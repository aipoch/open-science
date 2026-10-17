import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import type { NotebookSandboxInvocation } from './process-sandbox'

vi.mock('node:dns/promises', { spy: true })

it.skipIf(process.platform !== 'darwin')(
  'enforces offline/research ceilings in native processes despite global grants',
  async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'os-managed-confinement-')))
    const workspace = join(fixture, 'workspace')
    const unrelated = join(fixture, 'globally-granted')
    await mkdir(workspace)
    await mkdir(unrelated)
    await writeFile(join(unrelated, 'private.txt'), 'unrelated-content')
    const destinations: string[] = []
    // This parent proxy terminates the requests itself; no public/paid service is contacted.
    const proxy = createServer((request, response) => {
      destinations.push(request.url ?? '')
      response.end('controlled-fixture')
    })
    // Undici fetch uses CONNECT even for an HTTP origin. Terminate that tunnel locally too.
    proxy.on('connect', (request, socket, head) => {
      destinations.push(`CONNECT ${request.url}`)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const answer = (): void => {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\ncontrolled-fixture'
        )
      }
      if (head.length) answer()
      else socket.once('data', answer)
      socket.on('error', () => {})
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
    const lookupSpy = vi
      .mocked(lookup)
      .mockImplementation(async () => [{ address: '8.8.8.8', family: 4 }] as never)
    const requestDecision = vi.fn(async () => 'allowOnce' as const)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(fixture, 'commands'),
      getSettings: async () => ({
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        allowedDomains: ['api.example.org', 'other.example.org']
      }),
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      getGrantedLocalRoots: async () => [
        { id: 'unrelated', name: 'Unrelated', path: unrelated, access: 'rw' }
      ],
      getParentProxy: async () => ({ http: `http://127.0.0.1:${address.port}` }),
      requestDecision
    })
    const run = async (
      command: string,
      confinement?: NotebookSandboxInvocation['confinement']
    ): Promise<{ stdout: string; stderr: string; code: number | null }> => {
      const wrapped = await owner.wrap({
        executable: '/bin/bash',
        args: ['--noprofile', '--norc', '-c', command],
        env: { PATH: '/usr/bin:/bin', HOME: workspace, NODE_USE_ENV_PROXY: '1' },
        cwd: workspace,
        commandText: command,
        projectId: 'confinement',
        sessionId: 'shared-session',
        runtime: 'bash',
        confinement,
        // A legacy per-command grant must not widen the research ceiling either.
        allowedNetworkHosts: ['other.example.org'],
        filesystem: {
          readOnlyRoots: ['/usr/bin', '/bin', dirname(process.execPath)],
          readWriteRoots: [workspace],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const end = wrapped.beginExecution?.()
      let stdout = ''
      let stderr = ''
      const child = spawn(wrapped.executable, [...wrapped.args], {
        cwd: workspace,
        env: wrapped.env,
        stdio: 'pipe'
      })
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
      const [code] = await once(child, 'close')
      end?.()
      const diagnostic = wrapped.annotateStderr(stderr, stdout)
      const cleanup = await wrapped.cleanup('exit', {
        processesTerminated: true,
        processState: 'started-and-reaped'
      })
      expect(cleanup).toMatchObject({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      return { stdout, stderr: diagnostic, code }
    }
    const curl = (host: string): string =>
      `/usr/bin/curl --silent --show-error --fail --max-time 5 --noproxy '' http://${host}/fixture`
    try {
      const ordinary = await run(
        `/bin/cat '${join(unrelated, 'private.txt')}'; ${curl('api.example.org')}`
      )
      expect(ordinary.code).toBe(0)
      expect(ordinary.stdout).toBe('unrelated-contentcontrolled-fixture')
      destinations.length = 0
      for (const host of [
        'api.example.org',
        'registry.npmjs.org',
        'other.example.org',
        'unknown.example.org'
      ]) {
        const denied = await run(curl(host), { mode: 'offline-demo' })
        expect(denied.code).not.toBe(0)
        expect(denied.stderr).toContain('POLICY_BLOCKED')
      }
      expect(destinations).toEqual([])
      const onceHost = 'once.example.org'
      await expect(
        owner.requestNetworkAccess({
          sessionId: 'shared-session',
          projectId: 'confinement',
          hostname: onceHost,
          runtime: 'bash',
          command: curl(onceHost),
          reason: 'Controlled test fixture'
        })
      ).resolves.toMatchObject({ status: 'allowedOnce' })
      requestDecision.mockClear()
      const onceDenied = await run(curl(onceHost), { mode: 'offline-demo' })
      expect(onceDenied.code).not.toBe(0)
      expect(destinations).toEqual([])
      const onceAllowed = await run(curl(onceHost), {
        mode: 'research',
        allowedNetworkHosts: [onceHost]
      })
      expect(onceAllowed).toMatchObject({ code: 0, stdout: 'controlled-fixture' })
      // The demo neither used nor consumed the research/ordinary execution's pending grant.
      expect(destinations).toHaveLength(1)
      destinations.length = 0
      for (const mode of ['offline-demo', 'research'] as const) {
        const result = await run(`/bin/cat '${join(unrelated, 'private.txt')}'`, {
          mode,
          allowedNetworkHosts: []
        })
        expect(result.code).not.toBe(0)
        expect(result.stdout).not.toContain('unrelated-content')
      }
      const research = { mode: 'research' as const, allowedNetworkHosts: ['api.example.org'] }
      const allowed = await run(curl('api.example.org'), research)
      expect(allowed).toMatchObject({ code: 0, stdout: 'controlled-fixture' })
      expect(destinations).toHaveLength(1)
      const blocked = await run(curl('other.example.org'), research)
      expect(blocked.code).not.toBe(0)
      expect(blocked.stderr).toContain('POLICY_BLOCKED')
      expect(destinations).toHaveLength(1)
      const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
      const nodeFetch = `${quote(process.execPath)} -e ${quote("fetch('http://api.example.org/node-fetch', {signal: AbortSignal.timeout(5000)}).then(async r => { if (!r.ok) process.exitCode=1; console.log(await r.text()) }).catch(e => { console.error(e.name, e.cause?.code, e.cause?.message); process.exitCode=1 })")}`
      expect(await run(nodeFetch, research)).toMatchObject({
        code: 0,
        stdout: 'controlled-fixture\n'
      })
      expect(destinations).toHaveLength(2)
      expect((await run(nodeFetch, { mode: 'offline-demo' })).code).not.toBe(0)
      expect(destinations).toHaveLength(2)
      const raw = await run(
        `/usr/bin/curl --silent --show-error --max-time 3 --proxy '' http://127.0.0.1:${address.port}/bypass`,
        { mode: 'offline-demo' }
      )
      expect(raw.code).not.toBe(0)
      expect(destinations).toHaveLength(2)
      expect(requestDecision).not.toHaveBeenCalled()
    } finally {
      lookupSpy.mockRestore()
      await owner.dispose()
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await rm(fixture, { recursive: true, force: true })
    }
  },
  30000
)

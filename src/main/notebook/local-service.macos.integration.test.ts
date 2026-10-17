import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createServer, type Server } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import type { NotebookLocalService, NotebookProcessSandbox } from './process-sandbox'
import { runShellCommand } from './shell-process'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'

configureTestRuntimeMetadata()

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
const close = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))
const serviceDirectory = async (): Promise<string> => {
  const root = await realpath(await mkdtemp('/tmp/os-service-fixture-run-'))
  await chmod(root, 0o700)
  return root
}
const ownerFor = (root: string): NotebookNetworkSandboxOwner =>
  new NotebookNetworkSandboxOwner({
    resourceRoot: join(process.cwd(), 'packages/notebook-network-sandbox/vendor'),
    temporaryRoot: join(root, 'commands'),
    getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    requestDecision: async () => 'deny'
  })
const sandboxFor = (
  owner: NotebookNetworkSandboxOwner,
  service?: NotebookLocalService
): NotebookProcessSandbox => ({
  wrap: (invocation) =>
    owner.wrap(
      service
        ? {
            ...invocation,
            localService: service,
            filesystem: {
              ...invocation.filesystem,
              readWriteRoots: [...invocation.filesystem.readWriteRoots, dirname(service.socketPath)]
            }
          }
        : invocation
    )
})

const permissionsFixture = String.raw`
const net = require('node:net'), fs = require('node:fs');
const [socketPath, otherPath, port, privatePath] = process.argv.slice(2);
const listen = options => new Promise(resolve => {
  const server = net.createServer();
  server.once('error', error => resolve(error.code));
  server.listen(options, () => server.close(() => resolve('allowed')));
});
const connect = options => new Promise(resolve => {
  const socket = net.connect(options);
  socket.once('connect', () => { socket.destroy(); resolve('allowed'); });
  socket.once('error', error => resolve(error.code));
  socket.setTimeout(1000, () => { socket.destroy(); resolve('timeout'); });
});
(async () => {
  const result = {};
  const server = net.createServer(socket => { socket.on('error',()=>{}); socket.end(); });
  result.unixListen = await new Promise(resolve => {
    server.once('error', error => resolve(error.code));
    server.listen(socketPath, () => resolve('allowed'));
  });
  if (result.unixListen === 'allowed') {
    result.unixConnect = await connect({path: socketPath});
    await new Promise(resolve => server.close(resolve));
  }
  result.loopbackListen = await listen({port: Number(port), host: '127.0.0.1'});
  result.wildcardListen = await listen({port: Number(port), host: '0.0.0.0'});
  result.unixOtherListen = await listen({path: socketPath.replace('service.sock','ungranted.sock')});
  result.unixOtherConnect = await connect({path: otherPath});
  result.loopbackConnect = await connect({port: Number(port), host: '127.0.0.1'});
  result.internet = await connect({port:9, host:'1.1.1.1'});
  try { fs.symlinkSync(otherPath, socketPath); result.symlinkConnect = await connect({path:socketPath}); fs.unlinkSync(socketPath); }
  catch(error) { result.symlinkConnect = error.code; }
  try { fs.readFileSync(privatePath); result.privateRead = 'allowed'; }
  catch(error) { result.privateRead = error.code; }
  try { fs.writeFileSync(privatePath, 'changed'); result.privateWrite = 'allowed'; }
  catch(error) { result.privateWrite = error.code; }
  fs.writeFileSync('output.json', JSON.stringify(result));
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
`

describe.skipIf(process.platform !== 'darwin')('opt-in real macOS Unix service sandbox', () => {
  it('allows one private Unix path and rejects TCP, other Unix paths, symlinks and private files', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'os-local-service-')))
    const workspace = join(root, 'workspace'),
      runtime = join(root, 'runtime')
    await mkdir(workspace)
    await mkdir(runtime)
    const serviceRoot = await serviceDirectory()
    const socketPath = join(serviceRoot, 'service.sock')
    const fixture = join(workspace, 'permissions.cjs'),
      privatePath = join(root, 'private.txt')
    await writeFile(fixture, permissionsFixture)
    await writeFile(privatePath, 'untouched')
    const other = createServer((socket) => {
      socket.on('error', () => {})
      socket.end()
    })
    const tcp = createServer((socket) => {
      socket.on('error', () => {})
      socket.end()
    })
    const otherPath = join(serviceRoot, 'other.sock')
    await new Promise<void>((resolve) => other.listen(otherPath, resolve))
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    const address = tcp.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const port = address.port
    // Free the TCP listener so denial is an OS permission check, not EADDRINUSE.
    await close(tcp)
    const owner = ownerFor(root),
      node = await realpath(process.execPath)
    const execute = (service?: NotebookLocalService): ReturnType<typeof runShellCommand> =>
      runShellCommand({
        command: [node, fixture, socketPath, otherPath, port, privatePath]
          .map((part) => quote(String(part)))
          .join(' '),
        cwd: workspace,
        runtimeRoot: runtime,
        handoffDir: workspace,
        projectId: 'fixture-project',
        sessionId: 'fixture-session',
        executionReference: 'fixture-run',
        processSandbox: sandboxFor(owner, service),
        environment: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: workspace },
        timeoutMs: 10_000
      })
    try {
      const enabled = await execute({ executionId: 'fixture-run', socketPath })
      expect(enabled.exitCode, enabled.stderr).toBe(0)
      expect(enabled.ownedTreeReaped).not.toBe(false)
      const permitted = JSON.parse(enabled.stdout.trim())
      expect(permitted.unixListen).toBe('allowed')
      expect(permitted.unixConnect).toBe('allowed')
      for (const field of [
        'loopbackListen',
        'wildcardListen',
        'unixOtherListen',
        'unixOtherConnect',
        'loopbackConnect',
        'internet',
        'symlinkConnect',
        'privateRead',
        'privateWrite'
      ]) {
        expect(['EPERM', 'EACCES'], field).toContain(permitted[field])
      }
      const ordinary = await execute()
      expect(ordinary.exitCode, ordinary.stderr).toBe(0)
      const restricted = JSON.parse(ordinary.stdout.trim())
      expect(['EPERM', 'EACCES']).toContain(restricted.unixListen)
      expect(['EPERM', 'EACCES']).toContain(restricted.loopbackListen)
      expect(await readFile(privatePath, 'utf8')).toBe('untouched')
      await expect(
        owner.wrap({
          executable: node,
          args: [],
          env: {},
          cwd: workspace,
          commandText: '',
          projectId: 'fixture-project',
          sessionId: 'fixture-session',
          runtime: 'bash',
          executionReference: 'other-run',
          localService: { executionId: 'fixture-run', socketPath },
          filesystem: {
            readOnlyRoots: [],
            readWriteRoots: [serviceRoot],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
      ).rejects.toThrow('does not belong')
    } finally {
      await Promise.all([close(other), close(tcp)])
      await owner.dispose()
      await Promise.all(
        [root, serviceRoot].map((path) => rm(path, { recursive: true, force: true }))
      )
    }
  }, 30_000)

  it.each(['exit', 'cancel', 'timeout'] as const)(
    'reaps the service and its child on %s',
    async (mode) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'os-local-cleanup-')))
      const workspace = join(root, 'workspace'),
        runtime = join(root, 'runtime')
      await mkdir(workspace)
      await mkdir(runtime)
      const serviceRoot = await serviceDirectory(),
        socketPath = join(serviceRoot, 'service.sock')
      const fixture = join(workspace, 'service.cjs')
      await writeFile(
        fixture,
        String.raw`
const {spawn}=require('node:child_process'), fs=require('node:fs'), net=require('node:net');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
const server=net.createServer();
server.listen(process.argv[2],()=>{
  fs.writeFileSync('ready.json', JSON.stringify({pid:process.pid,childPid:child.pid}));
  if(process.argv[3]==='exit') process.exit(0);
});
`
      )
      const owner = ownerFor(root),
        registry = new ShellProcessOwnershipRegistry(root)
      const node = await realpath(process.execPath),
        controller = new AbortController()
      let verified = false,
        completion: ReturnType<typeof runShellCommand> | undefined
      try {
        completion = runShellCommand({
          command: [node, fixture, socketPath, mode].map(quote).join(' '),
          cwd: workspace,
          handoffDir: workspace,
          runtimeRoot: runtime,
          projectId: 'fixture-project',
          sessionId: 'fixture-session',
          runId: 'fixture-run',
          executionReference: 'fixture-run',
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 2000 : 10_000,
          environment: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: workspace },
          prepareProcessOwnership: () =>
            registry.beginLaunch({
              runId: 'fixture-run',
              projectId: 'fixture-project',
              sessionId: 'fixture-session',
              platform: 'darwin'
            }),
          processSandbox: sandboxFor(owner, { executionId: 'fixture-run', socketPath })
        })
        if (mode === 'cancel') {
          await vi.waitFor(
            async () =>
              expect(
                JSON.parse(await readFile(join(workspace, 'ready.json'), 'utf8')).childPid
              ).toBeGreaterThan(0),
            { timeout: 10_000 }
          )
          controller.abort()
        }
        const result = await completion
        expect(result.errorCode, result.stderr).toBeUndefined()
        expect(result.ownedTreeReaped).not.toBe(false)
        expect(mode === 'exit' ? result.exitCode === 0 : result.exitCode === null).toBe(true)
        if (mode === 'timeout') expect(result.stderr).toContain('timed out')
        if (mode === 'cancel') expect(result.cancelled).toBe(true)
        const pids = JSON.parse(await readFile(join(workspace, 'ready.json'), 'utf8'))
        for (const pid of [pids.pid, pids.childPid])
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(registry.hasReceipts()).toBe(false)
        verified = true
      } finally {
        controller.abort()
        await completion
        await owner.dispose()
        if (verified)
          await Promise.all(
            [root, serviceRoot].map((path) => rm(path, { recursive: true, force: true }))
          )
      }
    },
    30_000
  )
})

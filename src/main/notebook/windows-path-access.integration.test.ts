import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { windowsLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import { createRuntimeConfig } from '../../../packages/notebook-network-sandbox/src/config'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NotebookKernelExecutor } from './kernel-executor'

it.skipIf(process.platform !== 'win32' || process.env.OPEN_SCIENCE_TEST_PATH_ACL !== '1')(
  'starts an unrelated command when an optional network PATH share is unavailable',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-network-path-'))
    const config = createRuntimeConfig({
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    try {
      // Model a share disappearing after PATH discovery. Loopback cannot contact another host.
      const missingShare = `\\\\127.0.0.1\\os-missing-share-${Date.now()}`
      const wrapped = windowsLaunch({
        command: '',
        executable: join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
        args: ['/d', '/c', 'echo OPTIONAL_PATH_OK'],
        cwd: root,
        env: { ...process.env, PATH: missingShare, TEMP: root },
        installationId: config.installationId,
        ownershipRoot: config.windowsOwnershipRoot,
        hostPath: config.windowsHostPath,
        gatewayPort: 61200,
        gatewayCredentials: { username: 'unused', password: 'unused' },
        filesystem: {
          readOnlyRoots: [],
          optionalReadOnlyRoots: [missingShare],
          readWriteRoots: [root],
          deniedReadRoots: [],
          deniedWriteRoots: []
        }
      })
      const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        env: wrapped.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const [code] = await once(child, 'close')
      const terminated = await wrapped.confirmProcessTreeTermination?.()
      expect({ code, stdout, stderr }, stderr).toMatchObject({
        code: 0,
        stdout: expect.stringContaining('OPTIONAL_PATH_OK')
      })
      expect(terminated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  60_000
)

// Requires the existing native protected sandbox. No setup/UAC or user-directory ACL mutation.
it.skipIf(process.platform !== 'win32' || process.env.OPEN_SCIENCE_TEST_PATH_ACL !== '1')(
  'starts an unrelated command when an inherited PATH directory cannot be granted access',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-path-acl-'))
    const workspace = join(root, 'workspace')
    const runtimeRoot = join(root, 'runtime')
    const pathRoot = join(root, 'Git', 'cmd')
    const childPathRoot = join(pathRoot, 'bin')
    await mkdir(workspace)
    await mkdir(runtimeRoot)
    await mkdir(pathRoot, { recursive: true })
    await mkdir(childPathRoot)
    await writeFile(join(pathRoot, '.acl-probe-owned'), 'test-owned')
    await writeFile(join(childPathRoot, '.acl-probe-owned'), 'CHILD_PATH_OK')
    const windowsRoot = process.env.SystemRoot!
    const fixture = await readFile(
      resolve('src/main/notebook/windows-path-access.fixture.ps1'),
      'utf8'
    )
    const guard = spawn(
      join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(`& {\n${fixture}\n} $env:OPEN_SCIENCE_TEST_PATH_ROOT`, 'utf16le').toString(
          'base64'
        )
      ],
      {
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, OPEN_SCIENCE_TEST_PATH_ROOT: pathRoot }
      }
    )
    const guardClosed = once(guard, 'close')
    let guardError = ''
    guard.stderr.on('data', (chunk) => {
      guardError += String(chunk)
    })
    const config = createRuntimeConfig({
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    try {
      const ready = await Promise.race([
        once(guard.stdout, 'data').then(([chunk]) => String(chunk).trim()),
        guardClosed.then(() => {
          throw new Error(`ACL fixture failed: ${guardError}`)
        })
      ])
      expect(ready).toBe('READABLE_WITHOUT_WRITE_DAC')
      expect(await readFile(join(pathRoot, '.acl-probe-owned'), 'utf8')).toBe('test-owned')
      const env = {
        ...process.env,
        PATH: `${pathRoot};${childPathRoot};${join(windowsRoot, 'System32')}`,
        TEMP: workspace
      }
      vi.stubEnv('PATH', env.PATH)
      let requirePathRoot = false
      const sandbox: NotebookProcessSandbox = {
        wrap: async (invocation) => {
          const wrapped = windowsLaunch({
            command: '',
            executable: invocation.executable,
            args: invocation.args,
            env: { ...invocation.env, TEMP: workspace },
            cwd: invocation.cwd,
            installationId: config.installationId,
            ownershipRoot: config.windowsOwnershipRoot,
            hostPath: config.windowsHostPath,
            gatewayPort: 61200,
            gatewayCredentials: { username: 'unused', password: 'unused' },
            filesystem: {
              ...invocation.filesystem,
              readOnlyRoots: [
                ...invocation.filesystem.readOnlyRoots,
                ...(requirePathRoot ? [pathRoot] : [])
              ]
            }
          })
          return {
            executable: wrapped.argv[0],
            args: wrapped.argv.slice(1),
            env: wrapped.env,
            confirmProcessTreeTermination: wrapped.confirmProcessTreeTermination,
            annotateStderr: (stderr) => stderr,
            cleanup: async (_reason, outcome) => ({
              processesTerminated: outcome.processesTerminated,
              networkClosed: true,
              temporaryResourcesRemoved: true
            })
          }
        }
      }
      const adapter = new NotebookShellProcessAdapter('win32', sandbox)
      const run = (): ReturnType<NotebookShellProcessAdapter['execute']> =>
        adapter.execute({
          command: `[Console]::WriteLine('PATH_PROBE_OK'); try { [Console]::WriteLine([IO.File]::ReadAllText('${join(pathRoot, '.acl-probe-owned').replaceAll("'", "''")}')) } catch { [Console]::WriteLine('PATH_ROOT_DENIED') }; try { [Console]::WriteLine([IO.File]::ReadAllText('${join(childPathRoot, '.acl-probe-owned').replaceAll("'", "''")}')) } catch { [Console]::WriteLine('CHILD_PATH_DENIED') }`,
          runId: 'path-acl-test',
          projectId: 'path-acl-test',
          sessionId: 'path-acl-test',
          cwd: workspace,
          handoffDir: workspace,
          runtimeRoot,
          runtimeBinding: { kind: 'powershell', version: '5.1' },
          timeoutMs: 60_000
        })
      const result = await run()
      const executor = new NotebookKernelExecutor({
        replLoopPath: resolve('resources/notebook/repl_loop.js'),
        pythonLoopPath: resolve('resources/notebook/python_loop.py'),
        processSandbox: sandbox
      })
      const kernelResults = []
      try {
        const kinds: Array<'repl' | 'python'> = ['repl']
        if (process.env.OPEN_SCIENCE_TEST_PATH_PYTHON) kinds.push('python')
        for (const kind of kinds) {
          kernelResults.push(
            await executor.execute({
              language: 'python',
              ...(kind === 'repl' ? { kind } : {}),
              code: kind === 'repl' ? "console.log('PATH_PROBE_OK')" : "print('PATH_PROBE_OK')",
              cwd: workspace,
              notebookSessionRoot: workspace,
              dataRoot: root,
              runtimeRoot,
              sessionId: `path-acl-${kind}`,
              projectId: 'path-acl-test',
              timeoutMs: 60_000,
              ...(kind === 'python'
                ? { resolvedInterpreter: { command: process.env.OPEN_SCIENCE_TEST_PATH_PYTHON! } }
                : {})
            })
          )
        }
      } finally {
        await executor.shutdown()
      }
      requirePathRoot = true
      const requiredResult = await run()
      requirePathRoot = false
      // Restore the fixture before production cleanup retries the failed ACL rollback.
      guard.stdin.end('\n')
      expect((await guardClosed)[0], guardError).toBe(0)
      // Same command and PATH, with only the ACL restored. This also drains native ACL recovery
      // before the temporary directory is removed, including failed-grant rollback receipts.
      const control = await run()
      expect(control).toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('PATH_PROBE_OK')
      })
      expect(result.stdout).toContain('PATH_ROOT_DENIED')
      expect(result.stdout).toContain('CHILD_PATH_OK')
      expect(control.stdout).toContain('test-owned')
      expect(requiredResult.stderr).toContain('grant AppContainer access to')
      expect(requiredResult.stdout).not.toContain('PATH_PROBE_OK')
      for (const kernel of kernelResults) {
        expect(kernel, JSON.stringify(kernel)).toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining('PATH_PROBE_OK')
        })
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining('PATH_PROBE_OK')
      })
    } finally {
      guard.stdin.end('\n')
      await guardClosed
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  240_000
)

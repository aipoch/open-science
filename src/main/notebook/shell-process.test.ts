import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as processTree from '../process-tree'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildShellEnv,
  normalizePowerShellStderr,
  resolveShellInvocation,
  resolveShellProcessInvocation,
  runShellCommand,
  terminateShellOnTimeout
} from './shell-process'
import { NOTEBOOK_TEXT_LIMIT_BYTES } from './content-limits'
import type { NotebookProcessSandbox } from './process-sandbox'
import { normalizeFilesystemLayout } from '../../../packages/notebook-network-sandbox/runtime/src/platform/filesystem-layout.js'
import { terminateProcessTree } from '../process-tree'
import { notebookWorkloadCacheEnv } from './notebook-workload-cache-paths'

let portableRuntimeRoot: string

beforeEach(async () => {
  portableRuntimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-portable-runtime-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(portableRuntimeRoot, { recursive: true, force: true })
})

const previewAvailable = (): boolean => true

describe('notebook shell process behavior', () => {
  describe('invocation', () => {
    it('uses a POSIX sh command on Unix platforms', () => {
      expect(resolveShellInvocation('echo hi', 'linux')).toEqual({
        executable: '/bin/sh',
        args: ['-c', 'echo hi']
      })
    })

    it('uses an absolute non-interactive PowerShell command on Windows without relying on PATH', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const invocation = resolveShellInvocation('cp "source.png" "destination.png"', 'win32')

      expect(invocation.executable).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      )
      expect(invocation.args.slice(0, -1)).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand'
      ])

      const script = Buffer.from(invocation.args.at(-1) ?? '', 'base64').toString('utf16le')
      expect(script).toContain('[Console]::OutputEncoding = $openScienceUtf8')
      expect(script).toContain('$OutputEncoding = $openScienceUtf8')
      expect(script).toContain('$env:PSModulePath = $env:OPEN_SCIENCE_PSMODULEPATH')
      expect(script).toContain(
        'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop'
      )
      expect(script).toContain(
        'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop'
      )
      expect(script).toContain(
        "[System.Environment]::SetEnvironmentVariable('OPEN_SCIENCE_PSMODULEPATH', $null, [System.EnvironmentVariableTarget]::Process)"
      )
      expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
      expect(script).toContain("$ErrorActionPreference = 'Stop'")
      expect(script).toContain('catch {')
      expect(script).toContain('[Console]::Error.WriteLine($_.ToString())')
      const encodedCommand = script.match(/\$openScienceCommandBase64 = '([A-Za-z0-9+/=]+)'/)?.[1]
      expect(Buffer.from(encodedCommand ?? '', 'base64').toString('utf8')).toBe(
        'cp "source.png" "destination.png"'
      )
      expect(script).toContain('[ScriptBlock]::Create($openScienceCommandText)')
      expect(script).toContain('& $openScienceCommand')
      expect(script).toContain('$openScienceSucceeded = $?')
      expect(script).toContain('exit $openScienceNativeExitCode')
      expect(script).toMatch(/if \(\$openScienceSucceeded\) \{ exit 0 \}/)
      expect(script.indexOf('exit $openScienceNativeExitCode')).toBeLessThan(
        script.indexOf('if ($openScienceSucceeded) { exit 0 }')
      )
      expect(script).toMatch(/exit 1\s*$/)
    })

    it('isolates PowerShell command syntax from the exit-code wrapper', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const command = "Write-Output 'first'\n# keep this comment\nWrite-Output 'continued' `"
      const invocation = resolveShellInvocation(command, 'win32')
      const script = Buffer.from(invocation.args.at(-1) ?? '', 'base64').toString('utf16le')
      const encodedCommand = script.match(/\$openScienceCommandBase64 = '([A-Za-z0-9+/=]+)'/)?.[1]

      expect(script).not.toContain(command)
      expect(encodedCommand).toBeDefined()
      expect(Buffer.from(encodedCommand ?? '', 'base64').toString('utf8')).toBe(command)
      expect(script).toContain('[ScriptBlock]::Create($openScienceCommandText)')
      expect(script).toContain('& $openScienceCommand')
    })

    it('uses the shell captured by a native POSIX binding instead of re-reading the host platform', () => {
      expect(
        resolveShellInvocation('echo hi', {
          kind: 'native-posix',
          shell: '/opt/local/bin/zsh'
        })
      ).toEqual({ executable: '/opt/local/bin/zsh', args: ['-c', 'echo hi'] })
    })

    it('keeps host write protection separate from the selected Shell runtime', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const nativeBinding = { kind: 'native-posix' as const, shell: '/bin/sh' }
      const wslBinding = {
        kind: 'wsl2-bash' as const,
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'researcher'
      }

      expect(
        resolveShellProcessInvocation('echo hi', nativeBinding, '/managed/runtime', 'darwin', false)
      ).toMatchObject({
        executable: '/usr/bin/sandbox-exec',
        args: expect.arrayContaining(['/bin/sh', '-c', 'echo hi'])
      })
      expect(
        resolveShellProcessInvocation('echo hi', nativeBinding, '/managed/runtime', 'linux', false)
      ).toEqual({ executable: '/bin/sh', args: ['-c', 'echo hi'] })
      expect(
        resolveShellProcessInvocation(
          'Write-Output hi',
          { kind: 'powershell', version: '5.1' },
          'C:\\managed\\runtime',
          'win32',
          false
        ).executable
      ).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/)
      expect(
        resolveShellProcessInvocation('echo hi', wslBinding, 'C:\\managed\\runtime', 'win32', true)
      ).toEqual({ executable: '/bin/bash', args: ['-c', 'echo hi'] })
    })

    it('uses Bash and the exact selected profile for a WSL2 sandbox target', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => {
          throw new Error(`prepared:${JSON.stringify(invocation.target)}:${invocation.executable}`)
        })
      }

      const result = await runShellCommand({
        command: 'echo hi',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        },
        processSandbox,
        previewAvailable
      })

      expect(result).toEqual({
        stdout: '',
        stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable'
      })
      expect(processSandbox.wrap).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            kind: 'wsl2',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          executable: '/bin/bash',
          pathEnvironment: {
            OPEN_SCIENCE_HANDOFF_DIR: 'C:\\handoff',
            ...notebookWorkloadCacheEnv(portableRuntimeRoot)
          }
        })
      )
    })

    it('does not prepare a selected WSL2 runtime while the main Preview gate is closed', async () => {
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn()
      }

      const result = await runShellCommand({
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        },
        processSandbox,
        previewAvailable: () => false
      })

      expect(result).toEqual({
        stdout: '',
        stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable'
      })
      expect(processSandbox.wrap).not.toHaveBeenCalled()
    })

    it('surfaces the stable fail-closed diagnostic when guest-to-host transport is unsupported', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async () => {
          throw new Error(
            'WSL2_NETWORK_TRANSPORT_UNSUPPORTED: WSL2 Bash Preview network access requires mirrored networking.'
          )
        })
      }

      await expect(
        runShellCommand({
          command: 'echo should-not-run',
          cwd: 'C:\\workspace',
          handoffDir: 'C:\\handoff',
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          processSandbox,
          previewAvailable
        })
      ).resolves.toEqual({
        stdout: '',
        stderr:
          'WSL2_NETWORK_TRANSPORT_UNSUPPORTED: WSL2 Bash Preview network access requires mirrored networking.',
        exitCode: null,
        errorCode: 'shell-network-transport-unsupported'
      })
    })

    it('prioritizes incomplete WSL preparation cleanup over an aborted signal', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const controller = new AbortController()
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async () => {
          controller.abort()
          throw new Error(
            'SHELL_CLEANUP_INCOMPLETE: WSL2 shell preparation cleanup could not be verified.'
          )
        })
      }

      await expect(
        runShellCommand({
          command: 'echo should-not-run',
          cwd: 'C:\\workspace',
          handoffDir: 'C:\\handoff',
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          signal: controller.signal,
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          processSandbox,
          previewAvailable
        })
      ).resolves.toMatchObject({
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete'
      })
    })

    it('fails a selected WSL2 runtime closed with a stable unavailable code instead of native fallback', async () => {
      const result = await runShellCommand({
        command: 'Write-Output should-not-run',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        }
      })

      expect(result).toEqual({
        stdout: '',
        stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable'
      })
    })
  })

  describe('platform support', () => {
    const completedProgressClixml =
      '#< CLIXML\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
      '<Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
      '</Objs>\n'

    it('drops progress-only PowerShell CLIXML stderr records', () => {
      expect(normalizePowerShellStderr(completedProgressClixml, 'win32')).toBe('')
    })

    it('preserves real stderr around benign PowerShell CLIXML progress records', () => {
      expect(
        normalizePowerShellStderr(
          `real warning\n${completedProgressClixml}\nstill important\n`,
          'win32'
        )
      ).toBe('real warning\nstill important\n')
    })

    it('preserves non-progress PowerShell CLIXML records', () => {
      const errorClixml =
        '#< CLIXML\n' +
        '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
        '<Obj S="Error" RefId="0"><MS><S N="Message">boom</S></MS></Obj>' +
        '</Objs>\n'

      expect(normalizePowerShellStderr(errorClixml, 'win32')).toBe(errorClixml)
    })

    it('normalizes CLIXML only for the PowerShell binding on a Windows host', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-binding-stderr-'))
      const execute = async (
        runtimeBinding:
          | { kind: 'powershell'; version: '5.1' }
          | {
              kind: 'wsl2-bash'
              profileId: string
              distro: string
              user: string
            }
      ): Promise<string> => {
        const processSandbox: NotebookProcessSandbox = {
          wrap: vi.fn(async (invocation) => ({
            executable: process.execPath,
            args: ['-e', `process.stderr.write(${JSON.stringify(completedProgressClixml)})`],
            env: invocation.env,
            annotateStderr: (stderr: string) => stderr,
            cleanup: vi.fn(async () => ({
              processesTerminated: true,
              networkClosed: true,
              temporaryResourcesRemoved: true
            }))
          }))
        }
        const result = await runShellCommand({
          command: 'emit stderr',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding,
          processSandbox,
          previewAvailable,
          terminateTree: async () => ({ reaped: true })
        })
        return result.stderr
      }

      try {
        await expect(
          execute({
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          })
        ).resolves.toBe(completedProgressClixml)
        await expect(execute({ kind: 'powershell', version: '5.1' })).resolves.toBe('')
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    })

    it('keeps Windows shell runtime variables while excluding host secrets', () => {
      const runtimeRoot = 'D:\\OpenScience\\runtime'
      const env = buildShellEnv(
        '/notebook/handoff',
        'win32',
        {
          PATH: 'C:\\Windows\\System32',
          ProgramFiles: 'C:\\Program Files',
          SystemRoot: 'C:\\Windows',
          WINDIR: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          USERPROFILE: 'C:\\Users\\Ada',
          PSModulePath: 'C:\\host\\third-party-modules',
          OPEN_SCIENCE_PSMODULEPATH: 'C:\\host\\controlled-modules',
          OPEN_SCIENCE_TEST_SECRET: 'must-not-leak'
        },
        runtimeRoot
      )
      const cacheRoot = join(runtimeRoot, 'cache', 'notebook')

      expect(env).toMatchObject({
        PATH: 'C:\\Windows\\System32',
        ProgramFiles: 'C:\\Program Files',
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        PSModulePath:
          'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        OPEN_SCIENCE_PSMODULEPATH:
          'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        OPEN_SCIENCE_HANDOFF_DIR: '/notebook/handoff',
        OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
        PIP_CACHE_DIR: join(cacheRoot, 'pip'),
        HF_HUB_CACHE: join(cacheRoot, 'huggingface', 'hub'),
        TORCH_HOME: join(cacheRoot, 'torch')
      })
      expect(env.USERPROFILE).toBeUndefined()
      expect(env.OPEN_SCIENCE_TEST_SECRET).toBeUndefined()
    })

    it('waits for process-tree termination before settling a timed-out shell command', async () => {
      const child = {} as ChildProcess
      let finishTermination: ((result: { reaped: boolean }) => void) | undefined
      const terminateTree = vi.fn(
        () =>
          new Promise<{ reaped: boolean }>((resolve) => {
            finishTermination = resolve
          })
      )

      let settled = false
      const termination = terminateShellOnTimeout(child, 'win32', terminateTree).then((result) => {
        settled = true
        return result
      })

      expect(termination).toBeInstanceOf(Promise)
      expect(terminateTree).toHaveBeenCalledWith(child)
      await Promise.resolve()
      expect(settled).toBe(false)

      finishTermination?.({ reaped: true })
      return expect(termination).resolves.toEqual({ reaped: true })
    })

    it('waits for bounded POSIX process-tree reaping before reporting termination', async () => {
      const child = Object.assign(new EventEmitter(), { pid: 4321 }) as unknown as ChildProcess
      let finishTermination: ((result: { reaped: boolean }) => void) | undefined
      const terminateTree = vi.fn(
        () =>
          new Promise<{ reaped: boolean }>((resolve) => {
            finishTermination = resolve
          })
      )
      let completed = false

      const termination = terminateShellOnTimeout(child, 'linux', terminateTree).then((result) => {
        completed = true
        return result
      })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(terminateTree).toHaveBeenCalledWith(child)
      expect(completed).toBe(false)
      finishTermination?.({ reaped: true })
      await expect(termination).resolves.toEqual({ reaped: true })
    })

    it('reports an incomplete bounded POSIX teardown without claiming success', async () => {
      const child = { pid: 4321 } as unknown as ChildProcess
      const terminateTree = vi.fn(async () => ({ reaped: false }))

      await expect(terminateShellOnTimeout(child, 'darwin', terminateTree)).resolves.toEqual({
        reaped: false
      })
    })
  })

  it('awaits exactly one structured cleanup when spawn throws synchronously', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-sync-spawn-cleanup-'))
    let releaseCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const cleanup = vi.fn(async () => {
      await cleanupGate
      return {
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }
    })
    const endExecution = vi.fn()
    const beginExecution = vi.fn(() => endExecution)
    const spawnStarted = vi.fn()
    const spawnNotStarted = vi.fn()
    const beginSpawn = vi.fn(() => ({ started: spawnStarted, notStarted: spawnNotStarted }))
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: ['\0'],
        env: invocation.env,
        beginExecution,
        beginSpawn,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    let completed = false

    const completion = runShellCommand({
      command: 'echo unreachable',
      cwd: process.cwd(),
      handoffDir: process.cwd(),
      runtimeRoot,
      sessionId: 'session-1',
      projectId: 'project-1',
      platform: process.platform,
      processSandbox
    }).then((result) => {
      completed = true
      return result
    })

    await vi.waitFor(
      () => expect(cleanup).toHaveBeenCalledWith('spawn-failed', { processesTerminated: false }),
      { timeout: 5_000 }
    )
    expect(completed).toBe(false)
    expect(beginExecution).toHaveBeenCalledOnce()
    expect(endExecution).toHaveBeenCalledOnce()
    expect(beginSpawn).toHaveBeenCalledOnce()
    expect(spawnNotStarted).toHaveBeenCalledOnce()
    expect(spawnStarted).not.toHaveBeenCalled()
    releaseCleanup?.()

    const result = await completion
    expect(result).toMatchObject({ exitCode: null })
    expect(result.stderr).toContain('null bytes')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(endExecution).toHaveBeenCalledOnce()
    await rm(runtimeRoot, { recursive: true, force: true })
  })

  it('does not admit a WSL spawn when cancellation wins after preparation', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    const controller = new AbortController()
    const beginSpawn = vi.fn()
    const cleanup = vi.fn(async () => ({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    }))
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => {
        controller.abort()
        return {
          executable: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: invocation.env,
          beginSpawn,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }
      })
    }

    await expect(
      runShellCommand({
        command: 'echo never-spawned',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        signal: controller.signal,
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        },
        processSandbox,
        previewAvailable
      })
    ).resolves.toMatchObject({ cancelled: true, exitCode: null })
    expect(beginSpawn).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledWith('cancel', { processesTerminated: false })
  })

  it('returns a stable failure instead of trusting an exit when sandbox cleanup is incomplete', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-incomplete-cleanup-'))
    const cleanup = vi.fn(async () => ({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: false
    }))
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("finished")'],
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }

    try {
      await expect(
        runShellCommand({
          command: 'echo finished',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: process.platform,
          processSandbox,
          terminateTree: async () => ({ reaped: true })
        })
      ).resolves.toEqual({
        stdout: 'finished',
        stderr:
          'SHELL_CLEANUP_INCOMPLETE: Shell execution cleanup did not complete; the result is not trusted.',
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete'
      })
      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: true })
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('retries an incomplete WSL cleanup once before reporting the shell result', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-wsl-cleanup-retry-'))
    const cleanup = vi
      .fn()
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: false,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("finished")'],
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }

    try {
      await expect(
        runShellCommand({
          command: 'echo finished',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          processSandbox,
          previewAvailable,
          terminateTree: async () => ({ reaped: true })
        })
      ).resolves.toEqual({ stdout: 'finished', stderr: '', exitCode: 0 })
      expect(cleanup).toHaveBeenCalledTimes(2)
      expect(cleanup).toHaveBeenNthCalledWith(1, 'exit', { processesTerminated: true })
      expect(cleanup).toHaveBeenNthCalledWith(2, 'exit', { processesTerminated: true })
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  describe.runIf(process.platform !== 'win32')('process results', () => {
    let runtimeRoot: string
    beforeEach(async () => {
      runtimeRoot = await mkdtemp(join(tmpdir(), 'open-science-shell-process-'))
    })
    afterEach(async () => {
      await rm(runtimeRoot, { recursive: true, force: true })
    })

    it('settles a missing executable without an unhandled asynchronous spawn error', async () => {
      const registry = new ShellProcessOwnershipRegistry(runtimeRoot)
      const cleanup = vi.fn()
      const result = await runShellCommand({
        command: 'unused',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        prepareProcessOwnership: () =>
          registry.beginLaunch({
            runId: 'missing-executable',
            projectId: 'project-1',
            sessionId: 'session-1'
          }),
        processSandbox: {
          wrap: async (invocation) => ({
            executable: join(runtimeRoot, 'missing-executable'),
            args: [],
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup
          })
        }
      })
      expect(result.stderr).toContain('valid process identity')
      expect(registry.hasReceipts()).toBe(false)
      expect(cleanup).toHaveBeenCalledOnce()
    })

    it.each(['reaped', 'unreaped', 'rejected'] as const)(
      'preserves launch evidence until failed-claim cleanup is confirmed: %s',
      async (outcome) => {
        const registry = new ShellProcessOwnershipRegistry(runtimeRoot, {
          processStartIdentity: () => undefined
        })
        const launch = registry.beginLaunch({
          runId: 'failed-claim',
          projectId: 'project-1',
          sessionId: 'session-1'
        })
        const abort = vi.fn(launch.abort)
        const cleanup = vi.fn()
        const endExecution = vi.fn()
        const terminate = processTree.terminateProcessTree
        const spy = vi
          .spyOn(processTree, 'terminateProcessTree')
          .mockImplementation(async (child) => {
            expect(abort).not.toHaveBeenCalled()
            expect(registry.hasReceipts()).toBe(true)
            // Reap the real fixture even when simulating an unconfirmed termination result.
            await terminate(child)
            if (outcome === 'rejected') throw new Error('termination unavailable')
            return { reaped: outcome === 'reaped' }
          })
        try {
          const result = await runShellCommand({
            command: 'sleep 30',
            cwd: process.cwd(),
            handoffDir: process.cwd(),
            runtimeRoot,
            sessionId: 'session-1',
            projectId: 'project-1',
            prepareProcessOwnership: () => ({ claim: launch.claim, abort }),
            processSandbox: {
              wrap: async (invocation) => ({
                executable: invocation.executable,
                args: invocation.args,
                env: invocation.env,
                annotateStderr: (stderr) => stderr,
                beginExecution: () => endExecution,
                cleanup
              })
            }
          })
          expect(result.stderr).toContain('identity could not be confirmed')
          expect(abort).toHaveBeenCalledTimes(outcome === 'reaped' ? 1 : 0)
          expect(registry.hasReceipts()).toBe(outcome !== 'reaped')
          expect(cleanup).toHaveBeenCalledTimes(outcome === 'reaped' ? 1 : 0)
          expect(endExecution).toHaveBeenCalledOnce()
          expect(result).toHaveProperty(
            outcome === 'reaped' ? 'exitCode' : 'ownedTreeReaped',
            outcome === 'reaped' ? null : false
          )
        } finally {
          spy.mockRestore()
          launch.abort()
        }
      }
    )

    const execute = (
      command: string,
      timeoutMs = 5_000,
      signal?: AbortSignal
    ): ReturnType<typeof runShellCommand> =>
      runShellCommand({
        command,
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        timeoutMs,
        signal
      })

    it('preserves stdout, stderr, and a non-zero exit code as one ordinary result', async () => {
      await expect(execute("printf 'visible'; printf 'warning' >&2; exit 7")).resolves.toEqual({
        stdout: 'visible',
        stderr: 'warning',
        exitCode: 7
      })
    })

    it('reaps a setsid helper that outlives the shell leader', async () => {
      const helperScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
      const parentScript = [
        "const {spawn}=require('node:child_process')",
        `const helper=spawn(process.execPath,['-e',${JSON.stringify(helperScript)}],{stdio:'ignore',detached:true})`,
        'helper.unref()',
        'process.stdout.write(String(helper.pid))'
      ].join(';')
      let helperPid: number | undefined

      try {
        const result = await execute(
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`
        )
        helperPid = Number(result.stdout)
        expect(result.exitCode).toBe(0)
        await vi.waitFor(() => expect(() => process.kill(helperPid as number, 0)).toThrow())
      } finally {
        if (helperPid) {
          try {
            process.kill(helperPid, 'SIGKILL')
          } catch {
            // Expected once the tracked setsid helper has been reaped.
          }
        }
      }
    }, 15_000)

    it('wraps Notebook Bash with the shared process sandbox', async () => {
      const inputRoot = join(process.cwd(), '.open-science-test-inputs')
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const endExecution = vi.fn()
      const beginExecution = vi.fn(() => endExecution)
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => {
          normalizeFilesystemLayout(invocation.filesystem)
          return {
            executable: invocation.executable,
            args: invocation.args,
            env: { OPEN_SCIENCE_SANDBOX_TEST: 'wrapped' },
            beginExecution,
            annotateStderr: (stderr: string) => stderr,
            cleanup
          }
        })
      }

      const result = await runShellCommand({
        command: 'printf "$OPEN_SCIENCE_SANDBOX_TEST"',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        inputRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        processSandbox
      })

      expect(result.stderr).not.toContain('Sandbox filesystem path must be absolute')
      expect(result).toMatchObject({ stdout: 'wrapped', exitCode: 0 })

      expect(processSandbox.wrap).toHaveBeenCalledOnce()
      const [sandboxInvocation] = vi.mocked(processSandbox.wrap).mock.calls[0]
      expect(sandboxInvocation.filesystem.readOnlyRoots).toContain(runtimeRoot)
      expect(sandboxInvocation.filesystem.readOnlyRoots).toContain(inputRoot)
      expect(sandboxInvocation.filesystem.readWriteRoots).toContain(
        join(runtimeRoot, 'cache', 'notebook')
      )
      expect(sandboxInvocation.filesystem.deniedWriteRoots).not.toContain(runtimeRoot)
      expect(beginExecution).toHaveBeenCalledOnce()
      expect(endExecution).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: true })
    })

    it('waits for exit-tree inspection and reports an incomplete outcome exactly', async () => {
      let releaseInspection: (() => void) | undefined
      const inspectionGate = new Promise<void>((resolve) => {
        releaseInspection = resolve
      })
      const terminateTree = vi.fn(async () => {
        await inspectionGate
        return { reaped: false }
      })
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      let completed = false

      const completion = runShellCommand({
        command: 'exit 0',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        processSandbox,
        terminateTree
      }).then((result) => {
        completed = true
        return result
      })

      await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      expect(cleanup).not.toHaveBeenCalled()
      releaseInspection?.()
      await expect(completion).resolves.toMatchObject({
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete'
      })
      expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: false })
    })

    it.each([
      {
        name: 'timeout',
        command: 'sleep 5',
        timeoutMs: 25,
        reason: 'timeout' as const,
        cancel: false
      },
      {
        name: 'cancel',
        command: 'sleep 5',
        timeoutMs: 5_000,
        reason: 'cancel' as const,
        cancel: true
      }
    ])(
      'awaits one structured cleanup after $name',
      async ({ command, timeoutMs, reason, cancel }) => {
        const signal = cancel ? AbortSignal.timeout(25) : undefined
        const cleanup = vi.fn().mockResolvedValue({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
        const processSandbox: NotebookProcessSandbox = {
          wrap: vi.fn(async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr: string) => stderr,
            cleanup
          }))
        }

        await runShellCommand({
          command,
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'linux',
          timeoutMs,
          signal,
          processSandbox
        })

        expect(cleanup).toHaveBeenCalledOnce()
        expect(cleanup).toHaveBeenCalledWith(reason, { processesTerminated: true })
      }
    )

    it.each([
      { name: 'successful reaping', reaped: true },
      { name: 'bounded reaping failure', reaped: false }
    ])('waits for $name before timeout cleanup completes', async ({ reaped }) => {
      let releaseReaping: (() => void) | undefined
      const reapingGate = new Promise<void>((resolve) => {
        releaseReaping = resolve
      })
      const terminateTree = vi.fn(async (child: ChildProcess) => {
        const actual = await terminateProcessTree(child)
        expect(actual).toEqual({ reaped: true })
        await reapingGate
        return { reaped }
      })
      const cleanup = vi.fn(async (_reason, processOutcome: { processesTerminated: boolean }) => ({
        processesTerminated: processOutcome.processesTerminated,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }))
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      let completed = false

      const completion = runShellCommand({
        command: 'sleep 5',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        timeoutMs: 25,
        processSandbox,
        terminateTree
      }).then((result) => {
        completed = true
        return result
      })

      await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      expect(cleanup).not.toHaveBeenCalled()
      releaseReaping?.()
      await expect(completion).resolves.toMatchObject({ exitCode: null })
      expect(cleanup).toHaveBeenCalledWith('timeout', { processesTerminated: reaped })
    })

    it('awaits one structured cleanup when process spawning fails', async () => {
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: join(process.cwd(), 'missing-sandbox-executable'),
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }

      await expect(
        runShellCommand({
          command: 'echo unreachable',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'linux',
          processSandbox
        })
      ).resolves.toMatchObject({ exitCode: null })

      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('spawn-failed', { processesTerminated: true })
    })

    it('reports bounded spawn-failure teardown failure without assuming termination', async () => {
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: join(process.cwd(), 'missing-sandbox-executable'),
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }

      await runShellCommand({
        command: 'echo unreachable',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        processSandbox,
        terminateTree: vi.fn(async () => ({ reaped: false }))
      })

      expect(cleanup).toHaveBeenCalledWith('spawn-failed', { processesTerminated: false })
    })

    it('reserves stderr capacity after stdout reaches its capture limit', async () => {
      const script = `process.stdout.write('x'.repeat(${NOTEBOOK_TEXT_LIMIT_BYTES + 1024})); process.stderr.write('diagnostic survives'); process.exitCode = 7`
      const result = await execute(
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
      )

      expect(result.exitCode).toBe(7)
      expect(result.stderr).toContain('diagnostic survives')
      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
      ).toBeLessThanOrEqual(NOTEBOOK_TEXT_LIMIT_BYTES)
      expect(result.truncated).toBe(true)
    })

    it('classifies a timeout with a null exit code and appends its diagnostic after stderr', async () => {
      await expect(execute("printf 'before timeout' >&2; sleep 5", 50)).resolves.toEqual({
        stdout: '',
        stderr: 'before timeout\nShell command timed out after 50ms and was killed.',
        exitCode: null
      })
    })

    it('does not spawn work for an already-aborted shell request', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(execute('echo should-not-run', 5_000, controller.signal)).resolves.toEqual({
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      })
    })

    it('does not settle cancellation until the complete POSIX process group is gone', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shell-cancel-tree-'))
      const marker = randomUUID()
      const pidPath = join(root, `.shell-cancel-${marker}.pid`)
      const controller = new AbortController()
      const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
      try {
        const execution = runShellCommand({
          command: `${quote(process.execPath)} -e ${quote('setTimeout(() => {}, 30_000)')} & child=$!; printf '%s' "$child" > ${quote(pidPath)}; wait "$child"`,
          cwd: root,
          handoffDir: root,
          runtimeRoot: join(root, 'runtime'),
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'linux',
          timeoutMs: 30_000,
          signal: controller.signal
        })
        let descendantPid: number | undefined
        await vi.waitFor(
          async () => {
            descendantPid = Number((await readFile(pidPath, 'utf8')).trim())
            expect(descendantPid).toBeGreaterThan(0)
          },
          { timeout: 5_000 }
        )

        controller.abort()
        await expect(execution).resolves.toMatchObject({ cancelled: true, exitCode: null })
        expect(() => process.kill(descendantPid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildShellEnv,
  normalizePowerShellStderr,
  resolveShellInvocation,
  runShellCommand,
  terminateShellOnTimeout
} from './shell-process'
import { NOTEBOOK_TEXT_LIMIT_BYTES } from './content-limits'
import type { NotebookProcessSandbox } from './process-sandbox'
import { normalizeFilesystemLayout } from '../../../packages/notebook-network-sandbox/runtime/src/platform/filesystem-layout.js'

afterEach(() => vi.unstubAllEnvs())

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

    it('uses the Windows process-tree terminator for a timed-out shell command', () => {
      const child = {} as ChildProcess
      let finishTermination: ((result: { reaped: boolean }) => void) | undefined
      const terminateTree = vi.fn(
        () =>
          new Promise<{ reaped: boolean }>((resolve) => {
            finishTermination = resolve
          })
      )

      const termination = terminateShellOnTimeout(child, 'win32', terminateTree)

      expect(termination).toBeInstanceOf(Promise)
      expect(terminateTree).toHaveBeenCalledWith(child)
      finishTermination?.({ reaped: true })
      return expect(termination).resolves.toBe(true)
    })

    it('terminates the dedicated POSIX process group even after its shell leader exits', async () => {
      vi.useFakeTimers()
      const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const child = Object.assign(new EventEmitter(), { pid: 4321 }) as unknown as ChildProcess
      const terminateTree = vi.fn(async () => ({ reaped: true }))

      try {
        await expect(terminateShellOnTimeout(child, 'linux', terminateTree)).resolves.toBe(false)
        expect(signal).toHaveBeenCalledWith(-4321, 'SIGTERM')
        expect(terminateTree).not.toHaveBeenCalled()

        child.emit('exit', 0, 'SIGTERM')
        await vi.advanceTimersByTimeAsync(2_000)

        expect(signal).toHaveBeenCalledWith(-4321, 'SIGKILL')
      } finally {
        vi.useRealTimers()
        signal.mockRestore()
      }
    })

    it('never derives a POSIX process-group id from a missing or non-positive child pid', async () => {
      vi.useFakeTimers()
      const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const kill = vi.fn(() => true)
      const child = { pid: 0, kill } as unknown as ChildProcess

      try {
        await expect(terminateShellOnTimeout(child, 'darwin')).resolves.toBe(false)
        expect(signal).not.toHaveBeenCalled()
        expect(kill).toHaveBeenCalledWith('SIGTERM')

        await vi.advanceTimersByTimeAsync(2_000)
        expect(kill).toHaveBeenCalledWith('SIGKILL')
      } finally {
        vi.useRealTimers()
        signal.mockRestore()
      }
    })
  })

  describe.runIf(process.platform !== 'win32')('process results', () => {
    const execute = (
      command: string,
      timeoutMs = 5_000,
      signal?: AbortSignal
    ): ReturnType<typeof runShellCommand> =>
      runShellCommand({
        command,
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: join(process.cwd(), '.open-science-test-runtime'),
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

    it('wraps Notebook Bash with the shared process sandbox', async () => {
      const runtimeRoot = join(process.cwd(), '.open-science-test-runtime')
      const inputRoot = join(process.cwd(), '.open-science-test-inputs')
      const cleanup = vi.fn()
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
  })
})

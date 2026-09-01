import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runShellCommand } from './shell-process'

const POWERSHELL_PROCESS_TIMEOUT_MS = 30_000
const POWERSHELL_TEST_TIMEOUT_MS = POWERSHELL_PROCESS_TIMEOUT_MS + 5_000

const runPowerShell = (command: string): ReturnType<typeof runShellCommand> =>
  runShellCommand({
    command,
    cwd: process.cwd(),
    handoffDir: process.cwd(),
    runtimeRoot: join(process.cwd(), '.open-science-test-runtime'),
    sessionId: 'windows-shell-session',
    projectId: 'windows-shell-project',
    // Cold Windows PowerShell 5.1 module discovery on hosted runners can exceed Vitest's 15-second
    // default, while native-only and parser-error paths finish in under a second. Production allows
    // 120 seconds; this tighter process budget still detects a genuinely stuck shell.
    timeoutMs: POWERSHELL_PROCESS_TIMEOUT_MS
  })

describe.runIf(process.platform === 'win32')('Windows notebook shell integration', () => {
  it(
    'stops after a failing cmdlet',
    async () => {
      const result = await runPowerShell(
        'Get-Item "missing-open-science-file"; Write-Output "continued"'
      )

      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain('continued')
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it(
    'propagates a native process exit code',
    async () => {
      const result = await runPowerShell('cmd.exe /d /c exit 7 | Out-Null')

      expect(result.exitCode).toBe(7)
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it(
    'preserves UTF-8 output with only standard machine module paths',
    async () => {
      const result = await runPowerShell(`
Write-Output "分析完成"
Write-Output "__OPEN_SCIENCE_PSMODULEPATH__=$env:PSModulePath"
Write-Output "__OPEN_SCIENCE_INTERNAL__=[$env:OPEN_SCIENCE_PSMODULEPATH]"
`)

      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.stdout).toContain('分析完成')
      const programFiles = process.env.ProgramFiles
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
      expect(programFiles).toBeTruthy()
      expect(windowsRoot).toBeTruthy()
      if (!programFiles || !windowsRoot) throw new Error('Missing standard Windows path variables.')
      const modulePath = result.stdout.match(/^__OPEN_SCIENCE_PSMODULEPATH__=(.*)$/mu)?.[1]?.trim()
      expect(modulePath?.split(';').map((entry) => entry.toLowerCase())).toEqual([
        `${programFiles}\\WindowsPowerShell\\Modules`.toLowerCase(),
        `${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`.toLowerCase()
      ])
      expect(result.stdout).toContain('__OPEN_SCIENCE_INTERNAL__=[]')
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )

  it(
    'rejects a trailing continuation without consuming the wrapper',
    async () => {
      const result = await runPowerShell('Write-Output "isolated" `')

      expect(result.exitCode).toBe(1)
    },
    POWERSHELL_TEST_TIMEOUT_MS
  )
})

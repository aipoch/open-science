import { describe, expect, it } from 'vitest'

import { runShellCommand } from './runtime-service'

const POWERSHELL_PROCESS_TIMEOUT_MS = 30_000
const POWERSHELL_TEST_TIMEOUT_MS = POWERSHELL_PROCESS_TIMEOUT_MS + 5_000

const runPowerShell = (command: string): ReturnType<typeof runShellCommand> =>
  runShellCommand({
    command,
    cwd: process.cwd(),
    handoffDir: process.cwd(),
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
    'preserves UTF-8 output',
    async () => {
      const result = await runPowerShell('Write-Output "分析完成"')

      expect(result).toMatchObject({ exitCode: 0 })
      expect(result.stdout).toContain('分析完成')
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

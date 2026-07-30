import { describe, expect, it } from 'vitest'

import { runShellCommand } from './runtime-service'

const runPowerShell = (command: string): ReturnType<typeof runShellCommand> =>
  runShellCommand({
    command,
    cwd: process.cwd(),
    handoffDir: process.cwd(),
    timeoutMs: 10_000
  })

describe.runIf(process.platform === 'win32')('Windows notebook shell integration', () => {
  it('stops after a failing cmdlet', async () => {
    const result = await runPowerShell(
      'Get-Item "missing-open-science-file"; Write-Output "continued"'
    )

    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain('continued')
  })

  it('propagates a native process exit code', async () => {
    const result = await runPowerShell('cmd.exe /d /c exit 7 | Out-Null')

    expect(result.exitCode).toBe(7)
  })

  it('preserves UTF-8 output', async () => {
    const result = await runPowerShell('Write-Output "分析完成"')

    expect(result).toMatchObject({ exitCode: 0 })
    expect(result.stdout).toContain('分析完成')
  })

  it('rejects a trailing continuation without consuming the wrapper', async () => {
    const result = await runPowerShell('Write-Output "isolated" `')

    expect(result.exitCode).toBe(1)
  })
})

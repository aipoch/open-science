import { beforeEach, expect, it, vi } from 'vitest'
import { parsePowerShellCommands } from '@aipoch/notebook-syntax/powershell'
import { resolveWindowsNotebookRuntime } from './windows-notebook-runtime'
import { parsePowerShellSearchCommands } from './powershell-search-parser'

vi.mock('@aipoch/notebook-syntax/powershell', () => ({
  parsePowerShellCommands: vi.fn(async () => [])
}))
vi.mock('../windows-powershell', () => ({
  resolveWindowsPowerShellExecutable: () => 'system-powershell'
}))
vi.mock('./windows-notebook-runtime', () => ({
  resolveWindowsNotebookRuntime: vi.fn(() => ({ powershell: 'managed-powershell' }))
}))
beforeEach(() => vi.clearAllMocks())
it.each([
  ['5.1', 'system-powershell'],
  ['7.6', 'managed-powershell']
] as const)(
  'selects the host executable for %s and forwards inspection options',
  async (version, executable) => {
    const signal = new AbortController().signal
    await expect(
      parsePowerShellSearchCommands('Remove-Item target', signal, version, true)
    ).resolves.toEqual([])
    expect(parsePowerShellCommands).toHaveBeenCalledWith(
      executable,
      'Remove-Item target',
      signal,
      true
    )
  }
)
it('preserves promise rejection when host runtime resolution fails', async () => {
  const failure = new Error('Managed runtime unavailable')
  vi.mocked(resolveWindowsNotebookRuntime).mockImplementationOnce(() => {
    throw failure
  })
  const pending = parsePowerShellSearchCommands('Get-ChildItem', undefined, '7.6')
  await expect(pending).rejects.toBe(failure)
  expect(parsePowerShellCommands).not.toHaveBeenCalled()
})

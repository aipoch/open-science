import { parsePowerShellCommands } from '@aipoch/notebook-syntax/powershell'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { resolveWindowsNotebookRuntime } from './windows-notebook-runtime'

export type { ParsedPowerShellCommand } from '@aipoch/notebook-syntax/powershell'
export const parsePowerShellSearchCommands = (
  source: string,
  signal?: AbortSignal,
  version: '5.1' | '7.6' = '5.1',
  includeMutationEvidence = false
): ReturnType<typeof parsePowerShellCommands> => {
  try {
    return parsePowerShellCommands(
      version === '7.6'
        ? resolveWindowsNotebookRuntime().powershell
        : resolveWindowsPowerShellExecutable(),
      source,
      signal,
      includeMutationEvidence
    )
  } catch (error) {
    return Promise.reject(error)
  }
}

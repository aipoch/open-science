import { parsePowerShellCommands } from '@aipoch/notebook-syntax/powershell'
export const parsePowerShellSearchCommands = (
  source: string,
  signal?: AbortSignal,
  version: '5.1' | '7.6' = '5.1',
  includeMutationEvidence = false
): ReturnType<typeof parsePowerShellCommands> =>
  parsePowerShellCommands(
    version === '7.6' ? 'pwsh' : 'powershell.exe',
    source,
    signal,
    includeMutationEvidence
  )

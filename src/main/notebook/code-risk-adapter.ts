import { analyzePowerShellCodeRisk as analyze } from '@aipoch/notebook-code-risk'
import { parsePowerShellSearchCommands } from './powershell-search-parser'

export const analyzePowerShellCodeRisk = (
  source: string,
  signal?: AbortSignal,
  version: '5.1' | '7.6' = '5.1',
  cwd?: string
): ReturnType<typeof analyze> =>
  analyze(
    source,
    (code, signal) => parsePowerShellSearchCommands(code, signal, version, true),
    signal,
    cwd
  )

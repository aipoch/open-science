import { analyzePowerShellCodeRisk as analyze } from './index'
import * as parser from './powershell-test-support'
export { analyzeNotebookCodeRisk } from './index'
import type { NotebookCodeRiskContext } from './index'
export type NotebookSourceFileAccessContext = NotebookCodeRiskContext & {
  staticStrings: unknown[]
  staticCollections: unknown[]
  localFileWrappers: unknown[]
}
export const analyzePowerShellCodeRisk = (
  source: string,
  signal?: AbortSignal,
  version: '5.1' | '7.6' = '5.1',
  cwd?: string
): ReturnType<typeof analyze> =>
  analyze(
    source,
    (source, signal) => parser.parsePowerShellSearchCommands(source, signal, version, true),
    signal,
    cwd
  )

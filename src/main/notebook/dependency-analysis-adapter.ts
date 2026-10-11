import { join } from 'node:path'
import { NotebookDependencyAnalyzer as Analyzer } from '@aipoch/notebook-analysis'
import { getNotebookSessionRoot, getRuntimeRoot } from './repository'
import { envPrefix, pythonBin, resolveEnvName, rScriptBin } from './runtime-paths'
import { readFileGenerations as readGenerations } from '@aipoch/notebook-analysis'

type Options = ConstructorParameters<typeof Analyzer>[0]
/** Own only host resource resolution; the package owns the single analysis queue and cache. */
export class NotebookDependencyAnalyzer extends Analyzer {
  constructor(
    options: Omit<Options, 'cachePath' | 'managedInterpreter' | 'readFileGenerations'> & {
      storageRoot: string
    }
  ) {
    super({
      ...options,
      cachePath: (projectId, sessionId) =>
        join(
          getNotebookSessionRoot(options.storageRoot, projectId, sessionId),
          'cache',
          'dependency-analysis.json'
        ),
      readFileGenerations: (run, budget) => readGenerations(options.storageRoot, run, budget),
      managedInterpreter: (run) => {
        const language = run.kernelKind === 'r' ? 'r' : 'python'
        let environment: string
        try {
          environment = resolveEnvName(language, run.environment)
        } catch {
          return undefined
        }
        const prefix = envPrefix(getRuntimeRoot(options.storageRoot), environment)
        return { command: language === 'r' ? rScriptBin(prefix) : pythonBin(prefix) }
      }
    })
  }
}

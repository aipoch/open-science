import { join } from 'node:path'
import { NotebookDependencyAnalyzer } from '@aipoch/notebook-analysis'
import { readNotebookFileGenerations } from './analysis-file-evidence'
import { getNotebookSessionRoot, getRuntimeRoot } from './repository'
import { envPrefix, pythonBin, resolveEnvName, rScriptBin } from './runtime-paths'

type Options = ConstructorParameters<typeof NotebookDependencyAnalyzer>[0]

/** Bind host-authorized resources to the package's single analysis owner. */
export const createNotebookDependencyAnalyzer = (
  options: Omit<
    Options,
    'cachePath' | 'managedInterpreter' | 'readFileGenerations' | 'executionRelativeRoot'
  > & {
    storageRoot: string
  }
): NotebookDependencyAnalyzer =>
  new NotebookDependencyAnalyzer({
    ...options,
    executionRelativeRoot: 'data',
    cachePath: (projectId, sessionId) =>
      join(
        getNotebookSessionRoot(options.storageRoot, projectId, sessionId),
        'cache',
        'dependency-analysis.json'
      ),
    readFileGenerations: (run, budget) =>
      readNotebookFileGenerations(options.storageRoot, run, budget),
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

import { join } from 'node:path'
import { NotebookDependencyAnalyzer as Analyzer } from './dependency-analysis'
import type { NotebookAnalysisRun, NotebookWorkingFile } from './run-contract'
import { readGenerations } from './file-generations'
import { serializedFileContext as projectSerializedContext } from './serialized-file-provenance'
export {
  projectNotebookDependencies,
  unavailableNotebookDependencyProjection
} from './dependency-analysis'
export type {
  AnalyzeNotebookScripts,
  AnalyzedNotebookRun,
  NotebookDependencyAlias,
  NotebookDependencyAnalysisSidecar,
  NotebookDependencyCopyBinding,
  NotebookDependencyInterpreter,
  NotebookDependencyMemberWrite,
  NotebookDependencyProjection,
  NotebookFileDependency,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookFileCallEffectSummary,
  NotebookPythonHelperModule,
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessAnalysis,
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessContextRequest,
  NotebookSourceFileAccessExtraction,
  NotebookSourceFileWriteScope,
  ProjectNotebookDependenciesRequest
} from './dependency-analysis-types'
export type NotebookRunRecord = Omit<
  NotebookAnalysisRun,
  'workingFiles' | 'fileEvidence' | 'environmentManifest' | 'helperModules'
> & {
  [key: string]: unknown
  startedAt: number
  endedAt?: number
  workingFiles: (NotebookWorkingFile & { [key: string]: unknown })[]
  fileEvidence?: NonNullable<NotebookAnalysisRun['fileEvidence']> & { [key: string]: unknown }
  environmentManifest?: {
    executionContext?: {
      before: {
        pythonRandomState?: { state: 'available' | 'unavailable'; [key: string]: unknown }
        [key: string]: unknown
      }
      rPackages?: unknown
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  helperModules?: (NonNullable<NotebookAnalysisRun['helperModules']>[number] & {
    [key: string]: unknown
  })[]
}
export class NotebookDependencyAnalyzer extends Analyzer {
  constructor(
    options: Omit<ConstructorParameters<typeof Analyzer>[0], 'cachePath'> & { storageRoot: string }
  ) {
    super({
      ...options,
      cachePath: (project, session) =>
        join(
          options.storageRoot,
          'notebooks',
          project,
          session,
          'cache',
          'dependency-analysis.json'
        ),
      readFileGenerations: (run, budget) => readGenerations(options.storageRoot, run, budget),
      managedInterpreter:
        'managedInterpreter' in options
          ? options.managedInterpreter
          : () => ({ command: 'unused-managed-interpreter' })
    })
  }
}
export const serializedFileContext = (
  root: string,
  ...args: Parameters<typeof projectSerializedContext> extends [unknown, ...infer Rest]
    ? Rest
    : never
): ReturnType<typeof projectSerializedContext> =>
  projectSerializedContext((run, budget) => readGenerations(root, run, budget), ...args)

export type { NotebookLanguage } from './run-contract'

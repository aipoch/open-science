import type { NotebookLanguage } from '../../shared/notebook'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import type {
  NotebookSourceFileAccessAnalysis,
  NotebookSourceFileAccessContext
} from './dependency-analysis-types'

const analyzeNotebookSourceFileAccess = async (
  language: NotebookLanguage,
  source: string,
  context?: NotebookSourceFileAccessContext
): Promise<NotebookSourceFileAccessAnalysis> => {
  let activeContext: NotebookSourceFileAccessContext | undefined
  const analyze = language === 'r' ? analyzeRNotebookSource : analyzePythonNotebookSource
  const { facts: dependencyFacts, fileAccess } = await analyze(
    source,
    context,
    (dependencyFacts) => {
      const shadowedNames = new Set([
        ...(dependencyFacts?.definedNames ?? []),
        ...(dependencyFacts?.conditionallyDefinedNames ?? [])
      ])
      activeContext = context
        ? {
            staticStrings: context.staticStrings.filter(({ name }) => !shadowedNames.has(name)),
            staticCollections: context.staticCollections.filter(
              ({ name }) => !shadowedNames.has(name)
            ),
            localFileWrappers: context.localFileWrappers.filter(
              ({ name }) => !shadowedNames.has(name)
            ),
            // These identities are invalidated in Python statement order.
            ...(context.pythonBindings ? { pythonBindings: context.pythonBindings } : {}),
            ...(context.pythonTaintedNamespaces
              ? { pythonTaintedNamespaces: context.pythonTaintedNamespaces }
              : {}),
            ...(context.staticCollectionAliases
              ? { staticCollectionAliases: context.staticCollectionAliases }
              : {}),
            ...(context.resolvedKernelNames
              ? {
                  resolvedKernelNames: context.resolvedKernelNames.filter(
                    (name) => !shadowedNames.has(name)
                  )
                }
              : {}),
            ...(context.rFunctions
              ? { rFunctions: context.rFunctions.filter(({ name }) => !shadowedNames.has(name)) }
              : {})
          }
        : undefined
      return activeContext
    }
  )
  if (!fileAccess) {
    return {
      readState: 'unavailable',
      writeState: 'unavailable',
      externalState: 'unavailable',
      reads: [],
      writes: [],
      reasonCodes: ['source-analysis-unsupported-call']
    }
  }

  const reasonCodes: NotebookSourceFileAccessAnalysis['reasonCodes'] = []
  const unresolvedPriorNames = new Set(dependencyFacts?.priorUsedNames ?? [])
  if (language === 'r') unresolvedPriorNames.delete('pi')
  for (const safeName of dependencyFacts?.safeCallNames ?? []) unresolvedPriorNames.delete(safeName)
  for (const { name } of activeContext?.staticStrings ?? []) unresolvedPriorNames.delete(name)
  for (const { name } of activeContext?.staticCollections ?? []) unresolvedPriorNames.delete(name)
  for (const { name } of activeContext?.localFileWrappers ?? []) unresolvedPriorNames.delete(name)
  for (const name of activeContext?.resolvedKernelNames ?? []) unresolvedPriorNames.delete(name)
  const dependencyAnalysisUnavailable =
    !dependencyFacts ||
    (dependencyFacts.state === 'unknown' &&
      dependencyFacts.reasons.some(
        (reason) =>
          reason !== 'external-state' &&
          reason !== 'control-flow' &&
          !(reason === 'function-scope' && fileAccess.localFileWrappersComplete)
      ))
  if (dependencyAnalysisUnavailable || unresolvedPriorNames.size > 0) {
    reasonCodes.push('source-analysis-unsupported-call')
  }
  if (fileAccess.unresolvedReads || fileAccess.unresolvedWrites) {
    reasonCodes.push('dynamic-path-unresolved')
  }
  if (fileAccess.unsupportedExternalState || fileAccess.directoryStateRead) {
    reasonCodes.push('source-analysis-unsupported-call')
  }
  return {
    readState:
      dependencyAnalysisUnavailable ||
      unresolvedPriorNames.size > 0 ||
      fileAccess.unresolvedReads ||
      fileAccess.unsupportedExternalState
        ? 'partial'
        : 'complete',
    writeState: fileAccess.unresolvedWrites ? 'partial' : 'complete',
    externalState:
      dependencyAnalysisUnavailable ||
      fileAccess.unresolvedReads ||
      fileAccess.unresolvedWrites ||
      fileAccess.unsupportedExternalState ||
      fileAccess.directoryStateRead
        ? 'partial'
        : 'complete',
    reads: fileAccess.reads,
    writes: fileAccess.writes,
    ...(fileAccess.writeScopes?.length ? { writeScopes: fileAccess.writeScopes } : {}),
    reasonCodes: [...new Set(reasonCodes)]
  }
}

export { analyzeNotebookSourceFileAccess }

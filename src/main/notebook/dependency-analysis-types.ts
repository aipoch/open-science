import type {
  NotebookInvalidatedRun,
  NotebookRunRecord,
  NotebookRunStaleness
} from '../../shared/notebook'
import type { NotebookFileCallEffect } from './notebook-call-effects'

type NotebookDependencyAlias = {
  target: string
  source: string
  kind: 'reference' | 'possible-reference'
  access?: 'attribute' | 'subscript'
  member?: string
}

type NotebookDependencyTypeSummary = {
  name: string
  kind: 'python-class' | 'python-module' | 'r-s4' | 'r-r6' | 'r-function'
  complete?: boolean
  fields: Array<{ name: string; relationship: 'reference' | 'value' | 'unknown' }>
  methods: Array<{
    name: string
    effect: 'read' | 'mutate' | 'unknown'
    usedNames?: string[]
    safeCallNames?: string[]
    unknownScope?: 'receiver' | 'namespace'
    returnType?: string | null
    destructuredReturnTypes?: string[]
    mutatesKeyword?: string | null
  }>
}

type NotebookDependencyTypeBinding = {
  target: string
  typeName: string
  argumentNames?: string[]
}

type NotebookDependencyCopyBinding = {
  target: string
  sourceNames: string[]
}

type NotebookDependencyReceiverCall = {
  receiver: string
  member: string
  conditional?: boolean
  kind?: 'receiver' | 'generic' | 'mutating' | 'callable'
  argumentNames?: string[]
  receiverChain?: string[]
  receiverChainFirstArgumentNames?: string[][]
  receiverChainPositionalArgumentNames?: string[][][]
  receiverChainPositionalStaticBooleans?: Array<Array<boolean | null>>
  receiverChainKeywordArguments?: Array<
    Array<{ name: string; argumentNames: string[]; staticBoolean?: boolean | null }>
  >
  receiverValueNames?: string[]
  positionalArgumentNames?: string[][]
  positionalStaticBooleans?: Array<boolean | null>
  resultNames?: string[]
  // Each flattened result name retains its position in a nested unpacking target.
  resultPaths?: number[][]
  keywordArguments?: Array<{
    name: string
    argumentNames: string[]
    possibleArgumentNames?: string[]
    staticBoolean?: boolean | null
    callableReferences?: Array<{ root: string; member?: string; container?: 'list' | 'dict' }>
  }>
}

type NotebookDependencyMemberWrite = {
  receiver: string
  member?: string
  scope?: 'instance' | 'type'
  conditional?: boolean
}

type NotebookFileCallEffectSummary = Pick<NotebookFileCallEffect, 'kind' | 'inputForm'> & {
  name: string
  position: number
  keywords: string[]
  dependencyNames: string[]
}

type NotebookSourceFileAccessContext = {
  staticStrings: Array<{ name: string; value: string }>
  staticCollections: Array<{
    name: string
    values: string[]
    entries?: Array<{ key: string; value: string }>
    rKind?: 'vector' | 'list'
  }>
  localFileWrappers: NotebookFileCallEffectSummary[]
  // Bounded identities only: no live objects, interpreter handles or settings.
  pythonBindings?: Array<{ name: string; qualifiedName: string; kind: 'import' | 'object' }>
  // Observed monkeypatches survive re-imports within the same kernel epoch.
  pythonTaintedNamespaces?: string[]
  // Derived from prior same-epoch facts for the live run only. The bounded sidecar serializer
  // deliberately omits this field, so dependency-analysis.json remains unchanged.
  resolvedKernelNames?: string[]
  // Transient callable knowledge rebuilt from same-epoch dependency facts.
  rFunctions?: Array<{ name: string; summary: NotebookDependencyTypeSummary }>
  // Transient reference identities for Python collections; rebuilt from same-epoch facts.
  staticCollectionAliases?: Array<{ target: string; source: string }>
}

type NotebookRunDependencyFacts =
  | {
      state: 'available'
      definedNames: string[]
      conditionallyDefinedNames?: string[]
      usedNames: string[]
      priorUsedNames?: string[]
      possiblyUsedNames?: string[]
      mutatedNames: string[]
      possiblyMutatedNames?: string[]
      aliases?: NotebookDependencyAlias[]
      builtinContainerNames?: string[]
      copyOnModifyNames?: string[]
      copyOnModifyBindings?: NotebookDependencyCopyBinding[]
      copyOnModifyInvalidatedNames?: string[]
      safeCallNames?: string[]
      safeCallArgumentNames?: string[]
      typeSummaries?: NotebookDependencyTypeSummary[]
      typeBindings?: NotebookDependencyTypeBinding[]
      receiverCalls?: NotebookDependencyReceiverCall[]
      memberWrites?: NotebookDependencyMemberWrite[]
    }
  | {
      state: 'unknown'
      reasons: string[]
      definedNames?: string[]
      conditionallyDefinedNames?: string[]
      usedNames?: string[]
      priorUsedNames?: string[]
      possiblyUsedNames?: string[]
      mutatedNames?: string[]
      possiblyMutatedNames?: string[]
      aliases?: NotebookDependencyAlias[]
      builtinContainerNames?: string[]
      copyOnModifyNames?: string[]
      copyOnModifyBindings?: NotebookDependencyCopyBinding[]
      copyOnModifyInvalidatedNames?: string[]
      safeCallNames?: string[]
      safeCallArgumentNames?: string[]
      typeSummaries?: NotebookDependencyTypeSummary[]
      typeBindings?: NotebookDependencyTypeBinding[]
      receiverCalls?: NotebookDependencyReceiverCall[]
      memberWrites?: NotebookDependencyMemberWrite[]
    }

type AnalyzedNotebookRun = {
  run: NotebookRunRecord
  facts: NotebookRunDependencyFacts
}

type NotebookDependencyProjection = {
  stalenessByRunId: Record<string, NotebookRunStaleness>
  invalidatedByRunId: Record<string, NotebookInvalidatedRun[]>
  dependenciesByRunId?: Record<string, string[]>
}

type NotebookDependencyInterpreter = { command: string; args?: string[]; condaPrefix?: string }

type NotebookDependencyAnalysisSidecar = {
  version: 1
  analyzerVersion: 1
  runs: Record<
    string,
    {
      checksum: string
      facts: NotebookRunDependencyFacts
      fileContext?: NotebookSourceFileAccessContext
    }
  >
  projectionSnapshots: Record<
    string,
    {
      checksum: string
      projection: NotebookDependencyProjection
    }
  >
}

type ProjectNotebookDependenciesRequest = {
  projectId: string
  sessionId: string
  completedRun?: NotebookRunRecord
  interpreter?: NotebookDependencyInterpreter
  throughRunId?: string
}

type NotebookSourceFileAccessContextRequest = {
  projectId: string
  sessionId: string
  currentRunId: string
  language: 'python' | 'r'
  environment?: string
  kernelEpochId: string
}

type AnalyzeNotebookScripts = (
  interpreter: NotebookDependencyInterpreter,
  language: 'python' | 'r',
  sources: readonly string[]
) => Promise<NotebookRunDependencyFacts[]>

type NotebookSourceFileWriteScope = {
  kind: 'directory' | 'shapefile' | 'geotiff'
  path: string
}

type NotebookSourceFileAccessExtraction = {
  reads: string[]
  writes: string[]
  writeScopes?: NotebookSourceFileWriteScope[]
  unresolvedReads: boolean
  unresolvedWrites: boolean
  unsupportedExternalState: boolean
  directoryStateRead: boolean
  localFileWrappersComplete: boolean
  context: NotebookSourceFileAccessContext
}

type NotebookSourceFileAccessAnalysis = {
  readState: 'complete' | 'partial' | 'unavailable'
  writeState: 'complete' | 'partial' | 'unavailable'
  externalState: 'complete' | 'partial' | 'unavailable'
  reads: string[]
  writes: string[]
  writeScopes?: NotebookSourceFileWriteScope[]
  reasonCodes: Array<'dynamic-path-unresolved' | 'source-analysis-unsupported-call'>
}

export type {
  AnalyzeNotebookScripts,
  AnalyzedNotebookRun,
  NotebookDependencyAlias,
  NotebookDependencyAnalysisSidecar,
  NotebookDependencyCopyBinding,
  NotebookDependencyInterpreter,
  NotebookDependencyMemberWrite,
  NotebookDependencyProjection,
  NotebookDependencyReceiverCall,
  NotebookDependencyTypeBinding,
  NotebookDependencyTypeSummary,
  NotebookFileCallEffectSummary,
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessAnalysis,
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessContextRequest,
  NotebookSourceFileAccessExtraction,
  NotebookSourceFileWriteScope,
  ProjectNotebookDependenciesRequest
}

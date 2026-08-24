import type {
  NotebookInvalidatedRun,
  NotebookRunRecord,
  NotebookRunStaleness
} from '../../shared/notebook'

type NotebookDependencyAlias = {
  target: string
  source: string
  kind: 'reference' | 'possible-reference'
  access?: 'attribute' | 'subscript'
  member?: string
}

type NotebookDependencyTypeSummary = {
  name: string
  kind: 'python-class' | 'python-module' | 'r-s4' | 'r-r6'
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
    }
  >
}

type ProjectNotebookDependenciesRequest = {
  projectId: string
  sessionId: string
  completedRun?: NotebookRunRecord
  interpreter?: NotebookDependencyInterpreter
}

type AnalyzeNotebookScripts = (
  interpreter: NotebookDependencyInterpreter,
  language: 'python' | 'r',
  sources: readonly string[]
) => Promise<NotebookRunDependencyFacts[]>

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
  NotebookRunDependencyFacts,
  ProjectNotebookDependenciesRequest
}

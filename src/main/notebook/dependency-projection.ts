import { isAbsolute, normalize, relative, resolve } from 'node:path'

import type {
  NotebookInvalidatedRun,
  NotebookRunRecord,
  NotebookRunStaleness,
  NotebookWorkingFile
} from '../../shared/notebook'
import { notebookExecutionContextSchema } from '../../shared/notebook-execution-context'
import type {
  AnalyzedNotebookRun,
  NotebookDependencyAlias,
  NotebookDependencyProjection,
  NotebookFileDependency,
  NotebookDependencyTypeSummary,
  NotebookDependencyReceiverCall,
  NotebookRunDependencyFacts,
  NotebookSourceFileWriteScope
} from './dependency-analysis-types'
import { matchesWriteScope } from './working-file-observer'
import {
  PYTHON_LIBRARY_EFFECTS,
  pythonUnpackedReturnType,
  pythonArgumentShapeReturnType,
  type PythonArgumentShape,
  type PythonLibraryMethodEffect
} from './python-library-effects'

const DYNAMIC_NAMESPACE_ROOTS = new Set([
  'builtins',
  '__builtins__',
  '.GlobalEnv',
  '.BaseNamespaceEnv'
])
const R_DEFAULT_PACKAGES = new Set([
  'base',
  'utils',
  'stats',
  'graphics',
  'grDevices',
  'methods',
  'datasets'
])
const R_STATIC_DISPATCH_MEMBERS = new Set([
  'altExp',
  'altExps',
  'assay',
  'assays',
  'colData',
  'colLabels',
  'experimentData',
  'exprs',
  'fData',
  'featureData',
  'logcounts',
  'metadata',
  'normcounts',
  'pData',
  'reducedDim',
  'reducedDims',
  'rowData',
  'rowRanges',
  'rowSubset',
  'sizeFactors'
])
const R_DATA_TABLE_REFERENCE_MUTATORS = new Set([
  ':=',
  'set',
  'setalloccol',
  'setattr',
  'setcolorder',
  'setDF',
  'setDT',
  'setindex',
  'setindexv',
  'setkey',
  'setkeyv',
  'setnafill',
  'setnames',
  'setorder',
  'setorderv'
])
const isIncompleteRun = (run: NotebookRunRecord): boolean =>
  run.status === 'failed' ||
  run.status === 'timeout' ||
  run.status === 'interrupted' ||
  run.status === 'cancelled'

const namespaceKey = (run: NotebookRunRecord): string | undefined => {
  const projectedStatus = run.status === 'completed' || isIncompleteRun(run)
  if (
    (run.kernelKind !== 'python' && run.kernelKind !== 'r' && run.kernelKind !== 'repl') ||
    !run.kernelEpochId
  ) {
    return undefined
  }
  if (!projectedStatus) return undefined
  if (isIncompleteRun(run) && run.kernelDispatched === false) {
    return undefined
  }
  return [run.kernelKind, run.environment ?? '', run.kernelEpochId].join('\0')
}

const portablePath = (value: string): string =>
  value
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/\/{2,}/gu, '/')

const lineagePathCase = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

const lineageWorkingDirectory = (run: NotebookRunRecord): string | undefined =>
  run.cwdBefore ?? run.frozenShellContext?.cwd

// Historical run records may omit cwdBefore while retaining a complete runtime file-evidence
// summary. That evidence anchors relative paths to the session's observed roots, so preserve the
// legacy textual identity for those records. Without the anchor, keep relative paths run-local.
const hasCompleteRuntimeFileEvidence = (run: NotebookRunRecord): boolean =>
  run.fileEvidence?.state === 'available' &&
  run.fileEvidence.fileReads === 'complete' &&
  run.fileEvidence.relationCount !== 0

const hasCompleteRuntimeWriterEvidence = (run: NotebookRunRecord): boolean =>
  hasCompleteRuntimeFileEvidence(run) && run.fileEvidence?.writerAttribution === 'complete'

const lineageScopePath = (run: NotebookRunRecord, value: string): string => {
  const workingDirectory = lineageWorkingDirectory(run)
  if (workingDirectory === undefined) return lineagePathCase(portablePath(value))
  const resolved = isAbsolute(value) ? value : resolve(workingDirectory, value)
  return lineagePathCase(portablePath(relative(workingDirectory, resolved)))
}

const lineageScope = (
  run: NotebookRunRecord,
  scope: NotebookSourceFileWriteScope
): NotebookSourceFileWriteScope => ({
  ...scope,
  path: lineageScopePath(run, scope.path)
})

const matchesLineageScope = (scope: NotebookSourceFileWriteScope, candidate: string): boolean => {
  if (scope.kind === 'directory' && scope.path === '') return candidate.length > 0
  return matchesWriteScope(scope, candidate)
}

const lineagePathKey = (run: NotebookRunRecord, value: string): string => {
  const portable = lineagePathCase(portablePath(value))
  const workingDirectory = lineageWorkingDirectory(run)
  if (isAbsolute(value)) return `absolute:${lineagePathCase(portablePath(normalize(value)))}`
  if (workingDirectory !== undefined)
    return `absolute:${lineagePathCase(portablePath(normalize(resolve(workingDirectory, value))))}`
  if (hasCompleteRuntimeFileEvidence(run)) return `relative:evidence:${portable}`
  // Without cwd/session identity, a relative spelling is local to this run. Keep
  // same-run generation matching, but never alias it across independent runs.
  return `relative:${run.runId}:${portable}`
}

// Resolve a path against the run that observed it.  Scope invalidation can
// compare files from a different cwd than the run declaring the scope, so a
// relative path must never be interpreted through the current consumer cwd.
const absoluteLineagePath = (run: NotebookRunRecord, value: string): string | undefined => {
  const workingDirectory = lineageWorkingDirectory(run)
  if (!isAbsolute(value) && workingDirectory === undefined) return undefined
  return lineagePathCase(
    portablePath(isAbsolute(value) ? normalize(value) : resolve(workingDirectory!, value))
  )
}

const matchesAbsoluteLineageScope = (
  scopeRun: NotebookRunRecord,
  scope: NotebookSourceFileWriteScope,
  candidateRun: NotebookRunRecord,
  candidatePath: string
): boolean | undefined => {
  const scopePath = absoluteLineagePath(scopeRun, scope.path)
  const candidate = absoluteLineagePath(candidateRun, candidatePath)
  if (scopePath === undefined || candidate === undefined) return undefined
  return matchesWriteScope({ ...scope, path: scopePath }, candidate)
}

const isUnanchoredRelativePath = (run: NotebookRunRecord, key: string): boolean =>
  lineageWorkingDirectory(run) === undefined &&
  !hasCompleteRuntimeFileEvidence(run) &&
  key.startsWith(`relative:${run.runId}:`)

const matchesObservedFile = (
  run: NotebookRunRecord,
  requestedPath: string,
  file: NotebookWorkingFile
): boolean => {
  if (lineagePathKey(run, requestedPath) === lineagePathKey(run, file.path)) return true
  return (
    lineageWorkingDirectory(run) === undefined &&
    hasCompleteRuntimeFileEvidence(run) &&
    file.relativePath !== undefined &&
    lineagePathCase(portablePath(file.relativePath)) ===
      lineagePathCase(portablePath(requestedPath))
  )
}

const observedFileGeneration = (
  run: NotebookRunRecord,
  path: string
): NotebookWorkingFile | undefined =>
  run.workingFiles.find((file) => {
    if (!matchesObservedFile(run, path, file)) return false
    return (
      file.createdByRunId === run.runId || file.change === 'created' || file.change === 'modified'
    )
  })

const observedScopedGenerations = (
  run: NotebookRunRecord,
  scopes: readonly NotebookSourceFileWriteScope[]
): NotebookWorkingFile[] =>
  run.workingFiles.filter((file) => {
    const candidatePaths = [
      lineageScopePath(run, file.path),
      ...(lineageWorkingDirectory(run) === undefined &&
      hasCompleteRuntimeFileEvidence(run) &&
      file.relativePath
        ? [lineageScopePath(run, file.relativePath)]
        : [])
    ]
    return (
      scopes.some(
        (scope) =>
          matchesAbsoluteLineageScope(run, scope, run, file.path) ??
          candidatePaths.some(
            (candidatePath) =>
              candidatePath !== '..' &&
              !candidatePath.startsWith('../') &&
              matchesLineageScope(lineageScope(run, scope), candidatePath)
          )
      ) &&
      (file.createdByRunId === run.runId || file.change === 'created' || file.change === 'modified')
    )
  })

const incompleteRunFacts = (
  facts: NotebookRunDependencyFacts
): { facts: NotebookRunDependencyFacts; affectedNames: string[] } => {
  const affectedNames = [
    ...(facts.definedNames ?? []),
    ...(facts.mutatedNames ?? []),
    ...(facts.possiblyMutatedNames ?? []),
    ...(facts.copyOnModifyInvalidatedNames ?? []),
    ...(facts.memberWrites ?? []).map(({ receiver }) => receiver)
  ].filter((name) => name.length > 0)

  return {
    facts: {
      state: 'unknown',
      reasons: ['incomplete-run'],
      definedNames: [],
      usedNames: [],
      priorUsedNames: [],
      possiblyUsedNames: [],
      mutatedNames: [],
      possiblyMutatedNames: [...new Set(affectedNames)],
      aliases: (facts.aliases ?? []).map((alias) => ({
        ...alias,
        kind: 'possible-reference'
      })),
      builtinContainerNames: [],
      copyOnModifyNames: [],
      copyOnModifyBindings: [],
      copyOnModifyInvalidatedNames: [],
      safeCallNames: [],
      safeCallArgumentNames: [],
      typeSummaries: [],
      typeBindings: [],
      receiverCalls: facts.receiverCalls ?? [],
      ...(facts.pythonPlottingState ? { pythonPlottingState: facts.pythonPlottingState } : {}),
      memberWrites: facts.memberWrites ?? []
    },
    affectedNames
  }
}

const dependencyPath = (
  fromRunId: string,
  toRunId: string,
  downstream: ReadonlyMap<string, ReadonlySet<string>>
): string[] => {
  const queue: string[][] = [[fromRunId]]
  const visited = new Set([fromRunId])
  while (queue.length > 0) {
    const path = queue.shift()!
    const current = path[path.length - 1]!
    if (current === toRunId) return path
    for (const next of downstream.get(current) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push([...path, next])
    }
  }
  return [fromRunId, toRunId]
}

const descendantsOf = (
  runId: string,
  downstream: ReadonlyMap<string, ReadonlySet<string>>
): string[] => {
  const result: string[] = []
  const queue = [...(downstream.get(runId) ?? [])]
  const visited = new Set(queue)
  while (queue.length > 0) {
    const current = queue.shift()!
    result.push(current)
    for (const next of downstream.get(current) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push(next)
    }
  }
  return result
}

const detachPossibleAlias = (name: string, aliases: Map<string, Set<string>>): void => {
  for (const neighbor of aliases.get(name) ?? []) {
    const neighbors = aliases.get(neighbor)
    neighbors?.delete(name)
    if (neighbors?.size === 0) aliases.delete(neighbor)
  }
  aliases.delete(name)
}

const linkPossibleAlias = (
  left: string,
  right: string,
  aliases: Map<string, Set<string>>
): void => {
  if (left === right) return
  const leftNeighbors = aliases.get(left) ?? new Set<string>()
  leftNeighbors.add(right)
  aliases.set(left, leftNeighbors)
  const rightNeighbors = aliases.get(right) ?? new Set<string>()
  rightNeighbors.add(left)
  aliases.set(right, rightNeighbors)
}

const linkAliasClass = (left: string, right: string, aliases: Map<string, Set<string>>): void => {
  const members = new Set([left, right])
  const queue = [left, right]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const neighbor of aliases.get(current) ?? []) {
      if (members.has(neighbor)) continue
      members.add(neighbor)
      queue.push(neighbor)
    }
  }
  for (const member of members) {
    aliases.set(member, new Set([...members].filter((candidate) => candidate !== member)))
  }
}

class NotebookDependencyProjector {
  private readonly stalenessByRunId: Record<string, NotebookRunStaleness> = {}
  private readonly invalidatedByRunId: Record<string, NotebookInvalidatedRun[]> = {}
  private readonly rPackageLoadsByNamespace = new Map<string, Map<string, string>>()
  private readonly pythonPlottingStateByNamespace = new Map<string, string>()
  private readonly rThemeStateByNamespace = new Map<string, string>()
  private readonly rOptionWritesByNamespace = new Map<string, Map<string, string>>()
  private readonly rGraphicsStateByNamespace = new Map<string, string>()
  private readonly latestDefinitionsByNamespace = new Map<string, Map<string, string>>()
  private readonly referenceTokensByNamespace = new Map<string, Map<string, string>>()
  private readonly possibleAliasesByNamespace = new Map<string, Map<string, Set<string>>>()
  private readonly rCopyAliasesByNamespace = new Map<string, Map<string, Set<string>>>()
  private readonly builtinContainersByNamespace = new Map<string, Set<string>>()
  private readonly pythonCallbackContainersByNamespace = new Map<string, Map<string, string[]>>()
  private readonly copyOnModifyNamesByNamespace = new Map<string, Set<string>>()
  private readonly typeSummariesByNamespace = new Map<
    string,
    Map<string, NotebookDependencyTypeSummary>
  >()
  private readonly objectTypesByNamespace = new Map<
    string,
    Map<string, NotebookDependencyTypeSummary>
  >()
  private readonly shadowedMembersByNamespace = new Map<string, Map<string, Set<string>>>()
  private readonly shadowedTypeMembers = new WeakMap<NotebookDependencyTypeSummary, Set<string>>()
  private readonly safeCallConsumersByNamespace = new Map<string, Map<string, Set<string>>>()
  private readonly possibleConsumersByNamespace = new Map<string, Map<string, Set<string>>>()
  private readonly unknownReasonsByNamespace = new Map<string, string[]>()
  private readonly uncertainBindingsByNamespace = new Map<string, Map<string, string[]>>()
  private readonly runIdsByNamespace = new Map<string, string[]>()
  private readonly downstream = new Map<string, Set<string>>()
  private readonly namedConsumers = new Map<string, Set<string>>()
  private readonly directDependenciesByRunId = new Map<string, Set<string>>()
  private readonly runsById = new Map<string, NotebookRunRecord>()
  private readonly incompleteRunIds = new Set<string>()

  append({ run, facts: analyzedFacts }: AnalyzedNotebookRun): void {
    const {
      stalenessByRunId,
      invalidatedByRunId,
      latestDefinitionsByNamespace,
      referenceTokensByNamespace,
      possibleAliasesByNamespace,
      rCopyAliasesByNamespace,
      builtinContainersByNamespace,
      pythonCallbackContainersByNamespace,
      copyOnModifyNamesByNamespace,
      typeSummariesByNamespace,
      objectTypesByNamespace,
      shadowedMembersByNamespace,
      shadowedTypeMembers,
      safeCallConsumersByNamespace,
      possibleConsumersByNamespace,
      unknownReasonsByNamespace,
      uncertainBindingsByNamespace,
      runIdsByNamespace,
      downstream,
      namedConsumers,
      directDependenciesByRunId,
      runsById
    } = this
    runsById.set(run.runId, run)
    const incompleteRun = isIncompleteRun(run)
    if (incompleteRun) this.incompleteRunIds.add(run.runId)
    const incomplete = incompleteRun ? incompleteRunFacts(analyzedFacts) : undefined
    const facts = incomplete?.facts ?? analyzedFacts
    const conditionallyDefinedNames = new Set(facts.conditionallyDefinedNames ?? [])
    const namespace = namespaceKey(run)
    if (!namespace) {
      if (
        run.status === 'completed' &&
        (run.kernelKind === 'python' || run.kernelKind === 'r' || run.kernelKind === 'repl')
      ) {
        stalenessByRunId[run.runId] = {
          state: 'unknown',
          reasons: ['kernel-epoch-unavailable']
        }
      }
      return
    }
    const latestDefinitions =
      latestDefinitionsByNamespace.get(namespace) ?? new Map<string, string>()
    latestDefinitionsByNamespace.set(namespace, latestDefinitions)
    const referenceTokens = referenceTokensByNamespace.get(namespace) ?? new Map<string, string>()
    referenceTokensByNamespace.set(namespace, referenceTokens)
    const possibleAliases =
      possibleAliasesByNamespace.get(namespace) ?? new Map<string, Set<string>>()
    possibleAliasesByNamespace.set(namespace, possibleAliases)
    const rCopyAliases = rCopyAliasesByNamespace.get(namespace) ?? new Map<string, Set<string>>()
    rCopyAliasesByNamespace.set(namespace, rCopyAliases)
    const rCopyAliasesAtRunStart = new Map(
      [...rCopyAliases].map(([name, aliases]) => [name, new Set(aliases)])
    )
    const builtinContainers = builtinContainersByNamespace.get(namespace) ?? new Set<string>()
    builtinContainersByNamespace.set(namespace, builtinContainers)
    const callbackContainers =
      pythonCallbackContainersByNamespace.get(namespace) ?? new Map<string, string[]>()
    pythonCallbackContainersByNamespace.set(namespace, callbackContainers)
    const callbackNamespaceUncertain =
      incompleteRun ||
      (facts.state === 'unknown' &&
        facts.reasons.some(
          (reason) =>
            [
              'dynamic-namespace',
              'dynamic-assignment',
              'wildcard-import',
              'alias-rebind',
              'class-scope',
              'comprehension-scope',
              'analysis-unavailable',
              'analysis-unknown',
              'invalid-parser-result',
              'parse-error'
            ].includes(reason) || reason.startsWith('parser-')
        ))
    if (callbackNamespaceUncertain) callbackContainers.clear()
    // Lists capture a function object, not a live binding to its old global name.
    // A rebind or uncertain alias must not turn that stored object into the new one.
    const callbackCandidateWrites = new Set([
      ...(facts.definedNames ?? []),
      ...(facts.conditionallyDefinedNames ?? [])
    ])
    const callbackAliasExposures = new Set(
      (facts.aliases ?? []).flatMap((alias) => [alias.source, alias.target])
    )
    for (const [container, callbacks] of callbackContainers) {
      if (
        [container, ...callbacks].some(
          (name) =>
            callbackCandidateWrites.has(name) ||
            callbackAliasExposures.has(name) ||
            (name === container && (facts.mutatedNames ?? []).includes(name)) ||
            (name !== container && (facts.possiblyMutatedNames ?? []).includes(name))
        )
      )
        callbackContainers.delete(container)
    }
    const copyOnModifyNames = copyOnModifyNamesByNamespace.get(namespace) ?? new Set<string>()
    copyOnModifyNamesByNamespace.set(namespace, copyOnModifyNames)
    const copyOnModifyNamesAtRunStart = new Set(copyOnModifyNames)
    const typeSummaries =
      typeSummariesByNamespace.get(namespace) ?? new Map<string, NotebookDependencyTypeSummary>()
    typeSummariesByNamespace.set(namespace, typeSummaries)
    const objectTypes =
      objectTypesByNamespace.get(namespace) ?? new Map<string, NotebookDependencyTypeSummary>()
    objectTypesByNamespace.set(namespace, objectTypes)
    const objectTypesAtRunStart = new Map(objectTypes)
    const knownRValuesAtRunStart = new Set([
      ...copyOnModifyNames,
      ...[...objectTypes]
        .filter(
          ([, summary]) =>
            summary.kind === 'r-s4' &&
            summary.fields.every((field) => field.relationship === 'value')
        )
        .map(([name]) => name)
    ])
    const typeBehaviorChanges = new Set<string>()
    const completeSummaryNames = new Set(
      (facts.typeSummaries ?? [])
        .filter((summary) => summary.complete !== false)
        .map((summary) => summary.name)
    )
    for (const name of facts.definedNames ?? []) {
      if (!completeSummaryNames.has(name)) typeSummaries.delete(name)
    }
    for (const summary of facts.typeSummaries ?? []) {
      if (summary.complete !== false) {
        const existing = typeSummaries.get(summary.name)
        if (summary.kind === 'python-module' && existing?.kind === 'python-module') continue
        typeSummaries.set(summary.name, summary)
        continue
      }
      const existing = typeSummaries.get(summary.name)
      if (!existing || existing.kind !== summary.kind) continue
      for (const [name, objectSummary] of objectTypes) {
        if (objectSummary === existing) typeBehaviorChanges.add(name)
      }
      const fields = new Map(existing.fields.map((field) => [field.name, field]))
      for (const field of summary.fields) fields.set(field.name, field)
      const methods = new Map(existing.methods.map((method) => [method.name, method]))
      for (const method of summary.methods) methods.set(method.name, method)
      existing.fields.splice(0, existing.fields.length, ...fields.values())
      existing.methods.splice(0, existing.methods.length, ...methods.values())
    }
    const shadowedMembers =
      shadowedMembersByNamespace.get(namespace) ?? new Map<string, Set<string>>()
    shadowedMembersByNamespace.set(namespace, shadowedMembers)
    const safeCallConsumers =
      safeCallConsumersByNamespace.get(namespace) ?? new Map<string, Set<string>>()
    safeCallConsumersByNamespace.set(namespace, safeCallConsumers)
    const possibleConsumers =
      possibleConsumersByNamespace.get(namespace) ?? new Map<string, Set<string>>()
    possibleConsumersByNamespace.set(namespace, possibleConsumers)
    const uncertainBindings =
      uncertainBindingsByNamespace.get(namespace) ?? new Map<string, string[]>()
    uncertainBindingsByNamespace.set(namespace, uncertainBindings)
    const pendingTypeBindings = new Map(
      (facts.typeBindings ?? [])
        .map((binding) => {
          const summary = typeSummaries.get(binding.typeName)
          return summary ? ([binding.target, summary] as const) : undefined
        })
        .filter(
          (binding): binding is readonly [string, NotebookDependencyTypeSummary] =>
            binding !== undefined
        )
    )
    const callableSummary = (receiver: string): NotebookDependencyTypeSummary | undefined => {
      const pending = pendingTypeBindings.get(receiver)
      if (pending) return pending
      if ((facts.definedNames ?? []).includes(receiver)) return undefined
      return objectTypes.get(receiver)
    }
    const resolvedCallableResultNames = new Set(
      (facts.receiverCalls ?? [])
        .filter(
          (call) =>
            call.kind === 'callable' &&
            callableSummary(call.receiver)?.methods.some((method) => method.name === '__call__')
        )
        .flatMap((call) => call.resultNames ?? [])
    )
    const unresolvedConstructor = (facts.typeBindings ?? []).some(
      (binding) =>
        binding.typeName !== 'python.object' &&
        !typeSummaries.has(binding.typeName) &&
        !resolvedCallableResultNames.has(binding.target)
    )
    const unresolvedConstructorArguments = (facts.typeBindings ?? [])
      .filter(
        (binding) =>
          binding.typeName !== 'python.object' &&
          !typeSummaries.has(binding.typeName) &&
          !resolvedCallableResultNames.has(binding.target)
      )
      .flatMap((binding) => binding.argumentNames ?? [])
    const typeAwareMutatedNames: string[] = []
    const typeAwarePossiblyMutatedNames: string[] = [...unresolvedConstructorArguments]
    const typeAwarePossibleAliases: NotebookDependencyAlias[] = []
    const typeAwareUsedNames: string[] = []
    const typeAwareSafeCallNames: string[] = []
    const knownBuiltinContainers = new Set([
      ...builtinContainers,
      ...(facts.builtinContainerNames ?? [])
    ])
    const nameIsShadowed = (name: string): boolean =>
      latestDefinitions.has(name) || (facts.definedNames ?? []).includes(name)
    const typeAwareReasons: string[] = [
      ...(unresolvedConstructor ? ['opaque-call'] : []),
      ...(unresolvedConstructorArguments.length > 0 ? ['opaque-mutation'] : [])
    ]
    for (const [target, typeSummary] of pendingTypeBindings) {
      const constructorName = typeSummary.kind === 'python-class' ? '__init__' : 'initialize'
      const constructor = typeSummary.methods.find((method) => method.name === constructorName)
      typeAwareUsedNames.push(...(constructor?.usedNames ?? []))
      typeAwareSafeCallNames.push(...(constructor?.safeCallNames ?? []))
      if (constructor?.safeCallNames?.some(nameIsShadowed)) {
        const argumentsForTarget =
          facts.typeBindings?.find((binding) => binding.target === target)?.argumentNames ?? []
        typeAwarePossiblyMutatedNames.push(...argumentsForTarget)
        typeAwareReasons.push('opaque-mutation', 'opaque-call', 'dynamic-namespace')
      }
      if (constructor?.effect === 'unknown') {
        const argumentsForTarget =
          facts.typeBindings?.find((binding) => binding.target === target)?.argumentNames ?? []
        typeAwarePossiblyMutatedNames.push(...argumentsForTarget)
        typeAwareReasons.push('opaque-mutation')
        if (constructor.unknownScope === 'namespace') {
          typeAwareReasons.push('opaque-call', 'dynamic-namespace')
        }
      }
    }
    const receiversMayAlias = (left: string, right: string): boolean => {
      if (left === right) return true
      const leftToken = referenceTokens.get(left)
      const rightToken = referenceTokens.get(right)
      if (leftToken && rightToken && leftToken === rightToken) return true
      const queue = [left]
      const visited = new Set(queue)
      while (queue.length > 0) {
        const current = queue.shift()!
        const currentToken = referenceTokens.get(current)
        const neighbors = (facts.aliases ?? []).flatMap((alias) =>
          alias.target === current ? [alias.source] : alias.source === current ? [alias.target] : []
        )
        if (currentToken) {
          neighbors.push(
            ...[...referenceTokens.entries()]
              .filter(([, token]) => token === currentToken)
              .map(([name]) => name)
          )
        }
        neighbors.push(...(possibleAliases.get(current) ?? []))
        for (const neighbor of neighbors) {
          if (neighbor === right) return true
          if (visited.has(neighbor)) continue
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
      return false
    }
    for (const write of facts.memberWrites ?? []) {
      const classSummary =
        [...typeSummaries.entries()].find(([name]) =>
          receiversMayAlias(write.receiver, name)
        )?.[1] ?? (write.scope === 'type' ? objectTypes.get(write.receiver) : undefined)
      if (!classSummary) continue
      const affectedObjects = [...objectTypes.entries()]
        .filter(([, summary]) => summary === classSummary)
        .map(([name]) => name)
      for (const name of affectedObjects) typeBehaviorChanges.add(name)
      if (write.conditional) {
        const members = shadowedTypeMembers.get(classSummary) ?? new Set<string>()
        members.add(write.member ?? '*')
        shadowedTypeMembers.set(classSummary, members)
        continue
      }
      const methods = write.member
        ? classSummary.methods.filter((method) => method.name === write.member)
        : classSummary.methods
      for (const method of methods) {
        method.effect = 'unknown'
        method.unknownScope = 'namespace'
      }
    }
    const libraryEffectFor = (
      summary: NotebookDependencyTypeSummary | undefined,
      methodName: string
    ): PythonLibraryMethodEffect | undefined => {
      if (!summary) return undefined
      const direct = PYTHON_LIBRARY_EFFECTS[summary.name]?.methods[methodName]
      if (direct) return direct
      if (methodName !== '__call__' || !summary.name.startsWith('python-callable:')) {
        return undefined
      }
      const canonicalName = summary.name.slice('python-callable:'.length)
      const moduleName = Object.keys(PYTHON_LIBRARY_EFFECTS)
        .filter(
          (candidate) =>
            PYTHON_LIBRARY_EFFECTS[candidate]?.kind === 'module' &&
            canonicalName.startsWith(`${candidate}.`)
        )
        .sort((left, right) => right.length - left.length)[0]
      if (!moduleName) return undefined
      return PYTHON_LIBRARY_EFFECTS[moduleName]?.methods[canonicalName.slice(moduleName.length + 1)]
    }
    const returnTypeForCall = (
      fallback: string | null | undefined,
      effect: PythonLibraryMethodEffect | undefined,
      keywords:
        | Array<{ name: string; staticBoolean?: boolean | null; staticShape?: PythonArgumentShape }>
        | undefined,
      positionalShapes?: PythonArgumentShape[]
    ): string | null | undefined => {
      if (effect?.returnTypeByArgumentShape)
        return pythonArgumentShapeReturnType(effect, positionalShapes, keywords)
      const conditional = effect?.returnTypeWhenKeywordNotTrue
      if (!conditional) return fallback
      const keyword = keywords?.find((candidate) => candidate.name === conditional.keyword)
      const unpacked = keywords?.some((candidate) => candidate.name === '**')
      return (keyword && keyword.staticBoolean !== true) || unpacked
        ? conditional.returnType
        : fallback
    }

    // Function metadata does not replace its compiled body or bindings. Only
    // behavior slots and unknown member writes invalidate a plain function summary.
    const pythonFunctionBehaviorMembers = new Set([
      '__code__',
      '__defaults__',
      '__kwdefaults__',
      '__globals__',
      '__builtins__',
      '__closure__'
    ])
    const pythonFunctionMemberMayChangeBehavior = (member: string | undefined): boolean =>
      member === undefined || member === '*' || pythonFunctionBehaviorMembers.has(member)
    const pythonFunctionHasBehaviorShadow = (members: ReadonlySet<string> | undefined): boolean =>
      members ? [...members].some(pythonFunctionMemberMayChangeBehavior) : false

    // A definite pending binding to a summary emitted in this run denotes a
    // new function object, which cannot inherit the old name's reference shadow.
    const pythonFunctionHasFreshBinding = (
      receiver: string,
      summary: NotebookDependencyTypeSummary
    ): boolean =>
      pendingTypeBindings.get(receiver) === summary &&
      (facts.typeSummaries ?? []).includes(summary) &&
      !conditionallyDefinedNames.has(receiver)

    // Traverse only current plain function identities inside an
    // already opaque callback. These names are potential captures, not calls.
    const currentPythonFunctionSummary = (
      name: string
    ): NotebookDependencyTypeSummary | undefined => {
      if (run.kernelKind !== 'python' || incompleteRun) return undefined
      const aliasNames = [name]
      const visitedNames = new Set<string>()
      for (let cursor = 0; cursor < aliasNames.length; cursor++) {
        const current = aliasNames[cursor]
        if (visitedNames.has(current)) return undefined
        visitedNames.add(current)
        const definedInThisRun = (facts.definedNames ?? []).includes(current)
        const hasCurrentBinding =
          definedInThisRun &&
          (pendingTypeBindings.has(current) || completeSummaryNames.has(current))
        if (
          conditionallyDefinedNames.has(current) ||
          (uncertainBindings.has(current) && !hasCurrentBinding)
        )
          return undefined
        const summary = callableSummary(current)
        if (summary) {
          // Plain functions and real classes share kind 'python-class'; the
          // reviewed python-function: identity is the required narrower seam.
          if (!summary.name.startsWith('python-function:')) return undefined
          const token = referenceTokens.get(current)
          if (
            (!pythonFunctionHasFreshBinding(current, summary) &&
              token &&
              pythonFunctionHasBehaviorShadow(shadowedMembers.get(token))) ||
            pythonFunctionHasBehaviorShadow(shadowedTypeMembers.get(summary)) ||
            (facts.memberWrites ?? []).some(
              (write) =>
                receiversMayAlias(write.receiver, current) &&
                pythonFunctionMemberMayChangeBehavior(write.member)
            )
          )
            return undefined
          return summary
        }
        // Only a definite current direct alias can bridge a missing pending
        // binding. A possible alias cannot recover an old pre-rebind identity.
        const aliases = (facts.aliases ?? []).filter(
          (alias) =>
            alias.target === current &&
            alias.kind === 'reference' &&
            alias.access === undefined &&
            alias.member === undefined
        )
        if (aliases.length !== 1) return undefined
        aliasNames.push(aliases[0].source)
      }
      return undefined
    }
    const opaquePythonFunctionCaptures = (
      rootName: string,
      rootSummary: NotebookDependencyTypeSummary
    ): string[] => {
      const currentRoot = currentPythonFunctionSummary(rootName)
      if (!currentRoot || currentRoot !== rootSummary) return []
      const names: string[] = []
      const worklist = [currentRoot]
      const visitedSummaries = new Set(worklist)
      // An explicit worklist bounds traversal by summary identities and avoids
      // recursive JavaScript call-stack growth for deep helper chains.
      for (let cursor = 0; cursor < worklist.length; cursor++) {
        const method = worklist[cursor].methods.find((candidate) => candidate.name === '__call__')
        for (const name of method?.usedNames ?? []) {
          names.push(name)
          const helper = currentPythonFunctionSummary(name)
          if (!helper || visitedSummaries.has(helper)) continue
          visitedSummaries.add(helper)
          worklist.push(helper)
        }
      }
      return names
    }

    const ownedPropertyEffect = (
      alias: NotebookDependencyAlias,
      sourceType: NotebookDependencyTypeSummary | undefined
    ): PythonLibraryMethodEffect | undefined => {
      if (incompleteRun || alias.access !== 'attribute' || !alias.member || !sourceType)
        return undefined
      const token = referenceTokens.get(alias.source)
      const shadow = token ? shadowedMembers.get(token) : undefined
      const typeShadow = shadowedTypeMembers.get(sourceType)
      if (
        shadow?.has('*') ||
        shadow?.has(alias.member) ||
        typeShadow?.has('*') ||
        typeShadow?.has(alias.member) ||
        (facts.memberWrites ?? []).some(
          (write) =>
            receiversMayAlias(write.receiver, alias.source) &&
            (write.member === undefined || write.member === alias.member)
        )
      )
        return undefined
      const effect = libraryEffectFor(sourceType, `@${alias.member}`)
      return effect?.returnsAliasOfReceiver ? effect : undefined
    }
    for (const alias of facts.aliases ?? []) {
      if (alias.access !== 'attribute' || !alias.member) continue
      const sourceType =
        pendingTypeBindings.get(alias.source) ??
        ((facts.definedNames ?? []).includes(alias.source)
          ? undefined
          : objectTypes.get(alias.source))
      if (!libraryEffectFor(sourceType, `@${alias.member}`)?.returnsAliasOfReceiver) continue
      const property = ownedPropertyEffect(alias, sourceType)
      const type = property?.returnType ? typeSummaries.get(property.returnType) : undefined
      if (type) pendingTypeBindings.set(alias.target, type)
      else {
        typeAwareReasons.push('opaque-call')
        typeAwarePossiblyMutatedNames.push(alias.source, alias.target)
      }
    }

    if (!callbackNamespaceUncertain && run.kernelKind === 'python') {
      for (const candidate of facts.pythonCallbackContainerSummaries ?? []) {
        if (
          conditionallyDefinedNames.has(candidate.name) ||
          uncertainBindings.has(candidate.name) ||
          (facts.mutatedNames ?? []).includes(candidate.name) ||
          callbackAliasExposures.has(candidate.name) ||
          candidate.callbackNames.some(
            (name) => callbackAliasExposures.has(name) || !currentPythonFunctionSummary(name)
          )
        )
          continue
        callbackContainers.set(candidate.name, [...candidate.callbackNames])
      }
    }
    for (const call of facts.receiverCalls ?? []) {
      const priorActualMutationCount = typeAwareMutatedNames.length
      const priorPossibleMutationCount = typeAwarePossiblyMutatedNames.length
      const addTypeAwareMutation = (names: readonly string[]): void => {
        if (call.conditional) {
          typeAwarePossiblyMutatedNames.push(...names)
          if (names.length) typeAwareReasons.push('opaque-mutation')
        } else {
          typeAwareMutatedNames.push(...names)
        }
      }
      const modifiedR6Summary =
        call.member === 'set'
          ? [...typeSummaries.entries()].find(
              ([name, summary]) => summary.kind === 'r-r6' && receiversMayAlias(call.receiver, name)
            )?.[1]
          : undefined
      if (modifiedR6Summary) {
        const affectedObjects = [...objectTypes.entries()]
          .filter(([, summary]) => summary === modifiedR6Summary)
          .map(([name]) => name)
        for (const name of affectedObjects) typeBehaviorChanges.add(name)
        for (const method of modifiedR6Summary.methods) {
          method.effect = 'unknown'
          method.unknownScope = 'namespace'
        }
        continue
      }
      let typeSummary =
        pendingTypeBindings.get(call.receiver) ??
        ((facts.definedNames ?? []).includes(call.receiver)
          ? undefined
          : objectTypes.get(call.receiver)) ??
        typeSummaries.get(call.receiver)
      const configuredTypeName = typeSummary
        ? (facts.memberWrites ?? []).find(
            (write) =>
              !write.conditional &&
              write.member !== undefined &&
              receiversMayAlias(write.receiver, call.receiver) &&
              PYTHON_LIBRARY_EFFECTS[typeSummary!.name]?.typeWhenMembersWritten?.[write.member]
          )?.member
        : undefined
      if (typeSummary && configuredTypeName) {
        const replacementName =
          PYTHON_LIBRARY_EFFECTS[typeSummary.name]?.typeWhenMembersWritten?.[configuredTypeName]
        typeSummary = replacementName ? typeSummaries.get(replacementName) : typeSummary
      }
      const token = referenceTokens.get(call.receiver)
      const priorShadow = token ? shadowedMembers.get(token) : undefined
      let chainWasShadowed = false
      let projectedReceiverValueNames = [call.receiver]
      let chainProvenanceResolved = false
      for (const [chainIndex, chainedMember] of (call.receiverChain ?? []).entries()) {
        const accessedMember = chainedMember.startsWith('@')
          ? chainedMember.slice(1)
          : chainedMember
        const typeShadow = typeSummary ? shadowedTypeMembers.get(typeSummary) : undefined
        if (
          priorShadow?.has('*') === true ||
          priorShadow?.has(accessedMember) === true ||
          (facts.memberWrites ?? []).some(
            (write) =>
              write.scope !== 'type' &&
              receiversMayAlias(write.receiver, call.receiver) &&
              (write.member === undefined || write.member === accessedMember)
          ) ||
          typeShadow?.has('*') === true ||
          typeShadow?.has(accessedMember) === true
        ) {
          chainWasShadowed = true
          typeSummary = undefined
          break
        }
        const chainedMethod = typeSummary?.methods.find(
          (candidate) => candidate.name === chainedMember
        )
        const chainedEffect = libraryEffectFor(typeSummary, chainedMember)
        const chainPositional = call.receiverChainPositionalArgumentNames?.[chainIndex] ?? []
        const chainStaticBooleans = call.receiverChainPositionalStaticBooleans?.[chainIndex] ?? []
        const chainKeywords = call.receiverChainKeywordArguments?.[chainIndex] ?? []
        const chainFirstKeyword = chainedEffect?.firstArgumentKeyword
          ? chainKeywords.find((keyword) => keyword.name === chainedEffect.firstArgumentKeyword)
          : undefined
        const chainFirstNames = chainFirstKeyword?.argumentNames ?? chainPositional[0] ?? []
        const chainSecondKeyword = chainedEffect?.secondArgumentKeyword
          ? chainKeywords.find((keyword) => keyword.name === chainedEffect.secondArgumentKeyword)
          : undefined
        const chainSecondNames = chainSecondKeyword?.argumentNames ?? chainPositional[1] ?? []
        if (chainedEffect?.returnsAliasOfReceiver) {
          chainProvenanceResolved = true
        } else if (chainedEffect?.returnsPossibleAliasOf === 'firstArgument') {
          projectedReceiverValueNames = chainFirstNames
          chainProvenanceResolved = true
        } else if (chainedEffect?.returnsPossibleAliasOf === 'receiver') {
          chainProvenanceResolved = true
        } else if (chainedEffect?.returnsPossibleAliasWhenKeywordFalse) {
          const rule = chainedEffect.returnsPossibleAliasWhenKeywordFalse
          const flagKeyword = chainKeywords.find((keyword) => keyword.name === rule.keyword)
          const flagPosition = rule.positionalArgument
          const hasFlagPosition =
            flagPosition !== undefined && flagPosition < chainPositional.length
          if (flagKeyword || hasFlagPosition) {
            const flag = flagKeyword?.staticBoolean ?? chainStaticBooleans[flagPosition!]
            if (flag !== true) {
              const flagNames = new Set([
                ...(flagKeyword?.argumentNames ?? []),
                ...(flagPosition === undefined ? [] : (chainPositional[flagPosition] ?? []))
              ])
              projectedReceiverValueNames = [
                ...new Set(
                  rule.sources.flatMap((source) => {
                    if (source === 'receiver') return projectedReceiverValueNames
                    if (source === 'firstArgument') return chainFirstNames
                    if (source === 'secondArgument') return chainSecondNames
                    return [
                      ...chainPositional.flat(),
                      ...chainKeywords.flatMap((item) => item.argumentNames)
                    ].filter((name) => !flagNames.has(name))
                  })
                )
              ]
            } else {
              projectedReceiverValueNames = []
            }
            chainProvenanceResolved = true
          } else if (chainedEffect.returnType || chainedEffect.destructuredReturnTypes?.length) {
            projectedReceiverValueNames = []
            chainProvenanceResolved = true
          }
        } else if (chainedEffect?.returnType || chainedEffect?.destructuredReturnTypes?.length) {
          projectedReceiverValueNames = []
          chainProvenanceResolved = true
        }
        const chainedReturnType = returnTypeForCall(
          chainedMethod?.returnType,
          chainedEffect,
          chainKeywords,
          call.receiverChainPositionalStaticShapes?.[chainIndex]
        )
        typeSummary = chainedReturnType ? typeSummaries.get(chainedReturnType) : undefined
        if (!typeSummary) break
      }
      const writtenInThisRun = (facts.memberWrites ?? []).some(
        (write) =>
          write.scope !== 'type' &&
          receiversMayAlias(write.receiver, call.receiver) &&
          (write.member === undefined || write.member === call.member)
      )
      const typeShadow = typeSummary ? shadowedTypeMembers.get(typeSummary) : undefined
      const methodWasShadowed =
        chainWasShadowed ||
        writtenInThisRun ||
        priorShadow?.has('*') === true ||
        priorShadow?.has(call.member) === true ||
        typeShadow?.has('*') === true ||
        typeShadow?.has(call.member) === true
      const methodName = call.kind === 'callable' ? '__call__' : call.member
      const method = methodWasShadowed
        ? undefined
        : typeSummary?.methods.find((candidate) => candidate.name === methodName)
      const libraryEffect = methodWasShadowed
        ? undefined
        : (libraryEffectFor(typeSummary, methodName) ??
          (!typeSummary && knownBuiltinContainers.has(call.receiver)
            ? PYTHON_LIBRARY_EFFECTS['python.container']?.methods[methodName]
            : undefined))
      const receiverTypeRule = libraryEffect?.receiverTypeWhenKeywordNotTrue
      const receiverTypeKeyword = receiverTypeRule
        ? call.keywordArguments?.find((keyword) => keyword.name === receiverTypeRule.keyword)
        : undefined
      const hasUnpackedKeywords = call.keywordArguments?.some((keyword) => keyword.name === '**')
      if (
        !incompleteRun &&
        !call.conditional &&
        receiverTypeRule &&
        ((receiverTypeKeyword && receiverTypeKeyword.staticBoolean !== true) || hasUnpackedKeywords)
      ) {
        const replacement = typeSummaries.get(receiverTypeRule.typeName)
        if (replacement) {
          for (const name of new Set([
            call.receiver,
            ...[...objectTypes.keys()].filter((candidate) =>
              receiversMayAlias(candidate, call.receiver)
            ),
            ...[...pendingTypeBindings.keys()].filter((candidate) =>
              receiversMayAlias(candidate, call.receiver)
            )
          ])) {
            objectTypes.set(name, replacement)
            pendingTypeBindings.set(name, replacement)
          }
        }
      }
      const knownConstructorCall =
        call.kind === 'callable' &&
        typeSummary !== undefined &&
        method === undefined &&
        typeSummaries.get(call.receiver) === typeSummary
      const returnedType = returnTypeForCall(
        method?.returnType,
        libraryEffect,
        call.keywordArguments,
        call.positionalStaticShapes
      )
      const returnedTypes = method?.destructuredReturnTypes?.length
        ? method.destructuredReturnTypes
        : returnedType
          ? [returnedType]
          : []
      for (const [index, resultName] of (call.resultNames ?? []).entries()) {
        const returnedType = pythonUnpackedReturnType(
          returnedTypes,
          call.resultPaths?.[index] ?? [index]
        )
        const returnedSummary = returnedType ? typeSummaries.get(returnedType) : undefined
        if (returnedSummary) pendingTypeBindings.set(resultName, returnedSummary)
      }
      const namedFirstArgument = libraryEffect?.firstArgumentKeyword
        ? call.keywordArguments?.find(
            (keyword) => keyword.name === libraryEffect.firstArgumentKeyword
          )
        : undefined
      const firstArgumentNames = namedFirstArgument
        ? [
            ...(namedFirstArgument.argumentNames ?? []),
            ...(namedFirstArgument.possibleArgumentNames ?? [])
          ]
        : (call.positionalArgumentNames?.[0] ?? [])
      const namedSecondArgument = libraryEffect?.secondArgumentKeyword
        ? call.keywordArguments?.find(
            (keyword) => keyword.name === libraryEffect.secondArgumentKeyword
          )
        : undefined
      const secondArgumentNames = namedSecondArgument
        ? [
            ...(namedSecondArgument.argumentNames ?? []),
            ...(namedSecondArgument.possibleArgumentNames ?? [])
          ]
        : (call.positionalArgumentNames?.[1] ?? [])
      const receiverValueNames = chainProvenanceResolved
        ? projectedReceiverValueNames
        : call.receiverValueNames?.length
          ? call.receiverValueNames
          : call.receiverChain?.length
            ? []
            : [call.receiver]
      const mutationReceiverNames = call.receiverChain?.length
        ? receiverValueNames
        : [call.receiver]
      const definiteAliasKeyword = libraryEffect?.returnsAliasOfKeyword
        ? call.keywordArguments?.find(
            (keyword) => keyword.name === libraryEffect.returnsAliasOfKeyword
          )
        : undefined
      if (libraryEffect?.returnsAliasOfReceiver) {
        for (const source of receiverValueNames) {
          for (const resultName of call.resultNames ?? []) {
            typeAwarePossibleAliases.push({
              target: resultName,
              source,
              kind: 'reference'
            })
          }
        }
      }
      for (const source of definiteAliasKeyword?.argumentNames ?? []) {
        for (const resultName of call.resultNames ?? []) {
          typeAwarePossibleAliases.push({
            target: resultName,
            source,
            kind: 'reference'
          })
        }
      }
      for (const source of definiteAliasKeyword?.possibleArgumentNames ?? []) {
        for (const resultName of call.resultNames ?? []) {
          typeAwarePossibleAliases.push({
            target: resultName,
            source,
            kind: 'possible-reference'
          })
        }
      }
      const possibleAliasSources =
        libraryEffect?.returnsPossibleAliasOf === 'receiver'
          ? receiverValueNames
          : libraryEffect?.returnsPossibleAliasOf === 'firstArgument'
            ? firstArgumentNames
            : []
      for (const possibleAliasSource of possibleAliasSources) {
        for (const resultName of call.resultNames ?? []) {
          typeAwarePossibleAliases.push({
            target: resultName,
            source: possibleAliasSource,
            kind: 'possible-reference'
          })
        }
      }
      const conditionalAliasRule = libraryEffect?.returnsPossibleAliasWhenKeywordFalse
      const conditionalAliasKeyword = conditionalAliasRule
        ? call.keywordArguments?.find((keyword) => keyword.name === conditionalAliasRule.keyword)
        : undefined
      const conditionalAliasPosition = conditionalAliasRule?.positionalArgument
      const hasConditionalAliasPosition =
        conditionalAliasPosition !== undefined &&
        conditionalAliasPosition < (call.positionalArgumentNames?.length ?? 0)
      const conditionalAliasEnabled =
        (conditionalAliasKeyword !== undefined && conditionalAliasKeyword.staticBoolean !== true) ||
        (hasConditionalAliasPosition &&
          call.positionalStaticBooleans?.[conditionalAliasPosition!] !== true)
      if (conditionalAliasRule && conditionalAliasEnabled) {
        const flagNames = new Set([
          ...(conditionalAliasKeyword?.argumentNames ?? []),
          ...(conditionalAliasKeyword?.possibleArgumentNames ?? []),
          ...(conditionalAliasPosition === undefined
            ? []
            : (call.positionalArgumentNames?.[conditionalAliasPosition] ?? []))
        ])
        const conditionalSources = conditionalAliasRule.sources.flatMap((source) => {
          if (source === 'receiver') return receiverValueNames
          if (source === 'firstArgument') return firstArgumentNames
          if (source === 'secondArgument') return secondArgumentNames
          return (call.argumentNames ?? []).filter((name) => !flagNames.has(name))
        })
        for (const resultName of call.resultNames ?? []) {
          for (const source of new Set(conditionalSources)) {
            typeAwarePossibleAliases.push({
              target: resultName,
              source,
              kind: 'possible-reference'
            })
          }
        }
      }
      if (libraryEffect?.possiblyMutatesFirstArgument) {
        typeAwarePossiblyMutatedNames.push(...firstArgumentNames)
        if (firstArgumentNames.length) typeAwareReasons.push('opaque-mutation')
      }
      if (libraryEffect?.possiblyMutatesPositionalArgument !== undefined) {
        const possibleArgumentNames =
          call.positionalArgumentNames?.[libraryEffect.possiblyMutatesPositionalArgument] ?? []
        typeAwarePossiblyMutatedNames.push(...possibleArgumentNames)
        if (possibleArgumentNames.length) typeAwareReasons.push('opaque-mutation')
      }
      if (libraryEffect?.possiblyMutatesKeyword) {
        const possibleOutput = call.keywordArguments?.find(
          (keyword) => keyword.name === libraryEffect.possiblyMutatesKeyword
        )
        const possibleOutputNames = [
          ...(possibleOutput?.argumentNames ?? []),
          ...(possibleOutput?.possibleArgumentNames ?? [])
        ]
        typeAwarePossiblyMutatedNames.push(...possibleOutputNames)
        if (possibleOutputNames.length) typeAwareReasons.push('opaque-mutation')
      }
      const callbackArguments = (call.keywordArguments ?? []).filter(
        (keyword) =>
          libraryEffect?.callbackAllKeywords === true ||
          libraryEffect?.callbackKeywords?.includes(keyword.name)
      )
      const namedCallbackContainersUsed = new Set<string>()
      const callbackReferences = (
        keyword: NonNullable<NotebookDependencyReceiverCall['keywordArguments']>[number]
      ): NonNullable<typeof keyword.callableReferences> =>
        (keyword.callableReferences ?? []).flatMap((reference) => {
          if (!libraryEffect?.callbackContainerKeywords?.includes(keyword.name)) return [reference]
          if (reference.member !== undefined || reference.container !== undefined)
            return [reference]
          const callbacks = callbackContainers.get(reference.root)
          if (!callbacks) return [reference]
          const names = [reference.root, ...callbacks]
          const uncertain = names.some(
            (name) =>
              conditionallyDefinedNames.has(name) ||
              uncertainBindings.has(name) ||
              callbackAliasExposures.has(name) ||
              (name === reference.root &&
                (facts.mutatedNames ?? []).some((written) => receiversMayAlias(written, name)))
          )
          // Calls are aggregated without enough ordering/effect evidence to
          // prove this stored identity survived another use in the same run.
          // The solver's own use is allowed; any other exposure is a barrier.
          const otherCallUsesContainer = (facts.receiverCalls ?? []).some((other) => {
            if (other === call) return false
            const helper = currentPythonFunctionSummary(other.receiver)
            const captures = helper ? opaquePythonFunctionCaptures(other.receiver, helper) : []
            const namespaceUncertain = [helper, ...captures.map(currentPythonFunctionSummary)].some(
              (summary) =>
                summary?.methods.some(
                  (method) => method.effect === 'unknown' && method.unknownScope === 'namespace'
                )
            )
            return (
              namespaceUncertain ||
              [
                other.receiver,
                ...(other.argumentNames ?? []),
                ...captures,
                ...(other.keywordArguments ?? []).flatMap((argument) => [
                  ...(argument.argumentNames ?? []),
                  ...(argument.possibleArgumentNames ?? [])
                ])
              ].some((name) => receiversMayAlias(name, reference.root))
            )
          })
          if (
            uncertain ||
            typeAwareReasons.includes('dynamic-namespace') ||
            typeAwareMutatedNames.some(
              (mutation, index) =>
                index < priorActualMutationCount && receiversMayAlias(mutation, reference.root)
            ) ||
            typeAwarePossiblyMutatedNames.some(
              (mutation, index) =>
                index < priorPossibleMutationCount &&
                names.some((name) => receiversMayAlias(mutation, name))
            ) ||
            otherCallUsesContainer ||
            callbacks.some((name) => !currentPythonFunctionSummary(name))
          ) {
            callbackContainers.delete(reference.root)
            return [reference]
          }
          namedCallbackContainersUsed.add(reference.root)
          return callbacks.map((root) => ({ root, container: 'list' as const }))
        })
      // Visit every contracted callback before aggregating uncertainty: a
      // dynamic callback must not hide the known captures of later callbacks.
      const callbackUncertainties = callbackArguments.map((keyword) =>
        callbackReferences(keyword).map((reference) => {
          if (
            reference.container &&
            !libraryEffect?.callbackContainerKeywords?.includes(keyword.name)
          ) {
            return false
          }
          if (
            knownBuiltinContainers.has(reference.root) &&
            !libraryEffect?.callbackContainerKeywords?.includes(keyword.name)
          ) {
            return false
          }
          // A pending conditional body or an uncertain prior binding does not
          // identify the callback currently supplied to the library.
          const definedInThisRun = (facts.definedNames ?? []).includes(reference.root)
          const hasCurrentBinding =
            definedInThisRun &&
            (pendingTypeBindings.has(reference.root) || completeSummaryNames.has(reference.root))
          if (
            conditionallyDefinedNames.has(reference.root) ||
            (uncertainBindings.has(reference.root) && !hasCurrentBinding)
          )
            return true
          const namedTypeSummary =
            !definedInThisRun || completeSummaryNames.has(reference.root)
              ? typeSummaries.get(reference.root)
              : undefined
          const summary = callableSummary(reference.root) ?? namedTypeSummary
          if (!summary) {
            return reference.member !== undefined || libraryEffect?.callbackAllKeywords !== true
          }
          if (
            !reference.member &&
            libraryEffect?.callbackAllKeywords === true &&
            [
              'python.string',
              'python.strings',
              'python.scalar',
              'python.calculated-sequence'
            ].includes(summary.name)
          )
            return false
          // Plain function objects can change behavior through __code__,
          // defaults, or an unknown member write, including through aliases.
          const plainFunction = summary.name.startsWith('python-function:')
          if (reference.member || plainFunction) {
            const writtenInThisRun = (facts.memberWrites ?? []).some(
              (write) =>
                receiversMayAlias(write.receiver, reference.root) &&
                (plainFunction
                  ? pythonFunctionMemberMayChangeBehavior(write.member) ||
                    write.member === reference.member
                  : write.member === undefined || write.member === reference.member)
            )
            if (writtenInThisRun) return true
            const token = referenceTokens.get(reference.root)
            const shadow =
              token && !(plainFunction && pythonFunctionHasFreshBinding(reference.root, summary))
                ? shadowedMembers.get(token)
                : undefined
            const typeShadow = shadowedTypeMembers.get(summary)
            if (
              (plainFunction
                ? pythonFunctionHasBehaviorShadow(shadow) ||
                  (reference.member && shadow?.has(reference.member))
                : shadow?.has('*') || shadow?.has(reference.member!)) ||
              (plainFunction
                ? pythonFunctionHasBehaviorShadow(typeShadow) ||
                  (reference.member && typeShadow?.has(reference.member))
                : typeShadow?.has('*') || typeShadow?.has(reference.member!))
            ) {
              return true
            }
          }
          const callback = summary.methods.find(
            (candidate) => candidate.name === (reference.member ?? '__call__')
          )
          // An opaque callback can still have known captures. Preserve their
          // invalidation evidence without certifying the callback's effects.
          typeAwareUsedNames.push(...(callback?.usedNames ?? []))
          if (callback?.effect !== 'read') {
            if (!reference.member) {
              typeAwareUsedNames.push(...opaquePythonFunctionCaptures(reference.root, summary))
            }
            return true
          }
          typeAwareSafeCallNames.push(...(callback.safeCallNames ?? []))
          return callback.safeCallNames?.some(nameIsShadowed) ?? false
        })
      )
      if (callbackUncertainties.some((references) => references.some(Boolean))) {
        typeAwareReasons.push('opaque-call')
      }
      for (const container of namedCallbackContainersUsed) {
        if ((facts.possiblyMutatedNames ?? []).some((name) => receiversMayAlias(name, container)))
          callbackContainers.delete(container)
      }
      if (libraryEffect?.mutatesReceiverUnlessKeywordFalse) {
        const option = call.keywordArguments?.find(
          (keyword) => keyword.name === libraryEffect.mutatesReceiverUnlessKeywordFalse
        )
        if (
          hasUnpackedKeywords ||
          (option && option.staticBoolean !== true && option.staticBoolean !== false) ||
          call.receiverChain?.length
        ) {
          typeAwarePossiblyMutatedNames.push(...mutationReceiverNames)
          if (mutationReceiverNames.length) typeAwareReasons.push('opaque-mutation')
        } else if (option?.staticBoolean !== false) {
          addTypeAwareMutation([call.receiver])
        }
      }
      const mutatedKeyword = call.keywordArguments?.find(
        (keyword) => keyword.name === method?.mutatesKeyword
      )
      if (libraryEffect?.mutatesPositionalArgument !== undefined) {
        addTypeAwareMutation(
          call.positionalArgumentNames?.[libraryEffect.mutatesPositionalArgument] ?? []
        )
      }
      if (mutatedKeyword?.argumentNames) {
        addTypeAwareMutation(mutatedKeyword.argumentNames)
      }
      if (mutatedKeyword?.possibleArgumentNames?.length) {
        typeAwarePossiblyMutatedNames.push(...mutatedKeyword.possibleArgumentNames)
        typeAwareReasons.push('opaque-mutation')
      }
      typeAwareUsedNames.push(...(method?.usedNames ?? []))
      typeAwareSafeCallNames.push(...(method?.safeCallNames ?? []))
      if (method?.safeCallNames?.some(nameIsShadowed)) {
        typeAwarePossiblyMutatedNames.push(call.receiver)
        typeAwareReasons.push('opaque-mutation', 'opaque-call', 'dynamic-namespace')
      }
      if (method?.effect === 'unknown' && method.unknownScope === 'namespace') {
        typeAwareReasons.push('opaque-call', 'dynamic-namespace')
      }
      if (!method && typeSummary?.name.startsWith('python-callable:unknown.')) {
        typeAwareReasons.push('scoped-opaque-call')
      }
      if (method?.effect === 'read' && call.kind !== 'mutating') continue
      if (method?.effect === 'mutate' || call.kind === 'mutating') {
        if (call.receiverChain?.length) {
          typeAwarePossiblyMutatedNames.push(...mutationReceiverNames)
          if (mutationReceiverNames.length) typeAwareReasons.push('opaque-mutation')
        } else {
          addTypeAwareMutation([call.receiver])
        }
      } else if (knownConstructorCall) continue
      else if (methodWasShadowed) {
        typeAwarePossiblyMutatedNames.push(call.receiver, ...(call.argumentNames ?? []))
        typeAwareReasons.push('opaque-mutation', 'opaque-call', 'dynamic-namespace')
      } else if (method?.effect === 'unknown') {
        const safeCallNames = new Set(method.safeCallNames ?? [])
        typeAwarePossiblyMutatedNames.push(
          ...mutationReceiverNames,
          ...(call.argumentNames ?? []),
          ...(method.usedNames ?? []).filter((name) => !safeCallNames.has(name))
        )
        typeAwareReasons.push('opaque-mutation')
        if (
          typeSummary?.name.startsWith('python-callable:unknown.') ||
          typeSummary?.name.startsWith('python-function:')
        ) {
          typeAwareReasons.push('scoped-opaque-call')
        }
      } else if (call.kind === 'generic') {
        const argumentNames = call.argumentNames?.length
          ? [...mutationReceiverNames, ...call.argumentNames]
          : mutationReceiverNames
        typeAwarePossiblyMutatedNames.push(...argumentNames)
        typeAwareReasons.push('opaque-mutation')
        if (run.kernelKind === 'r' && R_STATIC_DISPATCH_MEMBERS.has(call.member)) {
          typeAwareReasons.push('opaque-call')
        }
      } else if (call.kind === 'callable') {
        typeAwarePossiblyMutatedNames.push(...(call.argumentNames ?? []))
        typeAwareReasons.push('opaque-call')
        if (call.argumentNames?.length) typeAwareReasons.push('opaque-mutation')
      } else {
        typeAwarePossiblyMutatedNames.push(...mutationReceiverNames, ...(call.argumentNames ?? []))
        typeAwareReasons.push('opaque-mutation')
        if (call.receiverChain?.length && mutationReceiverNames.length === 0) {
          typeAwareReasons.push('opaque-call', 'dynamic-namespace')
        }
      }
    }
    // Effective type-aware mutations also invalidate future candidates.
    if (typeAwareReasons.includes('dynamic-namespace')) callbackContainers.clear()
    const callbackActualMutationNames = [...(facts.mutatedNames ?? []), ...typeAwareMutatedNames]
    const callbackPossibleMutationNames = [
      ...(facts.possiblyMutatedNames ?? []),
      ...typeAwarePossiblyMutatedNames
    ]
    for (const [container, callbacks] of callbackContainers) {
      if (
        callbackActualMutationNames.some((mutation) => receiversMayAlias(mutation, container)) ||
        [container, ...callbacks].some((name) =>
          callbackPossibleMutationNames.some((mutation) => receiversMayAlias(mutation, name))
        ) ||
        callbacks.some(
          (name) =>
            callbackActualMutationNames.some((mutation) => receiversMayAlias(mutation, name)) &&
            !currentPythonFunctionSummary(name)
        )
      )
        callbackContainers.delete(container)
    }
    const packageUpstreamRunIds = new Set<string>()
    const packageReasons: string[] = []
    if (run.kernelKind === 'r') {
      const packages = this.rPackageLoadsByNamespace.get(namespace) ?? new Map<string, string>()
      const captured = run.environmentManifest?.executionContext?.rPackages
      const parsed = notebookExecutionContextSchema.shape.rPackages.safeParse(captured)
      const observed = parsed.success ? parsed.data : undefined
      if (captured && (!observed || !observed.complete))
        packageReasons.push('package-binding-capture-incomplete')
      if (observed?.complete) {
        for (const pkg of packages.keys()) if (!observed.before.includes(pkg)) packages.delete(pkg)
      }
      for (const pkg of facts.rPackageReads ?? []) {
        const producer = packages.get(pkg)
        if (producer) packageUpstreamRunIds.add(producer)
      }
      for (const { package: pkg } of observed?.reads ?? []) {
        if (R_DEFAULT_PACKAGES.has(pkg) || !observed?.before.includes(pkg)) continue
        // A local explicit load before the use can restore this package even
        // when the beginning of the original kernel history is unavailable.
        if (facts.rPackageLoads?.includes(pkg) && !facts.rPackageReads?.includes(pkg)) continue
        const producer = packages.get(pkg)
        if (producer) packageUpstreamRunIds.add(producer)
        else packageReasons.push(`missing-package-load:${pkg}`)
      }
      if (observed) {
        if (observed.complete) {
          for (const pkg of packages.keys()) if (!observed.after.includes(pkg)) packages.delete(pkg)
        }
        for (const pkg of observed.after) {
          if (!observed.before.includes(pkg)) packages.set(pkg, run.runId)
        }
      }
      // Failed cells may have attached a package before stopping; their producer
      // remains uncertain until a successful explicit load replaces it.
      for (const pkg of analyzedFacts.rPackageLoads ?? []) {
        if (!observed || observed.after.includes(pkg)) packages.set(pkg, run.runId)
      }
      this.rPackageLoadsByNamespace.set(namespace, packages)
    }
    const plottingProvider =
      run.kernelKind === 'python' && facts.pythonPlottingState?.reads
        ? this.pythonPlottingStateByNamespace.get(namespace)
        : undefined
    const themeProvider =
      run.kernelKind === 'r' && facts.rThemeState?.reads
        ? this.rThemeStateByNamespace.get(namespace)
        : undefined
    const graphicsProvider =
      run.kernelKind === 'r' && facts.rGraphicsState?.readsPrior
        ? this.rGraphicsStateByNamespace.get(namespace)
        : undefined
    const currentSafeCallNames = incompleteRun
      ? []
      : [...new Set([...(facts.safeCallNames ?? []), ...typeAwareSafeCallNames])]
    const safeCallShadowed = currentSafeCallNames.some(nameIsShadowed)
    const analysisReasons = (
      incompleteRun
        ? [
            'incomplete-run',
            ...(run.kernelKind === 'repl' && analyzedFacts.state === 'unknown'
              ? analyzedFacts.reasons.filter((reason) =>
                  [
                    'dynamic-namespace',
                    'dynamic-assignment',
                    'opaque-call',
                    'parse-error'
                  ].includes(reason)
                )
              : [])
          ]
        : [
            ...(facts.state === 'unknown'
              ? facts.reasons.filter(
                  (reason) => !(reason === 'graphics-state-unavailable' && graphicsProvider)
                )
              : []),
            ...(safeCallShadowed ? ['opaque-call'] : []),
            ...typeAwareReasons,
            ...(facts.pythonRandomStateReads &&
            run.environmentManifest?.executionContext?.before.pythonRandomState?.state !==
              'available'
              ? ['random-state-unavailable']
              : []),
            ...packageReasons
          ]
    ).filter((reason, index, reasons) => reasons.indexOf(reason) === index)
    const currentRunReasons = analysisReasons.filter(
      (reason) => reason !== 'opaque-mutation' && reason !== 'external-state'
    )
    if (run.kernelKind === 'repl' && !incompleteRun) {
      for (const name of facts.priorUsedNames ?? facts.usedNames ?? []) {
        if (!latestDefinitions.has(name) && !currentSafeCallNames.includes(name))
          currentRunReasons.push(`kernel-binding-unavailable:${name}`)
      }
    }
    const upstreamRunIds = new Set(packageUpstreamRunIds)
    // Formatting options are implicit inputs to R printing and plot labels.
    if (run.kernelKind === 'r') {
      for (const provider of this.rOptionWritesByNamespace.get(namespace)?.values() ?? [])
        upstreamRunIds.add(provider)
    }
    if (graphicsProvider) upstreamRunIds.add(graphicsProvider)
    if (themeProvider) upstreamRunIds.add(themeProvider)
    if (plottingProvider) upstreamRunIds.add(plottingProvider)
    const usedNames = incompleteRun
      ? []
      : [...(facts.priorUsedNames ?? facts.usedNames ?? []), ...typeAwareUsedNames]
    for (const name of usedNames) {
      const upstreamRunId = latestDefinitions.get(name)
      if (upstreamRunId) {
        upstreamRunIds.add(upstreamRunId)
        const key = `${upstreamRunId}\0${name}`
        const consumers = namedConsumers.get(key) ?? new Set<string>()
        consumers.add(run.runId)
        namedConsumers.set(key, consumers)
      }
    }
    for (const upstreamRunId of upstreamRunIds) {
      const dependents = downstream.get(upstreamRunId) ?? new Set<string>()
      dependents.add(run.runId)
      downstream.set(upstreamRunId, dependents)
    }
    directDependenciesByRunId.set(run.runId, upstreamRunIds)

    const unknownUpstream = [...upstreamRunIds]
      .map((runId) => stalenessByRunId[runId])
      .find(
        (candidate): candidate is Extract<NotebookRunStaleness, { state: 'unknown' }> =>
          candidate?.state === 'unknown'
      )
    const staleUpstream = [...upstreamRunIds]
      .map((runId) => stalenessByRunId[runId])
      .find(
        (candidate): candidate is Extract<NotebookRunStaleness, { state: 'stale' }> =>
          candidate?.state === 'stale'
      )
    const namespaceUnknownReasons = unknownReasonsByNamespace.get(namespace)
    const uncertainBindingReasons = [
      ...new Set(usedNames.flatMap((name) => uncertainBindings.get(name) ?? []))
    ]
    stalenessByRunId[run.runId] = namespaceUnknownReasons
      ? { state: 'unknown', reasons: namespaceUnknownReasons }
      : currentRunReasons.length > 0
        ? {
            state: 'unknown',
            reasons: [...new Set([...currentRunReasons, ...uncertainBindingReasons])]
          }
        : uncertainBindingReasons.length > 0
          ? { state: 'unknown', reasons: uncertainBindingReasons }
          : unknownUpstream
            ? unknownUpstream
            : staleUpstream
              ? { ...staleUpstream, path: [...staleUpstream.path, run.runId] }
              : { state: 'clear' }

    if (run.kernelKind === 'python' && facts.pythonPlottingState?.writes) {
      // Preserve the provider even when failed: downstream consumers must inherit
      // its uncertainty, rather than silently using a previous successful setup.
      this.pythonPlottingStateByNamespace.set(namespace, run.runId)
    }
    if (run.kernelKind === 'r' && analyzedFacts.rThemeState?.writes) {
      // A failed theme change must remain an uncertain dependency of later plots.
      this.rThemeStateByNamespace.set(namespace, run.runId)
    }
    if (run.kernelKind === 'r' && analyzedFacts.rOptionWrites?.length) {
      const providers = this.rOptionWritesByNamespace.get(namespace) ?? new Map<string, string>()
      for (const option of analyzedFacts.rOptionWrites) providers.set(option, run.runId)
      this.rOptionWritesByNamespace.set(namespace, providers)
    }
    if (run.kernelKind === 'r') {
      // Failed or opaque cells may change package configuration. Only a known,
      // successful chain, starting with an explicit reset, can supply it.
      if (stalenessByRunId[run.runId]?.state !== 'clear' || analysisReasons.length > 0) {
        this.rGraphicsStateByNamespace.delete(namespace)
      } else if (facts.rGraphicsState && (facts.rGraphicsState.resets || graphicsProvider)) {
        this.rGraphicsStateByNamespace.set(namespace, run.runId)
      } else if (
        facts.rGraphicsState ||
        currentSafeCallNames.some((name) => /^(circlize::|circos\.|chordDiagram$)/.test(name))
      ) {
        // A locally safe wrapper/tryCatch may alter the package without proving
        // the configuration left behind. Do not keep an older provider alive.
        this.rGraphicsStateByNamespace.delete(namespace)
      }
    }
    const mayRewriteExistingBindings = analysisReasons.some(
      (reason) =>
        [
          'dynamic-namespace',
          'dynamic-assignment',
          'wildcard-import',
          'alias-rebind',
          'class-scope',
          'comprehension-scope',
          'analysis-unavailable',
          'analysis-unknown',
          'invalid-parser-result',
          'parse-error'
        ].includes(reason) || reason.startsWith('parser-')
    )
    const taintsNamespace = mayRewriteExistingBindings || analysisReasons.includes('opaque-call')
    const taintCurrentNamespace = (reasons: string[]): void => {
      unknownReasonsByNamespace.set(namespace, reasons)
      if (mayRewriteExistingBindings) {
        for (const previousRunId of runIdsByNamespace.get(namespace) ?? []) {
          stalenessByRunId[previousRunId] = { state: 'unknown', reasons }
        }
      }
      stalenessByRunId[run.runId] = { state: 'unknown', reasons }
    }
    if (taintsNamespace) taintCurrentNamespace(analysisReasons)
    const namespaceRunIds = runIdsByNamespace.get(namespace) ?? []
    namespaceRunIds.push(run.runId)
    runIdsByNamespace.set(namespace, namespaceRunIds)

    const invalidateName = (
      name: string,
      state: 'stale' | 'unknown',
      reasons: string[] = [],
      rebind = true,
      includeDefinitionRun = false
    ): void => {
      for (const possibleConsumerRunId of possibleConsumers.get(name) ?? []) {
        for (const dependentRunId of [
          possibleConsumerRunId,
          ...descendantsOf(possibleConsumerRunId, downstream)
        ]) {
          if (dependentRunId === run.runId || stalenessByRunId[dependentRunId]?.state === 'stale') {
            continue
          }
          const possibleReasons = ['possible-data-mask-lookup']
          stalenessByRunId[dependentRunId] = {
            state: 'unknown',
            reasons: possibleReasons
          }
          const dependentRun = runsById.get(dependentRunId)
          if (!dependentRun) continue
          const invalidated = invalidatedByRunId[run.runId] ?? []
          const existing = invalidated.find(
            (candidate) => candidate.runId === dependentRunId && candidate.state === 'unknown'
          )
          if (existing?.state === 'unknown') {
            existing.names = [...new Set([...existing.names, name])]
            existing.reasons = [...new Set([...existing.reasons, ...possibleReasons])]
          } else if (
            !invalidated.some(
              (candidate) => candidate.runId === dependentRunId && candidate.state === 'stale'
            )
          ) {
            invalidated.push({
              runId: dependentRunId,
              cellId: dependentRun.cellId,
              names: [name],
              state: 'unknown',
              reasons: possibleReasons
            })
          }
          invalidatedByRunId[run.runId] = invalidated
        }
      }
      const previousDefinitionRunId = latestDefinitions.get(name)
      if (previousDefinitionRunId) {
        const directConsumers = namedConsumers.get(`${previousDefinitionRunId}\0${name}`) ?? []
        const affectedRuns = new Set<string>(includeDefinitionRun ? [previousDefinitionRunId] : [])
        for (const directConsumer of directConsumers) {
          affectedRuns.add(directConsumer)
          for (const descendant of descendantsOf(directConsumer, downstream)) {
            affectedRuns.add(descendant)
          }
        }
        for (const dependentRunId of affectedRuns) {
          if (dependentRunId === run.runId) continue
          const namespaceReasons = unknownReasonsByNamespace.get(namespace)
          const preserveNamespaceUncertainty =
            state === 'stale' &&
            namespaceReasons !== undefined &&
            stalenessByRunId[dependentRunId]?.state === 'unknown'
          const currentStaleness = stalenessByRunId[dependentRunId]
          const preservePossibleLookup =
            state === 'stale' &&
            currentStaleness?.state === 'unknown' &&
            currentStaleness.reasons.includes('possible-data-mask-lookup')
          const effectiveState =
            preserveNamespaceUncertainty || preservePossibleLookup ? 'unknown' : state
          const effectiveReasons = preserveNamespaceUncertainty
            ? namespaceReasons
            : preservePossibleLookup
              ? currentStaleness.reasons
              : reasons
          if (effectiveState === 'stale') {
            stalenessByRunId[dependentRunId] = {
              state: 'stale',
              causedByRunId: run.runId,
              names: [name],
              path: dependencyPath(previousDefinitionRunId, dependentRunId, downstream)
            }
          } else if (stalenessByRunId[dependentRunId]?.state !== 'stale') {
            stalenessByRunId[dependentRunId] = { state: 'unknown', reasons: effectiveReasons }
          }
          const dependentRun = runsById.get(dependentRunId)
          if (dependentRun) {
            const invalidated = invalidatedByRunId[run.runId] ?? []
            const existing = invalidated.find(
              (candidate) =>
                candidate.runId === dependentRunId && candidate.state === effectiveState
            )
            if (existing) {
              existing.names = [...new Set([...existing.names, name])]
              if (existing.state === 'unknown') {
                existing.reasons = [...new Set([...existing.reasons, ...effectiveReasons])]
              }
            } else if (
              effectiveState === 'stale' ||
              !invalidated.some(
                (candidate) => candidate.runId === dependentRunId && candidate.state === 'stale'
              )
            ) {
              invalidated.push(
                effectiveState === 'stale'
                  ? {
                      runId: dependentRunId,
                      cellId: dependentRun.cellId,
                      names: [name],
                      state: 'stale'
                    }
                  : {
                      runId: dependentRunId,
                      cellId: dependentRun.cellId,
                      names: [name],
                      state: 'unknown',
                      reasons: effectiveReasons
                    }
              )
            }
            invalidatedByRunId[run.runId] = invalidated
          }
        }
      }
      if (rebind) {
        for (const dependentRunId of safeCallConsumers.get(name) ?? []) {
          if (dependentRunId === run.runId) continue
          const reasons = ['opaque-call']
          if (stalenessByRunId[dependentRunId]?.state !== 'stale') {
            stalenessByRunId[dependentRunId] = { state: 'unknown', reasons }
          }
          const dependentRun = runsById.get(dependentRunId)
          if (!dependentRun) continue
          const invalidated = invalidatedByRunId[run.runId] ?? []
          if (!invalidated.some((candidate) => candidate.runId === dependentRunId)) {
            invalidated.push({
              runId: dependentRunId,
              cellId: dependentRun.cellId,
              names: [name],
              state: 'unknown',
              reasons
            })
            invalidatedByRunId[run.runId] = invalidated
          }
        }
        safeCallConsumers.delete(name)
        possibleConsumers.delete(name)
        latestDefinitions.set(name, run.runId)
      }
    }

    const definedNames = [...new Set(facts.definedNames ?? [])].filter(
      (name) => !conditionallyDefinedNames.has(name)
    )
    for (const name of definedNames) {
      const previousModule = objectTypes.get(name)
      const nextModule = pendingTypeBindings.get(name)
      // Re-importing an unchanged module binds the same sys.modules object. It
      // does not invalidate configuration set through that module in earlier cells.
      if (
        run.kernelKind === 'python' &&
        previousModule?.kind === 'python-module' &&
        previousModule === nextModule &&
        !uncertainBindings.has(name) &&
        !typeBehaviorChanges.has(name) &&
        !analysisReasons.length
      )
        continue
      invalidateName(name, 'stale')
      uncertainBindings.delete(name)
      referenceTokens.set(name, `${run.runId}\0${name}`)
      detachPossibleAlias(name, possibleAliases)
      detachPossibleAlias(name, rCopyAliases)
      builtinContainers.delete(name)
      copyOnModifyNames.delete(name)
      objectTypes.delete(name)
    }
    for (const name of conditionallyDefinedNames) {
      invalidateName(name, 'unknown', ['control-flow'], false)
      uncertainBindings.set(name, ['control-flow'])
      detachPossibleAlias(name, possibleAliases)
      detachPossibleAlias(name, rCopyAliases)
      builtinContainers.delete(name)
      copyOnModifyNames.delete(name)
      objectTypes.delete(name)
      typeSummaries.delete(name)
    }
    for (const name of typeBehaviorChanges) {
      invalidateName(name, 'unknown', ['opaque-mutation'], false)
    }
    for (const name of currentSafeCallNames.filter((candidate) => !nameIsShadowed(candidate))) {
      const consumers = safeCallConsumers.get(name) ?? new Set<string>()
      consumers.add(run.runId)
      safeCallConsumers.set(name, consumers)
    }
    for (const name of facts.possiblyUsedNames ?? []) {
      const consumers = possibleConsumers.get(name) ?? new Set<string>()
      consumers.add(run.runId)
      possibleConsumers.set(name, consumers)
    }
    for (const name of facts.builtinContainerNames ?? []) {
      if (!conditionallyDefinedNames.has(name)) builtinContainers.add(name)
    }
    for (const name of facts.copyOnModifyNames ?? []) {
      if (!conditionallyDefinedNames.has(name)) copyOnModifyNames.add(name)
    }
    if (!incompleteRun) {
      for (const [name, typeSummary] of pendingTypeBindings) {
        if (conditionallyDefinedNames.has(name)) continue
        objectTypes.set(name, typeSummary)
        if (typeSummary.kind === 'r-r6') copyOnModifyNames.delete(name)
      }
    }

    const isKnownRValue = (name: string): boolean => {
      const typeSummary = objectTypes.get(name)
      return (
        copyOnModifyNames.has(name) ||
        (typeSummary?.kind === 'r-s4' &&
          typeSummary.fields.every((field) => field.relationship === 'value'))
      )
    }
    for (const binding of facts.copyOnModifyBindings ?? []) {
      copyOnModifyNames.delete(binding.target)
    }
    for (const binding of facts.copyOnModifyBindings ?? []) {
      if (binding.sourceNames.every((name) => knownRValuesAtRunStart.has(name))) {
        copyOnModifyNames.add(binding.target)
      }
    }
    for (const name of facts.copyOnModifyInvalidatedNames ?? []) copyOnModifyNames.delete(name)

    for (const analyzedAlias of [...(facts.aliases ?? []), ...typeAwarePossibleAliases]) {
      const alias = incompleteRun
        ? ({ ...analyzedAlias, kind: 'possible-reference' } as const)
        : analyzedAlias
      const sourceType = objectTypes.get(alias.source)
      const isDataTableAlias =
        run.kernelKind === 'r' &&
        alias.kind === 'possible-reference' &&
        alias.access === undefined &&
        sourceType?.name === 'data.table'
      if (isDataTableAlias) {
        linkAliasClass(alias.target, alias.source, rCopyAliases)
        objectTypes.set(alias.target, sourceType)
        continue
      }
      const isRValueCopy =
        run.kernelKind === 'r' &&
        alias.kind === 'possible-reference' &&
        alias.access === undefined &&
        isKnownRValue(alias.source)
      if (isRValueCopy) {
        copyOnModifyNames.add(alias.target)
        linkAliasClass(alias.target, alias.source, rCopyAliases)
        if (sourceType) objectTypes.set(alias.target, sourceType)
        continue
      }
      const fieldRelationship = sourceType?.fields.find(
        (field) => field.name === alias.member
      )?.relationship
      if (fieldRelationship === 'value') continue
      const propertyEffect = ownedPropertyEffect(alias, sourceType)
      // An owned plotting property (for example ClusterGrid.ax_heatmap) is a
      // confirmed reference. Preserve its own type while sharing mutation history.
      const ownedProperty = propertyEffect?.returnsAliasOfReceiver === true
      if (ownedProperty && propertyEffect.returnType) {
        const propertyType = typeSummaries.get(propertyEffect.returnType)
        if (propertyType) objectTypes.set(alias.target, propertyType)
      }
      const isKnownRReferenceAlias =
        run.kernelKind === 'r' &&
        alias.access === undefined &&
        sourceType?.kind === 'r-r6' &&
        sourceType.name !== 'data.table'
      const isDefiniteReference =
        alias.kind === 'reference' ||
        ownedProperty ||
        isKnownRReferenceAlias ||
        (alias.access === 'subscript' && builtinContainers.has(alias.source)) ||
        fieldRelationship === 'reference'
      if (isDefiniteReference) {
        const sourceToken =
          referenceTokens.get(alias.source) ??
          `${latestDefinitions.get(alias.source) ?? run.runId}\0${alias.source}`
        referenceTokens.set(alias.source, sourceToken)
        referenceTokens.set(alias.target, sourceToken)
        if (builtinContainers.has(alias.source)) {
          builtinContainers.add(alias.target)
        }
        const sourceType = objectTypes.get(alias.source)
        if ((alias.kind === 'reference' || isKnownRReferenceAlias) && sourceType) {
          objectTypes.set(alias.target, sourceType)
        }
      } else {
        linkPossibleAlias(alias.target, alias.source, possibleAliases)
      }
    }

    for (const write of facts.memberWrites ?? []) {
      const receiverSummary = objectTypes.get(write.receiver)
      const configuredType =
        !write.conditional && write.member && receiverSummary
          ? PYTHON_LIBRARY_EFFECTS[receiverSummary.name]?.typeWhenMembersWritten?.[write.member]
          : undefined
      const configuredSummary = configuredType ? typeSummaries.get(configuredType) : undefined
      if (configuredSummary) {
        for (const name of new Set([
          write.receiver,
          ...[...objectTypes.keys()].filter((candidate) =>
            receiversMayAlias(candidate, write.receiver)
          )
        ])) {
          objectTypes.set(name, configuredSummary)
        }
        continue
      }
      const classSummary = [...typeSummaries.entries()].find(([name]) =>
        receiversMayAlias(write.receiver, name)
      )?.[1]
      if (classSummary) {
        if (write.conditional) continue
        if (write.member) {
          const method = classSummary.methods.find((candidate) => candidate.name === write.member)
          if (method) {
            method.effect = 'unknown'
            method.unknownScope = 'namespace'
          }
        } else {
          for (const method of classSummary.methods) {
            method.effect = 'unknown'
            method.unknownScope = 'namespace'
          }
        }
        continue
      }
      const relatedNames = new Set([write.receiver])
      const queue = [write.receiver]
      while (queue.length > 0) {
        const current = queue.shift()!
        const token = referenceTokens.get(current)
        const neighbors = new Set(possibleAliases.get(current) ?? [])
        if (token) {
          for (const [name, candidateToken] of referenceTokens) {
            if (candidateToken === token) neighbors.add(name)
          }
        }
        for (const neighbor of neighbors) {
          if (relatedNames.has(neighbor)) continue
          relatedNames.add(neighbor)
          queue.push(neighbor)
        }
      }
      for (const name of relatedNames) {
        const token = referenceTokens.get(name)
        if (!token) {
          objectTypes.delete(name)
          continue
        }
        const members = shadowedMembers.get(token) ?? new Set<string>()
        members.add(write.member ?? '*')
        shadowedMembers.set(token, members)
      }
    }

    const namesSharingReference = (name: string): Set<string> => {
      const token = referenceTokens.get(name)
      if (!token) return new Set([name])
      return new Set(
        [...referenceTokens.entries()]
          .filter(([, candidateToken]) => candidateToken === token)
          .map(([candidateName]) => candidateName)
      )
    }

    const namesSharingRCopyIn = (
      names: Iterable<string>,
      aliases: ReadonlyMap<string, ReadonlySet<string>>
    ): Set<string> => {
      const related = new Set(names)
      const queue = [...related]
      while (queue.length > 0) {
        const current = queue.shift()!
        for (const neighbor of aliases.get(current) ?? []) {
          if (related.has(neighbor)) continue
          related.add(neighbor)
          queue.push(neighbor)
        }
      }
      return related
    }
    const namesSharingRCopy = (names: Iterable<string>): Set<string> =>
      namesSharingRCopyIn(names, rCopyAliases)

    const referenceUpdateMembers = new Map<string, string>()
    const shadowedReferenceTargets = new Set<string>()
    if (run.kernelKind === 'r') {
      for (const call of facts.receiverCalls ?? []) {
        const member = call.member.startsWith('data.table::')
          ? call.member.slice('data.table::'.length)
          : call.member
        if (
          !call.conditional &&
          call.kind === 'mutating' &&
          R_DATA_TABLE_REFERENCE_MUTATORS.has(member)
        ) {
          const shadowedUnqualifiedCall =
            member === call.member &&
            currentSafeCallNames.includes(member) &&
            nameIsShadowed(member)
          if (shadowedUnqualifiedCall) shadowedReferenceTargets.add(call.receiver)
          else referenceUpdateMembers.set(call.receiver, member)
        }
      }
    }
    for (const target of referenceUpdateMembers.keys()) shadowedReferenceTargets.delete(target)
    for (const target of shadowedReferenceTargets) {
      if (definedNames.includes(target)) {
        objectTypes.delete(target)
        if ((facts.copyOnModifyNames ?? []).includes(target)) copyOnModifyNames.add(target)
        else copyOnModifyNames.delete(target)
        continue
      }
      const originalType = objectTypesAtRunStart.get(target)
      if (originalType) objectTypes.set(target, originalType)
      else objectTypes.delete(target)
      if (copyOnModifyNamesAtRunStart.has(target)) copyOnModifyNames.add(target)
      else copyOnModifyNames.delete(target)
    }
    const reboundReferenceTargets = new Set(
      [...referenceUpdateMembers.keys()].filter((target) => definedNames.includes(target))
    )
    const referenceUpdateAffectedNames = new Map<string, Set<string>>()
    for (const target of referenceUpdateMembers.keys()) {
      referenceUpdateAffectedNames.set(
        target,
        reboundReferenceTargets.has(target)
          ? namesSharingRCopyIn([target], rCopyAliasesAtRunStart)
          : namesSharingRCopy(namesSharingReference(target))
      )
    }
    const copyWriteNames = new Set(
      (facts.memberWrites ?? [])
        .filter((write) => !write.conditional)
        .map((write) => write.receiver)
    )
    const ambiguousCopyWriteNames = new Set<string>()
    const ambiguousReferenceAliasNames = new Set<string>()
    const referenceAliasStates = new Map<string, 'stale' | 'unknown'>()
    for (const [target, affectedNames] of referenceUpdateAffectedNames) {
      if (copyWriteNames.has(target) || reboundReferenceTargets.has(target)) {
        for (const name of affectedNames) {
          if (name === target) continue
          ambiguousReferenceAliasNames.add(name)
          if (referenceAliasStates.get(name) !== 'stale') referenceAliasStates.set(name, 'unknown')
        }
      } else {
        for (const name of affectedNames) {
          if (name !== target) referenceAliasStates.set(name, 'stale')
        }
      }
      for (const name of copyWriteNames) {
        if (name !== target && affectedNames.has(name)) ambiguousCopyWriteNames.add(name)
      }
    }
    for (const name of copyWriteNames) detachPossibleAlias(name, rCopyAliases)
    for (const [target, member] of referenceUpdateMembers) {
      const typeName = member === 'setDF' ? 'data.frame' : member === 'setDT' ? 'data.table' : null
      if (!typeName) continue
      const summary = typeSummaries.get(typeName)
      if (!summary) continue
      for (const name of referenceUpdateAffectedNames.get(target) ?? [target]) {
        if (name === target && reboundReferenceTargets.has(target)) continue
        if (ambiguousCopyWriteNames.has(name) || ambiguousReferenceAliasNames.has(name)) {
          objectTypes.delete(name)
          copyOnModifyNames.delete(name)
          continue
        }
        objectTypes.set(name, summary)
        if (typeName === 'data.table') copyOnModifyNames.delete(name)
        else copyOnModifyNames.add(name)
      }
    }

    const definiteMutations = new Set<string>()
    const definiteMutationRoots = incompleteRun
      ? []
      : [...(facts.mutatedNames ?? []), ...typeAwareMutatedNames]
    for (const name of definiteMutationRoots) {
      if (shadowedReferenceTargets.has(name) && !referenceUpdateMembers.has(name)) continue
      const affectedNames = referenceUpdateAffectedNames.get(name) ?? namesSharingReference(name)
      if (
        referenceUpdateAffectedNames.has(name) &&
        (copyWriteNames.has(name) || reboundReferenceTargets.has(name))
      ) {
        definiteMutations.add(name)
      } else {
        for (const aliasName of affectedNames) definiteMutations.add(aliasName)
      }
    }
    for (const name of facts.mutatedNames ?? []) {
      if (
        run.kernelKind === 'r' &&
        !referenceUpdateAffectedNames.has(name) &&
        isKnownRValue(name)
      ) {
        detachPossibleAlias(name, rCopyAliases)
      }
    }
    const possibleMutationReasons =
      analysisReasons.length > 0 ? analysisReasons : ['opaque-mutation']
    const possibleMutations = new Set<string>()
    const possibleMutationRoots = [
      ...(facts.possiblyMutatedNames ?? []),
      ...(facts.memberWrites ?? [])
        .filter((write) => write.conditional)
        .map((write) => write.receiver),
      ...(incompleteRun ? typeAwareMutatedNames : []),
      ...typeAwarePossiblyMutatedNames,
      ...ambiguousReferenceAliasNames,
      ...shadowedReferenceTargets,
      ...(safeCallShadowed ? (facts.safeCallArgumentNames ?? []) : [])
    ]
    for (const name of possibleMutationRoots) {
      for (const aliasName of namesSharingReference(name)) possibleMutations.add(aliasName)
    }
    const namesReachableThroughPossibleReferences = (names: Iterable<string>): Set<string> => {
      const reachable = new Set(names)
      const queue = [...reachable]
      while (queue.length > 0) {
        const current = queue.shift()!
        const neighbors = new Set([
          ...namesSharingReference(current),
          ...(possibleAliases.get(current) ?? [])
        ])
        for (const neighbor of neighbors) {
          if (reachable.has(neighbor)) continue
          reachable.add(neighbor)
          queue.push(neighbor)
        }
      }
      return reachable
    }
    const possibleAliasMutations = new Set<string>()
    for (const aliasName of namesReachableThroughPossibleReferences([
      ...definiteMutations,
      ...possibleMutations
    ])) {
      if (!definiteMutations.has(aliasName) && !possibleMutations.has(aliasName)) {
        possibleAliasMutations.add(aliasName)
      }
    }
    const touchesDynamicNamespace = [
      ...definiteMutations,
      ...possibleMutations,
      ...possibleAliasMutations
    ].some((name) => DYNAMIC_NAMESPACE_ROOTS.has(name))
    if (touchesDynamicNamespace) taintCurrentNamespace(['dynamic-namespace'])
    for (const name of definiteMutations) {
      invalidateName(name, 'stale', [], true, referenceAliasStates.get(name) === 'stale')
    }
    for (const name of possibleMutations) {
      if (!definiteMutations.has(name)) {
        invalidateName(
          name,
          'unknown',
          possibleMutationReasons,
          true,
          referenceAliasStates.get(name) === 'unknown'
        )
      }
    }
    if (possibleAliasMutations.size > 0) {
      for (const name of possibleAliasMutations) {
        uncertainBindings.set(name, ['possible-alias'])
        invalidateName(name, 'unknown', ['possible-alias'])
      }
    }
    if (incompleteRun) {
      for (const name of incomplete?.affectedNames ?? []) {
        uncertainBindings.set(name, ['incomplete-run'])
      }
    }
  }

  projection(): NotebookDependencyProjection {
    const stalenessByRunId = Object.fromEntries(
      Object.entries(this.stalenessByRunId).filter(([runId]) => !this.incompleteRunIds.has(runId))
    )
    const dependenciesByRunId = Object.fromEntries(
      [...this.directDependenciesByRunId].flatMap(([runId, dependencies]) =>
        stalenessByRunId[runId]?.state === 'clear' &&
        [...dependencies].every(
          (dependencyRunId) => stalenessByRunId[dependencyRunId]?.state === 'clear'
        )
          ? [[runId, [...dependencies].sort()]]
          : []
      )
    )
    return {
      stalenessByRunId,
      invalidatedByRunId: Object.fromEntries(
        Object.entries(this.invalidatedByRunId).map(([runId, invalidated]) => [
          runId,
          invalidated.map((entry) => ({
            ...entry,
            names: [...entry.names],
            ...(entry.state === 'unknown' ? { reasons: [...entry.reasons] } : {})
          }))
        ])
      ),
      dependenciesByRunId
    }
  }
}

const projectNotebookFileDependencies = (
  analyzedRuns: readonly AnalyzedNotebookRun[]
): {
  fileDependenciesByRunId: Record<string, NotebookFileDependency[]>
  unresolvedFileReadRunIds: string[]
} => {
  const producers = new Map<string, { runId: string; generationId?: string; checksum?: string }>()
  const producerPaths = new Map<string, NotebookWorkingFile>()
  const ambiguousPaths = new Set<string>()
  const unresolvedFileReadRunIds = new Set<string>()
  const dependenciesByRunId: Record<string, NotebookFileDependency[]> = {}
  const runsById = new Map(analyzedRuns.map(({ run }) => [run.runId, run]))
  const generationLineageKeys = (
    run: NotebookRunRecord,
    generation: NotebookWorkingFile
  ): Set<string> =>
    new Set([
      lineagePathKey(run, generation.path),
      ...(generation.relativePath ? [lineagePathKey(run, generation.relativePath)] : [])
    ])
  const aliasesForGeneration = (
    run: NotebookRunRecord,
    generation: NotebookWorkingFile
  ): Set<string> => {
    const generationKeys = generationLineageKeys(run, generation)
    return new Set(
      [...producerPaths].flatMap(([key, producerFile]) =>
        [...generationLineageKeys(run, producerFile)].some((candidate) =>
          generationKeys.has(candidate)
        )
          ? [key]
          : []
      )
    )
  }
  const invalidateGenerationAliases = (
    run: NotebookRunRecord,
    generation: NotebookWorkingFile,
    ambiguous: boolean
  ): void => {
    const keys = aliasesForGeneration(run, generation)
    for (const key of generationLineageKeys(run, generation)) keys.add(key)
    for (const key of keys) {
      producers.delete(key)
      producerPaths.delete(key)
      if (ambiguous) ambiguousPaths.add(key)
      else ambiguousPaths.delete(key)
    }
  }
  const registerProducer = (
    run: NotebookRunRecord,
    sourcePath: string,
    generation: NotebookWorkingFile
  ): void => {
    // A new generation supersedes every prior alias for the same artifact. Keep
    // those aliases ambiguous until the exact identities observed in this run
    // are registered below; scoped aliases for companion writes must not point
    // at the older producer.
    invalidateGenerationAliases(run, generation, true)
    const producer = {
      runId: run.runId,
      ...(generation.generationId ? { generationId: generation.generationId } : {}),
      ...(generation.checksum ? { checksum: generation.checksum } : {})
    }
    for (const path of [
      sourcePath,
      generation.path,
      ...(lineageWorkingDirectory(run) === undefined &&
      hasCompleteRuntimeFileEvidence(run) &&
      generation.relativePath
        ? [generation.relativePath]
        : [])
    ]) {
      const key = lineagePathKey(run, path)
      producers.set(key, producer)
      producerPaths.set(key, generation)
      ambiguousPaths.delete(key)
    }
  }
  const markAmbiguous = (run: NotebookRunRecord, generation: NotebookWorkingFile): void => {
    invalidateGenerationAliases(run, generation, true)
  }
  const markPathAmbiguous = (run: NotebookRunRecord, path: string): void => {
    const key = lineagePathKey(run, path)
    const aliases = new Set([key])
    for (const [producerKey, producerFile] of producerPaths) {
      if (generationLineageKeys(run, producerFile).has(key)) aliases.add(producerKey)
    }
    for (const alias of aliases) {
      producers.delete(alias)
      producerPaths.delete(alias)
      ambiguousPaths.add(alias)
    }
  }
  const scopeCandidatePath = (run: NotebookRunRecord, path: string): string => {
    return lineageScopePath(run, path)
  }
  const readMatchesScope = (
    run: NotebookRunRecord,
    path: string,
    scope: NotebookSourceFileWriteScope
  ): boolean => {
    const absoluteMatch = matchesAbsoluteLineageScope(run, scope, run, path)
    if (absoluteMatch !== undefined) return absoluteMatch
    const workingDirectory = lineageWorkingDirectory(run)
    const resolvedPath =
      workingDirectory !== undefined && !isAbsolute(path) ? resolve(workingDirectory, path) : path
    const candidatePath = scopeCandidatePath(run, resolvedPath)
    const normalizedScope = lineageScope(run, scope)
    return (
      candidatePath !== '..' &&
      !candidatePath.startsWith('../') &&
      matchesLineageScope(normalizedScope, candidatePath)
    )
  }
  const markScopeAmbiguous = (
    run: NotebookRunRecord,
    scope: NotebookSourceFileWriteScope
  ): void => {
    for (const [key, producerFile] of producerPaths) {
      const producerRunId = producers.get(key)?.runId
      const producerRun = producerRunId ? runsById.get(producerRunId) : undefined
      const absoluteMatch = producerRun
        ? matchesAbsoluteLineageScope(run, scope, producerRun, producerFile.path)
        : undefined
      const candidatePaths = [
        scopeCandidatePath(run, producerFile.path),
        ...(lineageWorkingDirectory(run) === undefined &&
        hasCompleteRuntimeFileEvidence(run) &&
        producerFile.relativePath
          ? [scopeCandidatePath(run, producerFile.relativePath)]
          : [])
      ]
      const normalizedScope = lineageScope(run, scope)
      const scopeMatch =
        absoluteMatch ??
        candidatePaths.some(
          (candidatePath) =>
            candidatePath !== '..' &&
            !candidatePath.startsWith('../') &&
            matchesLineageScope(normalizedScope, candidatePath)
        )
      if (!scopeMatch) continue
      producers.delete(key)
      producerPaths.delete(key)
      ambiguousPaths.add(key)
    }
  }
  for (const { run, fileAccess } of analyzedRuns) {
    const runtimeEvidenceComplete = hasCompleteRuntimeFileEvidence(run)
    const runtimeWriterEvidenceComplete = hasCompleteRuntimeWriterEvidence(run)
    if (run.status === 'completed' && fileAccess) {
      const dynamicReadUnresolved = fileAccess.reasonCodes.includes('dynamic-path-unresolved')
      if (
        (!runtimeEvidenceComplete || dynamicReadUnresolved) &&
        fileAccess.readState !== 'complete'
      )
        unresolvedFileReadRunIds.add(run.runId)
      const dependencies: NotebookFileDependency[] = []
      const writeKeys = new Set(
        (fileAccess.writes ?? []).map((rawPath) => lineagePathKey(run, rawPath))
      )
      for (const rawPath of fileAccess.reads) {
        const path = portablePath(rawPath)
        const key = lineagePathKey(run, rawPath)
        const scopeRead = (fileAccess.writeScopes ?? []).some((scope) =>
          readMatchesScope(run, rawPath, scope)
        )
        // Static extraction does not retain statement order. If a run both reads and
        // writes the same path, do not attribute the read to an older producer.
        const explicitBarrier = writeKeys.has(key) || scopeRead || ambiguousPaths.has(key)
        const lineageBlocked = explicitBarrier || isUnanchoredRelativePath(run, key)
        if (lineageBlocked) {
          if (!runtimeEvidenceComplete || explicitBarrier) unresolvedFileReadRunIds.add(run.runId)
          continue
        }
        if (fileAccess.readState !== 'complete') continue
        const producer = producers.get(key)
        if (!producer || producer.runId === run.runId) continue
        dependencies.push({
          producerRunId: producer.runId,
          path,
          ...(producer.generationId ? { generationId: producer.generationId } : {}),
          ...(producer.checksum ? { checksum: producer.checksum } : {}),
          confidence: (producer.checksum
            ? 'verified'
            : 'advisory') as NotebookFileDependency['confidence']
        })
      }
      if (dependencies.length) dependenciesByRunId[run.runId] = dependencies
    }
    if (run.status === 'completed') {
      const observedChanges = run.workingFiles.filter(
        (file) =>
          file.createdByRunId === run.runId ||
          file.change === 'created' ||
          file.change === 'modified'
      )
      const matchedGenerations = new Set<NotebookWorkingFile>()
      if (fileAccess?.writeState === 'complete') {
        for (const rawPath of fileAccess.writes) {
          const path = portablePath(rawPath)
          const generation = observedFileGeneration(run, path)
          if (generation) {
            registerProducer(run, path, generation)
            matchedGenerations.add(generation)
          }
        }
        for (const scope of fileAccess.writeScopes ?? []) {
          // Runtime observation does not establish complete scope coverage. Quarantine
          // all older companions first, then restore only generations observed now.
          markScopeAmbiguous(run, scope)
          const scopedGenerations = observedScopedGenerations(run, [scope])
          for (const generation of scopedGenerations) {
            registerProducer(run, scope.path, generation)
            matchedGenerations.add(generation)
          }
        }
        for (const generation of observedChanges) {
          if (!matchedGenerations.has(generation)) markAmbiguous(run, generation)
        }
        // A complete static write list is only evidence for the paths that were
        // observed. An unobserved declared path must poison that path, otherwise an
        // older producer can be reused after an overwrite that was not captured.
        for (const rawPath of fileAccess.writes) {
          if (!runtimeWriterEvidenceComplete && !observedFileGeneration(run, rawPath))
            markPathAmbiguous(run, rawPath)
        }
      } else if (runtimeWriterEvidenceComplete) {
        // A conservative static writer (for example an sf/terra companion
        // format) may still have a complete runtime receipt. In that case the
        // observed generations are authoritative for the paths that actually
        // changed, while any declared but unobserved path remains ambiguous.
        // This preserves useful output lineage without certifying the writer's
        // unobserved sidecar set.
        const matchedGenerations = new Set<NotebookWorkingFile>()
        for (const rawPath of fileAccess?.writes ?? []) {
          const generation = observedFileGeneration(run, rawPath)
          if (generation) {
            registerProducer(run, rawPath, generation)
            matchedGenerations.add(generation)
          } else markPathAmbiguous(run, rawPath)
        }
        for (const generation of observedChanges) {
          if (!matchedGenerations.has(generation)) markAmbiguous(run, generation)
        }
        for (const scope of fileAccess?.writeScopes ?? []) {
          markScopeAmbiguous(run, scope)
          const scopedGenerations = observedScopedGenerations(run, [scope])
          for (const generation of scopedGenerations) {
            registerProducer(run, scope.path, generation)
            matchedGenerations.add(generation)
          }
        }
      } else {
        for (const generation of observedChanges) markAmbiguous(run, generation)
        if (!runtimeWriterEvidenceComplete) {
          for (const rawPath of fileAccess?.writes ?? []) markPathAmbiguous(run, rawPath)
        }
        for (const scope of fileAccess?.writeScopes ?? []) {
          for (const generation of observedScopedGenerations(run, [scope]))
            markAmbiguous(run, generation)
          markScopeAmbiguous(run, scope)
        }
      }
    } else {
      // Incomplete runs may still have modified files. Keep their evidence as an
      // ambiguity barrier, but never register their generations as valid producers.
      for (const generation of run.workingFiles.filter(
        (file) =>
          file.createdByRunId === run.runId ||
          file.change === 'created' ||
          file.change === 'modified'
      ))
        markAmbiguous(run, generation)
      for (const rawPath of fileAccess?.writes ?? []) markPathAmbiguous(run, rawPath)
      for (const scope of fileAccess?.writeScopes ?? []) {
        for (const generation of observedScopedGenerations(run, [scope]))
          markAmbiguous(run, generation)
        markScopeAmbiguous(run, scope)
      }
    }
  }
  return {
    fileDependenciesByRunId: dependenciesByRunId,
    unresolvedFileReadRunIds: [...unresolvedFileReadRunIds]
  }
}

// Projects immutable run history into current dependency freshness. Cell identity is deliberately
// absent: every call can use a new cellId while still sharing the same persistent kernel namespace.
const projectNotebookDependencies = (
  analyzedRuns: readonly AnalyzedNotebookRun[]
): NotebookDependencyProjection => {
  const projector = new NotebookDependencyProjector()
  for (const analyzedRun of analyzedRuns) projector.append(analyzedRun)
  return projector.projection()
}

const unavailableNotebookDependencyProjection = (
  runs: readonly NotebookRunRecord[],
  reason = 'analysis-unavailable'
): NotebookDependencyProjection => ({
  stalenessByRunId: Object.fromEntries(
    runs.flatMap((run) =>
      run.status === 'completed' &&
      (run.kernelKind === 'python' || run.kernelKind === 'r' || run.kernelKind === 'repl')
        ? [[run.runId, { state: 'unknown', reasons: [reason] } satisfies NotebookRunStaleness]]
        : []
    )
  ),
  invalidatedByRunId: {},
  dependenciesByRunId: {}
})

export {
  NotebookDependencyProjector,
  projectNotebookFileDependencies,
  projectNotebookDependencies,
  unavailableNotebookDependencyProjection
}

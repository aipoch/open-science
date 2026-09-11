import { createHash, randomUUID } from 'node:crypto'
import type { PythonArgumentShape } from './python-library-effects'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  NotebookInvalidatedRun,
  NotebookRunRecord,
  NotebookRunStaleness
} from '../../shared/notebook'
import type {
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
  NotebookSourceFileAccessContext,
  NotebookSourceFileAccessContextRequest,
  NotebookRunDependencyFacts,
  ProjectNotebookDependenciesRequest
} from './dependency-analysis-types'
import {
  analyzePythonFileAccesses,
  analyzePythonNotebookSource
} from './dependency-analysis-python'
import { analyzeRFileAccesses, analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookFileContext, type FileContextEntry } from './dependency-file-context'
import { serializedFileContext, serializedValueDescriptors } from './serialized-file-provenance'
import {
  NotebookDependencyProjector,
  projectNotebookDependencies,
  unavailableNotebookDependencyProjection
} from './dependency-projection'
import { getNotebookSessionRoot, getRuntimeRoot, type NotebookRunRepository } from './repository'
import { envPrefix, pythonBin, resolveEnvName, rScriptBin } from './runtime-paths'

import {
  NOTEBOOK_ANALYZER_VERSION as ANALYZER_VERSION,
  NOTEBOOK_ANALYZER_REVISION as ANALYZER_REVISION
} from './analysis-version'
const SIDECAR_FILE = 'dependency-analysis.json'
const MAX_NAMES_PER_RUN = 512
const MAX_STATIC_STRING_LENGTH = 4_096
const MAX_STATIC_COLLECTION_VALUES = 128
const MAX_STATIC_COLLECTION_VALUES_PER_CONTEXT = 1_024
const MAX_INCREMENTAL_PROJECTIONS = 32
const RETRYABLE_ANALYSIS_FAILURES = new Set([
  'analysis-unavailable',
  'invalid-parser-result',
  'parser-failed',
  'parser-output-limit',
  'parser-timeout',
  'parser-unavailable'
])
const unknownFacts = (reason: string): NotebookRunDependencyFacts => ({
  state: 'unknown',
  reasons: [reason],
  priorUsedNames: [],
  possiblyUsedNames: [],
  copyOnModifyNames: [],
  copyOnModifyBindings: [],
  copyOnModifyInvalidatedNames: [],
  typeSummaries: [],
  typeBindings: [],
  receiverCalls: [],
  memberWrites: []
})

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= MAX_NAMES_PER_RUN &&
  value.every((item) => typeof item === 'string')
    ? [...new Set(value)].sort()
    : undefined

// Tuple slots and call chains are ordered and may repeat names/types.
const orderedStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= MAX_NAMES_PER_RUN &&
  value.every((item) => typeof item === 'string')
    ? [...value]
    : undefined

const projectionStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...(value as string[])]
    : undefined

const projectionValue = (value: unknown): NotebookDependencyProjection | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    !record.stalenessByRunId ||
    typeof record.stalenessByRunId !== 'object' ||
    Array.isArray(record.stalenessByRunId) ||
    !record.invalidatedByRunId ||
    typeof record.invalidatedByRunId !== 'object' ||
    Array.isArray(record.invalidatedByRunId) ||
    !record.dependenciesByRunId ||
    typeof record.dependenciesByRunId !== 'object' ||
    Array.isArray(record.dependenciesByRunId)
  ) {
    return undefined
  }

  const stalenessByRunId: Record<string, NotebookRunStaleness> = {}
  for (const [runId, candidate] of Object.entries(record.stalenessByRunId)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const staleness = candidate as Record<string, unknown>
    if (staleness.state === 'clear') {
      stalenessByRunId[runId] = { state: 'clear' }
      continue
    }
    if (staleness.state === 'unknown') {
      const reasons = projectionStringArray(staleness.reasons)
      if (!reasons?.length) return undefined
      stalenessByRunId[runId] = { state: 'unknown', reasons }
      continue
    }
    const names = projectionStringArray(staleness.names)
    const path = projectionStringArray(staleness.path)
    if (
      staleness.state !== 'stale' ||
      typeof staleness.causedByRunId !== 'string' ||
      !names ||
      !path
    ) {
      return undefined
    }
    stalenessByRunId[runId] = {
      state: 'stale',
      causedByRunId: staleness.causedByRunId,
      names,
      path
    }
  }

  const invalidatedByRunId: Record<string, NotebookInvalidatedRun[]> = {}
  for (const [runId, candidate] of Object.entries(record.invalidatedByRunId)) {
    if (!Array.isArray(candidate)) return undefined
    const invalidated: NotebookInvalidatedRun[] = []
    for (const item of candidate) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
      const entry = item as Record<string, unknown>
      const names = projectionStringArray(entry.names)
      if (typeof entry.runId !== 'string' || typeof entry.cellId !== 'string' || !names) {
        return undefined
      }
      if (entry.state === 'stale') {
        invalidated.push({
          state: 'stale',
          runId: entry.runId,
          cellId: entry.cellId,
          names
        })
        continue
      }
      const reasons = projectionStringArray(entry.reasons)
      if (entry.state !== 'unknown' || !reasons?.length) return undefined
      invalidated.push({
        state: 'unknown',
        runId: entry.runId,
        cellId: entry.cellId,
        names,
        reasons
      })
    }
    invalidatedByRunId[runId] = invalidated
  }

  const dependenciesByRunId: Record<string, string[]> = {}
  for (const [runId, candidate] of Object.entries(record.dependenciesByRunId)) {
    const dependencies = projectionStringArray(candidate)
    if (!dependencies) return undefined
    dependenciesByRunId[runId] = dependencies
  }
  return { stalenessByRunId, invalidatedByRunId, dependenciesByRunId }
}

const fileContextValue = (value: unknown): NotebookSourceFileAccessContext | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const rawStaticCollections = record.staticCollections ?? []
  if (
    !Array.isArray(record.staticStrings) ||
    !Array.isArray(rawStaticCollections) ||
    !Array.isArray(record.localFileWrappers) ||
    record.staticStrings.length > MAX_NAMES_PER_RUN ||
    rawStaticCollections.length > MAX_NAMES_PER_RUN ||
    record.localFileWrappers.length > MAX_NAMES_PER_RUN
  ) {
    return undefined
  }
  const staticStrings: NotebookSourceFileAccessContext['staticStrings'] = []
  const staticCollections: NotebookSourceFileAccessContext['staticCollections'] = []
  const localFileWrappers: NotebookSourceFileAccessContext['localFileWrappers'] = []
  const names = new Set<string>()
  for (const candidate of record.staticStrings) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const binding = candidate as Record<string, unknown>
    if (
      typeof binding.name !== 'string' ||
      !binding.name ||
      typeof binding.value !== 'string' ||
      binding.value.length > MAX_STATIC_STRING_LENGTH ||
      names.has(binding.name)
    ) {
      return undefined
    }
    names.add(binding.name)
    staticStrings.push({ name: binding.name, value: binding.value })
  }
  let staticCollectionValueCount = 0
  for (const candidate of rawStaticCollections) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const collection = candidate as Record<string, unknown>
    if (
      typeof collection.name !== 'string' ||
      !collection.name ||
      names.has(collection.name) ||
      (collection.rKind !== undefined &&
        collection.rKind !== 'vector' &&
        collection.rKind !== 'list') ||
      !Array.isArray(collection.values) ||
      !collection.values.length ||
      collection.values.length > MAX_STATIC_COLLECTION_VALUES ||
      collection.values.some(
        (item) => typeof item !== 'string' || item.length > MAX_STATIC_STRING_LENGTH
      )
    ) {
      return undefined
    }
    staticCollectionValueCount += collection.values.length
    if (staticCollectionValueCount > MAX_STATIC_COLLECTION_VALUES_PER_CONTEXT) return undefined
    let entries: Array<{ key: string; value: string }> | undefined
    if (collection.entries !== undefined) {
      if (
        !Array.isArray(collection.entries) ||
        collection.entries.length !== collection.values.length
      ) {
        return undefined
      }
      entries = []
      for (const [index, candidateEntry] of collection.entries.entries()) {
        if (!candidateEntry || typeof candidateEntry !== 'object') return undefined
        const entry = candidateEntry as Record<string, unknown>
        if (
          typeof entry.key !== 'string' ||
          entry.key.length > MAX_STATIC_STRING_LENGTH ||
          typeof entry.value !== 'string' ||
          entry.value !== collection.values[index]
        ) {
          return undefined
        }
        entries.push({ key: entry.key, value: entry.value })
      }
    }
    names.add(collection.name)
    staticCollections.push({
      name: collection.name,
      values: [...(collection.values as string[])],
      ...(collection.rKind ? { rKind: collection.rKind } : {}),
      ...(entries ? { entries } : {})
    })
  }
  for (const candidate of record.localFileWrappers) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const wrapper = candidate as Record<string, unknown>
    const keywords = stringArray(wrapper.keywords)
    const dependencyNames = stringArray(wrapper.dependencyNames)
    if (
      typeof wrapper.name !== 'string' ||
      !wrapper.name ||
      (wrapper.kind !== 'read' && wrapper.kind !== 'write') ||
      !Number.isSafeInteger(wrapper.position) ||
      (wrapper.position as number) < 0 ||
      !keywords ||
      !dependencyNames ||
      (wrapper.inputForm !== undefined &&
        wrapper.inputForm !== 'paths' &&
        wrapper.inputForm !== 'lines') ||
      names.has(wrapper.name)
    ) {
      return undefined
    }
    names.add(wrapper.name)
    localFileWrappers.push({
      name: wrapper.name,
      kind: wrapper.kind,
      position: wrapper.position as number,
      keywords,
      ...(wrapper.inputForm ? { inputForm: wrapper.inputForm } : {}),
      dependencyNames
    })
  }
  const pythonBindings: NonNullable<NotebookSourceFileAccessContext['pythonBindings']> = []
  const pythonTaintedNamespaces =
    record.pythonTaintedNamespaces === undefined ? [] : stringArray(record.pythonTaintedNamespaces)
  if (
    !pythonTaintedNamespaces ||
    pythonTaintedNamespaces.some((name) => !name || name.length > MAX_STATIC_STRING_LENGTH)
  )
    return undefined
  if (record.pythonBindings !== undefined) {
    if (!Array.isArray(record.pythonBindings) || record.pythonBindings.length > MAX_NAMES_PER_RUN)
      return undefined
    for (const candidate of record.pythonBindings) {
      if (!candidate || typeof candidate !== 'object') return undefined
      const binding = candidate as Record<string, unknown>
      if (
        typeof binding.name !== 'string' ||
        !binding.name ||
        binding.name.length > MAX_STATIC_STRING_LENGTH ||
        typeof binding.qualifiedName !== 'string' ||
        !binding.qualifiedName ||
        binding.qualifiedName.length > MAX_STATIC_STRING_LENGTH ||
        (binding.filePath !== undefined &&
          (binding.kind !== 'object' ||
            binding.qualifiedName !== 'pandas.ExcelFile' ||
            typeof binding.filePath !== 'string' ||
            !binding.filePath ||
            binding.filePath.length > MAX_STATIC_STRING_LENGTH)) ||
        (binding.kind !== 'import' && binding.kind !== 'object') ||
        names.has(binding.name)
      )
        return undefined
      names.add(binding.name)
      pythonBindings.push({
        name: binding.name,
        qualifiedName: binding.qualifiedName,
        kind: binding.kind,
        ...(typeof binding.filePath === 'string' ? { filePath: binding.filePath } : {})
      })
    }
  }
  return {
    ...(pythonTaintedNamespaces.length ? { pythonTaintedNamespaces } : {}),
    ...(pythonBindings.length
      ? { pythonBindings: pythonBindings.sort((a, b) => a.name.localeCompare(b.name)) }
      : {}),
    staticStrings: staticStrings.sort((left, right) => left.name.localeCompare(right.name)),
    staticCollections: staticCollections.sort((left, right) => left.name.localeCompare(right.name)),
    localFileWrappers: localFileWrappers.sort((left, right) => left.name.localeCompare(right.name))
  }
}

const aliasArray = (value: unknown): NotebookDependencyAlias[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_NAMES_PER_RUN) return undefined
  const aliases: NotebookDependencyAlias[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const record = candidate as Record<string, unknown>
    if (
      typeof record.target !== 'string' ||
      typeof record.source !== 'string' ||
      (record.kind !== 'reference' && record.kind !== 'possible-reference') ||
      (record.access !== undefined &&
        record.access !== 'attribute' &&
        record.access !== 'subscript') ||
      (record.member !== undefined && typeof record.member !== 'string')
    ) {
      return undefined
    }
    aliases.push({
      target: record.target,
      source: record.source,
      kind: record.kind,
      ...(record.access ? { access: record.access } : {}),
      ...(record.member ? { member: record.member } : {})
    })
  }
  return aliases.filter(
    (alias, index) =>
      aliases.findIndex(
        (candidate) =>
          candidate.target === alias.target &&
          candidate.source === alias.source &&
          candidate.kind === alias.kind &&
          candidate.access === alias.access &&
          candidate.member === alias.member
      ) === index
  )
}

const copyBindingArray = (value: unknown): NotebookDependencyCopyBinding[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_NAMES_PER_RUN) return undefined
  const bindings: NotebookDependencyCopyBinding[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const record = candidate as Record<string, unknown>
    const sourceNames = stringArray(record.sourceNames)
    if (typeof record.target !== 'string' || !sourceNames?.length) return undefined
    bindings.push({ target: record.target, sourceNames })
  }
  return bindings.filter(
    (binding, index) =>
      bindings.findIndex(
        (candidate) =>
          candidate.target === binding.target &&
          candidate.sourceNames.join('\0') === binding.sourceNames.join('\0')
      ) === index
  )
}

const typeSummaryArray = (
  value: unknown,
  requirePersistedMetadata = false
): NotebookDependencyTypeSummary[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_NAMES_PER_RUN) return undefined
  const summaries: NotebookDependencyTypeSummary[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const record = candidate as Record<string, unknown>
    if (
      typeof record.name !== 'string' ||
      (record.kind !== 'python-class' &&
        record.kind !== 'python-module' &&
        record.kind !== 'r-s4' &&
        record.kind !== 'r-function' &&
        record.kind !== 'r-r6') ||
      !Array.isArray(record.fields) ||
      !Array.isArray(record.methods) ||
      (requirePersistedMetadata && record.complete === undefined) ||
      record.fields.length > MAX_NAMES_PER_RUN ||
      record.methods.length > MAX_NAMES_PER_RUN
    ) {
      return undefined
    }
    const fields: NotebookDependencyTypeSummary['fields'] = []
    for (const field of record.fields) {
      if (!field || typeof field !== 'object') return undefined
      const fieldRecord = field as Record<string, unknown>
      if (
        typeof fieldRecord.name !== 'string' ||
        (fieldRecord.relationship !== 'reference' &&
          fieldRecord.relationship !== 'value' &&
          fieldRecord.relationship !== 'unknown')
      ) {
        return undefined
      }
      fields.push({ name: fieldRecord.name, relationship: fieldRecord.relationship })
    }
    const methods: NotebookDependencyTypeSummary['methods'] = []
    for (const method of record.methods) {
      if (!method || typeof method !== 'object') return undefined
      const methodRecord = method as Record<string, unknown>
      if (
        typeof methodRecord.name !== 'string' ||
        (methodRecord.effect !== 'read' &&
          methodRecord.effect !== 'mutate' &&
          methodRecord.effect !== 'unknown')
      ) {
        return undefined
      }
      if (
        (requirePersistedMetadata && methodRecord.unknownScope === undefined) ||
        (methodRecord.unknownScope !== undefined &&
          methodRecord.unknownScope !== 'receiver' &&
          methodRecord.unknownScope !== 'namespace')
      ) {
        return undefined
      }
      const usedNames =
        methodRecord.usedNames === undefined ? [] : stringArray(methodRecord.usedNames)
      const safeCallNames =
        methodRecord.safeCallNames === undefined ? [] : stringArray(methodRecord.safeCallNames)
      const destructuredReturnTypes =
        methodRecord.destructuredReturnTypes === undefined
          ? undefined
          : orderedStringArray(methodRecord.destructuredReturnTypes)
      if (
        !usedNames ||
        !safeCallNames ||
        (methodRecord.returnCopyArguments !== undefined &&
          typeof methodRecord.returnCopyArguments !== 'boolean') ||
        (methodRecord.returnType !== undefined &&
          methodRecord.returnType !== null &&
          typeof methodRecord.returnType !== 'string') ||
        (methodRecord.destructuredReturnTypes !== undefined && !destructuredReturnTypes) ||
        (typeof methodRecord.returnType === 'string' && Boolean(destructuredReturnTypes?.length)) ||
        (methodRecord.mutatesKeyword !== undefined &&
          methodRecord.mutatesKeyword !== null &&
          typeof methodRecord.mutatesKeyword !== 'string') ||
        (requirePersistedMetadata &&
          (methodRecord.usedNames === undefined ||
            methodRecord.safeCallNames === undefined ||
            methodRecord.returnType === undefined ||
            methodRecord.destructuredReturnTypes === undefined ||
            methodRecord.mutatesKeyword === undefined))
      ) {
        return undefined
      }
      methods.push({
        name: methodRecord.name,
        effect: methodRecord.effect,
        usedNames,
        safeCallNames,
        unknownScope: methodRecord.unknownScope === 'namespace' ? 'namespace' : 'receiver',
        returnType: typeof methodRecord.returnType === 'string' ? methodRecord.returnType : null,
        ...(methodRecord.returnCopyArguments === true ? { returnCopyArguments: true } : {}),
        destructuredReturnTypes: destructuredReturnTypes ?? [],
        mutatesKeyword:
          typeof methodRecord.mutatesKeyword === 'string' ? methodRecord.mutatesKeyword : null
      })
    }
    if (record.complete !== undefined && typeof record.complete !== 'boolean') return undefined
    summaries.push({
      name: record.name,
      kind: record.kind,
      complete: record.complete !== false,
      fields,
      methods
    })
  }
  return summaries
}

const typeBindingArray = (
  value: unknown,
  requireArgumentNames = false
): NotebookDependencyTypeBinding[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_NAMES_PER_RUN) return undefined
  const bindings: NotebookDependencyTypeBinding[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const record = candidate as Record<string, unknown>
    const argumentNames =
      record.argumentNames === undefined ? [] : stringArray(record.argumentNames)
    if (
      typeof record.target !== 'string' ||
      typeof record.typeName !== 'string' ||
      (requireArgumentNames && record.argumentNames === undefined) ||
      !argumentNames
    ) {
      return undefined
    }
    bindings.push({
      target: record.target,
      typeName: record.typeName,
      argumentNames
    })
  }
  return bindings
}

const memberWriteArray = (
  value: unknown,
  requireScope = false
): NotebookDependencyMemberWrite[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_NAMES_PER_RUN) return undefined
  const writes: NotebookDependencyMemberWrite[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const record = candidate as Record<string, unknown>
    if (
      typeof record.receiver !== 'string' ||
      (record.member !== undefined && typeof record.member !== 'string') ||
      (requireScope && record.scope === undefined) ||
      (record.scope !== undefined && record.scope !== 'instance' && record.scope !== 'type') ||
      (record.conditional !== undefined && typeof record.conditional !== 'boolean')
    ) {
      return undefined
    }
    writes.push({
      receiver: record.receiver,
      ...(record.member ? { member: record.member } : {}),
      scope: record.scope === 'type' ? 'type' : 'instance',
      ...(record.conditional === true ? { conditional: true } : {})
    })
  }
  return writes
}

const isPythonArgumentShape = (value: unknown): value is PythonArgumentShape =>
  typeof value === 'string' && ['none', 'list', 'scalar', 'unknown'].includes(value)

const pythonArgumentShapes = (value: unknown): PythonArgumentShape[] | undefined =>
  Array.isArray(value) && value.length <= MAX_NAMES_PER_RUN && value.every(isPythonArgumentShape)
    ? value
    : undefined

const receiverCallArray = (
  value: unknown,
  requireArgumentNames = false
): NotebookDependencyReceiverCall[] | undefined => {
  if (!Array.isArray(value) || value.length > MAX_NAMES_PER_RUN) return undefined
  const calls: NotebookDependencyReceiverCall[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return undefined
    const record = candidate as Record<string, unknown>
    const argumentNames =
      record.argumentNames === undefined ? undefined : stringArray(record.argumentNames)
    const receiverChain =
      record.receiverChain === undefined ? undefined : orderedStringArray(record.receiverChain)
    const receiverChainFirstArgumentNames = (() => {
      if (record.receiverChainFirstArgumentNames === undefined) return undefined
      if (
        !Array.isArray(record.receiverChainFirstArgumentNames) ||
        record.receiverChainFirstArgumentNames.length > MAX_NAMES_PER_RUN
      ) {
        return false
      }
      const positions = record.receiverChainFirstArgumentNames.map((position) =>
        stringArray(position)
      )
      return positions.every((position) => position !== undefined)
        ? (positions as string[][])
        : false
    })()
    const receiverChainPositionalArgumentNames = (() => {
      if (record.receiverChainPositionalArgumentNames === undefined) return undefined
      if (
        !Array.isArray(record.receiverChainPositionalArgumentNames) ||
        record.receiverChainPositionalArgumentNames.length > MAX_NAMES_PER_RUN
      ) {
        return false
      }
      const steps = record.receiverChainPositionalArgumentNames.map((step) => {
        if (!Array.isArray(step) || step.length > MAX_NAMES_PER_RUN) return undefined
        const positions = step.map((position) => stringArray(position))
        return positions.every((position) => position !== undefined)
          ? (positions as string[][])
          : undefined
      })
      return steps.every((step) => step !== undefined) ? (steps as string[][][]) : false
    })()
    const positionalStaticShapes =
      record.positionalStaticShapes === undefined
        ? undefined
        : pythonArgumentShapes(record.positionalStaticShapes)
    const receiverChainPositionalStaticShapes = (() => {
      if (
        !Array.isArray(record.receiverChainPositionalStaticShapes) ||
        record.receiverChainPositionalStaticShapes.length > MAX_NAMES_PER_RUN
      )
        return undefined
      const steps = record.receiverChainPositionalStaticShapes.map(pythonArgumentShapes)
      return steps.every((step): step is PythonArgumentShape[] => step !== undefined)
        ? steps
        : undefined
    })()
    const receiverChainPositionalStaticBooleans = (() => {
      if (record.receiverChainPositionalStaticBooleans === undefined) return undefined
      if (
        !Array.isArray(record.receiverChainPositionalStaticBooleans) ||
        record.receiverChainPositionalStaticBooleans.length > MAX_NAMES_PER_RUN
      ) {
        return false
      }
      const steps = record.receiverChainPositionalStaticBooleans.map((step) =>
        Array.isArray(step) &&
        step.length <= MAX_NAMES_PER_RUN &&
        step.every((value) => value === null || typeof value === 'boolean')
          ? (step as Array<boolean | null>)
          : undefined
      )
      return steps.every((step) => step !== undefined)
        ? (steps as Array<Array<boolean | null>>)
        : false
    })()
    const receiverChainKeywordArguments = (() => {
      if (record.receiverChainKeywordArguments === undefined) return undefined
      if (
        !Array.isArray(record.receiverChainKeywordArguments) ||
        record.receiverChainKeywordArguments.length > MAX_NAMES_PER_RUN
      ) {
        return false
      }
      const steps: Array<
        Array<{
          name: string
          argumentNames: string[]
          staticBoolean: boolean | null
          staticShape?: PythonArgumentShape
        }>
      > = []
      for (const step of record.receiverChainKeywordArguments) {
        if (!Array.isArray(step) || step.length > MAX_NAMES_PER_RUN) return false
        const parsed: Array<{
          name: string
          argumentNames: string[]
          staticBoolean: boolean | null
          staticShape?: PythonArgumentShape
        }> = []
        for (const candidate of step) {
          if (!candidate || typeof candidate !== 'object') return false
          const keyword = candidate as Record<string, unknown>
          const names = stringArray(keyword.argumentNames)
          if (
            typeof keyword.name !== 'string' ||
            !names ||
            (keyword.staticShape !== undefined && !isPythonArgumentShape(keyword.staticShape)) ||
            (keyword.staticBoolean !== null && typeof keyword.staticBoolean !== 'boolean')
          ) {
            return false
          }
          parsed.push({
            name: keyword.name,
            argumentNames: names,
            ...(isPythonArgumentShape(keyword.staticShape)
              ? { staticShape: keyword.staticShape }
              : {}),
            staticBoolean: typeof keyword.staticBoolean === 'boolean' ? keyword.staticBoolean : null
          })
        }
        steps.push(parsed)
      }
      return steps
    })()
    const receiverValueNames =
      record.receiverValueNames === undefined ? undefined : stringArray(record.receiverValueNames)
    const positionalArgumentNames = (() => {
      if (record.positionalArgumentNames === undefined) return undefined
      if (
        !Array.isArray(record.positionalArgumentNames) ||
        record.positionalArgumentNames.length > MAX_NAMES_PER_RUN
      ) {
        return false
      }
      const positions = record.positionalArgumentNames.map((position) => stringArray(position))
      return positions.every((position) => position !== undefined)
        ? (positions as string[][])
        : false
    })()
    const positionalStaticBooleans = (() => {
      if (record.positionalStaticBooleans === undefined) return undefined
      if (
        !Array.isArray(record.positionalStaticBooleans) ||
        record.positionalStaticBooleans.length > MAX_NAMES_PER_RUN ||
        record.positionalStaticBooleans.some(
          (value) => value !== null && typeof value !== 'boolean'
        )
      ) {
        return false
      }
      return record.positionalStaticBooleans as Array<boolean | null>
    })()
    // Return positions are ordered, unlike sets of dependency names.
    const resultNames =
      record.resultNames === undefined ? undefined : orderedStringArray(record.resultNames)
    const resultPaths = (() => {
      if (record.resultPaths === undefined) return undefined
      if (
        !Array.isArray(record.resultPaths) ||
        record.resultPaths.length !== resultNames?.length ||
        record.resultPaths.some(
          (path) =>
            !Array.isArray(path) ||
            path.length === 0 ||
            path.length > 64 ||
            path.some(
              (index) => !Number.isSafeInteger(index) || index < 0 || index > MAX_NAMES_PER_RUN
            )
        )
      )
        return false
      return record.resultPaths as number[][]
    })()
    const keywordArguments = (() => {
      if (record.keywordArguments === undefined) return undefined
      if (!Array.isArray(record.keywordArguments)) return false
      const parsed: Array<{
        name: string
        argumentNames: string[]
        possibleArgumentNames: string[]
        staticBoolean: boolean | null
        staticShape?: PythonArgumentShape
        callableReferences: Array<{
          root: string
          member?: string
          container?: 'list' | 'dict'
        }>
      }> = []
      for (const keyword of record.keywordArguments) {
        if (!keyword || typeof keyword !== 'object') return false
        const keywordRecord = keyword as Record<string, unknown>
        const keywordArgumentNames = stringArray(keywordRecord.argumentNames)
        const possibleArgumentNames =
          keywordRecord.possibleArgumentNames === undefined
            ? []
            : stringArray(keywordRecord.possibleArgumentNames)
        const staticBoolean =
          keywordRecord.staticBoolean === true || keywordRecord.staticBoolean === false
            ? keywordRecord.staticBoolean
            : null
        const callableReferences = (() => {
          if (keywordRecord.callableReferences === undefined) return []
          if (
            !Array.isArray(keywordRecord.callableReferences) ||
            keywordRecord.callableReferences.length > MAX_NAMES_PER_RUN
          ) {
            return undefined
          }
          const references: Array<{
            root: string
            member?: string
            container?: 'list' | 'dict'
          }> = []
          for (const candidate of keywordRecord.callableReferences) {
            if (!candidate || typeof candidate !== 'object') return undefined
            const reference = candidate as Record<string, unknown>
            if (
              typeof reference.root !== 'string' ||
              (reference.member !== undefined && typeof reference.member !== 'string') ||
              (reference.container !== undefined &&
                reference.container !== 'list' &&
                reference.container !== 'dict')
            ) {
              return undefined
            }
            references.push({
              root: reference.root,
              ...(typeof reference.member === 'string' ? { member: reference.member } : {}),
              ...(reference.container === 'list' || reference.container === 'dict'
                ? { container: reference.container }
                : {})
            })
          }
          return references
        })()
        if (
          typeof keywordRecord.name !== 'string' ||
          !keywordArgumentNames ||
          (requireArgumentNames && keywordRecord.possibleArgumentNames === undefined) ||
          !possibleArgumentNames ||
          (keywordRecord.staticShape !== undefined &&
            !isPythonArgumentShape(keywordRecord.staticShape)) ||
          (requireArgumentNames && keywordRecord.staticBoolean === undefined) ||
          (keywordRecord.staticBoolean !== undefined &&
            keywordRecord.staticBoolean !== null &&
            typeof keywordRecord.staticBoolean !== 'boolean') ||
          (requireArgumentNames && keywordRecord.callableReferences === undefined) ||
          !callableReferences
        ) {
          return false
        }
        parsed.push({
          name: keywordRecord.name,
          argumentNames: keywordArgumentNames,
          possibleArgumentNames,
          staticBoolean,
          ...(isPythonArgumentShape(keywordRecord.staticShape)
            ? { staticShape: keywordRecord.staticShape }
            : {}),
          callableReferences
        })
      }
      return parsed
    })()
    if (
      typeof record.receiver !== 'string' ||
      typeof record.member !== 'string' ||
      (record.kind !== undefined &&
        record.kind !== 'receiver' &&
        record.kind !== 'generic' &&
        record.kind !== 'mutating' &&
        record.kind !== 'callable') ||
      (record.conditional !== undefined && typeof record.conditional !== 'boolean') ||
      (requireArgumentNames && record.kind === undefined) ||
      (requireArgumentNames && record.argumentNames === undefined) ||
      (requireArgumentNames && record.receiverChain === undefined) ||
      (requireArgumentNames && record.receiverChainFirstArgumentNames === undefined) ||
      (requireArgumentNames && record.receiverChainPositionalArgumentNames === undefined) ||
      (requireArgumentNames && record.receiverChainPositionalStaticBooleans === undefined) ||
      (requireArgumentNames && record.receiverChainKeywordArguments === undefined) ||
      (requireArgumentNames && record.receiverValueNames === undefined) ||
      (requireArgumentNames && record.positionalArgumentNames === undefined) ||
      (requireArgumentNames && record.positionalStaticBooleans === undefined) ||
      (requireArgumentNames && record.resultNames === undefined) ||
      (requireArgumentNames && record.keywordArguments === undefined) ||
      (record.argumentNames !== undefined && !argumentNames) ||
      (record.receiverChain !== undefined && !receiverChain) ||
      (record.positionalStaticShapes !== undefined &&
        (!positionalStaticShapes ||
          !Array.isArray(positionalArgumentNames) ||
          positionalStaticShapes.length !== positionalArgumentNames.length)) ||
      (record.receiverChainPositionalStaticShapes !== undefined &&
        (!receiverChainPositionalStaticShapes ||
          !Array.isArray(receiverChainPositionalArgumentNames) ||
          receiverChainPositionalStaticShapes.length !==
            receiverChainPositionalArgumentNames.length ||
          receiverChainPositionalStaticShapes.some(
            (step, index) => step.length !== receiverChainPositionalArgumentNames[index]?.length
          ))) ||
      receiverChainFirstArgumentNames === false ||
      receiverChainPositionalArgumentNames === false ||
      receiverChainPositionalStaticBooleans === false ||
      receiverChainKeywordArguments === false ||
      (Array.isArray(receiverChain) &&
        Array.isArray(receiverChainFirstArgumentNames) &&
        receiverChain.length !== receiverChainFirstArgumentNames.length) ||
      (Array.isArray(receiverChain) &&
        Array.isArray(receiverChainPositionalArgumentNames) &&
        receiverChain.length !== receiverChainPositionalArgumentNames.length) ||
      (Array.isArray(receiverChain) &&
        Array.isArray(receiverChainPositionalStaticBooleans) &&
        receiverChain.length !== receiverChainPositionalStaticBooleans.length) ||
      (Array.isArray(receiverChain) &&
        Array.isArray(receiverChainKeywordArguments) &&
        receiverChain.length !== receiverChainKeywordArguments.length) ||
      (Array.isArray(receiverChainPositionalArgumentNames) &&
        Array.isArray(receiverChainPositionalStaticBooleans) &&
        receiverChainPositionalArgumentNames.some(
          (step, index) => step.length !== receiverChainPositionalStaticBooleans[index]?.length
        )) ||
      (record.receiverValueNames !== undefined && !receiverValueNames) ||
      positionalArgumentNames === false ||
      positionalStaticBooleans === false ||
      (Array.isArray(positionalArgumentNames) &&
        Array.isArray(positionalStaticBooleans) &&
        positionalArgumentNames.length !== positionalStaticBooleans.length) ||
      (record.resultNames !== undefined && !resultNames) ||
      resultPaths === false ||
      keywordArguments === false
    ) {
      return undefined
    }
    calls.push({
      receiver: record.receiver,
      member: record.member,
      ...(record.conditional === true ? { conditional: true } : {}),
      kind:
        record.kind === 'generic' || record.kind === 'mutating' || record.kind === 'callable'
          ? record.kind
          : 'receiver',
      argumentNames: argumentNames ?? [],
      receiverChain: receiverChain ?? [],
      receiverChainFirstArgumentNames: receiverChainFirstArgumentNames || [],
      receiverChainPositionalArgumentNames: receiverChainPositionalArgumentNames || [],
      ...(receiverChainPositionalStaticShapes ? { receiverChainPositionalStaticShapes } : {}),
      receiverChainPositionalStaticBooleans: receiverChainPositionalStaticBooleans || [],
      receiverChainKeywordArguments: receiverChainKeywordArguments || [],
      receiverValueNames: receiverValueNames ?? [],
      positionalArgumentNames: positionalArgumentNames || [],
      ...(positionalStaticShapes ? { positionalStaticShapes } : {}),
      positionalStaticBooleans: positionalStaticBooleans || [],
      resultNames: resultNames ?? [],
      ...(resultPaths ? { resultPaths } : {}),
      keywordArguments: keywordArguments || []
    })
  }
  return calls
}

const rGraphicsState = (value: unknown): NotebookRunDependencyFacts['rGraphicsState'] => {
  if (
    !value ||
    typeof value !== 'object' ||
    !('readsPrior' in value) ||
    !('resets' in value) ||
    typeof value.readsPrior !== 'boolean' ||
    typeof value.resets !== 'boolean'
  )
    return undefined
  return { readsPrior: value.readsPrior, resets: value.resets }
}

const plottingState = (value: unknown): NotebookRunDependencyFacts['pythonPlottingState'] => {
  if (
    !value ||
    typeof value !== 'object' ||
    !('reads' in value) ||
    !('writes' in value) ||
    typeof value.reads !== 'boolean' ||
    typeof value.writes !== 'boolean'
  )
    return undefined
  return { reads: value.reads, writes: value.writes }
}

const normalizeFacts = (value: unknown): NotebookRunDependencyFacts => {
  if (!value || typeof value !== 'object') return unknownFacts('invalid-parser-result')
  const record = value as Record<string, unknown>
  if (
    record.pythonRandomStateReads !== undefined &&
    typeof record.pythonRandomStateReads !== 'boolean'
  )
    return unknownFacts('invalid-parser-result')
  const plotting = plottingState(record.pythonPlottingState)
  if (record.pythonPlottingState !== undefined && !plotting)
    return unknownFacts('invalid-parser-result')
  const theme = plottingState(record.rThemeState)
  const optionWrites = stringArray(record.rOptionWrites ?? [])
  if (!optionWrites) return unknownFacts('invalid-parser-result')
  if (record.rThemeState !== undefined && !theme) return unknownFacts('invalid-parser-result')
  const graphics = rGraphicsState(record.rGraphicsState)
  if (record.rGraphicsState !== undefined && !graphics) return unknownFacts('invalid-parser-result')
  if (record.state === 'unknown') {
    const reasons = stringArray(record.reasons)
    const typeSummaries = typeSummaryArray(record.typeSummaries ?? [])
    const typeBindings = typeBindingArray(record.typeBindings ?? [])
    const receiverCalls = receiverCallArray(record.receiverCalls ?? [])
    const memberWrites = memberWriteArray(record.memberWrites ?? [])
    const copyOnModifyNames = stringArray(record.copyOnModifyNames ?? [])
    const rAtomicValueNames = stringArray(record.rAtomicValueNames ?? [])
    const serializedValueWrites = serializedValueDescriptors(record.serializedValueWrites ?? [])
    const serializedValueReads = stringArray(record.serializedValueReads ?? [])
    const rPackageLoads = stringArray(record.rPackageLoads ?? [])
    const rPackageReads = stringArray(record.rPackageReads ?? [])
    const copyOnModifyBindings = copyBindingArray(record.copyOnModifyBindings ?? [])
    const priorUsedNames = stringArray(record.priorUsedNames ?? record.usedNames ?? [])
    const possiblyUsedNames = stringArray(record.possiblyUsedNames ?? [])
    const copyOnModifyInvalidatedNames = stringArray(record.copyOnModifyInvalidatedNames ?? [])
    if (
      !reasons?.length ||
      !typeSummaries ||
      !typeBindings ||
      !receiverCalls ||
      !memberWrites ||
      !copyOnModifyNames ||
      !rAtomicValueNames ||
      !serializedValueWrites ||
      !serializedValueReads ||
      !rPackageLoads ||
      !rPackageReads ||
      !copyOnModifyBindings ||
      !priorUsedNames ||
      !possiblyUsedNames ||
      !copyOnModifyInvalidatedNames
    ) {
      return unknownFacts('analysis-unknown')
    }
    return {
      state: 'unknown',
      reasons,
      ...(stringArray(record.definedNames)
        ? { definedNames: stringArray(record.definedNames) }
        : {}),
      ...(stringArray(record.conditionallyDefinedNames)
        ? { conditionallyDefinedNames: stringArray(record.conditionallyDefinedNames) }
        : {}),
      ...(stringArray(record.usedNames) ? { usedNames: stringArray(record.usedNames) } : {}),
      priorUsedNames,
      possiblyUsedNames,
      ...(stringArray(record.mutatedNames)
        ? { mutatedNames: stringArray(record.mutatedNames) }
        : {}),
      ...(stringArray(record.possiblyMutatedNames)
        ? { possiblyMutatedNames: stringArray(record.possiblyMutatedNames) }
        : {}),
      ...(aliasArray(record.aliases) ? { aliases: aliasArray(record.aliases) } : {}),
      ...(stringArray(record.builtinContainerNames)
        ? { builtinContainerNames: stringArray(record.builtinContainerNames) }
        : {}),
      copyOnModifyNames,
      ...(rAtomicValueNames.length ? { rAtomicValueNames } : {}),
      ...(serializedValueWrites.length ? { serializedValueWrites } : {}),
      ...(serializedValueReads.length ? { serializedValueReads } : {}),
      ...(rPackageLoads.length ? { rPackageLoads } : {}),
      ...(rPackageReads.length ? { rPackageReads } : {}),
      ...(graphics ? { rGraphicsState: graphics } : {}),
      ...(theme ? { rThemeState: theme } : {}),
      ...(optionWrites.length ? { rOptionWrites: optionWrites } : {}),
      ...(plotting ? { pythonPlottingState: plotting } : {}),
      ...(record.pythonRandomStateReads === true ? { pythonRandomStateReads: true } : {}),
      copyOnModifyBindings,
      copyOnModifyInvalidatedNames,
      ...(stringArray(record.safeCallNames)
        ? { safeCallNames: stringArray(record.safeCallNames) }
        : {}),
      ...(stringArray(record.safeCallArgumentNames)
        ? { safeCallArgumentNames: stringArray(record.safeCallArgumentNames) }
        : {}),
      typeSummaries,
      typeBindings,
      receiverCalls,
      memberWrites
    }
  }
  if (record.state !== 'available') return unknownFacts('invalid-parser-result')
  const definedNames = stringArray(record.definedNames)
  const conditionallyDefinedNames = stringArray(record.conditionallyDefinedNames ?? [])
  const usedNames = stringArray(record.usedNames)
  const priorUsedNames = stringArray(record.priorUsedNames ?? record.usedNames)
  const possiblyUsedNames = stringArray(record.possiblyUsedNames ?? [])
  const mutatedNames = stringArray(record.mutatedNames)
  const possiblyMutatedNames = stringArray(record.possiblyMutatedNames ?? [])
  const aliases = aliasArray(record.aliases ?? [])
  const builtinContainerNames = stringArray(record.builtinContainerNames ?? [])
  const copyOnModifyNames = stringArray(record.copyOnModifyNames ?? [])
  const rAtomicValueNames = stringArray(record.rAtomicValueNames ?? [])
  const serializedValueWrites = serializedValueDescriptors(record.serializedValueWrites ?? [])
  const serializedValueReads = stringArray(record.serializedValueReads ?? [])
  const rPackageLoads = stringArray(record.rPackageLoads ?? [])
  const rPackageReads = stringArray(record.rPackageReads ?? [])
  const copyOnModifyBindings = copyBindingArray(record.copyOnModifyBindings ?? [])
  const copyOnModifyInvalidatedNames = stringArray(record.copyOnModifyInvalidatedNames ?? [])
  const safeCallNames = stringArray(record.safeCallNames ?? [])
  const safeCallArgumentNames = stringArray(record.safeCallArgumentNames ?? [])
  const typeSummaries = typeSummaryArray(record.typeSummaries ?? [])
  const typeBindings = typeBindingArray(record.typeBindings ?? [])
  const receiverCalls = receiverCallArray(record.receiverCalls ?? [])
  const memberWrites = memberWriteArray(record.memberWrites ?? [])
  return definedNames &&
    conditionallyDefinedNames &&
    usedNames &&
    priorUsedNames &&
    possiblyUsedNames &&
    mutatedNames &&
    possiblyMutatedNames &&
    aliases &&
    safeCallNames &&
    safeCallArgumentNames &&
    builtinContainerNames &&
    copyOnModifyNames &&
    rAtomicValueNames &&
    serializedValueWrites &&
    serializedValueReads &&
    rPackageLoads &&
    rPackageReads &&
    copyOnModifyBindings &&
    copyOnModifyInvalidatedNames &&
    typeSummaries &&
    typeBindings &&
    receiverCalls &&
    memberWrites
    ? {
        state: 'available',
        definedNames,
        ...(conditionallyDefinedNames.length ? { conditionallyDefinedNames } : {}),
        usedNames,
        priorUsedNames,
        possiblyUsedNames,
        mutatedNames,
        ...(possiblyMutatedNames?.length ? { possiblyMutatedNames } : {}),
        ...(aliases?.length ? { aliases } : {}),
        ...(builtinContainerNames?.length ? { builtinContainerNames } : {}),
        copyOnModifyNames,
        ...(rAtomicValueNames.length ? { rAtomicValueNames } : {}),
        ...(serializedValueWrites.length ? { serializedValueWrites } : {}),
        ...(serializedValueReads.length ? { serializedValueReads } : {}),
        ...(rPackageLoads.length ? { rPackageLoads } : {}),
        ...(rPackageReads.length ? { rPackageReads } : {}),
        ...(graphics ? { rGraphicsState: graphics } : {}),
        ...(theme ? { rThemeState: theme } : {}),
        ...(optionWrites.length ? { rOptionWrites: optionWrites } : {}),
        ...(plotting ? { pythonPlottingState: plotting } : {}),
        ...(record.pythonRandomStateReads === true ? { pythonRandomStateReads: true } : {}),
        copyOnModifyBindings,
        copyOnModifyInvalidatedNames,
        ...(safeCallNames?.length ? { safeCallNames } : {}),
        ...(safeCallArgumentNames?.length ? { safeCallArgumentNames } : {}),
        typeSummaries,
        typeBindings,
        receiverCalls,
        memberWrites
      }
    : unknownFacts('invalid-parser-result')
}

const boundedFileContext = (
  context: NotebookSourceFileAccessContext,
  facts: NotebookRunDependencyFacts
): NotebookSourceFileAccessContext => {
  const definedNames = new Set(facts.definedNames ?? [])
  const conditionalNames = new Set(facts.conditionallyDefinedNames ?? [])
  const staticStrings = context.staticStrings.filter(
    ({ name, value }) =>
      definedNames.has(name) &&
      !conditionalNames.has(name) &&
      value.length <= MAX_STATIC_STRING_LENGTH
  )
  const localFileWrappers = context.localFileWrappers.filter(
    ({ name }) => definedNames.has(name) && !conditionalNames.has(name)
  )
  const staticCollections: NotebookSourceFileAccessContext['staticCollections'] = []
  let staticCollectionValueCount = 0
  for (const collection of context.staticCollections) {
    if (
      !definedNames.has(collection.name) ||
      conditionalNames.has(collection.name) ||
      !collection.values.length ||
      collection.values.length > MAX_STATIC_COLLECTION_VALUES ||
      collection.values.some((value) => value.length > MAX_STATIC_STRING_LENGTH) ||
      (collection.entries &&
        (collection.entries.length !== collection.values.length ||
          collection.entries.some(
            (entry, index) =>
              entry.key.length > MAX_STATIC_STRING_LENGTH ||
              entry.value !== collection.values[index]
          ))) ||
      staticCollectionValueCount + collection.values.length >
        MAX_STATIC_COLLECTION_VALUES_PER_CONTEXT
    ) {
      continue
    }
    staticCollectionValueCount += collection.values.length
    staticCollections.push(collection)
  }
  const staticNames = new Set(staticStrings.map(({ name }) => name))
  const collectionNames = new Set(staticCollections.map(({ name }) => name))
  const wrapperNames = new Set(localFileWrappers.map(({ name }) => name))
  const pythonBindings = (context.pythonBindings ?? [])
    .filter(
      ({ name, qualifiedName, filePath }) =>
        (definedNames.has(name) || (qualifiedName === 'pandas.ExcelFile' && Boolean(filePath))) &&
        !conditionalNames.has(name) &&
        !staticNames.has(name) &&
        !collectionNames.has(name) &&
        !wrapperNames.has(name) &&
        name.length <= MAX_STATIC_STRING_LENGTH &&
        qualifiedName.length <= MAX_STATIC_STRING_LENGTH &&
        (!filePath || filePath.length <= MAX_STATIC_STRING_LENGTH)
    )
    .slice(0, MAX_NAMES_PER_RUN)
  const namespaces = context.pythonTaintedNamespaces ?? []
  const pythonTaintedNamespaces =
    namespaces.length > MAX_NAMES_PER_RUN ||
    namespaces.some((name) => name.length > MAX_STATIC_STRING_LENGTH)
      ? ['*']
      : namespaces
  return {
    ...(pythonTaintedNamespaces.length ? { pythonTaintedNamespaces } : {}),
    ...(pythonBindings.length ? { pythonBindings } : {}),
    staticStrings: staticStrings
      .filter(({ name }) => !wrapperNames.has(name))
      .slice(0, MAX_NAMES_PER_RUN),
    staticCollections: staticCollections
      .filter(({ name }) => !staticNames.has(name) && !wrapperNames.has(name))
      .slice(0, MAX_NAMES_PER_RUN),
    localFileWrappers: localFileWrappers
      .filter(({ name }) => !staticNames.has(name) && !collectionNames.has(name))
      .slice(0, MAX_NAMES_PER_RUN)
  }
}

const checksumFor = (run: NotebookRunRecord): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        ANALYZER_VERSION,
        ANALYZER_REVISION,
        run.kernelKind,
        run.environment,
        run.kernelEpochId,
        run.runtimeId,
        run.script,
        run.fileEvidence?.checksum
      ])
    )
    .digest('hex')

const emptySidecar = (): NotebookDependencyAnalysisSidecar => ({
  version: 1,
  analyzerVersion: ANALYZER_VERSION,
  analyzerRevision: ANALYZER_REVISION,
  runs: {},
  projectionSnapshots: {}
})

const cachedAnalysisIsReusable = (
  cached: NotebookDependencyAnalysisSidecar['runs'][string] | undefined,
  checksum: string
): boolean =>
  cached?.checksum === checksum &&
  !(
    cached.facts.state === 'unknown' &&
    cached.facts.reasons.some((reason) => RETRYABLE_ANALYSIS_FAILURES.has(reason))
  )

const isSourceFileAccessContextRun = (
  run: NotebookRunRecord,
  request: Pick<
    NotebookSourceFileAccessContextRequest,
    'language' | 'environment' | 'kernelEpochId'
  >
): boolean =>
  run.kernelKind === request.language &&
  (run.environment ?? '') === (request.environment ?? '') &&
  run.kernelEpochId === request.kernelEpochId

const sourceFileAccessContextNeedsRefresh = (
  runs: readonly NotebookRunRecord[],
  sidecar: NotebookDependencyAnalysisSidecar,
  request: Pick<
    NotebookSourceFileAccessContextRequest,
    'currentRunId' | 'language' | 'environment' | 'kernelEpochId'
  >
): boolean => {
  for (const run of runs) {
    if (run.runId === request.currentRunId) break
    if (
      !isSourceFileAccessContextRun(run, request) &&
      // Serialized file evidence can originate in another kernel epoch.
      !(
        ['r', 'python'].includes(request.language) &&
        ['r', 'python'].includes(run.kernelKind) &&
        run.fileEvidence?.state === 'available'
      )
    )
      continue
    if (run.status !== 'completed' && run.kernelDispatched === false) continue
    if (
      !cachedAnalysisIsReusable(sidecar.runs[run.runId], checksumFor(run)) ||
      sidecar.runs[run.runId]?.facts.serializedValueReads?.length
    )
      return true
  }
  return false
}

const projectSourceFileAccessContext = (
  runs: readonly NotebookRunRecord[],
  sidecar: NotebookDependencyAnalysisSidecar,
  request: Pick<
    NotebookSourceFileAccessContextRequest,
    'currentRunId' | 'language' | 'environment' | 'kernelEpochId'
  >
): NotebookSourceFileAccessContext | undefined => {
  const entries: Array<FileContextEntry | undefined> = []
  for (const run of runs) {
    if (run.runId === request.currentRunId) break
    if (!isSourceFileAccessContextRun(run, request)) continue
    if (run.status !== 'completed' && run.kernelDispatched === false) continue
    const cached = sidecar.runs[run.runId]
    const fileContext = cachedAnalysisIsReusable(cached, checksumFor(run))
      ? cached?.fileContext
      : undefined
    entries.push(
      fileContext && cached
        ? {
            // Code before an exception may already have modified a module. The
            // projection keeps only tainted identities at this unsafe boundary.
            facts: run.status === 'completed' ? cached.facts : unknownFacts('execution-incomplete'),
            fileContext
          }
        : undefined
    )
  }
  return projectNotebookFileContext(request.language, entries)
}

const externalInterpreterKey = (run: NotebookRunRecord): string =>
  `${run.kernelKind}\0${run.runtimeId ?? ''}`

const projectionChecksumFor = ({ run, facts }: AnalyzedNotebookRun): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        ANALYZER_REVISION,
        run.runId,
        run.kernelKind,
        run.environment,
        run.kernelEpochId,
        run.status,
        run.kernelDispatched,
        run.environmentManifest?.executionContext?.rPackages,
        facts
      ])
    )
    .digest('hex')

const projectionGroupChecksum = (checksums: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify(checksums)).digest('hex')

const projectionGroupKey = ({ run }: AnalyzedNotebookRun): string =>
  run.kernelEpochId && (run.kernelKind === 'python' || run.kernelKind === 'r')
    ? JSON.stringify([run.kernelKind, run.environment ?? '', run.kernelEpochId])
    : JSON.stringify(['run', run.runId])

const projectionRuntimeKey = ({ run }: AnalyzedNotebookRun): string | undefined =>
  run.kernelEpochId && (run.kernelKind === 'python' || run.kernelKind === 'r')
    ? JSON.stringify([run.kernelKind, run.environment ?? ''])
    : undefined

type IncrementalProjectionGroup = {
  checksums: string[]
  projection: NotebookDependencyProjection
  projector?: NotebookDependencyProjector
}

class NotebookDependencyAnalyzer {
  private readonly sessionQueues = new Map<string, Promise<void>>()
  private readonly incrementalProjections = new Map<
    string,
    Map<string, IncrementalProjectionGroup>
  >()

  constructor(
    private readonly options: {
      storageRoot: string
      repository: Pick<NotebookRunRepository, 'readSessionRuns'>
      analyze?: AnalyzeNotebookScripts
      resolveInterpreter?: (
        run: NotebookRunRecord
      ) => Promise<NotebookDependencyInterpreter | undefined>
    }
  ) {}

  project(request: ProjectNotebookDependenciesRequest): Promise<NotebookDependencyProjection> {
    return this.enqueueSessionOperation(request.projectId, request.sessionId, () =>
      this.projectExclusive(request)
    )
  }

  finalizeEpochs(request: {
    projectId: string
    sessionId: string
    kernelEpochIds: readonly string[]
  }): Promise<void> {
    if (request.kernelEpochIds.length === 0) return Promise.resolve()
    return this.enqueueSessionOperation(request.projectId, request.sessionId, async () => {
      await this.projectExclusive(
        { projectId: request.projectId, sessionId: request.sessionId },
        undefined,
        undefined,
        new Set(request.kernelEpochIds)
      )
    })
  }

  sourceFileAccessContext(
    request: NotebookSourceFileAccessContextRequest
  ): Promise<NotebookSourceFileAccessContext | undefined> {
    return this.enqueueSessionOperation(request.projectId, request.sessionId, () =>
      this.sourceFileAccessContextExclusive(request)
    )
  }

  private enqueueSessionOperation<T>(
    projectId: string,
    sessionId: string,
    execute: () => Promise<T>
  ): Promise<T> {
    const key = JSON.stringify([projectId, sessionId])
    const operation = (this.sessionQueues.get(key) ?? Promise.resolve()).then(execute)
    const tail = operation.then(
      () => undefined,
      () => undefined
    )
    this.sessionQueues.set(key, tail)
    void tail.then(() => {
      if (this.sessionQueues.get(key) === tail) this.sessionQueues.delete(key)
    })
    return operation
  }

  private projectIncrementally(
    projectId: string,
    sessionId: string,
    analyzedRuns: readonly AnalyzedNotebookRun[],
    sidecar: NotebookDependencyAnalysisSidecar,
    completeHistory: boolean,
    explicitlyClosedEpochIds: ReadonlySet<string>
  ): { projection: NotebookDependencyProjection; sidecarChanged: boolean } {
    const sessionKey = JSON.stringify([projectId, sessionId])
    const cachedGroups =
      this.incrementalProjections.get(sessionKey) ?? new Map<string, IncrementalProjectionGroup>()
    const groups = new Map<string, AnalyzedNotebookRun[]>()
    const latestGroupByRuntime = new Map<string, string>()
    const observedNames = new Set<string>()
    const bindingsByGroup = new Map<string, Set<string>>()
    for (const analyzedRun of analyzedRuns) {
      const groupKey = projectionGroupKey(analyzedRun)
      const group = groups.get(groupKey) ?? []
      const bindings = bindingsByGroup.get(groupKey) ?? new Set<string>()
      const { facts, run } = analyzedRun
      // Validate memory provenance before splitting projections by kernel. File
      // generations bridge kernels; a same-named variable from another one cannot.
      const missing =
        run.status === 'completed'
          ? (facts.priorUsedNames ?? facts.usedNames ?? []).filter(
              (name) =>
                observedNames.has(name) &&
                !bindings.has(name) &&
                !facts.safeCallNames?.includes(name)
            )
          : []
      group.push(
        missing.length
          ? {
              ...analyzedRun,
              facts: {
                ...facts,
                state: 'unknown',
                reasons: [
                  ...(facts.state === 'unknown' ? facts.reasons : []),
                  ...missing.map((name) => `kernel-binding-unavailable:${name}`)
                ]
              }
            }
          : analyzedRun
      )
      if (run.status === 'completed')
        for (const name of facts.definedNames ?? []) {
          if (facts.conditionallyDefinedNames?.includes(name)) continue
          bindings.add(name)
          observedNames.add(name)
        }
      bindingsByGroup.set(groupKey, bindings)
      groups.set(groupKey, group)
      const runtimeKey = projectionRuntimeKey(analyzedRun)
      if (runtimeKey) latestGroupByRuntime.set(runtimeKey, groupKey)
    }

    const projection: NotebookDependencyProjection = {
      stalenessByRunId: {},
      invalidatedByRunId: {},
      dependenciesByRunId: {}
    }
    const closedGroups = new Set<string>()
    let sidecarChanged = false
    for (const [groupKey, group] of groups) {
      const checksums = group.map(projectionChecksumFor)
      const groupChecksum = projectionGroupChecksum(checksums)
      const persisted = sidecar.projectionSnapshots[groupKey]
      const cached =
        cachedGroups.get(groupKey) ??
        (persisted?.checksum === groupChecksum
          ? { checksums, projection: persisted.projection }
          : undefined)
      const exactMatch =
        cached?.checksums.length === checksums.length &&
        cached.checksums.every((checksum, index) => checksum === checksums[index])
      const reusablePrefix =
        cached?.projector !== undefined &&
        cached.checksums.length <= checksums.length &&
        cached.checksums.every((checksum, index) => checksum === checksums[index])
      let projector = reusablePrefix ? cached.projector : undefined
      if (!exactMatch) {
        projector ??= new NotebookDependencyProjector()
        const appendFrom = reusablePrefix ? cached.checksums.length : 0
        for (const analyzedRun of group.slice(appendFrom)) projector.append(analyzedRun)
      }
      const groupProjection = exactMatch ? cached.projection : projector!.projection()
      const runtimeKey = projectionRuntimeKey(group[0]!)
      const epochId = group[0]!.run.kernelEpochId
      const closed =
        persisted !== undefined ||
        (epochId !== undefined && explicitlyClosedEpochIds.has(epochId)) ||
        (runtimeKey !== undefined && latestGroupByRuntime.get(runtimeKey) !== groupKey)
      if (closed) {
        closedGroups.add(groupKey)
        if (persisted?.checksum !== groupChecksum) {
          sidecar.projectionSnapshots[groupKey] = {
            checksum: groupChecksum,
            projection: groupProjection
          }
          sidecarChanged = true
        }
      }
      cachedGroups.set(groupKey, {
        checksums,
        projection: groupProjection,
        ...(!closed && projector ? { projector } : {})
      })
      Object.assign(projection.stalenessByRunId, groupProjection.stalenessByRunId)
      Object.assign(projection.invalidatedByRunId, groupProjection.invalidatedByRunId)
      Object.assign(projection.dependenciesByRunId!, groupProjection.dependenciesByRunId)
    }
    for (const groupKey of cachedGroups.keys()) {
      if (!groups.has(groupKey)) cachedGroups.delete(groupKey)
    }
    if (completeHistory) {
      for (const groupKey of Object.keys(sidecar.projectionSnapshots)) {
        if (closedGroups.has(groupKey)) continue
        delete sidecar.projectionSnapshots[groupKey]
        sidecarChanged = true
      }
    }

    this.incrementalProjections.delete(sessionKey)
    this.incrementalProjections.set(sessionKey, cachedGroups)
    if (this.incrementalProjections.size > MAX_INCREMENTAL_PROJECTIONS) {
      this.incrementalProjections.delete(this.incrementalProjections.keys().next().value!)
    }
    return { projection, sidecarChanged }
  }

  private async sourceFileAccessContextExclusive(
    request: NotebookSourceFileAccessContextRequest
  ): Promise<NotebookSourceFileAccessContext | undefined> {
    const [runs, initialSidecar] = await Promise.all([
      this.options.repository.readSessionRuns(request.projectId, request.sessionId),
      this.readSidecar(this.sidecarPath(request.projectId, request.sessionId))
    ])
    const sidecar = initialSidecar
    if (sourceFileAccessContextNeedsRefresh(runs, sidecar, request)) {
      await this.projectExclusive(
        { projectId: request.projectId, sessionId: request.sessionId },
        request.currentRunId,
        { runs, sidecar }
      )
    }
    const context = projectSourceFileAccessContext(runs, sidecar, request)
    return ['r', 'python'].includes(request.language)
      ? serializedFileContext(
          this.options.storageRoot,
          runs,
          (run) =>
            cachedAnalysisIsReusable(sidecar.runs[run.runId], checksumFor(run))
              ? sidecar.runs[run.runId]?.facts
              : undefined,
          request.currentRunId,
          context
        )
      : context
  }

  private async projectExclusive(
    request: ProjectNotebookDependenciesRequest,
    analyzeBeforeRunId?: string,
    prepared?: {
      runs: readonly NotebookRunRecord[]
      sidecar: NotebookDependencyAnalysisSidecar
    },
    explicitlyClosedEpochIds: ReadonlySet<string> = new Set()
  ): Promise<NotebookDependencyProjection> {
    const runs =
      prepared?.runs ??
      (await this.options.repository.readSessionRuns(request.projectId, request.sessionId))
    const boundaryRunId = analyzeBeforeRunId ?? request.throughRunId
    const boundaryIndex = boundaryRunId ? runs.findIndex((run) => run.runId === boundaryRunId) : -1
    const runsToAnalyze =
      boundaryIndex >= 0 ? runs.slice(0, boundaryIndex + (analyzeBeforeRunId ? 0 : 1)) : runs
    const sidecarPath = this.sidecarPath(request.projectId, request.sessionId)
    const sidecar = prepared?.sidecar ?? (await this.readSidecar(sidecarPath))
    let changed = false
    const attemptedRunIds = new Set<string>()

    const exactRun = request.completedRun
    if (
      exactRun &&
      request.interpreter &&
      (exactRun.kernelKind === 'python' || exactRun.kernelKind === 'r')
    ) {
      const analysisRuns = runsToAnalyze.some((run) => run.runId === exactRun.runId)
        ? runsToAnalyze
        : [...runsToAnalyze, exactRun]
      const exactGroup: NotebookRunRecord[] = []
      for (const run of analysisRuns) {
        if (
          run.kernelKind === exactRun.kernelKind &&
          (run.environment ?? '') === (exactRun.environment ?? '') &&
          run.kernelEpochId === exactRun.kernelEpochId &&
          (run.runtimeId ?? '') === (exactRun.runtimeId ?? '')
        ) {
          exactGroup.push(run)
        }
        if (run.runId === exactRun.runId) break
      }
      changed =
        (await this.analyzeGroup(sidecar, exactGroup, request.interpreter, analysisRuns)) || changed
      for (const run of exactGroup) attemptedRunIds.add(run.runId)
    }

    const missingByInterpreter = new Map<
      string,
      { interpreter?: NotebookDependencyInterpreter; runs: NotebookRunRecord[] }
    >()
    const resolvedExternalInterpreters = new Map<
      string,
      NotebookDependencyInterpreter | undefined
    >()
    for (const run of runsToAnalyze) {
      if (run.kernelKind !== 'python' && run.kernelKind !== 'r') continue
      const checksum = checksumFor(run)
      if (
        attemptedRunIds.has(run.runId) ||
        (cachedAnalysisIsReusable(sidecar.runs[run.runId], checksum) &&
          !sidecar.runs[run.runId]?.facts.serializedValueReads?.length)
      ) {
        continue
      }
      if (!this.options.analyze) {
        const key = `in-process:${run.kernelKind}`
        const group = missingByInterpreter.get(key) ?? { runs: [] }
        group.runs.push(run)
        missingByInterpreter.set(key, group)
        continue
      }
      const interpreter = run.runtimeId
        ? await this.resolveExternalInterpreter(run, resolvedExternalInterpreters)
        : this.managedInterpreter(run)
      if (!interpreter) {
        sidecar.runs[run.runId] = { checksum, facts: unknownFacts('parser-unavailable') }
        changed = true
        continue
      }
      const key = JSON.stringify([
        run.kernelKind,
        interpreter.command,
        interpreter.args ?? [],
        interpreter.condaPrefix ?? ''
      ])
      const group = missingByInterpreter.get(key) ?? { interpreter, runs: [] }
      group.runs.push(run)
      missingByInterpreter.set(key, group)
    }
    for (const { interpreter, runs: groupRuns } of missingByInterpreter.values()) {
      changed = (await this.analyzeGroup(sidecar, groupRuns, interpreter, runs)) || changed
    }
    const incremental = this.projectIncrementally(
      request.projectId,
      request.sessionId,
      runsToAnalyze.map((run) => ({
        run,
        facts:
          sidecar.runs[run.runId]?.facts ??
          unknownFacts(run.kernelEpochId ? 'analysis-unavailable' : 'kernel-epoch-unavailable')
      })),
      sidecar,
      boundaryRunId === undefined,
      explicitlyClosedEpochIds
    )
    if (changed || incremental.sidecarChanged) {
      await this.writeSidecar(sidecarPath, sidecar).catch(() => undefined)
    }
    return incremental.projection
  }

  private async analyzeGroup(
    sidecar: NotebookDependencyAnalysisSidecar,
    runs: readonly NotebookRunRecord[],
    interpreter?: NotebookDependencyInterpreter,
    sessionRuns: readonly NotebookRunRecord[] = runs
  ): Promise<boolean> {
    const pending = runs.filter(
      (run) =>
        !cachedAnalysisIsReusable(sidecar.runs[run.runId], checksumFor(run)) ||
        Boolean(sidecar.runs[run.runId]?.facts.serializedValueReads?.length)
    )
    if (pending.length === 0) return false
    const language = pending[0]?.kernelKind
    if (language !== 'python' && language !== 'r') return false
    const externalFacts =
      this.options.analyze && interpreter
        ? await this.options.analyze(
            interpreter,
            language,
            pending.map((run) => run.script)
          )
        : undefined
    for (const [index, run] of pending.entries()) {
      let priorContext = run.kernelEpochId
        ? projectSourceFileAccessContext(sessionRuns, sidecar, {
            currentRunId: run.runId,
            language,
            environment: run.environment,
            kernelEpochId: run.kernelEpochId
          })
        : undefined
      if (language === 'r' || language === 'python')
        priorContext = await serializedFileContext(
          this.options.storageRoot,
          sessionRuns,
          (previous) =>
            cachedAnalysisIsReusable(sidecar.runs[previous.runId], checksumFor(previous))
              ? sidecar.runs[previous.runId]?.facts
              : undefined,
          run.runId,
          priorContext
        )
      const analysis = externalFacts
        ? {
            facts: externalFacts[index] ?? unknownFacts('analysis-unavailable'),
            fileAccess: (language === 'python'
              ? await analyzePythonFileAccesses([run.script], priorContext)
              : await analyzeRFileAccesses([run.script], priorContext))[0]
          }
        : await (language === 'python' ? analyzePythonNotebookSource : analyzeRNotebookSource)(
            run.script,
            priorContext
          )
      const normalizedFacts = normalizeFacts(analysis.facts)
      const fileAccess = analysis.fileAccess
      const fileContext = fileAccess?.context
      sidecar.runs[run.runId] = {
        checksum: checksumFor(run),
        facts: normalizedFacts,
        ...(fileContext ? { fileContext: boundedFileContext(fileContext, normalizedFacts) } : {})
      }
    }
    return true
  }

  private async resolveExternalInterpreter(
    run: NotebookRunRecord,
    resolved: Map<string, NotebookDependencyInterpreter | undefined>
  ): Promise<NotebookDependencyInterpreter | undefined> {
    const key = externalInterpreterKey(run)
    if (resolved.has(key)) return resolved.get(key)
    const interpreter = await this.options.resolveInterpreter?.(run)
    resolved.set(key, interpreter)
    return interpreter
  }

  private managedInterpreter(run: NotebookRunRecord): NotebookDependencyInterpreter | undefined {
    const language = run.kernelKind === 'r' ? 'r' : 'python'
    let environment
    try {
      environment = resolveEnvName(language, run.environment)
    } catch {
      return undefined
    }
    const prefix = envPrefix(getRuntimeRoot(this.options.storageRoot), environment)
    return { command: language === 'r' ? rScriptBin(prefix) : pythonBin(prefix) }
  }

  private sidecarPath(projectId: string, sessionId: string): string {
    return join(
      getNotebookSessionRoot(this.options.storageRoot, projectId, sessionId),
      'cache',
      SIDECAR_FILE
    )
  }

  private async readSidecar(path: string): Promise<NotebookDependencyAnalysisSidecar> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return emptySidecar()
      const candidate = parsed as Partial<NotebookDependencyAnalysisSidecar>
      // An older app may inspect a newer cache, but must not overwrite its format.
      if (Number(candidate.version) > 1 || Number(candidate.analyzerVersion) > ANALYZER_VERSION)
        return { ...emptySidecar(), readOnly: true }
      if (
        candidate.version !== 1 ||
        candidate.analyzerVersion !== ANALYZER_VERSION ||
        !candidate.runs ||
        typeof candidate.runs !== 'object' ||
        Array.isArray(candidate.runs) ||
        (candidate.projectionSnapshots !== undefined &&
          (typeof candidate.projectionSnapshots !== 'object' ||
            Array.isArray(candidate.projectionSnapshots)))
      ) {
        return emptySidecar()
      }
      const runs: NotebookDependencyAnalysisSidecar['runs'] = {}
      for (const [runId, value] of Object.entries(candidate.runs)) {
        if (!value || typeof value !== 'object') return emptySidecar()
        const record = value as Record<string, unknown>
        if (typeof record.checksum !== 'string') return emptySidecar()
        const rawFacts = record.facts
        if (!rawFacts || typeof rawFacts !== 'object') return emptySidecar()
        const fileContext =
          record.fileContext === undefined ? undefined : fileContextValue(record.fileContext)
        if (record.fileContext !== undefined && !fileContext) return emptySidecar()
        const factsRecord = rawFacts as Record<string, unknown>
        const validFacts =
          factsRecord.state === 'available'
            ? stringArray(factsRecord.definedNames) !== undefined &&
              (factsRecord.conditionallyDefinedNames === undefined ||
                stringArray(factsRecord.conditionallyDefinedNames) !== undefined) &&
              stringArray(factsRecord.usedNames) !== undefined &&
              stringArray(factsRecord.priorUsedNames) !== undefined &&
              stringArray(factsRecord.possiblyUsedNames) !== undefined &&
              stringArray(factsRecord.mutatedNames) !== undefined &&
              (factsRecord.possiblyMutatedNames === undefined ||
                stringArray(factsRecord.possiblyMutatedNames) !== undefined) &&
              (factsRecord.aliases === undefined ||
                aliasArray(factsRecord.aliases) !== undefined) &&
              (factsRecord.builtinContainerNames === undefined ||
                stringArray(factsRecord.builtinContainerNames) !== undefined) &&
              stringArray(factsRecord.copyOnModifyNames) !== undefined &&
              (factsRecord.rPackageLoads === undefined ||
                stringArray(factsRecord.rPackageLoads) !== undefined) &&
              (factsRecord.pythonRandomStateReads === undefined ||
                typeof factsRecord.pythonRandomStateReads === 'boolean') &&
              (factsRecord.pythonPlottingState === undefined ||
                plottingState(factsRecord.pythonPlottingState) !== undefined) &&
              (factsRecord.rOptionWrites === undefined ||
                stringArray(factsRecord.rOptionWrites) !== undefined) &&
              (factsRecord.rThemeState === undefined ||
                plottingState(factsRecord.rThemeState) !== undefined) &&
              (factsRecord.rGraphicsState === undefined ||
                rGraphicsState(factsRecord.rGraphicsState) !== undefined) &&
              (factsRecord.rPackageReads === undefined ||
                stringArray(factsRecord.rPackageReads) !== undefined) &&
              (factsRecord.rAtomicValueNames === undefined ||
                stringArray(factsRecord.rAtomicValueNames) !== undefined) &&
              copyBindingArray(factsRecord.copyOnModifyBindings) !== undefined &&
              stringArray(factsRecord.copyOnModifyInvalidatedNames) !== undefined &&
              (factsRecord.safeCallNames === undefined ||
                stringArray(factsRecord.safeCallNames) !== undefined) &&
              (factsRecord.safeCallArgumentNames === undefined ||
                stringArray(factsRecord.safeCallArgumentNames) !== undefined) &&
              typeSummaryArray(factsRecord.typeSummaries, true) !== undefined &&
              typeBindingArray(factsRecord.typeBindings, true) !== undefined &&
              receiverCallArray(factsRecord.receiverCalls, true) !== undefined &&
              memberWriteArray(factsRecord.memberWrites, true) !== undefined
            : factsRecord.state === 'unknown' &&
              Boolean(stringArray(factsRecord.reasons)?.length) &&
              (factsRecord.definedNames === undefined ||
                stringArray(factsRecord.definedNames) !== undefined) &&
              (factsRecord.conditionallyDefinedNames === undefined ||
                stringArray(factsRecord.conditionallyDefinedNames) !== undefined) &&
              (factsRecord.usedNames === undefined ||
                stringArray(factsRecord.usedNames) !== undefined) &&
              stringArray(factsRecord.priorUsedNames) !== undefined &&
              stringArray(factsRecord.possiblyUsedNames) !== undefined &&
              (factsRecord.mutatedNames === undefined ||
                stringArray(factsRecord.mutatedNames) !== undefined) &&
              (factsRecord.possiblyMutatedNames === undefined ||
                stringArray(factsRecord.possiblyMutatedNames) !== undefined) &&
              (factsRecord.aliases === undefined ||
                aliasArray(factsRecord.aliases) !== undefined) &&
              (factsRecord.builtinContainerNames === undefined ||
                stringArray(factsRecord.builtinContainerNames) !== undefined) &&
              stringArray(factsRecord.copyOnModifyNames) !== undefined &&
              (factsRecord.rPackageLoads === undefined ||
                stringArray(factsRecord.rPackageLoads) !== undefined) &&
              (factsRecord.pythonRandomStateReads === undefined ||
                typeof factsRecord.pythonRandomStateReads === 'boolean') &&
              (factsRecord.pythonPlottingState === undefined ||
                plottingState(factsRecord.pythonPlottingState) !== undefined) &&
              (factsRecord.rOptionWrites === undefined ||
                stringArray(factsRecord.rOptionWrites) !== undefined) &&
              (factsRecord.rThemeState === undefined ||
                plottingState(factsRecord.rThemeState) !== undefined) &&
              (factsRecord.rGraphicsState === undefined ||
                rGraphicsState(factsRecord.rGraphicsState) !== undefined) &&
              (factsRecord.rPackageReads === undefined ||
                stringArray(factsRecord.rPackageReads) !== undefined) &&
              (factsRecord.rAtomicValueNames === undefined ||
                stringArray(factsRecord.rAtomicValueNames) !== undefined) &&
              copyBindingArray(factsRecord.copyOnModifyBindings) !== undefined &&
              stringArray(factsRecord.copyOnModifyInvalidatedNames) !== undefined &&
              (factsRecord.safeCallNames === undefined ||
                stringArray(factsRecord.safeCallNames) !== undefined) &&
              (factsRecord.safeCallArgumentNames === undefined ||
                stringArray(factsRecord.safeCallArgumentNames) !== undefined) &&
              typeSummaryArray(factsRecord.typeSummaries, true) !== undefined &&
              typeBindingArray(factsRecord.typeBindings, true) !== undefined &&
              receiverCallArray(factsRecord.receiverCalls, true) !== undefined &&
              memberWriteArray(factsRecord.memberWrites, true) !== undefined
        if (!validFacts) return emptySidecar()
        runs[runId] = {
          checksum: record.checksum,
          facts: normalizeFacts(rawFacts),
          ...(fileContext ? { fileContext } : {})
        }
      }
      const projectionSnapshots: NotebookDependencyAnalysisSidecar['projectionSnapshots'] = {}
      for (const [groupKey, value] of Object.entries(candidate.projectionSnapshots ?? {})) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const record = value as Record<string, unknown>
        const projection = projectionValue(record.projection)
        if (typeof record.checksum !== 'string' || !projection) continue
        projectionSnapshots[groupKey] = { checksum: record.checksum, projection }
      }
      return {
        version: 1,
        analyzerVersion: ANALYZER_VERSION,
        analyzerRevision: ANALYZER_REVISION,
        runs,
        projectionSnapshots
      }
    } catch {
      return emptySidecar()
    }
  }

  private async writeSidecar(
    path: string,
    sidecar: NotebookDependencyAnalysisSidecar
  ): Promise<void> {
    if (sidecar.readOnly) return
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, path)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export {
  NotebookDependencyAnalyzer,
  projectNotebookDependencies,
  unavailableNotebookDependencyProjection
}
export type {
  AnalyzedNotebookRun,
  NotebookDependencyProjection,
  NotebookDependencyInterpreter,
  AnalyzeNotebookScripts,
  NotebookRunDependencyFacts
}

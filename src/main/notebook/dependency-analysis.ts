import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { NotebookRunRecord } from '../../shared/notebook'
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
  NotebookRunDependencyFacts,
  ProjectNotebookDependenciesRequest
} from './dependency-analysis-types'
import { analyzePythonSources } from './dependency-analysis-python'
import { analyzeRSources } from './dependency-analysis-r'
import {
  projectNotebookDependencies,
  unavailableNotebookDependencyProjection
} from './dependency-projection'
import { getNotebookSessionRoot, getRuntimeRoot, type NotebookRunRepository } from './repository'
import { envPrefix, pythonBin, resolveEnvName, rScriptBin } from './runtime-paths'

const ANALYZER_VERSION = 1 as const
const ANALYZER_REVISION = 'tree-sitter-in-process-3'
const SIDECAR_FILE = 'dependency-analysis.json'
const MAX_NAMES_PER_RUN = 512
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
          : stringArray(methodRecord.destructuredReturnTypes)
      if (
        !usedNames ||
        !safeCallNames ||
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
      record.receiverChain === undefined ? undefined : stringArray(record.receiverChain)
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
        Array<{ name: string; argumentNames: string[]; staticBoolean: boolean | null }>
      > = []
      for (const step of record.receiverChainKeywordArguments) {
        if (!Array.isArray(step) || step.length > MAX_NAMES_PER_RUN) return false
        const parsed: Array<{
          name: string
          argumentNames: string[]
          staticBoolean: boolean | null
        }> = []
        for (const candidate of step) {
          if (!candidate || typeof candidate !== 'object') return false
          const keyword = candidate as Record<string, unknown>
          const names = stringArray(keyword.argumentNames)
          if (
            typeof keyword.name !== 'string' ||
            !names ||
            (keyword.staticBoolean !== null && typeof keyword.staticBoolean !== 'boolean')
          ) {
            return false
          }
          parsed.push({
            name: keyword.name,
            argumentNames: names,
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
    const resultNames =
      record.resultNames === undefined ? undefined : stringArray(record.resultNames)
    const keywordArguments = (() => {
      if (record.keywordArguments === undefined) return undefined
      if (!Array.isArray(record.keywordArguments)) return false
      const parsed: Array<{
        name: string
        argumentNames: string[]
        possibleArgumentNames: string[]
        staticBoolean: boolean | null
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
      receiverChainPositionalStaticBooleans: receiverChainPositionalStaticBooleans || [],
      receiverChainKeywordArguments: receiverChainKeywordArguments || [],
      receiverValueNames: receiverValueNames ?? [],
      positionalArgumentNames: positionalArgumentNames || [],
      positionalStaticBooleans: positionalStaticBooleans || [],
      resultNames: resultNames ?? [],
      keywordArguments: keywordArguments || []
    })
  }
  return calls
}

const normalizeFacts = (value: unknown): NotebookRunDependencyFacts => {
  if (!value || typeof value !== 'object') return unknownFacts('invalid-parser-result')
  const record = value as Record<string, unknown>
  if (record.state === 'unknown') {
    const reasons = stringArray(record.reasons)
    const typeSummaries = typeSummaryArray(record.typeSummaries ?? [])
    const typeBindings = typeBindingArray(record.typeBindings ?? [])
    const receiverCalls = receiverCallArray(record.receiverCalls ?? [])
    const memberWrites = memberWriteArray(record.memberWrites ?? [])
    const copyOnModifyNames = stringArray(record.copyOnModifyNames ?? [])
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
    builtinContainerNames &&
    copyOnModifyNames &&
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

const analyzeNotebookSources = (
  language: 'python' | 'r',
  sources: readonly string[]
): Promise<NotebookRunDependencyFacts[]> =>
  language === 'python' ? analyzePythonSources(sources) : analyzeRSources(sources)

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
        run.script
      ])
    )
    .digest('hex')

const emptySidecar = (): NotebookDependencyAnalysisSidecar => ({
  version: 1,
  analyzerVersion: ANALYZER_VERSION,
  runs: {}
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

const externalInterpreterKey = (run: NotebookRunRecord): string =>
  `${run.kernelKind}\0${run.runtimeId ?? ''}`

class NotebookDependencyAnalyzer {
  private queue: Promise<void> = Promise.resolve()

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
    const operation = this.queue.then(() => this.projectExclusive(request))
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async projectExclusive(
    request: ProjectNotebookDependenciesRequest
  ): Promise<NotebookDependencyProjection> {
    const runs = await this.options.repository.readSessionRuns(request.projectId, request.sessionId)
    const sidecarPath = this.sidecarPath(request.projectId, request.sessionId)
    const sidecar = await this.readSidecar(sidecarPath)
    let changed = false
    const attemptedRunIds = new Set<string>()

    const exactRun = request.completedRun
    if (
      exactRun &&
      request.interpreter &&
      (exactRun.kernelKind === 'python' || exactRun.kernelKind === 'r')
    ) {
      changed = (await this.analyzeGroup(sidecar, [exactRun], request.interpreter)) || changed
      attemptedRunIds.add(exactRun.runId)
    }

    const missingByInterpreter = new Map<
      string,
      { interpreter?: NotebookDependencyInterpreter; runs: NotebookRunRecord[] }
    >()
    const resolvedExternalInterpreters = new Map<
      string,
      NotebookDependencyInterpreter | undefined
    >()
    for (const run of runs) {
      if (run.kernelKind !== 'python' && run.kernelKind !== 'r') continue
      const checksum = checksumFor(run)
      if (
        attemptedRunIds.has(run.runId) ||
        cachedAnalysisIsReusable(sidecar.runs[run.runId], checksum)
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
      changed = (await this.analyzeGroup(sidecar, groupRuns, interpreter)) || changed
    }
    if (changed) await this.writeSidecar(sidecarPath, sidecar).catch(() => undefined)

    return projectNotebookDependencies(
      runs.map((run) => ({
        run,
        facts:
          sidecar.runs[run.runId]?.facts ??
          unknownFacts(run.kernelEpochId ? 'analysis-unavailable' : 'kernel-epoch-unavailable')
      }))
    )
  }

  private async analyzeGroup(
    sidecar: NotebookDependencyAnalysisSidecar,
    runs: readonly NotebookRunRecord[],
    interpreter?: NotebookDependencyInterpreter
  ): Promise<boolean> {
    const pending = runs.filter(
      (run) => !cachedAnalysisIsReusable(sidecar.runs[run.runId], checksumFor(run))
    )
    if (pending.length === 0) return false
    const language = pending[0]?.kernelKind
    if (language !== 'python' && language !== 'r') return false
    const sources = pending.map((run) => run.script)
    const facts =
      this.options.analyze && interpreter
        ? await this.options.analyze(interpreter, language, sources)
        : await analyzeNotebookSources(language, sources)
    pending.forEach((run, index) => {
      sidecar.runs[run.runId] = {
        checksum: checksumFor(run),
        facts: normalizeFacts(facts[index] ?? unknownFacts('analysis-unavailable'))
      }
    })
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
      if (
        candidate.version !== 1 ||
        candidate.analyzerVersion !== ANALYZER_VERSION ||
        !candidate.runs ||
        typeof candidate.runs !== 'object'
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
        runs[runId] = { checksum: record.checksum, facts: normalizeFacts(rawFacts) }
      }
      return { version: 1, analyzerVersion: ANALYZER_VERSION, runs }
    } catch {
      return emptySidecar()
    }
  }

  private async writeSidecar(
    path: string,
    sidecar: NotebookDependencyAnalysisSidecar
  ): Promise<void> {
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

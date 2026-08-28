import type {
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookOutput
} from '../../shared/artifact-provenance'
import {
  decodeVersionedJson,
  type VersionedJsonDecodeResult
} from '../storage/versioned-json-decoder'
import {
  decodeNotebookHelperEvidence,
  notebookHelperEvidenceKey
} from '../notebook/helper-evidence'

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const normalizeStoredProvenanceOutput = (value: unknown): ProvenanceNotebookOutput[] => {
  const output = recordValue(value)
  if (output?.type === 'text' && typeof output.text === 'string') {
    return [
      {
        type: 'text',
        text: output.text,
        ...(output.truncated === true ? { truncated: true } : {})
      }
    ]
  }
  if (output?.type === 'error') {
    const name = typeof output.name === 'string' ? output.name : undefined
    const message = typeof output.message === 'string' ? output.message : name
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.filter((line): line is string => typeof line === 'string')
      : typeof output.traceback === 'string' && output.traceback
        ? output.traceback.split('\n')
        : undefined
    return [
      {
        type: 'error',
        ...(name ? { name } : {}),
        message: message ?? 'Notebook execution failed.',
        ...(traceback ? { traceback } : {})
      }
    ]
  }
  if (output?.type === 'table') {
    const columns = Array.isArray(output.columns)
      ? output.columns.filter((column): column is string => typeof column === 'string')
      : []
    const previewRows = Array.isArray(output.previewRows)
      ? output.previewRows.filter((row): row is unknown[] => Array.isArray(row))
      : []
    const rowCount =
      typeof output.rowCount === 'number' && Number.isFinite(output.rowCount)
        ? output.rowCount
        : undefined
    return columns.length > 0 && rowCount !== undefined
      ? [{ type: 'table', columns, rowCount, previewRows }]
      : []
  }
  if (output?.type === 'omitted-media') {
    const mimeTypes =
      typeof output.mimeType === 'string'
        ? [output.mimeType]
        : Array.isArray(output.mime_types)
          ? output.mime_types.filter((mimeType): mimeType is string => typeof mimeType === 'string')
          : []
    return mimeTypes.map((mimeType) => ({
      type: 'omitted-media',
      mimeType,
      ...(typeof output.byteLength === 'number' ? { byteLength: output.byteLength } : {})
    }))
  }
  return []
}

const executionInputFileValue = (value: unknown): boolean => {
  const input = recordValue(value)
  return (
    input !== undefined &&
    typeof input.inputFileVersionId === 'string' &&
    (input.sourceKind === 'upload-version' || input.sourceKind === 'artifact-version') &&
    typeof input.sourceFileId === 'string' &&
    (input.sourceVersionNumber === undefined ||
      (typeof input.sourceVersionNumber === 'number' &&
        Number.isSafeInteger(input.sourceVersionNumber))) &&
    (input.sourceCreatedAt === undefined || typeof input.sourceCreatedAt === 'string') &&
    typeof input.sourceProjectId === 'string' &&
    typeof input.sourceSessionId === 'string' &&
    typeof input.filename === 'string' &&
    (input.contentType === undefined || typeof input.contentType === 'string') &&
    typeof input.sizeBytes === 'number' &&
    Number.isFinite(input.sizeBytes) &&
    typeof input.checksum === 'string' &&
    typeof input.storageKey === 'string' &&
    (input.association === 'turn-attached' || input.association === 'resolver-accessed')
  )
}

const executionInputKeyValue = (value: unknown): boolean => {
  const key = recordValue(value)
  return (
    key !== undefined &&
    (key.sourceKind === 'upload-version' || key.sourceKind === 'artifact-version') &&
    typeof key.inputFileVersionId === 'string'
  )
}

const executionRunValue = (value: unknown): boolean => {
  const run = recordValue(value)
  return (
    run !== undefined &&
    typeof run.runId === 'string' &&
    typeof run.runIndex === 'number' &&
    Number.isSafeInteger(run.runIndex) &&
    typeof run.agentFrameId === 'string' &&
    typeof run.messageBranchId === 'string' &&
    typeof run.runtimeSegmentId === 'string' &&
    typeof run.promptMessageId === 'string' &&
    (run.kernelEpochId === undefined || typeof run.kernelEpochId === 'string') &&
    (run.kernelKind === 'python' ||
      run.kernelKind === 'r' ||
      run.kernelKind === 'repl' ||
      run.kernelKind === 'bash') &&
    typeof run.script === 'string' &&
    (run.status === 'queued' ||
      run.status === 'running' ||
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'timeout' ||
      run.status === 'interrupted' ||
      run.status === 'cancelled') &&
    (run.environmentName === undefined || typeof run.environmentName === 'string') &&
    (run.scriptTruncated === undefined || run.scriptTruncated === true) &&
    (run.executionCount === undefined ||
      (typeof run.executionCount === 'number' && Number.isFinite(run.executionCount))) &&
    typeof run.startedAt === 'string' &&
    (run.completedAt === undefined || typeof run.completedAt === 'string') &&
    Array.isArray(run.outputs) &&
    run.outputs.every((output) => normalizeStoredProvenanceOutput(output).length > 0) &&
    Array.isArray(run.inputFileVersionKeys) &&
    run.inputFileVersionKeys.every(executionInputKeyValue) &&
    (run.hasOmittedFiles === undefined || run.hasOmittedFiles === true) &&
    (run.hasOmittedInputs === undefined || run.hasOmittedInputs === true) &&
    (run.omittedOutputCount === undefined ||
      (Number.isSafeInteger(run.omittedOutputCount) && Number(run.omittedOutputCount) >= 0)) &&
    (run.helperModuleKeys === undefined ||
      (Array.isArray(run.helperModuleKeys) &&
        run.helperModuleKeys.every((key) => typeof key === 'string')))
  )
}

function decodeSnapshotHelperEvidence(
  snapshot: Record<string, unknown>,
  runs: PersistedArtifactExecutionSnapshot['runs']
): Pick<PersistedArtifactExecutionSnapshot, 'helperModules' | 'helperEvidenceStatus'> {
  const rawHelpers = Array.isArray(snapshot.helperModules) ? snapshot.helperModules : []
  const invalidHelperReasons = new Set<'source-missing' | 'source-corrupt'>()
  const helperModules = rawHelpers.flatMap((helper) => {
    const decoded = decodeNotebookHelperEvidence(helper)
    if (decoded.state === 'valid') return [decoded.value]
    invalidHelperReasons.add(decoded.reason)
    return []
  })
  const persistedStatus = recordValue(snapshot.helperEvidenceStatus)
  const persistedReasons =
    persistedStatus?.state === 'incomplete' && Array.isArray(persistedStatus.reasons)
      ? persistedStatus.reasons.filter(
          (reason): reason is 'source-missing' | 'source-corrupt' | 'payload-limit' =>
            reason === 'source-missing' || reason === 'source-corrupt' || reason === 'payload-limit'
        )
      : []
  const reasons = new Set(persistedReasons)
  for (const reason of invalidHelperReasons) reasons.add(reason)

  const hasHelperKeys = runs.some((run) => (run.helperModuleKeys?.length ?? 0) > 0)
  if (
    (hasHelperKeys && snapshot.helperModules === undefined) ||
    ((hasHelperKeys || rawHelpers.length > 0) && snapshot.helperEvidenceStatus === undefined) ||
    (persistedStatus?.state === 'complete' && rawHelpers.length === 0)
  ) {
    reasons.add('source-missing')
  }
  if (snapshot.helperModules !== undefined && !Array.isArray(snapshot.helperModules)) {
    reasons.add('source-corrupt')
  }
  if (
    snapshot.helperEvidenceStatus !== undefined &&
    persistedStatus?.state !== 'complete' &&
    persistedStatus?.state !== 'incomplete'
  ) {
    reasons.add('source-corrupt')
  }
  if (
    persistedStatus?.state === 'incomplete' &&
    (!Array.isArray(persistedStatus.reasons) ||
      persistedReasons.length !== persistedStatus.reasons.length)
  ) {
    reasons.add('source-corrupt')
  }

  const availableKeys = new Set(helperModules.map(notebookHelperEvidenceKey))
  const hasMissingHelperSource = runs.some((run) =>
    run.helperModuleKeys?.some((key) => !availableKeys.has(key))
  )
  if (
    rawHelpers.length === helperModules.length &&
    !reasons.has('payload-limit') &&
    hasMissingHelperSource
  ) {
    reasons.add('source-missing')
  }

  const hasHelperEvidence =
    hasHelperKeys ||
    snapshot.helperModules !== undefined ||
    snapshot.helperEvidenceStatus !== undefined
  if (!hasHelperEvidence) return {}
  if (reasons.size > 0) {
    return {
      helperModules,
      helperEvidenceStatus: { state: 'incomplete', reasons: [...reasons].sort() }
    }
  }
  return { helperModules, helperEvidenceStatus: { state: 'complete' } }
}

const executionSnapshotValue = (value: unknown): PersistedArtifactExecutionSnapshot | undefined => {
  const snapshot = recordValue(value)
  const truncation = recordValue(snapshot?.truncation)
  if (
    snapshot?.schemaVersion !== 2 ||
    typeof snapshot.rootFrameId !== 'string' ||
    typeof snapshot.agentFrameId !== 'string' ||
    typeof snapshot.messageBranchId !== 'string' ||
    typeof snapshot.terminalPromptMessageId !== 'string' ||
    typeof snapshot.producerRunId !== 'string' ||
    typeof snapshot.producerRunIndex !== 'number' ||
    !Number.isSafeInteger(snapshot.producerRunIndex) ||
    typeof snapshot.createdAt !== 'string' ||
    !Array.isArray(snapshot.inputFiles) ||
    snapshot.inputFiles.some((input) => !executionInputFileValue(input)) ||
    !Array.isArray(snapshot.runs) ||
    (snapshot.truncation !== undefined &&
      (!truncation ||
        truncation.reason !== 'payload-limit' ||
        !Number.isSafeInteger(truncation.omittedLeadingRunCount) ||
        Number(truncation.omittedLeadingRunCount) < 0 ||
        !Number.isSafeInteger(truncation.omittedOutputCount) ||
        Number(truncation.omittedOutputCount) < 0 ||
        !Number.isSafeInteger(truncation.omittedInputCount) ||
        Number(truncation.omittedInputCount) < 0)) ||
    snapshot.runs.some((run) => !executionRunValue(run))
  ) {
    return undefined
  }
  const normalized = value as PersistedArtifactExecutionSnapshot
  return {
    ...normalized,
    ...decodeSnapshotHelperEvidence(snapshot, normalized.runs),
    runs: normalized.runs.map((run) => ({
      ...run,
      outputs: (run.outputs as unknown[]).flatMap(normalizeStoredProvenanceOutput)
    }))
  }
}

export const decodeArtifactExecutionSnapshot = (
  value: string
): VersionedJsonDecodeResult<PersistedArtifactExecutionSnapshot> =>
  decodeVersionedJson(value, {
    currentVersion: 2,
    readVersion: (candidate) => recordValue(candidate)?.schemaVersion,
    decode: executionSnapshotValue
  })

export const parseArtifactExecutionSnapshot = (
  value: string
): PersistedArtifactExecutionSnapshot => {
  const decoded = decodeArtifactExecutionSnapshot(value)
  if (decoded.status === 'unsupported') {
    throw new Error('Artifact Version execution snapshot version is not supported.')
  }
  if (decoded.status === 'corrupt') {
    throw new Error('Artifact Version execution snapshot schema is invalid.')
  }
  return decoded.value
}

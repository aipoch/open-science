import { ProvenanceIntegrityError } from '../../shared/provenance-read-result'
import type {
  ArtifactVersionEnvironmentEvidence,
  ArtifactVersionEvidence,
  ArtifactVersionInputEvidence,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookOutput,
  ProvenanceNotebookRun
} from '../../shared/artifact-provenance'
import { isArtifactNotebookProducer } from '../../shared/artifact-provenance'
import type {
  NotebookEnvironmentManifest,
  NotebookEnvironmentPackage,
  NotebookHelperModuleEvidence,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunInputFile,
  NotebookRunRecord
} from '../../shared/notebook'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import {
  decodeArtifactExecutionSnapshot,
  parseArtifactExecutionSnapshot
} from './provenance-execution-snapshot-decoder'
import {
  decodeNotebookHelperEvidence,
  notebookHelperEvidenceKey
} from '../notebook/helper-evidence'

const MAX_EXECUTION_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_EXECUTION_SNAPSHOT_RUNS = 128
const MAX_EXECUTION_SNAPSHOT_OUTPUTS = 256
const MAX_EXECUTION_SNAPSHOT_INPUTS = 256
const MAX_EXECUTION_OUTPUT_BYTES = 64 * 1024

type EligibleNotebookRun = { run: NotebookRunRecord; runIndex: number }
type HelperEvidenceReason = 'source-missing' | 'source-corrupt' | 'payload-limit'

const clipText = (value: string, maxLength = 16_000): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n…[truncated]`

const provenanceTextOutput = (value: string): ProvenanceNotebookOutput => {
  const clipped = clipText(value)
  return {
    type: 'text',
    text: clipped,
    ...(clipped !== value ? { truncated: true } : {})
  }
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const tableCell = (value: unknown): CanonicalJson => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value
  }
  const serialized = JSON.stringify(value)
  return serialized === undefined ? null : clipText(serialized, 2_000)
}

const tabularJsonOutput = (value: unknown): ProvenanceNotebookOutput | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.some((row) => !recordValue(row))) {
    return undefined
  }
  const previewRecords = value.slice(0, 100).map((row) => recordValue(row)!)
  const columns = [...new Set(previewRecords.flatMap((row) => Object.keys(row)))].slice(0, 50)
  if (columns.length === 0) return undefined
  return {
    type: 'table',
    columns,
    rowCount: value.length,
    previewRows: previewRecords.map((row) => columns.map((column) => tableCell(row[column])))
  }
}

const omittedMediaByteLength = (mimeType: string, value: string): number =>
  mimeType.startsWith('image/') || mimeType === 'application/pdf'
    ? Buffer.from(value, 'base64').byteLength
    : Buffer.byteLength(value)

const boundExecutionOutput = (output: ProvenanceNotebookOutput): ProvenanceNotebookOutput =>
  Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_EXECUTION_OUTPUT_BYTES
    ? output
    : {
        type: 'text',
        text: '[output omitted because it exceeded the execution evidence limit]',
        truncated: true
      }

const sanitizeOutput = (output: NotebookOutput): ProvenanceNotebookOutput[] => {
  if (output.type === 'display') {
    const entries = Object.entries(output.data)
    return [
      ...entries
        .filter(([mimeType]) => mimeType.startsWith('text/'))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => provenanceTextOutput(value)),
      ...entries
        .filter(([mimeType]) => !mimeType.startsWith('text/'))
        .sort(([left], [right]) => left.localeCompare(right))
        .map<ProvenanceNotebookOutput>(([mimeType, value]) => ({
          type: 'omitted-media',
          mimeType,
          byteLength: omittedMediaByteLength(mimeType, value)
        }))
    ]
  }
  if (output.type === 'json') {
    return [
      tabularJsonOutput(output.data) ?? provenanceTextOutput(JSON.stringify(output.data) ?? 'null')
    ]
  }
  if (output.type === 'error') {
    const traceback = clipText(output.traceback)
    return [
      {
        type: 'error',
        ...(output.name ? { name: output.name } : {}),
        message: clipText(output.message ?? output.name ?? 'Notebook execution failed.'),
        ...(traceback ? { traceback: traceback.split('\n') } : {})
      }
    ]
  }
  return [provenanceTextOutput(output.text)]
}

const sanitizeRun = (
  run: NotebookRunRecord,
  runIndex: number,
  outputs: ProvenanceNotebookOutput[] = run.outputs.flatMap(sanitizeOutput),
  helperModuleKeys: string[] = []
): ProvenanceNotebookRun => {
  const script = clipText(run.script)
  return {
    runId: run.runId,
    runIndex,
    agentFrameId: run.agentFrameId ?? '',
    messageBranchId: run.messageBranchId ?? '',
    runtimeSegmentId: run.runtimeSegmentId ?? '',
    promptMessageId: run.promptMessageId ?? '',
    ...(run.kernelEpochId ? { kernelEpochId: run.kernelEpochId } : {}),
    kernelKind: run.kernelKind,
    ...(run.environment ? { environmentName: run.environment } : {}),
    script,
    ...(script !== run.script ? { scriptTruncated: true } : {}),
    status: run.status,
    ...(run.executionCount !== undefined ? { executionCount: run.executionCount } : {}),
    startedAt: new Date(run.startedAt).toISOString(),
    ...(run.endedAt !== undefined ? { completedAt: new Date(run.endedAt).toISOString() } : {}),
    outputs,
    inputFileVersionKeys: (run.inputFiles ?? []).map((input) => ({
      sourceKind: input.sourceKind,
      inputFileVersionId: input.inputFileVersionId
    })),
    ...(run.workingFiles.length > 0 ? { hasOmittedFiles: true } : {}),
    ...(helperModuleKeys.length ? { helperModuleKeys } : {})
  }
}

const mergeExecutionInputs = (runs: EligibleNotebookRun[]): NotebookRunInputFile[] => {
  const inputs = new Map<string, NotebookRunInputFile>()
  for (const { run } of runs) {
    for (const input of run.inputFiles ?? []) {
      const key = `${input.sourceKind}\0${input.inputFileVersionId}`
      const existing = inputs.get(key)
      inputs.set(key, {
        ...input,
        association:
          existing?.association === 'resolver-accessed' || input.association === 'resolver-accessed'
            ? 'resolver-accessed'
            : 'turn-attached'
      })
    }
  }
  return [...inputs.values()]
}

function collectHelperEvidence(eligibleRuns: EligibleNotebookRun[]): {
  helperModulesByKey: Map<string, NotebookHelperModuleEvidence>
  helperEvidenceReasons: Set<HelperEvidenceReason>
  runHelperKeys: Map<string, string[]>
} {
  const helperModulesByKey = new Map<string, NotebookHelperModuleEvidence>()
  const helperEvidenceReasons = new Set<HelperEvidenceReason>()
  const runHelperKeys = new Map<string, string[]>()

  for (const { run } of eligibleRuns) {
    const rawHelpers = run.helperModules as unknown
    const rawStatus = recordValue(run.helperEvidenceStatus)
    if (rawStatus?.state === 'incomplete' && Array.isArray(rawStatus.reasons)) {
      for (const reason of rawStatus.reasons) {
        if (
          reason === 'source-missing' ||
          reason === 'source-corrupt' ||
          reason === 'payload-limit'
        ) {
          helperEvidenceReasons.add(reason)
        } else {
          helperEvidenceReasons.add('source-corrupt')
        }
      }
    } else if (rawStatus !== undefined && rawStatus.state !== 'complete') {
      helperEvidenceReasons.add('source-corrupt')
    }
    if (rawStatus?.state === 'complete' && rawHelpers === undefined) {
      helperEvidenceReasons.add('source-missing')
    }
    if (rawHelpers !== undefined && run.helperEvidenceStatus === undefined) {
      helperEvidenceReasons.add('source-missing')
    }
    if (rawHelpers === undefined) continue
    if (!Array.isArray(rawHelpers)) {
      helperEvidenceReasons.add('source-missing')
      continue
    }

    const keys: string[] = []
    for (const rawHelper of rawHelpers) {
      const decodedHelper = decodeNotebookHelperEvidence(rawHelper)
      if (decodedHelper.state === 'invalid') {
        helperEvidenceReasons.add(decodedHelper.reason)
        continue
      }
      const helper = decodedHelper.value
      const key = notebookHelperEvidenceKey(helper)
      const existing = helperModulesByKey.get(key)
      if (
        existing &&
        canonicalJson(existing as unknown as CanonicalJson) !==
          canonicalJson(helper as unknown as CanonicalJson)
      ) {
        helperEvidenceReasons.add('source-corrupt')
        continue
      }
      helperModulesByKey.set(key, helper)
      keys.push(key)
    }
    if (keys.length) runHelperKeys.set(run.runId, [...new Set(keys)].sort())
  }

  return { helperModulesByKey, helperEvidenceReasons, runHelperKeys }
}

function helperEvidenceFields(
  helperModules: NotebookHelperModuleEvidence[],
  registeredHelperCount: number,
  reasons: Set<HelperEvidenceReason>
): Pick<PersistedArtifactExecutionSnapshot, 'helperModules' | 'helperEvidenceStatus'> {
  const fields = helperModules.length > 0 ? { helperModules } : {}
  if (registeredHelperCount === 0 && reasons.size === 0) return fields
  if (reasons.size > 0) {
    return {
      ...fields,
      helperEvidenceStatus: { state: 'incomplete', reasons: [...reasons].sort() }
    }
  }
  return { ...fields, helperEvidenceStatus: { state: 'complete' } }
}

const buildBoundedExecutionSnapshot = (
  base: Omit<PersistedArtifactExecutionSnapshot, 'inputFiles' | 'runs' | 'truncation'>,
  eligibleRuns: EligibleNotebookRun[]
): PersistedArtifactExecutionSnapshot => {
  const { helperModulesByKey, helperEvidenceReasons, runHelperKeys } =
    collectHelperEvidence(eligibleRuns)
  let helperModules = [...helperModulesByKey.values()].sort((left, right) =>
    notebookHelperEvidenceKey(left).localeCompare(notebookHelperEvidenceKey(right))
  )
  let omittedLeadingRunCount = Math.max(0, eligibleRuns.length - MAX_EXECUTION_SNAPSHOT_RUNS)
  let omittedOutputCount = 0
  const selectedRuns = eligibleRuns.slice(-MAX_EXECUTION_SNAPSHOT_RUNS)
  let remainingOutputs = MAX_EXECUTION_SNAPSHOT_OUTPUTS
  const runs = selectedRuns.map(({ run, runIndex }) => ({
    run,
    runIndex,
    outputs: [] as ProvenanceNotebookOutput[]
  }))
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const candidate = runs[index]!
    const outputs = candidate.run.outputs.flatMap(sanitizeOutput).map(boundExecutionOutput)
    const retainedCount = Math.min(outputs.length, remainingOutputs)
    candidate.outputs = outputs.slice(0, retainedCount)
    const omittedForRun = outputs.length - retainedCount
    omittedOutputCount += omittedForRun
    remainingOutputs -= retainedCount
  }

  const allInputs = mergeExecutionInputs(eligibleRuns)
  let inputFiles = allInputs.slice(0, MAX_EXECUTION_SNAPSHOT_INPUTS)
  let omittedInputCount = allInputs.length - inputFiles.length
  const materializedRuns = runs.map(({ run, runIndex, outputs }) => {
    const materialized = sanitizeRun(run, runIndex, outputs, runHelperKeys.get(run.runId))
    const omittedForRun = run.outputs.flatMap(sanitizeOutput).length - outputs.length
    if (omittedForRun > 0) materialized.omittedOutputCount = omittedForRun
    return materialized
  })

  const retainedInputKeys = (): Set<string> =>
    new Set(inputFiles.map((input) => `${input.sourceKind}\0${input.inputFileVersionId}`))
  const filterRunInputKeys = (): void => {
    const retained = retainedInputKeys()
    for (const run of materializedRuns) {
      const filtered = run.inputFileVersionKeys.filter((input) =>
        retained.has(`${input.sourceKind}\0${input.inputFileVersionId}`)
      )
      if (filtered.length !== run.inputFileVersionKeys.length) run.hasOmittedInputs = true
      run.inputFileVersionKeys = filtered
    }
  }
  filterRunInputKeys()

  const snapshot = (): PersistedArtifactExecutionSnapshot => ({
    ...base,
    inputFiles,
    runs: materializedRuns,
    ...helperEvidenceFields(helperModules, helperModulesByKey.size, helperEvidenceReasons),
    ...(omittedLeadingRunCount > 0 || omittedOutputCount > 0 || omittedInputCount > 0
      ? {
          truncation: {
            reason: 'payload-limit' as const,
            omittedLeadingRunCount,
            omittedOutputCount,
            omittedInputCount
          }
        }
      : {})
  })
  const snapshotBytes = (): number =>
    Buffer.byteLength(canonicalJson(snapshot() as unknown as CanonicalJson), 'utf8')

  while (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES && materializedRuns.length > 1) {
    materializedRuns.shift()
    omittedLeadingRunCount += 1
  }
  while (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES) {
    const runWithOutput = materializedRuns.find((run) => run.outputs.length > 0)
    if (!runWithOutput) break
    runWithOutput.outputs.pop()
    runWithOutput.omittedOutputCount = (runWithOutput.omittedOutputCount ?? 0) + 1
    omittedOutputCount += 1
  }
  while (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES && inputFiles.length > 0) {
    inputFiles = inputFiles.slice(0, Math.floor(inputFiles.length / 2))
    omittedInputCount = allInputs.length - inputFiles.length
    filterRunInputKeys()
  }
  if (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES) {
    while (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES && helperModules.length > 0) {
      helperModules = helperModules.slice(0, -1)
      helperEvidenceReasons.add('payload-limit')
    }
  }
  if (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES) {
    const producer = materializedRuns.at(-1)
    if (producer) {
      producer.script = clipText(producer.script, 1_000)
      producer.scriptTruncated = true
    }
  }
  if (snapshotBytes() > MAX_EXECUTION_SNAPSHOT_BYTES) {
    throw new Error('Artifact execution evidence exceeds the bounded snapshot limit.')
  }
  return snapshot()
}

const inputEvidence = (
  input: NotebookRunInputFile,
  ordinal: number
): ArtifactVersionInputEvidence => ({
  ordinal,
  input_file_version_id: input.inputFileVersionId,
  source_kind: input.sourceKind,
  source_file_id: input.sourceFileId,
  ...(input.sourceVersionNumber !== undefined
    ? { source_version_number: input.sourceVersionNumber }
    : {}),
  ...(input.sourceCreatedAt ? { source_created_at: input.sourceCreatedAt } : {}),
  source_project_id: input.sourceProjectId,
  source_session_id: input.sourceSessionId,
  filename: input.filename,
  ...(input.contentType ? { content_type: input.contentType } : {}),
  size_bytes: input.sizeBytes,
  checksum: input.checksum,
  storage_key: input.storageKey,
  strongest_association: input.association
})

const environmentPackageEvidence = (
  pkg: NotebookEnvironmentPackage
): ArtifactVersionEnvironmentEvidence['packages'][number] => ({
  name: pkg.name,
  ...(pkg.version ? { version: pkg.version } : {}),
  version_status: pkg.versionStatus,
  ecosystem: pkg.ecosystem,
  evidence_sources: pkg.evidenceSources,
  loaded_state: pkg.loadedState ?? 'unknown',
  ...(pkg.libraryRank !== undefined ? { library_rank: pkg.libraryRank } : {}),
  ...(pkg.libraryScope ? { library_scope: pkg.libraryScope } : {}),
  ...(pkg.builtForRuntime ? { built_for_runtime: pkg.builtForRuntime } : {}),
  ...(pkg.priority ? { priority: pkg.priority } : {}),
  ...(pkg.source ? { source: pkg.source } : {})
})

const environmentEvidence = (
  manifest: NotebookEnvironmentManifest,
  checksum: string
): ArtifactVersionEnvironmentEvidence => ({
  capture_kind: manifest.captureKind,
  environment_name: manifest.environmentName,
  kernel_kind: manifest.kernelKind,
  runtime_source: manifest.runtimeSource,
  ...(manifest.runtimeVersion ? { runtime_version: manifest.runtimeVersion } : {}),
  ...(manifest.platform ? { platform: manifest.platform } : {}),
  ...(manifest.architecture ? { architecture: manifest.architecture } : {}),
  packages: manifest.packages.map(environmentPackageEvidence),
  ...(manifest.kernelKind === 'python' && manifest.runtimeVersion
    ? { python_version: manifest.runtimeVersion }
    : {}),
  ...(manifest.kernelKind === 'r' && manifest.runtimeVersion
    ? { r_version: manifest.runtimeVersion }
    : {}),
  inventory_sources: manifest.inventorySources,
  installed_inventory: {
    captured_at: manifest.installedInventory.capturedAt,
    source: manifest.installedInventory.source,
    validation: manifest.installedInventory.validation
  },
  ...(manifest.operationLog
    ? {
        op_log: manifest.operationLog.map((operation) => ({
          operation_id: operation.operationId,
          timestamp: operation.timestamp,
          operation: operation.operation,
          packages: operation.packages,
          result: operation.result,
          attempts: (operation.attempts ?? []).map((attempt) => ({
            group_ordinal: attempt.groupOrdinal,
            installer: attempt.installer,
            packages: attempt.packages,
            status: attempt.status,
            mutation_risk: attempt.mutationRisk,
            ...(attempt.reason ? { reason: attempt.reason } : {})
          })),
          fallback_used: operation.fallbackUsed ?? false,
          inventory_refresh: operation.inventoryRefresh ?? 'published',
          inventory_refresh_attempts: operation.inventoryRefreshAttempts ?? [],
          ...(operation.packageChanges
            ? {
                package_changes: operation.packageChanges.map((change) => ({
                  name: change.name,
                  ecosystem: change.ecosystem,
                  relationship: change.relationship,
                  change: change.change,
                  ...(change.beforeVersion ? { before_version: change.beforeVersion } : {}),
                  ...(change.afterVersion ? { after_version: change.afterVersion } : {}),
                  ...(change.libraryRank !== undefined ? { library_rank: change.libraryRank } : {}),
                  ...(change.libraryScope ? { library_scope: change.libraryScope } : {}),
                  ...(change.source ? { source: change.source } : {})
                }))
              }
            : {})
        }))
      }
    : {}),
  ...(manifest.operationLogTruncation
    ? {
        op_log_truncation: {
          omitted_count: manifest.operationLogTruncation.omittedCount,
          ...(manifest.operationLogTruncation.earliestRetainedAt
            ? { earliest_retained_at: manifest.operationLogTruncation.earliestRetainedAt }
            : {})
        }
      }
    : {}),
  captured_at: manifest.capturedAt,
  source_manifest_checksum: checksum,
  complete: manifest.complete,
  capture_status: manifest.captureStatus,
  ...(manifest.warnings ? { warnings: manifest.warnings } : {})
})

const resolveRunEnvironmentCapture = (
  run: NotebookRunRecord
): {
  capture: NotebookRunEnvironmentCapture
  manifest?: NotebookEnvironmentManifest
  checksum?: string
} => {
  const manifest = run.environmentManifest
  const checksum = run.environmentManifestChecksum
  const serialized = manifest ? `${JSON.stringify(manifest, null, 2)}\n` : undefined
  const manifestState = manifest?.captureStatus === 'complete' ? 'available' : 'partial'
  const manifestIsValid =
    serialized !== undefined &&
    checksum !== undefined &&
    sha256(serialized) === checksum &&
    manifest?.captureKind === 'completed-run' &&
    manifest.kernelKind === run.kernelKind &&
    manifest.environmentName === run.environment &&
    manifest.complete === (manifest.captureStatus === 'complete')

  if (run.environmentCapture) {
    if (run.environmentCapture.state === 'unavailable') {
      return { capture: { ...run.environmentCapture } }
    }
    if (
      manifestIsValid &&
      checksum === run.environmentCapture.manifestChecksum &&
      manifestState === run.environmentCapture.state
    ) {
      return {
        capture: { ...run.environmentCapture },
        manifest,
        checksum
      }
    }
    // A malformed available/partial tuple cannot be emitted as trustworthy evidence, but it also
    // must not invalidate the Artifact bytes. Collapse only this corrupt publication state.
    return {
      capture: { state: 'unavailable', reason: 'environment-manifest-publication-failed' }
    }
  }

  if (manifestIsValid && manifest && checksum) {
    return {
      capture: {
        state: manifestState,
        manifestChecksum: checksum,
        ...(manifest.warnings?.length ? { warnings: [...manifest.warnings] } : {})
      },
      manifest,
      checksum
    }
  }
  return {
    capture: { state: 'unavailable', reason: 'legacy-environment-reference-unavailable' }
  }
}

const validateArtifactExecutionSnapshot = (
  snapshot: PersistedArtifactExecutionSnapshot,
  expected: {
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
    promptMessageId: string
    producerRunId: string | null
    producerRunIndex: number | null
    executionSnapshotChecksum: string
    evidence: ArtifactVersionEvidence
  }
): void => {
  const producer = expected.evidence.producer
  const runIndexes = snapshot.runs.map((run) => run.runIndex)
  const indexesAreStrictlyIncreasing = runIndexes.every(
    (runIndex, index) => index === 0 || runIndex > runIndexes[index - 1]!
  )
  const terminalRun = snapshot.runs.at(-1)
  if (
    snapshot.rootFrameId !== expected.rootFrameId ||
    snapshot.agentFrameId !== expected.agentFrameId ||
    snapshot.messageBranchId !== expected.messageBranchId ||
    snapshot.terminalPromptMessageId !== expected.promptMessageId ||
    expected.producerRunId === null ||
    expected.producerRunIndex === null ||
    snapshot.producerRunId !== expected.producerRunId ||
    snapshot.producerRunIndex !== expected.producerRunIndex ||
    expected.evidence.execution_snapshot_checksum !== expected.executionSnapshotChecksum ||
    !isArtifactNotebookProducer(producer) ||
    producer.producer_run_id !== expected.producerRunId ||
    producer.run_index !== expected.producerRunIndex ||
    snapshot.runs.length === 0 ||
    !indexesAreStrictlyIncreasing ||
    runIndexes.some((runIndex) => runIndex > expected.producerRunIndex!) ||
    terminalRun?.runId !== expected.producerRunId ||
    terminalRun.runIndex !== expected.producerRunIndex
  ) {
    throw new ProvenanceIntegrityError('Artifact Version execution snapshot metadata mismatch.')
  }
}

export {
  buildBoundedExecutionSnapshot,
  decodeArtifactExecutionSnapshot,
  environmentEvidence,
  inputEvidence,
  parseArtifactExecutionSnapshot,
  resolveRunEnvironmentCapture,
  validateArtifactExecutionSnapshot
}

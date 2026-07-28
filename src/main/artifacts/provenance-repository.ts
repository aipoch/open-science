import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PrismaClient } from '@prisma/client'

import type {
  ArtifactExecutionSnapshot,
  ArtifactLineageProvenance,
  ArtifactMessageSnapshotFile,
  ArtifactVersionDescriptor,
  ArtifactVersionEnvironmentEvidence,
  ArtifactVersionEvidence,
  ArtifactVersionFile,
  ArtifactVersionInputEvidence,
  ArtifactVersionProvenance,
  ArtifactProducerUnavailableReason,
  CreateArtifactVersionRequest,
  FinalizeArtifactVersionsRequest,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest,
  PersistedArtifactExecutionSnapshot,
  ProvenanceNotebookOutput,
  ProvenanceExecutionInputFile,
  ReplayArtifactVersionRequest
} from '../../shared/artifact-provenance'
import { ArtifactCompatibilityScanIncompleteError, ArtifactRepository } from './repository'
import { NotebookRunRepository } from '../notebook/repository'
import type {
  NotebookEnvironmentManifest,
  NotebookEnvironmentPackage,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunInputFile,
  NotebookRunRecord
} from '../../shared/notebook'
import { toCheck, toReview } from '../reviewer/repository'
import { selectReviewChainForArtifactVersion } from '../reviewer/artifact-version-review'
import { flagStaleReviews } from '../reviewer/stale-reviews'
import type {
  ReviewFindingDispositionOutcome,
  ReviewFindingDispositionTrigger,
  ReviewScopeSnapshotBlock,
  ReviewWithProvenanceEvidence
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  materializeSessionConversationGraph,
  sanitizeActivityGroup,
  sanitizeToolActivity
} from '../../shared/session-persistence'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_ALLOCATION_MAX_ATTEMPTS = 3

const isRetryableLineageVersionConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') {
    return false
  }
  const meta =
    'meta' in error && typeof error.meta === 'object' && error.meta ? error.meta : undefined
  const target = meta && 'target' in meta ? meta.target : undefined
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')]
  const joined = fields.join(' ')
  return (
    (joined.includes('artifactId') && joined.includes('versionNumber')) ||
    (joined.includes('projectId') &&
      joined.includes('sessionId') &&
      joined.includes('normalizedFilename'))
  )
}

const withVersionAllocationRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= VERSION_ALLOCATION_MAX_ATTEMPTS || !isRetryableLineageVersionConflict(error)) {
        throw error
      }
    }
  }
}

type ArtifactProvenanceRepositoryOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  compatibilityRepository?: ArtifactRepository
  notebookRepository?: Pick<NotebookRunRepository, 'findExisting'>
  loadSession?: (
    projectId: string,
    appSessionId: string
  ) => Promise<PersistedChatSession | undefined>
  createId?: () => string
  now?: () => Date
  durability?: ArtifactDurability
}

type ArtifactDurability = {
  syncFile: (path: string) => Promise<void>
  syncDirectory: (path: string) => Promise<void>
}

type CompatibilityRoutingPublicationOptions = {
  allowRoutingReplacement?: boolean
  replaceUnroutedBytes?: boolean
}

type PublishCompatibilityRouting = (
  version: PersistedVersionFileRecord,
  options?: CompatibilityRoutingPublicationOptions
) => Promise<void>

const syncOpenPath = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const defaultArtifactDurability: ArtifactDurability = {
  syncFile: syncOpenPath,
  syncDirectory: async (path) => {
    try {
      await syncOpenPath(path)
    } catch (error) {
      // Node cannot open directory handles on Windows. File barriers still protect the immutable
      // payloads there; POSIX platforms additionally make directory entry publication durable.
      if (
        process.platform === 'win32' &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(String(error.code))
      ) {
        return
      }
      throw error
    }
  }
}

export type WriteAppGeneratedArtifactVersionRequest = Omit<
  CreateArtifactVersionRequest,
  | 'writeOperationId'
  | 'writeRequestChecksum'
  | 'notebookSessionId'
  | 'producerRunId'
  | 'sourceKind'
  | 'sourceFileObservation'
  | 'filename'
  | 'contentType'
> & {
  filename: string
  content: string
  contentType?: string
}

type PersistedVersionFileRecord = {
  id: string
  artifactId: string
  versionNumber: number
  artifactRunId: string
  contentStorageKey: string
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  createdAt: Date
  producerRunId: string | null
  executionSnapshotJson: string | null
}

type StagingArtifactVersionRecord = PersistedVersionFileRecord & {
  state: string
  evidenceStorageKey: string
  evidenceJson: string
  evidenceChecksum: string
  executionSnapshotChecksum: string | null
  executionSnapshotStorageKey: string | null
  artifact: { id: string; filename: string }
}

type ProducerCapture =
  | {
      state: 'unavailable'
      reason: ArtifactProducerUnavailableReason
    }
  | {
      state: 'available'
      notebookSessionId: string
      producerRunId: string
      producerRunIndex: number
      associationMethod: 'agent-declared-and-session-validated' | 'server-inferred-file-observation'
      kernelKind: NotebookRunRecord['kernelKind']
      environmentName?: string
      reproductionCode: string
      executionJson: string
      executionChecksum: string
      inputFiles: NotebookRunInputFile[]
      environmentCapture: NotebookRunEnvironmentCapture
      environmentManifest?: NotebookEnvironmentManifest
      environmentManifestChecksum?: string
    }

type ArtifactStorageReconciliationResult = {
  recoveredVersionIds: string[]
  quarantinedVersionIds: string[]
}

type ArtifactFinalizationContext = Pick<
  FinalizeArtifactVersionsRequest,
  | 'rootFrameId'
  | 'agentFrameId'
  | 'messageBranchId'
  | 'runtimeSegmentId'
  | 'promptMessageId'
  | 'messageId'
>

const validateDurableMessageOwnership = (
  session: PersistedChatSession,
  context: ArtifactFinalizationContext
): { messageBranchAncestry: string[]; messageAncestry: string[] } => {
  const graph = materializeSessionConversationGraph(session).conversationGraph!
  if (graph.rootFrameId !== context.rootFrameId) {
    throw new Error('Artifact finalization root Frame does not match the durable Session graph.')
  }
  const frame = graph.frames.find((candidate) => candidate.id === context.agentFrameId)
  const branch = graph.branches.find((candidate) => candidate.id === context.messageBranchId)
  if (!frame || !branch || branch.agentFrameId !== frame.id) {
    throw new Error('Artifact finalization Branch does not belong to the declared Agent Frame.')
  }
  const segment = graph.runtimeSegments.find(
    (candidate) =>
      candidate.id === context.runtimeSegmentId && candidate.agentFrameId === context.agentFrameId
  )
  if (!segment) throw new Error('Artifact finalization Runtime Segment is not durable.')
  const path = resolveMessageBranchPath(graph, context.messageBranchId)
  const promptIndex = path.findIndex((message) => message.id === context.promptMessageId)
  const finalIndex = path.findIndex((message) => message.id === context.messageId)
  const promptMessage = path[promptIndex]
  const finalMessage = path[finalIndex]
  // Message status is lifecycle state, not ownership proof. The runtime creates an Artifact claim only
  // after the provider turn terminates, while the renderer may not have applied its following stop event
  // yet; an internal disk load can also normalize that still-streaming node to error. Frame, Branch,
  // Runtime Segment, role, and ordered path identity remain the fail-closed ownership boundary.
  if (
    promptIndex < 0 ||
    finalIndex <= promptIndex ||
    !promptMessage ||
    promptMessage.role !== 'user' ||
    promptMessage.status !== 'complete' ||
    promptMessage.agentFrameId !== context.agentFrameId ||
    promptMessage.introducedOnBranchId !== context.messageBranchId ||
    promptMessage.runtimeSegmentId !== context.runtimeSegmentId ||
    !finalMessage ||
    finalMessage.role !== 'agent' ||
    finalMessage.agentFrameId !== context.agentFrameId ||
    finalMessage.introducedOnBranchId !== context.messageBranchId ||
    finalMessage.runtimeSegmentId !== context.runtimeSegmentId
  ) {
    throw new Error('Artifact finalization message is not a Branch descendant of its prompt.')
  }
  const branches = new Map(graph.branches.map((candidate) => [candidate.id, candidate]))
  const branchAncestry: string[] = []
  let current: typeof branch | undefined = branch
  while (current) {
    branchAncestry.unshift(current.id)
    current = current.parentBranchId ? branches.get(current.parentBranchId) : undefined
  }
  return {
    messageBranchAncestry: branchAncestry,
    messageAncestry: path.slice(0, finalIndex + 1).map((message) => message.id)
  }
}

type CanonicalJson =
  null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

const assertChecksum = (value: string, label: string): string => {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: expected lowercase SHA-256`)
  }
  return value
}

// JavaScript has no native toCaseFold. Locale-independent lowercase plus the multi-character and
// positional folds that differ on supported filenames covers the portability cases that ordinary
// lowercasing misses (notably German sharp-s and Greek final sigma).
const normalizeFilename = (filename: string): string =>
  filename
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/\u00df/gu, 'ss')
    .replace(/\u03c2/gu, '\u03c3')

const canonicalize = (value: CanonicalJson): CanonicalJson => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

const canonicalJson = (value: CanonicalJson): string => JSON.stringify(canonicalize(value))

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

const storageKey = (...segments: string[]): string => segments.join('/')

const resolveStorageKey = (root: string, key: string): string => {
  if (!key || isAbsolute(key) || key.includes('\\')) {
    throw new Error('Invalid provenance storage key.')
  }
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid provenance storage key.')
  }

  const candidate = resolve(root, ...segments)
  const relativePath = relative(resolve(root), candidate)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Invalid provenance storage key.')
  }
  return candidate
}

const readOptionalFile = async (path: string): Promise<Buffer | undefined> =>
  readFile(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  })

const moveDirectoryIfPresent = async (source: string, destination: string): Promise<boolean> => {
  try {
    await rename(source, destination)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

const clipText = (value: string, maxLength = 16_000): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n…[truncated]`

const provenanceTextOutput = (value: string): CanonicalJson => {
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

const hasServerInferredProducer = (evidenceJson: string): boolean => {
  try {
    const evidence = recordValue(JSON.parse(evidenceJson))
    const producer = recordValue(evidence?.producer)
    return producer?.association_method === 'server-inferred-file-observation'
  } catch {
    return false
  }
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

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
    const name = stringValue(output.name)
    const message = stringValue(output.message) ?? name ?? 'Notebook execution failed.'
    const traceback = Array.isArray(output.traceback)
      ? output.traceback.filter((line): line is string => typeof line === 'string')
      : typeof output.traceback === 'string' && output.traceback
        ? output.traceback.split('\n')
        : undefined
    return [
      { type: 'error', ...(name ? { name } : {}), message, ...(traceback ? { traceback } : {}) }
    ]
  }
  if (output?.type === 'table') {
    const columns = Array.isArray(output.columns)
      ? output.columns.filter((column): column is string => typeof column === 'string')
      : []
    const previewRows = Array.isArray(output.previewRows)
      ? output.previewRows.filter((row): row is unknown[] => Array.isArray(row))
      : []
    const rowCount = numberValue(output.rowCount)
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

const parseArtifactExecutionSnapshot = (value: string): PersistedArtifactExecutionSnapshot => {
  const parsed = JSON.parse(value) as unknown
  const snapshot = recordValue(parsed)
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
    !Array.isArray(snapshot.runs) ||
    snapshot.runs.some((run) => {
      const candidate = recordValue(run)
      return (
        !candidate ||
        typeof candidate.runId !== 'string' ||
        typeof candidate.runIndex !== 'number' ||
        !Number.isSafeInteger(candidate.runIndex) ||
        typeof candidate.kernelKind !== 'string' ||
        typeof candidate.script !== 'string' ||
        typeof candidate.status !== 'string' ||
        typeof candidate.startedAt !== 'string' ||
        !Array.isArray(candidate.outputs) ||
        !Array.isArray(candidate.inputFileVersionKeys)
      )
    })
  ) {
    throw new Error('Artifact Version execution snapshot schema is invalid.')
  }
  const normalized = parsed as PersistedArtifactExecutionSnapshot
  return {
    ...normalized,
    runs: normalized.runs.map((run) => ({
      ...run,
      outputs: (run.outputs as unknown[]).flatMap(normalizeStoredProvenanceOutput)
    }))
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
    producer.state !== 'available' ||
    producer.producer_run_id !== expected.producerRunId ||
    producer.run_index !== expected.producerRunIndex ||
    snapshot.runs.length === 0 ||
    !indexesAreStrictlyIncreasing ||
    runIndexes.some((runIndex) => runIndex > expected.producerRunIndex!) ||
    terminalRun?.runId !== expected.producerRunId ||
    terminalRun.runIndex !== expected.producerRunIndex
  ) {
    throw new Error('Artifact Version execution snapshot metadata mismatch.')
  }
}

type PersistedExecutionInputRow = {
  ordinal: number
  inputFileVersionId: string
  sourceKind: string
  sourceFileId: string
  sourceVersionNumber: number | null
  sourceCreatedAt: Date | null
  sourceProjectId: string
  sourceSessionId: string
  filename: string
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  storageKey: string
  strongestAssociation: string
}

const validateArtifactExecutionInputs = (
  snapshot: PersistedArtifactExecutionSnapshot,
  evidence: ArtifactVersionEvidence,
  rows: PersistedExecutionInputRow[]
): void => {
  const snapshotKeys = new Set(
    snapshot.inputFiles.map((input) => `${input.sourceKind}\0${input.inputFileVersionId}`)
  )
  const invalidRunKey = snapshot.runs.some((run) =>
    run.inputFileVersionKeys.some(
      (input) => !snapshotKeys.has(`${input.sourceKind}\0${input.inputFileVersionId}`)
    )
  )
  const invalidInput = snapshot.inputFiles.some((input, ordinal) => {
    const evidenceInput = evidence.inputs[ordinal]
    const row = rows[ordinal]
    return (
      !evidenceInput ||
      !row ||
      evidenceInput.ordinal !== ordinal ||
      row.ordinal !== ordinal ||
      input.inputFileVersionId !== evidenceInput.input_file_version_id ||
      input.inputFileVersionId !== row.inputFileVersionId ||
      input.sourceKind !== evidenceInput.source_kind ||
      input.sourceKind !== row.sourceKind ||
      input.sourceFileId !== evidenceInput.source_file_id ||
      input.sourceFileId !== row.sourceFileId ||
      input.sourceVersionNumber !== evidenceInput.source_version_number ||
      input.sourceVersionNumber !== (row.sourceVersionNumber ?? undefined) ||
      input.sourceCreatedAt !== evidenceInput.source_created_at ||
      input.sourceCreatedAt !== row.sourceCreatedAt?.toISOString() ||
      input.sourceProjectId !== evidenceInput.source_project_id ||
      input.sourceProjectId !== row.sourceProjectId ||
      input.sourceSessionId !== evidenceInput.source_session_id ||
      input.sourceSessionId !== row.sourceSessionId ||
      input.filename !== evidenceInput.filename ||
      input.filename !== row.filename ||
      input.contentType !== evidenceInput.content_type ||
      input.contentType !== (row.contentType ?? undefined) ||
      input.sizeBytes !== evidenceInput.size_bytes ||
      input.sizeBytes !== Number(row.sizeBytes) ||
      input.checksum !== evidenceInput.checksum ||
      input.checksum !== row.checksum ||
      input.storageKey !== evidenceInput.storage_key ||
      input.storageKey !== row.storageKey ||
      input.association !== evidenceInput.strongest_association ||
      input.association !== row.strongestAssociation
    )
  })
  if (
    invalidRunKey ||
    invalidInput ||
    snapshot.inputFiles.length !== evidence.inputs.length ||
    snapshot.inputFiles.length !== rows.length
  ) {
    throw new Error('Artifact Version execution snapshot input metadata mismatch.')
  }
}

const validRecoveryFilename = (value: string): boolean =>
  value.length > 0 &&
  value !== '.' &&
  value !== '..' &&
  !value.includes('/') &&
  !value.includes('\\')

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

const tabularJsonOutput = (value: unknown): CanonicalJson | undefined => {
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

const sanitizeOutput = (output: NotebookOutput): CanonicalJson[] => {
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
        .map(([mimeType, value]) => ({
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

const sanitizeRun = (run: NotebookRunRecord, runIndex: number): CanonicalJson => ({
  runId: run.runId,
  runIndex,
  agentFrameId: run.agentFrameId ?? '',
  messageBranchId: run.messageBranchId ?? '',
  runtimeSegmentId: run.runtimeSegmentId ?? '',
  promptMessageId: run.promptMessageId ?? '',
  kernelKind: run.kernelKind,
  ...(run.environment ? { environmentName: run.environment } : {}),
  script: run.script,
  status: run.status,
  ...(run.executionCount !== undefined ? { executionCount: run.executionCount } : {}),
  startedAt: new Date(run.startedAt).toISOString(),
  ...(run.endedAt !== undefined ? { completedAt: new Date(run.endedAt).toISOString() } : {}),
  outputs: run.outputs.flatMap(sanitizeOutput),
  inputFileVersionKeys: (run.inputFiles ?? []).map((input) => ({
    sourceKind: input.sourceKind,
    inputFileVersionId: input.inputFileVersionId
  })),
  ...(run.workingFiles.length > 0 ? { hasOmittedFiles: true } : {})
})

const mergeExecutionInputs = (
  runs: Array<{ run: NotebookRunRecord; runIndex: number }>
): NotebookRunInputFile[] => {
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
  ...(pkg.priority ? { priority: pkg.priority } : {})
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
  platform: manifest.platform,
  architecture: manifest.architecture,
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
                  ...(change.libraryScope ? { library_scope: change.libraryScope } : {})
                }))
              }
            : {})
        }))
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

class ArtifactProvenanceRepository {
  private readonly compatibilityRepository: ArtifactRepository
  private readonly notebookRepository: Pick<NotebookRunRepository, 'findExisting'>
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly durability: ArtifactDurability
  private readonly lineageWrites = new Map<string, Promise<void>>()

  constructor(private readonly options: ArtifactProvenanceRepositoryOptions) {
    this.compatibilityRepository =
      options.compatibilityRepository ?? new ArtifactRepository(options.storageRoot)
    this.notebookRepository =
      options.notebookRepository ?? new NotebookRunRepository(options.storageRoot)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.durability = options.durability ?? defaultArtifactDurability
  }

  private async syncAndVerifyFile(
    path: string,
    expectedChecksum: string,
    corruptMessage: string
  ): Promise<Buffer> {
    await this.durability.syncFile(path)
    const bytes = await readFile(path)
    if (sha256(bytes) !== expectedChecksum) throw new Error(corruptMessage)
    return bytes
  }

  private async ensureCompatibilityRouting(
    version: PersistedVersionFileRecord,
    projectId: string,
    artifactStorageSessionId: string,
    filename: string,
    options: CompatibilityRoutingPublicationOptions = {}
  ): Promise<void> {
    await this.compatibilityRepository.ensurePendingVersionRouting({
      projectName: projectId,
      sessionId: artifactStorageSessionId,
      runId: version.artifactRunId,
      filename,
      sourcePath: resolveStorageKey(this.options.storageRoot, version.contentStorageKey),
      routing: {
        artifactId: version.artifactId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        artifactRunId: version.artifactRunId,
        checksum: version.checksum,
        ...(version.contentType ? { mimeType: version.contentType } : {})
      },
      ...options
    })
  }

  private compatibilityRoutingPublisher(
    projectId: string,
    artifactStorageSessionId: string,
    filename: string
  ): PublishCompatibilityRouting {
    return (version, options) =>
      this.ensureCompatibilityRouting(
        version,
        projectId,
        artifactStorageSessionId,
        filename,
        options
      )
  }

  // App-owned connector tools do not have an MCP/RPC hop. Keep compatibility bytes, immutable
  // Version publication, operation identity, and rollback behind one repository interface so every
  // app-side generated file follows the same durable lifecycle as model-invoked Artifact writes.
  async writeAppGeneratedVersion(
    request: WriteAppGeneratedArtifactVersionRequest
  ): Promise<ArtifactVersionFile> {
    const { content, ...versionRequest } = request
    const writeOperationId = `artifact-app-write-${this.createId()}`

    return this.compatibilityRepository.withPendingFileTransaction(
      {
        projectName: request.projectId,
        sessionId: request.artifactStorageSessionId,
        runId: request.artifactRunId,
        filename: request.filename,
        mimeType: request.contentType,
        source: { kind: 'inline', content, encoding: 'utf8' }
      },
      {},
      async (pendingFile, _sourceFileObservation, bindVersionRouting) => {
        const contentChecksum = sha256(await readFile(pendingFile.path))
        const writeRequestChecksum = sha256(
          canonicalJson({
            contentChecksum,
            contentType: request.contentType ?? null,
            filename: request.filename,
            producerRunId: null,
            sourceKind: 'inline',
            sourceFileObservation: null
          })
        )

        return this.createVersionWithOptions(
          {
            ...versionRequest,
            writeOperationId,
            writeRequestChecksum,
            sourceKind: 'inline'
          },
          async (version) =>
            bindVersionRouting(
              {
                artifactId: version.artifactId,
                versionId: version.id,
                versionNumber: version.versionNumber,
                artifactRunId: version.artifactRunId,
                checksum: version.checksum,
                mimeType: version.contentType ?? undefined
              },
              resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
            )
        )
      }
    )
  }

  async createVersion(request: CreateArtifactVersionRequest): Promise<ArtifactVersionFile> {
    return this.createVersionWithOptions(
      request,
      this.compatibilityRoutingPublisher(
        request.projectId,
        request.artifactStorageSessionId,
        request.filename
      )
    )
  }

  private async createVersionWithOptions(
    request: CreateArtifactVersionRequest,
    publishCompatibilityRouting: PublishCompatibilityRouting
  ): Promise<ArtifactVersionFile> {
    const lineageKey = `${request.projectId}\0${request.appSessionId}\0${normalizeFilename(request.filename)}`
    const previous = this.lineageWrites.get(lineageKey) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.then(() => current)
    this.lineageWrites.set(lineageKey, tail)
    await previous

    try {
      return await this.createVersionSerialized(request, publishCompatibilityRouting)
    } finally {
      release()
      if (this.lineageWrites.get(lineageKey) === tail) this.lineageWrites.delete(lineageKey)
    }
  }

  async replayVersion(
    request: ReplayArtifactVersionRequest
  ): Promise<ArtifactVersionFile | undefined> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactStorageSessionId = assertSafeSegment(
      request.artifactStorageSessionId,
      'artifact storage session id'
    )
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const writeOperationId = assertSafeSegment(request.writeOperationId, 'write operation id')
    const normalizedFilename = normalizeFilename(request.filename)
    const client = await this.options.getClient()
    const existing = await client.artifactVersion.findUnique({
      where: { writeOperationId },
      include: { artifact: true }
    })
    if (!existing) return undefined
    const producerMatches =
      request.producerRunId !== undefined
        ? (existing.producerRunId ?? undefined) === request.producerRunId
        : existing.producerRunId === null || hasServerInferredProducer(existing.evidenceJson)
    if (
      existing.artifact.projectId !== projectId ||
      existing.artifact.sessionId !== appSessionId ||
      existing.artifactRunId !== artifactRunId ||
      existing.artifact.normalizedFilename !== normalizedFilename ||
      (existing.contentType ?? undefined) !== request.contentType ||
      !producerMatches
    ) {
      throw new Error(
        `Artifact write operation was reused for a different request: ${writeOperationId}`
      )
    }
    if (existing.state === 'staging') {
      return this.recoverStagingVersion(
        existing,
        projectId,
        appSessionId,
        request.filename,
        this.compatibilityRoutingPublisher(projectId, artifactStorageSessionId, request.filename)
      )
    }
    if (existing.state !== 'pending' && existing.state !== 'finalized') {
      throw new Error(`Artifact write has an invalid lifecycle state: ${writeOperationId}`)
    }
    if (existing.state === 'pending') {
      await this.ensureCompatibilityRouting(
        existing,
        projectId,
        artifactStorageSessionId,
        request.filename,
        { replaceUnroutedBytes: true }
      )
    }
    return this.toArtifactVersionFile(existing, projectId, appSessionId, request.filename)
  }

  private async createVersionSerialized(
    request: CreateArtifactVersionRequest,
    publishCompatibilityRouting: PublishCompatibilityRouting
  ): Promise<ArtifactVersionFile> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactStorageSessionId = assertSafeSegment(
      request.artifactStorageSessionId,
      'artifact storage session id'
    )
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const writeOperationId = assertSafeSegment(request.writeOperationId, 'write operation id')
    const writeRequestChecksum = assertChecksum(
      request.writeRequestChecksum,
      'write request checksum'
    )
    const normalizedFilename = normalizeFilename(request.filename)
    const client = await this.options.getClient()
    const existing = await client.artifactVersion.findUnique({
      where: { writeOperationId },
      include: {
        artifact: true,
        messageSnapshot: true,
        inputs: { orderBy: { ordinal: 'asc' } }
      }
    })

    if (existing) {
      if (
        existing.writeRequestChecksum !== writeRequestChecksum ||
        existing.artifact.projectId !== projectId ||
        existing.artifact.sessionId !== appSessionId
      ) {
        throw new Error(
          `Artifact write operation was reused for a different request: ${writeOperationId}`
        )
      }
      if (existing.state === 'staging') {
        return this.recoverStagingVersion(
          existing,
          projectId,
          appSessionId,
          request.filename,
          publishCompatibilityRouting
        )
      }
      if (existing.state !== 'pending' && existing.state !== 'finalized') {
        throw new Error(`Artifact write has an invalid lifecycle state: ${writeOperationId}`)
      }

      if (existing.state === 'pending') {
        await publishCompatibilityRouting(existing, { replaceUnroutedBytes: true })
      }
      return this.toArtifactVersionFile(existing, projectId, appSessionId, request.filename)
    }

    const pendingFiles = await this.compatibilityRepository.listPendingRunFiles({
      projectName: projectId,
      sessionId: artifactStorageSessionId,
      runId: artifactRunId
    })
    const pendingFile = pendingFiles.find(
      (file) => normalizeFilename(file.name) === normalizedFilename
    )

    if (!pendingFile) {
      throw new Error(`Pending artifact file not found: ${request.filename}`)
    }

    const versionId = this.createId()
    const stagingStorageKey = storageKey(
      'artifacts',
      projectId,
      appSessionId,
      '.provenance',
      '.staging',
      'versions',
      versionId
    )
    const stagingDirectory = join(this.options.storageRoot, ...stagingStorageKey.split('/'))
    const stagingContentPath = join(stagingDirectory, 'content')

    await mkdir(stagingDirectory, { recursive: true })
    await copyFile(pendingFile.path, stagingContentPath)

    let stagingRowPersisted = false
    try {
      await this.durability.syncFile(stagingContentPath)
      const content = await readFile(stagingContentPath)
      const checksum = sha256(content)
      const createdAt = this.now()
      const producer = await this.captureProducer(request, createdAt, checksum)
      const persisted = await withVersionAllocationRetry(() =>
        client.$transaction(async (transaction) => {
          const origin = await transaction.fileOriginSession.upsert({
            where: { projectId_sessionId: { projectId, sessionId: appSessionId } },
            create: {
              projectId,
              sessionId: appSessionId,
              titleSnapshot: request.titleSnapshot
            },
            update: request.titleSnapshot ? { titleSnapshot: request.titleSnapshot } : {}
          })
          if (origin.state !== 'active') {
            throw new Error('Artifact origin Session is being deleted and cannot accept a Version.')
          }

          let lineage = await transaction.artifactLineage.findUnique({
            where: {
              projectId_sessionId_normalizedFilename: {
                projectId,
                sessionId: appSessionId,
                normalizedFilename
              }
            }
          })
          if (!lineage) {
            lineage = await transaction.artifactLineage.create({
              data: {
                id: this.createId(),
                projectId,
                sessionId: appSessionId,
                normalizedFilename,
                filename: request.filename
              }
            })
          }

          const latest = await transaction.artifactVersion.aggregate({
            where: { artifactId: lineage.id },
            _max: { versionNumber: true }
          })
          const versionNumber = (latest._max.versionNumber ?? 0) + 1
          const contentStorageKey = storageKey(
            'artifacts',
            projectId,
            appSessionId,
            '.provenance',
            lineage.id,
            'versions',
            versionId,
            'content'
          )
          const evidenceStorageKey = storageKey(
            'artifacts',
            projectId,
            appSessionId,
            '.provenance',
            lineage.id,
            'versions',
            versionId,
            'evidence.json'
          )
          const executionSnapshotStorageKey =
            producer.state === 'available'
              ? storageKey(
                  'artifacts',
                  projectId,
                  appSessionId,
                  '.provenance',
                  lineage.id,
                  'versions',
                  versionId,
                  'execution.json'
                )
              : undefined
          const evidence: ArtifactVersionEvidence = {
            app_session_id: appSessionId,
            artifact_id: lineage.id,
            checksum,
            ...(request.contentType ? { content_type: request.contentType } : {}),
            conversation: {
              agent_frame_id: request.agentFrameId,
              message_branch_id: request.messageBranchId,
              prompt_message_id: request.promptMessageId,
              root_frame_id: request.rootFrameId,
              runtime_segment_id: request.runtimeSegmentId
            },
            created_at: createdAt.toISOString(),
            environment_status:
              producer.state !== 'available'
                ? { reason: producer.reason, state: 'unavailable' }
                : producer.environmentCapture.state === 'unavailable'
                  ? { reason: producer.environmentCapture.reason, state: 'unavailable' }
                  : { state: producer.environmentCapture.state },
            ...(producer.state === 'available' &&
            producer.environmentManifest &&
            producer.environmentManifestChecksum
              ? {
                  environment: environmentEvidence(
                    producer.environmentManifest,
                    producer.environmentManifestChecksum
                  )
                }
              : {}),
            execution_status:
              producer.state === 'available'
                ? { state: 'available' }
                : { reason: producer.reason, state: 'unavailable' },
            ...(producer.state === 'available'
              ? {
                  execution_snapshot_checksum: producer.executionChecksum,
                  reproduction_code: producer.reproductionCode
                }
              : {}),
            filename: request.filename,
            inputs:
              producer.state === 'available'
                ? producer.inputFiles.map((input, ordinal) => inputEvidence(input, ordinal))
                : [],
            is_user_upload: false,
            ...(request.agentName ? { agent_name: request.agentName } : {}),
            producer:
              producer.state === 'available'
                ? {
                    association_method: producer.associationMethod,
                    kernel_kind: producer.kernelKind,
                    notebook_session_id: producer.notebookSessionId,
                    producer_run_id: producer.producerRunId,
                    run_index: producer.producerRunIndex,
                    ...(producer.environmentCapture.state !== 'unavailable'
                      ? {
                          environment_manifest_checksum:
                            producer.environmentCapture.manifestChecksum
                        }
                      : {}),
                    state: 'available'
                  }
                : { reason: producer.reason, state: 'unavailable' },
            project_id: projectId,
            schema_version: 1,
            size_bytes: content.byteLength,
            version_id: versionId,
            version_number: versionNumber
          }
          const evidenceJson = canonicalJson(evidence as unknown as CanonicalJson)

          return transaction.artifactVersion.create({
            data: {
              id: versionId,
              artifactId: lineage.id,
              versionNumber,
              artifactRunId,
              writeOperationId,
              writeRequestChecksum,
              rootFrameId: assertSafeSegment(request.rootFrameId, 'root frame id'),
              agentFrameId: assertSafeSegment(request.agentFrameId, 'agent frame id'),
              messageBranchId: assertSafeSegment(request.messageBranchId, 'message branch id'),
              runtimeSegmentId: assertSafeSegment(request.runtimeSegmentId, 'runtime segment id'),
              promptMessageId: assertSafeSegment(request.promptMessageId, 'prompt message id'),
              notebookSessionId:
                producer.state === 'available' ? producer.notebookSessionId : undefined,
              producerRunId: producer.state === 'available' ? producer.producerRunId : undefined,
              producerRunIndex:
                producer.state === 'available' ? producer.producerRunIndex : undefined,
              state: 'staging',
              contentStorageKey,
              evidenceStorageKey,
              contentType: request.contentType,
              sizeBytes: BigInt(content.byteLength),
              checksum,
              evidenceJson,
              evidenceChecksum: sha256(evidenceJson),
              executionSnapshotJson:
                producer.state === 'available' ? producer.executionJson : undefined,
              executionSnapshotChecksum:
                producer.state === 'available' ? producer.executionChecksum : undefined,
              executionSnapshotStorageKey,
              executionSnapshotSchemaVersion: producer.state === 'available' ? 2 : undefined,
              ...(producer.state === 'available' && producer.inputFiles.length > 0
                ? {
                    inputs: {
                      create: producer.inputFiles.map((input, ordinal) => ({
                        id: this.createId(),
                        ordinal,
                        inputFileVersionId: input.inputFileVersionId,
                        sourceKind: input.sourceKind,
                        sourceFileId: input.sourceFileId,
                        ...(input.sourceKind === 'artifact-version'
                          ? { sourceArtifactVersionId: input.inputFileVersionId }
                          : { sourceUploadVersionId: input.inputFileVersionId }),
                        sourceVersionNumber: input.sourceVersionNumber,
                        sourceCreatedAt: input.sourceCreatedAt
                          ? new Date(input.sourceCreatedAt)
                          : undefined,
                        sourceProjectId: input.sourceProjectId,
                        sourceSessionId: input.sourceSessionId,
                        filename: input.filename,
                        contentType: input.contentType,
                        sizeBytes: BigInt(input.sizeBytes),
                        checksum: input.checksum,
                        storageKey: input.storageKey,
                        strongestAssociation: input.association
                      }))
                    }
                  }
                : {}),
              createdAt
            }
          })
        })
      )
      stagingRowPersisted = true

      const evidencePath = join(stagingDirectory, 'evidence.json')
      await writeFile(evidencePath, persisted.evidenceJson, 'utf8')
      await this.syncAndVerifyFile(
        evidencePath,
        persisted.evidenceChecksum,
        `Artifact Version evidence mirror is corrupt: ${persisted.id}`
      )
      if (persisted.executionSnapshotJson) {
        const executionPath = join(stagingDirectory, 'execution.json')
        await writeFile(executionPath, persisted.executionSnapshotJson, 'utf8')
        await this.syncAndVerifyFile(
          executionPath,
          persisted.executionSnapshotChecksum!,
          `Artifact Version execution mirror is corrupt: ${persisted.id}`
        )
      }
      const finalContentPath = join(
        this.options.storageRoot,
        ...persisted.contentStorageKey.split('/')
      )
      await mkdir(dirname(dirname(finalContentPath)), { recursive: true })
      await this.durability.syncDirectory(stagingDirectory)
      const finalDirectory = dirname(finalContentPath)
      await rename(stagingDirectory, finalDirectory)
      await this.durability.syncDirectory(dirname(finalDirectory))

      await publishCompatibilityRouting(persisted, { allowRoutingReplacement: true })
      const finalized = await client.$transaction(async (transaction) => {
        await transaction.artifactLineage.update({
          where: { id: persisted.artifactId },
          data: { filename: request.filename }
        })
        return transaction.artifactVersion.update({
          where: { id: persisted.id },
          data: { state: 'pending' }
        })
      })
      return this.toArtifactVersionFile(finalized, projectId, appSessionId, request.filename)
    } catch (error) {
      // Once SQLite owns the staging row, its copied bytes are recovery state for an idempotent
      // transport retry. Removing them here would force a retry to reread a mutable pending source.
      if (!stagingRowPersisted) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
      throw error
    }
  }

  private async recoverStagingVersion(
    version: StagingArtifactVersionRecord,
    projectId: string,
    appSessionId: string,
    requestedFilename: string,
    publishCompatibilityRouting?: PublishCompatibilityRouting
  ): Promise<ArtifactVersionFile> {
    if (sha256(version.evidenceJson) !== version.evidenceChecksum) {
      throw new Error(`Artifact Version canonical evidence is corrupt: ${version.id}`)
    }
    if (
      version.executionSnapshotJson &&
      (!version.executionSnapshotChecksum ||
        sha256(version.executionSnapshotJson) !== version.executionSnapshotChecksum)
    ) {
      throw new Error(`Artifact Version canonical execution snapshot is corrupt: ${version.id}`)
    }

    const stagingDirectory = resolveStorageKey(
      this.options.storageRoot,
      storageKey(
        'artifacts',
        projectId,
        appSessionId,
        '.provenance',
        '.staging',
        'versions',
        version.id
      )
    )
    const finalContentPath = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const finalDirectory = dirname(finalContentPath)
    const [stagingContent, finalContent] = await Promise.all([
      readOptionalFile(join(stagingDirectory, 'content')),
      readOptionalFile(finalContentPath)
    ])
    if (stagingContent && finalContent) {
      throw new Error(`Artifact Version has conflicting staging and final content: ${version.id}`)
    }
    const content = finalContent ?? stagingContent
    if (!content) throw new Error(`Artifact Version staging content is unavailable: ${version.id}`)
    if (content.byteLength !== Number(version.sizeBytes) || sha256(content) !== version.checksum) {
      throw new Error(`Artifact Version staging content is corrupt: ${version.id}`)
    }

    const publishDirectory = finalContent ? finalDirectory : stagingDirectory
    await this.syncAndVerifyFile(
      join(publishDirectory, 'content'),
      version.checksum,
      `Artifact Version staging content is corrupt: ${version.id}`
    )
    await this.ensureCanonicalMirror(
      join(publishDirectory, 'evidence.json'),
      version.evidenceJson,
      version.evidenceChecksum,
      `Artifact Version evidence mirror is corrupt: ${version.id}`
    )
    if (
      version.executionSnapshotJson &&
      version.executionSnapshotChecksum &&
      version.executionSnapshotStorageKey
    ) {
      await this.ensureCanonicalMirror(
        join(publishDirectory, 'execution.json'),
        version.executionSnapshotJson,
        version.executionSnapshotChecksum,
        `Artifact Version execution mirror is corrupt: ${version.id}`
      )
    }

    if (!finalContent) {
      await mkdir(dirname(finalDirectory), { recursive: true })
      await this.durability.syncDirectory(stagingDirectory)
      await rename(stagingDirectory, finalDirectory)
    }
    await this.durability.syncDirectory(dirname(finalDirectory))
    let routingPublisher = publishCompatibilityRouting
    if (!routingPublisher) {
      const pendingOwner = await this.compatibilityRepository.findPendingFileForRun({
        projectName: projectId,
        runId: version.artifactRunId,
        filename: requestedFilename,
        checksum: version.checksum
      })
      if (!pendingOwner) {
        throw new Error(
          `Artifact Version staging compatibility route is unavailable: ${version.id}`
        )
      }
      routingPublisher = this.compatibilityRoutingPublisher(
        projectId,
        pendingOwner.storageSessionId,
        requestedFilename
      )
    }
    await routingPublisher(version, { allowRoutingReplacement: true })

    const client = await this.options.getClient()
    const recovered = await client.$transaction(async (transaction) => {
      await transaction.artifactLineage.update({
        where: { id: version.artifactId },
        data: { filename: requestedFilename }
      })
      return transaction.artifactVersion.update({
        where: { id: version.id },
        data: { state: 'pending' }
      })
    })
    return this.toArtifactVersionFile(recovered, projectId, appSessionId, requestedFilename)
  }

  private async ensureCanonicalMirror(
    path: string,
    canonical: string,
    checksum: string,
    corruptMessage: string
  ): Promise<string> {
    if (sha256(canonical) !== checksum) throw new Error(corruptMessage)
    let bytes = await readOptionalFile(path)
    if (!bytes) {
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${this.createId()}.tmp`
      try {
        await writeFile(temporaryPath, canonical, { encoding: 'utf8', flag: 'wx' })
        await this.syncAndVerifyFile(temporaryPath, checksum, corruptMessage)
        await rename(temporaryPath, path)
        await this.durability.syncDirectory(dirname(path))
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      bytes = await this.syncAndVerifyFile(path, checksum, corruptMessage)
    } else {
      bytes = await this.syncAndVerifyFile(path, checksum, corruptMessage)
    }
    const value = bytes.toString('utf8')
    if (value !== canonical || sha256(bytes) !== checksum) throw new Error(corruptMessage)
    return value
  }

  private async captureProducer(
    request: CreateArtifactVersionRequest,
    createdAt: Date,
    artifactChecksum: string
  ): Promise<ProducerCapture> {
    // Local files require an app-side observation before an Agent-declared run may become evidence.
    // Inline bytes have no file observation, so they retain the declared run only after the durable
    // Notebook Session and graph-scope checks below succeed.
    if (
      request.producerRunId &&
      !request.sourceFileObservation &&
      request.sourceKind !== 'inline'
    ) {
      return { state: 'unavailable', reason: 'producer-source-unverifiable' }
    }
    if (request.producerRunId && !request.notebookSessionId) {
      throw new Error('producerRunId requires notebookSessionId in the active Artifact run.')
    }
    if (!request.notebookSessionId) {
      return { state: 'unavailable', reason: 'producer-not-supplied' }
    }
    if (!request.producerRunId && !request.sourceFileObservation) {
      return { state: 'unavailable', reason: 'producer-not-supplied' }
    }

    const document = await this.notebookRepository.findExisting(
      request.projectId,
      request.notebookSessionId
    )
    const sourceFileObservation = request.sourceFileObservation
      ? await this.verifySourceFileObservation(
          document,
          request.sourceFileObservation,
          artifactChecksum
        )
      : undefined
    if (request.sourceFileObservation && !sourceFileObservation) {
      return { state: 'unavailable', reason: 'producer-source-unverifiable' }
    }
    const expected = {
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      runtimeSegmentId: request.runtimeSegmentId,
      promptMessageId: request.promptMessageId
    }
    const inferredProducerRunId = request.producerRunId
      ? undefined
      : await this.inferProducerRunId(document, sourceFileObservation, expected)
    const producerRunId = request.producerRunId ?? inferredProducerRunId
    if (!producerRunId) {
      return {
        state: 'unavailable',
        reason: request.sourceFileObservation
          ? 'producer-source-unverifiable'
          : 'producer-not-supplied'
      }
    }
    const producerRunIndex = document?.runs.findIndex((run) => run.runId === producerRunId) ?? -1
    const producerRun = document?.runs[producerRunIndex]

    if (!document || !producerRun || producerRunIndex < 0) {
      throw new Error(`Notebook producer run not found: ${producerRunId}`)
    }
    for (const [field, value] of Object.entries(expected)) {
      if (producerRun[field as keyof typeof expected] !== value) {
        throw new Error(
          `Notebook producer run does not belong to the active Artifact ${field}: ${producerRunId}`
        )
      }
    }
    if (request.producerRunId && sourceFileObservation) {
      const observedOwners = await this.findObservedWorkingFileRunIds(
        document,
        sourceFileObservation,
        expected
      )
      if (observedOwners.length > 0 && !observedOwners.includes(request.producerRunId)) {
        throw new Error(
          `Declared producer source belongs to another Notebook run: ${observedOwners.join(', ')}`
        )
      }
      if (observedOwners.length !== 1) {
        return { state: 'unavailable', reason: 'producer-source-unverifiable' }
      }
    }

    const eligibleBranchIds = new Set(
      request.messageBranchAncestry?.length
        ? request.messageBranchAncestry
        : [request.messageBranchId]
    )
    if (!eligibleBranchIds.has(request.messageBranchId)) {
      throw new Error('Artifact Branch ancestry does not contain the active Branch.')
    }
    const eligibleMessageIds = request.messageAncestry?.length
      ? new Set(request.messageAncestry)
      : undefined
    if (eligibleMessageIds && !eligibleMessageIds.has(request.promptMessageId)) {
      throw new Error('Artifact Message ancestry does not contain the producer prompt.')
    }
    const eligibleRuns = document.runs
      .slice(0, producerRunIndex + 1)
      .map((run, runIndex) => ({ run, runIndex }))
      .filter(
        ({ run }) =>
          run.agentFrameId === request.agentFrameId &&
          !!run.messageBranchId &&
          eligibleBranchIds.has(run.messageBranchId) &&
          (eligibleMessageIds
            ? run.promptMessageId
              ? eligibleMessageIds.has(run.promptMessageId)
              : run.messageBranchId === request.messageBranchId
            : true)
      )
    const inputFiles = mergeExecutionInputs(eligibleRuns)
    await this.validateInputReferences(request.projectId, inputFiles)
    const executionJson = canonicalJson({
      schemaVersion: 2,
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      terminalPromptMessageId: request.promptMessageId,
      producerRunId,
      producerRunIndex,
      createdAt: createdAt.toISOString(),
      inputFiles: inputFiles.map((input) => ({ ...input })),
      runs: eligibleRuns.map(({ run, runIndex }) => sanitizeRun(run, runIndex))
    })
    const environment = resolveRunEnvironmentCapture(producerRun)

    return {
      state: 'available',
      notebookSessionId: request.notebookSessionId,
      producerRunId,
      producerRunIndex,
      associationMethod: request.producerRunId
        ? 'agent-declared-and-session-validated'
        : 'server-inferred-file-observation',
      kernelKind: producerRun.kernelKind,
      environmentName: producerRun.environment,
      reproductionCode: producerRun.script,
      executionJson,
      executionChecksum: sha256(executionJson),
      inputFiles,
      environmentCapture: environment.capture,
      ...(environment.manifest && environment.checksum
        ? {
            environmentManifest: environment.manifest,
            environmentManifestChecksum: environment.checksum
          }
        : {})
    }
  }

  private async inferProducerRunId(
    document: Awaited<ReturnType<NotebookRunRepository['findExisting']>>,
    observation: CreateArtifactVersionRequest['sourceFileObservation'],
    expected: {
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      runtimeSegmentId: string
      promptMessageId: string
    }
  ): Promise<string | undefined> {
    if (!document || !observation) return undefined
    const matches = await this.findObservedWorkingFileRunIds(document, observation, expected)
    return matches.length === 1 ? matches[0] : undefined
  }

  // Treat the RPC observation as an untrusted path hint. Main re-observes the source under the
  // Notebook's durable roots and proves that its bytes are exactly the immutable Artifact content
  // before the hint may participate in producer attribution.
  private async verifySourceFileObservation(
    document: Awaited<ReturnType<NotebookRunRepository['findExisting']>>,
    observation: NonNullable<CreateArtifactVersionRequest['sourceFileObservation']>,
    artifactChecksum: string
  ): Promise<NonNullable<CreateArtifactVersionRequest['sourceFileObservation']> | undefined> {
    if (
      !document ||
      !Number.isFinite(observation.sizeBytes) ||
      observation.sizeBytes < 0 ||
      !Number.isFinite(observation.mtimeMs) ||
      observation.mtimeMs < 0
    ) {
      return undefined
    }

    const observedPath = await realpath(resolve(observation.path)).catch(() => undefined)
    if (!observedPath) return undefined
    const roots = await Promise.all(
      [document.notebookSessionRoot, document.workspaceCwd].map((root) =>
        realpath(resolve(root)).catch(() => resolve(root))
      )
    )
    if (
      !roots.some((root) => {
        const relativePath = relative(root, observedPath)
        return (
          relativePath !== '' &&
          relativePath !== '..' &&
          !relativePath.startsWith(`..${sep}`) &&
          !isAbsolute(relativePath)
        )
      })
    ) {
      return undefined
    }

    const before = await stat(observedPath).catch(() => undefined)
    if (
      !before?.isFile() ||
      before.size !== observation.sizeBytes ||
      before.mtimeMs !== observation.mtimeMs
    ) {
      return undefined
    }
    const bytes = await readFile(observedPath).catch(() => undefined)
    const after = await stat(observedPath).catch(() => undefined)
    if (
      !bytes ||
      !after?.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      sha256(bytes) !== artifactChecksum
    ) {
      return undefined
    }

    return { path: observedPath, sizeBytes: after.size, mtimeMs: after.mtimeMs }
  }

  private async findObservedWorkingFileRunIds(
    document: NonNullable<Awaited<ReturnType<NotebookRunRepository['findExisting']>>>,
    observation: NonNullable<CreateArtifactVersionRequest['sourceFileObservation']>,
    expected: {
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      runtimeSegmentId: string
      promptMessageId: string
    }
  ): Promise<string[]> {
    if (
      !Number.isFinite(observation.sizeBytes) ||
      observation.sizeBytes < 0 ||
      !Number.isFinite(observation.mtimeMs) ||
      observation.mtimeMs < 0
    ) {
      return []
    }

    const canonicalPath = async (path: string): Promise<string> =>
      realpath(resolve(path)).catch(() => resolve(path))
    const observedPath = await canonicalPath(observation.path)
    const documentRoots = await Promise.all(
      [document.notebookSessionRoot, document.workspaceCwd].map(canonicalPath)
    )
    const isInsideDocumentRoot = documentRoots.some((root) => {
      const relativePath = relative(root, observedPath)
      return (
        relativePath !== '' &&
        relativePath !== '..' &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath)
      )
    })
    if (!isInsideDocumentRoot) return []

    const candidates = document.runs.filter((run) =>
      Object.entries(expected).every(
        ([field, value]) => run[field as keyof typeof expected] === value
      )
    )
    const workingFileMatches = (
      await Promise.all(
        candidates.map(async (run) => {
          for (const file of run.workingFiles) {
            if (
              (await canonicalPath(file.path)) === observedPath &&
              file.createdByRunId === run.runId &&
              file.size === observation.sizeBytes &&
              file.mtimeMs === observation.mtimeMs
            ) {
              return run.runId
            }
          }
          return undefined
        })
      )
    ).filter((runId): runId is string => runId !== undefined)

    // mtime is diagnostic context, not a causal execution receipt. Only a WorkingFile observation
    // attributed to one run may promote an omitted declaration to available producer evidence.
    return [...new Set(workingFileMatches)]
  }

  private async validateInputReferences(
    projectId: string,
    inputs: NotebookRunInputFile[]
  ): Promise<void> {
    const client = await this.options.getClient()
    for (const input of inputs) {
      if (input.sourceProjectId !== projectId) {
        throw new Error(`Notebook input belongs to another Project: ${input.inputFileVersionId}`)
      }
      if (input.sourceKind === 'upload-version') {
        const version = await client.uploadVersion.findUnique({
          where: { id: input.inputFileVersionId },
          include: { uploadFile: true }
        })
        if (
          !version ||
          version.state !== 'ready' ||
          version.uploadFileId !== input.sourceFileId ||
          version.uploadFile.projectId !== input.sourceProjectId ||
          version.uploadFile.sessionId !== input.sourceSessionId ||
          version.versionNumber !== input.sourceVersionNumber ||
          version.contentStorageKey !== input.storageKey ||
          version.checksum !== input.checksum ||
          Number(version.sizeBytes) !== input.sizeBytes
        ) {
          throw new Error(`Notebook Upload input identity is corrupt: ${input.inputFileVersionId}`)
        }
        continue
      }

      const version = await client.artifactVersion.findUnique({
        where: { id: input.inputFileVersionId },
        include: { artifact: true }
      })
      if (
        !version ||
        version.state !== 'finalized' ||
        version.artifactId !== input.sourceFileId ||
        version.artifact.projectId !== input.sourceProjectId ||
        version.artifact.sessionId !== input.sourceSessionId ||
        version.versionNumber !== input.sourceVersionNumber ||
        version.contentStorageKey !== input.storageKey ||
        version.checksum !== input.checksum ||
        Number(version.sizeBytes) !== input.sizeBytes
      ) {
        throw new Error(`Notebook Artifact input identity is corrupt: ${input.inputFileVersionId}`)
      }
    }
  }

  private async projectExecutionInput(
    input: NotebookRunInputFile
  ): Promise<ProvenanceExecutionInputFile> {
    const { storageKey: inputStorageKey, ...safeInput } = input
    const content = await readOptionalFile(
      resolveStorageKey(this.options.storageRoot, inputStorageKey)
    )
    return {
      ...safeInput,
      availability: !content
        ? { state: 'unavailable', reason: 'input-content-missing' }
        : sha256(content) === input.checksum
          ? { state: 'available' }
          : { state: 'unavailable', reason: 'input-content-corrupt' }
    }
  }

  private async loadFinalizationSession(
    request: FinalizeArtifactVersionsRequest
  ): Promise<PersistedChatSession> {
    if (!this.options.loadSession) {
      throw new Error('Artifact finalization requires the durable Session graph authority.')
    }
    const durableSession = await this.options.loadSession(request.projectId, request.appSessionId)
    if (
      !durableSession ||
      durableSession.projectId !== request.projectId ||
      durableSession.id !== request.appSessionId
    ) {
      throw new Error('Artifact finalization durable Session graph is unavailable.')
    }
    return durableSession
  }

  async validateFinalizationOwnership(request: FinalizeArtifactVersionsRequest): Promise<void> {
    const durableSession = await this.loadFinalizationSession(request)
    validateDurableMessageOwnership(durableSession, request)
  }

  async finalizeRun(request: FinalizeArtifactVersionsRequest): Promise<ArtifactVersionFile[]> {
    const durableSession = await this.loadFinalizationSession(request)
    return this.finalizeRunWithDurableSession(request, durableSession)
  }

  private async finalizeRunWithDurableSession(
    request: FinalizeArtifactVersionsRequest,
    durableSession: PersistedChatSession
  ): Promise<ArtifactVersionFile[]> {
    const ancestry = validateDurableMessageOwnership(durableSession, request)
    return this.finalizeVerifiedRun({ ...request, ...ancestry })
  }

  private async finalizeVerifiedRun(
    request: FinalizeArtifactVersionsRequest
  ): Promise<ArtifactVersionFile[]> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const rootFrameId = assertSafeSegment(request.rootFrameId, 'root frame id')
    const agentFrameId = assertSafeSegment(request.agentFrameId, 'agent frame id')
    const messageBranchId = assertSafeSegment(request.messageBranchId, 'message branch id')
    const runtimeSegmentId = assertSafeSegment(request.runtimeSegmentId, 'runtime segment id')
    const promptMessageId = assertSafeSegment(request.promptMessageId, 'prompt message id')
    const messageId = assertSafeSegment(request.messageId, 'message id')
    const client = await this.options.getClient()
    const versions = await client.$transaction(async (transaction) => {
      const matching = await transaction.artifactVersion.findMany({
        where: {
          artifactRunId,
          rootFrameId,
          agentFrameId,
          messageBranchId,
          runtimeSegmentId,
          promptMessageId,
          state: { in: ['pending', 'finalized'] },
          artifact: { is: { projectId, sessionId: appSessionId } }
        },
        include: { artifact: true },
        orderBy: [{ artifactId: 'asc' }, { versionNumber: 'asc' }]
      })
      const conflicting = matching.find(
        (version) => version.messageId && version.messageId !== messageId
      )
      if (conflicting) {
        throw new Error(
          `Artifact Version ${conflicting.id} is already finalized to a different message.`
        )
      }

      await transaction.artifactVersion.updateMany({
        where: {
          id: { in: matching.map((version) => version.id) },
          state: 'pending'
        },
        data: { state: 'finalized', messageId }
      })

      return transaction.artifactVersion.findMany({
        where: {
          id: { in: matching.map((version) => version.id) },
          state: 'finalized'
        },
        include: { artifact: true },
        orderBy: [{ artifactId: 'asc' }, { versionNumber: 'asc' }]
      })
    })

    return Promise.all(
      versions.map((version) =>
        this.toArtifactVersionFile(
          version,
          version.artifact.projectId,
          version.artifact.sessionId,
          version.artifact.filename
        )
      )
    )
  }

  async listRunVersions(request: {
    projectId: string
    appSessionId: string
    artifactRunId: string
  }): Promise<ArtifactVersionFile[]> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const client = await this.options.getClient()
    const versions = await client.artifactVersion.findMany({
      where: {
        artifactRunId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      include: { artifact: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })

    return Promise.all(
      versions.map((version) =>
        this.toArtifactVersionFile(version, projectId, appSessionId, version.artifact.filename)
      )
    )
  }

  async reconcileSession(
    projectIdInput: string,
    appSessionIdInput: string,
    durableSession?: PersistedChatSession
  ): Promise<ArtifactStorageReconciliationResult> {
    const projectId = assertSafeSegment(projectIdInput, 'project id')
    const appSessionId = assertSafeSegment(appSessionIdInput, 'app session id')
    const provenanceRoot = resolveStorageKey(
      this.options.storageRoot,
      storageKey('artifacts', projectId, appSessionId, '.provenance')
    )
    const result: ArtifactStorageReconciliationResult = {
      recoveredVersionIds: [],
      quarantinedVersionIds: []
    }
    const lineageEntries = await readdir(provenanceRoot, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          return []
        }
        throw error
      }
    )
    const client = await this.options.getClient()
    const stagingVersions = await client.artifactVersion.findMany({
      where: {
        state: 'staging',
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      include: { artifact: true }
    })

    // A crash can leave a complete staging row after its immutable bytes were copied but before the
    // final state update. Resume those rows from SQLite authority before scanning unindexed folders.
    for (const version of stagingVersions) {
      try {
        await this.recoverStagingVersion(
          version,
          projectId,
          appSessionId,
          version.artifact.filename
        )
        result.recoveredVersionIds.push(version.id)
      } catch (error) {
        // A transient/unrelated compatibility I/O error proves only that the scan was incomplete.
        // Leave the authoritative staging row untouched so a later startup can retry; quarantine is
        // reserved for a complete scan that positively fails the recovery proof.
        if (error instanceof ArtifactCompatibilityScanIncompleteError) continue
        const stillStaging = await client.artifactVersion.findUnique({
          where: { id: version.id },
          select: { state: true }
        })
        if (stillStaging?.state !== 'staging') continue

        // A staging row that cannot be resumed must not poison the operation forever. Preserve any
        // bytes for diagnosis under quarantine, then remove only the still-staging row so an exact
        // retry can start cleanly instead of colliding with a permanently broken lifecycle record.
        const quarantineDirectory = join(
          provenanceRoot,
          '.quarantine',
          'staging-invalid',
          version.artifactId,
          `${version.id}-${this.createId()}`
        )
        await mkdir(quarantineDirectory, { recursive: true })
        const stagingDirectory = join(provenanceRoot, '.staging', 'versions', version.id)
        const finalDirectory = dirname(
          resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
        )
        await moveDirectoryIfPresent(stagingDirectory, join(quarantineDirectory, 'staging'))
        await moveDirectoryIfPresent(finalDirectory, join(quarantineDirectory, 'published'))
        const deleted = await client.artifactVersion.deleteMany({
          where: { id: version.id, state: 'staging' }
        })
        if (deleted.count === 1) result.quarantinedVersionIds.push(version.id)
      }
    }

    // Compatibility finalization publishes its marker before moving files. If the process exits after
    // that commit but before SQLite finalization, replay only when the marker context and the durable
    // conversation graph independently prove the same Branch/message ownership.
    if (
      durableSession &&
      durableSession.projectId === projectId &&
      durableSession.id === appSessionId &&
      this.options.compatibilityRepository
    ) {
      const pendingVersions = await client.artifactVersion.findMany({
        where: {
          state: 'pending',
          artifact: { is: { projectId, sessionId: appSessionId } }
        }
      })
      const runIds = [...new Set(pendingVersions.map((version) => version.artifactRunId))]
      for (const artifactRunId of runIds) {
        const marker = await this.options.compatibilityRepository.findRunFinalizationMarker(
          projectId,
          artifactRunId
        )
        const markerContext = marker?.provenanceContext
        if (!marker || marker.sessionId !== appSessionId || !markerContext) continue
        const runVersions = pendingVersions.filter(
          (version) => version.artifactRunId === artifactRunId
        )
        if (
          runVersions.length === 0 ||
          runVersions.some(
            (version) =>
              version.rootFrameId !== markerContext.rootFrameId ||
              version.agentFrameId !== markerContext.agentFrameId ||
              version.messageBranchId !== markerContext.messageBranchId ||
              version.runtimeSegmentId !== markerContext.runtimeSegmentId ||
              version.promptMessageId !== markerContext.promptMessageId
          )
        ) {
          continue
        }
        try {
          const ancestry = validateDurableMessageOwnership(durableSession, {
            ...markerContext,
            messageId: marker.messageId
          })
          const finalized = await this.finalizeRunWithDurableSession(
            {
              projectId,
              appSessionId,
              artifactRunId,
              ...markerContext,
              messageId: marker.messageId,
              ...ancestry
            },
            durableSession
          )
          result.recoveredVersionIds.push(...finalized.map((version) => version.versionId!))
        } catch {
          // Leave the pending Version visible and retryable; an unproven marker is never guessed.
        }
      }
    }

    for (const lineageEntry of lineageEntries) {
      if (
        !lineageEntry.isDirectory() ||
        lineageEntry.name === '.staging' ||
        lineageEntry.name === '.quarantine' ||
        !SAFE_SEGMENT_PATTERN.test(lineageEntry.name)
      ) {
        continue
      }
      const versionsRoot = join(provenanceRoot, lineageEntry.name, 'versions')
      const versionEntries = await readdir(versionsRoot, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: unknown }).code === 'ENOENT'
          ) {
            return []
          }
          throw error
        }
      )
      for (const versionEntry of versionEntries) {
        if (!versionEntry.isDirectory() || !SAFE_SEGMENT_PATTERN.test(versionEntry.name)) continue
        const existing = await client.artifactVersion.findUnique({
          where: { id: versionEntry.name },
          select: { id: true }
        })
        if (existing) continue

        const versionDirectory = join(versionsRoot, versionEntry.name)
        try {
          await this.recoverUnindexedFinalizedVersion({
            projectId,
            appSessionId,
            artifactId: lineageEntry.name,
            versionId: versionEntry.name,
            versionDirectory
          })
          result.recoveredVersionIds.push(versionEntry.name)
        } catch (error) {
          // Do not turn an unreadable sidecar elsewhere in the Project into evidence that this
          // immutable Version is unowned. An incomplete scan is retryable, not quarantine proof.
          if (error instanceof ArtifactCompatibilityScanIncompleteError) continue
          // A concurrent reconciler may have inserted the same immutable row. Re-check before moving
          // anything; only a still-unowned directory is eligible for quarantine.
          const wonByAnotherWriter = await client.artifactVersion.findUnique({
            where: { id: versionEntry.name },
            select: { id: true }
          })
          if (wonByAnotherWriter) continue
          const quarantineDirectory = join(
            provenanceRoot,
            '.quarantine',
            'recovered-unlinked',
            lineageEntry.name,
            `${versionEntry.name}-${this.createId()}`
          )
          await mkdir(dirname(quarantineDirectory), { recursive: true })
          await rename(versionDirectory, quarantineDirectory)
          result.quarantinedVersionIds.push(versionEntry.name)
        }
      }
    }
    return result
  }

  private async recoverUnindexedFinalizedVersion(input: {
    projectId: string
    appSessionId: string
    artifactId: string
    versionId: string
    versionDirectory: string
  }): Promise<void> {
    const evidenceJson = await readFile(join(input.versionDirectory, 'evidence.json'), 'utf8')
    const evidence = recordValue(JSON.parse(evidenceJson))
    if (!evidence || canonicalJson(evidence as CanonicalJson) !== evidenceJson) {
      throw new Error('Recovered Artifact evidence is not canonical.')
    }
    const filename = stringValue(evidence.filename)
    const versionNumber = numberValue(evidence.version_number)
    const sizeBytes = numberValue(evidence.size_bytes)
    const checksum = stringValue(evidence.checksum)
    const createdAtValue = stringValue(evidence.created_at)
    const conversation = recordValue(evidence.conversation)
    if (
      evidence.schema_version !== 1 ||
      evidence.project_id !== input.projectId ||
      evidence.app_session_id !== input.appSessionId ||
      evidence.artifact_id !== input.artifactId ||
      evidence.version_id !== input.versionId ||
      !filename ||
      !validRecoveryFilename(filename) ||
      !Number.isInteger(versionNumber) ||
      (versionNumber ?? 0) < 1 ||
      !Number.isSafeInteger(sizeBytes) ||
      (sizeBytes ?? -1) < 0 ||
      !checksum ||
      !SHA256_PATTERN.test(checksum) ||
      !createdAtValue ||
      Number.isNaN(Date.parse(createdAtValue)) ||
      !conversation
    ) {
      throw new Error('Recovered Artifact evidence identity is invalid.')
    }
    const rootFrameId = assertSafeSegment(
      stringValue(conversation.root_frame_id) ?? '',
      'root frame id'
    )
    const agentFrameId = assertSafeSegment(
      stringValue(conversation.agent_frame_id) ?? '',
      'agent frame id'
    )
    const messageBranchId = assertSafeSegment(
      stringValue(conversation.message_branch_id) ?? '',
      'message branch id'
    )
    const runtimeSegmentId = assertSafeSegment(
      stringValue(conversation.runtime_segment_id) ?? '',
      'runtime segment id'
    )
    const promptMessageId = assertSafeSegment(
      stringValue(conversation.prompt_message_id) ?? '',
      'prompt message id'
    )
    const content = await readFile(join(input.versionDirectory, 'content'))
    if (content.byteLength !== sizeBytes || sha256(content) !== checksum) {
      throw new Error('Recovered Artifact content is corrupt.')
    }

    const producer = recordValue(evidence.producer)
    const executionStatus = recordValue(evidence.execution_status)
    let executionSnapshotJson: string | undefined
    let executionSnapshotChecksum: string | undefined
    let producerRunId: string | undefined
    let producerRunIndex: number | undefined
    let notebookSessionId: string | undefined
    if (executionStatus?.state === 'available') {
      executionSnapshotJson = await readFile(join(input.versionDirectory, 'execution.json'), 'utf8')
      executionSnapshotChecksum = stringValue(evidence.execution_snapshot_checksum)
      if (
        !executionSnapshotChecksum ||
        sha256(executionSnapshotJson) !== executionSnapshotChecksum
      ) {
        throw new Error('Recovered Artifact execution snapshot is corrupt.')
      }
      const execution = recordValue(JSON.parse(executionSnapshotJson))
      producerRunId = stringValue(producer?.producer_run_id)
      producerRunIndex = numberValue(producer?.run_index)
      notebookSessionId = stringValue(producer?.notebook_session_id)
      if (
        !execution ||
        execution.schemaVersion !== 2 ||
        execution.producerRunId !== producerRunId ||
        execution.producerRunIndex !== producerRunIndex
      ) {
        throw new Error('Recovered Artifact producer binding is invalid.')
      }
    }

    const snapshot = await this.findOwningMessageSnapshot({
      projectId: input.projectId,
      appSessionId: input.appSessionId,
      versionId: input.versionId,
      rootFrameId,
      agentFrameId,
      messageBranchId
    })
    const pendingRoute = await this.compatibilityRepository.findPendingVersionRouting({
      projectName: input.projectId,
      artifactId: input.artifactId,
      versionId: input.versionId
    })
    if (snapshot && pendingRoute) {
      throw new Error('Recovered Artifact has conflicting finalized and pending ownership proofs.')
    }
    if (!snapshot && !pendingRoute) {
      throw new Error('Recovered Artifact has no exact lifecycle ownership proof.')
    }
    if (
      pendingRoute &&
      (pendingRoute.versionNumber !== versionNumber ||
        normalizeFilename(pendingRoute.filename) !== normalizeFilename(filename) ||
        pendingRoute.checksum !== checksum ||
        (pendingRoute.mimeType ?? undefined) !== (stringValue(evidence.content_type) ?? undefined))
    ) {
      throw new Error('Recovered Artifact pending routing does not match immutable evidence.')
    }

    const rawInputs = Array.isArray(evidence.inputs) ? evidence.inputs : []
    const inputs = rawInputs.map((value, index) => {
      const item = recordValue(value)
      const sourceKind = stringValue(item?.source_kind)
      const inputFileVersionId = stringValue(item?.input_file_version_id)
      const sourceFileId = stringValue(item?.source_file_id)
      const sourceProjectId = stringValue(item?.source_project_id)
      const sourceSessionId = stringValue(item?.source_session_id)
      const inputFilename = stringValue(item?.filename)
      const inputChecksum = stringValue(item?.checksum)
      const storageKeyValue = stringValue(item?.storage_key)
      const inputSize = numberValue(item?.size_bytes)
      if (
        item?.ordinal !== index ||
        (sourceKind !== 'artifact-version' && sourceKind !== 'upload-version') ||
        !inputFileVersionId ||
        !sourceFileId ||
        !sourceProjectId ||
        !sourceSessionId ||
        !inputFilename ||
        !inputChecksum ||
        !storageKeyValue ||
        !Number.isSafeInteger(inputSize)
      ) {
        throw new Error('Recovered Artifact input evidence is invalid.')
      }
      return {
        id: this.createId(),
        ordinal: index,
        inputFileVersionId,
        sourceKind,
        sourceFileId,
        sourceArtifactVersionId: sourceKind === 'artifact-version' ? inputFileVersionId : undefined,
        sourceUploadVersionId: sourceKind === 'upload-version' ? inputFileVersionId : undefined,
        sourceVersionNumber: numberValue(item.source_version_number),
        sourceCreatedAt: stringValue(item.source_created_at)
          ? new Date(stringValue(item.source_created_at)!)
          : undefined,
        sourceProjectId,
        sourceSessionId,
        filename: inputFilename,
        contentType: stringValue(item.content_type),
        sizeBytes: BigInt(inputSize!),
        checksum: inputChecksum,
        storageKey: storageKeyValue,
        strongestAssociation: stringValue(item.strongest_association) ?? 'captured-version'
      }
    })

    const client = await this.options.getClient()
    await client.$transaction(async (transaction) => {
      await transaction.fileOriginSession.upsert({
        where: {
          projectId_sessionId: { projectId: input.projectId, sessionId: input.appSessionId }
        },
        create: { projectId: input.projectId, sessionId: input.appSessionId },
        update: {}
      })
      const normalizedFilename = normalizeFilename(filename)
      const lineageByName = await transaction.artifactLineage.findUnique({
        where: {
          projectId_sessionId_normalizedFilename: {
            projectId: input.projectId,
            sessionId: input.appSessionId,
            normalizedFilename
          }
        }
      })
      if (lineageByName && lineageByName.id !== input.artifactId) {
        throw new Error('Recovered Artifact lineage conflicts with an existing filename identity.')
      }
      const lineageById = await transaction.artifactLineage.findUnique({
        where: { id: input.artifactId }
      })
      if (
        lineageById &&
        (lineageById.projectId !== input.projectId ||
          lineageById.sessionId !== input.appSessionId ||
          lineageById.normalizedFilename !== normalizedFilename)
      ) {
        throw new Error('Recovered Artifact lineage ownership conflicts with SQLite.')
      }
      if (!lineageById) {
        await transaction.artifactLineage.create({
          data: {
            id: input.artifactId,
            projectId: input.projectId,
            sessionId: input.appSessionId,
            normalizedFilename,
            filename
          }
        })
      }
      await transaction.artifactVersion.create({
        data: {
          id: input.versionId,
          artifactId: input.artifactId,
          versionNumber: versionNumber!,
          artifactRunId: pendingRoute?.artifactRunId ?? `recovered-${input.versionId}`,
          rootFrameId,
          agentFrameId,
          messageBranchId,
          runtimeSegmentId,
          promptMessageId,
          notebookSessionId,
          producerRunId,
          producerRunIndex,
          messageId: snapshot?.terminalMessageId,
          messageSnapshotId: snapshot?.id,
          state: snapshot ? 'finalized' : 'pending',
          contentStorageKey: storageKey(
            'artifacts',
            input.projectId,
            input.appSessionId,
            '.provenance',
            input.artifactId,
            'versions',
            input.versionId,
            'content'
          ),
          evidenceStorageKey: storageKey(
            'artifacts',
            input.projectId,
            input.appSessionId,
            '.provenance',
            input.artifactId,
            'versions',
            input.versionId,
            'evidence.json'
          ),
          contentType: stringValue(evidence.content_type),
          sizeBytes: BigInt(sizeBytes!),
          checksum,
          evidenceJson,
          evidenceChecksum: sha256(evidenceJson),
          executionSnapshotJson,
          executionSnapshotChecksum,
          executionSnapshotStorageKey: executionSnapshotJson
            ? storageKey(
                'artifacts',
                input.projectId,
                input.appSessionId,
                '.provenance',
                input.artifactId,
                'versions',
                input.versionId,
                'execution.json'
              )
            : undefined,
          executionSnapshotSchemaVersion: executionSnapshotJson ? 2 : undefined,
          ...(inputs.length > 0 ? { inputs: { create: inputs } } : {}),
          createdAt: new Date(createdAtValue)
        }
      })
    })
  }

  private async findOwningMessageSnapshot(input: {
    projectId: string
    appSessionId: string
    versionId: string
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
  }): Promise<{ id: string; terminalMessageId: string } | undefined> {
    const client = await this.options.getClient()
    const candidates = await client.artifactMessageSnapshot.findMany({
      where: {
        projectId: input.projectId,
        sessionId: input.appSessionId,
        rootFrameId: input.rootFrameId,
        agentFrameId: input.agentFrameId,
        messageBranchId: input.messageBranchId,
        state: 'ready'
      }
    })
    const matches: Array<{ id: string; terminalMessageId: string }> = []
    for (const candidate of candidates) {
      try {
        const serialized = await readFile(
          resolveStorageKey(this.options.storageRoot, candidate.storageKey),
          'utf8'
        )
        if (!candidate.checksum || sha256(serialized) !== candidate.checksum) continue
        const payload = recordValue(JSON.parse(serialized))
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const messageRecords = messages.map(recordValue)
        const messageIds = new Set(messageRecords.map((message) => stringValue(message?.id)))
        const hasCompleteParentChain = messageRecords.every((message, index) => {
          if (!message || !stringValue(message.id)) return false
          const parentMessageId = stringValue(message.parentMessageId)
          return index === 0
            ? parentMessageId === undefined
            : parentMessageId === stringValue(messageRecords[index - 1]?.id)
        })
        const terminal = recordValue(messages.at(-1))
        const artifacts = Array.isArray(terminal?.artifacts) ? terminal.artifacts : []
        const parts = Array.isArray(terminal?.parts) ? terminal.parts : []
        const ownsVersion =
          artifacts.some((artifact) => recordValue(artifact)?.versionId === input.versionId) ||
          parts.some(
            (part) =>
              recordValue(part)?.type === 'artifact' &&
              recordValue(part)?.versionId === input.versionId
          )
        if (
          (payload?.schemaVersion === 2 || payload?.schemaVersion === 3) &&
          payload?.snapshotId === candidate.id &&
          payload.rootFrameId === input.rootFrameId &&
          payload.agentFrameId === input.agentFrameId &&
          payload.messageBranchId === input.messageBranchId &&
          payload.terminalMessageId === candidate.terminalMessageId &&
          messages.length === candidate.messageCount &&
          messageIds.size === messages.length &&
          hasCompleteParentChain &&
          (payload.schemaVersion !== 3 ||
            (Array.isArray(payload.activities) && Array.isArray(payload.activityGroups))) &&
          terminal?.id === candidate.terminalMessageId &&
          ownsVersion
        ) {
          matches.push({ id: candidate.id, terminalMessageId: candidate.terminalMessageId })
        }
      } catch {
        // A corrupt candidate cannot prove ownership; another valid snapshot may still do so.
      }
    }
    return matches.length === 1 ? matches[0] : undefined
  }

  async getLineage(request: GetArtifactLineageRequest): Promise<ArtifactLineageProvenance> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    const artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    const client = await this.options.getClient()
    let lineage = await client.artifactLineage.findFirst({
      where: { id: artifactId, projectId, sessionId: appSessionId },
      include: {
        originSession: true,
        versions: {
          where: { state: { in: ['pending', 'finalized'] } },
          orderBy: [{ versionNumber: 'asc' }, { id: 'asc' }]
        }
      }
    })
    if (!lineage) {
      await this.reconcileSession(projectId, appSessionId)
      lineage = await client.artifactLineage.findFirst({
        where: { id: artifactId, projectId, sessionId: appSessionId },
        include: {
          originSession: true,
          versions: {
            where: { state: { in: ['pending', 'finalized'] } },
            orderBy: [{ versionNumber: 'asc' }, { id: 'asc' }]
          }
        }
      })
    }
    if (!lineage) throw new Error(`Artifact lineage not found: ${artifactId}`)

    const versions = await Promise.all(
      lineage.versions.map(async (version) =>
        this.toDescriptor(version, projectId, lineage.sessionId, lineage.filename)
      )
    )
    return {
      artifactId: lineage.id,
      filename: lineage.filename,
      originSession: {
        sessionId: lineage.sessionId,
        state: lineage.originSession.state as 'active' | 'deleting' | 'deleted',
        title: lineage.originSession.titleSnapshot ?? undefined,
        deletedAt: lineage.originSession.deletedAt?.toISOString()
      },
      versions
    }
  }

  async getVersionProvenance(
    request: GetArtifactVersionProvenanceRequest,
    sections: { execution: boolean; messages: boolean; review: boolean } = {
      execution: true,
      messages: true,
      review: true
    }
  ): Promise<ArtifactVersionProvenance> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'app session id')
    const artifactId = assertSafeSegment(request.artifactId, 'artifact id')
    const versionId = assertSafeSegment(request.versionId, 'version id')
    const client = await this.options.getClient()
    let version = await client.artifactVersion.findFirst({
      where: {
        id: versionId,
        artifactId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, sessionId: appSessionId } }
      },
      include: {
        artifact: true,
        messageSnapshot: true,
        inputs: { orderBy: { ordinal: 'asc' } }
      }
    })
    if (!version) {
      await this.reconcileSession(projectId, appSessionId)
      version = await client.artifactVersion.findFirst({
        where: {
          id: versionId,
          artifactId,
          state: { in: ['pending', 'finalized'] },
          artifact: { is: { projectId, sessionId: appSessionId } }
        },
        include: {
          artifact: true,
          messageSnapshot: true,
          inputs: { orderBy: { ordinal: 'asc' } }
        }
      })
    }
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)

    const evidencePath = resolveStorageKey(this.options.storageRoot, version.evidenceStorageKey)
    const evidenceMirror = await this.ensureCanonicalMirror(
      evidencePath,
      version.evidenceJson,
      version.evidenceChecksum,
      `Artifact Version evidence is corrupt: ${versionId}`
    )
    const evidence = JSON.parse(evidenceMirror) as ArtifactVersionEvidence
    const contentPath = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const contentStatus: ArtifactVersionProvenance['contentStatus'] = await readFile(contentPath)
      .then((content) =>
        sha256(content) === version.checksum
          ? ({ state: 'available' } as const)
          : ({ state: 'unavailable', reason: 'checksum-mismatch' } as const)
      )
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          return { state: 'unavailable', reason: 'missing' } as const
        }
        throw error
      })

    let execution: ArtifactExecutionSnapshot | undefined
    if (
      sections.execution &&
      version.executionSnapshotJson &&
      version.executionSnapshotChecksum &&
      version.executionSnapshotStorageKey
    ) {
      const executionMirror = await this.ensureCanonicalMirror(
        resolveStorageKey(this.options.storageRoot, version.executionSnapshotStorageKey),
        version.executionSnapshotJson,
        version.executionSnapshotChecksum,
        `Artifact Version execution snapshot is corrupt: ${versionId}`
      )
      const persistedExecution = parseArtifactExecutionSnapshot(executionMirror)
      validateArtifactExecutionSnapshot(persistedExecution, {
        rootFrameId: version.rootFrameId,
        agentFrameId: version.agentFrameId,
        messageBranchId: version.messageBranchId,
        promptMessageId: version.promptMessageId,
        producerRunId: version.producerRunId,
        producerRunIndex: version.producerRunIndex,
        executionSnapshotChecksum: version.executionSnapshotChecksum,
        evidence
      })
      validateArtifactExecutionInputs(persistedExecution, evidence, version.inputs)
      execution = {
        ...persistedExecution,
        inputFiles: await Promise.all(
          persistedExecution.inputFiles.map((input) => this.projectExecutionInput(input))
        )
      }
    }

    let messages: ArtifactVersionProvenance['messages'] = {
      state: 'unavailable',
      reason: sections.messages ? 'message-snapshot-pending' : 'not-loaded'
    }
    if (sections.messages && version.messageSnapshot?.state === 'ready') {
      try {
        const serializedSnapshot = await readFile(
          resolveStorageKey(this.options.storageRoot, version.messageSnapshot.storageKey),
          'utf8'
        )
        const snapshotChecksum = sha256(serializedSnapshot)
        if (
          version.messageSnapshot.checksum &&
          version.messageSnapshot.checksum !== snapshotChecksum
        ) {
          throw new Error('Message snapshot checksum mismatch.')
        }
        const snapshot = JSON.parse(serializedSnapshot) as ArtifactMessageSnapshotFile
        const hasValidPath = snapshot.messages.every(
          (message, index) =>
            index === 0 || message.parentMessageId === snapshot.messages[index - 1]?.id
        )
        if (
          (snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) ||
          snapshot.snapshotId !== version.messageSnapshot.id ||
          snapshot.rootFrameId !== version.rootFrameId ||
          snapshot.agentFrameId !== version.agentFrameId ||
          snapshot.messageBranchId !== version.messageBranchId ||
          snapshot.terminalMessageId !== version.messageId ||
          snapshot.messages.length !== version.messageSnapshot.messageCount ||
          snapshot.messages.at(-1)?.id !== version.messageId ||
          !hasValidPath
        ) {
          throw new Error('Message snapshot metadata mismatch.')
        }
        if (
          snapshot.schemaVersion === 3 &&
          (!Array.isArray(snapshot.activities) || !Array.isArray(snapshot.activityGroups))
        ) {
          throw new Error('Message snapshot activity metadata mismatch.')
        }
        if (!version.messageSnapshot.checksum) {
          const updated = await client.artifactMessageSnapshot.updateMany({
            where: { id: version.messageSnapshot.id, state: 'ready', checksum: '' },
            data: { checksum: snapshotChecksum }
          })
          if (updated.count !== 1) throw new Error('Message snapshot checksum backfill raced.')
        }
        const rawActivities = snapshot.schemaVersion === 3 ? snapshot.activities : []
        const rawActivityGroups = snapshot.schemaVersion === 3 ? snapshot.activityGroups : []
        const activities = rawActivities.flatMap((activity) => {
          const sanitized = sanitizeToolActivity(activity)
          return sanitized ? [sanitized] : []
        })
        const activityGroups = rawActivityGroups.flatMap((group) => {
          const sanitized = sanitizeActivityGroup(group)
          return sanitized ? [sanitized] : []
        })
        const activityIds = new Set(activities.map((activity) => activity.id))
        if (
          activities.length !== rawActivities.length ||
          activityGroups.length !== rawActivityGroups.length ||
          activityGroups.some((group) =>
            group.activityIds.some((activityId) => !activityIds.has(activityId))
          )
        ) {
          throw new Error('Message snapshot activity metadata mismatch.')
        }
        messages = { state: 'available', items: snapshot.messages, activities, activityGroups }
      } catch {
        messages = { state: 'unavailable', reason: 'message-snapshot-corrupt' }
      }
    }

    let review: ArtifactVersionProvenance['review'] = {
      state: 'unavailable',
      reason: sections.review ? 'not-triggered' : 'not-loaded'
    }
    if (sections.review) {
      const reviewRows = await client.review.findMany({
        where: { projectId, sessionId: version.artifact.sessionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      })
      const provenanceReviews: ReviewWithProvenanceEvidence[] = await Promise.all(
        reviewRows.map(async (reviewRow) => {
          const [checkRows, snapshot] = await Promise.all([
            client.finding.findMany({
              where: { reviewId: reviewRow.id },
              orderBy: [{ sortIndex: 'asc' }, { id: 'asc' }]
            }),
            client.reviewScopeSnapshot.findUnique({ where: { reviewId: reviewRow.id } })
          ])
          let scopeSnapshot: ReviewWithProvenanceEvidence['scopeSnapshot'] = {
            state: 'unavailable',
            reason: snapshot ? 'pending' : 'legacy'
          }
          if (snapshot?.state === 'ready') {
            try {
              const payload = JSON.parse(snapshot.snapshotJson) as {
                schemaVersion?: unknown
                blocks?: unknown
              }
              if (
                (payload.schemaVersion !== 1 && payload.schemaVersion !== 2) ||
                !Array.isArray(payload.blocks) ||
                sha256(snapshot.snapshotJson) !== snapshot.checksum
              ) {
                throw new Error('Review scope snapshot checksum mismatch.')
              }
              scopeSnapshot = {
                state: 'available',
                blocks: payload.blocks as ReviewScopeSnapshotBlock[]
              }
            } catch {
              scopeSnapshot = { state: 'unavailable', reason: 'corrupt' }
            }
          }
          return {
            ...toReview(reviewRow),
            checks: checkRows.map(toCheck),
            scopeSnapshot
          }
        })
      )
      // Active Sessions are re-resolved before their verdict is projected so edits cannot make an old
      // pass look current. Deleted origins intentionally keep their frozen historical verdict: there is
      // no live conversation to recompute and Provenance never offers a re-run from this surface.
      const origin = await client.fileOriginSession.findUnique({
        where: {
          projectId_sessionId: { projectId, sessionId: version.artifact.sessionId }
        },
        select: { state: true }
      })
      let sourceSessionUnavailable = false
      let resolvedReviews = provenanceReviews
      if (this.options.loadSession && origin?.state === 'active') {
        const session = await this.options
          .loadSession(projectId, version.artifact.sessionId)
          .catch(() => undefined)
        if (
          !session ||
          session.projectId !== projectId ||
          session.id !== version.artifact.sessionId
        ) {
          sourceSessionUnavailable = provenanceReviews.length > 0
        } else {
          resolvedReviews = (
            await flagStaleReviews(provenanceReviews, session, this.options.storageRoot)
          ).map((review, index) => ({ ...provenanceReviews[index]!, stale: review.stale }))
        }
      }
      const findingIds = resolvedReviews.flatMap((candidate) =>
        candidate.checks.map((check) => check.id)
      )
      const dispositionRows =
        findingIds.length > 0
          ? await client.reviewFindingDisposition.findMany({
              where: { sourceFindingId: { in: findingIds } },
              orderBy: [{ createdAt: 'asc' }, { sequence: 'asc' }, { id: 'asc' }]
            })
          : []
      if (sourceSessionUnavailable) {
        review = { state: 'unavailable', reason: 'source-session-unavailable' }
      } else {
        const projection = selectReviewChainForArtifactVersion({
          selectedVersionId: versionId,
          versionMessageId: version.messageId ?? undefined,
          reviews: resolvedReviews,
          dispositions: dispositionRows.map((disposition) => ({
            id: disposition.id,
            sourceFindingId: disposition.sourceFindingId,
            causeReviewId: disposition.causeReviewId ?? undefined,
            sequence: disposition.sequence,
            trigger: disposition.trigger as ReviewFindingDispositionTrigger,
            outcome: disposition.outcome as ReviewFindingDispositionOutcome,
            note: disposition.note ?? undefined,
            assessedArtifactVersionId: disposition.assessedArtifactVersionId ?? undefined,
            createdAt: disposition.createdAt.getTime()
          }))
        })
        if (projection) review = { state: 'available', value: projection }
      }
    }

    return {
      descriptor: await this.toDescriptor(
        version,
        projectId,
        version.artifact.sessionId,
        version.artifact.filename
      ),
      contentStatus,
      evidence,
      execution,
      messages,
      review
    }
  }

  async getVersionCore(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<ArtifactVersionProvenance> {
    return this.getVersionProvenance(request, {
      execution: false,
      messages: false,
      review: false
    })
  }

  async getVersionExecution(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'execution'>> {
    const value = await this.getVersionProvenance(request, {
      execution: true,
      messages: false,
      review: false
    })
    return { execution: value.execution }
  }

  async getVersionMessages(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'messages'>> {
    const value = await this.getVersionProvenance(request, {
      execution: false,
      messages: true,
      review: false
    })
    return { messages: value.messages }
  }

  async getVersionReview(
    request: GetArtifactVersionProvenanceRequest
  ): Promise<Pick<ArtifactVersionProvenance, 'review'>> {
    const value = await this.getVersionProvenance(request, {
      execution: false,
      messages: false,
      review: true
    })
    return { review: value.review }
  }

  // Resolves reviewer/preview reads through the Version authority rather than reconstructing a
  // legacy session path from an id. The checksum is verified before the caller receives the path.
  async resolveVersionContent(request: {
    projectId: string
    versionId: string
    appSessionId?: string
    artifactId?: string
  }): Promise<{ path: string; filename: string; contentType?: string }> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const versionId = assertSafeSegment(request.versionId, 'version id')
    const appSessionId = request.appSessionId
      ? assertSafeSegment(request.appSessionId, 'app session id')
      : undefined
    const artifactId = request.artifactId
      ? assertSafeSegment(request.artifactId, 'artifact id')
      : undefined
    const client = await this.options.getClient()
    const version = await client.artifactVersion.findFirst({
      where: {
        id: versionId,
        ...(artifactId ? { artifactId } : {}),
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId, ...(appSessionId ? { sessionId: appSessionId } : {}) } }
      },
      include: { artifact: true }
    })
    if (!version) throw new Error(`Artifact Version not found: ${versionId}`)

    const path = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const bytes = await readFile(path)
    if (sha256(bytes) !== version.checksum) {
      throw new Error(`Artifact Version content checksum mismatch: ${versionId}`)
    }
    return {
      path,
      filename: version.artifact.filename,
      contentType: version.contentType ?? undefined
    }
  }

  // Project deletion is the terminal provenance boundary. Session deletion intentionally keeps this
  // graph; deleting the Project removes every SQLite authority row plus immutable managed bytes.
  async deleteProjectProvenance(projectIdValue: string): Promise<void> {
    const projectId = assertSafeSegment(projectIdValue, 'project id')
    const client = await this.options.getClient()
    const uploadVersions = await client.uploadVersion.findMany({
      where: { uploadFile: { is: { projectId } } },
      select: { contentStorageKey: true }
    })

    // Delete managed Upload bytes while their authority rows still make the operation replayable.
    // Any failure leaves the Project deletion intent and storage keys available for a later retry.
    for (const version of uploadVersions) {
      await rm(resolveStorageKey(this.options.storageRoot, version.contentStorageKey), {
        force: true
      })
    }

    await client.$transaction(async (tx) => {
      await tx.artifactVersionInput.deleteMany({
        where: {
          OR: [
            { sourceProjectId: projectId },
            { artifactVersion: { is: { artifact: { is: { projectId } } } } }
          ]
        }
      })
      await tx.artifactLineage.deleteMany({ where: { projectId } })
      await tx.uploadFile.deleteMany({ where: { projectId } })
      await tx.artifactMessageSnapshot.deleteMany({ where: { projectId } })
      await tx.fileOriginSession.deleteMany({ where: { projectId } })
    })

    await rm(resolveStorageKey(this.options.storageRoot, storageKey('artifacts', projectId)), {
      recursive: true,
      force: true
    })
  }

  private async toArtifactVersionFile(
    version: PersistedVersionFileRecord,
    projectId: string,
    appSessionId: string,
    filename: string
  ): Promise<ArtifactVersionFile> {
    const filePath = resolveStorageKey(this.options.storageRoot, version.contentStorageKey)
    const fileMtimeMs = await stat(filePath)
      .then((fileStat) => fileStat.mtimeMs)
      .catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          return version.createdAt.getTime()
        }
        throw error
      })
    let environment: string | undefined
    if (version.executionSnapshotJson && version.producerRunId) {
      const snapshot = JSON.parse(version.executionSnapshotJson) as {
        runs?: Array<{ runId?: string; environmentName?: string }>
      }
      environment = snapshot.runs?.find(
        (run) => run.runId === version.producerRunId
      )?.environmentName
    }

    return {
      id: version.id,
      artifactId: version.artifactId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      checksum: version.checksum,
      createdAt: version.createdAt.toISOString(),
      producerRunId: version.producerRunId ?? undefined,
      environment,
      projectName: projectId,
      sessionId: appSessionId,
      runId: version.artifactRunId,
      name: filename,
      path: filePath,
      fileUrl: pathToFileURL(filePath).toString(),
      mimeType: version.contentType ?? undefined,
      size: Number(version.sizeBytes),
      mtimeMs: fileMtimeMs
    }
  }

  private async toDescriptor(
    version: PersistedVersionFileRecord & { state: string; messageId: string | null },
    projectId: string,
    appSessionId: string,
    filename: string
  ): Promise<ArtifactVersionDescriptor> {
    const file = await this.toArtifactVersionFile(version, projectId, appSessionId, filename)
    const { path, fileUrl, ...relocatableFile } = file
    void path
    void fileUrl
    return {
      ...relocatableFile,
      state: version.state as 'pending' | 'finalized',
      messageId: version.messageId ?? undefined
    }
  }
}

export { ArtifactProvenanceRepository }
export type { ArtifactProvenanceRepositoryOptions }

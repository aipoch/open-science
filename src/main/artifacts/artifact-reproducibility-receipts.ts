import type { ReproducibilitySource } from './reproducibility-source'
import type { Dirent } from 'node:fs'
import { validOutputComparisonReport } from './output-comparison'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  OUTPUT_DIRECTORY,
  reproducibilityOutputUsage,
  pruneReproducibilityOutputs,
  validateReproducibilityOutputs,
  readRetainedReproducibilityOutput,
  retainReproducibilityOutput
} from './artifact-reproducibility-outputs'

import type {
  ArtifactReproducibilityCheckLog,
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityCheckLogReference,
  ArtifactReproducibilityFailedAttempt,
  ArtifactReproducibilityReceipt,
  ArtifactReproducibilityReceiptPage,
  ArtifactReproducibilityReceiptScope,
  ArtifactReproducibilityOutputStorage,
  ArtifactReproducibilityReceiptComparison,
  GetArtifactReproducibilityCheckLogRequest,
  ListArtifactReproducibilityReceiptsRequest
} from '../../shared/artifact-reproducibility'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import {
  readReproducibilityEnvironmentLock,
  readReproducibilitySource
} from './reproducibility-source'

type ArtifactReproducibilityReceiptPayload = Omit<ArtifactReproducibilityReceipt, 'receiptChecksum'>

type ArtifactReproducibilityReceiptDraft = Omit<ArtifactReproducibilityReceiptPayload, 'checkLog'>

type ArtifactReproducibilityCheckLogDraft = {
  entries: ArtifactReproducibilityCheckLog[]
  truncated: boolean
}

type ArtifactReproducibilityFailedAttemptDraft = Omit<
  ArtifactReproducibilityFailedAttempt,
  'schemaVersion' | 'checkLog'
>

type ArtifactReproducibilityReceiptStoreDependencies = {
  resolveVersionDirectory(request: ArtifactReproducibilityReceiptScope): Promise<string>
}

const RECEIPT_DIRECTORY = 'reproducibility-checks'
const RETENTION_DIRECTORY = 'output-retention'
const CLEARED_OUTPUTS_FILENAME = 'cleared.json'
const decodeClearedOutputs = (contents: string): string[] => {
  const value = JSON.parse(contents)
  if (
    value?.schemaVersion !== 1 ||
    Object.keys(value).some((key) => !['schemaVersion', 'receiptChecksums'].includes(key)) ||
    !Array.isArray(value.receiptChecksums) ||
    value.receiptChecksums.some(
      (item: unknown) => typeof item !== 'string' || !/^[a-f0-9]{64}$/u.test(item)
    )
  )
    throw new Error('Invalid reproduced output retention record.')
  return [...new Set<string>(value.receiptChecksums)]
}
const clearedOutputReceipts = async (directory: string): Promise<string[]> => {
  const parent = await lstat(join(directory, RETENTION_DIRECTORY)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  )
  if (parent && !parent.isDirectory())
    throw new Error('Invalid reproduced output retention directory.')
  const record = await readDurableJsonFile(
    join(directory, RETENTION_DIRECTORY, CLEARED_OUTPUTS_FILENAME),
    decodeClearedOutputs
  )
  return record.status === 'found' ? record.value : []
}
const LOG_DIRECTORY = 'logs'
const FAILURE_DIRECTORY = 'failures'
const LATEST_FAILURE_FILENAME = 'latest.json'
const HISTORY_INDEX_FILENAME = 'history-index.json'
const RECEIPT_FILENAME = /^sha256-([0-9a-f]{64})\.json$/u
const LOG_FILENAME = /^sha256-([0-9a-f]{64})\.json$/u
const SHA256 = /^[0-9a-f]{64}$/u
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

type ReceiptHistoryIndexEntry = Pick<
  ArtifactReproducibilityReceipt,
  'receiptChecksum' | 'receiptId' | 'completedAt' | 'outcome'
>

type ReceiptHistoryIndex = {
  schemaVersion: 1
  receipts: ReceiptHistoryIndexEntry[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}
const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && SHA256.test(value)
const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isCheckLogReference = (value: unknown): value is ArtifactReproducibilityCheckLogReference =>
  isRecord(value) &&
  hasExactKeys(value, ['logChecksum', 'entryCount', 'sizeBytes', 'truncated']) &&
  isSha256(value.logChecksum) &&
  isSize(value.entryCount) &&
  isSize(value.sizeBytes) &&
  typeof value.truncated === 'boolean'

const isCheckLogEntry = (value: unknown): value is ArtifactReproducibilityCheckLog => {
  if (!isRecord(value)) return false
  const baseValid =
    ['python', 'r'].includes(String(value.kernelKind)) &&
    ['stdout', 'stderr'].includes(String(value.stream)) &&
    typeof value.text === 'string' &&
    (value.recordedAt === undefined || isTimestamp(value.recordedAt)) &&
    (value.truncated === undefined || typeof value.truncated === 'boolean')
  if (!baseValid) return false
  if (value.source === 'environment') {
    return (
      Object.keys(value).every((key) =>
        [
          'source',
          'requirementId',
          'environmentIndex',
          'environmentTotal',
          'kernelKind',
          'stream',
          'text',
          'recordedAt',
          'truncated'
        ].includes(key)
      ) &&
      isString(value.requirementId) &&
      isSize(value.environmentIndex) &&
      isSize(value.environmentTotal) &&
      value.environmentIndex < value.environmentTotal
    )
  }
  return (
    value.source === 'notebook' &&
    Object.keys(value).every((key) =>
      [
        'source',
        'stepId',
        'runIndex',
        'kernelKind',
        'stream',
        'text',
        'recordedAt',
        'truncated'
      ].includes(key)
    ) &&
    isString(value.stepId) &&
    isSize(value.runIndex)
  )
}

type CheckLogPayload = Omit<ArtifactReproducibilityCheckLogRecord, 'logChecksum'>

const checkLogPayload = (
  record: ArtifactReproducibilityCheckLogRecord
): ArtifactReproducibilityCheckLogDraft & { schemaVersion: 1; attemptId: string } => {
  const payload: Partial<ArtifactReproducibilityCheckLogRecord> = { ...record }
  delete payload.logChecksum
  return payload as CheckLogPayload
}

const decodeCheckLog = (
  filePath: string,
  contents: string
): ArtifactReproducibilityCheckLogRecord => {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error(`Invalid reproducibility check log JSON: ${basename(filePath)}`)
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'attemptId', 'entries', 'truncated', 'logChecksum']) ||
    value.schemaVersion !== 1 ||
    !isString(value.attemptId) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isCheckLogEntry) ||
    typeof value.truncated !== 'boolean' ||
    !isSha256(value.logChecksum)
  ) {
    throw new Error(`Invalid reproducibility check log: ${basename(filePath)}`)
  }
  const record = value as unknown as ArtifactReproducibilityCheckLogRecord
  const expectedChecksum = sha256(
    canonicalJson(checkLogPayload(record) as unknown as CanonicalJson)
  )
  const filenameChecksum = LOG_FILENAME.exec(basename(filePath))?.[1]
  if (record.logChecksum !== expectedChecksum || filenameChecksum !== expectedChecksum) {
    throw new Error(`Reproducibility check log checksum mismatch: ${basename(filePath)}`)
  }
  return record
}

const compareHistoryEntries = (
  left: ReceiptHistoryIndexEntry,
  right: ReceiptHistoryIndexEntry
): number =>
  right.completedAt.localeCompare(left.completedAt) ||
  right.receiptId.localeCompare(left.receiptId) ||
  right.receiptChecksum.localeCompare(left.receiptChecksum)

const historyEntry = (receipt: ArtifactReproducibilityReceipt): ReceiptHistoryIndexEntry => ({
  receiptChecksum: receipt.receiptChecksum,
  receiptId: receipt.receiptId,
  completedAt: receipt.completedAt,
  outcome: receipt.outcome
})

const sameHistoryEntry = (
  left: ReceiptHistoryIndexEntry,
  right: ReceiptHistoryIndexEntry
): boolean =>
  left.receiptChecksum === right.receiptChecksum &&
  left.receiptId === right.receiptId &&
  left.completedAt === right.completedAt &&
  left.outcome === right.outcome

const decodeReceiptHistoryIndex = (contents: string): ReceiptHistoryIndex => {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error('Invalid reproducibility receipt history index.')
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'receipts']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.receipts)
  ) {
    throw new Error('Invalid reproducibility receipt history index.')
  }
  const receipts: ReceiptHistoryIndexEntry[] = []
  const checksums = new Set<string>()
  for (const entry of value.receipts) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['receiptChecksum', 'receiptId', 'completedAt', 'outcome']) ||
      !isSha256(entry.receiptChecksum) ||
      !isString(entry.receiptId) ||
      !isTimestamp(entry.completedAt) ||
      !['matched', 'different'].includes(String(entry.outcome)) ||
      checksums.has(entry.receiptChecksum)
    ) {
      throw new Error('Invalid reproducibility receipt history index.')
    }
    checksums.add(entry.receiptChecksum)
    receipts.push(entry as ReceiptHistoryIndexEntry)
  }
  if (
    receipts.some(
      (entry, index) => index > 0 && compareHistoryEntries(receipts[index - 1]!, entry) > 0
    )
  ) {
    throw new Error('Invalid reproducibility receipt history index order.')
  }
  return { schemaVersion: 1, receipts }
}

const isComparison = (value: unknown): value is ArtifactReproducibilityReceiptComparison => {
  if (!isRecord(value)) return false
  const allowed = [
    'stepId',
    'entityId',
    'relativePath',
    'status',
    'reason',
    'expectedChecksum',
    'expectedSizeBytes',
    'actualChecksum',
    'actualSizeBytes',
    'outputCaptured',
    'outputCaptureReason',
    'contentComparison',
    'contentComparisonUnavailableReason'
  ]
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false
  if (
    !isString(value.stepId) ||
    !isString(value.entityId) ||
    !isString(value.relativePath) ||
    !['matched', 'different'].includes(String(value.status)) ||
    !isSha256(value.expectedChecksum) ||
    !isSize(value.expectedSizeBytes)
  ) {
    return false
  }
  if (value.actualChecksum !== undefined && !isSha256(value.actualChecksum)) return false
  if (value.actualSizeBytes !== undefined && !isSize(value.actualSizeBytes)) return false
  if (
    value.contentComparisonUnavailableReason !== undefined &&
    (value.contentComparison !== undefined ||
      !['unsupported-format', 'budget-exceeded', 'comparison-failed'].includes(
        String(value.contentComparisonUnavailableReason)
      ) ||
      (value.status === 'different' &&
        !['size-mismatch', 'checksum-mismatch'].includes(String(value.reason))))
  )
    return false
  if (
    value.contentComparison !== undefined &&
    !validOutputComparisonReport(
      value.contentComparison,
      String(value.expectedChecksum),
      value.actualChecksum
    )
  )
    return false
  if (
    value.outputCaptured !== undefined &&
    (value.outputCaptured !== true ||
      !isSha256(value.actualChecksum) ||
      !isSize(value.actualSizeBytes) ||
      value.status !== 'different' ||
      !['size-mismatch', 'checksum-mismatch'].includes(String(value.reason)) ||
      value.outputCaptureReason !== undefined)
  )
    return false
  if (
    value.outputCaptureReason !== undefined &&
    (value.status !== 'different' ||
      !['too-large', 'storage-limit', 'unavailable'].includes(String(value.outputCaptureReason)))
  )
    return false
  const reasonValid =
    value.reason === undefined ||
    ['missing', 'not-file', 'linked', 'size-mismatch', 'checksum-mismatch'].includes(
      String(value.reason)
    )
  if (!reasonValid) return false
  return value.status !== 'matched'
    ? true
    : value.reason === undefined &&
        value.actualChecksum === value.expectedChecksum &&
        value.actualSizeBytes === value.expectedSizeBytes
}

const receiptPayload = (
  receipt: ArtifactReproducibilityReceipt
): ArtifactReproducibilityReceiptPayload => {
  const payload: Partial<ArtifactReproducibilityReceipt> = { ...receipt }
  delete payload.receiptChecksum
  return payload as ArtifactReproducibilityReceiptPayload
}

const receiptChecksum = (draft: ArtifactReproducibilityReceiptPayload): string =>
  sha256(canonicalJson(draft as unknown as CanonicalJson))

const matchesRequest = (
  receipt: ArtifactReproducibilityReceiptDraft,
  request: ArtifactReproducibilityReceiptScope
): boolean =>
  receipt.artifactVersion.projectId === request.projectId &&
  receipt.artifactVersion.appSessionId === request.appSessionId &&
  receipt.artifactVersion.artifactId === request.artifactId &&
  receipt.artifactVersion.versionId === request.versionId

const matchesArtifactVersionScope = (
  value: ArtifactReproducibilityReceiptScope,
  request: ArtifactReproducibilityReceiptScope
): boolean =>
  value.projectId === request.projectId &&
  value.appSessionId === request.appSessionId &&
  value.artifactId === request.artifactId &&
  value.versionId === request.versionId

const isArtifactVersionScope = (value: unknown): value is ArtifactReproducibilityReceiptScope =>
  isRecord(value) &&
  hasExactKeys(value, ['projectId', 'appSessionId', 'artifactId', 'versionId']) &&
  isString(value.projectId) &&
  isString(value.appSessionId) &&
  isString(value.artifactId) &&
  isString(value.versionId)

const CHECK_PHASES = new Set([
  'loading-evidence',
  'materializing-inputs',
  'restoring-environments',
  'executing',
  'comparing'
])

const decodeFailedAttempt = (contents: string): ArtifactReproducibilityFailedAttempt => {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error('Invalid failed reproducibility attempt JSON.')
  }
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        'schemaVersion',
        'attemptId',
        'startedAt',
        'completedAt',
        'artifactVersion',
        'frontierId',
        'phase',
        'checkLog'
      ].includes(key)
    ) ||
    ![
      'schemaVersion',
      'attemptId',
      'startedAt',
      'completedAt',
      'artifactVersion',
      'frontierId',
      'checkLog'
    ].every((key) => key in value) ||
    value.schemaVersion !== 1 ||
    !isString(value.attemptId) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.completedAt) ||
    value.completedAt < value.startedAt ||
    !isArtifactVersionScope(value.artifactVersion) ||
    !isString(value.frontierId) ||
    (value.phase !== undefined && !CHECK_PHASES.has(String(value.phase))) ||
    !isCheckLogReference(value.checkLog)
  ) {
    throw new Error('Invalid failed reproducibility attempt.')
  }
  return value as unknown as ArtifactReproducibilityFailedAttempt
}

const decodeArtifactReproducibilityReceipt = (
  filePath: string,
  contents: string
): ArtifactReproducibilityReceipt => {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    throw new Error(`Invalid reproducibility receipt JSON: ${basename(filePath)}`)
  }
  if (!isRecord(value)) throw new Error(`Invalid reproducibility receipt: ${basename(filePath)}`)
  if (typeof value.schemaVersion === 'number' && value.schemaVersion > 2) {
    throw new DurableJsonRecoveryBarrierError(
      `Unsupported reproducibility receipt version: ${value.schemaVersion}`
    )
  }
  const receiptKeys = [
    'schemaVersion',
    'receiptId',
    'startedAt',
    'completedAt',
    'outcome',
    'artifactVersion',
    'frontier',
    'recipe',
    'environmentLocks',
    'completedStepIds',
    'comparisons',
    'receiptChecksum'
  ]
  if (
    !Object.keys(value).every((key) => [...receiptKeys, 'checkLog'].includes(key)) ||
    !receiptKeys.every((key) => key in value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isString(value.receiptId) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.completedAt) ||
    value.completedAt < value.startedAt ||
    !['matched', 'different'].includes(String(value.outcome)) ||
    !Array.isArray(value.environmentLocks) ||
    !Array.isArray(value.completedStepIds) ||
    !value.completedStepIds.every(isString) ||
    !Array.isArray(value.comparisons) ||
    !value.comparisons.every(isComparison) ||
    (value.checkLog !== undefined && !isCheckLogReference(value.checkLog)) ||
    !isSha256(value.receiptChecksum)
  ) {
    throw new Error(`Invalid reproducibility receipt: ${basename(filePath)}`)
  }

  const artifactVersion = value.artifactVersion
  const frontier = value.frontier
  const recipe = value.recipe
  if (
    !isRecord(artifactVersion) ||
    !hasExactKeys(artifactVersion, [
      'projectId',
      'appSessionId',
      'artifactId',
      'versionId',
      'targetChecksum'
    ]) ||
    !isString(artifactVersion.projectId) ||
    !isString(artifactVersion.appSessionId) ||
    !isString(artifactVersion.artifactId) ||
    !isString(artifactVersion.versionId) ||
    !isSha256(artifactVersion.targetChecksum) ||
    !isRecord(frontier) ||
    !hasExactKeys(frontier, ['frontierId', 'claimScope']) ||
    !isString(frontier.frontierId) ||
    !['end-to-end', 'downstream-only'].includes(String(frontier.claimScope)) ||
    !isRecord(recipe) ||
    !hasExactKeys(recipe, ['recipeId', 'graphChecksum']) ||
    !isSha256(recipe.recipeId) ||
    !isSha256(recipe.graphChecksum)
  ) {
    throw new Error(`Invalid reproducibility receipt identity: ${basename(filePath)}`)
  }

  for (const lock of value.environmentLocks) {
    if (
      !isRecord(lock) ||
      Object.keys(lock).some(
        (key) => !['requirementId', 'kernelKind', 'environmentName', 'lockChecksum'].includes(key)
      ) ||
      !isString(lock.requirementId) ||
      !['python', 'r'].includes(String(lock.kernelKind)) ||
      (lock.environmentName !== undefined && !isString(lock.environmentName)) ||
      !isSha256(lock.lockChecksum)
    ) {
      throw new Error(`Invalid reproducibility receipt environment: ${basename(filePath)}`)
    }
  }

  const receipt = value as unknown as ArtifactReproducibilityReceipt
  const expectedChecksum = receiptChecksum(receiptPayload(receipt))
  const filenameChecksum = RECEIPT_FILENAME.exec(basename(filePath))?.[1]
  if (receipt.receiptChecksum !== expectedChecksum || filenameChecksum !== expectedChecksum) {
    throw new Error(`Reproducibility receipt checksum mismatch: ${basename(filePath)}`)
  }
  const comparisonsMatch = receipt.comparisons.every(
    (comparison) => comparison.status === 'matched'
  )
  if (receipt.comparisons.length === 0 || (receipt.outcome === 'matched') !== comparisonsMatch) {
    throw new Error(`Invalid reproducibility receipt outcome: ${basename(filePath)}`)
  }
  return receipt
}

const directoryEntries = async (directory: string): Promise<Dirent[]> =>
  readdir(directory, { withFileTypes: true }).catch((error) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  })

const validateCheckLogReference = (
  reference: ArtifactReproducibilityCheckLogReference,
  attemptId: string,
  logs: ReadonlyMap<string, { record: ArtifactReproducibilityCheckLogRecord; sizeBytes: number }>
): void => {
  const persisted = logs.get(reference.logChecksum)
  if (!persisted) throw new Error('Reproducibility check log was not found.')
  if (
    persisted.record.attemptId !== attemptId ||
    persisted.record.entries.length !== reference.entryCount ||
    persisted.record.truncated !== reference.truncated ||
    persisted.sizeBytes !== reference.sizeBytes
  ) {
    throw new Error('Reproducibility check log identity mismatch.')
  }
}

const validateArtifactReproducibilityReceiptStorage = async (
  versionDirectory: string
): Promise<void> => {
  const directory = join(versionDirectory, RECEIPT_DIRECTORY)
  await validateReproducibilityOutputs(directory)
  const cleared = new Set(await clearedOutputReceipts(directory))
  for (const entry of await directoryEntries(join(directory, RETENTION_DIRECTORY))) {
    if (!entry.isFile() || entry.name !== CLEARED_OUTPUTS_FILENAME)
      throw new Error('Invalid reproduced output retention entry.')
  }
  const receipts: ArtifactReproducibilityReceipt[] = []
  for (const entry of await directoryEntries(directory)) {
    if (
      entry.isDirectory() &&
      [LOG_DIRECTORY, FAILURE_DIRECTORY, OUTPUT_DIRECTORY, RETENTION_DIRECTORY].includes(entry.name)
    )
      continue
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid Artifact reproducibility receipt entry: ${entry.name}`)
    }
    // The history index is a rebuildable cache; immutable receipt files remain the migration truth.
    if (entry.name === HISTORY_INDEX_FILENAME) continue
    const filePath = join(directory, entry.name)
    receipts.push(decodeArtifactReproducibilityReceipt(filePath, await readFile(filePath, 'utf8')))
  }

  for (const receipt of receipts) {
    if (cleared.has(receipt.receiptChecksum)) continue
    for (const comparison of receipt.comparisons) {
      if (comparison.outputCaptured)
        await readRetainedReproducibilityOutput(
          directory,
          comparison.actualChecksum!,
          comparison.actualSizeBytes!
        )
    }
  }
  const logs = new Map<
    string,
    { record: ArtifactReproducibilityCheckLogRecord; sizeBytes: number }
  >()
  const logDirectory = join(directory, LOG_DIRECTORY)
  for (const entry of await directoryEntries(logDirectory)) {
    const logChecksum = entry.isFile() ? LOG_FILENAME.exec(entry.name)?.[1] : undefined
    if (!logChecksum) throw new Error(`Invalid reproducibility check log entry: ${entry.name}`)
    const filePath = join(logDirectory, entry.name)
    const contents = await readFile(filePath, 'utf8')
    logs.set(logChecksum, {
      record: decodeCheckLog(filePath, contents),
      sizeBytes: Buffer.byteLength(contents)
    })
  }

  let latestFailure: ArtifactReproducibilityFailedAttempt | undefined
  const failureDirectory = join(directory, FAILURE_DIRECTORY)
  for (const entry of await directoryEntries(failureDirectory)) {
    if (!entry.isFile() || entry.name !== LATEST_FAILURE_FILENAME) {
      throw new Error(`Invalid failed reproducibility attempt entry: ${entry.name}`)
    }
    latestFailure = decodeFailedAttempt(await readFile(join(failureDirectory, entry.name), 'utf8'))
  }

  for (const receipt of receipts) {
    if (receipt.checkLog) validateCheckLogReference(receipt.checkLog, receipt.receiptId, logs)
  }
  if (latestFailure) {
    validateCheckLogReference(latestFailure.checkLog, latestFailure.attemptId, logs)
  }
}

class ArtifactReproducibilityReceiptStore {
  constructor(private readonly dependencies: ArtifactReproducibilityReceiptStoreDependencies) {}

  async source(
    request: ArtifactReproducibilityReceiptScope
  ): Promise<ReproducibilitySource | undefined> {
    return readReproducibilitySource(await this.dependencies.resolveVersionDirectory(request))
  }

  async environmentLock(
    request: ArtifactReproducibilityReceiptScope,
    checksum: string
  ): Promise<string | undefined> {
    const source = await this.source(request)
    if (!source?.lockChecksums.includes(checksum)) return undefined
    return readReproducibilityEnvironmentLock(
      join(await this.dependencies.resolveVersionDirectory(request), 'reproducibility-locks'),
      checksum
    )
  }

  private async readScope(
    request: ArtifactReproducibilityReceiptScope
  ): Promise<ArtifactReproducibilityReceiptScope> {
    return (await this.source(request))?.sourceScope ?? request
  }

  // Enumerate only this Version's verified history and referenced payloads, never Project/runtime
  // trees, unfinished writes or unreferenced outputs.
  async packageFiles(
    request: ArtifactReproducibilityReceiptScope,
    signal?: AbortSignal
  ): Promise<{
    metadata: string[]
    outputs: Array<{ path: string; filename: string; checksum: string; sizeBytes: number }>
    lockChecksums: string[]
    targetChecksums: string[]
  }> {
    const directory = await this.receiptDirectory(request)
    const metadata = new Set<string>()
    const outputs = new Map<
      string,
      { path: string; filename: string; checksum: string; sizeBytes: number }
    >()
    const locks = new Set<string>()
    const targetChecksums = new Set<string>()
    const cleared = new Set(await clearedOutputReceipts(directory))
    if (cleared.size) metadata.add(`${RETENTION_DIRECTORY}/${CLEARED_OUTPUTS_FILENAME}`)
    let cursor: string | undefined
    do {
      signal?.throwIfAborted()
      const page = await this.list({ ...request, cursor, limit: MAX_PAGE_SIZE })
      for (const receipt of page.receipts) {
        targetChecksums.add(receipt.artifactVersion.targetChecksum)
        metadata.add(`sha256-${receipt.receiptChecksum}.json`)
        if (receipt.checkLog) {
          await this.getCheckLog({ ...request, receiptChecksum: receipt.receiptChecksum })
          metadata.add(`${LOG_DIRECTORY}/sha256-${receipt.checkLog.logChecksum}.json`)
        }
        for (const lock of receipt.environmentLocks) locks.add(lock.lockChecksum)
        if (!cleared.has(receipt.receiptChecksum))
          for (const comparison of receipt.comparisons) {
            if (!comparison.outputCaptured) continue
            const checksum = comparison.actualChecksum!
            outputs.set(checksum, {
              path: `${OUTPUT_DIRECTORY}/sha256-${checksum}.bin`,
              checksum,
              filename: comparison.relativePath,
              sizeBytes: comparison.actualSizeBytes!
            })
          }
      }
      if (page.latestFailedAttempt) {
        await this.getCheckLog({ ...request, attemptId: page.latestFailedAttempt.attemptId })
        metadata.add(`${FAILURE_DIRECTORY}/${LATEST_FAILURE_FILENAME}`)
        metadata.add(
          `${LOG_DIRECTORY}/sha256-${page.latestFailedAttempt.checkLog.logChecksum}.json`
        )
      }
      if (metadata.size + outputs.size > 10000)
        throw new Error('Reproducibility history exceeds the package limit.')
      cursor = page.nextCursor
    } while (cursor)
    return {
      metadata: [...metadata],
      outputs: [...outputs.values()],
      lockChecksums: [...locks],
      targetChecksums: [...targetChecksums]
    }
  }

  private async receiptDirectory(request: ArtifactReproducibilityReceiptScope): Promise<string> {
    return join(await this.dependencies.resolveVersionDirectory(request), RECEIPT_DIRECTORY)
  }

  async retainOutput(
    request: ArtifactReproducibilityReceiptScope,
    bytes: Buffer
  ): Promise<boolean> {
    return retainReproducibilityOutput(await this.receiptDirectory(request), bytes)
  }

  async pruneOutputs(request: ArtifactReproducibilityReceiptScope): Promise<void> {
    const directory = await this.receiptDirectory(request)
    await recoverDurableJsonDirectory(directory, (filePath, contents) =>
      basename(filePath) === HISTORY_INDEX_FILENAME
        ? decodeReceiptHistoryIndex(contents)
        : decodeArtifactReproducibilityReceipt(filePath, contents)
    )
    const referenced = new Set<string>()
    const cleared = new Set(await clearedOutputReceipts(directory))
    for (const path of (await this.receiptFiles(directory)).values()) {
      const receipt = await this.readReceipt(path, request)
      if (cleared.has(receipt.receiptChecksum)) continue
      for (const comparison of receipt.comparisons) {
        if (comparison.outputCaptured) referenced.add(comparison.actualChecksum!)
      }
    }
    await pruneReproducibilityOutputs(directory, referenced)
  }

  async outputStorage(
    request: ArtifactReproducibilityReceiptScope
  ): Promise<ArtifactReproducibilityOutputStorage> {
    const source = await this.source(request)
    const directory = await this.receiptDirectory(request)
    return {
      ...(await reproducibilityOutputUsage(directory)),
      clearedReceiptChecksums: await clearedOutputReceipts(directory),
      ...(source ? { omittedOutputChecksums: source.omittedOutputChecksums } : {})
    }
  }

  // Called under the attempt owner's idle-version fence and the storage lease.
  async clearOutputs(
    request: ArtifactReproducibilityReceiptScope
  ): Promise<ArtifactReproducibilityOutputStorage> {
    await this.pruneOutputs(request)
    const directory = await this.receiptDirectory(request)
    const cleared = new Set(await clearedOutputReceipts(directory))
    for (const path of (await this.receiptFiles(directory)).values()) {
      const receipt = await this.readReceipt(path, request)
      if (receipt.comparisons.some((comparison) => comparison.outputCaptured))
        cleared.add(receipt.receiptChecksum)
    }
    // Publish intent before removing bytes so a crash never makes immutable
    // receipts appear corrupt. Repeated cleanup finishes an interrupted removal.
    await writeDurableJsonFile(
      join(directory, RETENTION_DIRECTORY, CLEARED_OUTPUTS_FILENAME),
      JSON.stringify({ schemaVersion: 1, receiptChecksums: [...cleared].sort() })
    )
    await this.pruneOutputs(request)
    return this.outputStorage(request)
  }

  async getOutput(
    request: ArtifactReproducibilityReceiptScope,
    checksum: string,
    entityId: string
  ): Promise<Buffer> {
    const receipt = await this.get(request, checksum)
    if ((await clearedOutputReceipts(await this.receiptDirectory(request))).includes(checksum))
      throw new Error('Reproduced output was cleared.')
    const output = receipt?.comparisons.find(
      (comparison) => comparison.entityId === entityId && comparison.outputCaptured
    )
    if (!output) throw new Error('Reproduced output is unavailable.')
    if ((await this.source(request))?.omittedOutputChecksums.includes(output.actualChecksum!))
      throw new Error('Reproduced output was not included in this package.')
    return readRetainedReproducibilityOutput(
      await this.receiptDirectory(request),
      output.actualChecksum!,
      output.actualSizeBytes!
    )
  }

  private async writeCheckLog(
    directory: string,
    attemptId: string,
    draft: ArtifactReproducibilityCheckLogDraft
  ): Promise<ArtifactReproducibilityCheckLogReference> {
    const payload: CheckLogPayload = {
      schemaVersion: 1,
      attemptId,
      entries: draft.entries.map((entry) => ({ ...entry })),
      truncated: draft.truncated
    }
    const logChecksum = sha256(canonicalJson(payload as unknown as CanonicalJson))
    const record: ArtifactReproducibilityCheckLogRecord = { ...payload, logChecksum }
    const contents = `${canonicalJson(record as unknown as CanonicalJson)}\n`
    const filePath = join(directory, LOG_DIRECTORY, `sha256-${logChecksum}.json`)
    const validated = decodeCheckLog(filePath, contents)
    await writeDurableJsonFile(filePath, contents)
    return {
      logChecksum,
      entryCount: validated.entries.length,
      sizeBytes: Buffer.byteLength(contents),
      truncated: validated.truncated
    }
  }

  private async readCheckLog(
    directory: string,
    reference: ArtifactReproducibilityCheckLogReference,
    attemptId: string
  ): Promise<ArtifactReproducibilityCheckLogRecord> {
    const filePath = join(directory, LOG_DIRECTORY, `sha256-${reference.logChecksum}.json`)
    let persistedContents = ''
    const result = await readDurableJsonFile(filePath, (contents) => {
      persistedContents = contents
      return decodeCheckLog(filePath, contents)
    })
    if (result.status === 'missing') throw new Error('Reproducibility check log was not found.')
    if (
      result.value.attemptId !== attemptId ||
      result.value.entries.length !== reference.entryCount ||
      result.value.truncated !== reference.truncated ||
      Buffer.byteLength(persistedContents) !== reference.sizeBytes
    ) {
      throw new Error('Reproducibility check log identity mismatch.')
    }
    return result.value
  }

  private async receiptFiles(directory: string): Promise<Map<string, string>> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return []
      }
      throw error
    })
    const files = new Map<string, string>()
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith('.json') ||
        entry.name === HISTORY_INDEX_FILENAME
      ) {
        continue
      }
      const checksum = RECEIPT_FILENAME.exec(entry.name)?.[1]
      if (!checksum) throw new Error(`Invalid reproducibility receipt filename: ${entry.name}`)
      files.set(checksum, join(directory, entry.name))
    }
    return files
  }

  private async readReceipt(
    filePath: string,
    request: ArtifactReproducibilityReceiptScope
  ): Promise<ArtifactReproducibilityReceipt> {
    const result = await readDurableJsonFile(filePath, (contents) =>
      decodeArtifactReproducibilityReceipt(filePath, contents)
    )
    if (result.status === 'missing') {
      throw new Error(`Reproducibility receipt disappeared: ${basename(filePath)}`)
    }
    if (!matchesRequest(result.value, await this.readScope(request))) {
      throw new Error(`Reproducibility receipt identity mismatch: ${basename(filePath)}`)
    }
    return result.value
  }

  private async publishIndex(
    directory: string,
    receipts: ReceiptHistoryIndexEntry[]
  ): Promise<void> {
    const contents = `${canonicalJson({ schemaVersion: 1, receipts } as CanonicalJson)}\n`
    await writeDurableJsonFile(join(directory, HISTORY_INDEX_FILENAME), contents)
  }

  private async rebuildIndex(
    directory: string,
    request: ArtifactReproducibilityReceiptScope,
    files: ReadonlyMap<string, string>
  ): Promise<ReceiptHistoryIndex> {
    if (files.size === 0) return { schemaVersion: 1, receipts: [] }
    const receipts = (
      await Promise.all([...files.values()].map((filePath) => this.readReceipt(filePath, request)))
    )
      .map(historyEntry)
      .sort(compareHistoryEntries)
    await this.publishIndex(directory, receipts).catch(() => undefined)
    return { schemaVersion: 1, receipts }
  }

  private async loadIndex(
    directory: string,
    request: ArtifactReproducibilityReceiptScope,
    files: ReadonlyMap<string, string>
  ): Promise<ReceiptHistoryIndex> {
    const indexPath = join(directory, HISTORY_INDEX_FILENAME)
    const index = await readDurableJsonFile(indexPath, decodeReceiptHistoryIndex).catch(() => ({
      status: 'missing' as const
    }))
    if (
      index.status === 'found' &&
      index.value.receipts.length === files.size &&
      index.value.receipts.every((entry) => files.has(entry.receiptChecksum))
    ) {
      return index.value
    }
    return this.rebuildIndex(directory, request, files)
  }

  async append(
    request: ArtifactReproducibilityReceiptScope,
    draft: ArtifactReproducibilityReceiptDraft,
    checkLog: ArtifactReproducibilityCheckLogDraft = { entries: [], truncated: false }
  ): Promise<ArtifactReproducibilityReceipt> {
    if (!matchesRequest(draft, request)) {
      throw new Error('Reproducibility receipt belongs to a different Artifact Version.')
    }
    const directory = await this.receiptDirectory(request)
    const checkLogReference = await this.writeCheckLog(directory, draft.receiptId, checkLog)
    const draftWithLog: Omit<ArtifactReproducibilityReceipt, 'receiptChecksum'> = {
      ...draft,
      checkLog: checkLogReference
    }
    const checksum = receiptChecksum(draftWithLog)
    const receipt: ArtifactReproducibilityReceipt = {
      ...draftWithLog,
      receiptChecksum: checksum
    }
    const filePath = join(directory, `sha256-${checksum}.json`)
    const contents = `${canonicalJson(receipt as unknown as CanonicalJson)}\n`
    const validatedReceipt = decodeArtifactReproducibilityReceipt(filePath, contents)
    for (const comparison of validatedReceipt.comparisons) {
      if (comparison.outputCaptured)
        await readRetainedReproducibilityOutput(
          directory,
          comparison.actualChecksum!,
          comparison.actualSizeBytes!
        )
    }
    const existing = await readDurableJsonFile(filePath, (persistedContents) =>
      decodeArtifactReproducibilityReceipt(filePath, persistedContents)
    )
    if (existing.status === 'found') {
      const files = await this.receiptFiles(directory)
      await this.loadIndex(directory, request, files).catch(() => undefined)
      return existing.value
    }
    try {
      await writeDurableJsonFile(filePath, contents)
    } catch (writeError) {
      const published = await readDurableJsonFile(filePath, (persistedContents) =>
        decodeArtifactReproducibilityReceipt(filePath, persistedContents)
      )
      if (published.status === 'found') return published.value
      throw writeError
    }
    const files = await this.receiptFiles(directory)
    await this.loadIndex(directory, request, files).catch(() => undefined)
    return validatedReceipt
  }

  async recordFailure(
    request: ArtifactReproducibilityReceiptScope,
    draft: ArtifactReproducibilityFailedAttemptDraft,
    checkLog: ArtifactReproducibilityCheckLogDraft
  ): Promise<ArtifactReproducibilityFailedAttempt> {
    if (!matchesArtifactVersionScope(draft.artifactVersion, request)) {
      throw new Error('Failed reproducibility attempt belongs to a different Artifact Version.')
    }
    const directory = await this.receiptDirectory(request)
    const checkLogReference = await this.writeCheckLog(directory, draft.attemptId, checkLog)
    const failure: ArtifactReproducibilityFailedAttempt = {
      schemaVersion: 1,
      ...draft,
      checkLog: checkLogReference
    }
    const contents = `${canonicalJson(failure as unknown as CanonicalJson)}\n`
    const validated = decodeFailedAttempt(contents)
    await writeDurableJsonFile(
      join(directory, FAILURE_DIRECTORY, LATEST_FAILURE_FILENAME),
      contents
    )
    return validated
  }

  private async latestFailure(
    directory: string,
    request: ArtifactReproducibilityReceiptScope
  ): Promise<ArtifactReproducibilityFailedAttempt | undefined> {
    const result = await readDurableJsonFile(
      join(directory, FAILURE_DIRECTORY, LATEST_FAILURE_FILENAME),
      decodeFailedAttempt
    )
    if (result.status === 'missing') return undefined
    if (!matchesArtifactVersionScope(result.value.artifactVersion, await this.readScope(request))) {
      throw new Error('Failed reproducibility attempt identity mismatch.')
    }
    return result.value
  }

  async list(
    request: ListArtifactReproducibilityReceiptsRequest
  ): Promise<ArtifactReproducibilityReceiptPage> {
    const limit = request.limit ?? DEFAULT_PAGE_SIZE
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new Error('Invalid reproducibility receipt page size.')
    }
    if (request.cursor !== undefined && !SHA256.test(request.cursor)) {
      throw new Error('Invalid reproducibility receipt cursor.')
    }
    const directory = await this.receiptDirectory(request)
    await recoverDurableJsonDirectory(directory, (filePath, contents) =>
      basename(filePath) === HISTORY_INDEX_FILENAME
        ? decodeReceiptHistoryIndex(contents)
        : decodeArtifactReproducibilityReceipt(filePath, contents)
    )
    const files = await this.receiptFiles(directory)
    let index = await this.loadIndex(directory, request, files)
    let start = request.cursor
      ? index.receipts.findIndex((entry) => entry.receiptChecksum === request.cursor) + 1
      : 0
    if (request.cursor && start === 0) throw new Error('Unknown reproducibility receipt cursor.')
    let selected = index.receipts.slice(start, start + limit)
    let receipts = await Promise.all(
      selected.map((entry) => this.readReceipt(files.get(entry.receiptChecksum)!, request))
    )
    if (
      receipts.some(
        (receipt, position) => !sameHistoryEntry(historyEntry(receipt), selected[position]!)
      )
    ) {
      index = await this.rebuildIndex(directory, request, files)
      start = request.cursor
        ? index.receipts.findIndex((entry) => entry.receiptChecksum === request.cursor) + 1
        : 0
      if (request.cursor && start === 0) throw new Error('Unknown reproducibility receipt cursor.')
      selected = index.receipts.slice(start, start + limit)
      receipts = await Promise.all(
        selected.map((entry) => this.readReceipt(files.get(entry.receiptChecksum)!, request))
      )
    }
    const latestFailedAttempt =
      start === 0 ? await this.latestFailure(directory, request) : undefined
    const source = await this.source(request)
    return {
      receipts,
      ...(source ? { sourceArtifactVersion: source.sourceScope } : {}),
      ...(latestFailedAttempt ? { latestFailedAttempt } : {}),
      ...(start + selected.length < index.receipts.length && selected.length > 0
        ? { nextCursor: selected.at(-1)!.receiptChecksum }
        : {})
    }
  }

  async get(
    request: ArtifactReproducibilityReceiptScope,
    receiptChecksum: string
  ): Promise<ArtifactReproducibilityReceipt | undefined> {
    if (!SHA256.test(receiptChecksum)) throw new Error('Invalid reproducibility receipt checksum.')
    const directory = await this.receiptDirectory(request)
    const filePath = join(directory, `sha256-${receiptChecksum}.json`)
    const result = await readDurableJsonFile(filePath, (contents) =>
      decodeArtifactReproducibilityReceipt(filePath, contents)
    )
    if (result.status === 'missing') return undefined
    if (!matchesRequest(result.value, await this.readScope(request))) {
      throw new Error(`Reproducibility receipt identity mismatch: ${basename(filePath)}`)
    }
    return result.value
  }

  async getCheckLog(
    request: GetArtifactReproducibilityCheckLogRequest
  ): Promise<ArtifactReproducibilityCheckLogRecord | undefined> {
    const directory = await this.receiptDirectory(request)
    if (request.receiptChecksum) {
      const receipt = await this.get(request, request.receiptChecksum)
      if (!receipt?.checkLog) return undefined
      return this.readCheckLog(directory, receipt.checkLog, receipt.receiptId)
    }
    const failure = await this.latestFailure(directory, request)
    if (!failure || failure.attemptId !== request.attemptId) return undefined
    return this.readCheckLog(directory, failure.checkLog, failure.attemptId)
  }
}

const stores = new WeakMap<object, ArtifactReproducibilityReceiptStore>()

const bindArtifactReproducibilityReceipts = (
  owner: object,
  store: ArtifactReproducibilityReceiptStore
): void => {
  stores.set(owner, store)
}

const receiptStore = (owner: object): ArtifactReproducibilityReceiptStore => {
  const store = stores.get(owner)
  if (!store) throw new Error('Artifact reproducibility receipt storage is unavailable.')
  return store
}

const appendArtifactReproducibilityReceipt = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope,
  receipt: ArtifactReproducibilityReceiptDraft,
  checkLog?: ArtifactReproducibilityCheckLogDraft
): Promise<ArtifactReproducibilityReceipt> => receiptStore(owner).append(request, receipt, checkLog)

const recordFailedArtifactReproducibilityAttempt = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope,
  attempt: ArtifactReproducibilityFailedAttemptDraft,
  checkLog: ArtifactReproducibilityCheckLogDraft
): Promise<ArtifactReproducibilityFailedAttempt> =>
  receiptStore(owner).recordFailure(request, attempt, checkLog)

const listArtifactReproducibilityReceipts = (
  owner: object,
  request: ListArtifactReproducibilityReceiptsRequest
): Promise<ArtifactReproducibilityReceiptPage> => receiptStore(owner).list(request)

const getArtifactReproducibilityReceipt = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope,
  receiptChecksum: string
): Promise<ArtifactReproducibilityReceipt | undefined> =>
  receiptStore(owner).get(request, receiptChecksum)

const getArtifactReproducibilityCheckLog = (
  owner: object,
  request: GetArtifactReproducibilityCheckLogRequest
): Promise<ArtifactReproducibilityCheckLogRecord | undefined> =>
  receiptStore(owner).getCheckLog(request)

const retainArtifactReproducibilityOutput = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope,
  bytes: Buffer
): Promise<boolean> => receiptStore(owner).retainOutput(request, bytes)
const getArtifactReproducibilityOutputStorage = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope
): Promise<ArtifactReproducibilityOutputStorage> => receiptStore(owner).outputStorage(request)
const clearArtifactReproducibilityOutputs = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope
): Promise<ArtifactReproducibilityOutputStorage> => receiptStore(owner).clearOutputs(request)
const pruneArtifactReproducibilityOutputs = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope
): Promise<void> => receiptStore(owner).pruneOutputs(request)
const getArtifactReproducibilityEnvironmentLock = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope,
  checksum: string
): Promise<string | undefined> => receiptStore(owner).environmentLock(request, checksum)
const getArtifactReproducibilitySource = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope
): Promise<ReproducibilitySource | undefined> => receiptStore(owner).source(request)

const getArtifactReproducibilityOutput = (
  owner: object,
  request: ArtifactReproducibilityReceiptScope,
  checksum: string,
  entityId: string
): Promise<Buffer> => receiptStore(owner).getOutput(request, checksum, entityId)

export {
  getArtifactReproducibilityEnvironmentLock,
  getArtifactReproducibilitySource,
  getArtifactReproducibilityOutputStorage,
  clearArtifactReproducibilityOutputs,
  pruneArtifactReproducibilityOutputs,
  retainArtifactReproducibilityOutput,
  getArtifactReproducibilityOutput,
  appendArtifactReproducibilityReceipt,
  ArtifactReproducibilityReceiptStore,
  bindArtifactReproducibilityReceipts,
  decodeArtifactReproducibilityReceipt,
  getArtifactReproducibilityCheckLog,
  getArtifactReproducibilityReceipt,
  listArtifactReproducibilityReceipts,
  recordFailedArtifactReproducibilityAttempt,
  validateArtifactReproducibilityReceiptStorage
}
export type {
  ArtifactReproducibilityCheckLogDraft,
  ArtifactReproducibilityFailedAttemptDraft,
  ArtifactReproducibilityReceiptDraft,
  ArtifactReproducibilityReceiptStoreDependencies
}

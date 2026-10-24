import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  researchEnvironmentVariableSchema,
  type ResearchExecutionSecretSlot
} from '../../shared/research-execution-profile'
import { writeDurableJsonFile, readDurableJsonFile } from '@aipoch/durable-files'

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const trialId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u)
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const sealSchema = z
  .object({
    studyId: trialId,
    status: z.literal('sealed'),
    unit: z.literal('tokens'),
    totalCeiling: count.positive().max(1_000_000_000),
    carriedReservedUnits: count.max(1_000_000_000).default(0),
    allocationPerTrialCeiling: count.positive().max(250_000_000),
    maximumUnitsPerTrial: count.positive().max(250_000_000),
    maxRequestsPerTrial: count.positive().max(6),
    countingPolicy: z.literal('input-plus-output-no-double-count-reasoning-v1'),
    trialIds: z.array(trialId).length(4)
  })
  .passthrough()
export type AcceptanceBudgetSeal = z.infer<typeof sealSchema> & { sha256: string }

/** Test orchestration only: a reviewed token bound, independent of provider prices. */
export async function readAcceptanceBudgetSeal(path: string): Promise<AcceptanceBudgetSeal> {
  try {
    const bytes = await readFile(path)
    const seal = sealSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (
      new Set(seal.trialIds).size !== 4 ||
      seal.maximumUnitsPerTrial > seal.allocationPerTrialCeiling ||
      seal.carriedReservedUnits + seal.allocationPerTrialCeiling * 4 > seal.totalCeiling
    )
      throw new Error('invalid allocation')
    return { ...seal, sha256: digest(bytes) }
  } catch {
    // Never relay parsed input or upstream account text into a test log.
    throw new Error(
      'Live acceptance is blocked: the reviewed four-trial token budget is not sealed.'
    )
  }
}

const usageSchema = z
  .object({
    unit: z.literal('tokens'),
    state: z.enum(['unknown', 'partial', 'complete']),
    knownUnits: count.nullable(),
    requestCount: count.nullable(),
    requestsWithUsage: count,
    requestsWithoutUsage: count.nullable()
  })
  .strict()
  .superRefine((usage, ctx) => {
    const invalid = (): void => ctx.addIssue({ code: 'custom', message: 'Invalid usage evidence.' })
    if (usage.requestCount === null || usage.requestsWithoutUsage === null) {
      if (
        usage.state !== 'unknown' ||
        usage.knownUnits !== null ||
        usage.requestsWithUsage !== 0 ||
        usage.requestCount !== null ||
        usage.requestsWithoutUsage !== null
      )
        invalid()
      return
    }
    if (usage.requestsWithUsage + usage.requestsWithoutUsage !== usage.requestCount) invalid()
    if (usage.state === 'unknown') {
      if (usage.knownUnits !== null || usage.requestsWithUsage !== 0) invalid()
    } else if (usage.state === 'partial') {
      if (
        usage.knownUnits === null ||
        usage.requestsWithUsage === 0 ||
        usage.requestsWithoutUsage === 0
      )
        invalid()
    } else if (usage.knownUnits === null || usage.requestsWithoutUsage !== 0) invalid()
  })
export type AcceptanceTrialUsage = z.infer<typeof usageSchema>
const unknownUsage = (): AcceptanceTrialUsage => ({
  unit: 'tokens',
  state: 'unknown',
  knownUnits: null,
  requestCount: null,
  requestsWithUsage: 0,
  requestsWithoutUsage: null
})
const zeroUsageSchema = z
  .object({
    unit: z.literal('tokens'),
    state: z.literal('complete'),
    knownUnits: z.literal(0),
    requestCount: z.literal(0),
    requestsWithUsage: z.literal(0),
    requestsWithoutUsage: z.literal(0)
  })
  .strict()
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const evidenceFileSchema = z
  .object({ path: z.string().min(1).max(4096), sha256: sha256Schema })
  .strict()
const admissionFailureSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('acceptance-before-execution-entry-failure'),
    status: z.literal('failed'),
    evidenceBasis: z.enum(['harness-catch', 'operator-attestation']),
    recordedAt: z.string().datetime(),
    trialId,
    budgetDocumentSha256: sha256Schema,
    phase: z.literal('prepare'),
    dispatchAttempted: z.literal(false),
    usage: zeroUsageSchema,
    errorCode: z.literal('PREPARE_FAILED'),
    source: z
      .object({
        inputPackageSha256: sha256Schema,
        descriptorSha256: sha256Schema,
        sourceIdentity: z.string().min(1).max(200).nullable(),
        projectId: z.string().min(1).max(200).nullable(),
        sessionId: z.string().min(1).max(200).nullable()
      })
      .strict(),
    request: z
      .object({
        method: z.literal('execution.prepare'),
        requestId: z.string().min(1).max(200),
        sha256: sha256Schema.nullable()
      })
      .strict(),
    nativeOperationId: z.null(),
    notebookRunIds: z.array(z.never()).length(0),
    basisFiles: z
      .array(
        evidenceFileSchema
          .extend({
            role: z.enum(['harness-log', 'harness-source', 'ledger-snapshot', 'native-diagnostics'])
          })
          .strict()
      )
      .max(4)
  })
  .strict()
  .superRefine((value, ctx) => {
    const roles = new Set<string>(value.basisFiles.map((file) => file.role))
    if (
      roles.size !== value.basisFiles.length ||
      (value.evidenceBasis === 'operator-attestation' &&
        !['harness-log', 'harness-source', 'ledger-snapshot'].every((role) => roles.has(role))) ||
      (value.evidenceBasis === 'harness-catch' &&
        (!value.source.sourceIdentity ||
          !value.source.projectId ||
          !value.source.sessionId ||
          !value.request.sha256))
    )
      ctx.addIssue({ code: 'custom', message: 'Admission failure evidence is incomplete.' })
  })
export type AcceptanceAdmissionFailure = z.infer<typeof admissionFailureSchema>
const admissionAuditSchema = z
  .object({
    armedAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
    previousUsage: zeroUsageSchema,
    previousUsageRecordedAt: z.string(),
    receipt: evidenceFileSchema,
    attestation: admissionFailureSchema
  })
  .strict()
const zeroDispatchAuditSchema = z
  .object({
    armedAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
    previousUsage: zeroUsageSchema,
    previousUsageRecordedAt: z.string(),
    executionId: z.string().min(1).max(200),
    receiptKind: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200),
    notebookRunId: z.string().min(1).max(200),
    errorCode: z.string().min(1).max(200),
    evidence: z
      .object({
        receipt: evidenceFileSchema,
        result: evidenceFileSchema,
        operation: evidenceFileSchema,
        notebookRuns: evidenceFileSchema
      })
      .strict()
  })
  .strict()
const ledgerSchema = z
  .object({
    version: z.literal(2),
    unit: z.literal('tokens'),
    studyId: trialId,
    sealSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    carriedReservedUnits: count.max(1_000_000_000).default(0),
    reservations: z
      .array(
        z
          .object({
            trialId,
            maximumUnits: count.positive(),
            reservedAt: z.string(),
            usage: usageSchema,
            usageRecordedAt: z.string().optional(),
            zeroDispatchReconciliation: zeroDispatchAuditSchema.optional(),
            admissionFailureReconciliation: admissionAuditSchema.optional()
          })
          .strict()
          .refine((row) => !(row.zeroDispatchReconciliation && row.admissionFailureReconciliation))
      )
      .max(4)
  })
  .strict()
type AcceptanceLedger = z.infer<typeof ledgerSchema>

async function withAcceptanceLedger(
  budgetPath: string,
  seal: AcceptanceBudgetSeal,
  operation: (ledger: AcceptanceLedger) => void
): Promise<void> {
  // One ledger beside fixed materials, shared by every output directory and rerun.
  const ledgerPath = join(
    dirname(dirname(await realpath(budgetPath))),
    'live-acceptance-budget-ledger.json'
  )
  const lockPath = ledgerPath + '.lock'
  let lock: Awaited<ReturnType<typeof open>>
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch {
    throw new Error(
      'Acceptance budget is locked; reconcile the existing reservation before retrying.'
    )
  }
  try {
    const currentSeal = await readAcceptanceBudgetSeal(budgetPath)
    if (currentSeal.sha256 !== seal.sha256)
      throw new Error('Acceptance budget changed after review.')
    const read = await readDurableJsonFile(
      ledgerPath,
      (text) => ledgerSchema.parse(JSON.parse(text)),
      {},
      { maxBytes: 128 * 1024 }
    )
    const ledger: AcceptanceLedger =
      read.status === 'found'
        ? read.value
        : {
            version: 2,
            unit: 'tokens',
            studyId: seal.studyId,
            sealSha256: seal.sha256,
            carriedReservedUnits: seal.carriedReservedUnits,
            reservations: []
          }
    if (ledger.studyId !== seal.studyId || ledger.sealSha256 !== seal.sha256)
      throw new Error(
        'Existing budget ledger belongs to another sealed study; operator reconciliation is required.'
      )
    if (ledger.carriedReservedUnits !== seal.carriedReservedUnits)
      throw new Error('Carried reservations do not match the sealed budget.')
    if (
      new Set(ledger.reservations.map((row) => row.trialId)).size !== ledger.reservations.length ||
      ledger.reservations.some(
        (row) =>
          !seal.trialIds.includes(row.trialId) || row.maximumUnits !== seal.maximumUnitsPerTrial
      )
    )
      throw new Error('Existing budget reservations do not match the sealed allocation.')
    operation(ledger)
    await writeDurableJsonFile(ledgerPath, JSON.stringify(ledgerSchema.parse(ledger)))
  } finally {
    await lock.close()
    await rm(lockPath)
  }
}

/** Failed or uncertain trials retain their entire reservation. No automatic retry/refund. */
export async function reserveAcceptanceTrial(
  budgetPath: string,
  seal: AcceptanceBudgetSeal,
  requestedTrial: string
): Promise<void> {
  if (!seal.trialIds.includes(requestedTrial))
    throw new Error('Trial is not in the sealed acceptance budget.')
  await withAcceptanceLedger(budgetPath, seal, (ledger) => {
    const existing = ledger.reservations.find((row) => row.trialId === requestedTrial)
    const reconciliation =
      existing?.zeroDispatchReconciliation ?? existing?.admissionFailureReconciliation
    if (existing && (!reconciliation || reconciliation.consumedAt))
      throw new Error(
        'This acceptance trial is already reserved; automatic paid retries are forbidden.'
      )
    if (
      ledger.reservations.some(
        (row) =>
          (row.usage.knownUnits !== null && row.usage.knownUnits > row.maximumUnits) ||
          (row.usage.requestCount !== null && row.usage.requestCount > seal.maxRequestsPerTrial)
      )
    )
      throw new Error('Observed usage exceeded its reviewed bound; further trials are blocked.')
    if (existing && reconciliation) {
      if (!zeroUsageSchema.safeParse(existing.usage).success || !existing.usageRecordedAt)
        throw new Error('Reconciled zero-dispatch evidence no longer matches the reservation.')
      reconciliation.consumedAt = new Date().toISOString()
      existing.usage = unknownUsage()
      delete existing.usageRecordedAt
      return
    }
    if (
      ledger.carriedReservedUnits +
        ledger.reservations.reduce((total, row) => total + row.maximumUnits, 0) +
        seal.maximumUnitsPerTrial >
      seal.totalCeiling
    )
      throw new Error('Acceptance budget ceiling exceeded.')
    ledger.reservations.push({
      trialId: requestedTrial,
      maximumUnits: seal.maximumUnitsPerTrial,
      reservedAt: new Date().toISOString(),
      usage: unknownUsage()
    })
  })
}

/** Explicit operator action only. This is never called by the acceptance runner. */
export async function reconcileAcceptanceZeroDispatchFailure(
  budgetPath: string,
  seal: AcceptanceBudgetSeal,
  requestedTrial: string,
  paths: {
    receiptPath: string
    resultPath: string
    operationPath: string
    notebookRunsPath: string
  }
): Promise<void> {
  if (!seal.trialIds.includes(requestedTrial))
    throw new Error('Trial is not in the sealed acceptance budget.')
  const evidence = await readZeroDispatchEvidence(paths, seal, requestedTrial)
  await withAcceptanceLedger(budgetPath, seal, (ledger) => {
    const row = ledger.reservations.find((entry) => entry.trialId === requestedTrial)
    if (!row || !row.usageRecordedAt || !zeroUsageSchema.safeParse(row.usage).success)
      throw new Error('Zero-dispatch reconciliation requires recorded complete zero usage.')
    if (row.zeroDispatchReconciliation || row.admissionFailureReconciliation)
      throw new Error('This trial already has its one explicit zero-dispatch reconciliation.')
    row.zeroDispatchReconciliation = {
      armedAt: new Date().toISOString(),
      previousUsage: zeroUsageSchema.parse(row.usage),
      previousUsageRecordedAt: row.usageRecordedAt,
      ...evidence
    }
  })
}

/** Writes an honest caller attestation, not native proof. Never arms or executes a retry. */
export async function recordAcceptanceAdmissionFailure(
  path: string,
  value: AcceptanceAdmissionFailure
): Promise<void> {
  const receipt = admissionFailureSchema.parse(value)
  if (!isAbsolute(path)) throw new Error('Admission failure evidence requires an absolute path.')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(receipt, null, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Explicit operator review of a pre-execution failure. Zero reported usage alone is insufficient. */
export async function reconcileAcceptanceAdmissionFailure(
  budgetPath: string,
  seal: AcceptanceBudgetSeal,
  requestedTrial: string,
  receiptPath: string
): Promise<void> {
  if (!seal.trialIds.includes(requestedTrial))
    throw new Error('Trial is not in the sealed acceptance budget.')
  let file: Awaited<ReturnType<typeof readAcceptanceEvidenceFile>>
  let receipt: AcceptanceAdmissionFailure
  let snapshot: AcceptanceLedger | undefined
  try {
    file = await readAcceptanceEvidenceFile(receiptPath)
    receipt = admissionFailureSchema.parse(JSON.parse(file.bytes.toString('utf8')))
    if (receipt.trialId !== requestedTrial || receipt.budgetDocumentSha256 !== seal.sha256)
      throw new Error('Admission scope mismatch')
    for (const basis of receipt.basisFiles) {
      const read = await readAcceptanceEvidenceFile(basis.path)
      if (read.sha256 !== basis.sha256 || read.path === file.path)
        throw new Error('Evidence changed')
      if (basis.role === 'ledger-snapshot')
        snapshot = ledgerSchema.parse(JSON.parse(read.bytes.toString('utf8')))
    }
  } catch {
    throw new Error(
      'Admission reconciliation requires matching reviewed pre-execution failure evidence.'
    )
  }
  await withAcceptanceLedger(budgetPath, seal, (ledger) => {
    const row = ledger.reservations.find((entry) => entry.trialId === requestedTrial)
    if (!row || !row.usageRecordedAt || !zeroUsageSchema.safeParse(row.usage).success)
      throw new Error('Admission reconciliation requires recorded complete zero usage.')
    if (row.zeroDispatchReconciliation || row.admissionFailureReconciliation)
      throw new Error('This trial already has its one explicit zero-dispatch reconciliation.')
    if (receipt.evidenceBasis === 'operator-attestation') {
      const prior = snapshot?.reservations.find((entry) => entry.trialId === requestedTrial)
      if (
        snapshot?.studyId !== ledger.studyId ||
        snapshot.sealSha256 !== ledger.sealSha256 ||
        snapshot.carriedReservedUnits !== ledger.carriedReservedUnits ||
        !prior ||
        prior.reservedAt !== row.reservedAt ||
        prior.maximumUnits !== row.maximumUnits ||
        prior.usageRecordedAt !== row.usageRecordedAt ||
        !zeroUsageSchema.safeParse(prior.usage).success ||
        prior.zeroDispatchReconciliation ||
        prior.admissionFailureReconciliation
      )
        throw new Error(
          'Reviewed ledger snapshot does not match the current zero-usage reservation.'
        )
    }
    row.admissionFailureReconciliation = {
      armedAt: new Date().toISOString(),
      previousUsage: zeroUsageSchema.parse(row.usage),
      previousUsageRecordedAt: row.usageRecordedAt,
      receipt: { path: file.path, sha256: file.sha256 },
      attestation: receipt
    }
  })
}

async function readAcceptanceEvidenceFile(
  path: string
): Promise<{ path: string; sha256: string; bytes: Buffer }> {
  if (!isAbsolute(path) || path.length > 4096) throw new Error('Invalid evidence path')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid evidence file')
    const bytes = await handle.readFile()
    if (bytes.length > 1024 * 1024) throw new Error('Oversized evidence file')
    return { path: await realpath(path), sha256: digest(bytes), bytes }
  } finally {
    await handle.close()
  }
}

async function readZeroDispatchEvidence(
  paths: Parameters<typeof reconcileAcceptanceZeroDispatchFailure>[3],
  seal: AcceptanceBudgetSeal,
  requestedTrial: string
): Promise<
  Omit<
    z.infer<typeof zeroDispatchAuditSchema>,
    'armedAt' | 'previousUsage' | 'previousUsageRecordedAt'
  >
> {
  try {
    const read = async (
      path: string
    ): Promise<{ path: string; sha256: string; sizeBytes: number; value: unknown }> => {
      const file = await readAcceptanceEvidenceFile(path)
      return {
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.bytes.length,
        value: JSON.parse(file.bytes.toString('utf8'))
      }
    }
    const files = await Promise.all([
      read(paths.receiptPath),
      read(paths.resultPath),
      read(paths.operationPath),
      read(paths.notebookRunsPath)
    ])
    if (new Set(files.map((file) => file.path)).size !== 4)
      throw new Error('Duplicate evidence files')
    const errorSchema = z.object({ code: z.string().min(1).max(200), phase: z.string().min(1) })
    const receipt = z
      .object({
        schemaVersion: z.literal(1),
        kind: z.string().min(1).max(200),
        executionId: z.string().min(1).max(200),
        status: z.literal('failed'),
        phase: z.literal('finished'),
        trialId: z.literal(requestedTrial),
        budgetDocumentSha256: z.literal(seal.sha256),
        serviceSpawnAttempted: z.literal(false),
        childExit: z.null(),
        liveTrialsStarted: z.literal(0),
        scientificTrialsStarted: z.literal(0),
        requestReservedUnits: z.literal(0),
        providerCalls: z.union([z.literal(0), z.null()]),
        usage: zeroUsageSchema,
        error: errorSchema,
        outputs: z.array(z.object({ path: z.string(), sizeBytes: count, sha256: sha256Schema }))
      })
      .parse(files[0].value)
    const result = z
      .object({
        schemaVersion: z.literal(1),
        status: z.literal('failed'),
        runId: z.null(),
        providerCalls: z.union([z.literal(0), z.null()]),
        usage: zeroUsageSchema,
        liveTrialsStarted: z.literal(0),
        scientificTrialsStarted: z.literal(0),
        validationPassed: z.literal(false),
        error: errorSchema
      })
      .parse(files[1].value)
    const operation = z
      .object({
        schemaVersion: z.literal(1),
        status: z.literal('failed'),
        operationId: z.string().min(1).max(200),
        recoveryPending: z.literal(false).optional(),
        provenance: z.object({ promptMessageId: z.string().min(1) }),
        notebookRunIds: z.array(z.string().min(1).max(200)).length(1)
      })
      .parse(files[2].value)
    const [run] = z
      .array(
        z.object({
          runId: z.string().min(1).max(200),
          status: z.literal('failed'),
          exitCode: z
            .number()
            .int()
            .refine((value) => value !== 0),
          promptMessageId: z.string().min(1)
        })
      )
      .length(1)
      .parse(files[3].value)
    const resultOutputs = receipt.outputs.filter((output) => output.path === 'result.json')
    if (
      resultOutputs.length !== 1 ||
      resultOutputs[0].sha256 !== files[1].sha256 ||
      resultOutputs[0].sizeBytes !== files[1].sizeBytes ||
      receipt.error.code !== result.error.code ||
      receipt.error.phase !== result.error.phase ||
      operation.notebookRunIds[0] !== run.runId ||
      operation.provenance.promptMessageId !== run.promptMessageId
    )
      throw new Error('Mismatched failure evidence')
    const reference = (file: (typeof files)[number]): z.infer<typeof evidenceFileSchema> => ({
      path: file.path,
      sha256: file.sha256
    })
    return {
      executionId: receipt.executionId,
      receiptKind: receipt.kind,
      operationId: operation.operationId,
      notebookRunId: run.runId,
      errorCode: receipt.error.code,
      evidence: {
        receipt: reference(files[0]),
        result: reference(files[1]),
        operation: reference(files[2]),
        notebookRuns: reference(files[3])
      }
    }
  } catch {
    throw new Error(
      'Zero-dispatch reconciliation requires matching verified local failure evidence.'
    )
  }
}

/** Actual reported usage is evidence only. Partial, zero or missing usage never refunds a slot. */
export async function recordAcceptanceTrialUsage(
  budgetPath: string,
  seal: AcceptanceBudgetSeal,
  requestedTrial: string,
  value: AcceptanceTrialUsage
): Promise<void> {
  const usage = usageSchema.parse(value)
  await withAcceptanceLedger(budgetPath, seal, (ledger) => {
    const row = ledger.reservations.find((entry) => entry.trialId === requestedTrial)
    if (!row) throw new Error('Usage cannot be attached to an unreserved trial.')
    if (row.usageRecordedAt) {
      if (JSON.stringify(row.usage) !== JSON.stringify(usage))
        throw new Error('Conflicting terminal usage evidence; operator reconciliation is required.')
      return
    }
    row.usage = usage
    row.usageRecordedAt = new Date().toISOString()
  })
}

/** Reads explicitly selected slots, never merges .env into the runner/child process environment. */
export async function readAcceptanceCredentials(
  path: string,
  slots: readonly ResearchExecutionSecretSlot[]
): Promise<Record<string, string>> {
  if (!isAbsolute(path))
    throw new Error('Acceptance credentials require an explicit absolute local file path.')
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error('Acceptance credential file is unavailable.')
  const wanted = new Map(
    slots.map((slot) => [
      researchEnvironmentVariableSchema.parse(slot.environmentVariable),
      slot.key
    ])
  )
  const credentials: Record<string, string> = {}
  const bytes = await readFile(path)
  try {
    for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line.trim())
      if (!match || !wanted.has(match[1])) continue
      let value = match[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1)
      else value = value.replace(/\s+#.*$/u, '').trim()
      if (!value || value.includes('\0') || value.includes('\n') || value.length > 16_384)
        throw new Error('A required local credential is invalid.')
      const key = wanted.get(match[1])!
      if (key in credentials)
        throw new Error('The local credential file contains an ambiguous slot.')
      credentials[key] = value
    }
    if (slots.some((slot) => slot.required && !credentials[slot.key]))
      throw new Error('A required local credential is missing.')
    return credentials
  } catch {
    for (const key of Object.keys(credentials)) delete credentials[key]
    throw new Error('Acceptance credential slots could not be read; no secret values were logged.')
  } finally {
    bytes.fill(0)
  }
}

/** Test-only encryption; exercises the production store/lease path without claiming OS-vault UI coverage. */
export function ephemeralAcceptanceCipher(): {
  encrypt(value: string): string
  decrypt(ref: string): string
  destroy(): void
} {
  const key = randomBytes(32)
  let destroyed = false
  return {
    encrypt(value) {
      if (destroyed) throw new Error('Acceptance cipher is closed.')
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return 'enc:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
    },
    decrypt(ref) {
      if (destroyed || !ref.startsWith('enc:')) throw new Error('Acceptance cipher is unavailable.')
      const bytes = Buffer.from(ref.slice(4), 'base64')
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
    },
    destroy() {
      key.fill(0)
      destroyed = true
    }
  }
}

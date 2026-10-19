import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ResearchExecutionProfileStore } from '../research-execution-profiles/store'
import {
  ephemeralAcceptanceCipher,
  readAcceptanceBudgetSeal,
  readAcceptanceCredentials,
  reconcileAcceptanceAdmissionFailure,
  reconcileAcceptanceZeroDispatchFailure,
  recordAcceptanceAdmissionFailure,
  recordAcceptanceTrialUsage,
  reserveAcceptanceTrial,
  type AcceptanceAdmissionFailure
} from './research-acceptance.test-support'
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})
const sealed = {
  studyId: 'acceptance',
  status: 'sealed',
  unit: 'tokens',
  totalCeiling: 1_000_000_000,
  allocationPerTrialCeiling: 250_000_000,
  maximumUnitsPerTrial: 250_000_000,
  maxRequestsPerTrial: 6,
  countingPolicy: 'input-plus-output-no-double-count-reasoning-v1',
  trialIds: ['author', 'external', 'ordinary', 'fork']
}
async function fixture(): Promise<{ root: string; budgetPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'research-acceptance-budget-'))
  roots.push(root)
  await mkdir(join(root, 'materials'))
  const budgetPath = join(root, 'materials', 'budget.json')
  await writeFile(budgetPath, JSON.stringify(sealed))
  return { root, budgetPath }
}
const zeroUsage: AcceptanceAdmissionFailure['usage'] = {
  unit: 'tokens' as const,
  state: 'complete' as const,
  knownUnits: 0,
  requestCount: 0,
  requestsWithUsage: 0,
  requestsWithoutUsage: 0
}
const digest = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
async function zeroDispatchFixture(): Promise<{
  root: string
  budgetPath: string
  seal: Awaited<ReturnType<typeof readAcceptanceBudgetSeal>>
  paths: Parameters<typeof reconcileAcceptanceZeroDispatchFailure>[3]
  receipt: Record<string, unknown>
  result: Record<string, unknown>
  operation: Record<string, unknown>
  runs: Record<string, unknown>[]
  save(): Promise<void>
}> {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  await recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', zeroUsage)
  const error = { code: 'MAIN_SERVICE_ADAPTER_REQUIRED', phase: 'verify-materials' }
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    kind: 'tuanzi-managed-real-provider-small-trial',
    executionId: 'failed-driver',
    status: 'failed',
    phase: 'finished',
    trialId: 'author',
    budgetDocumentSha256: seal.sha256,
    serviceSpawnAttempted: false,
    childExit: null,
    liveTrialsStarted: 0,
    scientificTrialsStarted: 0,
    requestReservedUnits: 0,
    providerCalls: null,
    usage: zeroUsage,
    error
  }
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'failed',
    runId: null,
    providerCalls: null,
    usage: zeroUsage,
    liveTrialsStarted: 0,
    scientificTrialsStarted: 0,
    validationPassed: false,
    error
  }
  const operation: Record<string, unknown> = {
    schemaVersion: 1,
    operationId: 'failed-operation',
    status: 'failed',
    provenance: { promptMessageId: 'failed-prompt' },
    notebookRunIds: ['failed-notebook-run']
  }
  const runs: Record<string, unknown>[] = [
    {
      runId: 'failed-notebook-run',
      status: 'failed',
      exitCode: 1,
      promptMessageId: 'failed-prompt'
    }
  ]
  const paths = {
    receiptPath: join(f.root, 'execution-receipt.json'),
    resultPath: join(f.root, 'result.json'),
    operationPath: join(f.root, 'operation.json'),
    notebookRunsPath: join(f.root, 'notebook-runs.json')
  }
  const save = async (): Promise<void> => {
    const resultBytes = JSON.stringify(result)
    receipt.outputs = [
      {
        path: 'result.json',
        sizeBytes: Buffer.byteLength(resultBytes),
        sha256: digest(resultBytes)
      }
    ]
    await Promise.all([
      writeFile(paths.receiptPath, JSON.stringify(receipt)),
      writeFile(paths.resultPath, resultBytes),
      writeFile(paths.operationPath, JSON.stringify(operation)),
      writeFile(paths.notebookRunsPath, JSON.stringify(runs))
    ])
  }
  await save()
  return { ...f, seal, paths, receipt, result, operation, runs, save }
}
it('admits one explicitly reconciled zero-dispatch retry while preserving its reservation and failed audit', async () => {
  const f = await zeroDispatchFixture()
  const ledgerPath = join(f.root, 'live-acceptance-budget-ledger.json')
  const before = JSON.parse(await readFile(ledgerPath, 'utf8')).reservations[0]
  await expect(reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')).rejects.toThrow(
    'already reserved'
  )
  await reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  const armed = JSON.parse(await readFile(ledgerPath, 'utf8')).reservations[0]
  expect(armed.usage).toEqual(zeroUsage)
  expect(armed.zeroDispatchReconciliation).toMatchObject({
    previousUsage: zeroUsage,
    previousUsageRecordedAt: before.usageRecordedAt,
    executionId: 'failed-driver',
    receiptKind: 'tuanzi-managed-real-provider-small-trial',
    operationId: 'failed-operation',
    notebookRunId: 'failed-notebook-run',
    errorCode: 'MAIN_SERVICE_ADAPTER_REQUIRED'
  })
  expect(armed.zeroDispatchReconciliation.consumedAt).toBeUndefined()
  for (const [key, path] of Object.entries(f.paths)) {
    const name = key.replace(/Path$/u, '')
    expect(armed.zeroDispatchReconciliation.evidence[name]).toEqual({
      path: await realpath(path),
      sha256: digest(await readFile(path, 'utf8'))
    })
  }
  await expect(
    reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  ).rejects.toThrow('one explicit')
  await reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')
  const consumed = JSON.parse(await readFile(ledgerPath, 'utf8'))
  expect(consumed.reservations).toHaveLength(1)
  expect(consumed.reservations[0]).toMatchObject({
    maximumUnits: before.maximumUnits,
    reservedAt: before.reservedAt,
    usage: { state: 'unknown', knownUnits: null, requestCount: null }
  })
  expect(consumed.reservations[0].usageRecordedAt).toBeUndefined()
  expect(consumed.reservations[0].zeroDispatchReconciliation).toEqual({
    ...armed.zeroDispatchReconciliation,
    consumedAt: expect.any(String)
  })
  await expect(reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')).rejects.toThrow(
    'already reserved'
  )
  await recordAcceptanceTrialUsage(f.budgetPath, f.seal, 'author', zeroUsage)
  await expect(
    reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  ).rejects.toThrow('one explicit')
})
it.each([
  ['receipt', 'status', 'completed'],
  ['receipt', 'trialId', 'external'],
  ['receipt', 'budgetDocumentSha256', '0'.repeat(64)],
  ['receipt', 'serviceSpawnAttempted', true],
  ['receipt', 'serviceSpawnAttempted', undefined],
  ['receipt', 'childExit', 1],
  ['receipt', 'liveTrialsStarted', 1],
  ['receipt', 'scientificTrialsStarted', 1],
  ['receipt', 'requestReservedUnits', 1],
  ['receipt', 'providerCalls', 1],
  ['receipt', 'usage', { ...zeroUsage, state: 'unknown', knownUnits: null }],
  ['result', 'status', 'completed'],
  ['result', 'usage', { ...zeroUsage, requestCount: 1 }],
  ['result', 'validationPassed', true],
  ['result', 'runId', 'started-run'],
  ['result', 'error', { code: 'OTHER_FAILURE', phase: 'verify-materials' }],
  ['operation', 'status', 'completed'],
  ['operation', 'recoveryPending', true],
  ['operation', 'notebookRunIds', ['another-run']],
  ['operation', 'notebookRunIds', ['failed-notebook-run', 'another-run']],
  ['operation', 'provenance', { promptMessageId: 'another-prompt' }]
] as const)(
  'refuses unsafe or mismatched zero-dispatch evidence: %s.%s',
  async (file, key, value) => {
    const f = await zeroDispatchFixture()
    f[file][key] = value
    await f.save()
    const ledgerPath = join(f.root, 'live-acceptance-budget-ledger.json'),
      before = await readFile(ledgerPath, 'utf8')
    await expect(
      reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
    ).rejects.toThrow('verified local failure')
    expect(await readFile(ledgerPath, 'utf8')).toBe(before)
  }
)
it.each([
  'multiple-runs',
  'successful-run',
  'wrong-run',
  'wrong-prompt',
  'changed-result',
  'symlink'
])('refuses unbound or ambiguous selected failure evidence: %s', async (mode) => {
  const f = await zeroDispatchFixture()
  if (mode === 'multiple-runs') f.runs.push({ ...f.runs[0], runId: 'another' })
  if (mode === 'successful-run') f.runs[0].status = 'completed'
  if (mode === 'wrong-run') f.runs[0].runId = 'another'
  if (mode === 'wrong-prompt') f.runs[0].promptMessageId = 'another'
  await f.save()
  if (mode === 'changed-result')
    await writeFile(f.paths.resultPath, JSON.stringify({ ...f.result, extra: 'changed' }))
  if (mode === 'symlink') {
    const linked = join(f.root, 'linked.json')
    await symlink(f.paths.receiptPath, linked)
    f.paths.receiptPath = linked
  }
  await expect(
    reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  ).rejects.toThrow('verified local failure')
})
it('does not reconcile an unknown or unreserved trial even with matching failure files', async () => {
  const f = await zeroDispatchFixture()
  const ledgerPath = join(f.root, 'live-acceptance-budget-ledger.json')
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  ledger.reservations[0].usage = {
    unit: 'tokens',
    state: 'unknown',
    knownUnits: null,
    requestCount: null,
    requestsWithUsage: 0,
    requestsWithoutUsage: null
  }
  await writeFile(ledgerPath, JSON.stringify(ledger))
  await expect(
    reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  ).rejects.toThrow('recorded complete zero')
  ledger.reservations = []
  await writeFile(ledgerPath, JSON.stringify(ledger))
  await expect(
    reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  ).rejects.toThrow('recorded complete zero')
})
it('serializes explicit admission so concurrent duplicate starts consume an arm at most once', async () => {
  const f = await zeroDispatchFixture()
  await reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  const outcomes = await Promise.allSettled([
    reserveAcceptanceTrial(f.budgetPath, f.seal, 'author'),
    reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')
  ])
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
})
async function admissionFailureFixture(
  evidenceBasis: AcceptanceAdmissionFailure['evidenceBasis'] = 'harness-catch'
): Promise<
  Awaited<ReturnType<typeof zeroDispatchFixture>> & {
    receiptPath: string
    admission: AcceptanceAdmissionFailure
  }
> {
  const f = await zeroDispatchFixture()
  const receipt: AcceptanceAdmissionFailure = {
    schemaVersion: 1,
    kind: 'acceptance-before-execution-entry-failure',
    status: 'failed',
    evidenceBasis,
    recordedAt: new Date().toISOString(),
    trialId: 'author',
    budgetDocumentSha256: f.seal.sha256,
    phase: 'prepare',
    dispatchAttempted: false,
    usage: zeroUsage,
    errorCode: 'PREPARE_FAILED',
    source: {
      inputPackageSha256: 'a'.repeat(64),
      descriptorSha256: 'b'.repeat(64),
      sourceIdentity: evidenceBasis === 'harness-catch' ? 'source' : null,
      projectId: 'project',
      sessionId: 'session'
    },
    request: {
      method: 'execution.prepare',
      requestId: 'prepare-research',
      sha256: evidenceBasis === 'harness-catch' ? 'c'.repeat(64) : null
    },
    nativeOperationId: null,
    notebookRunIds: [],
    basisFiles: []
  }
  if (evidenceBasis === 'operator-attestation') {
    for (const [role, bytes] of [
      ['harness-log', 'Synthetic prepare error, before execute.'],
      ['harness-source', 'Synthetic code review: execute follows successful prepare.'],
      [
        'ledger-snapshot',
        await readFile(join(f.root, 'live-acceptance-budget-ledger.json'), 'utf8')
      ]
    ] as const) {
      const path = join(f.root, role + '.txt')
      await writeFile(path, bytes)
      receipt.basisFiles.push({ role, path, sha256: digest(bytes) })
    }
  }
  const receiptPath = join(f.root, 'before-execution-entry-failure.json')
  await recordAcceptanceAdmissionFailure(receiptPath, receipt)
  return { ...f, receiptPath, admission: receipt }
}
it.each(['harness-catch', 'operator-attestation'] as const)(
  'requires explicit one-shot reconciliation for a %s pre-execution failure, retaining original spend',
  async (basis) => {
    const f = await admissionFailureFixture(basis)
    const path = join(f.root, 'live-acceptance-budget-ledger.json')
    const before = JSON.parse(await readFile(path, 'utf8')).reservations[0]
    await expect(reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')).rejects.toThrow(
      'already reserved'
    )
    await expect(
      recordAcceptanceAdmissionFailure(f.receiptPath, f.admission)
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await reconcileAcceptanceAdmissionFailure(f.budgetPath, f.seal, 'author', f.receiptPath)
    const armed = JSON.parse(await readFile(path, 'utf8')).reservations[0]
    expect(armed.admissionFailureReconciliation).toMatchObject({
      previousUsage: zeroUsage,
      previousUsageRecordedAt: before.usageRecordedAt,
      receipt: { sha256: digest(await readFile(f.receiptPath, 'utf8')) },
      attestation: f.admission
    })
    expect(armed.zeroDispatchReconciliation).toBeUndefined()
    await reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')
    const ledger = JSON.parse(await readFile(path, 'utf8'))
    expect(ledger.reservations).toHaveLength(1)
    expect(ledger.reservations[0]).toMatchObject({
      reservedAt: before.reservedAt,
      maximumUnits: before.maximumUnits,
      usage: { state: 'unknown', knownUnits: null },
      admissionFailureReconciliation: { consumedAt: expect.any(String) }
    })
    await expect(reserveAcceptanceTrial(f.budgetPath, f.seal, 'author')).rejects.toThrow(
      'already reserved'
    )
    await recordAcceptanceTrialUsage(f.budgetPath, f.seal, 'author', zeroUsage)
    await expect(
      reconcileAcceptanceAdmissionFailure(f.budgetPath, f.seal, 'author', f.receiptPath)
    ).rejects.toThrow('one explicit')
    await expect(
      reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
    ).rejects.toThrow('one explicit')
  }
)
it.each([
  ['dispatchAttempted', true],
  ['phase', 'execute'],
  ['status', 'completed'],
  ['trialId', 'external'],
  ['budgetDocumentSha256', '0'.repeat(64)],
  ['usage', { ...zeroUsage, state: 'unknown', knownUnits: null }],
  ['nativeOperationId', 'possibly-started'],
  ['notebookRunIds', ['started-run']],
  ['errorCode', 'arbitrary unreviewed server text'],
  ['errorMessage', 'raw sensitive text'],
  [
    'source',
    {
      inputPackageSha256: 'a'.repeat(64),
      descriptorSha256: 'b'.repeat(64),
      sourceIdentity: null,
      projectId: 'p',
      sessionId: 's'
    }
  ],
  ['request', { method: 'execution.prepare', requestId: 'request', sha256: null }]
] as const)(
  'refuses an uncertain or mismatched pre-execution attestation: %s',
  async (key, value) => {
    const f = await admissionFailureFixture()
    await writeFile(f.receiptPath, JSON.stringify({ ...f.admission, [key]: value }))
    const ledgerPath = join(f.root, 'live-acceptance-budget-ledger.json'),
      before = await readFile(ledgerPath, 'utf8')
    await expect(
      reconcileAcceptanceAdmissionFailure(f.budgetPath, f.seal, 'author', f.receiptPath)
    ).rejects.toThrow('reviewed pre-execution')
    expect(await readFile(ledgerPath, 'utf8')).toBe(before)
  }
)
it.each([
  'missing-log',
  'changed-source',
  'mismatched-ledger',
  'unknown-current-usage',
  'prior-reconciliation'
])('refuses insufficient or stale manual review evidence: %s', async (mode) => {
  const f = await admissionFailureFixture('operator-attestation')
  const ledgerPath = join(f.root, 'live-acceptance-budget-ledger.json')
  if (mode === 'missing-log')
    f.admission.basisFiles = f.admission.basisFiles.filter((file) => file.role !== 'harness-log')
  if (mode === 'changed-source')
    await writeFile(
      f.admission.basisFiles.find((file) => file.role === 'harness-source')!.path,
      'Changed code'
    )
  if (mode === 'mismatched-ledger') {
    const basis = f.admission.basisFiles.find((file) => file.role === 'ledger-snapshot')!
    const value = JSON.parse(await readFile(basis.path, 'utf8'))
    value.reservations[0].reservedAt = 'another reservation'
    const bytes = JSON.stringify(value)
    await writeFile(basis.path, bytes)
    basis.sha256 = digest(bytes)
  }
  if (mode === 'unknown-current-usage') {
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    delete ledger.reservations[0].usageRecordedAt
    await writeFile(ledgerPath, JSON.stringify(ledger))
  }
  if (mode === 'prior-reconciliation')
    await reconcileAcceptanceZeroDispatchFailure(f.budgetPath, f.seal, 'author', f.paths)
  await writeFile(f.receiptPath, JSON.stringify(f.admission))
  const before = await readFile(ledgerPath, 'utf8')
  await expect(
    reconcileAcceptanceAdmissionFailure(f.budgetPath, f.seal, 'author', f.receiptPath)
  ).rejects.toThrow()
  expect(await readFile(ledgerPath, 'utf8')).toBe(before)
})
it.each([
  { status: 'pending' },
  { unit: 'CNY' },
  { maximumUnitsPerTrial: null },
  { countingPolicy: 'unknown' },
  { totalCeiling: 1_000_000_001 },
  { maximumUnitsPerTrial: 250_000_001 },
  { maxRequestsPerTrial: 7 },
  { totalCeiling: 999_999_999 },
  { maximumUnitsPerTrial: 0.5 },
  { trialIds: ['author', 'author', 'ordinary', 'fork'] }
])('blocks an unsealed or unsafe budget before any credential access: %j', async (change) => {
  const f = await fixture()
  await writeFile(f.budgetPath, JSON.stringify({ ...sealed, ...change }))
  await expect(readAcceptanceBudgetSeal(f.budgetPath)).rejects.toThrow('not sealed')
  await expect(readFile(join(f.root, 'live-acceptance-budget-ledger.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})
it('defaults omitted carry-over to zero for reviewed seals and existing v2 ledgers', async () => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  expect(seal.carriedReservedUnits).toBe(0)
  await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  const path = join(f.root, 'live-acceptance-budget-ledger.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  expect(original.carriedReservedUnits).toBe(0)
  delete original.carriedReservedUnits
  await writeFile(path, JSON.stringify(original))
  await reserveAcceptanceTrial(f.budgetPath, seal, 'external')
  const resumed = JSON.parse(await readFile(path, 'utf8'))
  expect(resumed.carriedReservedUnits).toBe(0)
  expect(resumed.reservations).toHaveLength(2)
  expect(resumed.reservations[0]).toEqual(original.reservations[0])
})
it('counts an unknown prior-study reservation alongside all four amended-trial bounds', async () => {
  const f = await fixture()
  const amended = {
    ...sealed,
    carriedReservedUnits: 12_582_912,
    allocationPerTrialCeiling: 246_854_272,
    maximumUnitsPerTrial: 12_582_912
  }
  await writeFile(f.budgetPath, JSON.stringify(amended))
  const seal = await readAcceptanceBudgetSeal(f.budgetPath)
  expect(seal.carriedReservedUnits + seal.allocationPerTrialCeiling * 4).toBe(1_000_000_000)
  for (const id of sealed.trialIds) await reserveAcceptanceTrial(f.budgetPath, seal, id)
  const ledger = JSON.parse(
    await readFile(join(f.root, 'live-acceptance-budget-ledger.json'), 'utf8')
  )
  expect(ledger.carriedReservedUnits).toBe(12_582_912)
  expect(
    ledger.carriedReservedUnits +
      ledger.reservations.reduce(
        (total: number, row: { maximumUnits: number }) => total + row.maximumUnits,
        0
      )
  ).toBe(62_914_560)
  expect(
    ledger.reservations.every(
      (row: { usage: { knownUnits: number | null } }) => row.usage.knownUnits === null
    )
  ).toBe(true)
  await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'author')).rejects.toThrow(
    'already reserved'
  )
})
it.each([-1, 0.5, 1_000_000_001, null, '12582912'])(
  'rejects an invalid carry-over value: %j',
  async (carriedReservedUnits) => {
    const f = await fixture()
    await writeFile(f.budgetPath, JSON.stringify({ ...sealed, carriedReservedUnits }))
    await expect(readAcceptanceBudgetSeal(f.budgetPath)).rejects.toThrow('not sealed')
  }
)
it('rejects allocation ceilings that omit the prior-study carry-over', async () => {
  const f = await fixture()
  await writeFile(f.budgetPath, JSON.stringify({ ...sealed, carriedReservedUnits: 12_582_912 }))
  await expect(readAcceptanceBudgetSeal(f.budgetPath)).rejects.toThrow('not sealed')
})
it.each([0, 12_582_911, -1, '12582912', null, undefined])(
  'refuses a corrupt or mismatched ledger carry-over without mutating evidence: %j',
  async (carry) => {
    const f = await fixture()
    await writeFile(
      f.budgetPath,
      JSON.stringify({
        ...sealed,
        carriedReservedUnits: 12_582_912,
        allocationPerTrialCeiling: 246_854_272,
        maximumUnitsPerTrial: 12_582_912
      })
    )
    const seal = await readAcceptanceBudgetSeal(f.budgetPath)
    await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
    const path = join(f.root, 'live-acceptance-budget-ledger.json')
    const ledger = JSON.parse(await readFile(path, 'utf8'))
    ledger.carriedReservedUnits = carry
    const bytes = JSON.stringify(ledger)
    await writeFile(path, bytes)
    await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'external')).rejects.toThrow()
    await expect(
      recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', zeroUsage)
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
)
it('reserves each of four trials once, across reruns, with failures never freeing spend', async () => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  for (const id of sealed.trialIds) await reserveAcceptanceTrial(f.budgetPath, seal, id)
  for (const id of sealed.trialIds)
    await expect(reserveAcceptanceTrial(f.budgetPath, seal, id)).rejects.toThrow('already reserved')
  await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'extra')).rejects.toThrow('not in')
  const ledger = JSON.parse(
    await readFile(join(f.root, 'live-acceptance-budget-ledger.json'), 'utf8')
  )
  expect(
    ledger.reservations.reduce(
      (sum: number, row: { maximumUnits: number }) => sum + row.maximumUnits,
      0
    )
  ).toBe(1_000_000_000)
})
it('reserves the reviewed workload bound rather than treating the billion-token cap as expected usage', async () => {
  const f = await fixture()
  await writeFile(f.budgetPath, JSON.stringify({ ...sealed, maximumUnitsPerTrial: 12_582_912 }))
  const seal = await readAcceptanceBudgetSeal(f.budgetPath)
  for (const id of sealed.trialIds) await reserveAcceptanceTrial(f.budgetPath, seal, id)
  const ledger = JSON.parse(
    await readFile(join(f.root, 'live-acceptance-budget-ledger.json'), 'utf8')
  )
  expect(
    ledger.reservations.reduce(
      (sum: number, row: { maximumUnits: number }) => sum + row.maximumUnits,
      0
    )
  ).toBe(50_331_648)
  expect(
    ledger.reservations.every(
      (row: { usage: { knownUnits: number | null } }) => row.usage.knownUnits === null
    )
  ).toBe(true)
})
it('refuses concurrent or changed-budget admission without resetting prior spend', async () => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  const concurrent = await Promise.allSettled([
    reserveAcceptanceTrial(f.budgetPath, seal, 'author'),
    reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  ])
  expect(concurrent.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
  await writeFile(f.budgetPath, JSON.stringify({ ...sealed, maximumUnitsPerTrial: 20 }))
  const changed = await readAcceptanceBudgetSeal(f.budgetPath)
  await expect(reserveAcceptanceTrial(f.budgetPath, changed, 'external')).rejects.toThrow(
    'another sealed study'
  )
})
it('retains unknown usage and a full reservation after a failed or uncertain attempt', async () => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  const ledger = JSON.parse(
    await readFile(join(f.root, 'live-acceptance-budget-ledger.json'), 'utf8')
  )
  expect(ledger.reservations[0]).toMatchObject({
    maximumUnits: 250_000_000,
    usage: {
      unit: 'tokens',
      state: 'unknown',
      knownUnits: null,
      requestCount: null,
      requestsWithUsage: 0,
      requestsWithoutUsage: null
    }
  })
  await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'author')).rejects.toThrow(
    'already reserved'
  )
})
it('records partial and explicit zero-request evidence without refunding or inventing missing usage', async () => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  const partial = {
    unit: 'tokens' as const,
    state: 'partial' as const,
    knownUnits: 31,
    requestCount: 2,
    requestsWithUsage: 1,
    requestsWithoutUsage: 1
  }
  await recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', partial)
  await recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', partial)
  await expect(
    recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', { ...partial, knownUnits: 32 })
  ).rejects.toThrow('Conflicting')
  await reserveAcceptanceTrial(f.budgetPath, seal, 'ordinary')
  await recordAcceptanceTrialUsage(f.budgetPath, seal, 'ordinary', {
    unit: 'tokens',
    state: 'complete',
    knownUnits: 0,
    requestCount: 0,
    requestsWithUsage: 0,
    requestsWithoutUsage: 0
  })
  const ledger = JSON.parse(
    await readFile(join(f.root, 'live-acceptance-budget-ledger.json'), 'utf8')
  )
  expect(ledger.reservations.map((row: { maximumUnits: number }) => row.maximumUnits)).toEqual([
    250_000_000, 250_000_000
  ])
  expect(ledger.reservations[0].usage).toEqual(partial)
  await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'ordinary')).rejects.toThrow(
    'already reserved'
  )
})
it.each([
  {
    unit: 'tokens',
    state: 'unknown',
    knownUnits: 0,
    requestCount: 1,
    requestsWithUsage: 0,
    requestsWithoutUsage: 1
  },
  {
    unit: 'tokens',
    state: 'complete',
    knownUnits: 0,
    requestCount: 1,
    requestsWithUsage: 0,
    requestsWithoutUsage: 1
  },
  {
    unit: 'tokens',
    state: 'partial',
    knownUnits: 10,
    requestCount: 1,
    requestsWithUsage: 1,
    requestsWithoutUsage: 1
  }
])('rejects contradictory usage without mutating the reservation: %j', async (usage) => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  const path = join(f.root, 'live-acceptance-budget-ledger.json'),
    before = await readFile(path, 'utf8')
  await expect(
    recordAcceptanceTrialUsage(
      f.budgetPath,
      seal,
      'author',
      usage as Parameters<typeof recordAcceptanceTrialUsage>[3]
    )
  ).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(before)
})
it.each([
  { knownUnits: 250_000_001, requestCount: 1, requestsWithUsage: 1 },
  { knownUnits: 30, requestCount: 7, requestsWithUsage: 7 }
])('retains observed overrun evidence and blocks further trials: %j', async (actual) => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
  await recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', {
    unit: 'tokens',
    state: 'complete',
    requestsWithoutUsage: 0,
    ...actual
  })
  await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'external')).rejects.toThrow(
    'exceeded its reviewed bound'
  )
})
it.each(['corrupt', 'old-currency', 'changed-reservation'])(
  'fails closed for a tampered ledger: %s',
  async (mode) => {
    const f = await fixture(),
      seal = await readAcceptanceBudgetSeal(f.budgetPath)
    await reserveAcceptanceTrial(f.budgetPath, seal, 'author')
    const path = join(f.root, 'live-acceptance-budget-ledger.json')
    const ledger = JSON.parse(await readFile(path, 'utf8'))
    if (mode === 'old-currency') ledger.version = 1
    if (mode === 'changed-reservation') ledger.reservations[0].maximumUnits = 1
    const bytes = mode === 'corrupt' ? '{' : JSON.stringify(ledger)
    await writeFile(path, bytes)
    await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'external')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
)
it('rejects a changed seal after it was read and does not attach usage to an unreserved trial', async () => {
  const f = await fixture(),
    seal = await readAcceptanceBudgetSeal(f.budgetPath)
  await expect(
    recordAcceptanceTrialUsage(f.budgetPath, seal, 'author', {
      unit: 'tokens',
      state: 'unknown',
      knownUnits: null,
      requestCount: null,
      requestsWithUsage: 0,
      requestsWithoutUsage: null
    })
  ).rejects.toThrow('unreserved')
  await writeFile(f.budgetPath, JSON.stringify({ ...sealed, maximumUnitsPerTrial: 100 }))
  await expect(reserveAcceptanceTrial(f.budgetPath, seal, 'author')).rejects.toThrow(
    'changed after review'
  )
})
it('uses only selected slots through production encrypted profile save/lease, keeping the key ephemeral', async () => {
  const f = await fixture(),
    cipher = ephemeralAcceptanceCipher()
  const slots = [
    {
      key: 'provider',
      description: 'Provider',
      environmentVariable: 'ACCEPTANCE_API_KEY',
      required: true
    }
  ]
  const env = join(f.root, '.env')
  await writeFile(
    env,
    'UNRELATED_KEY=not-selected\nACCEPTANCE_API_KEY="synthetic-credential-for-local-test"\n'
  )
  const credentials = await readAcceptanceCredentials(env, slots)
  const binding = {
    projectId: 'project',
    sourceSessionId: 'source',
    sourceIdentity: 'source-identity',
    descriptorVersionId: 'descriptor',
    descriptorSha256: 'a'.repeat(64),
    planKey: 'trial'
  }
  const store = new ResearchExecutionProfileStore(join(f.root, 'isolated-config'), cipher)
  const profile = await store.save(
    { ...binding, sessionId: 'ordinary', displayName: 'Isolated acceptance', credentials },
    binding,
    slots
  )
  for (const key of Object.keys(credentials)) delete credentials[key]
  const encoded = await readFile(
    join(f.root, 'isolated-config', 'research-execution-profiles.json'),
    'utf8'
  )
  expect(encoded.includes('synthetic-credential-for-local-test')).toBe(false)
  expect(encoded.includes('not-selected')).toBe(false)
  const lease = await store.lease(profile.profileId, binding, slots)
  expect(Object.keys(lease.privateEnvironment)).toEqual(['ACCEPTANCE_API_KEY'])
  expect(
    lease.privateEnvironment.ACCEPTANCE_API_KEY === 'synthetic-credential-for-local-test'
  ).toBe(true)
  lease.release()
  expect(lease.privateEnvironment).toEqual({})
  cipher.destroy()
  await expect(store.lease(profile.profileId, binding, slots)).rejects.toThrow('unavailable')
})

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()

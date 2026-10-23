import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactReproducibilityReceipt } from '../../shared/artifact-reproducibility'
import { sha256 } from './provenance-canonical'
import { compareReproducedContent } from '@aipoch/reproducibility'
import {
  ArtifactReproducibilityReceiptStore,
  validateArtifactReproducibilityReceiptStorage,
  type ArtifactReproducibilityReceiptDraft
} from './artifact-reproducibility-receipts'

const roots: string[] = []
const request = {
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactId: 'artifact-1',
  versionId: 'version-1'
}

const draft: ArtifactReproducibilityReceiptDraft = {
  schemaVersion: 1,
  receiptId: 'attempt-1',
  startedAt: '2026-09-02T00:00:00.000Z',
  completedAt: '2026-09-02T00:01:00.000Z',
  outcome: 'matched',
  artifactVersion: {
    ...request,
    targetChecksum: 'a'.repeat(64)
  },
  frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
  recipe: { recipeId: 'b'.repeat(64), graphChecksum: 'c'.repeat(64) },
  environmentLocks: [
    {
      requirementId: 'python:analysis',
      kernelKind: 'python',
      environmentName: 'analysis',
      lockChecksum: 'd'.repeat(64)
    }
  ],
  completedStepIds: ['notebook:run-1'],
  comparisons: [
    {
      stepId: 'notebook:run-1',
      entityId: 'file-1',
      relativePath: 'result.csv',
      expectedChecksum: 'e'.repeat(64),
      expectedSizeBytes: 12,
      actualChecksum: 'e'.repeat(64),
      actualSizeBytes: 12,
      status: 'matched'
    }
  ]
}

const contextReceiptDraft = (): ArtifactReproducibilityReceiptDraft => ({
  ...structuredClone(draft),
  schemaVersion: 2,
  frontier: { frontierId: 'workflow-selection', claimScope: 'downstream-only' },
  workflow: {
    captureId: '1'.repeat(64),
    targetRunIds: ['de'],
    planId: draft.recipe.recipeId,
    verification: 'state-comparison',
    executionOnlyTargetRunIds: []
  },
  environmentLocks: [
    {
      requirementId: 'r:analysis',
      kernelKind: 'r',
      lockChecksum: 'd'.repeat(64),
      sourceLockChecksum: 'e'.repeat(64),
      runtimeSubset: {
        schemaVersion: 1,
        scopeChecksum: '2'.repeat(64),
        planChecksum: '3'.repeat(64),
        archiveNames: ['r-base-4.5.3-test_0.conda', 'r-jsonlite-2.0.0-test_0.tar.bz2'],
        missingDependencies: [{ packageName: 'r-base', dependency: 'runtime-support >=1.0' }]
      }
    }
  ],
  completedStepIds: ['step:de'],
  comparisons: [
    {
      stepId: 'step:de',
      entityId: 'r-state:de',
      relativePath: 'R state (de)',
      expectedChecksum: 'e'.repeat(64),
      expectedSizeBytes: 256,
      status: 'matched',
      stateComparison: {
        outcome: 'equal',
        scientificOutcome: 'equal',
        packageContext: {
          schemaVersion: 1,
          sourcePackages: ['DESeq2', 'stats', 'base'],
          targetPackages: ['stats', 'base']
        }
      }
    }
  ]
})

const createStore = async (): Promise<{
  root: string
  store: ArtifactReproducibilityReceiptStore
}> => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-reproducibility-receipts-'))
  roots.push(root)
  return {
    root,
    store: new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => root
    })
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ArtifactReproducibilityReceiptStore', () => {
  it.each([
    { outcome: 'equal', scientificOutcome: 'equal' },
    { outcome: 'different', scientificOutcome: 'equal' },
    { outcome: 'different', scientificOutcome: 'different' }
  ] as const)(
    'round-trips scoped subset summaries and package context with $outcome/$scientificOutcome outcomes',
    async ({ outcome, scientificOutcome }) => {
      const { root, store } = await createStore()
      const candidate = contextReceiptDraft()
      const comparison = candidate.comparisons[0]!
      comparison.stateComparison!.outcome = outcome
      comparison.stateComparison!.scientificOutcome = scientificOutcome
      if (outcome === 'different') {
        candidate.outcome = 'different'
        comparison.status = 'different'
        comparison.reason = 'checksum-mismatch'
      }
      const saved = await store.append(request, candidate)
      const reopened = new ArtifactReproducibilityReceiptStore({
        resolveVersionDirectory: async () => root
      })
      expect((await reopened.list(request)).receipts[0]).toEqual(saved)
      expect(saved.comparisons[0]!.stateComparison!.packageContext!.sourcePackages).toEqual([
        'DESeq2',
        'stats',
        'base'
      ])
      expect((await reopened.packageFiles(request)).lockChecksums.sort()).toEqual([
        'd'.repeat(64),
        'e'.repeat(64)
      ])
      expect((await reopened.packageFiles(request)).lockChecksums).not.toContain('3'.repeat(64))
    }
  )

  it.each([
    'science-missing',
    'science-without-context',
    'science-conflict',
    'science-unknown',
    'state-extra',
    'context-schema',
    'context-extra',
    'empty',
    'duplicate',
    'invalid-name',
    'non-string',
    'oversized',
    'long-name'
  ])('rejects malformed package context evidence: %s', async (scenario) => {
    const { store } = await createStore()
    const candidate = contextReceiptDraft()
    const state = candidate.comparisons[0]!.stateComparison!
    const context = state.packageContext!
    if (scenario === 'science-missing') delete state.scientificOutcome
    if (scenario === 'science-without-context') delete state.packageContext
    if (scenario === 'science-conflict') state.scientificOutcome = 'different'
    if (scenario === 'science-unknown') Object.assign(state, { scientificOutcome: 'unknown' })
    if (scenario === 'state-extra') Object.assign(state, { certified: true })
    if (scenario === 'context-schema') Object.assign(context, { schemaVersion: 2 })
    if (scenario === 'context-extra') Object.assign(context, { ignored: true })
    if (scenario === 'empty') context.sourcePackages = []
    if (scenario === 'duplicate') context.targetPackages.push('base')
    if (scenario === 'invalid-name') context.sourcePackages[0] = '../DESeq2'
    if (scenario === 'non-string') Object.assign(context, { sourcePackages: [1] })
    if (scenario === 'oversized')
      context.targetPackages = Array.from({ length: 4097 }, (_, i) => `Package${i}`)
    if (scenario === 'long-name') context.sourcePackages[0] = 'A'.repeat(129)
    await expect(store.append(request, candidate)).rejects.toThrow(
      'Invalid reproducibility receipt'
    )
  })

  it.each([
    'schema',
    'scope-hash',
    'plan-hash',
    'extra',
    'python',
    'empty',
    'duplicate',
    'path',
    'windows-path',
    'url',
    'extension',
    'long-archive',
    'many-archives',
    'edge-extra',
    'edge-name',
    'edge-spec',
    'edge-long',
    'edge-duplicate',
    'many-edges'
  ])('rejects malformed runtime subset summaries: %s', async (scenario) => {
    const { store } = await createStore()
    const candidate = contextReceiptDraft()
    const lock = candidate.environmentLocks[0]!
    const summary = lock.runtimeSubset!
    if (scenario === 'schema') Object.assign(summary, { schemaVersion: 2 })
    if (scenario === 'scope-hash') summary.scopeChecksum = 'invalid'
    if (scenario === 'plan-hash') summary.planChecksum = 'F'.repeat(64)
    if (scenario === 'extra') Object.assign(summary, { certified: true })
    if (scenario === 'python') lock.kernelKind = 'python'
    if (scenario === 'empty') summary.archiveNames = []
    if (scenario === 'duplicate') summary.archiveNames.push(summary.archiveNames[0]!)
    if (scenario === 'path') summary.archiveNames[0] = '../r-base-4.5.3-test_0.conda'
    if (scenario === 'windows-path')
      summary.archiveNames[0] = 'C:\\cache\\r-base-4.5.3-test_0.conda'
    if (scenario === 'url')
      summary.archiveNames[0] = 'https://example.test/r-base-4.5.3-test_0.conda'
    if (scenario === 'extension') summary.archiveNames[0] = 'r-base-4.5.3-test_0.zip'
    if (scenario === 'long-archive')
      summary.archiveNames[0] = `r-${'a'.repeat(1024)}-1.0-test_0.conda`
    if (scenario === 'many-archives')
      summary.archiveNames = Array.from({ length: 10001 }, (_, i) => `pkg${i}-1.0-test_0.conda`)
    if (scenario === 'edge-extra') Object.assign(summary.missingDependencies[0]!, { ignored: true })
    if (scenario === 'edge-name') summary.missingDependencies[0]!.packageName = '../r-base'
    if (scenario === 'edge-spec') summary.missingDependencies[0]!.dependency = 'support\nother'
    if (scenario === 'edge-long') summary.missingDependencies[0]!.dependency = 'x'.repeat(4097)
    if (scenario === 'edge-duplicate')
      summary.missingDependencies.push({ ...summary.missingDependencies[0]! })
    if (scenario === 'many-edges')
      summary.missingDependencies = Array.from({ length: 10001 }, (_, i) => ({
        packageName: 'r-base',
        dependency: `pkg${i}`
      }))
    await expect(store.append(request, candidate)).rejects.toThrow(
      'Invalid reproducibility receipt'
    )
  })

  it('detects tampering with a persisted subset scope even when its new digest has a valid format', async () => {
    const { root, store } = await createStore()
    const saved = await store.append(request, contextReceiptDraft())
    const filePath = join(root, 'reproducibility-checks', `sha256-${saved.receiptChecksum}.json`)
    const changed = JSON.parse(await readFile(filePath, 'utf8'))
    changed.environmentLocks[0].runtimeSubset.scopeChecksum = '9'.repeat(64)
    await writeFile(filePath, JSON.stringify(changed))
    await expect(store.get(request, saved.receiptChecksum)).rejects.toThrow(
      'receipt checksum mismatch'
    )
  })

  it.each(['equal', 'different'] as const)(
    'persists verified R object outputs: %s',
    async (outcome) => {
      const { store } = await createStore()
      const stateDraft: ArtifactReproducibilityReceiptDraft = {
        ...draft,
        schemaVersion: 2,
        outcome: outcome === 'equal' ? 'matched' : 'different',
        frontier: { frontierId: 'workflow-selection', claimScope: 'downstream-only' },
        workflow: {
          captureId: '1'.repeat(64),
          targetRunIds: ['de'],
          planId: draft.recipe.recipeId,
          verification: 'state-comparison',
          executionOnlyTargetRunIds: []
        },
        completedStepIds: ['step:de'],
        comparisons: [
          {
            stepId: 'step:de',
            entityId: 'r-state:de',
            relativePath: 'R state (de)',
            expectedChecksum: 'e'.repeat(64),
            expectedSizeBytes: 256,
            stateComparison: { outcome },
            status: outcome === 'equal' ? 'matched' : 'different',
            ...(outcome === 'different' ? { reason: 'checksum-mismatch' as const } : {})
          }
        ]
      }
      const receipt = await store.append(request, stateDraft)
      expect((await store.list(request)).receipts[0]).toEqual(receipt)
      await expect(
        store.append(request, {
          ...stateDraft,
          workflow: { ...stateDraft.workflow!, verification: 'file-comparison' }
        })
      ).rejects.toThrow()
      await expect(
        store.append(request, {
          ...stateDraft,
          comparisons: [
            { ...stateDraft.comparisons[0]!, status: outcome === 'equal' ? 'different' : 'matched' }
          ]
        })
      ).rejects.toThrow()
      const mixed = await store.append(request, {
        ...stateDraft,
        receiptId: `mixed-${outcome}`,
        outcome: 'executed',
        completedStepIds: ['step:de', 'step:python-memory'],
        workflow: {
          ...stateDraft.workflow!,
          targetRunIds: ['de', 'python-memory'],
          verification: 'execution-only',
          executionOnlyTargetRunIds: ['python-memory']
        }
      })
      expect((await store.list(request)).receipts).toContainEqual(mixed)
    }
  )
  it('round-trips execution-only workflow receipts without claiming a match', async () => {
    const { store } = await createStore()
    const workflow = {
      captureId: '1'.repeat(64),
      targetRunIds: ['memory-stage'],
      planId: draft.recipe.recipeId,
      verification: 'execution-only' as const,
      executionOnlyTargetRunIds: ['memory-stage']
    }
    const saved = await store.append(request, {
      ...draft,
      schemaVersion: 2,
      frontier: { frontierId: 'workflow-selection', claimScope: 'downstream-only' },
      outcome: 'executed',
      workflow,
      comparisons: []
    })
    expect((await store.list(request)).receipts[0]).toEqual(saved)
    await expect(
      store.append(request, { ...draft, outcome: 'executed', comparisons: [] })
    ).rejects.toThrow()
    await expect(
      store.append(request, { ...draft, workflow, outcome: 'matched' })
    ).rejects.toThrow()
  })
  it('preserves the actual derived lock and its source when reopening and packaging receipts', async () => {
    const { root, store } = await createStore()
    const environmentLocks = [{ ...draft.environmentLocks[0]!, sourceLockChecksum: 'a'.repeat(64) }]
    const receipt = await store.append(request, { ...draft, schemaVersion: 2, environmentLocks })
    const reopened = new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => root
    })
    expect((await reopened.list(request)).receipts[0]).toEqual(receipt)
    expect((await reopened.list(request)).receipts[0]!.environmentLocks).toEqual(environmentLocks)
    expect((await reopened.packageFiles(request)).lockChecksums.sort()).toEqual([
      'a'.repeat(64),
      'd'.repeat(64)
    ])
    await expect(
      store.append(request, {
        ...draft,
        environmentLocks: [{ ...environmentLocks[0]!, sourceLockChecksum: 'invalid' }]
      })
    ).rejects.toThrow()
  })
  it.each(['unsupported-format', 'budget-exceeded', 'comparison-failed'] as const)(
    'persists the unavailable content comparison reason %s',
    async (reason) => {
      const { store } = await createStore()
      const receipt = await store.append(request, {
        ...draft,
        schemaVersion: 2,
        outcome: 'different',
        comparisons: [
          {
            ...draft.comparisons[0]!,
            status: 'different',
            reason: 'checksum-mismatch',
            actualChecksum: 'f'.repeat(64),
            contentComparisonUnavailableReason: reason
          }
        ]
      })
      expect((await store.list(request)).receipts[0]).toEqual(receipt)
    }
  )
  it('round-trips v2 content rules and metrics and rejects mismatched evidence', async () => {
    const { store } = await createStore()
    const expected = Buffer.from('x\n1\n'),
      actual = Buffer.from('x\r\n1\r\n')
    const { report } = await compareReproducedContent({ filename: 'x.csv', expected, actual })
    const comparison = {
      ...draft.comparisons[0]!,
      status: 'different' as const,
      reason: 'size-mismatch' as const,
      expectedSizeBytes: expected.length,
      actualSizeBytes: actual.length,
      expectedChecksum: report.expectedChecksum,
      actualChecksum: report.actualChecksum,
      contentComparison: report
    }
    const receipt = await store.append(request, {
      ...draft,
      schemaVersion: 2,
      outcome: 'different',
      comparisons: [comparison]
    })
    expect((await store.list(request)).receipts[0]).toEqual(receipt)
    await expect(
      store.append(request, {
        ...draft,
        schemaVersion: 2,
        outcome: 'different',
        comparisons: [{ ...comparison, contentComparisonUnavailableReason: 'unsupported-format' }]
      })
    ).rejects.toThrow('Invalid reproducibility receipt')
    await expect(
      store.append(request, {
        ...draft,
        schemaVersion: 2,
        outcome: 'different',
        comparisons: [
          { ...comparison, contentComparison: { ...report, actualChecksum: 'f'.repeat(64) } }
        ]
      })
    ).rejects.toThrow('Invalid reproducibility receipt')
  })
  it('clears deduplicated output without rewriting receipts and preserves that decision after recapture', async () => {
    const { root, store } = await createStore()
    const bytes = Buffer.from('changed output')
    const comparison = {
      ...draft.comparisons[0]!,
      status: 'different' as const,
      reason: 'checksum-mismatch' as const,
      outputCaptured: true as const,
      actualChecksum: sha256(bytes),
      actualSizeBytes: bytes.length
    }
    await store.retainOutput(request, bytes)
    const first = await store.append(request, {
      ...draft,
      outcome: 'different',
      comparisons: [comparison]
    })
    await store.retainOutput(request, bytes)
    const second = await store.append(request, {
      ...draft,
      receiptId: 'second',
      outcome: 'different',
      comparisons: [comparison]
    })
    expect(await store.outputStorage(request)).toEqual({
      sizeBytes: bytes.length,
      fileCount: 1,
      clearedReceiptChecksums: []
    })
    const receiptPath = join(root, 'reproducibility-checks', `sha256-${first.receiptChecksum}.json`)
    const originalReceipt = await readFile(receiptPath, 'utf8')
    const cleared = await store.clearOutputs(request)
    expect(cleared).toEqual({
      sizeBytes: 0,
      fileCount: 0,
      clearedReceiptChecksums: [first.receiptChecksum, second.receiptChecksum].sort()
    })
    expect(await readFile(receiptPath, 'utf8')).toBe(originalReceipt)
    await expect(
      store.getOutput(request, first.receiptChecksum, comparison.entityId)
    ).rejects.toThrow('cleared')
    await expect(store.list(request)).resolves.toMatchObject({
      receipts: expect.arrayContaining([first, second])
    })
    await expect(validateArtifactReproducibilityReceiptStorage(root)).resolves.toBeUndefined()
    // Retrying cleanup is safe, including after a new process opens the same store.
    const reopened = new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => root
    })
    expect(await reopened.clearOutputs(request)).toEqual(cleared)
    await reopened.retainOutput(request, bytes)
    const third = await reopened.append(request, {
      ...draft,
      receiptId: 'third',
      outcome: 'different',
      comparisons: [comparison]
    })
    await reopened.pruneOutputs(request)
    await expect(
      reopened.getOutput(request, third.receiptChecksum, comparison.entityId)
    ).resolves.toEqual(bytes)
    await expect(
      reopened.getOutput(request, first.receiptChecksum, comparison.entityId)
    ).rejects.toThrow('cleared')
    await expect(validateArtifactReproducibilityReceiptStorage(root)).resolves.toBeUndefined()
  })

  it('fails closed on a corrupt cleanup marker without removing output', async () => {
    const { root, store } = await createStore()
    await store.clearOutputs(request)
    const bytes = Buffer.from('keep')
    await store.retainOutput(request, bytes)
    await writeFile(join(root, 'reproducibility-checks', 'output-retention', 'cleared.json'), '{}')
    await expect(store.clearOutputs(request)).rejects.toThrow()
    expect(await readdir(join(root, 'reproducibility-checks', 'outputs'))).toEqual([
      `sha256-${sha256(bytes)}.bin`
    ])
  })
  it('binds retained output to a published receipt and prunes only unreferenced bytes', async () => {
    const { root, store } = await createStore()
    const bytes = Buffer.from('reproduced\n')
    const comparison = {
      ...draft.comparisons[0]!,
      status: 'different' as const,
      reason: 'checksum-mismatch' as const,
      outputCaptured: true as const,
      actualChecksum: sha256(bytes),
      actualSizeBytes: bytes.length
    }
    await expect(
      store.append(request, { ...draft, outcome: 'different', comparisons: [comparison] })
    ).rejects.toThrow()
    await store.retainOutput(request, bytes)
    const receipt = await store.append(request, {
      ...draft,
      outcome: 'different',
      comparisons: [comparison]
    })
    await store.retainOutput(request, Buffer.from('cancelled'))
    await store.pruneOutputs(request)
    await expect(
      store.getOutput(request, receipt.receiptChecksum, comparison.entityId)
    ).resolves.toEqual(bytes)
    await expect(store.getOutput(request, receipt.receiptChecksum, 'unrelated')).rejects.toThrow(
      'unavailable'
    )
    await expect(
      store.getOutput(
        { ...request, versionId: 'other' },
        receipt.receiptChecksum,
        comparison.entityId
      )
    ).rejects.toThrow()
    expect(await readdir(join(root, 'reproducibility-checks', 'outputs'))).toEqual([
      `sha256-${sha256(bytes)}.bin`
    ])
  })
  it('treats historical Artifact Versions without receipt storage as an empty history', async () => {
    const { root, store } = await createStore()

    await expect(store.list(request)).resolves.toEqual({ receipts: [] })
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('publishes canonical content-addressed receipts and reads newest first', async () => {
    const { root, store } = await createStore()
    const first = await store.append(request, draft)
    const second = await store.append(request, {
      ...draft,
      receiptId: 'attempt-2',
      startedAt: '2026-09-02T00:02:00.000Z',
      completedAt: '2026-09-02T00:03:00.000Z',
      outcome: 'different',
      comparisons: [{ ...draft.comparisons[0]!, status: 'different', reason: 'checksum-mismatch' }]
    })

    expect(first.receiptChecksum).toMatch(/^[0-9a-f]{64}$/u)
    expect(second.receiptChecksum).not.toBe(first.receiptChecksum)
    expect(await readdir(join(root, 'reproducibility-checks'))).toEqual(
      expect.arrayContaining([
        'history-index.json',
        `sha256-${first.receiptChecksum}.json`,
        `sha256-${second.receiptChecksum}.json`
      ])
    )
    await expect(store.list(request)).resolves.toMatchObject({
      receipts: [
        { receiptId: 'attempt-2', outcome: 'different' },
        { receiptId: 'attempt-1', outcome: 'matched' }
      ]
    })
  })

  it('makes an identical append idempotent', async () => {
    const { root, store } = await createStore()

    const first = await store.append(request, draft)
    const second = await store.append(request, draft)

    expect(second).toEqual(first)
    await expect(readdir(join(root, 'reproducibility-checks'))).resolves.toEqual(
      expect.arrayContaining(['history-index.json', `sha256-${first.receiptChecksum}.json`])
    )
  })

  it('persists a bounded check log behind the receipt and records the latest failed attempt', async () => {
    const { root, store } = await createStore()
    const entries = [
      {
        source: 'environment' as const,
        requirementId: 'python:analysis',
        environmentIndex: 0,
        environmentTotal: 1,
        kernelKind: 'python' as const,
        stream: 'stdout' as const,
        text: 'Linking numpy\n'
      }
    ]
    const receipt = await store.append(request, draft, { entries, truncated: false })

    expect(receipt.checkLog).toMatchObject({ entryCount: 1, truncated: false })
    await expect(
      store.getCheckLog({ ...request, receiptChecksum: receipt.receiptChecksum })
    ).resolves.toMatchObject({ attemptId: 'attempt-1', entries })
    expect(await readdir(join(root, 'reproducibility-checks', 'logs'))).toEqual([
      `sha256-${receipt.checkLog!.logChecksum}.json`
    ])

    const timestampedEntries = entries.map((entry) => ({
      ...entry,
      recordedAt: '2026-09-02T00:04:30.000Z'
    }))
    const failed = await store.recordFailure(
      request,
      {
        attemptId: 'attempt-2',
        startedAt: '2026-09-02T00:04:00.000Z',
        completedAt: '2026-09-02T00:05:00.000Z',
        artifactVersion: request,
        frontierId: 'original-inputs',
        phase: 'restoring-environments'
      },
      { entries: timestampedEntries, truncated: true }
    )
    await expect(store.list(request)).resolves.toMatchObject({
      latestFailedAttempt: { attemptId: 'attempt-2', checkLog: { truncated: true } }
    })
    await expect(
      store.getCheckLog({ ...request, attemptId: failed.attemptId })
    ).resolves.toMatchObject({
      attemptId: 'attempt-2',
      truncated: true,
      entries: timestampedEntries
    })
  })

  it('pages by immutable receipt checksum without shifting after a newer append', async () => {
    const { store } = await createStore()
    const receipts: ArtifactReproducibilityReceipt[] = []
    for (let index = 1; index <= 3; index += 1) {
      receipts.push(
        await store.append(request, {
          ...draft,
          receiptId: `attempt-${index}`,
          startedAt: `2026-09-02T00:0${index}:00.000Z`,
          completedAt: `2026-09-02T00:0${index}:30.000Z`
        })
      )
    }

    const firstPage = await store.list({ ...request, limit: 2 })
    expect(firstPage.receipts.map((receipt) => receipt.receiptId)).toEqual([
      'attempt-3',
      'attempt-2'
    ])
    expect(firstPage.nextCursor).toBe(receipts[1]!.receiptChecksum)

    await store.append(request, {
      ...draft,
      receiptId: 'attempt-4',
      startedAt: '2026-09-02T00:04:00.000Z',
      completedAt: '2026-09-02T00:04:30.000Z'
    })
    await expect(store.list({ ...request, cursor: firstPage.nextCursor })).resolves.toMatchObject({
      receipts: [{ receiptId: 'attempt-1' }]
    })
  })

  it('rejects invalid page requests', async () => {
    const { store } = await createStore()

    await expect(store.list({ ...request, limit: 0 })).rejects.toThrow(
      'Invalid reproducibility receipt page size.'
    )
    await expect(store.list({ ...request, cursor: 'invalid' })).rejects.toThrow(
      'Invalid reproducibility receipt cursor.'
    )
    await expect(store.list({ ...request, cursor: 'f'.repeat(64) })).rejects.toThrow(
      'Unknown reproducibility receipt cursor.'
    )
  })

  it('rebuilds a missing, corrupt, or stale derived history index', async () => {
    const { root, store } = await createStore()
    const receipt = await store.append(request, draft)
    const indexPath = join(root, 'reproducibility-checks', 'history-index.json')

    await writeFile(indexPath, '{"schemaVersion":1,"receipts":[]}', 'utf8')
    await expect(store.list(request)).resolves.toMatchObject({
      receipts: [{ receiptId: receipt.receiptId }]
    })
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      receipts: [{ receiptChecksum: receipt.receiptChecksum }]
    })

    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      receipts: Array<{ outcome: string }>
    }
    index.receipts[0]!.outcome = 'different'
    await writeFile(indexPath, JSON.stringify(index), 'utf8')
    await expect(store.list(request)).resolves.toMatchObject({
      receipts: [{ receiptId: receipt.receiptId, outcome: 'matched' }]
    })
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toMatchObject({
      receipts: [{ receiptChecksum: receipt.receiptChecksum, outcome: 'matched' }]
    })

    await writeFile(indexPath, '{broken', 'utf8')
    await expect(store.list(request)).resolves.toMatchObject({
      receipts: [{ receiptId: receipt.receiptId }]
    })
  })

  it('reads one immutable receipt directly for export', async () => {
    const { store } = await createStore()
    const receipt = await store.append(request, draft)

    await expect(store.get(request, receipt.receiptChecksum)).resolves.toEqual(receipt)
    await expect(store.get(request, 'f'.repeat(64))).resolves.toBeUndefined()
  })

  it('rejects modified receipt contents instead of silently accepting history', async () => {
    const { root, store } = await createStore()
    const receipt = await store.append(request, draft)
    const filePath = join(root, 'reproducibility-checks', `sha256-${receipt.receiptChecksum}.json`)
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as ArtifactReproducibilityReceipt
    await writeFile(filePath, JSON.stringify({ ...persisted, outcome: 'different' }), 'utf8')

    await expect(store.list(request)).rejects.toThrow('receipt checksum mismatch')
  })
})

it.each(['artifact', 'workflow'] as const)(
  'reads %s original output through an imported source-to-local entity mapping',
  async (kind) => {
    const { root } = await createStore()
    const {
      bindArtifactReproducibilityExecutionEvidence,
      readArtifactReproducibilityOriginalOutput
    } = await import('./provenance-reproducibility-execution-evidence')
    const { bindArtifactReproducibilityReceipts } =
      await import('./artifact-reproducibility-receipts')
    const owner = {}
    const bytes = Buffer.from('retained original output')
    await writeFile(join(root, 'original.bin'), bytes)
    await writeFile(
      join(root, 'reproducibility-source.json'),
      JSON.stringify({
        sourceScope: request,
        entityIds: { 'file-generation:source': 'file-generation:local' },
        omittedOutputChecksums: [],
        lockChecksums: []
      })
    )
    bindArtifactReproducibilityReceipts(
      owner,
      new ArtifactReproducibilityReceiptStore({ resolveVersionDirectory: async () => root })
    )
    bindArtifactReproducibilityExecutionEvidence(
      owner,
      async () =>
        ({
          [kind === 'workflow' ? 'workflowCapture' : 'provenanceGraph']:
            kind === 'workflow'
              ? {
                  state: 'available',
                  capture: {
                    graph: {
                      entities: [
                        {
                          entityId: 'file-generation:local',
                          kind: 'file-generation',
                          contentStorageKey: 'original.bin',
                          checksum: sha256(bytes),
                          sizeBytes: bytes.length
                        }
                      ]
                    }
                  }
                }
              : {
                  entities: [
                    {
                      entityId: 'file-generation:local',
                      kind: 'file-generation',
                      contentStorageKey: 'original.bin',
                      checksum: sha256(bytes),
                      sizeBytes: bytes.length
                    }
                  ]
                }
        }) as unknown as import('../../shared/artifact-provenance').PersistedArtifactExecutionSnapshot
    )
    await expect(
      readArtifactReproducibilityOriginalOutput(
        owner,
        root,
        { ...request, versionId: 'local-version' },
        'file-generation:source'
      )
    ).resolves.toEqual(bytes)
    await expect(
      readArtifactReproducibilityOriginalOutput(owner, root, request, 'outside-capture')
    ).rejects.toThrow('Original output is unavailable')
  }
)

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactReproducibilityReceipt } from '../../shared/artifact-reproducibility'
import { sha256 } from './provenance-canonical'
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

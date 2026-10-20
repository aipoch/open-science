import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { discoveryRecordSchema, type DiscoveryReference } from '../src/contracts.js'
import type { LiteratureJobsResult } from '../src/jobs.js'
import { LiteratureBatchJobs } from '../src/batch-jobs.js'
import { checkpoints, jobOptions } from './checkpoint-fixture.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'discovery-scale-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  vi.spyOn(checkpoints, 'write')
  return path
}
async function completedJob(count: number): Promise<{
  measured: { bytes: number; calls: number }
  result: LiteratureJobsResult
}> {
  const item = (id: string): DiscoveryReference => ({
    id,
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    collectionIds: [],
    projectIds: [],
    item: discoveryRecordSchema.parse({
      itemType: 'journalArticle',
      title: id,
      abstract: 'a'.repeat(8_000),
      identifiers: [{ scheme: 'doi', value: `10.1234/${id}` }]
    })
  })
  const onError = vi.fn()
  const jobs = new LiteratureBatchJobs({
    ...jobOptions,
    path: join(await directory(), 'jobs.json'),
    spacingMs: 0,
    onError,
    catalog: { get: async (id) => item(id) },
    metadata: {
      complete: async ({ itemId }) => ({
        mode: 'preview',
        reviewVersion: 1,
        provider: 'crossref',
        sourceUrl: 'https://crossref.org',
        item: item(itemId!),
        filled: [{ field: 'journal', value: 'Journal' }],
        conflicts: []
      }),
      applyReviewed: vi.fn()
    },
    fullText: { run: vi.fn() }
  })
  cleanup.push(() => jobs.close())
  const jobId = randomUUID()
  vi.mocked(checkpoints.write).mockClear()
  let bytes = 0
  let calls = 0
  vi.mocked(checkpoints.write).mockImplementation(async (target, contents) => {
    // Lazy readers use real fixture files; omit fsync here, not the written checkpoint data.
    await writeFile(target, contents)
    bytes += Buffer.byteLength(contents)
    calls++
    vi.mocked(checkpoints.write).mockClear()
  })
  await jobs.run({
    action: 'create',
    mode: 'metadata',
    requestId: jobId,
    itemIds: Array.from({ length: count }, (_, index) => `reference-${index}`)
  })
  await vi.waitFor(
    async () => {
      expect(onError).not.toHaveBeenCalled()
      const summary = await jobs.run({ action: 'list' })
      expect(summary.summaries?.[0].state).toBe('review')
    },
    { timeout: 60_000, interval: 50 }
  )
  const result = await jobs.run({ action: 'get', jobId })
  // close drains the final durable checkpoint before measuring.
  await jobs.close()
  const measured = { bytes, calls }
  return { measured, result }
}

it('keeps batch checkpoint bytes proportional to the number of processed references', async () => {
  const small = await completedJob(100)
  const large = await completedJob(200)
  console.info('checkpoint bytes', { small: small.measured, large: large.measured })
  expect(large.measured.bytes).toBeLessThan(small.measured.bytes * 2.5)
}, 60_000)

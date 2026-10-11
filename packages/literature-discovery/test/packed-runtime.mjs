/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LiteratureReferenceResolver,
  LiteratureMetadataEnricher
} from '@aipoch/literature-discovery'
import { discoveryRecordSchema } from '@aipoch/literature-discovery/contracts'
import { LiteratureBatchJobJournal } from '@aipoch/literature-discovery/checkpoints'

// Exercise actual public APIs with caller-owned records and storage outside the repository.
const directory = await mkdtemp(join(tmpdir(), 'discovery-consumer-'))
const checkpoints = {
  async read(path, decode, maxBytes) {
    try {
      assert.ok((await stat(path)).size <= maxBytes)
      return { status: 'found', value: decode(await readFile(path, 'utf8')) }
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing' }
      throw error
    }
  },
  async write(path, contents) {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, contents)
    await rename(temporary, path)
  },
  async recoverDirectory() {
    /* This fixture leaves no interrupted temporary writes. */
  },
  recoveryBarrier: (message) => new Error(message)
}
try {
  const fetchMetadata = async () =>
    new Response(
      JSON.stringify({
        message: {
          DOI: '10.1234/example',
          type: 'journal-article',
          title: ['Published title'],
          'container-title': ['Independent Journal'],
          author: [{ given: 'Ada', family: 'Example' }]
        }
      })
    )
  const [resolved] = await new LiteratureReferenceResolver(fetchMetadata).resolve([
    'doi:10.1234/example'
  ])
  assert.equal(resolved.item.title, 'Published title')
  let current = {
    id: 'paper',
    metadataRevision: 1,
    attachments: [],
    customOwnerState: { label: 'keep' },
    item: discoveryRecordSchema.parse({
      itemType: 'journalArticle',
      title: 'My title',
      identifiers: [{ scheme: 'doi', value: '10.1234/example' }],
      personalNote: 'Owner note'
    })
  }
  const receipts = new Map()
  let commits = 0
  const catalog = {
    get: async () => current,
    getMetadataCommitReceipt: async (id) => receipts.get(id) ?? null,
    async applyMetadata(input) {
      assert.equal(input.expectedMetadataRevision, current.metadataRevision)
      current = { ...current, item: input.item, metadataRevision: current.metadataRevision + 1 }
      receipts.set(input.operationId, {
        operationId: input.operationId,
        itemId: current.id,
        expectedMetadataRevision: input.expectedMetadataRevision,
        committedMetadataRevision: current.metadataRevision
      })
      commits++
      return current
    }
  }
  const preview = await new LiteratureMetadataEnricher(catalog, fetchMetadata).complete({
    mode: 'preview',
    itemId: 'paper'
  })
  assert.equal(preview.reviewVersion, 2)
  const job = {
    id: randomUUID(),
    createdAt: 1,
    updatedAt: 1,
    mode: 'metadata',
    phase: 'search',
    state: 'review',
    rows: [{ id: 'paper', checked: true, status: 'ready', item: current, metadata: preview }]
  }
  const path = join(directory, 'jobs.json')
  const journal = new LiteratureBatchJobJournal(path, checkpoints)
  await journal.save(job)
  await journal.saveIndex([job])
  const reopened = new LiteratureBatchJobJournal(path, checkpoints)
  const [restored] = await reopened.load()
  await reopened.hydrate(restored)
  assert.deepEqual(restored, job)
  const replay = new LiteratureMetadataEnricher(catalog, async () => {
    throw Error('Replay must not fetch')
  })
  await replay.applyReviewed(restored.rows[0].metadata, ['title'])
  await replay.applyReviewed(restored.rows[0].metadata, ['title'])
  assert.equal(commits, 1)
  assert.equal(current.item.title, 'Published title')
  assert.equal(current.item.personalNote, 'Owner note')
  assert.deepEqual(current.customOwnerState, { label: 'keep' })
} finally {
  await rm(directory, { recursive: true, force: true })
}

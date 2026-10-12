/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import { LiteratureFullTextIndex, LiteratureReader, type DocumentReference } from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createIndex } from './sqlite.js'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reading-domain-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const reference = (id = 'doc', checksum = 'a'.repeat(64)): DocumentReference => ({
  bindingId: id,
  name: `${id}.pdf`,
  checksum,
  sizeBytes: 10
})
function setup(text: string) {
  const index = createIndex(root)
  const extract = vi.fn(async () => ({ text, pageCount: 3, truncated: false }))
  const authorize = vi.fn(async () => extract)
  return { index, extract, authorize, reader: new LiteratureReader({ index, authorize }) }
}
it('preserves multiple bindings to the same extracted content and coalesces extraction', async () => {
  const { reader, extract, authorize } = setup('--- Page 1 ---\nshared evidence')
  const result = await reader.searchDocuments([reference('a'), reference('b')], 'evidence')
  expect(result).toMatchObject({ passages: [{ documentId: 'a' }, { documentId: 'b' }] })
  expect(extract).toHaveBeenCalledTimes(1)
  expect(authorize).toHaveBeenCalledTimes(2)
})
it('rechecks source authority even when extracted bytes are cached', async () => {
  const { reader, authorize, extract } = setup('evidence')
  await reader.readDocument(reference())
  authorize.mockRejectedValueOnce(new Error('revoked'))
  await expect(reader.readDocument(reference())).rejects.toThrow('revoked')
  expect(extract).toHaveBeenCalledTimes(1)
})
it('retries failed extraction without retaining a rejected cache entry', async () => {
  const { reader, extract } = setup('evidence')
  extract.mockRejectedValueOnce(new Error('extract failed'))
  await expect(reader.readDocument(reference())).rejects.toThrow('extract failed')
  await reader.readDocument(reference())
  expect(extract).toHaveBeenCalledTimes(2)
})
it('binds sequential cursors to the intended document and rejects invalid offsets', async () => {
  const { reader } = setup('a'.repeat(17000))
  const first = (await reader.readDocument(reference())) as {
    nextCursor: string
    passage: { text: string }
  }
  expect(first.passage.text).toHaveLength(16000)
  expect(await reader.readDocument(reference(), first.nextCursor)).toMatchObject({
    nextCursor: null,
    passage: { text: 'a'.repeat(1000) }
  })
  await expect(reader.readDocument(reference('other'), first.nextCursor)).rejects.toThrow(
    'cursor is invalid'
  )
  await expect(
    reader.readDocument(
      reference(),
      Buffer.from(JSON.stringify({ documentId: 'doc', offset: 18000 })).toString('base64url')
    )
  ).rejects.toThrow('out of range')
})
it('indexes bounded overlapping chunks with original page and text offsets', async () => {
  const text = '--- Page 1 ---\n' + 'a'.repeat(11000) + '\n--- Page 2 ---\ncohort evidence'
  const { reader } = setup(text),
    replace = vi.spyOn(LiteratureFullTextIndex.prototype, 'replace')
  await reader.searchDocuments([reference()], 'cohort')
  const chunks = replace.mock.calls[0][0].chunks
  expect(chunks.length).toBeGreaterThan(3)
  expect(chunks[1].textStart).toBe(4750)
  expect(chunks.at(-1)).toMatchObject({ pageStart: 2, pageEnd: 2 })
  for (const chunk of chunks) expect(text.slice(chunk.textStart, chunk.textEnd)).toBe(chunk.content)
})
it.each(['sqlite-error', 'no-match', 'cjk'] as const)(
  'falls back to bounded lexical search for %s',
  async (mode) => {
    const { reader, index } = setup(
      mode === 'cjk'
        ? '--- Page 2 ---\n这是临床研究证据'
        : '--- Page 2 ---\nclinical cohort evidence'
    )
    if (mode === 'sqlite-error')
      vi.spyOn(index, 'open').mockRejectedValueOnce(new Error('sqlite unavailable'))
    if (mode === 'no-match')
      vi.spyOn(LiteratureFullTextIndex.prototype, 'search').mockResolvedValueOnce([])
    const result = await reader.searchDocuments(
      [reference()],
      mode === 'cjk' ? '临床研究' : 'cohort'
    )
    expect(result).toMatchObject({
      retrievalMode: 'fallback',
      passages: [{ pageStart: 2, documentId: 'doc' }]
    })
  }
)
it('coalesces concurrent index builds and rebuilds after expiration', async () => {
  const { reader, index } = setup('cohort evidence'),
    replace = vi.spyOn(LiteratureFullTextIndex.prototype, 'replace')
  await Promise.all([
    reader.searchDocuments([reference()], 'cohort'),
    reader.searchDocuments([reference()], 'evidence')
  ])
  expect(replace).toHaveBeenCalledTimes(1)
  const connection = await index.open()
  await connection.deleteExtraction(replace.mock.calls[0][0].extractionId)
  await connection.close()
  await reader.searchDocuments([reference()], 'cohort')
  expect(replace).toHaveBeenCalledTimes(2)
})
it('bounds screening evidence and retrieves later relevant pages', async () => {
  const { reader } = setup(
    '--- Page 1 ---\n' + 'background '.repeat(5000) + '\n--- Page 3 ---\nrandomized cohort evidence'
  )
  const result = await reader.classificationEvidence(reference(), 'randomized cohort')
  expect(result.coverage).toBe('passages')
  expect(result.passages).toContainEqual(
    expect.objectContaining({ pageStart: 3, content: expect.stringContaining('randomized') })
  )
  expect(result.passages.length).toBeLessThanOrEqual(8)
  expect(result.passages.reduce((n, p) => n + Buffer.byteLength(p.content), 0)).toBeLessThanOrEqual(
    32000
  )
})
it('keeps complete short screening evidence distinct from selected passages', async () => {
  const { reader } = setup('short evidence')
  expect(await reader.classificationEvidence(reference(), 'absent')).toMatchObject({
    coverage: 'full-text',
    passages: [{ content: 'short evidence' }]
  })
})

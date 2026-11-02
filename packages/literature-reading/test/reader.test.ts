/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import { LiteratureFullTextIndex, LiteratureReader, type DocumentReference } from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createIndex, memoryIndex } from './memory-index.js'
import { createHash } from 'node:crypto'
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
it.each([
  'open-science-pdfjs-verified-bytes-v2',
  'open-science-pdfjs-verified-bytes-prose-columns-v3'
])('does not reuse obsolete extraction identity %s', async (version) => {
  const { reader, index } = setup('column ordered cohort evidence')
  const oldFingerprint = createHash('sha256').update(version).digest('hex')
  const oldId = createHash('sha256')
    .update(`${reference().checksum}:${oldFingerprint}`)
    .digest('hex')
  const connection = await index.open()
  await connection.replace({
    extractionId: oldId,
    documentChecksum: reference().checksum,
    extractorFingerprint: oldFingerprint,
    chunks: [
      {
        pageStart: 1,
        pageEnd: 1,
        textStart: 0,
        textEnd: 28,
        content: 'obsolete interleaved evidence'
      }
    ]
  })
  await connection.close()
  const replace = vi.spyOn(LiteratureFullTextIndex.prototype, 'replace')
  const result = await reader.searchDocuments([reference()], 'evidence')
  expect(replace).toHaveBeenCalledOnce()
  expect(replace.mock.calls[0][0].extractionId).not.toBe(oldId)
  expect(replace.mock.calls[0][0].extractorFingerprint).not.toBe(oldFingerprint)
  expect(result.passages[0].content).toBe('column ordered cohort evidence')
})
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
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()),
          offset: 18000
        })
      ).toString('base64url')
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
it.each(['index-error', 'no-match', 'cjk'] as const)(
  'falls back to bounded lexical search for %s',
  async (mode) => {
    const { reader, index } = setup(
      mode === 'cjk'
        ? '--- Page 2 ---\n这是临床研究证据'
        : '--- Page 2 ---\nclinical cohort evidence'
    )
    if (mode === 'index-error')
      vi.spyOn(index, 'open').mockRejectedValueOnce(new Error('index unavailable'))
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

it.each(['bm25', 'fallback'] as const)(
  'isolates extraction caches and %s indexes by caller strategy',
  async (mode) => {
    type StrategyReference = DocumentReference & { strategy: string }
    const index = createIndex(root)
    if (mode === 'fallback') vi.spyOn(index, 'open').mockRejectedValue(new Error('offline'))
    const extract = vi.fn(async (strategy: string) => ({
      text: `${strategy} cohort evidence`,
      pageCount: 2,
      truncated: false
    }))
    const authorize = vi.fn(async (ref: StrategyReference) => () => extract(ref.strategy))
    const fingerprint = (strategy: string) => createHash('sha256').update(strategy).digest('hex')
    const onIndexError = vi.fn()
    const reader = new LiteratureReader({
      index,
      authorize,
      extractionFingerprint: (ref) => fingerprint(ref.strategy),
      onIndexError
    })
    const native = { ...reference(), strategy: 'native' }
    const explicit = { ...reference(), strategy: 'explicit' }
    const nativeResult = await reader.searchDocuments([native], 'cohort')
    const explicitResult = await reader.searchDocuments([explicit], 'cohort')
    expect(nativeResult.passages[0]?.content).toBe('native cohort evidence')
    expect(explicitResult.passages[0]?.content).toBe('explicit cohort evidence')
    const repeatedNativeResult = await reader.searchDocuments([native], 'cohort')
    expect(repeatedNativeResult.passages[0]?.content).toBe('native cohort evidence')
    for (const result of [nativeResult, explicitResult, repeatedNativeResult])
      expect(result.retrievalMode).toBe(mode)
    expect(extract).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenCalledTimes(3)
    if (mode === 'bm25') {
      expect(onIndexError).not.toHaveBeenCalled()
      const rows = [...memoryIndex(root).documents.values()]
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map((row) => row.extractionId)).size).toBe(2)
      expect(rows.map((row) => row.extractorFingerprint).sort()).toEqual(
        [fingerprint('native'), fingerprint('explicit')].sort()
      )
    }
  }
)

it('binds cursors to extraction strategy and checksum and rejects legacy cursors', async () => {
  const reader = new LiteratureReader({
    index: createIndex(root),
    authorize: async () => async () => ({
      text: 'a'.repeat(17000),
      pageCount: 2,
      truncated: false
    }),
    extractionFingerprint: (ref: DocumentReference & { strategy?: string }) =>
      ref.strategy ?? 'native'
  })
  const first = await reader.readDocument(reference())
  expect(first.nextCursor).not.toBeNull()
  await expect(
    reader.readDocument({ ...reference(), strategy: 'explicit' }, first.nextCursor!)
  ).rejects.toThrow('cursor is invalid')
  await expect(
    reader.readDocument(reference('doc', 'b'.repeat(64)), first.nextCursor!)
  ).rejects.toThrow('cursor is invalid')
  await expect(
    reader.readDocument(
      reference(),
      Buffer.from(JSON.stringify({ documentId: 'doc', offset: 16000 })).toString('base64url')
    )
  ).rejects.toThrow('cursor is invalid')
})

it('shares the six-extraction cache limit across caller strategies', async () => {
  const extract = vi.fn(async () => ({ text: 'evidence', pageCount: 2, truncated: false }))
  const reader = new LiteratureReader({
    index: createIndex(root),
    authorize: async () => extract,
    extractionFingerprint: (ref: DocumentReference & { strategy: string }) => ref.strategy
  })
  for (let i = 0; i < 7; i++) await reader.readDocument({ ...reference(), strategy: String(i) })
  await reader.readDocument({ ...reference(), strategy: '6' })
  expect(extract).toHaveBeenCalledTimes(7)
  await reader.readDocument({ ...reference(), strategy: '0' })
  expect(extract).toHaveBeenCalledTimes(8)
})

it('reads and searches with no index or persistence capability', async () => {
  const onIndexError = vi.fn()
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: 'cohort evidence',
      pageCount: 1,
      truncated: false
    }),
    onIndexError
  })
  expect(await reader.readDocument(reference())).toMatchObject({
    passage: { text: 'cohort evidence' }
  })
  expect(await reader.searchDocuments([reference()], 'cohort')).toMatchObject({
    retrievalMode: 'fallback',
    passages: [{ content: 'cohort evidence' }]
  })
  expect(onIndexError).not.toHaveBeenCalled()
})

it('preserves incomplete extraction coverage through reading, retrieval and classification', async () => {
  const coverage = { textPages: [1], ocrPages: [2], unavailablePages: [3], uncheckedPages: [] }
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: '--- Page 1 ---\nNative clinical evidence\n\n--- Page 2 ---\nOCR clinical evidence',
      pageCount: 3,
      truncated: false,
      coverage
    })
  })
  expect((await reader.readDocument(reference())).document.coverage).toEqual(coverage)
  expect((await reader.searchDocuments([reference()], 'clinical')).documents[0].coverage).toEqual(
    coverage
  )
  expect((await reader.classificationEvidence(reference(), 'clinical')).coverage).toBe('passages')
})

it('never labels a truncated extraction as full-text evidence', async () => {
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: 'partial clinical evidence',
      pageCount: 2,
      truncated: true
    })
  })
  expect((await reader.classificationEvidence(reference(), 'clinical')).coverage).toBe('passages')
})

it('retries incomplete pages and rejects cursors from the earlier extraction', async () => {
  const first = {
    text: '--- Page 1 ---\n' + 'clinical evidence '.repeat(1200),
    pageCount: 2,
    truncated: false,
    coverage: { textPages: [1], ocrPages: [], unavailablePages: [2], uncheckedPages: [] }
  }
  const recovered = {
    ...first,
    text: first.text + '\n\n--- Page 2 ---\nrecovered evidence',
    coverage: { textPages: [1], ocrPages: [2], unavailablePages: [], uncheckedPages: [] }
  }
  const extract = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(recovered)
  const reader = new LiteratureReader({ authorize: async () => extract })
  const old = await reader.readDocument(reference())
  expect(old.nextCursor).not.toBeNull()
  await reader.readDocument(reference(), old.nextCursor!)
  expect(extract).toHaveBeenCalledOnce()
  expect((await reader.readDocument(reference())).document.coverage).toEqual(recovered.coverage)
  await expect(reader.readDocument(reference(), old.nextCursor!)).rejects.toThrow(
    'cursor is invalid'
  )
  expect(extract).toHaveBeenCalledTimes(2)
})

it('reports every unavailable page even when no text can be read or retrieved', async () => {
  const coverage = { textPages: [], ocrPages: [], unavailablePages: [1, 2], uncheckedPages: [] }
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: '',
      pageCount: 2,
      truncated: false,
      coverage
    })
  })
  expect((await reader.readDocument(reference())).document.coverage).toEqual(coverage)
  const search = await reader.searchDocuments([reference()], 'clinical')
  expect(search.documents[0].coverage).toEqual(coverage)
  expect(search.passages).toEqual([])
  expect(await reader.classificationEvidence(reference(), 'clinical')).toEqual({
    coverage: 'unavailable',
    passages: []
  })
})

it('pagination shares one extraction even when a page is permanently blank', async () => {
  const extract = vi.fn(async () => ({
    text: '--- Page 1 ---\n' + 'clinical '.repeat(6000),
    pageCount: 2,
    truncated: false,
    coverage: { textPages: [1], ocrPages: [], unavailablePages: [2], uncheckedPages: [] }
  }))
  const reader = new LiteratureReader({ authorize: async () => extract })
  const first = await reader.readDocument(reference())
  const second = await reader.readDocument(reference(), first.nextCursor!)
  await reader.readDocument(reference(), second.nextCursor!)
  expect(
    extract,
    'cursor continuation must not repeat expensive OCR on a permanent gap'
  ).toHaveBeenCalledOnce()
})

it('never treats image-bearing pages as verified complete evidence', async () => {
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: '--- Page 1 ---\n1\nrecognized clinical evidence',
      pageCount: 1,
      truncated: false,
      coverage: {
        textPages: [1],
        ocrPages: [1],
        unavailablePages: [],
        uncheckedPages: [],
        unverifiedPages: [1]
      }
    })
  })
  expect((await reader.classificationEvidence(reference(), 'clinical')).coverage).toBe('passages')
})

it('requires positive coverage of every page before declaring full-text', async () => {
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: '--- Page 1 ---\nclinical evidence',
      pageCount: 2,
      truncated: false,
      coverage: { textPages: [1], ocrPages: [], unavailablePages: [], uncheckedPages: [] }
    })
  })
  expect((await reader.classificationEvidence(reference(), 'clinical')).coverage).toBe('passages')
})

it('text identity rejects stale cursors after a retry changes text without changing page coverage', async () => {
  const coverage = { textPages: [1], ocrPages: [], unavailablePages: [2], uncheckedPages: [] }
  const extract = vi
    .fn()
    .mockResolvedValueOnce({
      text: 'old evidence '.repeat(2000),
      pageCount: 2,
      truncated: false,
      coverage
    })
    .mockResolvedValue({
      text: 'new evidence '.repeat(2000),
      pageCount: 2,
      truncated: false,
      coverage
    })
  const reader = new LiteratureReader({ authorize: async () => extract })
  const old = await reader.readDocument(reference())
  await reader.readDocument(reference())
  await expect(reader.readDocument(reference(), old.nextCursor!)).rejects.toThrow(
    'cursor is invalid'
  )
})

it('coverage-only updates preserve text cursors and still update evidence provenance', async () => {
  const text = 'unchanged clinical evidence '.repeat(1200)
  const before = { textPages: [1], ocrPages: [], unavailablePages: [2], uncheckedPages: [] }
  const after = { textPages: [], ocrPages: [1], unavailablePages: [2], uncheckedPages: [] }
  const extract = vi
    .fn()
    .mockResolvedValueOnce({ text, pageCount: 2, truncated: false, coverage: before })
    .mockResolvedValue({ text, pageCount: 2, truncated: false, coverage: after })
  const reader = new LiteratureReader({ authorize: async () => extract })
  const first = await reader.readDocument(reference())
  await reader.readDocument(reference())
  expect((await reader.readDocument(reference(), first.nextCursor!)).document.coverage).toEqual(
    after
  )
})

it('fresh classification retries missing OCR evidence', async () => {
  const extract = vi
    .fn()
    .mockResolvedValueOnce({
      text: '',
      pageCount: 2,
      truncated: false,
      coverage: { textPages: [], ocrPages: [], unavailablePages: [1, 2], uncheckedPages: [] }
    })
    .mockResolvedValue({
      text: 'Recovered clinical evidence',
      pageCount: 2,
      truncated: false,
      coverage: { textPages: [], ocrPages: [1, 2], unavailablePages: [], uncheckedPages: [] }
    })
  const reader = new LiteratureReader({ authorize: async () => extract })
  expect((await reader.classificationEvidence(reference(), 'clinical')).coverage).toBe(
    'unavailable'
  )
  expect(
    (await reader.classificationEvidence(reference(), 'clinical')).passages[0].content
  ).toContain('Recovered')
  expect(extract).toHaveBeenCalledTimes(2)
})

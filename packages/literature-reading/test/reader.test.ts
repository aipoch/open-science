/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import {
  LiteratureFullTextIndex,
  LiteratureReader,
  type DocumentReference,
  type PageTextLayout
} from '../src/index.js'
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

it.each([false, true])(
  'retains extraction uncertainty through cached reads, continuation and search; index: %s',
  async (indexed) => {
    const warnings = ['Page 2: text layout remains uncertain; native reading order was retained.']
    const extract = vi.fn(async () => ({
      text: 'cohort ' + 'a'.repeat(17000),
      pageCount: 3,
      truncated: false,
      warnings
    }))
    const reader = new LiteratureReader({
      index: indexed ? createIndex(root) : undefined,
      authorize: vi.fn(async () => extract)
    })
    const first = await reader.readDocument(reference())
    expect(first.document.extractionWarnings).toEqual(warnings)
    expect(
      (await reader.readDocument(reference(), first.nextCursor!)).document.extractionWarnings
    ).toEqual(warnings)
    const search = await reader.searchDocuments([reference()], 'cohort')
    expect(search.documents[0].extractionWarnings).toEqual(warnings)
    expect(search.retrievalMode).toBe(indexed ? 'bm25' : 'fallback')
    expect(extract).toHaveBeenCalledOnce()
  }
)

const positionedPage = (page: number, text: string): PageTextLayout => ({
  page,
  width: 600,
  height: 800,
  coordinateSystem: 'top-left',
  blocks: [{ id: 0, text, bounds: [40, 100, 250, 120] }]
})
it.each([false, true])(
  'scopes positioned evidence to read batches and search matches without changing text offsets; indexed: %s',
  async (indexed) => {
    const text =
      '--- Page 1 ---\n' +
      'cohort evidence '.repeat(1200) +
      '\n\n--- Page 2 ---\nneedle result\n\n--- Page 3 ---\nunsupported layout'
    const pages = [positionedPage(1, 'cohort evidence'), positionedPage(2, 'needle result')]
    const extract = vi.fn(async () => ({
      text,
      pageCount: 3,
      truncated: false,
      pageLayouts: pages,
      layoutOmittedPages: [3]
    }))
    const reader = new LiteratureReader({
      index: indexed ? createIndex(root) : undefined,
      authorize: async () => extract
    })
    const first = await reader.readDocument(reference())
    expect(first.passage.text).toBe(text.slice(0, 16000))
    expect(first.passage.pageLayouts).toEqual([pages[0]])
    expect(first.passage.layoutOmittedPages).toBeUndefined()
    const second = await reader.readDocument(reference(), first.nextCursor!)
    expect(first.passage.text + second.passage.text).toBe(text)
    expect(second.passage.pageLayouts).toEqual(pages)
    expect(second.passage.layoutOmittedPages).toEqual([3])
    const found = await reader.searchDocuments([reference()], 'needle')
    expect(found.documents[0].pageLayouts).toEqual([pages[1]])
    expect(found.documents[0].layoutOmittedPages).toBeUndefined()
    for (const hit of found.passages)
      expect(hit.content).toBe(text.slice(hit.textStart, hit.textEnd))
    expect(extract).toHaveBeenCalledOnce()
  }
)
it('continues at page boundaries so complete positioned evidence is not lost to the prior batch budget', async () => {
  const pages = [
    positionedPage(1, 'original '.repeat(1000)),
    positionedPage(2, 'different '.repeat(1000))
  ]
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: '--- Page 1 ---\nshort one\n\n--- Page 2 ---\nshort two',
      pageCount: 2,
      truncated: false,
      pageLayouts: pages
    })
  })
  const result = await reader.readDocument(reference())
  expect(result.passage.pageLayouts).toEqual([pages[0]])
  expect(result.passage.layoutOmittedPages).toBeUndefined()
  expect(result.nextCursor).toBeTruthy()
  expect(JSON.stringify(result.passage.pageLayouts).length).toBeLessThanOrEqual(16000)
  const next = await reader.readDocument(reference(), result.nextCursor!)
  expect(next.passage.pageLayouts).toEqual([pages[1]])
  expect(next.passage.text).toContain('short two')
  expect(result.passage.text + next.passage.text).toBe(
    '--- Page 1 ---\nshort one\n\n--- Page 2 ---\nshort two'
  )
  expect(next.nextCursor).toBeNull()
})

it('explicitly omits an oversized page layout while preserving progress and native text', async () => {
  const text = '--- Page 1 ---\noriginal source'
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text,
      pageCount: 1,
      truncated: false,
      pageLayouts: [positionedPage(1, 'x'.repeat(17000))]
    })
  })
  const result = await reader.readDocument(reference())
  expect(result.passage.text).toBe(text)
  expect(result.passage.pageLayouts).toBeUndefined()
  expect(result.passage.layoutOmittedPages).toEqual([1])
  expect(result.nextCursor).toBeNull()
})

it('counts positioned evidence toward the extraction cache memory limit', async () => {
  const blocks = Array.from({ length: 100 }, (_, id) => ({
    id,
    text: 'original short source',
    bounds: [40, 100, 250, 120] as const
  }))
  const pageLayouts = Array.from({ length: 800 }, (_, i) => ({
    ...positionedPage(i + 1, ''),
    blocks
  }))
  const text = pageLayouts
    .map((page) => `--- Page ${page.page} ---\n` + blocks.map((block) => block.text).join('\n'))
    .join('\n\n')
  const extract = vi.fn(async () => ({ text, pageCount: 800, truncated: false, pageLayouts }))
  const reader = new LiteratureReader({ authorize: async () => extract })
  const first = reference('first')
  await reader.readDocument(first)
  for (let i = 0; i < 3; i++)
    await reader.readDocument(reference(`filler-${i}`, String(i).repeat(64)))
  expect(extract).toHaveBeenCalledTimes(4)
  await reader.readDocument(first)
  expect(extract).toHaveBeenCalledTimes(5)
})

it('retains complete geometry when a native cursor lands inside inter-page whitespace', async () => {
  const prefix = '--- Page 1 ---\n'
  const text = prefix + 'a'.repeat(15999 - prefix.length) + '\n\n--- Page 2 ---\nsecond source'
  const pageLayouts = [positionedPage(1, 'x'.repeat(9000)), positionedPage(2, 'y'.repeat(9000))]
  const reader = new LiteratureReader({
    authorize: async () => async () => ({ text, pageCount: 2, truncated: false, pageLayouts })
  })
  const chunks: string[] = [],
    seen = new Set<number>()
  let cursor: string | undefined
  do {
    const batch = await reader.readDocument(reference(), cursor)
    chunks.push(batch.passage.text)
    expect(batch.passage.layoutOmittedPages).toBeUndefined()
    for (const page of batch.passage.pageLayouts ?? []) seen.add(page.page)
    cursor = batch.nextCursor ?? undefined
    expect(chunks.length).toBeLessThanOrEqual(4)
  } while (cursor)
  expect(chunks.join('')).toBe(text)
  expect([...seen]).toEqual([1, 2])
})

it.each([false, true])(
  'prioritizes the highest-ranked search match when complete layouts compete for budget; indexed: %s',
  async (indexed) => {
    const first = 'needle ' + 'first padding '.repeat(650)
    const second = 'needle signal ' + 'second padding '.repeat(600)
    const text = `--- Page 1 ---\n${first}\n\n--- Page 2 ---\n${second}`
    const pageLayouts = [positionedPage(1, first), positionedPage(2, second)]
    const reader = new LiteratureReader({
      index: indexed ? createIndex(root) : undefined,
      authorize: async () => async () => ({ text, pageCount: 2, truncated: false, pageLayouts })
    })
    const found = await reader.searchDocuments([reference()], 'needle signal')
    expect(found.passages[0].pageStart).toBe(2)
    expect(found.documents[0].pageLayouts).toEqual([pageLayouts[1]])
    expect(found.documents[0].layoutOmittedPages).toEqual([1])
  }
)
it('uses source-owned physical page boundaries when document text imitates page markers', async () => {
  const first =
    '--- Page 1 ---\nFirst source.\n--- Page 99 ---\nneedle belongs to physical page one.'
  const text = first + '\n\n--- Page 2 ---\nSecond source.'
  const pageLayouts = [
    positionedPage(1, 'needle belongs to physical page one.'),
    positionedPage(2, 'Second source.')
  ]
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text,
      pageCount: 2,
      truncated: false,
      pageLayouts,
      pageStarts: [
        { page: 1, offset: 0 },
        { page: 2, offset: first.length + 2 }
      ]
    })
  })
  const found = await reader.searchDocuments([reference()], 'needle')
  expect(found.passages[0].pageStart).toBe(1)
  expect(found.passages[0].pageEnd).toBe(1)
  expect(found.documents[0].pageLayouts).toEqual([pageLayouts[0]])
  const read = await reader.readDocument(reference())
  expect(read.passage.text).toBe(text)
})

it('keeps physical page ranges across native cursors inside page-like source text', async () => {
  const first = '--- Page 1 ---\n--- Page 99 ---\n' + 'source '.repeat(3000)
  const text = first + '\n\n--- Page 2 ---\nSecond source.'
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text,
      pageCount: 2,
      truncated: false,
      pageStarts: [
        { page: 1, offset: 0 },
        { page: 2, offset: first.length + 2 }
      ]
    })
  })
  const head = await reader.readDocument(reference())
  expect(head.passage.pageStart).toBe(1)
  expect(head.passage.pageEnd).toBe(1)
  expect(head.nextCursor).not.toBeNull()
  const tail = await reader.readDocument(reference(), head.nextCursor!)
  expect(tail.passage.pageStart).toBe(1)
  expect(tail.passage.pageEnd).toBe(2)
  expect(head.passage.text + tail.passage.text).toBe(text)
  expect(tail.nextCursor).toBeNull()
})

it.each([
  [{ page: 1, offset: 1 }],
  [
    { page: 1, offset: 0 },
    { page: 2, offset: 0 }
  ],
  [{ page: 99, offset: 0 }],
  [
    { page: 1, offset: 0 },
    { page: 2, offset: 999 }
  ]
])('rejects invalid source-owned physical page boundaries: %j', async (...pageStarts) => {
  const reader = new LiteratureReader({
    authorize: async () => async () => ({
      text: '--- Page 1 ---\nsource',
      pageCount: 2,
      truncated: false,
      pageStarts
    })
  })
  await expect(reader.readDocument(reference())).rejects.toThrow('invalid physical page boundaries')
})

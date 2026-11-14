import { expect, it, vi, type Mock } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureItemView
} from '@aipoch/literature-library/contracts'
import { ComparisonExtractor, ComparisonGlobalError } from './extractor'
import { literatureOverviewSource } from '../../../shared/literature-overview'
import type { ComparisonTable } from '../../../shared/literature-comparison'
const paper = (): LiteratureItemView =>
  ({
    id: 'paper',
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Paper',
      abstract: 'Sample comprised 20 patients.'
    }),
    attachments: [],
    collectionIds: [],
    tags: []
  }) as unknown as LiteratureItemView
function paperWithPdf(): LiteratureItemView {
  const item = paper()
  item.attachments = [
    {
      id: 'attachment',
      kind: 'fullText',
      title: '',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      versions: [
        {
          id: 'pdf-version',
          versionNumber: 3,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 200,
          checksum: 'a'.repeat(64),
          createdAt: 1
        }
      ]
    }
  ]
  return item
}
const field = { id: 'population', name: 'Population', rule: 'Report sample size', version: 1 }
function fixture(
  text = JSON.stringify({
    value: '20 patients',
    evidenceIds: ['P1']
  })
): {
  extractor: ComparisonExtractor
  table: ComparisonTable
  infer: Mock<
    (input: {
      prompt: string
      systemPrompt: string
      signal: AbortSignal
    }) => Promise<{ text: string; model: string }>
  >
  reader: { classificationEvidence: Mock }
  catalog: { get: Mock<() => Promise<LiteratureItemView>> }
  change(): void
} {
  let item = paper()
  const infer = vi.fn(
    async (input: { prompt: string; systemPrompt: string; signal: AbortSignal }) => {
      void input
      return { text, model: 'model-1' }
    }
  )
  const reader = { classificationEvidence: vi.fn() }
  const catalog = { get: vi.fn(async () => item) }
  const extractor = new ComparisonExtractor({ catalog, reader, infer })
  const table = {
    sourcePolicy: 'abstract',
    language: 'en',
    members: [{ itemId: 'paper', sourceKey: literatureOverviewSource(item).key }]
  } as ComparisonTable
  return {
    extractor,
    table,
    infer,
    reader,
    catalog,
    change: () => {
      item = { ...item, metadataRevision: 2 }
    }
  }
}
it('binds selected abstract evidence to the original text and honest coverage', async () => {
  const f = fixture()
  const result = await f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  expect(result.coverage).toBe('abstract')
  expect(result.evidence).toEqual([
    { pageStart: null, pageEnd: null, quote: 'Sample comprised 20 patients.' }
  ])
  expect(JSON.parse(f.infer.mock.calls[0][0].prompt).passages).toEqual([
    { id: 'P1', pageStart: null, pageEnd: null, content: 'Sample comprised 20 patients.' }
  ])
  expect(f.reader.classificationEvidence).not.toHaveBeenCalled()
})
it('does not silently fall back to abstract under full-text policy', async () => {
  const f = fixture()
  f.table.sourcePolicy = 'full-text'
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('full-text-unavailable')
  expect(f.infer).not.toHaveBeenCalled()
})
it('admits readable PDFs when translated field names have no hits but the extraction rule does', async () => {
  const f = fixture()
  const item = paperWithPdf()
  const translatedField = { ...field, name: '研究人群' }
  f.catalog.get.mockResolvedValue(item)
  f.table.sourcePolicy = 'full-text'
  f.table.fields = [translatedField]
  f.table.members[0].sourceKey = literatureOverviewSource(item).key
  f.reader.classificationEvidence.mockImplementation(async ({ query }: { query: string }) => ({
    coverage: 'passages',
    passages: query.includes(translatedField.rule)
      ? [{ pageStart: 7, pageEnd: 7, content: 'Sample comprised 20 patients.' }]
      : []
  }))
  expect(await f.extractor.checkSource(f.table, 'paper')).toMatchObject({
    status: 'available',
    coverage: 'passages'
  })
  expect(f.reader.classificationEvidence).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: translatedField.rule })
  )
  expect(f.infer).not.toHaveBeenCalled()
  expect(
    await f.extractor.extract(f.table, translatedField, 'paper', new AbortController().signal)
  ).toMatchObject({
    status: 'succeeded',
    evidence: [{ pageStart: 7, pageEnd: 7, quote: 'Sample comprised 20 patients.' }]
  })
  expect(f.reader.classificationEvidence).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: translatedField.rule })
  )
})
it('keeps empty search results as an extraction evidence gap rather than a readability failure', async () => {
  const f = fixture()
  const item = paperWithPdf()
  f.catalog.get.mockResolvedValue(item)
  f.table.sourcePolicy = 'full-text'
  f.table.fields = [{ ...field, name: '研究人群' }]
  f.table.members[0].sourceKey = literatureOverviewSource(item).key
  f.reader.classificationEvidence.mockResolvedValue({ coverage: 'passages', passages: [] })
  expect(await f.extractor.checkSource(f.table, 'paper')).toMatchObject({ status: 'available' })
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('full-text-insufficient')
  expect(f.infer).not.toHaveBeenCalled()
})
it('rejects a PDF that the reader reports as unavailable during readability preflight', async () => {
  const f = fixture()
  const item = paperWithPdf()
  f.catalog.get.mockResolvedValue(item)
  f.table.sourcePolicy = 'full-text'
  f.table.fields = [field]
  f.reader.classificationEvidence.mockResolvedValue({ coverage: 'unavailable', passages: [] })
  expect(await f.extractor.checkSource(f.table, 'paper')).toMatchObject({ status: 'unreadable' })
  expect(f.infer).not.toHaveBeenCalled()
})
it.each(['P0', 'P2', 'p1', ' P1', ' ', 'P1\n'])('rejects unknown evidence ID %j', async (id) => {
  const f = fixture(JSON.stringify({ value: '20 patients', evidenceIds: [id] }))
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('invalid-evidence')
})
it('rejects a value without selected evidence', async () => {
  const f = fixture(JSON.stringify({ value: '20 patients', evidenceIds: [] }))
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('unsupported-value')
})
it('does not accept model-authored quotations or page numbers alongside valid IDs', async () => {
  const f = fixture(
    JSON.stringify({
      value: '1000 patients',
      evidenceIds: ['P1'],
      evidence: [{ pageStart: 1, pageEnd: 1, quote: '1000 patients' }]
    })
  )
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow()
})
it('preserves an unreported result without manufacturing evidence', async () => {
  const f = fixture(JSON.stringify({ value: null, evidenceIds: [] }))
  expect(
    await f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).toMatchObject({ status: 'succeeded', value: null, evidence: [] })
})
it('deduplicates selected evidence without copying it repeatedly', async () => {
  const f = fixture(JSON.stringify({ value: '20 patients', evidenceIds: ['P1', 'P1'] }))
  expect(
    (await f.extractor.extract(f.table, field, 'paper', new AbortController().signal)).evidence
  ).toHaveLength(1)
})
it('splits long abstracts within quote limits while retaining every original character', async () => {
  const f = fixture(JSON.stringify({ value: '20 patients', evidenceIds: ['P2'] }))
  const item = paper()
  item.item.abstract = 'a'.repeat(12000) + 'Sample comprised 20 patients.'
  f.catalog.get.mockResolvedValue(item)
  f.table.members[0].sourceKey = literatureOverviewSource(item).key
  const result = await f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  const passages = JSON.parse(f.infer.mock.calls[0][0].prompt).passages
  expect(passages.map((passage: { content: string }) => passage.content).join('')).toBe(
    item.item.abstract
  )
  expect(result.evidence).toEqual([
    { pageStart: null, pageEnd: null, quote: 'Sample comprised 20 patients.' }
  ])
})
it('rejects results after source revisions', async () => {
  const f = fixture()
  f.infer.mockImplementation(async () => {
    f.change()
    return { text: JSON.stringify({ value: null, evidenceIds: [] }), model: 'model' }
  })
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('source-changed')
})
it('classifies ordinary provider configuration/auth errors as global model failures', async () => {
  const f = fixture()
  f.infer.mockRejectedValue(new Error('Authentication failed'))
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toBeInstanceOf(ComparisonGlobalError)
})
it.each(['passages', 'full-text'] as const)(
  'preserves actual %s coverage and immutable PDF version/page evidence',
  async (coverage) => {
    const item = paperWithPdf()
    const reader = {
      classificationEvidence: vi.fn().mockResolvedValue({
        coverage,
        passages: [{ pageStart: 7, pageEnd: 8, content: 'Sample comprised 20 patients.' }]
      })
    }
    const infer = vi.fn().mockResolvedValue({
      model: 'test-model',
      text: JSON.stringify({
        value: '20 patients',
        evidenceIds: ['P1']
      })
    })
    const extractor = new ComparisonExtractor({ catalog: { get: async () => item }, reader, infer })
    const table = {
      sourcePolicy: 'full-text',
      language: 'en',
      members: [{ itemId: 'paper', sourceKey: literatureOverviewSource(item).key }]
    } as ComparisonTable
    expect(
      await extractor.extract(table, field, 'paper', new AbortController().signal)
    ).toMatchObject({
      coverage,
      metadataRevision: 1,
      attachmentVersionId: 'pdf-version',
      attachmentVersionNumber: 3,
      evidence: [{ pageStart: 7, pageEnd: 8, quote: 'Sample comprised 20 patients.' }]
    })
    expect(reader.classificationEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentVersionId: 'pdf-version',
        checksum: 'a'.repeat(64),
        sizeBytes: 200
      })
    )
    reader.classificationEvidence.mockRejectedValue(new Error('ENOENT private file path'))
    await expect(
      extractor.extract(table, field, 'paper', new AbortController().signal)
    ).rejects.toThrow('full-text-unavailable')
    expect(infer).toHaveBeenCalledTimes(1)
    for (const empty of [
      { coverage: 'unavailable', passages: [] },
      { coverage, passages: [] }
    ]) {
      reader.classificationEvidence.mockResolvedValue(empty)
      await expect(
        extractor.extract(table, field, 'paper', new AbortController().signal)
      ).rejects.toThrow('full-text-insufficient')
    }
    expect(infer).toHaveBeenCalledTimes(1)
  }
)
it('binds PDF typography and physical pages without asking the model to reproduce them', async () => {
  const item = paperWithPdf()
  const content =
    '1284\nEfﬁcacy was assessed in 666 postmeno-\npausal women.\nMedian PFS: 24.8\u00a0months.'
  const passages = [
    { pageStart: 2, pageEnd: 2, content: 'The study protocol was approved.' },
    { pageStart: 7, pageEnd: 7, content }
  ]
  const infer = vi.fn(async () => ({
    model: 'model-1',
    text: JSON.stringify({
      value: '666 postmenopausal women; PFS 24.8 months',
      evidenceIds: ['P2']
    })
  }))
  const extractor = new ComparisonExtractor({
    catalog: { get: async () => item },
    reader: {
      classificationEvidence: vi.fn().mockResolvedValue({ coverage: 'passages', passages })
    },
    infer
  })
  const table = {
    sourcePolicy: 'full-text',
    language: 'en',
    members: [{ itemId: 'paper', sourceKey: literatureOverviewSource(item).key }]
  } as ComparisonTable
  // A human-readable reconstruction would fail the former verbatim/page-copy contract.
  expect(content.includes('Efficacy was assessed in 666 postmenopausal women.')).toBe(false)
  const result = await extractor.extract(table, field, 'paper', new AbortController().signal)
  expect(result.evidence).toEqual([{ pageStart: 7, pageEnd: 7, quote: content }])
  expect(result.evidence[0].pageStart).not.toBe(1284)
})
it('does not expose or accept whitespace-only PDF passages as evidence', async () => {
  const item = paperWithPdf()
  const infer = vi.fn()
  const extractor = new ComparisonExtractor({
    catalog: { get: async () => item },
    reader: {
      classificationEvidence: vi.fn().mockResolvedValue({
        coverage: 'passages',
        passages: [{ pageStart: 7, pageEnd: 7, content: ' \n\t' }]
      })
    },
    infer
  })
  const table = {
    sourcePolicy: 'full-text',
    members: [{ itemId: 'paper', sourceKey: literatureOverviewSource(item).key }]
  } as ComparisonTable
  await expect(
    extractor.extract(table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('full-text-insufficient')
  expect(infer).not.toHaveBeenCalled()
})

it('keeps a merged member bound to its original identity across preflight, refresh, and extraction', async () => {
  const f = fixture()
  f.catalog.get.mockResolvedValue({ ...paper(), id: 'surviving-paper' })
  expect(await f.extractor.checkSource(f.table, 'paper')).toMatchObject({ status: 'missing' })
  await expect(f.extractor.member('paper')).rejects.toThrow('source-unavailable')
  await expect(
    f.extractor.extract(f.table, field, 'paper', new AbortController().signal)
  ).rejects.toThrow('source-unavailable')
  expect(f.infer).not.toHaveBeenCalled()
})

import { describe, expect, it, vi, type Mock } from 'vitest'
import { createLiteratureClient } from '@aipoch/literature-library/client'
import type {
  LiteratureCollectionView,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import type {
  SmartCollectionRow,
  SmartCollectionView
} from '@aipoch/literature-screening/contracts'
import {
  readScreeningExport,
  screeningResultsCsv,
  screeningResultsFilename,
  ScreeningExportChanged
} from './screening-results-csv'

const collection: LiteratureCollectionView = {
  id: 'smart',
  name: 'Trials',
  description: 'Adult trials',
  revision: 1,
  smart: true,
  itemCount: 1,
  createdAt: 1,
  updatedAt: 1
}
function item(id: string): LiteratureItemView {
  return {
    id,
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    projectIds: [],
    collectionIds: [],
    item: {
      itemType: 'journalArticle',
      title: `Title ${id}`,
      abstract: '',
      issuedText: '',
      issuedYear: 2025,
      containerTitle: '',
      shortTitle: '',
      language: '',
      rights: '',
      url: '',
      extra: '',
      typeFields: {},
      creators: [
        { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'author' },
        { nameMode: 'organization', literalName: 'Trial Group', creatorType: 'author' },
        { nameMode: 'person', givenName: 'Editor', familyName: 'Only', creatorType: 'editor' }
      ],
      identifiers: [{ scheme: 'doi', value: '10.1234/trial', isPrimary: true }]
    }
  }
}
type ExportReader = Parameters<typeof readScreeningExport>[1]
type Fixture = {
  rows: SmartCollectionRow[]
  view: SmartCollectionView
  transport: Mock<ExportReader['readItems']>
  reader: {
    search: Mock<ExportReader['search']>
    readItems: Mock<ExportReader['readItems']>
    readSmart: Mock<(offset: number, summaryOnly?: boolean) => Promise<SmartCollectionView>>
    check: Mock<ExportReader['check']>
  }
}

function fixture(count = 1): Fixture {
  const rows: SmartCollectionRow[] = Array.from({ length: count }, (_, index) => ({
    id: `paper-${index}`,
    title: `Title paper-${index}`,
    verdict: (['match', 'no-match', 'uncertain', 'pending', 'stale', 'error'] as const)[index % 6]!
  }))
  const counts = {
    match: rows.filter((row) => row.verdict === 'match').length,
    'no-match': rows.filter((row) => row.verdict === 'no-match').length,
    review: rows.filter((row) => row.verdict === 'uncertain' || row.verdict === 'stale').length,
    pending: rows.filter((row) => row.verdict === 'pending' || row.verdict === 'error').length
  }
  const view: SmartCollectionView = {
    scope: { kind: 'library' },
    sourceName: '',
    sourceAvailable: true,
    configured: false,
    ruleRevision: 1,
    evidenceMode: 'abstract',
    total: count,
    matches: counts.match,
    pending: rows.filter((row) => ['pending', 'stale', 'error'].includes(row.verdict)).length,
    counts,
    overrides: 0,
    rows
  }
  const transport = vi.fn<ExportReader['readItems']>(async (request) => {
    const ids = request.itemIds ?? []
    const offset = request.offset ?? 0
    const next = offset + Math.min(request.limit ?? 50, 35)
    return {
      entries: ids.slice(offset, next).map(item),
      totalCount: ids.length,
      ...(next < ids.length ? { nextOffset: next } : {})
    }
  })
  const client = createLiteratureClient({
    search: transport,
    get: async () => undefined,
    exportRecord: async () => {
      throw new Error('Unexpected record transfer')
    },
    jobs: async () => {
      throw new Error('Unexpected job lookup')
    },
    formatReferences: async () => {
      throw new Error('Unexpected citation formatting')
    }
  })
  const reader = {
    search: vi.fn<ExportReader['search']>(async () => ({
      entries: [{ ...collection, itemCount: count }]
    })),
    readItems: vi.fn<ExportReader['readItems']>((request) =>
      client.readLiteratureSelectionPage(request)
    ),
    readSmart: vi.fn(async (offset: number, summaryOnly?: boolean) => ({
      ...view,
      rows: summaryOnly ? [] : rows.slice(offset, offset + 100),
      ...(!summaryOnly && offset + 100 < count ? { nextOffset: offset + 100 } : {})
    })),
    check: vi.fn()
  }
  return { rows, view, reader, transport }
}

// Read the generated file as records, including embedded delimiters and newlines.
function records(csv: string): string[][] {
  const result: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 1; index < csv.length; index++) {
    const character = csv[index]
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"'
        index++
      } else quoted = !quoted
    } else if (!quoted && character === ',') {
      row.push(cell)
      cell = ''
    } else if (!quoted && character === '\r' && csv[index + 1] === '\n') {
      row.push(cell)
      result.push(row)
      row = []
      cell = ''
      index++
    } else cell += character
  }
  return result
}

describe('screening results CSV', () => {
  it('bounds and sanitizes Unicode filenames', () => {
    expect(screeningResultsFilename('论文'.repeat(100))).toBe(
      `${'论文'.repeat(30)}-screening-results.csv`
    )
    expect(screeningResultsFilename('  Ａ/Ｂ\\C:*?<>|  ')).toBe('A_B_C______-screening-results.csv')
    expect(screeningResultsFilename('   ')).toBe('collection-screening-results.csv')
    expect(screeningResultsFilename('a'.repeat(59) + '😀')).toBe(
      `${'a'.repeat(59)}-screening-results.csv`
    )
  })
  it('includes every candidate state across smart and metadata pages, independently of included membership', async () => {
    const { reader, transport } = fixture(205)
    const snapshot = await readScreeningExport('smart', reader)
    expect(snapshot.rows).toHaveLength(205)
    expect(snapshot.items.size).toBe(205)
    expect(reader.readSmart.mock.calls).toEqual([[0], [100], [200], [0, true]])
    expect(reader.readItems).toHaveBeenCalledTimes(3)
    expect(transport).toHaveBeenCalledTimes(7)
    expect(snapshot.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 205 }, (_, i) => `paper-${i}`)
    )
    for (const entry of snapshot.items.values()) {
      expect(entry.item).not.toHaveProperty('abstract')
      expect(entry).not.toHaveProperty('attachments')
    }
    for (const [request] of reader.readItems.mock.calls) {
      expect(request).not.toHaveProperty('collectionId')
      expect(request).not.toHaveProperty('smartFilter')
      expect(request).not.toHaveProperty('query')
    }
    const csv = screeningResultsCsv(snapshot)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const [header, ...data] = records(csv)
    expect(data).toHaveLength(205)
    expect(new Set(data.map((record) => record[header!.indexOf('final_verdict')]))).toEqual(
      new Set(['match', 'no-match', 'uncertain', 'pending', 'stale', 'error'])
    )
    expect(data[0]![header!.indexOf('authors')]).toBe('Ada Lovelace; Trial Group')
    expect(data[0]![header!.indexOf('doi')]).toBe('10.1234/trial')
    expect(data[0]![header!.indexOf('year')]).toBe('2025')
  })

  it('quotes commas, quotes and CRLF, neutralizes formulas, and preserves manual/stale evidence without inventing an AI verdict', async () => {
    const { rows, reader, view } = fixture()
    rows[0] = {
      ...rows[0]!,
      verdict: 'no-match',
      override: 'exclude',
      decisionSource: 'manual',
      reason: 'rule-changed',
      assessment: {
        current: false,
        model: 'model',
        evaluatedAt: 1000,
        ruleRevision: 1,
        currentRuleRevision: 2,
        probabilities: { match: 0.8, 'no-match': 0.1, uncertain: 0.1 },
        evidence: {
          coverage: 'passages',
          filename: 'paper.pdf',
          passage: { pageStart: 2, pageEnd: 3, content: 'text' }
        }
      }
    }
    view.matches = 0
    view.pending = 0
    view.overrides = 1
    view.ruleRevision = 2
    view.counts = { match: 0, 'no-match': 1, review: 0, pending: 0 }
    const snapshot = await readScreeningExport('smart', reader)
    snapshot.items.get('paper-0')!.item.title = '  =HYPERLINK("x"),\n论文'
    snapshot.collection.description = '\t@SUM(1,2)'
    const csv = screeningResultsCsv(snapshot)
    expect(csv).not.toMatch(/(?<!\r)\n/u)
    const [header, values] = records(csv)
    const record = Object.fromEntries(header!.map((key, index) => [key, values![index]]))
    expect(record.title).toBe('\'  =HYPERLINK("x"),\r\n论文')
    expect(record.collection_rule).toBe("'\t@SUM(1,2)")
    expect(record).toMatchObject({
      final_verdict: 'no-match',
      manual_decision: 'exclude',
      assessment_current: 'false',
      probability_match: '0.8',
      page_start: '2',
      page_end: '3'
    })
    expect(header).not.toContain('ai_verdict')
    for (const prefix of ['=', '+', '-', '@', '\t', '\r', '\n', ' \u0000=']) {
      snapshot.items.get('paper-0')!.item.title = `${prefix}formula`
      expect(records(screeningResultsCsv(snapshot))[1]![1]).toMatch(/^'/u)
    }
  })

  it.each(['summary', 'duplicate', 'missing', 'metadata', 'source'] as const)(
    'rejects %s changes/incompleteness',
    async (failure) => {
      const { reader } = fixture(101)
      const readSmart = reader.readSmart.getMockImplementation()!
      reader.readSmart.mockImplementation(async (offset, summaryOnly) => {
        const page = await readSmart(offset, summaryOnly)
        if (failure === 'summary' && offset === 100) page.ruleRevision = 2
        if (failure === 'duplicate' && offset === 100) page.rows[0]!.id = 'paper-0'
        if (failure === 'missing' && offset === 100) page.rows = []
        if (failure === 'source') page.sourceAvailable = false
        return page
      })
      if (failure === 'metadata') reader.readItems.mockResolvedValue({ entries: [], totalCount: 0 })
      await expect(readScreeningExport('smart', reader)).rejects.toThrow()
    }
  )

  it('detects a changed final summary even when counts and candidate total stay constant', async () => {
    const { reader } = fixture()
    const original = reader.readSmart.getMockImplementation()!
    reader.readSmart.mockImplementation(async (offset, summaryOnly) => ({
      ...(await original(offset, summaryOnly)),
      ...(summaryOnly ? { ruleRevision: 2 } : {})
    }))
    await expect(readScreeningExport('smart', reader)).rejects.toBeInstanceOf(
      ScreeningExportChanged
    )
  })

  it('exports a valid empty source as headers only', async () => {
    const { reader, view } = fixture(0)
    view.pending = 0
    view.counts.pending = 0
    expect(records(screeningResultsCsv(await readScreeningExport('smart', reader)))).toHaveLength(1)
    expect(reader.readItems).not.toHaveBeenCalled()
  })
})

it('adversarial: rejects a renamed collection with unchanged screening counts and rule summary', async () => {
  const { reader } = fixture()
  reader.search
    .mockResolvedValueOnce({ entries: [{ ...collection }] })
    .mockResolvedValueOnce({ entries: [{ ...collection, name: 'Renamed', revision: 2 }] })
  await expect(readScreeningExport('smart', reader)).rejects.toBeInstanceOf(ScreeningExportChanged)
})

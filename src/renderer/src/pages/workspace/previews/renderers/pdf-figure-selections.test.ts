import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createPdfPagePreviewCache,
  groupPdfFigureSelections,
  loadPdfFigurePreview
} from './pdf-figure-selections'
import { copyPdfTable } from '../../../../../../shared/pdf-table-copy'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const batch = (page: number): PdfStructureResult => {
  const region = { page, x: 0.1, y: 0.1, width: 0.8, height: 0.5 }
  return {
    schemaVersion: 1,
    extractionId: `batch-${page}`,
    engineFingerprint: 'a'.repeat(64),
    sourceChecksum: 'b'.repeat(64),
    sourceSizeBytes: 100,
    pageCount: 8,
    requestedPages: [page],
    processedPages: [page],
    pages: [{ page, width: 600, height: 800, rotation: 0 }],
    thumbnails: [],
    navigation: [],
    issues: [],
    elements: [
      {
        id: `table-${page}`,
        kind: 'table',
        thumbnailId: `crop-${page}`,
        regions: [region],
        caption: {
          text: page === 5 ? 'Table 1. Baseline data.' : 'Table 1. (continued)',
          regions: [region]
        },
        issues: [],
        table: {
          rowCount: 2,
          columnCount: 3,
          cells: [
            ['Variable', 'Arm A', 'Arm B'],
            [page === 5 ? 'Letrozole' : 'Anastrozole', '3', '8']
          ].flatMap((row, r) =>
            row.map((text, column) => ({
              row: r,
              column,
              rowSpan: 1,
              columnSpan: 1,
              text,
              regions: [region]
            }))
          ),
          unassignedText: [],
          issues: [],
          notes: page === 5 ? [] : [{ text: 'Source definitions.', regions: [region] }]
        }
      }
    ]
  }
}

it('joins explicit adjacent table continuations across batches without duplicating the header', () => {
  const batches = [batch(5), batch(6), batch(7)]
  const original = structuredClone(batches)
  const entries = groupPdfFigureSelections(batches)
  expect(entries).toHaveLength(1)
  expect(entries[0].continuations).toHaveLength(2)
  expect(entries[0].combinedTable?.rowCount).toBe(4)
  const table = entries[0].combinedTable!
  expect(copyPdfTable(table, 'tsv', '')).toBe(
    'Variable\tArm A\tArm B\nLetrozole\t3\t8\nAnastrozole\t3\t8\nAnastrozole\t3\t8'
  )
  expect(copyPdfTable(table, 'html', '')).toContain('Source definitions.')
  expect(table.cells.find((c) => c.row === 2)?.regions[0].page).toBe(6)
  expect(batches).toEqual(original)
})

it('leaves unrelated, ambiguous or incompatible tables separate', () => {
  const variants = [
    (b: PdfStructureResult) => {
      b.sourceChecksum = 'c'.repeat(64)
    },
    (b: PdfStructureResult) => {
      b.elements[0].regions[0].page = 7
    },
    (b: PdfStructureResult) => {
      b.elements[0].caption!.text = 'Table 2. (continued)'
    },
    (b: PdfStructureResult) => {
      b.elements[0].caption!.text = 'Table 1. Independent data.'
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.cells[1].text = 'Other arm'
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.cells[1].rowSpan = 2
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.cells[4].text = 'Mean (SD)'
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.unassignedText = [{ text: 'Unplaced heading', regions: [] }]
    }
  ]
  for (const change of variants) {
    const next = batch(6)
    change(next)
    expect(groupPdfFigureSelections([batch(5), next])).toHaveLength(2)
  }
  const first = batch(5)
  first.elements.push({ ...first.elements[0], id: 'other-table' })
  expect(groupPdfFigureSelections([first, batch(6)])).toHaveLength(3)
})

it('joins a repeated units header while preserving section rows, notes and page provenance', () => {
  const data = [batch(5), batch(6)]
  for (const [i, result] of data.entries()) {
    const element = result.elements[0]
    element.caption!.text = i ? 'Table 1 (continued )' : 'Table 1. Longitudinal results'
    element.table = {
      rowCount: 4,
      columnCount: 4,
      cells: [
        ...['Variables', 'Arm A', 'Arm B', 'P-value'].map((text, column) => ({
          row: 0,
          column,
          rowSpan: 1,
          columnSpan: 1,
          text,
          regions: element.regions
        })),
        { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: '', regions: element.regions },
        {
          row: 1,
          column: 1,
          rowSpan: 1,
          columnSpan: 2,
          text: '(Mean ± SD)',
          regions: element.regions
        },
        { row: 1, column: 3, rowSpan: 1, columnSpan: 1, text: '', regions: element.regions },
        {
          row: 2,
          column: 0,
          rowSpan: 1,
          columnSpan: 4,
          text: `Outcome ${i + 1}`,
          regions: element.regions
        },
        ...['Baseline', '12.2 ± 1.0', '13.4 ± 1.2', '0.2'].map((text, column) => ({
          row: 3,
          column,
          rowSpan: 1,
          columnSpan: 1,
          text,
          regions: element.regions
        }))
      ],
      unassignedText: [],
      issues: [],
      notes: i ? [{ text: 'Paired comparisons.', regions: element.regions }] : []
    }
  }
  const entries = groupPdfFigureSelections(data)
  expect(entries).toHaveLength(1)
  expect(entries[0].combinedTable?.rowCount).toBe(6)
  expect(entries[0].combinedTable?.cells.find((c) => c.row === 4)?.text).toBe('Outcome 2')
  expect(entries[0].combinedTable?.cells.find((c) => c.row === 5)?.regions[0].page).toBe(6)
  expect(copyPdfTable(entries[0].combinedTable!, 'html', '')).toContain('Paired comparisons.')
  data[1].elements[0].table!.cells[5].text = '(Median ± SD)'
  expect(groupPdfFigureSelections(data)).toHaveLength(2)
})

it('joins explicit continuations whose first record follows full-width outcome labels', () => {
  const a = batch(5),
    b = batch(6)
  for (const result of [a, b]) {
    const t = result.elements[0].table!
    t.cells.forEach((c) => {
      if (c.row) c.row += 2
    })
    t.cells.push(
      ...[1, 2].map((row) => ({
        row,
        column: 0,
        rowSpan: 1,
        columnSpan: 3,
        text: `Outcome ${row}`,
        regions: result.elements[0].regions
      }))
    )
    t.rowCount += 2
  }
  const entries = groupPdfFigureSelections([a, b])
  expect(entries).toHaveLength(1)
  expect(entries[0].combinedTable!.cells.filter((c) => c.text === 'Outcome 1')).toHaveLength(2)
})
it('requires a complete repeated header and page-edge geometry for an unlabelled short continuation', () => {
  const a = batch(5),
    b = batch(6)
  b.elements[0].caption = undefined
  for (const r of [a, b]) {
    const t = r.elements[0].table!,
      region = r.elements[0].regions[0]
    t.columnCount = 4
    t.cells.push(
      { row: 0, column: 3, rowSpan: 1, columnSpan: 1, text: 'Arm C', regions: [region] },
      { row: 1, column: 3, rowSpan: 1, columnSpan: 1, text: '9', regions: [region] }
    )
  }
  const t = a.elements[0].table!
  for (let row = 2; row < 12; row++)
    t.cells.push(
      ...t.cells
        .filter((c) => c.row === 1)
        .map((c) => ({ ...c, row, text: c.column ? c.text : `Record ${row}` }))
    )
  t.rowCount = 12
  a.elements[0].regions[0].height = 0.8
  expect(groupPdfFigureSelections([a, b])).toHaveLength(1)
  b.elements[0].regions[0].y = 0.4
  expect(groupPdfFigureSelections([a, b])).toHaveLength(2)
  b.elements[0].regions[0].y = 0.1
  b.elements[0].table!.cells.find((c) => c.row === 0 && c.column === 3)!.text = 'Other group'
  expect(groupPdfFigureSelections([a, b])).toHaveLength(2)
  const next = b.elements[0].table!
  next.cells.find((c) => c.row === 0 && c.column === 3)!.text = 'Arm C'
  for (const c of t.cells.filter((c) => c.row === 0 && [1, 2].includes(c.column)))
    c.text += ' M±SD or n (%)'
  for (const c of next.cells) if (c.row) c.row++
  next.cells.find((c) => c.row === 0 && c.column === 3)!.rowSpan = 2
  next.cells.push(
    ...[1, 2].map((column) => ({
      row: 1,
      column,
      rowSpan: 1,
      columnSpan: 1,
      text: 'M±SD or n (%)',
      regions: b.elements[0].regions
    }))
  )
  next.rowCount++
  const combined = groupPdfFigureSelections([a, b])
  expect(combined).toHaveLength(1)
  expect(combined[0].combinedTable!.rowCount).toBe(13)
})

it('joins a repeated header with explicitly named statistics in the first record', () => {
  const first = batch(5),
    next = batch(6)
  for (const b of [first, next]) {
    const cells = b.elements[0].table!.cells
    cells[1].text = 'Statistics'
    cells[2].text = 'P value'
  }
  first.elements[0].table!.cells[4].text = 't=0.699'
  first.elements[0].table!.cells[5].text = 'P=0.486'
  const joined = groupPdfFigureSelections([first, next])
  expect(joined).toHaveLength(1)
  expect(copyPdfTable(joined[0].combinedTable!, 'tsv', '')).toContain('t=0.699\tP=0.486')
  for (const change of ['wrong-heading', 'prose']) {
    const invalid = structuredClone(first)
    const following = structuredClone(next)
    if (change === 'wrong-heading') {
      invalid.elements[0].table!.cells[1].text = 'Arm A'
      following.elements[0].table!.cells[1].text = 'Arm A'
    } else invalid.elements[0].table!.cells[4].text = 't=approximately 0.699'
    expect(groupPdfFigureSelections([invalid, following])).toHaveLength(2)
  }
})

it('joins numeric records with native superscript footnotes while preserving their display and copy', () => {
  const first = batch(5),
    second = batch(6)
  const cell = first.elements[0].table!.cells[4]
  cell.text = '44c'
  cell.textRuns = [
    { text: '44', position: 'normal' },
    { text: 'c', position: 'superscript' }
  ]
  const original = structuredClone([first, second])
  const entries = groupPdfFigureSelections([first, second])
  expect(entries).toHaveLength(1)
  expect(entries[0].combinedTable!.cells[4]).toEqual(cell)
  expect(copyPdfTable(entries[0].combinedTable!, 'html', '')).toContain('44<sup>c</sup>')
  expect([first, second]).toEqual(original)
  delete cell.textRuns
  expect(groupPdfFigureSelections([first, second])).toHaveLength(2)
  cell.textRuns = [
    { text: '44', position: 'normal' },
    { text: 'c', position: 'subscript' }
  ]
  expect(groupPdfFigureSelections([first, second])).toHaveLength(2)
})

it('joins source-backed multilevel continuations while preserving sections and source regions', async () => {
  const { resolve } = await import('node:path')
  const f = readPdfFixture(
    resolve('test/fixtures/pdf-figure-selections/rotated-outcome-table-continuation.json')
  )
  const a = batch(5),
    b = batch(6)
  a.elements[0].table = f.start
  b.elements[0].table = f.continued
  a.elements[0].caption!.text =
    'Table 4 Mean and Range T 1 (Baseline). T 2 (1 week after) and T 3 (5 week after); Mean Differences. t-distribution. and p values of T 1 - T 2 and T1 - T 3 for within-group change scores in Patient-Reported Outcomes'
  b.elements[0].caption!.text =
    'Table 4 Mean and Range T 1 (Baseline). T 2 (1 week after) and T 3 (5 week after); Mean Differences. t-distribution. and p values of T 1 - T 2 and T1 - T 3 for within-group change scores in Patient-Reported Outcomes (Continued)'
  const original = structuredClone([a, b])
  const joined = groupPdfFigureSelections([a, b])
  expect(joined).toHaveLength(1)
  expect(joined[0].combinedTable?.rowCount).toBe(f.start.rowCount + f.continued.rowCount - 2)
  expect(joined[0].combinedTable?.cells.find((c) => c.text === 'Insomnia')?.regions[0].page).toBe(
    12
  )
  expect(joined[0].combinedTable?.cells.find((c) => c.text === 'POMS')?.columnSpan).toBe(15)
  expect([a, b]).toEqual(original)
  for (const mode of [
    'changed-caption',
    'changed-parent',
    'overlap',
    'missing-leaf',
    'unassigned'
  ]) {
    const next = structuredClone(b),
      table = next.elements[0].table!
    if (mode === 'changed-caption')
      next.elements[0].caption!.text = 'Table 4. Independent outcomes. (Continued)'
    if (mode === 'changed-parent')
      table.cells.find((c) => c.row === 0 && c.column === 1)!.text = 'Other cohort'
    if (mode === 'overlap') table.cells.push(structuredClone(table.cells[0]))
    if (mode === 'missing-leaf')
      table.cells = table.cells.filter((c) => !(c.row === 1 && c.column === 1))
    if (mode === 'unassigned') table.unassignedText.push({ text: 'Unowned value', regions: [] })
    expect(groupPdfFigureSelections([a, next]), mode).toHaveLength(2)
  }
})

it('joins native assessment schedules and unheaded quotations without dropping body rows', async () => {
  const { resolve } = await import('node:path')
  const cases = readPdfFixture(
    resolve('test/fixtures/pdf-figure-selections/native-table-continuations.json')
  )
  for (const [name, rows] of [
    ['schedules', 30],
    ['quotations', 9]
  ] as const) {
    const results = cases[name] as PdfStructureResult[]
    const original = structuredClone(results),
      grouped = groupPdfFigureSelections(results)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].combinedTable?.rowCount).toBe(rows)
    expect(grouped[0].continuations).toHaveLength(1)
    expect(results).toEqual(original)
    if (name === 'quotations') {
      expect(grouped[0].combinedTable?.cells.map((c) => c.text)).toEqual(
        results.flatMap((r) => r.elements[0].table!.cells.map((c) => c.text))
      )
      expect(copyPdfTable(grouped[0].combinedTable!, 'tsv', '')).toContain('3.1 a “And I agree')
    }
  }
})
it.each([
  'no-caption',
  'different-number',
  'different-columns',
  'ordinary-prose',
  'unassigned',
  'different-source',
  'nonadjacent'
])('leaves a narrative continuation separate with %s evidence', async (variant) => {
  const { resolve } = await import('node:path')
  const { quotations } = readPdfFixture(
    resolve('test/fixtures/pdf-figure-selections/native-table-continuations.json')
  )
  const next = quotations[1] as PdfStructureResult,
    element = next.elements[0],
    table = element.table!
  if (variant === 'no-caption') delete element.caption
  if (variant === 'different-number') element.caption!.text = 'Table 2 (continued)'
  if (variant === 'different-columns')
    table.cells
      .filter((c) => c.column === 1)
      .forEach((c) =>
        c.regions.forEach((r) => {
          r.x += 0.04
        })
      )
  if (variant === 'ordinary-prose')
    table.cells.forEach((c) => {
      c.text = c.text.replace(/^\d.*?[“"]/, '')
    })
  if (variant === 'unassigned') table.unassignedText = [{ text: 'Unplaced content', regions: [] }]
  if (variant === 'different-source') next.sourceChecksum = 'd'.repeat(64)
  if (variant === 'nonadjacent') element.regions[0].page += 1
  expect(groupPdfFigureSelections(quotations)).toHaveLength(2)
})

const readPdfFixture = (path: string): ReturnType<typeof JSON.parse> =>
  JSON.parse(readFileSync(path, 'utf8'))

afterEach(() => vi.unstubAllGlobals())

it('opens the uniquely captioned parent figure from the destination page and exact PDF version', async () => {
  const result = batch(5)
  const figure = {
    ...result.elements[0],
    kind: 'figure' as const,
    caption: { ...result.elements[0].caption!, text: 'Figure 13. Growth.' }
  }
  result.elements = [
    figure,
    { ...figure, id: 'control', caption: { ...figure.caption, text: 'Fig. 3. Control.' } }
  ]
  result.elements.push({
    ...figure,
    id: 'combined',
    thumbnailId: 'combined-crop',
    caption: { ...figure.caption, text: 'Figure 3 and 4. Combined observations.' }
  })
  const readCached = vi.fn().mockResolvedValue(result)
  const readThumbnail = vi.fn().mockResolvedValue('image')
  vi.stubGlobal('window', { api: { pdfStructure: { readCached, readThumbnail } } })
  const source = { attachmentVersionId: 'version' }
  const destination = { pageNumber: 5, x: 0, y: 0 }
  expect(await loadPdfFigurePreview(source, destination, 'Fig. 3(b)')).toEqual({
    image: 'image',
    caption: 'Fig. 3. Control.',
    destination: { pageNumber: 5, x: figure.regions[0].x, y: figure.regions[0].y }
  })
  expect(readCached).toHaveBeenCalledWith({ ...source, page: 5 })
  expect(readThumbnail).toHaveBeenCalledWith({
    ...source,
    page: 5,
    extractionId: result.extractionId,
    thumbnailId: 'crop-5'
  })
  result.elements.push({ ...result.elements[1], id: 'duplicate' })
  expect(await loadPdfFigurePreview(source, destination, 'Fig. 3')).toBeUndefined()
  readCached.mockResolvedValue(undefined)
  expect(await loadPdfFigurePreview(source, destination, 'Fig. 3')).toBeUndefined()
  expect(readThumbnail).toHaveBeenCalledTimes(1)
})

it.each([
  ['Figure 3 and 4. Combined observations.', false],
  ['Figure 3 至 5. Combined observations.', false],
  ['图3．2 温度曲线', false],
  ['图3．温度曲线', true],
  ['Figure 3 Growth rate', true]
])(
  'selects a unique whole-figure crop for %s only when its label is unambiguous',
  async (caption, eligible) => {
    const result = batch(5)
    result.elements[0].kind = 'figure'
    result.elements[0].caption!.text = String(caption)
    const readThumbnail = vi.fn().mockResolvedValue('crop')
    vi.stubGlobal('window', {
      api: {
        pdfStructure: {
          readCached: vi.fn().mockResolvedValue(result),
          readThumbnail
        }
      }
    })
    const preview = await loadPdfFigurePreview(
      { attachmentVersionId: 'version' },
      { pageNumber: 5, x: 0, y: 0 },
      'Fig. 3'
    )
    expect(preview?.image).toBe(eligible ? 'crop' : undefined)
    expect(readThumbnail).toHaveBeenCalledTimes(eligible ? 1 : 0)
  }
)

it('parses only a missing destination page when requested and removes its cancellation listener', async () => {
  const result = batch(5)
  result.elements[0].kind = 'figure'
  result.elements[0].caption!.text = 'Figure 3. Growth.'
  const readCached = vi.fn().mockResolvedValue(undefined)
  const readThumbnail = vi.fn().mockResolvedValue('crop')
  const parse = vi.fn().mockResolvedValue(result)
  const cancel = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { pdfStructure: { readCached, readThumbnail, parse, cancel } } })
  const source = { attachmentVersionId: 'version' }
  const destination = { pageNumber: 5, x: 0, y: 0 }
  const controller = new AbortController()
  const onCacheMiss = vi.fn()
  expect(await loadPdfFigurePreview(source, destination, 'Fig. 3')).toBeUndefined()
  expect(parse).not.toHaveBeenCalled()
  expect(
    await loadPdfFigurePreview(source, destination, 'Fig. 3', controller.signal, onCacheMiss)
  ).toEqual({
    image: 'crop',
    caption: 'Figure 3. Growth.',
    destination: {
      pageNumber: 5,
      x: result.elements[0].regions[0].x,
      y: result.elements[0].regions[0].y
    }
  })
  expect(onCacheMiss).toHaveBeenCalledOnce()
  expect(parse).toHaveBeenCalledWith({ ...source, page: 5, requestId: expect.any(String) })
  controller.abort()
  expect(cancel).not.toHaveBeenCalled()

  readCached.mockResolvedValue({ ...result, elements: [...result.elements, ...result.elements] })
  expect(
    await loadPdfFigurePreview(source, destination, 'Fig. 3', new AbortController().signal)
  ).toBeUndefined()
  expect(parse).toHaveBeenCalledOnce()
})

it('cancels pending page analysis and discards its late result without loading the crop', async () => {
  const result = batch(5)
  result.elements[0].kind = 'figure'
  result.elements[0].caption!.text = 'Figure 3. Growth.'
  let complete!: (value: PdfStructureResult) => void
  const parse = vi.fn().mockImplementation(() => new Promise((resolve) => (complete = resolve)))
  const readThumbnail = vi.fn()
  const cancel = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      pdfStructure: {
        readCached: vi.fn().mockResolvedValue(undefined),
        readThumbnail,
        parse,
        cancel
      }
    }
  })
  const controller = new AbortController()
  const loading = loadPdfFigurePreview(
    { attachmentVersionId: 'version' },
    { pageNumber: 5, x: 0, y: 0 },
    'Fig. 3',
    controller.signal
  )
  await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce())
  controller.abort()
  expect(cancel).toHaveBeenCalledWith(parse.mock.calls[0][0].requestId)
  complete(result)
  expect(await loading).toBeUndefined()
  expect(readThumbnail).not.toHaveBeenCalled()
})

it('falls back when optional page analysis fails or the caller aborts before cache lookup finishes', async () => {
  const parse = vi.fn().mockRejectedValue(new Error('Local model not installed'))
  const cancel = vi.fn().mockResolvedValue(undefined)
  const readCached = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { pdfStructure: { readCached, parse, cancel } } })
  const source = { attachmentVersionId: 'version' }
  const destination = { pageNumber: 5, x: 0, y: 0 }
  const controller = new AbortController()
  expect(
    await loadPdfFigurePreview(source, destination, 'Fig. 3', controller.signal)
  ).toBeUndefined()
  controller.abort()
  expect(cancel).not.toHaveBeenCalled()
  const next = new AbortController()
  const onCacheMiss = vi.fn()
  const loading = loadPdfFigurePreview(source, destination, 'Fig. 3', next.signal, onCacheMiss)
  next.abort()
  expect(await loading).toBeUndefined()
  expect(parse).toHaveBeenCalledOnce()
  expect(onCacheMiss).not.toHaveBeenCalled()
})

const mockPagePreviewDocument = (): {
  document: PDFDocumentProxy
  getPage: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  canvases: Array<{ width: number; height: number; toDataURL: ReturnType<typeof vi.fn> }>
} => {
  const canvases: Array<{
    width: number
    height: number
    toDataURL: ReturnType<typeof vi.fn>
  }> = []
  vi.stubGlobal('document', {
    createElement: vi.fn().mockImplementation(() => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue({}),
        toDataURL: vi.fn().mockReturnValue(`data:image/png;base64,page-${canvases.length}`)
      }
      canvases.push(canvas)
      return canvas
    })
  })
  const cancel = vi.fn()
  const render = vi.fn().mockReturnValue({ promise: Promise.resolve(), cancel })
  const getPage = vi.fn().mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({ width: 6000 * scale, height: 8000 * scale }),
    render
  })
  return {
    document: { numPages: 8, getPage } as unknown as PDFDocumentProxy,
    getPage,
    render,
    cancel,
    canvases
  }
}

it('renders bounded whole-page PNGs and keeps only the three most recently used pages', async () => {
  const { document, getPage, render, canvases } = mockPagePreviewDocument()
  const cache = createPdfPagePreviewCache(document)
  const signal = new AbortController().signal
  const first = await cache.load(1, signal)
  expect(first).toBe('data:image/png;base64,page-0')
  expect(render.mock.calls[0][0].viewport).toEqual({ width: 900, height: 1200 })
  expect(canvases[0].toDataURL).toHaveBeenCalledWith('image/png')
  expect(canvases[0].width).toBe(0)
  expect(canvases[0].height).toBe(0)
  await cache.load(2, signal)
  await cache.load(3, signal)
  expect(await cache.load(1, signal)).toBe(first)
  await cache.load(4, signal)
  expect(getPage).toHaveBeenCalledTimes(4)
  expect(await cache.load(2, signal)).toBe('data:image/png;base64,page-4')
  expect(getPage).toHaveBeenCalledTimes(5)
  cache.clear()
  await cache.load(2, signal)
  expect(getPage).toHaveBeenCalledTimes(6)
})

it('cancels rendering on abort and clear, releases canvases, and never caches late page images', async () => {
  const { document, getPage, render, cancel, canvases } = mockPagePreviewDocument()
  const cache = createPdfPagePreviewCache(document)
  let finish!: () => void
  render.mockImplementation(() => ({
    promise: new Promise<void>((resolve) => (finish = resolve)),
    cancel
  }))
  const controller = new AbortController()
  const loading = cache.load(1, controller.signal)
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
  controller.abort()
  expect(cancel).toHaveBeenCalledOnce()
  finish()
  expect(await loading).toBeUndefined()
  expect(canvases[0].width).toBe(0)
  expect(canvases[0].toDataURL).not.toHaveBeenCalled()

  const next = cache.load(1, new AbortController().signal)
  await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2))
  cache.clear()
  expect(cancel).toHaveBeenCalledTimes(2)
  finish()
  expect(await next).toBeUndefined()
  render.mockReturnValue({ promise: Promise.resolve(), cancel })
  expect(await cache.load(1, new AbortController().signal)).toBeDefined()
  expect(getPage).toHaveBeenCalledTimes(3)
})

it('ignores invalid and aborted pages and discards a page acquired after clearing the cache', async () => {
  const { document, getPage, render } = mockPagePreviewDocument()
  const cache = createPdfPagePreviewCache(document)
  const controller = new AbortController()
  controller.abort()
  expect(await cache.load(1, controller.signal)).toBeUndefined()
  for (const number of [0, 9, 1.5, NaN])
    expect(await cache.load(number, new AbortController().signal)).toBeUndefined()
  expect(getPage).not.toHaveBeenCalled()
  const page = await document.getPage(1)
  let acquire!: (value: typeof page) => void
  getPage.mockImplementationOnce(() => new Promise((resolve) => (acquire = resolve)))
  const loading = cache.load(1, new AbortController().signal)
  cache.clear()
  acquire(page)
  expect(await loading).toBeUndefined()
  expect(render).not.toHaveBeenCalled()
  getPage.mockRejectedValueOnce(new Error('Document destroyed'))
  expect(await cache.load(1, new AbortController().signal)).toBeUndefined()
})

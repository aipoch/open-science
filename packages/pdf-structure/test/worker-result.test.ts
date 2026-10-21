import { mkdtemp, mkdir, writeFile, rm, symlink, unlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPdfStructureDecodingBudget } from '../src/result.js'
import { readWorkerResult } from '../src/worker-result.js'
import { parsePdfStructureResult, type PdfStructureIdentity } from '../src/result.js'

const identity: PdfStructureIdentity = {
  extractionId: '00000000-0000-4000-8000-000000000001',
  engineFingerprint: 'b'.repeat(64),
  sourceChecksum: 'c'.repeat(64),
  sourceSizeBytes: 100,
  requestedPages: [1]
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
  'base64'
)
const { inspectScratch, serializeWorkerResult } = await import(
  pathToFileURL(resolve('resources/scratch.mjs')).href
)
const raw = (): Record<string, unknown> => ({
  sourceSha256: identity.sourceChecksum,
  pageCount: 1,
  requestedPages: [1],
  processedPages: [1],
  pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
  figures: [
    {
      id: 'p1-figure-1',
      page: 1,
      region: [0.1, 0.1, 0.5, 0.5],
      thumbnail: 'thumbnails/p1-figure-1.png',
      caption: { text: 'Full caption\nsecond line', rect: [60, 400, 300, 480] }
    }
  ],
  tables: [],
  navigation: { entries: [] }
})
let root: string
const rawTableFixture = {
  id: 'p1-figure-1',
  page: 1,
  region: [0.1, 0.1, 0.8, 0.9],
  thumbnail: 'thumbnails/p1-figure-1.png',
  sourceViewport: { width: 600, height: 800 },
  grid: [['=', '10']],
  cells: ['=', '10'].map((text, column) => ({
    row: 0,
    column,
    rowSpan: 1,
    colSpan: 1,
    text,
    sourceRects: [[60 + column * 100, 100, 80 + column * 100, 120]],
    sourceItems: [{ pageNumber: 1, index: column + 3, text: column ? '10' : '¼' }]
  })),
  unassigned: [],
  issues: []
}
const rawTable = (): typeof rawTableFixture => structuredClone(rawTableFixture)
const save = async (value: unknown): Promise<void> => {
  await writeFile(join(root, 'structure.json'), JSON.stringify(value))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-worker-result-'))
  await mkdir(join(root, 'thumbnails'))
  await writeFile(join(root, 'thumbnails/p1-figure-1.png'), png)
  await save(raw())
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
describe('worker result boundary', () => {
  it.each(['math-table', 'algorithm'] as const)(
    'preserves independently proved %s body origins without inventing cells',
    async (kind) => {
      const value = raw(),
        sourceItems = [{ pageNumber: 1, index: 7, text: 'Exact native body' }],
        candidate = {
          ...(value.figures as Record<string, unknown>[])[0],
          nativeBody: { kind, sourceItems }
        }
      value.figures = []
      if (kind === 'algorithm') value.algorithms = [candidate]
      else
        value.tables = [
          {
            ...candidate,
            sourceViewport: { width: 600, height: 800 },
            grid: [],
            cells: [],
            unassigned: [],
            issues: ['no-source-cell-grid']
          }
        ]
      await save(value)
      const result = await readWorkerResult(root, identity, new Map()),
        element = result.elements[0]
      expect(element).toMatchObject({
        kind: kind === 'algorithm' ? 'algorithm' : 'table',
        nativeBody: { kind, sourceItems }
      })
      expect(element.table).toBeUndefined()
      expect(parsePdfStructureResult(result, identity)).toEqual(result)
      for (const change of ['kind', 'caption', 'issue', 'wrong-page', 'empty', 'duplicate']) {
        const bad = structuredClone(result),
          body = bad.elements[0]
        if (change === 'kind') body.kind = 'figure'
        if (change === 'caption') delete body.caption
        if (change === 'issue') body.issues.push({ code: 'unknown-structure', detail: '' })
        if (change === 'wrong-page') body.nativeBody!.sourceItems[0].pageNumber = 2
        if (change === 'empty') body.nativeBody!.sourceItems = []
        if (change === 'duplicate') body.nativeBody!.sourceItems.push({ ...sourceItems[0] })
        expect(() => parsePdfStructureResult(bad, identity), change).toThrow()
      }
      const duplicate = structuredClone(result)
      duplicate.elements.push({ ...structuredClone(element), id: 'other-body' })
      expect(() => parsePdfStructureResult(duplicate, identity)).toThrow(/multiple owners/)
      const competing = structuredClone(result)
      competing.elements.push({
        id: 'other-figure',
        kind: 'figure',
        regions: structuredClone(element.regions),
        issues: [],
        sourceItems
      })
      expect(() => parsePdfStructureResult(competing, identity)).toThrow(/multiple owners/)
      const cellConflict = structuredClone(result)
      cellConflict.elements.push({
        id: 'other-table',
        kind: 'table',
        regions: structuredClone(element.regions),
        issues: [],
        table: {
          rowCount: 1,
          columnCount: 1,
          issues: [],
          unassignedText: [],
          cells: [
            {
              row: 0,
              column: 0,
              rowSpan: 1,
              columnSpan: 1,
              text: 'Exact native body',
              regions: structuredClone(element.regions),
              sourceItems
            }
          ]
        }
      })
      expect(() => parsePdfStructureResult(cellConflict, identity)).toThrow(
        /both a native body and a table/
      )
    }
  )

  it.each(['nodes', 'text'])(
    'omits the complete optional body proof when its %s budget is exceeded',
    async (budget) => {
      const value = raw(),
        candidate = {
          ...(value.figures as Record<string, unknown>[])[0],
          nativeBody: {
            kind: 'algorithm',
            sourceItems: Array.from({ length: budget === 'nodes' ? 8192 : 12 }, (_, index) => ({
              pageNumber: 1,
              index,
              text: budget === 'text' ? 'x'.repeat(190000) : 'x'
            }))
          }
        }
      value.figures = []
      value.algorithms = [candidate]
      await save(value)
      const result = await readWorkerResult(root, identity, new Map())
      expect(result.elements[0].kind).toBe('algorithm')
      expect(result.elements[0].nativeBody).toBeUndefined()
    }
  )

  it('omits the complete optional body proof when its serialized UTF-8 budget is exceeded', async () => {
    const value = raw()
    value.algorithms = [
      {
        ...(value.figures as Record<string, unknown>[])[0],
        nativeBody: {
          kind: 'algorithm',
          sourceItems: Array.from({ length: 16 }, (_, index) => ({
            pageNumber: 1,
            index,
            text: '中'.repeat(200000)
          }))
        }
      }
    ]
    value.figures = []
    const serialized = serializeWorkerResult(value)
    expect(serialized).not.toContain('nativeBody')
    await save(JSON.parse(serialized))
    expect(
      (await readWorkerResult(root, identity, new Map())).elements[0].nativeBody
    ).toBeUndefined()
  })

  it('retains uncertainty on figures with a crop and native source evidence', async () => {
    const value = raw()
    Object.assign((value.figures as Record<string, unknown>[])[0], {
      issue: 'uncertain-region',
      sourceItems: [{ pageNumber: 1, index: 7, text: 'Observed count' }]
    })
    await save(value)
    const result = await readWorkerResult(root, identity, new Map())
    expect(result.elements[0].issues).toEqual([
      { code: 'uncertain-region', detail: 'uncertain-region' }
    ])
  })
  it('preserves proved figure label origins through worker and public cache decoding', async () => {
    const value = raw(),
      sourceItems = [{ pageNumber: 1, index: 7, text: 'Observed count' }]
    Object.assign((value.figures as Record<string, unknown>[])[0], { sourceItems })
    await save(value)
    const result = await readWorkerResult(root, identity, new Map())
    expect(result.elements[0]).toMatchObject({ sourceItems })
    expect(parsePdfStructureResult(result, identity)).toEqual(result)
    for (const invalid of [
      [],
      [{ pageNumber: 2, index: 7, text: 'Observed count' }],
      [{ pageNumber: 1, index: -1, text: 'Observed count' }],
      [sourceItems[0], sourceItems[0]]
    ]) {
      const bad = structuredClone(result)
      bad.elements[0].sourceItems = invalid
      expect(() => parsePdfStructureResult(bad, identity)).toThrow()
    }
    const algorithm = structuredClone(result)
    algorithm.elements[0].kind = 'algorithm'
    expect(() => parsePdfStructureResult(algorithm, identity)).toThrow()
    const duplicate = structuredClone(result)
    duplicate.elements.push({ ...structuredClone(result.elements[0]), id: 'other-figure' })
    expect(() => parsePdfStructureResult(duplicate, identity)).toThrow(/multiple owners/)
    const conflict = structuredClone(result)
    conflict.elements.push({
      id: 'competing-table',
      kind: 'table',
      regions: structuredClone(result.elements[0].regions),
      issues: [],
      table: {
        rowCount: 1,
        columnCount: 1,
        issues: [],
        unassignedText: [],
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            text: 'Observed count',
            regions: structuredClone(result.elements[0].regions),
            sourceItems
          }
        ]
      }
    })
    expect(() => parsePdfStructureResult(conflict, identity)).toThrow(/both a figure and a table/)
  })

  it('keeps repaired display text separate from exact raw origins on a rotated page', async () => {
    const table = rawTable()
    await save({
      ...raw(),
      figures: [],
      tables: [table],
      pages: [{ page: 1, width: 600, height: 800, rotation: 90 }]
    })
    const result = await readWorkerResult(root, identity, new Map())
    expect(result.elements[0].table!.cells[0]).toMatchObject({
      text: '=',
      sourceItems: [{ pageNumber: 1, index: 3, text: '¼' }]
    })
    // The same strict contract protects IPC/cache reads independently of the worker schema.
    const cell = result.elements[0].table!.cells[0]
    for (const origins of [
      [],
      [{ pageNumber: 1, index: -1, text: 'x' }],
      [{ pageNumber: 1, index: 1.5, text: 'x' }],
      [{ pageNumber: 1, index: Number.MAX_SAFE_INTEGER + 1, text: 'x' }],
      [{ pageNumber: 1, index: 3, text: ' ' }],
      [{ pageNumber: 2, index: 3, text: '¼' }],
      [{ pageNumber: 1, index: 4, text: '¼' }], // Conflicts with the second cell.
      [
        { pageNumber: 1, index: 3, text: '¼' },
        { pageNumber: 1, index: 3, text: '¼' }
      ],
      [
        { pageNumber: 1, index: 5, text: 'x' },
        { pageNumber: 1, index: 3, text: '¼' }
      ]
    ]) {
      cell.sourceItems = origins
      expect(() => parsePdfStructureResult(result, identity)).toThrow()
      table.cells[0].sourceItems = origins
      await save({ ...raw(), figures: [], tables: [table] })
      await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
    }
    delete cell.sourceItems
    delete result.elements[0].table!.cells[1].sourceItems
    expect(parsePdfStructureResult(result, identity)).toEqual(result)
  })

  it.each(['nodes', 'text', 'converted-nodes'])(
    'omits origins for the entire job when optional metadata exceeds the %s budget',
    async (budget) => {
      const table = rawTable()
      table.cells[0].sourceItems = Array.from(
        { length: budget === 'text' ? 12 : budget === 'nodes' ? 8192 : 6000 },
        (_, index) => ({
          pageNumber: 1,
          index: index + 10,
          text: budget === 'text' ? 'x'.repeat(190000) : 'x'
        })
      )
      if (budget === 'converted-nodes')
        table.cells[0].sourceRects = Array.from({ length: 1500 }, () => [60, 100, 80, 120])
      const value = { ...raw(), figures: [], tables: [table] }
      if (budget === 'converted-nodes')
        expect(() =>
          checkPdfStructureDecodingBudget(JSON.parse(JSON.stringify(value)))
        ).not.toThrow()
      await save(value)
      const images = new Map<string, Uint8Array>()
      const result = await readWorkerResult(root, identity, images)
      expect(result.elements[0].table!.cells.map((cell) => cell.text)).toEqual(['=', '10'])
      expect(result.elements[0].table!.cells.every((cell) => cell.sourceItems === undefined)).toBe(
        true
      )

      // Omitting optional metadata must not relax the original content budgets.
      table.cells[1].text = 'x'.repeat(262145)
      await save(value)
      await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('budget')
    }
  )

  it('omits all origins before writing an oversized UTF-8 manifest', async () => {
    const table = rawTable()
    Object.assign(table.cells[0], { sourceTokens: [{ text: 'temporary token geometry' }] })
    const value = { ...raw(), figures: [], tables: [table] }
    const small = serializeWorkerResult(value)
    expect(small).toContain('sourceItems')
    expect(small).not.toContain('sourceTokens')
    table.cells[0].sourceItems = Array.from({ length: 16 }, (_, index) => ({
      pageNumber: 1,
      index: index + 10,
      text: '中'.repeat(200000)
    }))
    const text = serializeWorkerResult(value)
    expect(Buffer.byteLength(text)).toBeLessThan(8 * 1024 ** 2)
    expect(text).not.toContain('sourceItems')
    expect(text).not.toContain('sourceTokens')
    await writeFile(join(root, 'structure.json'), text)
    expect(
      (await readWorkerResult(root, identity, new Map())).elements[0].table!.cells[0].text
    ).toBe('=')
  })

  it('rejects source items on another processed page even when that page exists', async () => {
    const table = rawTable()
    table.cells[0].sourceItems[0].pageNumber = 2
    const bothPages = { ...identity, requestedPages: [1, 2] }
    await save({
      ...raw(),
      pageCount: 2,
      requestedPages: [1, 2],
      processedPages: [1, 2],
      pages: [1, 2].map((page) => ({ page, width: 600, height: 800, rotation: 0 })),
      figures: [],
      tables: [table]
    })
    await expect(readWorkerResult(root, bothPages, new Map())).rejects.toThrow('cell page')
  })

  it.each([false, true])(
    'normalizes auxiliary-page notes independently and retains their provenance (grouped: %s)',
    async (grouped) => {
      const notes = [{ text: 'a Two-sample t test.', page: 2, rect: [30, 40, 270, 80] }]
      const data = {
        sourceViewport: { width: 900, height: 1200 },
        grid: [['Value']],
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            colSpan: 1,
            text: 'Value',
            sourceItems: [{ pageNumber: 1, index: 9, text: 'Exact raw value' }],
            sourceRects: [[90, 120, 450, 600]]
          }
        ],
        unassigned: [],
        issues: [],
        notes
      }
      const table = {
        id: 'p1-figure-1',
        page: 1,
        region: [0.1, 0.1, 0.5, 0.5],
        thumbnail: 'thumbnails/p1-figure-1.png',
        caption: { text: 'Table 1. Sample data.', rect: [60, 80, 300, 90] },
        ...(grouped
          ? {
              parts: [
                { ...data, title: 'A' },
                { ...data, title: 'B' }
              ],
              notes
            }
          : data)
      }
      const value = {
        ...raw(),
        pageCount: 2,
        auxiliaryPages: [2],
        pages: [
          { page: 1, width: 600, height: 800, rotation: 0 },
          { page: 2, width: 300, height: 400, rotation: 90 }
        ],
        figures: [],
        tables: [table]
      }
      await save(value)
      const images = new Map<string, Uint8Array>()
      const result = await readWorkerResult(root, identity, images)
      const element = result.elements[0]
      const cells = (grouped ? element.tableParts![0].table : element.table!).cells
      expect(cells[0].sourceItems).toEqual(data.cells[0].sourceItems)
      const expected = [
        { text: notes[0].text, regions: [{ page: 2, x: 0.1, y: 0.1, width: 0.8, height: 0.1 }] }
      ]
      expect(grouped ? element.tableNotes : element.table?.notes).toEqual(expected)
      if (grouped)
        for (const part of element.tableParts!) expect(part.table.notes).toEqual(expected)
      expect(result.requestedPages).toEqual([1])
      expect(result.processedPages).toEqual([1])

      for (const page of [0, 1.5, 3]) {
        notes[0].page = page
        await save(value)
        await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
      }
    }
  )

  it('persists one parent table with independent part grids and shared notes', async () => {
    const parts = [5, 7].map((columns, index) => ({
      title: index ? 'B. Dewa data' : 'A. Tricco data',
      sourceViewport: { width: 900, height: 1200 },
      grid: [Array<string>(columns).fill('Value')],
      cells: Array.from({ length: columns }, (_, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: 'Value',
        sourceRects: [[90, 120, 100, 130]]
      })),
      unassigned: [],
      issues: index ? [] : ['native-table-structure-ambiguous']
    }))
    const group = {
      id: 'p1-figure-1',
      page: 1,
      region: [0.1, 0.1, 0.8, 0.9],
      thumbnail: 'thumbnails/p1-figure-1.png',
      caption: { text: 'Table 1. Sample data.', rect: [60, 80, 300, 90] },
      notes: [{ text: 'Shared note', rect: [60, 700, 300, 710] }],
      parts
    }
    await save({ ...raw(), figures: [], tables: [group] })
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements).toHaveLength(1)
    expect(result.elements[0].table).toBeUndefined()
    expect(
      result.elements[0].tableParts?.map((part) => [part.title, part.table.columnCount])
    ).toEqual([
      ['A. Tricco data', 5],
      ['B. Dewa data', 7]
    ])
    expect(result.elements[0].tableNotes?.[0].text).toBe('Shared note')
    // Part-local uncertainty must not become a group-wide conflict after
    // worker normalization; a reliable sibling keeps its own clean status.
    expect(result.elements[0].issues).toEqual([])
    expect(result.elements[0].tableParts?.map((part) => part.table.issues)).toEqual([
      [{ code: 'native-table-structure-ambiguous', detail: 'native-table-structure-ambiguous' }],
      []
    ])
    expect(result.thumbnails).toHaveLength(1)

    await save({ ...raw(), figures: [], tables: [{ ...group, caption: undefined }] })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
    await save({
      ...raw(),
      figures: [],
      tables: [{ ...group, parts: [{ ...parts[0], grid: [] }, parts[1]] }]
    })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
  })
  it.each(['algorithm', 'graphical-table', 'open-rule-table'])(
    'accounts for and cleans %s thumbnails while retaining unexpected scratch files',
    async (kind) => {
      const originalBytes = await inspectScratch(root)
      await writeFile(join(root, `thumbnails/p1-${kind}-0.png`), png)
      expect(await inspectScratch(root)).toBe(originalBytes + png.length)
      await writeFile(join(root, 'thumbnails/unowned.png'), png)
      await expect(inspectScratch(root)).rejects.toThrow('Unexpected PDF scratch')
      await unlink(join(root, 'thumbnails/unowned.png'))
      expect(await inspectScratch(root, true)).toBe(originalBytes + png.length)
      expect(await inspectScratch(root)).toBe(0)
    }
  )
  it('persists algorithms as image regions without manufacturing table cells', async () => {
    await save({
      ...raw(),
      figures: [],
      algorithms: [
        {
          id: 'p1-figure-1',
          page: 1,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Algorithm 1 Search', rect: [60, 80, 300, 90] }
        }
      ]
    })
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements[0].kind).toBe('algorithm')
    expect(result.elements[0].table).toBeUndefined()
    expect(result.elements[0].caption?.text).toBe('Algorithm 1 Search')

    expect(images.get('p1-figure-1')).toEqual(png)
  })
  it('normalizes an adjacent caption using its own page and preserves provenance through conversion', async () => {
    const value = raw()
    await save({
      ...value,
      pageCount: 2,
      auxiliaryPages: [2],
      pages: [
        { page: 1, width: 600, height: 800, rotation: 0 },
        { page: 2, width: 300, height: 400, rotation: 0 }
      ],
      figures: [
        {
          id: 'p1-figure-1',
          page: 1,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Following page caption', page: 2, rect: [30, 40, 270, 80] }
        }
      ]
    })
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.processedPages).toEqual([1])
    expect(result.auxiliaryPages).toEqual([2])
    expect(result.elements[0].caption?.regions[0]).toMatchObject({
      page: 2,
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.1
    })
  })
  it('rejects a caption whose declared page has no geometry', async () => {
    await save({
      ...raw(),
      pageCount: 2,
      figures: [
        {
          id: 'p1-figure-1',
          page: 1,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Missing source', page: 2, rect: [30, 40, 270, 80] }
        }
      ]
    })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('caption page')
  })
  it('normalizes a table continuation through an intermediate source page and preserves its caption in the result', async () => {
    const continuedIdentity = { ...identity, requestedPages: [3] }
    const value = {
      ...raw(),
      pageCount: 3,
      requestedPages: [3],
      processedPages: [3],
      auxiliaryPages: [1, 2],
      pages: [1, 2, 3].map((page) => ({ page, width: 600, height: 800, rotation: 0 })),
      figures: [],
      tables: [
        {
          id: 'p1-figure-1',
          page: 3,
          region: [0.1, 0.1, 0.5, 0.5],
          thumbnail: 'thumbnails/p1-figure-1.png',
          caption: { text: 'Table 1. Sample data.', page: 1, rect: [60, 80, 300, 90] },
          sourceViewport: { width: 900, height: 1200 },
          grid: [['Value']],
          cells: [
            {
              row: 0,
              column: 0,
              rowSpan: 1,
              colSpan: 1,
              text: 'Value',
              sourceRects: [[90, 120, 450, 600]]
            }
          ],
          unassigned: [],
          issues: []
        }
      ]
    }
    await save(value)
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, continuedIdentity, images)
    expect(result.elements[0].caption?.regions[0].page).toBe(1)
    expect(result.elements[0].table?.cells[0].regions[0].page).toBe(3)

    value.auxiliaryPages = [1]
    value.pages = value.pages.filter(({ page }) => page !== 2)
    await save(value)
    await expect(readWorkerResult(root, continuedIdentity, new Map())).rejects.toThrow('coverage')
  })
  it('normalizes a continued caption across different page sizes and preserves it through conversion', async () => {
    const value = raw() as ReturnType<typeof JSON.parse>
    value.pageCount = 2
    value.auxiliaryPages = [2]
    value.pages.push({ page: 2, width: 300, height: 400, rotation: 0 })
    value.figures[0].caption.regions = [
      { page: 1, rect: [60, 400, 300, 480] },
      { page: 2, rect: [30, 40, 270, 80] }
    ]
    await save(value)
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements[0].caption?.regions).toEqual(
      [
        { page: 1, x: 0.1, y: 0.5, width: 0.4, height: 0.1 },
        { page: 2, x: 0.1, y: 0.1, width: 0.8, height: 0.1 }
      ].map((r) => ({ ...r, height: expect.closeTo(r.height) }))
    )
  })
  it.each(['missing-page', 'empty-region', 'empty-fragments', 'too-many-fragments'])(
    'rejects invalid continued-caption evidence: %s',
    async (mode) => {
      const value = raw() as ReturnType<typeof JSON.parse>
      const part = { page: 1, rect: [60, 400, 300, 480] }
      value.figures[0].caption.regions = [part]
      if (mode === 'missing-page') part.page = 2
      if (mode === 'empty-region') part.rect[2] = part.rect[0]
      if (mode === 'empty-fragments') value.figures[0].caption.regions = []
      if (mode === 'too-many-fragments') value.figures[0].caption.regions = [part, part, part]
      await save(value)
      await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
    }
  )
  it('publishes and reopens high-resolution crops without changing image bytes or source regions', async () => {
    const image = await sharp({
      create: { width: 2400, height: 1800, channels: 3, background: '#fff' }
    })
      .png()
      .toBuffer()
    await writeFile(join(root, 'thumbnails/p1-figure-1.png'), image)
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.thumbnails[0]).toMatchObject({ width: 2400, height: 1800 })

    expect(images.get('p1-figure-1')).toEqual(image)
  })
  it.each([
    [2401, 1],
    [2400, 2401]
  ])('rejects crops beyond the edge or pixel budget (%i × %i)', async (width, height) => {
    const image = await sharp({
      create: { width, height, channels: 3, background: '#fff' }
    })
      .png()
      .toBuffer()
    await writeFile(join(root, 'thumbnails/p1-figure-1.png'), image)
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
  })
  it('accepts a bounded page result from a document longer than 100 pages', async () => {
    await save({ ...raw(), pageCount: 101 })
    expect((await readWorkerResult(root, identity, new Map())).pageCount).toBe(101)
  })
  it('preserves separate notes and their page regions while accepting historical tables without notes', async () => {
    const table = {
      id: 'p1-figure-1',
      page: 1,
      region: [0.1, 0.1, 0.5, 0.5],
      thumbnail: 'thumbnails/p1-figure-1.png',
      sourceViewport: { width: 900, height: 1200 },
      grid: [['Value']],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          colSpan: 1,
          text: 'Value',
          sourceRects: [[90, 120, 450, 600]]
        }
      ],
      unassigned: [],
      issues: []
    }
    await save({ ...raw(), figures: [], tables: [table] })
    expect(
      (await readWorkerResult(root, identity, new Map())).elements[0].table?.notes
    ).toBeUndefined()
    await save({
      ...raw(),
      figures: [],
      tables: [{ ...table, notes: [{ text: '* Original note.', rect: [60, 410, 300, 430] }] }]
    })
    const notes = (await readWorkerResult(root, identity, new Map())).elements[0].table?.notes
    expect(notes?.[0].text).toBe('* Original note.')
    expect(notes?.[0].regions[0]).toMatchObject({ page: 1, x: 0.1, y: 410 / 800, width: 0.4 })
    const textRuns = [
      { text: 'Value', position: 'normal' },
      { text: '*', position: 'superscript' }
    ]
    await save({
      ...raw(),
      figures: [],
      tables: [
        { ...table, grid: [['Value*']], cells: [{ ...table.cells[0], text: 'Value*', textRuns }] }
      ]
    })
    expect(
      (await readWorkerResult(root, identity, new Map())).elements[0].table?.cells[0].textRuns
    ).toEqual(textRuns)
    await save({
      ...raw(),
      figures: [],
      tables: [{ ...table, cells: [{ ...table.cells[0], textRuns }] }]
    })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow()
  })
  it('preserves full captions, normalized crop bounds and exact image bytes', async () => {
    const images = new Map<string, Uint8Array>()
    const result = await readWorkerResult(root, identity, images)
    expect(result.elements[0].caption?.text).toBe('Full caption\nsecond line')
    expect(result.elements[0].regions[0]).toEqual({
      page: 1,
      x: 0.1,
      y: 0.1,
      width: 0.4,
      height: 0.4
    })
    expect(images.get('p1-figure-1')).toEqual(png)
    expect(result.issues[0].code).toBe('candidate-results')
  })
  it('rejects manifest file links before reading contents', async ({ skip }) => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, 'this would fail JSON decoding')
    await unlink(join(root, 'structure.json'))
    try {
      await symlink(outside, join(root, 'structure.json'))
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        skip(
          'This Windows account cannot create file symlinks; the rejection runs where supported.'
        )
      }
      throw error
    }
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow(
      'Unsafe PDF output manifest'
    )
  })
  it('rejects thumbnail-directory links before reading image contents', async () => {
    await rm(join(root, 'thumbnails'), { recursive: true })
    await mkdir(join(root, 'outside'))
    await symlink(
      join(root, 'outside'),
      join(root, 'thumbnails'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow(
      'Unsafe PDF output directory'
    )
  })
  it('rejects excessive JSON and changed coverage before image decoding', async () => {
    await save({ ...raw(), ignored: Array(9000).fill(0) })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('decoding budget')
    await save({ ...raw(), processedPages: [2] })
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('coverage mismatch')
    await save(raw())
    await truncate(join(root, 'thumbnails/p1-figure-1.png'), 5 * 1024 ** 2)
    await expect(readWorkerResult(root, identity, new Map())).rejects.toThrow('decoding budget')
  })
})

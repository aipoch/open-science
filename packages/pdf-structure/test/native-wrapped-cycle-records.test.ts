/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import {
  PDFDocument,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
  setStrokingRgbColor,
  setLineWidth,
  moveTo,
  lineTo,
  stroke,
  rgb
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'
const resource = (name: string) => pathToFileURL(resolve(`resources/${name}.mjs`)).href
const { recoverNativeWrappedCycleRecordGrid: recover, recoverNativeWrappedCycleRecords: finish } =
  await import(resource('literature-pdf-native-wrapped-cycle-records'))
const { tableTextToken } = await import(resource('literature-pdf-orientation'))
const { recoverOwnedTableCrop } = await import(resource('literature-pdf-table-geometry'))
const { collectTableRules, collectGraphicsBounds } = await import(
  resource('literature-pdf-graphics')
)
const { projectPdfTextLines, findCaptionCandidates } = await import(
  resource('literature-pdf-caption-group')
)
const {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} = await import(resource('literature-pdf-render-bounds'))

async function withFixture(
  fault: string,
  inspect: (f: ReturnType<typeof JSON.parse>) => Promise<void>
) {
  const doc = await PDFDocument.create(),
    require = createRequire(import.meta.url),
    assets = dirname(require.resolve('pdfjs-dist/package.json'))
  doc.registerFontkit(require('fontkit'))
  const font = await doc.embedFont(
      await readFile(join(assets, 'standard_fonts/LiberationSans-Regular.ttf'))
    ),
    page = doc.addPage([600, 800]),
    key = page.node.newFontDictionary('Native', font.ref)
  const text = (value: string, x: number, y: number) =>
    page.pushOperators(
      beginText(),
      setFontAndSize(key, 10),
      setTextMatrix(1, 0, 0, 1, x, 800 - y),
      showText(font.encodeText(value)),
      endText()
    )
  text('Table', 60, 80)
  text('1:', 88, 80)
  text('Native-records', 101, 80)
  const starts = [50, 125, 200, 275, 350, 425]
  for (let c = fault === 'blank-stub' ? 1 : 0; c < 6; c++) {
    text(`Field-${c}`, starts[c], 110)
    if (c === 5 || fault === 'blank-stub') text('Detail', starts[c], 122)
  }
  for (let n = 0; n < 4; n++) {
    const y = 150 + n * 40,
      fields = starts.map((x, c) => () => {
        if (fault === 'missing-field' && n === 2 && c === 4) return
        text(
          c === 0 ? `Record-${n}` : `Value-${c}`,
          x,
          y + (fault === 'delay' && n === 2 && c === 4 ? 4 : 0)
        )
        if ((n === 1 && c === 0) || c === 5 || (n === 3 && [1, 2].includes(c)))
          text(
            'Tail',
            fault === 'gutter' && c === 5 ? 394 : x,
            y + (fault === 'record-overlap' && n === 1 ? 41 : 12)
          )
      })
    for (const c of fault === 'source-cycle' && n === 2 ? [0, 2, 1, 3, 4, 5] : [0, 1, 2, 3, 4, 5])
      fields[c]()
  }
  text('External-notice', 400, fault === 'foreign-ink' ? 290 : 312)
  page.pushOperators(
    setLineWidth(0.5),
    setStrokingRgbColor(...(fault === 'white-rail' ? ([1, 1, 1] as const) : ([0, 0, 0] as const)))
  )
  for (const y of fault === 'missing-rail' ? [98, 133] : [98, 133, 293])
    page.pushOperators(moveTo(40, 800 - y), lineTo(500, 800 - y), stroke())
  if (fault === 'foreign-paint')
    page.drawRectangle({ x: 200, y: 600, width: 10, height: 10, color: rgb(0, 0, 0) })
  const bytes = await doc.save(),
    sha = createHash('sha256').update(bytes).digest('hex'),
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    })
  try {
    const pdf = await loading.promise,
      p = await pdf.getPage(1),
      raw = await p.getTextContent(),
      nativeViewport = p.getViewport({ scale: 1 }),
      viewport = p.getViewport({ scale: 1.5 }),
      operators = await p.getOperatorList(),
      canvas = createCanvas(900, 1200),
      render = p.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport,
        recordOperations: true
      })
    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(render, p.recordedBBoxes),
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        raw,
        nativeViewport,
        graphics.graphicsBounds,
        sha,
        p.commonObjs
      ),
      bound = matchNativeFigureRenderContext(
        snapshot,
        1,
        raw,
        nativeViewport,
        graphics.graphicsBounds,
        sha
      ),
      sourceContent = bound.content,
      sourcePage = {
        pageNumber: 1,
        width: 600,
        height: 800,
        rotation: 0,
        renderRotation: 0,
        lines: projectPdfTextLines(raw, nativeViewport),
        ...graphics
      },
      context = {
        sourceContent,
        viewport,
        operators,
        sourcePage,
        nativeGlyphContext: { ...bound, pageNumber: 1, sourceSha256: sha }
      },
      items = sourceContent.items
        .filter((r) => r.str?.trim())
        .map((r) => tableTextToken(r, viewport, 0)),
      rules = collectTableRules(operators, viewport),
      captions = findCaptionCandidates(
        [{ pageNumber: 1, width: 900, height: 1200, lines: projectPdfTextLines(raw, viewport) }],
        new Map([[1, rules]])
      ),
      table = { id: 'page-1-table-1', page: 1, cropRect: [39, 95, 501, 300].map((x) => x * 1.5) }
    await inspect({ table, items, captions, rules, context })
  } finally {
    await loading.destroy()
  }
}

it.each(['', 'blank-stub'])(
  'owns complete six-field native source cycles and all wrapped tails: %s',
  async (fault) => {
    await withFixture(fault, async (f) => {
      const grid = recover(f.table, f.items, f.captions, f.rules, f.context)
      expect(grid?.rows).toHaveLength(5)
      expect(grid.columns).toHaveLength(6)
      expect(grid.completeSpans).toBe(true)
      const expected = f.items.filter((i) => i.baseline > 98 * 1.5 && i.baseline < 293 * 1.5)
      expect([...grid.ownedTokens]).toEqual(expected)
      expect([...grid.ownedTokens].some((i) => i.text === 'External-notice')).toBe(false)
      const labels = expected.filter((i) => /^Record-\d+$/u.test(i.text))
      expect(labels).toHaveLength(4)
      for (const [n, label] of labels.entries()) {
        const row = grid.rows[n + 1],
          owner = expected.filter(
            (i) =>
              i.sourceItem.index >= label.sourceItem.index &&
              i.sourceItem.index < (labels[n + 1]?.sourceItem.index ?? Infinity)
          )
        for (const token of owner) {
          expect(token.rect[1]).toBeGreaterThanOrEqual(row[1])
          expect(token.rect[3]).toBeLessThanOrEqual(row[3])
          const column = grid.columns.findIndex(
            (r) => token.rect[0] >= r[0] && token.rect[2] <= r[2]
          )
          expect(column).toBeGreaterThanOrEqual(0)
          expect(
            token.text === `Record-${n}` ||
              token.text === 'Tail' ||
              token.text === `Value-${column}`
          ).toBe(true)
        }
      }
    })
  }
)
it.each([
  'missing-field',
  'delay',
  'gutter',
  'record-overlap',
  'source-cycle',
  'foreign-ink',
  'missing-rail',
  'white-rail',
  'foreign-paint',
  'source-text',
  'source-rect'
])('declines incomplete native cycle proof: %s', async (fault) => {
  await withFixture(fault, async (f) => {
    if (fault === 'source-text')
      f.items.find((i) => i.text === 'Value-2').sourceItem.text += ' altered'
    if (fault === 'source-rect') f.items.find((i) => i.text === 'Value-2').rect[0] += 0.1
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
  })
})

it('repairs late ownership while retaining the final crop and unrelated diagnostics', async () => {
  await withFixture('blank-stub', async (f) => {
    const plan = recover(f.table, f.items, f.captions, f.rules, f.context),
      text = (fonts) => fonts.map((i) => i.text).join(' '),
      make = (fonts, row, column) => ({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: text(fonts),
        sourceItems: fonts.map((i) => i.sourceItem),
        sourceRects: fonts.map((i) => i.rect),
        sourceTokens: fonts
      }),
      cells = plan.rows.flatMap((r, row) =>
        plan.columns.map((c, column) =>
          make(
            [...plan.ownedTokens].filter(
              (i) =>
                i.rect[0] >= c[0] && i.rect[2] <= c[2] && i.rect[1] >= r[1] && i.rect[3] <= r[3]
            ),
            row,
            column
          )
        )
      ),
      donor = cells.find((c) => c.row === 1 && c.column === 5),
      next = cells.find((c) => c.row === 2 && c.column === 5),
      missing = cells.find((c) => c.row === 2 && c.column === 3),
      missingFonts = [...missing.sourceTokens]
    cells[cells.indexOf(next)] = make(
      [...donor.sourceTokens.slice(1), ...next.sourceTokens],
      next.row,
      next.column
    )
    cells[cells.indexOf(donor)] = make(donor.sourceTokens.slice(0, 1), donor.row, donor.column)
    cells[cells.indexOf(missing)] = make([], missing.row, missing.column)
    const result = {
        ...f.table,
        cropRect: [39, 97.5, 501, 300].map((x) => x * 1.5),
        cells,
        grid: [],
        rows: plan.rows.map((rect, n) => ({
          rect: n === 0 ? [rect[0], rect[1] + 4, rect[2], rect[3]] : [...rect],
          origin: 'model'
        })),
        unassigned: missingFonts.map((i) => i.text),
        clipped: [],
        notes: ['retained-note'],
        excludedCaptionItems: ['retained-caption'],
        issues: ['unassigned-source-text', 'native-table-structure-ambiguous'],
        repairs: [],
        reviewCandidate: false
      },
      fixed = finish(result, f.items, f.captions, f.rules, text, f.context)
    expect(fixed).toBeDefined()
    expect(fixed.cropRect).toBe(result.cropRect)
    expect(Math.min(...fixed.rows.map((r) => r.rect[1]))).toBe(
      Math.min(...result.rows.map((r) => r.rect[1]))
    )
    expect(Math.max(...fixed.rows.map((r) => r.rect[3]))).toBe(
      Math.max(...result.rows.map((r) => r.rect[3]))
    )
    expect(fixed.notes).toBe(result.notes)
    expect(fixed.clipped).toBe(result.clipped)
    expect(fixed.excludedCaptionItems).toBe(result.excludedCaptionItems)
    expect(fixed.issues).toEqual(['native-table-structure-ambiguous'])
    expect(fixed.reviewCandidate).toBe(false)
    expect(fixed.unassigned).toEqual([])
    const blank = fixed.cells.find((cell) => cell.row === 0 && cell.column === 0)
    expect(blank).not.toHaveProperty('sourceItems')
    expect(blank.sourceRects).toEqual([])
    expect(blank.sourceTokens).toEqual([])
    expect(() => recoverOwnedTableCrop(fixed, f.rules, [900, 1200], f.items)).not.toThrow()
    expect(
      fixed.cells.flatMap((c) => c.sourceItems ?? []).sort((a, b) => a.index - b.index)
    ).toEqual([...plan.ownedTokens].map((i) => i.sourceItem))
    for (const cell of fixed.cells) {
      const fonts = [...plan.ownedTokens].filter((i) =>
        (cell.sourceItems ?? []).some((o) => o.index === i.sourceItem.index)
      )
      expect(cell.sourceRects ?? []).toEqual(fonts.map((i) => i.rect))
      expect(cell.text).toBe(text(fonts))
      expect(cell.sourceTokens).toEqual(
        fonts.map(({ text, rect, baseline, height }) => ({ text, rect, baseline, height }))
      )
      for (const token of cell.sourceTokens)
        expect(Object.keys(token).sort()).toEqual(['baseline', 'height', 'rect', 'text'])
    }
    expect(
      finish(
        { ...result, unassigned: [...result.unassigned, 'Unproved'] },
        f.items,
        f.captions,
        f.rules,
        text,
        f.context
      )
    ).toBeUndefined()
    for (const fault of ['segment', 'formatting', 'literal', 'origin', 'rectangle', 'duplicate']) {
      const bad = {
          ...result,
          cells: result.cells.map((cell) => ({
            ...cell,
            sourceItems: cell.sourceItems.map((o) => ({ ...o })),
            sourceRects: cell.sourceRects.map((r) => [...r])
          }))
        },
        cell = bad.cells.find((c) => c.sourceItems.length),
        peer = bad.cells.find((c) => c !== cell && c.sourceItems.length)
      if (fault === 'segment') cell.sourceSegments = [{ ...cell.sourceItems[0], start: 0, end: 1 }]
      if (fault === 'formatting') cell.textRuns = [{ text: cell.text, position: 'normal' }]
      if (fault === 'literal') cell.text += ' changed'
      if (fault === 'origin') cell.sourceItems[0].index = -1
      if (fault === 'rectangle') cell.sourceRects[0][0] += 0.1
      if (fault === 'duplicate') {
        peer.sourceItems.push(cell.sourceItems[0])
        peer.sourceRects.push(cell.sourceRects[0])
        peer.text += ' ' + cell.sourceItems[0].text
      }
      expect(finish(bad, f.items, f.captions, f.rules, text, f.context), fault).toBeUndefined()
    }
  })
})

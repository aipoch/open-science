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
  setFillingRgbColor,
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
const { recoverNativeCitedProseRecordGrid: recover } = await import(
  resource('literature-pdf-native-cited-prose-records')
)
const { tableTextToken } = await import(resource('literature-pdf-orientation'))
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
  for (const [t, x] of [
    ['Reference', 50],
    ['Context', 115],
    ['/', fault === 'header-slash' ? 330 : 210],
    ['Procedure', 230],
    ['Use', 350]
  ] as [string, number][])
    text(t, x, 110)
  if (fault !== 'header-wrap') text('Scope', 115, 120)
  for (let n = 0; n < 4; n++) {
    const y = 143 + n * 40,
      label = String(fault === 'duplicate' && n === 2 ? 5 : n + 4)
    // Brackets and linked digits are separate actual showText operations.
    page.pushOperators(
      beginText(),
      setFontAndSize(key, 10),
      setTextMatrix(1, 0, 0, 1, 50, 800 - y),
      showText(font.encodeText('[')),
      setFillingRgbColor(0, 0, 1),
      showText(font.encodeText(label)),
      setFillingRgbColor(0, 0, 0),
      showText(font.encodeText(']')),
      endText()
    )
    const fields = [
      () => {
        text('Case-type', 115, y + (n === 3 ? (fault === 'delay' ? 15 : 7.5) : 0))
        text('Category', 115, y + (n === 3 ? 17.5 : 10))
      },
      () => text('Compact-model', fault === 'gutter' ? 200 : 230, y),
      () => {
        if (fault === 'field' && n === 2) return
        text('Limited-memory', 350, y)
        text('Fast-inference', 350, y + 10)
      }
    ]
    for (const i of fault === 'source-cycle' && n === 2 ? [1, 0, 2] : [0, 1, 2]) fields[i]()
  }
  text('External-notice', 400, fault === 'foreign-ink' ? 310 : 318.2)
  page.pushOperators(
    setLineWidth(0.5),
    setStrokingRgbColor(...(fault === 'white-rail' ? ([1, 1, 1] as const) : ([0, 0, 0] as const)))
  )
  for (const y of fault === 'missing-rail' ? [98, 129] : [98, 129, 310])
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
      table = { id: 'page-1-table-1', page: 1, cropRect: [39, 95, 501, 317].map((x) => x * 1.5) }
    await inspect({ table, items, captions, rules, context })
  } finally {
    await loading.destroy()
  }
}

it('owns four complete citation-led source cycles with delayed fields and a wrapped slash header', async () => {
  await withFixture('', async (f) => {
    const grid = recover(f.table, f.items, f.captions, f.rules, f.context)
    expect(grid?.rows).toHaveLength(5)
    expect(grid.columns).toHaveLength(4)
    expect(grid.completeSpans).toBe(true)
    const expected = f.items.filter((i) => i.baseline > 98 * 1.5 && i.baseline < 310 * 1.5)
    expect([...grid.ownedTokens]).toEqual(expected)
    expect([...grid.ownedTokens].some((i) => i.text === 'External-notice')).toBe(false)
    const labels = expected.filter((i) => /^\[\d+\]$/u.test(i.text))
    expect(labels).toHaveLength(4)
    for (const [n, label] of labels.entries()) {
      const row = grid.rows[n + 1],
        owner = expected.filter(
          (i) =>
            i.sourceItem.index >= label.sourceItem.index &&
            i.sourceItem.index < (labels[n + 1]?.sourceItem.index ?? Infinity)
        )
      expect(
        owner.every(
          (i) => (i.rect[1] + i.rect[3]) / 2 > row[1] && (i.rect[1] + i.rect[3]) / 2 < row[3]
        )
      ).toBe(true)
      expect(
        new Set(
          owner.map((i) => grid.columns.findIndex((r) => i.rect[0] >= r[0] && i.rect[2] <= r[2]))
        ).size
      ).toBe(4)
    }
  })
})
it.each([
  'header-slash',
  'header-wrap',
  'duplicate',
  'delay',
  'gutter',
  'field',
  'source-cycle',
  'foreign-ink',
  'missing-rail',
  'white-rail',
  'foreign-paint',
  'source-text'
])('declines incomplete native record proof: %s', async (fault) => {
  await withFixture(fault, async (f) => {
    if (fault === 'source-text')
      f.items.find((i) => i.text === 'Case-type').sourceItem.text += ' altered'
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
  })
})

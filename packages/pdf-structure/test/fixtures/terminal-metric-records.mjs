/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'
import {
  collectGraphicsBounds,
  collectTableRules
} from '../../resources/literature-pdf-graphics.mjs'
import {
  recordPaintedOperationBounds,
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext
} from '../../resources/literature-pdf-render-bounds.mjs'
import {
  projectPdfTextLines,
  findCaptionCandidates
} from '../../resources/literature-pdf-caption-group.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

async function capture(stream) {
  const require = createRequire(import.meta.url),
    assets = dirname(require.resolve('pdfjs-dist/package.json')),
    doc = await PDFDocument.create(),
    p = doc.addPage([300, 400]),
    fonts = {},
    keys = {}
  doc.registerFontkit(require('fontkit'))
  for (const [key, file] of Object.entries({
    F: 'LiberationSans-Regular.ttf',
    W: 'LiberationSans-Bold.ttf',
    E: 'LiberationSans-Italic.ttf'
  })) {
    fonts[key] = await doc.embedFont(await readFile(join(assets, 'standard_fonts', file)))
    keys[key] = p.node.newFontDictionary(key, fonts[key].ref)
  }
  const encoded = stream.replace(
    /BT \/([FWE]) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \(([^)]*)\) Tj ET/g,
    (_, key, size, x, y, text) =>
      `BT ${keys[key]} ${size} Tf ${x} ${y} Td ${fonts[key].encodeText(text.replaceAll('\\261', '±'))} Tj ET`
  )
  p.node.addContentStream(doc.context.register(doc.context.flateStream(encoded)))
  const document = await getDocument({
      data: await doc.save(),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise,
    nativePage = await document.getPage(1),
    v = nativePage.getViewport({ scale: 1 }),
    viewport = nativePage.getViewport({ scale: 1.5 }),
    raw = await nativePage.getTextContent(),
    canvas = createCanvas(450, 600),
    render = nativePage.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
      recordOperations: true
    })
  recordPaintedOperationBounds(render)
  await render.promise
  const graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
    sha = 'b'.repeat(64),
    snapshot = captureNativeFigureRenderContext(
      render,
      1,
      raw,
      v,
      graphics.graphicsBounds,
      sha,
      nativePage.commonObjs
    ),
    matched = matchNativeFigureRenderContext(snapshot, 1, raw, v, graphics.graphicsBounds, sha),
    sourceContent = {
      ...raw,
      items: raw.items.map((i, index) => ({
        ...i,
        sourceItem: { pageNumber: 1, index, text: i.str }
      }))
    },
    items = sourceContent.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, viewport, 0)),
    page = {
      pageNumber: 1,
      width: 300,
      height: 400,
      rotation: 0,
      renderRotation: 0,
      lines: projectPdfTextLines(raw, v),
      ...graphics
    },
    rules = collectTableRules(matched.operators, viewport),
    captions = findCaptionCandidates(
      [page],
      new Map([[1, collectTableRules(matched.operators, v)]])
    ).map((c) => ({ ...c, rect: c.rect.map((x) => x * 1.5) })),
    context = {
      sourcePage: page,
      nativeGlyphContext: { ...matched, pageNumber: 1, sourceSha256: sha },
      sourceContent,
      content: sourceContent,
      viewport,
      operators: matched.operators
    }
  return {
    items,
    rules,
    captions,
    context,
    cleanup: async () => {
      canvas.width = canvas.height = 1
      await document.destroy()
    }
  }
}

export async function anonymousTerminalMetricRecords(mode = '') {
  const text = (s, x, y, size = 8, font = 'F') =>
      `BT /${font} ${size} Tf ${x} ${400 - y} Td (${s.replaceAll('±', '\\261')}) Tj ET`,
    stream = [
      '0.5 w',
      ...[105, 138, 174, mode === 'ink-beyond-closing' ? 198.01 : 205].map(
        (y) => `15 ${400 - y} m 295 ${400 - y} l S`
      ),
      ...(mode === 'missing-underline' ? [] : ['80 278 m 290 278 l S']),
      text('Method', 20, 115),
      text('Scores', 160, 115),
      ...[85, 137, 189, 241].map((x, n) => text(`T${n}`, x, 132)),
      ...[150, 164, 184, 198].flatMap((y, row) => [
        text(['Model', 'Alpha', 'Beta', 'Gamma'][row], 20, y),
        ...(row === 0 ? [text('c', 41.776, y + 1.2, 5.6)] : []),
        ...[85, 137, 189, 241].flatMap((x, c) =>
          (mode === 'sparse' && row === 3 && c === 2) || (mode === 'wrapped-label' && row === 3)
            ? []
            : [
                text(`0.${row + c + 1}`, x, y),
                text('±', x + 12, y, 8, 'W'),
                text(
                  '1e-3',
                  x + 17.5,
                  y + (mode === 'metric-script' && row === 3 && c === 1 ? -2 : 0),
                  mode === 'metric-script' && row === 3 && c === 1 ? 5.6 : 8,
                  'E'
                )
              ]
        )
      ]),
      ...(mode === 'foreign-paint' ? ['100 210 10 3 re f'] : []),
      ...(mode === 'foreign-glyph' ? [text('Foreign', 60, 190)] : []),
      text('Table', 20, 223),
      text('1:', 42, 223),
      text('Anonymous', 53, 223),
      text('metrics.', 98, 223)
    ].join('\n'),
    f = await capture(stream),
    scale = 1.5,
    cuts = [15, 77, 129, 181, 233, 295].map((x) => x * scale),
    ys = [100, 125, 138, 157, 174, 210].map((y) => y * scale),
    inside = f.items.filter(
      (i) => i.text !== 'Foreign' && i.baseline > 105 * scale && i.baseline < 205 * scale
    ),
    lane = (i) => cuts.slice(1).findIndex((x, c) => i.rect[0] >= cuts[c] && i.rect[2] <= x),
    recordText = (fonts) =>
      [...fonts]
        .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
        .map((i) => i.text)
        .join(' '),
    cell = (row, column, fonts, rowSpan = 1, colSpan = 1) => ({
      row,
      column,
      rowSpan,
      colSpan,
      text: recordText(fonts),
      rect: [cuts[column], ys[row], cuts[column + colSpan], ys[row + rowSpan]],
      sourceItems: fonts.map((i) => ({ ...i.sourceItem })),
      sourceRects: fonts.map((i) => i.rect),
      sourceTokens: fonts.map(({ text, rect, baseline, height }) => ({
        text,
        rect,
        baseline,
        height
      }))
    }),
    cells = [
      cell(
        0,
        0,
        inside.filter((i) => i.text === 'Method'),
        2
      ),
      cell(
        0,
        1,
        inside.filter((i) => i.text === 'Scores'),
        1,
        4
      ),
      ...[1, 2, 3, 4].map((c) =>
        cell(
          1,
          c,
          inside.filter((i) => lane(i) === c && i.text === `T${c - 1}`)
        )
      ),
      ...[2, 3, 4].flatMap((row) =>
        [0, 1, 2, 3, 4].map((c) =>
          cell(
            row,
            c,
            inside.filter((i) => lane(i) === c && i.baseline > ys[row] && i.baseline <= ys[row + 1])
          )
        )
      )
    ],
    grid = Array.from({ length: 5 }, () => Array(5).fill(''))
  for (const c of cells) grid[c.row][c.column] = c.text
  const script = cells.find((c) => c.row === 2 && c.column === 0)
  script.textRuns = [
    { text: 'Model', position: 'normal' },
    { text: 'c', position: 'subscript' }
  ]
  const result = {
    id: 'page-1-table-1',
    page: 1,
    readingRotation: 0,
    cropRect: [22.5, 150, 442.5, 315],
    grid,
    cells,
    rows: ys
      .slice(1)
      .map((bottom, n) => ({ rect: [cuts[0], ys[n], cuts.at(-1), bottom], origin: 'model' })),
    issues: ['existing-diagnostic'],
    unassigned: [],
    repairs: ['existing-repair'],
    notes: [{ text: 'existing note', rect: [10, 330, 80, 340] }],
    reviewCandidate: false
  }
  return { ...f, result, recordText, inside }
}

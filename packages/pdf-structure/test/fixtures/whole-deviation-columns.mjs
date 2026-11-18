/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  PDFDocument,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  setStrokingRgbColor,
  setLineWidth,
  setDashPattern,
  moveTo,
  lineTo,
  stroke
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'
const req = createRequire(import.meta.url),
  asset = dirname(req.resolve('pdfjs-dist/package.json'))
export async function wholeDeviationColumnsFixture(mode = 'base') {
  const document = await PDFDocument.create({ updateMetadata: false }),
    regular = await document.embedFont(StandardFonts.Helvetica),
    bold = await document.embedFont(StandardFonts.HelveticaBold),
    page = document.addPage([500, 130]),
    scale = 1.5,
    heights = [80, 90, 100],
    cuts = [0, 50, 100, 150, 200, 250, 275, 305, 340, 375, 415, 470]
  const text = (value, x, baseline, alternate = false) =>
    page.drawText(value, { x, y: 130 - baseline, size: 8, font: alternate ? bold : regular })
  text('Table 1. Summary', 5, 13)
  for (let c = 0; c < 4; c++)
    text(
      mode === 'independent-sd-heading' && c === 1 ? 'SD' : String.fromCharCode(65 + c),
      280 + c * 55,
      50,
      c % 2 === 1
    )
  for (const y of heights) {
    text('Record', 5, y)
    for (let c = 0; c < 4; c++) text('0.20', 55 + c * 50, y, c % 2 === 1)
    for (let c = 0; c < 4; c++) text('1.20 ± 0.03', 255 + c * 55, y, c % 2 === 1)
  }
  if (mode === 'foreign-native-omission') text('Z', 303, 90)
  for (const y of [
    62,
    108,
    ...(mode === 'equivalent-double-closing' ? [107.5] : []),
    ...(mode === 'competing-closings' ? [104.3] : [])
  ])
    page.pushOperators(
      pushGraphicsState(),
      setStrokingRgbColor(0, 0, 0),
      setLineWidth(0.25),
      setDashPattern([], 0),
      moveTo(0, 130 - y),
      lineTo(470, 130 - y),
      stroke(),
      popGraphicsState()
    )
  const bytes = await document.save({ useObjectStreams: false }),
    task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      fontExtraProperties: true,
      useSystemFonts: false,
      verbosity: 0,
      standardFontDataUrl: asset + '/standard_fonts/',
      cMapUrl: asset + '/cmaps/',
      wasmUrl: asset + '/wasm/',
      cMapPacked: true
    }),
    pdf = await task.promise,
    p = await pdf.getPage(1),
    viewport = p.getViewport({ scale }),
    raw = await p.getTextContent(),
    sourceContent = {
      ...raw,
      items: raw.items.map((i, index) =>
        'str' in i ? { ...i, sourceItem: { pageNumber: 1, index, text: i.str } } : i
      )
    },
    all = sourceContent.items
      .filter((i) => i.str?.trim())
      .map((i) => tableTextToken(i, viewport, 0)),
    tokens = mode === 'foreign-native-omission' ? all.filter((i) => i.text !== 'Z') : all,
    rules = collectTableRules(await p.getOperatorList(), viewport),
    relative = (r) => r.map((v) => v * scale),
    table = {
      id: 'anonymous-whole-deviation',
      readingRotation: 0,
      cropRect: relative([0, 20, 470, 110]),
      structure: {
        objects: [
          { label: 'table column header', score: 1, rect: relative([0, 20, 470, 40]) },
          { label: 'table row', score: 1, rect: relative([0, 20, 470, 40]) },
          ...heights.map((y) => ({
            label: 'table row',
            score: 1,
            rect: relative([0, y - 29, 470, y - 16])
          })),
          ...cuts.slice(0, -1).map((x, n) => ({
            label: 'table column',
            score: 1,
            rect: relative([x, 0, cuts[n + 1], 90])
          }))
        ]
      }
    },
    captions = [{ page: 1, lines: ['Table 1. Summary'], rect: relative([5, 5, 70, 13]) }],
    context = { sourceContent, viewport }
  return { table, tokens, captions, rules, context, bytes, dispose: () => task.destroy() }
}

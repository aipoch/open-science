/* eslint-disable @typescript-eslint/explicit-function-return-type -- infer synthetic native proof fixtures */
import { expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
// @ts-expect-error Worker-private JavaScript is exercised through its native runtime.
import * as pdfium from '../../../../resources/pdf-translation/pdfium.mjs'
const { engine } = pdfium
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import {
  matchingOverprintFormObjects,
  translateFormLabels
  // @ts-expect-error Worker-private JavaScript has no renderer/main public declarations.
} from '../../../../resources/pdf-translation/form-labels.mjs'

const rectangle = (left = 0, bottom = 0, right = 200, top = 200) => [
  [2, false, left, bottom],
  [0, false, left, top],
  [0, false, right, top],
  [0, false, right, bottom],
  [0, true, left, bottom]
]
const child = (text: string, y: number) => ({
  type: 1,
  bounds: [20, y, 46, y + 10],
  text,
  identity: {
    matrix: [1, 0, 0, 1, 20, y],
    active: 1,
    fill: [0, 0, 0, 255],
    stroke: [0, 0, 0, 255],
    clipping: [rectangle()],
    font: 'SyntheticMathFont',
    size: 12,
    mode: 0,
    paint: [52, 20, 208, 4, 'native-glyph-paint']
  }
})
const pair = () => {
  const before = [child('Tok 1', 80), child('', 80.8), child('Question', 120)]
  const after = structuredClone(before)
  after[0].text = ''
  after[1].text = 'Tok 1'
  for (const item of after) item.identity.clipping = []
  return { before, after }
}
const matches = ({ before, after }: ReturnType<typeof pair>) =>
  matchingOverprintFormObjects(before, after, [0, 0, 200, 200])

it('matches only ordered native paint-identical overprint text assignment changes', () => {
  expect(matches(pair())).toBe(true)
})
it.each(['word', 'font', 'matrix', 'bounds', 'paint', 'other-child', 'duplicate', 'missing-proof'])(
  'rejects changed or ambiguous Form identity: %s',
  (kind) => {
    const value = pair()
    if (kind === 'word') value.after[1].text = 'Tok 2'
    if (kind === 'font') value.after[0].identity.font = 'OtherFont'
    if (kind === 'matrix') value.after[0].identity.matrix[4] += 0.001
    if (kind === 'bounds') value.after[0].bounds[2] += 0.001
    if (kind === 'paint') value.after[0].identity.paint[4] = 'changed-glyph-paint'
    if (kind === 'other-child') value.after[2].text = 'Answer'
    if (kind === 'duplicate') {
      value.before.push(child('', 80.6))
      value.after.push(child('Tok 1', 80.6))
    }
    if (kind === 'missing-proof') Object.assign(value.after[0], { identity: undefined })
    expect(matches(value)).toBe(false)
  }
)
it.each(['cut-edge', 'triangle', 'compound', 'curve', 'unclosed', 'backtrack', 'nonfinite'])(
  'does not discard effective or unproven native clips: %s',
  (kind) => {
    const value = pair(),
      clip = rectangle()
    if (kind === 'cut-edge') clip[2][2] = 199.999999
    if (kind === 'triangle') clip[1][2] = 20
    if (kind === 'compound') clip.splice(2, 0, [2, false, 40, 40])
    if (kind === 'curve') clip[1][0] = 1
    if (kind === 'unclosed') clip[4][1] = false
    if (kind === 'backtrack') clip[2] = [...clip[0]]
    if (kind === 'nonfinite') clip[1][2] = Number.NaN
    value.before[0].identity.clipping = [clip]
    expect(matches(value)).toBe(false)
  }
)

it('matches an unchanged axis-aligned image with a redundant full-paint clip', () => {
  const value = pair(),
    image = {
      type: 3,
      bounds: [30, 40, 80, 90],
      text: '',
      identity: {
        matrix: [50, 0, 0, 50, 30, 40],
        active: 1,
        clipping: [rectangle(30, 40, 80, 90)],
        paint: [100, 100, 400, 4, 'native-image-paint'],
        paintBounds: [30, 40, 80, 90]
      }
    }
  Object.assign(value, {
    before: [...value.before, image],
    after: [
      ...value.after,
      { ...structuredClone(image), identity: { ...image.identity, clipping: [] } }
    ]
  })
  expect(matches(value)).toBe(true)
})
it.each([
  'crop',
  'shear',
  'rotation',
  'paint',
  'bounds',
  'nonrectangle',
  'compound',
  'negative-scale'
])('rejects an unproven image clip identity: %s', (kind) => {
  const value = pair(),
    image = {
      type: 3,
      bounds: [30, 40, 80, 90],
      text: '',
      identity: {
        matrix: [50, 0, 0, 50, 30, 40],
        active: 1,
        clipping: [rectangle(30, 40, 80, 90)],
        paint: [100, 100, 400, 4, 'native-image-paint'],
        paintBounds: [30, 40, 80, 90]
      }
    },
    other = structuredClone(image)
  other.identity.clipping = []
  if (kind === 'crop') image.identity.clipping = [rectangle(30, 40, 79.5, 90)]
  if (kind === 'shear') image.identity.matrix[1] = other.identity.matrix[1] = 0.01
  if (kind === 'rotation') image.identity.matrix[2] = other.identity.matrix[2] = 0.01
  if (kind === 'paint') other.identity.paint[4] = 'changed-image-paint'
  if (kind === 'bounds') image.identity.paintBounds[2] = other.identity.paintBounds[2] = 80.01
  if (kind === 'nonrectangle') image.identity.clipping[0][1][2] = 31
  if (kind === 'compound') image.identity.clipping[0].splice(2, 0, [2, false, 40, 40])
  if (kind === 'negative-scale') image.identity.matrix[0] = other.identity.matrix[0] = -50
  Object.assign(value, { before: [...value.before, image], after: [...value.after, other] })
  expect(matches(value)).toBe(false)
})

it('retains a complete single native diagram tag instead of an expanded model label', async () => {
  const panel = await PDFDocument.create(),
    local = panel.addPage([200, 200]),
    font = await panel.embedFont(StandardFonts.Helvetica)
  local.drawText('O', { x: 20, y: 50, size: 12, font })
  local.drawText('Classification label', { x: 20, y: 100, size: 12, font })
  const document = await PDFDocument.create(),
    embedded = await document.embedPage(local)
  document.addPage([600, 800]).drawPage(embedded, { x: 100, y: 300 })
  const data = await document.save(),
    task = getDocument({ data: data.slice(), useSystemFonts: true })
  try {
    const pdf = await task.promise,
      { source } = await extractPdfTranslationSource({
        document: pdf,
        resourceRequestKey: 'literal-diagram-tag',
        signal: new AbortController().signal
      }),
      unit = source.units.find((u) => u.source === 'O')!
    expect(unit).toBeDefined()
    let attempted = false
    const output = await translateFormLabels(
      data,
      [{ ...unit, translation: '其他' }],
      source.pages,
      () => {
        attempted = true
        throw Error('A single native tag must stay literal')
      }
    )
    expect(attempted).toBe(false)
    expect(Buffer.compare(Buffer.from(output), Buffer.from(data))).toBe(0)
  } finally {
    await task.destroy()
  }
})

it.each([
  'literal',
  'changed-variable',
  'changed-number',
  'changed-prime',
  'ordinary-word',
  'flat'
])('retains only geometry-proven unchanged variable sequences: %s', async (kind) => {
  const panel = await PDFDocument.create(),
    local = panel.addPage([200, 200]),
    font = await panel.embedFont(StandardFonts.Helvetica)
  if (kind === 'ordinary-word')
    local.drawText('Measured response', { x: 20, y: 50, size: 12, font })
  else {
    local.drawText('E', { x: 20, y: 50, size: 12, font })
    local.drawText('1', {
      x: 28,
      y: kind === 'flat' ? 50 : 47,
      size: kind === 'flat' ? 12 : 8,
      font
    })
    local.drawText('...', { x: 42, y: 50, size: 12, font })
    local.drawText('E', { x: 62, y: 50, size: 12, font })
    local.drawText('M', {
      x: 70,
      y: kind === 'flat' ? 50 : 47,
      size: kind === 'flat' ? 12 : 8,
      font
    })
  }
  const document = await PDFDocument.create(),
    embedded = await document.embedPage(local)
  document.addPage([600, 800]).drawPage(embedded, { x: 100, y: 300 })
  const data = await document.save(),
    task = getDocument({ data: data.slice(), useSystemFonts: true })
  try {
    const pdf = await task.promise,
      { source } = await extractPdfTranslationSource({
        document: pdf,
        resourceRequestKey: 'native-variable-sequence',
        signal: new AbortController().signal
      }),
      unit =
        kind === 'ordinary-word'
          ? source.units.find((u) => u.source === 'Measured response')!
          : {
              ...source.units[0],
              source: 'E1 ... EM',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 118 / 600, y: (800 - 365) / 800, width: 67 / 600, height: 24 / 800 },
                  items: source.units.flatMap((u) => u.fragments.flatMap((f) => f.items ?? []))
                }
              ]
            }
    expect(unit).toBeDefined()
    let attempted = false
    const translation =
      kind === 'ordinary-word'
        ? unit.source
        : kind === 'changed-variable'
          ? unit.source.replace('M', 'N')
          : kind === 'changed-number'
            ? unit.source.replace('1', '2')
            : kind === 'changed-prime'
              ? unit.source + "'"
              : unit.source.replace('...', '…')
    await translateFormLabels(
      data,
      [{ ...unit, translation }],
      source.pages,
      async (localRequest: { data: Uint8Array }) => {
        attempted = true
        return localRequest.data
      }
    )
    expect(attempted).toBe(kind !== 'literal' && kind !== 'ordinary-word')
  } finally {
    await task.destroy()
  }
})

it('reads native path dash-array and phase without losing an explicit stroke pattern', async () => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([200, 200])
  page.drawLine({
    start: { x: 20, y: 80 },
    end: { x: 180, y: 80 },
    thickness: 2,
    dashArray: [3, 2],
    dashPhase: 1
  })
  const e = await engine(),
    input = e.open(await pdf.save()),
    native = e.p.FPDF_LoadPage(input.doc, 0),
    at = e.alloc(16)
  try {
    const path = e.objects(native).find((o: { type: number; obj: number }) => o.type === 2)!
    expect(path).toBeDefined()
    expect(e.p.FPDFPageObj_GetDashCount(path.obj)).toBe(2)
    expect(e.p.FPDFPageObj_GetDashArray(path.obj, at, 2)).toBe(true)
    expect([...e.m.HEAPF32.slice(at / 4, at / 4 + 2)]).toEqual([3, 2])
    expect(e.p.FPDFPageObj_GetDashPhase(path.obj, at)).toBe(true)
    expect(e.m.HEAPF32[at / 4]).toBe(1)
  } finally {
    e.free(at)
    e.p.FPDF_ClosePage(native)
    input.close()
  }
})
it.each(['dash', 'phase'])('rejects a changed native path stroke pattern: %s', (kind) => {
  const value = pair(),
    path = {
      type: 2,
      bounds: [0, 0, 200, 200],
      text: '',
      identity: {
        matrix: [1, 0, 0, 1, 0, 0],
        active: 1,
        clipping: [],
        dash: [3, 2],
        dashPhase: 1,
        parts: rectangle(),
        width: 2,
        cap: 0,
        join: 0,
        mode: [0, 1]
      }
    },
    changed = structuredClone(path)
  if (kind === 'dash') changed.identity.dash[0] = 4
  else changed.identity.dashPhase = 2
  Object.assign(value, { before: [...value.before, path], after: [...value.after, changed] })
  expect(matches(value)).toBe(false)
})

it.each([
  'readable',
  'missing-dash-count',
  'missing-dash-phase',
  'missing-dash-array',
  'missing-clip-count',
  'negative-clip-count',
  'unknown-clip-count',
  'active-fill-color',
  'active-stroke-color',
  'disabled-fill-color',
  'disabled-stroke-color',
  'exact-key-missing-dash'
])('fails closed only for unproven native Form fallback: %s', async (kind) => {
  const panel = await PDFDocument.create(),
    local = panel.addPage([200, 200]),
    font = await panel.embedFont(StandardFonts.Helvetica)
  local.drawText('Tok 1', { x: 20, y: 80, size: 12, font })
  local.drawText('Tok 1', { x: 20, y: 80.8, size: 12, font })
  local.drawText('Question', { x: 20, y: 120, size: 12, font })
  local.drawRectangle({
    x: 10,
    y: 10,
    width: 180,
    height: 180,
    ...(kind === 'disabled-fill-color' ? { color: undefined } : { color: rgb(1, 1, 1) }),
    ...(kind === 'disabled-stroke-color'
      ? { borderWidth: 0 }
      : { borderColor: rgb(0, 0, 0), borderWidth: 1 })
  })
  const document = await PDFDocument.create(),
    embedded = await document.embedPage(local)
  document.addPage([600, 800]).drawPage(embedded, { x: 100, y: 300 })
  const data = await document.save(),
    task = getDocument({ data: data.slice(), useSystemFonts: true, isEvalSupported: false })
  let spy: ReturnType<typeof vi.spyOn> | undefined
  try {
    const pdf = await task.promise,
      { source } = await extractPdfTranslationSource({
        document: pdf,
        resourceRequestKey: 'native-proof-getter-failure',
        signal: new AbortController().signal
      }),
      unit = source.units.find((u) => u.source === 'Question')!,
      e = await engine(),
      p = e.p,
      loadText = p.FPDFText_LoadPage,
      getText = p.FPDFTextObj_GetText,
      countPaths = p.FPDFClipPath_CountPaths,
      pageWidths = new Map<number, number>()
    let borrowedEmpty = false
    p.FPDFClipPath_CountPaths = (clip: number) => {
      const count = countPaths(clip)
      borrowedEmpty ||= clip !== 0 && count === -1
      return count
    }
    expect(unit).toBeDefined()
    p.FPDFText_LoadPage = (page: number) => {
      const text = loadText(page)
      pageWidths.set(text, p.FPDF_GetPageWidth(page))
      return text
    }
    // Model the proven PDFium text-page ownership permutation. Each object's
    // native glyph paint, matrix, font and ordered position remains untouched.
    p.FPDFTextObj_GetText = (obj: number, text: number, at: number, size: number) => {
      const matrix = e.alloc(24)
      try {
        p.FPDFPageObj_GetMatrix(obj, matrix)
        const y = e.m.HEAPF32[matrix / 4 + 5],
          original = pageWidths.get(text) === 600,
          suppress = original ? y > 80.5 && y < 81 : y === 80
        if (kind !== 'exact-key-missing-dash' && (y === 80 || (y > 80.5 && y < 81))) {
          const bytes = Buffer.from((suppress ? '' : 'Tok 1') + '\0', 'utf16le')
          if (at && size >= bytes.length) e.m.HEAPU8.set(bytes, at)
          return bytes.length
        }
        return getText(obj, text, at, size)
      } finally {
        e.free(matrix)
      }
    }
    if (kind === 'missing-dash-count' || kind === 'exact-key-missing-dash')
      p.FPDFPageObj_GetDashCount = undefined
    if (kind === 'missing-dash-phase') p.FPDFPageObj_GetDashPhase = undefined
    if (kind === 'missing-dash-array') p.FPDFPageObj_GetDashArray = undefined
    if (kind === 'missing-clip-count') p.FPDFClipPath_CountPaths = undefined
    if (kind === 'negative-clip-count') p.FPDFClipPath_CountPaths = () => -2
    if (kind === 'unknown-clip-count') p.FPDFClipPath_CountPaths = () => Number.NaN
    if (kind === 'active-fill-color' || kind === 'disabled-fill-color')
      p.FPDFPageObj_GetFillColor = () => false
    if (kind === 'active-stroke-color' || kind === 'disabled-stroke-color')
      p.FPDFPageObj_GetStrokeColor = () => false
    spy = vi.spyOn(pdfium, 'engine').mockResolvedValueOnce(e)
    let attempted = false
    await translateFormLabels(
      data,
      [{ ...unit, translation: '问题' }],
      source.pages,
      async (request: { data: Uint8Array }) => {
        attempted = true
        return request.data
      }
    )
    if (kind === 'readable') expect(borrowedEmpty).toBe(true)
    expect(attempted).toBe(
      [
        'readable',
        'disabled-fill-color',
        'disabled-stroke-color',
        'exact-key-missing-dash'
      ].includes(kind)
    )
  } finally {
    spy?.mockRestore()
    await task.destroy()
  }
})

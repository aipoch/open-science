import {
  PDFDocument,
  PDFDict,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
  concatTransformationMatrix
} from 'pdf-lib'
import { expect, it } from 'vitest'
import { engine } from '../resources/pdfium.mjs'
import { readNativeReflowRetention } from '../resources/reflow-native-retention.mjs'

type Unit = {
  source: string
  translation: string
  kind: string
  fragments: Array<{
    pageNumber: number
    rect: { x: number; y: number; width: number; height: number }
    items: Array<{ index: number; text: string }>
  }>
}

async function inspect(
  options: {
    font?: StandardFonts
    renamedFont?: string
    small?: number
    rise?: number
    gap?: number
    visual?: boolean
    paint?: boolean
    mutation?: boolean
    rotated?: boolean
    identity?: boolean
    crossColumn?: boolean
    clipped?: boolean
    sourceMutation?: boolean
    form?: boolean
    foreignForm?: boolean
    duplicateOwner?: boolean
    duplicateFragment?: boolean
    foreignText?: boolean
    invalidBounds?: boolean
    stretched?: boolean
    invalidGeometry?: boolean
    separateOwners?: boolean
    visualFirst?: boolean
  } = {}
): Promise<{ units: Set<number>; pages: Set<number> }> {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(options.font ?? StandardFonts.TimesRomanItalic)
  const page = pdf.addPage([400, 500]),
    base = options.font === StandardFonts.Symbol ? 'η' : 'L',
    script = options.font === StandardFonts.Symbol ? 'μ' : 'ab',
    baseWidth = font.widthOfTextAtSize(base, 12),
    x = options.crossColumn ? 250 : 40 + baseWidth + (options.gap ?? 0.5)
  if (options.stretched)
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0.98, 0, 0, 1, 0, 0))
  if (options.clipped)
    page.pushOperators(pushGraphicsState(), rectangle(40, 398, baseWidth / 2, 5), clip(), endPath())
  page.drawText(base, { font, x: 40, y: 400, size: 12 })
  page.drawText(script, {
    font,
    x,
    y: 400 + (options.rise ?? -2),
    size: options.small ?? 8,
    rotate: degrees(options.rotated ? 30 : 0)
  })
  if (options.clipped) page.pushOperators(popGraphicsState())
  if (options.stretched) page.pushOperators(popGraphicsState())
  if (options.visual)
    page.drawText('=', { font, x: x + font.widthOfTextAtSize(script, 8) + 2, y: 400, size: 12 })
  if (options.foreignText) page.drawText('Q', { font, x: 42, y: 400, size: 12 })
  if (options.paint) page.drawRectangle({ x: 40, y: 398, width: 5, height: 2, color: rgb(0, 0, 0) })
  if (options.foreignForm) {
    const graphic = await PDFDocument.create()
    graphic.addPage([8, 8]).drawRectangle({ x: 0, y: 0, width: 8, height: 8 })
    const [embedded] = await pdf.embedPdf(await graphic.save())
    page.drawPage(embedded, { x: 40, y: 398 })
  }
  let data = await pdf.save()
  if (options.renamedFont) {
    const renamed = await PDFDocument.load(data)
    renamed.context
      .lookup(font.ref, PDFDict)
      .set(PDFName.of('BaseFont'), PDFName.of(options.renamedFont))
    data = await renamed.save()
  }
  if (options.form) {
    const wrapped = await PDFDocument.create(),
      [embedded] = await wrapped.embedPdf(data)
    wrapped.addPage([400, 500]).drawPage(embedded)
    data = await wrapped.save()
  }
  const n = await engine(),
    source = n.open(data),
    nativePage = n.p.FPDF_LoadPage(source.doc, 0)
  try {
    if (options.form)
      return readNativeReflowRetention(
        n,
        source,
        {
          units: [
            {
              source: 'Lab',
              translation: 'Localized.',
              kind: 'text',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 0.09, y: 0.17, width: 0.1, height: 0.05 },
                  items: [{ index: 0, text: 'Lab' }]
                }
              ]
            }
          ]
        },
        [{ left: 0, top: 500, width: options.invalidGeometry ? NaN : 400, height: 500 }]
      )
    const objects = n.objects(nativePage).filter((o) => o.type === 1),
      selected = objects.slice(0, 2),
      rect = (rows: typeof objects): Unit['fragments'][number]['rect'] => {
        const left = Math.min(...rows.map((o) => o.bounds[0])) - 0.01,
          bottom = Math.min(...rows.map((o) => o.bounds[1])) - 0.01,
          right = Math.max(...rows.map((o) => o.bounds[2])) + 0.01,
          top = Math.max(...rows.map((o) => o.bounds[3])) + 0.01
        return {
          x: left / 400,
          y: (500 - top) / 500,
          width: (right - left) / 400,
          height: (top - bottom) / 500
        }
      },
      words = selected.map((o) => o.text).join(''),
      units: Unit[] = [
        {
          source: words,
          translation: options.identity ? words : 'Localized.',
          kind: 'text',
          fragments: [
            {
              pageNumber: 1,
              rect: rect(selected),
              items: selected.map((o, index) => ({ index, text: o.text }))
            }
          ]
        }
      ]
    if (options.visual)
      units.push({
        source: '=',
        translation: '=',
        kind: 'visual',
        fragments: [
          {
            pageNumber: 1,
            rect: rect(objects.slice(2)),
            items: [{ index: 2, text: '=' }]
          }
        ]
      })
    if (options.visualFirst) units.reverse()
    if (options.separateOwners) {
      units.splice(
        0,
        1,
        ...selected.map((o, index) => ({
          source: o.text,
          translation: 'Localized.',
          kind: 'text',
          fragments: [{ pageNumber: 1, rect: rect([o]), items: [{ index, text: o.text }] }]
        }))
      )
    }
    if (options.mutation) units[0].fragments[0].items[1].text = 'foreign'
    if (options.duplicateOwner) units.push(structuredClone(units[0]))
    if (options.duplicateFragment) {
      units[0].fragments.push(structuredClone(units[0].fragments[0]))
      units[0].source += words
    }
    if (options.sourceMutation) units[0].source = 'Foreign.'
    if (options.invalidBounds) {
      const objects = n.objects.bind(n)
      n.objects = (page): ReturnType<typeof objects> => [
        ...objects(page),
        { i: 999, obj: 0, type: 2, bounds: [NaN, 0, 1, 2] }
      ]
    }
    const before = JSON.stringify(units),
      result = readNativeReflowRetention(n, source, { units }, [
        { left: 0, top: 500, width: options.invalidGeometry ? NaN : 400, height: 500 }
      ])
    expect(JSON.stringify(units)).toBe(before)
    return result
  } finally {
    n.p.FPDF_ClosePage(nativePage)
    source.close()
  }
}

it('retains a whole native italic body and lowered suffix without changing its accepted target', async () => {
  expect(await inspect()).toEqual({ units: new Set([0]), pages: new Set() })
})
it('allows ordinary horizontally fitted native prose', async () => {
  expect(await inspect({ stretched: true, small: 12, rise: 0 })).toEqual({
    units: new Set(),
    pages: new Set()
  })
})
it('retains native Greek raised hierarchy', async () => {
  expect(await inspect({ font: StandardFonts.Symbol, rise: 4 })).toEqual({
    units: new Set([0]),
    pages: new Set()
  })
})
it('keeps an unchanged equation prefix with its adjacent visual scaffold on the source page', async () => {
  expect(await inspect({ identity: true, visual: true })).toEqual({
    units: new Set(),
    pages: new Set([1])
  })
})
it('retains an equation scaffold regardless of source owner row order', async () => {
  expect(await inspect({ identity: true, visual: true, visualFirst: true })).toEqual({
    units: new Set(),
    pages: new Set([1])
  })
})
it('does not treat separate native cell owners as one script token', async () => {
  expect(await inspect({ separateOwners: true })).toEqual({ units: new Set(), pages: new Set() })
})
it.each([
  { small: 12, rise: 0 },
  { small: 8, rise: 0 },
  { crossColumn: true },
  { font: StandardFonts.TimesRoman },
  { renamedFont: 'CMR10', small: 12, rise: 0 },
  { renamedFont: 'CMTI10', small: 12, rise: 0 }
])('allows ordinary prose or nonattached native runs: %j', async (options) => {
  const adjusted =
    options.font === StandardFonts.TimesRoman ? { ...options, small: 12, rise: 0 } : options
  expect(await inspect(adjusted)).toEqual({ units: new Set(), pages: new Set() })
})
it.each([
  { mutation: true },
  { sourceMutation: true },
  { paint: true },
  { clipped: true },
  { foreignForm: true },
  { duplicateOwner: true },
  { duplicateFragment: true },
  { foreignText: true },
  { invalidBounds: true },
  { invalidGeometry: true }
])('promotes unclosed native ownership to source-page retention: %j', async (options) => {
  expect(await inspect(options)).toEqual({ units: new Set(), pages: new Set([1]) })
})
it('supplies no new certificate for hierarchy hidden inside an opaque Form', async () => {
  expect(await inspect({ form: true })).toEqual({ units: new Set(), pages: new Set() })
})
it('retains the source page instead of guessing rotated script attachment', async () => {
  expect(await inspect({ rotated: true })).toEqual({ units: new Set(), pages: new Set([1]) })
})
it.each(['CMSY10', 'CMMIB10', 'MSBM10'])(
  'retains existing known native math alphabet %s',
  async (renamedFont) => {
    expect(await inspect({ renamedFont, small: 12, rise: 0 })).toEqual({
      units: new Set([0]),
      pages: new Set()
    })
  }
)

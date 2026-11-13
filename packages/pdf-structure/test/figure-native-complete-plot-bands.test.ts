import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

// Two closed Forms have leading native panel markers; the first contains two
// raster rows. The Type3 d1 clip is deliberately wider than its actual ink.
async function withLeadingType3Forms(
  inspect: (fixture: ReturnType<typeof JSON.parse>) => Promise<void>,
  separateDocument = false,
  ligature = false,
  singleForm: '' | 'complete' | 'foreign-paint' | 'foreign-text' | 'second-form' = '',
  captionScript: '' | 'raised' | 'baseline' | 'detached' = '',
  curvedGlyph = false
): Promise<void> {
  const objects: string[] = [],
    add = (s: string): number => objects.push(s),
    stream = (s: string, dict = ''): number =>
      add(`<< ${dict} /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    catalog = add(''),
    pages = add(''),
    ordinary = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
    ),
    charproc = stream(
      curvedGlyph
        ? '600 0 0 0 600 800 d1 50 50 m 50 650 450 650 450 50 c 50 50 l h f'
        : '600 0 0 0 600 800 d1 50 50 450 650 re f'
    ),
    unicode = stream(
      `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Anonymous def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <4B> <${ligature ? '00660069' : '004B'}> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`
    ),
    typed = add(
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 800] /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /K ${charproc} 0 R >> /Encoding << /Type /Encoding /Differences [75 /K] >> /FirstChar 75 /LastChar 75 /Widths [600] /Resources << >> /ToUnicode ${unicode} 0 R >>`
    ),
    images = [
      'ff000000ff000000ffffffff>',
      '00ff000000ffffffffff0000>',
      '0000ffffffff00ff0000ff00>',
      'ffffff0000ffff000000ff00>'
    ].map((pixels) =>
      stream(
        pixels,
        '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode'
      )
    ),
    left = stream(
      `q 45 0 0 35 60 250 cm /I0 Do Q q 45 0 0 35 120 250 cm /I1 Do Q q 45 0 0 35 60 190 cm /I2 Do Q q 45 0 0 35 120 190 cm /I3 Do Q BT /K 10 Tf 1 0 0 1 65 290 Tm (K) Tj 1 0 0 1 130 ${singleForm ? 187 : 230} Tm (K) Tj ET`,
      `/Type /XObject /Subtype /Form /BBox [55 185 175 305] /Resources << /Font << /K ${typed} 0 R >> /XObject << ${images.map((id, i) => `/I${i} ${id} 0 R`).join(' ')} >> >>`
    ),
    right = stream(
      '1 w 230 190 100 100 re S 230 240 m 330 240 l S BT /K 10 Tf 1 0 0 1 240 295 Tm (K) Tj ET',
      `/Type /XObject /Subtype /Form /BBox [225 185 340 310] /Resources << /Font << /K ${typed} 0 R >> >>`
    ),
    footer = stream(
      '20 30 10 10 re f',
      '/Type /XObject /Subtype /Form /BBox [20 30 30 40] /Resources << >>'
    ),
    plateCaption = captionScript
      ? `BT /T 10 Tf 1 0 0 1 50 160 Tm (Figure 1: 4) Tj /T 6 Tf 1 0 0 1 ${captionScript === 'detached' ? 110 : 97.8} ${captionScript === 'baseline' ? 160 : 163} Tm (2) Tj /T 10 Tf 1 0 0 1 ${captionScript === 'detached' ? 120 : 101.136} 160 Tm ( plate.) Tj ET`
      : 'BT /T 10 Tf 1 0 0 1 50 160 Tm (Figure 1: Native plate.) Tj ET',
    body = stream(
      singleForm
        ? `BT /T 10 Tf 1 0 0 1 55 350 Tm (Running header.) Tj ET q /A Do Q ${singleForm === 'foreign-paint' ? '70 220 10 10 re f' : singleForm === 'foreign-text' ? 'BT /T 10 Tf 1 0 0 1 70 220 Tm (Foreign.) Tj ET' : singleForm === 'second-form' ? 'q /B Do Q' : ''} ${plateCaption} q /C Do Q`
        : 'BT /T 10 Tf 1 0 0 1 55 350 Tm (Running header.) Tj 1 0 0 1 50 310 Tm (a) Tj ET q /A Do Q BT /T 10 Tf 1 0 0 1 220 310 Tm (b) Tj ET q /B Do Q BT /T 10 Tf 1 0 0 1 50 160 Tm (Figure 1: Two native panels.) Tj ET q /C Do Q'
    ),
    pageId = add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 400 400] /Resources << /Font << /T ${ordinary} 0 R >> /XObject << /A ${left} 0 R /B ${right} 0 R /C ${footer} 0 R >> >> /Contents ${body} 0 R >>`
    )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    sourceSha256 = createHash('sha256').update(bytes).digest('hex'),
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
      standardFontDataUrl
    }),
    {
      recordPaintedOperationBounds,
      captureNativeFigureRenderContext,
      matchNativeFigureRenderContext
    } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href),
    { collectGraphicsBounds } = await import(
      pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
    ),
    { tableTextToken } = await import(
      pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
    ),
    { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
    )
  const canvas = createCanvas(600, 600)
  let auxiliary: ReturnType<typeof getDocument> | undefined
  try {
    const document = await loading.promise,
      nativePage = await document.getPage(1),
      content = await nativePage.getTextContent(),
      operators = await nativePage.getOperatorList(),
      viewport = nativePage.getViewport({ scale: 1 }),
      render = nativePage.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport: nativePage.getViewport({ scale: 1.5 }),
        recordOperations: true
      })
    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(
        render,
        (nativePage as ReturnType<typeof JSON.parse>).recordedBBoxes
      ),
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        sourceSha256,
        nativePage.commonObjs
      ),
      context = {
        ...matchNativeFigureRenderContext(
          snapshot,
          1,
          content,
          viewport,
          graphics.graphicsBounds,
          sourceSha256
        ),
        pageNumber: 1,
        sourceSha256
      },
      tokens = context.content.items
        .filter((r: { str: string }) => r.str?.trim())
        .map((r: unknown) => tableTextToken(r, viewport, 0)),
      cap = tokens.find((t: { text: string }) => t.text.startsWith('Figure 1:')),
      captionParts = captionScript
        ? tokens.filter((t: ReturnType<typeof JSON.parse>) => t.rect[1] >= 225 && t.rect[3] <= 241)
        : [cap],
      caption = {
        page: 1,
        rect: [
          Math.min(...captionParts.map((t: ReturnType<typeof JSON.parse>) => t.rect[0])),
          Math.min(...captionParts.map((t: ReturnType<typeof JSON.parse>) => t.rect[1])),
          Math.max(...captionParts.map((t: ReturnType<typeof JSON.parse>) => t.rect[2])),
          Math.max(...captionParts.map((t: ReturnType<typeof JSON.parse>) => t.rect[3]))
        ],
        lines: [captionScript ? 'Figure 1: 4² plate.' : cap.text]
      },
      page = {
        pageNumber: 1,
        width: 400,
        height: 400,
        rotation: 0,
        renderRotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds: graphics.graphicsBounds,
        lines: []
      },
      figure = { caption, rect: [60, 175, 165, 210] },
      captions = [caption],
      live = { nativePage, pageContent: content, operators },
      fresh = (): ReturnType<typeof JSON.parse> =>
        nativeCertifiedFigurePixelCrop(
          page,
          figure,
          captions,
          [],
          tokens,
          context,
          [figure],
          figure.rect,
          live
        )
    if (separateDocument) {
      auxiliary = getDocument({
        data: new Uint8Array(Buffer.from(pdf)),
        fontExtraProperties: true,
        isEvalSupported: false,
        useSystemFonts: false,
        verbosity: 0,
        standardFontDataUrl
      })
      live.nativePage = await (await auxiliary.promise).getPage(1)
      live.pageContent = await live.nativePage.getTextContent()
      live.operators = await live.nativePage.getOperatorList()
    }
    expect(context.glyphBounds).toBeUndefined()
    expect(context.type3GlyphPrograms).toBeUndefined()
    expect(context.pixelType3Programs).toHaveLength(1)
    await inspect({
      page,
      figure,
      captions,
      tokens,
      context,
      live,
      fresh,
      nativeCertifiedFigurePixelPngSafe
    })
  } finally {
    canvas.width = canvas.height = 0
    await auxiliary?.destroy()
    await loading.destroy()
  }
}

it('preserves both raster rows and a sibling Form through complete Type3 preview evidence', async () => {
  await withLeadingType3Forms(async (f) => {
    const before = JSON.stringify([f.page, f.figure, f.tokens, f.context]),
      plan = f.fresh()
    expect(plan).toBeDefined()
    expect(plan.rect[0]).toBeLessThan(50)
    expect(plan.rect[1]).toBeLessThan(90)
    expect(plan.rect[2]).toBeGreaterThan(330)
    expect(plan.rect[3]).toBeGreaterThan(210)
    expect(plan.rect[1]).toBeGreaterThan(70)
    expect(plan.rect[3]).toBeLessThan(240)
    expect(plan.sourceItems).toBeUndefined()
    expect(JSON.stringify([f.page, f.figure, f.tokens, f.context])).toBe(before)
    const { renderPdfCrop } = await import(
        pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
      ),
      png = await renderPdfCrop(f.live.nativePage, plan.rect)
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  })
})

it('restores a single closed Type3 Form with its complete outer labels', async () => {
  await withLeadingType3Forms(
    async (f) => {
      const before = JSON.stringify([f.page, f.figure, f.tokens, f.context]),
        plan = f.fresh()
      expect(plan).toBeDefined()
      expect(plan.rect[1]).toBeLessThan(110)
      expect(plan.rect[3]).toBeGreaterThan(212)
      expect(plan.rect[1]).toBeGreaterThan(70)
      expect(plan.rect[3]).toBeLessThan(240)
      expect(plan.rect[2]).toBeLessThan(180)
      expect(plan.sourceItems).toBeUndefined()
      expect(JSON.stringify([f.page, f.figure, f.tokens, f.context])).toBe(before)
      const { renderPdfCrop } = await import(
          pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
        ),
        png = await renderPdfCrop(f.live.nativePage, plan.rect)
      expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    },
    false,
    false,
    'complete'
  )
})

it('proves a curved Type3 glyph through its exact native tight cache while retaining conservative ink', async () => {
  await withLeadingType3Forms(
    async (f) => {
      const plan = f.fresh()
      expect(plan).toBeDefined()
      const { renderPdfCrop } = await import(
        pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
      )
      const png = await renderPdfCrop(f.live.nativePage, plan.rect)
      expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    },
    false,
    false,
    'complete',
    '',
    true
  )
})

it.each(['perturbed', 'clipped-control-ink'] as const)(
  'rejects a curved Type3 %s cache or clip',
  async (mode) => {
    await withLeadingType3Forms(
      async (f) => {
        const font = f.context.pixelType3Programs[0],
          glyph = font.glyphs[0],
          index = f.context.content.items.findIndex(
            (r: ReturnType<typeof JSON.parse>) => r.fontName === font.fontName
          ),
          liveFont = f.live.nativePage.commonObjs.get(f.live.pageContent.items[index].fontName),
          actual = liveFont.charProcOperatorList[glyph.operatorListId]
        if (mode === 'clipped-control-ink') {
          glyph.program.argsArray[0][5] = actual.argsArray[0][5] = 600
        } else {
          glyph.program.argsArray[1][2][3] = actual.argsArray[1][2][3] = 501
        }
        expect(f.fresh()).toBeUndefined()
      },
      false,
      false,
      'complete',
      '',
      true
    )
  }
)

it('binds a raised caption digit to its native display before restoring the complete plate', async () => {
  await withLeadingType3Forms(
    async (f) => {
      const before = JSON.stringify([f.page, f.figure, f.tokens, f.context]),
        plan = f.fresh()
      expect(plan).toBeDefined()
      expect(plan.rect[1]).toBeLessThan(110)
      expect(plan.rect[3]).toBeGreaterThan(212)
      expect(plan.sourceItems).toBeUndefined()
      expect(f.tokens.some((t: ReturnType<typeof JSON.parse>) => t.text === '2')).toBe(true)
      expect(f.tokens.some((t: ReturnType<typeof JSON.parse>) => t.text.includes('²'))).toBe(false)
      const { renderPdfCrop } = await import(
        pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
      )
      const png = await renderPdfCrop(f.live.nativePage, plan.rect)
      expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      expect(JSON.stringify([f.page, f.figure, f.tokens, f.context])).toBe(before)
    },
    false,
    false,
    'complete',
    'raised'
  )
})
it.each(['baseline', 'detached'] as const)(
  'refuses a caption superscript claimed from a %s native digit',
  async (mode) => {
    await withLeadingType3Forms(
      async (f) => {
        expect(f.fresh()).toBeUndefined()
      },
      false,
      false,
      'complete',
      mode
    )
  }
)
it.each(['wrong-text', 'missing-source', 'partial-caption'] as const)(
  'keeps the raised caption source proof closed with %s',
  async (mode) => {
    await withLeadingType3Forms(
      async (f) => {
        if (mode === 'wrong-text') f.figure.caption.lines[0] = 'Figure 1: 4³ plate.'
        if (mode === 'missing-source')
          f.tokens.splice(
            f.tokens.findIndex((t: ReturnType<typeof JSON.parse>) => t.text === '2'),
            1
          )
        if (mode === 'partial-caption') f.figure.caption.rect[2] = 100
        expect(f.fresh()).toBeUndefined()
      },
      false,
      false,
      'complete',
      'raised'
    )
  }
)

it.each(['foreign-paint', 'foreign-text', 'second-form'] as const)(
  'refuses a single Type3 plate with native %s outside its complete scope',
  async (mode) => {
    await withLeadingType3Forms(
      async (f) => {
        expect(f.fresh()).toBeUndefined()
      },
      false,
      false,
      mode
    )
  }
)

it.each([
  'missing-live',
  'missing-occurrence',
  'duplicate-occurrence',
  'wrong-d1-advance',
  'ink-outside-d1',
  'open-path',
  'missing-source',
  'changed-source',
  'foreign-font',
  'foreign-paint',
  'adjacent-caption',
  'missing-marker',
  'extra-form'
])('refuses leading Type3 Form preview with %s', async (mode) => {
  await withLeadingType3Forms(async (f) => {
    const glyph = f.context.pixelType3Programs[0].glyphs[0]
    if (mode === 'missing-live') f.live.nativePage = undefined
    if (mode === 'missing-occurrence') glyph.occurrences.pop()
    if (mode === 'duplicate-occurrence') glyph.occurrences.push(glyph.occurrences[0])
    if (mode === 'wrong-d1-advance') glyph.program.argsArray[0][0]++
    if (mode === 'ink-outside-d1') glyph.program.argsArray[0][4] = 100
    if (mode === 'open-path')
      glyph.program.argsArray[1][1][0] = glyph.program.argsArray[1][1][0].slice(0, -1)
    if (mode === 'missing-source')
      f.tokens.splice(
        f.tokens.findIndex((t: { text: string }) => t.text === 'K'),
        1
      )
    if (mode === 'changed-source')
      f.context.content.items.find((r: { str: string }) => r.str === 'K').str = 'L'
    if (mode === 'foreign-font') f.context.partialFontGlyphBounds[0].glyphs.pop()
    if (mode === 'foreign-paint') {
      const index = f.context.operators.fnArray.lastIndexOf(OPS.paintFormXObjectBegin)
      f.context.operators.argsArray[index][0] = [1, 0, 0, 1, 100, 170]
    }
    if (mode === 'adjacent-caption')
      f.captions.push({
        page: 1,
        rect: [180, 100, 250, 112],
        lines: ['Figure 2: Another native object.']
      })
    if (mode === 'missing-marker')
      f.context.content.items.find((r: { str: string }) => r.str === 'b').str = 'c'
    if (mode === 'extra-form') {
      const i = f.context.operators.fnArray.lastIndexOf(OPS.paintFormXObjectBegin)
      f.context.operators.fnArray.splice(i, 0, OPS.paintFormXObjectBegin)
      f.context.operators.argsArray.splice(i, 0, [
        [1, 0, 0, 1, 0, 0],
        [50, 90, 330, 210]
      ])
    }
    expect(f.fresh()).toBeUndefined()
  })
})

it.each(['path-reference', 'path-value', 'source-reference', 'late-snapshot'])(
  'invalidates leading Type3 preview after live %s drift',
  async (mode) => {
    await withLeadingType3Forms(async (f) => {
      const plan = f.fresh()
      expect(plan).toBeDefined()
      const { renderPdfCrop } = await import(
          pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
        ),
        { Path2D } = await import('@napi-rs/canvas'),
        png = await renderPdfCrop(f.live.nativePage, plan.rect),
        entry = f.context.pixelType3Programs[0],
        font = f.live.nativePage.commonObjs.get(entry.fontName),
        program = font.charProcOperatorList[entry.glyphs[0].operatorListId]
      expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
      if (mode === 'path-reference')
        program.argsArray[1][1][0] = new Path2D(program.argsArray[1][1][0])
      if (mode === 'path-value') program.argsArray[1][1][0].rect(0, 0, 1000, 1000)
      if (mode === 'source-reference') f.live.pageContent.items = [...f.live.pageContent.items]
      if (mode === 'late-snapshot') entry.glyphs[0].program.argsArray[0][4]++
      expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    })
  }
)
it.each(['complete', 'wrong-font-map', 'raw-path-drift', 'raw-reversion'])(
  'binds separate-document leading Type3 fonts and first path execution: %s',
  async (mode) => {
    await withLeadingType3Forms(async (f) => {
      const entry = f.context.pixelType3Programs[0],
        index = f.context.content.items.findIndex(
          (r: { fontName: string }) => r.fontName === entry.fontName
        ),
        actualName = f.live.pageContent.items[index].fontName,
        program =
          f.live.nativePage.commonObjs.get(actualName).charProcOperatorList[
            entry.glyphs[0].operatorListId
          ]
      expect(actualName).not.toBe(entry.fontName)
      const initialRaw = program.argsArray[1][1][0]
      expect(ArrayBuffer.isView(program.argsArray[1][1][0])).toBe(true)
      if (mode === 'wrong-font-map') {
        f.live.pageContent.items[index].fontName = f.live.pageContent.items[0].fontName
        expect(f.fresh()).toBeUndefined()
        return
      }
      const plan = f.fresh()
      expect(plan).toBeDefined()
      if (mode === 'raw-path-drift') program.argsArray[1][1][0][1]++
      const { renderPdfCrop } = await import(
          pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
        ),
        { Path2D } = await import('@napi-rs/canvas'),
        png = await renderPdfCrop(f.live.nativePage, plan.rect)
      expect(program.argsArray[1][1][0]).toBeInstanceOf(Path2D)
      expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(
        mode !== 'raw-path-drift'
      )
      if (mode === 'raw-reversion') {
        program.argsArray[1][1][0] = initialRaw
        expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
      }
    }, true)
  }
)

it('binds a native multi-character Type3 glyph literally without changing source text', async () => {
  await withLeadingType3Forms(
    async (f) => {
      expect(f.context.pixelType3Programs[0].glyphs[0].unicode).toBe('fi')
      expect(f.context.content.items.some((r: { str: string }) => r.str === 'fi')).toBe(true)
      const before = JSON.stringify(f.context.content),
        plan = f.fresh()
      expect(plan).toBeDefined()
      expect(plan.sourceItems).toBeUndefined()
      expect(JSON.stringify(f.context.content)).toBe(before)
    },
    true,
    true
  )
})

const standardFontDataUrl =
  join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts'
  ) + '/'
const { collectClosedFigureFrames } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const {
  nativeCaptionedPlotBand,
  nativePlotStripHasOmittedAxes,
  nativeFigureRunningHead,
  nativeClosedCategoryLabels,
  nativeAlignedNodeFigure,
  nativeTopParagraphTail,
  nativeDisjointPlotColumn
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> => {
  const caption = { page: 1, lines: ['Figure 1: Paired curves.'], rect: [40, 280, 240, 292] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 40, y: 280, width: 200, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const rules: number[][] = []
  for (const left of [100, 330]) {
    rules.push(
      [left, 60, left + 170, 60],
      [left, 240, left + 170, 240],
      [left, 60, left, 240],
      [left + 170, 60, left + 170, 240]
    )
    for (const rect of [
      [left - 1, 59, left + 171, 241],
      [left + 3, 64, left + 160, 232],
      [left + 6, 68, left + 155, 220],
      [left + 10, 74, left + 150, 205]
    ])
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    for (let i = 0; i < 5; i++)
      page.lines.push({
        text: String(i),
        x: left - 15,
        y: 75 + i * 30,
        width: 8,
        height: 8,
        fontSize: 8
      })
    page.lines.push({
      text: 'Horizontal axis',
      x: left + 20,
      y: 247,
      width: 110,
      height: 8,
      fontSize: 8
    })
  }
  const tableCaption = {
    page: 1,
    lines: ['Table 1. Independent records.'],
    rect: [40, 380, 240, 392]
  }
  return { page, caption, captions: [caption, tableCaption], rules }
}

// Four anonymized faces are enough to reproduce independently trimmed plot
// widths. Titles and exact closed frames prove columns without widening a gap.
function intervalTitleGrid(): ReturnType<typeof JSON.parse> {
  const caption = { page: 1, lines: ['Figure 1. Sample measurements.'], rect: [40, 355, 480, 365] }
  const frames = [
    [80, 80, 215, 180],
    [280, 80, 415, 180],
    [80, 230, 205, 330],
    [280, 230, 415, 330]
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 40, y: 355, width: 440, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const rules: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  for (const [index, [x, y, right, bottom]] of frames.entries()) {
    rules.push(
      [x, y, right, y],
      [x, bottom, right, bottom],
      [x, y, x, bottom],
      [right, y, right, bottom]
    )
    const title = {
      text: `Sample ${index + 1}`,
      x: x + 30,
      y: y - 12,
      width: 60,
      height: 8,
      fontSize: 8
    }
    page.lines.push(title)
    tokens.push({
      text: title.text,
      rect: [title.x, title.y, title.x + title.width, title.y + 8],
      height: 8,
      baseline: title.y + 8,
      horizontal: true
    })
    for (let n = 0; n < 5; n++)
      page.lines.push({
        text: String(n),
        x: x - 9,
        y: y + 10 + n * 17,
        width: 5,
        height: 6,
        fontSize: 6
      })
    for (let n = 0; n < 3; n++)
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [x + 5 + n, y + 10 + n, right - 10 - n, bottom - 10 - n].map(
          (v, i) => v / (i % 2 ? 800 : 600)
        )
      })
  }
  return { page, caption, captions: [caption], frames, tokens, rules }
}

it('completes independently trimmed native plot columns from whole unique titles and closed faces', () => {
  const f = intervalTitleGrid(),
    before = structuredClone(f)
  const result = nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    [],
    f.rules,
    f.frames,
    f.tokens
  )
  expect(result?.graphicsCount).toBe(4)
  expect(result?.rect[1]).toBe(68)
  expect(result?.rect[3]).toBe(330)
  expect(
    associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)[0]?.rect[1]
  ).toBeLessThanOrEqual(68)
  expect(f).toEqual(before)
})

it.each([
  'missing-title',
  'duplicate-title',
  'short-title-font',
  'wrong-title-height',
  'missing-frame',
  'orphan-frame',
  'competing-title',
  'foreign-caption',
  'foreign-title-row-caption',
  'foreign-table',
  'foreign-prose'
])('refuses ambiguous independently trimmed native plot columns: %s', (reason) => {
  const f = intervalTitleGrid()
  if (reason === 'missing-title') f.tokens.splice(0, 1)
  if (reason === 'duplicate-title') {
    f.page.lines[7].text = f.page.lines[1].text
    f.tokens[1].text = f.tokens[0].text
  }
  if (reason === 'short-title-font') f.tokens[0].rect[2] -= 1
  if (reason === 'wrong-title-height') f.tokens[0].height = 7
  if (reason === 'missing-frame') f.frames.splice(0, 1)
  if (reason === 'orphan-frame') f.frames.push([220, 100, 260, 150])
  if (reason === 'competing-title') f.page.lines.push({ ...f.page.lines[1], text: 'Other title' })
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Separate owner.'], rect: [90, 200, 200, 210] })
  if (reason === 'foreign-title-row-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Separate owner.'], rect: [220, 70, 275, 76] })
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent article paragraph. '.repeat(4),
      x: 90,
      y: 200,
      width: 400,
      height: 10,
      fontSize: 10
    })
  const result = nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    reason === 'foreign-table' ? [[90, 200, 200, 220]] : [],
    f.rules,
    f.frames,
    f.tokens
  )
  expect(result?.graphicsCount).not.toBe(4)
})
it('keeps separately captioned adjacent plots separate through final association', () => {
  const f = input()
  f.captions = [100, 330].map((left, i) => ({
    page: 1,
    lines: [`Figure ${i + 1}: Measurement.`],
    rect: [left, 270, left + 170, 280]
  }))
  f.page.lines = f.page.lines.filter(
    (line: ReturnType<typeof JSON.parse>) => !line.text.startsWith('Figure')
  )
  for (const caption of f.captions) {
    f.page.lines.push({
      text: caption.lines[0],
      x: caption.rect[0],
      y: 270,
      width: 170,
      height: 10,
      fontSize: 10
    })
    f.page.lines.push({
      text: 'Outcome axis',
      x: caption.rect[0] + 20,
      y: 65,
      width: 90,
      height: 8,
      fontSize: 8
    })
  }
  const before = structuredClone(f)
  const figures = associateFigures(f.page, f.captions, [], f.rules)
  expect(figures).toHaveLength(2)
  expect(figures[0].rect[2]).toBeLessThan(figures[1].rect[0])
  expect(figures[0].rect[0]).toBeLessThanOrEqual(100)
  expect(figures[0].rect[2]).toBeGreaterThanOrEqual(270)
  expect(figures[1].rect[0]).toBeLessThanOrEqual(330)
  expect(figures[1].rect[2]).toBeGreaterThanOrEqual(500)
  expect(f).toEqual(before)
})
const positionedClosedPlots = (): ReturnType<typeof JSON.parse> => {
  const caption = {
      page: 1,
      lines: [
        'Figure 1: Left: first measurement. Center: second measurement. Right: third measurement.'
      ],
      rect: [95, 170, 510, 180]
    },
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    frames = [
      [110, 70, 220, 140],
      [250, 71.1, 360, 141.1],
      [390, 71.4, 500, 141.4]
    ],
    rules: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  const line = (text: string, rect: number[], height: number, horizontal = true): void => {
    page.lines.push({
      text,
      x: rect[0],
      y: rect[1],
      width: rect[2] - rect[0],
      height: rect[3] - rect[1],
      fontSize: height
    })
    tokens.push({ text, rect, height, horizontal, baseline: rect[3] })
  }
  line(caption.lines[0], caption.rect, 10)
  for (const [left, top, right, bottom] of frames) {
    rules.push(
      [left, top, right, top],
      [left, bottom, right, bottom],
      [left, top, left, bottom],
      [right, top, right, bottom]
    )
    for (const rect of [
      [left - 14, top - 3, right + 6, bottom + 17],
      ...Array.from({ length: 3 }, (_, n) => [
        left + 5,
        top + 10 + n * 4,
        right - 5,
        bottom - 10 - n * 4
      ])
    ])
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
      })
    for (let n = 0; n < 4; n++)
      line(String(n), [left - 8, top + 8 + n * 15, left - 4, top + 11 + n * 15], 3)
    line('0 1 2 3 4', [left + 3, bottom + 1, right - 3, bottom + 4], 3)
    line('Position', [left + 30, bottom + 6, left + 66, bottom + 9.5], 3.5)
    line('Outcome', [left - 12, top + 25, left - 8.5, top + 37], 3.5, false)
  }
  return { page, caption, captions: [caption], frames, rules, tokens }
}
it('retains three independently closed positioned plots and every whole measured paint carrier', () => {
  const f = positionedClosedPlots(),
    before = structuredClone(f),
    proof = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
  expect(proof?.rect).toEqual([96, 67, 506, 158.4])
  expect(proof?.graphicsCount).toBe(3)
  expect(f).toEqual(before)
})
it('completes the real association consumer across all three positioned closed plots', () => {
  const f = positionedClosedPlots(),
    figures = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([96, 67, 506, 158.4])
  expect(figures[0].caption).toEqual(f.caption)
  expect(figures[0].graphicsCount).toBe(3)
})
it.each([
  'missing-frame',
  'mismatched-frame',
  'missing-font',
  'clipped-font',
  'invalid-baseline',
  'duplicate-font',
  'missing-rotated-axis',
  'missing-position-key',
  'competing-caption',
  'foreign-column-paint',
  'oversized-background',
  'crossing-table'
])('refuses incomplete three-position plot evidence: %s', (reason) => {
  const f = positionedClosedPlots(),
    tables: number[][] = []
  if (reason === 'missing-frame') f.frames.shift()
  if (reason === 'mismatched-frame') f.frames[0][0] += 0.01
  if (reason === 'missing-font')
    f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => t.text !== 'Position')
  if (reason === 'clipped-font')
    f.page.lines.find((l: ReturnType<typeof JSON.parse>) => l.text === 'Position').height -= 0.1
  if (reason === 'invalid-baseline')
    f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Position').baseline = NaN
  if (reason === 'duplicate-font')
    f.tokens.push(
      structuredClone(f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Position'))
    )
  if (reason === 'missing-rotated-axis')
    f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Outcome').horizontal = true
  if (reason === 'missing-position-key')
    f.caption.lines[0] = f.caption.lines[0].replace('Left:', 'First:')
  if (reason === 'competing-caption') f.captions.push(structuredClone(f.caption))
  if (reason === 'foreign-column-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [230 / 600, 90 / 800, 265 / 600, 100 / 800]
    })
  if (reason === 'oversized-background')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [90 / 600, 60 / 800, 510 / 600, 165 / 800]
    })
  if (reason === 'crossing-table') tables.push([120, 90, 210, 130])
  const proof = nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    tables,
    f.rules,
    f.frames,
    f.tokens
  )
  expect(proof?.graphicsCount).not.toBe(3)
  if (reason === 'crossing-table') expect(proof?.graphicsCount).toBe(2)
})
it('preserves a different-page equal-coordinate caption outside the positioned plot ownership proof', () => {
  const f = positionedClosedPlots()
  f.captions.push({ ...structuredClone(f.caption), page: 2 })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)?.rect
  ).toEqual([96, 67, 506, 158.4])
})
const closedSharedLegend = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['FIG. 1: Three measurements share an independent closed legend.'],
    rect: [55, 280, 565, 290]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 55, y: 280, width: 510, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const tokens: ReturnType<typeof JSON.parse>[] = [],
    frames = [
      [80, 60, 530, 85],
      [100, 105, 230, 210],
      [265, 105, 395, 210],
      [430, 105, 560, 210]
    ]
  const line = (text: string, r: number[], size = 10, horizontal = true): void => {
    page.lines.push({
      text,
      x: r[0],
      y: r[1],
      width: r[2] - r[0],
      height: r[3] - r[1],
      fontSize: size
    })
    tokens.push({ text, rect: r, height: size, baseline: r[3], horizontal })
  }
  const paint = (r: number[]): void => {
    page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600))
    })
  }
  paint([52, 50, 570, 253])
  frames.slice(1).forEach((f, n) => {
    paint([f[0] - 2, f[1] - 2, f[2] + 3, f[3] + 4])
    for (let i = 0; i < 3; i++) paint([f[0] + 4, f[1] + 18 + i * 4, f[2] - 4, f[3] - 3 - i * 4])
    line(`Panel ${String.fromCharCode(65 + n)}`, [f[0] + 40, 91, f[2] - 40, 102], 11)
    for (let i = 0; i < 3; i++) {
      line(String(i), [f[0] + 5 + i * 55, 214, f[0] + 13 + i * 55, 224])
      line(String(i), [f[0] - 17, 125 + i * 32, f[0] - 9, 135 + i * 32])
    }
    line('Axis', [f[0] + 55, 229, f[2] - 55, 239])
    line('Y', [f[0] - 35, 150, f[0] - 25, 165], 10, false)
  })
  paint([78, 59, 533, 91])
  paint([86, 64, 95, 68])
  line(
    'Shared legend uses ordinary native words and complete independent physical boundaries.',
    [105, 61, 520, 69],
    8
  )
  line('Second series', [105, 73, 180, 81], 8)
  return { page, caption, captions: [caption], frames, tokens, owned: [65, 72, 563, 240] }
}
it('completes a separately boxed shared legend without cutting crossed complete native paint', () => {
  const f = closedSharedLegend(),
    before = structuredClone(f),
    actual = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      [],
      [],
      f.frames,
      f.tokens,
      f.owned
    )
  expect(actual?.caption).toBe(f.caption)
  expect(actual?.graphicsCount).toBe(3)
  expect(actual?.rect).toEqual([52, 50, 570, (253 / 800) * 800])
  expect(f).toEqual(before)
})
it('preserves an already complete associated plate rather than replacing its existing owner', () => {
  const f = closedSharedLegend(),
    actual = associateFigures(f.page, f.captions, [], [], f.frames, f.tokens)
  expect(actual).toHaveLength(1)
  expect(actual[0].caption).toBe(f.caption)
  expect(actual[0].rect.slice(0, 3)).toEqual([52, 50, 570])
  expect(actual[0].rect[3]).toBeCloseTo(253, 10)
  expect(actual[0].graphicsCount).toBe(15)
})
it.each([
  'missing-owned',
  'missing-legend',
  'missing-face',
  'misaligned-face',
  'unequal-face',
  'fifth-frame',
  'different-page',
  'foreign-caption',
  'foreign-table',
  'foreign-image',
  'distant-container',
  'caption-overlap',
  'crossing-paint',
  'foreign-prose',
  'duplicate-container',
  'legend-gap-paint',
  'face-gap-paint',
  'duplicate-legend-stroke',
  'missing-font',
  'missing-height',
  'wrong-height',
  'missing-baseline',
  'nonfinite-baseline',
  'clipped-font',
  'duplicate-font',
  'missing-axis',
  'no-interior-paint',
  'invalid-graphics',
  'unknown-paint'
])('refuses shared legend completion without every independent source owner: %s', (reason) => {
  const f = closedSharedLegend(),
    tables: number[][] = []
  const addPaint = (r: number[], kind = 'path'): void => {
    f.page.graphicsBounds.push({ kind, normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600)) })
  }
  if (reason === 'missing-legend') f.frames.shift()
  if (reason === 'missing-face') f.frames.pop()
  if (reason === 'misaligned-face') f.frames[2][1] += 0.1
  if (reason === 'unequal-face') f.frames[2][2] += 0.1
  if (reason === 'fifth-frame') f.frames.push([90, 65, 140, 75])
  if (reason === 'different-page') f.caption.page = 2
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Independent plate.'], rect: [100, 65, 200, 75] })
  if (reason === 'foreign-table') tables.push([100, 65, 200, 75])
  if (reason === 'foreign-image') addPaint([100, 65, 200, 75], 'image')
  if (reason === 'distant-container') f.page.graphicsBounds[0].normalizedRect[1] = 20 / 800
  if (reason === 'caption-overlap') f.page.graphicsBounds[0].normalizedRect[3] = 281 / 800
  if (reason === 'crossing-paint') addPaint([20, 60, 130, 75])
  if (reason === 'foreign-prose') {
    f.page.lines.push({
      text: 'Independent ordinary text in the empty title corridor',
      x: 90,
      y: 86,
      width: 410,
      height: 10,
      fontSize: 10
    })
    f.tokens.push({
      text: 'Independent ordinary text in the empty title corridor',
      rect: [90, 86, 500, 96],
      height: 10,
      baseline: 96,
      horizontal: true
    })
  }
  if (reason === 'duplicate-container')
    f.page.graphicsBounds.push(structuredClone(f.page.graphicsBounds[0]))
  if (reason === 'legend-gap-paint') addPaint([140, 87, 250, 90])
  if (reason === 'face-gap-paint') addPaint([110, 99, 150, 102])
  if (reason === 'duplicate-legend-stroke')
    f.page.graphicsBounds.push(structuredClone(f.page.graphicsBounds.at(-2)))
  const font = f.tokens.find((t: ReturnType<typeof JSON.parse>) => t.text === 'Second series')
  if (reason === 'missing-font') f.tokens.splice(f.tokens.indexOf(font), 1)
  if (reason === 'missing-height') delete font.height
  if (reason === 'wrong-height') font.height = 1
  if (reason === 'missing-baseline') delete font.baseline
  if (reason === 'nonfinite-baseline') font.baseline = NaN
  if (reason === 'clipped-font') font.rect[3] -= 0.1
  if (reason === 'duplicate-font') f.tokens.push(structuredClone(font))
  if (reason === 'missing-axis')
    f.tokens = f.tokens.filter(
      (t: ReturnType<typeof JSON.parse>) => !(t.rect[1] > 210 && t.rect[0] > 100 && t.rect[2] < 230)
    )
  if (reason === 'no-interior-paint') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 1)
  if (reason === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
  if (reason === 'unknown-paint') addPaint([140, 87, 250, 90], 'unobserved-paint')
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      tables,
      [],
      f.frames,
      f.tokens,
      reason === 'missing-owned' ? undefined : f.owned
    )
  ).toBeUndefined()
})

// Only the optional label proof receives loaded-font evidence. The ordinary
// mixed-strip fixture deliberately remains useful without any font claims.
function disjointGroupFonts(): ReturnType<typeof JSON.parse> {
  const f = disjointMixedGroups()
  for (const token of f.tokens) token.baseline = token.rect[3]
  const glyphs = new Map<string, number[]>()
  for (const [i, op] of f.context.operators.fnArray.entries()) {
    if (op !== OPS.showText) continue
    for (const glyph of f.context.operators.argsArray[i][0]) {
      glyph.fontChar = glyph.unicode
      glyph.isInFont = true
      glyphs.set(glyph.fontChar, [0, -0.2, 0.5, 0.8])
    }
  }
  f.context.glyphBounds = [
    { fontName: 'face', glyphs: [...glyphs].map(([fontChar, bounds]) => ({ fontChar, bounds })) }
  ]
  return f
}
it('claims whole group-owned words with independent native glyph ink', () => {
  const f = disjointGroupFonts(),
    before = structuredClone(f)
  const result = nativeDisjointMixedFigureGroup(
    f.page,
    { caption: f.captions[0], rect: [60, 65, 550, 300], reason: 'native-raster-vector-strip' },
    f.captions,
    [],
    f.tokens,
    f.context
  )
  expect(result.sourceItems).toEqual([{ pageNumber: 1, index: 1, text: 'Axis' }])
  expect(result.issue).toBe('native-disjoint-mixed-group')
  expect(result.reason).toBe('native-raster-vector-strip')
  expect(f).toEqual(before)
})
it.each(['missing-font', 'missing-glyph', 'not-in-font', 'glyph-outside-clip', 'source-alias'])(
  'retains a complete group crop without incomplete optional text claims: %s',
  (mode) => {
    const f = disjointGroupFonts(),
      ops = f.context.operators
    if (mode === 'missing-font') f.context.glyphBounds = []
    if (mode === 'missing-glyph')
      f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
        (g) => g.fontChar !== 'A'
      )
    if (mode === 'not-in-font')
      ops.argsArray[
        ops.fnArray.indexOf(OPS.showText, ops.fnArray.lastIndexOf(OPS.beginGroup))
      ][0][0].isInFont = false
    if (mode === 'glyph-outside-clip')
      f.context.glyphBounds[0].glyphs.find((g) => g.fontChar === 'A').bounds[2] = 5
    if (mode === 'source-alias')
      f.tokens[1].sourceToken = { sourceItem: { ...f.tokens[1].sourceItem } }
    const result = nativeDisjointMixedFigureGroup(
      f.page,
      { caption: f.captions[0], rect: [60, 65, 550, 300], reason: 'native-raster-vector-strip' },
      f.captions,
      [],
      f.tokens,
      f.context
    )
    expect(result.rect).toEqual([320, 60, 560, 300])
    expect(result.sourceItems).toBeUndefined()
    expect(result.issue).toBeUndefined()
  }
)

const { nativeUncaptionedFormPlate } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-form-plate.mjs')).href
)
function textFreeFormPlate(): ReturnType<typeof JSON.parse> {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const context = {
    viewport: { width: 600, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    content: { items: [], styles: {} },
    glyphBounds: [],
    graphicsBounds: page.graphicsBounds,
    operators: { fnArray: [] as number[], argsArray: [] as unknown[] }
  }
  const emit = (op: number, args: unknown = []): number => {
    context.operators.fnArray.push(op)
    return context.operators.argsArray.push(args) - 1
  }
  emit(OPS.paintFormXObjectBegin, [null, Float32Array.from([120, 200, 480, 600])])
  emit(OPS.paintFormXObjectBegin, [null, Float32Array.from([100, 180, 500, 620])])
  for (const [x, y, right, bottom] of [
    [100, 180, 500, 620],
    [140, 220, 300, 400],
    [300, 400, 460, 580]
  ]) {
    const operationIndex = emit(OPS.constructPath, [
      OPS.fill,
      [Float32Array.from([0, x, y, 1, right, y, 1, right, bottom, 1, x, bottom, 4])],
      Float32Array.from([x, y, right, bottom])
    ])
    page.graphicsBounds.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [x / 600, (800 - bottom) / 800, right / 600, (800 - y) / 800]
    })
  }
  emit(OPS.paintFormXObjectEnd)
  emit(OPS.paintFormXObjectEnd)
  return { page, context, tokens: [] }
}
function addFormPlateText(f: ReturnType<typeof JSON.parse>, internal: boolean): void {
  const x = 200,
    baseline = internal ? 500 : 700,
    sourceItem = { pageNumber: 1, index: 0, text: 'A' }
  f.context.content.items = [
    {
      str: 'A',
      dir: 'ltr',
      fontName: 'face',
      width: 5,
      height: 10,
      transform: [10, 0, 0, 10, x, baseline],
      sourceItem
    }
  ]
  f.context.content.styles.face = { ascent: 0.8, descent: -0.2 }
  f.context.glyphBounds = [
    { fontName: 'face', glyphs: [{ fontChar: 'A', bounds: [0, -0.2, 0.5, 0.8] }] }
  ]
  f.context.viewport.convertToViewportPoint = (x: number, y: number): number[] => [x, 800 - y]
  f.tokens.push({
    text: 'A',
    sourceItem,
    rect: [x, 800 - baseline - 10, x + 5, 800 - baseline],
    height: 10,
    baseline: 800 - baseline,
    horizontal: true
  })
  const position = internal
    ? f.context.operators.fnArray.length - 2
    : f.context.operators.fnArray.length
  f.context.operators.fnArray.splice(
    position,
    0,
    OPS.beginText,
    OPS.setFont,
    OPS.setTextMatrix,
    OPS.showText,
    OPS.endText
  )
  f.context.operators.argsArray.splice(
    position,
    0,
    [],
    ['face', 10],
    [[1, 0, 0, 1, x, baseline]],
    [[{ unicode: 'A', fontChar: 'A', isInFont: true, width: 500 }]],
    []
  )
}
it('retains one complete text-free vector plate at its actual Form clip', () => {
  const f = textFreeFormPlate(),
    before = structuredClone(f)
  expect(nativeUncaptionedFormPlate(f.page, [], [], f.tokens, f.context)).toEqual({
    rect: [120, 200, 480, 600],
    graphicsCount: 3,
    reason: 'native-uncaptioned-form-plate'
  })
  expect(f).toEqual(before)
})
function turnedFormPlate(
  transform: readonly number[] = [0, 1, -1, 0, 650, -100]
): ReturnType<typeof JSON.parse> {
  const f = textFreeFormPlate()
  f.context.operators.fnArray.unshift(OPS.save, OPS.transform)
  f.context.operators.argsArray.unshift([], transform)
  f.context.operators.fnArray.push(OPS.restore)
  f.context.operators.argsArray.push([])
  for (const graphic of f.page.graphicsBounds) {
    graphic.operationIndex += 2
    const [left, top, right, bottom] = graphic.normalizedRect.map(
      (v: number, i: number) => v * (i % 2 ? 800 : 600)
    )
    const points = [
      [left, 800 - top],
      [right, 800 - top],
      [right, 800 - bottom],
      [left, 800 - bottom]
    ].map(([x, y]) => [
      transform[0] * x + transform[2] * y + transform[4],
      800 - (transform[1] * x + transform[3] * y + transform[5])
    ])
    graphic.normalizedRect = [
      Math.min(...points.map(([x]) => x)),
      Math.min(...points.map(([, y]) => y)),
      Math.max(...points.map(([x]) => x)),
      Math.max(...points.map(([, y]) => y))
    ].map((v, i) => v / (i % 2 ? 800 : 600))
  }
  return f
}
it.each([
  ['forward', [0, 1, -1, 0, 650, -100]],
  ['backward', [0, -1, 1, 0, -150, 500]]
] as const)(
  'retains a complete quarter-turned Form near the page bottom: %s',
  (_label, transform) => {
    const f = turnedFormPlate(transform),
      before = structuredClone(f)
    expect(nativeUncaptionedFormPlate(f.page, [], [], f.tokens, f.context)).toEqual({
      rect: [50, 420, 450, 780],
      graphicsCount: 3,
      reason: 'native-uncaptioned-form-plate',
      clipToForm: true
    })
    expect(f).toEqual(before)
  }
)
it.each([
  'mirror',
  'unequal-scale',
  'shear',
  'singular',
  'nonfinite',
  'outside-page',
  'internal-text',
  'foreign-text',
  'missing-paint',
  'unclosed-form',
  'missing-background'
])('declines a turned Form without complete native closure: %s', (mode) => {
  const f = turnedFormPlate(),
    o = f.context.operators
  if (mode === 'mirror') o.argsArray[1][2] = 1
  if (mode === 'unequal-scale') o.argsArray[1][2] = -2
  if (mode === 'shear') o.argsArray[1][0] = 0.01
  if (mode === 'singular') o.argsArray[1][1] = 0
  if (mode === 'nonfinite') o.argsArray[1][4] = Infinity
  if (mode === 'outside-page') o.argsArray[1][5] = -140
  if (mode === 'internal-text') addFormPlateText(f, true)
  if (mode === 'foreign-text') {
    addFormPlateText(f, false)
    f.context.content.items[0].transform[5] = 300
    f.tokens[0].rect = [200, 490, 205, 500]
    f.tokens[0].baseline = 500
    o.argsArray[o.fnArray.indexOf(OPS.setTextMatrix)][0][5] = 300
  }
  if (mode === 'missing-paint') f.page.graphicsBounds.pop()
  if (mode === 'unclosed-form') {
    o.fnArray.pop()
    o.argsArray.pop()
  }
  if (mode === 'missing-background') o.argsArray[4][0] = OPS.stroke
  expect(nativeUncaptionedFormPlate(f.page, [], [], f.tokens, f.context)).toBeUndefined()
})
it.each([false, true])(
  'separates complete native exterior text from internal Form text: internal=%s',
  (internal) => {
    const f = textFreeFormPlate()
    addFormPlateText(f, internal)
    const result = nativeUncaptionedFormPlate(f.page, [], [], f.tokens, f.context)
    if (internal) expect(result).toBeUndefined()
    else expect(result.rect).toEqual([120, 200, 480, 600])
  }
)
it.each([
  'missing-bbox',
  'unclosed-form',
  'wrong-scope',
  'group',
  'foreign-paint',
  'background-incomplete',
  'background-degenerate',
  'caption',
  'table',
  'unknown-path',
  'invalid-graphics'
])('declines an uncaptioned vector plate without complete native closure: %s', (mode) => {
  const f = textFreeFormPlate(),
    o = f.context.operators
  if (mode === 'missing-bbox') o.argsArray[0][1] = null
  if (mode === 'unclosed-form') {
    o.fnArray.pop()
    o.argsArray.pop()
  }
  if (mode === 'wrong-scope') o.fnArray[0] = OPS.save
  if (mode === 'group') o.fnArray[0] = OPS.beginGroup
  if (mode === 'foreign-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 999,
      normalizedRect: [0.8, 0.1, 0.9, 0.2]
    })
  if (mode === 'background-incomplete') {
    o.argsArray[2][1][0] = Float32Array.from([
      0, 140, 220, 1, 300, 220, 1, 300, 400, 1, 140, 400, 4
    ])
    o.argsArray[2][2] = [140, 220, 300, 400]
  }
  if (mode === 'background-degenerate')
    o.argsArray[2][1][0] = Float32Array.from([
      0, 100, 180, 1, 500, 180, 1, 100, 180, 1, 100, 620, 4
    ])
  if (mode === 'unknown-path') o.argsArray[2][0] = -1
  if (mode === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
  expect(
    nativeUncaptionedFormPlate(
      f.page,
      mode === 'caption' ? [{ page: 1, rect: [80, 80, 300, 100] }] : [],
      mode === 'table' ? [[140, 220, 300, 400]] : [],
      f.tokens,
      f.context
    )
  ).toBeUndefined()
})
const spectra = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 650, 560, 662]
  f.page.lines = [{ text: f.caption.lines[0], x: 40, y: 650, width: 520, height: 10, fontSize: 10 }]
  f.captions = [f.caption]
  f.page.graphicsBounds = []
  f.rules = []
  for (const top of [80, 280, 480]) {
    f.rules.push(
      [80, top, 520, top],
      [80, top + 140, 520, top + 140],
      [80, top, 80, top + 140],
      [520, top, 520, top + 140]
    )
    for (let i = 0; i < 5; i++) {
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [85, top + 10 + i * 5, 515, top + 100 + i * 4].map(
          (v, n) => v / (n % 2 ? 800 : 600)
        )
      })
      f.page.lines.push({
        text: String(i),
        x: 65,
        y: top + 15 + i * 20,
        width: 8,
        height: 8,
        fontSize: 8
      })
    }
    f.page.lines.push({
      text: Array.from({ length: 15 }, (_, i) => (100 + i / 10).toFixed(2)).join(' '),
      x: 65,
      y: top + 142,
      width: 440,
      height: 8,
      fontSize: 8
    })
  }
  return f
}
it('keeps all closed spectra when native numeric wavelength ticks are merged into long axis rows', () => {
  const f = spectra(),
    r = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules)
  expect(r?.rect[1]).toBeLessThanOrEqual(80)
  expect(r?.rect[3]).toBeGreaterThanOrEqual(628)
})
it.each(['body-text', 'nonmonotonic', 'outside-axis', 'foreign-table'])(
  'does not exempt an unproved long numeric row from the plot prose barrier: %s',
  (reason) => {
    const f = spectra(),
      row = f.page.lines.find((l: ReturnType<typeof JSON.parse>) => l.text.length > 60)
    if (reason === 'body-text') row.text += ' describes the separate experiment.'
    if (reason === 'nonmonotonic') row.text = row.text.split(' ').reverse().join(' ')
    if (reason === 'outside-axis') row.y -= 30
    const r = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[80, 220, 520, 235]] : [],
      f.rules
    )
    // The lower pair remains independently valid; the unproved upper row
    // must not be borrowed into its shared-caption band.
    expect(r?.rect[1] ?? Infinity).toBeGreaterThan(80)
  }
)
const keyedUnequalGrid = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.lines = ['Figure 1. Panels (a) to (d), with (e) and (f), show the measured curves.']
  f.caption.rect = [40, 470, 500, 482]
  f.captions = [f.caption]
  f.page.lines = [{ text: f.caption.lines[0], x: 40, y: 470, width: 460, height: 10, fontSize: 10 }]
  f.page.graphicsBounds = []
  f.rules = []
  f.frames = [
    [80, 60, 120, 160],
    [135, 60, 175, 160],
    [190, 60, 230, 160],
    [245, 60, 285, 160],
    [95, 210, 270, 310],
    [95, 345, 270, 445]
  ]
  f.tokens = []
  f.frames.forEach((r: number[], n: number) => {
    const text = `(${String.fromCharCode(97 + n)})`
    f.tokens.push({
      text,
      rect: [r[0] + 1, r[1] - 1, r[0] + 11, r[1] + 9],
      height: 10,
      horizontal: true
    })
    for (let i = 0; i < 4; i++)
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [r[0] + 3, r[1] + 10 + i * 3, r[2] - 3, r[3] - 10 - i * 3].map(
          (v, j) => v / (j % 2 ? 800 : 600)
        )
      })
    f.page.lines.push({ text: '0', x: r[0] - 8, y: r[1] + 30, width: 6, height: 8, fontSize: 8 })
  })
  f.page.lines.push(
    { text: '(a) (b) (c) (d)', x: 81, y: 59, width: 175, height: 10, fontSize: 10 },
    { text: '(e)', x: 96, y: 209, width: 10, height: 10, fontSize: 10 },
    { text: '(f)', x: 96, y: 344, width: 10, height: 10, fontSize: 10 }
  )
  return f
}
it('keeps a finite unequal scientific grid only with complete native caption-keyed closed faces', () => {
  const f = keyedUnequalGrid(),
    r = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], [], f.frames, f.tokens)
  expect(r?.rect[1]).toBeLessThanOrEqual(59)
  expect(r?.rect[3]).toBeGreaterThanOrEqual(445)
})
it.each([
  'missing-key',
  'duplicate-key',
  'missing-curve',
  'foreign-caption',
  'foreign-table',
  'unproved-frame'
])('declines an unequal scientific grid with incomplete native ownership: %s', (reason) => {
  const f = keyedUnequalGrid()
  if (reason === 'missing-key') f.tokens.shift()
  if (reason === 'duplicate-key') f.tokens[1].text = '(a)'
  if (reason === 'missing-curve') f.page.graphicsBounds.splice(0, 4)
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Independent.'], rect: [100, 180, 250, 192] })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[80, 60, 120, 160]] : [],
      [],
      reason === 'unproved-frame' ? f.frames.slice(1) : f.frames,
      f.tokens
    )
  ).toBeUndefined()
})
it('preserves both closed populated native plots under one short caption', () => {
  const f = input(),
    r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect[2]).toBeGreaterThanOrEqual(500)
  expect(r[0].rect[0]).toBeLessThanOrEqual(85)
})
it('preserves both vertically stacked closed plots above their shared caption', () => {
  const f = input()
  f.rules = f.rules.slice(0, 4)
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.page.lines = f.page.lines.slice(0, 7)
  f.rules.push(
    [100, 270, 270, 270],
    [100, 450, 270, 450],
    [100, 270, 100, 450],
    [270, 270, 270, 450]
  )
  for (const g of [...f.page.graphicsBounds])
    f.page.graphicsBounds.push({
      ...g,
      normalizedRect: g.normalizedRect.map((v: number, i: number) => v + (i % 2 ? 210 / 800 : 0))
    })
  for (const l of f.page.lines.slice(1)) f.page.lines.push({ ...l, y: l.y + 210 })
  f.caption.rect = [40, 490, 450, 502]
  f.captions[1].rect = [40, 570, 240, 582]
  f.page.lines[0] = {
    text: f.caption.lines[0],
    x: 40,
    y: 490,
    width: 410,
    height: 10,
    fontSize: 10
  }
  const r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect).toBeDefined()
  expect(r[0].rect[1]).toBeLessThan(70)
  expect(r[0].rect[3]).toBeGreaterThan(450)
})

it('preserves a finite four-by-four populated plot grid before the nearest bar-chart match', () => {
  const f = input()
  f.page.lines = [f.page.lines[0]]
  f.page.graphicsBounds = []
  f.rules = []
  f.caption.rect = [40, 620, 560, 632]
  f.page.lines[0] = { ...f.page.lines[0], y: 620, width: 520 }
  f.captions = [f.caption]
  for (const top of [70, 205, 340, 475]) {
    for (const left of [80, 200, 320, 440]) {
      f.rules.push(
        [left, top, left + 90, top],
        [left, top + 100, left + 90, top + 100],
        [left, top, left, top + 100],
        [left + 90, top, left + 90, top + 100]
      )
      for (let i = 0; i < 4; i++) {
        f.page.graphicsBounds.push({
          kind: 'path',
          normalizedRect: [left + 5, top + 8 + i * 5, left + 85, top + 40 + i * 5].map(
            (v, j) => v / (j % 2 ? 800 : 600)
          )
        })
        f.page.lines.push({
          text: String(i),
          x: left - 12,
          y: top + 10 + i * 20,
          width: 8,
          height: 7,
          fontSize: 7
        })
      }
    }
  }
  const r = associateFigures(f.page, f.captions, [], f.rules)
  expect(r[0].rect[1]).toBeLessThanOrEqual(70)
  expect(r[0].rect[3]).toBeGreaterThanOrEqual(575)
  const proof = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules)
  expect(proof?.rect[1]).toBeLessThanOrEqual(70)
  const missing = structuredClone(f)
  missing.page.graphicsBounds = missing.page.graphicsBounds.slice(4)
  expect(
    nativeCaptionedPlotBand(missing.page, missing.caption, missing.captions, [], missing.rules)
  ).toBeUndefined()
})

it.each([
  'missing-edge',
  'missing-curves',
  'missing-ticks',
  'foreign-prose',
  'competing-caption',
  'foreign-table'
])('declines incomplete native plot ownership: %s', (reason) => {
  const f = input()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'missing-curves') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  if (reason === 'missing-ticks')
    f.page.lines = f.page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.x < 300)
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent paragraph text. '.repeat(4),
      x: 110,
      y: 120,
      width: 360,
      height: 10,
      fontSize: 10
    })
  if (reason === 'competing-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Independent.'], rect: [330, 180, 490, 192] })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[330, 80, 490, 230]] : [],
      f.rules
    )
  ).toBeUndefined()
})

const token = (
  text: string,
  rect: number[],
  height = 8,
  horizontal = true
): ReturnType<typeof JSON.parse> => ({ text, rect, height, horizontal, baseline: rect[3] })
const measuredStack = (): ReturnType<typeof JSON.parse> => {
  const f = spectra()
  f.caption.lines = ['Figure 1. Heights are labeled in arcseconds and in km.']
  f.page.lines[0].text = f.caption.lines[0]
  f.tokens = []
  for (const top of [80, 280, 480])
    for (let i = 0; i < 6; i++) {
      const y = top + 45 + i * 15
      f.tokens.push(
        token((i / 10).toFixed(1), [525, y, 534, y + 6], 6),
        token('′′', [534.01, y - 0.4, 537, y + 3.8], 4.2),
        token(`(${i * 80} km)`, [539.2, y, 566, y + 6], 6)
      )
      f.page.lines.push({
        text: `${(i / 10).toFixed(1)}′′ (${i * 80} km)`,
        x: 525,
        y,
        width: 41,
        height: 6,
        fontSize: 6
      })
    }
  return f
}
it('retains complete repeated native measurement-unit chains beside every populated closed face', () => {
  const f = measuredStack()
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2]
  ).toBeGreaterThanOrEqual(566)
  expect(
    associateFigures(f.page, f.captions, [], f.rules, [], f.tokens)[0].rect[2]
  ).toBeGreaterThanOrEqual(566)
})
it('does not use another page caption as a barrier to same-page native measurement chains', () => {
  const f = measuredStack()
  f.captions.push({ page: 2, lines: ['Figure 2. Independent.'], rect: [550, 100, 580, 120] })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2]
  ).toBeGreaterThanOrEqual(566)
})
it('keeps repeated measurement units despite already owned close-fitting native plot path extents', () => {
  const f = measuredStack()
  for (const top of [80, 280, 480])
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [65 / 600, (top - 30) / 800, 570 / 600, (top + 170) / 800]
    })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2]
  ).toBeGreaterThanOrEqual(566)
})
it.each(['competing-container', 'foreign-small-path', 'foreign-same-size-path'])(
  'does not ignore independent path paint merely because a plot has an outer context: %s',
  (reason) => {
    const f = measuredStack()
    for (const top of [80, 280, 480])
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [65 / 600, (top - 30) / 800, 570 / 600, (top + 170) / 800]
      })
    const rect =
      reason === 'competing-container'
        ? [65, 50, 570, 250]
        : reason === 'foreign-same-size-path'
          ? [552, 50, 1057, 250]
          : [552, 100, 580, 120]
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
    })
    expect(
      nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, [], f.tokens)?.rect[2] ??
        0
    ).toBeLessThan(566)
  }
)
it.each([
  'missing-quote',
  'wrong-baseline',
  'wrong-unit',
  'lexical-prose',
  'missing-number',
  'incomplete-peer',
  'mismatched-sequence',
  'duplicate-quote',
  'far-gutter',
  'missing-font',
  'foreign-token',
  'foreign-caption',
  'foreign-table',
  'foreign-paint',
  'missing-edge'
])('does not extend a closed stack to unproved measurement tails: %s', (reason) => {
  const f = measuredStack()
  if (reason === 'missing-quote') f.tokens.splice(1, 1)
  if (reason === 'wrong-baseline') f.tokens[2].baseline += 2
  if (reason === 'wrong-unit') f.tokens[2].text = '(0 m)'
  if (reason === 'lexical-prose') f.tokens[2].text = '(the height)'
  if (reason === 'missing-number') f.tokens.shift()
  if (reason === 'incomplete-peer') f.tokens.splice(20, 1)
  if (reason === 'mismatched-sequence') f.tokens[18].text = '9.0'
  if (reason === 'duplicate-quote') f.tokens.push({ ...f.tokens[1] })
  if (reason === 'far-gutter')
    for (const t of f.tokens) t.rect = t.rect.map((v: number, i: number) => (i % 2 ? v : v + 40))
  if (reason === 'missing-font') delete f.tokens[2].height
  if (reason === 'foreign-token') f.tokens.push(token('Independent text', [552, 101, 580, 109], 8))
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Independent.'], rect: [550, 100, 580, 120] })
  if (reason === 'foreign-paint')
    f.page.graphicsBounds.push({
      kind: 'image',
      normalizedRect: [552 / 600, 100 / 800, 580 / 600, 120 / 800]
    })
  if (reason === 'missing-edge') f.rules = f.rules.filter((_: number[], n: number) => n % 4 !== 3)
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[550, 100, 580, 120]] : [],
      f.rules,
      [],
      f.tokens
    )?.rect[2] ?? 0
  ).toBeLessThan(566)
})
it('uses a native running separator when the graphics filter already omitted its stroke', () => {
  const f = input()
  f.page.pageNumber = 4
  f.page.lines.push({
    text: '4 Independent running title',
    x: 40,
    y: 30,
    width: 500,
    height: 8,
    fontSize: 8
  })
  const tokens = [
    token('4', [40, 30, 44, 38]),
    token('Independent running title', [410, 30, 540, 38])
  ]
  const proof = nativeFigureRunningHead(f.page, f.captions, tokens, [[40, 48, 540, 48]])
  expect(proof?.lines).toContain(f.page.lines.at(-1))
  for (const reason of ['missing-rule', 'competing-rule', 'caption-in-band', 'image-in-band']) {
    const g = structuredClone(f),
      rules = reason === 'missing-rule' ? [] : [[40, 48, 540, 48]]
    if (reason === 'competing-rule') rules.push([40, 47, 540, 47])
    if (reason === 'caption-in-band') g.captions[0].rect = [40, 30, 540, 38]
    if (reason === 'image-in-band')
      g.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.06, 0.03, 0.95, 0.055] })
    expect(nativeFigureRunningHead(g.page, g.captions, tokens, rules)).toBeUndefined()
  }
})
const categories = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.rules = f.rules.slice(0, 4)
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.tokens = [
    token('Category alpha', [45, 85, 98, 95], 6, false),
    token('Category beta', [50, 120, 98, 130], 6, false),
    token('Category gamma', [48, 155, 98, 165], 6, false),
    token('Axis title', [34, 80, 42, 190], 8, false),
    token('a', [34, 42, 42, 54], 12),
    ...Array.from({ length: 4 }, (_, i) =>
      token(String(i), [105 + i * 35, 242, 109 + i * 35, 248], 6)
    )
  ]
  return f
}
it('keeps repeated slanted categories, adjacent vertical title and their panel marker', () => {
  const f = categories(),
    rect = [99, 60, 270, 260]
  const owned = nativeClosedCategoryLabels(
    f.page,
    f.caption,
    f.captions,
    [],
    rect,
    f.rules,
    f.tokens
  )
  expect(Math.min(...owned.map((r: number[]) => r[0]))).toBe(34)
  expect(Math.min(...owned.map((r: number[]) => r[1]))).toBe(42)
})
it.each([
  'missing-edge',
  'single-category',
  'missing-ticks',
  'ambiguous-title',
  'foreign-prose',
  'table-owner'
])('rejects incomplete category-axis ownership: %s', (reason) => {
  const f = categories()
  if (reason === 'missing-edge') f.rules.pop()
  if (reason === 'single-category')
    f.tokens = f.tokens.filter(
      (t: ReturnType<typeof JSON.parse>) => !['Category beta', 'Category gamma'].includes(t.text)
    )
  if (reason === 'missing-ticks')
    f.tokens = f.tokens.filter((t: ReturnType<typeof JSON.parse>) => !/^[0-9]$/.test(t.text))
  if (reason === 'ambiguous-title') f.tokens.push(token('Second axis', [32, 90, 40, 195], 8, false))
  if (reason === 'foreign-prose')
    f.tokens.push(token('Independent body paragraph text. '.repeat(3), [30, 110, 99, 122], 10))
  expect(
    nativeClosedCategoryLabels(
      f.page,
      f.caption,
      f.captions,
      reason === 'table-owner' ? [[30, 60, 99, 230]] : [],
      [99, 60, 270, 260],
      f.rules,
      f.tokens
    )
  ).toEqual([])
})
it('recognizes only repeated native paragraph continuity above drawing ink', () => {
  const lines = [0, 1, 2, 3].map((i) => ({
    text:
      i === 3
        ? 'Short final line.'
        : 'Independent prose paragraph with many source words in the same printed block.'.repeat(2),
    x: 40,
    y: 40 + i * 13,
    width: i === 3 ? 100 : 440,
    height: 10,
    fontSize: 10
  }))
  expect(nativeTopParagraphTail(lines[3], [70, 110, 470, 250], lines)).toBe(true)
  expect(nativeTopParagraphTail(lines[3], [70, 80, 470, 250], lines)).toBe(false)
  expect(
    nativeTopParagraphTail(
      lines[3],
      [70, 110, 470, 250],
      lines.map((l) => ({ ...l, text: 'Short chart title' }))
    )
  ).toBe(false)
  expect(
    nativeTopParagraphTail(
      lines[3],
      [70, 110, 470, 250],
      lines.filter((_, i) => i !== 1)
    )
  ).toBe(false)
})
const nodes = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 220, 540, 232]
  f.page.lines[0] = {
    text: f.caption.lines[0],
    x: 40,
    y: 220,
    width: 500,
    height: 10,
    fontSize: 10
  }
  f.page.graphicsBounds = []
  f.rules = []
  f.tokens = []
  for (let i = 0; i < 4; i++) {
    const x = 110 + i * 90
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [x / 600, 175 / 800, (x + 10) / 600, 185 / 800]
    })
    f.tokens.push(
      token('Label', [x - 5, 152, x + 15, 160]),
      token('Value', [x - 5, 194, x + 15, 202])
    )
    if (i < 3) f.rules.push([x + 10, 180, x + 90, 180])
  }
  return f
}
it('recovers a sparse aligned native-node diagram with complete upper/lower labels', () => {
  const f = nodes()
  expect(
    nativeAlignedNodeFigure(f.page, f.caption, f.captions, [], f.rules, f.tokens)?.rect
  ).toEqual([105, 152, 395, 202])
})
it.each([
  'missing-connector',
  'missing-upper-label',
  'foreign-prose',
  'table-owner',
  'unaligned-node'
])('declines a sparse chain without full native proof: %s', (reason) => {
  const f = nodes()
  if (reason === 'missing-connector') f.rules = []
  if (reason === 'missing-upper-label') f.tokens.shift()
  if (reason === 'foreign-prose')
    f.tokens.push(token('Independent paragraph. '.repeat(4), [100, 170, 405, 180], 10))
  if (reason === 'unaligned-node') f.page.graphicsBounds[0].normalizedRect[1] -= 0.01
  expect(
    nativeAlignedNodeFigure(
      f.page,
      f.caption,
      f.captions,
      reason === 'table-owner' ? [[100, 170, 405, 205]] : [],
      f.rules,
      f.tokens
    )
  ).toBeUndefined()
})
it('declines disjoint-column ownership without repeated numeric source and curve objects', () => {
  const f = input()
  f.captions.push({ page: 1, lines: ['Figure 2: Adjacent curves.'], rect: [330, 280, 540, 292] })
  expect(nativeDisjointPlotColumn(f.page, f.caption, f.captions, [], [])).toBeUndefined()
})

const columns = (): ReturnType<typeof JSON.parse> => {
  const f = input()
  f.caption.rect = [40, 280, 290, 292]
  f.page.lines[0].width = 250
  f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 4)
  f.page.lines = f.page.lines.slice(0, 7)
  f.captions.push({
    page: 1,
    lines: ['Figure 2: Independent right plot.'],
    rect: [330, 280, 560, 292]
  })
  f.tokens = f.page.lines
    .slice(1)
    .map((l: ReturnType<typeof JSON.parse>) =>
      token(l.text, [l.x, l.y, l.x + l.width, l.y + l.height], l.fontSize)
    )
  return f
}
it('recovers a whole populated column without swallowing the adjacent caption column', () => {
  const f = columns(),
    r = nativeDisjointPlotColumn(f.page, f.caption, f.captions, [], f.tokens)
  expect(r?.rect).toEqual([85, 59, 271, 255])
})
it.each(['missing-ticks', 'missing-curves', 'no-disjoint-caption', 'foreign-prose', 'table-owner'])(
  'declines unproven column ownership: %s',
  (reason) => {
    const f = columns()
    if (reason === 'missing-ticks') f.tokens = []
    if (reason === 'missing-curves') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 1)
    if (reason === 'no-disjoint-caption') f.captions = f.captions.slice(0, 2)
    if (reason === 'foreign-prose')
      f.tokens.push(token('Independent paragraph text. '.repeat(3), [90, 100, 270, 110], 10))
    expect(
      nativeDisjointPlotColumn(
        f.page,
        f.caption,
        f.captions,
        reason === 'table-owner' ? [[100, 100, 250, 220]] : [],
        f.tokens
      )
    ).toBeUndefined()
  }
)

it('keeps a decoded painted raster in its independent caption column despite caption scripts', async () => {
  const { nativeRasterCaptionColumn } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-raster-column.mjs')).href
  )
  const f = input()
  f.caption.rect = [320, 280, 550, 300]
  f.page.lines = [
    { text: f.caption.lines[0], x: 320, y: 280, width: 230, height: 10, fontSize: 10 },
    { text: 'index', x: 380, y: 289, width: 10, height: 6, fontSize: 6 }
  ]
  f.captions[1].rect = [40, 60, 290, 110]
  f.page.graphicsBounds = [
    {
      kind: 'image',
      normalizedRect: [0.5, 0.02, 0.95, 0.34],
      paintedNormalizedRect: [0.55, 0.06, 0.935, 0.33]
    }
  ]
  expect(nativeRasterCaptionColumn(f.page, f.caption, f.captions, [])?.rect).toEqual([
    330, 48, 561, 264
  ])
  const unpainted = structuredClone(f)
  delete unpainted.page.graphicsBounds[0].paintedNormalizedRect
  expect(
    nativeRasterCaptionColumn(unpainted.page, unpainted.caption, unpainted.captions, [])
  ).toBeUndefined()
  expect(
    nativeRasterCaptionColumn(f.page, f.caption, f.captions, [[330, 100, 550, 250]])
  ).toBeUndefined()
  const ambiguous = structuredClone(f)
  ambiguous.captions[1].rect = [330, 80, 540, 110]
  expect(
    nativeRasterCaptionColumn(ambiguous.page, ambiguous.caption, ambiguous.captions, [])
  ).toBeUndefined()
})

const titledGrid = (): ReturnType<typeof JSON.parse> => {
  const page: {
      pageNumber: number
      width: number
      height: number
      lines: ReturnType<typeof JSON.parse>[]
      graphicsBounds: ReturnType<typeof JSON.parse>[]
    } = { pageNumber: 1, width: 600, height: 800, lines: [], graphicsBounds: [] },
    caption = {
      page: 1,
      lines: ['Figure 3: Eight independent complete native panels.'],
      rect: [50, 380, 560, 392]
    },
    frames: number[][] = [],
    rules: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  page.lines.push({ text: caption.lines[0], x: 50, y: 380, width: 510, height: 10, fontSize: 10 })
  for (let n = 0; n < 8; n++) {
    const center = 125 + (n % 4) * 125,
      top = n < 4 ? 70 : 230,
      width = n < 4 ? 110 : 98,
      r = [center - width / 2, top, center + width / 2, top + 100]
    frames.push(r)
    rules.push(
      [r[0], r[1], r[2], r[1]],
      [r[0], r[3], r[2], r[3]],
      [r[0], r[1], r[0], r[3]],
      [r[2], r[1], r[2], r[3]]
    )
    const title = {
      text: String.fromCharCode(97 + n) + ') Native panel',
      x: center - 25,
      y: top - 18,
      width: 50,
      height: 8,
      fontSize: 8
    }
    page.lines.push(title)
    tokens.push(
      token(title.text, [title.x, title.y, title.x + title.width, title.y + title.height], 8)
    )
    for (let i = 0; i < 4; i++)
      page.lines.push({
        text: String(i),
        x: r[0] - 12,
        y: top + 10 + i * 20,
        width: 8,
        height: 8,
        fontSize: 8
      })
    for (let i = 0; i < 3; i++)
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [
          (r[0] + 8 + i * 2) / 600,
          (top + 20 + i * 10) / 800,
          (r[2] - 8) / 600,
          (top + 70 + i * 5) / 800
        ]
      })
  }
  return { page, caption, captions: [caption], frames, rules, tokens }
}

const translatedNineGrid = (): ReturnType<typeof JSON.parse> => {
  const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    caption = {
      page: 1,
      lines: ['Figure 4: Nine independent complete native measurements.'],
      rect: [50, 540, 560, 552]
    },
    frames: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  page.lines.push({ text: caption.lines[0], x: 50, y: 540, width: 510, height: 10, fontSize: 10 })
  for (let column = 0; column < 3; column++)
    for (let row = 0; row < 3; row++) {
      const left = 100 + column * 160,
        top = 100 + row * 150 + [0, 0.8, -1.6][column],
        r = [left, top, left + 110, top + 90]
      frames.push(r)
      for (let i = 0; i < 5; i++) {
        const l = {
          text: String(i),
          x: left - 14,
          y: top + 8 + i * 15,
          width: 6,
          height: 6,
          fontSize: 6
        }
        page.lines.push(l)
        tokens.push(token(l.text, [l.x, l.y, l.x + l.width, l.y + l.height], 6))
      }
      for (let i = 0; i < 3; i++)
        page.graphicsBounds.push({
          kind: 'path',
          normalizedRect: [
            (left + 5 + i) / 600,
            (top + 10 + i * 5) / 800,
            (left + 105) / 600,
            (top + 70 + i * 3) / 800
          ]
        })
    }
  frames.push([110, 40, 520, 60])
  for (const [text, x] of [
    ['Independent series', 130],
    ['Comparison series', 330]
  ] as const) {
    const l = { text, x, y: 45, width: 100, height: 6, fontSize: 6 }
    page.lines.push(l)
    tokens.push(token(text, [x, 45, x + 100, 51], 6))
  }
  return { page, caption, captions: [caption], frames, rules: [], tokens }
}

const compactFacetedGrid = (): ReturnType<typeof JSON.parse> => {
  const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    caption = {
      page: 1,
      lines: ['Figure 1: Independent faceted measurements.'],
      rect: [60, 630, 540, 642]
    },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    viewport = { width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    line = (text: string, rect: number[], font: number): void => {
      page.lines.push({
        text,
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1],
        fontSize: font
      })
      tokens.push({ text, rect, horizontal: true, baseline: rect[3], height: font })
    },
    frame = (rect: number[]): void => {
      const [left, top, right, bottom] = rect,
        y0 = 800 - bottom,
        y1 = 800 - top,
        native = new Float32Array([left, y0, right, y1])
      page.graphicsBounds.push({
        kind: 'path',
        operationIndex: operators.fnArray.length,
        normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
      })
      add(OPS.constructPath, [
        OPS.fillStroke,
        [new Float32Array([0, left, y0, 1, right, y0, 1, right, y1, 1, left, y1, 4])],
        native
      ])
    }
  add(OPS.paintFormXObjectBegin, [
    new Float32Array([1, 0, 0, 1, 0, 0]),
    new Float32Array([0, 0, 600, 800])
  ])
  frame([60, 330, 540, 610])
  line(caption.lines[0], caption.rect, 12)
  for (let c = 0; c < 3; c++) {
    const left = 86 + c * 156,
      right = left + 130,
      carrier = [c === 0 ? 64 : 68 + c * 156, 334, 224 + c * 156, 608]
    frame(carrier)
    line(`Group ${c + 1}`, [left + 30, 340, left + 100, 348], 8)
    line('Measurements', [left + 30, 352, left + 100, 360], 8)
    for (let r = 0; r < 3; r++) {
      const top = 378 + r * 76,
        bottom = top + 58
      frame([left, top, right, bottom])
      frame([left, top - 12, right, top])
      line(`Series ${r + 1}`, [left + 45, top - 9, left + 85, top - 3], 6)
      for (let n = 0; n < 4; n++)
        line(String(80 - n * 20), [left - 13, top + 8 + n * 12, left - 5, top + 14 + n * 12], 6)
      for (let n = 0; n < 3; n++)
        frame([left + 20 + n * 24, bottom - 14 - n * 11, left + 24 + n * 24, bottom])
      if (r === 2) line('0 1 2 3 4', [left + 2, bottom + 4, right - 2, bottom + 10], 6)
    }
  }
  add(OPS.paintFormXObjectEnd, null)
  for (const t of tokens) {
    add(OPS.beginText, null)
    add(OPS.setFont, ['anonymous-font', t.height])
    add(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, t.rect[0], 800 - t.baseline])])
    add(OPS.showText, [
      [...t.text].map((char) => ({
        originalCharCode: char.charCodeAt(0),
        fontChar: char,
        unicode: char,
        width: 100,
        isSpace: char === ' ',
        isInFont: true
      }))
    ])
    add(OPS.endText, null)
  }
  const frames = collectClosedFigureFrames(operators, viewport)
  return {
    page,
    caption,
    captions: [caption],
    tokens,
    frames,
    rules: [],
    owned: [241, 518, 548, 600],
    context: { operators, viewport }
  }
}

it('completes every compact faceted face and whole measured carrier using native operator context', () => {
  const f = compactFacetedGrid(),
    before = structuredClone(f),
    result = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      [],
      f.rules,
      f.frames,
      f.tokens,
      f.owned,
      f.context
    )
  expect(result?.rect).toEqual([60, 330, 548, 610])
  expect(result?.graphicsCount).toBe(9)
  expect(f).toEqual(before)
})

it('forwards compact faceted source context through the actual association consumer', () => {
  const f = compactFacetedGrid(),
    figures = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, f.context)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect[0]).toBeLessThanOrEqual(60)
  expect(figures[0].rect[1]).toBeLessThanOrEqual(330)
  expect(figures[0].rect[3]).toBeGreaterThanOrEqual(610)
  expect(figures[0].graphicsCount).toBe(9)
})

it.each([
  'missing-face',
  'missing-strip',
  'missing-carrier',
  'missing-bar',
  'missing-font',
  'clipped-font',
  'invalid-font-baseline',
  'foreign-row',
  'unknown-paint',
  'oversized-paint',
  'foreign-right-padding-paint',
  'crossing-table',
  'competing-caption',
  'noncanonical-caption',
  'invalid-paint-index',
  'missing-context',
  'unknown-opcode',
  'shading',
  'invisible-text',
  'gstate',
  'type3-zero-program',
  'invalid-glyph-width',
  'reflected-transform',
  'unbalanced-save',
  'missing-form-box',
  'Float64-path',
  'DataView-form-box',
  'unknown-path-command',
  'truncated-path-command',
  'mismatched-viewport',
  'malformed-op-args'
])('refuses incomplete compact faceted source qualification: %s', (reason) => {
  const f = compactFacetedGrid(),
    tables: number[][] = [],
    operators = f.context.operators,
    index = operators.fnArray.indexOf(OPS.constructPath),
    glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0],
    insert = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      const at = operators.fnArray.indexOf(OPS.beginText)
      operators.fnArray.splice(at, 0, op)
      operators.argsArray.splice(at, 0, args)
    }
  if (reason === 'missing-face') f.frames.splice(2, 1)
  if (reason === 'missing-strip') f.frames.splice(3, 1)
  if (reason === 'missing-carrier') f.frames.splice(1, 1)
  if (reason === 'missing-bar') f.frames.splice(4, 1)
  if (reason === 'missing-font') f.tokens.splice(1, 1)
  if (reason === 'clipped-font') f.tokens[1].rect[3] -= 1
  if (reason === 'invalid-font-baseline') f.tokens[1].baseline = NaN
  if (reason === 'foreign-row') {
    f.page.lines.push({
      text: 'Foreign content',
      x: 300,
      y: 520,
      width: 40,
      height: 6,
      fontSize: 6
    })
    f.tokens.push({
      text: 'Foreign content',
      rect: [300, 520, 340, 526],
      height: 6,
      baseline: 526,
      horizontal: true
    })
  }
  if (reason === 'unknown-paint') f.page.graphicsBounds[0].kind = 'shading'
  if (reason === 'oversized-paint') f.page.graphicsBounds[0].normalizedRect[0] = 10 / 600
  if (reason === 'foreign-right-padding-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 9999,
      normalizedRect: [542 / 600, 590 / 800, 547 / 600, 605 / 800]
    })
  if (reason === 'crossing-table') tables.push([60, 350, 120, 400])
  if (reason === 'competing-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 2: Other measurements.'],
      rect: [70, 365, 160, 377]
    })
  if (reason === 'noncanonical-caption') f.caption = structuredClone(f.caption)
  if (reason === 'invalid-paint-index') f.page.graphicsBounds[0].operationIndex = NaN
  if (reason === 'missing-context') f.context = undefined
  if (reason === 'unknown-opcode') insert(999999, null)
  if (reason === 'shading') insert(OPS.shadingFill, ['unobserved-shading'])
  if (reason === 'invisible-text') insert(OPS.setTextRenderingMode, [3])
  if (reason === 'gstate') insert(OPS.setGState, [[['CA', 0]]])
  if (reason === 'type3-zero-program') glyph.operatorListId = 0
  if (reason === 'invalid-glyph-width') glyph.width = NaN
  if (reason === 'reflected-transform') insert(OPS.transform, [-1, 0, 0, 1, 0, 0])
  if (reason === 'unbalanced-save') insert(OPS.save, null)
  if (reason === 'missing-form-box') operators.argsArray[0][1] = null
  if (reason === 'Float64-path')
    operators.argsArray[index][1][0] = new Float64Array(operators.argsArray[index][1][0])
  if (reason === 'DataView-form-box') operators.argsArray[0][1] = new DataView(new ArrayBuffer(16))
  if (reason === 'unknown-path-command') operators.argsArray[index][1][0][0] = 99
  if (reason === 'truncated-path-command')
    operators.argsArray[index][1][0] = new Float32Array([0, 10])
  if (reason === 'mismatched-viewport') f.context.viewport.transform[0] = 1.5
  if (reason === 'malformed-op-args') operators.argsArray.pop()
  const before = structuredClone(f),
    result = nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      tables,
      f.rules,
      f.frames,
      f.tokens,
      f.owned,
      f.context
    )
  expect(result?.graphicsCount).not.toBe(9)
  expect(f).toEqual(before)
})

it('preserves complete legacy association results when compact native context is absent or unsupported', () => {
  const f = compactFacetedGrid(),
    previous = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)
  expect(associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, undefined)).toEqual(
    previous
  )
  f.context.operators.fnArray.unshift(OPS.setTextRenderingMode)
  f.context.operators.argsArray.unshift([3])
  expect(associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens, f.context)).toEqual(
    previous
  )
})

it('retains every populated closed face and complete shared legend in a repeated translated three-by-three array', () => {
  const f = translatedNineGrid(),
    before = structuredClone(f),
    proof = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
  expect(proof?.graphicsCount).toBe(9)
  expect(proof?.rect).toEqual([86, 40, 530, 490.8])
  const associated = associateFigures(f.page, f.captions, [], f.rules, f.frames, f.tokens)
  expect(associated[0].rect[1]).toBeLessThanOrEqual(40)
  expect(associated[0].rect[3]).toBeGreaterThanOrEqual(490.8)
  expect(f).toEqual(before)
})

it.each([
  'missing-face',
  'duplicate-face',
  'unequal-size',
  'nonrepeated-offset',
  'missing-paint',
  'missing-tick-font',
  'missing-orientation',
  'wrong-line-font',
  'clipped-tick-font',
  'missing-legend-font',
  'clipped-legend-font',
  'unframed-legend',
  'competing-legend',
  'unknown-font',
  'foreign-caption',
  'foreign-table',
  'foreign-prose'
])('refuses incomplete translated array or shared legend evidence: %s', (reason) => {
  const f = translatedNineGrid()
  if (reason === 'missing-face') f.frames.splice(0, 1)
  if (reason === 'duplicate-face') f.frames[1] = f.frames[0].slice()
  if (reason === 'unequal-size') f.frames[1][2] += 1
  if (reason === 'nonrepeated-offset') {
    f.frames[1][1] += 1
    f.frames[1][3] += 1
  }
  if (reason === 'missing-paint') f.page.graphicsBounds.splice(0, 3)
  if (reason === 'missing-tick-font') delete f.tokens[0].height
  if (reason === 'missing-orientation') delete f.tokens[0].horizontal
  if (reason === 'wrong-line-font') f.page.lines[1].fontSize = 5
  if (reason === 'clipped-tick-font') f.tokens[0].rect[3] -= 1
  if (reason === 'missing-legend-font') f.tokens.pop()
  if (reason === 'clipped-legend-font') f.tokens.at(-1).rect[3] -= 1
  if (reason === 'unframed-legend') f.frames.pop()
  if (reason === 'competing-legend') f.frames.push([110, 35, 520, 55])
  if (reason === 'unknown-font') f.tokens.push(token('Unowned source', [120, 110, 170, 116], 6))
  if (reason === 'foreign-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 5: Independent native owner.'],
      rect: [100, 150, 510, 162]
    })
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent article paragraph. '.repeat(4),
      x: 100,
      y: 150,
      width: 400,
      height: 10,
      fontSize: 10
    })
  expect(
    nativeCaptionedPlotBand(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[100, 150, 500, 200]] : [],
      f.rules,
      f.frames,
      f.tokens
    )
  ).toBeUndefined()
})

it('retains all eight keyed closed plots with independently sized rows', () => {
  const f = titledGrid(),
    before = structuredClone(f),
    result = nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
  expect(result?.graphicsCount).toBe(8)
  for (const frame of f.frames) {
    expect(result?.rect[0]).toBeLessThanOrEqual(frame[0])
    expect(result?.rect[1]).toBeLessThanOrEqual(frame[1] - 18)
    expect(result?.rect[2]).toBeGreaterThanOrEqual(frame[2])
    expect(result?.rect[3]).toBeGreaterThanOrEqual(frame[3])
  }
  expect(f).toEqual(before)
})

it('binds each complete native title from its separate panel key and title glyph boxes', () => {
  const f = titledGrid()
  f.tokens = f.tokens.flatMap((item: ReturnType<typeof JSON.parse>) => [
    {
      ...item,
      text: item.text.slice(0, 2),
      rect: [item.rect[0], item.rect[1], item.rect[0] + 8, item.rect[3]]
    },
    {
      ...item,
      text: item.text.slice(3),
      rect: [item.rect[0] + 10, item.rect[1], item.rect[2], item.rect[3]]
    }
  ])
  const before = structuredClone(f)
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
      ?.graphicsCount
  ).toBe(8)
  expect(f).toEqual(before)
  f.tokens[1].rect[2] += 1
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
      ?.graphicsCount
  ).not.toBe(8)
})

it.each([
  'short-bottom',
  'short-top',
  'short-width',
  'wrong-height',
  'missing-height',
  'nonfinite-height',
  'missing-baseline',
  'nonfinite-baseline',
  'detached-baseline',
  'short-split-fragment'
])('requires complete native font geometry for each closed-grid title: %s', (reason) => {
  const f = titledGrid(),
    title = f.tokens[0]
  if (reason === 'short-bottom') title.rect[3] -= 1
  if (reason === 'short-top') title.rect[1] += 0.1
  if (reason === 'short-width') title.rect[2] -= 1
  if (reason === 'wrong-height') title.height = 1
  if (reason === 'missing-height') delete title.height
  if (reason === 'nonfinite-height') title.height = NaN
  if (reason === 'missing-baseline') delete title.baseline
  if (reason === 'nonfinite-baseline') title.baseline = NaN
  if (reason === 'detached-baseline') title.baseline -= 1
  if (reason === 'short-split-fragment') {
    f.tokens.splice(
      0,
      1,
      {
        ...title,
        text: 'a)',
        rect: [title.rect[0], title.rect[1], title.rect[0] + 8, title.rect[3]]
      },
      {
        ...title,
        text: 'Native panel',
        rect: [title.rect[0] + 10, title.rect[1], title.rect[2], title.rect[3] - 1]
      }
    )
  }
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames, f.tokens)
      ?.graphicsCount
  ).not.toBe(8)
})

it.each([
  'missing-key',
  'duplicate-key',
  'nonserial-key',
  'missing-side',
  'foreign-caption',
  'foreign-table',
  'foreign-prose',
  'unpopulated-face',
  'misaligned-center'
])('requires complete independently keyed closed-grid ownership: %s', (reason) => {
  const f = titledGrid()
  if (reason === 'missing-key') {
    f.tokens.shift()
    f.page.lines.splice(1, 1)
  }
  if (reason === 'duplicate-key') f.tokens.push(structuredClone(f.tokens[0]))
  if (reason === 'nonserial-key') {
    f.tokens[0].text = 'j) Native panel'
    f.page.lines[1].text = f.tokens[0].text
  }
  if (reason === 'missing-side') {
    f.rules.splice(3, 1)
    f.frames.shift()
  }
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 4: Foreign panels.'], rect: [70, 185, 555, 197] })
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'A separate complete article paragraph crosses the claimed plot corridor.',
      x: 70,
      y: 185,
      width: 485,
      height: 10,
      fontSize: 10
    })
  if (reason === 'unpopulated-face') f.page.graphicsBounds.splice(0, 3)
  if (reason === 'misaligned-center') {
    f.tokens[0].rect[0] -= 25
    f.tokens[0].rect[2] -= 25
    f.page.lines[1].x -= 25
  }
  const result = nativeCaptionedPlotBand(
    f.page,
    f.caption,
    f.captions,
    reason === 'foreign-table' ? [[70, 185, 555, 210]] : [],
    f.rules,
    f.frames,
    f.tokens
  )
  expect(result?.graphicsCount).not.toBe(8)
})

const twoCurveStack = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 1. Top: first measurement. Bottom: second measurement.'],
    rect: [50, 310, 300, 330]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 50, y: 310, width: 250, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const frames = [
    [100, 70, 280, 170],
    [100, 180, 280, 280]
  ]
  const rules: number[][] = []
  for (const [left, top, right, bottom] of frames) {
    rules.push(
      [left, top, right, top],
      [left, bottom, right, bottom],
      [left, top, left, bottom],
      [right, top, right, bottom]
    )
    for (const rect of [
      [left, top, right, bottom],
      [left + 10, top + 10, right - 10, bottom - 20],
      [left + 10, top + 15, right - 10, bottom - 10]
    ]) {
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    }
    for (let i = 0; i < 4; i++)
      page.lines.push({
        text: String(i),
        x: 80,
        y: top + 10 + i * 20,
        width: 8,
        height: 8,
        fontSize: 8
      })
  }
  return { page, caption, captions: [caption], rules, frames }
}

it('recovers two native closed curve faces explicitly named top and bottom', () => {
  const f = twoCurveStack(),
    snapshot = structuredClone(f)
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames)?.rect
  ).toEqual([80, 70, 280, 280])
  expect(f).toEqual(snapshot)
})

it.each([
  'no layout wording',
  'missing native frame',
  'unequal frame',
  'only one curve',
  'foreign caption'
])('does not infer a two-curve stack with %s', (reason) => {
  const f = twoCurveStack()
  if (reason === 'no layout wording') f.caption.lines = ['Figure 1. Two measurements.']
  if (reason === 'missing native frame') f.frames.pop()
  if (reason === 'unequal frame') f.frames[1][2] -= 10
  if (reason === 'only one curve') f.page.graphicsBounds.splice(2, 1)
  if (reason === 'foreign caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Another owner.'], rect: [100, 172, 280, 179] })
  expect(
    nativeCaptionedPlotBand(f.page, f.caption, f.captions, [], f.rules, f.frames)
  ).toBeUndefined()
})

const openSpineStrip = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 1: Independent response panels.'],
    rect: [40, 230, 560, 240]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 40, y: 230, width: 520, height: 10, fontSize: 10 }],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const rules: number[][] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  for (const [index, left] of [70, 200, 330, 460].entries()) {
    for (const y of [100, 120, 140, 160, 180]) rules.push([left, y, left + 90, y])
    rules.push([left, 100, left, 180])
    if (index >= 2) rules.push([left + 90, 100, left + 90, 180])
    page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [left, 100, left + 90, 180].map((v, axis) => v / (axis % 2 ? 800 : 600))
    })
    const text = `Panel ${String.fromCharCode(65 + index)}`
    page.lines.push({ text, x: left + 25, y: 87, width: 40, height: 8, fontSize: 8 })
    tokens.push({
      text,
      rect: [left + 25, 87, left + 65, 95],
      height: 8,
      baseline: 95,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })
    for (let n = 0; n < 5; n++)
      page.lines.push({
        text: String(n),
        x: left - 9,
        y: 105 + n * 15,
        width: 5,
        height: 6,
        fontSize: 6
      })
    for (let n = 0; n < 6; n++)
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [left + 5 + n, 110 + n, left + 85 - n, 175 - n].map(
          (v, axis) => v / (axis % 2 ? 800 : 600)
        )
      })
  }
  page.lines.push({
    text: 'Common horizontal axis',
    x: 230,
    y: 190,
    width: 140,
    height: 8,
    fontSize: 8
  })
  return { page, caption, captions: [caption], rules, tokens }
}
it('keeps independently titled open-spine panels when a later closed-face match owns only a subset', () => {
  const f = openSpineStrip(),
    before = structuredClone(f)
  const result = associateFigures(f.page, f.captions, [], f.rules, [], f.tokens)
  expect(result).toHaveLength(1)
  expect(result[0].rect[0]).toBeLessThanOrEqual(70)
  expect(result[0].rect[2]).toBeGreaterThanOrEqual(550)
  expect(result[0].rect[1]).toBeLessThanOrEqual(87)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(198)
  expect(f).toEqual(before)
})
it.each([
  'unproved-omitted-axes',
  'unproved-omitted-titles',
  'duplicate-title',
  'foreign-caption',
  'foreign-table',
  'no-omitted-face'
])('keeps the ordinary completion path when omitted-strip evidence is incomplete: %s', (mode) => {
  const f = openSpineStrip(),
    old = { reason: 'native-vector-chart-strip', caption: f.caption, rect: [61, 87, 550, 198] },
    closed = { rect: [321, 87, 550, 198] }
  if (mode === 'unproved-omitted-axes')
    f.rules = f.rules.filter((r: number[]) => !(r[0] < 330 && r[0] === r[2]))
  if (mode === 'unproved-omitted-titles') f.tokens.splice(0, 2)
  if (mode === 'duplicate-title')
    f.tokens.push({ ...f.tokens[0], sourceItem: { ...f.tokens[0].sourceItem, index: 99 } })
  if (mode === 'foreign-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 2: Independent object.'],
      rect: [80, 110, 150, 125]
    })
  if (mode === 'no-omitted-face') closed.rect = [61, 87, 550, 198]
  expect(
    nativePlotStripHasOmittedAxes(
      f.page,
      old,
      closed,
      f.captions,
      mode === 'foreign-table' ? [[80, 110, 150, 125]] : [],
      f.rules,
      f.tokens
    )
  ).toBe(false)
})
const vectorOverIndependentRaster = (): ReturnType<typeof JSON.parse> => {
  const captions = [
    { page: 1, lines: ['Figure 1: Measured response curves.'], rect: [60, 250, 300, 260] },
    { page: 1, lines: ['Figure 2: Independent raster surface.'], rect: [60, 440, 300, 450] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: c.rect[2] - c.rect[0],
      height: 10,
      fontSize: 10
    })),
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const add = (kind: string, r: number[]): void => {
    page.graphicsBounds.push({ kind, normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 600)) })
  }
  add('path', [80, 60, 280, 225])
  for (let n = 0; n < 9; n++) add('path', [85 + n, 65 + n, 275 - n, 220 - n])
  for (let n = 0; n < 5; n++)
    page.lines.push({ text: String(n), x: 65, y: 80 + n * 30, width: 8, height: 8, fontSize: 8 })
  page.lines.push({
    text: 'Measured response axis',
    x: 100,
    y: 230,
    width: 160,
    height: 8,
    fontSize: 8
  })
  add('path', [80, 270, 280, 430])
  add('image', [80, 270, 280, 430])
  return { page, captions }
}
it('recovers the proved upper vector chart after rejecting a lower raster with its own owner', () => {
  const f = vectorOverIndependentRaster(),
    before = structuredClone(f)
  const result = associateFigures(f.page, f.captions)
  expect(result).toHaveLength(2)
  expect(result[0].rect).toEqual([65, 60, 280, 238])
  expect(result[1].rect).toEqual([80, 270, 280, 430])
  expect(f).toEqual(before)
})
const { nativeUpperVectorAfterRasterConflict } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
it.each([
  'missing-owner',
  'different-owner-rect',
  'unproved-upper-chart',
  'foreign-label-table',
  'foreign-label-caption'
])('retains no-crop when the upper-chart recovery lacks independent proof: %s', (mode) => {
  const f = vectorOverIndependentRaster(),
    rect = [80, 270, 280, 430],
    upper = { caption: f.captions[0], rect },
    lower = { caption: f.captions[1], rect: [...rect] }
  if (mode === 'foreign-label-caption')
    f.captions.push({ page: 1, lines: ['Figure 3: Independent label.'], rect: [64, 80, 79, 88] })
  if (mode === 'missing-owner') Object.defineProperty(lower, 'rect', { value: undefined })
  if (mode === 'different-owner-rect') lower.rect[0]++
  if (mode === 'unproved-upper-chart')
    f.page.graphicsBounds = f.page.graphicsBounds.filter(
      (g: { normalizedRect: number[] }) => g.normalizedRect[1] >= 270 / 800
    )
  expect(
    nativeUpperVectorAfterRasterConflict(
      f.page,
      upper,
      lower,
      [upper, lower],
      f.captions,
      mode === 'foreign-label-table' ? [[64, 80, 79, 100]] : [],
      [],
      undefined
    )
  ).toBeUndefined()
})

// The two renderer groups have separate closed clips and source captions.
// One borrowed path is enough for the generic mixed strip to absorb its peer.
function disjointMixedGroups(foreignText = false): ReturnType<typeof JSON.parse> {
  const captions = [
    { page: 1, lines: ['Figure 1: Mixed measurements.'], rect: [320, 312, 560, 390] },
    { page: 1, lines: ['Figure 2: Independent curves.'], rect: [40, 342, 280, 420] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: 240,
      height: 10,
      fontSize: 10
    })),
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const context = {
    viewport: { width: 600, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    operators: { fnArray: [] as number[], argsArray: [] as unknown[] },
    graphicsBounds: page.graphicsBounds,
    content: {
      items: [] as ReturnType<typeof JSON.parse>[],
      styles: { face: { ascent: 0.8, descent: -0.2 } }
    }
  }
  const emit = (op: number, args: unknown = null): number => {
    context.operators.fnArray.push(op)
    return context.operators.argsArray.push(args) - 1
  }
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const text = (value: string, x: number, y: number): void => {
    emit(OPS.beginText)
    emit(OPS.setFont, ['face', 10])
    emit(OPS.setTextMatrix, [1, 0, 0, 1, x, 800 - y - 10])
    emit(OPS.showText, [Array.from(value, (unicode) => ({ unicode, width: 500 }))])
    emit(OPS.endText)
    const index = context.content.items.length,
      rect = [x, y, x + value.length * 5, y + 10],
      sourceItem = { pageNumber: 1, index, text: value }
    context.content.items.push({
      str: value,
      dir: 'ltr',
      fontName: 'face',
      width: value.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, 800 - y - 10],
      sourceItem
    })
    tokens.push({
      text: value,
      rect,
      nativeLabelRect: rect,
      height: 10,
      horizontal: true,
      sourceItem
    })
  }
  for (const [column, bottom] of [
    [40, 330],
    [320, 300]
  ]) {
    const group = {
      matrix: null,
      bbox: [column, 800 - bottom, column + 240, 740],
      smask: null,
      isolated: false,
      knockout: false
    }
    emit(OPS.beginGroup, [group])
    emit(OPS.paintFormXObjectBegin, [null, null])
    const add = (kind: string, rect: number[]): void => {
      const operationIndex = emit(
        kind === 'image' ? OPS.paintImageXObject : OPS.constructPath,
        kind === 'image'
          ? ['image', 10, 10]
          : [
              OPS.stroke,
              [[0, rect[0], 800 - rect[1], 1, rect[2], 800 - rect[3]]],
              [rect[0], 800 - rect[3], rect[2], 800 - rect[1]]
            ]
      )
      page.graphicsBounds.push({
        operationIndex,
        kind,
        normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
      })
    }
    if (column === 40) add('path', [60, 70, 270, 300])
    else {
      add('image', [330, 65, 390, 295])
      for (let n = 0; n < 12; n++) add('path', [420 + n, 70 + n, 550 - n, 270 - n])
    }
    text(column === 40 ? 'Peer' : 'Axis', column + 219.9, 100)
    emit(OPS.paintFormXObjectEnd, [])
    emit(OPS.endGroup, [group])
  }
  for (const c of captions) text(c.lines[0], c.rect[0], c.rect[1])
  if (foreignText) text('Note', 552, 80)
  return { page, captions, context, tokens }
}
it.each([1, 1.5])('uses the complete renderer clip with native token scale=%s', (scale) => {
  const f = disjointMixedGroups(),
    before = structuredClone(f)
  for (const t of f.tokens) t.rect = t.rect.map((v: number) => (v * scale) / scale)
  if (scale === 1.5) {
    for (const [i, op] of f.context.operators.fnArray.entries()) {
      if (op !== OPS.constructPath) continue
      const a = f.context.operators.argsArray[i]
      a[1][0] = Float32Array.from(a[1][0])
      a[2] = Float32Array.from(a[2])
    }
  }
  const supplied = structuredClone(f),
    result = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context),
    own = result.find((r: { caption: unknown }) => r.caption === f.captions[0])
  expect(own.rect).toEqual([320, 60, 560, 300])
  expect(f).toEqual(supplied)
  expect(before.context.content).toEqual(f.context.content)
})
const { nativeDisjointMixedFigureGroup, nativeSingleVectorGroupPng } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
)

// The numeric ticks can be vector paths. A complete renderer group, rather
// than a guessed text-tick column, owns the keys and rotated source title.
function singleVectorGroup(drawing = false, paired = false): ReturnType<typeof JSON.parse> {
  const title = drawing
      ? paired
        ? 'Figure 1. Drawings of (a) mount A and (b) B. Dimensions are in mm.'
        : 'Figure 1. Drawings of (a) mount A and (b) mount B. Dimensions are in mm.'
      : 'Figure 1. Independent native panels and their axes.',
    right = 50 + title.length * 3.75,
    page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    context = {
      viewport: {
        width: 600,
        height: 800,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800]
      },
      operators: { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] },
      graphicsBounds: page.graphicsBounds,
      content: {
        items: [] as ReturnType<typeof JSON.parse>[],
        styles: { face: { ascent: 0.8, descent: -0.2 } }
      },
      glyphBounds: [{ fontName: 'face', glyphs: [] as ReturnType<typeof JSON.parse>[] }]
    },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    emit = (op: number, args: unknown = null): number => {
      context.operators.fnArray.push(op)
      return context.operators.argsArray.push(args) - 1
    },
    text = (value: string, x: number, y: number, size = 10, rotated = false): void => {
      const width = (value.length * size) / 2,
        transform = rotated
          ? [0, size, -size, 0, x + size, 800 - y - width]
          : [size, 0, 0, size, x, 800 - y - size],
        basis = transform.map((v, n) => (n < 4 ? v / size : v))
      emit(OPS.beginText)
      emit(OPS.setFont, ['face', size])
      emit(OPS.setTextMatrix, basis)
      emit(OPS.showText, [
        Array.from(value, (unicode) => {
          const glyphs = context.glyphBounds[0].glyphs
          if (!glyphs.some((g) => g.fontChar === unicode))
            glyphs.push({ fontChar: unicode, bounds: [0, -0.2, 0.5, 0.8] })
          return { unicode, fontChar: unicode, width: 500, isInFont: true }
        })
      ])
      emit(OPS.endText)
      const index = context.content.items.length,
        sourceItem = { pageNumber: 1, index, text: value },
        rect = rotated ? [x, y, x + size, y + width] : [x, y, x + width, y + size]
      context.content.items.push({
        str: value,
        dir: 'ltr',
        fontName: 'face',
        width,
        height: size,
        transform,
        sourceItem
      })
      tokens.push({
        text: value,
        sourceItem,
        rect,
        height: size,
        baseline: rect[3],
        horizontal: !rotated,
        fontAscent: 0.8,
        fontDescent: -0.2
      })
      page.lines.push({
        text: value,
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1],
        fontSize: size,
        horizontal: !rotated
      })
    }
  text('Article heading', 50, 20)
  const group = {
    matrix: null,
    bbox: [50, 240, right, 740],
    smask: null,
    isolated: false,
    knockout: false
  }
  emit(OPS.beginGroup, [group])
  emit(OPS.paintFormXObjectBegin, [null, null])
  for (const [n, y] of (drawing ? [100, 350] : [100, 250, 400]).entries()) {
    for (let k = 0; k < (drawing ? 6 : 4); k++) {
      const rect = [130 + k, y + k, right - 20 - k, y + 100 - k],
        operationIndex = emit(OPS.constructPath, [
          OPS.stroke,
          [Float32Array.from([0, rect[0], 800 - rect[1], 1, rect[2], 800 - rect[3]])],
          Float32Array.from([rect[0], 800 - rect[3], rect[2], 800 - rect[1]])
        ])
      page.graphicsBounds.push({
        operationIndex,
        kind: 'path',
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    }
    if (paired) {
      text(`(${String.fromCharCode(97 + n)})`, 60, y - 30)
      text('11', 180, y + 20, 8)
      text('9', 210, y + 40, 8)
      text('7', 240, y + 60, 8)
    }
    text(
      drawing ? ['Mount A', 'Mount B'][n] : `(${String.fromCharCode(97 + n)})`,
      80,
      y - (drawing ? 30 : 10)
    )
  }
  if (!drawing) text('Bridge voltage', 89, 420, 9, true)
  emit(OPS.paintFormXObjectEnd)
  emit(OPS.endGroup, [group])
  text(title, 50, 572, 7.5)
  const caption = { page: 1, lines: [title], rect: [50, 572, right, 579.5] }
  return { page, context, tokens, caption, captions: [caption], rect: [50, 60, right, 560] }
}

it('retains two independently proved engineering prefix and header rows', () => {
  const f = singleVectorGroup(true, true),
    before = structuredClone(f),
    result = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(result[0].rect).toEqual(f.rect)
  expect(result[0].reason).toBe('native-single-vector-group')
  expect(result[0].sourceItems).toBeUndefined()
  expect(result[0].fallbackFigure.rect).toEqual([130, 100, 277.5, 450])
  expect(result[0].fallbackFigure.fallbackFigure).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'unloaded-key',
  'missing-key-outline',
  'duplicate-source',
  'unproved-group',
  'foreign-table',
  'foreign-caption',
  'not-engineering',
  'no-dimensions',
  'unpaired-header'
])('keeps the ordinary crop without complete paired engineering evidence: %s', (mode) => {
  const f = singleVectorGroup(true, true),
    o = f.context.operators,
    keyShow = o.fnArray.findIndex(
      (op: number, i: number) =>
        op === OPS.showText && o.argsArray[i][0].map((g) => g.unicode ?? '').join('') === '(a)'
    )
  let tables: number[][] = []
  if (mode === 'unloaded-key') o.argsArray[keyShow][0][1].isInFont = false
  if (mode === 'missing-key-outline')
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g) => g.fontChar !== '('
    )
  if (mode === 'duplicate-source')
    f.tokens.push(structuredClone(f.tokens.find((t) => t.text === '(a)')))
  if (mode === 'unproved-group') o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].knockout = true
  if (mode === 'foreign-table') tables = [[50, 60, 70, 80]]
  if (mode === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [50, 60, 70, 80] })
  if (mode === 'not-engineering') f.caption.lines = ['Figure 1. Paired panels.']
  if (mode === 'no-dimensions') {
    // Preserve the complete native packet program while replacing dimension semantics.
    for (const raw of f.context.content.items)
      if (['11', '9', '7'].includes(raw.str)) {
        raw.str = raw.str.replace(/\d/g, 'q')
        raw.sourceItem.text = raw.str
      }
    for (const token of f.tokens)
      if (['11', '9', '7'].includes(token.text)) {
        token.text = token.text.replace(/\d/g, 'q')
        token.sourceItem.text = token.text
      }
    for (const [i, op] of o.fnArray.entries())
      if (op === OPS.showText)
        for (const glyph of o.argsArray[i][0])
          if (/^[179]$/.test(glyph.unicode ?? '')) glyph.unicode = 'q'
  }
  if (mode === 'unpaired-header') {
    // A title packet remains complete, but is no longer alongside its key.
    const raw = f.context.content.items.find((r) => r.str === 'Mount B'),
      token = f.tokens.find((t) => t.text === 'Mount B'),
      show = o.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText &&
          o.argsArray[i][0].map((g) => g.unicode ?? '').join('') === 'Mount B'
      )
    raw.transform[4] += 30
    token.rect[0] += 30
    token.rect[2] += 30
    o.argsArray[show - 1][0] += 30
  }
  const result = associateFigures(f.page, f.captions, tables, [], [], f.tokens, f.context)
  expect(result[0]?.reason).not.toBe('native-single-vector-group')
})

it('retains complete caption-named drawing titles through the original independent native group', () => {
  const f = singleVectorGroup(true),
    before = structuredClone(f),
    result = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(result[0].rect).toEqual(f.rect)
  expect(result[0].reason).toBe('native-single-vector-group')
  expect(result[0].sourceItems).toBeUndefined()
  expect(result[0].fallbackFigure.rect).toEqual([130, 100, 300, 450])
  expect(result[0].fallbackFigure.fallbackFigure).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'abbreviated-name',
  'duplicate-owner',
  'different-font',
  'unloaded-title',
  'unproved-group',
  'outside-ink',
  'foreign-table',
  'foreign-caption'
])('keeps the ordinary drawing crop when caption-named ownership is incomplete: %s', (mode) => {
  const f = singleVectorGroup(true),
    o = f.context.operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : []))
  let tables: number[][] = []
  if (mode === 'abbreviated-name' || mode === 'duplicate-owner') {
    // Keep the entire changed caption packet/source/geometry coherent so
    // rejection proves the title naming gate, not a stale source mismatch.
    const text = f.caption.lines[0].replace(
        '(b) mount B',
        mode === 'abbreviated-name' ? '(b) B' : '(b) mount A'
      ),
      raw = f.context.content.items.at(-1),
      token = f.tokens.at(-1),
      line = f.page.lines.at(-1),
      width = (text.length * raw.height) / 2
    raw.str = raw.sourceItem.text = token.text = token.sourceItem.text = line.text = text
    raw.width = line.width = width
    token.rect[2] = token.rect[0] + width
    f.caption.lines = [text]
    f.caption.rect[2] = f.caption.rect[0] + width
    o.argsArray[shows.at(-1)!] = [
      Array.from(text, (unicode) => ({ unicode, fontChar: unicode, width: 500, isInFont: true }))
    ]
  }
  if (mode === 'different-font') {
    f.context.content.items[2].fontName = 'other'
    f.context.content.styles.other = { ...f.context.content.styles.face }
    f.context.glyphBounds.push({
      fontName: 'other',
      glyphs: structuredClone(f.context.glyphBounds[0].glyphs)
    })
    o.argsArray[shows[2] - 2] = ['other', 10]
  }
  if (mode === 'unloaded-title') o.argsArray[shows[1]][0][0].isInFont = false
  if (mode === 'unproved-group') o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].smask = {}
  if (mode === 'outside-ink')
    f.context.glyphBounds[0].glyphs.find(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'A'
    ).bounds = [0, -20, 0.5, 0.8]
  if (mode === 'foreign-table') tables = [[100, 200, 180, 212]]
  if (mode === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [100, 200, 180, 212] })
  const result = associateFigures(f.page, f.captions, tables, [], [], f.tokens, f.context)
  expect(result.some((r) => r.reason === 'native-single-vector-group')).toBe(false)
})

it('preserves all native group keys and a rotated axis when ticks are painted paths', () => {
  const f = singleVectorGroup(),
    before = structuredClone(f),
    result = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(result[0].rect).toEqual(f.rect)
  expect(result[0].reason).toBe('native-single-vector-group')
  expect(result[0].sourceItems).toBeUndefined()
  expect(result[0].fallbackFigure.rect).toEqual([130, 100, 221.25, 500])
  expect(result[0].fallbackFigure.fallbackFigure).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'missing-source',
  'missing-key',
  'unknown-paint',
  'unbalanced',
  'soft-mask',
  'foreign-font',
  'missing-outline',
  'foreign-ink',
  'table-owner',
  'foreign-caption'
])('declines a single vector group without complete independent proof: %s', (mode) => {
  const f = singleVectorGroup(),
    o = f.context.operators
  let tables: number[][] = []
  if (mode === 'missing-source') f.context.content.items[1].sourceItem.index = 99
  if (mode === 'missing-key') {
    f.tokens[1].text = f.tokens[1].sourceItem.text = f.context.content.items[1].str = '(z)'
    const packet =
      o.argsArray[o.fnArray.indexOf(OPS.showText, o.fnArray.indexOf(OPS.beginGroup))][0]
    packet[1].unicode = packet[1].fontChar = 'z'
    f.context.glyphBounds[0].glyphs.push({ fontChar: 'z', bounds: [0, -0.2, 0.5, 0.8] })
  }
  if (mode === 'unknown-paint') o.fnArray[o.fnArray.indexOf(OPS.constructPath)] = OPS.shadingFill
  if (mode === 'unbalanced') o.fnArray[o.fnArray.indexOf(OPS.endGroup)] = OPS.restore
  if (mode === 'soft-mask') o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].smask = {}
  if (mode === 'foreign-font') o.argsArray[o.fnArray.indexOf(OPS.showText)][0][0].isInFont = false
  if (mode === 'missing-outline') f.context.glyphBounds[0].glyphs = []
  if (mode === 'foreign-ink')
    f.context.glyphBounds[0].glyphs.find(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'A'
    ).bounds = [0, -20, 0.5, 0.8]
  if (mode === 'table-owner') tables = [[100, 100, 200, 200]]
  if (mode === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [80, 100, 160, 112] })
  const results = associateFigures(f.page, f.captions, tables, [], [], f.tokens, f.context)
  expect(results.some((r) => r.reason === 'native-single-vector-group')).toBe(false)
})

it('validates the actual single-group PNG halo at both initial and retried scales', () => {
  const f = singleVectorGroup(),
    candidate = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)[0],
    png = (scale: number): Uint8Array => {
      const b = Buffer.alloc(33)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b)
      b.writeUInt32BE(13, 8)
      b.write('IHDR', 12)
      b.writeUInt32BE(Math.ceil((f.rect[2] - f.rect[0]) * scale), 16)
      b.writeUInt32BE(Math.ceil((f.rect[3] - f.rect[1]) * scale), 20)
      return b
    }
  expect(nativeSingleVectorGroupPng(png(4), candidate)).toBe(true)
  expect(nativeSingleVectorGroupPng(png(0.8), candidate)).toBe(true)
  // This outside loaded ink misses the exact group by .005pt, but lies in
  // the canvas/antialiasing halo. A clip alone cannot authorize publication.
  const near = structuredClone(candidate)
  near.groupRasterProof.outsideInk.push([49.98, 100, 49.995, 110])
  expect(nativeSingleVectorGroupPng(png(4), near)).toBe(false)
  expect(nativeSingleVectorGroupPng(png(0.8), near)).toBe(false)
  expect(nativeSingleVectorGroupPng(new Uint8Array(32), candidate)).toBe(false)
})

const { nativeCaptionedFormScope, nativeCaptionedFormPixelCrop, nativeCaptionedFormPixelPngSafe } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-form.mjs')).href
  )

// One native Form and one independent article rule reproduce a borrowed
// paragraph. Its exact clip owns the picture, without claiming its labels.
function captionedVectorForm(bottom = 180): ReturnType<typeof JSON.parse> {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [] as ReturnType<typeof JSON.parse>[],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const context = {
    viewport: { width: 600, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    operators: { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] },
    graphicsBounds: page.graphicsBounds,
    content: {
      items: [] as ReturnType<typeof JSON.parse>[],
      styles: { face: { ascent: 0.8, descent: -0.2 } }
    },
    glyphBounds: [{ fontName: 'face', glyphs: [] as ReturnType<typeof JSON.parse>[] }]
  }
  const tokens: ReturnType<typeof JSON.parse>[] = [],
    glyphs = context.glyphBounds[0].glyphs,
    emit = (op: number, args: unknown = null): number => {
      context.operators.fnArray.push(op)
      return context.operators.argsArray.push(args) - 1
    },
    text = (value: string, x: number, y: number): void => {
      emit(OPS.beginText)
      emit(OPS.setFont, ['face', 10])
      emit(OPS.setTextMatrix, [1, 0, 0, 1, x, 800 - y - 10])
      emit(OPS.showText, [
        Array.from(value, (unicode) => {
          if (!glyphs.some((g) => g.fontChar === unicode))
            glyphs.push({ fontChar: unicode, bounds: [0, -0.2, 0.5, 0.8] })
          return { unicode, fontChar: unicode, width: 500, isInFont: true }
        })
      ])
      emit(OPS.endText)
      const index = context.content.items.length,
        sourceItem = { pageNumber: 1, index, text: value },
        rect = [x, y, x + value.length * 5, y + 10]
      context.content.items.push({
        str: value,
        dir: 'ltr',
        fontName: 'face',
        width: value.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, 800 - y - 10],
        sourceItem
      })
      tokens.push({
        text: value,
        rect,
        height: 10,
        baseline: y + 10,
        horizontal: true,
        fontAscent: 0.8,
        fontDescent: -0.2,
        sourceItem
      })
      page.lines.push({ text: value, x, y, width: value.length * 5, height: 10, fontSize: 10 })
    },
    path = (rect: number[]): void => {
      const operationIndex = emit(OPS.constructPath, [
        OPS.stroke,
        [Float32Array.from([0, rect[0], 800 - rect[1], 1, rect[2], 800 - rect[3]])],
        Float32Array.from([rect[0], 800 - rect[3], rect[2], 800 - rect[1]])
      ])
      page.graphicsBounds.push({
        operationIndex,
        kind: 'path',
        normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
      })
    }
  text('Neighbor paragraph and explanation', 50, 100)
  path([210, 150, 270, 151])
  emit(OPS.paintFormXObjectBegin, [null, Float32Array.from([320, 800 - bottom, 560, 740])])
  for (let n = 0; n < 3; n++) path([330 + n, 70 + n, 550 - n, bottom - 10 - n])
  text('Value', 350, 110)
  emit(OPS.paintFormXObjectEnd)
  const caption = {
    page: 1,
    lines: ['Figure 1: Complete native vector panel example.'],
    rect: [320, bottom + 0.1, 555, bottom + 10.1]
  }
  text(caption.lines[0], 320, bottom + 0.1)
  const figure = { caption, rect: [210, 70, 550, bottom - 10], graphicsCount: 4 }
  return { page, context, tokens, caption, captions: [caption], figure }
}

it('isolates a whole captioned Form at the actual association seam without claiming text', () => {
  const f = captionedVectorForm(),
    before = structuredClone(f)
  for (const token of f.tokens) token.rect = token.rect.map((v: number) => (v * 1.5) / 1.5)
  const result = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(result).toEqual([
    {
      ...f.figure,
      rect: [320, 60, 560, 180],
      graphicsCount: 3,
      raster: {
        scale: 4,
        pixelWidth: 960,
        pixelHeight: 480,
        protection: [319.75, 59.75, 560.25, 180.25]
      },
      reason: 'native-captioned-form-scope',
      fallbackFigure: f.figure
    }
  ])
  expect(result[0].sourceItems).toBeUndefined()
  expect(f.page).toEqual(before.page)
  expect(f.context).toEqual(before.context)
})

// The pixel-only family keeps large Forms separate from Source ownership.
function pixelOnlyVectorForm(): ReturnType<typeof JSON.parse> {
  const f = captionedVectorForm(300)
  f.context.partialFontGlyphBounds = f.context.glyphBounds
  delete f.context.glyphBounds
  f.context.pageNumber = 1
  f.context.sourceSha256 = 'a'.repeat(64)
  return f
}

function formPixelPng(rect: number[], scale = 4): Uint8Array {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(Math.ceil((rect[2] - rect[0]) * scale), 16)
  bytes.writeUInt32BE(Math.ceil((rect[3] - rect[1]) * scale), 20)
  return bytes
}

it('preserves a complete large Form as pixels while keeping exterior fonts and source claims strict', () => {
  const f = pixelOnlyVectorForm(),
    before = structuredClone(f),
    plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  expect(plan).toEqual({ rect: [319.5, 59.5, 560.5, 300.5] })
  expect(nativeCaptionedFormPixelPngSafe(plan, formPixelPng(plan.rect), plan.rect, f.page)).toBe(
    true
  )
  expect(
    nativeCaptionedFormPixelPngSafe({ ...plan }, formPixelPng(plan.rect), plan.rect, f.page)
  ).toBe(false)
  expect(nativeCaptionedFormPixelPngSafe(plan, formPixelPng(plan.rect, 1), plan.rect, f.page)).toBe(
    false
  )
  expect(
    nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'ordinary',
  'identity-matrix',
  'nested-marker',
  'line-leading',
  'character-spacing',
  'empty-end-path',
  'empty-text-end',
  'unrecorded-inner-path'
])(
  'restores proven missing native Form glyph pixels without borrowing exterior text: %s',
  (mode) => {
    const f = pixelOnlyVectorForm(),
      o = f.context.operators,
      begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin)
    f.figure.rect = [319.5, 59.5, 360, 300.5]
    if (mode === 'identity-matrix') o.argsArray[begin][0] = Float32Array.from([1, 0, 0, 1, 0, 0])
    if (mode === 'line-leading' || mode === 'character-spacing') {
      const show = o.fnArray.indexOf(OPS.showText, begin)
      if (mode === 'line-leading') {
        o.argsArray[show - 1][5] += 4
        o.fnArray.splice(show, 0, OPS.setLeading, OPS.nextLine)
        o.argsArray.splice(show, 0, [4], null)
      } else {
        o.fnArray.splice(show, 0, OPS.setCharSpacing)
        o.argsArray.splice(show, 0, [0.001])
      }
    }
    if (mode === 'empty-end-path' || mode === 'empty-text-end') {
      o.fnArray.splice(begin + 1, 0, mode === 'empty-end-path' ? OPS.constructPath : OPS.endText)
      o.argsArray.splice(
        begin + 1,
        0,
        mode === 'empty-end-path' ? [OPS.endPath, [null], null] : null
      )
      for (const g of f.page.graphicsBounds) if (g.operationIndex > begin) g.operationIndex++
    }
    if (mode === 'unrecorded-inner-path') f.page.graphicsBounds.splice(1, 1)
    if (mode === 'nested-marker') {
      const end = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
      o.fnArray.splice(end, 0, OPS.paintFormXObjectEnd)
      o.argsArray.splice(end, 0, [])
      o.fnArray.splice(begin + 1, 0, OPS.paintFormXObjectBegin)
      o.argsArray.splice(begin + 1, 0, [null, Float32Array.from([320, 500, 560, 740])])
      for (const g of f.page.graphicsBounds)
        if (g.operationIndex > begin) g.operationIndex += g.operationIndex < end ? 1 : 2
    }
    const before = structuredClone(f),
      plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
    expect(plan).toEqual({ rect: [319.5, 59.5, 560.5, 300.5] })
    expect(nativeCaptionedFormPixelPngSafe(plan, formPixelPng(plan.rect), plan.rect, f.page)).toBe(
      true
    )
    expect(f).toEqual(before)
    expect(plan.sourceItems).toBeUndefined()
    expect(
      nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
    ).toBeUndefined()
  }
)

it('keeps a complete Form crop when only its unpainted native frame extends beyond publication', () => {
  const f = pixelOnlyVectorForm()
  f.figure.rect = [319.5, 59.5, 550, 300.5]
  expect(
    nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})

it.each([
  'unrecorded-exterior-path',
  'unrecorded-path-without-bbox',
  'unbalanced-form',
  'unknown-glyph-clip',
  'transparent-owned-glyph',
  'wrong-spaced-source-position'
])('keeps the old crop when a missing Form glyph lacks closed native proof: %s', (mode) => {
  const f = pixelOnlyVectorForm(),
    o = f.context.operators,
    begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin)
  f.figure.rect = [319.5, 59.5, 360, 300.5]
  if (mode === 'unrecorded-exterior-path') f.page.graphicsBounds.splice(0, 1)
  if (mode === 'unrecorded-path-without-bbox') o.argsArray[begin][1] = null
  if (mode === 'unbalanced-form')
    o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.restore
  if (mode === 'unknown-glyph-clip') {
    const text = o.fnArray.indexOf(OPS.beginText, begin)
    o.fnArray.splice(text, 0, OPS.clip, OPS.constructPath)
    o.argsArray.splice(text, 0, null, [
      OPS.endPath,
      [Float32Array.from([0, 320, 500, 1, 560, 500, 1, 440, 740, 4])],
      Float32Array.from([320, 500, 560, 740])
    ])
  }
  if (mode === 'transparent-owned-glyph') {
    const text = o.fnArray.indexOf(OPS.beginText, begin),
      end = o.fnArray.indexOf(OPS.endText, text)
    o.fnArray.splice(end + 1, 0, OPS.setGState)
    o.argsArray.splice(end + 1, 0, [[['ca', 1]]])
    o.fnArray.splice(text, 0, OPS.setGState)
    o.argsArray.splice(text, 0, [[['ca', 0]]])
  }
  if (mode === 'wrong-spaced-source-position') {
    const show = o.fnArray.indexOf(OPS.showText, begin)
    o.fnArray.splice(show, 0, OPS.setCharSpacing)
    o.argsArray.splice(show, 0, [4])
  }
  expect(
    nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})

it.each(['separate-fill', 'crossing-fill', 'near-fill', 'stroked-fill', 'missing-fill-bounds'])(
  'retains physical foreign fill and its final PNG halo beside a complete Form: %s',
  (mode) => {
    const f = pixelOnlyVectorForm(),
      g = f.page.graphicsBounds[0],
      right = mode === 'crossing-fill' ? 320 : mode === 'near-fill' ? 319.1 : 318,
      rect = [310, 145, right, 155],
      o = f.context.operators
    f.figure.rect = [319.5, 59.5, 360, 300.5]
    g.normalizedRect = [309.5, 144.5, 319.55, 155.5].map((v, n) => v / (n % 2 ? 800 : 600))
    o.argsArray[g.operationIndex] = [
      mode === 'stroked-fill' ? OPS.fillStroke : OPS.fill,
      [
        Float32Array.from([
          0,
          rect[0],
          800 - rect[1],
          1,
          rect[2],
          800 - rect[1],
          1,
          rect[2],
          800 - rect[3],
          1,
          rect[0],
          800 - rect[3],
          4
        ])
      ],
      mode === 'missing-fill-bounds'
        ? null
        : Float32Array.from([rect[0], 800 - rect[3], rect[2], 800 - rect[1]])
    ]
    const plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
    if (mode === 'separate-fill' || mode === 'near-fill') {
      expect(plan).toEqual({ rect: [319.5, 59.5, 560.5, 300.5] })
      expect(
        nativeCaptionedFormPixelPngSafe(plan, formPixelPng(plan.rect), plan.rect, f.page)
      ).toBe(mode === 'separate-fill')
    } else expect(plan).toBeUndefined()
  }
)

it.each(['disjoint', 'overlapping'])(
  'keeps every independent native Form as a conservative foreign domain: %s',
  (mode) => {
    const f = pixelOnlyVectorForm(),
      o = f.context.operators,
      begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin),
      left = mode === 'disjoint' ? 40 : 330,
      right = mode === 'disjoint' ? 180 : 550
    f.figure.rect = [319.5, 59.5, 360, 300.5]
    for (const g of f.page.graphicsBounds) if (g.operationIndex >= begin) g.operationIndex += 3
    o.fnArray.splice(
      begin,
      0,
      OPS.paintFormXObjectBegin,
      OPS.constructPath,
      OPS.paintFormXObjectEnd
    )
    o.argsArray.splice(
      begin,
      0,
      [null, Float32Array.from([left - 5, 500, right + 5, 740])],
      [
        OPS.stroke,
        [Float32Array.from([0, left, 700, 1, right, 600])],
        Float32Array.from([left, 600, right, 700])
      ],
      []
    )
    f.page.graphicsBounds.push({
      operationIndex: begin + 1,
      kind: 'path',
      normalizedRect: [left, 100, right, 200].map((v, n) => v / (n % 2 ? 800 : 600))
    })
    const plan = nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context)
    if (mode === 'disjoint') {
      expect(plan).toEqual({ rect: [319.5, 59.5, 560.5, 300.5] })
      expect(
        nativeCaptionedFormPixelPngSafe(plan, formPixelPng(plan.rect), plan.rect, f.page)
      ).toBe(true)
    } else expect(plan).toBeUndefined()
    expect(
      nativeCaptionedFormScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
    ).toBeUndefined()
  }
)

it('rejects a real Type3 charproc that pops the surrounding Form clip', async () => {
  const {
      recordPaintedOperationBounds,
      captureNativeFigureRenderContext,
      matchNativeFigureRenderContext
    } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href),
    { collectGraphicsBounds } = await import(
      pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
    ),
    { tableTextToken } = await import(
      pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
    ),
    { renderPdfCrop } = await import(
      pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
    ),
    objects: string[] = [],
    add = (text: string): number => objects.push(text),
    stream = (text: string, dict = ''): number =>
      add(`<< ${dict} /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`),
    catalog = add(''),
    pages = add(''),
    face = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ids: number[] = []
  for (const extraQ of ['', 'Q Q Q ']) {
    const glyph = stream(`1000 0 d0 ${extraQ}1 0 0 rg 300 300 30 30 re f`),
      font = add(
        `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [.001 0 0 .001 0 0] /FirstChar 65 /LastChar 65 /Widths [1000] /Encoding << /Type /Encoding /Differences [65 /A] >> /CharProcs << /A ${glyph} 0 R >> /Resources << >> >>`
      ),
      form = stream(
        '0 1 0 rg 110 110 70 70 re f 115 115 10 10 re f 130 130 10 10 re f BT /F3 10 Tf 1 0 0 1 150 150 Tm (A) Tj ET',
        `/Type /XObject /Subtype /Form /BBox [100 100 200 200] /Resources << /Font << /F3 ${font} 0 R >> >>`
      ),
      content = stream(
        'BT /Text 10 Tf 1 0 0 1 100 350 Tm [(Running) -278 (header.)] TJ ET q /Picture Do Q BT /Text 10 Tf 1 0 0 1 100 85 Tm [(Figure) -278 (1:Completepanel.)] TJ ET'
      )
    ids.push(
      add(
        `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 400 400] /Resources << /Font << /Text ${face} 0 R >> /XObject << /Picture ${form} 0 R >> >> /Contents ${content} 0 R >>`
      )
    )
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] =
    `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count 2 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    sourceSha256 = createHash('sha256').update(bytes).digest('hex'),
    task = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl
    })
  try {
    const document = await task.promise
    for (const pageNumber of [1, 2]) {
      const nativePage = await document.getPage(pageNumber),
        viewport = nativePage.getViewport({ scale: 1 }),
        content = await nativePage.getTextContent(),
        canvas = createCanvas(400, 400),
        render = nativePage.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext('2d') as never,
          viewport,
          recordOperations: true
        })
      try {
        recordPaintedOperationBounds(render)
        await render.promise
        const rgba = canvas.getContext('2d').getImageData(0, 0, 400, 400).data
        let escaped = 0
        for (let y = 0; y < 400; y++)
          for (let x = 0; x < 400; x++) {
            const i = (y * 400 + x) * 4
            if (
              rgba[i] > 200 &&
              rgba[i + 1] < 80 &&
              rgba[i + 2] < 80 &&
              !(x >= 100 && x <= 200 && y >= 200 && y <= 300)
            )
              escaped++
          }
        expect(escaped).toBe(pageNumber === 1 ? 0 : 900)
        const graphics = collectGraphicsBounds(
            render,
            (nativePage as ReturnType<typeof JSON.parse>).recordedBBoxes
          ),
          snapshot = captureNativeFigureRenderContext(
            render,
            pageNumber,
            content,
            viewport,
            graphics.graphicsBounds,
            sourceSha256,
            nativePage.commonObjs
          ),
          context = {
            ...matchNativeFigureRenderContext(
              snapshot,
              pageNumber,
              content,
              viewport,
              graphics.graphicsBounds,
              sourceSha256
            ),
            pageNumber,
            sourceSha256
          },
          tokens = context.content.items
            .filter((r: ReturnType<typeof JSON.parse>) => r.str?.trim())
            .map((r: ReturnType<typeof JSON.parse>) => tableTextToken(r, viewport, 0)),
          cap = tokens.find((t: ReturnType<typeof JSON.parse>) => t.text.startsWith('Figure 1:')),
          caption = { page: pageNumber, rect: cap.rect, lines: [cap.text] },
          page = {
            pageNumber,
            width: 400,
            height: 400,
            rotation: 0,
            renderRotation: 0,
            invalidGraphicsBounds: 0,
            graphicsBounds: graphics.graphicsBounds,
            lines: []
          },
          figure = { caption, rect: [90, 40, 350, 305] },
          proof = nativeCaptionedFormPixelCrop(
            page,
            figure,
            [caption],
            [],
            tokens,
            context,
            figure.rect,
            { nativePage, pageContent: content, operators: await nativePage.getOperatorList() }
          )
        if (pageNumber === 2) expect(proof).toBeUndefined()
        else {
          expect(proof).toBeDefined()
          const png = await renderPdfCrop(nativePage, proof.rect, 0)
          expect(nativeCaptionedFormPixelPngSafe(proof, png, proof.rect, page)).toBe(true)
        }
      } finally {
        canvas.width = canvas.height = 0
      }
    }
  } finally {
    await task.destroy()
  }
})

it.each(['exterior-charproc', 'missing-exterior-outline', 'invalid-bbox', 'clean-published-crop'])(
  'declines an unproved or unnecessary complete Form pixel crop: %s',
  (mode) => {
    const f = pixelOnlyVectorForm(),
      o = f.context.operators
    let published = f.figure.rect
    if (mode === 'exterior-charproc')
      o.argsArray[o.fnArray.indexOf(OPS.showText)][0][0].operatorListId = 'outside-program'
    if (mode === 'missing-exterior-outline') f.context.partialFontGlyphBounds[0].glyphs = []
    if (mode === 'invalid-bbox') o.argsArray[o.fnArray.indexOf(OPS.paintFormXObjectBegin)][1] = null
    if (mode === 'clean-published-crop') published = [319.5, 59.5, 560.5, 300.5]
    expect(
      nativeCaptionedFormPixelCrop(f.page, f.figure, f.captions, [], f.tokens, f.context, published)
    ).toBeUndefined()
  }
)

it.each([
  'native-source',
  'path-bytes',
  'published-rectangle',
  'equal-native-slot',
  'source-index',
  'native-bbox'
])('invalidates a retained Form pixel plan when its actual inputs change: %s', (mode) => {
  const f = pixelOnlyVectorForm(),
    published = [...f.figure.rect],
    plan = nativeCaptionedFormPixelCrop(
      f.page,
      f.figure,
      f.captions,
      [],
      f.tokens,
      f.context,
      published
    )
  expect(plan).toBeDefined()
  if (mode === 'native-source') f.context.content.items[0].str += ' changed'
  if (mode === 'path-bytes')
    f.context.operators.argsArray[f.context.operators.fnArray.indexOf(OPS.constructPath)][1][0][1]++
  if (mode === 'published-rectangle') published[0]++
  if (mode === 'equal-native-slot') f.context.operators = structuredClone(f.context.operators)
  if (mode === 'source-index') f.context.content.items[0].sourceItem.index++
  if (mode === 'native-bbox')
    f.context.operators.argsArray[
      f.context.operators.fnArray.indexOf(OPS.paintFormXObjectBegin)
    ][1][0]++
  expect(nativeCaptionedFormPixelPngSafe(plan, formPixelPng(plan.rect), plan.rect, f.page)).toBe(
    false
  )
})

it.each([
  'bad-scope',
  'unbalanced',
  'unknown-paint',
  'missing-render-paint',
  'foreign-loaded-font',
  'missing-font-outline',
  'external-ink-crosses',
  'external-space-ink-crosses',
  'near-edge-glyph',
  'near-edge-paint',
  'oversized-raster',
  'foreign-caption',
  'table-overlap',
  'wrong-caption-source',
  'no-borrowed-paint'
])('declines a Form crop with incomplete or conflicting native proof: %s', (mode) => {
  const f = captionedVectorForm(mode === 'oversized-raster' ? 300 : 180),
    o = f.context.operators
  let tables: number[][] = []
  if (mode === 'bad-scope')
    o.argsArray[o.fnArray.indexOf(OPS.paintFormXObjectBegin)][1] = Float32Array.from([
      40, 620, 560, 740
    ])
  if (mode === 'unbalanced') o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.restore
  if (mode === 'unknown-paint') o.fnArray[o.fnArray.indexOf(OPS.constructPath)] = OPS.shadingFill
  if (mode === 'missing-render-paint') {
    f.page.graphicsBounds = f.page.graphicsBounds.slice(0, -1)
    f.context.graphicsBounds = f.page.graphicsBounds
  }
  if (mode === 'foreign-loaded-font')
    o.argsArray[o.fnArray.indexOf(OPS.showText)][0][0].isInFont = false
  if (mode === 'missing-font-outline')
    f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar !== 'N'
    )
  if (mode === 'external-ink-crosses')
    f.context.glyphBounds[0].glyphs.find(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'N'
    ).bounds = [0, -0.2, 40, 0.8]
  if (mode === 'external-space-ink-crosses')
    f.context.glyphBounds[0].glyphs.find(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar === ' '
    ).bounds = [0, -0.2, 40, 0.8]
  if (mode === 'near-edge-glyph')
    f.context.glyphBounds[0].glyphs.find(
      (g: ReturnType<typeof JSON.parse>) => g.fontChar === 'N'
    ).bounds = [0, -0.2, 26.9995, 0.8]
  if (mode === 'near-edge-paint') {
    const g = f.page.graphicsBounds[0],
      rect = [319.98, 150, 319.995, 151]
    g.normalizedRect = rect.map((v: number, n: number) => v / (n % 2 ? 800 : 600))
    o.argsArray[g.operationIndex] = [
      OPS.stroke,
      [Float32Array.from([0, rect[0], 800 - rect[1], 1, rect[2], 800 - rect[3]])],
      Float32Array.from([rect[0], 800 - rect[3], rect[2], 800 - rect[1]])
    ]
  }
  if (mode === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Table 2. Other.'], rect: [350, 100, 450, 120] })
  if (mode === 'table-overlap') tables = [[350, 100, 450, 120]]
  if (mode === 'wrong-caption-source') f.caption.lines = ['Figure 1: Different native title.']
  if (mode === 'no-borrowed-paint') f.figure.rect = [320, 60, 560, 180]
  expect(
    nativeCaptionedFormScope(f.page, f.figure, f.captions, tables, f.tokens, f.context)
  ).toBeUndefined()
})
it.each([
  'soft-mask',
  'knockout',
  'group-matrix',
  'unclosed-group',
  'unknown-paint',
  'wrong-text-matrix',
  'wrong-token-geometry',
  'duplicate-source',
  'foreign-paint',
  'foreign-native-text',
  'foreign-caption',
  'foreign-final-clip-table',
  'caption-without-source'
])('retains the ordinary strip when the independent renderer group lacks proof: %s', (mode) => {
  const f = disjointMixedGroups(mode === 'foreign-native-text'),
    ops = f.context.operators,
    ownBegin = ops.fnArray.lastIndexOf(OPS.beginGroup),
    group = ops.argsArray[ownBegin][0],
    figure = {
      caption: f.captions[0],
      rect: [60, 65, 550, 300],
      reason: 'native-raster-vector-strip'
    }
  if (mode === 'soft-mask') group.smask = { subtype: 'Alpha' }
  if (mode === 'knockout') group.knockout = true
  if (mode === 'group-matrix') group.matrix = [1, 0, 0, 1, 0, 0]
  if (mode === 'unclosed-group') ops.fnArray[ops.fnArray.lastIndexOf(OPS.endGroup)] = OPS.restore
  if (mode === 'unknown-paint') ops.argsArray[ops.fnArray.indexOf(OPS.constructPath)][0] = -1
  if (mode === 'wrong-text-matrix')
    ops.argsArray[ops.fnArray.indexOf(OPS.setTextMatrix, ownBegin)][4]++
  if (mode === 'wrong-token-geometry') f.tokens[1].rect[2] += 0.001
  if (mode === 'duplicate-source') f.tokens.push(structuredClone(f.tokens[1]))
  if (mode === 'foreign-paint') {
    f.page.graphicsBounds[0].normalizedRect = [550 / 600, 80 / 800, 558 / 600, 100 / 800]
  }
  if (mode === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 3: Separate text.'], rect: [552, 80, 558, 100] })
  if (mode === 'caption-without-source') f.captions[0].lines[0] += ' Changed.'
  expect(
    nativeDisjointMixedFigureGroup(
      f.page,
      figure,
      f.captions,
      mode === 'foreign-final-clip-table' ? [[552, 80, 558, 100]] : [],
      f.tokens,
      f.context
    )
  ).toBeUndefined()
})

function balancedNativeDrawing(): ReturnType<typeof JSON.parse> {
  const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [] as ReturnType<typeof JSON.parse>[],
      graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
    },
    viewport = {
      width: 600,
      height: 800,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 800],
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y]
    },
    context = {
      pageNumber: 1,
      sourceSha256: '0'.repeat(64),
      viewport,
      graphicsBounds: page.graphicsBounds,
      operators: { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] },
      content: { items: [] as ReturnType<typeof JSON.parse>[] },
      glyphBounds: [{ fontName: 'face', glyphs: [] as ReturnType<typeof JSON.parse>[] }]
    },
    emit = (op: number, args: unknown = null): number => {
      context.operators.fnArray.push(op)
      return context.operators.argsArray.push(args) - 1
    },
    text = (value: string, x: number, top: number, painted = value): void => {
      emit(OPS.beginText)
      emit(OPS.setFont, ['face', 10])
      emit(OPS.setTextMatrix, [Float32Array.from([1, 0, 0, 1, x, 790 - top])])
      emit(OPS.showText, [
        Array.from(painted, (unicode) => {
          if (!context.glyphBounds[0].glyphs.some((g) => g.fontChar === unicode))
            context.glyphBounds[0].glyphs.push({
              fontChar: unicode,
              bounds: unicode === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 1]
            })
          return { unicode, fontChar: unicode, width: 500, isInFont: true }
        })
      ])
      emit(OPS.endText)
      const index = context.content.items.length
      context.content.items.push({
        str: value,
        dir: 'ltr',
        fontName: 'face',
        width: value.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, 790 - top],
        sourceItem: { pageNumber: 1, index, text: value }
      })
      page.lines.push({ text: value, x, y: top, width: value.length * 5, height: 10, fontSize: 10 })
    },
    path = (rect: number[], frame = false, padding = 2): void => {
      const [l, t, r, b] = rect,
        operationIndex = emit(OPS.constructPath, [
          OPS.stroke,
          [
            Float32Array.from(
              frame
                ? [0, l, 800 - t, 1, r, 800 - t, 1, r, 800 - b, 1, l, 800 - b, 4]
                : [0, l, 800 - t, 1, r, 800 - b]
            )
          ],
          Float32Array.from([l, 800 - b, r, 800 - t])
        ])
      page.graphicsBounds.push({
        operationIndex,
        kind: 'path',
        normalizedRect: rect.map((n, i) => (n + (i < 2 ? -padding : padding)) / (i % 2 ? 800 : 600))
      })
    }
  emit(OPS.save)
  emit(OPS.save)
  emit(OPS.setLineWidth, [0.4])
  for (const [x, y] of [
    [60, 90],
    [150, 150],
    [240, 90]
  ]) {
    path([x, y, x + 35, y + 25], true)
    text('Node', x, y + 5)
  }
  for (let i = 0; i < 9; i++)
    path(i === 0 ? [42, 62, 278, 263] : [70 + i * 3, 210 + i * 3, 240 + i * 3, 211 + i * 3])
  text('Before', 40, 60)
  text('After', 245, 60)
  text('Native legend', 100, 250)
  emit(OPS.restore)
  emit(OPS.restore)
  text('Neighbor paragraph', 330, 80)
  path([286, 130, 550, 131], false, 5)
  text('μ', 450, 400, 'µ')
  const caption = {
    page: 1,
    lines: ['Figure 1: Complete vector diagram.'],
    rect: [40, 280, 280, 290]
  }
  text(caption.lines[0], 40, 280)
  const native = context.content.items.map((item) => ({
    text: item.str,
    sourceItem: item.sourceItem,
    rect: [
      item.transform[4],
      800 - item.transform[5] - 10,
      item.transform[4] + item.width,
      800 - item.transform[5]
    ],
    height: 10,
    baseline: 800 - item.transform[5],
    horizontal: true
  }))
  return {
    page,
    context,
    tokens: native,
    caption,
    captions: [caption],
    figure: { caption, rect: [40, 60, 550, 270], graphicsCount: 13 }
  }
}

it('isolates an independently closed balanced native drawing without claiming neighboring source', () => {
  const f = balancedNativeDrawing(),
    before = structuredClone({
      ...f,
      context: {
        ...f.context,
        viewport: { ...f.context.viewport, convertToViewportPoint: undefined }
      }
    }),
    result = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(result[0].reason).toBe('native-balanced-vector-scope')
  expect(result[0].rect[2]).toBeLessThan(300)
  expect(result[0].fallbackFigure).toBeDefined()
  expect(result[0].sourceItems).toBeUndefined()
  expect({
    ...f,
    context: {
      ...f.context,
      viewport: { ...f.context.viewport, convertToViewportPoint: undefined }
    }
  }).toEqual(before)
})

const { nativeBalancedVectorFigureScope } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-balanced-scope.mjs')).href
)
const balancedScopeRefusals: [string, (f: ReturnType<typeof balancedNativeDrawing>) => void][] = [
  [
    'same-column unowned legend',
    (f) => {
      const r = f.context.content.items[6]
      r.transform[4] = 80
      r.transform[5] = 522
      const show = f.context.operators.fnArray.flatMap((op: number, i: number) =>
        op === OPS.showText ? [i] : []
      )[6]
      f.context.operators.argsArray[show - 1] = [Float32Array.from([1, 0, 0, 1, 80, 522])]
    }
  ],
  [
    'later overlapping paint',
    (f) => {
      const g = f.page.graphicsBounds.at(-1),
        a = f.context.operators.argsArray[g.operationIndex]
      a[1] = [Float32Array.from([0, 150, 600, 1, 200, 599])]
      a[2] = Float32Array.from([150, 599, 200, 600])
      g.normalizedRect = [145 / 600, 195 / 800, 205 / 600, 206 / 800]
    }
  ],
  [
    'missing complete foreign glyph',
    (f) => {
      f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar !== 'µ'
      )
    }
  ],
  [
    'normalization required by a claimed source',
    (f) => {
      const r = f.context.content.items[0]
      r.str = 'μode'
      r.sourceItem.text = r.str
      const show = f.context.operators.fnArray.indexOf(OPS.showText)
      f.context.operators.argsArray[show][0][0] = {
        unicode: 'µ',
        fontChar: 'µ',
        width: 500,
        isInFont: true
      }
    }
  ],
  [
    'unaccounted painted path',
    (f) => {
      f.page.graphicsBounds.pop()
    }
  ],
  [
    'malformed optional source evidence',
    (f) => {
      f.context.content.items[0] = null
    }
  ],
  [
    'unbalanced drawing save',
    (f) => {
      f.context.operators.fnArray.push(OPS.save)
      f.context.operators.argsArray.push(null)
    }
  ],
  [
    'hairline stroke without a finite ink envelope',
    (f) => {
      f.context.operators.argsArray[2] = [0]
    }
  ],
  [
    'source packet crossing drawing closure',
    (f) => {
      const o = f.context.operators,
        show = o.fnArray.indexOf(OPS.showText),
        tail = o.argsArray[show][0].splice(2),
        close = o.fnArray.indexOf(OPS.restore)
      o.fnArray.splice(close, 1)
      o.argsArray.splice(close, 1)
      o.fnArray.splice(show + 1, 0, OPS.restore, OPS.showText)
      o.argsArray.splice(show + 1, 0, null, [tail])
      for (const g of f.page.graphicsBounds)
        if (g.operationIndex > show) g.operationIndex += g.operationIndex < close ? 2 : 1
    }
  ]
]
it.each(balancedScopeRefusals)('keeps the ordinary figure without %s', (_name, mutate) => {
  const f = balancedNativeDrawing()
  mutate(f)
  expect(
    nativeBalancedVectorFigureScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})
it('retains a zero-advance foreign source and refuses a PNG halo touching foreign ink', () => {
  const f = balancedNativeDrawing(),
    r = f.context.content.items[7],
    o = f.context.operators
  r.str = '̸'
  r.sourceItem.text = r.str
  r.width = 0
  f.context.glyphBounds[0].glyphs.push({ fontChar: '̸', bounds: [-0.2, 0, 0.2, 1] })
  const show = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : []))[7]
  o.argsArray[show][0] = [{ unicode: '̸', fontChar: '̸', width: 0, isInFont: true }]
  const result = nativeBalancedVectorFigureScope(
    f.page,
    f.figure,
    f.captions,
    [],
    f.tokens,
    f.context
  )
  expect(result?.reason).toBe('native-balanced-vector-scope')
  expect(r.str).toBe('̸')
  expect(o.argsArray[show][0][0].width).toBe(0)
  const png = new Uint8Array(33),
    view = new DataView(png.buffer)
  png.set([137, 80, 78, 71, 13, 10, 26, 10])
  view.setUint32(8, 13)
  view.setUint32(12, 0x49484452)
  view.setUint32(16, 960)
  view.setUint32(20, 820)
  expect(nativeSingleVectorGroupPng(png, result)).toBe(true)
  const near = {
    ...result,
    groupRasterProof: {
      ...result.groupRasterProof,
      outsideInk: [...result.groupRasterProof.outsideInk, [280.005, 100, 280.1, 120]]
    }
  }
  expect(nativeSingleVectorGroupPng(png, near)).toBe(false)
})

function shadedNativeDiffExample(): ReturnType<typeof JSON.parse> {
  const f = balancedNativeDrawing(),
    c = f.context
  f.page.graphicsBounds.length = 0
  f.page.lines.length = 0
  c.operators.fnArray.length = 0
  c.operators.argsArray.length = 0
  c.content.items.length = 0
  c.glyphBounds[0].glyphs.length = 0
  c.content.styles = { face: { fontFamily: 'monospace' } }
  const emit = (op: number, a: unknown = null): number => {
    c.operators.fnArray.push(op)
    return c.operators.argsArray.push(a) - 1
  }
  for (let block = 0; block < 2; block++)
    for (const [row, text] of [
      '@@ sample ' + (block ? 'two' : 'one') + ' @@',
      'value = build()',
      '-value = old()',
      '+value = next()',
      'consume(value)'
    ].entries()) {
      const top = 60 + block * 90 + row * 14,
        operationIndex = emit(OPS.setFillRGBColor, ['#eeeeee']) + 1
      emit(OPS.constructPath, [
        OPS.fill,
        [
          Float32Array.from([
            0,
            30,
            801 - top,
            1,
            270,
            801 - top,
            1,
            270,
            789 - top,
            1,
            30,
            789 - top,
            4
          ])
        ],
        Float32Array.from([30, 789 - top, 270, 801 - top])
      ])
      f.page.graphicsBounds.push({
        kind: 'path',
        operationIndex,
        normalizedRect: [30 / 600, (top - 1) / 800, 270 / 600, (top + 11) / 800]
      })
      emit(OPS.setFillRGBColor, ['#000000'])
      emit(OPS.beginText)
      emit(OPS.setFont, ['face', 10])
      emit(OPS.setTextMatrix, [Float32Array.from([1, 0, 0, 1, 35, 790 - top])])
      emit(OPS.showText, [
        Array.from(text, (unicode) => {
          if (!c.glyphBounds[0].glyphs.some((g) => g.fontChar === unicode))
            c.glyphBounds[0].glyphs.push({
              fontChar: unicode,
              bounds: unicode === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 1]
            })
          return {
            unicode,
            fontChar: unicode,
            width: 500,
            isInFont: true,
            isSpace: unicode === ' ',
            originalCharCode: unicode.codePointAt(0)
          }
        })
      ])
      emit(OPS.endText)
      const index = c.content.items.length
      c.content.items.push({
        str: text,
        width: text.length * 5,
        height: 10,
        dir: 'ltr',
        fontName: 'face',
        transform: [10, 0, 0, 10, 35, 790 - top],
        sourceItem: { pageNumber: 1, index, text }
      })
    }
  return {
    page: f.page,
    context: c,
    options: {
      competingRects: [],
      captions: [],
      current: structuredClone({
        operators: c.operators,
        content: c.content,
        viewport: { ...c.viewport, convertToViewportPoint: undefined },
        sourceSha256: c.sourceSha256,
        pageNumber: c.pageNumber
      })
    },
    facts: [
      {
        fontName: 'face',
        loadedFontName: 'face',
        isMonospace: true,
        missingFile: false,
        isType3Font: false,
        isInvalidPDFjsFont: false
      }
    ],
    candidate: {
      id: 'p1-graphical-table-1',
      page: 1,
      region: [29 / 600, 58 / 800, 271 / 600, 219 / 800],
      sourceViewport: { width: 900, height: 1200, scale: 1.5 },
      thumbnail: 'thumbnails/p1-graphical-table-1.png',
      grid: [],
      cells: [],
      unassigned: [],
      issues: ['no-source-cell-grid']
    }
  }
}
it('proves a whole shaded monospaced diff without changing its existing crop or image', async () => {
  const { proveNativeDiffCodeFigure } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-diff-code.mjs')).href
    ),
    f = shadedNativeDiffExample(),
    result = proveNativeDiffCodeFigure(f.page, f.candidate, f.context, f.options, f.facts)
  expect(result?.sourceItems).toHaveLength(10)
  expect(result?.issue).toBe('native-diff-code-packet')
  expect(result?.region).toEqual(f.candidate.region)
  expect(result?.thumbnail).toBe(f.candidate.thumbnail)
  expect(result?.grid).toBeUndefined()
  expect(result?.cells).toBeUndefined()
})
const diffCodeRefusals: [string, (f: ReturnType<typeof shadedNativeDiffExample>) => void][] = [
  ['missing current program', (f) => delete f.options.current],
  ['changed current source', (f) => (f.options.current.content.items[0].width += 1)],
  ['unbound current font', (f) => (f.facts[0].loadedFontName = 'other-face')],
  [
    'current-only opaque overlay',
    (f) => {
      const o = f.options.current.operators
      o.fnArray.push(OPS.save, OPS.setFillRGBColor, OPS.constructPath, OPS.restore)
      o.argsArray.push(
        null,
        ['#ff00ff'],
        [
          OPS.fill,
          [Float32Array.from([0, 35, 740, 1, 100, 740, 1, 100, 730, 1, 35, 730, 4])],
          Float32Array.from([35, 730, 100, 740])
        ],
        null
      )
    }
  ],
  [
    'missing loaded mono font',
    (f) => {
      f.facts = []
    }
  ],
  [
    'duplicate packet header',
    (f) => {
      const c = f.context,
        r = c.content.items[5],
        first = c.content.items[0]
      r.str = first.str
      r.sourceItem.text = r.str
      const shows = c.operators.fnArray.flatMap((op: number, i: number) =>
        op === OPS.showText ? [i] : []
      )
      c.operators.argsArray[shows[5]] = structuredClone(c.operators.argsArray[shows[0]])
    }
  ],
  [
    'proportional font facts',
    (f) => {
      f.facts[0].isMonospace = false
    }
  ],
  [
    'missing loaded header outline',
    (f) => {
      f.context.glyphBounds[0].glyphs = f.context.glyphBounds[0].glyphs.filter(
        (g: ReturnType<typeof JSON.parse>) => g.fontChar !== '@'
      )
    }
  ],
  [
    'context tail outside the crop',
    (f) => {
      f.candidate.region[3] = 205 / 800
    }
  ],
  [
    'competing native owner',
    (f) => {
      f.options.competingRects.push([30, 60, 50, 80])
    }
  ],
  [
    'additional native subpath',
    (f) => {
      f.context.operators.argsArray[1][1].push(
        Float32Array.from([0, 80, 710, 1, 90, 710, 1, 90, 700, 1, 80, 700, 4])
      )
    }
  ],
  [
    'degenerate shaded rectangle',
    (f) => {
      const q = f.context.operators.argsArray[1][1][0]
      q[7] = q[1]
      q[8] = q[2]
    }
  ],
  [
    'a mapped logical table',
    (f) => {
      f.candidate.cells.push({ row: 0, column: 0, text: 'existing mapping' })
    }
  ],
  [
    'foreign shaded fill between packets',
    (f) => {
      const o = f.context.operators,
        id = o.fnArray.length
      o.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
      o.argsArray.push(
        ['#eeeeee'],
        [
          OPS.fill,
          [Float32Array.from([0, 100, 665, 1, 110, 665, 1, 110, 661, 1, 100, 661, 4])],
          Float32Array.from([100, 661, 110, 665])
        ]
      )
      f.page.graphicsBounds.push({
        kind: 'path',
        operationIndex: id + 1,
        normalizedRect: [100 / 600, 135 / 800, 110 / 600, 139 / 800]
      })
    }
  ]
]
it.each(diffCodeRefusals)(
  'retains the previous preview without complete diff evidence: %s',
  async (_name, mutate) => {
    const { proveNativeDiffCodeFigure } = await import(
        pathToFileURL(resolve('resources/literature-pdf-native-diff-code.mjs')).href
      ),
      f = shadedNativeDiffExample()
    mutate(f)
    expect(
      proveNativeDiffCodeFigure(f.page, f.candidate, f.context, f.options, f.facts)
    ).toBeUndefined()
  }
)
it('declines invalid diff PNG validation without mutating the old graphical preview', async () => {
  const { proveNativeDiffCodeFigure, acceptsNativeDiffCodePng } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-diff-code.mjs')).href
    ),
    f = shadedNativeDiffExample(),
    before = JSON.stringify(f.candidate),
    result = proveNativeDiffCodeFigure(f.page, f.candidate, f.context, f.options, f.facts)
  expect(result).toBeDefined()
  expect(acceptsNativeDiffCodePng(new Uint8Array(32), result)).toBe(false)
  expect(JSON.stringify(f.candidate)).toBe(before)
})
it('proves the complete current diff program with independent font aliases and operation indices', async () => {
  const { proveNativeDiffCodeFigure } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-diff-code.mjs')).href
    ),
    f = shadedNativeDiffExample(),
    current = f.options.current
  current.operators.fnArray.unshift(OPS.save, OPS.restore)
  current.operators.argsArray.unshift(null, null)
  current.content.styles = { loadedFace: current.content.styles.face }
  for (const r of current.content.items) r.fontName = 'loadedFace'
  current.operators.fnArray.forEach((op: number, i: number) => {
    if (op === OPS.setFont) current.operators.argsArray[i][0] = 'loadedFace'
  })
  f.facts[0].loadedFontName = 'loadedFace'
  const result = proveNativeDiffCodeFigure(f.page, f.candidate, f.context, f.options, f.facts)
  expect(result?.sourceItems).toHaveLength(10)
  expect(result?.diffCodeProof.currentOwnedPaintIndices).toEqual(
    result?.diffCodeProof.ownedPaintIndices.map((i: number) => i + 2)
  )
})

function repeatedHeaderNativeDrawing(): ReturnType<typeof JSON.parse> {
  const f = balancedNativeDrawing(),
    c = f.context,
    headers = ['4', 'Example et al.'].map((str, i) => ({
      str,
      dir: 'ltr',
      fontName: 'face',
      width: str.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, i ? 70 : 40, 770]
    })),
    ops: number[] = [],
    args: ReturnType<typeof JSON.parse>[] = []
  for (const r of headers) {
    ops.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    args.push(
      null,
      ['face', 10],
      [Float32Array.from([1, 0, 0, 1, r.transform[4], 770])],
      [
        Array.from(r.str, (unicode) => {
          if (!c.glyphBounds[0].glyphs.some((g) => g.fontChar === unicode))
            c.glyphBounds[0].glyphs.push({
              fontChar: unicode,
              bounds: unicode === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 1]
            })
          return { unicode, fontChar: unicode, width: 500, isInFont: true }
        })
      ],
      null
    )
  }
  c.operators.fnArray.unshift(...ops)
  c.operators.argsArray.unshift(...args)
  for (const g of f.page.graphicsBounds) g.operationIndex += ops.length
  c.content.items.unshift(...headers)
  c.content.items.forEach((r, index) => (r.sourceItem = { pageNumber: 4, index, text: r.str }))
  c.content.styles = { face: { fontFamily: 'serif', ascent: 1, descent: 0, vertical: false } }
  f.page.pageNumber = c.pageNumber = f.caption.page = 4
  f.page.lines.unshift({
    text: '4 Example et al.',
    x: 40,
    y: 20,
    width: 100,
    height: 10,
    fontSize: 10
  })
  f.tokens = c.content.items.map((r) => ({
    text: r.str,
    sourceItem: r.sourceItem,
    rect: [
      r.transform[4],
      800 - r.transform[5] - 10,
      r.transform[4] + r.width,
      800 - r.transform[5]
    ],
    height: 10,
    baseline: 800 - r.transform[5],
    horizontal: true
  }))
  f.figure.rect = [35, 20, 280, 270]
  const currentContent = structuredClone(c.content),
    witnessContent = structuredClone(c.content)
  currentContent.items.forEach((r) => (r.fontName = 'loadedFace'))
  currentContent.styles = { loadedFace: currentContent.styles.face }
  witnessContent.items.forEach((r) => {
    r.fontName = 'loadedFace'
    delete r.sourceItem
  })
  witnessContent.styles = { loadedFace: witnessContent.styles.face }
  witnessContent.items[0].str = '2'
  c.runningHeadWitness = {
    sourceSha256: c.sourceSha256,
    currentPageNumber: 4,
    witnessPageNumber: 2,
    currentContent,
    witnessContent,
    witnessViewport: { ...c.viewport, convertToViewportPoint: undefined }
  }
  return f
}

it('excludes only an independently repeated header from a complete native drawing scope', async () => {
  const m = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-balanced-scope.mjs')).href
    ),
    f = repeatedHeaderNativeDrawing(),
    result = m.nativeRepeatedHeaderVectorFigureScope?.(
      f.page,
      f.figure,
      f.captions,
      [],
      f.tokens,
      f.context
    )
  expect(result?.reason).toBe('native-repeated-header-vector-scope')
  expect(result?.rect[1]).toBeGreaterThan(50)
  expect(result?.rect[3]).toBeGreaterThan(260)
  expect(result?.sourceItems).toBeUndefined()
  expect(
    m.nativeBalancedVectorFigureScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
  ).toBeUndefined()
})

const repeatedHeaderRefusals: [
  string,
  (f: ReturnType<typeof repeatedHeaderNativeDrawing>) => void
][] = [
  ['missing independent witness', (f) => delete f.context.runningHeadWitness],
  [
    'missing current font proof',
    (f) => delete f.context.runningHeadWitness.currentContent.styles.loadedFace
  ],
  ['wrong witness page number', (f) => (f.context.runningHeadWitness.witnessPageNumber = 3)],
  [
    'wrong printed witness number',
    (f) => (f.context.runningHeadWitness.witnessContent.items[0].str = '3')
  ],
  ['different page domain', (f) => (f.context.runningHeadWitness.witnessViewport.width += 1)],
  [
    'nonfinite witness width',
    (f) => (f.context.runningHeadWitness.witnessContent.items[1].width = Infinity)
  ],
  [
    'witness header outside the page',
    (f) => (f.context.runningHeadWitness.witnessContent.items[1].transform[4] = -1)
  ],
  [
    'same text in body rather than repeated header',
    (f) => (f.context.runningHeadWitness.witnessContent.items[1].transform[5] -= 40)
  ],
  [
    'different native witness face',
    (f) => (f.context.runningHeadWitness.witnessContent.items[1].fontName = 'otherFace')
  ],
  [
    'legend outside the claimed scope',
    (f) => {
      const c = f.context,
        o = c.operators,
        i =
          o.fnArray.findIndex(
            (op: number, i: number) =>
              op === OPS.showText &&
              o.argsArray[i][0].map((g: ReturnType<typeof JSON.parse>) => g.unicode).join('') ===
                'Native legend'
          ) - 3
      o.fnArray.splice(i, 0, OPS.restore, OPS.restore, OPS.save, OPS.save)
      o.argsArray.splice(i, 0, null, null, null, null)
      for (const g of f.page.graphicsBounds) if (g.operationIndex >= i) g.operationIndex += 4
    }
  ],
  [
    'foreign same-column paint',
    (f) => {
      const o = f.context.operators,
        id = o.fnArray.length
      o.fnArray.push(OPS.constructPath)
      o.argsArray.push([
        OPS.stroke,
        [Float32Array.from([0, 50, 760, 1, 100, 760])],
        Float32Array.from([50, 760, 100, 760])
      ])
      f.page.graphicsBounds.push({
        kind: 'path',
        operationIndex: id,
        normalizedRect: [48 / 600, 38 / 800, 102 / 600, 42 / 800]
      })
    }
  ]
]
it.each(repeatedHeaderRefusals)(
  'preserves the previous drawing without repeated-header evidence: %s',
  async (_name, mutate) => {
    const m = await import(
        pathToFileURL(resolve('resources/literature-pdf-figure-native-balanced-scope.mjs')).href
      ),
      f = repeatedHeaderNativeDrawing()
    mutate(f)
    expect(
      m.nativeRepeatedHeaderVectorFigureScope(f.page, f.figure, f.captions, [], f.tokens, f.context)
    ).toBeUndefined()
  }
)
it('checks the actual PNG halo beyond the independently repeated header drawing', async () => {
  const m = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-balanced-scope.mjs')).href
    ),
    f = repeatedHeaderNativeDrawing(),
    first = m.nativeRepeatedHeaderVectorFigureScope(
      f.page,
      f.figure,
      f.captions,
      [],
      f.tokens,
      f.context
    ),
    right = first.rect[2],
    o = f.context.operators,
    id = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [
      Float32Array.from([
        0,
        right + 0.01,
        650,
        1,
        right + 0.02,
        650,
        1,
        right + 0.02,
        640,
        1,
        right + 0.01,
        640,
        4
      ])
    ],
    Float32Array.from([right + 0.01, 640, right + 0.02, 650])
  ])
  f.page.graphicsBounds.push({
    kind: 'path',
    operationIndex: id,
    normalizedRect: [(right + 0.01) / 600, 150 / 800, (right + 0.02) / 600, 160 / 800]
  })
  const candidate = m.nativeRepeatedHeaderVectorFigureScope(
      f.page,
      f.figure,
      f.captions,
      [],
      f.tokens,
      f.context
    ),
    png = Buffer.alloc(32)
  expect(candidate).toBeDefined()
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(Math.ceil((candidate.rect[2] - candidate.rect[0]) * 4), 16)
  png.writeUInt32BE(Math.ceil((candidate.rect[3] - candidate.rect[1]) * 4), 20)
  expect(nativeSingleVectorGroupPng(png, candidate)).toBe(false)
})
it('uses a real bounded transparency canvas without granting its labels Source ownership', async () => {
  const {
      nativeRenderedGroupPixelCrop,
      nativeNonisolatedGroupPixelCrop,
      nativeRenderedGroupPixelPngSafe
    } = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
    ),
    { createNativeNonisolatedGroupCropProfile } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
    ),
    {
      recordPaintedOperationBounds,
      captureNativeFigureRenderContext,
      matchNativeFigureRenderContext
    } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href),
    { collectGraphicsBounds } = await import(
      pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
    ),
    { tableTextToken } = await import(
      pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
    ),
    { renderPdfCrop } = await import(
      pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
    ),
    objects: string[] = [],
    add = (text: string): number => objects.push(text),
    stream = (text: string, dict = ''): number =>
      add(`<< ${dict} /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`),
    catalog = add(''),
    pages = add(''),
    face = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    fn = add('<< /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [.7 .7 .7] /N 1 >>'),
    shading = add(
      `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [100 100 300 280] /Function ${fn} 0 R /Extend [true true] >>`
    ),
    pattern = add(`<< /Type /Pattern /PatternType 2 /Shading ${shading} 0 R >>`),
    image = stream(
      'eeeeee888888ccccccaaaaaa>',
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode'
    ),
    secondImage = stream(
      'ddeeff88aabbccddee99aabb>',
      '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode'
    ),
    tile = stream(
      'q 16 0 0 16 0 0 cm /TileImage Do Q',
      '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 2 /BBox [0 0 16 16] /XStep 16 /YStep 16 /Resources << /XObject << /TileImage ' +
        image +
        ' 0 R >> >>'
    ),
    glyph = stream('600 0 d0 0 0 500 600 re f'),
    type3 = add(
      `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 700] /FontMatrix [.001 0 0 .001 0 0] /FirstChar 65 /LastChar 65 /Widths [600] /Encoding << /Type /Encoding /Differences [65 /A] >> /CharProcs << /A ${glyph} 0 R >> /Resources << >> >>`
    ),
    ids: number[] = []
  for (const withType3 of [false, true]) {
    const form = stream(
        'q /Pattern cs /Shade scn 100 100 200 180 re f Q q /Pattern cs /Tile scn 270 240 20 20 re f Q q 20 0 0 20 150 110 cm /PanelImage Do Q 0 0 0 rg BT /Text 10 Tf 2 Tr 1 0 0 1 105 260 Tm (Left label) Tj 1 0 0 1 200 200 Tm (Middle label) Tj 1 0 0 1 230 130 Tm (Right label) Tj ET' +
          (withType3 ? ' BT /Type3 10 Tf 1 0 0 1 150 150 Tm (A) Tj ET' : ''),
        `/Type /XObject /Subtype /Form /BBox [100 100 300 280] /Group << /S /Transparency /I false /K false >> /Resources << /Font << /Text ${face} 0 R /Type3 ${type3} 0 R >> /Pattern << /Shade ${pattern} 0 R /Tile ${tile} 0 R >> /XObject << /PanelImage ${secondImage} 0 R >> >>`
      ),
      content = stream(
        'BT /Text 10 Tf 1 0 0 1 90 350 Tm (Running header.) Tj ET q /Picture Do Q BT /Text 10 Tf 1 0 0 1 90 80 Tm (Figure 1: Three complete measured sample panels.) Tj /Text 6 Tf 1 0 0 1 118 53 Tm (r) Tj 1 0 0 1 118 39 Tm (s) Tj ET q .339 w 115 47 m 130 47 l S 155 35 m 165 35 l S Q'
      )
    ids.push(
      add(
        `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 400 400] /Resources << /Font << /Text ${face} 0 R >> /XObject << /Picture ${form} 0 R >> >> /Contents ${content} 0 R >>`
      )
    )
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] =
    `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count 2 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    sourceSha256 = createHash('sha256').update(bytes).digest('hex'),
    task = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
      standardFontDataUrl
    })
  try {
    const document = await task.promise
    for (const pageNumber of [1, 2]) {
      const nativePage = await document.getPage(pageNumber),
        witnessPage = await document.getPage(pageNumber === 1 ? 2 : 1),
        viewport = nativePage.getViewport({ scale: 1 }),
        content = await nativePage.getTextContent(),
        canvas = createCanvas(400, 400),
        render = nativePage.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext('2d') as never,
          viewport,
          recordOperations: true
        })
      try {
        recordPaintedOperationBounds(render)
        await render.promise
        const graphics = collectGraphicsBounds(
            render,
            (nativePage as ReturnType<typeof JSON.parse>).recordedBBoxes
          ),
          snapshot = captureNativeFigureRenderContext(
            render,
            pageNumber,
            content,
            viewport,
            graphics.graphicsBounds,
            sourceSha256,
            nativePage.commonObjs
          ),
          context = {
            ...matchNativeFigureRenderContext(
              snapshot,
              pageNumber,
              content,
              viewport,
              graphics.graphicsBounds,
              sourceSha256
            ),
            pageNumber,
            sourceSha256,
            runningHeadWitness: {
              sourceSha256,
              currentPageNumber: pageNumber,
              witnessPageNumber: witnessPage.pageNumber,
              currentContent: content,
              witnessContent: await witnessPage.getTextContent(),
              witnessViewport: witnessPage.getViewport({ scale: 1 })
            }
          },
          tokens = context.content.items
            .filter((r: ReturnType<typeof JSON.parse>) => r.str?.trim())
            .map((r: ReturnType<typeof JSON.parse>) => tableTextToken(r, viewport, 0)),
          cap = tokens.find((t: ReturnType<typeof JSON.parse>) => t.text.startsWith('Figure 1:')),
          caption = { page: pageNumber, rect: cap.rect, lines: [cap.text] },
          page = {
            pageNumber,
            width: 400,
            height: 400,
            rotation: 0,
            renderRotation: 0,
            invalidGraphicsBounds: 0,
            graphicsBounds: graphics.graphicsBounds,
            lines: []
          },
          figure = {
            caption,
            rect: [120, 120, 300, 300],
            graphicsCount: graphics.graphicsBounds.length,
            reason: 'native-raster-composite-grid',
            issue: undefined
          },
          live = {
            nativePage,
            pageContent: content,
            operators: await nativePage.getOperatorList()
          },
          profile = createNativeNonisolatedGroupCropProfile(page, tokens, context)
        if (pageNumber === 1)
          expect(
            nativeRenderedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              tokens,
              context,
              figure.rect,
              live
            )
          ).toBeUndefined()
        const plan = nativeNonisolatedGroupPixelCrop(
          page,
          figure,
          [caption],
          [],
          tokens,
          context,
          figure.rect,
          live,
          profile
        )
        if (pageNumber === 2) expect(plan).toBeUndefined()
        else {
          const rgba = canvas.getContext('2d').getImageData(100, 130, 20, 15).data
          let omittedInk = 0
          for (let i = 0; i < rgba.length; i += 4)
            if (rgba[i] < 80 && rgba[i + 1] < 80 && rgba[i + 2] < 80) omittedInk++
          expect(omittedInk).toBeGreaterThan(3)
          expect(plan).toEqual({ rect: [99.5, 119.5, 300.5, 300.5] })
          expect(plan.sourceItems).toBeUndefined()
          expect(figure.reason).toBe('native-raster-composite-grid')
          const marginTokens = tokens.filter(
              (t: ReturnType<typeof JSON.parse>) => t.text !== 'Running header.'
            ),
            marginPlan = nativeNonisolatedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              marginTokens,
              context,
              figure.rect,
              live,
              createNativeNonisolatedGroupCropProfile(page, marginTokens, context)
            )
          expect(marginPlan).toEqual(plan)
          expect(marginPlan.sourceItems).toBeUndefined()
          const missingLabelTokens = marginTokens.filter(
            (t: ReturnType<typeof JSON.parse>) => t.text !== 'Right label'
          )
          expect(
            nativeNonisolatedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              missingLabelTokens,
              context,
              figure.rect,
              live,
              createNativeNonisolatedGroupCropProfile(page, missingLabelTokens, context)
            )
          ).toBeUndefined()
          const sourceColor =
              context.operators.argsArray[
                context.operators.fnArray.findIndex(
                  (op: number, i: number) =>
                    op === OPS.setFillColorN && context.operators.argsArray[i][0] === 'Shading'
                )
              ],
            liveColor =
              live.operators.argsArray[
                live.operators.fnArray.findIndex(
                  (op: number, i: number) =>
                    op === OPS.setFillColorN && live.operators.argsArray[i][0] === 'Shading'
                )
              ]
          expect(sourceColor[1]).not.toBe(liveColor[1])
          const tileIndex = live.operators.fnArray.findIndex(
              (op: number, i: number) =>
                op === OPS.setFillColorN && live.operators.argsArray[i][0] === 'TilingPattern'
            ),
            tileProgram = live.operators.argsArray[tileIndex][2],
            nestedIndex = tileProgram.fnArray.indexOf(OPS.paintImageXObject),
            nestedImage = tileProgram.argsArray[nestedIndex],
            imageIndex = live.operators.fnArray.indexOf(OPS.paintImageXObject),
            mainImage = live.operators.argsArray[imageIndex],
            width = mainImage[1],
            imageId = mainImage[0],
            save = tileProgram.fnArray[0]
          mainImage[1]++
          expect(
            nativeRenderedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              tokens,
              context,
              figure.rect,
              live
            )
          ).toBeUndefined()
          mainImage[1] = width
          mainImage[0] = nestedImage[0]
          expect(
            nativeRenderedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              tokens,
              context,
              figure.rect,
              live
            )
          ).toBeUndefined()
          mainImage[0] = imageId
          tileProgram.fnArray[0] = OPS.restore
          expect(
            nativeRenderedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              tokens,
              context,
              figure.rect,
              live
            )
          ).toBeUndefined()
          tileProgram.fnArray[0] = save
          expect(
            nativeRenderedGroupPixelCrop(
              page,
              { ...figure, sourceItems: [tokens[0].sourceItem] },
              [caption],
              [],
              tokens,
              context,
              figure.rect,
              live
            )
          ).toBeUndefined()
          const png = await renderPdfCrop(nativePage, plan.rect, 0)
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          const outside = context.graphicsBounds.find(
              (g: ReturnType<typeof JSON.parse>) =>
                g.kind === 'path' &&
                g.operationIndex > context.operators.fnArray.lastIndexOf(OPS.endGroup)
            ),
            ledgers = [...new Set([context.graphicsBounds, page.graphicsBounds])],
            slots = ledgers.map((ledger) => ({
              ledger,
              index: ledger.findIndex(
                (g: ReturnType<typeof JSON.parse>) => g.operationIndex === outside.operationIndex
              )
            })),
            originals = slots.map(({ ledger, index }) => ledger[index]),
            freshPlan = (): ReturnType<typeof nativeNonisolatedGroupPixelCrop> =>
              nativeNonisolatedGroupPixelCrop(
                page,
                figure,
                [caption],
                [],
                tokens,
                context,
                figure.rect,
                live,
                createNativeNonisolatedGroupCropProfile(page, tokens, context)
              )
          expect(outside).toBeDefined()
          const witness = context.runningHeadWitness,
            witnessViewport = witness.witnessViewport,
            widthBefore = witnessViewport.width,
            viewportPrototype = Object.getPrototypeOf(witnessViewport),
            sourceHashBefore = witness.sourceSha256
          witnessViewport.width++
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          witnessViewport.width = widthBefore
          Object.setPrototypeOf(witnessViewport, {})
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          Object.setPrototypeOf(witnessViewport, viewportPrototype)
          const converterSlot = Object.getOwnPropertyDescriptor(
            viewportPrototype,
            'convertToViewportPoint'
          )!
          Object.defineProperty(viewportPrototype, 'convertToViewportPoint', {
            ...converterSlot,
            value: (): number[] => []
          })
          try {
            expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          } finally {
            Object.defineProperty(viewportPrototype, 'convertToViewportPoint', converterSlot)
          }
          witness.sourceSha256 = '0'.repeat(64)
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          witness.sourceSha256 = sourceHashBefore
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          let witnessGetterCalls = 0
          for (const [object, key] of [
            [witness, 'witnessViewport'],
            [witnessViewport, 'width']
          ] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(object, key)!
            Object.defineProperty(object, key, {
              configurable: true,
              get() {
                witnessGetterCalls++
                return descriptor.value
              }
            })
            try {
              expect(freshPlan()).toBeUndefined()
            } finally {
              Object.defineProperty(object, key, descriptor)
            }
          }
          expect(witnessGetterCalls).toBe(0)
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          // The exterior fraction is still native source, never part of the picture.
          expect(
            (await nativePage.getTextContent()).items.filter(
              (i) => 'str' in i && ['r', 's'].includes(i.str)
            )
          ).toHaveLength(2)
          for (const { ledger, index } of slots) ledger.splice(index, 1)
          expect(freshPlan()).toBeUndefined()
          slots.forEach(({ ledger, index }, n) => ledger.splice(index, 0, originals[n]))
          for (const { ledger, index } of slots)
            ledger[index] = { ...ledger[index], normalizedRect: [0.4, 0.4, 0.5, 0.5] }
          expect(freshPlan()).toBeUndefined()
          slots.forEach(({ ledger, index }, n) => {
            ledger[index] = originals[n]
          })
          // A conservative bound can miss the group yet reach the final raster halo.
          for (const { ledger, index } of slots) {
            const box = ledger[index].normalizedRect
            ledger[index] = {
              ...ledger[index],
              normalizedRect: [box[0], 300.6 / 400, box[2], box[3]]
            }
          }
          const haloPlan = freshPlan()
          expect(haloPlan).toBeDefined()
          expect(nativeRenderedGroupPixelPngSafe(haloPlan, png, haloPlan.rect, page)).toBe(false)
          slots.forEach(({ ledger, index }, n) => {
            ledger[index] = originals[n]
          })
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          const exteriorTop = outside.normalizedRect[1]
          outside.normalizedRect[1] = exteriorTop + 0.001
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          outside.normalizedRect[1] = exteriorTop
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          tileProgram.argsArray[nestedIndex] = [...nestedImage]
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          tileProgram.argsArray[nestedIndex] = nestedImage
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          expect(nativeRenderedGroupPixelPngSafe(structuredClone(plan), png, plan.rect, page)).toBe(
            false
          )
          const original = live.pageContent
          live.pageContent = structuredClone(original)
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          live.pageContent = original
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          const fontIndex = live.operators.fnArray.indexOf(OPS.setFont),
            font = nativePage.commonObjs.get(live.operators.argsArray[fontIndex][0]),
            character = Object.keys(font.compiledGlyphs)[0],
            oldSlot = Object.getOwnPropertyDescriptor(font.compiledGlyphs, character)!
          let getterCalls = 0
          Object.defineProperty(font.compiledGlyphs, character, {
            configurable: true,
            get() {
              getterCalls++
              return oldSlot.value
            }
          })
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          expect(getterCalls).toBe(0)
          Object.defineProperty(font.compiledGlyphs, character, oldSlot)
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          const originalViewport = nativePage.getViewport,
            oldViewportSlot = Object.getOwnPropertyDescriptor(nativePage, 'getViewport'),
            view = nativePage.view,
            left = view[0]
          Object.defineProperty(nativePage, 'getViewport', {
            configurable: true,
            value: (options: Parameters<typeof nativePage.getViewport>[0]) =>
              originalViewport.call(nativePage, {
                ...options,
                offsetX: (options.offsetX ?? 0) + 20
              })
          })
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          if (oldViewportSlot) Object.defineProperty(nativePage, 'getViewport', oldViewportSlot)
          else delete (nativePage as ReturnType<typeof JSON.parse>).getViewport
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          view[0]++
          expect(nativePage.getViewport).toBe(originalViewport)
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
          view[0] = left
          expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
          const low = createCanvas(201, 181)
          try {
            await nativePage.render({
              canvas: low as never,
              canvasContext: low.getContext('2d') as never,
              viewport: nativePage.getViewport({
                scale: 1,
                offsetX: -plan.rect[0],
                offsetY: -plan.rect[1]
              })
            }).promise
            expect(
              nativeRenderedGroupPixelPngSafe(plan, low.toBuffer('image/png'), plan.rect, page)
            ).toBe(false)
          } finally {
            low.width = low.height = 0
          }
        }
      } finally {
        canvas.width = canvas.height = 0
      }
    }
  } finally {
    await task.destroy()
  }
})

it.each(['complete', 'removed-margin', 'missing-interior', 'zero-exterior'])(
  'binds clipped Type3 pixels to the complete original render while preserving source: %s',
  async (mode) => {
    const { anonymousClippedType3Pdf } = await import(
      pathToFileURL(resolve('test/fixtures/figure-recovery-program.mjs')).href
    )
    const {
      recordPaintedOperationBounds,
      captureNativeFigureRenderContext,
      matchNativeFigureRenderContext
    } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)
    const { collectGraphicsBounds } = await import(
      pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
    )
    const { tableTextToken } = await import(
      pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
    )
    const { renderPdfCrop } = await import(
      pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
    )
    const { nativeRenderedGroupPixelCrop, nativeRenderedGroupPixelPngSafe } = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
    )
    const bytes = anonymousClippedType3Pdf(mode === 'zero-exterior' ? 'outside' : 'inside'),
      checksum = createHash('sha256').update(bytes).digest('hex'),
      loading = getDocument({
        data: bytes,
        fontExtraProperties: true,
        isEvalSupported: false,
        useSystemFonts: false,
        disableFontFace: true,
        verbosity: 0,
        standardFontDataUrl
      })
    try {
      const pdf = await loading.promise,
        nativePage = await pdf.getPage(1),
        content = await nativePage.getTextContent(),
        operators = await nativePage.getOperatorList(),
        viewport = nativePage.getViewport({ scale: 1 }),
        canvas = createCanvas(600, 600)
      try {
        const render = nativePage.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext('2d') as never,
          viewport: nativePage.getViewport({ scale: 1.5 }),
          recordOperations: true
        })
        recordPaintedOperationBounds(render)
        await render.promise
        const graphics = collectGraphicsBounds(render, nativePage.recordedBBoxes),
          snapshot = captureNativeFigureRenderContext(
            render,
            1,
            content,
            viewport,
            graphics.graphicsBounds,
            checksum,
            nativePage.commonObjs
          ),
          context = {
            ...matchNativeFigureRenderContext(
              snapshot,
              1,
              content,
              viewport,
              graphics.graphicsBounds,
              checksum
            ),
            pageNumber: 1,
            sourceSha256: checksum
          },
          allTokens = context.content.items
            .filter((r: { str: string }) => r.str?.trim())
            .map((r: unknown) => tableTextToken(r, viewport, 0)),
          tokens = allTokens.filter((t: { text: string }) =>
            mode === 'removed-margin'
              ? !t.text.startsWith('Running header.')
              : mode === 'missing-interior'
                ? t.text !== 'Left label'
                : true
          ),
          captionToken = tokens.find((t: { text: string }) => t.text.startsWith('Figure 1:')),
          caption = { page: 1, rect: captionToken.rect, lines: [captionToken.text] },
          page = {
            pageNumber: 1,
            width: 400,
            height: 400,
            rotation: 0,
            renderRotation: 0,
            invalidGraphicsBounds: 0,
            graphicsBounds: graphics.graphicsBounds,
            lines: []
          },
          figure = {
            caption,
            rect: [120, 120, 300, 300],
            graphicsCount: graphics.graphicsBounds.length
          },
          before = JSON.stringify({ context, tokens, page, figure }),
          fresh = (): ReturnType<typeof JSON.parse> =>
            nativeRenderedGroupPixelCrop(
              page,
              figure,
              [caption],
              [],
              tokens,
              context,
              figure.rect,
              { nativePage, pageContent: content, operators }
            ),
          plan = fresh()
        expect(JSON.stringify({ context, tokens, page, figure })).toBe(before)
        if (mode === 'missing-interior' || mode === 'zero-exterior') {
          expect(plan).toBeUndefined()
          return
        }
        expect(plan?.rect).toEqual([99.5, 119.5, 300.5, 300.5])
        expect(plan.sourceItems).toBeUndefined()
        expect(context.glyphBounds).toBeUndefined()
        expect(
          context.content.items.some(
            (r: { str: string; width: number }) => r.str === '0' && r.width === 0
          )
        ).toBe(true)
        const png = await renderPdfCrop(nativePage, plan.rect, 0)
        expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
        expect(nativeRenderedGroupPixelPngSafe(structuredClone(plan), png, plan.rect, page)).toBe(
          false
        )
        const program = context.pixelType3Programs[0].glyphs[0].program,
          old = program.argsArray[1][0][0][1]
        program.argsArray[1][0][0][1] = 2
        expect(fresh()).toBeUndefined()
        expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
        program.argsArray[1][0][0][1] = old
        expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(true)
        const font = nativePage.commonObjs.get(context.pixelType3Programs[0].fontName),
          liveProgram =
            font.charProcOperatorList[context.pixelType3Programs[0].glyphs[0].operatorListId],
          original = liveProgram.fnArray
        liveProgram.fnArray = [...original]
        expect(nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, page)).toBe(false)
      } finally {
        canvas.width = canvas.height = 0
      }
    } finally {
      await loading.destroy()
    }
  }
)

// A generated native PDF, not a reduced copy of a paper or a synthetic Source.
async function withAnonymousPairedMicroFigure(
  mode: 'complete' | 'identity' | 'foreign' | 'missing-marker' = 'complete',
  inspect: (fixture: ReturnType<typeof JSON.parse>) => Promise<void>
): Promise<void> {
  const objects: string[] = [],
    add = (s: string): number => objects.push(s),
    stream = (s: string, dict = ''): number => {
      if (mode === 'identity') s = s.replaceAll('\\265', 'r')
      return add(`<< ${dict} /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`)
    },
    catalog = add(''),
    pages = add(''),
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    group = (bottom: number): number =>
      stream(
        `0 0 0 RG 1 w 100 ${bottom + 10} 180 60 re S 110 ${bottom + 30} m 270 ${bottom + 30} l S BT /T 8 Tf 1 0 0 1 100 ${bottom + 60} Tm (Left) Tj 1 0 0 1 180 ${bottom + 40} Tm (Middle) Tj 1 0 0 1 260 ${bottom + 15} Tm (Right) Tj ET`,
        `/Type /XObject /Subtype /Form /BBox [90 ${bottom} 310 ${bottom + 80}] /Group << /S /Transparency /I false /K false >> /Resources << /Font << /T ${font} 0 R >> >>`
      ),
    a = group(330),
    b = group(210),
    description = (s: string, y: number): string =>
      `BT /T 8 Tf 1 0 0 1 90 ${y} Tm [${s
        .split(' ')
        .map((word) => `(${word})`)
        .join(' -278 ')}] TJ ET`,
    body = stream(
      'BT /T 10 Tf 1 0 0 1 90 450 Tm [(Running) -278 (header.)] TJ ET q /A Do Q ' +
        description('(a) A complete native record.', 316) +
        description('A parameter \\265, remains unchanged.', 304) +
        ' q /B Do Q ' +
        description(
          mode === 'missing-marker'
            ? 'A second complete native record.'
            : '(b) A second complete native record.',
          198
        ) +
        description('The pair \\265, is measured.', 186) +
        description('Both records remain complete.', 174) +
        ' BT /T 10 Tf 1 0 0 1 90 150 Tm [(Figure) -278 (1:) -278 (Paired) -278 (native) -278 (records.)] TJ ET' +
        (mode === 'foreign' ? ' BT /T 4 Tf 1 0 0 1 86 360 Tm (X) Tj ET' : '')
    ),
    pageId = add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 400 480] /Resources << /Font << /T ${font} 0 R >> /XObject << /A ${a} 0 R /B ${b} 0 R >> >> /Contents ${body} 0 R >>`
    )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    sourceSha256 = createHash('sha256').update(bytes).digest('hex'),
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
      standardFontDataUrl
    }),
    {
      recordPaintedOperationBounds,
      captureNativeFigureRenderContext,
      matchNativeFigureRenderContext,
      attachNativeDualApiEvidence
    } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href),
    { collectGraphicsBounds } = await import(
      pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
    ),
    { tableTextToken } = await import(
      pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
    )
  let canvas: ReturnType<typeof createCanvas> | undefined
  try {
    const document = await loading.promise,
      nativePage = await document.getPage(1),
      viewport = nativePage.getViewport({ scale: 1 }),
      content = await nativePage.getTextContent(),
      raw = await nativePage.getTextContent({ disableNormalization: true })
    canvas = createCanvas(400, 480)
    const render = nativePage.render({
      canvas: canvas as never,
      canvasContext: canvas.getContext('2d') as never,
      viewport,
      recordOperations: true
    })
    recordPaintedOperationBounds(render)
    await render.promise
    const graphics = collectGraphicsBounds(
        render,
        (nativePage as ReturnType<typeof JSON.parse>).recordedBBoxes
      ),
      snapshot = captureNativeFigureRenderContext(
        render,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        sourceSha256,
        nativePage.commonObjs
      ),
      context = {
        ...matchNativeFigureRenderContext(
          snapshot,
          1,
          content,
          viewport,
          graphics.graphicsBounds,
          sourceSha256
        ),
        pageNumber: 1,
        sourceSha256
      },
      tokens = context.content.items
        .filter((r: ReturnType<typeof JSON.parse>) => r.str?.trim())
        .map((r: ReturnType<typeof JSON.parse>) => tableTextToken(r, viewport, 0)),
      cap = tokens.find((t: ReturnType<typeof JSON.parse>) => t.text.startsWith('Figure 1:')),
      caption = { page: 1, rect: cap.rect, lines: [cap.text] },
      page = {
        pageNumber: 1,
        width: 400,
        height: 480,
        rotation: 0,
        renderRotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds: graphics.graphicsBounds,
        lines: []
      },
      figure = { caption, reason: 'no-unambiguous-adjacent-graphics' },
      live = {
        nativePage,
        pageContent: content,
        operators: await nativePage.getOperatorList(),
        sourceSha256
      }
    expect(context.operators).toBeDefined()
    expect(attachNativeDualApiEvidence(snapshot, content, raw).dualApiEvidence).toBeUndefined()
    expect(content.items.some((r: ReturnType<typeof JSON.parse>) => r.str?.includes('μ,'))).toBe(
      mode !== 'identity'
    )
    await inspect({ page, figure, captions: [caption], tokens, context, live, content, raw })
  } finally {
    if (canvas) canvas.width = canvas.height = 0
    await loading.destroy()
  }
}

it('keeps both native transparency groups and whole micro-sign descriptions pixel-only', async () => {
  const m = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
  )
  await withAnonymousPairedMicroFigure('complete', async (f) => {
    const before = JSON.stringify([f.content, f.raw, f.tokens]),
      plan = await m.nativePairedDescriptionGroupPixelCrop(
        f.page,
        f.figure,
        f.captions,
        [],
        f.tokens,
        f.context,
        f.live
      )
    expect(plan).toBeDefined()
    expect(plan.sourceItems).toBeUndefined()
    expect(plan.rect[1]).toBeLessThan(70)
    expect(plan.rect[3]).toBeGreaterThan(306)
    expect(plan.rect[3]).toBeLessThan(f.figure.caption.rect[1])
    expect(m.nativePairedDescriptionGroupPixelCurrent(plan, f.page)).toBe(true)
    expect(m.nativePairedDescriptionGroupPixelCurrent(structuredClone(plan), f.page)).toBe(false)
    expect(
      m.nativeRenderedGroupPixelCrop(
        f.page,
        f.figure,
        f.captions,
        [],
        f.tokens,
        f.context,
        undefined,
        f.live
      )
    ).toBeUndefined()
    const canvas = createCanvas(
        Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
        Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
      ),
      png = canvas.toBuffer('image/png')
    expect(m.nativePairedDescriptionGroupPixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    expect(m.nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    const low = createCanvas(
      Math.ceil(plan.rect[2] - plan.rect[0]),
      Math.ceil(plan.rect[3] - plan.rect[1])
    )
    expect(
      m.nativePairedDescriptionGroupPixelPngSafe(plan, low.toBuffer('image/png'), plan.rect, f.page)
    ).toBe(false)
    const original = f.context.operators.argsArray
    f.context.operators.argsArray = structuredClone(original)
    expect(m.nativePairedDescriptionGroupPixelCurrent(plan, f.page)).toBe(false)
    f.context.operators.argsArray = original
    expect(m.nativePairedDescriptionGroupPixelCurrent(plan, f.page)).toBe(true)
    expect(JSON.stringify([f.content, f.raw, f.tokens])).toBe(before)
    canvas.width = canvas.height = low.width = low.height = 0
  })
})
it.each(['foreign', 'missing-marker'] as const)(
  'declines the paired crop with %s evidence',
  async (mode) => {
    const m = await import(
      pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
    )
    await withAnonymousPairedMicroFigure(mode, async (f) => {
      expect(
        await m.nativePairedDescriptionGroupPixelCrop(
          f.page,
          f.figure,
          f.captions,
          [],
          f.tokens,
          f.context,
          f.live
        )
      ).toBeUndefined()
    })
  }
)
it('requires the actual same-page micro cursor and independent foreign-table clearance', async () => {
  const m = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
  )
  await withAnonymousPairedMicroFigure('complete', async (f) => {
    expect(
      await m.nativePairedDescriptionGroupPixelCrop(
        f.page,
        f.figure,
        f.captions,
        [[90, 280, 300, 310]],
        f.tokens,
        f.context,
        f.live
      )
    ).toBeUndefined()
    expect(
      await m.nativePairedDescriptionGroupPixelCrop(
        f.page,
        f.figure,
        f.captions,
        [],
        f.tokens,
        f.context,
        { ...f.live, sourceSha256: 'f'.repeat(64) }
      )
    ).toBeUndefined()
    const old = f.live.nativePage.getTextContent
    Object.defineProperty(f.live.nativePage, 'getTextContent', {
      configurable: true,
      value: async (options: ReturnType<typeof JSON.parse>) => {
        const raw = await old.call(f.live.nativePage, options),
          out = { ...raw, items: raw.items.map((r: ReturnType<typeof JSON.parse>) => ({ ...r })) },
          r = out.items.find((r: ReturnType<typeof JSON.parse>) => r.str?.includes('µ,'))
        r.width += 0.001
        return out
      }
    })
    try {
      expect(
        await m.nativePairedDescriptionGroupPixelCrop(
          f.page,
          f.figure,
          f.captions,
          [],
          f.tokens,
          f.context,
          f.live
        )
      ).toBeUndefined()
    } finally {
      delete f.live.nativePage.getTextContent
    }
  })
})
it('does not treat other punctuation changes or an incomplete original micro cursor as normalization', async () => {
  const m = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
  )
  await withAnonymousPairedMicroFigure('complete', async (f) => {
    const old = f.live.nativePage.getTextContent
    Object.defineProperty(f.live.nativePage, 'getTextContent', {
      configurable: true,
      value: async (options: ReturnType<typeof JSON.parse>) => {
        const raw = await old.call(f.live.nativePage, options),
          out = { ...raw, items: raw.items.map((r: ReturnType<typeof JSON.parse>) => ({ ...r })) },
          r = out.items.find((r: ReturnType<typeof JSON.parse>) => r.str?.includes('µ,'))
        r.str = r.str.replace('µ,', 'µ;')
        return out
      }
    })
    try {
      expect(
        await m.nativePairedDescriptionGroupPixelCrop(
          f.page,
          f.figure,
          f.captions,
          [],
          f.tokens,
          f.context,
          f.live
        )
      ).toBeUndefined()
    } finally {
      delete f.live.nativePage.getTextContent
    }
    const op = f.context.operators.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText &&
          f.context.operators.argsArray[i][0].some(
            (g: ReturnType<typeof JSON.parse>) => g?.unicode === 'µ'
          )
      ),
      glyph = f.context.operators.argsArray[op][0].find(
        (g: ReturnType<typeof JSON.parse>) => g?.unicode === 'µ'
      ),
      width = glyph.width
    glyph.width += 10
    try {
      expect(
        await m.nativePairedDescriptionGroupPixelCrop(
          f.page,
          f.figure,
          f.captions,
          [],
          f.tokens,
          f.context,
          f.live
        )
      ).toBeUndefined()
    } finally {
      glyph.width = width
    }
    expect(
      await m.nativePairedDescriptionGroupPixelCrop(
        f.page,
        f.figure,
        f.captions,
        [],
        f.tokens,
        f.context,
        f.live
      )
    ).toBeDefined()
  })
})

it('accepts an identical default and raw native relation without requiring a micro sign', async () => {
  const m = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-group.mjs')).href
  )
  await withAnonymousPairedMicroFigure('identity', async (f) => {
    expect(f.content).toEqual(f.raw)
    const before = JSON.stringify([f.content, f.raw, f.tokens]),
      plan = await m.nativePairedDescriptionGroupPixelCrop(
        f.page,
        f.figure,
        f.captions,
        [],
        f.tokens,
        f.context,
        f.live
      )
    expect(plan).toBeDefined()
    expect(m.nativePairedDescriptionGroupPixelCurrent(plan, f.page)).toBe(true)
    expect(plan.sourceItems).toBeUndefined()
    expect(JSON.stringify([f.content, f.raw, f.tokens])).toBe(before)
  })
})

async function withRepeatedPaintHeader(
  inspect: (fixture: ReturnType<typeof JSON.parse>) => Promise<void>,
  variant: '' | 'body-repeat' | 'third-form' | 'foreign-paint' = ''
): Promise<void> {
  const {
    captureNativeFigureRenderContext,
    matchNativeFigureRenderContext,
    recordPaintedOperationBounds
  } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)
  const { collectGraphicsBounds } = await import(
    pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
  )
  const { tableTextToken } = await import(
    pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
  )
  const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
  )
  const { renderPdfCrop } = await import(
    pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
  )
  const objects: string[] = [],
    add = (s: string): number => objects.push(s),
    stream = (s: string, d = ''): number =>
      add(`<< ${d} /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    catalog = add(''),
    pages = add(''),
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    logo = stream(
      '0.2 0.3 0.6 rg 0 0 16 10 re f 20 0 16 12 re f 40 0 18 10 re f',
      '/Type /XObject /Subtype /Form /BBox [0 0 60 12] /Resources << >>'
    ),
    chart = stream(
      '0 0 0 rg 1 w 50 570 500 150 re S 50 620 m 550 620 l S 50 670 m 550 670 l S BT /T 10 Tf 1 0 0 1 70 700 Tm (Measured value) Tj ET',
      `/Type /XObject /Subtype /Form /BBox [45 565 555 725] /Resources << /Font << /T ${font} 0 R >> >>`
    ),
    header = `${variant === 'body-repeat' ? 'q 1 0 0 1 0 -130 cm ' : ''}BT /T 8 Tf 1 0 0 1 40 770 Tm (REPORT) Tj ET q 1 0 0 1 480 766 cm /L Do Q q 0.4 w 40 762 m 550 762 l S Q${variant === 'body-repeat' ? ' Q' : ''}`,
    body = stream(
      `${header} q /C Do Q ${variant === 'third-form' ? 'q 1 0 0 1 480 766 cm /L Do Q' : variant === 'foreign-paint' ? '100 600 20 20 re f' : ''} BT /T 10 Tf 1 0 0 1 50 530 Tm (Figure 1: Anonymous measurements.) Tj ET`
    ),
    witness = stream(`${header} BT /T 10 Tf 1 0 0 1 50 700 Tm (An independent paragraph.) Tj ET`),
    blank = stream(''),
    ids = []
  for (const content of [blank, witness, blank, body])
    ids.push(
      add(
        `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 600 800] /Resources << /Font << /T ${font} 0 R >> /XObject << /L ${logo} 0 R /C ${chart} 0 R >> >> /Contents ${content} 0 R >>`
      )
    )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${ids.map((i) => `${i} 0 R`).join(' ')}] /Count 4 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, o] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    sha = createHash('sha256').update(bytes).digest('hex'),
    pdfres = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    task = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
      standardFontDataUrl: join(pdfres, 'standard_fonts') + '/'
    })
  try {
    const doc = await task.promise
    const read = async (pn: number): Promise<ReturnType<typeof JSON.parse>> => {
      const page = await doc.getPage(pn),
        v = page.getViewport({ scale: 1 }),
        s = page.getViewport({ scale: 1.5 }),
        canvas = createCanvas(s.width, s.height),
        r = page.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext('2d') as never,
          viewport: s,
          recordOperations: true
        })
      recordPaintedOperationBounds(r)
      await r.promise
      const content = await page.getTextContent(),
        g = collectGraphicsBounds(r, (page as ReturnType<typeof JSON.parse>).recordedBBoxes),
        context = {
          ...matchNativeFigureRenderContext(
            captureNativeFigureRenderContext(
              r,
              pn,
              content,
              v,
              g.graphicsBounds,
              sha,
              page.commonObjs
            ),
            pn,
            content,
            v,
            g.graphicsBounds,
            sha
          ),
          pageNumber: pn,
          sourceSha256: sha
        }
      return { page, v, g, context }
    }
    const f = await read(4),
      w = await read(2),
      c = f.context
    c.runningHeadWitness = {
      sourceSha256: sha,
      currentPageNumber: 4,
      witnessPageNumber: 2,
      currentContent: c.content,
      witnessContent: w.context.content,
      witnessViewport: w.v,
      paintPrefix: {
        operators: {
          fnArray: w.context.operators.fnArray.slice(0, 512),
          argsArray: w.context.operators.argsArray.slice(0, 512)
        },
        glyphBounds: w.context.glyphBounds
      }
    }
    const tokens = c.content.items
        .filter((r: ReturnType<typeof JSON.parse>) => r.str?.trim())
        .map((r: ReturnType<typeof JSON.parse>) => tableTextToken(r, f.v, 0)),
      cap = tokens.find((t: ReturnType<typeof JSON.parse>) => t.text.startsWith('Figure 1:')),
      caption = { page: 4, rect: cap.rect, lines: [cap.text] },
      page = {
        pageNumber: 4,
        width: 600,
        height: 800,
        rotation: 0,
        renderRotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds: f.g.graphicsBounds,
        lines: []
      },
      figure = { caption, rect: [35, 20, 555, 245] },
      fresh = (): ReturnType<typeof JSON.parse> =>
        nativeCertifiedFigurePixelCrop(
          page,
          figure,
          [caption],
          [],
          tokens,
          c,
          [figure],
          figure.rect
        )
    await inspect({
      context: c,
      witness: c.runningHeadWitness,
      figure,
      page,
      tokens,
      fresh,
      nativePage: f.page,
      renderPdfCrop,
      nativeCertifiedFigurePixelPngSafe
    })
  } finally {
    await task.destroy()
  }
}

it('excludes a complete repeated native publisher header while retaining the independent Form', async () => {
  await withRepeatedPaintHeader(async (f) => {
    const before = JSON.stringify(f.figure),
      plan = f.fresh()
    expect(plan?.kind).toBe('complete-native-picture-with-repeated-header')
    expect(plan.rect[1]).toBeGreaterThan(60)
    expect(Object.keys(plan).sort()).toEqual(['graphicsCount', 'kind', 'rect'].sort())
    const png = await f.renderPdfCrop(f.nativePage, plan.rect)
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    expect(JSON.stringify(f.figure)).toBe(before)
  })
})
const repeatedPaintHeaderRefusals: [string, (fixture: ReturnType<typeof JSON.parse>) => void][] = [
  ['missing witness', (f) => delete f.context.runningHeadWitness],
  ['wrong document', (f) => (f.witness.sourceSha256 = '0'.repeat(64))],
  ['equal-size shifted viewport origin', (f) => (f.witness.witnessViewport.transform[4] += 10)],
  ['changed source identity', (f) => (f.witness.witnessContent.items[0].sourceItem.index = 1)],
  [
    'changed font bounds',
    (f) => (f.witness.paintPrefix.glyphBounds[0].glyphs[0].bounds[2] += 0.01)
  ],
  [
    'changed path program',
    (f) => {
      const o = f.witness.paintPrefix.operators,
        i = o.fnArray.findIndex((x: number) => x === OPS.constructPath)
      o.argsArray[i][1][0][1] += 1
    }
  ],
  [
    'changed Form clip',
    (f) => {
      const o = f.witness.paintPrefix.operators,
        i = o.fnArray.findIndex((x: number) => x === OPS.paintFormXObjectBegin)
      o.argsArray[i][1][2] -= 1
    }
  ],
  ['missing header glyph program', (f) => (f.witness.paintPrefix.glyphBounds = [])],
  [
    'accessor witness',
    (f) =>
      Object.defineProperty(f.witness.paintPrefix, 'operators', {
        get: () => {
          throw new Error('must not read accessor')
        }
      })
  ]
]
it.each(repeatedPaintHeaderRefusals)(
  'retains the previous picture without closed publisher-header evidence: %s',
  async (_name, mutate) => {
    await withRepeatedPaintHeader(async (f) => {
      mutate(f)
      expect(f.fresh()).toBeUndefined()
    })
  }
)
it.each(['body-repeat', 'third-form', 'foreign-paint'] as const)(
  'does not discard repeated body content or competing figure paint: %s',
  async (variant) => {
    await withRepeatedPaintHeader(async (f) => {
      expect(f.fresh()).toBeUndefined()
    }, variant)
  }
)
it('rejects a publisher-header PNG when its source witness changes', async () => {
  await withRepeatedPaintHeader(async (f) => {
    const plan = f.fresh()
    expect(plan).toBeDefined()
    const png = await f.renderPdfCrop(f.nativePage, plan.rect)
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    f.witness.witnessContent.items[0].str = 'OTHER'
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  })
})

async function withWrappedProof(
  inspect: (fixture: ReturnType<typeof JSON.parse>) => Promise<void>,
  variant:
    | ''
    | 'wrong-equation'
    | 'missing-proof'
    | 'wrong-ending'
    | 'open-qed'
    | 'foreign-paint'
    | 'misaligned-qed'
    | 'anchor-other-column'
    | 'anchor-order' = ''
): Promise<void> {
  const {
    captureNativeFigureRenderContext,
    matchNativeFigureRenderContext,
    recordPaintedOperationBounds
  } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)
  const { collectGraphicsBounds } = await import(
    pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
  )
  const { tableTextToken } = await import(
    pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
  )
  const { nativeCertifiedFigurePixelCrop, nativeCertifiedFigurePixelPngSafe } = await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
  )
  const { renderPdfCrop } = await import(
    pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
  )
  const objects: string[] = [],
    add = (s: string): number => objects.push(s),
    stream = (s: string): number =>
      add(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    catalog = add(''),
    pages = add(''),
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    math = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>'
    )
  const stroke = (x: number, y: number, x2: number, y2: number): string =>
    `q 1 0 0 1 ${x + (variant === 'misaligned-qed' ? 12 : 0)} ${y} cm 0.4 w 0 J [] 0 d 0 0 m ${x2} ${y2} l S Q`
  const body = stream(
    `0 0 0 rg 0 0 0 RG BT /T 10 Tf 1 0 0 1 469.45 ${variant === 'anchor-order' ? 690 : 740} Tm (${variant === 'wrong-equation' ? '(3.3)' : '(3.2)'}) Tj ET BT /M 10 Tf 1 0 0 1 ${variant === 'anchor-other-column' ? 180 : 40} 700 Tm (${variant === 'missing-proof' ? 'Note.' : 'Proof.'}) Tj ET BT /T 10 Tf 1 0 0 1 40 650 Tm (Hence) Tj /M 10 Tf 1 0 0 1 74 650 Tm (x) Tj /T 10 Tf 1 0 0 1 85 650 Tm (the complete result now) Tj /M 10 Tf 1 0 0 1 220 650 Tm (y) Tj /T 10 Tf 1 0 0 1 460 650 Tm (${variant === 'wrong-ending' ? 'values' : 'proves'}) Tj 1 0 0 1 40 636 Tm ((3.2).) Tj ET ${stroke(482, 636, 0, 8)} ${stroke(490, 636, 0, 8)} ${stroke(482.2, 636.2, 7.6, 0)} ${variant === 'open-qed' ? '' : stroke(482.2, 643.8, 7.6, 0)} ${variant === 'foreign-paint' ? '60 620 5 5 re f' : ''} q 1 w 80 350 420 200 re S 80 420 m 500 420 l S 80 490 m 500 490 l S BT /T 10 Tf 1 0 0 1 100 530 Tm (Measured value) Tj ET Q BT /T 10 Tf 1 0 0 1 50 300 Tm (Figure 1: Anonymous measurements.) Tj ET`
  )
  const pageId = add(
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 600 800] /Resources << /Font << /T ${font} 0 R /M ${math} 0 R >> >> /Contents ${body} 0 R >>`
  )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, o] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(Buffer.from(pdf)),
    sha = createHash('sha256').update(bytes).digest('hex'),
    pdfres = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    task = getDocument({
      data: bytes,
      fontExtraProperties: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
      standardFontDataUrl: join(pdfres, 'standard_fonts') + '/'
    })
  try {
    const doc = await task.promise,
      nativePage = await doc.getPage(1),
      v = nativePage.getViewport({ scale: 1 }),
      s = nativePage.getViewport({ scale: 1.5 }),
      canvas = createCanvas(s.width, s.height),
      render = nativePage.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport: s,
        recordOperations: true
      })
    recordPaintedOperationBounds(render)
    await render.promise
    const content = await nativePage.getTextContent(),
      g = collectGraphicsBounds(
        render,
        (nativePage as ReturnType<typeof JSON.parse>).recordedBBoxes
      ),
      context = {
        ...matchNativeFigureRenderContext(
          captureNativeFigureRenderContext(
            render,
            1,
            content,
            v,
            g.graphicsBounds,
            sha,
            nativePage.commonObjs
          ),
          1,
          content,
          v,
          g.graphicsBounds,
          sha
        ),
        pageNumber: 1,
        sourceSha256: sha
      },
      tokens = context.content.items
        .filter((r: ReturnType<typeof JSON.parse>) => r.str?.trim())
        .map((r: ReturnType<typeof JSON.parse>) => tableTextToken(r, v, 0)),
      cap = tokens.find((t: ReturnType<typeof JSON.parse>) => t.text.startsWith('Figure 1:')),
      caption = { page: 1, rect: cap.rect, lines: [cap.text] },
      page = {
        pageNumber: 1,
        width: 600,
        height: 800,
        rotation: 0,
        renderRotation: 0,
        invalidGraphicsBounds: 0,
        graphicsBounds: g.graphicsBounds,
        lines: []
      },
      figure = { caption, rect: [35, 140, 510, 460] },
      fresh = (): ReturnType<typeof JSON.parse> =>
        nativeCertifiedFigurePixelCrop(
          page,
          figure,
          [caption],
          [],
          tokens,
          context,
          [figure],
          figure.rect
        )
    await inspect({
      context,
      tokens,
      page,
      figure,
      fresh,
      nativePage,
      renderPdfCrop,
      nativeCertifiedFigurePixelPngSafe
    })
  } finally {
    await task.destroy()
  }
}

it('removes only a complete wrapped equation-proof conclusion and its native QED', async () => {
  await withWrappedProof(async (f) => {
    const before = JSON.stringify(f.figure),
      plan = f.fresh()
    expect(plan).toBeDefined()
    expect(plan.rect[1]).toBeGreaterThan(200)
    expect(Object.keys(plan).sort()).toEqual(['graphicsCount', 'kind', 'rect'].sort())
    const png = await f.renderPdfCrop(f.nativePage, plan.rect)
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    expect(JSON.stringify(f.figure)).toBe(before)
  })
})
it.each([
  'wrong-equation',
  'missing-proof',
  'wrong-ending',
  'open-qed',
  'foreign-paint',
  'misaligned-qed',
  'anchor-other-column',
  'anchor-order'
] as const)('preserves unproved wrapped equation-proof paint: %s', async (variant) => {
  await withWrappedProof(async (f) => {
    expect(f.fresh()).toBeUndefined()
  }, variant)
})
const wrappedProofRefusals: [string, (f: ReturnType<typeof JSON.parse>) => void][] = [
  [
    'partial source literal',
    (f) => {
      const r = f.context.content.items.find(
        (r: ReturnType<typeof JSON.parse>) => r.str === 'Hence'
      )
      r.sourceItem.text = 'Hen'
    }
  ],
  ['missing glyph outline', (f) => (f.context.glyphBounds = [])],
  [
    'stroked conclusion text',
    (f) => {
      const o = f.context.operators,
        i = o.fnArray.findIndex((op: number) => op === OPS.showText)
      o.fnArray.splice(i, 0, OPS.setTextRenderingMode)
      o.argsArray.splice(i, 0, [1])
    }
  ]
]
it.each(wrappedProofRefusals)(
  'rejects incomplete native wrapped-proof ownership: %s',
  async (_name, mutate) => {
    await withWrappedProof(async (f) => {
      mutate(f)
      expect(f.fresh()).toBeUndefined()
    })
  }
)
it('rejects a wrapped-proof PNG when its native path changes', async () => {
  await withWrappedProof(async (f) => {
    const plan = f.fresh()
    expect(plan).toBeDefined()
    const png = await f.renderPdfCrop(f.nativePage, plan.rect)
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    const operators = f.context.operators
    const index = operators.fnArray.findIndex((op: number) => op === OPS.constructPath)
    operators.argsArray[index][1][0][1] += 1
    expect(f.nativeCertifiedFigurePixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
  })
})

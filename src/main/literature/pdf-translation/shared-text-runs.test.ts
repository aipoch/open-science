/* eslint-disable @typescript-eslint/explicit-function-return-type -- infer native synthetic fixture helpers */
import { expect, it } from 'vitest'
import {
  PDFDocument,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  clip,
  endPath,
  rectangle
} from 'pdf-lib'
// @ts-expect-error Worker-private native JavaScript has no main/renderer public API.
import { engine } from '../../../../resources/pdf-translation/pdfium.mjs'
import {
  recoverOverprintedTextSources,
  splitSharedTextRuns
  // @ts-expect-error Worker-private native JavaScript has no main/renderer public API.
} from '../../../../resources/pdf-translation/shared-text-runs.mjs'

type NativeObject = { obj: number; type: number; text?: string; bounds: number[] }

it.each(['kerning', 'spacing', 'pixel-rollback', 'legacy-fallback', 'effective-clip', 'long-run'])(
  'splits shared native runs only with exact ink proof: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      long = kind === 'long-run',
      width = long ? 1800 : 612,
      height = long ? 200 : 792,
      page = pdf.addPage([width, height]),
      font = await pdf.embedFont(
        kind === 'kerning' || kind === 'spacing'
          ? StandardFonts.TimesRoman
          : StandardFonts.Helvetica
      ),
      x = kind === 'kerning' || kind === 'spacing' ? 165.667 : 40,
      y = long ? 100 : 711.163,
      size = kind === 'kerning' || kind === 'spacing' ? 7.9701 : 10,
      first = long
        ? 'I'.repeat(495)
        : kind === 'kerning' || kind === 'spacing'
          ? 'top-1 err.'
          : 'Method',
      second = kind === 'kerning' || kind === 'spacing' ? 'top-5 err.' : '11'
    if (kind === 'effective-clip')
      page.pushOperators(rectangle(x + 12, y - 4, 180, 18), clip(), endPath())
    // Establish a font resource; the actual run remains one native TJ object.
    page.drawText('', { font, size, x, y })
    const key = page.node.newFontDictionary(font.name, font.ref),
      parts =
        kind === 'kerning' || kind === 'spacing'
          ? [
              font.encodeText('top-1 err'),
              kind === 'spacing' ? 95 : 55,
              font.encodeText('.'),
              -2000,
              font.encodeText('top-5 err'),
              55,
              font.encodeText('.')
            ]
          : [font.encodeText(first), -2000, font.encodeText(second)]
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(size)]),
      PDFOperator.of(
        PDFOperatorNames.SetTextMatrix,
        [1, 0, 0, 1, x, y].map((v) => PDFNumber.of(v))
      ),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [pdf.context.obj(parts)]),
      PDFOperator.of(PDFOperatorNames.EndText)
    )
    const e = await engine(),
      input = e.open(await pdf.save()),
      p = e.p,
      native = p.FPDF_LoadPage(input.doc, 0),
      at = e.alloc(64),
      objects = () => e.objects(native) as NativeObject[],
      initial = objects(),
      original = initial.find((o) => o.type === 1 && o.text?.includes(first.slice(0, 5)))!,
      render = () => {
        const bitmap = p.FPDFBitmap_Create(width * 2, height * 2, 1)
        try {
          p.FPDFBitmap_FillRect(bitmap, 0, 0, width * 2, height * 2, 0xffffffff)
          p.FPDF_RenderPageBitmap(bitmap, native, 0, 0, width * 2, height * 2, 0, 0)
          const buffer = p.FPDFBitmap_GetBuffer(bitmap)
          return e.m.HEAPU8.slice(buffer, buffer + height * 2 * p.FPDFBitmap_GetStride(bitmap))
        } finally {
          p.FPDFBitmap_Destroy(bitmap)
        }
      }
    try {
      expect(original).toBeDefined()
      const text = p.FPDFText_LoadPage(native),
        chars: Array<{ code: number; x: number; right: number }> = []
      try {
        for (let i = 0; i < p.FPDFText_CountChars(text); i++) {
          if (p.FPDFText_GetTextObject(text, i) !== original.obj) continue
          const code = p.FPDFText_GetUnicode(text, i)
          if (code === 32) continue
          p.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24)
          chars.push({ code, x: e.m.HEAPF64[at / 8], right: e.m.HEAPF64[at / 8 + 1] })
        }
      } finally {
        p.FPDFText_ClosePage(text)
      }
      const firstChars = first.replace(/\s/gu, '').length,
        rectangles = [
          {
            x: original.bounds[0] - 0.1,
            width: chars[firstChars - 1].right - original.bounds[0] + 0.2,
            bottom: y - 4,
            top: y + 10,
            sourceItems: [first]
          },
          {
            x: chars[firstChars].x - 0.1,
            width: original.bounds[2] - chars[firstChars].x + 0.2,
            bottom: y - 4,
            top: y + 10,
            sourceItems: [second]
          }
        ],
        before = render(),
        nativeRender = p.FPDF_RenderPageBitmap,
        setText = p.FPDFText_SetText
      let attemptedGroups = 0,
        rejectedPaints = 0
      p.FPDFText_SetText = (obj: number, buffer: number) => {
        if (e.m.HEAPU16[buffer / 2 + 1]) attemptedGroups++
        return setText(obj, buffer)
      }
      p.FPDF_RenderPageBitmap = (...args: number[]) => {
        nativeRender(...args)
        if (!['pixel-rollback', 'legacy-fallback'].includes(kind)) return
        p.FPDFPageObj_GetIsActive(original.obj, at)
        if (e.m.HEAP32[at / 4]) return
        if (
          kind === 'legacy-fallback' &&
          !objects().some(
            (o) => o.obj !== original.obj && (o.text?.replace(/\s/gu, '').length ?? 0) > 1
          )
        )
          return
        const buffer = p.FPDFBitmap_GetBuffer(args[0])
        e.m.HEAPU8[buffer] ^= 1
        rejectedPaints++
      }
      splitSharedTextRuns(e, input.doc, native, rectangles)
      p.FPDF_RenderPageBitmap = nativeRender
      p.FPDFText_SetText = setText
      const after = objects()
      expect(Buffer.compare(Buffer.from(render()), Buffer.from(before))).toBe(0)
      expect(
        after
          .map((o) => o.text ?? '')
          .join('')
          .replace(/\s/gu, '')
      ).toBe((first + second).replace(/\s/gu, ''))
      if (kind === 'pixel-rollback' || kind === 'effective-clip') expect(after).toEqual(initial)
      if (kind === 'pixel-rollback') expect(rejectedPaints).toBe(2)
      if (kind === 'legacy-fallback') {
        expect(rejectedPaints).toBe(1)
        expect(after.some((o) => o.obj === original.obj)).toBe(false)
        expect(after.every((o) => (o.text?.replace(/\s/gu, '').length ?? 0) <= 1)).toBe(true)
      }
      if (kind === 'kerning') {
        expect(after.some((o) => o.obj === original.obj)).toBe(false)
        expect(after.some((o) => o.text?.replace(/\s/gu, '') === 'err')).toBe(true)
      }
      if (long) expect(attemptedGroups).toBeGreaterThan(30)
    } finally {
      e.free(at)
      p.FPDF_ClosePage(native)
      input.close()
    }
  }
)

it.each([
  'native',
  'injected-space',
  'different-label',
  'inactive',
  'different-color',
  'different-size',
  'effective-clip',
  'read-failure',
  'incomplete-read',
  'partial-read',
  'restore-failure',
  'pixel-change'
])('recovers only identical native overprints and restores the page: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([240, 120]),
    font = await pdf.embedFont(
      kind === 'injected-space' ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman
    ),
    letter = kind === 'injected-space' ? 's' : 'd'
  if (kind === 'effective-clip') page.pushOperators(rectangle(48, 59, 6, 9), clip(), endPath())
  for (const [index, text] of [letter, letter, letter].entries())
    page.drawText(text, {
      font,
      size: kind === 'injected-space' ? 9 : kind === 'different-size' && index > 0 ? 11 : 10,
      x: 50 + index * 0.2,
      y: 60 + (index === 1 ? 0.2 : 0)
    })
  if (kind === 'injected-space')
    page.drawText('=1.3)', {
      font: await pdf.embedFont(StandardFonts.TimesRoman),
      size: 9,
      x: 55,
      y: 60
    })
  page.drawText('Unrelated text', { font, size: 10, x: 50, y: 30 })
  const e = await engine(),
    input = e.open(await pdf.save()),
    p = e.p,
    native = p.FPDF_LoadPage(input.doc, 0),
    at = e.alloc(64),
    objects = () => e.objects(native) as NativeObject[],
    active = (obj: number) => {
      expect(p.FPDFPageObj_GetIsActive(obj, at)).toBeTruthy()
      return !!e.m.HEAP32[at / 4]
    },
    render = () => {
      const bitmap = p.FPDFBitmap_Create(480, 240, 1)
      try {
        p.FPDFBitmap_FillRect(bitmap, 0, 0, 480, 240, 0xffffffff)
        p.FPDF_RenderPageBitmap(bitmap, native, 0, 0, 480, 240, 0, 0)
        const buffer = p.FPDFBitmap_GetBuffer(bitmap)
        return e.m.HEAPU8.slice(buffer, buffer + 240 * p.FPDFBitmap_GetStride(bitmap))
      } finally {
        p.FPDFBitmap_Destroy(bitmap)
      }
    },
    nativeTextLoad = p.FPDFText_LoadPage,
    nativeGetText = p.FPDFTextObj_GetText,
    nativeSetActive = p.FPDFPageObj_SetIsActive,
    nativeRender = p.FPDF_RenderPageBitmap
  let rejectedRestore = 0,
    reads = 0,
    paints = 0
  try {
    const original = objects(),
      duplicates = original.filter((o) => o.type === 1 && o.text === '')
    if (kind === 'different-size') expect(original.filter((o) => o.type === 1)).toHaveLength(4)
    else expect(duplicates).toHaveLength(2)
    const label = original.find((o) => o.text?.trim() === letter)!,
      unrelated = original.find((o) => o.text === 'Unrelated text')!
    if (kind === 'injected-space') expect(label.text).toBe('s ')
    if (kind === 'inactive') {
      for (const duplicate of duplicates) expect(nativeSetActive(duplicate.obj, false)).toBeTruthy()
    } else if (kind === 'different-color') {
      for (const duplicate of duplicates)
        expect(p.FPDFPageObj_SetFillColor(duplicate.obj, 255, 0, 0, 255)).toBeTruthy()
    }
    const initial = objects(),
      states = initial.map((o) => active(o.obj)),
      before = render(),
      snapshot =
        kind === 'different-label'
          ? initial.map((o) => (o.obj === label.obj ? { ...o, text: 'q' } : o))
          : initial
    p.FPDFText_LoadPage = (page: number) => {
      reads++
      if (kind === 'read-failure' && reads === 1) throw Error('Native text inspection failed')
      return nativeTextLoad(page)
    }
    p.FPDFTextObj_GetText = (obj: number, text: number, buffer: number, length: number) => {
      const read = nativeGetText(obj, text, buffer, length)
      return buffer &&
        (kind === 'incomplete-read' || (kind === 'partial-read' && obj === duplicates[0].obj))
        ? read - 2
        : read
    }
    p.FPDFPageObj_SetIsActive = (obj: number, value: boolean) => {
      if (kind === 'restore-failure' && obj === label.obj && value && rejectedRestore++ === 0)
        return false
      return nativeSetActive(obj, value)
    }
    p.FPDF_RenderPageBitmap = (...args: number[]) => {
      nativeRender(...args)
      if (kind === 'pixel-change' && ++paints === 2)
        e.m.HEAPU8[p.FPDFBitmap_GetBuffer(args[0])] ^= 1
    }
    if (kind === 'read-failure')
      expect(() => recoverOverprintedTextSources(e, native, snapshot)).toThrow(
        'Native text inspection failed'
      )
    else if (kind === 'restore-failure') {
      expect(() => recoverOverprintedTextSources(e, native, snapshot)).toThrow(
        'Could not restore overprinted text sources'
      )
      // A failed restoration does not prevent restoring later page objects.
      expect(active(unrelated.obj)).toBe(true)
      expect(duplicates.every((o) => active(o.obj))).toBe(true)
      expect(nativeSetActive(label.obj, true)).toBeTruthy()
    } else if (kind === 'pixel-change')
      expect(() => recoverOverprintedTextSources(e, native, snapshot)).toThrow(
        'Overprinted text source inspection changed page pixels'
      )
    else {
      const recovered = recoverOverprintedTextSources(e, native, snapshot)
      if (kind === 'native' || kind === 'injected-space') {
        expect([...recovered.sources]).toEqual(duplicates.map((o) => [o.obj, letter]))
        expect(recovered.groups).toEqual([
          {
            objects: initial
              .filter((o) => o.obj === label.obj || duplicates.some((copy) => copy.obj === o.obj))
              .map((o) => o.obj),
            labelSource: letter.repeat(3)
          }
        ])
        expect(reads).toBe(2)
      } else {
        expect(recovered.sources.size).toBe(kind === 'partial-read' ? 1 : 0)
        expect(recovered.groups).toEqual([])
      }
    }
    p.FPDFText_LoadPage = nativeTextLoad
    p.FPDFTextObj_GetText = nativeGetText
    p.FPDFPageObj_SetIsActive = nativeSetActive
    p.FPDF_RenderPageBitmap = nativeRender
    expect(initial.map((o) => active(o.obj))).toEqual(states)
    expect(objects()).toEqual(initial)
    expect(Buffer.compare(Buffer.from(render()), Buffer.from(before))).toBe(0)
  } finally {
    p.FPDFText_LoadPage = nativeTextLoad
    p.FPDFTextObj_GetText = nativeGetText
    p.FPDFPageObj_SetIsActive = nativeSetActive
    p.FPDF_RenderPageBitmap = nativeRender
    e.free(at)
    p.FPDF_ClosePage(native)
    input.close()
  }
})

it.each([
  'native',
  'trailing-space',
  'unflagged',
  'comma-inside',
  'partial-digits',
  'wrong-label',
  'ordinary-linked-label',
  'effective-clip',
  'pixel-change'
])(
  'partitions a native citation separator only with complete digit and ink proof: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([240, 120]),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      label =
        kind === 'ordinary-linked-label'
          ? 'Native'
          : kind === 'wrong-label'
            ? ';27'
            : kind === 'trailing-space'
              ? ',27 '
              : ',27',
      x = 60,
      y = 60,
      size = 6
    if (kind === 'effective-clip')
      page.pushOperators(rectangle(x + 1, y - 2, 20, 12), clip(), endPath())
    page.drawText(label, { font, size, x, y })
    page.drawText('Native neighbor', { font, size: 9, x: 30, y: 30 })
    const e = await engine(),
      input = e.open(await pdf.save()),
      p = e.p,
      native = p.FPDF_LoadPage(input.doc, 0),
      at = e.alloc(64),
      objects = () => e.objects(native) as NativeObject[],
      initial = objects(),
      original = initial.find((o) => o.text?.trim() === label.trim())!,
      nativeRender = p.FPDF_RenderPageBitmap,
      render = () => {
        const bitmap = p.FPDFBitmap_Create(480, 240, 1)
        try {
          p.FPDFBitmap_FillRect(bitmap, 0, 0, 480, 240, 0xffffffff)
          p.FPDF_RenderPageBitmap(bitmap, native, 0, 0, 480, 240, 0, 0)
          const buffer = p.FPDFBitmap_GetBuffer(bitmap)
          return e.m.HEAPU8.slice(buffer, buffer + 240 * p.FPDFBitmap_GetStride(bitmap))
        } finally {
          p.FPDFBitmap_Destroy(bitmap)
        }
      },
      glyphs = () => {
        const text = p.FPDFText_LoadPage(native),
          result: Array<{
            code: number
            box: number[]
            origin: number[]
            font: number
            matrix: number[]
          }> = []
        try {
          for (let i = 0; i < p.FPDFText_CountChars(text); i++) {
            const object = p.FPDFText_GetTextObject(text, i),
              code = p.FPDFText_GetUnicode(text, i)
            if (
              !object ||
              code === 32 ||
              !objects().some((o) => o.obj === object && o.bounds[1] > 50)
            )
              continue
            p.FPDFText_GetCharBox(text, i, at, at + 8, at + 16, at + 24)
            const box = Array.from(e.m.HEAPF64.slice(at / 8, at / 8 + 4) as Float64Array)
            p.FPDFText_GetCharOrigin(text, i, at, at + 8)
            const origin = Array.from(e.m.HEAPF64.slice(at / 8, at / 8 + 2) as Float64Array)
            p.FPDFPageObj_GetMatrix(object, at)
            result.push({
              code,
              box,
              origin,
              font: p.FPDFTextObj_GetFont(object),
              matrix: Array.from(e.m.HEAPF32.slice(at / 4, at / 4 + 4) as Float32Array)
            })
          }
          return result
        } finally {
          p.FPDFText_ClosePage(text)
        }
      }
    try {
      const before = render(),
        originalGlyphs = glyphs(),
        left = kind === 'comma-inside' ? original.bounds[0] - 0.1 : originalGlyphs[1].origin[0],
        right = kind === 'partial-digits' ? originalGlyphs[1].box[1] : original.bounds[2] + 0.1
      if (kind === 'pixel-change')
        p.FPDF_RenderPageBitmap = (...args: number[]) => {
          nativeRender(...args)
          p.FPDFPageObj_GetIsActive(original.obj, at)
          if (e.m.HEAP32[at / 4]) return
          e.m.HEAPU8[p.FPDFBitmap_GetBuffer(args[0])] ^= 1
        }
      splitSharedTextRuns(e, input.doc, native, [
        {
          x: left,
          width: right - left,
          bottom: y - 2,
          top: y + 8,
          nativeCitation: kind !== 'unflagged'
        }
      ])
      p.FPDF_RenderPageBitmap = nativeRender
      expect(Buffer.compare(Buffer.from(render()), Buffer.from(before))).toBe(0)
      const after = objects()
      if (['native', 'trailing-space'].includes(kind)) {
        expect(after.some((o) => o.obj === original.obj)).toBe(false)
        expect(
          after
            .filter((o) => o.bounds[1] > 50)
            .map((o) => o.text?.trim())
            .join('')
        ).toBe(',27')
        expect(after.filter((o) => o.bounds[1] > 50).some((o) => /,\d/u.test(o.text ?? ''))).toBe(
          false
        )
        const afterGlyphs = glyphs()
        expect(afterGlyphs).toHaveLength(originalGlyphs.length)
        for (const [i, glyph] of afterGlyphs.entries()) {
          expect(glyph.code).toBe(originalGlyphs[i].code)
          expect(glyph.font).toBe(originalGlyphs[i].font)
          expect(glyph.matrix).toEqual(originalGlyphs[i].matrix)
          for (const [j, value] of glyph.origin.entries())
            expect(value).toBeCloseTo(originalGlyphs[i].origin[j], 4)
          for (const [j, value] of glyph.box.entries())
            expect(value).toBeCloseTo(originalGlyphs[i].box[j], 4)
        }
      } else expect(after).toEqual(initial)
    } finally {
      p.FPDF_RenderPageBitmap = nativeRender
      e.free(at)
      p.FPDF_ClosePage(native)
      input.close()
    }
  }
)

it.each(['ordinary-cross-boundary', 'table-gap', 'legacy-grouping'])(
  'isolates citation-only rectangles from every legacy split rule: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([240, 120]),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      size = 9,
      first = kind === 'ordinary-cross-boundary' ? 'Complete' : 'Method',
      second = kind === 'ordinary-cross-boundary' ? 'native prose.' : '11',
      source = `${first} ${second}`
    if (kind === 'ordinary-cross-boundary') page.drawText(source, { font, size, x: 30, y: 60 })
    else {
      page.drawText('', { font, size, x: 30, y: 60 })
      const key = page.node.newFontDictionary(font.name, font.ref)
      page.pushOperators(
        PDFOperator.of(PDFOperatorNames.BeginText),
        PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(size)]),
        PDFOperator.of(PDFOperatorNames.SetTextMatrix, [1, 0, 0, 1, 30, 60].map(PDFNumber.of)),
        PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
          pdf.context.obj([font.encodeText(first), -2000, font.encodeText(second)])
        ]),
        PDFOperator.of(PDFOperatorNames.EndText)
      )
    }
    const data = await pdf.save(),
      e = await engine(),
      p = e.p,
      snapshots: Array<Array<{ text?: string; bounds: number[] }>> = []
    for (const flagged of [false, true]) {
      const input = e.open(data),
        native = p.FPDF_LoadPage(input.doc, 0),
        initial = e.objects(native) as NativeObject[],
        original = initial.find((o) => o.text?.includes(first))!,
        firstRect = {
          x: original.bounds[0] - 0.1,
          width: font.widthOfTextAtSize(first, size) + 0.2,
          bottom: 58,
          top: 69,
          sourceItems: [first]
        },
        fullRect = {
          x: original.bounds[0] - 0.1,
          width: original.bounds[2] - original.bounds[0] + 0.2,
          bottom: 58,
          top: 69,
          sourceItems: [source]
        }
      try {
        splitSharedTextRuns(e, input.doc, native, [
          ...(kind === 'legacy-grouping'
            ? [
                firstRect,
                {
                  ...fullRect,
                  x: firstRect.x + firstRect.width + size,
                  width: original.bounds[2] - firstRect.x - firstRect.width - size + 0.1,
                  sourceItems: [second]
                }
              ]
            : [fullRect]),
          ...(flagged ? [{ ...firstRect, width: firstRect.width / 2, nativeCitation: true }] : [])
        ])
        const after = e.objects(native) as NativeObject[]
        if (kind !== 'legacy-grouping') expect(after).toEqual(initial)
        else expect(after.some((o) => o.obj === original.obj)).toBe(false)
        snapshots.push(after.map(({ text, bounds }) => ({ text, bounds })))
      } finally {
        p.FPDF_ClosePage(native)
        input.close()
      }
    }
    expect(snapshots[1]).toEqual(snapshots[0])
  }
)

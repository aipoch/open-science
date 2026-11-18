import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import {
  createNativeFunctionDisplayReader,
  nativeFunctionDisplayOwners,
  sameNativeFunctionDisplay
} from '../../src/reader/native-function-display.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'

// Self-authored Type2 curves, not a font or excerpt from an external paper.
function enclosureFont(): Uint8Array {
  const num = (n: number): number[] => {
      n = Math.round(n)
      return n >= -107 && n <= 107 ? [n + 139] : [28, (n >> 8) & 255, n & 255]
    },
    index = (entries: number[][]): number[] =>
      entries.length
        ? [
            0,
            entries.length,
            2,
            0,
            1,
            ...entries.flatMap((_, n) => {
              const end = 1 + entries.slice(0, n + 1).reduce((s, e) => s + e.length, 0)
              return [end >> 8, end & 255]
            }),
            ...entries.flat()
          ]
        : [0, 0],
    bytes = (s: string): number[] => Array.from(new TextEncoder().encode(s)),
    split = (p: number[][], t: number): number[][][] => {
      const mix = (a: number[], b: number[]): number[] => a.map((x, n) => x * (1 - t) + b[n] * t),
        a = mix(p[0], p[1]),
        b = mix(p[1], p[2]),
        c = mix(p[2], p[3]),
        d = mix(a, b),
        e = mix(b, c),
        f = mix(d, e)
      return [
        [p[0], a, d, f],
        [f, e, c, p[3]]
      ]
    },
    outer = [
      [600, 1800],
      [0, 1200],
      [0, -1200],
      [600, -1800]
    ],
    inner = [
      [680, -1800],
      [80, -1200],
      [80, 1200],
      [680, 1800]
    ],
    o = split(outer, 0.45),
    i = split(inner, 0.55),
    outline = (curves: number[][][], mirror = false): number[] => {
      const point = (p: number[]): number[] => [
        Math.round(mirror ? 680 - p[0] : p[0]),
        Math.round(p[1])
      ]
      let from = point(curves[0][0])
      const out = [...num(800), ...from.flatMap(num), 21]
      for (const c of curves) {
        const start = point(c[0])
        if (start.some((v, n) => v !== from[n])) {
          out.push(...start.map((v, n) => v - from[n]).flatMap(num), 5)
          from = start
        }
        for (const next of c.slice(1)) {
          const to = point(next)
          out.push(...to.map((v, n) => v - from[n]).flatMap(num))
          from = to
        }
        out.push(8)
      }
      out.push(14)
      return out
    },
    paths = [
      outline([outer, inner]),
      outline([outer, inner], true),
      outline([o[0], i[1]]),
      outline([o[1], i[0]]),
      outline([o[0], i[1]], true),
      outline([o[1], i[0]], true)
    ],
    names = index([bytes('AnonymousCurves')]),
    strings = index(
      ['arcLeft', 'arcRight', 'arcUpperLeft', 'arcLowerLeft', 'arcUpperRight', 'arcLowerRight'].map(
        bytes
      )
    ),
    chars = index([[14], ...paths]),
    charset = [0, ...paths.flatMap((_, n) => [1, 135 + n])],
    top = (offset: number): number[] => [
      ...[-10, -1800, 800, 1800].flatMap(num),
      5,
      ...num(offset),
      15,
      ...num(offset + charset.length),
      17,
      ...num(0),
      ...num(offset + charset.length + chars.length),
      18
    ]
  let offset = 0
  for (let n = 0; n < 4; n++)
    offset = 4 + names.length + index([top(offset)]).length + strings.length + 2
  return new Uint8Array([
    1,
    0,
    4,
    1,
    ...names,
    ...index([top(offset)]),
    ...strings,
    0,
    0,
    ...charset,
    ...chars
  ])
}
async function display(fault = ''): Promise<Awaited<ReturnType<typeof getDocument>['promise']>> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const body = await pdf.embedFont(
      await readFile(
        join(
          dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
          'standard_fonts/LiberationSans-Regular.ttf'
        )
      ),
      { subset: false }
    ),
    page = pdf.addPage([400, 500])
  page.drawText('Anonymous ordinary prose in a sentence.', { x: 40, y: 440, font: body, size: 10 })
  const key = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString(),
    file = pdf.context.register(pdf.context.flateStream(enclosureFont(), { Subtype: 'Type1C' })),
    descriptor = pdf.context.register(
      pdf.context.obj({
        Type: 'FontDescriptor',
        FontName: 'AnonymousCurves',
        Flags: 4,
        FontBBox: [0, -1800, 800, 1800],
        ItalicAngle: 0,
        Ascent: 1800,
        Descent: -1800,
        CapHeight: 700,
        StemV: 80,
        FontFile3: file
      })
    ),
    curves = pdf.context.register(
      pdf.context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'AnonymousCurves',
        FontDescriptor: descriptor,
        FirstChar: 1,
        LastChar: 6,
        Widths: [800, 800, 800, 800, 800, 800],
        Encoding: {
          Type: 'Encoding',
          Differences: [
            1,
            'arcLeft',
            'arcRight',
            'arcUpperLeft',
            'arcLowerLeft',
            'arcUpperRight',
            'arcLowerRight'
          ]
        },
        ToUnicode: pdf.context.register(
          pdf.context.flateStream(
            'begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def 1 begincodespacerange <00> <ff> endcodespacerange 6 beginbfchar <01> <e111> <02> <e222> <03> <e113> <04> <e114> <05> <e225> <06> <e226> endbfchar endcmap'
          )
        )
      })
    )
  page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).set(PDFName.of('Curves'), curves)
  const text = (s: string, x: number, y: number): string =>
    `BT ${key} 10 Tf ${x} ${y} Td [${s
      .split(' ')
      .map((w) => body.encodeText(w).toString())
      .join(' -277.83203125 ')}] TJ ET`
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        [
          text('Anonymous ordinary prose in a sentence.', 40, 440),
          text(fault === 'changed' ? 'on' : 'in', 95, 300),
          `q BT /Curves 10 Tf ${fault === 'invisible' ? '3 Tr' : fault === 'stroke' ? '1 Tr' : fault === 'clip' ? '7 Tr' : ''} 110 300 Td <${fault.startsWith('split') ? '03' : '01'}> Tj ET Q`,
          ...(fault.startsWith('split')
            ? [`BT /Curves 10 Tf 110 ${fault === 'split-gap' ? 299.5 : 300} Td <04> Tj ET`]
            : []),
          text(fault === 'prose' ? 'other words' : 'a+b', 135, 300),
          ...(fault === 'open'
            ? []
            : [
                `q BT /Curves 10 Tf ${fault === 'invisible' ? '3 Tr' : fault === 'stroke' ? '1 Tr' : fault === 'clip' ? '7 Tr' : ''} 210 300 Td <${fault.startsWith('split') ? '05' : fault === 'mirrored-wrong' ? '01' : '02'}> Tj ET Q`
              ]),
          ...(fault.startsWith('split')
            ? [`BT /Curves 10 Tf 210 ${fault === 'split-gap' ? 299.5 : 300} Td <06> Tj ET`]
            : []),
          text(fault === 'no-equality' ? '(a+b)' : '=(a+b)', 110, 265),
          ...(fault === 'foreign' ? [text('Other words', 150, 290)] : []),
          ...(fault === 'paint' ? ['130 292 50 1 re f'] : []),
          ...(fault === 'left-prose' ? [text('We compare', 40, 300)] : []),
          ...(fault === 'overhang' ? ['BT /Curves 10 Tf 150 248 Td <01> Tj ET'] : []),
          text('The following paragraph remains eligible.', 40, 220)
        ].join('\n')
      )
    )
  )
  if (fault === 'annotation')
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [130, 290, 180, 310],
            Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: 'https://example.invalid/' }
          })
        )
      ])
    )
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise
}
it.each([
  '',
  'split',
  'open',
  'prose',
  'no-equality',
  'foreign',
  'paint',
  'annotation',
  'invisible',
  'stroke',
  'clip',
  'mirrored-wrong',
  'left-prose',
  'overhang',
  'split-gap'
])('retains only a complete native unnumbered function display: %s', async (fault) => {
  const document = await display(fault)
  try {
    const extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      }),
      operator = extraction.source.units.find((u) =>
        u.fragments.some((f) => f.items.some((i) => i.text === 'in'))
      )
    expect(operator).toBeDefined()
    expect(operator?.sourceOnly === true).toBe(fault === '' || fault === 'split')
    if (!fault || fault === 'split') expect(operator?.preserve).toBe('formula')
    expect(
      extraction.source.units.find((u) => u.source.startsWith('Anonymous ordinary'))?.sourceOnly
    ).not.toBe(true)
    expect(extraction.coverage.excludedItemCount).toBe(0)
  } finally {
    await document.destroy()
  }
})
it('rejects old accepted operator replacement while preserving an identical native packet', async () => {
  const original = await display(),
    target = await display('changed'),
    options = { nativeDocumentFactory: getDocument, signal: new AbortController().signal }
  try {
    expect(await sameNativeFunctionDisplay(original, original, 1, options)).toBe(true)
    expect(await sameNativeFunctionDisplay(original, target, 1, options)).toBe(false)
  } finally {
    await original.destroy()
    await target.destroy()
  }
})
it('requires complete unique, unchanged source ownership', async () => {
  const document = await display()
  try {
    const out = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      }),
      page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      units = out.source.units.map((u) => ({ ...u, sourceOnly: undefined, preserve: undefined })),
      reader = createNativeFunctionDisplayReader({ document }),
      owner = units.find((u) => u.fragments.some((f) => f.items.some((i) => i.text === 'in')))!
    try {
      expect(
        (
          await nativeFunctionDisplayOwners(
            units,
            page,
            content,
            page.getViewport({ scale: 1 }),
            1,
            reader
          )
        ).has(owner.id)
      ).toBe(true)
      for (const changed of [
        units.map((u) => (u === owner ? { ...u, source: 'Invented' } : u)),
        [...units, { ...owner, id: 'duplicate' }],
        units.filter((u) => u !== owner)
      ])
        expect(
          (
            await nativeFunctionDisplayOwners(
              changed,
              page,
              content,
              page.getViewport({ scale: 1 }),
              1,
              reader
            )
          ).size
        ).toBe(0)
    } finally {
      await reader.dispose()
    }
  } finally {
    await document.destroy()
  }
})

it('rechecks source annotation data across the target-await window', async () => {
  const original = await display(),
    target = await display(),
    page = await original.getPage(1),
    annotations = await page.getAnnotations({ intent: 'display' }),
    read = target.getPage.bind(target)
  page.getAnnotations = async () => annotations
  target.getPage = async (n) => {
    annotations.push({ rect: [130, 290, 180, 310], subtype: 'Link' })
    return read(n)
  }
  try {
    expect(
      await sameNativeFunctionDisplay(original, target, 1, {
        nativeDocumentFactory: getDocument,
        signal: new AbortController().signal
      })
    ).toBe(false)
  } finally {
    await original.destroy()
    await target.destroy()
  }
})
it('rejects a coordinate-system change in a saved candidate', async () => {
  const original = await display(),
    target = await display(),
    page = await target.getPage(1),
    get = page.getViewport.bind(page)
  page.getViewport = (options) => {
    const viewport = get(options)
    viewport.transform[4] = 10
    return viewport
  }
  try {
    expect(
      await sameNativeFunctionDisplay(original, target, 1, {
        nativeDocumentFactory: getDocument,
        signal: new AbortController().signal
      })
    ).toBe(false)
  } finally {
    await original.destroy()
    await target.destroy()
  }
})
it('does not reinterpret a separated prose preposition before a displayed equation', async () => {
  const document = await display('left-prose')
  try {
    const out = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      }),
      page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      reader = createNativeFunctionDisplayReader({ document }),
      separate = out.source.units.flatMap((u) =>
        u.fragments.flatMap((f) =>
          f.items.map((i) => ({
            ...u,
            id: 'native-' + i.index,
            source: i.text,
            sourceOnly: undefined,
            preserve: undefined,
            fragments: [{ ...f, items: [i] }]
          }))
        )
      )
    try {
      expect(
        (
          await nativeFunctionDisplayOwners(
            separate,
            page,
            content,
            page.getViewport({ scale: 1 }),
            1,
            reader
          )
        ).size
      ).toBe(0)
    } finally {
      await reader.dispose()
    }
  } finally {
    await document.destroy()
  }
})

import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import {
  resolveNativeLatinAccents,
  type NativeMathObject
} from '../../../../resources/pdf-translation/math-accents.mjs'

type Object = NativeMathObject & { fontIdentity: number; size: number }
const objects = (): Object[] => [
  {
    i: 1,
    text: 'Naaren',
    bounds: [5, 100, 36, 107],
    fontName: 'Times',
    fontIdentity: 1,
    size: 10,
    glyphs: [
      { text: 'a', offset: 1, bounds: [10, 100, 14, 105] },
      { text: 'a', offset: 2, bounds: [15, 100, 19, 105] }
    ]
  },
  { i: 2, text: '¨', bounds: [10.5, 106, 13.5, 107], fontName: 'Times', fontIdentity: 1, size: 10 },
  { i: 3, text: '¨ ', bounds: [15.5, 106, 18.5, 107], fontName: 'Times', fontIdentity: 1, size: 10 }
]

it('resolves two uniquely owned native vowels inside the same complete name without altering objects', () => {
  const native = objects(),
    before = structuredClone(native)
  expect(resolveNativeLatinAccents(native)).toEqual([
    { indices: [2, 1], accentIndex: 2, baseIndex: 1, offset: 1, letter: 'ä' },
    { indices: [3, 1], accentIndex: 3, baseIndex: 1, offset: 2, letter: 'ä' }
  ])
  expect(native).toEqual(before)
})

it.each([
  'different-font',
  'different-font-name',
  'different-size',
  'inline',
  'too-high',
  'wide',
  'ambiguous-base',
  'unknown-combining-mark',
  'missing-glyph',
  'wrong-offset',
  'not-vowel',
  'off-center',
  'glyph-outside-object',
  'legacy-math-font'
])('does not infer a native Latin accent when proof is missing: %s', (kind) => {
  const native = objects().slice(0, 2),
    [base, accent] = native
  if (kind === 'different-font') accent.fontIdentity = 2
  if (kind === 'different-font-name') accent.fontName = 'Courier'
  if (kind === 'different-size') accent.size = 9
  if (kind === 'inline') accent.bounds = [10.5, 100, 13.5, 101]
  if (kind === 'too-high') accent.bounds = [10.5, 109, 13.5, 110]
  if (kind === 'wide') accent.bounds = [8, 106, 16, 107]
  if (kind === 'ambiguous-base') native.push({ ...base, i: 4 })
  if (kind === 'unknown-combining-mark') accent.text = '\u0308'
  if (kind === 'missing-glyph') base.glyphs = []
  if (kind === 'wrong-offset') base.glyphs![0].offset = 0
  if (kind === 'not-vowel') {
    base.text = 'Nbaren'
    base.glyphs![0].text = 'b'
  }
  if (kind === 'off-center') accent.bounds = [12, 106, 15, 107]
  if (kind === 'glyph-outside-object') base.bounds = [11, 100, 36, 107]
  if (kind === 'legacy-math-font') base.fontName = accent.fontName = 'TeX-matha10'
  expect(resolveNativeLatinAccents(native)).toEqual([])
})

it.each(['complete-name', 'changed-name', 'unowned-accent'])(
  'retains native accented citation glyphs and action only for the complete owner: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([320, 200]),
      left = 40 + font.widthOfTextAtSize('Evidence (', 10),
      vowelX = left + font.widthOfTextAtSize('N', 10),
      edge = vowelX + font.widthOfTextAtSize('aaren et al.', 10),
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'native-latin', surface: 'electron' })
    page.drawText('Evidence (', { font, size: 10, x: 40, y: 150 })
    page.drawText('N', { font, size: 10, x: left, y: 150 })
    page.drawText('¨', { font, size: 10, x: vowelX + 0.2, y: 150 })
    page.drawText('aaren et al.', { font, size: 10, x: vowelX, y: 150 })
    page.drawText(', 2009).', { font, size: 10, x: edge, y: 150 })
    page.drawText('Neighbor', { font, size: 10, x: 40, y: 110 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [left - 1, 148, edge + 1, 159],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.invalid/naaren-2009') }
          })
        )
      ])
    )
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const before = await (await original.promise).getPage(1),
        oldItems = (await before.getTextContent()).items.filter((i) => 'str' in i)
      const output = new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generate(
        {
          id: 'native-latin',
          data,
          pages: [{ width: 320, height: 200 }],
          units: [
            {
              source: 'Evidence (Näaren et al., 2009).',
              translation: `研究证据（${kind === 'changed-name' ? 'Naaren' : 'Näaren'} et al., 2009）。`,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 39 / 320,
                    y: 40 / 200,
                    width: 260 / 320,
                    height: (kind === 'unowned-accent' ? 4 : 22) / 200
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (kind !== 'complete-name') {
        await expect(output).rejects.toMatchObject({
          failure: { code: kind === 'unowned-accent' ? 'unsupported-layout' : 'annotations' }
        })
        return
      }
      target = getDocument({ data: (await output)!, useSystemFonts: true })
      const after = await (await target.promise).getPage(1),
        items = (await after.getTextContent()).items.filter((i) => 'str' in i),
        oldLink = (await before.getAnnotations())[0],
        link = (await after.getAnnotations())[0]
      expect(items.map((i) => i.str).join('')).toContain('研究证据')
      expect(link.url).toBe(oldLink.url)
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(oldLink.rect[2] - oldLink.rect[0], 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(oldLink.rect[3] - oldLink.rect[1], 3)
      for (const label of ['N', '¨', 'aaren et al.']) {
        const old = oldItems.find((i) => i.str === label)!,
          current = items.find((i) => i.str === label)!
        expect(current.height).toBe(old.height)
        expect(current.width).toBeCloseTo(old.width, 4)
        expect(current.transform[4] - old.transform[4]).toBeCloseTo(
          link.rect[0] - oldLink.rect[0],
          3
        )
        expect(current.transform[5] - old.transform[5]).toBeCloseTo(
          link.rect[1] - oldLink.rect[1],
          3
        )
      }
      expect(items.find((i) => i.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 110])
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

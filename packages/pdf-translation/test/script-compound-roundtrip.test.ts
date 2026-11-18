import { expect, it, onTestFinished } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { PdfTranslationPdfRequest } from '../src/contracts.js'
const { source, translation } = readPdfTranslationCases<{ source: string; translation: string }>(
  'native-script-compound-tokens.jsonl'
)[0]
type Item = Extract<
  Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number],
  { str: string }
>
type Fixture = {
  data: Uint8Array
  fragments: PdfTranslationPdfRequest['units'][number]['fragments']
}
const lease = (): ReturnType<TestCallerRegistry['acquire']>['lease'] => {
  const registry = new TestCallerRegistry()
  onTestFinished(() => registry.dispose())
  return registry.acquire({ leaseId: 'script-compounds', surface: 'electron' }).lease
}
async function fixture(): Promise<Fixture> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const fonts = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts'
    ),
    body = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Regular.ttf')), {
      subset: false
    }),
    math = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Italic.ttf')), {
      subset: false
    }),
    page = pdf.addPage([600, 800])
  let x = 40
  const put = (text: string, y = 600, size = 10, font = body): void => {
    page.drawText(text, { x, y, size, font })
    x += font.widthOfTextAtSize(text, size)
  }
  put('We evaluate ')
  put('q', 600, 10, math)
  const attached = x + 0.3
  page.drawText('′', { x: attached, y: 603.6, size: 7, font: body })
  page.drawText('β', { x: attached, y: 597.2, size: 7, font: math })
  x = attached + Math.max(body.widthOfTextAtSize('′', 7), math.widthOfTextAtSize('β', 7))
  put(' then compare ')
  put('y', 600, 10, math)
  put('1:', 598.5, 7)
  put('j', 598.5, 7, math)
  put('−1', 598.5, 7)
  put(' and ')
  put('z', 600, 10, math)
  put('(', 603.6, 7)
  put('a,b', 603.6, 7, math)
  put(')', 603.6, 7)
  put(' with nearby symbols.')
  const data = new Uint8Array(await pdf.save())
  return {
    data,
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 39 / 600, y: 188 / 800, width: (x - 38) / 600, height: 18 / 800 }
      }
    ]
  }
}
it('paints a compound scripted sentence with all native script levels intact', async () => {
  const f = await fixture(),
    controller = new AbortController()
  try {
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      output = await writer.generateDetailed(
        {
          id: 'script-compounds',
          data: f.data,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          preserveUnmatched: true,
          units: [{ source, translation, fragments: f.fragments }]
        },
        lease()
      )
    expect(output?.layoutFailures).toEqual([])
    const target = await getDocument({
      data: output!.data.slice(),
      fontExtraProperties: true,
      disableFontFace: true,
      isEvalSupported: false
    }).promise
    try {
      const items = (await (await target.getPage(1)).getTextContent()).items.filter(
        (i): i is Item => 'str' in i && !!i.str.trim()
      )
      const text = items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
      expect(text).toBe(translation)
      const q = items.find((i) => i.str === 'q')!,
        prime = items.find((i) => i.str === '′')!,
        beta = items.find((i) => i.str === 'β')!
      expect(prime.transform[5] - q.transform[5]).toBeCloseTo(3.6, 3)
      expect(beta.transform[5] - q.transform[5]).toBeCloseTo(-2.8, 3)
      expect(prime.height).toBeCloseTo(7, 3)
      const range = items.find((i) => i.str === '1:j−1')!,
        tuple = items.find((i) => i.str === '(a,b)')!
      expect(range).toBeDefined()
      expect(tuple).toBeDefined()
      expect(range.height).toBeLessThan(q.height * 0.85)
      expect(range.transform[5]).toBeCloseTo(598.5, 3)
      expect(tuple.height).toBeLessThan(q.height * 0.85)
      expect(tuple.transform[5]).toBeCloseTo(603.6, 3)
    } finally {
      await target.destroy()
    }
  } finally {
    controller.abort()
  }
})
it.each([
  'prime-changed',
  'prime-missing',
  'range-changed',
  'range-missing',
  'range-reordered',
  'tuple-changed',
  'tuple-missing',
  'tuple-reordered'
] as const)('retains the whole verified source when %s', async (fault) => {
  const f = await fixture(),
    controller = new AbortController()
  try {
    const target = translation.replace(
      fault.startsWith('prime') ? 'q′β' : fault.startsWith('range') ? 'y1:j−1' : 'z(a,b)',
      {
        'prime-changed': 'q′γ',
        'prime-missing': 'qβ',
        'range-changed': 'y1:k−1',
        'range-missing': 'y',
        'range-reordered': 'y1:−1j',
        'tuple-changed': 'z(a,c)',
        'tuple-missing': 'z',
        'tuple-reordered': 'z(b,a)'
      }[fault]!
    )
    const out = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'script-negative',
        data: f.data,
        pages: [{ width: 600, height: 800 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [{ source, translation: target, fragments: f.fragments }]
      },
      lease()
    )
    expect(out?.layoutFailures).toMatchObject([
      { unitIndex: 0, phase: 'planning', code: 'unsupported-layout' }
    ])
    expect(out?.data).toEqual(f.data)
  } finally {
    controller.abort()
  }
})

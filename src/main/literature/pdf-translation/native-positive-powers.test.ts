import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  { kind: 'repeated-native-powers', target: '数值10⁹和10⁹保持稳定。', accepted: true },
  { kind: 'changed-base', target: '数值100⁹和10⁹保持稳定。', accepted: false },
  { kind: 'changed-exponent', target: '数值10⁸和10⁹保持稳定。', accepted: false },
  { kind: 'missing-occurrence', target: '数值10⁹保持稳定。', accepted: false },
  { kind: 'extra-occurrence', target: '数值10⁹、10⁹和10⁹保持稳定。', accepted: false },
  { kind: 'flat-native-digit', target: '数值10⁹和10⁹保持稳定。', accepted: false },
  { kind: 'preserve-unproven', target: '数值100⁹和10⁹保持稳定。', accepted: false }
])(
  'preserves complete native positive powers without flattening: $kind',
  async ({ kind, target, accepted }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'native-positive-power', surface: 'electron' })
    let x = 40
    const draw = (text: string): void => {
      page.drawText(text, { font, size: 12, x, y: 700 })
      x += font.widthOfTextAtSize(text, 12)
    }
    draw('Measured values 10')
    page.drawText('9', {
      font,
      size: kind === 'flat-native-digit' ? 12 : 8,
      x,
      y: kind === 'flat-native-digit' ? 700 : 704
    })
    x += 5
    draw(' and 10')
    page.drawText('9', { font, size: 8, x, y: 704 })
    x += 5
    draw(' remain stable.')
    page.drawText('Neighbor 17', { font, size: 12, x: 40, y: 650 })
    const original = await pdf.save()
    try {
      const request = new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generate(
        {
          id: 'positive-power',
          data: original,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: kind === 'preserve-unproven',
          units: [
            {
              source: 'Measured values 10⁹ and 10⁹ remain stable.',
              translation: target,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 86 / 800, width: 380 / 600, height: 24 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (kind === 'preserve-unproven') {
        expect(await request).toEqual(original)
        return
      }
      if (!accepted) {
        await expect(request).rejects.toMatchObject({
          failure: { code: kind === 'flat-native-digit' ? 'unsupported-layout' : 'annotations' }
        })
        return
      }
      const output = await request,
        task = getDocument({ data: output!.slice() })
      try {
        const document = await task.promise,
          items = (await (await document.getPage(1)).getTextContent()).items.flatMap((item) =>
            'str' in item ? [item] : []
          ),
          powers = items.filter((item) => item.str === '9'),
          body = items.filter((item) => item.str.includes('10'))
        expect(powers).toHaveLength(2)
        expect(body).toHaveLength(2)
        for (const power of powers) {
          expect(power.height).toBeCloseTo(8, 3)
          expect(power.transform.slice(0, 4)).toEqual([8, 0, 0, 8])
          expect(
            Math.min(...body.map((base) => Math.abs(power.transform[5] - base.transform[5] - 4)))
          ).toBeLessThan(0.01)
        }
        expect(items.map((item) => item.str).join('')).toContain('Neighbor 17')
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

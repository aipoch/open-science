import { PDFDocument, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it, onTestFinished } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it('translates a contact heading above a fixed native email link', async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 200])
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  const heading = 'Corresponding author: Dana Example'
  const localizedHeading = '通信作者：Dana Example'
  const email = 'dana@example.test'
  const uri = 'mailto:' + email
  page.drawText(heading, { x: 50, y: 96, font, size: 8 })
  page.drawText(email, { x: 50, y: 84, font, size: 8 })
  page.node.addAnnot(
    pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [49, 76, 114, 90],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(uri) }
      })
    )
  )
  const read = async (
    data: Uint8Array
  ): Promise<{
    items: { str: string; index: number; transform: number[] }[]
    links: { url?: string; rect: number[] }[]
  }> => {
    const document = getDocument({ data: data.slice(), useSystemFonts: true })
    onTestFinished(() => document.destroy())
    const page = await (await document.promise).getPage(1)
    const text = await page.getTextContent()
    return {
      items: text.items.flatMap((item, index) =>
        'str' in item ? [{ str: item.str, transform: item.transform, index }] : []
      ),
      links: (await page.getAnnotations()).map(({ url, rect }) => ({ url, rect }))
    }
  }

  const bytes = await pdf.save()
  const original = await read(bytes)
  const result = await new PdfTranslationWriter(() =>
    resolve('resources/worker.mjs')
  ).generateDetailed(
    {
      id: 'contact-heading',
      data: bytes,
      pages: [{ width: 300, height: 200 }],
      preserveUnsupported: true,
      preserveUnmatched: true,
      units: [
        {
          source: heading + ' ' + email,
          translation: localizedHeading + ' ' + email,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 50 / 300, y: 97 / 200, width: 145 / 300, height: 21 / 200 },
              items: original.items
                .filter(({ str }) => str === heading || str === email)
                .map(({ index, str }) => ({ index, text: str }))
            }
          ]
        }
      ]
    },
    {
      leaseId: 'contact-heading',
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
  )
  expect(result?.layoutFailures).toEqual([])
  const output = await read(result!.data)
  expect(
    output.items
      .map(({ str }) => str)
      .join(' ')
      .replace(/\s+/gu, ' ')
  ).toContain(localizedHeading)
  expect(output.items.find(({ str }) => str === email)?.transform).toEqual(
    original.items.find(({ str }) => str === email)?.transform
  )
  expect(output.links).toEqual(original.links)
  expect(output.links).toHaveLength(1)
})

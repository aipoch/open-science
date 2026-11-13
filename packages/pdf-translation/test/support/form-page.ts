import { createCanvas } from '@napi-rs/canvas'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
// @ts-expect-error The font fixture dependency has no bundled declarations.
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export async function formPage(fault = '', disableFontFace = true): Promise<PDFDocumentProxy> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
    await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts/LiberationSans-Regular.ttf'
      )
    ),
    { subset: false }
  )
  const page = pdf.addPage([300, 220])
  page.drawText('Visible caption', { x: 20, y: 70, size: 12, font })
  const fontKey = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString(),
    label = font.encodeText('Panel label').toString(),
    text = `BT /FixtureFont 12 Tf 10 ${fault === 'visible' ? 45 : fault === 'partial' ? 25 : 10} Td ${label} Tj ET`,
    form = pdf.context.register(
      pdf.context.flateStream(
        `${fault === 'path-clip' ? '0 30 m 200 30 l 100 100 l h W n ' : ''}${fault === 'white' ? '1 1 1 rg' : '0 0 0 rg'} ${text}`,
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: ['no-clip', 'nested', 'path-clip'].includes(fault)
            ? [0, 0, 200, 100]
            : [0, 30, 200, 100],
          Resources: { Font: { FixtureFont: font.ref } }
        }
      )
    )
  const panel =
    fault === 'nested'
      ? pdf.context.register(
          pdf.context.flateStream('/Child Do', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 30, 200, 100],
            Resources: { XObject: { Child: form } }
          })
        )
      : form
  page.node.set(
    PDFName.of('Resources'),
    pdf.context.obj({
      Font: { [fontKey.slice(1)]: font.ref },
      XObject: { Panel: panel }
    })
  )
  const images: Record<string, unknown> = {}
  if (fault === 'images') {
    for (const [index, color] of ['#345678', '#789abc'].entries()) {
      const canvas = createCanvas(224, 224),
        context = canvas.getContext('2d')
      context.fillStyle = color
      context.fillRect(0, 0, 224, 224)
      context.fillStyle = '#ffffff'
      context.fillRect(15 + index * 10, 20, 25, 140)
      const image = await pdf.embedPng(canvas.toBuffer('image/png'))
      images['Image' + index] = image.ref
    }
    const resources = page.node.Resources()!
    resources.set(PDFName.of('XObject'), pdf.context.obj({ Panel: panel, ...images }))
  }
  const matrix = fault === 'rotation' ? '0 1 -1 0 200 100' : '0.5 0 0 0.5 20 100',
    invoke = `q ${matrix} cm /Panel Do Q`,
    visible = `BT ${fontKey} 12 Tf 20 70 Td ${label} Tj ET`,
    caption = `BT ${fontKey} 12 Tf 20 ${fault === 'roundtrip' ? 110 : 50} Td ${font.encodeText('Visible caption').toString()} Tj ET`
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        `${fault === 'images' ? 'q 40 0 0 40 230 150 cm /Image0 Do Q q 40 0 0 40 180 150 cm /Image1 Do Q' : ''}\n${invoke}\n${fault === 'same-position' ? invoke : fault === 'repeated-form' ? 'q 0.5 0 0 0.5 150 100 cm /Panel Do Q' : ''}\n${visible}\n${caption}`
      )
    )
  )
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace,
    isEvalSupported: false
  }).promise
}

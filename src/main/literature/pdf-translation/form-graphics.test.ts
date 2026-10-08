import { resolve } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'

it.each([
  'clear',
  'overlap',
  'nested-text',
  'clipped',
  'shared',
  'linked',
  'unrelated-link',
  'flat-raster',
  'raster-pattern'
] as const)('preserves nested graphics when replacing a parent Form caption: %s', async (kind) => {
  const logo = await PDFDocument.create(),
    raster = kind === 'flat-raster' || kind === 'raster-pattern',
    logoPage = logo.addPage(raster ? [180, 60] : [80, 80])
  if (raster) {
    const canvas = createCanvas(180, 60),
      context = canvas.getContext('2d')
    context.fillStyle = '#3380cc'
    context.fillRect(0, 0, 180, 60)
    if (kind === 'raster-pattern') {
      context.fillStyle = '#000000'
      context.fillRect(70, 0, 3, 60)
    }
    const image = await logo.embedPng(canvas.toBuffer('image/png'))
    logoPage.drawImage(image, { x: 0, y: 0, width: 180, height: 60 })
  } else logoPage.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(0.2, 0.5, 0.8) })
  // PDFium reports bounds beyond this mandatory Form BBox. Only clipped paint matters.
  logoPage.drawRectangle({ x: 100, y: 100, width: 40, height: 40, color: rgb(1, 0, 0) })
  if (kind === 'nested-text') {
    const font = await logo.embedFont(StandardFonts.Helvetica)
    logoPage.drawText('12', { x: 20, y: 20, size: 12, font })
  }
  await logo.flush()
  const container = await PDFDocument.create(),
    containerPage = container.addPage([200, 200]),
    font = await container.embedFont(StandardFonts.Helvetica),
    graphic = await container.embedPage(logoPage)
  containerPage.drawText('Measured response', { x: 20, y: 150, size: 12, font })
  containerPage.drawPage(graphic, {
    x: raster ? 10 : 20,
    y: raster ? 130 : kind === 'overlap' ? 140 : 20
  })
  await container.flush()
  const pdf = await PDFDocument.create(),
    parent = await pdf.embedPage(
      containerPage,
      kind === 'clipped' ? { left: 0, bottom: 154, right: 200, top: 200 } : undefined
    )
  const first = pdf.addPage([600, 800])
  first.drawPage(parent, { x: 50, y: 400, xScale: 1.25, yScale: 1.25 })
  if (kind === 'shared')
    pdf.addPage([600, 800]).drawPage(parent, { x: 50, y: 400, xScale: 1.25, yScale: 1.25 })
  if (kind === 'linked' || kind === 'unrelated-link')
    first.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: kind === 'linked' ? [70, 580, 230, 610] : [70, 450, 150, 470],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/diagram') }
          })
        )
      ])
    )
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true }),
    caller = new ApplicationCallerLeaseRegistry().acquire({
      leaseId: 'mixed-form',
      surface: 'electron'
    })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const before = await original.promise,
      { source } = await extractPdfTranslationSource({
        document: before,
        resourceRequestKey: 'mixed-form',
        signal: caller.lease.signal
      }),
      unit = source.units.find(
        (item) => item.source === 'Measured response' && item.fragments[0].pageNumber === 1
      )!
    expect(unit).toBeDefined()
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'mixed-form',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [{ ...unit, translation: '测量响应' }]
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const after = await target.promise,
      translated = ['clear', 'shared', 'unrelated-link', 'flat-raster'].includes(kind)
    for (let number = 1; number <= before.numPages; number++) {
      const text = (await (await after.getPage(number)).getTextContent()).items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join('')
      expect(text).toContain(number === 1 && translated ? '测量响应' : 'Measured response')
      const render = async (document: typeof before): Promise<Buffer> => {
        const page = await document.getPage(number),
          viewport = page.getViewport({ scale: 2 }),
          canvas = createCanvas(viewport.width, viewport.height),
          context = canvas.getContext('2d')
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise
        if (translated && number === 1) {
          const rect = unit.fragments[0].rect
          context.clearRect(
            Math.floor(rect.x * viewport.width) - 2,
            Math.floor(rect.y * viewport.height) - 2,
            Math.ceil(rect.width * viewport.width) + 4,
            Math.ceil(rect.height * viewport.height) + 4
          )
        }
        return Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
      }
      expect(Buffer.compare(await render(after), await render(before))).toBe(0)
      const links = async (document: typeof before): Promise<unknown[]> =>
        (await (await document.getPage(number)).getAnnotations()).map(({ subtype, rect, url }) => ({
          subtype,
          rect,
          url
        }))
      expect(await links(after)).toEqual(await links(before))
    }
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

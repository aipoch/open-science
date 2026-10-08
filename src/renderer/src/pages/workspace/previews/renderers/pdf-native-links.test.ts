// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFName, PDFString, degrees, type PDFRef } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  renderPdfNativeLinks,
  resolvePdfLinkPage,
  resolvePdfLinkDestination
} from './pdf-native-links'

vi.mock('../pdfjs', async () => ({
  pdfjsLib: await import('pdfjs-dist/legacy/build/pdf.mjs')
}))
Object.assign(globalThis, { pdfjsLib: pdfjs })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function fixture(rotation = 0): Promise<
  Parameters<typeof renderPdfNativeLinks>[0] & {
    options: Parameters<typeof renderPdfNativeLinks>[0]
    controller: AbortController
  }
> {
  const pdf = await PDFDocument.create()
  const first = pdf.addPage([600, 800])
  const second = pdf.addPage([600, 800])
  first.setCropBox(20, 30, 560, 740)
  first.setRotation(degrees(rotation))
  const link = (extra: Record<string, unknown>): PDFRef =>
    pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 700, 120, 720],
        Border: [0, 0, 0],
        ...extra
      })
    )
  first.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      link({ Dest: [second.ref, 'Fit'] }),
      link({ A: { S: 'URI', URI: PDFString.of('https://example.invalid/10.0000/paper.00001') } }),
      link({ A: { S: 'URI', URI: PDFString.of('mailto:science@example.org') } }),
      link({ A: { S: 'URI', URI: PDFString.of('file:///private/secret') } }),
      link({ A: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } }),
      link({ A: { S: 'Named', N: 'NextPage' } }),
      link({
        Dest: [second.ref, 'Fit'],
        QuadPoints: [40, 720, 75, 720, 40, 713, 75, 713, 85, 707, 120, 707, 85, 700, 120, 700]
      })
    ])
  )
  const task = pdfjs.getDocument({ data: new Uint8Array(await pdf.save()) })
  cleanups.push(() => task.destroy())
  const document = await task.promise
  const page = await document.getPage(1)
  const host = window.document.createElement('div')
  host.id = 'original'
  window.document.body.append(host)
  const controller = new AbortController()
  const onNavigate = vi.fn()
  const options = {
    host,
    page,
    document,
    viewport: page.getViewport({ scale: 1.5 }),
    signal: controller.signal,
    onNavigate,
    label: 'Open link'
  }
  return { ...options, options, controller }
}

describe('native PDF links', () => {
  it.each([0, 90, 180, 270])(
    'uses PDF.js crop/quad geometry at rotation %i and resolves references',
    async (rotation) => {
      const { options, host, onNavigate } = await fixture(rotation)
      await renderPdfNativeLinks(options)
      expect(host.querySelector('.pdf-native-links')?.getAttribute('data-main-rotation')).toBe(
        String(rotation)
      )
      const links = host.querySelectorAll('a')
      expect(links).toHaveLength(4)
      expect(host.querySelector('clipPath')).not.toBeNull()
      expect(links[0].getAttribute('aria-label')).toBe('Open link')
      expect(links[1].href).toBe('https://example.invalid/10.0000/paper.00001')
      expect(links[1].target).toBe('_blank')
      expect(links[1].rel).toContain('noreferrer')
      links[0].click()
      await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }))
      const other = window.document.createElement('div')
      other.id = 'translated'
      await renderPdfNativeLinks({ ...options, host: other })
      const originalIds = [...host.querySelectorAll('[id]')].map((node) => node.id)
      expect(
        [...other.querySelectorAll('[id]')].every((node) => !originalIds.includes(node.id))
      ).toBe(true)
      const auxiliary = new MouseEvent('auxclick', { cancelable: true, button: 1 })
      expect(links[0].dispatchEvent(auxiliary)).toBe(false)
    }
  )

  it('resolves named destinations and rejects invalid page numbers', async () => {
    const { document } = await fixture()
    vi.spyOn(document, 'getDestination').mockResolvedValue([1, { name: 'Fit' }])
    expect(await resolvePdfLinkPage(document, 'references')).toBe(2)
    for (const index of [-1, 2, 0.5, Infinity])
      expect(await resolvePdfLinkPage(document, [index, { name: 'Fit' }])).toBeUndefined()
    expect(await resolvePdfLinkPage(document, null)).toBeUndefined()
  })

  it.each([
    [0, 0.25, 0.25],
    [90, 0.75, 0.25],
    [180, 0.75, 0.75],
    [270, 0.25, 0.75]
  ])('resolves XYZ coordinates on a cropped page rotated %i degrees', async (rotation, x, y) => {
    const { document } = await fixture(rotation)
    // Crop box: [20, 30, 580, 770]. A point one quarter from the top left.
    expect(await resolvePdfLinkDestination(document, [0, { name: 'XYZ' }, 160, 585, 4])).toEqual({
      pageNumber: 1,
      x,
      y
    })
  })

  it('resolves named, fit and rectangle destinations while preserving the caller zoom', async () => {
    const { document } = await fixture()
    vi.spyOn(document, 'getDestination').mockResolvedValue([0, { name: 'XYZ' }, null, null, null])
    expect(await resolvePdfLinkDestination(document, 'heading')).toEqual({
      pageNumber: 1,
      x: 0,
      y: 0
    })
    for (const mode of ['Fit', 'FitB'])
      expect(await resolvePdfLinkDestination(document, [0, { name: mode }])).toEqual({
        pageNumber: 1,
        x: 0,
        y: 0
      })
    for (const mode of ['FitH', 'FitBH'])
      expect(await resolvePdfLinkDestination(document, [0, { name: mode }, 400])).toEqual({
        pageNumber: 1,
        x: 0,
        y: 0.5
      })
    for (const mode of ['FitV', 'FitBV'])
      expect(await resolvePdfLinkDestination(document, [0, { name: mode }, 300])).toEqual({
        pageNumber: 1,
        x: 0.5,
        y: 0
      })
    expect(
      await resolvePdfLinkDestination(document, [0, { name: 'FitR' }, 160, 400, 300, 585])
    ).toEqual({ pageNumber: 1, x: 0.25, y: 0.25 })
    expect(await resolvePdfLinkDestination(document, [0, { name: 'XYZ' }, -10, 900, null])).toEqual(
      { pageNumber: 1, x: 0, y: 0 }
    )
    for (const destination of [
      null,
      [0],
      [2, { name: 'Fit' }],
      [0, { name: 'Unknown' }],
      [0, { name: 'XYZ' }, NaN, 3, null],
      [0, { name: 'XYZ' }, 3, 4],
      [0, { name: 'FitR' }, 2, 3, 1, 4],
      [0, { name: 'FitR' }, null, 3, 4, 5]
    ])
      expect(await resolvePdfLinkDestination(document, destination)).toBeUndefined()
  })

  it('does not publish a layer after cancellation', async () => {
    const { options, host, controller } = await fixture()
    const promise = renderPdfNativeLinks(options)
    controller.abort()
    await promise
    expect(host.childElementCount).toBe(0)
  })

  it('ignores stale pending destinations after disposal and broken references', async () => {
    const { options, host, controller, document, onNavigate } = await fixture()
    await renderPdfNativeLinks(options)
    let finish!: (index: number) => void
    vi.spyOn(document, 'getPageIndex').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    host.querySelector('a')!.click()
    controller.abort()
    finish(1)
    await Promise.resolve()
    expect(onNavigate).not.toHaveBeenCalled()
    vi.mocked(document.getPageIndex).mockRejectedValue(new Error('broken reference'))
    host.querySelector('a')!.click()
    await Promise.resolve()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('filters unsupported protocols and active actions before handing annotations to PDF.js', async () => {
    const { options, page, host } = await fixture()
    const safe = (await page.getAnnotations())[1]
    vi.spyOn(page, 'getAnnotations').mockResolvedValue([
      ...['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.org', 'relative.pdf'].map(
        (url) => ({ ...safe, url })
      ),
      ...['actions', 'attachment', 'setOCGState', 'resetForm'].map((key) => ({
        ...safe,
        [key]: {}
      }))
    ])
    await renderPdfNativeLinks(options)
    expect(host.childElementCount).toBe(0)
  })
})

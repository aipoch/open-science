// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, type PDFRef } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  renderIndexedFigureLinks,
  renderPdfNativeLinks,
  resolvePdfLinkPage,
  resolvePdfLinkDestination,
  type PdfLinkDestination
} from './pdf-native-links'

vi.mock('../pdfjs', async () => ({
  pdfjsLib: await import('pdfjs-dist/legacy/build/pdf.mjs')
}))
Object.assign(globalThis, { pdfjsLib: pdfjs })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

function indexedFixture(
  texts = ['See Fig. 3b for the result.'],
  pageNumber = 1,
  layout?: Array<{ x: number; y: number }>
): {
  options: Parameters<typeof renderIndexedFigureLinks>[0]
  host: HTMLDivElement
  textLayer: HTMLDivElement
  nodes: Text[]
  destination: PdfLinkDestination
  onNavigate: ReturnType<typeof vi.fn>
  click: (x?: number) => void
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  const textLayer = document.createElement('div')
  const host = document.createElement('div')
  container.append(textLayer, host)
  document.body.append(container)
  const nodes = texts.map((text) => {
    const span = document.createElement('span')
    span.textContent = text
    textLayer.append(span)
    return span.firstChild as Text
  })
  const positions = nodes.map((_, i) => 50 + texts.slice(0, i).join('').length * 6 + i * 4)
  const createRange = document.createRange.bind(document)
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange()
    range.getClientRects = () => {
      const first = nodes.indexOf(range.startContainer as Text)
      const last = nodes.indexOf(range.endContainer as Text)
      if (first < 0 || last < first) return [] as unknown as DOMRectList
      return nodes.slice(first, last + 1).map((node, offset) => {
        const i = first + offset
        const start = i === first ? range.startOffset : 0
        const end = i === last ? range.endOffset : node.length
        return new DOMRect(
          (layout?.[i].x ?? positions[i]) + start * 6,
          layout?.[i].y ?? 80,
          (end - start) * 6,
          12
        )
      }) as unknown as DOMRectList
    }
    return range
  })
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 600, 800))
  const destination = { pageNumber: 2, x: 0.1, y: 0.2 }
  const onNavigate = vi.fn()
  const options = {
    host,
    textLayer,
    index: new Map([['figure:3', destination]]),
    pageNumber,
    onNavigate
  }
  const click = (x = 90): void => {
    textLayer.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: 85 }))
  }
  return { options, host, textLayer, nodes, destination, onNavigate, click, container }
}

describe('indexed PDF figure links', () => {
  it('uses exact rendered characters for keyboard and pointer navigation', () => {
    const { options, host, destination, onNavigate, click } = indexedFixture()
    renderIndexedFigureLinks(options)
    const link = host.querySelector('a')!
    expect(link.getAttribute('aria-label')).toBe('Fig. 3b')
    expect(link.getAttribute('href')).toBe('#page=2')
    expect(link.style.left).toBe('64px')
    expect(link.style.top).toBe('60px')
    expect(link.style.width).toBe('42px')
    expect(link.style.pointerEvents).toBe('none')
    link.click()
    expect(onNavigate).toHaveBeenLastCalledWith(destination, 'Fig. 3b')
    click(100)
    expect(onNavigate).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(link)
    click(220)
    expect(onNavigate).toHaveBeenCalledTimes(2)
  })

  it('joins adjacent PDF.js spans without rewriting selectable text', () => {
    const { options, host, textLayer, nodes, onNavigate } = indexedFixture([
      'See Fig.',
      '3b',
      'for the result.'
    ])
    renderIndexedFigureLinks(options)
    expect(host.querySelectorAll('a')).toHaveLength(1)
    expect(textLayer.childElementCount).toBe(3)
    expect(textLayer.firstElementChild?.firstChild).toBe(nodes[0])
    host.querySelector('a')!.click()
    expect(onNavigate).toHaveBeenCalledWith(options.index.get('figure:3'), 'Fig. 3b')
  })

  it.each([
    'See Fig. 3b and 4c.',
    'See Fig. 3b, c.',
    'See Fig. 3-5.',
    'See Fig. 3.2.',
    'See Fig. 3aa.',
    'See Fig. 3 b.',
    'See Supplementary Fig. 3.',
    'See Extended Data Fig. 3.',
    'See Fig. 8.',
    'See Table 3.'
  ])('leaves unreliable or unavailable references as ordinary text for %s', (text) => {
    const { options, host, click, onNavigate } = indexedFixture([text])
    renderIndexedFigureLinks(options)
    expect(host.childElementCount).toBe(0)
    click()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it.each(['Supplementary', 'Supplemental', 'Extended Data', 'Supporting Information'])(
    'excludes an explicitly adjacent wrapped %s qualifier',
    (qualifier) => {
      const { options, host, onNavigate, click } = indexedFixture(
        [`See ${qualifier}`, 'Fig. 3.'],
        1,
        [
          { x: 50, y: 64 },
          { x: 50, y: 80 }
        ]
      )
      renderIndexedFigureLinks(options)
      expect(host.childElementCount).toBe(0)
      click()
      expect(onNavigate).not.toHaveBeenCalled()
    }
  )

  it.each([
    { x: 350, y: 64 },
    { x: 50, y: 20 }
  ])('keeps a plain figure reference when the qualifier belongs elsewhere (%j)', (previous) => {
    const { options, host } = indexedFixture(['See Supplementary', 'Fig. 3.'], 1, [
      previous,
      { x: 50, y: 80 }
    ])
    renderIndexedFigureLinks(options)
    expect(host.querySelectorAll('a')).toHaveLength(1)
  })

  it('excludes a same-page caption while allowing references in body prose', () => {
    const { options, host } = indexedFixture(['Fig. 3b. Measured response.'], 2)
    renderIndexedFigureLinks(options)
    expect(host.childElementCount).toBe(0)
    options.textLayer.querySelector('span')!.firstChild!.textContent = 'See Fig. 3b for details.'
    renderIndexedFigureLinks(options)
    expect(host.querySelectorAll('a')).toHaveLength(1)
  })

  it('preserves an existing native link even when it covers only the number', () => {
    const { options, host, container } = indexedFixture()
    const native = document.createElement('div')
    native.className = 'pdf-native-links'
    const anchor = document.createElement('a')
    native.append(anchor)
    container.append(native)
    vi.spyOn(anchor, 'getClientRects').mockReturnValue([
      new DOMRect(104, 80, 12, 12)
    ] as unknown as DOMRectList)
    renderIndexedFigureLinks(options)
    expect(host.childElementCount).toBe(0)
  })

  it('allows text selection and suppresses navigation while tools make the host inert', () => {
    const { options, host, textLayer, nodes, click, onNavigate } = indexedFixture()
    renderIndexedFigureLinks(options)
    const range = document.createRange()
    range.setStart(nodes[0], 0)
    range.setEnd(nodes[0], 10)
    document.getSelection()!.addRange(range)
    click()
    expect(onNavigate).not.toHaveBeenCalled()
    expect(document.getSelection()!.toString()).toBe('See Fig. 3')
    document.getSelection()!.removeAllRanges()
    host.setAttribute('inert', '')
    click()
    host.querySelector('a')!.click()
    expect(onNavigate).not.toHaveBeenCalled()
    host.removeAttribute('inert')
    textLayer.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 1, clientX: 90, clientY: 85 })
    )
    expect(onNavigate).not.toHaveBeenCalled()
    click()
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('removes old listeners on refresh and on disposal', () => {
    const { options, host, click, onNavigate } = indexedFixture()
    const firstDispose = renderIndexedFigureLinks(options)
    const dispose = renderIndexedFigureLinks(options)
    firstDispose()
    expect(host.querySelectorAll('a')).toHaveLength(1)
    click()
    expect(onNavigate).toHaveBeenCalledTimes(1)
    dispose()
    expect(host.childElementCount).toBe(0)
    click()
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})

async function fixture(
  rotation = 0,
  sourceText?: string,
  linkedText = sourceText
): Promise<
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
  let rect = [40, 700, 120, 720]
  if (sourceText && linkedText) {
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    first.drawText(sourceText, { x: 40, y: 704, size: 12, font })
    const start =
      40 + font.widthOfTextAtSize(sourceText.slice(0, sourceText.indexOf(linkedText)), 12)
    rect = [start, 700, start + font.widthOfTextAtSize(linkedText, 12), 720]
  }
  const link = (extra: Record<string, unknown>): PDFRef =>
    pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: rect,
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
  it.each([
    ['Fig. 3b', 'Fig. 3b', 'Fig. 3b'],
    ['Fig. 3b', '3', 'Fig. 3b'],
    ['Figure 3(b)', '3', 'Figure 3(b)'],
    ['Fig. S3b', 'S3b', 'Fig. S3b']
  ])('reads the clicked source figure only on demand for %s', async (text, linked, expected) => {
    const { options, page, host, onNavigate } = await fixture(90, text, linked)
    const read = vi.spyOn(page, 'getTextContent')
    await renderPdfNativeLinks(options)
    expect(read).not.toHaveBeenCalled()
    host.querySelector('a')!.click()
    await vi.waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }, expected)
    )
    host.querySelector('a')!.click()
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['See Table 3.', '3'],
    ['See section 3.', '3'],
    ['See Fig. 3b and 4c.', '3b'],
    ['See Fig. 3b, c.', '3b'],
    ['See Fig. 3-5.', '3'],
    ['See Fig. 3.2.', '3'],
    ['See Fig. 3aa.', '3'],
    ['Supplementary Fig. 3', '3'],
    ['Extended Data Fig. 3', '3'],
    ['Fig. 3 b', '3'],
    ['See Fig. 3b and citation [7].', '7']
  ])(
    'preserves ordinary navigation without guessing figure identity for %s',
    async (text, linked) => {
      const { options, host, onNavigate } = await fixture(0, text, linked)
      await renderPdfNativeLinks(options)
      host.querySelector('a')!.click()
      await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }))
      expect(vi.mocked(onNavigate).mock.calls[0]).toHaveLength(1)
    }
  )

  it('joins a separately linked number to its same-line source prefix', async () => {
    const { options, page, host, onNavigate } = await fixture()
    vi.spyOn(page, 'getTextContent').mockResolvedValue({
      items: [
        {
          str: 'Fig.',
          dir: 'ltr',
          transform: [12, 0, 0, 12, 40, 704],
          width: 20,
          height: 12,
          fontName: 'font',
          hasEOL: false
        },
        {
          str: '3b',
          dir: 'ltr',
          transform: [12, 0, 0, 12, 64, 704],
          width: 12,
          height: 12,
          fontName: 'font',
          hasEOL: false
        }
      ],
      styles: {},
      lang: null
    })
    const annotation = (await page.getAnnotations())[0]
    vi.spyOn(page, 'getAnnotations').mockResolvedValue([
      { ...annotation, rect: [64, 700, 70, 718] }
    ])
    await renderPdfNativeLinks(options)
    host.querySelector('a')!.click()
    await vi.waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }, 'Fig. 3b')
    )
  })

  it('preserves a number-only native link after a wrapped qualified Figure prefix', async () => {
    const { options, page, host, onNavigate } = await fixture()
    const annotation = (await page.getAnnotations())[0]
    vi.spyOn(page, 'getAnnotations').mockResolvedValue([
      { ...annotation, rect: [84, 700, 96, 718] }
    ])
    vi.spyOn(page, 'getTextContent').mockResolvedValue({
      items: [
        { str: 'See Supplementary', x: 40, y: 720, width: 100 },
        { str: 'Figure', x: 40, y: 704, width: 40 },
        { str: '3b', x: 84, y: 704, width: 12 }
      ].map(({ str, x, y, width }) => ({
        str,
        dir: 'ltr',
        transform: [12, 0, 0, 12, x, y],
        width,
        height: 12,
        fontName: 'font',
        hasEOL: false
      })),
      styles: {},
      lang: null
    })
    await renderPdfNativeLinks(options)
    host.querySelector('a')!.click()
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }))
    expect(vi.mocked(onNavigate).mock.calls[0]).toHaveLength(1)
  })

  it.each([
    { qualifier: 'See Supplementary', x: 40, y: 720, identified: false },
    { qualifier: 'See Extended Data', x: 40, y: 720, identified: false },
    { qualifier: 'See Supplementary', x: 340, y: 720, identified: true },
    { qualifier: 'See Supplementary', x: 40, y: 760, identified: true }
  ])(
    'checks wrapped native figure qualifiers only in the adjacent line (%j)',
    async ({ qualifier, x, y, identified }) => {
      const { options, page, host, onNavigate } = await fixture(0, 'Fig. 3')
      const content = await page.getTextContent()
      const figure = content.items.find((item) => 'str' in item && item.str === 'Fig. 3')
      if (!figure || !('str' in figure)) throw new Error('Missing source figure text')
      vi.spyOn(page, 'getTextContent').mockResolvedValue({
        ...content,
        items: [{ ...figure, str: qualifier, transform: [12, 0, 0, 12, x, y], width: 100 }, figure]
      })
      await renderPdfNativeLinks(options)
      host.querySelector('a')!.click()
      await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1))
      expect(vi.mocked(onNavigate).mock.calls[0]).toEqual(
        identified ? [{ pageNumber: 2, x: 0, y: 0 }, 'Fig. 3'] : [{ pageNumber: 2, x: 0, y: 0 }]
      )
    }
  )

  it.each([true, false])(
    'uses rendered character geometry for a link within a long proportional-font run (%s)',
    async (figureLink) => {
      const source = 'See Fig. 3b and citation [7].'
      const { options, host, onNavigate } = await fixture(0, source, figureLink ? '3b' : '7')
      await renderPdfNativeLinks(options)
      const layer = document.createElement('div')
      layer.dataset.pdfTextLayer = 'true'
      const span = document.createElement('span')
      span.textContent = source
      layer.append(span)
      document.body.append(layer)
      const link = host.querySelector('a')!
      vi.spyOn(link, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(figureLink ? 90 : 160, 20, 12, 12)
      )
      const createRange = document.createRange.bind(document)
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        const range = createRange()
        range.getClientRects = () => {
          expect(range.startOffset).toBe(source.indexOf('3b'))
          expect(range.endOffset).toBe(source.indexOf('3b') + 2)
          return [new DOMRect(90, 20, 12, 12)] as unknown as DOMRectList
        }
        return range
      })
      link.click()
      await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1))
      expect(vi.mocked(onNavigate).mock.calls[0]).toEqual(
        figureLink ? [{ pageNumber: 2, x: 0, y: 0 }, 'Fig. 3b'] : [{ pageNumber: 2, x: 0, y: 0 }]
      )
    }
  )

  it('requires character evidence before assigning a partial link in a long run', async () => {
    const { options, host, onNavigate } = await fixture(0, 'See Fig. 3b and citation [7].', '3b')
    await renderPdfNativeLinks(options)
    host.querySelector('a')!.click()
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }))
  })

  it('falls back to native navigation when source text extraction fails', async () => {
    const { options, page, host, onNavigate } = await fixture()
    vi.spyOn(page, 'getTextContent').mockRejectedValue(new Error('unavailable text'))
    await renderPdfNativeLinks(options)
    host.querySelector('a')!.click()
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }))
  })

  it('keeps each clicked annotation identity while the shared source read is pending', async () => {
    const { options, page, host, onNavigate } = await fixture()
    const annotation = (await page.getAnnotations())[0]
    vi.spyOn(page, 'getAnnotations').mockResolvedValue([
      { ...annotation, rect: [64, 700, 76, 718] },
      { ...annotation, id: 'second-figure', rect: [164, 700, 176, 718] }
    ])
    let finish!: (content: Awaited<ReturnType<typeof page.getTextContent>>) => void
    vi.spyOn(page, 'getTextContent').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await renderPdfNativeLinks(options)
    const links = host.querySelectorAll('a')
    links[0].click()
    links[1].click()
    finish({
      items: [
        {
          str: 'Fig. 3b',
          dir: 'ltr',
          transform: [12, 0, 0, 12, 40, 704],
          width: 36,
          height: 12,
          fontName: 'font',
          hasEOL: false
        },
        {
          str: 'Fig. 8a',
          dir: 'ltr',
          transform: [12, 0, 0, 12, 140, 704],
          width: 36,
          height: 12,
          fontName: 'font',
          hasEOL: false
        }
      ],
      styles: {},
      lang: null
    })
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1))
    expect(onNavigate).toHaveBeenCalledWith({ pageNumber: 2, x: 0, y: 0 }, 'Fig. 8a')
  })

  it('ignores source text that finishes after the reader is disposed', async () => {
    const { options, page, host, controller, onNavigate } = await fixture()
    let finish!: (content: Awaited<ReturnType<typeof page.getTextContent>>) => void
    vi.spyOn(page, 'getTextContent').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await renderPdfNativeLinks(options)
    host.querySelector('a')!.click()
    controller.abort()
    finish({ items: [], styles: {}, lang: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onNavigate).not.toHaveBeenCalled()
  })

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

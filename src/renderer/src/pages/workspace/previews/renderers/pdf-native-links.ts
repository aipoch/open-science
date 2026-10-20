import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'

export type PdfLinkDestination = Readonly<{ pageNumber: number; x: number; y: number }>

export async function resolvePdfLinkPage(
  document: PDFDocumentProxy,
  destination: string | unknown[] | null
): Promise<number | undefined> {
  const resolved =
    typeof destination === 'string' ? await document.getDestination(destination) : destination
  const page = resolved?.[0]
  let index: number | undefined
  if (typeof page === 'number') index = page
  else if (
    typeof page === 'object' &&
    page !== null &&
    'num' in page &&
    'gen' in page &&
    typeof page.num === 'number' &&
    typeof page.gen === 'number'
  )
    index = await document.getPageIndex({ num: page.num, gen: page.gen })
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < document.numPages
    ? index + 1
    : undefined
}

export async function resolvePdfLinkDestination(
  document: PDFDocumentProxy,
  destination: string | unknown[] | null
): Promise<PdfLinkDestination | undefined> {
  const resolved =
    typeof destination === 'string' ? await document.getDestination(destination) : destination
  if (!Array.isArray(resolved)) return undefined
  const pageNumber = await resolvePdfLinkPage(document, resolved)
  const mode = (resolved[1] as { name?: unknown } | undefined)?.name
  if (pageNumber === undefined || typeof mode !== 'string') return undefined
  if (mode === 'Fit' || mode === 'FitB') return { pageNumber, x: 0, y: 0 }
  const coordinates = resolved.slice(2)
  const length =
    mode === 'XYZ'
      ? 3
      : mode === 'FitR'
        ? 4
        : ['FitH', 'FitBH', 'FitV', 'FitBV'].includes(mode)
          ? 1
          : 0
  if (
    !length ||
    coordinates.length !== length ||
    coordinates.some(
      (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value))
    )
  )
    return undefined
  const page = await document.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const [left, bottom, right, top] = page.view
  let rect: number[]
  if (mode === 'FitR') {
    if (
      coordinates.some((value) => value === null) ||
      !(coordinates[2] > coordinates[0]) ||
      !(coordinates[3] > coordinates[1])
    )
      return undefined
    rect = coordinates as number[]
  } else if (mode === 'XYZ') {
    const x = coordinates[0] ?? left,
      y = coordinates[1] ?? top
    rect = [x, y, x, y]
  } else if (mode === 'FitH' || mode === 'FitBH') {
    const y = coordinates[0] ?? top
    rect = [left, y, left, y]
  } else {
    const x = coordinates[0] ?? left
    rect = [x, bottom, x + right - left, top]
  }
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect)
  return {
    pageNumber,
    x: Math.max(0, Math.min(1, Math.min(x1, x2) / viewport.width)),
    y: Math.max(0, Math.min(1, Math.min(y1, y2) / viewport.height))
  }
}

export async function renderPdfNativeLinks({
  host,
  page,
  document,
  viewport,
  signal,
  onNavigate,
  label
}: {
  host: HTMLDivElement
  page: PDFPageProxy
  document: PDFDocumentProxy
  viewport: PageViewport
  signal: AbortSignal
  onNavigate: (destination: PdfLinkDestination) => void
  label: string
}): Promise<void> {
  const annotations = (await page.getAnnotations({ intent: 'display' })).filter((item) => {
    if (
      item.annotationType !== pdfjsLib.AnnotationType.LINK ||
      item.action ||
      item.actions ||
      item.attachment ||
      item.setOCGState ||
      item.resetForm
    )
      return false
    if (item.url) {
      try {
        return ['http:', 'https:', 'mailto:'].includes(new URL(item.url).protocol)
      } catch {
        return false
      }
    }
    return Boolean(item.dest)
  })
  if (signal.aborted || !annotations.length) return
  const { SimpleLinkService, LinkTarget } = await import('pdfjs-dist/web/pdf_viewer.mjs')
  if (signal.aborted) return
  const linkService = new SimpleLinkService()
  linkService.externalLinkTarget = LinkTarget.BLANK
  let navigation = 0
  linkService.goToDestination = async (destination): Promise<void> => {
    const request = ++navigation
    try {
      const target = await resolvePdfLinkDestination(document, destination)
      if (!signal.aborted && request === navigation && target) onNavigate(target)
    } catch {
      // Broken destinations must not interrupt reading or reject an event handler's promise.
    }
  }
  const div = window.document.createElement('div')
  div.className = 'pdf-native-links'
  div.style.setProperty('--total-scale-factor', String(viewport.scale))
  div.style.setProperty('--scale-round-x', '1px')
  div.style.setProperty('--scale-round-y', '1px')
  const layer = new pdfjsLib.AnnotationLayer({
    div,
    page,
    viewport: viewport.clone({ dontFlip: true }),
    linkService,
    accessibilityManager: undefined,
    annotationCanvasMap: undefined,
    annotationEditorUIManager: undefined,
    structTreeLayer: undefined,
    commentManager: undefined,
    annotationStorage: undefined
  })
  await layer.render({
    div,
    page,
    viewport,
    annotations: annotations.map((item) => ({ ...item, id: `${host.id}-${item.id}` })),
    linkService,
    renderForms: false,
    enableScripting: false
  })
  if (signal.aborted) return
  for (const link of div.querySelectorAll('a')) {
    link.setAttribute('aria-label', link.title || label)
    if (!link.title) link.title = label
    // Keep modified/middle clicks on internal destinations inside this reader.
    if (link.closest('[data-internal-link]')) link.onauxclick = (event) => event.preventDefault()
  }
  host.replaceChildren(div)
}

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'
import {
  endsWithFigureSeriesQualifier,
  figureReferenceKey,
  type PdfLinkDestination
} from './pdf-figure-index'

export type { PdfLinkDestination } from './pdf-figure-index'
type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

export type FigureLinkAnchor = {
  trigger: HTMLAnchorElement
  x: number
  top: number
  bottom: number
  left: number
  right: number
  keyboard: boolean
}

function figureLinkAnchor(trigger: HTMLAnchorElement, event: MouseEvent): FigureLinkAnchor {
  const bounds = trigger.getBoundingClientRect()
  return {
    trigger,
    x: event.detail ? event.clientX : bounds.left + bounds.width / 2,
    top: bounds.top,
    bottom: bounds.bottom,
    left: bounds.left,
    right: bounds.right,
    keyboard: event.detail === 0
  }
}

const indexedLinkDisposers = new WeakMap<HTMLElement, () => void>()

function figureReferences(text: string, precedingLine = ''): RegExpExecArray[] {
  return [
    ...text.matchAll(
      /(?:\b(?:Fig(?:ure)?\.?)|[图圖])[ \t]*(?:S[ \t]*)?\d+(?:[ \t]*\([ \t]*[a-z][ \t]*\)|[a-z])?/giu
    )
  ].filter((match) => {
    const before = text.slice(0, match.index).split('\n').at(-1)!
    const after = text.slice(match.index + match[0].length)
    // A wrapped series qualifier still belongs to a label starting the next line.
    return (
      !endsWithFigureSeriesQualifier(before.trim() ? before : precedingLine) &&
      !/^[\p{L}\d]/u.test(after) &&
      !/^[ \t]+[a-z](?:\b|$)/iu.test(after) &&
      !/^[ \t]*(?:[.．]\d|[（(]|[-–—/]|(?:[,，&]|and\b|or\b|和|与|與|及)[ \t]*(?:S?\d|[a-z]\b))/iu.test(
        after
      )
    )
  })
}

/** Add keyboard links while leaving pointer selection on the original PDF.js text. */
export function renderIndexedFigureLinks({
  host,
  textLayer,
  index,
  pageNumber,
  onNavigate
}: {
  host: HTMLDivElement
  textLayer: HTMLElement
  index: ReadonlyMap<string, PdfLinkDestination>
  pageNumber: number
  onNavigate: (destination: PdfLinkDestination, reference: string, anchor: FigureLinkAnchor) => void
}): () => void {
  indexedLinkDisposers.get(host)?.()
  host.replaceChildren()
  const document = host.ownerDocument
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT)
  const lines: Array<{
    text: string
    runs: Array<{ node: Text; start: number; end: number }>
    firstBox: DOMRect
    lastBox: DOMRect
  }> = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!node.textContent || !parent?.closest('span') || parent.closest('a, .endOfContent'))
      continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0)
    if (!box) continue
    let line = lines.at(-1)
    if (
      !line ||
      Math.abs(line.lastBox.top - box.top) > Math.min(line.lastBox.height, box.height) * 0.4 ||
      box.left < line.lastBox.left ||
      box.left - line.lastBox.right > Math.max(line.lastBox.height, box.height)
    ) {
      line = { text: '', runs: [], firstBox: box, lastBox: box }
      lines.push(line)
    }
    if (line.text && !/\s$/u.test(line.text) && !/^\s/u.test(node.textContent)) line.text += ' '
    const start = line.text.length
    line.text += node.textContent
    line.runs.push({ node: node as Text, start, end: line.text.length })
    line.lastBox = box
  }
  const nativeBoxes = [
    ...(host.parentElement?.querySelectorAll('.pdf-native-links a') ?? [])
  ].flatMap((link) => [...link.getClientRects()])
  const hostBox = host.getBoundingClientRect()
  const links: Array<{
    range: Range
    anchor: HTMLAnchorElement
    destination: PdfLinkDestination
    reference: string
  }> = []
  for (const [i, line] of lines.entries()) {
    const previous = lines[i - 1]
    const precedingLine =
      previous &&
      line.firstBox.top > previous.firstBox.top &&
      line.firstBox.top - previous.firstBox.top <= line.firstBox.height * 2 &&
      Math.abs(line.firstBox.left - previous.firstBox.left) <= line.firstBox.height * 2
        ? previous.text
        : ''
    for (const match of figureReferences(line.text, precedingLine)) {
      const reference = match[0]
      const end = match.index + reference.length
      const before = line.text.slice(0, match.index)
      const key = figureReferenceKey(reference)
      const destination = key ? index.get(key) : undefined
      // A same-page label starting a line may be the figure's own caption.
      if (!destination || (destination.pageNumber === pageNumber && !before.trim())) continue
      const first = line.runs.find((run) => run.start <= match.index && run.end > match.index)
      const last = line.runs.find((run) => run.start < end && run.end >= end)
      if (!first || !last) continue
      const range = document.createRange()
      range.setStart(first.node, match.index - first.start)
      range.setEnd(last.node, end - last.start)
      const boxes = [...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0)
      if (
        !boxes.length ||
        boxes.some((box) =>
          nativeBoxes.some(
            (native) =>
              native.left < box.right &&
              native.right > box.left &&
              native.top < box.bottom &&
              native.bottom > box.top
          )
        )
      )
        continue
      const left = Math.min(...boxes.map((box) => box.left))
      const top = Math.min(...boxes.map((box) => box.top))
      const anchor = document.createElement('a')
      anchor.href = `#page=${destination.pageNumber}`
      anchor.setAttribute('aria-label', reference)
      anchor.dataset.pdfFigureReference = reference
      Object.assign(anchor.style, {
        position: 'absolute',
        left: `${left - hostBox.left}px`,
        top: `${top - hostBox.top}px`,
        width: `${Math.max(...boxes.map((box) => box.right)) - left}px`,
        height: `${Math.max(...boxes.map((box) => box.bottom)) - top}px`,
        pointerEvents: 'none',
        outlineOffset: '2px'
      })
      anchor.onfocus = () => {
        anchor.style.outline = '2px solid var(--ring)'
      }
      anchor.onblur = () => {
        anchor.style.outline = ''
      }
      anchor.onclick = (event) => {
        event.preventDefault()
        if (!host.closest('[inert]'))
          onNavigate(destination, reference, figureLinkAnchor(anchor, event))
      }
      anchor.onauxclick = (event) => event.preventDefault()
      host.append(anchor)
      links.push({ range, anchor, destination, reference })
    }
  }
  const onClick = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.detail > 1 ||
      host.closest('[inert]') ||
      !document.getSelection()?.isCollapsed ||
      (event.target instanceof Element && event.target.closest('a'))
    )
      return
    const link = links.find(({ range }) =>
      [...range.getClientRects()].some(
        (box) =>
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom
      )
    )
    if (!link) return
    event.preventDefault()
    link.anchor.focus({ preventScroll: true })
    onNavigate(link.destination, link.reference, figureLinkAnchor(link.anchor, event))
  }
  textLayer.addEventListener('click', onClick)
  const dispose = (): void => {
    textLayer.removeEventListener('click', onClick)
    for (const { anchor } of links) anchor.remove()
    if (indexedLinkDisposers.get(host) === dispose) indexedLinkDisposers.delete(host)
  }
  indexedLinkDisposers.set(host, dispose)
  return dispose
}

function sourceFigureReference(
  content: TextContent,
  rect: number[],
  link: HTMLAnchorElement
): string | undefined {
  if (rect.length !== 4 || !rect.every(Number.isFinite)) return undefined
  const left = Math.min(rect[0], rect[2]),
    right = Math.max(rect[0], rect[2]),
    bottom = Math.min(rect[1], rect[3]),
    top = Math.max(rect[1], rect[3])
  const items = content.items.flatMap((item) => {
    if (!('str' in item) || !item.str || item.dir !== 'ltr') return []
    const [a, b, c, d, x, y] = item.transform
    // Rotated/vertical glyph runs do not establish a reliable horizontal label.
    if (a <= 0 || d <= 0 || Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || item.width <= 0) return []
    const height = item.height || d
    const style = content.styles[item.fontName]
    const ascent = style?.ascent ?? 0.8,
      descent = style?.descent ?? -0.2
    const overlaps = y + height * ascent > bottom && y + height * descent < top
    return [{ text: item.str, x, y, width: item.width, height, overlaps }]
  })
  const owners = items.filter(
    (item) => item.overlaps && item.x < right && item.x + item.width > left
  )
  if (!owners.length) return undefined
  const baseline = owners[0].y
  if (owners.some((item) => Math.abs(item.y - baseline) > item.height * 0.3)) return undefined
  const row = items
    .filter((item) => Math.abs(item.y - baseline) <= item.height * 0.3)
    .sort((a, b) => a.x - b.x)
  let text = ''
  const runs: Array<{ item: (typeof row)[number]; start: number; end: number }> = []
  let previous: (typeof row)[number] | undefined
  for (const item of row) {
    const gap = previous ? item.x - previous.x - previous.width : 0
    // A column boundary cannot supply the missing figure prefix.
    if (previous && gap > Math.max(previous.height, item.height)) {
      text += '\n'
    } else if (previous && gap > item.height * 0.1 && !text.endsWith(' ')) {
      text += ' '
    }
    runs.push({ item, start: text.length, end: text.length + item.text.length })
    text += item.text
    previous = item
  }
  const ownerRun = runs.find((run) => run.item === owners[0])!
  const lineStart = text.lastIndexOf('\n', ownerRun.start) + 1
  const first = runs.find((run) => run.start >= lineStart)!.item
  const preceding = items
    .filter(
      (item) =>
        item.y > baseline + item.height * 0.3 &&
        item.y - baseline <= item.height * 2 &&
        Math.abs(item.x - first.x) <= item.height * 2
    )
    .sort((a, b) => a.y - b.y || a.x - b.x)[0]
  let precedingLine = ''
  if (preceding) {
    let previous = preceding
    for (const item of items
      .filter(
        (item) => Math.abs(item.y - preceding.y) <= item.height * 0.3 && item.x >= preceding.x
      )
      .sort((a, b) => a.x - b.x)) {
      if (item.x - previous.x - previous.width > Math.max(previous.height, item.height)) break
      precedingLine += ` ${item.text}`
      previous = item
    }
  }
  const matches = figureReferences(text, precedingLine).filter((match) => {
    const end = match.index + match[0].length
    const digit = match.index + match[0].search(/\d/u)
    const covered = runs.filter((run) => run.start < end && run.end > digit)
    // Dedicated label/number runs establish ownership without guessing glyph widths.
    if (
      owners.every((owner) => {
        const run = runs.find((candidate) => candidate.item === owner)!
        return (
          run.start + owner.text.search(/\S/u) >= match.index &&
          run.end - (owner.text.length - owner.text.trimEnd().length) <= end
        )
      }) &&
      covered.some((run) => owners.includes(run.item))
    )
      return true
    // A long proportional-font run needs the rendered text layer's actual character geometry.
    const bounds = link.getBoundingClientRect()
    const layer = link
      .closest('.pdf-native-links')
      ?.parentElement?.parentElement?.querySelector('[data-pdf-text-layer]')
    if (!layer || !bounds.width || !bounds.height) return false
    return covered.some((run) =>
      [...layer.querySelectorAll('span')].some((span) => {
        if (
          span.textContent !== run.item.text ||
          span.childNodes.length !== 1 ||
          span.firstChild?.nodeType !== Node.TEXT_NODE
        )
          return false
        const range = window.document.createRange()
        range.setStart(span.firstChild, Math.max(0, digit - run.start))
        range.setEnd(span.firstChild, Math.min(run.item.text.length, end - run.start))
        return [...range.getClientRects()].some(
          (box) =>
            box.left < bounds.right &&
            box.right > bounds.left &&
            box.top < bounds.bottom &&
            box.bottom > bounds.top
        )
      })
    )
  })
  return matches.length === 1 ? matches[0][0] : undefined
}

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
  onNavigate: (
    destination: PdfLinkDestination,
    reference?: string,
    anchor?: FigureLinkAnchor
  ) => void
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
  let activeSource:
    { rect: number[]; link: HTMLAnchorElement; anchor: FigureLinkAnchor } | undefined
  let textContent: Promise<TextContent> | undefined
  linkService.goToDestination = async (destination): Promise<void> => {
    if (signal.aborted) return
    const request = ++navigation
    const source = activeSource
    try {
      const [target, reference] = await Promise.all([
        resolvePdfLinkDestination(document, destination),
        source
          ? (textContent ??= page.getTextContent())
              .then((content) => sourceFigureReference(content, source.rect, source.link))
              .catch(() => undefined)
          : undefined
      ])
      if (!signal.aborted && request === navigation && target) {
        if (reference && source) onNavigate(target, reference, source.anchor)
        else onNavigate(target)
      }
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
  const sourceAnnotations = new Map(annotations.map((item) => [`${host.id}-${item.id}`, item]))
  for (const link of div.querySelectorAll('a')) {
    link.setAttribute('aria-label', link.title || label)
    if (!link.title) link.title = label
    // Keep modified/middle clicks on internal destinations inside this reader.
    if (link.closest('[data-internal-link]')) {
      link.onauxclick = (event) => event.preventDefault()
      const annotation = sourceAnnotations.get(link.getAttribute('data-element-id') ?? '')
      const navigate = link.onclick
      link.onclick = function (event) {
        activeSource = annotation?.rect
          ? { rect: annotation.rect, link, anchor: figureLinkAnchor(link, event) }
          : undefined
        try {
          return navigate?.call(this, event)
        } finally {
          activeSource = undefined
        }
      }
    }
  }
  host.replaceChildren(div)
}

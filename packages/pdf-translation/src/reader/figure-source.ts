import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { readPdfStructureEvidence } from './structure-evidence.js'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type {
  StructTreeContent,
  StructTreeNode,
  TextItem
} from 'pdfjs-dist/types/src/display/api.js'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfTranslationExtraction } from './extraction.js'
import { isPdfTranslationCaption } from './layout.js'
import { createPdfTranslationSource, type PdfTranslationFragment } from './source.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import {
  structureRegionContains,
  structureRegionsOverlap,
  verifiedPdfStructureRegions
} from './structure-regions.js'
import { nativeLabelRegion, nativeRectangularPath } from './native-source-geometry.js'
import {
  retainPdfWholeRegionSources,
  isCurrentCaptionedMathBodyRetention
} from './whole-region-retention.js'
import { restoreReferenceFigureCaptions } from './reference-figure-caption.js'
import { carryNativeCaptionEligibility } from './caption-eligibility.js'
import { restoreNativeOrdinaryAppendixProse } from './wrapped-section-prose.js'
import { retainNativeFigurePanels, isCurrentNativeFigurePanels } from './figure-panels.js'
import {
  retainNativeFigureVariableKeys,
  isCurrentNativeFigureVariableKeys
} from './figure-variable-keys.js'

type Rect = PdfTranslationFragment['rect']
type FilledRule = Rect & { operatorIndex: number }
type Matrix = readonly number[]
type PaintedPath = Rect & {
  frame: boolean
  rounded: boolean
  straight?: true
  diagramStroke?: 'box' | 'horizontal'
  point?: 'circle' | 'cross'
}
type Document = { getPage: (number: number) => Promise<PDFPageProxy> }
type Source = PdfTranslationExtraction['source']
const multiply = (a: Matrix, b: Matrix): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5]
]
const overlaps = (a: Rect, b: Rect, pad = 0.004): boolean =>
  a.x <= b.x + b.width + pad &&
  b.x <= a.x + a.width + pad &&
  a.y <= b.y + b.height + pad &&
  b.y <= a.y + a.height + pad
const union = (a: Rect, b: Rect): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
  height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y)
})
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - 0.003 &&
  inner.y >= outer.y - 0.003 &&
  inner.x + inner.width <= outer.x + outer.width + 0.003 &&
  inner.y + inner.height <= outer.y + outer.height + 0.003

const isFigureCaption = (text: string): boolean =>
  /^(?:(?:Extended Data\s+)?(?:Figure|Fig\.))\s*\d/iu.test(text)

// A full-width floating figure can divide a quantified sentence between pages.
function nativeFigureSentenceContinuation(
  source: Source,
  units: Source['units'],
  regions: readonly Rect[],
  number: number
): { head: Source['units'][number]; tail: Source['units'][number] } | undefined {
  const previousPage = source.pages[number - 2],
    currentPage = source.pages[number - 1]
  if (
    !previousPage ||
    !currentPage ||
    previousPage.width !== currentPage.width ||
    previousPage.height !== currentPage.height ||
    regions.length !== 1
  )
    return
  const [figure] = regions
  const captionIndex = units.findIndex((unit) => isPdfTranslationCaption(unit.source))
  if (captionIndex < 1) return
  const [caption, tail, following] = units.slice(captionIndex)
  const label = /^Figure (\d+): /u.exec(caption.source)
  if (!label || caption.fragments.length !== 1 || tail?.fragments.length !== 1) return
  const prior = source.units.filter((unit) =>
    unit.fragments.some((part) => part.pageNumber === number - 1)
  )
  const [head, folio] = prior.slice(-2)
  const headPart = head?.fragments[0],
    tailPart = tail.fragments[0]
  if (
    !headPart ||
    head.sourceOnly ||
    tail.sourceOnly ||
    head.figure ||
    tail.figure ||
    head.fragments.length !== 1 ||
    headPart.pageNumber !== number - 1 ||
    tailPart.pageNumber !== number ||
    !/\. Thus, the sum of$/u.test(headPart.items.at(-1)?.text ?? '') ||
    tailPart.items[0]?.text !== 'this quantity over all' ||
    !/^this quantity over all \p{Ll} ∈ \{\d+(?:, \d+){1,5}\} is at most \d+\. Since /u.test(
      tail.source
    ) ||
    !folio?.sourceOnly ||
    folio.preserve !== 'literal' ||
    folio.source !== String(number - 1) ||
    folio.fragments.length !== 1 ||
    folio.fragments[0].rect.y < 0.88 ||
    !following?.sourceOnly ||
    following.preserve !== 'formula' ||
    !/^pair \(/u.test(following.source) ||
    following.fragments.length !== 1 ||
    following.fragments[0].pageNumber !== number ||
    !prior.some((unit) => unit.source.includes(`See Figure ${label[1]} for `))
  )
    return
  const end = (rect: Rect): number => rect.y + rect.height
  const before = headPart.rect,
    after = tailPart.rect,
    cap = caption.fragments[0].rect
  const aligned = (r: Rect): boolean =>
    Math.abs(r.x - before.x) < 0.003 && Math.abs(r.width - before.width) < 0.006
  const labelMargin = after.height * 3
  const figureBand = {
    x: figure.x - labelMargin,
    width: figure.width + labelMargin * 2,
    y: figure.y - labelMargin / 2,
    height: figure.height + labelMargin
  }
  if (
    end(before) < 0.85 ||
    before.width < 0.7 ||
    end(before) >= folio.fragments[0].rect.y ||
    figure.y < 0.07 ||
    figure.y > 0.16 ||
    figure.width < 0.4 ||
    figure.height < 0.13 ||
    cap.y < end(figure) ||
    cap.y - end(figure) > 0.05 ||
    !aligned(cap) ||
    !aligned(after) ||
    after.y <= end(cap) ||
    after.y - end(cap) > 0.04 ||
    units
      .slice(0, captionIndex)
      .some(
        (unit) =>
          unit.fragments.length !== 1 ||
          unit.fragments[0].pageNumber !== number ||
          !contains(figureBand, unit.fragments[0].rect)
      )
  )
    return
  return { head, tail }
}

// A numbered figure appendix after the bibliography has its own caption flow.
async function rasterAppendixCaptions(
  page: PDFPageProxy,
  units: Source['units'],
  images: Rect[],
  heading: Source['units'][number],
  signal: AbortSignal
): Promise<string[]> {
  const captions = units.filter((unit) => unit !== heading)
  if (page.rotate !== 0 || !captions.length || captions.length !== images.length) return []
  const graphics = [...images].sort((a, b) => a.y - b.y)
  if (
    !captions.every(({ fragments: [{ rect }] }, index) => {
      const graphic = graphics[index]
      const gap = rect.y - graphic.y - graphic.height
      const previous = captions[index - 1]?.fragments[0].rect
      return (
        rect.width >= 0.66 &&
        graphic.width >= 0.45 &&
        graphic.height >= 0.2 &&
        Math.abs(rect.x - graphic.x) < 0.002 &&
        graphic.x + graphic.width < rect.x + rect.width &&
        gap > 0.002 &&
        gap < 0.028 &&
        (!previous || previous.y + previous.height < graphic.y) &&
        (!(index === 0 && units[0] === heading) ||
          heading.fragments[0].rect.y + heading.fragments[0].rect.height < graphic.y)
      )
    })
  )
    return []

  const content = await page.getTextContent()
  signal.throwIfAborted()
  const items = units.flatMap((unit) => unit.fragments[0].items)
  const visible = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  if (
    items.length !== visible.length ||
    !visible.every(
      ({ item, index }, i) =>
        items[i].index === index &&
        items[i].text === item.str &&
        item.dir === 'ltr' &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0 &&
        item.height > 0 &&
        item.width > 0
    )
  )
    return []
  return captions.map((unit) => unit.id)
}

// A full-width caption may follow the last reference when it belongs to a separate image.
async function terminalReferenceCaption(
  page: PDFPageProxy,
  units: Source['units'],
  images: Rect[],
  previous: Source['units'][number] | undefined,
  signal: AbortSignal
): Promise<string | undefined> {
  const unit = units.at(-1)
  const [fragment] = unit?.fragments ?? []
  if (
    !unit?.sourceOnly ||
    unit.preserve !== 'reference' ||
    unit.fragments.length !== 1 ||
    page.rotate !== 0
  )
    return
  const { rect } = fragment
  const image = images[0]
  const gap = image && rect.y - image.y - image.height
  // A standalone last page can carry a photograph and one caption after the bibliography.
  if (
    units.length === 1 &&
    images.length === 1 &&
    previous?.sourceOnly &&
    previous.preserve === 'reference' &&
    previous.fragments.at(-1)?.pageNumber === fragment.pageNumber - 1 &&
    /^Figure [1-9]\d*: \p{Lu}.{24,}\.$/u.test(unit.source) &&
    image.width >= 0.3 &&
    image.height >= 0.25 &&
    gap > 0.004 &&
    gap < 0.03 &&
    Math.abs(2 * image.x + image.width - 1) < 0.01 &&
    Math.abs(2 * rect.x + rect.width - 1) < 0.01
  ) {
    const { items } = await page.getTextContent()
    signal.throwIfAborted()
    const native = items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    )
    if (native.length === 0 || native.length !== fragment.items.length) return
    const { width, height } = page.getViewport({ scale: 1 })
    if (![width, height].every((size) => Number.isFinite(size) && size > 0)) return
    const first = native[0].item
    const last = native.at(-1)!.item
    if (
      Math.abs(first.transform[4] / width - rect.x) > 0.005 ||
      Math.abs((last.transform[4] + last.width) / width - rect.x - rect.width) > 0.005 ||
      Math.abs(1 - first.transform[5] / height - rect.y - rect.height) > 0.008 ||
      native
        .map(({ item }) => item.str)
        .join('')
        .replace(/\s+/gu, '') !== unit.source.replace(/\s+/gu, '')
    )
      return
    return native.every(({ item, index }, i) => {
      const [a, b, c, d, x, y] = item.transform
      const prior = native[i - 1]?.item
      const separation = prior ? x - prior.transform[4] - prior.width : 0
      return (
        index === fragment.items[i].index &&
        item.str === fragment.items[i].text &&
        item.dir === 'ltr' &&
        [a, b, c, d, x, y, item.width, item.height].every(Number.isFinite) &&
        a > 0 &&
        b === 0 &&
        c === 0 &&
        d > 0 &&
        item.width > 0 &&
        item.height === first.height &&
        first.height > 0 &&
        y === first.transform[5] &&
        separation >= -first.height * 0.05 &&
        separation <= first.height * 0.5
      )
    })
      ? unit.id
      : undefined
  }
  if (
    !/^Figure [1-9]\d*\. \S.{120,}\.$/u.test(unit.source) ||
    fragment.items.length < 4 ||
    rect.width < 0.7 ||
    rect.y < 0.6
  )
    return
  const headingIndex = units.findLastIndex((u) => /^References$/iu.test(u.source))
  if (headingIndex < 0) return
  const [heading, ...citations] = units.slice(headingIndex, -1)
  if (
    citations.length < 2 ||
    ![heading, ...citations].every(
      (u) =>
        u.sourceOnly &&
        u.preserve === 'reference' &&
        u.fragments.length === 1 &&
        u.fragments[0].rect.x > rect.x + rect.width / 2
    ) ||
    !citations.every((u) =>
      /^\p{Lu}[\p{L}'’ -]+, .+, (?:19|20)\d{2}, [\p{L}&. ]+, \d+, [A-Z]?\d+$/u.test(u.source)
    )
  )
    return
  const lastCitation = citations.at(-1)!.fragments[0].rect
  const anchors = images.filter((r) => {
    const gap = rect.y - r.y - r.height
    return (
      Math.abs(r.x - rect.x) < 0.005 &&
      Math.abs(r.x + r.width - rect.x - rect.width) < 0.005 &&
      r.y > lastCitation.y + lastCitation.height &&
      gap > 0.002 &&
      gap < 0.04
    )
  })
  if (anchors.length !== 1) return

  const { items } = await page.getTextContent()
  signal.throwIfAborted()
  const native = items
    .slice(fragment.items[0].index)
    .flatMap((item, i) =>
      'str' in item && item.str.trim() ? [{ item, index: fragment.items[0].index + i }] : []
    )
  if (native.length !== fragment.items.length) return
  const baselines = new Set<number>()
  for (const [i, { item, index }] of native.entries()) {
    const [a, b, c, d] = item.transform
    if (
      index !== fragment.items[i].index ||
      item.str !== fragment.items[i].text ||
      a <= 0 ||
      b !== 0 ||
      c !== 0 ||
      d <= 0 ||
      item.height <= 0
    )
      return
    baselines.add(item.transform[5])
  }
  if (baselines.size < 2 || baselines.size > 5) return
  return unit.id
}

// Deferred raster plots can interrupt a bibliography. Prove the plot and the
// two independent reference columns below its caption.
async function interleavedRasterCaption(
  page: PDFPageProxy,
  source: Source,
  units: Source['units'],
  images: readonly Rect[],
  pageNumber: number,
  signal: AbortSignal
): Promise<string | undefined> {
  if (page.rotate !== 0 || pageNumber <= 1) return
  const terminal = pageNumber === source.pages.length && images.length === 1
  if (!terminal && (pageNumber >= source.pages.length || images.length !== 2)) return
  const [top, secondImage] = images.toSorted((a, b) => a.y - b.y)
  const bottom = secondImage ?? top
  const stackGap = bottom.y - top.y - top.height
  const hasRunningTitle = terminal && units[0]?.source !== String(pageNumber)
  const folioIndex = hasRunningTitle ? 1 : 0
  const folio = units[folioIndex]
  const caption = units[folioIndex + 1]
  if (
    top.y > 0.12 ||
    Math.abs(2 * top.x + top.width - 1) > 0.01 ||
    (terminal
      ? top.width < 0.6 || top.height < (hasRunningTitle ? 0.25 : 0.18)
      : top.width < 0.4 ||
        bottom.width < 0.4 ||
        top.height + bottom.height < 0.55 ||
        Math.abs(2 * bottom.x + bottom.width - 1) > 0.01 ||
        stackGap < -0.002 ||
        stackGap > 0.005)
  )
    return
  if (hasRunningTitle) {
    const head = units[0]
    const headRect = head?.fragments[0]?.rect
    const folioRect = folio?.fragments[0]?.rect
    if (
      !head?.sourceOnly ||
      head.preserve !== 'reference' ||
      head.fragments.length !== 1 ||
      head.fragments[0].items.length !== 1 ||
      !headRect ||
      !folioRect ||
      Math.abs(2 * headRect.x + headRect.width - 1) > 0.01 ||
      Math.abs(headRect.y - folioRect.y) > 0.002 ||
      headRect.y + headRect.height >= top.y ||
      folioRect.x < 0.85
    )
      return
  }
  if (
    folio?.source !== String(pageNumber) ||
    folio.fragments.length !== 1 ||
    folio.fragments[0].rect.y > 0.07 ||
    !caption?.sourceOnly ||
    caption.preserve !== 'reference' ||
    caption.fragments.length !== 1 ||
    !/^Figure [1-9]\d*\. \p{Lu}.{80,}\.$/u.test(caption.source)
  )
    return
  const [fragment] = caption.fragments
  const cap = fragment.rect
  const gap = cap.y - bottom.y - bottom.height
  if (
    cap.width < 0.75 ||
    (terminal &&
      !hasRunningTitle &&
      (folio.fragments[0].rect.x < 0.85 ||
        folio.fragments[0].rect.y + folio.fragments[0].rect.height >= top.y ||
        Math.abs(cap.x - top.x) > 0.005 ||
        Math.abs(cap.width - top.width) > 0.01)) ||
    Math.abs(2 * cap.x + cap.width - 1) > 0.02 ||
    gap < 0.004 ||
    gap > 0.025 ||
    fragment.items.length < (terminal ? 3 : 4) ||
    !source.units.some(
      (u) =>
        u.sourceOnly &&
        u.preserve === 'reference' &&
        /^References$/iu.test(u.source) &&
        u.fragments.length === 1 &&
        u.fragments[0].pageNumber === pageNumber - 1
    ) ||
    (!terminal &&
      !source.units.some(
        (u) =>
          u.sourceOnly &&
          u.preserve === 'reference' &&
          u.fragments[0]?.pageNumber === pageNumber + 1 &&
          /(?:19|20)\d{2}, [\p{L}.& ]+, \d+, [A-Z]?\d+$/u.test(u.source)
      ))
  )
    return
  const lower = units.slice(folioIndex + 2)
  if (
    lower.some(
      (u) =>
        !u.sourceOnly ||
        u.preserve !== 'reference' ||
        u.fragments.length !== 1 ||
        u.fragments[0].rect.y <= cap.y + cap.height ||
        u.fragments[0].rect.width > 0.45
    )
  )
    return
  const lanes = [
    lower.filter((u) => u.fragments[0].rect.x < 0.5),
    lower.filter((u) => u.fragments[0].rect.x >= 0.5)
  ]
  if (
    !lanes.every(
      (lane) =>
        lane.length >= 2 &&
        /^\p{L}.+, (?:\p{Lu}\.[ ]*)+/u.test(lane[0].source) &&
        (terminal
          ? lane.filter((u) => /\bdoi:\s*10\.\d{4,9}\/\S+/iu.test(u.source)).length >= 2
          : /(?:19|20)\d{2}, [\p{L}.& ]+, \d+, [A-Z]?\d+$/u.test(
              lane.map((u) => u.source).join(' ')
            ))
    ) ||
    Math.abs(lanes[0][0].fragments[0].rect.y - lanes[1][0].fragments[0].rect.y) > 0.001
  )
    return
  const { items } = await page.getTextContent()
  signal.throwIfAborted()
  const start = fragment.items[0].index
  const end = fragment.items.at(-1)!.index
  const native = items
    .slice(start, end + 1)
    .flatMap((item, offset) =>
      'str' in item && item.str.trim() ? [{ item, index: start + offset }] : []
    )
  if (native.length !== fragment.items.length) return
  const lead = native[0].item
  const next = native[1].item
  if (
    !/^Figure [1-9]\d*\.$/u.test(lead.str) ||
    lead.fontName === next.fontName ||
    lead.height !== next.height ||
    lead.transform[5] !== next.transform[5] ||
    !native.every(({ item, index }, at) => {
      const [a, b, c, d] = item.transform
      return (
        index === fragment.items[at].index &&
        item.str === fragment.items[at].text &&
        item.dir === 'ltr' &&
        [...item.transform, item.width, item.height].every(Number.isFinite) &&
        a > 0 &&
        b === 0 &&
        c === 0 &&
        d > 0 &&
        item.width > 0 &&
        item.height > 0
      )
    })
  )
    return
  return caption.id
}

// A bibliography can be followed by a final page of full-width figures.
function referencePageCaptions(
  source: Source,
  units: Source['units'],
  vectors: readonly Rect[],
  pageNumber: number
): string[] {
  if (
    vectors.length < 2 ||
    !units.every(
      (unit) => unit.fragments.length === 1 && unit.fragments[0].pageNumber === pageNumber
    )
  )
    return []
  const previous = source.units.filter(
    (unit) => unit.fragments.at(-1)?.pageNumber === pageNumber - 1
  )
  if (
    !previous.some(
      (unit) => unit.preserve === 'reference' && /^(?:References|Bibliography)$/iu.test(unit.source)
    )
  )
    return []
  const folio = new RegExp(`\\bpage ${pageNumber} of ${pageNumber}$`, 'iu')
  const captions = units.filter(
    (unit) =>
      unit.sourceOnly &&
      unit.preserve === 'reference' &&
      /^(?:Figure|Fig\.) [1-9]\d*[.:] \p{Lu}.{80,}\.$/u.test(unit.source) &&
      isPdfTranslationCaption(unit.source)
  )
  if (captions.length < 2) return []
  const figures = captions.map(({ fragments: [{ rect }] }) => {
    if (rect.width < 0.7 || Math.abs(2 * rect.x + rect.width - 1) >= 0.02) return
    const candidates = vectors.filter((graphic) => {
      const gap = rect.y - graphic.y - graphic.height
      return (
        graphic.height >= 0.12 &&
        graphic.width >= 0.5 &&
        gap > 0.002 &&
        gap < 0.025 &&
        graphic.x >= rect.x &&
        graphic.x + graphic.width <= rect.x + rect.width
      )
    })
    return candidates.length === 1 ? candidates[0] : undefined
  })
  if (
    figures.some((graphic, index) => {
      const previous = captions[index - 1]?.fragments[0].rect
      return !graphic || (previous && graphic.y <= previous.y + previous.height)
    }) ||
    units.some((unit) => {
      const [{ rect }] = unit.fragments
      return (
        !captions.includes(unit) &&
        !figures.some((graphic) => graphic && contains(graphic, rect)) &&
        !(
          rect.y + rect.height < 0.055 &&
          source.units.some(
            (earlier) =>
              earlier.source === unit.source &&
              earlier.fragments[0].pageNumber < pageNumber &&
              earlier.fragments[0].rect.y + earlier.fragments[0].rect.height < 0.055
          )
        ) &&
        !(rect.y > 0.88 && folio.test(unit.source))
      )
    })
  )
    return []
  return captions.map(({ id }) => id)
}

function legendFrame(paths: ArrayLike<number>[] | undefined, bounds: readonly number[]): boolean {
  if (paths?.length !== 1 || !ArrayBuffer.isView(paths[0])) return false
  const rectangle = nativeRectangularPath(paths)
  if (rectangle) return rectangle.every((value, i) => value === bounds[i])
  const p = Array.from(paths[0])
  // Some plots paint a rounded box with alternating straight edges and corner cubics.
  if (p.length !== 44 || p[0] !== 0 || p[43] !== 4 || !p.every(Number.isFinite)) return false
  const [left, bottom, right, top] = bounds
  const rx = p[1] - left,
    ry = p[12] - bottom
  if (
    rx <= 0 ||
    rx > (right - left) * 0.1 ||
    ry <= 0 ||
    ry > (top - bottom) * 0.1 ||
    p[2] !== bottom
  )
    return false
  const corners = [
    [right - rx, bottom, right, bottom + ry],
    [right, top - ry, right - rx, top],
    [left + rx, top, left, top - ry],
    [left, bottom + ry, left + rx, bottom]
  ]
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.001
  return corners.every(([x0, y0, x1, y1], n) => {
    const [line, x, y, curve, ax, ay, bx, by, ex, ey] = p.slice(3 + 10 * n, 13 + 10 * n)
    const within = (v: number, a: number, b: number): boolean =>
      v >= Math.min(a, b) && v <= Math.max(a, b)
    return (
      line === 1 &&
      curve === 2 &&
      near(x, x0) &&
      near(y, y0) &&
      near(ex, x1) &&
      near(ey, y1) &&
      (n % 2 === 0
        ? near(ay, y0) && near(bx, x1) && within(ax, x0, x1) && within(by, y0, y1)
        : near(ax, x0) && near(by, y1) && within(ay, y0, y1) && within(bx, x0, x1))
    )
  })
}

function pointLegendShape(path: ArrayLike<number> | undefined): PaintedPath['point'] {
  if (!path || path[0] !== 0) return
  if (
    path.length === 12 &&
    path[3] === 1 &&
    path[6] === 0 &&
    path[9] === 1 &&
    path[2] === path[5] &&
    path[7] === path[10] &&
    path[1] !== path[4] &&
    path[8] !== path[11] &&
    Math.abs(path[1] + path[4] - 2 * path[7]) < 0.001 &&
    Math.abs(path[8] + path[11] - 2 * path[2]) < 0.001
  )
    return 'cross'
  if (
    path.length === 60 &&
    path[59] === 4 &&
    path[1] === path[57] &&
    path[2] === path[58] &&
    path[1] === path[29] &&
    path[16] === path[44] &&
    Math.abs(path[15] + path[43] - 2 * path[1]) < 0.001 &&
    Math.abs(path[2] + path[30] - 2 * path[16]) < 0.001 &&
    Array.from({ length: 8 }, (_, i) => path[3 + i * 7]).every((op) => op === 2)
  )
    return 'circle'
}

/** Conservative graphic anchors, not regions authorized for PDF text replacement. */
async function graphicRegions(
  page: PDFPageProxy,
  ops: typeof OPS,
  signal: AbortSignal
): Promise<{
  images: Rect[]
  vectors: Rect[]
  rules?: Rect[]
  maskRules?: Rect[]
  smallMaskRules?: Rect[]
  painted?: PaintedPath[]
  filledRules?: FilledRule[]
}> {
  const images: Rect[] = [],
    maskRules: Rect[] = [],
    smallMaskRules: Rect[] = [],
    vectors: Rect[] = [],
    painted: PaintedPath[] = [],
    filledRules: FilledRule[] = []
  // Older embedders may provide only the text extraction subset of PDFPageProxy.
  if (typeof page.getOperatorList !== 'function') return { images, vectors }
  const viewport = page.getViewport({ scale: 1 })
  const list = await page.getOperatorList()
  signal.throwIfAborted()
  if (list.fnArray.length > 150000) return { images, vectors }
  let matrix: Matrix = viewport.transform
  const stack: {
    matrix: Matrix
    solid: boolean
    direct: boolean
    black: boolean
    opaque: boolean
    solidFill: boolean
  }[] = []
  let solid = true,
    direct = true,
    black = true,
    opaque = true,
    solidFill = true
  const add = (bounds: readonly number[], target: Rect[]): void => {
    if (bounds.length !== 4 || !bounds.every(Number.isFinite)) return
    const [left, bottom, right, top] = bounds
    if (right < left || top < bottom) return
    const points = [
      [left, bottom],
      [left, top],
      [right, bottom],
      [right, top]
    ].map(([x, y]) => [
      matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5]
    ])
    const x = Math.max(0, Math.min(...points.map((p) => p[0])) / viewport.width),
      y = Math.max(0, Math.min(...points.map((p) => p[1])) / viewport.height)
    const rect = {
      x,
      y,
      width: Math.min(1, Math.max(...points.map((p) => p[0])) / viewport.width) - x,
      height: Math.min(1, Math.max(...points.map((p) => p[1])) / viewport.height) - y
    }
    // Ignore rules, tiny glyph outlines and page backgrounds/scanned body pages.
    if (
      rect.width >= 0 &&
      rect.height >= 0 &&
      (target === vectors
        ? Math.max(rect.width, rect.height) >= 0.006
        : rect.width >= 0.006 && rect.height >= 0.006) &&
      rect.width * rect.height <= 0.7
    )
      target.push(rect)
  }
  for (let index = 0; index < list.fnArray.length; index++) {
    if (index % 1000 === 0) signal.throwIfAborted()
    if (images.length + vectors.length > 10000) return { images: [], vectors: [] }
    const op = list.fnArray[index],
      args = list.argsArray[index]
    if (op === ops.save || op === ops.paintFormXObjectBegin || op === ops.beginGroup) {
      if (stack.length >= 128) return { images: [], vectors: [] }
      stack.push({ matrix, solid, direct, black, opaque, solidFill })
      if (op !== ops.save) opaque = false
      if (op !== ops.save) direct = false
      if (op === ops.paintFormXObjectBegin && args[0]) matrix = multiply(matrix, args[0])
    } else if (op === ops.restore || op === ops.paintFormXObjectEnd || op === ops.endGroup) {
      if (!stack.length) return { images: [], vectors: [] }
      const state = stack.pop()!
      matrix = state.matrix
      solid = state.solid
      direct = state.direct
      black = state.black
      opaque = state.opaque
      solidFill = state.solidFill
    } else if (op === ops.transform) matrix = multiply(matrix, args)
    else if (op === ops.setDash) solid = args[0]?.length === 0
    else if (op === ops.setFillRGBColor) {
      black = args?.length === 1 && args[0] === '#000000'
      solidFill = args?.length === 1 && /^#[0-9a-f]{6}$/iu.test(args[0])
    } else if (
      op === ops.setFillColorSpace ||
      op === ops.setFillColor ||
      op === ops.setFillColorN ||
      op === ops.setFillGray ||
      op === ops.setFillCMYKColor ||
      op === ops.setFillTransparent
    ) {
      black = false
      solidFill = false
    } else if (op === ops.clip || op === ops.eoClip) {
      direct = false
      const next = list.argsArray[index + 1]
      const clip = Array.isArray(next?.[1]) ? nativeRectangularPath(next[1]) : undefined
      opaque &&=
        list.fnArray[index + 1] === ops.constructPath &&
        next?.[0] === ops.endPath &&
        clip !== undefined &&
        matrix[1] === 0 &&
        matrix[2] === 0 &&
        Math.abs(matrix[0] * clip[0] + matrix[4]) < 0.05 &&
        Math.abs(matrix[0] * clip[2] + matrix[4] - viewport.width) < 0.05 &&
        Math.abs(Math.min(...[clip[1], clip[3]].map((y) => matrix[3] * y + matrix[5]))) < 0.05 &&
        Math.abs(
          Math.max(...[clip[1], clip[3]].map((y) => matrix[3] * y + matrix[5])) - viewport.height
        ) < 0.05
    } else if (op === ops.setGState) {
      direct = false
      opaque &&=
        Array.isArray(args?.[0]) &&
        args[0].every(
          ([key, value]: [string, unknown]) =>
            (key === 'BM' && value === 'source-over') ||
            ((key === 'ca' || key === 'CA') && value === 1)
        )
    } else if (
      op === ops.paintSolidColorImageMask &&
      direct &&
      solidFill &&
      Array.isArray(args) &&
      args.length === 0
    ) {
      const [width, b, c, height, left, top] = matrix
      if (
        matrix.every(Number.isFinite) &&
        b === 0 &&
        c === 0 &&
        height > 0.05 &&
        height <= 1.25 &&
        left >= 0 &&
        top >= 0 &&
        left + width <= viewport.width &&
        top + height <= viewport.height
      ) {
        const mask = {
          x: left / viewport.width,
          y: top / viewport.height,
          width: width / viewport.width,
          height: height / viewport.height
        }
        // TeX can paint a table rule or a fraction bar as a filled single-bit mask.
        if (black && mask.width >= 0.18 && mask.width <= 0.9) maskRules.push(mask)
        if (opaque && width >= 2 && width <= 24) smallMaskRules.push(mask)
      }
    } else if (op === ops.constructPath && args[2]) {
      const count = vectors.length
      add(args[2], vectors)
      if (
        opaque &&
        solidFill &&
        vectors.length !== count &&
        args[0] === ops.fill &&
        args[1] &&
        matrix[1] === 0 &&
        matrix[2] === 0 &&
        nativeRectangularPath(args[1])?.every((value, i) => value === args[2][i])
      ) {
        const rect = vectors.at(-1)!
        if (
          (rect.width > 0.02 && rect.height > 0 && rect.height <= 0.003) ||
          (rect.height > 0.02 && rect.width > 0 && rect.width <= 0.003)
        )
          filledRules.push({ ...rect, operatorIndex: index })
      }
      if (vectors.length !== count && (args[0] === ops.stroke || args[0] === ops.fillStroke)) {
        const frame = args[0] === ops.fillStroke && legendFrame(args[1], args[2])
        const path = args[1]?.[0]
        const axisAlignedStroke =
          solid &&
          args[0] === ops.stroke &&
          args[1]?.length === 1 &&
          path?.length === 6 &&
          path[0] === 0 &&
          path[3] === 1 &&
          Math.min(path[1], path[4]) === args[2][0] &&
          Math.min(path[2], path[5]) === args[2][1] &&
          Math.max(path[1], path[4]) === args[2][2] &&
          Math.max(path[2], path[5]) === args[2][3] &&
          matrix[1] === 0 &&
          matrix[2] === 0 &&
          (path[1] === path[4]) !== (path[2] === path[5])
        const point =
          !frame && args[0] === ops.fillStroke && args[1]?.length === 1 && pointLegendShape(path)
        const diagramStroke =
          args[0] === ops.stroke &&
          matrix[1] === 0 &&
          matrix[2] === 0 &&
          args[1] &&
          nativeRectangularPath(args[1])?.every((value, i) => value === args[2][i])
            ? 'box'
            : axisAlignedStroke && path[2] === path[5]
              ? 'horizontal'
              : undefined
        painted.push({
          ...(diagramStroke ? { diagramStroke } : {}),
          ...(point ? { point } : {}),
          ...vectors.at(-1)!,
          frame,
          rounded: frame && path?.length === 44,
          ...(direct && axisAlignedStroke ? { straight: true as const } : {})
        })
      }
    } else if (op === ops.paintImageXObjectRepeat && args[3]?.length <= 10000) {
      const base = matrix
      for (let at = 0; at < args[3].length; at += 2) {
        matrix = multiply(base, [args[1], 0, 0, args[2], args[3][at], args[3][at + 1]])
        add([0, 0, 1, 1], images)
      }
      matrix = base
    } else if (
      op === ops.paintImageXObject ||
      op === ops.paintInlineImageXObject ||
      op === ops.paintImageMaskXObject
    )
      add([0, 0, 1, 1], images)
  }
  // Connected vector shapes identify a diagram. Standalone filled text boxes
  // require a nearby figure caption below before any text can be skipped.
  if (vectors.length > 5000) return { images, vectors: [] }
  const grouped: Rect[] = []
  for (const rect of vectors) {
    let merged = rect
    for (let index = 0; index < grouped.length;) {
      if (overlaps(merged, grouped[index])) {
        merged = union(merged, grouped.splice(index, 1)[0])
        index = 0
      } else index++
    }
    if (merged.width * merged.height <= 0.7) grouped.push(merged)
  }
  return {
    images,
    vectors: grouped.filter((rect) => rect.width >= 0.006 && rect.height >= 0.006),
    painted,
    filledRules,
    maskRules,
    smallMaskRules,
    rules: vectors.filter((rect) => rect.width >= 0.18 && rect.height < 0.006)
  }
}

// A single paragraph replacement would detach the labels from their swatches.
async function nativeLegendOwners(
  page: PDFPageProxy,
  units: Source['units'],
  paths: readonly PaintedPath[],
  signal: AbortSignal,
  splitFrequencyLabels?: Map<string, Source['units']>
): Promise<string[]> {
  if (
    page.rotate !== 0 ||
    !paths.some((path) => path.frame) ||
    typeof page.getTextContent !== 'function'
  )
    return []
  const frequency = '[A-Z][A-Z0-9]{1,10} \\d+(?:\\.\\d+)? (?:kHz|MHz|GHz)'
  const thisWork = new RegExp('^' + frequency + ' \\(this work\\)$', 'u')
  const cited = new RegExp(
    '^' + frequency + ' \\(\\p{Lu}[\\p{L}’.-]+ et al\\., (?:19|20)\\d{2}\\)$',
    'u'
  )
  const candidates: {
    ids: string[]
    fragment: PdfTranslationFragment
    frame?: PaintedPath
    frequencyLegend?: Source['units'][number]
  }[] = []
  for (const unit of units) {
    const { id, source, fragments, sourceOnly } = unit
    if (sourceOnly || fragments.length !== 1) continue
    const [fragment] = fragments
    const { items } = fragment
    if (
      splitFrequencyLabels &&
      items.length >= 6 &&
      items.length <= 16 &&
      source === items.map((item) => item.text).join(' ') &&
      thisWork.test(items[0].text) &&
      items.slice(1).every((item) => cited.test(item.text)) &&
      new Set(items.map(({ text }) => text)).size === items.length
    )
      candidates.push({ ids: [id], fragment, frequencyLegend: unit })
    else if (items.length >= 2 && items.length <= 8) candidates.push({ ids: [id], fragment })
  }
  for (const frame of paths.filter((path) => path.rounded)) {
    const members = units.filter(({ fragments }) =>
      fragments.some(({ rect }) => contains(frame, rect))
    )
    if (
      members.length !== 2 ||
      members.some(
        ({ source, sourceOnly, fragments }) =>
          sourceOnly ||
          fragments.length !== 1 ||
          fragments[0].items.length !== 1 ||
          fragments[0].items[0].text !== source ||
          !/^[A-Z]{2,4}[a-z]{0,2}$/u.test(source)
      )
    )
      continue
    const [first, second] = members
      .map(({ fragments }) => fragments[0])
      .sort((a, b) => a.rect.y - b.rect.y)
    candidates.push({
      ids: members.map(({ id }) => id),
      fragment: {
        ...first,
        rect: union(first.rect, second.rect),
        items: [...first.items, ...second.items]
      },
      frame
    })
  }
  if (!candidates.length) return []
  const { items, styles } = await page.getTextContent()
  signal.throwIfAborted()
  const viewport = page.getViewport({ scale: 1 })
  const [sx, skewY, skewX, sy, tx, ty] = viewport.transform
  if (
    !viewport.transform.every(Number.isFinite) ||
    sx <= 0 ||
    sy >= 0 ||
    skewX !== 0 ||
    skewY !== 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return []
  return candidates.flatMap(({ ids, fragment, frame: standaloneFrame, frequencyLegend }) => {
    const paired = fragment.items.length === 2
    const rows = fragment.items.map(({ index, text }) => {
      const row = items[index]
      return row &&
        'str' in row &&
        row.str === text &&
        row.dir === 'ltr' &&
        row.transform.every(Number.isFinite) &&
        row.transform[0] > 0 &&
        row.transform[3] > 0 &&
        row.transform[1] === 0 &&
        row.transform[2] === 0 &&
        row.width > 0 &&
        row.height > 0 &&
        (frequencyLegend || /^[\p{L}][\p{L} ()+-]{2,45}$/u.test(text)) &&
        (paired || !text.includes('+'))
        ? row
        : undefined
    })
    if (!rows.every((row) => row !== undefined)) return []
    const labels = [...Map.groupBy(rows, (row) => row.transform[5]).values()]
    const starts = labels.map(([row]) => row)
    const split = starts.length !== rows.length
    const [first, second] = starts
    if (!first || !second || (frequencyLegend && split)) return []
    // With only two labels, also require their shared multiword series name.
    const name = paired && /^([\p{L}]+ [\p{L}]+) /u.exec(first.str)?.[1]
    const pointPair = paired && (!name || !second.str.startsWith(name + ' '))
    const em = first.height
    const left = (sx * first.transform[4] + tx) / viewport.width
    const pitch = first.transform[5] - second.transform[5]
    const face = labels[0].at(-1)!.fontName
    if (
      pitch < em * 1.25 ||
      pitch > em * 1.8 ||
      (split && labels.length < 3) ||
      labels.some((parts, n) => {
        const row = starts[n]
        const tail = parts[1]
        const rowPitch = n ? starts[n - 1].transform[5] - row.transform[5] : pitch
        const gap = tail ? tail.transform[4] - row.transform[4] - row.width : 0
        return (
          parts.length > 2 ||
          parts.at(-1)!.fontName !== face ||
          parts.some((part) => Math.abs(part.height - em) > em * 0.05) ||
          (tail && (gap < -em * 0.05 || gap > em * 0.65)) ||
          Math.abs(row.transform[4] - first.transform[4]) > em * 0.05 ||
          (split
            ? rowPitch < em * 1.25 || rowPitch > em * 1.8
            : Math.abs(first.transform[5] - row.transform[5] - n * pitch) > em * 0.05)
        )
      })
    )
      return []
    const width = (sx * em) / viewport.width,
      height = (-sy * em) / viewport.height
    const isFramedLegend = paths.some((frame) => {
      if (
        !frame.frame ||
        (standaloneFrame && frame !== standaloneFrame) ||
        (pointPair && (!frame.rounded || first.str === second.str)) ||
        !contains(frame, fragment.rect) ||
        left - frame.x < width * 2 ||
        left - frame.x > width * 4 ||
        frame.x + frame.width - fragment.rect.x - fragment.rect.width > width
      )
        return false
      const matches = (mark: PaintedPath, baseline: number): boolean => {
        const center = (sy * baseline + ty) / viewport.height - height * 0.35
        return (
          mark !== frame &&
          contains(frame, mark) &&
          mark.x + mark.width < left - width * 0.35 &&
          mark.width <= width * 2.2 &&
          mark.height <= height * 1.1 &&
          Math.abs(mark.y + mark.height / 2 - center) < height * 0.25
        )
      }
      if (frequencyLegend && frame.rounded) {
        const claims = new Set(fragment.items.map(({ index }) => index))
        // Very small swatches may be absent from the path inventory. An exact
        // labelled series in a rounded plot key still has independent rows.
        return items.every((item, index) => {
          if (!('str' in item) || !item.str.trim() || claims.has(index)) return true
          const rect = nativeLabelRegion(item, styles[item.fontName], viewport, fragment.pageNumber)
          return rect !== undefined && !overlaps(frame, rect)
        })
      }
      if (!pointPair)
        return starts.every((row) => paths.some((mark) => matches(mark, row.transform[5])))
      const marks = starts.map((row) =>
        paths.filter(
          (mark) =>
            matches(mark, row.transform[5]) &&
            !mark.frame &&
            mark.width > width * 0.45 &&
            mark.width < width * (standaloneFrame ? 1.1 : 1) &&
            Math.abs(mark.width / width - mark.height / height) < 0.05
        )
      )
      // Two unrelated labels need unique, co-sized point markers in the same column.
      const [[top], [bottom]] = marks
      if (!marks.every((row) => row.length === 1)) return false
      // Independent acronyms have distinct swatches with the same marker center.
      if (standaloneFrame) {
        return (
          !!top.point &&
          !!bottom.point &&
          top.point !== bottom.point &&
          Math.abs(top.x + top.width / 2 - bottom.x - bottom.width / 2) < width * 0.05
        )
      }
      return (
        Math.abs(top.x - bottom.x) < width * 0.05 &&
        Math.abs(top.width - bottom.width) < width * 0.05 &&
        Math.abs(top.height - bottom.height) < height * 0.05
      )
    })
    if (!isFramedLegend) return []
    if (!frequencyLegend) return ids
    const parts = starts.map((row, index) => {
      const bounds = nativeLabelRegion(row, styles[row.fontName], viewport, fragment.pageNumber)
      if (!bounds) return
      const { x, y, width, height } = bounds
      const id = frequencyLegend.id + '-legend-' + (index + 1)
      return {
        ...frequencyLegend,
        id,
        source: row.str,
        ...(index ? { sourceOnly: true as const, preserve: 'literal' as const } : {}),
        figure: true as const,
        fragments: [
          { ...fragment, id, rect: { x, y, width, height }, items: [fragment.items[index]] }
        ]
      }
    })
    if (parts.every((part) => part !== undefined))
      splitFrequencyLabels?.set(frequencyLegend.id, parts)
    return []
  })
}

// Some PDF producers paint each border as four filled rectangles, duplicating shared edges.
async function closedFilledTable(
  page: PDFPageProxy,
  number: number,
  units: Source['units'],
  filledRules: readonly FilledRule[],
  signal: AbortSignal
): Promise<{ rect: Rect; owners: string[] } | undefined> {
  if (page.rotate !== 0 || filledRules.length < 32 || filledRules.length > 500) return
  const runs: FilledRule[][] = []
  for (const rule of filledRules) {
    const run = runs.at(-1)
    if (run?.at(-1)?.operatorIndex === rule.operatorIndex - 1) run.push(rule)
    else runs.push([rule])
  }
  const lattices = runs.filter(
    (run) => run.length >= 32 && run.length <= 320 && run.length % 8 === 0
  )
  if (lattices.length !== 1) return
  const [rules] = lattices
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.000001
  const right = (r: Rect): number => r.x + r.width
  const bottom = (r: Rect): number => r.y + r.height
  const cells: Rect[] = []
  for (let i = 0; i < rules.length; i += 4) {
    const [top, lower, left, edge] = rules.slice(i, i + 4)
    if (
      top.height > 0.003 ||
      left.width > 0.003 ||
      top.width < 0.02 ||
      left.height < 0.02 ||
      !near(top.x, lower.x) ||
      !near(top.width, lower.width) ||
      !near(top.height, lower.height) ||
      !near(left.y, edge.y) ||
      !near(left.height, edge.height) ||
      !near(left.width, edge.width) ||
      !near(top.x, left.x) ||
      !near(top.y, left.y) ||
      !near(right(top), right(edge)) ||
      !near(bottom(lower), bottom(left))
    )
      return
    cells.push({ x: top.x, y: top.y, width: top.width, height: left.height })
  }
  const row = (y: number): Rect[] =>
    cells.filter((cell) => near(cell.y, y)).sort((a, b) => a.x - b.x)
  const first = row(Math.min(...cells.map((cell) => cell.y))),
    second = row(Math.max(...cells.map((cell) => cell.y))),
    count = first.length,
    vertical = rules[2].width,
    horizontal = rules[0].height
  if (
    count !== second.length ||
    count * 2 !== cells.length ||
    !near(bottom(first[0]) - horizontal, second[0].y) ||
    first.some(
      (cell, i) =>
        !near(cell.height, first[0].height) ||
        !near(second[i].height, second[0].height) ||
        !near(cell.x, second[i].x) ||
        !near(cell.width, second[i].width) ||
        (i > 0 && !near(right(first[i - 1]) - vertical, cell.x))
    )
  )
    return
  const rect = union(first[0], second.at(-1)!)
  if (
    rect.width < 0.45 ||
    rect.x <= 0.01 ||
    rect.y <= 0.01 ||
    right(rect) >= 0.99 ||
    bottom(rect) >= 0.99
  )
    return
  const viewport = page.getViewport({ scale: 1 }),
    content = await page.getTextContent()
  signal.throwIfAborted()
  const placed = new Map<number, string>()
  const texts = cells.map(() => [] as TextItem[])
  for (const [index, item] of content.items.entries()) {
    if (!('str' in item) || !item.str.trim()) continue
    const bounds = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
    if (!bounds) {
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      if (overlaps(rect, { x: x / viewport.width, y: y / viewport.height, width: 0, height: 0 }, 0))
        return
      continue
    }
    if (!overlaps(rect, bounds, 0)) continue
    const cell = cells.findIndex(
      (r) =>
        bounds.x > r.x && bounds.y > r.y && right(bounds) < right(r) && bottom(bounds) < bottom(r)
    )
    if (cell < 0 || item.transform[1] !== 0 || item.transform[2] !== 0) return
    texts[cell].push(item)
    placed.set(index, item.str)
  }
  const data = second.map((cell) => texts[cells.indexOf(cell)])
  if (
    texts.some((items) => !items.length) ||
    data.some((items) => items.some((item) => item.transform[5] !== data[0][0].transform[5])) ||
    data.filter((items) => /^\d[\d.,]*$/u.test(items.map((item) => item.str).join(''))).length <
      count / 2
  )
    return
  const owners: string[] = []
  for (const unit of units) {
    const all = unit.fragments
    if (!all.some((fragment) => fragment.pageNumber === number && overlaps(rect, fragment.rect, 0)))
      continue
    if (
      all.some(
        (fragment) =>
          fragment.pageNumber !== number ||
          fragment.unclippedRect ||
          !contains(rect, fragment.rect) ||
          fragment.items.some(
            ({ index, text }) => placed.get(index) !== text || !placed.delete(index)
          )
      )
    )
      return
    owners.push(unit.id)
  }
  if (!placed.size) return { rect, owners }
}

// Three-line academic tables often have no vertical rules. A caption plus
// matching top/header/bottom rules proves an atomic region without guessing cells.
type RuledTable = { rect: Rect; header: Rect; top: Rect; separator: Rect; appendix?: true }
function tableRegions(
  units: Source['units'],
  rules: readonly Rect[],
  number: number,
  mode: 'standard' | 'appendix' | 'roman' | 'roman-below' | 'roman-total' = 'standard'
): RuledTable[] {
  const romanCaption = mode === 'roman' || mode === 'roman-below' || mode === 'roman-total'
  const appendix = mode === 'appendix'
  const captions = units
    .filter((unit) =>
      appendix
        ? /^(?:Table|Tab\.) [A-Z]\.[1-9]\d*\. \p{Lu}/u.test(unit.source)
        : romanCaption
          ? /^TABLE [IVXLCDM]+\. \p{Lu}/u.test(unit.source)
          : /^(?:Table|Tab\.)\s*\d/iu.test(unit.source) && isPdfTranslationCaption(unit.source)
    )
    .flatMap((unit) => unit.fragments.filter((f) => f.pageNumber === number))
  const regions: RuledTable[] = []
  for (const caption of captions) {
    for (const above of mode === 'roman-below' ? [true] : romanCaption ? [false] : [true, false]) {
      const nearby = rules
        .filter(
          (rule) =>
            rule.x < caption.rect.x + caption.rect.width &&
            rule.x + rule.width > caption.rect.x &&
            (above
              ? rule.y <= caption.rect.y && caption.rect.y - rule.y < 0.1
              : rule.y >= caption.rect.y + caption.rect.height &&
                rule.y - caption.rect.y - caption.rect.height < 0.1)
        )
        .sort((a, b) => (above ? b.y - a.y : a.y - b.y))
      const edge = nearby[0]
      if (!edge) continue
      const aligned = rules
        .filter(
          (rule) =>
            Math.abs(rule.x - edge.x) < 0.012 &&
            Math.abs(rule.x + rule.width - edge.x - edge.width) < 0.012 &&
            (above
              ? rule.y <= edge.y && edge.y - rule.y < 0.65
              : rule.y >= edge.y && rule.y - edge.y < 0.65)
        )
        .sort((a, b) => a.y - b.y)
      const distinct = aligned.filter(
        (rule, index) => !index || rule.y - aligned[index - 1].y > 0.004
      )
      if (distinct.length < 3 || (mode === 'roman' && distinct.length !== 3)) continue
      if (
        mode === 'roman-total' &&
        (distinct.length !== 4 ||
          aligned.length !== 6 ||
          aligned[1].y - aligned[0].y <= 0.001 ||
          aligned[1].y - aligned[0].y > 0.004 ||
          aligned.at(-1)!.y - aligned.at(-2)!.y <= 0.001 ||
          aligned.at(-1)!.y - aligned.at(-2)!.y > 0.004)
      )
        continue
      if (
        mode === 'roman-below' &&
        (distinct.length < 4 ||
          aligned.length !== distinct.length + 2 ||
          caption.rect.y - edge.y > 0.04 ||
          aligned[1].y - aligned[0].y <= 0.001 ||
          aligned[1].y - aligned[0].y > 0.004 ||
          aligned.at(-1)!.y - aligned.at(-2)!.y <= 0.001 ||
          aligned.at(-1)!.y - aligned.at(-2)!.y > 0.004 ||
          aligned.some((rule) => rule.x !== edge.x || rule.width !== edge.width))
      )
        continue
      // The header separator follows the top rule closely; a distant rule can
      // belong to another table or a footnote and cannot establish the top.
      const tops = distinct
        .slice(0, -2)
        .filter((rule, index) => distinct[index + 1].y - rule.y < 0.06)
      const top = tops[0]
      const bottom = above ? edge : distinct.at(-1)
      if (!top || !bottom || bottom.y - top.y < 0.025) continue
      if (romanCaption && distinct.some((rule) => rule.x !== top.x || rule.width !== top.width))
        continue
      const rect = {
        x: Math.max(0, top.x - 0.002),
        y: Math.max(0, top.y - 0.003),
        width: Math.min(1, top.x + top.width + 0.002) - Math.max(0, top.x - 0.002),
        height: Math.min(1, bottom.y + bottom.height + 0.003) - Math.max(0, top.y - 0.003)
      }
      const ruledInterior = { ...rect, y: top.y, height: bottom.y + bottom.height - top.y }
      if (
        captions.some((other) => overlaps(other === caption ? ruledInterior : rect, other.rect, 0))
      )
        continue
      const inside = units.filter(
        (unit) =>
          !isPdfTranslationCaption(unit.source) &&
          unit.fragments.some(
            (fragment) => fragment.pageNumber === number && contains(rect, fragment.rect)
          )
      )
      if (
        inside.length < 3 ||
        inside.some(
          (unit) => unit.source.length > 800 && unit.fragments.some((f) => f.rect.width > 0.65)
        )
      )
        continue
      const separator = distinct[distinct.indexOf(top) + 1]
      const header = { ...rect, height: separator.y - rect.y }
      if (!regions.some((region) => overlaps(region.rect, rect, 0)))
        regions.push({ rect, header, top, separator, ...(appendix ? { appendix: true } : {}) })
    }
  }
  return regions
}

// A tagged measurement table can split one data row or cell into prose owners.
async function taggedMeasurementTableOwners(
  page: PDFPageProxy,
  number: number,
  units: Source['units'],
  signal: AbortSignal
): Promise<{ owners: string[]; header?: [string, Source['units']] } | undefined> {
  if (page.rotate !== 0 || !units.some((unit) => /^TABLE [IVXLCDM]+\. /u.test(unit.source))) return
  const tree = await page.getStructTree()
  signal.throwIfAborted()
  if (!tree) return
  type Node = StructTreeNode | StructTreeContent
  const tables: StructTreeNode[] = []
  let nodes = 0
  const visit = (node: Node, depth: number): void => {
    if (depth > 32 || ++nodes > 10000) throw new Error('Table structure exceeds its depth limit')
    if (!('role' in node)) return
    if (node.role === 'Table') tables.push(node)
    for (const child of node.children) visit(child, depth + 1)
  }
  visit(tree, 0)
  if (tables.length !== 1) return
  const [table] = tables
  const rows = table.children
  if (
    rows.length < 5 ||
    rows.length > 32 ||
    !rows.every(
      (row, index): row is StructTreeNode =>
        'role' in row &&
        row.role === 'TR' &&
        row.children.length === 5 &&
        row.children.every(
          (cell, column) => 'role' in cell && cell.role === (index && column ? 'TD' : 'TH')
        )
    )
  )
    return
  const [plain, marked] = await Promise.all([
    page.getTextContent(),
    page.getTextContent({ includeMarkedContent: true })
  ])
  signal.throwIfAborted()
  const stack: (string | undefined)[] = [],
    carriers = new Map<string, { index: number; item: TextItem }[]>()
  let index = 0
  for (const item of marked.items) {
    if ('str' in item) {
      const ordinary = plain.items[index]
      if (
        !ordinary ||
        !('str' in ordinary) ||
        ordinary.str !== item.str ||
        ordinary.fontName !== item.fontName ||
        ordinary.width !== item.width ||
        ordinary.height !== item.height ||
        ordinary.transform.some((value, i) => value !== item.transform[i])
      )
        return
      const group = stack.at(-1)
      if (group && item.str.trim()) carriers.get(group)!.push({ index, item })
      index++
    } else if (item.type === 'endMarkedContent') {
      if (!stack.length) return
      stack.pop()
    } else {
      if (item.id) {
        if (carriers.has(item.id)) return
        carriers.set(item.id, [])
      }
      stack.push(item.id)
    }
  }
  if (stack.length || index !== plain.items.length) return
  const claimed = new Set<string>()
  const gather = (node: Node): { index: number; item: TextItem }[] => {
    if ('role' in node) {
      if (!['TH', 'TD', 'P', 'Span', 'Link'].includes(node.role))
        throw new Error('Unexpected tagged table cell role')
      return node.children.flatMap(gather)
    }
    if (node.type === 'object') return []
    const data = carriers.get(node.id)
    if (!data || !data.length || claimed.has(node.id))
      throw new Error('Missing or duplicate marked table content')
    claimed.add(node.id)
    return data
  }
  const cells = rows.map((row) => row.children.map(gather)),
    [header, ...body] = cells
  const text = (cell: (typeof header)[number]): string =>
    cell
      .map(({ item }) => item.str)
      .join('')
      .replace(/\s+/gu, '')
  const measurement = '[+−-]?\\d+(?:\\.\\d+)?dB'
  const values = new RegExp(
    `^(?:${measurement}|${measurement}\\([A-Z]\\)${measurement}\\([A-Z]\\))$`,
    'u'
  )
  const citation = /^\[\d{1,4}\]$/u
  if (
    text(header[4]) !== 'Ref.' ||
    header.some((cell) => cell.length !== 1 || !/^\p{Lu}\p{Ll}{2,24}\.?$/u.test(text(cell))) ||
    body.slice(0, -1).some((row) => !citation.test(text(row[4]))) ||
    body.some(
      ([key, a, b, value]) =>
        !/^[A-Za-z0-9]{2,8}(?:[-–][A-Za-z0-9]{2,8}){1,2}$/u.test(text(key)) ||
        ![a, b].every((cell) => /^[A-Z]{2,5}$/u.test(text(cell))) ||
        !values.test(text(value))
    ) ||
    text(body.at(-1)![4]) !== 'Thiswork'
  )
    return
  const flat = cells.flat(2),
    selected = new Map(body.flat(2).map(({ index, item }) => [index, item.str]))
  if (new Set(flat.map(({ index }) => index)).size !== flat.length) return
  const owners: string[] = []
  for (const unit of units) {
    if (
      !unit.fragments.some(
        (f) => f.pageNumber === number && f.items.some((i) => selected.has(i.index))
      )
    )
      continue
    if (
      unit.fragments.some(
        (f) =>
          f.pageNumber !== number ||
          f.unclippedRect ||
          f.items.some((i) => selected.get(i.index) !== i.text || !selected.delete(i.index))
      )
    )
      return
    if (!unit.sourceOnly) owners.push(unit.id)
  }
  if (selected.size) return
  const heads = header.map(([head]) => head)
  const headOwner = units.find((unit) => {
    if (unit.sourceOnly || unit.preserve || unit.fragments.length !== 1) return false
    const [fragment] = unit.fragments
    return (
      fragment.pageNumber === number &&
      !fragment.unclippedRect &&
      fragment.items.length === heads.length &&
      fragment.items.every(
        ({ index, text }, n) => index === heads[n].index && text === heads[n].item.str
      ) &&
      unit.source === heads.map(({ item }) => item.str).join(' ')
    )
  })
  if (!headOwner) return { owners }
  const viewport = page.getViewport({ scale: 1 }),
    [fragment] = headOwner.fragments,
    claims = new Set(heads.map(({ index }) => index)),
    headerBounds = heads.map(({ item }) =>
      nativeLabelRegion(item, plain.styles[item.fontName], viewport, number)
    )
  if (
    headerBounds.some(
      (bounds, n) =>
        !bounds ||
        !contains(fragment.rect, bounds) ||
        (n && bounds.x <= headerBounds[n - 1]!.x + headerBounds[n - 1]!.width)
    ) ||
    heads.some(({ item }) => item.transform[5] !== heads[0].item.transform[5]) ||
    units.some(
      (unit) =>
        unit !== headOwner &&
        unit.fragments.some(
          (f) => f.pageNumber === number && f.items.some((part) => claims.has(part.index))
        )
    )
  )
    return { owners }
  const split = heads.map(({ item }, n) => {
    const { x, width } = headerBounds[n]!
    return {
      ...headOwner,
      id: `${headOwner.id}-cell-${n + 1}`,
      source: item.str,
      ...(n === heads.length - 1
        ? { sourceOnly: true as const, preserve: 'literal' as const }
        : {}),
      fragments: [{ ...fragment, rect: { ...fragment.rect, x, width }, items: [fragment.items[n]] }]
    }
  })
  return { owners, header: [headOwner.id, split] }
}

// A fused native run cannot be translated without moving content between columns.
async function retainGroupedRomanTable(
  page: PDFPageProxy,
  number: number,
  units: Source['units'],
  rules: readonly Rect[],
  signal: AbortSignal
): Promise<{ rect: Rect; owners: string[] }[]> {
  if (page.rotate !== 0 || rules.length < 6) return []
  const tables = tableRegions(units, rules, number, 'roman-below')
  if (!tables.length) return []
  const content = await page.getTextContent()
  signal.throwIfAborted()
  const viewport = page.getViewport({ scale: 1 })
  return tables.flatMap(({ rect, header, top }) => {
    const native = new Map<number, { item: TextItem; header: boolean }>()
    for (const [index, item] of content.items.entries()) {
      if (!('str' in item) || !item.str.trim()) continue
      const bounds = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
      if (!bounds) {
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
        if (contains(rect, { x: x / viewport.width, y: y / viewport.height, width: 0, height: 0 }))
          return []
        continue
      }
      if (!overlaps(rect, bounds, 0)) continue
      if (
        !contains(rect, bounds) ||
        item.dir !== 'ltr' ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0
      )
        return []
      native.set(index, { item, header: contains(header, bounds) })
    }
    const entries = [...native.values()]
    const heads = entries.filter((entry) => entry.header).map(({ item }) => item)
    if (heads.length !== 3 || native.size < 15) return []
    const [first, second, last] = heads
    const em = first.height
    const left = (item: TextItem): number => item.transform[4]
    const right = (item: TextItem): number => left(item) + item.width
    const sameRail = (item: TextItem, head: TextItem): boolean =>
      Math.abs(left(item) - left(head)) < em * 0.05
    if (
      Math.abs(left(first) - top.x * viewport.width) > em * 0.35 ||
      heads.some(
        (head, i) =>
          head.fontName !== first.fontName ||
          head.height !== em ||
          head.transform[5] !== first.transform[5] ||
          !/\p{L}{2}/u.test(head.str) ||
          (i > 0 && left(head) - right(heads[i - 1]) < em)
      )
    )
      return []
    const body = entries.filter((entry) => !entry.header).map(({ item }) => item)
    if (
      heads.some((head) => body.filter((item) => sameRail(item, head)).length < 3) ||
      !body.some(
        (item) =>
          sameRail(item, second) && right(item) > left(last) + em && /\p{L}{2}/u.test(item.str)
      )
    )
      return []
    const owners = units.filter((unit) =>
      unit.fragments.some(
        (fragment) => fragment.pageNumber === number && overlaps(rect, fragment.rect, 0)
      )
    )
    if (
      owners.some(({ fragments }) =>
        fragments.some(
          ({ pageNumber, rect: bounds, unclippedRect, items }) =>
            pageNumber !== number ||
            unclippedRect ||
            !contains(rect, bounds) ||
            items.some(
              ({ index, text }) => native.get(index)?.item.str !== text || !native.delete(index)
            )
        )
      ) ||
      native.size
    )
      return []
    return [{ rect, owners: owners.map(({ id }) => id) }]
  })
}

// A single translation cannot keep native fields on opposite sides of a table rule.
function crossRuleStencilTableOwners(
  units: Source['units'],
  tables: readonly RuledTable[],
  number: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): string[] {
  return tables.flatMap(({ rect, separator }) => {
    const selected = units.filter((unit) =>
      unit.fragments.some((f) => f.pageNumber === number && overlaps(rect, f.rect, 0))
    )
    if (
      selected.length < 4 ||
      selected.some((unit) =>
        unit.fragments.some(
          (f) => f.pageNumber !== number || f.unclippedRect || !contains(rect, f.rect)
        )
      )
    )
      return []
    const native = new Map<number, { item: TextItem; baseline: number }>()
    for (const [index, item] of content.items.entries()) {
      if (!('str' in item) || !item.str.trim()) continue
      const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      const point = { x: vx / viewport.width, y: vy / viewport.height, width: 0, height: 0 }
      const bounds = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
      if (!overlaps(rect, bounds ?? point, 0)) continue
      if (
        !bounds ||
        !contains(rect, bounds) ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0 ||
        item.dir !== 'ltr'
      )
        return []
      native.set(index, { item, baseline: point.y })
    }
    const remaining = new Map(native)
    const ownsAll = selected.every(({ fragments }) =>
      fragments.every(
        ({ items }) =>
          items.length > 0 &&
          items.every(
            ({ index, text }) => remaining.get(index)?.item.str === text && remaining.delete(index)
          )
      )
    )
    if (!ownsAll || remaining.size > 0) return []
    const crosses = selected.some(({ sourceOnly, preserve, fragments }) => {
      if (sourceOnly || preserve || fragments.length !== 2) return false
      const [header, data] = fragments.map(({ items }) =>
        items.map(({ index }) => native.get(index)!)
      )
      if (header.length < 2 || data.length < 3) return false
      const [left, ...fields] = data
      const h = left.item.height
      return (
        header.every(({ baseline }) => baseline < separator.y) &&
        data.every(
          ({ baseline }) => baseline > separator.y + separator.height && baseline === left.baseline
        ) &&
        fields.every(({ item }, n) => {
          const prior = data[n].item
          return (
            item.fontName === left.item.fontName &&
            item.height === h &&
            item.transform[4] - prior.transform[4] - prior.width > h
          )
        }) &&
        /^\p{L}{2,}$/u.test(left.item.str) &&
        /^\d+(?:\s*,\s*\d+)*$/u.test(fields.at(-1)!.item.str)
      )
    })
    return crosses ? selected.map(({ id }) => id) : []
  })
}

// The same native dividers must bound the type in the header and reappear below its separator.
function nativeHeaderColumns(
  { top, separator }: RuledTable,
  painted: readonly PaintedPath[]
): Rect[] | undefined {
  if (
    ![top, separator].every((rule) =>
      painted.some(
        ({ straight, x, y, width, height }) =>
          straight && height === 0 && x === rule.x && y === rule.y && width === rule.width
      )
    )
  )
    return
  const right = top.x + top.width,
    pitch = separator.y - top.y,
    tolerance = pitch * 0.02
  if (
    Math.abs(separator.x - top.x) > tolerance ||
    Math.abs(separator.x + separator.width - right) > tolerance
  )
    return
  const verticals = painted.filter(
    (p) => p.straight && p.width === 0 && p.x >= top.x - tolerance && p.x <= right + tolerance
  )
  const header = verticals
    .filter((p) => p.y > top.y && p.y + p.height < separator.y && p.height > pitch / 2)
    .sort((a, b) => a.x - b.x)
  if (
    header.length < 4 ||
    Math.abs(header[0].x - top.x) > tolerance ||
    Math.abs(header.at(-1)!.x - right) > tolerance ||
    header.some(
      (p, i) =>
        (i > 0 && p.x - header[i - 1].x <= tolerance) ||
        Math.abs(p.y - header[0].y) > tolerance ||
        Math.abs(p.height - header[0].height) > tolerance
    )
  )
    return
  const below = verticals.filter((p) => Math.abs(p.y - header[0].y - pitch) <= tolerance)
  return below.length === header.length &&
    header.every(
      (p) =>
        below.filter(
          (peer) =>
            Math.abs(peer.x - p.x) <= tolerance && Math.abs(peer.height - p.height) <= tolerance
        ).length === 1
    )
    ? header
    : undefined
}

type NativeHeaderRun = { index: number; item: TextItem; rect: Rect }

function splitNativeTableHeader(
  unit: Source['units'][number],
  table: RuledTable,
  dividers: readonly Rect[],
  runs: readonly NativeHeaderRun[],
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  ownerCounts: ReadonlyMap<number, number>
): Source['units'] | undefined {
  const [fragment] = unit.fragments
  if (
    fragment.unclippedRect ||
    unit.preserve ||
    fragment.rect.y < table.top.y ||
    fragment.rect.y + fragment.rect.height > table.separator.y ||
    runs.some(({ index, item, rect }, i) => {
      const previous = runs[i - 1]
      return (
        ownerCounts.get(index) !== 1 ||
        item.transform[5] !== runs[0].item.transform[5] ||
        (previous &&
          (previous.item.hasEOL ||
            index <= previous.index ||
            rect.x <= previous.rect.x ||
            rect.x + rect.width < previous.rect.x + previous.rect.width))
      )
    })
  )
    return

  const cells: Source['units'][number][] = []
  let cursor = 0
  for (let i = 1; i < dividers.length; i++) {
    const left = dividers[i - 1],
      right = dividers[i]
    const start = cursor
    while (cursor < runs.length && runs[cursor].rect.x < right.x) cursor++
    const cell = runs.slice(start, cursor)
    const first = cell[0],
      last = cell.at(-1)
    if (
      !first ||
      !last ||
      first.rect.x <= left.x ||
      last.rect.x + last.rect.width >= right.x ||
      cell.some(({ rect }) => rect.y <= right.y || rect.y + rect.height >= right.y + right.height)
    )
      return

    const prior = runs[start - 1],
      gap = content.items[first.index - 1]
    if (prior && (first.index !== prior.index + 2 || !gap || !('str' in gap) || gap.str !== ' '))
      return
    let label = '',
      next = 0
    for (let index = first.index; index <= last.index; index++) {
      const item = content.items[index]
      if (!item || !('str' in item) || (item.str !== ' ' && cell[next++]?.index !== index)) return
      label += item.str
    }
    if (next !== cell.length || !/\p{L}{2}/u.test(label)) return
    cells.push({
      ...unit,
      id: `${unit.id}-cell-${i}`,
      source: label,
      fragments: [
        {
          pageNumber: fragment.pageNumber,
          rect: {
            ...fragment.rect,
            x: first.rect.x,
            width: last.rect.x + last.rect.width - first.rect.x
          },
          items: cell.map(({ index, item }) => ({ index, text: item.str }))
        }
      ]
    })
  }
  if (cursor === runs.length && cells.map(({ source }) => source).join(' ') === unit.source)
    return cells
}

// A ruled four-column table can have wrapped prose that crosses a physical row boundary.
function splitCrossRowTableProse(
  units: Source['units'],
  table: RuledTable,
  number: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): Map<string, Source['units']> {
  const split = new Map<string, Source['units']>()
  const native = content.items.flatMap((item, index) => {
    if (!('str' in item) || !item.str.trim()) return []
    const [scale, skewY, skewX, height, x, y] = item.transform
    if (scale <= 0 || height <= 0 || skewX !== 0 || skewY !== 0) return []
    const rect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
    return rect && contains(table.rect, rect) ? [{ item, index, rect, x, y }] : []
  })
  const heads = native.filter(({ rect }) => contains(table.header, rect)).sort((a, b) => a.x - b.x)
  const first = heads[0]
  if (heads.length !== 4 || Math.abs(first.rect.x - table.top.x) > 0.001) return split
  const em = first.item.height
  const aligned = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.05
  if (
    heads.some(({ item, x, y }, i) => {
      const previous = heads[i - 1]
      return (
        item.fontName !== first.item.fontName ||
        item.height !== em ||
        !aligned(y, first.y) ||
        !/\p{L}{2}/u.test(item.str) ||
        (previous && x - previous.x - previous.item.width <= em)
      )
    })
  )
    return split

  const body = native.filter(({ rect }) => rect.y >= table.separator.y)
  const starts = body.filter(
    ({ item, x }) =>
      item.fontName === first.item.fontName &&
      item.height === em &&
      aligned(x, first.x) &&
      /^[A-Z]\d{1,2} \p{Lu}/u.test(item.str)
  )
  const peers = heads.slice(1)
  if (
    starts.length < 3 ||
    starts.some(
      ({ item, y }, i) =>
        !item.str.startsWith(starts[0].item.str[0] + (i + 1) + ' ') ||
        (i > 0 && starts[i - 1].y - y <= em * 2) ||
        peers.some(
          (head) =>
            body.filter(
              (run) => run.item.height === em && aligned(run.x, head.x) && aligned(run.y, y)
            ).length !== 1
        )
    )
  )
    return split
  const claims = new Map<number, number>()
  for (const { fragments } of units)
    for (const { pageNumber, items } of fragments)
      if (pageNumber === number)
        for (const { index } of items) claims.set(index, (claims.get(index) ?? 0) + 1)
  const byIndex = new Map(body.map((run) => [run.index, run]))
  const compact = (text: string): string => text.replace(/\s+/gu, '')
  const matches = (parts: Source['units'][number]['fragments'], text: string): boolean =>
    compact(parts.flatMap(({ items }) => items.map(({ text }) => text)).join('')) === compact(text)
  for (const unit of units) {
    if (
      unit.sourceOnly ||
      unit.figure ||
      unit.preserve ||
      unit.referenceBoundary ||
      unit.fragments.length < 2
    )
      continue
    const fragments = unit.fragments
    const column = heads.findLastIndex(({ rect }) => fragments[0].rect.x >= rect.x - 0.001)
    if (column < 0) continue
    const left = heads[column].rect.x - 0.001
    const right = heads[column + 1]?.rect.x ?? table.top.x + table.top.width
    if (
      fragments.some(
        ({ pageNumber, unclippedRect, rect, items }, i) =>
          pageNumber !== number ||
          unclippedRect ||
          rect.x < left ||
          rect.x + rect.width > right ||
          (i > 0 && rect.y <= fragments[i - 1].rect.y) ||
          !items.length ||
          items.some(({ index, text }) => {
            const run = byIndex.get(index)
            return claims.get(index) !== 1 || run?.item.str !== text || !contains(rect, run.rect)
          })
      )
    )
      continue
    const boundaries: number[] = []
    for (let i = 1; i < fragments.length; i++) {
      const start = byIndex.get(fragments[i].items[0].index)!
      const previous = byIndex.get(fragments[i - 1].items[0].index)!
      if (
        aligned(start.x, heads[column].x) &&
        previous.y - start.y > em * 1.5 &&
        starts.some(({ y }) => aligned(y, start.y))
      )
        boundaries.push(i)
    }
    if (boundaries.length !== 1) continue
    const [at] = boundaries
    const boundary = byIndex.get(fragments[at].items[0].index)!
    const row = starts.findIndex(({ y }) => aligned(y, boundary.y))
    const previous = starts[row - 1]
    if (!previous) continue
    const inBand = (parts: typeof fragments, top: number, bottom: number): boolean =>
      parts.every(({ items }) =>
        items.every(({ index }) => {
          const { y } = byIndex.get(index)!
          return y <= top + em * 0.05 && y > bottom + em * 0.05
        })
      )
    const beforeFragments = fragments.slice(0, at)
    const afterFragments = fragments.slice(at)
    if (
      !inBand(beforeFragments, previous.y, starts[row].y) ||
      !inBand(afterFragments, starts[row].y, starts[row + 1]?.y ?? -Infinity)
    )
      continue
    const lead = fragments[at].items[0].text
    const seam = unit.source.indexOf(' ' + lead) + 1
    if (!seam || unit.source.indexOf(' ' + lead, seam) !== -1) continue
    const before = unit.source.slice(0, seam - 1)
    const after = unit.source.slice(seam)
    if (
      !/[.!?]$/u.test(before) ||
      !matches(beforeFragments, before) ||
      !matches(afterFragments, after)
    )
      continue
    split.set(unit.id, [
      { ...unit, source: before, fragments: beforeFragments },
      { ...unit, id: unit.id + '-table-row', source: after, fragments: afterFragments }
    ])
  }
  return split
}

// The final priced item and the separate total can share one prose owner.
function splitRomanCostTotal(
  units: Source['units'],
  table: RuledTable,
  number: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): Map<string, Source['units']> {
  const split = new Map<string, Source['units']>()
  const runs = content.items.flatMap((item, index) => {
    if (!('str' in item) || !item.str.trim()) return []
    const rect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
    if (
      !rect ||
      (!contains(table.rect, rect) &&
        (item.str !== ')' ||
          !contains(
            { ...table.header, width: table.header.width + item.height / viewport.width },
            rect
          )))
    )
      return []

    const [a, b, c, d, x, y] = item.transform
    return a > 0 && b === 0 && c === 0 && d > 0 && item.dir === 'ltr'
      ? [{ item, index, rect, x, y }]
      : []
  })
  const heads = runs.filter(({ rect }) => rect.y + rect.height <= table.separator.y + 0.001)
  const first = heads[0]
  if (
    heads.length !== 4 ||
    first.item.str !== 'Component' ||
    heads
      .slice(1)
      .map(({ item }) => item.str)
      .join('') !== 'Approx. cost (US$)' ||
    heads.some(({ y }) => Math.abs(y - first.y) > first.item.height * 0.15)
  )
    return split
  const em = first.item.height
  const close = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.08
  const rows: (typeof runs)[] = []
  for (const run of runs.slice(4)) {
    const row = rows.at(-1)
    if (row && close(run.y, row[0].y)) row.push(run)
    else rows.push([run])
  }
  const last = rows.at(-1)
  const prices = rows.slice(0, -1)
  if (
    !last ||
    last.length !== 3 ||
    prices.length < 5 ||
    prices.some(
      ([label, price], at) =>
        prices[at].length !== 2 ||
        !close(label.x, first.x) ||
        label.item.fontName !== first.item.fontName ||
        price.item.fontName !== first.item.fontName ||
        !/^\d+(?:\.\d+)?$/u.test(price.item.str) ||
        !close(price.x + price.item.width / 2, prices[0][1].x + prices[0][1].item.width / 2) ||
        (at > 0 && !close(prices[at - 1][0].y - label.y, prices[0][0].y - prices[1][0].y))
    )
  )
    return split
  const [sum, sign, total] = last
  const [label, price] = prices.at(-1)!
  if (
    !/^Total \(excluding the [a-z ]+\)$/u.test(sum.item.str) ||
    !close(sum.x, first.x) ||
    sum.item.fontName !== first.item.fontName ||
    sign.item.str !== '≈' ||
    !/^\d{1,5}$/u.test(total.item.str) ||
    total.item.fontName !== price.item.fontName ||
    !close((sign.x + total.x + total.item.width) / 2, price.x + price.item.width / 2) ||
    sum.rect.x + sum.rect.width >= sign.rect.x ||
    !close(label.y - sum.y, prices[0][0].y - prices[1][0].y)
  )
    return split
  const exactly = (
    items: Source['units'][number]['fragments'][number]['items'],
    expected: typeof runs
  ): boolean =>
    items.length === expected.length &&
    items.every(
      ({ index, text }, at) => index === expected[at].index && text === expected[at].item.str
    )
  const owner = units.filter((unit) =>
    unit.fragments.some(
      ({ pageNumber, items }) =>
        pageNumber === number &&
        items.some(({ index }) => [label, sum, sign, total].some((run) => run.index === index))
    )
  )
  const [unit] = owner
  if (
    owner.length !== 1 ||
    unit.sourceOnly ||
    unit.figure ||
    unit.preserve ||
    unit.referenceBoundary ||
    unit.fragments.length !== 2 ||
    unit.fragments.some(
      (f) => f.pageNumber !== number || f.unclippedRect || !contains(table.rect, f.rect)
    ) ||
    !exactly(unit.fragments[0].items, [label]) ||
    !exactly(unit.fragments[1].items, last) ||
    unit.source !== [label, ...last].map(({ item }) => item.str).join(' ') ||
    !units.some(
      (u) =>
        u.sourceOnly &&
        u.preserve === 'literal' &&
        u.fragments.length === 1 &&
        u.fragments[0].pageNumber === number &&
        exactly(u.fragments[0].items, [price])
    )
  )
    return split
  const fragment = (selected: typeof runs): typeof unit.fragments => [
    {
      pageNumber: number,
      rect: selected
        .map(({ rect: { x, y, width, height } }) => ({ x, y, width, height }))
        .reduce(union),
      items: selected.map(({ index, item }) => ({ index, text: item.str }))
    }
  ]
  split.set(unit.id, [
    { ...unit, source: label.item.str, fragments: unit.fragments.slice(0, 1) },
    { ...unit, id: unit.id + '-total-label', source: sum.item.str, fragments: fragment([sum]) },
    {
      ...unit,
      id: unit.id + '-total-value',
      source: sign.item.str + ' ' + total.item.str,
      sourceOnly: true,
      preserve: 'literal',
      fragments: fragment([sign, total])
    }
  ])
  return split
}

// One translation cannot keep separately aligned native table labels in their columns.
async function coalescedTableHeaderOwners(
  page: PDFPageProxy,
  number: number,
  units: Source['units'],
  tables: readonly RuledTable[],
  painted: readonly PaintedPath[],
  signal: AbortSignal
): Promise<{ retained: string[]; split: Map<string, Source['units']> }> {
  const retained: string[] = [],
    split = new Map<string, Source['units']>(),
    result = { retained, split }
  const candidates = units.filter((unit) => {
    const [fragment] = unit.fragments
    return (
      !unit.sourceOnly &&
      unit.fragments.length === 1 &&
      fragment.pageNumber === number &&
      fragment.items.length >= 3 &&
      tables.some(
        ({ header, appendix }) =>
          contains(header, fragment.rect) && (!appendix || unit.source === 'Parameter Units Prior')
      )
    )
  })
  if (!candidates.length || page.rotate !== 0) return result
  const columns = tables.map((table) => ({ table, dividers: nativeHeaderColumns(table, painted) }))
  const ownerCounts = new Map<number, number>()
  if (columns.some(({ dividers, table }) => dividers || table.appendix))
    for (const unit of units)
      for (const fragment of unit.fragments)
        if (fragment.pageNumber === number)
          for (const { index } of fragment.items)
            ownerCounts.set(index, (ownerCounts.get(index) ?? 0) + 1)
  const content = await page.getTextContent()
  signal.throwIfAborted()
  const viewport = page.getViewport({ scale: 1 })
  for (const unit of candidates) {
    const {
      id,
      fragments: [fragment]
    } = unit
    const runs = fragment.items.map(({ index, text }) => {
      const item = content.items[index]
      if (
        !item ||
        !('str' in item) ||
        item.str !== text ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0
      )
        return undefined
      const rect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
      return rect && { index, item, rect }
    })
    if (!runs.every((run) => run !== undefined)) continue
    const matching = columns.filter(
      ({ table }) =>
        (!table.appendix || unit.source === 'Parameter Units Prior') &&
        runs.every(({ rect }) => contains(table.header, rect))
    )
    if (!matching.length) continue
    const [{ table, dividers }] = matching
    if (matching.length === 1 && dividers) {
      const cells = splitNativeTableHeader(unit, table, dividers, runs, content, ownerCounts)
      if (cells) {
        split.set(id, cells)
        continue
      }
    }
    const separated = runs.slice(1).every(({ index, item }, i) => {
      const previous = runs[i]
      const spaces = content.items.slice(previous.index + 1, index)
      const gap = item.transform[4] - previous.item.transform[4] - previous.item.width
      return (
        index === previous.index + 2 &&
        spaces.length === 1 &&
        'str' in spaces[0] &&
        spaces[0].str === ' ' &&
        !previous.item.hasEOL &&
        item.fontName === previous.item.fontName &&
        item.transform[5] === previous.item.transform[5] &&
        gap > item.height &&
        gap > previous.item.height
      )
    })
    if (table.appendix) {
      if (!separated || matching.length !== 1 || runs.length !== 3) continue
      // For this parameter table the three ruled, widely spaced one-word labels
      // are independent cells even without painted vertical dividers.
      const { top, separator } = table
      const edges = [
        top.x,
        ...runs.slice(1).map(({ rect }, i) => (rect.x + runs[i].rect.x + runs[i].rect.width) / 2),
        top.x + top.width
      ].map((x) => ({ x, y: top.y, width: 0, height: separator.y - top.y }))
      const cells = splitNativeTableHeader(unit, table, edges, runs, content, ownerCounts)
      if (cells) split.set(id, cells)
      continue
    }
    if (separated) {
      retained.push(id)
      if (matching.length === 1)
        retained.push(...coalescedRuledBodyOwners(units, table, number, content, viewport))
    }
  }
  return result
}

// A translation of several table rows cannot be fitted as a single column of prose.
function coalescedRuledBodyOwners(
  units: Source['units'],
  table: RuledTable,
  number: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): string[] {
  const header = content.items
    .flatMap((item) => {
      if (!('str' in item) || !item.str.trim()) return []
      const rect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
      return rect && contains(table.header, rect) ? [{ item, rect }] : []
    })
    .sort((a, b) => a.rect.x - b.rect.x)
  if (header.length < 4) return []
  const { item: left, rect: leftRect } = header[0]
  const em = left.height
  const ends = (item: TextItem): number => item.transform[4] + item.width
  if (
    Math.abs(leftRect.x - table.top.x) > 0.002 ||
    header.some(
      ({ item }, i) =>
        item.fontName !== left.fontName ||
        item.height !== em ||
        item.transform[5] !== left.transform[5] ||
        (i > 0 && item.transform[4] - ends(header[i - 1].item) <= em)
    )
  )
    return []
  const claimed = new Map<number, number>()
  for (const { fragments } of units)
    for (const fragment of fragments)
      if (fragment.pageNumber === number)
        for (const { index } of fragment.items) claimed.set(index, (claimed.get(index) ?? 0) + 1)
  const body = units.flatMap((unit) => {
    if (
      !unit.fragments.every(
        ({ pageNumber, rect, unclippedRect }) =>
          pageNumber === number &&
          !unclippedRect &&
          contains(table.rect, rect) &&
          rect.y >= table.separator.y
      )
    )
      return []
    const runs = unit.fragments
      .flatMap(({ items }) => items)
      .map(({ index, text }) => {
        const item = content.items[index]
        return claimed.get(index) === 1 &&
          item &&
          'str' in item &&
          item.str === text &&
          item.dir === 'ltr' &&
          item.transform[0] > 0 &&
          item.transform[1] === 0 &&
          item.transform[2] === 0 &&
          item.transform[3] > 0
          ? item
          : undefined
      })
    return runs.length && runs.every((item) => item !== undefined) ? [{ unit, runs }] : []
  })
  // Existing numeric-only owners in the second column witness each data row.
  const numericX = header[1].item.transform[4]
  const rows = [
    ...new Set(
      body.flatMap(({ unit, runs }) =>
        unit.sourceOnly && /^[0-9.,{} +−-]+$/u.test(unit.source)
          ? runs
              .filter(
                (item) =>
                  Math.abs(item.height - em) < em * 0.01 &&
                  Math.abs(item.transform[4] - numericX) < em * 0.06
              )
              .map((item) => item.transform[5])
          : []
      )
    )
  ].sort((a, b) => b - a)
  if (rows.length < 3) return []
  const pitch = rows[0] - rows[1]
  if (
    pitch < em ||
    pitch >= em * 1.5 ||
    rows.slice(1).some((row, i) => Math.abs(rows[i] - row - pitch) > em * 0.03)
  )
    return []
  return body.flatMap(({ unit, runs }) => {
    if (unit.sourceOnly || unit.preserve) return []
    const column = header.findLastIndex(({ item }) =>
      runs.every((run) => run.transform[4] >= item.transform[4] - em * 0.06)
    )
    if (column < 0) return []
    const x = header[column].item.transform[4],
      right =
        header[column + 1]?.item.transform[4] ?? (table.top.x + table.top.width) * viewport.width
    if (
      runs.some(
        (item) =>
          ends(item) > right + (column === header.length - 1 ? em * 0.01 : 0) ||
          !rows.some((row) => Math.abs(item.transform[5] - row) < em * 0.4)
      )
    )
      return []
    const starts = rows.filter((row) =>
      runs.some(
        (item) =>
          Math.abs(item.height - em) < em * 0.01 &&
          Math.abs(item.transform[4] - x) < em * 0.06 &&
          Math.abs(item.transform[5] - row) < em * 0.03
      )
    )
    return starts.length >= 2 ? [unit.id] : []
  })
}

// A full rail of original check/dash cells witnesses the baselines of a merged text column.
function splitMarkedTableTextColumn(
  units: Source['units'],
  table: RuledTable,
  number: number,
  header: readonly NativeHeaderRun[],
  body: readonly NativeHeaderRun[]
): Map<string, Source['units']> {
  const result = new Map<string, Source['units']>()
  if (header.length < 6 || header.length > 10) return result
  const rows = [...Map.groupBy(body, ({ item }) => item.transform[5]).values()]
    .map((row) => row.sort((a, b) => a.rect.x - b.rect.x))
    .sort((a, b) => b[0].item.transform[5] - a[0].item.transform[5])
  if (rows.length < 4 || rows.length > 24 || rows.some((row) => row.length !== 6)) return result
  const [first, second] = rows
  const em = first[1].item.height
  const baseline = ({ item }: NativeHeaderRun): number => item.transform[5]
  const right = ({ rect }: NativeHeaderRun): number => rect.x + rect.width
  const center = (run: NativeHeaderRun): number => (run.rect.x + right(run)) / 2
  const [stub, label] = first
  const pitch = baseline(stub) - baseline(second[0])
  const headerBaseline = Math.min(...header.map(baseline))
  const heads = header
    .filter((run) => baseline(run) === headerBaseline)
    .sort((a, b) => a.rect.x - b.rect.x)
  if (
    heads.length !== 6 ||
    Math.abs(stub.rect.x - table.top.x) > 0.001 ||
    heads.some(
      (head, i) =>
        head.item.fontName !== label.item.fontName ||
        head.item.height !== em ||
        !/\p{L}{2}/u.test(head.item.str) ||
        (i > 0 && head.rect.x <= right(heads[i - 1])) ||
        (i < 2
          ? Math.abs(head.rect.x - first[i].rect.x) > 0.001
          : Math.abs(center(head) - center(first[i])) > first[i].rect.width * 0.15)
    ) ||
    pitch < em * 1.2 ||
    pitch > em * 1.4 ||
    rows.some(
      (row, i) =>
        Math.abs(baseline(stub) - baseline(row[0]) - i * pitch) > em * 0.03 ||
        row.some(
          (cell, j) =>
            cell.item.height !== em ||
            (j > 0 && cell.rect.x <= right(row[j - 1])) ||
            (j < 2
              ? Math.abs(cell.rect.x - first[j].rect.x) > 0.001 || !/\p{L}{2}/u.test(cell.item.str)
              : !/^[✓–]$/u.test(cell.item.str) ||
                Math.abs(center(cell) - center(first[j])) > first[j].rect.width * 0.15)
        )
    )
  )
    return result

  const owners = new Map<number, { unit: Source['units'][number]; text: string }>()
  for (const unit of units)
    for (const fragment of unit.fragments)
      if (fragment.pageNumber === number)
        for (const { index, text } of fragment.items) {
          if (owners.has(index)) return result
          owners.set(index, { unit, text })
        }
  if (body.some(({ index, item }) => owners.get(index)?.text !== item.str)) return result
  if (
    rows.some((row) =>
      row.slice(2).some(({ index, item }) => {
        const { unit } = owners.get(index)!
        return (
          !unit.sourceOnly ||
          unit.source !== item.str ||
          unit.fragments.length !== 1 ||
          unit.fragments[0].items.length !== 1 ||
          unit.fragments[0].unclippedRect
        )
      })
    )
  )
    return result

  const cells = rows.map((row) => row[1])
  const { unit } = owners.get(label.index)!
  const [fragment] = unit.fragments
  if (
    unit.sourceOnly ||
    unit.preserve ||
    unit.figure ||
    unit.referenceBoundary ||
    unit.fragments.length !== 1 ||
    fragment.unclippedRect ||
    fragment.pageNumber !== number ||
    !contains(table.rect, fragment.rect) ||
    fragment.items.length !== cells.length ||
    cells.some(
      (cell, i) =>
        cell.index !== fragment.items[i].index ||
        cell.item.fontName !== label.item.fontName ||
        !contains(fragment.rect, cell.rect)
    ) ||
    fragment.items.map(({ text }) => text).join(' ') !== unit.source
  )
    return result

  result.set(
    unit.id,
    cells.map(({ item, rect: { x, y, width, height } }, i) => ({
      ...unit,
      id: `${unit.id}-cell-${i + 1}`,
      source: item.str,
      fragments: [{ ...fragment, rect: { x, y, width, height }, items: [fragment.items[i]] }]
    }))
  )
  return result
}

// A ruled quantity/value table can put an approximate value in its translated label owner.
function splitApproximateTableValues(
  units: Source['units'],
  table: RuledTable,
  number: number,
  [quantity, value]: readonly NativeHeaderRun[],
  body: readonly NativeHeaderRun[]
): Map<string, Source['units']> {
  const result = new Map<string, Source['units']>()
  if (quantity.item.str !== 'Quantity' || value.item.str !== 'Value') return result
  const em = quantity.rect.height
  const sameRail = (x: number, y: number): boolean => Math.abs(x - y) < em * 0.045
  const baseline = (run: NativeHeaderRun): number => run.item.transform[5]
  if (
    !em ||
    quantity.item.fontName !== value.item.fontName ||
    baseline(quantity) !== baseline(value) ||
    value.rect.x - quantity.rect.x < em * 7 ||
    body.filter((run) => sameRail(run.rect.x, value.rect.x) && /^\d+$/u.test(run.item.str)).length <
      5
  )
    return result
  const native = new Map(body.map((run) => [run.index, run]))
  const seen = new Set<number>()
  const overlaps = new Set<number>()
  for (const unit of units)
    for (const fragment of unit.fragments)
      if (fragment.pageNumber === number)
        for (const { index } of fragment.items) {
          if (seen.has(index)) overlaps.add(index)
          seen.add(index)
        }
  for (const unit of units) {
    const [fragment] = unit.fragments
    if (
      unit.sourceOnly ||
      unit.preserve ||
      unit.referenceBoundary ||
      unit.fragments.length !== 1 ||
      fragment.pageNumber !== number ||
      fragment.unclippedRect ||
      !contains(table.rect, fragment.rect)
    )
      continue
    const [first, ...parts] = fragment.items
    const label = native.get(first?.index)
    const measures = parts.map(({ index }) => native.get(index))
    const [start] = measures
    if (
      !label ||
      !start ||
      start.item.str !== '≃' ||
      label.item.fontName !== quantity.item.fontName ||
      !sameRail(label.rect.x, quantity.rect.x) ||
      !sameRail(start.rect.x, value.rect.x) ||
      label.rect.x + label.rect.width >= start.rect.x - em * 0.4 ||
      !unit.source.startsWith(label.item.str + ' ') ||
      !/^≃ \d+(?:[–-]\d+|\.\d+ [a-z]{2,8})$/u.test(unit.source.slice(label.item.str.length + 1)) ||
      fragment.items.some(({ index, text }) => {
        const run = native.get(index)
        return (
          !run || overlaps.has(index) || run.item.str !== text || baseline(run) !== baseline(label)
        )
      }) ||
      measures.some((run) => run!.rect.x < start.rect.x)
    )
      continue
    const rect = ({ x, y, width, height }: Rect): Rect => ({ x, y, width, height })
    result.set(unit.id, [
      {
        ...unit,
        id: unit.id + '-cell-1',
        source: label.item.str,
        fragments: [{ pageNumber: number, rect: rect(label.rect), items: [first] }]
      },
      {
        ...unit,
        id: unit.id + '-cell-2',
        source: unit.source.slice(label.item.str.length + 1),
        sourceOnly: true,
        preserve: 'literal',
        fragments: [
          {
            pageNumber: number,
            rect: measures.map((run) => rect(run!.rect)).reduce(union),
            items: parts
          }
        ]
      }
    ])
  }
  return result
}

// Columns in a ruled parameter table can share a prose owner even though their
// native rows, labels and measurement fields are independently aligned.
function splitRuledParameterTableOwners(
  units: Source['units'],
  table: RuledTable,
  number: number,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  viewport: ReturnType<PDFPageProxy['getViewport']>
): Map<string, Source['units']> {
  const result = new Map<string, Source['units']>()
  const { rect, top, separator } = table
  const runs: NativeHeaderRun[] = []
  for (const [index, item] of content.items.entries()) {
    if (!('str' in item) || !item.str.trim()) continue
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
    if (
      x < top.x * viewport.width ||
      x > (top.x + top.width) * viewport.width ||
      y < top.y * viewport.height ||
      y > (rect.y + rect.height) * viewport.height
    )
      continue
    const runRect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
    if (
      !runRect ||
      !contains(rect, runRect) ||
      item.dir !== 'ltr' ||
      item.transform[0] <= 0 ||
      item.transform[1] !== 0 ||
      item.transform[2] !== 0 ||
      item.transform[3] <= 0
    )
      return result
    runs.push({ index, item, rect: runRect })
  }
  const baseline = ({ item }: NativeHeaderRun): number =>
    viewport.convertToViewportPoint(item.transform[4], item.transform[5])[1]
  const right = ({ rect }: NativeHeaderRun): number => rect.x + rect.width
  const header = runs.filter((r) => baseline(r) < separator.y * viewport.height)
  if (header.length !== 4) {
    const body = runs.filter((run) => baseline(run) >= separator.y * viewport.height)
    if (header.length === 2) return splitApproximateTableValues(units, table, number, header, body)
    return splitMarkedTableTextColumn(units, table, number, header, body)
  }
  const [stub, description, value, measure] = header
  const em = stub.item.height,
    emX = em / viewport.width
  const label = /^\p{Lu}\p{Ll}+(?: \p{Ll}+){1,5}\.?$/u
  const word = /^\p{Lu}\p{Ll}{2,20}$/u
  if (
    !(em > 0) ||
    !word.test(stub.item.str) ||
    !label.test(description.item.str) ||
    !label.test(value.item.str) ||
    !word.test(measure.item.str) ||
    header.some(
      (r, i) =>
        r.item.fontName !== stub.item.fontName ||
        r.item.height !== em ||
        baseline(r) !== baseline(stub) ||
        (i > 0 && r.rect.x - right(header[i - 1]) < emX)
    )
  )
    return result

  const body = runs.slice(header.length)
  const descriptions = body.filter((r) => Math.abs(r.rect.x - description.rect.x) < emX * 0.06)
  if (
    descriptions.length < 4 ||
    descriptions.length > 32 ||
    descriptions.some(
      (r) =>
        r.item.fontName !== stub.item.fontName || r.item.height !== em || !label.test(r.item.str)
    )
  )
    return result
  const pitch = baseline(descriptions[1]) - baseline(descriptions[0])
  if (
    pitch < em * 1.2 ||
    pitch > em * 1.55 ||
    baseline(descriptions[0]) - separator.y * viewport.height < em * 0.8 ||
    baseline(descriptions[0]) - separator.y * viewport.height > em * 1.6 ||
    (rect.y + rect.height) * viewport.height - baseline(descriptions.at(-1)!) > em * 1.5 ||
    descriptions
      .slice(1)
      .some((r, i) => Math.abs(baseline(r) - baseline(descriptions[i]) - pitch) > em * 0.05)
  )
    return result

  const cuts = header.slice(1).map((r) => r.rect.x - emX * 0.7)
  const cells = new Map(header.map((r) => [r.index, { run: r, preserve: false }]))
  const data = new Set<number>()
  for (const name of descriptions) {
    const row = body.filter((r) => Math.abs(baseline(r) - baseline(name)) < em * 0.48)
    const columns = [[], [], [], []] as NativeHeaderRun[][]
    for (const run of row) {
      if (data.has(run.index) || cuts.some((cut) => run.rect.x < cut && right(run) > cut))
        return new Map()
      columns[cuts.filter((cut) => cut <= run.rect.x).length].push(run)
      data.add(run.index)
    }
    const [symbol, prose, values, measures] = columns
    const text = (column: NativeHeaderRun[]): string => column.map((r) => r.item.str).join('')
    const centered = (column: NativeHeaderRun[], heading: NativeHeaderRun): boolean => {
      if (!column.length) return false
      const midpoint =
        (Math.min(...column.map((r) => r.rect.x)) + Math.max(...column.map(right))) / 2
      return Math.abs(midpoint - (heading.rect.x + right(heading)) / 2) < emX * 0.85
    }
    if (
      prose.length !== 1 ||
      prose[0] !== name ||
      !/^[\p{Script=Latin}\p{Script=Greek}]{1,4}\d?$/u.test(text(symbol)) ||
      !symbol.some(({ item }) => item.fontName !== stub.item.fontName) ||
      !/^(?:\p{Lu}\p{Ll}{2,20}|(?=.*\d)[\p{Script=Greek}0-9()./×+−a-z]+)$/u.test(text(values)) ||
      !/^(?:[–—-]|[a-z]{1,3}(?:[−-]\d)?)$/u.test(text(measures)) ||
      !centered(symbol, stub) ||
      !centered(values, value) ||
      !centered(measures, measure)
    )
      return new Map()
    for (const run of row) {
      const plain =
        run === name || (values.length === 1 && values[0] === run && word.test(run.item.str))
      cells.set(run.index, { run, preserve: !plain })
    }
  }
  if (data.size !== body.length) return result

  const owners = new Set<number>()
  const candidates = []
  for (const unit of units) {
    const hit = unit.fragments.some(
      (fragment) =>
        fragment.pageNumber === number && fragment.items.some(({ index }) => cells.has(index))
    )
    if (!hit) continue
    if (
      unit.fragments.some(
        (fragment) =>
          fragment.pageNumber !== number || fragment.unclippedRect || !contains(rect, fragment.rect)
      )
    )
      return new Map()
    const parts = unit.fragments.flatMap((fragment) => fragment.items)
    if (!parts.length) return new Map()
    for (const { index, text } of parts) {
      if (cells.get(index)?.run.item.str !== text || owners.has(index)) return new Map()
      owners.add(index)
    }
    candidates.push({ unit, parts })
  }
  if (owners.size !== cells.size) return result
  for (const { unit, parts } of candidates) {
    if (
      unit.sourceOnly ||
      unit.preserve ||
      parts.length < 2 ||
      parts.map(({ text }) => text).join(' ') !== unit.source ||
      parts.every(({ index }) => cells.get(index)!.preserve)
    )
      continue
    result.set(
      unit.id,
      parts.map((part, offset) => {
        const { run, preserve } = cells.get(part.index)!
        return {
          ...unit,
          id: `${unit.id}-cell-${offset + 1}`,
          source: part.text,
          ...(preserve ? { sourceOnly: true as const, preserve: 'literal' as const } : {}),
          fragments: [{ pageNumber: number, rect: run.rect, items: [part] }]
        }
      })
    )
  }
  return result
}

// A connector label and the adjacent node can have almost the same baseline.
async function diagramNodeLabelOwners(
  page: PDFPageProxy,
  number: number,
  units: Source['units'],
  regions: readonly Rect[],
  paths: readonly PaintedPath[],
  signal: AbortSignal
): Promise<Map<string, Source['units']>> {
  const split = new Map<string, Source['units']>()
  const boxes = paths.filter((path) => path.diagramStroke === 'box')
  if (page.rotate !== 0 || boxes.length < 2 || !regions.length) return split
  const candidates = units.flatMap((unit, at) =>
    !unit.sourceOnly &&
    unit.fragments.length === 1 &&
    unit.fragments[0].pageNumber === number &&
    unit.fragments[0].items.length === 2 &&
    regions.some((region) => contains(region, unit.fragments[0].rect))
      ? [{ unit, next: units[at + 1] }]
      : []
  )
  if (!candidates.length) return split
  const ownerCounts = new Map<number, number>()
  for (const unit of units)
    for (const fragment of unit.fragments)
      if (fragment.pageNumber === number)
        for (const { index } of fragment.items)
          ownerCounts.set(index, (ownerCounts.get(index) ?? 0) + 1)
  const content = await page.getTextContent()
  signal.throwIfAborted()
  const viewport = page.getViewport({ scale: 1 })
  for (const { unit, next } of candidates) {
    const [part] = unit.fragments,
      second = next?.fragments[0]
    if (
      !next ||
      next.sourceOnly ||
      next.fragments.length !== 1 ||
      !second ||
      second.pageNumber !== number ||
      second.items.length < 1 ||
      second.items.length > 3 ||
      !regions.some((region) => contains(region, part.rect) && contains(region, second.rect)) ||
      split.has(unit.id) ||
      split.has(next.id) ||
      unit.source !== part.items.map(({ text }) => text).join(' ') ||
      next.source !== second.items.map(({ text }) => text).join(' ')
    )
      continue
    const claims = [...part.items, ...second.items]
    if (
      claims.some(
        ({ index }, at) => ownerCounts.get(index) !== 1 || (at > 0 && index <= claims[at - 1].index)
      ) ||
      content.items
        .slice(claims[0].index, claims.at(-1)!.index + 1)
        .filter((item) => 'str' in item && item.str.trim()).length !== claims.length
    )
      continue
    const runs = claims.map(({ index, text }) => {
      const item = content.items[index]
      if (
        !item ||
        !('str' in item) ||
        item.str !== text ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0
      )
        return
      const rect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
      if (rect) return { item, rect }
    })
    if (!runs.every((run) => run !== undefined)) continue
    const [label, top, ...bottom] = runs,
      h = top.rect.height
    const owners = boxes.filter(
      (box) =>
        runs.slice(1).every(({ rect }) => contains(box, rect)) && !overlaps(label.rect, box, 0)
    )
    if (owners.length !== 1) continue
    const [box] = owners
    const left = boxes.filter(
      (peer) =>
        peer.x + peer.width < label.rect.x &&
        Math.abs(peer.y - box.y) < h * 0.15 &&
        Math.abs(peer.height - box.height) < h * 0.15
    )
    if (
      left.length !== 1 ||
      !/^[a-z]{3,16}$/u.test(label.item.str) ||
      label.item.fontName === top.item.fontName ||
      label.rect.height >= h * 0.85 ||
      Math.abs(label.rect.y - top.rect.y) > h * 0.2 ||
      bottom.some(
        ({ item }) =>
          item.fontName !== top.item.fontName ||
          item.height !== top.item.height ||
          item.transform[5] !== bottom[0].item.transform[5]
      ) ||
      Math.abs(second.rect.x - top.rect.x) > h * 0.15 ||
      second.rect.y - top.rect.y < h ||
      second.rect.y - top.rect.y > h * 1.5
    )
      continue
    const [peer] = left
    const connections = paths.filter(
      (path) =>
        path.diagramStroke === 'horizontal' &&
        Math.abs(path.x + path.width - box.x) < h * 0.1 &&
        Math.abs(path.x - peer.x - peer.width) < h * 0.6 &&
        path.x < label.rect.x + h * 0.1 &&
        path.y > label.rect.y + label.rect.height &&
        path.y - label.rect.y - label.rect.height < h * 0.6
    )
    if (connections.length !== 1) continue
    const labelOwner = {
      ...unit,
      figure: true as const,
      source: claims[0].text,
      fragments: [{ pageNumber: number, rect: label.rect, items: [claims[0]] }]
    }
    const nodeOwner = {
      ...next,
      figure: true as const,
      source: claims[1].text + ' ' + next.source,
      fragments: [{ pageNumber: number, rect: top.rect, items: [claims[1]] }, second]
    }
    split.set(unit.id, [labelOwner, nodeOwner])
    split.set(next.id, [])
  }
  return split
}

// These rows hold dates and instrument settings. Leave their aligned data native,
// including a filter suffix or a measurement prime painted as a separate glyph.
function nativeObservationTableRow(
  fragment: PdfTranslationFragment,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
): boolean {
  const parts = fragment.items.map(({ index }) => content.items[index])
  if (
    !parts.every((item, index): item is TextItem =>
      Boolean(
        item &&
        'str' in item &&
        item.str === fragment.items[index].text &&
        item.dir === 'ltr' &&
        item.transform.every(Number.isFinite) &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0 &&
        Number.isFinite(item.width) &&
        item.width > 0
      )
    )
  )
    return false
  if (
    !parts.every(
      (item, index) =>
        Math.abs(item.transform[5] - parts[0].transform[5]) < parts[0].height * 0.45 &&
        (!index || item.transform[4] > parts[index - 1].transform[4])
    )
  )
    return false
  const [date, telescope, instrument, ...filterAndValues] = parts.map(({ str }) => str)
  if (!date || !telescope || !instrument || filterAndValues.length < 1) return false
  return (
    /^(?:19|20)[0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec) [1-9][0-9]?$/u.test(
      date
    ) &&
    /^[A-Z][A-Za-z0-9]+(?: [A-Z])?$/u.test(telescope) &&
    /^[A-Z][A-Z0-9]{1,8}$/u.test(instrument) &&
    /^(?:[A-Z][0-9]{2,4}[A-Z]|[a-z] [’′])(?: (?:[0-9]+(?:x[0-9]+)?|[0-9]+[.][0-9]+|′′|[(] *[0-9]+[.][0-9]+[)]))*$/u.test(
      filterAndValues.join(' ')
    )
  )
}

// A whole, standalone fraction stays native when the two text tiers and its
// directly painted bar agree. The same compact spelling can also be prose.
async function nativeMaskFractions(
  units: Source['units'],
  page: PDFPageProxy,
  number: number,
  masks: readonly Rect[],
  signal: AbortSignal
): Promise<string[]> {
  if (!masks.length || page.rotate !== 0) return []
  const candidates = units.filter(
    ({ source, sourceOnly, preserve, fragments }) =>
      !sourceOnly &&
      !preserve &&
      /^(?:\d{2,4}[a-z]|\d{1,2}[a-z]\d{1,2})$/u.test(source) &&
      fragments.length === 1 &&
      fragments[0].pageNumber === number &&
      fragments[0].items.length === 3
  )
  if (!candidates.length) return []
  const { items } = await page.getTextContent()
  signal.throwIfAborted()
  const { width, height, transform } = page.getViewport({ scale: 1 })
  const [sx, b, c, sy, tx, ty] = transform
  if (sx <= 0 || sy >= 0 || b !== 0 || c !== 0) return []
  return candidates.flatMap(({ id, source, fragments: [fragment] }) => {
    const claims = fragment.items.toSorted((a, b) => a.index - b.index)
    const runs = claims.map(({ index, text }) => {
      const item = items[index]
      return item &&
        'str' in item &&
        item.str === text &&
        item.dir === 'ltr' &&
        item.transform.every(Number.isFinite) &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        item.transform[3] > 0 &&
        item.width > 0 &&
        item.height > 0
        ? item
        : undefined
    })
    const [digit, variable, denominator] = runs
    if (
      !digit ||
      !variable ||
      !denominator ||
      !/^\d{1,2}$/u.test(digit.str) ||
      !/^[a-z]$/u.test(variable.str) ||
      !/^\d{1,2}$/u.test(denominator.str) ||
      digit.fontName !== denominator.fontName ||
      digit.fontName === variable.fontName ||
      (source !== digit.str + denominator.str + variable.str &&
        source !== digit.str + variable.str + denominator.str) ||
      items
        .slice(claims[0].index, claims[2].index + 1)
        .filter((item) => 'str' in item && item.str.trim()).length !== 3
    )
      return []
    const em = digit.height,
      left = digit.transform[4],
      right = variable.transform[4] + variable.width
    const lowerLeft = denominator.transform[4],
      lowerRight = lowerLeft + denominator.width
    const rising = digit.transform[5],
      lower = denominator.transform[5]
    if (
      Math.abs(variable.transform[5] - rising) > em * 0.02 ||
      Math.abs(variable.transform[4] - left - digit.width) > em * 0.12 ||
      [variable, denominator].some((item) => Math.abs(item.height - em) > em * 0.02) ||
      rising - lower < em * 0.95 ||
      rising - lower > em * 1.2 ||
      Math.abs(left + right - lowerLeft - lowerRight) > em * 0.22
    )
      return []
    const bars = masks.filter((mask) => {
      const x = (mask.x * width - tx) / sx,
        end = ((mask.x + mask.width) * width - tx) / sx,
        top = (mask.y * height - ty) / sy,
        bottom = ((mask.y + mask.height) * height - ty) / sy
      return (
        Math.abs(x - left) <= em * 0.1 &&
        Math.abs(end - right) <= em * 0.1 &&
        rising - top >= em * 0.08 &&
        rising - top <= em * 0.35 &&
        bottom - lower >= em * 0.65 &&
        bottom - lower <= em &&
        top - bottom >= em * 0.025 &&
        top - bottom <= em * 0.13
      )
    })
    return bars.length === 1 ? [id] : []
  })
}

// The raster frame and two equally spaced rows distinguish coordinates from prose.
function nativeSkyCoordinateTicks(
  units: Source['units'],
  images: readonly Rect[],
  preserved: ReadonlySet<string>
): string[] {
  const candidates = units.flatMap((unit) => {
    const [part] = unit.fragments
    return preserved.has(unit.id) &&
      !unit.sourceOnly &&
      unit.fragments.length === 1 &&
      /^\d[\d.hms°'"]+$/u.test(unit.source) &&
      part.items
        .map(({ text }) => text)
        .join('')
        .replace(/\s/gu, '') === unit.source
      ? [{ id: unit.id, label: unit.source, rect: part.rect }]
      : []
  })
  const row = (values: number[], font: number): boolean => {
    const gap = values[1] - values[0]
    return (
      values.length >= 4 &&
      gap > font * 2 &&
      values
        .slice(2)
        .every((value, index) => Math.abs(value - values[index + 1] - gap) < font * 0.15)
    )
  }
  return images.flatMap((image) => {
    const x = candidates
      .filter(
        ({ rect, label }) =>
          /^(?:\d{1,2}h\d{2}m)?\d{2}\.\d{2}s$/u.test(label) &&
          rect.x + rect.width / 2 >= image.x &&
          rect.x + rect.width / 2 < image.x + image.width &&
          rect.y >= image.y + image.height &&
          rect.y - image.y - image.height < rect.height
      )
      .sort((a, b) => a.rect.x + a.rect.width / 2 - b.rect.x - b.rect.width / 2)
    const y = candidates
      .filter(
        ({ rect, label }) =>
          /^(?:\d{1,2}°)?(?:\d{2}')?\d{2}\.\d{2}"$/u.test(label) &&
          rect.y > image.y &&
          rect.y + rect.height <= image.y + image.height &&
          rect.x + rect.width <= image.x &&
          image.x - rect.x - rect.width < rect.height * 1.5
      )
      .sort((a, b) => a.rect.y - b.rect.y)
    if (x.length < 4 || y.length < 4) return []
    const [firstX] = x,
      [firstY] = y
    return /^\d{1,2}h\d{2}m/u.test(firstX.label) &&
      /^\d{1,2}°\d{2}'/u.test(firstY.label) &&
      x
        .slice(1)
        .every(
          ({ label, rect }) =>
            !label.includes('h') && Math.abs(rect.y - firstX.rect.y) < firstX.rect.height * 0.05
        ) &&
      y
        .slice(1)
        .every(
          ({ label, rect }) =>
            !label.includes('°') &&
            Math.abs(rect.x + rect.width - firstY.rect.x - firstY.rect.width) <
              firstY.rect.height * 0.1
        ) &&
      row(
        x.map(({ rect }) => rect.x + rect.width / 2),
        firstX.rect.height
      ) &&
      row(
        y.map(({ rect }) => rect.y + rect.height / 2),
        firstY.rect.height
      )
      ? [...x, ...y].map(({ id }) => id)
      : []
  })
}

// An axis title can overlap the middle tick's text metrics even though their
// native rows are distinct. Split only with a painted axis and a complete tick rail.
async function splitNativeOrdinalAxisTitles(
  page: PDFPageProxy,
  units: Source['units'],
  regions: Rect[],
  painted: readonly PaintedPath[],
  pageNumber: number,
  signal: AbortSignal
): Promise<Map<string, Source['units']>> {
  const splits = new Map<string, Source['units']>()
  const axes = painted.filter(({ diagramStroke }) => diagramStroke === 'horizontal')
  if (page.rotate !== 0 || !axes.length || !regions.length || !page.getTextContent) return splits

  const candidates = units.filter(({ source, sourceOnly, preserve, fragments }) => {
    const [fragment] = fragments
    const [tick, title] = fragment?.items ?? []
    return (
      !sourceOnly &&
      !preserve &&
      fragments.length === 1 &&
      fragment.pageNumber === pageNumber &&
      fragment.items.length === 2 &&
      /^\d{1,4}$/u.test(tick.text) &&
      /^\p{L}{2,}(?: \p{L}{2,}){1,5}$/u.test(title.text) &&
      source === title.text + tick.text &&
      regions.some((region) => contains(region, fragment.rect))
    )
  })
  if (!candidates.length) return splits

  const { items, styles } = await page.getTextContent()
  signal.throwIfAborted()
  const viewport = page.getViewport({ scale: 1 })
  const nativeRun = ({
    index,
    text
  }: PdfTranslationFragment['items'][number]): { item: TextItem; rect: Rect } | undefined => {
    const item = items[index]
    if (
      !item ||
      !('str' in item) ||
      item.str !== text ||
      item.transform[0] <= 0 ||
      item.transform[1] !== 0 ||
      item.transform[2] !== 0 ||
      item.transform[3] <= 0 ||
      styles[item.fontName]?.vertical !== false ||
      !Number.isFinite(styles[item.fontName].ascent)
    )
      return
    const rect = nativeLabelRegion(item, styles[item.fontName], viewport, pageNumber)
    return rect && { item, rect }
  }
  const literals = units.flatMap(({ source, sourceOnly, preserve, fragments }) => {
    const [fragment] = fragments
    if (
      !sourceOnly ||
      preserve !== 'literal' ||
      fragments.length !== 1 ||
      fragment.pageNumber !== pageNumber ||
      fragment.items.length !== 1 ||
      fragment.items[0].text !== source ||
      !/^\d{1,4}$/u.test(source)
    )
      return []
    const run = nativeRun(fragment.items[0])
    return run ? [run] : []
  })
  const center = (rect: Rect): number => rect.x + rect.width / 2
  for (const unit of candidates) {
    const [fragment] = unit.fragments
    const tick = nativeRun(fragment.items[0])
    const title = nativeRun(fragment.items[1])
    if (!tick || !title || tick.item.fontName !== title.item.fontName) continue
    const em = tick.item.height
    const rise = title.item.transform[5] - tick.item.transform[5]
    if (
      rise < em * 0.65 ||
      rise > em * 1.5 ||
      title.item.height < em ||
      title.item.height > em * 1.5
    )
      continue
    const axis = axes.find(
      (path) =>
        path.width >= (em * 16) / viewport.width &&
        path.y > tick.rect.y + tick.rect.height &&
        path.y - tick.rect.y - tick.rect.height < tick.rect.height &&
        Math.abs(center(path) - center(title.rect)) < em / viewport.width &&
        Math.abs(center(tick.rect) - center(title.rect)) < em / viewport.width &&
        regions.some((region) => contains(region, path) && contains(region, fragment.rect))
    )
    if (!axis) continue
    const rail = [...literals, tick]
      .filter(
        ({ item, rect }) =>
          item.fontName === tick.item.fontName &&
          Math.abs(item.height - em) < em * 0.03 &&
          Math.abs(item.transform[5] - tick.item.transform[5]) < em * 0.04 &&
          rect.x >= axis.x &&
          rect.x + rect.width <= axis.x + axis.width
      )
      .sort((a, b) => a.rect.x - b.rect.x)
    if (rail.length < 5) continue
    const step = Number(rail[1].item.str) - Number(rail[0].item.str)
    const start = center(rail[0].rect)
    const pitch = (center(rail.at(-1)!.rect) - start) / (rail.length - 1)
    if (
      step <= 0 ||
      pitch < (em * 2) / viewport.width ||
      center(rail.at(-1)!.rect) - start < axis.width * 0.65 ||
      rail.some(
        ({ item, rect }, index) =>
          Number(item.str) !== Number(rail[0].item.str) + index * step ||
          Math.abs(center(rect) - start - index * pitch) > (em * 0.4) / viewport.width
      )
    )
      continue
    splits.set(
      unit.id,
      [tick, title].map(({ item, rect }, index) => ({
        ...unit,
        id: index ? unit.id : unit.id + '-axis-tick',
        source: item.str,
        figure: true as const,
        ...(index ? {} : { sourceOnly: true as const, preserve: 'literal' as const }),
        fragments: [{ ...fragment, rect, items: [fragment.items[index]] }]
      }))
    )
  }
  return splits
}

// A line shared by three raster labels cannot be translated as one paragraph.
async function splitThreeRasterPanelLabels(
  page: PDFPageProxy,
  number: number,
  units: Source['units'],
  images: readonly Rect[],
  signal: AbortSignal
): Promise<Map<string, Source['units']>> {
  const split = new Map<string, Source['units']>()
  if (page.rotate !== 0 || images.length < 3) return split
  const right = (rect: Rect): number => rect.x + rect.width
  const ids = /^\(([a-z])\)$/u
  const candidates = units.flatMap((unit, i) => {
    const marker = units[i - 1]
    const [fragment] = unit.fragments
    const items = fragment?.items
    if (
      unit.sourceOnly ||
      unit.preserve ||
      unit.figure ||
      unit.referenceBoundary ||
      unit.fragments.length !== 1 ||
      fragment.pageNumber !== number ||
      fragment.unclippedRect ||
      items.length !== 5 ||
      !marker?.sourceOnly ||
      marker.preserve !== 'formula' ||
      marker.fragments.length !== 1 ||
      marker.fragments[0].pageNumber !== number ||
      marker.fragments[0].unclippedRect ||
      marker.fragments[0].items.length !== 1
    )
      return []
    const pieces = [...marker.fragments[0].items, ...items]
    const letter = ids.exec(marker.source)?.[1]
    if (
      !letter ||
      pieces[0].text !== marker.source ||
      items.map(({ text }) => text).join(' ') !== unit.source ||
      [2, 4].some(
        (n) => pieces[n].text !== '(' + String.fromCharCode(letter.charCodeAt(0) + n / 2) + ')'
      ) ||
      [1, 3, 5].some((n) => !/^\p{Lu}[^()]{8,120}$/u.test(pieces[n].text))
    )
      return []
    const emY = fragment.rect.height
    const lower = fragment.rect.y + emY
    const captions = units.filter(
      ({ source, fragments, sourceOnly }) =>
        !sourceOnly &&
        isFigureCaption(source) &&
        isPdfTranslationCaption(source) &&
        fragments.some(
          ({ pageNumber, rect }) =>
            pageNumber === number &&
            rect.y > lower &&
            rect.y - lower < emY &&
            rect.x <= marker.fragments[0].rect.x &&
            right(rect) >= right(fragment.rect)
        )
    )
    return captions.length === 1 ? [{ unit, fragment, pieces, marker }] : []
  })
  if (!candidates.length) return split
  const content = await page.getTextContent()
  signal.throwIfAborted()
  const viewport = page.getViewport({ scale: 1 })
  const owners = new Map<number, number>()
  for (const { fragments } of units)
    for (const fragment of fragments)
      if (fragment.pageNumber === number)
        for (const { index } of fragment.items) owners.set(index, (owners.get(index) ?? 0) + 1)
  for (const { unit, fragment, pieces, marker } of candidates) {
    const runs = pieces.map(({ index, text }, i) => {
      const item = content.items[index]
      if (
        owners.get(index) !== 1 ||
        !item ||
        !('str' in item) ||
        item.str !== text ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0 ||
        (i > 0 &&
          (pieces[i - 1].index >= index ||
            content.items
              .slice(pieces[i - 1].index + 1, index)
              .some((other) => 'str' in other && other.str.trim())))
      )
        return
      const rect = nativeLabelRegion(item, content.styles[item.fontName], viewport, number)
      return rect && { item, rect }
    })
    if (!runs.every((run) => run !== undefined)) continue
    const em = runs[0].item.height
    if (
      runs.some(
        ({ item, rect }, i) =>
          item.height !== em ||
          item.transform[5] !== runs[0].item.transform[5] ||
          item.fontName !== runs[i % 2].item.fontName ||
          (i > 0 && rect.x <= right(runs[i - 1].rect)) ||
          !contains(i === 0 ? marker.fragments[0].rect : fragment.rect, rect)
      )
    )
      continue
    const panels = [0, 2, 4].map((i) => {
      const a = runs[i].rect,
        b = runs[i + 1].rect
      const gap = b.x - right(a)
      if (gap > (em * 0.55) / viewport.width) return
      const fits = images.filter(
        (image) =>
          a.x >= image.x &&
          right(b) <= right(image) &&
          Math.abs(a.x + right(b) - image.x - right(image)) <= em / viewport.width &&
          a.y > image.y + image.height &&
          a.y - image.y - image.height < a.height * 1.2
      )
      return fits.length === 1 ? fits[0] : undefined
    })
    if (
      !panels.every((panel) => panel !== undefined) ||
      panels.some(
        (panel, i) =>
          i > 0 &&
          (panel.x <= right(panels[i - 1]!) ||
            Math.abs(panel.y - panels[0]!.y) > fragment.rect.height * 0.2)
      )
    )
      continue
    split.set(
      unit.id,
      pieces.slice(1).map((part, i) => {
        const mark = i % 2 !== 0
        const { x, y, width, height } = runs[i + 1].rect
        return {
          ...unit,
          id: `${unit.id}-panel-${i + 1}`,
          source: part.text,
          ...(mark ? { sourceOnly: true as const, preserve: 'formula' as const } : {}),
          fragments: [{ pageNumber: number, rect: { x, y, width, height }, items: [part] }]
        }
      })
    )
  }
  return split
}

/** Run before admitting a new translation; historical snapshots keep their indices unchanged. */
export async function preservePdfFigureSources<T extends Pick<PdfTranslationExtraction, 'source'>>({
  document,
  extraction,
  operators,
  signal,
  skipTranslation = true
}: {
  document: Document
  extraction: T
  operators: typeof OPS
  signal: AbortSignal
  /** Preparation can annotate ownership before the user chooses a layout mode. */
  skipTranslation?: boolean
}): Promise<T> {
  const source = extraction.source,
    preserved = new Set<string>(),
    nativeLiterals = new Set<string>(),
    retainedTableOwners = new Set<string>(),
    nativeFractionOwners = new Set<string>(),
    splitTableCells = new Map<string, Source['units']>(),
    splitTableRows = new Map<string, Source['units']>(),
    splitFigureLabels = new Map<string, Source['units']>(),
    splitFrequencyLabels = new Map<string, Source['units']>(),
    figureContinuations = new Map<string, Source['units']>()
  const restoredCaptions = new Set<string>()
  const appendixHeading = source.units.findIndex((unit) => unit.source === 'Figures:')
  const appendix = appendixHeading > 0 ? source.units.slice(appendixHeading) : []
  const [heading, ...appendixCaptions] = appendix
  const anchor = source.units[appendixHeading - 1]
  const figureAppendix =
    appendixCaptions.length >= 2 &&
    appendix.every(
      (unit) => unit.sourceOnly && unit.preserve === 'reference' && unit.fragments.length === 1
    ) &&
    anchor?.sourceOnly &&
    anchor.preserve === 'reference' &&
    anchor.fragments.at(-1)?.pageNumber === heading.fragments[0].pageNumber - 1 &&
    appendixCaptions.every((unit, index) =>
      new RegExp(`^Figure ${index + 1} - \\p{Lu}.{24,}\\.$`, 'u').test(unit.source)
    )
  const originalRegions: NonNullable<Source['originalRegions']>[number][] = [
    ...(source.originalRegions ?? [])
  ]
  for (let number = 1; number <= source.pages.length; number++) {
    signal.throwIfAborted()
    const units = source.units.filter((unit) => unit.fragments.some((f) => f.pageNumber === number))
    if (!units.length) continue
    let page: PDFPageProxy | undefined
    try {
      page = await document.getPage(number)
      signal.throwIfAborted()
      const {
        images,
        vectors,
        rules = [],
        maskRules = [],
        smallMaskRules = [],
        painted = [],
        filledRules = []
      } = await graphicRegions(page, operators, signal)
      if (figureAppendix && units.every((unit) => appendix.includes(unit))) {
        for (const id of await rasterAppendixCaptions(page, units, images, heading, signal))
          restoredCaptions.add(id)
      }
      if (number === source.pages.length && source.units.at(-1) === units.at(-1)) {
        const restored = await terminalReferenceCaption(
          page,
          units,
          images,
          source.units.at(-2),
          signal
        )
        if (restored) restoredCaptions.add(restored)
        if (page.rotate === 0)
          for (const id of referencePageCaptions(source, units, vectors, number))
            restoredCaptions.add(id)
      }
      const interleaved = await interleavedRasterCaption(
        page,
        source,
        units,
        images,
        number,
        signal
      )
      if (interleaved) restoredCaptions.add(interleaved)
      const captions = units
        .filter((unit) => isFigureCaption(unit.source) && isPdfTranslationCaption(unit.source))
        .flatMap((unit) => unit.fragments.filter((f) => f.pageNumber === number))
      const captionedVectors = vectors.filter((rect) =>
        captions.some(
          ({ rect: caption }) =>
            caption.y >= rect.y + rect.height - 0.003 &&
            caption.y - rect.y - rect.height < 0.14 &&
            caption.x < rect.x + rect.width &&
            caption.x + caption.width > rect.x
        )
      )
      const continued =
        !page.rotate && nativeFigureSentenceContinuation(source, units, captionedVectors, number)
      if (continued && !preserved.has(continued.head.id)) {
        const { head, tail } = continued
        figureContinuations.set(head.id, [
          {
            ...head,
            source: head.source + ' ' + tail.source,
            fragments: [...head.fragments, ...tail.fragments]
          }
        ])
        figureContinuations.set(tail.id, [])
      }
      const vectorTables = tableRegions(units, rules, number)
      for (const id of await nativeMaskFractions(units, page, number, smallMaskRules, signal))
        nativeFractionOwners.add(id)
      const maskTables = tableRegions(units, maskRules, number)
      const tables = [...vectorTables, ...maskTables]

      if (maskTables.length) {
        const content = await page.getTextContent()
        signal.throwIfAborted()
        if (page.rotate === 0)
          for (const id of crossRuleStencilTableOwners(
            units,
            maskTables,
            number,
            content,
            page.getViewport({ scale: 1 })
          ))
            retainedTableOwners.add(id)
        for (const unit of units) {
          if (
            !unit.sourceOnly &&
            maskTables.some((table) =>
              unit.fragments.every(
                (fragment) =>
                  fragment.pageNumber === number &&
                  contains(table.rect, fragment.rect) &&
                  fragment.rect.y > table.separator.y &&
                  nativeObservationTableRow(fragment, content)
              )
            )
          )
            nativeLiterals.add(unit.id)
        }
      }
      const taggedTable = await taggedMeasurementTableOwners(page, number, units, signal).catch(
        () => {
          signal.throwIfAborted()
        }
      )
      if (taggedTable) {
        for (const id of taggedTable.owners) {
          preserved.add(id)
          retainedTableOwners.add(id)
        }
        if (!skipTranslation && taggedTable.header) {
          const [id, cells] = taggedTable.header
          preserved.add(id)
          splitTableCells.set(id, cells)
        }
      }
      const filled = await closedFilledTable(page, number, units, filledRules, signal)
      if (filled) for (const id of filled.owners) retainedTableOwners.add(id)
      const grouped = await retainGroupedRomanTable(
        page,
        number,
        units,
        painted.filter(({ straight, height }) => straight && height === 0),
        signal
      )
      for (const table of grouped) {
        for (const id of table.owners) {
          preserved.add(id)
          retainedTableOwners.add(id)
        }
      }
      const regions = [
        ...images,
        ...grouped.map(({ rect }) => rect),
        ...tables.map(({ rect }) => rect),
        ...captionedVectors,
        ...(filled ? [filled.rect] : [])
      ]
      for (const rect of regions)
        if (
          !originalRegions.some(
            (region) => region.pageNumber === number && contains(region.rect, rect)
          )
        )
          originalRegions.push({ pageNumber: number, rect })
      for (const unit of units.filter(
        (unit) =>
          !isPdfTranslationCaption(unit.source) &&
          unit.fragments.every((f) => f.pageNumber === number)
      ))
        if (
          unit.fragments.every((fragment) => regions.some((rect) => contains(rect, fragment.rect)))
        )
          preserved.add(unit.id)
      if (page.rotate === 0 && images.length)
        for (const id of nativeSkyCoordinateTicks(units, images, preserved)) nativeLiterals.add(id)
      // Paired detector arms use the same exposure keys on their raw images.
      if (page.rotate === 0 && !skipTranslation && images.length >= 2) {
        const detectors = units.flatMap((unit) => {
          if (
            !preserved.has(unit.id) ||
            unit.sourceOnly ||
            unit.fragments.length !== 1 ||
            !/^(?:SCIENCE|FLAT|ARC) (?:BLUE|RED)$/u.test(unit.source)
          )
            return []
          const { rect, items } = unit.fragments[0]
          if (items.length !== 2 || items.map(({ text }) => text).join(' ') !== unit.source)
            return []
          const panels = images.filter(
            (image) =>
              contains(image, rect) &&
              Math.abs(rect.x - image.x) < rect.height * 2.5 &&
              Math.abs(image.y + image.height - rect.y - rect.height) < rect.height * 2
          )
          return panels.length === 1 ? [{ unit, rect, panel: panels[0] }] : []
        })
        for (const blue of detectors.filter(({ unit }) => unit.source.endsWith(' BLUE'))) {
          const peers = detectors.filter(
            ({ unit, rect, panel }) =>
              unit.source === blue.unit.source.replace(/BLUE$/u, 'RED') &&
              Math.abs(rect.y - blue.rect.y) < blue.rect.height * 0.1 &&
              Math.abs(rect.height - blue.rect.height) < blue.rect.height * 0.1 &&
              Math.abs(panel.y - blue.panel.y) < blue.rect.height * 0.1 &&
              Math.abs(panel.width - blue.panel.width) < blue.rect.height * 0.1 &&
              Math.abs(panel.height - blue.panel.height) < blue.rect.height * 0.1 &&
              panel.x >= blue.panel.x + blue.panel.width &&
              panel.x - blue.panel.x - blue.panel.width < blue.rect.height
          )
          if (peers.length === 1) {
            nativeLiterals.add(blue.unit.id)
            nativeLiterals.add(peers[0].unit.id)
          }
        }
      }
      if (!skipTranslation) {
        for (const [id, labels] of await splitThreeRasterPanelLabels(
          page,
          number,
          units,
          images,
          signal
        )) {
          preserved.add(id)
          splitFigureLabels.set(id, labels)
        }
        const nodes = await diagramNodeLabelOwners(
          page,
          number,
          units,
          captionedVectors,
          painted,
          signal
        )
        for (const [id, labels] of nodes) splitFigureLabels.set(id, labels)
        for (const [id, labels] of await splitNativeOrdinalAxisTitles(
          page,
          units,
          captionedVectors,
          painted,
          number,
          signal
        ))
          splitFigureLabels.set(id, labels)
        const headers = await coalescedTableHeaderOwners(
          page,
          number,
          units,
          [...tables, ...tableRegions(units, rules, number, 'appendix')],
          painted,
          signal
        )
        for (const id of headers.retained) retainedTableOwners.add(id)
        for (const [id, cells] of headers.split) {
          preserved.add(id)
          splitTableCells.set(id, cells)
        }
        const romanTables =
          page.rotate === 0
            ? tableRegions(
                units,
                painted.filter(({ straight, height }) => straight && height === 0),
                number,
                'roman'
              )
            : []
        const totalTables =
          page.rotate === 0
            ? tableRegions(
                units,
                painted.filter(({ straight, height }) => straight && height === 0),
                number,
                'roman-total'
              )
            : []
        if (
          page.rotate === 0 &&
          (vectorTables.length || romanTables.length || totalTables.length)
        ) {
          const content = await page.getTextContent()
          signal.throwIfAborted()
          const viewport = page.getViewport({ scale: 1 })
          for (const table of totalTables)
            for (const [id, cells] of splitRomanCostTotal(units, table, number, content, viewport))
              splitTableRows.set(id, cells)
          for (const table of romanTables)
            for (const [id, rows] of splitCrossRowTableProse(
              units,
              table,
              number,
              content,
              viewport
            ))
              splitTableRows.set(id, rows)
          for (const table of vectorTables)
            for (const [id, cells] of splitRuledParameterTableOwners(
              units,
              table,
              number,
              content,
              viewport
            )) {
              preserved.add(id)
              if (!splitTableCells.has(id)) splitTableCells.set(id, cells)
            }
        }
      }
      // A column of unspaced feature keys keeps the native names used by the data.
      const keys = units.filter((unit) => {
        if (!preserved.has(unit.id) || unit.sourceOnly || unit.fragments.length !== 1) return false
        const [{ items }] = unit.fragments
        return (
          items.length === 1 &&
          items[0].text === unit.source &&
          /^[A-Z][a-z\d]+(?:[A-Z][a-z\d]*)+$/u.test(unit.source)
        )
      })
      const figureRegions = [...images, ...captionedVectors]
      const legendCandidates = units.filter(
        (unit) =>
          preserved.has(unit.id) &&
          unit.fragments.length === 1 &&
          captionedVectors.some((region) => contains(region, unit.fragments[0].rect))
      )
      for (const id of await nativeLegendOwners(
        page,
        legendCandidates,
        painted,
        signal,
        skipTranslation ? undefined : splitFrequencyLabels
      ))
        nativeLiterals.add(id)

      for (const key of keys) {
        const { rect } = key.fragments[0]
        for (const region of figureRegions.filter((region) => contains(region, rect))) {
          const left = new Set<number>()
          const right = new Set<number>()
          for (const peer of keys) {
            const other = peer.fragments[0].rect
            if (
              !contains(region, other) ||
              Math.abs(rect.height - other.height) >= rect.height * 0.05
            )
              continue
            if (Math.abs(rect.x - other.x) < 0.001) left.add(other.y)
            if (Math.abs(rect.x + rect.width - other.x - other.width) < 0.001) right.add(other.y)
          }
          if (left.size >= 3 || right.size >= 3) nativeLiterals.add(key.id)
        }
      }
      // Native plot fonts can be decoded as ordinary text instead of markers.
      const dingbatText = /^l+(?:\s+l+)*$/u
      const texMarkerText = /^[①❤✒✠·qrt\s]+$/u
      const hasUndecodedPlotGlyph = (text: string): boolean =>
        [...text].some((char) => char.charCodeAt(0) < 32 && char.trim() !== '')
      const markerUnits = units.filter(
        (unit) =>
          preserved.has(unit.id) &&
          !unit.sourceOnly &&
          unit.fragments.length === 1 &&
          unit.fragments[0].items.length > 0 &&
          (dingbatText.test(unit.source) ||
            texMarkerText.test(unit.source) ||
            hasUndecodedPlotGlyph(unit.source))
      )
      const fonts = page.commonObjs
      if (markerUnits.length && typeof fonts?.has === 'function') {
        const content = await page.getTextContent()
        signal.throwIfAborted()
        for (const unit of markerUnits) {
          const dingbat = dingbatText.test(unit.source)
          const texMarker = texMarkerText.test(unit.source)
          if (
            unit.fragments[0].items.every(({ index, text }) => {
              const item = content.items[index]
              if (!item || !('str' in item) || item.str !== text || !fonts.has(item.fontName))
                return false
              const font = fonts.get(item.fontName)
              return (
                (font?.name === 'ZapfDingbats' && font.missingFile === true && dingbat) ||
                (font?.missingFile === false &&
                  /^(?:[A-Z]{6}\+)?(?:LCIRCLEW10|LINEW10)$/u.test(font.name) &&
                  texMarker) ||
                (font?.isType3Font === true &&
                  font.missingFile === false &&
                  hasUndecodedPlotGlyph(text))
              )
            })
          )
            nativeLiterals.add(unit.id)
        }
      }
    } catch {
      // Missing/unusual graphics must not prevent ordinary text translation.
      signal.throwIfAborted()
    } finally {
      // PDF.js defers cleanup while a shared page is still rendering.
      page?.cleanup()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  if (
    !preserved.size &&
    !splitTableRows.size &&
    !originalRegions.length &&
    !restoredCaptions.size &&
    !figureContinuations.size &&
    !nativeFractionOwners.size
  )
    return extraction
  return Object.freeze({
    ...extraction,
    source: carryNativeCaptionEligibility(
      source,
      createPdfTranslationSource({
        ...source,
        originalRegions,
        units: source.units.flatMap((unit) => {
          const continued = figureContinuations.get(unit.id)
          if (continued) return continued
          if (restoredCaptions.has(unit.id)) {
            const restored = { ...unit }
            delete restored.sourceOnly
            delete restored.preserve
            return restored
          }
          if (nativeFractionOwners.has(unit.id))
            return { ...unit, sourceOnly: true as const, preserve: 'formula' as const }
          if (!preserved.has(unit.id)) return splitTableRows.get(unit.id) ?? [unit]
          const labels = splitFrequencyLabels.get(unit.id) ?? splitFigureLabels.get(unit.id)
          if (labels) return labels
          const cells = splitTableCells.get(unit.id)
          if (cells && !nativeLiterals.has(unit.id) && !retainedTableOwners.has(unit.id))
            return cells.map((cell) => ({ ...cell, figure: true as const }))
          return {
            ...unit,
            ...(skipTranslation || nativeLiterals.has(unit.id) || retainedTableOwners.has(unit.id)
              ? { sourceOnly: true as const }
              : {}),
            ...(nativeLiterals.has(unit.id) ? { preserve: 'literal' as const } : {}),
            figure: true as const
          }
        })
      })
    )
  })
}

/** Preserve every native item; only complete, independently proved figure units leave prose. */
export async function applyCachedPdfFigureSources({
  extraction,
  document,
  sourceId,
  sourceIdentity,
  signal,
  nativeDocumentFactory,
  readCached
}: {
  extraction: PdfTranslationExtraction
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'> &
    Partial<Pick<PDFDocumentProxy, 'getData' | 'getMetadata'>>
  sourceId: string
  sourceIdentity: PdfTranslationSourceIdentity
  signal: AbortSignal
  nativeDocumentFactory?: typeof import('pdfjs-dist').getDocument
  readCached: (
    request: Readonly<{ sourceId: string; page: number }>
  ) => Promise<PdfStructureResult | undefined>
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const source = extraction.source,
    identity = { ...sourceIdentity }
  if (
    !/^[a-f0-9]{64}$/.test(identity.sourceChecksum) ||
    !Number.isSafeInteger(identity.sourceSizeBytes) ||
    identity.sourceSizeBytes <= 0 ||
    !source.fingerprint ||
    source.fingerprint !== document.fingerprints[0] ||
    source.pages.length !== document.numPages
  )
    return extraction
  const current = (): void => {
    signal.throwIfAborted()
    if (
      source.fingerprint !== document.fingerprints[0] ||
      source.pages.length !== document.numPages
    )
      throw new Error('PDF source changed during figure verification')
  }
  try {
    const results = await readPdfStructureEvidence({
      document,
      sourceId,
      identity,
      readCached,
      assertCurrent: current
    })
    if (!results) return extraction
    current()
    const figureExtraction = await (async () => {
      const elements = results.flatMap((result) => result.elements)
      const owners = new Map<string, string>()
      for (const unit of source.units)
        for (const fragment of unit.fragments)
          for (const item of fragment.items) {
            const key = `${fragment.pageNumber}:${item.index}`
            if (owners.has(key)) return extraction
            owners.set(key, item.text)
          }
      const native = new Map<
        number,
        Awaited<ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['getTextContent']>>
      >()
      const viewports = new Map<number, ReturnType<PDFPageProxy['getViewport']>>()
      const graphicAnchors = new Map<number, Rect[]>()
      const claims = new Map<string, (typeof elements)[number]>()
      for (const figure of elements) {
        const pairedPanelTags =
          figure.sourceItems?.length === 2 &&
          figure.sourceItems
            .map(({ text }) => text)
            .sort()
            .join(' ') === 'a b'
        if (
          figure.kind !== 'figure' ||
          !figure.sourceItems?.length ||
          !figure.caption ||
          // This code records the native recovery mechanism, not uncertainty.
          // It never substitutes for the complete source and geometry proof below.
          figure.issues.some(
            (issue) =>
              issue.code !== 'native-raster-composite-grid' &&
              issue.code !== 'native-raster-side-by-side' &&
              issue.code !== 'native-raster-quad' &&
              issue.code !== 'native-vector-bar-chart' &&
              issue.code !== 'native-raster-horizontal-array' &&
              issue.code !== 'native-disjoint-mixed-group' &&
              !(pairedPanelTags && issue.code === 'native-raster-vector-strip')
          )
        )
          continue
        for (const item of figure.sourceItems) {
          const key = `${item.pageNumber}:${item.index}`
          if (claims.has(key) || owners.get(key) !== item.text) return extraction
          if (!native.has(item.pageNumber)) {
            current()
            const page = await document.getPage(item.pageNumber),
              viewport = page.getViewport({ scale: 1 })
            current()
            const expected = source.pages[item.pageNumber - 1]
            if (
              !expected ||
              ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
              Math.abs(viewport.width - expected.width) > 1e-6 ||
              Math.abs(viewport.height - expected.height) > 1e-6
            )
              return extraction
            viewports.set(item.pageNumber, viewport)
            native.set(item.pageNumber, await page.getTextContent())
            current()
          }
          const original = native.get(item.pageNumber)!.items[item.index]
          if (!original || !('str' in original) || original.str !== item.text) return extraction
          const style = native.get(item.pageNumber)!.styles?.[original.fontName]
          if (
            !style ||
            !Number.isFinite(style.ascent) ||
            !Number.isFinite(style.descent) ||
            style.ascent! <= 0 ||
            style.descent! > 0 ||
            style.ascent! <= style.descent!
          )
            return extraction
          const region = nativeLabelRegion(
            original,
            native.get(item.pageNumber)!.styles?.[original.fontName],
            viewports.get(item.pageNumber)!,
            item.pageNumber
          )
          if (
            !region ||
            !figure.regions.some((outer) => structureRegionContains(outer, region)) ||
            elements.some(
              (element) =>
                (element !== figure &&
                  element.regions.some((other) => structureRegionsOverlap(region, other))) ||
                element.caption?.regions.some((caption) => structureRegionsOverlap(region, caption))
            )
          )
            return extraction
          claims.set(key, figure)
        }
      }
      // Some cached generic figures have a complete crop and caption but no
      // serialized sourceItems. Recover them only when every native text item
      // inside the crop belongs to complete source units wholly contained by
      // that crop. Any mixed unit, unknown native geometry, caption overlap,
      // or competing claim leaves the figure untranslated.
      for (const figure of elements) {
        if (
          figure.kind !== 'figure' ||
          figure.sourceItems?.length ||
          !figure.caption ||
          !isFigureCaption(figure.caption.text) ||
          !isPdfTranslationCaption(figure.caption.text) ||
          !figure.thumbnailId ||
          figure.regions.length !== 1 ||
          figure.issues.some((issue) => !/^native-(?:raster|vector)-/u.test(issue.code)) ||
          figure.regions[0].width * figure.regions[0].height < 0.002 ||
          figure.regions[0].width * figure.regions[0].height > 0.8
        )
          continue
        const region = figure.regions[0]
        if (
          figure.caption.regions.some((caption) => structureRegionsOverlap(region, caption)) ||
          elements.some(
            (element) =>
              element !== figure &&
              (element.regions.some((other) => structureRegionsOverlap(region, other)) ||
                element.caption?.regions.some((caption) =>
                  structureRegionsOverlap(region, caption)
                ))
          )
        ) {
          continue
        }
        const pageNumber = region.page
        if (!native.has(pageNumber)) {
          current()
          const page = await document.getPage(pageNumber),
            viewport = page.getViewport({ scale: 1 })
          current()
          const expected = source.pages[pageNumber - 1]
          if (
            !expected ||
            ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
            Math.abs(viewport.width - expected.width) > 1e-6 ||
            Math.abs(viewport.height - expected.height) > 1e-6
          ) {
            continue
          }
          viewports.set(pageNumber, viewport)
          native.set(pageNumber, await page.getTextContent())
          current()
        }
        const content = native.get(pageNumber)!
        if (!graphicAnchors.has(pageNumber)) {
          current()
          const page = await document.getPage(pageNumber)
          try {
            const { images, vectors } = await graphicRegions(page, OPS, signal)
            graphicAnchors.set(pageNumber, [...images, ...vectors])
          } finally {
            page.cleanup()
          }
          current()
        }
        const anchors = graphicAnchors.get(pageNumber) ?? []
        const regionArea = region.width * region.height
        const hasGraphicOwnership = anchors.some((anchor) => {
          const overlapWidth = Math.max(
            0,
            Math.min(region.x + region.width, anchor.x + anchor.width) -
              Math.max(region.x, anchor.x)
          )
          const overlapHeight = Math.max(
            0,
            Math.min(region.y + region.height, anchor.y + anchor.height) -
              Math.max(region.y, anchor.y)
          )
          const overlap = overlapWidth * overlapHeight
          return overlap > 0 && overlap >= Math.min(regionArea, anchor.width * anchor.height) * 0.35
        })
        if (!hasGraphicOwnership) continue
        const insideKeys = new Set<string>()
        let complete = true
        for (const [index, item] of content.items.entries()) {
          if (!('str' in item) || !item.str.trim()) continue
          const label = nativeLabelRegion(
            item,
            content.styles?.[item.fontName],
            viewports.get(pageNumber)!,
            pageNumber
          )
          if (!label) {
            complete = false
            break
          }
          if (!structureRegionContains(region, label)) continue
          const key = `${pageNumber}:${index}`
          if (owners.get(key) !== item.str) {
            complete = false
            break
          }
          insideKeys.add(key)
        }
        if (!complete || insideKeys.size < 2) {
          continue
        }
        const units = source.units.filter((unit) =>
          unit.fragments.some((fragment) =>
            structureRegionsOverlap(region, { page: fragment.pageNumber, ...fragment.rect })
          )
        )
        const unitKeys = new Set<string>()
        for (const unit of units) {
          if (isPdfTranslationCaption(unit.source)) {
            complete = false
            break
          }
          for (const fragment of unit.fragments) {
            if (
              fragment.pageNumber !== pageNumber ||
              !structureRegionContains(region, {
                page: fragment.pageNumber,
                ...fragment.rect
              }) ||
              !fragment.items.length
            ) {
              complete = false
              break
            }
            for (const item of fragment.items) {
              const key = `${fragment.pageNumber}:${item.index}`
              if (owners.get(key) !== item.text) {
                complete = false
                break
              }
              unitKeys.add(key)
            }
            if (!complete) break
          }
          if (!complete) break
        }
        if (!complete || !insideKeys.size || [...insideKeys].some((key) => !unitKeys.has(key))) {
          continue
        }
        if ([...unitKeys].some((key) => claims.has(key) && claims.get(key) !== figure)) continue
        for (const key of unitKeys) claims.set(key, figure)
      }
      let changed = false
      const units = source.units.map((unit) => {
        if (unit.sourceOnly) return unit
        const keys = unit.fragments.flatMap((fragment) =>
          fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
        )
        const figure = claims.get(keys[0])
        if (!figure || keys.some((key) => claims.get(key) !== figure)) return unit
        // Whole source units only. A mixed prose/caption unit must remain readable;
        // no crop-based text selection, string slicing or inferred ownership here.
        const regions = unit.fragments.map((fragment) => ({
          page: fragment.pageNumber,
          ...fragment.rect
        }))
        if (
          regions.some(
            (region) =>
              !figure.regions.some((outer) => structureRegionContains(outer, region)) ||
              elements.some(
                (element) =>
                  (element !== figure &&
                    element.regions.some((other) => structureRegionsOverlap(region, other))) ||
                  element.caption?.regions.some((caption) =>
                    structureRegionsOverlap(region, caption)
                  )
              )
          )
        )
          return unit
        changed = true
        return { ...unit, sourceOnly: true as const, figure: true as const }
      })
      const originalRegions = verifiedPdfStructureRegions(
        source,
        elements
          .filter((element) => element.kind === 'figure')
          .map((element) => ({
            regions: element.regions,
            owners: new Set(
              [...claims].filter(([, owner]) => owner === element).map(([key]) => key)
            )
          })),
        new Map(
          [...native].map(([number, content]) => [
            number,
            { content, viewport: viewports.get(number)! }
          ])
        ),
        elements.flatMap((element) => element.caption?.regions ?? [])
      )
      current()
      return changed || originalRegions.length
        ? Object.freeze({
            ...extraction,
            source: carryNativeCaptionEligibility(
              source,
              createPdfTranslationSource({
                ...source,
                units,
                ...(originalRegions.length
                  ? { originalRegions: [...(source.originalRegions ?? []), ...originalRegions] }
                  : {})
              })
            )
          })
        : extraction
    })()
    const retained = await retainPdfWholeRegionSources({
      extraction: figureExtraction,
      document,
      results,
      sourceIdentity: identity,
      nativeDocumentFactory,
      signal
    })
    const restored = await restoreReferenceFigureCaptions({
      extraction: retained,
      document,
      results,
      sourceIdentity: identity,
      nativeDocumentFactory,
      signal
    })
    current()
    if (!isCurrentCaptionedMathBodyRetention(retained)) return extraction
    const ordinary = await restoreNativeOrdinaryAppendixProse({
      extraction: restored,
      document,
      sourceIdentity: identity,
      signal
    })
    current()
    if (!isCurrentCaptionedMathBodyRetention(retained)) return extraction
    const keys = await retainNativeFigureVariableKeys({
      extraction: ordinary,
      document,
      results,
      sourceIdentity: identity,
      nativeDocumentFactory,
      signal
    })
    current()
    if (!isCurrentCaptionedMathBodyRetention(retained)) return extraction
    const panels = await retainNativeFigurePanels({
      extraction: keys,
      document,
      sourceIdentity: identity,
      nativeDocumentFactory,
      signal
    })
    current()
    if (!isCurrentCaptionedMathBodyRetention(retained)) return extraction
    return isCurrentNativeFigureVariableKeys(keys) && isCurrentNativeFigurePanels(panels)
      ? panels
      : extraction
  } catch {
    signal.throwIfAborted()
    return extraction
  }
}

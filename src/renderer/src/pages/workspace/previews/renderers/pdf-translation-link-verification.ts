import {
  verifiedPdfLatinAccentText,
  pdfLinkLabelKey,
  pdfLinkLabelMatches,
  pdfLinkAddressMatches,
  pdfBracketedReferenceBlocks,
  translatedPdfBracketedReference,
  translatedPdfLinkFragment,
  translatedPdfLinkLabel,
  type PdfTranslationResults
} from '@aipoch/pdf-translation/reader'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

// A figure prefix may govern exactly two coordinated panels. Only the second
// digit is implicit; the complete ordered pair and its occurrence stay fixed.
function coordinatedPanelContinuation(
  source: string,
  translation: string,
  label: string,
  offset: number
): { start: number; panel: string } | undefined {
  if (!/^\d+$/u.test(label) || source.slice(offset, offset + label.length) !== label)
    return undefined
  const pairs = (value: string): RegExpExecArray[] =>
    [
      ...value.matchAll(
        /(?:\b(?:Figure|Fig\.?)\s*|[图圖]\s*)(\d+)[（(]\s*([A-Za-z])\s*[)）]\s*(?:and\b|和|与|與|及)\s*(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/giu
      )
    ].filter(
      (match) =>
        !/^\s*(?:[,;，；]|and\b|和|与|與|及)\s*\d/u.test(value.slice(match.index + match[0].length))
    )
  const identity = (match: RegExpExecArray): string => match.slice(1, 5).join(':')
  const digit = (match: RegExpExecArray): number =>
    match.index + match[0].search(/\d+[（(]\s*[A-Za-z]\s*[)）]\s*$/u)
  const from = pairs(source),
    reference = from.find((match) => match[3] === label && digit(match) === offset)
  if (!reference) return undefined
  const same = (match: RegExpExecArray): boolean => identity(match) === identity(reference)
  const original = from.filter(same),
    translated = pairs(translation).filter(same)
  const compoundCount = (value: string): number =>
    [...value.matchAll(/(?<![A-Za-z\d_.])(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/gu)].filter(
      (match) => match[1] === label && match[2] === reference[4]
    ).length
  if (
    original.length !== translated.length ||
    compoundCount(source) !== original.length ||
    compoundCount(translation) !== translated.length
  )
    return undefined
  const target = translated[original.indexOf(reference)]
  return target ? { start: digit(target), panel: reference[4] } : undefined
}

export const textKey = (text: string): string => text.normalize('NFC').replace(/\s/gu, '')

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type TextItem = Extract<TextContent['items'][number], { str: string }>

// Align crops to each glyph origin, so save-time coordinate rounding never
// changes raster phase; require exactly identical, nonempty native ink.
async function verifiedNativePrefixInk(
  before: TextItem,
  after: TextItem,
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  sourceStyle: TextContent['styles'][string]
): Promise<boolean> {
  if (
    typeof originalPage.render !== 'function' ||
    typeof targetPage.render !== 'function' ||
    sourceStyle.vertical ||
    !Number.isFinite(sourceStyle.ascent) ||
    !Number.isFinite(sourceStyle.descent) ||
    sourceStyle.ascent <= 0 ||
    sourceStyle.ascent > 1.5 ||
    sourceStyle.descent > 0 ||
    sourceStyle.descent < -1
  )
    return false
  const fontBounds = [sourceStyle.descent, sourceStyle.ascent]
  const pixels = async (
    page: PDFPageProxy,
    before: TextItem
  ): Promise<Uint8ClampedArray | undefined> => {
    const viewport = page.getViewport({ scale: 4 }),
      corners = [
        viewport.convertToViewportPoint(
          before.transform[4],
          before.transform[5] + before.transform[3] * fontBounds[0]
        ),
        viewport.convertToViewportPoint(
          before.transform[4] + before.width,
          before.transform[5] + before.transform[3] * fontBounds[1]
        )
      ],
      x = Math.min(...corners.map(([x]) => x)),
      y = Math.min(...corners.map(([, y]) => y)),
      width = Math.ceil(Math.max(...corners.map(([x]) => x)) - x),
      height = Math.ceil(Math.max(...corners.map(([, y]) => y)) - y)
    if (width <= 0 || height <= 0 || width * height > 262144) return undefined
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return undefined
      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, -x, -y]
      }).promise
      return context.getImageData(0, 0, width, height).data
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }
  const [original, target] = await Promise.all([
    pixels(originalPage, { ...before, width: after.width }),
    pixels(targetPage, after)
  ])
  return Boolean(
    original &&
    target &&
    original.length === target.length &&
    original.some(
      (value, index) =>
        index % 4 === 3 &&
        value > 0 &&
        original[index - 3] + original[index - 2] + original[index - 1] < 765
    ) &&
    original.every((value, index) => value === target[index])
  )
}

// A saved native link can split a merged final run. Prove every visible
// prefix with unchanged ink before accepting the finer PDF.js item boundaries.
async function verifiedNativeLinkPrefix(
  before: TextItem[],
  after: TextItem[],
  original: TextContent,
  target: TextContent,
  originalPage: PDFPageProxy,
  targetPage: PDFPageProxy,
  delta: readonly number[]
): Promise<boolean> {
  if (!before.length || before.length !== after.length) return false
  for (let index = 0; index < before.length; index++) {
    const source = before[index],
      moved = after[index],
      sourceStyle = original.styles?.[source.fontName],
      targetStyle = target.styles?.[moved.fontName],
      suffix = source.str.slice(moved.str.length)
    if (
      !moved.str.trim() ||
      ![source.width, moved.width].every((width) => Number.isFinite(width) && width > 0) ||
      (index < before.length - 1
        ? source.str !== moved.str || Math.abs(source.width - moved.width) >= 0.001
        : !source.str.startsWith(moved.str) ||
          !/^(?:\s|[,.;:)\]](?:\s|$))/u.test(suffix) ||
          moved.width >= source.width) ||
      !sourceStyle ||
      !targetStyle ||
      sourceStyle.fontFamily !== targetStyle.fontFamily ||
      targetStyle.vertical ||
      !(['ascent', 'descent'] as const).every(
        (key) => Math.abs(sourceStyle[key] - targetStyle[key]) < 0.001
      ) ||
      source.transform[0] <= 0 ||
      source.transform[3] <= 0 ||
      source.transform[1] !== 0 ||
      source.transform[2] !== 0 ||
      !source.transform
        .slice(0, 4)
        .every((value, i) => Math.abs(value - moved.transform[i]) < 0.001) ||
      ![4, 5].every(
        (axis) => Math.abs(moved.transform[axis] - source.transform[axis] - delta[axis - 4]) < 0.05
      ) ||
      !(await verifiedNativePrefixInk(source, moved, originalPage, targetPage, sourceStyle))
    )
      return false
  }
  return true
}

// Object references may change when saving. Compare destinations by page, not object ID.
export type AnnotationSnapshot = {
  type: number
  key: string
  rect: readonly number[]
  quadPoints: ArrayLike<number> | undefined
  destinationCoordinates: readonly (number | null)[]
  uri: string | undefined
}
export const sameCoordinates = (
  left: ArrayLike<number | null> | undefined,
  right: ArrayLike<number | null> | undefined
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length &&
      Array.from(left).every((value, index) =>
        value === null || right[index] === null
          ? value === right[index]
          : Number.isFinite(value) &&
            Number.isFinite(right[index]) &&
            Math.abs(value - (right[index] as number)) <= 0.001
      )

export async function annotationKey(
  document: PDFDocumentProxy,
  page: PDFPageProxy,
  original = false
): Promise<AnnotationSnapshot[]> {
  const annotations = await page.getAnnotations({ intent: 'any' })
  return Promise.all(
    annotations
      .filter((annotation) => {
        // Match the writer's original-only notes/markup policy. Never filter the generated PDF:
        // unexpected annotations there must still fail independent validation.
        const type = annotation.annotationType
        return !original || type === 2 || type < 1 || type > 16
      })
      .map(async (annotation) => {
        let dest =
          typeof annotation.dest === 'string'
            ? await document.getDestination(annotation.dest)
            : annotation.dest
        // Extracted pages can keep names whose targets are outside the document.
        // Preserve their identity instead of treating every missing target as null.
        const unresolvedDestination =
          typeof annotation.dest === 'string' && dest === null ? annotation.dest : undefined
        if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object')
          dest = [await document.getPageIndex(dest[0]), ...dest.slice(1)]
        const coordinateCount = Array.isArray(dest)
          ? (({ XYZ: 2, FitH: 1, FitBH: 1, FitV: 1, FitBV: 1, FitR: 4 } as Record<string, number>)[
              dest[1]?.name
            ] ?? 0)
          : 0
        const destinationCoordinates = coordinateCount ? dest.slice(2, 2 + coordinateCount) : []
        // Only positions have point-based tolerance; destination page, mode, nulls
        // and zoom retain their exact meaning.
        if (coordinateCount)
          dest = [
            ...dest.slice(0, 2),
            ...destinationCoordinates.map(() => null),
            ...dest.slice(2 + coordinateCount)
          ]
        const borderStyle = annotation.borderStyle && { ...annotation.borderStyle }
        // PDFium serializes border widths through float32; all other metadata stays exact.
        for (const key of ['width', 'rawWidth'])
          if (
            borderStyle &&
            typeof borderStyle[key] === 'number' &&
            borderStyle[key] >= 0 &&
            Number.isFinite(Math.fround(borderStyle[key]))
          )
            borderStyle[key] = Math.fround(borderStyle[key])
        return {
          type: annotation.annotationType,
          destinationCoordinates,
          rect: annotation.rect,
          quadPoints: annotation.quadPoints,
          uri: annotation.unsafeUrl ?? annotation.url,
          key: JSON.stringify({
            type: annotation.annotationType,
            color: annotation.color,
            borderStyle,
            flags: annotation.annotationFlags,
            url: annotation.url,
            unsafeUrl: annotation.unsafeUrl,
            newWindow: annotation.newWindow,
            hasAppearance: annotation.hasAppearance,
            unresolvedDestination,
            dest
          })
        }
      })
  )
}

type PageLinkVerification = Readonly<{
  number: number
  sourcePage: PDFPageProxy
  translatedPage: PDFPageProxy
  source: ReturnType<PDFPageProxy['getViewport']>
  target: ReturnType<PDFPageProxy['getViewport']>
  originalText: TextContent
  text: TextContent
  hidden: { source: ReadonlySet<number>; target: ReadonlySet<number> } | undefined
  sourceAnnotations: readonly AnnotationSnapshot[]
  targetAnnotations: readonly AnnotationSnapshot[]
  documentSource: PdfTranslationResults['source']
  units: PdfTranslationResults['source']['units']
  renderUnits: readonly { readonly translation: string }[]
  canRetainLinks: boolean
  originalLinkOwners: ReadonlyMap<number, ReadonlyMap<number, string>>
  preservedIds: ReadonlySet<string>
  acceptedById: ReadonlyMap<string, PdfTranslationResults['units'][number]>
  unchanged: (unitIndex: number) => boolean
  validationError: (details: string) => Error
}>

export async function verifyPdfTranslationLinks({
  number,
  sourcePage,
  translatedPage,
  source,
  target,
  originalText,
  text,
  hidden,
  sourceAnnotations,
  targetAnnotations,
  documentSource,
  units,
  renderUnits,
  canRetainLinks,
  originalLinkOwners,
  preservedIds,
  acceptedById,
  unchanged,
  validationError
}: PageLinkVerification): Promise<{
  pageLatinAccentText: ReadonlyMap<TextItem, string>
  pendingRetentions: ReadonlyMap<number, string>
}> {
  // A moved link keeps its original label/action and stays within one source
  // paragraph. References can legitimately repeat within that paragraph;
  // full translated text is verified independently below.
  // Reuse the page's verified Form exclusions without changing native item
  // indices, which still identify the original owners below.
  const visibleSourceItems = hidden
      ? originalText.items.filter((_, index) => !hidden.source.has(index))
      : originalText.items,
    visibleTargetItems = hidden
      ? text.items.filter((_, index) => !hidden.target.has(index))
      : text.items
  const linkedItems = (
    content: TextContent,
    rect: readonly number[],
    intersect = false
  ): TextItem[] =>
    (content === text ? visibleTargetItems : visibleSourceItems).flatMap((item) => {
      if (!('str' in item) || !item.str.trim()) return []
      const [a, b, , , x, y] = item.transform,
        point = Math.hypot(a, b)
      if (!Number.isFinite(point) || point <= 0) return []
      const points = [
        [x - b * 0.3, y + a * 0.3],
        [x + (a / point) * item.width - b * 0.3, y + (b / point) * item.width + a * 0.3]
      ]
      const contained = points.every(
        ([px, py]) =>
          px >= rect[0] - 1 && px <= rect[2] + 1 && py >= rect[1] - 1 && py <= rect[3] + 1
      )
      const crosses =
        Math.min(...points.map(([, py]) => py)) <= rect[3] + 1 &&
        Math.max(...points.map(([, py]) => py)) >= rect[1] - 1 &&
        Math.min(...points.map(([px]) => px)) <= rect[2] + 1 &&
        Math.max(...points.map(([px]) => px)) >= rect[0] - 1
      return contained || (intersect && crosses) ? [item] : []
    })
  const pageLatinAccentText = new Map<TextItem, string>()
  let latinAccentText = new Map<TextItem, string>()
  const linkedText = (content: typeof text, rect: readonly number[], intersect = false): string =>
    textKey(
      linkedItems(content, rect, intersect)
        .map((item) => latinAccentText.get(item) ?? item.str)
        .join('')
    )
  if (sourceAnnotations.length !== targetAnnotations.length)
    throw validationError('PDF annotations changed')
  // Identify a fresh recovery attempt for this page. Any unproved link
  // failure still takes the ordinary original-page fallback.
  const pendingRetentions = new Map<number, string>()
  const pendingOwners = new Set<string>()
  for (const [index, annotation] of sourceAnnotations.entries()) {
    const moved = targetAnnotations[index]
    if (
      annotation.key !== moved.key ||
      !sameCoordinates(annotation.quadPoints, moved.quadPoints) ||
      !sameCoordinates(annotation.destinationCoordinates, moved.destinationCoordinates)
    )
      throw validationError('PDF annotations changed')
    if (sameCoordinates(annotation.rect, moved.rect)) continue
    if (originalLinkOwners.get(number)?.has(index)) throw validationError('Retained PDF link moved')
    if (
      annotation.type !== 2 ||
      annotation.quadPoints?.length ||
      [annotation.rect, moved.rect].some(
        (rect) =>
          rect.length !== 4 ||
          !rect.every(Number.isFinite) ||
          rect[2] <= rect[0] ||
          rect[3] <= rect[1]
      ) ||
      Math.abs(annotation.rect[2] - annotation.rect[0] - moved.rect[2] + moved.rect[0]) > 0.001 ||
      Math.abs(annotation.rect[3] - annotation.rect[1] - moved.rect[3] + moved.rect[1]) > 0.001
    )
      throw validationError('PDF link geometry changed')
    const retainLink = (): boolean => {
      if (!canRetainLinks) return false
      // A lowered prime from the next line can fall inside the label read
      // tolerance. It cannot claim a source link above its anchor.
      const hit = linkedItems(originalText!, annotation.rect, true).filter((item) => {
          const [a, b, , , , y] = item.transform
          return b !== 0 || !/^[′″‴⁗]+$/u.test(item.str.trim()) || y + a * 0.3 >= annotation.rect[1]
        }),
        claims = documentSource.units.flatMap((unit) =>
          unit.fragments.flatMap((fragment) =>
            fragment.pageNumber === number &&
            fragment.items.some((part) => hit.includes(originalText!.items[part.index] as TextItem))
              ? [{ unit, fragment }]
              : []
          )
        )
      // If this paragraph is already queued, keep another original
      // link only when the sole competing claim is an exact, source-only
      // closing delimiter on the following line.
      const candidates = claims.filter(({ unit }) => pendingOwners.has(unit.id))
      const candidate = claims.length === 1 ? claims[0] : candidates[0]
      const neighbor = claims.find((claim) => claim !== candidate)
      const delimiter = neighbor?.fragment.items[0]
      const nativeDelimiter = delimiter && originalText!.items[delimiter.index]
      const alreadyRetaining =
        candidate &&
        claims.length === 2 &&
        candidates.length === 1 &&
        neighbor?.unit.sourceOnly &&
        neighbor.unit.fragments.length === 1 &&
        neighbor.fragment.items.length === 1 &&
        delimiter &&
        nativeDelimiter &&
        'str' in nativeDelimiter &&
        /^[)）\]］]$/u.test(nativeDelimiter.str) &&
        delimiter.text === nativeDelimiter.str &&
        neighbor.unit.source === nativeDelimiter.str &&
        nativeDelimiter.transform[1] === 0 &&
        hit.includes(nativeDelimiter) &&
        hit.some(
          (item) =>
            item.transform[1] === 0 &&
            item.transform[5] > nativeDelimiter.transform[5] &&
            candidate.fragment.items.some(
              (part) => originalText!.items[part.index] === item && part.text === item.str
            )
        )
      if (hit.length && candidate && (claims.length === 1 || alreadyRetaining)) {
        const { unit, fragment } = candidate
        const inside = [
          source.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
          source.convertToViewportPoint(annotation.rect[2], annotation.rect[3])
        ].every(
          ([x, y]) =>
            x >= fragment.rect.x * source.width - 2 &&
            x <= (fragment.rect.x + fragment.rect.width) * source.width + 2 &&
            y >= fragment.rect.y * source.height - 2 &&
            y <= (fragment.rect.y + fragment.rect.height) * source.height + 2
        )
        // A printed author link can extend vertically past its native row.
        // Use only the original link and exact original owner on retry.
        const originalAuthor = (() => {
          if (
            inside ||
            hit.length !== 1 ||
            source.rotation !== 0 ||
            annotation.uri ||
            !annotation.destinationCoordinates.length
          )
            return false
          const item = hit[0],
            [a, b, c, d, x, y] = item.transform,
            [left, bottom, right, top] = annotation.rect,
            [start, anchor] = source.convertToViewportPoint(x, y + a * 0.3),
            [end] = source.convertToViewportPoint(x + item.width, y + a * 0.3),
            [boxLeft, boxTop] = source.convertToViewportPoint(left, top),
            [boxRight, boxBottom] = source.convertToViewportPoint(right, bottom),
            owner = fragment.rect,
            ownerTop = owner.y * source.height,
            ownerBottom = (owner.y + owner.height) * source.height,
            center = (boxTop + boxBottom) / 2
          return (
            a > 0 &&
            a === d &&
            b === 0 &&
            c === 0 &&
            /^\([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/u.test(item.str) &&
            item.width > a &&
            boxLeft >= start &&
            boxLeft - start <= (end - start) / 10 &&
            boxRight >= end &&
            boxRight - end <= (end - start) / 10 &&
            boxLeft >= owner.x * source.width - 2 &&
            boxRight <= (owner.x + owner.width) * source.width + 2 &&
            anchor >= ownerTop &&
            anchor <= ownerBottom &&
            center >= ownerTop &&
            center <= ownerBottom &&
            anchor >= boxTop &&
            anchor <= boxBottom &&
            top - bottom <= a * 2
          )
        })()
        if (
          (inside || originalAuthor) &&
          (pendingOwners.size < 8 || pendingOwners.has(unit.id)) &&
          !preservedIds.has(unit.id) &&
          !unit.sourceOnly &&
          acceptedById.has(unit.id) &&
          acceptedById.get(unit.id)!.translation !== unit.source &&
          hit.every(
            (item) =>
              fragment.items.some(
                (part) => originalText!.items[part.index] === item && part.text === item.str
              ) ||
              (alreadyRetaining && item === nativeDelimiter)
          )
        ) {
          pendingRetentions.set(index, unit.id)
          pendingOwners.add(unit.id)
          return true
        }
      }
      return false
    }
    latinAccentText = verifiedPdfLatinAccentText(
      originalText,
      text,
      linkedItems(originalText, annotation.rect, true),
      linkedItems(text, moved.rect, true),
      annotation.rect,
      moved.rect
    )
    for (const [item, value] of latinAccentText) pageLatinAccentText.set(item, value)
    // PDF.js may combine a source link with surrounding prose. Require the
    // exact target label once in the intersecting source run and its owner.
    let label = linkedText(text, moved.rect)
    if (!label) {
      // Some links cover only the digit inside one native "[3]" run.
      // Accept its overhang only when the complete unchanged run and
      // its exact position relative to the hit area move together.
      const before = linkedItems(originalText, annotation.rect, true).filter((item) =>
          item.str.trim()
        ),
        after = linkedItems(text, moved.rect, true).filter((item) => item.str.trim())
      if (
        before.length === 1 &&
        after.length === 1 &&
        /^\[\d+(?:[,–-]\d+)*\]$/u.test(textKey(before[0].str)) &&
        textKey(before[0].str) === textKey(after[0].str) &&
        Math.abs(before[0].width - after[0].width) < 0.01 &&
        before[0].transform
          .slice(0, 4)
          .every((value, i) => Math.abs(value - after[0].transform[i]) < 0.01) &&
        [0, 1].every(
          (axis) =>
            Math.abs(
              after[0].transform[4 + axis] -
                before[0].transform[4 + axis] -
                moved.rect[axis] +
                annotation.rect[axis]
            ) < 0.01
        )
      )
        label = textKey(after[0].str)
    }
    if (!label) {
      // A dated year link may cover its localized closing bracket. Keep
      // only its original right overhang, proven by the complete native
      // source suffix and the same unique author/year paragraph.
      const after = linkedItems(text, moved.rect, true).filter((item) =>
        /^\d{4}[a-z]?[)）]$/u.test(item.str)
      )
      if (after.length === 1) {
        const item = after[0],
          candidates = units.filter((unit, unitIndex) => {
            const translation = renderUnits[unitIndex].translation,
              at = translation.indexOf(item.str),
              from = translatedPdfLinkFragment(translation, unit.source, item.str, at)
            if (
              unchanged(unitIndex) ||
              at < 0 ||
              translation.lastIndexOf(item.str) !== at ||
              !from ||
              unit.source.indexOf(from.text) !== from.start ||
              unit.source.lastIndexOf(from.text) !== from.start
            )
              return false
            const before = linkedItems(originalText!, annotation.rect, true).filter(
              (sourceItem) =>
                sourceItem.str.endsWith(from.text) &&
                unit.fragments.some(
                  (fragment) =>
                    fragment.pageNumber === number &&
                    fragment.items.some(
                      (claimed) =>
                        originalText!.items[claimed.index] === sourceItem &&
                        textKey(claimed.text) === textKey(sourceItem.str)
                    )
                )
            )
            if (before.length !== 1) return false
            const original = before[0],
              right = original.transform[4] + original.width - annotation.rect[2],
              pointY = item.transform[5] + item.transform[0] * 0.3
            return (
              [original, item].every(
                (glyph) =>
                  glyph.transform[0] > 0 && glyph.transform[1] === 0 && glyph.transform[2] === 0
              ) &&
              right > 0 &&
              right <= original.transform[0] * 0.5 &&
              item.transform[4] >= moved.rect[0] - 1 &&
              item.transform[4] + item.width <= moved.rect[2] + right + 0.001 &&
              pointY >= moved.rect[1] - 1 &&
              pointY <= moved.rect[3] + 1
            )
          })
        if (candidates.length === 1) label = item.str
      }
    }
    if (!label) {
      // PDF.js can combine the original citation with surrounding prose.
      // A comma-separated numeric run may span several smaller hit areas;
      // every member must move together and retain its source label/action.
      const citationRun = (rect: readonly number[]): string => {
        const items = linkedItems(text, rect, true).filter((item) =>
          /^\d+(?:,\d+)+$/u.test(textKey(item.str))
        )
        return items.length === 1 ? textKey(items[0].str) : ''
      }
      const run = citationRun(moved.rect),
        dx = moved.rect[0] - annotation.rect[0],
        dy = moved.rect[1] - annotation.rect[1],
        group = targetAnnotations.flatMap((candidate, position) =>
          citationRun(candidate.rect) === run ? [position] : []
        )
      if (
        /^\d+(?:,\d+)+$/u.test(run) &&
        group.length === run.split(',').length &&
        group.every((position) => {
          const from = sourceAnnotations[position],
            to = targetAnnotations[position]
          return (
            from.type === 2 &&
            to.type === 2 &&
            from.key === to.key &&
            linkedText(originalText!, from.rect, true).split(run).length === 2 &&
            Math.abs(to.rect[0] - from.rect[0] - dx) <= 0.001 &&
            Math.abs(to.rect[1] - from.rect[1] - dy) <= 0.001
          )
        })
      )
        label = run
    }
    let nativeUriLabel = ''
    let nativeUriOwner: (typeof units)[number] | undefined
    if (annotation.uri) {
      // Wrapped URI pieces can keep a small native glyph overhang outside
      // their hit areas. Prove the complete action and rigidly preserved
      // piece, never a substring cut out of translated surrounding prose.
      const group = sourceAnnotations.filter((part) => part.uri === annotation.uri),
        owners = units.flatMap((unit, unitIndex) => {
          const matches = (value: string): number =>
              pdfLinkAddressMatches(value.replace(/\b(https?:) +(?=\/\/)/gu, '$1')).filter(
                (address) => address.text.replace(/ /gu, '') === annotation.uri
              ).length,
            native = unit.fragments.flatMap((fragment) =>
              fragment.pageNumber !== number
                ? []
                : fragment.items.flatMap((claimed) => {
                    const item = originalText!.items[claimed.index]
                    return item && 'str' in item && claimed.text === item.str ? [item] : []
                  })
            ),
            joined = native.map((item) => textKey(item.str)).join(''),
            start = joined.indexOf(annotation.uri!)
          if (
            unchanged(unitIndex) ||
            matches(unit.source) !== 1 ||
            matches(renderUnits[unitIndex].translation) !== 1 ||
            unit.fragments.some(
              (fragment) =>
                fragment.pageNumber !== number ||
                fragment.items.some((claimed) => {
                  const item = originalText!.items[claimed.index]
                  return !item || !('str' in item) || claimed.text !== item.str
                })
            ) ||
            start < 0 ||
            joined.lastIndexOf(annotation.uri!) !== start
          )
            return []
          let cursor = 0
          const owned = native.filter((item) => {
            const from = cursor
            cursor += textKey(item.str).length
            return from >= start && cursor <= start + annotation.uri!.length
          })
          return [{ unit, owned }]
        }),
        pieces = group.map((part) =>
          linkedItems(originalText!, part.rect, true).filter(
            (item) => owners.length === 1 && owners[0].owned.includes(item)
          )
        ),
        before = linkedItems(originalText, annotation.rect, true).filter(
          (item) => owners.length === 1 && owners[0].owned.includes(item)
        ),
        after = linkedItems(text, moved.rect, true).filter(
          (item) => before.length === 1 && item.str === before[0].str
        )
      if (
        group.length > 1 &&
        textKey(pieces.flatMap((runs) => runs.map((item) => item.str)).join('')) ===
          annotation.uri &&
        owners.length === 1 &&
        pieces.every((runs) => runs.length === 1) &&
        before.length === 1 &&
        after.length === 1 &&
        (!label || label === textKey(before[0].str)) &&
        Boolean(originalText.styles[before[0].fontName]) &&
        JSON.stringify(originalText.styles[before[0].fontName]) ===
          JSON.stringify(text.styles[after[0].fontName]) &&
        Math.abs(before[0].width - after[0].width) < 0.01 &&
        before[0].transform
          .slice(0, 4)
          .every((value, i) => Math.abs(value - after[0].transform[i]) < 0.01) &&
        [0, 1].every(
          (axis) =>
            Math.abs(
              after[0].transform[4 + axis] -
                before[0].transform[4 + axis] -
                moved.rect[axis] +
                annotation.rect[axis]
            ) < 0.01
        )
      ) {
        nativeUriOwner = owners[0].unit
        nativeUriLabel = before[0].str
        label = textKey(nativeUriLabel)
      }
    }
    const originalRun = linkedText(originalText, annotation.rect, true)
    // PDF.js can serialize a linked number with an opening bracket, trailing
    // comma or closing bracket. Its closed citation still has to pass the ordered proof below.
    const delimiterLabel = /^(\d{1,4})([,，\]］])$/u.exec(label)
    const openingLabel = /^([[［])(\d{1,4})$/u.exec(label)
    const mergedNumber = delimiterLabel?.[1] ?? openingLabel?.[2]
    const mergedHit = mergedNumber ? linkedItems(text, moved.rect) : []
    const mergedDelimiter =
      mergedNumber &&
      mergedHit.length === 1 &&
      pdfBracketedReferenceBlocks(originalRun).some((block) =>
        openingLabel
          ? block.numbers[0]?.[0] === mergedNumber
          : block.numbers.some((token) => token[0] === mergedNumber)
      )
    if (mergedDelimiter) label = mergedNumber
    const key = pdfLinkLabelKey(label)
    const fragmentLabels = originalRun.includes(label)
      ? []
      : units.flatMap((unit, unitIndex) => {
          const rawTranslation = renderUnits[unitIndex].translation,
            translated = textKey(rawTranslation),
            result: string[] = [],
            positions: number[] = []
          // Link extraction omits spaces, but author word boundaries are
          // part of the saved citation identity. Project only whitespace
          // removal in already-NFC text; composition has no offset proof.
          if (rawTranslation.normalize('NFC') === rawTranslation)
            for (let index = 0; index < rawTranslation.length; index++)
              if (!/\s/u.test(rawTranslation[index])) positions.push(index)
          for (
            let at = translated.indexOf(label);
            label && at >= 0;
            at = translated.indexOf(label, at + label.length)
          ) {
            const start = positions[at],
              end = positions[at + label.length - 1],
              rawLabel =
                start === undefined || end === undefined
                  ? undefined
                  : rawTranslation.slice(start, end + 1),
              rawFragment =
                start !== undefined && rawLabel && textKey(rawLabel) === label
                  ? (translatedPdfLinkFragment(rawTranslation, unit.source, rawLabel, start) ??
                    translatedPdfLinkLabel(
                      rawTranslation,
                      unit.source,
                      rawLabel,
                      start,
                      annotation.uri
                    ))
                  : undefined,
              fragment =
                rawFragment ??
                translatedPdfLinkFragment(translated, unit.source, label, at) ??
                translatedPdfLinkLabel(translated, unit.source, label, at)
            if (fragment) result.push(textKey(fragment.text))
          }
          return result
        })
    const originalLabel = [
      ...new Set(
        [
          ...originalRun.matchAll(
            /(?:(?:Table|Tab\.|Figure|Fig\.)\d+|(?:Suppl\.|Supplementary)Appendix|[“”"]\d+)(?![A-Za-z\d]|[.．,，–—−-]\d)/giu
          )
        ]
          .filter((match) => key !== null && pdfLinkLabelKey(match[0]) === key)
          .map((match) => match[0])
          .concat(
            units.flatMap((unit) =>
              pdfLinkLabelMatches(unit.source, label).map((match) => textKey(match[0]))
            ),
            fragmentLabels
          )
      )
    ].filter((candidate) => originalRun.split(candidate).length === 2)
    const sourceLabel =
      originalLabel.length === 1
        ? originalLabel[0]
        : key?.startsWith('panel:')
          ? label.normalize('NFKC')
          : label
    // A merged native line may cite the same year more than once. Prove
    // all numeric/panel hit areas together in their source left-to-right order;
    // a missing link, changed year, or swapped distinct label fails closed.
    let repeatedNumericLabel = false
    const referenceNumber = /^\d+(?:\.\d+)*(?:[a-z]|\([A-Za-z]\))?$/u
    // Substrings in quantities/decimals/identifiers are not occurrences
    // of a citation label: the 8 in "80% ... [8]" is a different token.
    // A compact equation reference has an explicit prefix before its digit.
    const numericTokens = (value: string): RegExpExecArray[] => [
      ...value
        .normalize('NFKC')
        .matchAll(
          /(?:(?<![A-Za-z\d.])|(?<=\bEq\.))\d+(?:\.\d+)*(?:[a-z]|\([A-Za-z]\))?(?![A-Za-z\d])/gu
        )
    ]
    const numericOccurrences = referenceNumber.test(sourceLabel)
      ? numericTokens(
          (() => {
            const items = linkedItems(originalText, annotation.rect, true)
            const [period, year] = items
            // The tolerance around a hit can include the period in
            // "et al.". Preserve its real native space before the year.
            if (
              !annotation.uri &&
              annotation.destinationCoordinates.length > 0 &&
              items.length === 2 &&
              period.str === '.' &&
              /^[12]\d{3}\](?:\s|$)/u.test(year.str) &&
              [period, year].every(({ transform: [a, b, c] }) => a > 0 && b === 0 && c === 0) &&
              Math.abs(period.transform[5] - year.transform[5]) < 0.01 &&
              period.transform[4] + period.width < annotation.rect[0] &&
              year.transform[4] >= annotation.rect[0] &&
              year.transform[4] < annotation.rect[2]
            ) {
              const index = originalText.items.indexOf(period)
              const space = originalText.items[index + 1]
              if (
                space &&
                'str' in space &&
                /^ +$/u.test(space.str) &&
                originalText.items[index + 2] === year
              )
                return `. ${year.str}`
            }
            return items.map((item) => item.str).join('')
          })()
        ).filter((match) => match[0] === sourceLabel).length
      : 0
    // A linked number belongs to its full closed citation, not a
    // month elsewhere in this paragraph. Prove its ordinal on the
    // actual translated native row as well as in the saved text.
    const bracketedSources = /^\d{1,4}$/u.test(sourceLabel)
      ? units.filter(
          (unit, unitIndex) =>
            !unchanged(unitIndex) &&
            pdfBracketedReferenceBlocks(unit.source).some((block) =>
              block.numbers.some((token) => token[0] === sourceLabel)
            ) &&
            unit.fragments.some(
              (fragment) =>
                fragment.pageNumber === number &&
                fragment.items.some((claimed) =>
                  linkedItems(originalText!, annotation.rect, true).some(
                    (item) =>
                      originalText!.items[claimed.index] === item &&
                      textKey(claimed.text) === textKey(item.str)
                  )
                )
            )
        )
      : []
    // A year linked inside an author citation must not be reclassified
    // by a pure [2019] elsewhere in the same paragraph. Only a complete
    // source block mapped to this annotation's exact native run applies.
    const nativeBracketedSources = bracketedSources.filter((unit) => {
      const claimed = unit.fragments
          .filter((fragment) => fragment.pageNumber === number)
          .flatMap((fragment) => fragment.items),
        sourceItems = [...new Set(claimed.map((part) => part.index))].map(
          (index) => originalText!.items[index]
        )
      if (
        claimed.some((part) => {
          const item = originalText!.items[part.index]
          return !item || !('str' in item) || textKey(part.text) !== textKey(item.str)
        })
      )
        return true
      const native = sourceItems.map((item) => ('str' in item ? item.str : '')).join(''),
        proofs = pdfBracketedReferenceBlocks(unit.source).flatMap((block) =>
          block.numbers
            .filter((token) => token[0] === sourceLabel)
            .map((token) =>
              translatedPdfBracketedReference(
                unit.source,
                native,
                sourceLabel,
                block.start + token.index
              )
            )
        )
      const linked = linkedItems(originalText!, annotation.rect, true)
      if (!proofs.length || proofs.some((proof) => !proof)) {
        // A same-number citation on a different page cannot name the
        // sole occurrence in a native figure-panel line. The panel
        // still has to pass its own translated label and geometry proof.
        if (
          annotation.uri ||
          !annotation.destinationCoordinates.length ||
          linked.length !== 1 ||
          !unit.fragments.some((fragment) => fragment.pageNumber !== number) ||
          pdfBracketedReferenceBlocks(native).some((block) =>
            block.numbers.some((token) => token[0] === sourceLabel)
          )
        )
          return true
        const line = linked[0].str,
          occurrences = [...line.matchAll(/\d+/gu)].filter((match) => match[0] === sourceLabel),
          panels = [...line.matchAll(/\b(?:Figure|Fig\.?)\s*(\d+)[A-Za-z](?![A-Za-z\d])/giu)]
        return !(occurrences.length === 1 && panels.some((match) => match[1] === sourceLabel))
      }
      let cursor = 0
      return sourceItems.some((item) => {
        const start = cursor
        cursor += 'str' in item ? item.str.length : 0
        return (
          linked.includes(item as TextItem) &&
          proofs.some(
            (proof) => start < proof!.targetBlock.end && cursor > proof!.targetBlock.start
          )
        )
      })
    })
    const bracketedOwners = nativeBracketedSources.filter((unit) => {
      const unitIndex = units.indexOf(unit),
        translation = renderUnits[unitIndex].translation
      // One serialized native item can carry a digit and exactly one
      // boundary delimiter. Its identity is still proved below by the
      // complete closed vector, its occurrence and the same owner.
      const numericHit = (
        items: TextItem[]
      ):
        | {
            linked: TextItem[]
            label: string
            open: string
            close: string
            comma?: string
          }
        | undefined => {
        const linked =
          items.length > 1 && /^[,，]$/u.test(textKey(items.at(-1)!.str))
            ? items.slice(0, -1)
            : items
        const label = textKey(linked.map((item) => item.str).join(''))
        if (/^\d{1,4}$/u.test(label)) return { linked, label, open: '', close: '' }
        if (items.length !== 1) return
        const comma = label.match(/^(\d{1,4})([,，])$/u)
        if (comma)
          return {
            linked,
            label: comma[1],
            open: '',
            close: '',
            comma: comma[2]
          }
        const opening = label.match(/^([[［])(\d{1,4})$/u),
          closing = label.match(/^(\d{1,4})([\]］])$/u)
        return opening
          ? { linked, label: opening[2], open: opening[1], close: '' }
          : closing
            ? { linked, label: closing[1], open: '', close: closing[2] }
            : undefined
      }
      const located = (rect: readonly number[], token: string, offset: number): boolean => {
        const hit = linkedItems(text, rect),
          numeric = numericHit(hit)
        if (!numeric || numeric.label !== token) return false
        const linked = numeric.linked
        const first = linked[0],
          within = (item: TextItem, fragment: (typeof unit.fragments)[number]): boolean =>
            [
              target.convertToViewportPoint(item.transform[4], item.transform[5]),
              target.convertToViewportPoint(item.transform[4] + item.width, item.transform[5])
            ].every(
              ([x, y]) =>
                x >= fragment.rect.x * target.width - 1 &&
                x <= (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                y >= fragment.rect.y * target.height - 1 &&
                y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
            ),
          owners = unit.fragments.filter(
            (fragment) =>
              fragment.pageNumber === number && linked.every((item) => within(item, fragment))
          )
        if (owners.length !== 1) return false
        const owner = owners[0],
          candidates = visibleTargetItems.flatMap((item) => {
            if (
              !('str' in item) ||
              !item.str.trim() ||
              item.transform[0] <= 0 ||
              item.transform[1] !== 0 ||
              item.transform[2] !== 0
            )
              return []
            return within(item, owner) ? [item] : []
          }),
          local = candidates
            .filter(
              (item) =>
                Math.abs(item.transform[5] - first.transform[5]) <=
                Math.min(item.transform[0], first.transform[0]) * 0.3
            )
            .sort((a, b) => a.transform[4] - b.transform[4]),
          rows = [
            local,
            [...candidates].sort((a, b) =>
              Math.abs(a.transform[5] - b.transform[5]) >
              Math.max(a.transform[0], b.transform[0]) * 0.3
                ? b.transform[5] - a.transform[5]
                : a.transform[4] - b.transform[4]
            )
          ]
        // Anchor a single-row citation to its own digits. A pairwise
        // font-size comparator can place unrelated lowered math inside it.
        return rows.some((row, rowIndex) => {
          let cursor = 0
          const spans = row.map((item) => {
              const start = cursor
              cursor += textKey(item.str).length
              return { item, start, end: cursor }
            }),
            line = textKey(row.map((item) => item.str).join('')),
            actual = spans.filter((span) => linked.includes(span.item)),
            full = translatedPdfBracketedReference(unit.source, translation, token, offset)
          if (actual.length !== linked.length || !full) return false
          const before = textKey(translation.slice(full.targetBlock.start, full.start)),
            after = textKey(translation.slice(full.end, full.targetBlock.end))
          if (
            (numeric.open && before !== numeric.open) ||
            (numeric.close && after !== numeric.close) ||
            (numeric.comma && !after.startsWith(numeric.comma))
          )
            return false
          const block = textKey(full.targetBlock.text),
            blockStart = actual[0].start + numeric.open.length - before.length
          if (
            blockStart < 0 ||
            line.slice(blockStart, blockStart + block.length) !== block ||
            actual.at(-1)!.end - actual[0].start !==
              token.length +
                numeric.open.length +
                numeric.close.length +
                (numeric.comma?.length ?? 0)
          )
            return false
          const parts = spans.filter(
            (span) => span.start < blockStart + block.length && span.end > blockStart
          )
          // A preserved hit area can also cover the following comma.
          // It must belong to this exact closed vector, never nearby prose.
          if (hit.some((item) => !parts.some((part) => part.item === item))) return false
          if (
            rowIndex === 0 &&
            candidates.some(
              (item) =>
                !local.includes(item) &&
                parts.some(
                  ({ item: part }) =>
                    Math.abs(item.transform[5] - part.transform[5]) <
                      Math.max(item.transform[0], part.transform[0]) * 0.65 &&
                    item.transform[4] < part.transform[4] + part.width &&
                    item.transform[4] + item.width > part.transform[4]
                )
            )
          )
            return false
          return parts.every((part, index) => {
            if (!index) return true
            const previous = parts[index - 1].item,
              size = Math.max(part.item.transform[0], previous.transform[0]),
              rise = previous.transform[5] - part.item.transform[5],
              gap = part.item.transform[4] - previous.transform[4] - previous.width
            if (Math.abs(rise) <= size * 0.3)
              return gap >= -first.transform[0] * 0.05 && gap <= first.transform[0] * 0.5
            // A full native citation may wrap at a comma. Keep it in
            // this one owned region and prove adjacent row-end/start
            // geometry; no intervening text may enter the exact block.
            return (
              rise >= size * 0.65 &&
              rise <= size * 1.6 &&
              ((/[,，–[［-]$/u.test(textKey(previous.str)) &&
                /^[\d\]］]/u.test(textKey(part.item.str))) ||
                (/\d$/u.test(textKey(previous.str)) && /^[-–]/u.test(textKey(part.item.str)))) &&
              previous.transform[4] + previous.width >=
                (owner.rect.x + owner.rect.width) * target.width - size * 3 &&
              Math.abs(part.item.transform[4] - owner.rect.x * target.width) <= size * 0.5
            )
          })
        })
      }
      const claimed = unit.fragments.filter((f) => f.pageNumber === number).flatMap((f) => f.items),
        indices = [...new Set(claimed.map((part) => part.index))],
        sourceItems = indices.map((index) => originalText!.items[index])
      if (
        claimed.some((part) => {
          const item = originalText!.items[part.index]
          return !item || !('str' in item) || textKey(part.text) !== textKey(item.str)
        })
      )
        return false
      const sourceLine = sourceItems.map((item) => ('str' in item ? item.str : '')).join('')
      for (const occurrence of unit.source.matchAll(
        new RegExp(`(?<!\\d)${sourceLabel}(?!\\d)`, 'gu')
      )) {
        const full = translatedPdfBracketedReference(
            unit.source,
            translation,
            sourceLabel,
            occurrence.index
          ),
          nativeSource = translatedPdfBracketedReference(
            unit.source,
            sourceLine,
            sourceLabel,
            occurrence.index
          )
        if (!full || !nativeSource || !located(moved.rect, sourceLabel, occurrence.index)) continue
        let cursor = 0
        const owned = sourceItems.filter((item) => {
            const start = cursor
            cursor += 'str' in item ? item.str.length : 0
            return start < nativeSource.targetBlock.end && cursor > nativeSource.targetBlock.start
          }),
          digitOwners = new Set<TextItem>(),
          // One merged native line can contain the same complete
          // citation twice. Prove all linked blocks in that run together;
          // the full helper keeps their occurrence and numeric ordinals.
          blockKey = pdfBracketedReferenceBlocks(nativeSource.targetBlock.text)[0]?.key,
          records = pdfBracketedReferenceBlocks(unit.source).flatMap((block) => {
            const first = block.numbers[0],
              proof = translatedPdfBracketedReference(
                unit.source,
                sourceLine,
                first[0],
                block.start + first.index
              )
            if (!proof) return []
            const digits = pdfBracketedReferenceBlocks(proof.targetBlock.text)[0]?.numbers ?? []
            let cursor = 0
            const runs = sourceItems.filter((item): item is TextItem => {
              const start = cursor
              cursor += 'str' in item ? item.str.length : 0
              return (
                'str' in item &&
                digits.some(
                  (digit) =>
                    start < proof.targetBlock.start + digit.index + digit[0].length &&
                    cursor > proof.targetBlock.start + digit.index
                )
              )
            })
            return [{ block, runs }]
          }),
          selectedRecords = new Set<(typeof records)[number]>(),
          sharedRuns = new Set(owned),
          sharedKeys = new Set([blockKey])
        let expanded = true
        while (expanded) {
          expanded = false
          for (const record of records) {
            if (
              selectedRecords.has(record) ||
              (!sharedKeys.has(record.block.key) && !record.runs.some((run) => sharedRuns.has(run)))
            )
              continue
            selectedRecords.add(record)
            sharedKeys.add(record.block.key)
            record.runs.forEach((run) => {
              sharedRuns.add(run)
              digitOwners.add(run)
            })
            expanded = true
          }
        }
        const tokens = records.flatMap((record) =>
            selectedRecords.has(record)
              ? record.block.numbers.map((token) => ({
                  label: token[0],
                  offset: record.block.start + token.index,
                  blockKey: record.block.key
                }))
              : []
          ),
          group = sourceAnnotations
            .flatMap((candidate, position) => {
              if (
                !linkedItems(originalText!, candidate.rect, true).some((item) =>
                  digitOwners.has(item)
                )
              )
                return []
              const targetItems = linkedItems(text, targetAnnotations[position].rect),
                label = numericHit(targetItems)?.label,
                sourceItem = linkedItems(originalText!, candidate.rect, true).find((item) =>
                  digitOwners.has(item)
                )!
              const targetBlocks = new Set(
                tokens.flatMap((token) =>
                  token.label === label &&
                  located(targetAnnotations[position].rect, label, token.offset)
                    ? [token.blockKey]
                    : []
                )
              )
              return targetBlocks.size === 1
                ? [
                    {
                      label,
                      blockKey: [...targetBlocks][0],
                      rect: candidate.rect,
                      sourceItem,
                      targetFirst: targetItems[0],
                      targetLast: targetItems.at(-1)!
                    }
                  ]
                : []
            })
            .sort((a, b) =>
              Math.abs(a.sourceItem.transform[5] - b.sourceItem.transform[5]) >
              Math.max(a.sourceItem.transform[0], b.sourceItem.transform[0]) * 0.3
                ? b.sourceItem.transform[5] - a.sourceItem.transform[5]
                : a.rect[0] - b.rect[0]
            )
        if (
          group.length === tokens.length &&
          group.every((member, index) => {
            // Separate complete citations can change order with prose;
            // the numeric vector and repeated ordinal of one identity
            // still follow their source-native action group exactly.
            const previous =
              group[
                tokens
                  .slice(0, index)
                  .findLastIndex((token) => token.blockKey === tokens[index].blockKey)
              ]
            return (
              member.label === tokens[index].label &&
              member.blockKey === tokens[index].blockKey &&
              (!previous ||
                member.targetFirst.transform[5] <
                  previous.targetLast.transform[5] - member.targetFirst.transform[0] * 0.3 ||
                (Math.abs(member.targetFirst.transform[5] - previous.targetLast.transform[5]) <=
                  member.targetFirst.transform[0] * 0.3 &&
                  member.targetFirst.transform[4] >=
                    previous.targetLast.transform[4] +
                      previous.targetLast.width -
                      member.targetFirst.transform[0] * 0.05))
            )
          })
        )
          return true
      }
      return false
    })
    if ((mergedDelimiter || nativeBracketedSources.length) && bracketedOwners.length !== 1) {
      if (retainLink()) continue
      throw validationError('PDF link left its closed numeric citation')
    }
    const verifiedClosedSuffix =
      mergedDelimiter && /^[\]］]$/u.test(delimiterLabel?.[2] ?? '') && bracketedOwners.length === 1
    // A raised native reference list can directly follow a name,
    // NumPy¹,². Joining it with the body erases the numeric boundary.
    // Prove its complete native run and one owning paragraph instead.
    const nativeReferences = linkedItems(originalText, annotation.rect, true).filter((item) => {
      const list = textKey(item.str).normalize('NFKC')
      if (!referenceNumber.test(sourceLabel) || !/^\d+(?:[,–−-]\d+)+$/u.test(list)) return false
      return (
        units.filter((unit, unitIndex) => {
          if (
            textKey(unit.source).normalize('NFKC').split(list).length !== 2 ||
            textKey(renderUnits[unitIndex].translation).normalize('NFKC').split(list).length !== 2
          )
            return false
          return unit.fragments.some(
            (fragment) =>
              fragment.pageNumber === number &&
              fragment.items.some(
                (claimed) =>
                  originalText!.items[claimed.index] === item &&
                  textKey(claimed.text) === textKey(item.str)
              ) &&
              fragment.items.some((claimed) => {
                const body = originalText!.items[claimed.index]
                return (
                  body &&
                  'str' in body &&
                  body.transform[0] > 0 &&
                  body.transform[1] === 0 &&
                  body.transform[2] === 0 &&
                  item.transform[0] > body.transform[0] * 0.3 &&
                  item.transform[0] < body.transform[0] * 0.85 &&
                  item.transform[1] === 0 &&
                  item.transform[2] === 0 &&
                  item.transform[5] - body.transform[5] > body.transform[0] * 0.1 &&
                  item.transform[5] - body.transform[5] < body.transform[0] * 0.5
                )
              })
          )
        }).length === 1
      )
    })
    if (numericOccurrences > 1 || nativeReferences.length === 1) {
      // Top-origin equation operators may cross the line's hit area
      // despite belonging to a neighboring formula. They cannot contain
      // a numeric label; their native geometry is verified separately.
      const originals =
        nativeReferences.length === 1
          ? nativeReferences
          : linkedItems(originalText, annotation.rect, true).filter(
              (item) => !/^[√∛∜∫∑∏]$/u.test(item.str.trim())
            )
      if (
        originals.length === 1 &&
        originals[0].transform[0] > 0 &&
        originals[0].transform[1] === 0
      ) {
        const yearLabel = /^\d{4}[a-z]?$/u.test(sourceLabel)
        const numbers = numericTokens(originals[0].str)
          // A native line can include an unlinked prose list marker
          // between citations: (..., 2041), (3) another method (..., 2041).
          // Only exclude that explicit list syntax; every repeated year
          // still requires its own unchanged, ordered link below.
          .filter((match) => {
            // Plain quantities in the same line are not dated citations.
            if (yearLabel && !/^\d{4}[a-z]?$/u.test(match[0])) return false
            const before = originals[0].str.slice(0, match.index),
              after = originals[0].str.slice(match.index + match[0].length)
            return !(
              /^\d{1,2}$/u.test(match[0]) &&
              /(?:^|[,;])\s*(?:and\s+)?\($/u.test(before) &&
              /^\)\s+[a-z]/u.test(after)
            )
          })
          .map((match) => match[0])
        const group = sourceAnnotations
          .flatMap((candidate, position) => {
            const items = linkedItems(originalText!, candidate.rect, true)
                .filter((item) => !/^[√∛∜∫∑∏]$/u.test(item.str.trim()))
                .filter((item) => nativeReferences.length !== 1 || item === nativeReferences[0]),
              targetLabel = linkedText(text, targetAnnotations[position].rect).normalize('NFKC')
            return items.length === 1 &&
              items[0] === originals[0] &&
              referenceNumber.test(targetLabel) &&
              (!yearLabel || /^\d{4}[a-z]?$/u.test(targetLabel))
              ? [{ rect: candidate.rect, label: targetLabel }]
              : []
          })
          .sort((a, b) => a.rect[0] - b.rect[0])
        repeatedNumericLabel =
          group.length === numbers.length &&
          group.every(
            (candidate, position) =>
              candidate.label === numbers[position] &&
              (position === 0 || candidate.rect[0] >= group[position - 1].rect[2] - 1)
          )
      }
    }
    // Appendix letters may also occur inside acronyms in a merged line
    // (Appendix A ... CIFAR). Require the same unique typed reference.
    const typedAppendix = (value: string): number =>
      /^[A-Z]$/u.test(sourceLabel)
        ? [
            ...value.matchAll(
              new RegExp(
                '(?:\\bappendix\\s*|附[录錄]\\s*)' + sourceLabel + '(?![A-Za-z\\d])',
                'giu'
              )
            )
          ].length
        : 0
    const appendixLetter =
      typedAppendix(
        linkedItems(originalText, annotation.rect, true)
          .map((item) => item.str)
          .join(' ')
      ) === 1 &&
      units.some(
        (unit, unitIndex) =>
          typedAppendix(unit.source) === 1 &&
          typedAppendix(renderUnits[unitIndex].translation) === 1 &&
          unit.fragments.some(
            (fragment) =>
              fragment.pageNumber === number &&
              annotation.rect[0] >= fragment.rect.x * source.width - 2 &&
              annotation.rect[2] <= (fragment.rect.x + fragment.rect.width) * source.width + 2 &&
              source.height - annotation.rect[3] >= fragment.rect.y * source.height - 2 &&
              source.height - annotation.rect[1] <=
                (fragment.rect.y + fragment.rect.height) * source.height + 2
          )
      )
    // Some publishers link only the digit of a figure panel while
    // PDF.js merges the complete label into the whole prose run.
    // A bare digit is not enough: prove the complete unchanged panel,
    // its occurrence count and the same unique source paragraph.
    const panelNumber =
      /^\d+$/u.test(sourceLabel) &&
      (() => {
        const panels = (value: string): RegExpExecArray[] => [
            ...value.matchAll(
              /(?:\b(?:Figure|Fig\.?)\s*|[图圖]\s*)(\d+)(?:[（(]\s*([A-Za-z])\s*[)）]|([A-Za-z]))(?![A-Za-z\d])/giu
            )
          ],
          nativeItems = linkedItems(originalText!, annotation.rect, true),
          nativeRun = nativeItems.map((item) => item.str).join(' '),
          originals = [
            ...panels(nativeRun),
            ...nativeRun.matchAll(/^\s*(\d+)[（(]\s*([A-Za-z])\s*[)）](?![A-Za-z\d])/gu)
          ].filter((match) => match[1] === sourceLabel)
        if (originals.length !== 1) return false
        const compact = originals[0][3],
          letter = originals[0][2] ?? compact
        if (compact) {
          const linked = linkedItems(text, moved.rect),
            digit = linked[0],
            native = nativeItems[0]
          if (
            annotation.uri ||
            !annotation.destinationCoordinates.length ||
            nativeItems.length !== 1 ||
            linked.length !== 1 ||
            digit.str !== sourceLabel ||
            sourceAnnotations.filter((link) =>
              linkedItems(originalText!, link.rect, true).includes(native)
            ).length !== 1
          )
            return false
          const [size, b, c, , x, y] = digit.transform
          if (!(size > 0) || b !== 0 || c !== 0) return false
          const row = visibleTargetItems.filter(
            (item): item is TextItem =>
              'str' in item &&
              !!item.str.trim() &&
              item !== digit &&
              item.transform[0] > 0 &&
              item.transform[1] === 0 &&
              item.transform[2] === 0 &&
              Math.abs(item.transform[5] - y) <= size * 0.2
          )
          if (
            !row.some((item) => {
              const gap = x - item.transform[4] - item.width
              return (
                gap >= -0.01 &&
                gap <= size * 0.5 &&
                /(?:\b(?:Figure|Fig\.?)|[图圖])\s*$/iu.test(item.str)
              )
            }) ||
            !row.some((item) => {
              const gap = item.transform[4] - x - digit.width,
                suffix = item.str.trimStart()
              return (
                gap >= -0.01 &&
                gap <= size * 0.5 &&
                suffix.startsWith(compact) &&
                !/^[A-Za-z\d]/u.test(suffix.slice(1))
              )
            })
          )
            return false
        }
        const owners = units.filter((unit, unitIndex) => {
          const matches = panels(unit.source).filter(
            (match) =>
              match[1] === sourceLabel &&
              Boolean(match[3]) === Boolean(compact) &&
              (match[2] ?? match[3]) === letter
          )
          const starts = [
              ...unit.source.matchAll(
                new RegExp(
                  `(?<![A-Za-z\\d_.])${sourceLabel}[（(]\\s*${originals[0][2]}\\s*[)）](?![A-Za-z\\d])`,
                  'gu'
                )
              )
            ],
            continued =
              !compact && matches.length === 0 && starts.length === 1
                ? coordinatedPanelContinuation(
                    unit.source,
                    renderUnits[unitIndex].translation,
                    sourceLabel,
                    starts[0].index
                  )
                : undefined
          if (matches.length !== 1 && !continued) return false
          const match = matches[0],
            target = match
              ? translatedPdfLinkFragment(
                  unit.source,
                  renderUnits[unitIndex].translation,
                  sourceLabel,
                  match.index + match[0].indexOf(sourceLabel)
                )
              : continued && { start: continued.start, text: sourceLabel }
          if (continued) {
            const targetGeometry = source
            const after = linkedItems(text, moved.rect),
              glyph = after[0]
            if (
              nativeItems.length !== 1 ||
              after.length !== 1 ||
              glyph.str !== sourceLabel ||
              glyph.transform[0] <= 0 ||
              glyph.transform[3] <= 0 ||
              glyph.transform[1] !== 0 ||
              glyph.transform[2] !== 0 ||
              Math.abs(nativeItems[0].transform[4] - annotation.rect[0]) > 1 ||
              units.filter((u) =>
                u.fragments.some(
                  (f) =>
                    f.pageNumber === number &&
                    f.items.some((c) => originalText!.items[c.index] === nativeItems[0])
                )
              ).length !== 1 ||
              sourceAnnotations.filter((a) =>
                linkedItems(originalText!, a.rect, true).includes(nativeItems[0])
              ).length !== 1 ||
              targetAnnotations.filter((a) => linkedItems(text, a.rect).includes(glyph)).length !==
                1
            )
              return false
            const within = (item: TextItem): boolean =>
                unit.fragments.some(
                  (f) =>
                    f.pageNumber === number &&
                    item.transform[4] >= f.rect.x * targetGeometry.width - 1 &&
                    item.transform[4] + item.width <=
                      (f.rect.x + f.rect.width) * targetGeometry.width + 1 &&
                    targetGeometry.height - item.transform[5] >=
                      f.rect.y * targetGeometry.height - 1 &&
                    targetGeometry.height - item.transform[5] <=
                      (f.rect.y + f.rect.height) * targetGeometry.height + 1
                ),
              row = visibleTargetItems
                .filter(
                  (item): item is TextItem =>
                    'str' in item &&
                    Boolean(item.str.trim()) &&
                    item !== glyph &&
                    item.transform[0] > 0 &&
                    item.transform[3] > 0 &&
                    item.transform[1] === 0 &&
                    item.transform[2] === 0 &&
                    Math.abs(item.transform[5] - glyph.transform[5]) <= glyph.transform[0] * 0.3 &&
                    item.transform[4] >= glyph.transform[4] + glyph.width - 0.001
                )
                .sort((a, b) => a.transform[4] - b.transform[4])
            let tail = '',
              previous = glyph
            for (const item of row) {
              if (tail.length >= 3) break
              if (
                !within(item) ||
                item.transform[4] - previous.transform[4] - previous.width >
                  glyph.transform[0] * 1.5
              )
                return false
              tail += item.str.replace(/\s/gu, '').normalize('NFKC')
              previous = item
            }
            if (!within(glyph) || !tail.startsWith(`(${continued.panel})`)) return false
          }
          return (
            target?.text === label &&
            unit.fragments.some(
              (fragment) =>
                fragment.pageNumber === number &&
                nativeItems.every((native) =>
                  fragment.items.some(
                    (item) =>
                      originalText!.items[item.index] === native &&
                      textKey(item.text) === textKey(native.str)
                  )
                ) &&
                annotation.rect[0] >= fragment.rect.x * source.width - 2 &&
                annotation.rect[2] <= (fragment.rect.x + fragment.rect.width) * source.width + 2 &&
                source.height - annotation.rect[3] >= fragment.rect.y * source.height - 2 &&
                source.height - annotation.rect[1] <=
                  (fragment.rect.y + fragment.rect.height) * source.height + 2
            )
          )
        })
        return owners.length === 1
      })()
    const containedSourceItems = linkedItems(originalText, annotation.rect).filter(
      (item) => !referenceNumber.test(sourceLabel) || !/^[√∛∜∫∑∏]$/u.test(item.str.trim())
    )
    const originalExactLabel = textKey(
      containedSourceItems.map((item) => latinAccentText.get(item) ?? item.str).join('')
    )
    // A hit may include the opening bracket while only overlapping the
    // closing run. The complete source and target citation still have to agree.
    const verifiedBracketPrefix =
      nativeBracketedSources.length === 1 &&
      bracketedOwners.length === 1 &&
      originalExactLabel.normalize('NFKC') === `[${sourceLabel}`
    // PDF.js can expose an unchanged formula's control-coded glyph next to
    // a citation. Its exact foreign owner cannot name the closed link.
    const foreignCitationGlyph =
      !annotation.uri &&
      annotation.destinationCoordinates.length > 0 &&
      sourceLabel === label &&
      /^\d{1,4}$/u.test(label) &&
      numericOccurrences === 1 &&
      nativeBracketedSources.length === 1 &&
      bracketedOwners.length === 1 &&
      containedSourceItems.length === 1 &&
      originalExactLabel.length === 1 &&
      originalExactLabel.charCodeAt(0) < 0x20 &&
      (() => {
        const glyph = containedSourceItems[0],
          before = linkedItems(originalText, annotation.rect, true),
          after = linkedItems(text, moved.rect)
        if (
          before.length !== 2 ||
          after.length !== 1 ||
          after[0].str !== label ||
          !before.includes(glyph) ||
          !before.some(
            (item) =>
              item !== glyph &&
              pdfBracketedReferenceBlocks(item.str).some(
                (block) => block.numbers.length === 1 && block.numbers[0][0] === sourceLabel
              )
          )
        )
          return false
        const owners = documentSource.units.filter((unit) =>
          unit.fragments.some(
            (fragment) =>
              fragment.pageNumber === number &&
              fragment.items.some(
                (item) => originalText!.items[item.index] === glyph && item.text === glyph.str
              )
          )
        )
        return (
          owners.length === 1 &&
          owners[0].sourceOnly &&
          owners[0].preserve === 'formula' &&
          visibleTargetItems.filter(
            (item) =>
              'str' in item &&
              item.str === glyph.str &&
              Math.abs(item.width - glyph.width) < 0.001 &&
              item.transform.every((value, i) => Math.abs(value - glyph.transform[i]) < 0.001)
          ).length === 1
        )
      })()
    // A digit-only annotation needs the full typed-reference identity and
    // its native row ordinal. Repeated references need complete native link coverage.
    const typedReferences = (
      value: string,
      includeCompact: boolean
    ): { key: string; label: string; at: number; end: number; digit: number }[] =>
      [
        ...value.matchAll(
          includeCompact
            ? /(?:\b(?:Figure|Fig\.?|Table|Tab\.?|Theorem)|[图圖表]|定理)\s*(\d+)(?:\s*[（(]\s*([A-Za-z])\s*[)）]|([A-Za-z]))?(?![A-Za-z\d]|[.．]\d)/giu
            : /(?:\b(?:Figure|Fig\.?|Table|Tab\.?|Theorem)|[图圖表]|定理)\s*(\d+)(?:\s*[（(]\s*([A-Za-z])\s*[)）])?(?![A-Za-z\d]|[.．]\d)/giu
        )
      ].flatMap((match) => {
        const prefix = match[0].slice(0, match[0].indexOf(match[1])),
          key = pdfLinkLabelKey(prefix + match[1]),
          compact = match[3]
        return key &&
          (!compact || key.startsWith('figure:')) &&
          (!/^\s*[（(]/u.test(value.slice(match.index + match[0].length)) || match[2])
          ? [
              {
                key: key + ':' + (match[2] ?? compact ?? ''),
                label: match[1] + (compact ?? ''),
                at: match.index,
                end: match.index + match[0].length,
                digit: match.index + prefix.length
              }
            ]
          : []
      })
    const compactPanel = /^\d+[A-Za-z]$/u.test(sourceLabel),
      typedHit = linkedItems(originalText, annotation.rect, true),
      typedNativeRow = typedHit.map((item) => item.str).join(' '),
      nativeTypedReferences = typedReferences(typedNativeRow, compactPanel),
      repeatedCompactPanel =
        compactPanel &&
        nativeTypedReferences.some((reference) => reference.label === sourceLabel) &&
        units.some(
          (unit) =>
            unit.fragments.some(
              (fragment) =>
                fragment.pageNumber === number &&
                fragment.items.some((claimed) =>
                  typedHit.includes(originalText!.items[claimed.index] as TextItem)
                )
            ) &&
            typedReferences(unit.source, true).filter(
              (reference) => reference.label === sourceLabel
            ).length > 1
        )
    // A bare number cannot borrow one digit of a dotted section label
    // that belongs to a different translated annotation.
    const linkedDigit =
        /^\d+$/u.test(label) &&
        numericOccurrences === 1 &&
        [...typedNativeRow.matchAll(/\d+/gu)].filter((match) => match[0] === label).length > 1
          ? linkedItems(text, moved.rect)
          : [],
      sharedDottedHit =
        linkedDigit.length === 1 &&
        targetAnnotations.some((other) => {
          if (
            other === moved ||
            other.rect[0] >= moved.rect[2] ||
            other.rect[2] <= moved.rect[0] ||
            other.rect[1] >= moved.rect[3] ||
            other.rect[3] <= moved.rect[1]
          )
            return false
          const hit = linkedItems(text, other.rect)
          return (
            hit.includes(linkedDigit[0]) &&
            /^\d+(?:\.\d+)+$/u.test(textKey(hit.map((item) => item.str).join('')))
          )
        })
    const typedReferenceRequired =
      repeatedCompactPanel ||
      (!panelNumber &&
        originalExactLabel !== sourceLabel &&
        /^\d+$/u.test(sourceLabel) &&
        (numericOccurrences !== 1 ||
          [...typedNativeRow.matchAll(/\d+(?:\.\d+)*/gu)].filter(
            (match) => match[0] === sourceLabel
          ).length !== 1) &&
        nativeTypedReferences.some((reference) => reference.key.split(':')[1] === sourceLabel))
    const typedReferenceOwners =
      typedReferenceRequired && sourceLabel === label
        ? units.map((unit, unitIndex) => {
            if (unchanged(unitIndex) || unit.fragments.some((f) => f.pageNumber !== number))
              return undefined
            const hit = typedHit,
              claims = unit.fragments.flatMap((f) => f.items),
              indices = claims.map((c) => c.index)
            if (
              !hit.length ||
              new Set(indices).size !== indices.length ||
              indices.some((n, i) => i > 0 && n <= indices[i - 1]) ||
              claims.some((c) => {
                const native = originalText!.items[c.index]
                return !native || !('str' in native) || native.str !== c.text
              }) ||
              !hit.every((native) => claims.some((c) => originalText!.items[c.index] === native)) ||
              units.some(
                (other) =>
                  other !== unit &&
                  other.fragments.some(
                    (f) => f.pageNumber === number && f.items.some((c) => indices.includes(c.index))
                  )
              ) ||
              unit.fragments.filter((f) =>
                hit.every((native) => f.items.some((c) => originalText!.items[c.index] === native))
              ).length !== 1
            )
              return undefined
            let cursor = 0
            const spans = claims.map((c) => {
                const start = cursor
                cursor += c.text.length + 1
                return {
                  item: originalText!.items[c.index] as TextItem,
                  start,
                  end: cursor - 1
                }
              }),
              native = claims.map((c) => c.text).join(' '),
              from = typedReferences(unit.source, compactPanel),
              to = typedReferences(renderUnits[unitIndex].translation, compactPanel),
              actualFrom = typedReferences(native, compactPanel),
              same = (a: typeof from, b: typeof from): boolean =>
                a.length > 0 && a.length === b.length && a.every((r, i) => r.key === b[i].key),
              candidates = actualFrom.filter((r) => {
                if (repeatedCompactPanel && r.label !== sourceLabel) return false
                const parts = spans.filter((s) => s.start < r.end && s.end > r.at)
                return parts.length > 0 && parts.every((s) => hit.includes(s.item))
              })
            if (
              !same(from, actualFrom) ||
              !same(from, to) ||
              !candidates.length ||
              candidates.length > 8
            )
              return undefined
            const row = hit.map((item) => item.str).join(' '),
              digits = [
                ...row.matchAll(
                  repeatedCompactPanel ? /(?<![A-Za-z\d])\d+[A-Za-z](?![A-Za-z\d])/gu : /\d+/gu
                )
              ],
              rowLinks = sourceAnnotations.flatMap((link) => {
                const items = linkedItems(originalText!, link.rect, true)
                return items.some((item) => hit.includes(item)) ? [{ link, items }] : []
              })
            let ordinal = 0
            if (candidates.length === 1) {
              if (
                digits.filter((match) => match[0] === sourceLabel).length !== 1 ||
                rowLinks.length !== 1
              )
                return undefined
            } else {
              // A merged row can contain several links to the same figure. Only a complete
              // set of disjoint links with an identical action establishes their order.
              const rowItem = hit[0],
                [, b, c, d, left] = rowItem.transform,
                right = left + rowItem.width
              rowLinks.sort((a, b) => a.link.rect[0] - b.link.rect[0])
              if (
                hit.length !== 1 ||
                !/^\d+$/u.test(sourceLabel) ||
                !annotation.destinationCoordinates?.length ||
                !candidates[0].key.startsWith('figure:') ||
                candidates.some(
                  (part) => part.key !== candidates[0].key || part.label !== sourceLabel
                ) ||
                digits.length !== candidates.length ||
                digits.some((match) => match[0] !== sourceLabel) ||
                rowItem.transform[0] <= 0 ||
                b !== 0 ||
                c !== 0 ||
                d <= 0 ||
                ![...rowItem.transform, rowItem.width].every(Number.isFinite) ||
                rowItem.width <= 0 ||
                rowLinks.length !== candidates.length ||
                rowLinks.some(
                  ({ link, items }, i) =>
                    items.length !== 1 ||
                    link.key !== annotation.key ||
                    !sameCoordinates(
                      link.destinationCoordinates,
                      annotation.destinationCoordinates
                    ) ||
                    link.quadPoints?.length ||
                    link.rect.length !== 4 ||
                    !link.rect.every(Number.isFinite) ||
                    link.rect[0] < left - 0.001 ||
                    link.rect[2] > right + 0.001 ||
                    Math.abs(link.rect[1] - annotation.rect[1]) > 0.001 ||
                    Math.abs(link.rect[3] - annotation.rect[3]) > 0.001 ||
                    link.rect[2] <= link.rect[0] ||
                    (i > 0 && rowLinks[i - 1].link.rect[2] >= link.rect[0])
                )
              )
                return undefined
              ordinal = rowLinks.findIndex(({ link }) => link === annotation)
              if (ordinal < 0) return undefined
            }
            const occurrence = actualFrom.indexOf(candidates[ordinal]),
              expected = translatedPdfLinkFragment(
                unit.source,
                renderUnits[unitIndex].translation,
                sourceLabel,
                from[occurrence].digit
              ),
              within = (item: TextItem, fragment: (typeof unit.fragments)[number]): boolean =>
                item.transform[0] > 0 &&
                item.transform[3] > 0 &&
                item.transform[1] === 0 &&
                item.transform[2] === 0 &&
                [item.transform[4], item.transform[4] + item.width].every(
                  (x) =>
                    x >= fragment.rect.x * target.width - 1 &&
                    x <= (fragment.rect.x + fragment.rect.width) * target.width + 1
                ) &&
                target.height - item.transform[5] >= fragment.rect.y * target.height - 1 &&
                target.height - item.transform[5] <=
                  (fragment.rect.y + fragment.rect.height) * target.height + 1,
              targetRows = unit.fragments.map((fragment) =>
                visibleTargetItems
                  .filter(
                    (item): item is TextItem =>
                      'str' in item && Boolean(item.str) && within(item, fragment)
                  )
                  .sort((a, b) =>
                    Math.abs(a.transform[5] - b.transform[5]) >
                    Math.max(a.transform[0], b.transform[0]) * 0.3
                      ? b.transform[5] - a.transform[5]
                      : a.transform[4] - b.transform[4]
                  )
              ),
              ordered = targetRows.flat(),
              after = linkedItems(text, moved.rect)
            if (
              expected?.text !== sourceLabel ||
              expected.start !== to[occurrence].digit ||
              !after.length ||
              textKey(after.map((i) => i.str).join('')) !== sourceLabel ||
              new Set(ordered).size !== ordered.length ||
              !after.every((i) => ordered.includes(i)) ||
              targetAnnotations.filter((a) =>
                linkedItems(text, a.rect).some((item) => after.includes(item))
              ).length !== 1
            )
              return undefined
            cursor = 0
            const targetSpans = ordered.map((item) => {
                const start = cursor
                cursor += textKey(item.str).length
                return { item, start, end: cursor }
              }),
              targetNative = ordered.map((item) => item.str).join(''),
              actualTo = typedReferences(targetNative, compactPanel).map((r) => ({
                ...r,
                digit: textKey(targetNative.slice(0, r.digit)).length
              })),
              reference = actualTo[occurrence],
              linked = targetSpans.filter((s) => after.includes(s.item))
            if (
              !same(to, actualTo) ||
              !reference ||
              linked[0].start !== reference.digit ||
              linked.at(-1)!.end !== reference.digit + sourceLabel.length ||
              after.length !== 1 ||
              hit.length !== 1
            )
              return undefined
            return unit
          })
        : []
    const typedOwners = typedReferenceOwners.filter((unit) => unit !== undefined),
      typedReferenceNumber = typedOwners.length === 1
    // Detached accents or range dashes can split a native link between
    // larger PDF.js prose runs. Every fully contained run must belong
    // to the same unique complete author or numeric range/list span.
    const labelStart = originalRun.indexOf(sourceLabel)
    let sourceOffset = 0
    const partialRangeLabel = /^\d+(?:[,–−-]\d+)+$/u.test(sourceLabel)
    const partialSourceLabel =
      Boolean(originalExactLabel) &&
      (key?.startsWith('authors:') ||
        partialRangeLabel ||
        (latinAccentText.size > 0 && /^[A-Za-zÀ-ÖØ-öø-ÿ]+$/u.test(sourceLabel))) &&
      originalRun.split(sourceLabel).length === 2 &&
      linkedItems(originalText, annotation.rect, true).every((item) => {
        const start = sourceOffset
        sourceOffset += textKey(latinAccentText.get(item) ?? item.str).length
        return (
          !containedSourceItems.includes(item) ||
          (start >= labelStart && sourceOffset <= labelStart + sourceLabel.length)
        )
      })
    const prefixBefore = linkedItems(originalText, annotation.rect, true),
      prefixAfter = linkedItems(text, moved.rect),
      prefixOwners =
        originalExactLabel &&
        originalExactLabel !== sourceLabel &&
        sourceLabel === label &&
        textKey(prefixAfter.map((item) => item.str).join('')) === label &&
        sourceLabel.startsWith(originalExactLabel) &&
        prefixBefore.length > 0 &&
        prefixBefore.length === prefixAfter.length &&
        Math.abs(prefixBefore[0].transform[4] - annotation.rect[0]) <= 1 &&
        Math.abs(
          prefixBefore.at(-1)!.transform[4] + prefixAfter.at(-1)!.width - annotation.rect[2]
        ) <= 1 &&
        originalRun.startsWith(sourceLabel) &&
        originalRun.split(sourceLabel).length === 2
          ? units.filter(
              (unit, unitIndex) =>
                !unchanged(unitIndex) &&
                textKey(unit.source).split(sourceLabel).length === 2 &&
                textKey(renderUnits[unitIndex].translation).split(label).length === 2 &&
                unit.fragments.every((fragment) => fragment.pageNumber === number) &&
                prefixBefore.every((item) =>
                  unit.fragments.some((fragment) =>
                    fragment.items.some(
                      (claimed) =>
                        originalText!.items[claimed.index] === item && claimed.text === item.str
                    )
                  )
                )
            )
          : [],
      verifiedPrefix =
        prefixOwners.length === 1 &&
        (await verifiedNativeLinkPrefix(
          prefixBefore,
          prefixAfter,
          originalText,
          text,
          sourcePage,
          translatedPage,
          [moved.rect[0] - annotation.rect[0], moved.rect[1] - annotation.rect[1]]
        ))
    const literalLabel = (
      nativeUriLabel ||
      linkedItems(text, moved.rect)
        .map((item) => item.str)
        .join('')
    )
      .replace(/\s+/gu, ' ')
      .trim()
    // A wrapped URI can share its short label, such as "https://", with
    // another address. Prove its complete original action and exact
    // native source interval before assigning the translated fragment.
    const wrappedUriOwners = new Set<(typeof units)[number]>()
    const uriFragment = (unit: (typeof units)[number], unitIndex: number): boolean => {
      if (!annotation.uri || !literalLabel || unit.fragments.some((f) => f.pageNumber !== number))
        return false
      const translation = renderUnits[unitIndex].translation,
        same = (item: { text: string }): boolean => item.text.replace(/ /gu, '') === annotation.uri,
        from = pdfLinkAddressMatches(unit.source).filter(same),
        to = pdfLinkAddressMatches(translation).filter(same)
      if (from.length !== 1 || to.length !== 1) return false
      const indices = [
          ...new Set(unit.fragments.flatMap((fragment) => fragment.items.map((item) => item.index)))
        ],
        native = indices.map((index) => originalText!.items[index])
      if (
        native.some((item) => !item || !('str' in item)) ||
        unit.fragments.some((fragment) =>
          fragment.items.some((claimed) => {
            const item = originalText!.items[claimed.index]
            return !item || !('str' in item) || textKey(claimed.text) !== textKey(item.str)
          })
        )
      )
        return false
      let cursor = 0
      const spans = native.map((item) => {
          const start = cursor
          cursor += textKey('str' in item ? item.str : '').length
          return { item, start, end: cursor, nativeStart: start, nativeEnd: cursor }
        }),
        nativeLiteral = native.map((item) => ('str' in item ? item.str : '')).join(''),
        nativeText = textKey(nativeLiteral),
        removed = new Set<number>()
      if (nativeText !== textKey(unit.source)) {
        // Only the full original action can prove a layout hyphen inside
        // its URI. Require adjacent native rows in this same fragment;
        // semantic hyphens remain literal characters of that action.
        const breaks = new Set<number>()
        for (let i = 0; i + 1 < native.length; i++) {
          const before = native[i],
            after = native[i + 1]
          if (!('str' in before) || !('str' in after)) continue
          const size = before.transform[0],
            dy = before.transform[5] - after.transform[5]
          if (
            /[A-Za-z\d]-$/u.test(before.str.trimEnd()) &&
            /^[A-Za-z\d]/u.test(after.str.trimStart()) &&
            before.hasEOL === true &&
            indices[i + 1] === indices[i] + 1 &&
            before.fontName &&
            before.fontName === after.fontName &&
            [before, after].every(
              (part) =>
                part.transform[0] > 0 &&
                part.transform[1] === 0 &&
                part.transform[2] === 0 &&
                Math.abs(part.transform[3] - size) < size * 0.05
            ) &&
            Math.abs(size - after.transform[0]) < size * 0.05 &&
            dy > size * 0.8 &&
            dy < size * 1.8 &&
            Math.abs(before.transform[4] - after.transform[4]) < size * 0.3 &&
            unit.fragments.some(
              (fragment) =>
                fragment.items.some((part) => part.index === indices[i]) &&
                fragment.items.some((part) => part.index === indices[i + 1])
            )
          )
            breaks.add(spans[i].end - 1)
        }
        const addresses = pdfLinkAddressMatches(nativeLiteral).flatMap((rawAddress) => {
          const address = {
            text: textKey(rawAddress.text),
            index: textKey(nativeLiteral.slice(0, rawAddress.index)).length
          }
          let at = 0
          const skipped: number[] = []
          for (let i = 0; i < address.text.length; i++) {
            const char = address.text[i]
            if (char === annotation.uri![at]) at++
            else if (char === '-' && breaks.has(address.index + i)) skipped.push(address.index + i)
            else return []
          }
          return at === annotation.uri!.length && skipped.length ? [skipped] : []
        })
        if (addresses.length !== 1) return false
        for (const at of addresses[0]) removed.add(at)
        if (
          nativeText
            .split('')
            .filter((_, at) => !removed.has(at))
            .join('') !== textKey(unit.source)
        )
          return false
        for (const span of spans) {
          const start = span.start,
            end = span.end
          span.start -= [...removed].filter((at) => at < start).length
          span.end -= [...removed].filter((at) => at < end).length
        }
      }
      const linked = linkedItems(originalText!, annotation.rect, true),
        candidates: number[] = []
      for (
        let at = to[0].text.indexOf(literalLabel);
        at >= 0;
        at = to[0].text.indexOf(literalLabel, at + literalLabel.length)
      ) {
        const mapped = translatedPdfLinkFragment(
          translation,
          unit.source,
          literalLabel,
          to[0].index + at
        )
        if (
          !mapped ||
          mapped.start < from[0].index ||
          mapped.start + mapped.text.length > from[0].index + from[0].text.length
        )
          continue
        const start = textKey(unit.source.slice(0, mapped.start)).length,
          end = start + textKey(mapped.text).length,
          owned = spans.filter((span) => span.start < end && span.end > start)
        const nativeEdge =
          removed.size > 0 &&
          owned.some((span) => {
            if (!('str' in span.item)) return false
            const item = span.item,
              pointY = item.transform[5] + item.transform[0] * 0.3
            return (
              pointY >= annotation.rect[1] - 1 &&
              pointY <= annotation.rect[3] + 1 &&
              ((end === span.end &&
                removed.has(span.nativeEnd - 1) &&
                /-$/u.test(item.str.trimEnd()) &&
                Math.abs(item.transform[4] + item.width - annotation.rect[2]) <
                  item.transform[0] * 0.1) ||
                (start === span.start &&
                  removed.has(span.nativeStart - 1) &&
                  Math.abs(item.transform[4] - annotation.rect[0]) < item.transform[0] * 0.1))
            )
          })
        if (
          owned.length &&
          owned.every((span) => 'str' in span.item && linked.includes(span.item)) &&
          (removed.size ? nativeEdge : originalRun.split(textKey(mapped.text)).length === 2)
        )
          candidates.push(at)
      }
      if (candidates.length === 1 && removed.size) wrappedUriOwners.add(unit)
      return candidates.length === 1
    }
    // A merged row may repeat one author/year identity in linked and
    // unlinked prose. A complete native closed citation and its two
    // original actions prove the label; a repeated author or year alone
    // does not. Every occurrence must retain this same dated identity.
    const repeatedDatedOwners =
      sourceLabel === label && originalRun.split(sourceLabel).length > 2
        ? units.filter((unit, unitIndex) => {
            if (unchanged(unitIndex) || !originalText) return false
            const claimed = unit.fragments
                .filter((fragment) => fragment.pageNumber === number)
                .flatMap((fragment) => fragment.items),
              native = claimed.map((part) => originalText!.items[part.index])
            if (
              !claimed.length ||
              claimed.some(
                (part, index) =>
                  !native[index] ||
                  !('str' in native[index]) ||
                  (native[index] as TextItem).str !== part.text
              )
            )
              return false
            const group = sourceAnnotations.flatMap((part, position) => {
              if (part.key !== annotation.key) return []
              const before = linkedItems(originalText!, part.rect, true),
                after = linkedItems(text, targetAnnotations[position].rect)
              return before.length &&
                before.every((item) => native.includes(item)) &&
                after.length === 1
                ? [{ position, glyph: after[0] }]
                : []
            })
            if (group.length < 2 || !group.some((part) => part.position === index)) return false
            const current = group.find((part) => part.position === index)!,
              author = pdfLinkLabelKey(current.glyph.str)?.startsWith('authors:')
                ? current
                : group
                    .filter(
                      (part) =>
                        pdfLinkLabelKey(part.glyph.str)?.startsWith('authors:') &&
                        part.glyph.transform[4] < current.glyph.transform[4] &&
                        Math.abs(part.glyph.transform[5] - current.glyph.transform[5]) <=
                          current.glyph.transform[0] * 0.3
                    )
                    .sort((a, b) => b.glyph.transform[4] - a.glyph.transform[4])[0],
              year = /^\d{4}[a-z]?$/u.test(current.glyph.str)
                ? current
                : group
                    .filter(
                      (part) =>
                        /^\d{4}[a-z]?$/u.test(part.glyph.str) &&
                        part.glyph.transform[4] > current.glyph.transform[4] &&
                        Math.abs(part.glyph.transform[5] - current.glyph.transform[5]) <=
                          current.glyph.transform[0] * 0.3
                    )
                    .sort((a, b) => a.glyph.transform[4] - b.glyph.transform[4])[0]
            if (!author || !year) return false
            const complete = `${author.glyph.str}, ${year.glyph.str}`,
              identity = pdfLinkLabelKey(complete),
              from = pdfLinkLabelMatches(unit.source, complete),
              to = pdfLinkLabelMatches(renderUnits[unitIndex].translation, complete),
              names = pdfLinkLabelMatches(unit.source, author.glyph.str),
              years = numericTokens(unit.source).filter((match) => match[0] === year.glyph.str)
            if (
              !identity?.startsWith('dated-authors:') ||
              from.length < 2 ||
              from.length !== to.length ||
              names.length !== from.length ||
              years.length !== from.length ||
              group.length !== from.length * 2 ||
              group.filter(
                (part) => pdfLinkLabelKey(part.glyph.str) === pdfLinkLabelKey(author.glyph.str)
              ).length !== from.length ||
              group.filter((part) => part.glyph.str === year.glyph.str).length !== from.length ||
              Math.abs(author.glyph.transform[5] - year.glyph.transform[5]) >
                Math.max(author.glyph.transform[0], year.glyph.transform[0]) * 0.3
            )
              return false
            return unit.fragments.some((fragment) => {
              if (fragment.pageNumber !== number) return false
              const inside = (item: TextItem): boolean =>
                [
                  target.convertToViewportPoint(item.transform[4], item.transform[5]),
                  target.convertToViewportPoint(item.transform[4] + item.width, item.transform[5])
                ].every(
                  ([x, y]) =>
                    x >= fragment.rect.x * target.width - 1 &&
                    x <= (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                    y >= fragment.rect.y * target.height - 1 &&
                    y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
                )
              if (![author.glyph, year.glyph].every(inside)) return false
              const row = visibleTargetItems
                  .flatMap((item) =>
                    'str' in item &&
                    item.str.trim() &&
                    inside(item) &&
                    item.transform[0] > 0 &&
                    item.transform[1] === 0 &&
                    item.transform[2] === 0 &&
                    Math.abs(item.transform[5] - author.glyph.transform[5]) <=
                      Math.max(item.transform[0], author.glyph.transform[0]) * 0.3
                      ? [item]
                      : []
                  )
                  .sort((a, b) => a.transform[4] - b.transform[4]),
                at = row.indexOf(author.glyph),
                end = row.indexOf(year.glyph),
                between = textKey(
                  row
                    .slice(at + 1, end)
                    .map((item) => item.str)
                    .join('')
                )
              return (
                at > 0 &&
                end > at &&
                ((/[(（]\s*$/u.test(row[at - 1].str) && /^[,，]$/u.test(between)) ||
                  /^[（(]$/u.test(between)) &&
                /^[)）]/u.test(row[end + 1]?.str ?? '') &&
                row.slice(at, end + 2).every((item, position, parts) => {
                  if (!position) return true
                  const previous = parts[position - 1],
                    gap = item.transform[4] - previous.transform[4] - previous.width
                  return gap >= -0.001 && gap <= item.transform[0] * 1.5
                })
              )
            })
          })
        : []
    const verifiedRepeatedDated = repeatedDatedOwners.length === 1
    // A wrapped author citation can start a merged row with "et al."
    // and repeat those words later in that row. Bind this exact native
    // prefix to all three unchanged author/collective/year hit areas;
    // a repeated substring alone never proves its destination.
    const collectiveOwners =
      label === 'etal.'
        ? units.filter((unit, unitIndex) => {
            if (unchanged(unitIndex) || !originalText) return false
            const before = linkedItems(originalText, annotation.rect, true),
              after = linkedItems(text, moved.rect),
              group = sourceAnnotations
                .flatMap((part, position) => {
                  const saved = targetAnnotations[position],
                    glyphs = linkedItems(text, saved.rect)
                  return part.key === annotation.key &&
                    sameCoordinates(
                      part.destinationCoordinates,
                      annotation.destinationCoordinates
                    ) &&
                    saved.key === part.key &&
                    sameCoordinates(saved.destinationCoordinates, part.destinationCoordinates) &&
                    glyphs.length === 1
                    ? [{ part, saved, glyph: glyphs[0], label: glyphs[0].str.trim() }]
                    : []
                })
                .sort((a, b) =>
                  Math.abs(a.part.rect[1] - b.part.rect[1]) > 2
                    ? b.part.rect[1] - a.part.rect[1]
                    : a.part.rect[0] - b.part.rect[0]
                )
            if (
              before.length !== 1 ||
              after.length !== 1 ||
              group.length !== 3 ||
              !before[0].str.trimStart().startsWith('et al.') ||
              group[1].part !== annotation ||
              !/^[A-Z][A-Za-z .’'-]*$/u.test(group[0].label) ||
              group[1].label !== 'et al.' ||
              !/^\d{4}[a-z]?$/u.test(group[2].label) ||
              !originalText.styles[before[0].fontName] ||
              JSON.stringify(originalText.styles[before[0].fontName]) !==
                JSON.stringify(text.styles[after[0].fontName]) ||
              before[0].transform
                .slice(0, 4)
                .some((value, axis) => Math.abs(value - after[0].transform[axis]) >= 0.001) ||
              [0, 1].some(
                (axis) =>
                  Math.abs(
                    after[0].transform[4 + axis] -
                      before[0].transform[4 + axis] -
                      moved.rect[axis] +
                      annotation.rect[axis]
                  ) >= 0.001
              )
            )
              return false
            const authorBefore = linkedItems(originalText, group[0].part.rect, true),
              authorAfter = group[0].glyph
            // The author hit area must own this exact native suffix, rather
            // than another name elsewhere in the same complete paragraph.
            if (
              authorBefore.length !== 1 ||
              authorBefore[0].str.split(group[0].label).length !== 2 ||
              !authorBefore[0].str.endsWith(group[0].label) ||
              !/[\s(]/u.test(
                authorBefore[0].str.slice(-group[0].label.length - 1, -group[0].label.length)
              ) ||
              JSON.stringify(originalText.styles[authorBefore[0].fontName]) !==
                JSON.stringify(text.styles[authorAfter.fontName]) ||
              authorBefore[0].transform
                .slice(0, 4)
                .some((value, axis) => Math.abs(value - authorAfter.transform[axis]) >= 0.001) ||
              Math.abs(
                authorBefore[0].transform[4] + authorBefore[0].width - group[0].part.rect[2]
              ) >
                authorBefore[0].transform[0] * 0.2 ||
              Math.abs(
                authorAfter.transform[4] +
                  authorAfter.width -
                  authorBefore[0].transform[4] -
                  authorBefore[0].width -
                  group[0].saved.rect[0] +
                  group[0].part.rect[0]
              ) >= 0.001
            )
              return false
            const author = group[0].label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
              citation = new RegExp(
                '\\(' + author + '\\s+et\\s+al\\.,\\s*' + group[2].label + '\\)',
                'gu'
              ),
              sourceMatches = [...unit.source.matchAll(citation)],
              targetMatches = [...renderUnits[unitIndex].translation.matchAll(citation)],
              claimed = unit.fragments
                .filter((fragment) => fragment.pageNumber === number)
                .flatMap((fragment) => fragment.items),
              native = [...new Set(claimed.map((part) => part.index))].map(
                (position) => originalText!.items[position]
              )
            if (
              sourceMatches.length !== 1 ||
              targetMatches.length !== 1 ||
              unit.fragments.some((fragment) => fragment.pageNumber !== number) ||
              claimed.some(
                (part) =>
                  !originalText!.items[part.index] ||
                  !('str' in originalText!.items[part.index]) ||
                  (originalText!.items[part.index] as TextItem).str !== part.text
              ) ||
              !before.every((glyph) => native.includes(glyph)) ||
              group.some(
                ({ part, glyph }) =>
                  !linkedItems(originalText!, part.rect, true).every((item) =>
                    native.includes(item)
                  ) ||
                  !unit.fragments.some((fragment) => {
                    const [x, y] = target.convertToViewportPoint(
                      glyph.transform[4],
                      glyph.transform[5]
                    )
                    return (
                      x >= fragment.rect.x * target.width - 1 &&
                      x + glyph.width <=
                        (fragment.rect.x + fragment.rect.width) * target.width + 1 &&
                      y >= fragment.rect.y * target.height - 1 &&
                      y <= (fragment.rect.y + fragment.rect.height) * target.height + 1
                    )
                  })
              )
            )
              return false
            // The three target parts must remain adjacent in their one dated
            // citation. Only the comma/space gap can separate native pieces.
            return group.every(({ glyph }, position) => {
              if (!position) return true
              const previous = group[position - 1].glyph,
                dy = previous.transform[5] - glyph.transform[5]
              if (dy < -0.001 || dy > glyph.transform[0] * 1.8) return false
              if (dy <= glyph.transform[0] * 0.3) {
                const gap = glyph.transform[4] - previous.transform[4] - previous.width
                return (
                  gap >= -0.001 &&
                  gap <= glyph.transform[0] * 1.5 &&
                  visibleTargetItems.every(
                    (item) =>
                      !('str' in item) ||
                      Math.abs(item.transform[5] - glyph.transform[5]) > 0.001 ||
                      item.transform[4] < previous.transform[4] + previous.width - 0.001 ||
                      item.transform[4] + item.width > glyph.transform[4] + 0.001 ||
                      /^[\s,，]*$/u.test(item.str)
                  )
                )
              }
              return false
            })
          })
        : []
    const collectiveBefore = linkedItems(originalText, annotation.rect, true),
      collectiveAfter = linkedItems(text, moved.rect)
    const verifiedCollective =
      collectiveOwners.length === 1 &&
      (await verifiedNativePrefixInk(
        collectiveBefore[0],
        collectiveAfter[0],
        sourcePage,
        translatedPage,
        originalText.styles[collectiveBefore[0].fontName]
      ))
    const uriOwners = units.filter(
      (unit, unitIndex) =>
        !unchanged(unitIndex) && (unit === nativeUriOwner || uriFragment(unit, unitIndex))
    )
    const verifiedUri =
      uriOwners.length === 1 &&
      (uriOwners[0] === nativeUriOwner || wrappedUriOwners.has(uriOwners[0]))
    // The merged source run can also contain this digit in prose.
    // Use the unique closed citation proof to identify the linked occurrence.
    const verifiedMergedBracketNumber =
      !annotation.uri &&
      annotation.destinationCoordinates.length > 0 &&
      originalExactLabel === '' &&
      numericOccurrences > 1 &&
      nativeBracketedSources.length === 1 &&
      bracketedOwners.length === 1 &&
      sourceLabel === label &&
      /^\d{1,4}$/u.test(label)
    if (
      !label ||
      (typedReferenceRequired && !typedReferenceNumber && !verifiedMergedBracketNumber) ||
      sharedDottedHit ||
      (nativeReferences.length === 1 && !repeatedNumericLabel && !verifiedRepeatedDated) ||
      (!verifiedClosedSuffix &&
        !verifiedUri &&
        !verifiedCollective &&
        !verifiedRepeatedDated &&
        (originalExactLabel
          ? originalExactLabel.normalize('NFKC') !== sourceLabel.normalize('NFKC') &&
            !verifiedBracketPrefix &&
            !partialSourceLabel &&
            !foreignCitationGlyph &&
            !verifiedPrefix &&
            !repeatedNumericLabel
          : (referenceNumber.test(sourceLabel)
              ? numericOccurrences !== 1 && !verifiedMergedBracketNumber
              : originalRun.split(sourceLabel).length !== 2) &&
            !repeatedNumericLabel &&
            !appendixLetter &&
            !panelNumber &&
            !typedReferenceNumber)) ||
      (!verifiedUri &&
        !verifiedCollective &&
        sourceLabel !== label &&
        !fragmentLabels.includes(sourceLabel) &&
        (!key || pdfLinkLabelKey(sourceLabel) !== key))
    ) {
      if (retainLink()) continue
      throw validationError('PDF link label changed')
    }
    const owners = units.filter(
      (unit, unitIndex) =>
        !unchanged(unitIndex) &&
        (!verifiedUri || uriOwners.includes(unit)) &&
        (!verifiedCollective || collectiveOwners.includes(unit)) &&
        (!verifiedRepeatedDated || repeatedDatedOwners.includes(unit)) &&
        (!verifiedPrefix || prefixOwners.includes(unit)) &&
        (!typedReferenceNumber || typedOwners.includes(unit)) &&
        (!nativeBracketedSources.length || bracketedOwners.includes(unit)) &&
        textKey(unit.source).includes(sourceLabel) &&
        textKey(renderUnits[unitIndex].translation).includes(label) &&
        (!partialRangeLabel ||
          !partialSourceLabel ||
          (textKey(unit.source).split(sourceLabel).length === 2 &&
            textKey(renderUnits[unitIndex].translation).split(label).length === 2)) &&
        (key !== null ||
          typedOwners.includes(unit) ||
          fragmentLabels.includes(sourceLabel) ||
          uriOwners.includes(unit) ||
          (/^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .&'’−-]*$/u.test(literalLabel) &&
            (() => {
              const spelling = literalLabel
                  .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
                  .replaceAll(' ', '\\s+'),
                pattern = new RegExp(`(?<![A-Za-z])${spelling}(?![A-Za-z])`, 'gu'),
                count = [...unit.source.matchAll(pattern)].length
              const translation = renderUnits[unitIndex].translation
              return (
                (count > 0 && count === [...translation.matchAll(pattern)].length) ||
                (/^[a-z]$/u.test(sourceLabel) &&
                  translatedPdfLinkFragment(
                    unit.source,
                    translation,
                    sourceLabel,
                    unit.source.lastIndexOf(sourceLabel)
                  )?.text === literalLabel) ||
                [...unit.source.matchAll(pattern)].some((match) => {
                  const citation = translatedPdfLinkLabel(
                    unit.source,
                    translation,
                    match[0],
                    match.index
                  )
                  return citation !== null && textKey(citation.text) === label
                })
              )
            })()) ||
          /^(?:\[\d+(?:[,–-]\d+)*\]|[\d,.;:–−-]+)$/u.test(label) ||
          (/^\d{4}[a-z]$/u.test(label) &&
            (() => {
              const occurrences = [
                ...unit.source.matchAll(new RegExp(`(?<![A-Za-z\\d])${label}(?![A-Za-z\\d])`, 'gu'))
              ]
              return (
                occurrences.length > 0 &&
                occurrences.every(
                  (match) =>
                    translatedPdfLinkFragment(
                      unit.source,
                      renderUnits[unitIndex].translation,
                      label,
                      match.index
                    )?.text === label
                )
              )
            })()) ||
          (textKey(unit.source).split(label).length === 2 &&
            textKey(renderUnits[unitIndex].translation).split(label).length === 2)) &&
        unit.fragments.some((fragment) => {
          if (fragment.pageNumber !== number) return false
          const containsLink = (
            box: readonly number[],
            view: typeof target,
            region: typeof fragment.rect
          ): boolean =>
            [
              view.convertToViewportPoint(box[0], box[1]),
              view.convertToViewportPoint(box[2], box[3])
            ].every(
              ([x, y]) =>
                x >= region.x * view.width - 2 &&
                x <= (region.x + region.width) * view.width + 2 &&
                y >= region.y * view.height - 2 &&
                y <= (region.y + region.height) * view.height + 2
            )
          if (containsLink(annotation.rect, source, fragment.rect)) {
            if (
              unit.fragments.some(
                ({ pageNumber, rect }) =>
                  pageNumber === number && containsLink(moved.rect, target, rect)
              )
            )
              return true

            // An unchanged hit area can cross the join between two
            // contiguous rows of its own paragraph after reflow.
            if (
              /^(?:18|19|20)\d{2}$/u.test(label) &&
              [0, 1].every(
                (axis) =>
                  Math.abs(
                    annotation.rect[axis + 2] -
                      annotation.rect[axis] -
                      (moved.rect[axis + 2] - moved.rect[axis])
                  ) <= 0.002
              ) &&
              source.rotation === 0 &&
              target.rotation === 0 &&
              unit.fragments.some(({ pageNumber, rect: upper }, row) => {
                const lower = unit.fragments[row + 1]
                return (
                  pageNumber === number &&
                  lower?.pageNumber === number &&
                  Math.abs(upper.x - lower.rect.x) * target.width <= 0.001 &&
                  Math.abs(upper.width - lower.rect.width) * target.width <= 0.001 &&
                  Math.abs(upper.y + upper.height - lower.rect.y) <=
                    Math.min(upper.height, lower.rect.height) * 0.1 &&
                  containsLink(moved.rect, target, {
                    ...upper,
                    height: lower.rect.y + lower.rect.height - upper.y
                  }) &&
                  linkedItems(text, moved.rect).some((item) => {
                    const [size, , , , x, y] = item.transform
                    const baseline = y + size * 0.3
                    return (
                      item.str.trim() === label &&
                      [upper, lower.rect].some(
                        (region) =>
                          x >= region.x * target.width - 0.001 &&
                          x + item.width <= (region.x + region.width) * target.width + 0.001 &&
                          baseline <= (1 - region.y) * target.height + 0.001 &&
                          baseline >= (1 - region.y - region.height) * target.height - 0.001
                      )
                    )
                  })
                )
              })
            )
              return true
          }
          // Some publishers give one citation a taller hit area than its
          // text line. Keep only that existing vertical envelope, with
          // the linked text still owned by this same unique paragraph.
          if (source.rotation !== 0 || target.rotation !== 0) return false
          const r = fragment.rect,
            left = r.x * source.width,
            right = (r.x + r.width) * source.width,
            bottom = source.height * (1 - r.y - r.height),
            top = source.height * (1 - r.y),
            originalBox = annotation.rect,
            movedBox = moved.rect,
            centerY = (originalBox[1] + originalBox[3]) / 2
          if (
            centerY < bottom ||
            centerY > top ||
            [originalBox, movedBox].some((box) => box[0] < left - 2 || box[2] > right + 2)
          )
            return false
          const points = (item: TextItem): number[][] => {
            const [a, b, , , x, y] = item.transform
            if (a <= 0 || Math.abs(b) > 0.001) return []
            return [
              [x, y + a * 0.3],
              [x + item.width, y + a * 0.3]
            ]
          }
          const inside = (item: TextItem, box: readonly number[]): boolean => {
            const ink = points(item)
            return (
              ink.length === 2 &&
              ink.every(
                ([x, y]) =>
                  x >= box[0] - 0.001 &&
                  x <= box[2] + 0.001 &&
                  y >= box[1] - 0.001 &&
                  y <= box[3] + 0.001
              )
            )
          }
          const ownerBox = [left - 2, bottom - 2, right + 2, top + 2],
            before = linkedItems(originalText!, originalBox, true),
            after = linkedItems(text, movedBox, true)
          if (
            movedBox[1] < Math.min(bottom, originalBox[1]) - 0.001 ||
            movedBox[3] > Math.max(top, originalBox[3]) + 0.001
          ) {
            // A line-leading figure link can keep its full hit area
            // while its localized glyphs adjust the original baseline.
            if (
              !key?.startsWith('figure:') ||
              !annotation.destinationCoordinates.length ||
              before.length !== 1 ||
              after.length !== 1 ||
              !fragment.items.some(
                (part) =>
                  originalText!.items[part.index] === before[0] && part.text === before[0].str
              ) ||
              ![before[0], after[0]].every((item, position) => {
                const [a, b, c, d, x] = item.transform
                return (
                  a > 0 &&
                  a === d &&
                  b === 0 &&
                  c === 0 &&
                  Math.abs(x - [originalBox, movedBox][position][0]) < 0.001
                )
              }) ||
              Math.abs(movedBox[0] - originalBox[0]) >= 0.001 ||
              Math.abs(movedBox[1] - originalBox[1]) > before[0].transform[0] / 100 ||
              Math.abs(movedBox[3] - originalBox[3]) > before[0].transform[0] / 100 ||
              ![before[0].str, unit.source, renderUnits[unitIndex].translation].every((value) => {
                const [match, next] = pdfLinkLabelMatches(value, label)
                return match?.index === 0 && !next
              }) ||
              pdfLinkLabelKey(after[0].str) !== key
            )
              return false
          }
          return (
            before.some((item) => inside(item, ownerBox)) &&
            after.some((item) => inside(item, ownerBox)) &&
            after.every((item) => inside(item, ownerBox) || inside(item, originalBox))
          )
        })
    )
    if (owners.length !== 1) {
      if (retainLink()) continue
      throw validationError('PDF link left its source paragraph')
    }
  }
  return { pageLatinAccentText, pendingRetentions }
}

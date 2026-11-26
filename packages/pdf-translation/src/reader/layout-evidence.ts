import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'

type LayoutUnit = PdfTranslationLayout['units'][number]

export function samePageSize(left: PdfLayoutPage, right: PdfLayoutPage): boolean {
  return left.width === right.width && left.height === right.height
}

export function sameUnrotatedPageSize(left: PdfLayoutPage, right: PdfLayoutPage): boolean {
  return !left.rotation && !right.rotation && samePageSize(left, right)
}

export function appendLayoutUnitText(head: LayoutUnit, tail: LayoutUnit): void {
  head.source += ' ' + tail.source
  head.items.push(...tail.items)
  head.originalStrings.push(...tail.originalStrings)
  head.fragments.push(...tail.fragments)
}

// Affine geometry requires both font extents. The horizontal source check can
// also admit ordinary runs whose font extents are unavailable.
export function nativeAffineTextItem(i: PdfLayoutTextItem): boolean {
  return (
    !!i &&
    i.dir === 'ltr' &&
    !!i.fontName &&
    i.transform.length === 6 &&
    [...i.transform, i.width, i.height, i.fontAscent!, i.fontDescent!].every(Number.isFinite) &&
    i.width > 0 &&
    i.height > 0 &&
    i.fontAscent! > 0 &&
    i.fontAscent! <= 1 &&
    i.fontDescent! <= 0 &&
    i.fontDescent! >= -1 &&
    i.fontAscent! > i.fontDescent! &&
    i.fontVertical === false
  )
}
export function nativeHorizontalSourceItem(i: PdfLayoutTextItem): boolean {
  return (
    !!i &&
    i.dir === 'ltr' &&
    !!i.fontName &&
    i.transform.length === 6 &&
    [...i.transform, i.width, i.height].every(Number.isFinite) &&
    i.width > 0 &&
    i.height > 0 &&
    i.transform[0] > 0 &&
    i.transform[1] === 0 &&
    i.transform[2] === 0 &&
    Math.abs(i.transform[3] - i.height) < 1e-6 &&
    i.fontVertical === false
  )
}
export function nativeContentsUpright(i: PdfLayoutTextItem): boolean {
  return (
    nativeAffineTextItem(i) &&
    i.transform[0] > 0 &&
    i.transform[1] === 0 &&
    i.transform[2] === 0 &&
    Math.abs(i.transform[3] - i.height) < 1e-6
  )
}

export function nativeReferenceItems(
  unit: LayoutUnit,
  pages: PdfLayoutPage[]
): PdfLayoutTextItem[] {
  const items: PdfLayoutTextItem[] = []
  for (const key of unit.items) {
    const [page, index] = key.split(':').map(Number)
    const nativePage = pages[page - 1],
      item = nativePage?.items[index]
    if (!nativePage || nativePage.page !== page || !item) return []
    items.push(item)
  }
  return items
}

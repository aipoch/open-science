import type { PdfTranslationResults } from './pdf-translation'
import { isPdfTranslationCaption } from './pdf-translation-layout'

// Prepare layout capacity without changing extraction or source-item ownership.
export function pdfTranslationLayoutFragments(
  unit: PdfTranslationResults['source']['units'][number],
  source: PdfTranslationResults['source']
): Array<PdfTranslationResults['source']['units'][number]['fragments'][number]> {
  const result: Array<PdfTranslationResults['source']['units'][number]['fragments'][number]> = []
  for (const fragment of unit.fragments) {
    const previous = result.at(-1)
    if (!previous || previous.pageNumber !== fragment.pageNumber) {
      result.push(fragment)
      continue
    }
    const a = previous.rect,
      b = fragment.rect,
      page = source.pages[fragment.pageNumber - 1]
    const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const gap = (b.y - a.y - a.height) * page.height
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y)
    const rect = {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y
    }
    let otherContent = false
    for (const other of source.units) {
      if (other === unit) continue
      for (const f of other.fragments) {
        if (
          f.pageNumber !== fragment.pageNumber ||
          f.rect.x >= rect.x + rect.width ||
          f.rect.x + f.rect.width <= rect.x ||
          f.rect.y >= rect.y + rect.height ||
          f.rect.y + f.rect.height <= rect.y
        )
          continue
        // PDF.js line boxes with scripts can overlap by up to two points even though
        // their glyphs do not. Trim only that edge; native ownership still
        // proves the complete source before replacing anything.
        if (f.rect.y > rect.y && (rect.y + rect.height - f.rect.y) * page.height <= 2) {
          rect.height = f.rect.y - rect.y
        } else if (
          f.rect.y + f.rect.height < rect.y + rect.height &&
          (f.rect.y + f.rect.height - rect.y) * page.height <= 2
        ) {
          const top = f.rect.y + f.rect.height
          rect.height -= top - rect.y
          rect.y = top
        } else otherContent = true
      }
    }
    if (
      b.y > a.y &&
      // Tall inline fractions can overlap the next line's font box. Merge
      // only a minority of the shorter box; neighbor ownership is checked above.
      gap >= -Math.max(2, Math.min(a.height, b.height) * page.height * 0.5) &&
      gap <= 2 &&
      // A paragraph can narrow beside a figure. Keep that change in footprint
      // instead of filling its bounding rectangle across the neighboring graphic.
      (overlap >= Math.max(a.width, b.width) * 0.8 ||
        (isPdfTranslationCaption(unit.source) &&
          fragment === unit.fragments.at(-1) &&
          Math.abs(a.x - b.x) * page.width <= 1 &&
          b.width < a.width)) &&
      !otherContent
    ) {
      result[result.length - 1] = {
        ...previous,
        rect,
        items: [...previous.items, ...fragment.items]
      }
    } else result.push(fragment)
  }
  // Short labels, headings and page counters often expand in another language.
  // Their ink width is not the full usable cell. Borrow at most two line-heights
  // of clear space, with the same boundary rule for every short single-line unit.
  const shortLine =
    result.length === 1 &&
    unit.source.trim().length <= 80 &&
    /\p{L}/u.test(unit.source) &&
    result[0].rect.height * source.pages[result[0].pageNumber - 1].height <= 20
  // A wrapped prose paragraph can contain a URL as wide as its entire column.
  // Its translated parentheses need a little clear horizontal space as well.
  // Keep the original height; native source, link and paint preflight still
  // reject any neighboring content in this bounded margin.
  const multilineUrl =
    result.length === 1 &&
    result[0].items.length >= 2 &&
    result[0].rect.height * source.pages[result[0].pageNumber - 1].height > 20 &&
    unit.source.trim().length > 80 &&
    /https?:\/\/[^\s)）]{12,}/u.test(unit.source) &&
    /[.!?。]$/u.test(unit.source) &&
    (unit.source.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6
  if (shortLine || multilineUrl) {
    const fragment = result[0],
      { rect, pageNumber } = fragment,
      page = source.pages[pageNumber - 1],
      right = rect.x + rect.width
    let end = Math.min(
      1 - 2 / page.width,
      right + Math.min(24, rect.height * page.height * 2) / page.width
    )
    for (const other of source.units) {
      if (other === unit) continue
      for (const next of other.fragments) {
        if (
          next.pageNumber === pageNumber &&
          next.rect.x + next.rect.width > right &&
          next.rect.y < rect.y + rect.height &&
          next.rect.y + next.rect.height > rect.y
        )
          end = Math.min(end, next.rect.x - 2 / page.width)
      }
    }
    const width = Math.max(right, end) - rect.x,
      bottom = rect.y + rect.height
    const numberedLabel = /^([A-Z]+)\d+$/.exec(unit.source.trim()),
      numberedRow =
        numberedLabel &&
        source.units.some(
          (other) =>
            other !== unit &&
            /^[−+-]?\d+(?:[.,]\d+)?$/u.test(other.source.trim()) &&
            other.fragments.some(
              (next) =>
                next.pageNumber === pageNumber &&
                next.rect.x >= right &&
                Math.abs(next.rect.y - rect.y) * page.height <= 2
            )
        ) &&
        source.units.some(
          (other) =>
            other !== unit &&
            new RegExp(`^${numberedLabel[1]}\\d+$`).test(other.source.trim()) &&
            other.fragments.some(
              (next) =>
                next.pageNumber === pageNumber &&
                next.rect.y >= bottom &&
                (next.rect.y - bottom) * page.height <= 24 &&
                Math.abs(next.rect.x - rect.x) * page.width <= 2
            )
        ),
      dateFields =
        /^[\p{L} ]+:\s*\d{1,2}\s+\p{L}+\s+\d{4}(?:\s*\/\s*[\p{L} ]+:\s*\d{1,2}\s+\p{L}+\s+\d{4})+$/u.test(
          unit.source.trim()
        )
    // Only a proven numbered table row or complete date fields may borrow a
    // second line. Ordinary prose and linked labels keep their native padding.
    // Other source rows, page edges and native paint still bound that space.
    let low = Math.min(
      1 - 2 / page.height,
      bottom +
        (numberedRow || dateFields
          ? Math.min(12, rect.height * page.height * 1.25)
          : shortLine
            ? 0.25
            : 0) /
          page.height
    )
    for (const other of source.units) {
      if (other === unit) continue
      for (const next of other.fragments) {
        if (
          next.pageNumber === pageNumber &&
          next.rect.x < rect.x + width &&
          next.rect.x + next.rect.width > rect.x &&
          next.rect.y + next.rect.height > bottom
        )
          low = Math.min(low, next.rect.y - 2 / page.height)
      }
    }
    result[0] = { ...fragment, rect: { ...rect, width, height: Math.max(bottom, low) - rect.y } }
  }
  // Figure captions may borrow surrounding whitespace. A one-line prose
  // sentence may wrap downwards; table values keep their existing footprint.
  if (!result.length) return result
  const captionHeading = (text: string): boolean =>
    /^(?:figure|fig\.)\s*\d+\b/i.test(text) && isPdfTranslationCaption(text)
  let caption = captionHeading(unit.source)
  let next = unit.fragments[0]
  for (let index = source.units.indexOf(unit) - 1; !caption && index >= 0; index--) {
    const previous = source.units[index],
      last = previous.fragments.at(-1)
    if (!last || last.pageNumber !== next.pageNumber || /[.!?。]$/.test(previous.source)) break
    const page = source.pages[next.pageNumber - 1]
    const gap = (next.rect.y - last.rect.y - last.rect.height) * page.height
    if (gap < 0 || gap > 2 || Math.abs(next.rect.x - last.rect.x) * page.width > 2) break
    caption = captionHeading(previous.source)
    next = previous.fragments[0]
  }
  const singleLineSentence =
    unit.fragments.length === 1 &&
    unit.fragments[0].items.length === 1 &&
    /[.!?。]$/.test(unit.source) &&
    (unit.source.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6
  const singleLineBullet =
    unit.fragments.length === 1 &&
    /^[•●▪]\s+/u.test(unit.source) &&
    (unit.source.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6
  const singleLineStatement =
    unit.fragments.length === 1 &&
    /^(?:Definition|Lemma|Theorem|Proposition|Corollary)\s+\d+(?:\.\d+)*[.:]/u.test(unit.source)
  if (!caption && !singleLineSentence && !singleLineBullet && !singleLineStatement) return result
  return result.map((fragment) => {
    const { rect, pageNumber } = fragment,
      page = source.pages[pageNumber - 1],
      bottom = rect.y + rect.height
    if (
      source.units.some(
        (other) =>
          other !== unit &&
          other.fragments.some(
            (next) =>
              next.pageNumber === pageNumber &&
              next.rect.x < rect.x + rect.width &&
              next.rect.x + next.rect.width > rect.x &&
              next.rect.y < bottom &&
              next.rect.y + next.rect.height > rect.y
          )
      )
    )
      return fragment
    // Captions often need extra translated lines. Borrow at most 24 points below
    // and 12 points to the right, retaining two points before other source regions. Native
    // preflight also rejects any intersecting image, path or unowned text.
    let limit = Math.min(1 - 2 / page.height, bottom + 24 / page.height)
    for (const other of source.units)
      for (const next of other.fragments) {
        if (
          next.pageNumber === pageNumber &&
          next.rect.y >= bottom - 0.5 / page.height &&
          next.rect.x < rect.x + rect.width &&
          next.rect.x + next.rect.width > rect.x
        )
          limit = Math.min(limit, next.rect.y - 2 / page.height)
      }
    limit = Math.max(bottom, limit)
    const right = rect.x + rect.width
    let rightLimit =
      caption || singleLineBullet
        ? Math.min(1 - 2 / page.width, right + (singleLineBullet ? 24 : 12) / page.width)
        : right
    for (const other of source.units)
      for (const next of other.fragments) {
        if (
          next.pageNumber === pageNumber &&
          next.rect.x >= right - 0.5 / page.width &&
          next.rect.y < limit &&
          next.rect.y + next.rect.height > rect.y
        )
          rightLimit = Math.min(rightLimit, next.rect.x - 2 / page.width)
      }
    // A definition often has an equation immediately below but empty space above.
    // Borrow one line above it without crossing any preceding source region.
    let top = rect.y
    if (singleLineStatement) {
      top = Math.max(2 / page.height, rect.y - 12 / page.height)
      for (const other of source.units)
        for (const previous of other.fragments) {
          if (
            other === unit ||
            previous.pageNumber !== pageNumber ||
            previous.rect.x >= rect.x + rect.width ||
            previous.rect.x + previous.rect.width <= rect.x ||
            previous.rect.y >= rect.y
          )
            continue
          top = Math.max(
            top,
            Math.min(rect.y, previous.rect.y + previous.rect.height + 2 / page.height)
          )
        }
    }
    return {
      ...fragment,
      rect: {
        ...rect,
        y: top,
        height: limit - top,
        width: Math.max(right, rightLimit) - rect.x
      }
    }
  })
}

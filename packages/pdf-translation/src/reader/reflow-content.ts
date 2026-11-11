import type { PdfTranslationSource } from './source.js'
import {
  hasNativeCaptionEligibility,
  hasNativeOrdinaryProseEligibility
} from './caption-eligibility.js'

export type PdfReflowContentKind = 'text' | 'reference' | 'visual'

// Repeated whole source fragments establish the reference column's right edge;
// a short heading alone cannot distinguish a deeply indented body paragraph.
function referenceColumnRight(
  source: PdfTranslationSource,
  anchor: PdfTranslationSource['units'][number]['fragments'][number]
): number | undefined {
  const witnesses = source.units.flatMap((unit) =>
    unit.figure ||
    (unit.preserve && unit.preserve !== 'reference') ||
    (unit.source.match(/[A-Za-z]{2,}/gu)?.length ?? 0) < 8
      ? []
      : unit.fragments
          .filter(
            ({ pageNumber, rect }) =>
              pageNumber === anchor.pageNumber &&
              Math.abs(rect.x - anchor.rect.x) < 0.03 &&
              rect.width > 0.2 &&
              rect.width < 0.5 &&
              rect.height > 0.008
          )
          .map(({ rect }) => rect)
  )
  if (witnesses.length < 2) return
  const right = Math.max(...witnesses.map((rect) => rect.x + rect.width))
  const aligned = witnesses.filter((rect) => Math.abs(rect.x + rect.width - right) < 0.015)
  if (
    aligned.length < 2 ||
    Math.max(...aligned.map((rect) => rect.y)) - Math.min(...aligned.map((rect) => rect.y)) <=
      Math.min(...aligned.map((rect) => rect.height)) / 2
  )
    return
  return Math.max(right, anchor.rect.x + anchor.rect.width)
}

// A centered heading has no left-edge body witnesses. One numbered entry may
// resume above it in the next column; close that specific native reference seam
// rather than treating all right-column body above the heading as bibliography.
function numberedReferenceColumnContinuation(
  source: PdfTranslationSource,
  anchor: PdfTranslationSource['units'][number]['fragments'][number],
  unit: PdfTranslationSource['units'][number]
): boolean {
  const number = /^\[(\d{1,4})\]\s+\p{Lu}/u.exec(unit.source)?.[1],
    part = unit.fragments[0]
  if (
    !number ||
    unit.referenceBoundary ||
    unit.fragments.length !== 1 ||
    part.pageNumber !== anchor.pageNumber ||
    part.rect.y >= 0.2 ||
    part.rect.y + part.rect.height >= anchor.rect.y ||
    !/\b(?:19|20)\d{2}\b/u.test(unit.source) ||
    (unit.source.match(/[A-Za-z]{2,}/gu)?.length ?? 0) < 8
  )
    return false
  const matches = (n: number): PdfTranslationSource['units'] =>
    source.units.filter(
      (u) =>
        u.sourceOnly &&
        u.preserve === 'reference' &&
        u.fragments.length === 1 &&
        u.fragments[0].pageNumber === anchor.pageNumber &&
        new RegExp(`^\\[${n}\\]\\s+`, 'u').test(u.source)
    )
  const prior = matches(Number(number) - 1),
    before = matches(Number(number) - 2),
    after = matches(Number(number) + 1)
  if (prior.length !== 1 || before.length !== 1 || after.length !== 1) return false
  const left = prior[0].fragments[0].rect,
    earlier = before[0].fragments[0].rect,
    right = after[0].fragments[0].rect,
    current = part.rect
  if (
    left.width < 0.2 ||
    left.width > 0.5 ||
    left.y + left.height < 0.6 ||
    earlier.y >= left.y ||
    Math.abs(earlier.x - left.x) > 0.005 ||
    Math.abs(earlier.width - left.width) > 0.015 ||
    Math.abs(anchor.rect.x + anchor.rect.width / 2 - left.x - left.width / 2) > 0.015 ||
    anchor.rect.x <= left.x ||
    anchor.rect.x + anchor.rect.width >= left.x + left.width ||
    current.x <= left.x + left.width + 0.01 ||
    Math.abs(current.width - left.width) > 0.015 ||
    Math.abs(right.x - current.x) > 0.005 ||
    Math.abs(right.width - current.width) > 0.015 ||
    right.y < current.y + current.height ||
    right.y - current.y - current.height > 0.03
  )
    return false
  const seam = [prior[0], unit, after[0]].map((u) => u.fragments[0].items)
  if (
    seam.some(
      (items) =>
        !items.length ||
        items.some(
          (i, n) =>
            !Number.isSafeInteger(i.index) ||
            i.index < 0 ||
            (n > 0 && i.index <= items[n - 1].index)
        )
    )
  )
    return false
  if (seam[0].at(-1)!.index >= seam[1][0].index || seam[1].at(-1)!.index >= seam[2][0].index)
    return false
  const keys = new Set(seam[1].map((i) => i.index)),
    gap = source.units.flatMap((u) =>
      u.fragments.flatMap((f) =>
        f.pageNumber === anchor.pageNumber
          ? f.items.filter(
              (i) => i.text.trim() && i.index > seam[0].at(-1)!.index && i.index < seam[2][0].index
            )
          : []
      )
    )
  return gap.length === keys.size && gap.every((i) => keys.has(i.index))
}

/** Classify legacy snapshots without changing their immutable translation indices. */
export function pdfReflowContentKinds(
  source: PdfTranslationSource
): ReadonlyMap<string, PdfReflowContentKind> {
  const kinds = new Map<string, PdfReflowContentKind>()
  let reference: PdfTranslationSource['units'][number]['fragments'][number] | undefined
  const columnEdges = new Map<NonNullable<typeof reference>, number | undefined>()
  for (const unit of source.units) {
    if (
      hasNativeCaptionEligibility(source, unit) ||
      hasNativeOrdinaryProseEligibility(source, unit)
    ) {
      kinds.set(unit.id, 'text')
      continue
    }
    if (unit.figure || (unit.preserve && unit.preserve !== 'reference')) {
      kinds.set(unit.id, 'visual')
      continue
    }
    const text = unit.source.trim(),
      fragment = unit.fragments[0]
    const heading = text
      .replace(/^(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[.)])\s+/u, '')
      .replace(/[:：]$/u, '')
      .trimEnd()
    if (unit.referenceBoundary && !unit.sourceOnly) reference = undefined
    else if (
      /^(?:references|bibliography|literature cited|works cited|参考文献|參考文獻)[:：]?$/iu.test(
        heading
      )
    )
      reference = fragment
    else if (
      reference &&
      fragment.pageNumber > reference.pageNumber &&
      (/^(?:appendix|appendices|supplementary material|acknowledgments?|acknowledgements?|funding|author contributions|disclosures|conflicts? of interest|data availability|code availability|附录|附錄)(?:\s+\S.*)?$/iu.test(
        heading
      ) ||
        (!unit.sourceOnly && /^[A-Z][.\s]+[A-Z][A-Za-z\s-]{3,70}$/u.test(heading))) &&
      fragment.rect.width > 0.12 &&
      fragment.rect.height > 0.01
    )
      reference = undefined
    // Reading-order snapshots can list a right-column References heading before
    // left-column body paragraphs. A following column can also resume references
    // above a left-column heading; only that column's horizontal start proves it.
    const anchor = reference
    if (anchor && !columnEdges.has(anchor))
      columnEdges.set(anchor, referenceColumnRight(source, anchor))
    const columnRight = anchor && columnEdges.get(anchor)
    const inReferences =
      anchor &&
      (numberedReferenceColumnContinuation(source, anchor, unit) ||
        unit.fragments.every(
          ({ pageNumber, rect }) =>
            pageNumber > anchor.pageNumber ||
            (pageNumber === anchor.pageNumber &&
              rect.x + rect.width > anchor.rect.x + 0.01 &&
              (rect.y + rect.height > anchor.rect.y ||
                (columnRight !== undefined && rect.x > columnRight + 0.01)))
        ))
    if (inReferences || unit.preserve === 'reference') kinds.set(unit.id, 'reference')
    else {
      const words = text.match(/[A-Za-z]{2,}/gu)?.length ?? 0
      const prose =
        words >= 14 &&
        unit.fragments.every(({ rect }) => rect.width > 0.2) &&
        !/[=∑∫√{}]/u.test(text)
      kinds.set(unit.id, !unit.sourceOnly || prose ? 'text' : 'visual')
    }
  }
  return kinds
}

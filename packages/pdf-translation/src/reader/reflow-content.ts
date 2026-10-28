import type { PdfTranslationSource } from './source.js'

export type PdfReflowContentKind = 'text' | 'reference' | 'visual'

/** Classify legacy snapshots without changing their immutable translation indices. */
export function pdfReflowContentKinds(
  source: PdfTranslationSource
): ReadonlyMap<string, PdfReflowContentKind> {
  const kinds = new Map<string, PdfReflowContentKind>()
  let reference: PdfTranslationSource['units'][number]['fragments'][number] | undefined
  for (const unit of source.units) {
    if (unit.figure || (unit.preserve && unit.preserve !== 'reference')) {
      kinds.set(unit.id, 'visual')
      continue
    }
    const text = unit.source.trim(),
      fragment = unit.fragments[0]
    const heading = text
      .replace(/^(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[.)])\s+/u, '')
      .replace(/[:：]$/u, '')
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
      (/^(?:appendix|appendices|supplementary material|acknowledgments?|acknowledgements?|funding|author contributions|disclosures|conflicts? of interest|data availability|code availability|附录|附錄)(?:\s+.+)?$/iu.test(
        heading
      ) ||
        (!unit.sourceOnly && /^[A-Z][.\s]+[A-Z][A-Za-z\s-]{3,70}$/u.test(heading))) &&
      fragment.rect.width > 0.12 &&
      fragment.rect.height > 0.01
    )
      reference = undefined
    // Reading-order snapshots can list a right-column References heading before
    // left-column body paragraphs. Those paragraphs still precede the bibliography.
    const anchor = reference
    const inReferences =
      anchor &&
      unit.fragments.every(
        ({ pageNumber, rect }) =>
          pageNumber > anchor.pageNumber ||
          (pageNumber === anchor.pageNumber &&
            rect.x + rect.width > anchor.rect.x + 0.01 &&
            rect.y + rect.height > anchor.rect.y)
      )
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

type PageFragments = { fragments: readonly { pageNumber: number }[] }

/** A rendering or recovery pass keeps all pages of each joined unit together. */
export function includeJoinedPdfPages(pages: Set<number>, units: readonly PageFragments[]): void {
  let previousSize: number
  do {
    previousSize = pages.size
    for (const unit of units)
      if (unit.fragments.some((fragment) => pages.has(fragment.pageNumber)))
        for (const fragment of unit.fragments) pages.add(fragment.pageNumber)
  } while (pages.size !== previousSize)
}

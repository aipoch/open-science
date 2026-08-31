export type PdfSearchPageMatches = Readonly<{ pageNumber: number; count: number }>
export type PdfSearchMatch = Readonly<{ pageNumber: number; occurrence: number }>

export const countPdfSearchOccurrences = (text: string, query: string): number => {
  if (!query) return 0
  let count = 0
  let index = 0
  while ((index = text.indexOf(query, index)) >= 0) {
    count += 1
    index += Math.max(1, query.length)
  }
  return count
}

export const resolvePdfSearchMatch = (
  pages: readonly PdfSearchPageMatches[],
  selectedIndex: number
): PdfSearchMatch | undefined => {
  let remaining = selectedIndex
  for (const page of pages) {
    if (remaining < page.count) {
      return { pageNumber: page.pageNumber, occurrence: remaining }
    }
    remaining -= page.count
  }
  return undefined
}

export type SearchMatch = { start: number; end: number }
export type SearchSort = 'relevance' | 'recent'
export type SearchFileFormat = 'pdf' | 'spreadsheet' | 'notebook' | 'image'

export const SEARCH_FILE_EXTENSIONS: Record<SearchFileFormat, readonly string[]> = {
  pdf: ['pdf'],
  spreadsheet: ['csv', 'tsv', 'xls', 'xlsx', 'ods'],
  notebook: ['ipynb'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'tif', 'tiff', 'bmp', 'avif']
}
export const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3')

export const searchTitleRank = (title: string, query: string): number => {
  const needle = normalizeSearchText(query.trim())
  if (!needle) return 0
  const text = normalizeSearchText(title)
  return text === needle ? 3 : text.startsWith(needle) ? 2 : text.includes(needle) ? 1 : 0
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Map normalized matches back to original graphemes, including composed accents and fullwidth text.
export const findSearchMatches = (text: string, query: string, limit = Infinity): SearchMatch[] => {
  const needle = normalizeSearchText(query.trim())
  if (!needle) return []
  const folded = normalizeSearchText(text)
  if (!folded.includes(needle)) return []
  const matches: SearchMatch[] = []
  // Ordinary normalized text keeps UTF-16 offsets, so large transcripts avoid a grapheme map.
  if (text.normalize('NFKC') === text && folded.length === text.length) {
    let offset = 0
    while (offset < folded.length && matches.length < limit) {
      const index = folded.indexOf(needle, offset)
      if (index < 0) break
      const end = index + needle.length
      if (!/\p{M}/u.test(folded.slice(end, end + 1))) matches.push({ start: index, end })
      offset = end
    }
    return matches
  }
  const starts: number[] = []
  const ends: number[] = []
  for (const { segment, index } of segmenter.segment(text)) {
    const normalized = normalizeSearchText(segment)
    for (let i = 0; i < normalized.length; i++) {
      starts.push(index)
      ends.push(index + segment.length)
    }
  }
  let offset = 0
  while (offset < folded.length && matches.length < limit) {
    const index = folded.indexOf(needle, offset)
    if (index < 0) break
    const end = index + needle.length
    if (
      (index === 0 || starts[index - 1] !== starts[index]) &&
      (end === folded.length || ends[end - 1] !== ends[end])
    ) {
      matches.push({ start: starts[index]!, end: ends[end - 1]! })
    }
    offset = end
  }
  return matches
}

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3')
export const searchTitleRank = (title: string, query: string): number => {
  const needle = normalize(query.trim())
  if (!needle) return 0
  const text = normalize(title)
  return text === needle ? 3 : text.startsWith(needle) ? 2 : text.includes(needle) ? 1 : 0
}

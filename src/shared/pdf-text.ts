export type PdfTextItem = Readonly<{
  str?: string
  hasEOL?: boolean
  dir?: string
  transform?: readonly number[]
  width?: number
  height?: number
}>

const fontHeight = (item: PdfTextItem): number => {
  if (item.height && item.height > 0) return item.height
  const transform = item.transform
  return transform && transform.length >= 4 ? Math.hypot(transform[2], transform[3]) : 0
}

const hasWordGap = (previous: PdfTextItem, current: PdfTextItem): boolean => {
  if ((previous.dir && previous.dir !== 'ltr') || (current.dir && current.dir !== 'ltr'))
    return false
  const previousTransform = previous.transform
  const currentTransform = current.transform
  if (
    !previousTransform ||
    previousTransform.length < 6 ||
    !currentTransform ||
    currentTransform.length < 6 ||
    previous.width === undefined
  ) {
    return false
  }
  const height = Math.max(fontHeight(previous), fontHeight(current))
  if (height <= 0 || Math.abs(previousTransform[5] - currentTransform[5]) > height / 2) return false
  return currentTransform[4] - (previousTransform[4] + previous.width) > height * 0.15
}

const hasCaptionBlockGap = (previous: PdfTextItem, current: PdfTextItem): boolean => {
  const label = previous.str ?? ''
  if (
    previous.hasEOL ||
    (!/[A-Za-z]{3,}$/u.test(label) &&
      !/^[0-9]{4}$/u.test(label) &&
      !/^[A-Za-z]{3,}(?:[ ,]+[A-Za-z]{3,})*[ ,]+[0-9]{1,2}$/u.test(label) &&
      !/^[A-Za-z]{3,}(?: +[A-Za-z]{3,})+ +↓$/u.test(label))
  )
    return false
  if ([...label].some((character) => character.charCodeAt(0) < 32)) return false
  if (!/^(?:Figure\s+[A-Z]?\d+\s*:|Fig\.\s+[A-Z]?\d+\.)(?=\s|$)/u.test(current.str ?? ''))
    return false
  const upright = (item: PdfTextItem): boolean => {
    const transform = item.transform
    return Boolean(
      transform &&
      transform.length === 6 &&
      transform.every(Number.isFinite) &&
      transform[0] > 0 &&
      transform[3] > 0 &&
      transform[1] === 0 &&
      transform[2] === 0 &&
      Number.isFinite(item.width) &&
      item.width! > 0 &&
      Number.isFinite(item.height) &&
      item.height! > 0 &&
      Math.abs(item.height! - transform[3]) < 1e-6 &&
      (!item.dir || item.dir === 'ltr')
    )
  }
  if (!upright(previous) || !upright(current)) return false
  if (current.transform![4] + current.width! >= previous.transform![4]) return false
  if (previous.height! * 1.5 >= current.height!) return false
  const height = Math.max(previous.height!, current.height!)
  const descendingDistance = previous.transform![5] - current.transform![5]
  return descendingDistance > 2 * height && descendingDistance - current.height! > height
}

export const joinPdfTextItems = (items: readonly PdfTextItem[]): string => {
  let text = ''
  let previousItem: PdfTextItem | undefined
  for (const item of items) {
    const value = item.str ?? ''
    if (!value) {
      // PDF.js can end a physical line with a separate empty item. It carries
      // no glyph geometry, but its explicit line-end flag still owns whitespace.
      if (item.hasEOL) text += '\n'
      continue
    }
    const previous = text.at(-1)
    if (previous && !/\s/u.test(previous) && !/^\s/u.test(value) && previousItem) {
      if (hasCaptionBlockGap(previousItem, item)) text += '\n'
      else if (hasWordGap(previousItem, item)) text += ' '
    }
    text += value
    if (item.hasEOL) text += '\n'
    previousItem = item
  }
  return text.trim()
}

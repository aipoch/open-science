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

export const joinPdfTextItems = (items: readonly PdfTextItem[]): string => {
  let text = ''
  let previousItem: PdfTextItem | undefined
  for (const item of items) {
    const value = item.str ?? ''
    if (!value) continue
    const previous = text.at(-1)
    if (
      previous &&
      !/\s/u.test(previous) &&
      !/^\s/u.test(value) &&
      previousItem &&
      hasWordGap(previousItem, item)
    ) {
      text += ' '
    }
    text += value
    if (item.hasEOL) text += '\n'
    previousItem = item
  }
  return text.trim()
}

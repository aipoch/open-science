import { groupPdfTranslationPages } from '@aipoch/pdf-translation/reader'
import type {
  PDFPageProxy,
  StructTreeNode,
  TextContent,
  TextItem
} from 'pdfjs-dist/types/src/display/api'
import { joinPdfTextItems } from '../../shared/pdf-text'

// A complete logical structure is stronger evidence than visual column geometry.
const taggedOrder = (content: TextContent, tree: StructTreeNode): TextItem[][] | undefined => {
  const groups = new Map<string, TextItem[]>()
  const stack: (string | undefined)[] = []
  let count = 0
  let previousGroup: TextItem[] | undefined
  for (const item of content.items) {
    if ('str' in item) {
      const id = stack.findLast((value) => value !== undefined)
      if (!id) {
        if (item.str.trim()) return undefined
        previousGroup?.push(item)
        continue
      }
      const group = groups.get(id) ?? []
      group.push(item)
      groups.set(id, group)
      previousGroup = group
      if (item.str.trim()) count++
    } else if (item.type === 'endMarkedContent') stack.pop()
    else stack.push(item.type === 'beginMarkedContentProps' ? item.id : undefined)
  }
  const ordered: TextItem[][] = []
  const visit = (node: StructTreeNode): void => {
    for (const child of node.children) {
      if ('children' in child) visit(child)
      else if (child.type === 'content') {
        const group = groups.get(child.id)
        if (group) ordered.push(group)
      }
    }
  }
  visit(tree)
  const items = ordered.flat().filter((item) => item.str.trim())
  return count > 0 && items.length === count && new Set(items).size === count ? ordered : undefined
}

export const readPdfPageText = async (page: PDFPageProxy): Promise<string> => {
  const content = await page.getTextContent({ includeMarkedContent: true })
  const nativeItems = content.items.filter((item): item is TextItem => 'str' in item)
  const native = (): string => joinPdfTextItems(nativeItems)
  const tree = await page.getStructTree()
  if (tree) {
    const ordered = taggedOrder(content, tree)
    // Incomplete tags must not drop untagged text or silently replace a declared order.
    return ordered ? joinPdfTextItems(ordered.flat()) : native()
  }
  if (page.rotate % 360 !== 0) return native()
  const [left, bottom, right, top] = page.view
  const packets: TextItem[][] = []
  for (const item of nativeItems) {
    if (item.str.trim()) packets.push([item])
    else packets.at(-1)?.push(item)
  }
  const items = packets.map((packet) => packet[0])
  if (
    !items.length ||
    ![left, bottom, right, top].every(Number.isFinite) ||
    right <= left ||
    top <= bottom ||
    items.some(
      (item) =>
        item.dir !== 'ltr' ||
        content.styles[item.fontName]?.vertical ||
        item.transform?.length !== 6 ||
        ![...item.transform, item.width, item.height].every(Number.isFinite) ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.transform[3] <= 0 ||
        item.width <= 0 ||
        item.height <= 0
    )
  )
    return native()

  const layout = groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: right - left,
        height: top - bottom,
        rotation: 0,
        items: items.map((item) => ({
          ...item,
          transform: [
            ...item.transform.slice(0, 4),
            item.transform[4] - left,
            item.transform[5] - bottom
          ],
          fontAscent: content.styles[item.fontName]?.ascent,
          fontDescent: content.styles[item.fontName]?.descent,
          fontVertical: content.styles[item.fontName]?.vertical
        }))
      }
    ]
  })
  const blocks = layout.pages[0].blocks
  const lines = blocks.flatMap((block) =>
    block.lines.length ? block.lines.map((line) => line.items) : [block.items]
  )
  const indexes = lines.flat().map((key) => Number(key.split(':')[1]))
  if (
    indexes.length !== items.length ||
    new Set(indexes).size !== items.length ||
    indexes.some((index) => !Number.isInteger(index) || !items[index]) ||
    blocks.some((block) => block.risks.includes('unsupported-orientation'))
  )
    return native()

  // Untagged paired rows can be a text table, even when every cell is a sentence.
  // Do not turn such rows into columns merely because there is a visual gutter.
  const pairedBaselines: number[] = []
  for (const a of blocks)
    for (const b of blocks) {
      if (a === b || a.rect.right >= b.rect.x) continue
      const tolerance = Math.min(a.rect.font, b.rect.font) * 0.25
      for (const line of a.lines) {
        if (!b.lines.some((other) => Math.abs(line.y - other.y) <= tolerance)) continue
        if (pairedBaselines.some((y) => Math.abs(y - line.y) > tolerance)) return native()
        pairedBaselines.push(line.y)
      }
    }
  // Preserve source strings and explicit whitespace instead of normalized paragraph text.
  return lines
    .map((line) => joinPdfTextItems(line.flatMap((key) => packets[Number(key.split(':')[1])])))
    .join('\n')
}

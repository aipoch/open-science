import { groupPdfTranslationPages } from '@aipoch/pdf-translation/reader'
import type { PageTextLayout } from '@aipoch/literature-reading'
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
    } else if (item.type === 'endMarkedContent') {
      if (!stack.length) return undefined
      stack.pop()
    } else stack.push(item.type === 'beginMarkedContentProps' ? item.id : undefined)
  }
  if (stack.length) return undefined
  const ordered: TextItem[][] = []
  const pending: { node: StructTreeNode['children'][number]; depth: number }[] = [
    { node: tree, depth: 0 }
  ]
  let visited = 0
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (++visited > 10_000 || depth > 128) return undefined
    if ('children' in node) {
      if (visited + pending.length + node.children.length > 10_000) return undefined
      for (let i = node.children.length - 1; i >= 0; i--)
        pending.push({ node: node.children[i], depth: depth + 1 })
    } else if (node.type === 'content') {
      const group = groups.get(node.id)
      if (group) ordered.push(group)
    }
  }
  const items = ordered.flat().filter((item) => item.str.trim())
  return count > 0 && items.length === count && new Set(items).size === count ? ordered : undefined
}

// Project only admitted physical rows. Original draw-call tails do not own positioned spaces.
const projectRows = (
  sourceItems: readonly TextItem[],
  items: readonly TextItem[],
  rows: readonly number[][]
): string | undefined => {
  let next = 0
  const separators = sourceItems.flatMap((item) => {
    if (item.str.trim()) {
      next++
      return []
    }
    if (!item.str) return []
    const t = item.transform
    const positioned =
      t?.length === 6 &&
      t.every(Number.isFinite) &&
      t[0] >= 0 &&
      t[1] === 0 &&
      t[2] === 0 &&
      t[3] >= 0 &&
      Number.isFinite(item.width) &&
      item.width >= 0 &&
      (!item.dir || item.dir === 'ltr')
    const previous = items[next - 1],
      following = items[next]
    const sourceFlow = Boolean(
      positioned &&
      previous &&
      following &&
      Math.abs(t[4] - previous.transform[4] - previous.width) <= 1e-6 &&
      Math.abs(t[4] + item.width - following.transform[4]) <= 1e-6 &&
      Math.abs(t[5] - previous.transform[5]) <= 1e-6 &&
      Math.abs(t[5] - following.transform[5]) <= 1e-6
    )
    return [
      {
        item,
        before: next - 1,
        sourceFlow,
        geometry: positioned ? ([t[4], t[4] + item.width, t[5]] as const) : undefined
      }
    ]
  })
  // Positioned whitespace belongs to a physical gap, not the preceding draw call.
  // Without coordinates, only unchanged source adjacency establishes ownership.
  const renderRow = (indices: readonly number[]): string | undefined => {
    const ambiguous = separators.some(({ geometry, before, sourceFlow }) => {
      // A gap to the next drawn run can span text drawn later. After reordering
      // it is a layout transition, not an overlapping word separator.
      if (geometry && sourceFlow) return false
      if (geometry)
        return indices.some((index) => {
          const item = items[index]
          return (
            Math.abs(geometry[2] - item.transform[5]) <= 1e-6 &&
            geometry[0] < item.transform[4] + item.width - 1e-6 &&
            geometry[1] > item.transform[4] + 1e-6
          )
        })
      const position = indices.indexOf(before)
      return position >= 0 && indices.includes(before + 1) && indices[position + 1] !== before + 1
    })
    if (ambiguous) return undefined
    const row: TextItem[] = []
    for (const [offset, index] of indices.entries()) {
      if (offset) {
        const before = indices[offset - 1],
          previous = items[before],
          current = items[index]
        const left = previous.transform[4] + previous.width,
          right = current.transform[4]
        const spaces = separators
          .filter(({ geometry, before: sourceBefore }) =>
            geometry
              ? Math.abs(geometry[2] - previous.transform[5]) <= 1e-6 &&
                Math.abs(geometry[2] - current.transform[5]) <= 1e-6 &&
                geometry[0] >= left - 1e-6 &&
                geometry[1] <= right + 1e-6
              : sourceBefore === before && before + 1 === index
          )
          .sort((a, b) => (a.geometry?.[0] ?? left) - (b.geometry?.[0] ?? left))
        row.push(...spaces.map(({ item }) => item))
      }
      row.push(items[index])
    }
    return joinPdfTextItems(row.map((item) => ({ ...item, hasEOL: false })))
  }
  const text = rows.map((row) => {
    if (
      row.some(
        (index, offset) =>
          offset > 0 &&
          (Math.abs(items[index].transform[5] - items[row[0]].transform[5]) > 1e-6 ||
            items[index].transform[4] < items[row[offset - 1]].transform[4])
      )
    )
      return undefined
    return renderRow(row)
  })
  return text.some((value) => value === undefined) ? undefined : text.join('\n')
}

// Source units remain independent: geometry does not classify prose columns or table rows.
// A whole-page sidecar either fits or is omitted; never silently drop source units.
const sourceLayout = (
  page: PDFPageProxy,
  items: readonly TextItem[],
  styles: TextContent['styles']
): PageTextLayout | undefined => {
  const [left, bottom, right, top] = page.view
  if (
    page.rotate % 360 !== 0 ||
    ![left, bottom, right, top].every(Number.isFinite) ||
    !Number.isFinite(right - left) ||
    !Number.isFinite(top - bottom) ||
    right <= left ||
    top <= bottom
  )
    return undefined
  const blocks: PageTextLayout['blocks'][number][] = []
  let chars = 0
  for (const item of items) {
    if (!item.str) continue
    const whitespace = !item.str.trim()
    const t = item.transform
    if (
      (!whitespace && item.dir !== 'ltr') ||
      (whitespace && item.dir && item.dir !== 'ltr') ||
      styles[item.fontName]?.vertical ||
      t?.length !== 6 ||
      ![...t, item.width, item.height].every(Number.isFinite) ||
      t[0] < 0 ||
      (!whitespace && t[0] === 0) ||
      t[1] !== 0 ||
      t[2] !== 0 ||
      t[3] < 0 ||
      (!whitespace && t[3] === 0) ||
      item.width < 0 ||
      (!whitespace && item.width === 0) ||
      item.height < 0 ||
      (!whitespace && item.height === 0)
    )
      return undefined
    const block = {
      id: blocks.length,
      text: item.str,
      bounds: [t[4] - left, top - t[5] - item.height, t[4] + item.width - left, top - t[5]] as const
    }
    if (!block.bounds.every(Number.isFinite)) return undefined
    chars += JSON.stringify(block).length + 1
    if (chars > 16_000) return undefined
    blocks.push(block)
  }
  return {
    page: page.pageNumber,
    width: right - left,
    height: top - bottom,
    coordinateSystem: 'top-left',
    blocks
  }
}

export const readPdfPageText = async (
  page: PDFPageProxy,
  onUncertain?: (page: number, layout?: PageTextLayout) => void,
  includeLayout = false
): Promise<string> => {
  const content = await page.getTextContent({ includeMarkedContent: true })
  const nativeItems = content.items.filter((item): item is TextItem => 'str' in item)
  const native = (uncertain = false): string => {
    if (uncertain && nativeItems.some((item) => item.str.trim())) {
      if (includeLayout)
        onUncertain?.(page.pageNumber, sourceLayout(page, nativeItems, content.styles))
      else onUncertain?.(page.pageNumber)
    }
    return joinPdfTextItems(nativeItems)
  }
  try {
    const tree = await page.getStructTree()
    if (tree) {
      const ordered = taggedOrder(content, tree)
      // Incomplete tags must not drop untagged text or silently replace a declared order.
      return ordered ? joinPdfTextItems(ordered.flat()) : native(true)
    }
  } catch {
    // Structure is optional: damaged tags must not make otherwise readable text unavailable.
    return native(true)
  }
  if (page.rotate % 360 !== 0) return native(true)
  const [left, bottom, right, top] = page.view
  const items = nativeItems.filter((item) => item.str.trim())
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
    return native(true)

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
    return native(true)

  // Paired baselines are ambiguous only when the layout engine has no table-cell evidence and
  // the lanes do not look like multi-line prose. Ordinary aligned prose still needs column order;
  // proven table cells, short labels and other uncertain content retain native rows.
  const pairedBaselines: number[] = []
  for (const a of blocks)
    for (const b of blocks) {
      if (a === b || a.rect.right >= b.rect.x) continue
      const tolerance = Math.min(a.rect.font, b.rect.font) * 0.25
      for (const line of a.lines) {
        if (!b.lines.some((other) => Math.abs(line.y - other.y) <= tolerance)) continue
        pairedBaselines.push(line.y)
      }
    }
  const wordCount = (text: string): number =>
    text.match(/[\p{L}\p{N}]+(?:['’\u2010-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  const lanes: (typeof blocks)[] = []
  for (const block of blocks) {
    const lane = lanes.find(
      (candidate) =>
        Math.abs(candidate[0].rect.x - block.rect.x) <=
        Math.min(candidate[0].rect.font, block.rect.font)
    )
    if (lane) lane.push(block)
    else lanes.push([block])
  }
  const proseLanes = lanes.filter((lane) => {
    const lines = lane.flatMap((block) => block.lines)
    if (lane.some((block) => block.tableCell) || lines.length < 3) return false
    const substantialLines = lines.filter((line) => wordCount(line.text) >= 5).length
    return substantialLines >= Math.max(2, Math.ceil(lines.length * 0.5))
  })
  if (
    pairedBaselines.length > 1 &&
    (blocks.some((block) => block.tableCell) || proseLanes.length < 2)
  )
    return native(true)
  return (
    projectRows(
      nativeItems,
      items,
      lines.map((line) => line.map((key) => Number(key.split(':')[1])))
    ) ?? native(true)
  )
}

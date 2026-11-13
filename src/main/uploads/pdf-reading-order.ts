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
    const joinsNativeRuns = (width: number): boolean =>
      Boolean(
        positioned &&
        previous &&
        following &&
        Math.abs(t[4] - previous.transform[4] - previous.width) <= 1e-6 &&
        Math.abs(t[4] + width - following.transform[4]) <= 1e-6 &&
        Math.abs(t[5] - previous.transform[5]) <= 1e-6 &&
        Math.abs(t[5] - following.transform[5]) <= 1e-6
      )
    // PDF.js can report a synthetic space's unscaled width beside horizontally
    // scaled text. Use that span only to refuse reordered inline content when
    // the same original scale on both neighbors closes both endpoints exactly.
    // Positive row projection retains the original physical whitespace checks.
    const scale = positioned && t[3] > 0 ? t[0] / t[3] : undefined
    const scaledWidth =
      scale !== undefined &&
      Number.isFinite(scale) &&
      scale > 0 &&
      previous &&
      following &&
      previous.transform[3] > 0 &&
      following.transform[3] > 0 &&
      Math.abs(previous.transform[0] / previous.transform[3] - scale) <= 1e-6 &&
      Math.abs(following.transform[0] / following.transform[3] - scale) <= 1e-6
        ? item.width * scale
        : undefined
    const width =
      !joinsNativeRuns(item.width) &&
      scaledWidth !== undefined &&
      Number.isFinite(scaledWidth) &&
      joinsNativeRuns(scaledWidth)
        ? scaledWidth
        : item.width
    const sourceFlow = joinsNativeRuns(item.width)
    return [
      {
        item,
        before: next - 1,
        sourceFlow,
        geometry: positioned ? ([t[4], t[4] + item.width, t[5]] as const) : undefined,
        inlineSourceFlow: joinsNativeRuns(width),
        inlineGeometry: positioned ? ([t[4], t[4] + width, t[5]] as const) : undefined
      }
    ]
  })
  const sourceLines: number[] = []
  let sourceLine = 0
  for (const item of sourceItems) {
    if (item.str.trim()) sourceLines.push(sourceLine)
    if (item.hasEOL) sourceLine++
  }
  const rowOwners = new Map(
    rows.flatMap((row, owner) => row.map((index) => [index, owner] as const))
  )
  // A narrow native inline gap cannot become a new layout row merely because
  // one end is a short run. Explicit source EOLs and real column gutters keep
  // their existing behavior; uncertainty retains the complete native stream.
  if (
    separators.some(({ inlineSourceFlow: sourceFlow, inlineGeometry: geometry, before }) => {
      if (!sourceFlow || !geometry || sourceLines[before] !== sourceLines[before + 1]) return false
      const previous = items[before],
        following = items[before + 1]
      const em = Math.min(previous.height, following.height)
      const previousRow = rowOwners.get(before),
        followingRow = rowOwners.get(before + 1)
      if (
        /^\/\/(?:\s|$)/u.test(following.str.trimStart()) &&
        /^(?:const|let|var|for|while|if|return)\b/u.test(previous.str.trimStart()) &&
        /[;)}]\s*$/u.test(previous.str) &&
        previousRow !== followingRow
      )
        return true
      if (geometry[1] <= geometry[0] || geometry[1] - geometry[0] > em * 1.5) return false
      const short = (item: TextItem): boolean =>
        /^\S+$/u.test(item.str.trim()) && item.width <= em * 2
      const prose = (item: TextItem): boolean => item.str.trim().split(/\s+/u).length >= 3
      // A later native line under either side of this authenticated inline gap
      // cannot overtake its first line, even when it is only a journal name or URL.
      const overtaken =
        previousRow !== undefined &&
        followingRow !== undefined &&
        followingRow > previousRow + 1 &&
        rows.slice(previousRow + 1, followingRow).some((row) =>
          row.some((index) => {
            const candidate = items[index]
            return (
              index > before + 1 &&
              sourceLines[index] > sourceLines[before + 1] &&
              candidate.transform[5] + candidate.height < following.transform[5] - 1e-6 &&
              ((candidate.transform[4] < following.transform[4] + following.width - 1e-6 &&
                candidate.transform[4] + candidate.width > following.transform[4] + 1e-6) ||
                (candidate.transform[4] >= previous.transform[4] - 1e-6 &&
                  candidate.transform[4] + candidate.width <=
                    previous.transform[4] + previous.width + 1e-6))
            )
          })
        )
      return (
        ((short(previous) && prose(following)) ||
          (prose(previous) && short(following)) ||
          overtaken) &&
        previousRow !== followingRow
      )
    })
  )
    return undefined
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

type PositionedLayoutLine = Readonly<{
  x: number
  font: number
  y: number
  items: readonly string[]
}>

// Constrain only an independently outermost short source row in a grid's
// before/after partition. This is not a y-sort across ordinary prose columns.
const displacedNativeOuterRow = (
  rows: readonly number[][],
  items: readonly TextItem[],
  before: boolean
): boolean => {
  const index = before ? 0 : items.length - 1
  const row = rows.find((row) => row.includes(index))
  const source = items[index]
  if (
    rows.length < 2 ||
    !row ||
    row.length !== 1 ||
    row === (before ? rows[0] : rows.at(-1)) ||
    !/^\S+$/u.test(source.str.trim()) ||
    source.width > source.height * 2
  )
    return false
  const top = -source.transform[5] - source.height
  const bottom = -source.transform[5]
  return rows
    .filter((other) => other !== row)
    .every((other) =>
      other.every((n) =>
        before
          ? -items[n].transform[5] - items[n].height > bottom + 1e-6
          : -items[n].transform[5] < top - 1e-6
      )
    )
}

// A source stream that repeatedly traverses aligned columns by row is
// stronger evidence for a table than the layout engine's independent column lanes.
const rowMajorGridBounds = (
  lines: readonly PositionedLayoutLine[],
  items: readonly TextItem[]
): { bounds: readonly [number, number]; first: number; last: number } | undefined => {
  const baselines: {
    y: number
    lines: PositionedLayoutLine[]
  }[] = []
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const baseline = baselines.find(
      (candidate) =>
        Math.abs(candidate.y - line.y) <=
        Math.max(1, Math.min(candidate.lines[0].font, line.font) * 0.12)
    )
    if (baseline) baseline.lines.push(line)
    else baselines.push({ y: line.y, lines: [line] })
  }

  const lanesFor = (baselineLines: readonly PositionedLayoutLine[]): number[] => {
    const lanes: { x: number; font: number }[] = []
    for (const line of [...baselineLines].sort((a, b) => a.x - b.x)) {
      const lane = lanes.find(
        (candidate) => Math.abs(candidate.x - line.x) <= Math.min(candidate.font, line.font) * 0.5
      )
      if (!lane) lanes.push({ x: line.x, font: line.font })
    }
    return lanes.map(({ x }) => x)
  }

  const rows = baselines
    .flatMap(({ y, lines: baselineLines }) => {
      const lanes = lanesFor(baselineLines)
      const indexes = baselineLines.flatMap((line) =>
        line.items.map((key) => Number(key.split(':')[1])).filter(Number.isSafeInteger)
      )
      return lanes.length >= 2 && indexes.length
        ? [
            {
              minY: y,
              maxY: y,
              lanes,
              first: Math.min(...indexes),
              last: Math.max(...indexes),
              shortLanes: baselineLines
                .filter((line) => {
                  const text = line.items
                    .map((key) => items[Number(key.split(':')[1])]?.str ?? '')
                    .join(' ')
                  const words =
                    text.match(/[\p{L}\p{N}]+(?:['’\u2010-][\p{L}\p{N}]+)*/gu)?.length ?? 0
                  return words > 0 && words <= 4
                })
                .map((line) => line.x)
            }
          ]
        : []
    })
    .sort((a, b) => a.minY - b.minY)

  // Wrapped cells can put later baselines inside the same source-index interval.
  // Merge those baselines into one logical row before checking row-major order.
  const sourceRows: {
    lanes: number[]
    first: number
    last: number
    minY: number
    maxY: number
    shortLanes: number[]
  }[] = []
  for (const row of rows) {
    const previous = sourceRows.at(-1)
    if (previous && row.first <= previous.last) {
      previous.first = Math.min(previous.first, row.first)
      previous.last = Math.max(previous.last, row.last)
      previous.minY = Math.min(previous.minY, row.minY)
      previous.maxY = Math.max(previous.maxY, row.maxY)
      previous.lanes.push(...row.lanes)
      previous.shortLanes.push(...row.shortLanes)
    } else sourceRows.push({ ...row, lanes: [...row.lanes], shortLanes: [...row.shortLanes] })
  }
  if (sourceRows.length < 3) return

  const stableLanes = new Set<number>()
  for (const row of sourceRows) {
    for (const x of row.lanes) {
      const occurrences = sourceRows.filter((candidate) =>
        candidate.lanes.some((candidateX) => Math.abs(candidateX - x) <= 2)
      ).length
      if (occurrences >= 3) stableLanes.add(x)
    }
  }
  const fontSizes = items.map((item) => item.transform[0]).toSorted((a, b) => a - b)
  const minimumColumnGap = fontSizes[Math.floor(fontSizes.length / 2)] * 3
  const stableLaneCandidates = [...stableLanes]
  for (const x of stableLaneCandidates) {
    if (!stableLaneCandidates.some((other) => Math.abs(other - x) >= minimumColumnGap))
      stableLanes.delete(x)
  }
  const gridRows = sourceRows.filter((row) => {
    const stableRowLanes = row.lanes.filter((x) =>
      [...stableLanes].some((stable) => Math.abs(stable - x) <= 2)
    )
    return (
      new Set(stableRowLanes).size >= 2 &&
      row.shortLanes.some((x) => [...stableLanes].some((stable) => Math.abs(stable - x) <= 2))
    )
  })
  if (
    gridRows.length < 3 ||
    gridRows.filter((row) =>
      row.shortLanes.some((x) => [...stableLanes].some((stable) => Math.abs(x - stable) <= 2))
    ).length < 3 ||
    !gridRows.every((row, index) => index === 0 || gridRows[index - 1].last < row.first)
  )
    return
  const first = Math.min(...gridRows.map((row) => row.first))
  let last = Math.max(...gridRows.map((row) => row.last))
  const gridBottom = Math.max(...gridRows.map((row) => row.maxY))
  while (last + 1 < items.length) {
    const continuation = lines.find((line) =>
      line.items.some((key) => Number(key.split(':')[1]) === last + 1)
    )
    if (
      !continuation ||
      ![...stableLanes].some((x) => Math.abs(continuation.x - x) <= 2) ||
      continuation.y < gridBottom - continuation.font * 0.25 ||
      continuation.y - gridBottom > continuation.font * 1.25
    )
      break
    last++
  }
  const gridLines = lines.filter((line) => {
    const indexes = line.items.map((key) => Number(key.split(':')[1]))
    return (
      [...stableLanes].some((x) => Math.abs(line.x - x) <= 2) &&
      indexes.some((index) => index >= first && index <= last)
    )
  })
  return gridLines.length
    ? {
        bounds: [
          Math.min(...gridLines.map((line) => line.y)),
          Math.max(...gridLines.map((line) => line.y))
        ],
        first,
        last
      }
    : undefined
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
  const positionedLines: PositionedLayoutLine[] = blocks.flatMap((block) => {
    const blockLines = block.lines.length ? block.lines : [{ y: block.rect.y, items: block.items }]
    return blockLines.map((line) => ({
      x: block.rect.x,
      font: block.rect.font,
      y: line.y,
      items: line.items
    }))
  })
  // Layout blocks can combine several physical cell lanes into one line. Use the
  // line baseline from the layout, but recover each source item's own x position.
  const sourcePositionedLines: PositionedLayoutLine[] = lines.flatMap((line, lineIndex) =>
    line.flatMap((key) => {
      const index = Number(key.split(':')[1])
      const item = items[index]
      return item
        ? [
            {
              x: item.transform[4] - left,
              font: item.transform[0],
              y: positionedLines[lineIndex].y,
              items: [key]
            }
          ]
        : []
    })
  )
  const sourceBaselines: PositionedLayoutLine[][] = []
  for (const line of [...sourcePositionedLines].sort((a, b) => a.y - b.y)) {
    const baseline = sourceBaselines.find(
      (candidate) => Math.abs(candidate[0].y - line.y) <= Math.max(1, line.font * 0.12)
    )
    if (baseline) baseline.push(line)
    else sourceBaselines.push([line])
  }
  const sourceLanes = new Map<number, { lines: string[]; font: number }>()
  for (const baseline of sourceBaselines) {
    const columns = new Map<number, { items: string[]; font: number }>()
    for (const line of baseline) {
      const laneX = [...columns.keys()].find((x) => Math.abs(x - line.x) <= line.font * 0.5)
      const key = laneX ?? line.x
      const column = columns.get(key) ?? { items: [], font: line.font }
      column.items.push(...line.items)
      columns.set(key, column)
    }
    for (const [x, column] of columns) {
      const lane = sourceLanes.get(x) ?? { lines: [], font: column.font }
      lane.lines.push(
        column.items.map((key) => items[Number(key.split(':')[1])]?.str ?? '').join(' ')
      )
      sourceLanes.set(x, lane)
    }
  }
  const substantialLanes = [...sourceLanes.entries()]
    .filter(([, lane]) => {
      const substantialLines = lane.lines.filter((line) => wordCount(line) >= 3).length
      return (
        lane.lines.length >= 3 &&
        substantialLines >= Math.max(2, Math.ceil(lane.lines.length * 0.5))
      )
    })
    .map(([x, lane]) => ({ x, font: lane.font }))
  const hasIndependentSourceProseColumns = substantialLanes.some((lane, index) =>
    substantialLanes
      .slice(index + 1)
      .some((other) => Math.abs(other.x - lane.x) >= Math.max(lane.font, other.font) * 3)
  )
  const projected = projectRows(
    nativeItems,
    items,
    lines.map((line) => line.map((key) => Number(key.split(':')[1])))
  )
  const grid = rowMajorGridBounds(sourcePositionedLines, items)
  if (grid) {
    const { bounds, first, last } = grid
    const beforeRows: number[][] = []
    const afterRows: number[][] = []
    const seen = new Set<number>()
    let uncertain = false
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const indexes = lines[lineIndex].map((key) => Number(key.split(':')[1]))
      const hasGridItem = indexes.some((index) => index >= first && index <= last)
      if (hasGridItem) {
        if (
          indexes.some((index) => index < first || index > last) ||
          positionedLines[lineIndex].y < bounds[0] - 2 ||
          positionedLines[lineIndex].y > bounds[1] + 2 ||
          indexes.some((index) => seen.has(index))
        ) {
          uncertain = true
          break
        }
        indexes.forEach((index) => seen.add(index))
      } else if (positionedLines[lineIndex].y < bounds[0]) beforeRows.push(indexes)
      else if (positionedLines[lineIndex].y > bounds[1]) afterRows.push(indexes)
      else {
        uncertain = true
        break
      }
    }
    const beforeIndexes = beforeRows.flat()
    const afterIndexes = afterRows.flat()
    const beforeSet = new Set(beforeIndexes)
    const afterSet = new Set(afterIndexes)
    const outsideOwnershipIsComplete =
      beforeIndexes.every((index) => index < first) &&
      afterIndexes.every((index) => index > last) &&
      beforeSet.size === first &&
      afterSet.size === items.length - last - 1 &&
      Array.from({ length: first }, (_, index) => beforeSet.has(index)).every(Boolean) &&
      Array.from({ length: items.length - last - 1 }, (_, offset) =>
        afterSet.has(last + 1 + offset)
      ).every(Boolean)
    if (
      !uncertain &&
      outsideOwnershipIsComplete &&
      !displacedNativeOuterRow(beforeRows, items, true) &&
      !displacedNativeOuterRow(afterRows, items, false) &&
      seen.size === last - first + 1 &&
      Array.from({ length: last - first + 1 }, (_, offset) => seen.has(first + offset)).every(
        Boolean
      )
    ) {
      const nativePosition = new Map(nativeItems.map((item, index) => [item, index]))
      const nativeStart = nativePosition.get(items[first])
      const nativeEnd = nativePosition.get(items[last])
      if (nativeStart !== undefined && nativeEnd !== undefined) {
        const beforeItems = items.slice(0, first)
        const afterItems = items.slice(last + 1)
        const beforeText = beforeItems.length
          ? projectRows(nativeItems.slice(0, nativeStart), beforeItems, beforeRows)
          : ''
        const afterText = afterItems.length
          ? projectRows(
              nativeItems.slice(nativeEnd + 1),
              afterItems,
              afterRows.map((row) => row.map((index) => index - last - 1))
            )
          : ''
        if (beforeText !== undefined && afterText !== undefined) {
          const gridText = joinPdfTextItems(nativeItems.slice(nativeStart, nativeEnd + 1))
          return [beforeText, gridText, afterText].filter(Boolean).join('\n')
        }
      }
    }
    return native(true)
  }
  if (
    projected !== undefined &&
    projected !== joinPdfTextItems(nativeItems) &&
    lanes.length >= 2 &&
    sourceBaselines.length >= 3 &&
    !hasIndependentSourceProseColumns
  )
    return native(true)
  return projected ?? native(true)
}

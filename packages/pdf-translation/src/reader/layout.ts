import { resolveInlineFractions } from '../../resources/math-fractions.mjs'
import { numberedSourcePackets } from './numbered-source.js'
import { nativeNumberedReferenceColumns } from './reference-columns.js'

const durationStatistic = /^\d+(?:\.\d+)?±\d+(?:\.\d+)?(?:ms|s)(?:\s*\(\d+(?:\.\d+)?%\))?$/u

// Heuristic source grouping, promoted from the verified paragraph-flow spike.
// English boundary rules are candidates, not semantic or translation-quality certification.
export type PdfLayoutTextItem = {
  str: string
  width: number
  height: number
  dir: string
  transform: number[]
  hasEOL?: boolean
  fontName?: string
  fontAscent?: number
  fontDescent?: number
}
export type PdfLayoutPage = {
  page: number
  width: number
  height: number
  rotation: number
  items: PdfLayoutTextItem[]
}
type Rect = { x: number; y: number; right: number; bottom: number }
type Item = PdfLayoutTextItem &
  Rect & {
    index: number
    nativeLine: number
    key: string
    page: number
    font: number
    baseline: number
    originalBaseline: number
    unsupported: boolean
  }
type Line = Rect & { font: number; baseline: number; text: string; items: Item[] }
type Block = Rect & {
  font: number
  lines: Line[]
  source: string
  items: Item[]
  risks: string[]
  readingBaseline?: number
}
type LayoutBlock = {
  sourceOnly?: true
  tableCell?: true
  id: string
  page: number
  source: string
  items: string[]
  originalStrings: string[]
  rect: Rect & { font: number }
  lines: (Rect & { text: string; items: string[] })[]
  risks: string[]
}
type LayoutPage = {
  page: number
  width: number
  height: number
  sourceItems: number
  blocks: LayoutBlock[]
}
type LayoutUnit = {
  id: string
  kind: 'prose-candidate' | 'heading-candidate' | 'other'
  source: string
  sourceOnly?: true
  items: string[]
  originalStrings: string[]
  fragments: { id: string; page: number; rect: Rect & { font: number } }[]
  risks: string[]
}
export type PdfTranslationLayout = {
  bodyFont: number
  pages: LayoutPage[]
  units: LayoutUnit[]
  joins: { from: string; to: string; kind: 'page' | 'column'; left: string; right: string }[]
}

// Same conservative source policy as joinCaptionLines in the Node caption pipeline.
// Keep this browser entry independent of its Node imports and unrelated caption heuristics.
function joinCaptionLines(lines: string[], pageWords: Set<string>): string {
  return lines.reduce((text, line) => {
    const next = line.trim()
    if (!next) return text
    if (text.endsWith('\u00ad')) return text.slice(0, -1) + next
    const prefix = /(\p{L}+)-$/u.exec(text)?.[1]
    const suffix = /^(\p{Ll}+)/u.exec(next)?.[1]
    if (
      prefix &&
      suffix &&
      pageWords?.has((prefix + suffix).toLowerCase()) &&
      !pageWords.has((prefix + '-' + suffix).toLowerCase())
    )
      return text.slice(0, -1) + next
    return text + (text && !/[-\u2010\u2011]$/.test(text) ? ' ' : '') + next
  }, '')
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 9
const bounds = (items: Rect[]): Rect => ({
  x: Math.min(...items.map((i) => i.x)),
  y: Math.min(...items.map((i) => i.y)),
  right: Math.max(...items.map((i) => i.right)),
  bottom: Math.max(...items.map((i) => i.bottom))
})
function joinLines(left: string, right: string): string {
  if (!left) return right
  if (/[A-Za-z]-$/.test(left) && /^[a-z]/.test(right)) {
    const prefix = left.match(/([A-Za-z]+)-$/)![1].toLowerCase()
    // ponytail: English-only line-wrap heuristic; preserve the original line text alongside it.
    return (
      (['non', 'pre', 'post', 'well', 'self'].includes(prefix) ? left : left.slice(0, -1)) + right
    )
  }
  return left + ' ' + right
}
function lineOf(items: Item[]): Line {
  const font = Math.max(...items.map((i) => i.font))
  items.sort((a, b) => a.x - b.x || a.index - b.index)
  for (let first = 0; first < items.length; first++) {
    if (items[first].font >= font * 0.85) continue
    let end = first + 1
    let right = items[first].right
    while (
      end < items.length &&
      items[end].font < font * 0.85 &&
      items[end].x <= right + font * 0.15
    ) {
      right = Math.max(right, items[end].right)
      end++
    }
    const cluster = items.slice(first, end)
    if (
      Math.max(...cluster.map((part) => part.originalBaseline)) -
        Math.min(...cluster.map((part) => part.originalBaseline)) >
      font * 0.15
    )
      items.splice(first, cluster.length, ...cluster.sort((a, b) => a.index - b.index))
    first = end - 1
  }
  // A spacing accent may precede its native base despite a larger x coordinate.
  // Preserve proven native order, including a same-font grave over a word vowel.
  for (const mark of [...items]) {
    if (mark.str !== 'ˆ' && mark.str !== '`') continue
    const bases = items.filter(
      (base) =>
        base.index === mark.index + 1 &&
        (mark.str === 'ˆ'
          ? /^[A-Za-z\p{Script=Greek}\d]$/u.test(base.str)
          : /^[AEIOUaeiou][a-z]{1,}\b/u.test(base.str)) &&
        mark.fontName &&
        base.fontName &&
        Math.abs(mark.font - base.font) < font * 0.05 &&
        Math.abs(mark.x - base.x) < font * 0.15 &&
        (mark.str === 'ˆ'
          ? base.originalBaseline - mark.originalBaseline > font * 0.15 &&
            base.originalBaseline - mark.originalBaseline < font * 0.35
          : mark.fontName === base.fontName &&
            Math.abs(base.originalBaseline - mark.originalBaseline) < font * 0.1 &&
            mark.x >= base.x &&
            mark.x - base.x < font * 0.1 &&
            mark.width < font * 0.45) &&
        mark.width > 0 &&
        mark.width <= base.width &&
        !mark.unsupported &&
        !base.unsupported &&
        Math.abs(mark.transform[2]) < 0.001 &&
        Math.abs(base.transform[2]) < 0.001
    )
    if (bases.length !== 1 || items.indexOf(mark) < items.indexOf(bases[0])) continue
    items.splice(items.indexOf(mark), 1)
    items.splice(items.indexOf(bases[0]), 0, mark)
  }
  const accents = new Map<Item, Item>()
  for (const mark of items.filter((item) => /^\p{M}$/u.test(item.str) || item.str === '¨')) {
    const bases = items.filter(
      (base) =>
        /^\p{L}/u.test(base.str) &&
        Math.abs(base.x - mark.x) < font * 0.15 &&
        Math.abs(base.baseline - mark.baseline) < font * 0.1 &&
        Math.abs(base.font - mark.font) < font * 0.1 &&
        (mark.str !== '¨' ||
          (/^[AEIOUYaeiouy]/u.test(base.str) &&
            base.index === mark.index + 1 &&
            base.fontName &&
            base.fontName === mark.fontName &&
            mark.width < font * 0.45 &&
            mark.x >= base.x &&
            mark.x - base.x < font * 0.1))
    )
    if (bases.length === 1) accents.set(mark, bases[0])
  }
  const fractions = resolveInlineFractions(
    items.map((item) => ({
      i: item.index,
      text: item.str,
      fontSize: item.font,
      baseline: -item.originalBaseline,
      bounds: [item.x, -item.bottom, item.right, -item.y]
    })),
    -median(items.filter((item) => item.font >= font * 0.9).map((item) => item.baseline)),
    font
  )
  // Negative powers may be emitted as separate minus and digit glyphs. Require
  // both glyphs to share a raised baseline beside the actual base ten.
  const negativeExponentItems = new Set<Item>()
  for (let n = 1; n < items.length; n++) {
    const sign = items[n]
    const base = items[n - 1]
    if (!/(?:^|[^0-9])10$/u.test(base.str) || !/^[−-](?:\d{1,2})?$/u.test(sign.str)) continue
    const digits = sign.str.length === 1 ? items[n + 1] : sign
    if (
      !digits ||
      (digits !== sign && !/^\d{1,2}$/u.test(digits.str)) ||
      sign.font >= base.font * 0.9 ||
      digits.font >= base.font * 0.9 ||
      base.originalBaseline - sign.originalBaseline <= base.font * 0.2 ||
      Math.abs(digits.originalBaseline - sign.originalBaseline) > base.font * 0.1 ||
      sign.x - base.right < -base.font * 0.1 ||
      sign.x - base.right > base.font * 0.4 ||
      (digits !== sign &&
        (digits.x - sign.right < -base.font * 0.1 || digits.x - sign.right > base.font * 0.3))
    )
      continue
    negativeExponentItems.add(sign)
    negativeExponentItems.add(digits)
  }
  const text = items
    .map((item, n) => {
      if (accents.has(item)) return ''
      const fraction = fractions.find((value) => value.indices.includes(item.index))
      if (fraction) {
        const first = items.find((value) => fraction.indices.includes(value.index))
        return item === first ? ' ' + fraction.label : ''
      }
      const prev = items.slice(0, n).findLast((part) => !accents.has(part))
      // Preserve an unambiguous power of ten from its actual raised glyphs.
      // Flattening 6 × 10⁶ to 6 × 106 changes the quantity sent to the model.
      const exponent =
        negativeExponentItems.has(item) ||
        (prev &&
          /\d\s*[×·]\s*10\s*$/u.test(
            items
              .slice(0, n)
              .map((part) => part.str)
              .join('')
          ) &&
          /^\d{1,2}$/u.test(item.str) &&
          item.font < prev.font * 0.9 &&
          prev.baseline - item.baseline > prev.font * 0.2 &&
          item.x - prev.right < prev.font * 0.4)
      // A raised footnote after a completed body sentence is a separate
      // token. Flattening "Table 6." plus its marker to "6.3" fabricates a
      // decimal/reference identity and prevents safe link relocation.
      const sentenceFootnote =
        prev &&
        item === items.at(-1) &&
        /^\d{1,2}$/u.test(item.str) &&
        /\.$/u.test(prev.str) &&
        (prev.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
        prev.fontName &&
        prev.fontName === item.fontName &&
        item.font >= prev.font * 0.5 &&
        item.font < prev.font * 0.85 &&
        prev.originalBaseline - item.originalBaseline > prev.font * 0.2 &&
        prev.originalBaseline - item.originalBaseline < prev.font * 0.55 &&
        item.x - prev.right >= -prev.font * 0.1 &&
        item.x - prev.right < prev.font * 0.4
      const value = exponent
        ? item.str.replace(/[−-]/gu, '⁻').replace(/\d/gu, (digit) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)])
        : item.str.replace(/^\p{L}/u, (letter) => {
            const marks = [...accents].filter(([, base]) => base === item)
            const composed =
              letter + marks.map(([mark]) => (mark.str === '¨' ? '\u0308' : mark.str)).join('')
            return marks.some(([mark]) => mark.str === '¨') ? composed.normalize('NFC') : composed
          })
      return (
        (!exponent &&
        prev &&
        (sentenceFootnote || item.x - prev.right > font * 0.1) &&
        !/\s$/.test(prev.str) &&
        !/^\s/.test(item.str)
          ? ' '
          : '') + value
      )
    })
    .join('')
    .trim()
  return {
    ...bounds(items),
    font,
    baseline: median(items.filter((i) => i.font >= font * 0.9).map((i) => i.baseline)),
    text,
    items
  }
}
function gaps(blocks: Rect[], axis: 'x' | 'y'): { start: number; end: number; size: number }[] {
  const end = axis === 'x' ? 'right' : 'bottom'
  const spans = blocks.map((b) => [b[axis], b[end]]).sort((a, b) => a[0] - b[0])
  let right = spans[0][1]
  const result = []
  for (const [start, stop] of spans.slice(1)) {
    if (start > right) result.push({ start: right, end: start, size: start - right })
    right = Math.max(right, stop)
  }
  return result
}
function readingOrder(blocks: Block[], pageBlocks = blocks): Block[] {
  if (blocks.length < 2) return [...blocks]
  const font = median(blocks.map((b) => b.font))
  // Column gutters can be slightly narrower than one font em.
  let x = gaps(blocks, 'x')
    .filter((g) => g.size > font * 0.9)
    .sort((a, b) => b.size - a.size)[0]
  const y = gaps(blocks, 'y')
    .filter((g) => g.size > font * 0.35)
    .sort((a, b) => b.size - a.size)[0]
  // Two displayed equations can leave a vertical gap beside their short
  // introductions. A complete neighboring prose frame and the alternating
  // native stream prove one column, rather than two independent text lanes.
  if (x && blocks.length <= 4) {
    const pageOrder = [...pageBlocks].sort((a, b) => a.y - b.y)
    for (let offset = 0; offset + 3 < pageOrder.length; offset++) {
      const ordered = pageOrder.slice(offset, offset + 4)
      if (!blocks.every((block) => ordered.includes(block))) continue
      const sequenceGap = gaps(ordered, 'x').find((gap) => gap.size > font * 0.9)
      if (!sequenceGap) continue
      const first = Math.min(...ordered[0].items.map((item) => item.index))
      const last = Math.max(...ordered.at(-1)!.items.map((item) => item.index))
      if (
        ordered.every(
          (block, index) =>
            block.items.every((item) => !item.unsupported && !!item.fontName) &&
            (index % 2 === 0
              ? wordCount(block.source) >= 2 &&
                !terminal(block.source) &&
                !symbolicExpression(block.source) &&
                block.right <= sequenceGap.start + 0.001
              : symbolicExpression(block.source) && block.x >= sequenceGap.end - 0.001) &&
            (index === 0 ||
              (block.y > ordered[index - 1].bottom &&
                block.y - ordered[index - 1].bottom < font * 5 &&
                Math.min(...block.items.map((item) => item.index)) >
                  Math.max(...ordered[index - 1].items.map((item) => item.index))))
        ) &&
        !pageBlocks.some(
          (block) =>
            !ordered.includes(block) &&
            block.items.some((item) => item.index >= first && item.index <= last)
        ) &&
        pageBlocks.some(
          (block) =>
            !ordered.includes(block) &&
            wordCount(block.source) >= 12 &&
            !symbolicExpression(block.source) &&
            block.x <= ordered[0].x + font * 0.2 &&
            block.right > Math.max(...ordered.map((part) => part.right)) + font * 2 &&
            ((block.bottom < ordered[0].y && ordered[0].y - block.bottom < font * 6) ||
              (block.y > ordered.at(-1)!.bottom && block.y - ordered.at(-1)!.bottom < font * 6))
        )
      )
        return ordered.filter((block) => blocks.includes(block))
    }
  }
  // A pair of centered author/affiliation stacks belongs above the body
  // columns. Require the complete native band, paired rows and terminal email
  // lines; a title or a few short blocks alone cannot override a column cut.
  if (x)
    for (const gap of gaps(blocks, 'y').filter((gap) => gap.size > font * 0.5)) {
      const above = blocks.filter((block) => block.bottom <= gap.start + 0.001)
      const below = blocks.filter((block) => block.y >= gap.end - 0.001)
      const lanes = [
        above.filter((b) => b.right <= x!.start + 0.001),
        above.filter((b) => b.x >= x!.end - 0.001)
      ].map((lane) => lane.sort((a, b) => a.y - b.y))
      if (
        above.length + below.length !== blocks.length ||
        lanes[0].length !== lanes[1].length ||
        lanes[0].length < 3 ||
        lanes[0].length > 6 ||
        lanes.flat().length !== above.length ||
        Math.max(...above.flatMap((b) => b.items.map((i) => i.index))) >=
          Math.min(...below.flatMap((b) => b.items.map((i) => i.index)))
      )
        continue
      if (
        lanes.every((lane) => {
          const center = (lane[0].x + lane[0].right) / 2
          return (
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(lane.at(-1)!.source) &&
            lane[0].font > lane[1].font * 1.05 &&
            lane.every(
              (b, index) =>
                b.lines.length === 1 &&
                !b.risks.length &&
                b.items.every((i) => !i.unsupported && !!i.fontName) &&
                Math.abs((b.x + b.right) / 2 - center) < font * 0.5 &&
                (index === 0 ||
                  (b.y >= lane[index - 1].bottom - font * 0.1 &&
                    b.y - lane[index - 1].bottom < font * 1.5))
            )
          )
        }) &&
        lanes[0].every(
          (b, index) =>
            Math.abs(b.y - lanes[1][index].y) < font * 0.15 &&
            Math.abs(b.font - lanes[1][index].font) < font * 0.05 &&
            b.items[0].fontName === lanes[1][index].items[0].fontName
        ) &&
        [false, true].every((right) =>
          below.some(
            (b) =>
              (right ? b.x >= x!.end - 0.001 : b.right <= x!.start + 0.001) &&
              b.lines.length >= 2 &&
              wordCount(b.source) >= 12 &&
              !symbolicExpression(b.source)
          )
        )
      )
        return [...readingOrder(above, pageBlocks), ...readingOrder(below, pageBlocks)]
    }
  // Repeated prose frames can prove a gutter obscured by a short formula tail.
  // Require two disjoint native streams and validate every complete block;
  // a spanning title, interleaved source stream or larger overhang rejects it.
  if (!x) {
    const frames = blocks.filter(
      (block) =>
        wordCount(block.source) >= 12 &&
        block.right - block.x >= font * 8 &&
        block.lines.length >= 2 &&
        !symbolicExpression(block.source) &&
        !block.risks.length
    )
    const candidates =
      frames.length >= 4 ? gaps(frames, 'x').filter((gap) => gap.size > font * 0.9) : []
    if (candidates.length === 1) {
      const gutter = candidates[0]
      const left = frames.filter((block) => block.right <= gutter.start + 0.001)
      const right = frames.filter((block) => block.x >= gutter.end - 0.001)
      const lastLeft = Math.max(...left.flatMap((block) => block.items.map((item) => item.index)))
      const firstRight = Math.min(
        ...right.flatMap((block) => block.items.map((item) => item.index))
      )
      if (
        left.length >= 2 &&
        right.length >= 2 &&
        lastLeft < firstRight &&
        blocks.every((block) => {
          const first = Math.min(...block.items.map((item) => item.index))
          const last = Math.max(...block.items.map((item) => item.index))
          return last < firstRight
            ? block.x < gutter.start &&
                block.right <= gutter.end + font &&
                (block.right <= gutter.start + 0.001 || symbolicExpression(block.source))
            : first >= firstRight && block.x >= gutter.end - font * 0.05
        })
      )
        x = gutter
    }
  }
  // A full-width gap with complete native sections takes priority over columns.
  // Both sections must independently occupy both sides of the same gutter.
  const horizontalSection =
    x &&
    y &&
    y.size > font * 2 &&
    (() => {
      const above = blocks.filter((block) => block.bottom <= y.start + 0.001)
      const below = blocks.filter((block) => block.y >= y.end - 0.001)
      return (
        above.length + below.length === blocks.length &&
        [above, below].every(
          (section) =>
            section.some(
              (block) =>
                block.right <= x!.start + 0.001 &&
                block.lines.length >= 2 &&
                wordCount(block.source) >= 12 &&
                block.right - block.x >= font * 8 &&
                !symbolicExpression(block.source) &&
                !block.risks.length
            ) &&
            section.some(
              (block) =>
                block.x >= x!.end - 0.001 &&
                block.lines.length >= 2 &&
                wordCount(block.source) >= 12 &&
                block.right - block.x >= font * 8 &&
                !symbolicExpression(block.source) &&
                !block.risks.length
            )
        ) &&
        Math.max(...above.flatMap((block) => block.items.map((item) => item.index))) <
          Math.min(...below.flatMap((block) => block.items.map((item) => item.index)))
      )
    })()
  // XY-cut: proved section boundaries first, otherwise full-height gutters.
  const cut = horizontalSection ? y : (x ?? y)
  if (!cut) {
    // Inline formulas can extend above the prose baseline; wrapped text can
    // extend left of its opening line. Group only matching native baselines,
    // then order their actual opening positions without a pairwise tolerance sort.
    const anchor = (block: Block): Line | Item => {
      const first = block.lines[0] ?? block.items[0]
      return block.readingBaseline === undefined
        ? first
        : { ...first, baseline: block.readingBaseline }
    }
    const rows: { baseline: number; top: number; blocks: Block[] }[] = []
    for (const block of [...blocks].sort((a, b) => anchor(a).baseline - anchor(b).baseline)) {
      const row = rows.at(-1)
      if (row && Math.abs(row.baseline - anchor(block).baseline) <= 0.001) {
        row.blocks.push(block)
        row.top = Math.min(row.top, block.y)
      } else rows.push({ baseline: anchor(block).baseline, top: block.y, blocks: [block] })
    }
    return rows
      .sort((a, b) => a.top - b.top || a.baseline - b.baseline)
      .flatMap((row) => row.blocks.sort((a, b) => anchor(a).x - anchor(b).x))
  }
  const axis = x && !horizontalSection ? 'x' : 'y',
    point = (cut.start + cut.end) / 2
  return [
    ...readingOrder(
      blocks.filter((b) => b[axis] < point),
      pageBlocks
    ),
    ...readingOrder(
      blocks.filter((b) => b[axis] >= point),
      pageBlocks
    )
  ]
}
function undecodedGlyph(text: string): boolean {
  return text.length === 1 && text.charCodeAt(0) < 32 && !/\s/u.test(text)
}
function symbolicExpression(text: string): boolean {
  if (undecodedGlyph(text)) return true
  if (
    /·/u.test(text) &&
    /[A-Za-z\p{Script=Greek}]/u.test(text) &&
    /^[A-Za-z\p{Script=Greek}\d\s·]+$/u.test(text) &&
    !/[A-Za-z]{3,}/u.test(text)
  )
    return true
  // Tokenization examples are literal lists, sometimes flattened from several
  // output rows. Keep quoted tokens and their underscore boundary markers intact.
  const tokens = [...text.matchAll(/[‘’'"][A-Za-z_][A-Za-z_0-9]*[‘’'"]/gu)]
  if (
    tokens.length >= 2 &&
    /[[\]]/u.test(text) &&
    /^[\s,，[\]]*$/u.test(text.replace(/[‘’'"][A-Za-z_][A-Za-z_0-9]*[‘’'"]/gu, ''))
  )
    return true
  // Norm bars and Adobe extensible-bracket pieces have no translatable prose.
  if (/^[✓✗∣∥‖︷︸⏞⏟\uF8EB-\uF8FE\s]+$/u.test(text.trim())) return true
  // A prose citation lead-in is not a function with a square-bracket argument.
  if (/^(?:Following|See(?: also)?|As in|According to)\s*\[$/iu.test(text.trim())) return false
  if (/^[A-Z][A-Za-z-]{2,}\s+\[\d+(?:[ ,–-]\d+)*\]\s+(?:and|or)$/u.test(text.trim())) return false
  // A numeric comparison in a prose continuation is not a function call.
  if (/^[A-Za-z]{3,}\s+\(\d+(?:\.\d+)?\s+vs\.$/u.test(text.trim())) return false
  // Lowercase prose (including a word continued from the preceding line) can
  // introduce a parenthesized example/condition. It is not a named math function.
  if (
    /^[a-z]{3,}\s+\((?:(?:e\.g|i\.e|a\.k\.a)\.|[∼~]|[A-Za-z]\s*[<>≤≥=])/u.test(text.trim()) &&
    !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(text.trim())
  )
    return false
  const content = text.replace(
    /\b(?:where|and|for|from|thus|hence|therefore|lim|max|min|log|ln|exp|sin|cos|tan|det)\b/giu,
    ''
  )
  return (
    (content.includes('\u0302') ||
      /[([|√∑∫=≠≤≥+*/^←→∂−\p{Script=Greek}]/u.test(content) ||
      /^[)\]}]+(?:\s*[A-Za-z\p{Script=Greek}])?$/u.test(content.trim()) ||
      /\b[A-Za-z]{2,}\s*[([]/u.test(content)) &&
    !/(?:[A-Za-z]{3,}|\b(?:an|as|at|be|by|do|go|if|in|is|it|no|of|on|or|so|to|up|us|we)\b)/iu.test(
      content.replace(/\b[A-Za-z]{2,}[\p{Script=Greek}\d]*(?=\s*[([])/gu, '')
    )
  )
}

// A repeated centered margin title is a running header, not a spanning body
// block. Native font, position and size must repeat on at least three pages.
function runningHeaderItems(pages: PdfLayoutPage[]): Set<string> {
  const candidates = new Map<
    string,
    { page: number; index: number; x: number; y: number; width: number; font: number }[]
  >()
  for (const page of pages)
    for (const [index, item] of page.items.entries()) {
      const [a, b, c, d, x, y] = item.transform
      const baseline = page.height - y
      // A short publication label can sit at the body edge instead of being
      // centered. Require an otherwise empty upper margin and independent body
      // text, then apply the same multi-page font/position proof below.
      const isolatedMarginLabel =
        baseline <= page.height * 0.05 &&
        item.width >= d * 2 &&
        item.width < page.width * 0.18 &&
        x >= page.width * 0.05 &&
        x + item.width <= page.width * 0.95 &&
        /^\p{Lu}[\p{L}-]{3,19}\.$/u.test(item.str) &&
        page.items.findIndex((part) => part.str.trim()) === index &&
        page.items.every(
          (part, other) =>
            other === index ||
            !part.str.trim() ||
            (part.transform.length === 6 &&
              part.transform.every(Number.isFinite) &&
              page.height - part.transform[5] - Math.abs(part.transform[3]) * 0.85 >
                baseline + d * 2)
        ) &&
        page.items.some(
          (part) => part !== item && part.width > page.width * 0.3 && wordCount(part.str) >= 8
        )
      if (
        page.rotation !== 0 ||
        item.dir !== 'ltr' ||
        !item.fontName ||
        ![a, b, c, d, x, y, item.width, page.width, page.height].every(Number.isFinite) ||
        a <= 0 ||
        d <= 0 ||
        Math.abs(b) > 0.001 ||
        Math.abs(c) > 0.001 ||
        baseline < d * 2 ||
        baseline > page.height * 0.08 ||
        (!isolatedMarginLabel &&
          (item.width < page.width * 0.2 ||
            item.width > page.width * 0.65 ||
            Math.abs(x + item.width / 2 - page.width / 2) > d * 2 ||
            item.str.length < 16 ||
            wordCount(item.str) > 12 ||
            !/^[\p{L}][\p{L}\p{N} ,:–—()-]+$/u.test(item.str)))
      )
        continue
      const key = `${item.fontName}:${item.str}:${page.width}:${page.height}`
      const values = candidates.get(key) ?? []
      values.push({ page: page.page, index, x, y: baseline, width: item.width, font: d })
      candidates.set(key, values)
    }
  const result = new Set<string>()
  for (const values of candidates.values()) {
    const first = values[0]
    if (
      new Set(values.map((value) => value.page)).size < 3 ||
      values.length !== new Set(values.map((value) => value.page)).size ||
      values.some(
        (value) =>
          Math.abs(value.font - first.font) > first.font * 0.02 ||
          Math.abs(value.x - first.x) > first.font * 0.2 ||
          Math.abs(value.y - first.y) > first.font * 0.2 ||
          Math.abs(value.width - first.width) > first.font * 0.2
      )
    )
      continue
    for (const value of values) result.add(`${value.page}:${value.index}`)
  }
  return result
}
function extractPage(
  page: PdfLayoutPage,
  runningHeaders: Set<string>,
  numberedPackets: number[][] = []
): LayoutPage {
  let nativeLine = 0
  const nativeLineIds: number[] = [],
    finalizedLines = new Set<number>()
  for (const [index, item] of page.items.entries()) {
    nativeLineIds[index] = nativeLine
    if (item.hasEOL === true) {
      finalizedLines.add(nativeLine)
      nativeLine++
    }
  }
  const all = page.items.flatMap((item, index) => {
    if (!item.str.trim()) return []
    const [a, b, c, d, x, y] = item.transform
    const upright =
      page.rotation === 0 &&
      item.dir === 'ltr' &&
      Math.abs(b) < 0.001 &&
      Math.abs(c) <= Math.abs(d) * 0.5 &&
      a > 0 &&
      d > 0
    const font = (upright ? Math.abs(d) : Math.hypot(c, d)) || item.height || 9
    return [
      {
        ...item,
        index,
        nativeLine: nativeLineIds[index],
        key: `${page.page}:${index}`,
        page: page.page,
        font,
        x,
        y: page.height - y - font * 0.85,
        right: x + item.width,
        baseline: page.height - y,
        originalBaseline: page.height - y,
        bottom: page.height - y + font * 0.25,
        unsupported: !upright,
        detachedOperator:
          undecodedGlyph(item.str) ||
          /^[︷︸⏞⏟\uF8EB-\uF8FE]+$/u.test(item.str) ||
          (/^[∑∫∏]$/u.test(item.str) && (item.fontDescent ?? 0) < -1) ||
          (item.str === '√' && (item.fontDescent ?? 0) < -0.5) ||
          // Legacy extension-font brackets can decode as h/i. Their top-origin
          // font metrics distinguish them from ordinary letters or time units.
          (/^[∑∫∏√phi()[\]{}|∣∥‖]$/u.test(item.str) &&
            (item.fontAscent ?? 1) >= 0 &&
            (item.fontAscent ?? 1) < 0.1 &&
            (item.fontDescent ?? 0) <= -0.5 &&
            item.width >= font * (/^[hi()[\]{}|∣∥‖]$/u.test(item.str) ? 0.4 : 0.6) &&
            item.width <= font * 1.6)
      }
    ]
  })
  // LaTeXiT embeds a closed XML/base64 payload as effectively zero-size text.
  // Keep its native owners, but never attach it to a nearby visible formula.
  const embeddedMetadata = new Set<Item>()
  for (const [index, item] of all.entries()) {
    const payload = all[index + 1]
    if (
      item.str === '<latexit' &&
      payload &&
      /^sha1_base64="[A-Za-z0-9+/=]+">[A-Za-z0-9+/=]+<\/latexit>$/u.test(payload.str) &&
      item.font < 0.001 &&
      payload.font < 0.001 &&
      item.width < 0.001 &&
      payload.width < 0.001 &&
      item.fontName &&
      payload.fontName === item.fontName &&
      Math.abs(payload.originalBaseline - item.originalBaseline) < 0.001
    ) {
      embeddedMetadata.add(item)
      embeddedMetadata.add(payload)
    }
  }
  // Some symbol fonts encode a narrow inline trademark at a larger em size.
  // The adjoining native body runs, not that symbol's em, prove its reading row.
  for (const [index, mark] of all.entries()) {
    const before = all[index - 1],
      after = all[index + 1]
    if (
      !/^[®™]$/u.test(mark.str) ||
      !before ||
      !after ||
      mark.unsupported ||
      before.unsupported ||
      after.unsupported ||
      !before.fontName ||
      before.fontName !== after.fontName ||
      !mark.fontName ||
      !/\p{L}$/u.test(before.str) ||
      !/^[)\s\p{L}]/u.test(after.str) ||
      mark.font < before.font * 1.4 ||
      mark.font > before.font * 2 ||
      mark.width > before.font * 0.65 ||
      Math.abs(before.font - after.font) > before.font * 0.05 ||
      Math.abs(before.originalBaseline - after.originalBaseline) > before.font * 0.05 ||
      mark.originalBaseline - before.originalBaseline < 0 ||
      mark.originalBaseline - before.originalBaseline > before.font * 0.5 ||
      mark.x - before.right < -before.font * 0.05 ||
      mark.x - before.right > before.font * 0.1 ||
      after.x - mark.right < -before.font * 0.05 ||
      after.x - mark.right > before.font * 0.8
    )
      continue
    mark.font = before.font
    mark.baseline = before.baseline
  }
  // A drop cap is painted at the bottom of its inset opening lines. Its
  // native order and three matching prose rows prove the first reading row.
  const dropCaps = new Map<Item, Item>()
  for (const [index, cap] of all.entries()) {
    const rows = all.slice(index + 1, index + 4),
      first = rows[0]
    if (
      cap.unsupported ||
      !/^[A-Z]$/u.test(cap.str) ||
      rows.length !== 3 ||
      !first.fontName ||
      !/^\p{Ll}\p{L}+\s/u.test(first.str) ||
      cap.font < first.font * 2.8 ||
      cap.font > first.font * 5.5 ||
      Math.abs(cap.right - first.x) > first.font * 0.15 ||
      Math.abs(cap.y - first.y) > first.font ||
      Math.abs(cap.originalBaseline - rows[2].originalBaseline) > first.font * 0.2 ||
      rows.some(
        (row, at) =>
          row.unsupported ||
          row.fontName !== first.fontName ||
          Math.abs(row.font - first.font) > first.font * 0.05 ||
          Math.abs(row.x - first.x) > first.font * 0.15 ||
          row.str.trim().split(/\s+/u).length < 5 ||
          (at > 0 &&
            (row.originalBaseline - rows[at - 1].originalBaseline < first.font * 0.85 ||
              row.originalBaseline - rows[at - 1].originalBaseline > first.font * 1.6))
      )
    )
      continue
    dropCaps.set(cap, first)
    cap.font = first.font
    cap.baseline = first.baseline
  }
  const resolvedRadicands = new Map<Item, Item>()
  // Raised radicals can use a top-origin transform even in ordinary fonts. An adjacent body-sized
  // radicand proves their reading row; otherwise the radical is kept separate.
  // Without this, prose can silently lose √ while its region still contains it.
  for (const radical of all.filter(
    (item) => item.str === '√' && (item.detachedOperator || item.fontDescent !== undefined)
  )) {
    const bases = all.filter(
      (base) =>
        !base.unsupported &&
        /^[A-Za-z\p{Script=Greek}\d]{1,2}$/u.test(base.str) &&
        Math.abs(base.font - radical.font) < radical.font * 0.05 &&
        Math.abs(base.x - radical.right) < radical.font * 0.15 &&
        base.originalBaseline - radical.originalBaseline > radical.font * 0.65 &&
        base.originalBaseline - radical.originalBaseline < radical.font * 0.95
    )
    if (bases.length !== 1) continue
    if (
      !radical.unsupported &&
      bases[0].nativeLine === radical.nativeLine &&
      bases[0].index > radical.index &&
      !all.some((item) => item.index > radical.index && item.index < bases[0].index)
    )
      resolvedRadicands.set(radical, bases[0])
    radical.detachedOperator = false
    radical.baseline = bases[0].baseline
    radical.y = bases[0].y
    radical.bottom = bases[0].bottom
  }
  // Extension-font floor/ceiling delimiters can use a top-origin transform.
  // A centered stacked fraction proves the body row independently of that origin.
  // Keep its glyph boxes while assigning its tiers and paired delimiters to that row.
  const fractionCandidates = all.map((item) => ({
    i: item.index,
    text: item.str,
    fontSize: item.font,
    baseline: -item.baseline,
    bounds: [item.x, -item.bottom, item.right, -item.y] as [number, number, number, number]
  }))
  const fractionRows = new Set<string>()
  const alignedFractions = new Set<number>()
  const preservedFractions: {
    indices: number[]
    label: string
    baseline: number
    right: number
  }[] = []
  for (const body of all.filter((item) => item.str.length > 3 && !item.unsupported)) {
    const key = body.baseline.toFixed(2) + ':' + body.font.toFixed(2)
    if (fractionRows.has(key)) continue
    fractionRows.add(key)
    // A small radical denominator and centered numerator form one protected
    // inline formula. Keep both tiers out of prose instead of dropping the raised
    // numerator or sending an incomplete expression to the model.
    for (const radical of all.filter(
      (i) => i.str === '√' && !i.detachedOperator && i.font < body.font * 0.85
    )) {
      if (preservedFractions.some((f) => f.indices.includes(radical.index))) continue
      const bases = all.filter(
        (i) =>
          /^[A-Za-z\p{Script=Greek}]$/u.test(i.str) &&
          Math.abs(i.font - radical.font) < body.font * 0.05 &&
          Math.abs(i.x - radical.right) < body.font * 0.15 &&
          i.originalBaseline - body.originalBaseline > body.font * 0.2 &&
          i.originalBaseline - body.originalBaseline < body.font * 0.7
      )
      if (bases.length !== 1) continue
      const base = bases[0]
      const scripts = (base: typeof radical): typeof all =>
        all.filter(
          (i) =>
            /^\d{1,2}$/u.test(i.str) &&
            i.font < base.font * 0.8 &&
            i.font > base.font * 0.6 &&
            i.x - base.right > -base.font * 0.15 &&
            i.x - base.right < base.font * 0.3 &&
            Math.abs(i.originalBaseline - base.originalBaseline) < base.font * 0.5
        )
      const denominator = [radical, base, ...scripts(base)],
        right = Math.max(...denominator.map((i) => i.right))
      const numerators = all.filter(
        (i) =>
          /^[A-Za-z\p{Script=Greek}]$/u.test(i.str) &&
          Math.abs(i.font - radical.font) < body.font * 0.05 &&
          body.originalBaseline - i.originalBaseline > body.font * 0.2 &&
          body.originalBaseline - i.originalBaseline < body.font * 0.7 &&
          i.x >= radical.x &&
          i.right <= right &&
          Math.abs((i.x + i.right - radical.x - right) / 2) < body.font * 0.3
      )
      if (numerators.length !== 1) continue
      const numerator = numerators[0],
        members = [numerator, ...scripts(numerator), ...denominator]
      if (members.some((i) => preservedFractions.some((f) => f.indices.includes(i.index)))) continue
      const label = (base: typeof radical): string =>
        base.str +
        scripts(base)
          .sort((a, b) => b.originalBaseline - a.originalBaseline)
          .map((i) => (i.originalBaseline > base.originalBaseline ? '_' : '^') + i.str)
          .join('')
      alignedFractions.add(numerator.index)
      preservedFractions.push({
        indices: members.map((i) => i.index),
        label: label(numerator) + '/(√' + label(base) + ')',
        baseline: body.baseline,
        right
      })
    }
    for (const fraction of resolveInlineFractions(
      fractionCandidates,
      -body.originalBaseline,
      body.font
    )) {
      const numerator = all.find((item) => item.index === fraction.numerator)!
      if (alignedFractions.has(fraction.numerator)) continue
      if (
        /^(?:1\/[A-Za-z\p{Script=Greek}]|[A-Za-z\p{Script=Greek}]\/\([A-Za-z\p{Script=Greek}][+−-]\d{1,3}\))$/u.test(
          fraction.label
        )
      ) {
        alignedFractions.add(fraction.numerator)
        preservedFractions.push({ ...fraction, baseline: body.baseline, right: fraction.bounds[2] })
        continue
      }
      // Numeric fractions already share a prose band. Correct the split identifier
      // case without changing ordinary citation/subscript baseline assignment.
      if (/^\d/u.test(numerator.str)) continue
      alignedFractions.add(fraction.numerator)
      for (const item of all.filter((item) => fraction.indices.includes(item.index)))
        item.baseline = body.baseline
      const left = all.filter(
        (item) =>
          item.str === '⌊' &&
          fraction.bounds[0] - item.right >= 0 &&
          fraction.bounds[0] - item.right < body.font &&
          item.originalBaseline < body.baseline - body.font * 0.6 &&
          body.baseline - item.originalBaseline < body.font * 2
      )
      const right = all.filter(
        (item) =>
          item.str === '⌋' &&
          item.x - fraction.bounds[2] >= 0 &&
          item.x - fraction.bounds[2] < body.font &&
          item.originalBaseline < body.baseline - body.font * 0.6 &&
          body.baseline - item.originalBaseline < body.font * 2
      )
      if (
        left.length === 1 &&
        right.length === 1 &&
        Math.abs(left[0].originalBaseline - right[0].originalBaseline) < 0.1
      ) {
        for (const item of [left[0], right[0]]) {
          item.baseline = body.baseline
          item.y = item.originalBaseline
          item.bottom = Math.max(-fraction.bounds[1], body.baseline + body.font * 0.25)
        }
      }
    }
  }
  // A tiny second-level subscript may be geometrically closer to the next
  // row's fraction tiers. Preserve its proven native inline owner instead of
  // allowing the stacked-expression pass to borrow it across native rows.
  const nestedScriptOwners = new Map<Item, Item>()
  for (let index = 2; index < all.length - 1; index++) {
    const base = all[index - 2],
      first = all[index - 1],
      second = all[index],
      following = all[index + 1]
    if (
      ![base, first, second].every((item) => /^[A-Za-z]$/u.test(item.str)) ||
      ![base, first, second, following].every(
        (item) =>
          !item.unsupported &&
          !item.detachedOperator &&
          !!item.fontName &&
          Number.isFinite(item.width) &&
          item.width > 0 &&
          Number.isFinite(item.height) &&
          item.height > 0 &&
          item.transform.length === 6 &&
          item.transform.every(Number.isFinite) &&
          item.transform[0] > 0 &&
          item.transform[3] > 0 &&
          Math.abs(item.transform[0] - item.font) < item.font * 0.05 &&
          Math.abs(item.height - item.font) < item.font * 0.05 &&
          Math.abs(item.transform[1]) < 0.001 &&
          Math.abs(item.transform[2]) < 0.001 &&
          item.nativeLine === base.nativeLine
      ) ||
      ![
        [base, first],
        [first, second]
      ].every(
        ([parent, child]) =>
          child.font >= parent.font * 0.6 &&
          child.font < parent.font * 0.85 &&
          child.originalBaseline - parent.originalBaseline > parent.font * 0.08 &&
          child.originalBaseline - parent.originalBaseline < parent.font * 0.55 &&
          child.x - parent.right >= -parent.font * 0.01 &&
          child.x - parent.right < parent.font * 0.05
      ) ||
      !/^[A-Za-z ,;:'’!.?–-]+$/u.test(following.str) ||
      (following.str.match(/\b[a-z]{2,}\b/gu)?.length ?? 0) < 3 ||
      /\b(?:sin|cos|tan|log|exp|lim|(?:arg)?min|(?:arg)?max)\b/u.test(following.str) ||
      /\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(following.str) ||
      Math.abs(following.font - base.font) > base.font * 0.05 ||
      Math.abs(following.originalBaseline - base.originalBaseline) > base.font * 0.05 ||
      following.x - second.right < 0 ||
      following.x - second.right > base.font * 0.5
    )
      continue
    nestedScriptOwners.set(second, base)
  }
  // Isolate a visibly stacked mathematical expression as a whole. Its source
  // order cannot be inferred by sorting the numerator and denominator as prose.
  // Keep adjacent sentences translatable while retaining every formula glyph.
  const stackedRows = new Set<string>(),
    proseItems = all.filter((i) => /[A-Za-z]{3,}/u.test(i.str) && !i.unsupported)
  for (const body of proseItems) {
    const key = body.baseline.toFixed(2) + ':' + body.font.toFixed(2)
    if (stackedRows.has(key)) continue
    stackedRows.add(key)
    const rowProse = proseItems.filter(
      (i) => Math.abs(i.originalBaseline - body.originalBaseline) < body.font * 0.1
    )
    const candidates = all
      .filter(
        (i) =>
          !i.unsupported &&
          (!nestedScriptOwners.has(i) ||
            nestedScriptOwners.get(i)!.nativeLine === body.nativeLine) &&
          // A top-origin radical already belongs to its adjacent native
          // radicand's row, even when its original transform is nearer a
          // preceding stacked equation. Do not reassign that proven owner.
          (!resolvedRadicands.has(i) ||
            Math.abs(i.font - body.font) > body.font * 0.05 ||
            Math.abs(resolvedRadicands.get(i)!.originalBaseline - body.originalBaseline) <
              body.font * 0.1) &&
          (!/[A-Za-z]{3,}/u.test(i.str) ||
            // Word variables may form small fraction tiers or exponents in a
            // distinct math font. They still need the stacked geometry and
            // connected operator group below; ordinary baseline prose cannot join.
            (i.font < body.font * 0.85 &&
              i.fontName !== undefined &&
              body.fontName !== undefined &&
              i.fontName !== body.fontName &&
              /^[A-Za-z]+(?:\s+[A-Za-z]+)?$/u.test(i.str) &&
              Math.abs(i.originalBaseline - body.originalBaseline) > body.font * 0.2)) &&
          i.font <= body.font * 1.1 &&
          Math.abs(i.originalBaseline - body.originalBaseline) < body.font * 0.9 &&
          // Tiny fraction tiers can be closer to the preceding prose row
          // than to their own base. The stacked geometry below owns them.
          (i.font <= body.font * 0.6 ||
            !proseItems.some(
              (other) =>
                (!/[A-Za-z]{3,}/u.test(i.str) ||
                  (other.font >= body.font * 0.85 && other.x < i.right && other.right > i.x)) &&
                Math.abs(i.originalBaseline - other.originalBaseline) + body.font * 0.05 <
                  Math.abs(i.originalBaseline - body.originalBaseline)
            )) &&
          !rowProse.some((prose) => i.x < prose.right && i.right > prose.x)
      )
      .sort((a, b) => a.x - b.x)
    const groups: (typeof all)[] = []
    for (const item of candidates) {
      const previous = groups.at(-1)
      if (previous && item.x - Math.max(...previous.map((i) => i.right)) < body.font * 0.55)
        previous.push(item)
      else groups.push([item])
    }
    for (const members of groups) {
      if (
        !members.some((i) => /[√∑∫=≠≤≥+*/^←→∂−\p{Script=Greek}]/u.test(i.str)) ||
        !members.some(
          (a) =>
            a.font < body.font * 0.85 &&
            members.some((b) => {
              if (Math.min(a.right, b.right) - Math.max(a.x, b.x) <= body.font * 0.15) return false
              const ordinaryFraction =
                members.some((i) => i.originalBaseline < body.originalBaseline - body.font * 0.2) &&
                members.some((i) => i.originalBaseline > body.originalBaseline + body.font * 0.2) &&
                Math.abs(a.originalBaseline - b.originalBaseline) > body.font * 0.65
              // A fraction may sit wholly above the row as an exponent; its
              // denominator can contain a variable centered under the numerator.
              const fractionalExponent =
                /^[0-9]+$/u.test(a.str) &&
                /^[0-9A-Za-z\p{Script=Greek}]+$/u.test(b.str) &&
                b.font < body.font * 0.85 &&
                Math.max(a.originalBaseline, b.originalBaseline) <
                  body.originalBaseline - body.font * 0.1 &&
                Math.abs(a.originalBaseline - b.originalBaseline) > Math.max(a.font, b.font) * 0.65
              return ordinaryFraction || fractionalExponent
            })
        )
      )
        continue
      const indices = members.map((i) => i.index)
      if (
        preservedFractions.some(
          (f) => f.indices.length === indices.length && f.indices.every((i) => indices.includes(i))
        )
      )
        continue
      if (
        preservedFractions.some(
          (f) =>
            f.indices.some((i) => indices.includes(i)) &&
            !f.indices.every((i) => indices.includes(i))
        )
      )
        continue
      for (let i = preservedFractions.length - 1; i >= 0; i--)
        if (preservedFractions[i].indices.every((id) => indices.includes(id)))
          preservedFractions.splice(i, 1)
      preservedFractions.push({
        indices,
        label: members
          .sort((a, b) => a.index - b.index)
          .map((i) => i.str)
          .join(' '),
        baseline: body.baseline,
        right: Math.max(...members.map((i) => i.right))
      })
      for (const item of members) item.detachedOperator = false
    }
  }
  const nativeGroups = Map.groupBy(
    all.filter((item) => !embeddedMetadata.has(item)),
    (item) => item.nativeLine
  )
  const usableLines = new Set(
    [...nativeGroups]
      .filter(
        ([id, items]) =>
          finalizedLines.has(id) &&
          items.every((i) => !i.unsupported) &&
          Math.max(...items.map((i) => i.baseline)) - Math.min(...items.map((i) => i.baseline)) <
            Math.max(...items.map((i) => i.font)) * 0.5
      )
      .map(([id]) => id)
  )
  // A compact plot may sit beside body prose. Prove both numeric axes before
  // separating small tick objects, so a near-baseline tick cannot become a
  // superscript or an ordinary word in the neighboring paragraph.
  const wordsByFont = new Map<string, Item[]>()
  for (const item of all) {
    if (item.fontName === undefined || !/\p{L}/u.test(item.str)) continue
    const words = wordsByFont.get(item.fontName) ?? []
    words.push(item)
    wordsByFont.set(item.fontName, words)
  }
  const plotTicks = new Set<Item>(),
    proseRows = all.filter((item) => (item.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6),
    ticks = all.filter(
      (item) =>
        !item.unsupported &&
        item.fontName !== undefined &&
        item.transform.every(Number.isFinite) &&
        item.width > 0 &&
        /^[−-]?\d+(?:\.\d+)?$/u.test(item.str.trim()) &&
        !(wordsByFont.get(item.fontName) ?? []).some(
          (other) =>
            other !== item &&
            Math.abs(other.originalBaseline - item.originalBaseline) < item.font * 0.1 &&
            ((other.x >= item.right && other.x - item.right < item.font * 0.5) ||
              (item.x >= other.right && item.x - other.right < item.font * 0.5))
        )
    )
  for (const tick of ticks) {
    if (
      !proseRows.some(
        (item) =>
          item.font > tick.font / 0.85 &&
          item.fontName !== tick.fontName &&
          item.right <= tick.x &&
          tick.x - item.right < item.font * 2 &&
          Math.abs(item.baseline - tick.baseline) < item.font * 0.5
      )
    )
      continue
    const same = ticks.filter(
        (other) =>
          other.fontName === tick.fontName && Math.abs(other.font - tick.font) < tick.font * 0.01
      ),
      column = same
        .filter((other) => Math.abs(other.right - tick.right) < tick.font * 0.15)
        .sort((a, b) => a.baseline - b.baseline),
      vertical = column
        .flatMap((first, index) => {
          const gap = column[index + 1]?.baseline - first.baseline
          if (!(gap > tick.font && gap < tick.font * 6)) return []
          const run = [first, column[index + 1]]
          for (const next of column.slice(index + 2)) {
            if (Math.abs(next.baseline - run.at(-1)!.baseline - gap) > tick.font * 0.15) break
            run.push(next)
          }
          return run.length >= 3 && run.includes(tick) ? [run] : []
        })
        .sort((a, b) => b.length - a.length)[0]
    if (
      !vertical ||
      vertical.length < 3 ||
      new Set(vertical.map((item) => item.str.trim())).size !== vertical.length ||
      !vertical.some((item) => /^[−-]/u.test(item.str.trim())) ||
      !vertical.some((item) => Number(item.str.trim().replace('−', '-')) > 0) ||
      !vertical.slice(1).every((item, index) => {
        const gap = item.baseline - vertical[index].baseline
        return gap > tick.font && gap < tick.font * 6
      })
    )
      continue
    const bottom = vertical.at(-1)!,
      horizontal = same
        .filter(
          (item) =>
            item.x > tick.right &&
            item.x - tick.right < tick.font * 35 &&
            item.baseline - bottom.baseline > tick.font * 0.5 &&
            item.baseline - bottom.baseline < tick.font * 3
        )
        .sort((a, b) => a.x - b.x)
    if (
      horizontal.length < 3 ||
      horizontal[0].x - tick.right > tick.font * 3 ||
      horizontal.at(-1)!.right - horizontal[0].x < tick.font * 6 ||
      !horizontal.some((item) => /^[−-]/u.test(item.str.trim())) ||
      !horizontal.some((item) => Number(item.str.trim().replace('−', '-')) > 0) ||
      !horizontal.every(
        (item) => Math.abs(item.baseline - horizontal[0].baseline) < tick.font * 0.08
      )
    )
      continue
    for (const item of [...vertical, ...horizontal]) plotTicks.add(item)
  }
  const bands: { baseline: number; font: number; items: Item[] }[] = []
  const attachedScripts = new Set<Item>()
  for (const item of all
    .filter(
      (i) =>
        !i.unsupported &&
        !i.detachedOperator &&
        !embeddedMetadata.has(i) &&
        !plotTicks.has(i) &&
        !preservedFractions.some((fraction) => fraction.indices.includes(i.index))
    )
    // Establish full-size baselines before assigning superscripts. Otherwise a
    // raised reference in the opposite column can capture a line's first glyphs.
    .sort((a, b) => b.font - a.font || a.baseline - b.baseline || a.x - b.x)) {
    const sharesLine = (band: (typeof bands)[number]): number =>
      Number(
        usableLines.has(item.nativeLine) &&
          band.items.some((other) => other.nativeLine === item.nativeLine)
      )
    // A raised/lowered glyph belongs to its adjacent base before a closer row
    // in another column. Vertical distance alone can detach a power from σ.
    const adjacentBase = (band: (typeof bands)[number]): number =>
      Number(
        band.items.some(
          (base) =>
            item.font < base.font * 0.85 &&
            /^[A-Za-z0-9()+−†‡]+$/u.test(item.str) &&
            /[\p{L}\p{N})\]]$/u.test(base.str) &&
            ((Math.abs(item.baseline - base.baseline) > base.font * 0.08 &&
              Math.abs(item.baseline - base.baseline) < base.font * 0.55 &&
              item.x - base.right >= -base.font * 0.1 &&
              item.x - base.right < base.font * 0.5) ||
              // Named operators place their lower limit underneath, not at the
              // right edge used by ordinary subscripts. Keep it with the operator.
              (/^(?:arg\s*)?(?:min|max|lim)$/u.test(base.str) &&
                item.baseline - base.baseline > base.font * 0.4 &&
                item.baseline - base.baseline < base.font * 0.9 &&
                item.x >= base.x &&
                item.right <= base.right &&
                base.right - item.x < base.font * 1.2))
        ) ||
          // A table footnote starts with a raised letter before its prose, not
          // after a mathematical base. Keep it in that line's source identity.
          (/^[a-z]$/u.test(item.str) &&
            band.items.reduce(
              (count, part) => count + (part.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0),
              0
            ) >= 3 &&
            band.items.some(
              (base) =>
                item.font < base.font * 0.85 &&
                base.baseline - item.baseline > base.font * 0.08 &&
                base.baseline - item.baseline < base.font * 0.75 &&
                base.x - item.right >= 0 &&
                base.x - item.right < base.font * 0.5
            )) ||
          (item.font < band.font * 0.85 &&
            /^[A-Za-z0-9()+−]+$/u.test(item.str) &&
            band.items.some(
              (part) =>
                attachedScripts.has(part) &&
                Math.abs(part.font - item.font) < band.font * 0.05 &&
                Math.abs(part.originalBaseline - item.originalBaseline) < band.font * 0.1 &&
                item.x - part.right >= -band.font * 0.1 &&
                item.x - part.right < band.font * 0.3
            ))
      )
    let band = bands
      .filter(
        (b) =>
          sharesLine(b) ||
          adjacentBase(b) ||
          (Math.abs(b.baseline - item.baseline) < Math.max(b.font, item.font) * 0.45 &&
            // A larger row in another column can sit between two smaller rows.
            // Its tolerance must not merge distinct, overlapping body rows here.
            !b.items.some(
              (other) =>
                usableLines.has(item.nativeLine) &&
                usableLines.has(other.nativeLine) &&
                other.nativeLine !== item.nativeLine &&
                other.x < item.right &&
                other.right > item.x &&
                Math.abs(other.baseline - item.baseline) >= Math.max(other.font, item.font) * 0.45
            ))
      )
      .sort((a, b) => {
        return (
          adjacentBase(b) - adjacentBase(a) ||
          sharesLine(b) - sharesLine(a) ||
          Math.abs(a.baseline - item.baseline) - Math.abs(b.baseline - item.baseline)
        )
      })[0]
    if (!band) {
      band = { baseline: item.baseline, font: item.font, items: [] }
      bands.push(band)
    }
    if (adjacentBase(band)) attachedScripts.add(item)
    band.items.push(item)
    band.font = Math.max(band.font, item.font)
  }
  // PDF.js native lines can cross table columns. Require repeated, aligned
  // numeric rows before treating their separated labels and headers as cells.
  // Keep cells independent vertically too: merging a label column would move
  // translations away from their numeric row or cover intervening table rules.
  const spacedCells = (band: (typeof bands)[number], columns: number[] = []): Item[][] => {
    const cells: Item[][] = []
    for (const item of [...band.items].sort((a, b) => a.x - b.x)) {
      const previous = cells.at(-1)
      const columnStart =
        previous &&
        columns.some(
          (x) =>
            Math.abs(item.x - x) < band.font * 0.3 &&
            previous[0].x < x - band.font * 0.5 &&
            Math.max(...previous.map((i) => i.right)) <= x + band.font * 0.1
        )
      if (
        !previous ||
        (columnStart &&
          // A numeric column anchor can fall inside an italic P-value header.
          // Its adjacent native runs prove the complete label, not two cells.
          !(
            previous.length === 1 &&
            /^[pP]$/u.test(previous[0].str.trim()) &&
            /^[-−]\s*value$/u.test(item.str.trim()) &&
            previous[0].nativeLine === item.nativeLine &&
            item.index > previous[0].index &&
            !all.some((part) => part.index > previous[0].index && part.index < item.index) &&
            Math.abs(item.font - previous[0].font) < band.font * 0.05 &&
            Math.abs(item.originalBaseline - previous[0].originalBaseline) < band.font * 0.05 &&
            item.x - previous[0].right >= -band.font * 0.05 &&
            item.x - previous[0].right < band.font * 0.3
          )) ||
        item.x - Math.max(...previous.map((i) => i.right)) > band.font * 0.9
      )
        cells.push([item])
      else previous.push(item)
    }
    return cells
  }
  // Clinical tables commonly use mean (SD), confidence intervals and marked
  // P values. They still prove numeric columns; parentheses are not body prose.
  const statisticalCell = (text: string): boolean =>
    /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\s*\[[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s+to\s+|\s*[–−-]\s*)[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\]$/u.test(
      text
    ) ||
    /^\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?%\)[a-z]?$/u.test(text) ||
    /^\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?(?:ms|s)?(?:\s*\(\d+(?:\.\d+)?%\))?$/u.test(text) ||
    /^(?:[<>≤≥]\s*)?[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\([+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:(?:\s+to\s+|\s*[–−-]\s*)[+−-]?(?:\d+(?:\.\d+)?|\.\d+))?\))?[a-z]?$/u.test(
      text
    )
  // A raised power is already proven by the source glyph geometry. Flat trailing
  // digits are not an exponent; repeated aligned rows still prove the table.
  const scientificCell = (text: string): boolean =>
    /^[+−-]?\d+(?:\.\d+)?\s*[×·]\s*10[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}$/u.test(text)
  const pairedCount = (text: string): boolean => /^\d+[kMG]?(?:\/\d+[kMG]?)+$/u.test(text)
  const scaledCount = (text: string): boolean =>
    /^\d+(?:\.\d+)?[kMGB]\s*\(\d+(?:\.\d+)?x\)$/u.test(text)
  const numericCell = (text: string): boolean =>
    pairedCount(text) ||
    scaledCount(text) ||
    /^\d+[kMG]\s*\(shared\)$/u.test(text) ||
    /^[✓✗]$/u.test(text) ||
    /^[+−-]?\d[\d\s.,/×+−–%-]*(?:[kMGB]|ms|s)?$/u.test(text) ||
    statisticalCell(text) ||
    scientificCell(text)
  // Preserve technical values only inside an independently established table.
  // Units and tensor dimensions must not supply new evidence for table detection.
  const preservedTableValue = (text: string): boolean =>
    /^[-−–—]$/u.test(text) ||
    pairedCount(text) ||
    scaledCount(text) ||
    /^[✓✗]$/u.test(text) ||
    /^[+−-]?\d[\d\s.,/×x+−–%-]*(?:[kKMGT]?B|[KMGT]iB|[kMG]|ms|s|bits?)?$/u.test(text) ||
    statisticalCell(text) ||
    scientificCell(text)
  // Dense benchmark tables can use gaps smaller than a normal word and
  // dash placeholders. Independent native values in at least two aligned
  // columns across three labeled rows establish their frame. A neighboring
  // prose column must not change that frame's font or reading geometry.
  const denseValue = (item: Item): boolean =>
    /^[-−–—]$|^\d{1,4}(?:\.\d{1,4})?$/u.test(item.str.trim())
  const measuredEnds = new Map<Item, number>()
  const denseCandidates = bands.flatMap((band) => {
    const values = band.items
      .filter(denseValue)
      .filter((value) => {
        // A tightly adjacent native mean ± SD is one measured value. Its
        // right operand must not establish an extra table column or seam.
        const sign = all.findLast((item) => item.index < value.index)
        if (sign?.str.trim() !== '±') return true
        const mean = all.findLast((item) => item.index < sign.index)
        if (
          !mean ||
          !/^\d{1,4}(?:\.\d{1,4})?$/u.test(mean.str.trim()) ||
          !value.fontName ||
          [mean, sign].some(
            (item) =>
              item.nativeLine !== value.nativeLine ||
              item.fontName !== value.fontName ||
              Math.abs(item.font - value.font) >= value.font * 0.05 ||
              Math.abs(item.originalBaseline - value.originalBaseline) >= value.font * 0.05
          ) ||
          sign.x - mean.right < -value.font * 0.05 ||
          sign.x - mean.right >= value.font * 0.3 ||
          value.x - sign.right < -value.font * 0.05 ||
          value.x - sign.right >= value.font * 0.3
        )
          return true
        measuredEnds.set(mean, value.right)
        return false
      })
      .sort((a, b) => a.x - b.x)
    const groups: Item[][] = []
    for (const value of values) {
      const previous = groups.at(-1)
      if (
        !previous ||
        value.x - (measuredEnds.get(previous.at(-1)!) ?? previous.at(-1)!.right) > value.font * 4 ||
        Math.abs(value.font - previous.at(-1)!.font) > value.font * 0.1
      )
        groups.push([value])
      else previous.push(value)
    }
    return groups.flatMap((values) => {
      if (values.length < 2 || values.filter((item) => /\d/u.test(item.str)).length < 2) return []
      const font = median(values.map((item) => item.font))
      if (values.some((item) => Math.abs(item.font - font) > font * 0.1)) return []
      const first = values[0]
      // Native operators connect operands within one tensor or expression;
      // repeated operands must never become independent table-column evidence.
      if (
        band.items.some(
          (item) =>
            /^[×x*·+−=/<>≤≥]$/u.test(item.str.trim()) &&
            item.x > first.x &&
            item.right < values.at(-1)!.right
        )
      )
        return []
      const labels = band.items
        .filter(
          (item) =>
            !denseValue(item) &&
            item.right <= first.x + font * 0.1 &&
            item.right > first.x - font * 12 &&
            item.str.length <= 80 &&
            item.str.split(/\s+/u).length <= 8 &&
            item.font <= font * 1.1
        )
        .sort((a, b) => a.x - b.x)
      const label = labels.at(-1)
      if (
        !label ||
        first.x - label.right > font * 12 ||
        !/\p{L}/u.test(labels.map((i) => i.str).join(' '))
      )
        return []
      const labelCells = spacedCells({ ...band, font, items: labels })
      const twoColumn = values.length === 2
      // Two columns need stronger native evidence than a wider table: one
      // complete descriptor, matching type size, and empty ink between values.
      // Never silently discard an earlier descriptive column or prose connector.
      if (
        twoColumn &&
        (labelCells.length !== 1 ||
          labels.some(
            (item) => Math.abs(item.font - font) > font * 0.1 && !attachedScripts.has(item)
          ) ||
          band.items.some(
            (item) => !values.includes(item) && item.x >= first.right && item.right <= values[1].x
          ))
      )
        return []
      const labelItems = labelCells.at(-1)!
      const items = [...labelItems, ...values]
      return [
        {
          ...band,
          font,
          items,
          cells: [lineOf(labelItems), ...values.map((item) => lineOf([item]))],
          numeric: values.map((item) => lineOf([item])),
          dense: true as const,
          twoColumn
        }
      ]
    })
  })
  const denseRows = denseCandidates.filter((row) => {
    const columns = row.twoColumn ? 2 : 3
    const peers = denseCandidates.filter(
      (other) =>
        other.twoColumn === row.twoColumn &&
        Math.abs(other.baseline - row.baseline) < row.font * 12 &&
        Math.abs(other.font - row.font) < row.font * 0.1 &&
        Math.abs(other.cells[0].x - row.cells[0].x) < row.font * 0.5 &&
        row.numeric.filter((cell) =>
          other.numeric.some(
            (peer) => Math.abs(cell.x + cell.right - peer.x - peer.right) < row.font * 0.6
          )
        ).length >= columns
    )
    // A dash may occupy an established numeric column, but cannot establish
    // an extra column by itself (such as a marker before two prose quantities).
    return (
      peers.length >= 3 &&
      row.numeric.filter((cell) =>
        peers.some((other) =>
          other.numeric.some(
            (peer) =>
              /\d/u.test(peer.text) &&
              Math.abs(cell.x + cell.right - peer.x - peer.right) < row.font * 0.6
          )
        )
      ).length >= columns
    )
  })
  // Wide narrative tables need complete record and column ownership, not
  // prose overlap. A native header establishes at least six narrow columns;
  // three records must repeat those anchors and three measured value columns.
  const narrativeCells = new Map<Item, object>()
  // Mixed tables need their native row and column identities even when most
  // cells contain words. A complete header and repeated serialized records
  // prove the frame; prose sharing a visual baseline supplies no evidence.
  const categoricalValue = (text: string): boolean => /^(?:Yes|No|Unclear|Invariant)$/iu.test(text)
  const mixedRecords = [...nativeGroups]
    .filter(([id]) => usableLines.has(id))
    .map(([, items]) => {
      const line = lineOf(items)
      return { ...line, cells: spacedCells(line).map(lineOf) }
    })
    .filter(
      (row) =>
        row.cells.length >= 4 &&
        row.cells.length <= 6 &&
        /\p{L}{3}/u.test(row.cells[0].text) &&
        row.cells[0].text.length <= 140 &&
        row.cells[0].text.split(/\s+/u).length <= 16 &&
        row.cells.slice(1, -1).some((cell) => /\p{L}{3}/u.test(cell.text)) &&
        ((/\d/u.test(row.cells.at(-1)!.text) &&
          (numericCell(row.cells.at(-1)!.text) ||
            /^\d+(?:\.\d+)?[kKMGT]?(?:\s+frames)?$/u.test(row.cells.at(-1)!.text))) ||
          // Closed response cells supply the same native row proof as scores.
          // Keep the full header and repeated column/type checks below.
          (row.cells.length >= 5 &&
            categoricalValue(row.cells.at(-1)!.text) &&
            row.cells.slice(1).filter((cell) => categoricalValue(cell.text)).length >= 2)) &&
        row.cells.slice(1, -1).every((cell) => cell.text.split(/\s+/u).length <= 8) &&
        row.items.every((item) => item.fontName && Math.abs(item.font - row.font) < row.font * 0.05)
    )
  for (const row of mixedRecords) {
    if (row.items.some((item) => narrativeCells.has(item))) continue
    const matches = mixedRecords.filter(
      (other) =>
        other.cells.length === row.cells.length &&
        Math.abs(other.cells[0].x - row.cells[0].x) < row.font * 0.15 &&
        Math.abs(other.font - row.font) < row.font * 0.05 &&
        other.cells.every(
          (cell, col) =>
            cell.items[0].fontName === row.cells[col].items[0].fontName &&
            (col === 0 ||
              Math.abs(cell.x + cell.right - row.cells[col].x - row.cells[col].right) <
                row.font * 0.6)
        )
    )
    const ordered = matches.toSorted((a, b) => a.baseline - b.baseline),
      at = ordered.indexOf(row),
      blocked = (a: number, b: number): boolean =>
        b - a >= row.font * 6 ||
        bands.some(
          (band) =>
            band.baseline > a + row.font * 0.1 &&
            band.baseline < b - row.font * 0.1 &&
            (band.items.some(
              (item) => item.x < row.cells[1].x && item.right > row.cells.at(-1)!.x
            ) ||
              (spacedCells(band).length >= row.cells.length &&
                band.items.every((item) => /\p{L}/u.test(item.str) && !/\d/u.test(item.str))))
        )
    let begin = at,
      end = at
    while (begin > 0 && !blocked(ordered[begin - 1].baseline, ordered[begin].baseline)) begin--
    while (end + 1 < ordered.length && !blocked(ordered[end].baseline, ordered[end + 1].baseline))
      end++
    const aligned = ordered.slice(begin, end + 1)
    if (
      aligned.filter((other) => Math.abs(other.baseline - row.baseline) < row.font * 6).length < 3
    )
      continue
    let first = row
    for (const other of aligned.toSorted((a, b) => b.baseline - a.baseline)) {
      if (other.baseline > first.baseline) continue
      if (first.baseline - other.baseline >= row.font * 6) break
      first = other
    }
    const left = row.cells.map((_, col) => Math.min(...aligned.map((peer) => peer.cells[col].x))),
      right = row.cells.map((_, col) => Math.max(...aligned.map((peer) => peer.cells[col].right))),
      seams = left.slice(1).map((x, col) => (x + right[col]) / 2),
      columnOf = (item: Item): number =>
        row.cells.findIndex(
          (_, col) =>
            !item.unsupported &&
            item.fontName &&
            Math.abs(item.font - row.font) < row.font * 0.1 &&
            item.x >= (seams[col - 1] ?? left[0] - row.font * 0.15) &&
            item.right <= (seams[col] ?? right[col] + row.font * 0.75)
        )
    if (seams.some((seam, col) => seam <= right[col] || seam >= left[col + 1])) continue
    const header = all.find(
      (item) =>
        item.index < Math.min(...first.items.map((part) => part.index)) &&
        first.baseline - item.originalBaseline > row.font * 0.75 &&
        first.baseline - item.originalBaseline < row.font * 8 &&
        Math.abs(item.x - left[0]) < row.font * 0.15 &&
        columnOf(item) === 0 &&
        /\p{L}{3}/u.test(item.str) &&
        item.str.split(/\s+/u).length <= 5 &&
        row.cells.every((_, col) =>
          all.some(
            (label) =>
              label.index < Math.min(...first.items.map((part) => part.index)) &&
              Math.abs(label.originalBaseline - item.originalBaseline) < row.font * 1.6 &&
              (columnOf(label) === col ||
                // A right-aligned final header may be wider than yes/no ink.
                // The serialized header row and exact outer edge prove its owner.
                (col === row.cells.length - 1 &&
                  label.nativeLine === item.nativeLine &&
                  label.fontName === row.cells[col].items[0].fontName &&
                  Math.abs(label.font - row.font) < row.font * 0.05 &&
                  label.width < row.font * 8 &&
                  label.x > right[col - 1] - row.font * 0.3 &&
                  Math.abs(label.right - right[col]) < row.font * 0.15) ||
                // A complete native header may name two neighboring columns
                // in one run. It proves their anchors without splitting that run.
                (label.fontName === row.cells[col].items[0].fontName &&
                  Math.abs(label.font - row.font) < row.font * 0.05 &&
                  label.x <= left[col] + row.font * 0.15 &&
                  label.right >= right[col] - row.font * 0.15 &&
                  left.filter(
                    (x, index) =>
                      label.x <= x + row.font * 0.15 &&
                      label.right >= right[index] - row.font * 0.15
                  ).length === 2 &&
                  label.x >= left[1] - row.font * 0.75 &&
                  label.right <= right.at(-1)! + row.font * 0.75)) &&
              /\p{L}{3}/u.test(label.str) &&
              label.str.split(/\s+/u).length <= 5 &&
              !numericCell(label.str.trim())
          )
        )
    )
    if (!header) continue
    const lastBaseline = Math.max(...aligned.map((peer) => peer.baseline)),
      starts = all
        .filter(
          (item) =>
            item.originalBaseline >= first.baseline - row.font * 0.1 &&
            item.originalBaseline <= lastBaseline + row.font * 0.1 &&
            Math.abs(item.x - left[0]) < row.font * 0.15 &&
            columnOf(item) === 0 &&
            /^[A-Z]/u.test(item.str) &&
            /\p{L}{3}/u.test(item.str)
        )
        .toSorted((a, b) => a.originalBaseline - b.originalBaseline),
      owners = new Map<string, object>()
    for (const item of all) {
      const col = columnOf(item)
      if (col < 0 || narrativeCells.has(item)) continue
      const record = starts.findLastIndex(
        (start) => item.originalBaseline >= start.originalBaseline - row.font * 0.1
      )
      const isHeader =
        item.index < Math.min(...first.items.map((part) => part.index)) &&
        Math.abs(item.originalBaseline - header.originalBaseline) < row.font * 1.6
      if (!isHeader && (record < 0 || item.originalBaseline > lastBaseline + row.font * 0.1))
        continue
      const key = `${isHeader ? 'header' : record}:${col}`
      if (!owners.has(key)) owners.set(key, {})
      narrativeCells.set(item, owners.get(key)!)
    }
  }
  for (const header of bands) {
    const columns = spacedCells(header).map(lineOf)
    if (
      columns.length < 6 ||
      columns.some(
        (cell) =>
          numericCell(cell.text) ||
          !/\p{L}/u.test(cell.text) ||
          cell.text.split(/\s+/u).length > 5 ||
          cell.right - cell.x > header.font * 12
      )
    )
      continue
    const aligned = (item: Item, column: Line): boolean =>
      Math.abs(item.x - column.x) < header.font * 0.2 &&
      Math.abs(item.font - header.font) < header.font * 0.1
    const records = bands
      .filter(
        (band) =>
          band.baseline > header.baseline + header.font * 0.75 &&
          band.items.some((item) => aligned(item, columns[0])) &&
          columns.filter((column) => band.items.some((item) => aligned(item, column))).length >=
            6 &&
          columns.filter((column) =>
            band.items.some((item) => aligned(item, column) && numericCell(item.str.trim()))
          ).length >= 3
      )
      .sort((a, b) => a.baseline - b.baseline)
    if (records.length < 3) continue
    // No native run may cross a column seam. Preserve unknown spans rather
    // than infer cells from text meaning or a page-wide spacing threshold.
    const columnOf = (item: Item): number => {
      const col = columns.findLastIndex((column) => item.x >= column.x - header.font * 0.2)
      if (
        col < 0 ||
        Math.abs(item.font - header.font) > header.font * 0.2 ||
        item.right > (columns[col + 1]?.x ?? columns[col].x + header.font * 12) - header.font * 0.15
      )
        return -1
      return col
    }
    // Some clinical records omit several measured columns. Once full rows
    // prove the frame, two values and a descriptor at a repeatedly owned native
    // label anchor establish another row; unmeasured wraps keep their owner.
    const fullRecords = [...records]
    // A spanning group header sits directly above this proven wide header.
    // Complete native labels repeat measured-column starts; their native type
    // must occur in three full records before ownership can split adjacent labels.
    for (const upper of bands) {
      if (
        header.baseline - upper.baseline <= header.font * 0.75 ||
        header.baseline - upper.baseline >= header.font * 1.8
      )
        continue
      const provenType = (item: Item): boolean =>
        !!item.fontName &&
        /\p{L}{3}/u.test(item.str) &&
        item.str.split(/\s+/u).length <= 8 &&
        item.width < header.font * 12 &&
        Math.abs(item.originalBaseline - upper.baseline) < header.font * 0.1 &&
        fullRecords.filter((record) =>
          record.items.some(
            (part) =>
              part.fontName === item.fontName &&
              Math.abs(part.font - item.font) < header.font * 0.05
          )
        ).length >= 3
      const groups = upper.items.flatMap((item) => {
        if (!provenType(item)) return []
        const matches = columns
          .slice(1)
          .flatMap((column, index) =>
            Math.abs(item.x - column.x) < header.font * 0.2 ? [index] : []
          )
        return matches.length === 1 ? [{ item, column: matches[0] }] : []
      })
      if (new Set(groups.map((group) => group.column)).size < 2) continue
      const labels = upper.items.filter(
        (item) =>
          provenType(item) &&
          item.x >= columns[0].x &&
          item.right < columns[1].x - header.font * 0.15
      )
      for (const item of [...labels, ...groups.map((group) => group.item)])
        narrativeCells.set(item, {})
    }
    for (const band of bands) {
      if (
        records.includes(band) ||
        band.baseline < fullRecords[0].baseline ||
        band.baseline > fullRecords.at(-1)!.baseline + header.font * 6
      )
        continue
      const label = band.items.filter((item) => columnOf(item) === 0),
        measured = columns
          .slice(1)
          .filter((_, index) =>
            band.items.some((item) => columnOf(item) === index + 1 && numericCell(item.str.trim()))
          )
      if (
        measured.length >= 2 &&
        label.length > 0 &&
        /\p{L}{3}/u.test(lineOf(label).text) &&
        fullRecords.filter((record) =>
          record.items.some(
            (item) =>
              columnOf(item) === 0 &&
              Math.abs(item.x - label[0].x) < header.font * 0.15 &&
              item.fontName === label[0].fontName &&
              Math.abs(item.font - label[0].font) < header.font * 0.05
          )
        ).length >= 3
      )
        records.push(band)
    }
    records.sort((a, b) => a.baseline - b.baseline)
    // The last record ends where its actual wrap baselines stop. Do not
    // assign later footer or body text merely because it shares a column x.
    let finalBaseline = records.at(-1)!.baseline
    for (const band of bands.toSorted((a, b) => a.baseline - b.baseline)) {
      if (band.baseline <= finalBaseline + header.font * 0.1) continue
      if (band.baseline - finalBaseline > header.font * 1.8) break
      if (band.items.some((item) => columnOf(item) >= 0)) finalBaseline = band.baseline
    }
    const headerEnd = Math.max(...header.items.map((item) => item.index))
    const firstRecord = records[0]
    const owned = new Map<string, Item[]>()
    for (const band of bands.toSorted((a, b) => a.baseline - b.baseline)) {
      if (band.baseline < header.baseline - header.font * 0.1) continue
      const row = records.findLastIndex(
        (record) => band.baseline >= record.baseline - header.font * 0.1
      )
      // A continuation above the first complete record owns a separate row.
      // Header wraps are identified by their actual native serialization.
      for (const item of band.items) {
        const col = columnOf(item)
        if (col < 0 || narrativeCells.has(item)) continue
        if (band.baseline > finalBaseline + header.font * 0.1) continue
        const rowKey =
          item.index <= headerEnd && band.baseline < firstRecord.baseline ? 'header' : String(row)
        const key = rowKey + ':' + col
        const items = owned.get(key) ?? []
        items.push(item)
        owned.set(key, items)
      }
    }
    for (const items of owned.values()) {
      const owner = {}
      for (const item of items) narrativeCells.set(item, owner)
    }
  }
  // Sparse schedule tables may put just one checkmark in each record. A
  // complete native header and repeated marks in three independent columns
  // establish that frame; a mark establishes its record's first label line.
  // Give wraps the same cell owner, stopping before the next record or section.
  for (const header of bands) {
    const columns = spacedCells(header).map(lineOf)
    if (
      columns.length < 6 ||
      columns.some(
        (cell) =>
          numericCell(cell.text) ||
          !/\p{L}/u.test(cell.text) ||
          cell.text.split(/\s+/u).length > 5 ||
          cell.right - cell.x > header.font * 12
      )
    )
      continue
    const records = bands
      .flatMap((band) => {
        if (band.baseline <= header.baseline + header.font * 1.5) return []
        const marks = band.items.filter((item) => /^[✓✗]$/u.test(item.str))
        if (
          !marks.length ||
          marks.some(
            (item) =>
              Math.abs(item.font - header.font) >= header.font * 0.1 ||
              !columns.slice(1).some((column) => Math.abs(item.x - column.x) < header.font * 0.3)
          )
        )
          return []
        const firstMark = Math.min(...marks.map((item) => item.x))
        const label = band.items.filter(
          (item) =>
            !marks.includes(item) &&
            item.x >= columns[0].x - header.font * 0.2 &&
            item.x < columns[1].x - header.font * 0.5 &&
            item.right < firstMark - header.font * 0.2 &&
            Math.abs(item.font - header.font) < header.font * 0.1
        )
        if (
          !label.length ||
          !/\p{L}/u.test(lineOf(label).text) ||
          marks.some(
            (mark) =>
              Math.abs(mark.originalBaseline - label[0].originalBaseline) > header.font * 0.2
          ) ||
          spacedCells({ ...band, items: label }).length !== 1 ||
          band.items.some(
            (item) =>
              !label.includes(item) &&
              !marks.includes(item) &&
              item.x >= columns[0].x &&
              item.right <= columns.at(-1)!.right
          )
        )
          return []
        return [{ ...band, marks, label, x: Math.min(...label.map((item) => item.x)) }]
      })
      .sort((a, b) => a.baseline - b.baseline)
    const usedColumns = columns
      .slice(1)
      .filter((column) =>
        records.some((record) =>
          record.marks.some((item) => Math.abs(item.x - column.x) < header.font * 0.3)
        )
      )
    if (
      records.length < 3 ||
      usedColumns.length < 3 ||
      records.some((record) => Math.abs(record.x - records[0].x) > header.font * 0.3)
    )
      continue
    for (const [index, record] of records.entries()) {
      const owner = {},
        next = records[index + 1]
      let lastBaseline = record.baseline
      for (const band of bands.toSorted((a, b) => a.baseline - b.baseline)) {
        if (band.baseline < record.baseline - header.font * 0.1) continue
        if (next && band.baseline >= next.baseline - header.font * 0.1) break
        if (band.baseline - lastBaseline > header.font * 1.8) break
        const label = band.items.filter(
          (item) =>
            !/^[✓✗]$/u.test(item.str) &&
            item.x >= record.x - header.font * 0.3 &&
            item.right < Math.min(...record.marks.map((mark) => mark.x)) - header.font * 0.2
        )
        if (
          !label.length ||
          // In this native record the descriptor (including wraps) is drawn
          // before its state glyphs. Never absorb an unmarked following row.
          label.some(
            (item) =>
              item.index < Math.min(...record.label.map((part) => part.index)) ||
              item.index >= Math.min(...record.marks.map((mark) => mark.index))
          ) ||
          band.items.some((item) => item.x < record.x - header.font * 0.5) ||
          label.some(
            (item) =>
              Math.abs(item.font - header.font) >= header.font * 0.1 ||
              item.fontName !== record.label[0].fontName ||
              narrativeCells.has(item)
          ) ||
          spacedCells({ ...band, items: label }).length !== 1
        )
          break
        for (const item of label) narrativeCells.set(item, owner)
        lastBaseline = band.baseline
      }
    }
  }
  // A narrow gutter can separate a measured table from a complete prose
  // column. Serial, uninterrupted body wraps prove exterior ink without
  // treating a long descriptive cell or scattered header as paragraph evidence.
  const nativeProseLines = [...nativeGroups.values()].map(lineOf)
  const nativeProseTail = (
    parts: Item[],
    boundary: number,
    side: 'left' | 'right' = 'right'
  ): boolean => {
    if (!parts.length) return false
    const row = lineOf(parts)
    const native = nativeGroups.get(parts[0].nativeLine)
    if (
      (side === 'right'
        ? row.x <= boundary + row.font * 0.5
        : row.right >= boundary - row.font * 0.5) ||
      row.right - row.x <= row.font * 16 ||
      wordCount(row.text) < 3 ||
      symbolicExpression(row.text) ||
      !native?.every((item) => parts.includes(item)) ||
      parts.some((item) => item.nativeLine !== parts[0].nativeLine) ||
      !parts[0].fontName ||
      spacedCells(row).some((cell) => numericCell(lineOf(cell).text))
    )
      return false
    if (
      parts.some(
        (item) =>
          !item.fontName ||
          item.unsupported ||
          item.font < row.font * 0.65 ||
          item.font > row.font * 1.05 ||
          Math.abs(item.originalBaseline - row.baseline) > row.font * 0.3
      )
    )
      return false
    return [...new Set(parts.map((item) => item.fontName))].some((fontName) => {
      const peers = nativeProseLines.filter(
        (other) =>
          (side !== 'left' || other.right < boundary - row.font * 0.5) &&
          Math.abs(other.x - row.x) < row.font * 0.5 &&
          Math.abs(other.right - row.right) < row.font &&
          Math.abs(other.baseline - row.baseline) < row.font * 4 &&
          other.right - other.x > row.font * 16 &&
          wordCount(other.text) >= 5 &&
          other.items.every(
            (item) =>
              !item.unsupported &&
              item.fontName === fontName &&
              Math.abs(item.font - row.font) < row.font * 0.05 &&
              Math.abs(item.originalBaseline - other.baseline) < row.font * 0.05
          )
      )
      return (
        peers.length >= 2 &&
        peers.some((previous) =>
          peers.some(
            (next) =>
              next.items[0].nativeLine === previous.items.at(-1)!.nativeLine + 1 &&
              continuousBodyWrap(previous, next, all, row.x, row.right)
          )
        )
      )
    })
  }
  const numericRows = bands.flatMap((band) => {
    let cells = spacedCells(band).map(lineOf)
    let nativeFrameRow: Line | undefined
    const opening = cells[0]
    const nativeOpening = nativeGroups.get(opening.items[0].nativeLine) ?? opening.items
    // A short bold run-in label may be a visual cell in a full native body
    // row. Only this style transition admits whole-row column witnesses;
    // ordinary table headers keep their existing measured-cell evidence.
    const styledNativeOpening =
      nativeOpening.length > 1 &&
      opening.items.length === 1 &&
      /^\p{Lu}[\p{L} ]{2,39}[.:]$/u.test(opening.text) &&
      wordCount(opening.text) >= 2 &&
      wordCount(opening.text) <= 6 &&
      opening.items[0].fontName &&
      nativeOpening.at(-1)?.fontName &&
      opening.items[0].fontName !== nativeOpening.at(-1)!.fontName &&
      wordCount(lineOf(nativeOpening).text) >= 8 &&
      nativeOpening.every(
        (item) =>
          band.items.includes(item) &&
          !item.unsupported &&
          Math.abs(item.originalBaseline - opening.baseline) < band.font * 0.05 &&
          Math.abs(item.font - opening.font) < band.font * 0.05
      ) &&
      !spacedCells(lineOf(nativeOpening)).some((cell) => numericCell(lineOf(cell).text))
    const first = styledNativeOpening ? lineOf(nativeOpening) : opening
    const proseFont = styledNativeOpening ? first.items.at(-1)!.fontName : first.items[0].fontName
    let prosePeers = bands.flatMap((other) =>
      other !== band && Math.abs(other.baseline - band.baseline) < band.font * 4
        ? other.items.filter(
            (item) =>
              Math.abs(item.x - first.x) < band.font * 0.5 &&
              item.right >= first.right - band.font * 0.5 &&
              item.right <= first.right + band.font * 3 &&
              item.right - item.x > band.font * 16 &&
              item.str.split(/\s+/u).length >= 5
          )
        : []
    )
    if (styledNativeOpening)
      prosePeers = [...nativeGroups.values()].flatMap((items) => {
        const row = lineOf(items)
        return items[0].nativeLine !== first.items[0].nativeLine &&
          Math.abs(row.baseline - band.baseline) < band.font * 4 &&
          Math.abs(row.x - first.x) < band.font * 0.5 &&
          row.right >= first.right - band.font * 0.5 &&
          row.right <= first.right + band.font * 3 &&
          row.right - row.x > band.font * 16 &&
          wordCount(row.text) >= 5 &&
          !spacedCells(row).some((cell) => numericCell(lineOf(cell).text)) &&
          items.every(
            (item) =>
              !item.unsupported &&
              item.fontName &&
              Math.abs(item.originalBaseline - row.baseline) < row.font * 0.05 &&
              Math.abs(item.font - row.font) < row.font * 0.05
          )
          ? [{ ...items[0], ...row, str: row.text }]
          : []
      })
    if (
      cells.length >= 3 &&
      first.right - first.x > band.font * 16 &&
      first.text.split(/\s+/u).length >= 5 &&
      prosePeers.length >= 2
    ) {
      const alignedPeers = prosePeers.filter(
        (item) =>
          item.fontName === proseFont &&
          Math.abs(item.font - first.font) < first.font * 0.05 &&
          prosePeers.some(
            (other) =>
              other !== item &&
              item.fontName !== undefined &&
              other.fontName === item.fontName &&
              Math.abs(other.font - item.font) < item.font * 0.05 &&
              Math.abs(other.right - item.right) < band.font * 0.5
          )
      )
      const columnEnd = median(
        (alignedPeers.length >= 2 ? alignedPeers : prosePeers).map((item) => item.right)
      )
      const remaining = cells.filter((cell) => cell.right > columnEnd + band.font * 0.5)
      const prelude = cells
        .filter((cell) => !remaining.includes(cell))
        .flatMap((cell) => cell.items)
      const completeNativePrelude =
        alignedPeers.length >= 2 &&
        prelude.length > 0 &&
        prelude.every(
          (item) =>
            item.nativeLine === first.items[0].nativeLine &&
            (item.fontName === proseFont || (styledNativeOpening && item === first.items[0])) &&
            Math.abs(item.font - first.font) < first.font * 0.05
        ) &&
        nativeGroups.get(first.items[0].nativeLine)?.every((item) => prelude.includes(item)) &&
        remaining
          .flatMap((cell) => cell.items)
          .every((item) => item.nativeLine !== first.items[0].nativeLine)
      // A narrow gutter can still separate body prose from a smaller table.
      // Require both complete native rows and a descriptor with measured columns;
      // a long descriptive table cell must not supply this outside-prose proof.
      const remainingItems = remaining.flatMap((cell) => cell.items)
      const nativeFrame =
        completeNativePrelude &&
        remaining.length >= 3 &&
        !numericCell(remaining[0].text) &&
        (remaining.slice(1).every((cell) => numericCell(cell.text)) ||
          (styledNativeOpening &&
            remaining.filter((cell) => numericCell(cell.text)).length >= 2 &&
            remaining.every((cell) => wordCount(cell.text) <= 4))) &&
        remaining[0].x > columnEnd + band.font * 0.5 &&
        remainingItems[0]?.fontName &&
        remainingItems.every(
          (item) =>
            !item.unsupported &&
            item.nativeLine === remainingItems[0].nativeLine &&
            item.fontName === remainingItems[0].fontName &&
            item.font < first.font * 0.9 &&
            Math.abs(item.font - remainingItems[0].font) < item.font * 0.05
        ) &&
        nativeGroups
          .get(remainingItems[0].nativeLine)
          ?.every((item) => remainingItems.includes(item))
      // A justified paragraph can finish with a separately drawn tail word.
      // Repeated full lines plus its complete native row prove that the shorter
      // sentence/tail is exterior prose, not extra table descriptor columns.
      if (
        (remaining[0]?.x > columnEnd + band.font * 2 || nativeFrame) &&
        (Math.max(...prosePeers.map((item) => item.right)) -
          Math.min(...prosePeers.map((item) => item.right)) <
          band.font * 0.5 ||
          completeNativePrelude)
      )
        cells = remaining
      if (nativeFrame) nativeFrameRow = lineOf(remainingItems)
    }
    // The same baseline may also carry an independent prose column on the
    // right. Require repeated native lines before excluding that column from
    // the table's numeric-row evidence.
    const lastValue = cells.findLastIndex((cell) => numericCell(cell.text))
    if (
      lastValue >= 1 &&
      cells.slice(0, lastValue + 1).filter((cell) => numericCell(cell.text)).length >= 2
    ) {
      const tail = cells[lastValue + 1]
      if (tail && tail.x - cells[lastValue].right > band.font * 2) {
        const proseColumn = [...nativeGroups.values()]
          .map(lineOf)
          .filter(
            (line) =>
              line.x >= tail.x - band.font * 0.5 &&
              line.x <= tail.x + band.font * 0.5 &&
              line.right - line.x > band.font * 16 &&
              line.text.split(/\s+/u).length >= 5 &&
              Math.abs(line.baseline - band.baseline) < band.font * 4
          )
        if (proseColumn.length >= 2) cells = cells.slice(0, lastValue + 1)
      }
    }
    // Two side-by-side tables may share a baseline. A wide gutter after
    // measured values and before a new label separates their independent
    // frames; each side must still prove at least two numeric columns.
    const frames: Line[][] = [[]]
    for (const [index, cell] of cells.entries()) {
      if (
        index > 0 &&
        numericCell(cells[index - 1].text) &&
        !numericCell(cell.text) &&
        cell.x - cells[index - 1].right > band.font * 4 &&
        frames.at(-1)!.filter((part) => numericCell(part.text)).length >= 2 &&
        cells.slice(index).filter((part) => numericCell(part.text)).length >= 2
      )
        frames.push([])
      frames.at(-1)!.push(cell)
    }
    return frames.flatMap((cells) => {
      const numeric = cells.filter((cell) => numericCell(cell.text))
      return numeric.length >= 1 &&
        (numeric.length === cells.length ||
          (numeric.length === cells.length - 1 &&
            /\p{L}/u.test(cells[0].text) &&
            cells[0].text.length <= 80 &&
            cells[0].text.split(/\s+/u).length <= 8) ||
          // Several descriptive columns can precede the measured values. Keep
          // the same repeated two-score alignment proof below, and reject prose.
          (numeric.length >= 2 &&
            (cells.slice(-2).every((cell) => numericCell(cell.text)) ||
              // Dense tables may end with a descriptive operation or note.
              // Require a numeric majority before accepting interior columns.
              (numeric.length >= 3 && numeric.length > cells.length / 2)) &&
            cells.every((cell) => cell.text.length <= 80 && cell.text.split(/\s+/u).length <= 8)))
        ? [{ ...(nativeFrameRow ?? band), cells, numeric }]
        : []
    })
  })
  // Repeated closed response columns establish a categorical table. Keep
  // comments outside the measured response frame in the ordinary prose path.

  const categoricalCandidates = bands.flatMap((band) => {
    const cells = spacedCells(band).map(lineOf)
    const numeric = cells.filter((cell) => categoricalValue(cell.text))
    const last = cells.findLastIndex((cell) => categoricalValue(cell.text))
    return numeric.length >= 4 &&
      cells[0] !== numeric[0] &&
      cells[0].text.length <= 80 &&
      /\p{L}/u.test(cells[0].text) &&
      cells.slice(1, last + 1).every((cell) => numeric.includes(cell))
      ? [{ ...band, cells: cells.slice(0, last + 1), numeric }]
      : []
  })
  const categoricalRows = categoricalCandidates.filter(
    (row) =>
      categoricalCandidates.filter(
        (other) =>
          other !== row &&
          Math.abs(row.baseline - other.baseline) > row.font * 0.75 &&
          Math.abs(row.baseline - other.baseline) < row.font * 20 &&
          Math.abs(row.font - other.font) < row.font * 0.1 &&
          Math.abs(row.cells[0].x - other.cells[0].x) < row.font * 0.5 &&
          other.numeric.length === row.numeric.length &&
          (row.numeric.every(
            (cell, index) => Math.abs(cell.x - other.numeric[index].x) < row.font * 0.3
          ) ||
            row.numeric.every(
              (cell, index) =>
                Math.abs(
                  cell.x + cell.right - other.numeric[index].x - other.numeric[index].right
                ) <
                row.font * 0.6
            ))
      ).length >= 2
  )
  // A neighboring figure or body column can share a visual baseline with a
  // complete native table row. Its own header, repeated value anchors and
  // per-column type sizes prove the local frame independently of that neighbor.
  const nativeRows = [...nativeGroups]
    .filter(([id]) => usableLines.has(id))
    .map(([, items]) => {
      const line = lineOf(items),
        cells = spacedCells({ ...line, items }).map(lineOf)
      return { ...line, cells, numeric: cells.slice(1) }
    })
  const nativeTableCandidates = nativeRows.filter(
    (row) =>
      row.cells.length >= 2 &&
      row.cells.length <= 5 &&
      row.cells[0].text.replace(/[^\p{L}]/gu, '').length >= 3 &&
      row.cells[0].text.length <= 80 &&
      row.cells[0].text.split(/\s+/u).length <= 8 &&
      !numericCell(row.cells[0].text) &&
      row.numeric.every((cell) => numericCell(cell.text) || /^[-−–—]$/u.test(cell.text)) &&
      row.numeric.some((cell) => /\d/u.test(cell.text)) &&
      row.numeric[0].x - row.cells[0].right > row.font * (row.numeric.length === 1 ? 4 : 1) &&
      row.items.every((item) => item.fontName !== undefined)
  )
  const nativeTableHeaders = new Map<Item, Line[]>()
  const measuredTableRows = new Set<Item>()
  const nativeTableRows = nativeTableCandidates.filter((row) => {
    const aligned = nativeTableCandidates.filter(
      (other) =>
        other.cells.length === row.cells.length &&
        Math.abs(other.cells[0].x - row.cells[0].x) < row.font * 0.15 &&
        other.cells.every(
          (cell, index) =>
            cell.items[0].fontName === row.cells[index].items[0].fontName &&
            Math.abs(cell.items[0].font - row.cells[index].items[0].font) < row.font * 0.05 &&
            (index === 0 ||
              Math.abs(cell.x + cell.right - row.cells[index].x - row.cells[index].right) <
                row.font * 0.6 ||
              // A right-aligned dash has a narrower center than a real score.
              // Only the exact native edge of a measured numeric peer proves it.
              ((/^[-−–—]$/u.test(cell.text) || /^[-−–—]$/u.test(row.cells[index].text)) &&
                /\d/u.test(cell.text + row.cells[index].text) &&
                Math.abs(cell.right - row.cells[index].right) < row.font * 0.15))
        )
    )
    const peers = aligned.filter((other) => Math.abs(other.baseline - row.baseline) < row.font * 6)
    if (
      peers.length < 3 ||
      !row.numeric.every((_, index) => peers.some((peer) => /\d/u.test(peer.numeric[index].text)))
    )
      return false
    // A long table can end beside a plot whose ticks share its visual bands.
    // Follow complete, aligned native records back to their existing header;
    // a distant header cannot bridge a break in that independently proven chain.
    let firstBaseline = row.baseline
    for (const other of aligned.toSorted((a, b) => b.baseline - a.baseline)) {
      if (other.baseline > firstBaseline) continue
      if (firstBaseline - other.baseline >= row.font * 6) break
      firstBaseline = other.baseline
    }
    // Page furniture may share a serialized native line with a bold header,
    // and two tables can share its visual band. Use this record's proven frame
    // and score seam; neither neighboring table nor footer supplies evidence.
    const headers = [
      ...nativeRows.map((header) => ({ ...header, measuredHeader: false })),
      ...bands.flatMap((band) => {
        const items = band.items.filter(
          (item) =>
            item.right > row.cells[0].x - row.font * 0.15 &&
            item.x < row.cells.at(-1)!.right + row.font * 0.6
        )
        if (
          !items.length ||
          items.some(
            (item) =>
              item.x < row.cells[0].x - row.font * 0.15 ||
              item.right > row.cells.at(-1)!.right + row.font * 0.6
          )
        )
          return []
        const line = lineOf(items)
        return [
          {
            ...line,
            measuredHeader: true,
            cells: spacedCells(
              line,
              row.numeric.map((cell) => cell.x)
            ).map(lineOf)
          }
        ]
      })
    ]
    const header = headers.find(
      (header) =>
        header.cells.length === row.cells.length &&
        header.baseline < row.baseline - row.font * 0.75 &&
        firstBaseline - header.baseline < row.font * 12 &&
        Math.max(...header.items.map((item) => item.index)) <
          Math.min(...row.items.map((item) => item.index)) &&
        Math.abs(header.cells[0].x - row.cells[0].x) < row.font * 0.15 &&
        (header.measuredHeader
          ? header.items.every(
              (item) => item.fontName && item.fontName === header.cells[0].items[0].fontName
            )
          : header.cells[0].items[0].fontName === row.cells[0].items[0].fontName) &&
        header.cells[0].items[0].font >= row.cells[0].items[0].font * 0.8 &&
        header.cells[0].items[0].font <= row.cells[0].items[0].font * 1.1 &&
        header.cells.every(
          (cell, index) =>
            /\p{L}{3}/u.test(cell.text) &&
            cell.text.split(/\s+/u).length <= 5 &&
            !numericCell(cell.text) &&
            (index === 0 ||
              (row.numeric[index - 1].x + row.numeric[index - 1].right) / 2 >=
                cell.x - row.font * 0.3) &&
            (index === 0 ||
              (row.numeric[index - 1].x + row.numeric[index - 1].right) / 2 <=
                cell.right + row.font * 0.3)
        )
    )
    if (
      header &&
      header.cells.every((cell, index) =>
        cell.items.every(
          (part) =>
            part.fontName ===
              (header.measuredHeader
                ? header.cells[index].items[0].fontName
                : row.cells[index].items[0].fontName) &&
            part.font >= row.cells[index].items[0].font * 0.8 &&
            part.font <= row.cells[index].items[0].font * 1.1
        )
      )
    )
      nativeTableHeaders.set(header.items[0], header.cells)
    if (header?.measuredHeader) measuredTableRows.add(row.items[0])
    return !!header
  })
  // The same full native header used to prove repeated records owns its cells.
  // Reuse that exact proof, rather than extrapolate a row frame over nearby prose.
  for (const cells of nativeTableHeaders.values())
    for (const cell of cells) {
      const owner = {}
      for (const item of cell.items) narrativeCells.set(item, owner)
    }
  // A clinical header can mix italic count variables with ordinary labels,
  // or wrap its count onto the next line. Three independently aligned measured
  // rows establish its columns; do not infer this frame from nearby prose.
  for (const header of bands) {
    if (header.items.some((item) => narrativeCells.has(item))) continue
    const records = numericRows.filter(
      (row) =>
        row.numeric.length >= 3 &&
        row.cells.length === row.numeric.length + 1 &&
        row.baseline > header.baseline + header.font * 0.75 &&
        row.baseline < header.baseline + header.font * 12 &&
        Math.abs(row.font - header.font) < header.font * 0.1
    )
    const row = records.find(
      (candidate) =>
        records.filter(
          (other) =>
            other.cells.length === candidate.cells.length &&
            Math.abs(other.cells[0].x - candidate.cells[0].x) < header.font * 0.3 &&
            other.numeric.every(
              (cell, index) => Math.abs(cell.x - candidate.numeric[index].x) < header.font * 0.3
            )
        ).length >= 3
    )
    if (!row) continue
    const cells = spacedCells(
      header,
      row.numeric.map((cell) => cell.x)
    ).map(lineOf)
    if (
      cells.length !== row.cells.length ||
      Math.abs(cells[0].x - row.cells[0].x) > header.font * 1.1 ||
      Math.max(...header.items.map((item) => item.index)) >=
        Math.min(...row.items.map((item) => item.index)) ||
      cells.some(
        (cell, index) =>
          !/\p{L}{3}/u.test(cell.text) ||
          cell.text.split(/\s+/u).length > 6 ||
          cell.items.some(
            (item) => !item.fontName || Math.abs(item.font - header.font) > header.font * 0.1
          ) ||
          (index > 0 && Math.abs(cell.x - row.cells[index].x) > header.font * 0.3) ||
          (cells[index + 1] && cell.right > cells[index + 1].x - header.font * 0.2) ||
          /[=<>≤≥+*/^β]/u.test(cell.text.replace(/\(\s*n\s*=\s*\d+\)/u, ''))
      )
    )
      continue
    for (const [index, cell] of cells.entries()) {
      const owner = {}
      for (const item of cell.items) narrativeCells.set(item, owner)
      if (index === 0 || cell.text.includes('(')) continue
      // Only a complete, closed group-count suffix can extend a header cell.
      const continuation = bands.find(
        (band) =>
          band.baseline > header.baseline + header.font * 0.8 &&
          band.baseline < header.baseline + header.font * 1.8
      )
      if (!continuation) continue
      const parts = continuation.items.filter(
        (item) =>
          item.x >= cell.x - header.font * 0.1 &&
          item.right < (cells[index + 1]?.x ?? page.width) - header.font * 0.2
      )
      if (
        parts.length &&
        /^[A-Za-z][A-Za-z -]{2,}\s*\(\s*n\s*=\s*\d+\)$/u.test(
          cell.text + ' ' + lineOf(parts).text
        ) &&
        parts.every(
          (item) =>
            !narrativeCells.has(item) &&
            item.fontName &&
            Math.abs(item.font - header.font) < header.font * 0.1
        )
      )
        for (const item of parts) narrativeCells.set(item, owner)
    }
  }
  const tableRows = [
    ...denseRows,
    ...nativeTableRows.map((row) => ({ ...row, nativeFrame: true as const })),
    ...categoricalRows,
    ...numericRows.filter((row) => {
      // Repeated uncertainty signs prove a decimal-aligned timing column even
      // when optional speedup percentages make cell centers differ.
      const uncertainty = row.items.find((item) => item.str === '±')
      const timingColumn =
        row.cells.length === 2 &&
        row.numeric.length === 1 &&
        durationStatistic.test(row.numeric[0].text) &&
        uncertainty &&
        numericRows.filter(
          (other) =>
            other !== row &&
            other.cells.length === 2 &&
            other.numeric.length === 1 &&
            durationStatistic.test(other.numeric[0].text) &&
            Math.abs(other.baseline - row.baseline) > row.font * 0.75 &&
            Math.abs(other.baseline - row.baseline) < row.font * 3.6 &&
            Math.abs(other.font - row.font) < row.font * 0.1 &&
            Math.abs(other.cells[0].x - row.cells[0].x) < row.font * 0.5 &&
            other.items.some(
              (item) => item.str === '±' && Math.abs(item.x - uncertainty.x) < row.font * 0.5
            )
        ).length >= 2
      // Three aligned label/score rows can prove a table even when intermediate
      // columns are blank. Keep the wide label/value gap and final score aligned;
      // isolated pairs, distant lines and drifting values do not establish cells.
      const scoreColumn =
        row.numeric.length === row.cells.length - 1 &&
        row.numeric[0].x - row.cells[0].right >= row.font * 4 &&
        numericRows.filter(
          (other) =>
            other !== row &&
            other.numeric.length === other.cells.length - 1 &&
            other.numeric[0].x - other.cells[0].right >= other.font * 4 &&
            Math.abs(other.baseline - row.baseline) > row.font * 0.75 &&
            Math.abs(other.baseline - row.baseline) < row.font * 3.6 &&
            Math.abs(other.font - row.font) < row.font * 0.1 &&
            Math.abs(other.cells[0].x - row.cells[0].x) < row.font * 0.5 &&
            Math.abs(
              other.numeric.at(-1)!.x +
                other.numeric.at(-1)!.right -
                row.numeric.at(-1)!.x -
                row.numeric.at(-1)!.right
            ) <
              row.font * 1.5
        ).length >= 2
      return (
        timingColumn ||
        scoreColumn ||
        numericRows.some(
          (other) =>
            other !== row &&
            Math.abs(other.baseline - row.baseline) > row.font * 0.75 &&
            Math.abs(other.baseline - row.baseline) < row.font * 3.6 &&
            Math.abs(other.font - row.font) < row.font * 0.1 &&
            // Blank cells and row-spanning labels change positional indices. Require
            // two numeric centers to agree without shifting later columns left.
            row.numeric.filter((cell) =>
              other.numeric.some(
                (peer) =>
                  Math.abs(cell.x + cell.right - peer.x - peer.right) < row.font * 1.5 ||
                  // Tensor widths vary with their dimensions, but their left
                  // anchors still prove the same two independent numeric columns.
                  (/^\d+(?:\s*×\s*\d+)+$/u.test(cell.text) &&
                    /^\d+(?:\s*×\s*\d+)+$/u.test(peer.text) &&
                    Math.abs(cell.x - peer.x) < row.font * 0.3)
              )
            ).length >= 2
        )
      )
    })
  ]
  const tableItems = new Set<Item>()
  const tableRects = new Map<Item, Rect>()
  const lines: Line[] = []
  const completeDualScriptPackets: Set<Item>[] = []
  // A measured table cell can wrap its numeric interval or first-column
  // descriptor. Native adjacency and the repeated columns prove one owner.
  const openInterval =
    /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\s+\([+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s+to)?$/u
  const descriptor = /^[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3}$/u
  const wrapNumeric = (text: string): boolean =>
    numericCell(text) || (/\*{1,3}$/u.test(text) && statisticalCell(text.replace(/\*{1,3}$/u, '')))
  const wrapRows = [
    ...tableRows,
    ...bands.flatMap((band) => {
      const parts = spacedCells(band).map(lineOf),
        cells = parts.slice(0, parts.findLastIndex((cell) => wrapNumeric(cell.text)) + 1),
        numeric = cells.filter((cell) => wrapNumeric(cell.text))
      if (
        cells.length < 4 ||
        numeric.length < 3 ||
        !/\p{L}/u.test(cells[0].text) ||
        cells.slice(1).some((cell) => !wrapNumeric(cell.text) && !openInterval.test(cell.text))
      )
        return []
      return [{ ...band, cells, numeric }]
    })
  ]
  for (const band of bands) {
    if (
      !band.items.some(
        (item) => openInterval.test(item.str.trim()) || descriptor.test(item.str.trim())
      )
    )
      continue
    const frame = wrapRows.find(
      (row) =>
        row.numeric.length >= 2 &&
        // A placeholder cannot establish the left edge of a wrapped label.
        /\d/u.test(row.numeric[0].text) &&
        Math.abs(row.baseline - band.baseline) < row.numeric[0].font * 12 &&
        Math.abs(spacedCells(band)[0][0].x - row.cells[0].x) < row.numeric[0].font * 0.3 &&
        row.numeric.filter((cell) =>
          band.items.some(
            (item) =>
              wrapNumeric(item.str.trim()) &&
              Math.abs(item.font - cell.font) < cell.font * 0.05 &&
              Math.abs(item.x + item.right - cell.x - cell.right) < cell.font * 1.5
          )
        ).length >= 2 &&
        new Set(
          wrapRows
            .filter(
              (peer) =>
                Math.abs(peer.baseline - row.baseline) < row.numeric[0].font * 12 &&
                Math.abs(peer.numeric[0].font - row.numeric[0].font) < row.numeric[0].font * 0.1 &&
                Math.abs(peer.cells[0].x - row.cells[0].x) < row.numeric[0].font * 0.3 &&
                row.numeric.filter((cell) =>
                  peer.numeric.some(
                    (other) =>
                      Math.abs(cell.x + cell.right - other.x - other.right) <
                      row.numeric[0].font * 1.5
                  )
                ).length >= 2
            )
            .map((peer) => peer.baseline)
        ).size >= 3
    )
    if (!frame) continue
    for (const start of band.items) {
      if (
        narrativeCells.has(start) ||
        !start.fontName ||
        (!openInterval.test(start.str.trim()) && !descriptor.test(start.str.trim()))
      )
        continue
      const immediate = all.find((item) => item.index > start.index)
      // A wrapped descriptor can paint its word-end hyphen separately. Keep
      // that exact adjacent glyph with the label, never a numeric placeholder.
      const hyphen =
        descriptor.test(start.str.trim()) &&
        immediate?.str === '-' &&
        immediate.nativeLine === start.nativeLine &&
        immediate.fontName === start.fontName &&
        Math.abs(immediate.font - start.font) < start.font * 0.05 &&
        Math.abs(immediate.originalBaseline - start.originalBaseline) < start.font * 0.05 &&
        immediate.x - start.right >= -start.font * 0.05 &&
        immediate.x - start.right < start.font * 0.15
          ? immediate
          : undefined
      const next = hyphen ? all.find((item) => item.index > hyphen.index) : immediate
      if (
        !next ||
        narrativeCells.has(next) ||
        next.unsupported ||
        next.fontName !== start.fontName ||
        Math.abs(next.font - start.font) >= start.font * 0.05 ||
        Math.abs(next.x - start.x) >= start.font * 0.15 ||
        next.originalBaseline - start.originalBaseline <= start.font * 0.75 ||
        next.originalBaseline - start.originalBaseline >= start.font * 1.6 ||
        !(
          (openInterval.test(start.str.trim()) &&
            statisticalCell(start.str.trim() + ' ' + next.str.trim()) &&
            /^(?:to\s+)?[+−-]?(?:\d+(?:\.\d+)?|\.\d+)\)$/u.test(next.str.trim())) ||
          (descriptor.test(start.str.trim()) &&
            Math.abs(start.x - frame.cells[0].x) < start.font * 0.15 &&
            (hyphen
              ? /^[a-z]+(?:\s+\([A-Za-z]{1,6}\))?$/u.test(next.str.trim())
              : /^[a-z]+(?:\s+[a-z]+){0,2}$/u.test(next.str.trim())) &&
            Math.max(start.right, next.right) < frame.numeric[0].x - start.font &&
            (!hyphen || hyphen.right < frame.numeric[0].x - start.font * 0.3) &&
            !bands.some(
              (other) =>
                Math.abs(other.baseline - next.originalBaseline) < start.font * 0.1 &&
                frame.numeric.filter((cell) =>
                  other.items.some(
                    (item) =>
                      wrapNumeric(item.str.trim()) &&
                      Math.abs(item.font - cell.font) < cell.font * 0.05 &&
                      Math.abs(item.x + item.right - cell.x - cell.right) < cell.font * 1.5
                  )
                ).length >= 2
            ))
        ) ||
        band.items.some(
          (item) => item !== start && item.x > start.x && next.right >= item.x - start.font * 0.15
        ) ||
        bands.some(
          (other) =>
            other !== band &&
            other.baseline > start.originalBaseline + start.font * 0.1 &&
            other.baseline < next.originalBaseline - start.font * 0.1 &&
            other.items.some(
              (item) => item.x < Math.max(start.right, next.right) && item.right > start.x
            )
        )
      )
        continue
      const owner = {}
      narrativeCells.set(start, owner)
      if (hyphen) narrativeCells.set(hyphen, owner)
      narrativeCells.set(next, owner)
    }
  }
  // Multi-line subfigure captions can have gutters narrower than the global
  // column threshold. Prove their local grid from serial native labels and a
  // following spanning figure caption, then keep each complete native owner.
  const panelCaptionBlocks: Block[] = [],
    panelCaptionItems = new Set<Item>()
  for (const parent of nativeProseLines) {
    if (
      !/^(?:Figure|Fig\.)\s+\d+[.:]\s+\p{Lu}/u.test(parent.text) ||
      parent.right - parent.x < page.width * 0.45
    )
      continue
    const candidates = all.filter(
      (item) =>
        /^\([a-l]\)(?:\s|$)/u.test(item.str) &&
        item.index < parent.items[0].index &&
        item.originalBaseline < parent.baseline &&
        parent.baseline - item.originalBaseline < parent.font * 40
    )
    const first = candidates.findLastIndex((item) => /^\(a\)/u.test(item.str))
    const starts = candidates.slice(first)
    if (first < 0 || starts.length < 3 || starts.length > 12) continue
    const font = starts[0].font,
      grid: Item[][] = [[]]
    let valid = true
    for (const [index, start] of starts.entries()) {
      const row = grid.at(-1)!
      if (
        start.str[1].charCodeAt(0) !== 97 + index ||
        !start.fontName ||
        start.fontName !== starts[0].fontName ||
        Math.abs(start.font - font) > font * 0.05
      ) {
        valid = false
        break
      }
      if (row.length && Math.abs(start.originalBaseline - row[0].originalBaseline) > font * 0.2)
        grid.push([])
      grid.at(-1)!.push(start)
    }
    if (
      !valid ||
      grid.some(
        (row, n) =>
          row.length < 3 ||
          row.length > 6 ||
          row.at(-1)!.x - row[0].x < page.width * 0.4 ||
          row.some((start, col) =>
            col
              ? start.x <= row[col - 1].x + font * 6
              : n > 0 &&
                (start.originalBaseline - grid[n - 1][0].originalBaseline < font * 4 ||
                  start.originalBaseline - grid[n - 1][0].originalBaseline > font * 25)
          ) ||
          (n > 0 &&
            (row.length !== grid[0].length ||
              row.some((start, col) => Math.abs(start.x - grid[0][col].x) > font * 0.15)))
      )
    )
      continue
    const proven: Block[] = []
    for (const [index, start] of starts.entries()) {
      const end = starts[index + 1]?.index ?? parent.items[0].index,
        members = all.filter((item) => item.index >= start.index && item.index < end),
        owned = new Set<Item>(members),
        rows = bands
          .map((band) => band.items.filter((item) => owned.has(item)))
          .filter((items) => items.length)
          .map(lineOf)
          .sort((a, b) => a.baseline - b.baseline),
        column = grid.find((row) => row.includes(start))!,
        nextColumn = column[column.indexOf(start) + 1],
        right = nextColumn ? nextColumn.x - font * 0.3 : page.width * 0.9
      if (
        rows.length < 2 ||
        rows.length > 8 ||
        rows.flatMap((row) => row.items).length !== members.length ||
        wordCount(rows[0].text) < 3 ||
        rows.some(
          (row, n) =>
            row.x < start.x - font * 0.05 ||
            row.right > right ||
            Math.abs(row.x - start.x) > font * 0.15 ||
            Math.abs(row.font - font) > font * 0.05 ||
            (n > 0 &&
              (row.baseline - rows[n - 1].baseline < font * 0.75 ||
                row.baseline - rows[n - 1].baseline > font * 1.6)) ||
            row.items.some(
              (item) =>
                item.unsupported ||
                !item.fontName ||
                tableItems.has(item) ||
                embeddedMetadata.has(item) ||
                item.transform.length !== 6 ||
                !item.transform.every(Number.isFinite) ||
                Math.abs(item.transform[2]) > 0.001 ||
                item.width <= 0 ||
                item.font < font * 0.55 ||
                item.font > font * 1.05 ||
                Math.abs(item.baseline - row.baseline) > font * 0.95
            )
        ) ||
        !terminal(rows.at(-1)!.text) ||
        parent.baseline - rows.at(-1)!.baseline < font * 0.5
      ) {
        valid = false
        break
      }
      proven.push({
        ...bounds(members),
        font,
        lines: rows,
        items: members,
        source: '',
        risks: [],
        readingBaseline: column[0].baseline
      })
    }
    if (!valid || parent.baseline - proven.at(-1)!.lines.at(-1)!.baseline > font * 6) continue
    panelCaptionBlocks.push(...proven)
    for (const block of proven) for (const item of block.items) panelCaptionItems.add(item)
  }
  for (const band of bands.flatMap((band) => {
    const sections: Item[][] = [[]]
    for (const cell of spacedCells(band)) {
      const previous = sections.at(-1)!.at(-1)
      if (
        previous &&
        (nativeTableRows.some(
          (row) =>
            measuredTableRows.has(row.items[0]) &&
            row.numeric.at(-1)!.items.includes(previous) &&
            row.items.every((item) => band.items.includes(item)) &&
            cell.every((item) => item.x > row.cells.at(-1)!.right + row.font * 0.15)
        ) ||
          (cell[0].x - previous.right > band.font * 2 &&
            denseRows.some(
              (row) =>
                Math.abs(row.baseline - band.baseline) < row.font * 4 &&
                previous.x >= row.cells[0].x - row.font * 2 &&
                previous.right <= row.numeric.at(-1)!.right + row.font * 2 &&
                cell[0].x > row.numeric.at(-1)!.right + row.font * 2
            )) ||
          (cell[0].x - previous.right > band.font * 4 &&
            tableRows.some(
              (row) =>
                row.numeric.length >= 2 &&
                Math.abs(row.baseline - band.baseline) < band.font * 6 &&
                Math.abs(row.font - band.font) < band.font * 0.1 &&
                row.cells[0].x > previous.right + band.font * 2 &&
                // A staggered header's second line can omit the descriptive
                // first column. Its measured columns still belong to this proven
                // frame; otherwise the neighboring header is treated as prose.
                cell[0].x >= row.cells[0].x - band.font * 2 &&
                cell[0].x <= row.cells.at(-1)!.right + band.font * 2
            )))
      )
        sections.push([])
      sections.at(-1)!.push(...cell)
    }
    return sections.map((items) => ({
      ...band,
      items,
      font: Math.max(...items.map((i) => i.font))
    }))
  })) {
    const owned = Map.groupBy(
      band.items.filter((item) => narrativeCells.has(item)),
      (item) => narrativeCells.get(item)!
    )
    for (const items of owned.values()) {
      lines.push(lineOf(items))
      for (const item of items) tableItems.add(item)
    }
    band.items = band.items.filter(
      (item) => !narrativeCells.has(item) && !panelCaptionItems.has(item)
    )
    if (!band.items.length) continue
    // A row of lettered figure-panel titles has serial native labels and wide
    // gaps. Keep each panel's scripts with its title, not all panels as prose.
    const panels = band.items
      .filter((item) => /^\([a-z]\)\s+[A-Z][A-Za-z]{2,}/u.test(item.str))
      .toSorted((a, b) => a.x - b.x)
    if (
      panels.length >= 3 &&
      panels.length <= 6 &&
      panels.at(-1)!.right - panels[0].x > page.width * 0.45 &&
      panels.every(
        (item, index) =>
          item.str[1].charCodeAt(0) === panels[0].str[1].charCodeAt(0) + index &&
          item.fontName === panels[0].fontName &&
          Math.abs(item.font - panels[0].font) < band.font * 0.05 &&
          Math.abs(item.originalBaseline - panels[0].originalBaseline) < band.font * 0.1 &&
          item.str.split(/\s+/u).length <= 8 &&
          (index === 0 || item.x - panels[index - 1].right > band.font)
      )
    ) {
      const groups = Map.groupBy(band.items, (item) =>
        panels.findLastIndex((panel) => item.x >= panel.x)
      )
      if (!groups.has(-1)) {
        lines.push(...[...groups.values()].map(lineOf))
        continue
      }
    }
    let cells = spacedCells(band)
    const tableRow = tableRows
      .toSorted(
        // A sparse two-column subframe must not override an already proven
        // wider table containing those scores.
        (a, b) =>
          Number(
            !(
              ('nativeFrame' in a ||
                (a.numeric.length >= 3 && a.numeric.length === a.cells.length - 1)) &&
              !numericCell(a.cells[0].text) &&
              a.cells[0].right - a.cells[0].x <= a.font * 16 &&
              Math.abs(a.baseline - band.baseline) < a.font * 0.1 &&
              band.items.every((item) => a.cells.some((cell) => cell.items.includes(item)))
            )
          ) -
            Number(
              !(
                ('nativeFrame' in b ||
                  (b.numeric.length >= 3 && b.numeric.length === b.cells.length - 1)) &&
                !numericCell(b.cells[0].text) &&
                b.cells[0].right - b.cells[0].x <= b.font * 16 &&
                Math.abs(b.baseline - band.baseline) < b.font * 0.1 &&
                band.items.every((item) => b.cells.some((cell) => cell.items.includes(item)))
              )
            ) ||
          Number('twoColumn' in a && a.twoColumn) - Number('twoColumn' in b && b.twoColumn) ||
          a.cells.at(-1)!.right - a.cells[0].x - (b.cells.at(-1)!.right - b.cells[0].x)
      )
      .find(
        (row) =>
          // This frame is proven by a complete serialized native row, not by
          // surrounding page overlap. Never extend it to a neighboring body line.
          (!('nativeFrame' in row) || row.items.every((item) => band.items.includes(item))) &&
          (band.baseline <= row.baseline + row.font * 0.1 ||
            // A table's last descriptive row may have just one numeric cell.
            // Its other cells must share two already proven column anchors.
            (band.baseline <= row.baseline + row.font * 3.6 &&
              row.cells[0].right - row.cells[0].x < row.font * 12 &&
              (('dense' in row &&
                'twoColumn' in row &&
                row.twoColumn &&
                row.numeric.filter((value) =>
                  band.items.some(
                    (item) =>
                      denseValue(item) &&
                      Math.abs(item.font - row.font) < row.font * 0.1 &&
                      Math.abs(item.x + item.right - value.x - value.right) < row.font * 0.6
                  )
                ).length >= 2) ||
                (cells.length >= 3 &&
                  cells.some((cell) => preservedTableValue(lineOf(cell).text)) &&
                  row.numeric.filter((value) =>
                    cells.some((cell) => {
                      const rect = bounds(cell)
                      return (
                        Math.abs(rect.x - value.x) < row.font * 0.3 ||
                        (numericCell(lineOf(cell).text) &&
                          Math.abs(rect.x + rect.right - value.x - value.right) < row.font * 1.5)
                      )
                    })
                  ).length >= 2)))) &&
          band.baseline >= row.baseline - row.font * 4 &&
          (Math.abs(band.font - row.font) < row.font * 0.1 ||
            // The complete independently proven native row may sit beside
            // larger prose or diagram labels on the same visual baseline.
            ('nativeFrame' in row && row.items.every((item) => band.items.includes(item))) ||
            // Independent native value columns establish the local table font
            // even when larger prose shares this baseline in another column.
            ('dense' in row &&
              row.numeric.filter((value) =>
                band.items.some(
                  (item) =>
                    (denseValue(item) ||
                      (item.str.split(/\s+/u).length <= 4 && item.width < row.font * 12)) &&
                    Math.abs(item.font - row.font) < row.font * 0.1 &&
                    Math.abs(item.x + item.right - value.x - value.right) < row.font * 0.6
                )
              ).length >= ('twoColumn' in row && row.twoColumn ? 2 : 3)) ||
            // Labels can use a smaller type size than their measured values.
            // Require that exact size to occur in the established table row.
            (band.font < row.font &&
              row.items.some((item) => Math.abs(item.font - band.font) < band.font * 0.1))) &&
          band.items.some(
            (item) =>
              item.right >= row.cells[0].x - row.font * 2 &&
              item.x <= row.cells.at(-1)!.right + row.font * 2
          ) &&
          band.items
            .filter(
              (item) =>
                item.right >= row.cells[0].x - row.font * 2 &&
                !cells.some(
                  (cell) =>
                    cell.includes(item) &&
                    cell[0].x < row.cells[0].x - row.font * 4 &&
                    bounds(cell).right - bounds(cell).x > row.font * 12 &&
                    bounds(cell).right < row.cells[0].x
                ) &&
                item.x <= row.cells.at(-1)!.right + row.font * 2
            )
            .every(
              (item) =>
                (item.x >= row.cells[0].x - row.font * 2 ||
                  // A longer first-column label can extend left of shorter
                  // peers; two aligned values still prove its independent row.
                  (item.x >= row.cells[0].x - row.font * 4 &&
                    item.right < row.numeric[0].x - row.font * 0.5 &&
                    row.numeric.filter((value) =>
                      band.items.some(
                        (part) =>
                          (numericCell(part.str) ||
                            // Header words can be centered over numeric columns.
                            // Their font must occur in this same proven table.
                            (band.font <= row.font &&
                              row.items.some(
                                (label) => Math.abs(label.font - part.font) < part.font * 0.1
                              ) &&
                              part.str.split(/\s+/u).length <= 4 &&
                              part.right - part.x < row.font * 12)) &&
                          Math.abs(part.x + part.right - value.x - value.right) < row.font * 1.5
                      )
                    ).length >= 2)) &&
                (item.right <= row.cells.at(-1)!.right + row.font * 2 ||
                  (item.right - item.x < row.font * 12 &&
                    row.numeric.some(
                      (cell) => Math.abs(item.x + item.right - cell.x - cell.right) < row.font * 2
                    )))
            )
      )
    // Long labels can nearly touch the next cell. Once neighboring rows prove
    // the numeric column positions, use those positions to separate its native
    // items too; a narrow visual gap must not merge an entire table into prose.
    if (tableRow)
      cells = spacedCells(
        band,
        'dense' in tableRow
          ? band.items
              .filter(
                (item) =>
                  (denseValue(item) ||
                    (item.str.split(/\s+/u).length <= 4 && item.width < tableRow.font * 12)) &&
                  tableRow.numeric.some(
                    (value) =>
                      Math.abs(item.x + item.right - value.x - value.right) < tableRow.font * 0.6
                  )
              )
              .map((item) => item.x)
          : tableRow.numeric.map((cell) => cell.x)
      )
    const statisticHeading =
      cells.length === 1 &&
      /\b(?:mean|median)\s*\((?:SD|SE|IQR)\)/iu.test(lineOf(band.items).text) &&
      tableRow &&
      bounds(band.items).right < tableRow.cells[1].x - band.font
    if (tableRow && (cells.length >= 2 || statisticHeading)) {
      // A separately serialized body row can nearly touch a table header.
      // Separate that native owner before assigning visual cells to the table.
      const numericEnd = tableRow.numeric.at(-1)!.right
      cells = cells.flatMap((cell) => {
        const native = [...Map.groupBy(cell, (item) => item.nativeLine).values()]
        if (native.length < 2) return [cell]
        const exterior = native.filter((parts) => {
          if (nativeProseTail(parts, numericEnd)) return true
          const font = Math.max(...parts.map((item) => item.font)),
            right = Math.max(...parts.map((item) => item.right))
          // A larger body column can nearly touch a small-cap table stub.
          // Require its complete serial body wraps and a separate native owner
          // for every remaining item; whitespace alone never splits a cell.
          return (
            font > tableRow.font * 1.1 &&
            nativeProseTail(parts, tableRow.cells[0].x, 'left') &&
            native
              .filter((other) => other !== parts)
              .every((other) => other.every((item) => item.x > right + font * 0.5))
          )
        })
        if (!exterior.length) return [cell]
        const inside = cell.filter((item) => !exterior.some((parts) => parts.includes(item)))
        return [inside, ...exterior]
          .filter((parts) => parts.length)
          .toSorted((a, b) => a[0].x - b[0].x)
      })
      // A table owns only its established frame. Rejoin native prose items
      // outside it before emitting their line, including justified tail words.
      const outsideFrame = (cell: Item[]): boolean =>
        cell.every((item) => item.right < tableRow.cells[0].x - tableRow.font * 2) ||
        // A neighboring prose column can finish inside the frame's padding.
        // Its distant left edge and wholly exterior ink still keep it outside.
        (cell[0].x < tableRow.cells[0].x - tableRow.font * 4 &&
          bounds(cell).right - bounds(cell).x > tableRow.font * 12 &&
          cell.every((item) => item.right < tableRow.cells[0].x)) ||
        cell.every((item) => item.x > tableRow.cells.at(-1)!.right + tableRow.font * 2) ||
        nativeProseTail(cell, numericEnd)
      const outsideLines = new Map<number, Item[]>()
      for (const cell of cells.filter(outsideFrame))
        for (const item of cell) {
          const line = outsideLines.get(item.nativeLine) ?? []
          line.push(item)
          outsideLines.set(item.nativeLine, line)
        }
      lines.push(...[...outsideLines.values()].map(lineOf))
      for (const [index, cell] of cells.entries()) {
        if (outsideFrame(cell)) continue
        const rect = bounds(cell),
          previous = cells[index - 1],
          next = cells[index + 1] ?? (statisticHeading ? tableRow.cells[1].items : undefined),
          text = lineOf(cell).text,
          label = index === 0 && /\p{L}/u.test(text) && !preservedTableValue(text),
          compactParameter =
            label &&
            (/^\d{1,3}h(?:[0-5]?\d)?$|^\d+(?:\.\d+)?(?:ms|s|min)$/u.test(text) ||
              /^(?:\d{1,2}\s*[×x]\s*)?[A-Z][A-Za-z]{1,7}(?:\s+[a-z]{1,3})?\s*\/\s*s[1-9]\d?$/u.test(
                text
              ))
        // A descriptive first column can expand beyond an abbreviated label.
        // Keep its native left edge and use right-side whitespace before the next value.
        // Only complete durations and operation/stride parameters retain their
        // bounded one-em capacity. Descriptive timepoint labels keep the left rule.
        // Numeric cells and row heights keep their original budget;
        // the writer also checks native text, graphics and table rules.
        tableRects.set(cell[0], {
          ...rect,
          x:
            label && !compactParameter
              ? rect.x
              : Math.max(rect.x - band.font, previous ? (bounds(previous).right + rect.x) / 2 : 0),
          right:
            label && next
              ? Math.max(rect.right, bounds(next).x - band.font)
              : Math.min(
                  rect.right + band.font,
                  next ? (bounds(next).x + rect.right) / 2 : page.width
                )
        })
        lines.push(lineOf(cell))
        for (const item of cell) tableItems.add(item)
      }
      continue
    }
    // PDF native rows may serialize the upper and lower indices separately.
    // Their x order interleaves, but they must not become adjacent captions.
    // Prove the complete interval through its returning relation, not merely
    // that the two words were attached to some mathematical base in this band.
    const commonScriptBase = (left: Item, right: Item): boolean => {
      if (!attachedScripts.has(left) || !attachedScripts.has(right)) return false
      const provedPackets = new Map<Item, Set<Item>>()
      const owners = band.items.filter((base) => {
        if (
          !/^[A-Za-z\p{Script=Greek}]$/u.test(base.str) ||
          Math.abs(base.font - band.font) >= band.font * 0.05 ||
          base.index >= Math.min(left.index, right.index)
        )
          return false
        const relation = all.find(
          (part) => part.index > base.index && part.font >= base.font * 0.85
        )
        if (
          !relation ||
          !band.items.includes(relation) ||
          !/^[=<>≤≥]$/u.test(relation.str) ||
          Math.abs(relation.font - base.font) >= base.font * 0.05 ||
          Math.abs(relation.originalBaseline - base.originalBaseline) >= base.font * 0.05
        )
          return false
        const scripts: Item[] = all.filter(
          (part) => part.index > base.index && part.index < relation.index
        )
        if (!scripts.includes(left) || !scripts.includes(right)) return false
        const upper = scripts.filter((part) => part.originalBaseline < base.originalBaseline),
          lower = scripts.filter((part) => part.originalBaseline > base.originalBaseline)
        if (
          !upper.length ||
          !lower.length ||
          upper.length + lower.length !== scripts.length ||
          upper.includes(left) === upper.includes(right) ||
          (Math.max(...upper.map((part) => part.index)) >=
            Math.min(...lower.map((part) => part.index)) &&
            Math.max(...lower.map((part) => part.index)) >=
              Math.min(...upper.map((part) => part.index)))
        )
          return false
        if (
          ![upper, lower].every((lane) =>
            lane.every((part, index) => {
              const previous = lane[index - 1]
              const gap = part.x - (previous?.right ?? base.right)
              const rise = Math.abs(part.originalBaseline - base.originalBaseline)
              return (
                band.items.includes(part) &&
                /^[\p{L}\p{N},+−()-]{1,20}$/u.test(part.str) &&
                part.font > base.font * 0.5 &&
                part.font < base.font * 0.85 &&
                Math.abs(part.font - left.font) < base.font * 0.05 &&
                rise > base.font * 0.08 &&
                rise < base.font * 0.55 &&
                Math.abs(part.originalBaseline - lane[0].originalBaseline) < base.font * 0.05 &&
                gap >= -base.font * 0.1 &&
                gap < base.font * (previous ? 0.3 : 0.5)
              )
            })
          )
        )
          return false
        const packet = [base, ...scripts, relation],
          rect = bounds(packet)
        const proved =
          relation.x - Math.max(...scripts.map((part) => part.right)) >= -base.font * 0.1 &&
          relation.x - Math.max(...scripts.map((part) => part.right)) < base.font * 0.9 &&
          packet.every(
            (part) =>
              !!part.fontName &&
              !part.unsupported &&
              part.width > 0 &&
              part.height > 0 &&
              part.transform.length === 6 &&
              part.transform.every(Number.isFinite) &&
              Math.abs(part.transform[0] - part.font) < base.font * 0.05 &&
              Math.abs(part.transform[3] - part.font) < base.font * 0.05 &&
              Math.abs(part.transform[1]) < 0.001 &&
              Math.abs(part.transform[2]) < 0.001 &&
              part.nativeLine >= base.nativeLine &&
              part.nativeLine <= base.nativeLine + 1 &&
              !tableRows.some((row) => row.items.includes(part))
          ) &&
          !all.some(
            (part) =>
              !packet.includes(part) &&
              Math.min(part.right, rect.right) - Math.max(part.x, rect.x) > 0.000001 &&
              Math.min(part.bottom, rect.bottom) - Math.max(part.y, rect.y) > 0.000001 &&
              // Font ascent/descent boxes can overlap the adjacent body row.
              // Only a separate full-size native row outside this whole packet
              // may contribute that padding; script-sized competing ink cannot.
              !(
                Math.abs(part.font - base.font) < base.font * 0.05 &&
                ((part.index > relation.index &&
                  part.originalBaseline - base.originalBaseline > base.font) ||
                  (part.index < base.index &&
                    base.originalBaseline - part.originalBaseline > base.font))
              )
          )
        if (proved) provedPackets.set(base, new Set(packet))
        return proved
      })
      if (owners.length !== 1) return false
      completeDualScriptPackets.push(provedPackets.get(owners[0])!)
      return true
    }
    let pending: Item[] = []
    for (const item of band.items.sort((a, b) => a.x - b.x)) {
      const prev = pending.at(-1)
      // A sentence-ending raised reference can share a native row with a
      // lowered model label later on. Their combined vertical span may exceed
      // the whole-row threshold; use the returning body baseline at this seam.
      const referenceBase = pending.findLast((part) => part.font >= band.font * 0.9)
      const referenceContinuation =
        prev &&
        referenceBase &&
        prev !== referenceBase &&
        /^\d{1,3}$/u.test(prev.str) &&
        /[A-Za-z]{3,}[)\]]?[.!?]$/u.test(referenceBase.str) &&
        referenceBase.fontName &&
        referenceBase.fontName === item.fontName &&
        prev.fontName === referenceBase.fontName &&
        referenceBase.nativeLine === prev.nativeLine &&
        /^\p{Lu}\p{L}{2,}\b/u.test(item.str) &&
        Math.abs(referenceBase.font - item.font) < band.font * 0.05 &&
        Math.abs(referenceBase.originalBaseline - item.originalBaseline) < band.font * 0.05 &&
        prev.font >= band.font * 0.5 &&
        prev.font < band.font * 0.85 &&
        referenceBase.originalBaseline - prev.originalBaseline > band.font * 0.1 &&
        referenceBase.originalBaseline - prev.originalBaseline < band.font * 0.5 &&
        prev.x - referenceBase.right >= -band.font * 0.05 &&
        prev.x - referenceBase.right < band.font * 0.2 &&
        item.x - prev.right >= 0 &&
        item.x - prev.right < band.font * 0.9 &&
        referenceBase.index < prev.index &&
        !all.some(
          (part) => part.index > referenceBase.index && part.index < item.index && part !== prev
        )
      const nativeContinuation =
        prev?.hasEOL === false &&
        prev.index < item.index &&
        prev.nativeLine === item.nativeLine &&
        // A neighboring prose column may share this band and prevent whole-band
        // table classification. Still respect an already proven label/value seam.
        !tableRows.some(
          (row) =>
            row.cells.length === 2 &&
            row.numeric.length === 1 &&
            durationStatistic.test(row.numeric[0].text) &&
            Math.abs(row.baseline - item.baseline) < row.font * 3.6 &&
            Math.abs(item.font - row.font) < row.font * 0.1 &&
            Math.abs(pending[0].x - row.cells[0].x) < row.font * 0.5 &&
            prev.right < row.numeric[0].x &&
            Math.abs(item.x - row.numeric[0].x) < row.font * 0.6
        ) &&
        (usableLines.has(item.nativeLine) ||
          referenceContinuation ||
          (isPdfTranslationCaption(lineOf(pending).text) &&
            Math.abs(prev.originalBaseline - item.originalBaseline) < band.font * 0.05)) &&
        item.x - prev.right < band.font * 4
      const scriptRelation =
        prev &&
        attachedScripts.has(prev) &&
        /^[=<>≤≥]$/u.test(item.str.trim()) &&
        Math.abs(item.font - band.font) < band.font * 0.1 &&
        item.x - Math.max(...pending.map((part) => part.right)) < band.font * 0.9
      if (
        prev &&
        !nativeContinuation &&
        !scriptRelation &&
        (item.x - Math.max(...pending.map((part) => part.right)) >
          Math.max(4, Math.min(prev.font, item.font) * 0.9) ||
          // Neighboring captions can have a narrow gutter and slightly staggered
          // baselines. Native row identity separates their full-size prose.
          (prev.nativeLine !== item.nativeLine &&
            /[A-Za-z]{3,}/u.test(prev.str) &&
            /[A-Za-z]{3,}/u.test(item.str) &&
            Math.abs(prev.font - item.font) < band.font * 0.1 &&
            Math.abs(prev.originalBaseline - item.originalBaseline) > band.font * 0.15 &&
            !commonScriptBase(prev, item)))
      ) {
        const mark = pending.at(-1)!
        const carryMark =
          pending.length > 1 &&
          mark.hasEOL !== true &&
          mark.nativeLine === item.nativeLine &&
          /^[,.;:]+$/u.test(mark.str) &&
          mark.fontName === item.fontName &&
          Math.abs(mark.originalBaseline - item.originalBaseline) < band.font * 0.05 &&
          item.x - mark.right < band.font * 2
        lines.push(lineOf(carryMark ? pending.slice(0, -1) : pending))
        pending = carryMark ? [mark] : []
      }
      pending.push(item)
    }
    if (pending.length) lines.push(lineOf(pending))
  }
  const preservedFormulaLines = new Set<Line>()
  for (const fraction of preservedFractions) {
    const line = lineOf(all.filter((item) => fraction.indices.includes(item.index)))
    const preserved = { ...line, text: fraction.label, baseline: fraction.baseline }
    lines.push(preserved)
    preservedFormulaLines.add(preserved)
  }
  // Listings may use proportional fonts and expose spaced keywords. Require a
  // Python definition, an indented body and a return, then preserve every glyph
  // in that block, including strings/comments; stop before dedented body prose.
  const codeItems = new Set<Item>()
  const orderedLines = [...lines].sort((a, b) => a.baseline - b.baseline || a.x - b.x)
  const listingPackets: Set<Item>[] = []
  const assignment = /^(?:[A-Za-z_][\w., [\]():]*|\[[\w, ]+\])\s*=(?!=)/u
  const call = /[A-Za-z_]\w*(?:\s*\.\s*\w+)*\s*\(/u
  const syntax = (text: string): boolean =>
    assignment.test(text) ||
    /^[A-Za-z_]\w*(?:\s*\.\s*\w+)*\s*\([^]*(?:[),;:]|\()\s*$/u.test(text) ||
    /^(?:import|from|def|function|return|raise|if|for|while|else|end)\b/u.test(text) ||
    /^(?:[#%]|"""[^]*"""$|[({]?\s*["'’][^]*[,:;)]\s*$|[()[\]{} ,:;]+$|\)\s*(?:->|[-+*/@]))/u.test(
      text
    ) ||
    /^[A-Za-z_]\w*\s*(?::|[-+*@/])/u.test(text)
  const completePacket = (items: Item[]): boolean => {
    const first = Math.min(...items.map((item) => item.index)),
      last = Math.max(...items.map((item) => item.index)),
      owned = new Set(items)
    return (
      owned.size === items.length &&
      items.every(
        (item) =>
          !item.unsupported &&
          !!item.fontName &&
          !tableItems.has(item) &&
          [item.x, item.y, item.right, item.bottom, item.font, item.originalBaseline].every(
            Number.isFinite
          ) &&
          item.width > 0 &&
          item.height > 0
      ) &&
      all.every((item) => item.index < first || item.index > last || owned.has(item))
    )
  }
  const preserveListing = (items: Item[], caption: Line[] = []): void => {
    for (const item of items) codeItems.add(item)
    const packet = new Set([...caption.flatMap((line) => line.items), ...items])
    if (!listingPackets.some((previous) => [...packet].some((item) => previous.has(item))))
      listingPackets.push(packet)
  }
  for (const indices of numberedPackets) {
    const items = all.filter((item) => indices.includes(item.index))
    if (items.length === indices.length && completePacket(items)) preserveListing(items)
  }
  // Number gutters are independent native glyphs, not a prefix to remove from
  // source text. Require consecutive ordinals, one body font, complete native
  // rows and repeated executable syntax; ordinary numbered prose is excluded.
  const gutterRows = all
    .filter((item) => /^\d{1,3}$/u.test(item.str))
    .flatMap((gutter) => {
      const parts = all
        .filter(
          (item) =>
            item !== gutter &&
            item.x > gutter.right &&
            Math.abs(item.originalBaseline - gutter.originalBaseline) < gutter.font * 0.05
        )
        .sort((a, b) => a.x - b.x)
      if (
        parts.length &&
        (gutter.font >= parts[0].font * 0.7 ||
          parts.some(
            (part) =>
              !part.fontName ||
              part.fontName !== parts[0].fontName ||
              Math.abs(part.font - parts[0].font) > parts[0].font * 0.05
          ))
      )
        return []
      const marker = parts.findIndex((item) => item.str === '#')
      if (
        parts.some(
          (part, n) =>
            n > 0 &&
            (part.index <= parts[n - 1].index ||
              (part.x - parts[n - 1].right > part.font &&
                !(marker >= 0 && n >= marker) &&
                !(
                  /[,:([{]\s*$/u.test(parts[n - 1].str) &&
                  /^(?:[()[\]{}"']|True\b|False\b|[+−-]?\d|[A-Za-z_]\w*\s*=)/u.test(part.str)
                )))
        )
      )
        return []
      const comment = parts.findIndex((item) => item.str === '#'),
        code = comment > 0 ? parts.slice(0, comment) : parts
      return [{ gutter, parts, text: code.length ? lineOf([...code]).text : '' }]
    })
    .sort((a, b) => a.gutter.originalBaseline - b.gutter.originalBaseline)
  for (let index = 0; index < gutterRows.length;) {
    const rows = [gutterRows[index++]]
    while (index < gutterRows.length) {
      const previous = rows.at(-1)!,
        next = gutterRows[index],
        font = rows.find((row) => row.parts.length)?.parts[0].font ?? previous.gutter.font * 2
      if (
        Number(next.gutter.str) !== Number(previous.gutter.str) + 1 ||
        Math.abs(next.gutter.right - previous.gutter.right) > font * 0.15 ||
        Math.abs(next.gutter.font - previous.gutter.font) > font * 0.05 ||
        next.gutter.originalBaseline - previous.gutter.originalBaseline > font * 2.5
      )
        break
      rows.push(next)
      index++
    }
    const body = rows.filter((row) => row.parts.length),
      items = rows.flatMap((row) => [row.gutter, ...row.parts])
    // A numbered code row can wrap only its trailing native comment. Every
    // intervening item must share its native wrap indent and body font before the
    // next consecutive ordinal; prose outside this closed interval is excluded.
    for (let n = 1; n < rows.length; n++) {
      const previous = rows[n - 1],
        next = rows[n],
        marker = previous.parts.find((item) => item.str === '#'),
        end = Math.max(...previous.parts.map((item) => item.index), previous.gutter.index),
        tail = all.filter((item) => item.index > end && item.index < next.gutter.index)
      if (
        marker &&
        tail.length &&
        tail[0].x >= previous.parts[0].x + marker.font * 0.3 &&
        tail[0].x <= previous.parts[0].x + marker.font * 4 &&
        tail.every(
          (item) =>
            item.fontName === marker.fontName &&
            Math.abs(item.font - marker.font) < marker.font * 0.05 &&
            item.x >= tail[0].x &&
            Math.abs(item.originalBaseline - tail[0].originalBaseline) < marker.font * 0.05 &&
            item.originalBaseline > previous.gutter.originalBaseline &&
            item.originalBaseline < next.gutter.originalBaseline
        )
      )
        items.push(...tail)
    }
    if (
      body.length < 2 ||
      !completePacket(items) ||
      Math.min(...body.map((row) => row.parts[0].x - row.gutter.right)) >
        body[0].parts[0].font * 3 ||
      body.some(
        (row) => !syntax(row.text) || row.parts[0].fontName !== body[0].parts[0].fontName
      ) ||
      body.filter((row) => assignment.test(row.text)).length < 2 ||
      !(
        body.some((row) => call.test(row.text) || /^(?:import|from)\b/u.test(row.text)) ||
        body.filter((row) => /^["']\s*\w[^]*["']\s*:/u.test(row.text)).length >= 2
      )
    )
      continue
    const first = Math.min(...items.map((item) => item.originalBaseline)),
      captionIndex = orderedLines.findLastIndex(
        (line) =>
          /^Listing\s+\d+\s*:/u.test(line.text) &&
          line.baseline < first &&
          first - line.baseline < body[0].parts[0].font * 8
      ),
      caption =
        captionIndex < 0
          ? []
          : orderedLines.slice(captionIndex).filter((line) => line.baseline < first)
    preserveListing(
      items,
      caption.length &&
        caption.every((line) => line.items.every((item) => !codeItems.has(item))) &&
        completePacket([...caption.flatMap((line) => line.items), ...items])
        ? caption
        : []
    )
  }
  // A caption and closed function prove the scope across blank native rows.
  // Font or spacing alone cannot extend a listing into surrounding prose.
  for (const [index, start] of orderedLines.entries()) {
    if (!/^(?:import\s+\w|def\s+\w|function\s+(?:\[|\w))/u.test(start.text)) continue
    const captionStart = orderedLines
      .slice(0, index)
      .findLastIndex(
        (line) =>
          /^Listing\s+\d+\s*:/u.test(line.text) && start.baseline - line.baseline < start.font * 8
      )
    if (captionStart < 0) continue
    const caption = orderedLines.slice(captionStart, index),
      firstCaption = caption[0]
    if (
      !firstCaption.items[0].fontName ||
      firstCaption.items[0].fontName === start.items[0].fontName ||
      caption.some(
        (line) => line.items.some((item) => codeItems.has(item)) || line.baseline >= start.baseline
      )
    )
      continue
    const listing: Line[] = []
    for (const line of orderedLines.slice(index)) {
      const comment = /^[#%]/u.test(line.text)
      if (
        line.x < start.x - start.font * 0.1 ||
        (listing.length && line.baseline - listing.at(-1)!.baseline > start.font * 4) ||
        Math.abs(line.font - start.font) > start.font * 0.05 ||
        line.items.some(
          (item) => !item.fontName || (!comment && item.fontName !== start.items[0].fontName)
        ) ||
        !syntax(line.text)
      )
        break
      listing.push(line)
    }
    if (listing.length < 4 || listing.filter((line) => assignment.test(line.text)).length < 2)
      continue
    const gaps = listing.slice(1).map((line, n) => line.baseline - listing[n].baseline),
      pitch = median(gaps.filter((gap) => gap > start.font * 0.75 && gap < start.font * 1.8))
    if (
      gaps.some(
        (gap) =>
          Math.round(gap / pitch) < 1 ||
          Math.round(gap / pitch) > 3 ||
          Math.abs(gap - Math.round(gap / pitch) * pitch) > start.font * 0.1
      )
    )
      continue
    const definition = listing.find((line) => /^(?:def|function)\s/u.test(line.text))
    if (!definition) continue
    const matlab = /^function\s/u.test(definition.text)
    let closed = false
    if (matlab) {
      if (!/^function\s+(?:\[[\w, ]+\]|\w+)\s*=\s*\w+\s*\([^]*\)\s*$/u.test(definition.text))
        continue
      const stack: Line[] = []
      for (const line of listing) {
        if (/^(?:function|if|for|while|switch|try)\b/u.test(line.text)) stack.push(line)
        if (/^end\s*;?$/u.test(line.text)) {
          const opening = stack.pop()
          if (!opening || Math.abs(opening.x - line.x) > start.font * 0.1) break
          if (!stack.length) {
            closed = line === listing.at(-1)
            break
          }
        }
      }
    } else {
      const last = listing.at(-1)!
      const definitionRows = listing.slice(listing.indexOf(definition)),
        signature = definitionRows.findIndex((line) => /\)\s*(?:->[^:]+)?\s*:\s*$/u.test(line.text))
      closed =
        signature >= 0 &&
        (signature === 0 || /^\)\s*(?:->[^:]+)?\s*:\s*$/u.test(definitionRows[signature].text)) &&
        /^def\s+[A-Za-z_]\w*\([^()]*\)\s*(?:->[^:]+)?\s*:\s*$/u.test(
          definitionRows
            .slice(0, signature + 1)
            .map((line) => line.text)
            .join(' ')
        ) &&
        definitionRows
          .slice(1, signature)
          .every((line) => /^[A-Za-z_]\w*(?:\s*:\s*[\w.[\], |]+)?\s*,?$/u.test(line.text)) &&
        /^return\s/u.test(last.text) &&
        last.x >= definition.x + start.font * 0.3 &&
        listing
          .slice(listing.indexOf(definition) + 1)
          .every((line) => line.x >= definition.x + start.font * 0.3)
    }
    const items = listing.flatMap((line) => line.items),
      packet = [...caption.flatMap((line) => line.items), ...items]
    if (closed && completePacket(packet)) preserveListing(items, caption)
  }
  for (const [index, start] of orderedLines.entries()) {
    if (
      !/^d\s*e\s*f\s+[A-Za-z_]/u.test(start.text) ||
      !/^def[A-Za-z_]\w*\(/u.test(start.text.replace(/\s/gu, ''))
    )
      continue
    const body: Line[] = []
    let last = start
    for (const line of orderedLines.slice(index + 1)) {
      if (
        line.x < start.x + start.font * 0.3 ||
        line.baseline - last.baseline > start.font * 1.8 ||
        Math.abs(line.font - start.font) > start.font * 0.15
      )
        break
      body.push(line)
      last = line
    }
    if (!body.some((line) => /^r\s*e\s*t\s*u\s*r\s*n\s+/u.test(line.text))) continue
    for (const line of [start, ...body]) for (const item of line.items) codeItems.add(item)
  }
  // Listings often mix proportional and monospace fonts. Require repeated
  // shell prompts/options, Python assignments or C++ includes/statements;
  // preserve their output rows too, stopping before the caption or body text.
  const shellPrompt = /^[%$>]\s*[A-Za-z_][\w.-]*\b/u
  const pythonImport = /^import\s+[A-Za-z_][\w.]*(?:\s+as\s+[A-Za-z_]\w*)?$/u
  const cppInclude = /^#include\s*<[\w./-]+>$/u
  for (const [index, start] of orderedLines.entries()) {
    if (
      (!shellPrompt.test(start.text) &&
        !pythonImport.test(start.text) &&
        !cppInclude.test(start.text)) ||
      start.items.every((item) => codeItems.has(item))
    )
      continue
    const listing = [start]
    let last = start
    for (const line of orderedLines.slice(index + 1)) {
      if (line.x >= start.right + start.font || line.right <= start.x - start.font) continue
      if (
        line.x < start.x - start.font * 0.3 ||
        line.x > Math.max(start.right, start.x + start.font * 4) ||
        line.baseline - last.baseline > start.font * 3 ||
        Math.abs(line.font - start.font) > start.font * 0.15 ||
        isPdfTranslationCaption(line.text)
      )
        break
      listing.push(line)
      last = line
    }
    const shell = shellPrompt.test(start.text)
      ? listing.filter((line) => shellPrompt.test(line.text)).length >= 2 &&
        listing.some((line) => /(?:--|−−)\s*[a-z_]|\|\s*[A-Za-z_]/u.test(line.text))
      : false
    const python =
      pythonImport.test(start.text) &&
      listing.filter((line) => {
        const equals = line.text.indexOf('=')
        return (
          equals > 0 &&
          line.text[equals + 1] !== '=' &&
          /^[A-Za-z_][\w, ]*$/u.test(line.text.slice(0, equals).trimEnd())
        )
      }).length >= 2
    const cpp =
      cppInclude.test(start.text) &&
      listing.filter((line) => cppInclude.test(line.text)).length >= 2 &&
      listing.filter((line) => /::|;$/u.test(line.text)).length >= 2
    if (!shell && !python && !cpp) continue
    for (const line of listing) for (const item of line.items) codeItems.add(item)
  }
  const detachedProseOrigins = new Map<Line, Line>()
  // A tall delimiter may start above this row. When its native item order
  // and x position both fall between two runs on the row, keep those runs
  // separate instead of making prose own the intervening formula glyph.
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index],
      first = Math.min(...line.items.map((item) => item.index)),
      last = Math.max(...line.items.map((item) => item.index))
    const barriers = all
      .filter(
        (item) =>
          item.detachedOperator &&
          (undecodedGlyph(item.str) || /^[()[\]{}|∣∥‖︷︸⏞⏟\uF8EB-\uF8FE]+$/u.test(item.str)) &&
          item.index > first &&
          item.index < last &&
          item.x > line.x &&
          item.right < line.right
      )
      .sort((a, b) => a.x - b.x)
    if (!barriers.length) continue
    const groups: Item[][] = [[]]
    for (const item of line.items) {
      const group = barriers.filter(
        (barrier) => barrier.right <= item.x && barrier.index < item.index
      ).length
      ;(groups[group] ??= []).push(item)
    }
    const parts = groups.filter((items) => items.length).map(lineOf)
    if (parts.length < 2) continue
    if (
      [...line.items, ...barriers].every(
        (item) =>
          item.nativeLine === line.items[0].nativeLine &&
          Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05
      )
    )
      detachedProseOrigins.set(parts.at(-1)!, line)
    lines.splice(index, 1, ...parts)
    index += parts.length - 1
  }
  // A neighboring column can share a fraction's baseline. Require its own
  // native sequence; real inline formula tails can include up to a three-em gap.
  const adjacentFractionTail = (
    line: Line,
    fraction: (typeof preservedFractions)[number]
  ): boolean => {
    const last = Math.max(...fraction.indices),
      next = Math.min(...line.items.map((item) => item.index))
    if (last >= next) return false
    const bridge = all.filter((item) => item.index > last && item.index < next)
    // Closing delimiters and an additive term can follow the fraction before
    // prose resumes. Every native item must remain a local mathematical suffix.
    if (
      bridge.length > 12 ||
      bridge.some(
        (item, index) =>
          item.unsupported ||
          !/^(?:[A-Za-z\p{Script=Greek}\d]{1,2}|[()[\]{}+−–*-])$/u.test(item.str) ||
          (/^[A-Za-z]+$/u.test(item.str) &&
            (!item.fontName || item.fontName === line.items[0].fontName)) ||
          item.x < fraction.right - line.font * 0.15 ||
          item.right > line.x + line.font * 0.05 ||
          item.font < line.font * 0.45 ||
          item.font > line.font * 1.05 ||
          Math.abs(item.originalBaseline - fraction.baseline) >
            line.font * (/^[()[\]{}]$/u.test(item.str) ? 1.25 : 0.55) ||
          item.x - (index ? bridge[index - 1].right : fraction.right) > line.font * 0.6 ||
          item.x - (index ? bridge[index - 1].right : fraction.right) < -line.font * 0.15
      )
    )
      return false
    const right = Math.max(fraction.right, ...bridge.map((item) => item.right))
    return (
      line.x >= right - line.font * 0.05 &&
      line.x - right < line.font * 3 &&
      Math.abs(line.baseline - fraction.baseline) < line.font * 0.45
    )
  }
  const formulaTails = new Set<Line>(
    lines.filter(
      (line) =>
        !symbolicExpression(line.text) &&
        preservedFractions.some((fraction) => adjacentFractionTail(line, fraction))
    )
  )
  // Require distinct markers: a solitary (x) or (i) may be a math operand.
  const romanMarker = /^\((?:i{1,3}|iv|v|vi{1,3}|ix|x)\)(?=\s+\p{L})/u
  const romanList =
    new Set(lines.map((line) => line.text.match(romanMarker)?.[0]).filter(Boolean)).size > 1
  const arabicMarker = /^\(\d{1,3}\)(?=\s+\p{L})/u
  const arabicList =
    new Set(lines.map((line) => line.text.match(arabicMarker)?.[0]).filter(Boolean)).size > 1
  // Only a serial, same-column caption continuation can use a styled acronym
  // parenthesis as prose evidence; unrelated rows and formulas supply none.
  const captionProseLines = new Set<Line>()
  const captionOrder = lines.toSorted((a, b) => a.baseline - b.baseline || a.x - b.x)
  for (const line of captionOrder) {
    if (isPdfTranslationCaption(line.text)) {
      captionProseLines.add(line)
      continue
    }
    const previous = captionOrder.findLast(
      (other) =>
        other.baseline < line.baseline &&
        Math.abs(other.x - line.x) < line.font * 0.15 &&
        captionProseLines.has(other)
    )
    if (
      previous &&
      !terminal(previous.text) &&
      line.baseline - previous.baseline > line.font * 0.75 &&
      line.baseline - previous.baseline < line.font * 1.6 &&
      Math.abs(line.font - previous.font) < line.font * 0.05 &&
      Math.min(...line.items.map((item) => item.index)) >
        Math.max(...previous.items.map((item) => item.index)) &&
      !all.some(
        (item) =>
          item.index > Math.max(...previous.items.map((part) => part.index)) &&
          item.index < Math.min(...line.items.map((part) => part.index))
      )
    )
      captionProseLines.add(line)
  }
  const uninterruptedNativeRow = (line: Line): boolean =>
    line.items.every(
      (item, index) =>
        item.nativeLine === line.items[0].nativeLine &&
        Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
        (!index ||
          (item.index > line.items[index - 1].index &&
            !all.some(
              (part) => part.index > line.items[index - 1].index && part.index < item.index
            ) &&
            item.x - line.items[index - 1].right >= -line.font * 0.05 &&
            item.x - line.items[index - 1].right < line.font * 0.8))
    )
  const verifiedProseLines = new Set<Line>()
  const sectionReferenceStarts = new Set<Line>()
  // A numeric citation can wrap after its comma, followed by another cited
  // name and returning prose. Prove both complete references and uninterrupted
  // body ownership; a digit-led function/index or an open bracket proves none.
  for (const line of lines) {
    if (
      !/^\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*\] (?:and|or) [A-Z][A-Za-z0-9-]{1,19} \[\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*\] (?:[a-z]{2,} ){4,}[a-z]{2,}-?$/u.test(
        line.text
      )
    )
      continue
    const previousItem = all.findLast((item) => item.index < line.items[0].index)
    const previous = previousItem && lines.find((row) => row.items.at(-1) === previousItem)
    if (
      !previous ||
      !/\[\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*,$/u.test(previous.text) ||
      previous.text.split('[').length !== previous.text.split(']').length + 1 ||
      !uninterruptedNativeRow(previous) ||
      !uninterruptedNativeRow(line) ||
      [previous, line].some(
        (row) =>
          preservedFormulaLines.has(row) ||
          row.items.some((item) => item.unsupported || tableItems.has(item) || codeItems.has(item))
      )
    )
      continue
    const acronyms = previous.items.filter(
      (item) => /^[A-Z]{2,7}s?$/u.test(item.str) && previous.text.includes(`(${item.str})`)
    )
    if (
      acronyms.length <= 1 &&
      continuousBodyWrap(previous, line, all, line.x, line.right, acronyms)
    )
      verifiedProseLines.add(line)
  }
  // A styled run-in label with an explicit section reference introduces prose,
  // not a function call. Require one unbroken native whitespace slot between
  // styles, and an uninterrupted literal body row, including justified gaps.
  for (const line of lines) {
    const [label, first, ...rest] = line.items
    if (!first || !/^[A-Z][a-z]{3,19} \(§[1-9]\d*(?:\.\d+)*\)\.$/u.test(label.str)) continue
    const body = lineOf([first, ...rest])
    const space = page.items[label.index + 1]
    if (
      !/^(?:Sin|Cos|Tan|Log|Exp|Min|Max|Argmin|Argmax|Det|Relu|Softmax|Sigmoid|Norm|Var)\b/u.test(
        label.str
      ) &&
      /^[A-Z][A-Za-z0-9 ,.;’'–-]+$/u.test(body.text) &&
      !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(body.text) &&
      wordCount(body.text) >= 5 &&
      (body.text.match(/\b[A-Za-z]*[a-z]{2,}[A-Za-z]*\b/gu)?.length ?? 0) >= 4 &&
      label.fontName !== first.fontName &&
      first.index === label.index + 2 &&
      space !== undefined &&
      !space.hasEOL &&
      ((space.str === '' &&
        space.fontName === undefined &&
        space.width === 0 &&
        space.height === 0 &&
        space.dir === 'ltr' &&
        space.transform.length === 6 &&
        space.transform.every((value) => value === 0)) ||
        (space.str === ' ' &&
          space.fontName === label.fontName &&
          space.dir === 'ltr' &&
          space.transform.length === 6 &&
          space.transform.every(Number.isFinite) &&
          Math.abs(space.transform[0] - label.font) < line.font * 0.05 &&
          Math.abs(space.transform[3] - label.font) < line.font * 0.05 &&
          Math.abs(space.transform[1]) < 0.001 &&
          Math.abs(space.transform[2]) < 0.001 &&
          Math.abs(space.transform[5] - label.transform[5]) < line.font * 0.05 &&
          Math.abs(space.transform[4] - label.right) < line.font * 0.01 &&
          Math.abs(space.transform[4] + space.width - first.x) < line.font * 0.01)) &&
      first.x - label.right > 0 &&
      first.x - label.right < line.font &&
      uninterruptedNativeRow(body) &&
      line.items.every(
        (part, index) =>
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          !!part.fontName &&
          (!index || part.fontName === first.fontName) &&
          part.nativeLine === label.nativeLine &&
          Math.abs(part.originalBaseline - line.baseline) < line.font * 0.05 &&
          Math.abs(part.font - first.font) < line.font * 0.05 &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[0] - part.transform[3]) < line.font * 0.05 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001
      )
    ) {
      verifiedProseLines.add(line)
      sectionReferenceStarts.add(line)
    }
  }
  // A literal score difference can wrap before its unit and metric label.
  // Require two complete point quantities, not arbitrary named functions.
  for (const line of lines) {
    if (
      !/^((?:percentage )?points?) \([A-Z][A-Z0-9]{1,7}\) and \d+(?:\.\d+)? \1 \([A-Z][A-Z0-9]{1,7}\)[.!?]$/u.test(
        line.text
      )
    )
      continue
    const previousItem = all.findLast((item) => item.index < line.items[0].index)
    const previous = previousItem && lines.find((other) => other.items.includes(previousItem))
    if (
      previous &&
      /(?:^|\s)\d+(?:\.\d+)?$/u.test(previous.text) &&
      ![previous, line].some(
        (row) =>
          preservedFormulaLines.has(row) ||
          row.items.some((item) => tableItems.has(item) || codeItems.has(item))
      ) &&
      continuousBodyWrap(previous, line, all, previous.x, previous.right) &&
      uninterruptedNativeRow(line)
    )
      verifiedProseLines.add(line)
  }
  // Repeated observation labels next to literal durations are a prose schedule,
  // not function calls. Prove the whole row and its uninterrupted body context;
  // a lone label, a formula suffix, or independently styled cells supplies none.
  for (const line of lines) {
    const schedule = line.text.match(
      /^([a-z]{4,}) \(([A-Z])(\d{1,2})\)(?: (?:and )?\d+(?:\.\d+)? (?:ms|s|min|h|days?) \([A-Z]\d{1,2}\),?){2,}(?: (?:and )?\d+(?:\.\d+)? (?:ms|s|min|h|days?))?$/u
    )
    if (
      !schedule ||
      /^(?:sin|cos|tan|log|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)$/u.test(
        schedule[1]
      )
    )
      continue
    const labels = [...line.text.matchAll(/\(([A-Z])(\d{1,2})\)/gu)]
    const previousItem = all.findLast((item) => item.index < line.items[0].index)
    const previous = previousItem && lines.find((other) => other.items.includes(previousItem))
    const trailingDuration = / \d+(?:\.\d+)? (?:ms|s|min|h|days?)$/u.test(line.text)
    const following = all.find((item) => item.index > line.items.at(-1)!.index)
    const closingLabel = `(${schedule[2]}${Number(schedule[3]) + labels.length}) `
    if (
      trailingDuration &&
      (!following ||
        !following.str.startsWith(closingLabel) ||
        !/^[a-z]{3}/u.test(following.str.slice(closingLabel.length)) ||
        tableItems.has(following) ||
        codeItems.has(following) ||
        following.fontName !== line.items[0].fontName ||
        Math.abs(following.font - line.font) > line.font * 0.05 ||
        Math.abs(following.x - line.x) > line.font * 0.15 ||
        following.originalBaseline - line.baseline <= line.font * 0.75 ||
        following.originalBaseline - line.baseline >= line.font * 1.7)
    )
      continue
    if (
      previous &&
      ![previous, line].some(
        (row) =>
          preservedFormulaLines.has(row) ||
          row.items.some((item) => tableItems.has(item) || codeItems.has(item))
      ) &&
      labels.every(
        (label, index) =>
          label[1] === schedule[2] && Number(label[2]) === Number(schedule[3]) + index
      ) &&
      continuousBodyWrap(previous, line, all, previous.x, previous.right) &&
      Math.abs(line.right - previous.right) < line.font &&
      line.items.every(
        (item, index) =>
          Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
          (!index ||
            (item.index > line.items[index - 1].index &&
              !all.some(
                (part) => part.index > line.items[index - 1].index && part.index < item.index
              ) &&
              item.x - line.items[index - 1].right >= -line.font * 0.05 &&
              item.x - line.items[index - 1].right < line.font * 0.8))
      )
    )
      verifiedProseLines.add(line)
  }
  // A wrapped physical dose is prose, even when a unit (min) also names a
  // mathematical operator. Require a complete numeric/unit parenthesis spanning
  // the row start, adjacent body geometry, and native inverse-unit scripts.
  // Expressions outside those literal quantities must retain their boundaries.
  const dose =
    /\b[A-Za-z][A-Za-z-]{2,}\s+\(\d+(?:\.\d+)?(?:[–-]\d+(?:\.\d+)?)?\s+(?:[μµu]?g|mg|kg|m[lL])(?:[·/]\s*(?:kg|min|h|day)(?:\s*[−-]1)?)*\s*\)/gu
  for (const line of lines) {
    if (
      preservedFormulaLines.has(line) ||
      line.items.some((item) => codeItems.has(item) || tableItems.has(item)) ||
      /[=<>≤≥+^∑∫]/u.test(line.text)
    )
      continue
    const first = line.items[0]
    const previousItem = all.findLast((item) => item.index < first.index)
    const previous = previousItem && lines.find((other) => other.items.includes(previousItem))
    if (
      !previous ||
      previous.text.length < 40 ||
      terminal(previous.text) ||
      symbolicExpression(previous.text) ||
      preservedFormulaLines.has(previous) ||
      previous.items.some((item) => codeItems.has(item) || tableItems.has(item)) ||
      !first.fontName ||
      first.fontName !== previous.items[0].fontName ||
      Math.abs(line.x - previous.x) > line.font * 0.15 ||
      Math.abs(line.right - previous.right) > line.font ||
      line.baseline - previous.baseline <= line.font * 0.75 ||
      line.baseline - previous.baseline >= line.font * 1.7 ||
      Math.abs(line.font - previous.font) > line.font * 0.05
    )
      continue
    const context = previous.text + ' ' + line.text
    const doses = [...context.matchAll(dose)].filter(
      (match) =>
        !/^(?:sin|cos|tan|log|ln|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(
          match[0]
        )
    )
    const outsideDoses = doses
      .reduce(
        (text, match) =>
          text.slice(0, match.index) +
          ' '.repeat(match[0].length) +
          text.slice(match.index + match[0].length),
        context
      )
      .slice(previous.text.length + 1)
    if (
      !doses.some(
        (match) =>
          match.index <= previous.text.length + 1 &&
          match.index + match[0].length > previous.text.length + 1
      ) ||
      !/^[\p{L}\s,.;:'’–-]*$/u.test(outsideDoses) ||
      /\b[A-Za-z]\s*[-–]\s*[A-Za-z]\b/u.test(outsideDoses)
    )
      continue
    const raisedPowers = new Set(
      line.items.filter((item, at) => {
        const base = line.items.slice(0, at).findLast((part) => part.font >= line.font * 0.9)
        return (
          base &&
          /(?:^|[·/\s])(?:kg|min|h|day)$/u.test(base.str) &&
          item.x - base.right >= -line.font * 0.05 &&
          item.x - base.right < line.font &&
          /^[−-]1?$|^1$/u.test(item.str) &&
          item.font >= line.font * 0.5 &&
          item.font < line.font * 0.85 &&
          line.baseline - item.originalBaseline > line.font * 0.1 &&
          line.baseline - item.originalBaseline < line.font * 0.5
        )
      })
    )
    // Validate the complete native exponent span, independent of how PDF.js
    // divides it between runs. Neither a flat digit nor a body run ending in
    // the minus sign may borrow the geometry of a neighboring raised glyph.
    const powerGlyphs = line.items.flatMap((item) =>
      item.str
        .replace(/\s/gu, '')
        .split('')
        .map((char) => ({ char, item }))
    )
    const nativePowers = [
      ...powerGlyphs
        .map(({ char }) => char)
        .join('')
        .matchAll(/[−-]1\b/gu)
    ]
    if (
      nativePowers.some((match) =>
        powerGlyphs
          .slice(match.index, match.index + match[0].length)
          .some(({ item }) => !raisedPowers.has(item))
      ) ||
      !line.items.every((item, at) => {
        const prior = at ? line.items[at - 1] : previousItem!
        return (
          (raisedPowers.has(item) ||
            (item.fontName === first.fontName &&
              Math.abs(item.font - line.font) < line.font * 0.05 &&
              Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05)) &&
          item.index > prior.index &&
          !all.some((other) => other.index > prior.index && other.index < item.index) &&
          (!at ||
            (item.x - prior.right >= -line.font * 0.05 && item.x - prior.right < line.font * 0.8))
        )
      })
    )
      continue
    verifiedProseLines.add(line)
  }
  const wordScriptFormulas = new Set<Line>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (
      verifiedProseLines.has(line) ||
      preservedFormulaLines.has(line) ||
      line.items.every((item) => codeItems.has(item) || tableItems.has(item))
    )
      continue
    // Word-valued indices remain part of their mathematical base. Their
    // letters must not masquerade as the start of the following prose run.
    const wordScripts = new Set(
      line.items.filter((item, at) => {
        const base = line.items[at - 1],
          next = line.items[at + 1]
        return (
          base &&
          next &&
          attachedScripts.has(item) &&
          /^[A-Za-z]{3,20}$/u.test(item.str) &&
          /^[A-Za-z\p{Script=Greek}]$/u.test(base.str) &&
          item.nativeLine === base.nativeLine &&
          item.index > base.index &&
          !all.some((part) => part.index > base.index && part.index < item.index) &&
          item.font < base.font * 0.85 &&
          item.font > base.font * 0.5 &&
          item.originalBaseline - base.originalBaseline > base.font * 0.08 &&
          item.originalBaseline - base.originalBaseline < base.font * 0.55 &&
          item.x - base.right >= -base.font * 0.1 &&
          item.x - base.right < base.font * 0.2 &&
          /^[=<>≤≥+*/^−-]/u.test(next.str) &&
          symbolicExpression(next.str) &&
          next.nativeLine === base.nativeLine &&
          Math.abs(next.originalBaseline - base.originalBaseline) < base.font * 0.05 &&
          Math.abs(next.font - base.font) < base.font * 0.05 &&
          next.x - item.right >= -base.font * 0.1 &&
          next.x - item.right < base.font * 0.5 &&
          next.index > item.index &&
          !all.some((part) => part.index > item.index && part.index < next.index)
        )
      })
    )
    let split = line.items.findIndex(
      (item, itemIndex) =>
        itemIndex > 0 &&
        !wordScripts.has(item) &&
        /[A-Za-z]{3,}/u.test(item.str.replace(/\b(?:and|where|for)\b/giu, '')) &&
        symbolicExpression(
          lineOf(line.items.slice(0, itemIndex).filter((part) => !wordScripts.has(part))).text
        )
    )
    if (split < 1) continue
    // A complete native expansion wraps immediately before
    // its last word and matching acronym. This is not a word/function list.
    const [expansionTail, acronym, closing] = line.items
    const opener = expansionTail.str.match(/^([a-z]+) \($/u)
    const predecessor = all.findLast((part) => part.index < expansionTail.index)
    const previousExpansionLine =
      predecessor && lines.find((row) => row.items.at(-1) === predecessor)
    const expansionWords = predecessor?.str.trim().match(/[A-Za-z]+$/u)
      ? predecessor.str.trim().split(/\s+/u)
      : []
    const initials =
      acronym?.str && /^[A-Z]{2,8}$/u.test(acronym.str)
        ? [...expansionWords.slice(-(acronym.str.length - 1)), opener?.[1] ?? '']
            .map((word) => word[0]?.toUpperCase() ?? '')
            .join('')
        : ''
    const remaining = closing && lineOf(line.items.slice(3)).text
    const proven =
      split === 1 &&
      !!opener &&
      !!predecessor &&
      !!previousExpansionLine &&
      initials === acronym.str &&
      closing?.str === ')' &&
      !!remaining &&
      /^[\p{L}\p{M}\s,.'’?!:;–-]+$/u.test(remaining) &&
      /[A-Za-z]{3,}/u.test(remaining) &&
      !symbolicExpression(previousExpansionLine.text) &&
      !terminal(previousExpansionLine.text) &&
      (previousExpansionLine.text.length > 40 ||
        (previousExpansionLine.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6) &&
      !preservedFormulaLines.has(previousExpansionLine) &&
      previousExpansionLine.items.every((part) => !tableItems.has(part) && !codeItems.has(part)) &&
      predecessor.nativeLine + 1 === expansionTail.nativeLine &&
      line.baseline - previousExpansionLine.baseline > line.font * 0.75 &&
      line.baseline - previousExpansionLine.baseline < line.font * 1.7 &&
      Math.abs(line.x - previousExpansionLine.x) < line.font * 0.15 &&
      nativeGroups.get(expansionTail.nativeLine)?.length === line.items.length &&
      uninterruptedNativeRow(line) &&
      line.items.every(
        (part) =>
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          !attachedScripts.has(part) &&
          part.dir === 'ltr'
      ) &&
      [predecessor, expansionTail, acronym, closing].every(
        (part) =>
          part.fontName === expansionTail.fontName &&
          !!part.fontName &&
          Math.abs(part.font - line.font) < line.font * 0.05 &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001
      ) &&
      !all.some(
        (part) =>
          !line.items.includes(part) &&
          part.x < line.right &&
          part.right > line.x &&
          part.y < line.bottom &&
          part.bottom > line.y
      )
    if (proven) continue

    // A comma-separated pair of baseline variables introduces an explanation,
    // not a display equation. Keep the whole native prose row, including later
    // occurrences of those labels, only with contiguous body-sized geometry.
    const [lead, firstVariable, comma, secondVariable, prose] = line.items
    if (
      split === 4 &&
      lead.str === 'where' &&
      /^\p{Script=Greek}$/u.test(firstVariable.str) &&
      comma.str === ',' &&
      /^\p{Script=Greek}$/u.test(secondVariable.str) &&
      firstVariable.str !== secondVariable.str &&
      firstVariable.fontName === secondVariable.fontName &&
      /^are [a-z]{3,}\b/u.test(prose.str) &&
      wordCount(line.text) >= 12 &&
      !/[=<>≤≥+*/^∑∫−]/u.test(line.text) &&
      uninterruptedNativeRow(line) &&
      line.items.every((part, at) => {
        const prior = line.items[at - 1]
        return (
          part.fontName &&
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          Math.abs(part.font - lead.font) < lead.font * 0.05 &&
          Math.abs(part.originalBaseline - lead.originalBaseline) < lead.font * 0.05 &&
          part.transform.every(Number.isFinite) &&
          Math.abs(part.transform[0] - lead.font) < lead.font * 0.05 &&
          Math.abs(part.transform[3] - lead.font) < lead.font * 0.05 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001 &&
          (part === comma ||
            (part.str === firstVariable.str || part.str === secondVariable.str
              ? part.fontName === firstVariable.fontName
              : part.fontName === lead.fontName)) &&
          (!prior ||
            (part.index > prior.index &&
              !all.some((other) => other.index > prior.index && other.index < part.index) &&
              part.x - prior.right >= -lead.font * 0.05 &&
              part.x - prior.right < lead.font * 0.5))
        )
      })
    ) {
      verifiedProseLines.add(line)
      continue
    }
    // A definition may name two signed variants using attached subscripts.
    // They are labels, not baseline arithmetic preceding an independent sentence.
    // Prove the complete native row and returning prose before retaining it intact.
    const [
      definition,
      positiveBase,
      positiveSign,
      conjunction,
      negativeBase,
      negativeSign,
      description
    ] = line.items
    if (
      split === 6 &&
      line.items.length === 7 &&
      definition.str === 'where' &&
      conjunction.str === 'and' &&
      /^[A-Za-z]$/u.test(positiveBase.str) &&
      negativeBase.str === positiveBase.str &&
      negativeBase.fontName === positiveBase.fontName &&
      positiveSign.str === '+' &&
      negativeSign.str === '−' &&
      /^are [a-z]{3,}\b/u.test(description.str) &&
      /^[A-Za-z ,;:'’!.?–-]+$/u.test(description.str) &&
      (description.str.match(/\b[a-z]{2,}\b/gu)?.length ?? 0) >= 6 &&
      !/\b(?:sin|cos|tan|log|exp|lim|(?:arg)?min|(?:arg)?max)\b/u.test(description.str) &&
      !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(description.str) &&
      nativeGroups.get(definition.nativeLine)?.length === line.items.length &&
      line.items.every((item, at) => {
        const prior = line.items[at - 1],
          sign = item === positiveSign || item === negativeSign
        return (
          !item.unsupported &&
          !('detachedOperator' in item && item.detachedOperator) &&
          !!item.fontName &&
          Number.isFinite(item.width) &&
          item.width > 0 &&
          Number.isFinite(item.height) &&
          item.height > 0 &&
          item.transform.length === 6 &&
          item.transform.every(Number.isFinite) &&
          item.transform[0] > 0 &&
          item.transform[3] > 0 &&
          Math.abs(item.transform[0] - item.font) < item.font * 0.05 &&
          Math.abs(item.height - item.font) < item.font * 0.05 &&
          Math.abs(item.transform[1]) < 0.001 &&
          Math.abs(item.transform[2]) < 0.001 &&
          item.nativeLine === definition.nativeLine &&
          (sign
            ? attachedScripts.has(item) &&
              item.font > prior.font * 0.6 &&
              item.font < prior.font * 0.85 &&
              item.originalBaseline - prior.originalBaseline > prior.font * 0.08 &&
              item.originalBaseline - prior.originalBaseline < prior.font * 0.55 &&
              item.x - prior.right >= -prior.font * 0.01 &&
              item.x - prior.right < prior.font * 0.05
            : Math.abs(item.font - definition.font) < definition.font * 0.05 &&
              Math.abs(item.originalBaseline - definition.originalBaseline) <
                definition.font * 0.05 &&
              (item === positiveBase ||
                item === negativeBase ||
                item.fontName === definition.fontName)) &&
          (!prior ||
            (item.index > prior.index &&
              !all.some((other) => other.index > prior.index && other.index < item.index) &&
              item.x - prior.right >= -line.font * 0.05 &&
              item.x - prior.right < line.font * 0.5))
        )
      })
    )
      continue
    // A separate "where" run introduces the explanation, including its variable.
    // Keep it with the prose instead of consuming it into the preceding formula.
    const explanation = line.items.findIndex(
      (item, itemIndex) =>
        itemIndex > 0 &&
        itemIndex < split &&
        /^[,;]?\s*\(?where\b/iu.test(item.str) &&
        symbolicExpression(
          lineOf(line.items.slice(0, itemIndex).filter((part) => !wordScripts.has(part))).text
        ) &&
        !symbolicExpression(lineOf(line.items.slice(itemIndex)).text)
    )
    if (explanation > 0) split = explanation
    // A closed author/year citation split into link objects is prose, not
    // a named function's argument. Require the adjacent native run, baseline,
    // and font as well as the complete dated citation before removing a seam.
    const prefix = lineOf(line.items.slice(0, split)).text,
      beforeCitation = line.items[split - 1],
      citation = line.items[split]
    // A body-sized Greek quantity can start a wrapped prose row. Its native
    // attachment and an unfinished preceding body row prove the continuation;
    // a standalone symbol, operator, table cell or raised glyph proves none.
    if (
      split === 1 &&
      /^\p{Script=Greek}$/u.test(beforeCitation.str) &&
      /^[a-z]{3,} [a-z]{2,}/u.test(citation.str) &&
      (line.text.match(/\b[a-z]{2,}\b/gu)?.length ?? 0) >= 5 &&
      !/[=<>≤≥+*/^∑∫−]/u.test(line.text) &&
      !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(line.text) &&
      uninterruptedNativeRow(line) &&
      beforeCitation.fontName &&
      citation.fontName &&
      line.items.every(
        (part) =>
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          Math.abs(part.font - line.font) < line.font * 0.05 &&
          Math.abs(part.originalBaseline - citation.originalBaseline) < line.font * 0.05 &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001
      )
    ) {
      const preceding = all.findLast((part) => part.index < beforeCitation.index),
        previous = preceding && lines.find((row) => row.items.includes(preceding))
      if (
        previous &&
        /\b(?:a|an|the|of|for|by|with|further|additional)$/u.test(previous.text) &&
        !preservedFormulaLines.has(previous) &&
        previous.items.every((part) => !tableItems.has(part) && !codeItems.has(part)) &&
        citation.fontName === previous.items[0].fontName &&
        continuousBodyWrap(previous, line, all, previous.x, previous.right, [beforeCitation])
      )
        continue
    }
    // A caption may wrap a word immediately before styled descriptive labels.
    // Closed, multiword labels are prose; a named function or symbolic operand
    // does not establish this continuation merely by opening a parenthesis.
    if (
      captionProseLines.has(line) &&
      /^[a-z]{3,}\s+\($/u.test(prefix) &&
      !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(prefix) &&
      /^[a-z]{3,}\s+\([A-Za-z]{3,}(?:[ +-]+[A-Za-z]{3,})+\)\s+(?:with|and)\b/u.test(line.text) &&
      line.items.every(
        (item) =>
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          Math.abs(item.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05
      )
    )
      continue
    // A paired quoted dataset/configuration label can close a prose sentence.
    // Prove the native body continuation; quoted operands in function calls,
    // standalone labels and formula suffixes provide no such evidence.
    if (
      /^(?:for|with|under|using|as) [a-z]{3,}(?: [a-z]{3,})? \((?:“[A-Za-z0-9]+(?:[+/_-]+[A-Za-z0-9]+)*”|"[A-Za-z0-9]+(?:[+/_-]+[A-Za-z0-9]+)*"|‘[A-Za-z0-9]+(?:[+/_-]+[A-Za-z0-9]+)*’)\)[.!?]$/u.test(
        prefix
      ) &&
      !/\b(?:sin|cos|tan|log|ln|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)\b/u.test(
        prefix
      ) &&
      /^[A-Z][A-Za-z'’‐-]*(?: [A-Za-z][A-Za-z'’‐-]*){2,}[.,;:]?$/u.test(
        lineOf(line.items.slice(split)).text
      ) &&
      uninterruptedNativeRow(line) &&
      !!line.items[0].fontName &&
      line.items.every(
        (part) =>
          part.fontName === line.items[0].fontName &&
          Math.abs(part.font - line.font) < line.font * 0.05 &&
          !tableItems.has(part) &&
          !codeItems.has(part)
      )
    )
      continue
    // A spelled-out name followed by its own acronym is a prose label.
    // Match the actual capital initials and a descriptive predicate; arbitrary
    // function operands, nested parameters and unrelated native rows prove none.
    const namedAcronym = prefix.match(
      /^([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*) \(([A-Z]{2,8})\d{0,3}\)$/u
    )
    if (
      namedAcronym &&
      /[a-z]{3,}/u.test(namedAcronym[1]) &&
      namedAcronym[1].replace(/[^A-Z]/gu, '') === namedAcronym[2] &&
      !/\b[a-z]\s*-\s*[a-z]\b/u.test(line.text) &&
      !/^(?:sin|cos|tan|log|ln|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)$/iu.test(
        namedAcronym[1]
      ) &&
      /^(?:[a-z]{2,} ){1,3}(?:is|are|was|were) [a-z]{3,}[a-z’' -]*$/u.test(
        lineOf(line.items.slice(split)).text
      ) &&
      uninterruptedNativeRow(line) &&
      !!line.items[0].fontName &&
      line.items.every(
        (item) =>
          item.fontName === line.items[0].fontName &&
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item)
      )
    )
      continue
    // A styled example abbreviation can end just before its final dot/comma.
    // Require a closed prose explanation and returning body font. The closing
    // parenthesis may wrap once through an uninterrupted native body row.
    const exampleLead = line.items[split - 2]
    if (
      /^(?:(?:\d+(?:\.\d+)? )?[a-z]{3,}\s+)?\((?:e\.g|i\.e)$/u.test(prefix) &&
      !/\b(?:sin|cos|tan|log|ln|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)\s+\(/u.test(
        prefix
      ) &&
      /^(?:e\.g|i\.e)$/u.test(beforeCitation.str) &&
      exampleLead?.fontName &&
      citation.fontName === exampleLead.fontName &&
      line.items.every((item, at) => {
        const previous = line.items[at - 1]
        return (
          item.fontName &&
          item.nativeLine === exampleLead.nativeLine &&
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          Math.abs(item.originalBaseline - exampleLead.originalBaseline) < line.font * 0.05 &&
          (!previous ||
            (item.index > previous.index &&
              !all.some((part) => part.index > previous.index && part.index < item.index) &&
              item.x - previous.right >= -line.font * 0.05 &&
              item.x - previous.right < line.font * 0.5))
        )
      })
    ) {
      const remainder = lineOf(line.items.slice(split)).text
      if (
        /^(?:[a-z]{3,}\s+)?\((?:e\.g|i\.e)$/u.test(prefix) &&
        /^\.\s+[A-Za-z][^()[\]{}=<>≤≥+*/^]{2,160}\)(?:\s+\p{L}|[,.;:]|$)/u.test(remainder)
      )
        continue
      const bodyExample = line.items.every(
        (part) =>
          (part === beforeCitation || part.fontName === exampleLead.fontName) &&
          !tableItems.has(part) &&
          !codeItems.has(part)
      )
      const closedExample =
        /^\.,?\s+(?:[A-Za-z]|\d+(?:\.\d+)?\s+[A-Za-z])[A-Za-z0-9 ,.;:'’‐-]{2,160}\)[.,;:]?(?: [A-Za-z0-9][A-Za-z0-9.,;'’‐-]*)*$/u
      if (
        bodyExample &&
        closedExample.test(remainder) &&
        !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(remainder)
      )
        continue
      // A complete cited name is a literal example, including a medial dot
      // inside a capitalized name. Do not admit general products or formulas.
      const citedExample =
        /^\.,? ([A-Z][A-Za-z]{2,}(?:·[A-Z][A-Za-z]*)?) \[[1-9]\d{0,2}(?:, ?[1-9]\d{0,2})*\]\)\. ([A-Z][A-Za-z ,;'’‐-]+)$/u.exec(
          remainder
        )
      // An example can consist entirely of closed numeric references. Its
      // unfinished preceding body row proves the opening is prose; the native
      // abbreviation alone must not exempt a standalone symbolic expression.
      const citedNumbers =
        /^\.,? \[[1-9]\d{0,2}(?:, ?[1-9]\d{0,2})*\]\)[.,;:]? ([A-Za-z ,;'’‐-]+)$/u.exec(remainder)
      const citedProse = citedExample?.[2] ?? citedNumbers?.[1]
      const precedingItem = all.findLast((part) => part.index < line.items[0].index)
      const preceding = precedingItem && lines.find((row) => row.items.includes(precedingItem))
      if (
        bodyExample &&
        citedProse &&
        preceding &&
        (citedProse.match(/\b[A-Za-z]*[a-z]{2,}[A-Za-z]*\b/gu)?.length ?? 0) >= 4 &&
        !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(citedProse) &&
        (!citedExample ||
          !/^(?:Sin|Cos|Tan|Log|Exp|Min|Max|Argmin|Argmax|Det|Relu|Softmax|Sigmoid|Norm|Var)$/u.test(
            citedExample[1]
          )) &&
        uninterruptedNativeRow(preceding) &&
        line.items[0].nativeLine === preceding.items[0].nativeLine + 1 &&
        ![...preceding.items, ...line.items].some(
          (part) =>
            part.unsupported ||
            tableItems.has(part) ||
            codeItems.has(part) ||
            !part.transform.every(Number.isFinite) ||
            part.transform[0] <= 0 ||
            part.transform[3] <= 0 ||
            Math.abs(part.transform[0] - part.transform[3]) >= line.font * 0.05 ||
            Math.abs(part.transform[1]) > 0.001 ||
            Math.abs(part.transform[2]) > 0.001
        ) &&
        continuousBodyWrap(preceding, line, all, line.x, line.right, [beforeCitation])
      )
        continue
      const lastIndex = Math.max(...line.items.map((part) => part.index))
      const followingItem = all.find((part) => part.index > lastIndex)
      const following = followingItem && lines.find((row) => row.items.includes(followingItem))
      if (
        bodyExample &&
        following &&
        !preservedFormulaLines.has(following) &&
        following.items.every((part) => !tableItems.has(part) && !codeItems.has(part)) &&
        uninterruptedNativeRow(following) &&
        continuousBodyWrap(line, following, all, line.x, line.right, [beforeCitation]) &&
        closedExample.test(`${remainder} ${following.text}`) &&
        !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(`${remainder} ${following.text}`)
      )
        continue
    }
    const versionPrefix = prefix.match(/^and ([A-Z][A-Za-z]{0,7})\d+(?:\.\d+)+ \($/u)
    const wrappedVersionCitation =
      versionPrefix &&
      /^and [A-Z][A-Za-z]{0,7}\d+(?:\.\d+)+ \([^()]+\)[.,;:]? [A-Za-z][A-Za-z0-9.'’‐-]*(?:\s+[A-Za-z][A-Za-z0-9.'’‐-]*)*\s*$/u.test(
        line.text
      ) &&
      uninterruptedNativeRow(line) &&
      lines.some(
        (previous) =>
          !preservedFormulaLines.has(previous) &&
          previous.items.every((item) => !tableItems.has(item) && !codeItems.has(item)) &&
          new RegExp(`\\b${versionPrefix[1]}\\d+(?:\\.\\d+)+$`, 'u').test(previous.text) &&
          continuousBodyWrap(previous, line, all, line.x, line.right)
      )
    if (
      (/[A-Za-z]{3,}\s*\($/u.test(prefix) || wrappedVersionCitation) &&
      !/\b(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\s*\($/iu.test(
        prefix
      ) &&
      /^(?:[A-Z][\p{L}'’.-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’.-]+)?(?:\s+et al\.)?)\s*,\s*\d{4}[a-z]?(?:,\s*\d{4}[a-z]?)*\)/u.test(
        lineOf(line.items.slice(split)).text
      ) &&
      beforeCitation.nativeLine === citation.nativeLine &&
      beforeCitation.fontName &&
      beforeCitation.fontName === citation.fontName &&
      Math.abs(beforeCitation.font - citation.font) < line.font * 0.05 &&
      Math.abs(beforeCitation.originalBaseline - citation.originalBaseline) < line.font * 0.1 &&
      citation.x - beforeCitation.right >= -line.font * 0.05 &&
      citation.x - beforeCitation.right < line.font * 0.5
    )
      continue
    // Closed prose references can occupy separate link/font objects. Require
    // their full literal grammar and a serial native body row, returning to the
    // introducing font; unclosed references and function operands stay separate.
    const closedProseReference =
      // A styled multiword term in a closed parenthesis still belongs to its
      // introducing prose. Literal words and the returning body font below
      // distinguish this explanation from a function's symbolic arguments.
      (/^[a-z]{3,}\s+\((?:[\p{L}][\p{L}\p{M}'’‐-]{2,29}\s+){1,5}[\p{L}][\p{L}\p{M}'’‐-]{2,29}\)[.,;:]?\s+\p{L}{2,}\b/u.test(
        line.text
      ) &&
        !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(
          line.text
        )) ||
      (captionProseLines.has(line) &&
        /^[a-z]{3,}\s+\([A-Za-z][A-Za-z0-9]{0,7}\)[.,;:]?\s+[A-Za-z]+\b/u.test(line.text) &&
        !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(
          line.text
        )) ||
      // A defined acronym can resume a body wrap through a whole styled word.
      // Native adjacency and the ordinary body-wrap proof still apply.
      (/^[a-z]{3,}\s+\([A-Z]{2,8}\)[.,;:]?\s+[a-z]{3,}\b/u.test(line.text) &&
        (line.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 5 &&
        !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(
          line.text
        ) &&
        lines.some(
          (previous) =>
            !preservedFormulaLines.has(previous) &&
            previous.items.every((item) => !tableItems.has(item) && !codeItems.has(item)) &&
            continuousBodyWrap(
              previous,
              line,
              all,
              line.x,
              line.right,
              line.items.filter(
                (item) => item.fontName !== line.items[0].fontName && /^[a-z]{3,}$/u.test(item.str)
              )
            )
        )) ||
      (/^[a-z]{3,}\s+\([A-Z][A-Z0-9]{1,7}\)-$/u.test(prefix) &&
        !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(prefix) &&
        /^[a-z]{3,}\b/u.test(lineOf(line.items.slice(split)).text)) ||
      (/^[a-z]{3,}\s+\($/u.test(prefix) &&
        !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(prefix) &&
        /^(?:(?:Figure|Table)s?\s+\d+[A-Z]?(?:[,–-]\s*\d*[A-Z])?|(?:Table\s+\d+|S\d+\s+(?:Fig|Table)s?)(?:\s+and\s+S\d+\s+(?:Fig|Table)s?)+)\)[.,;:]?(?:\s+[A-Za-z]{2,}|$)/u.test(
          lineOf(line.items.slice(split)).text
        )) ||
      (/^\([A-Z][\p{L}'’.-]+\s+et al\.,\s*\d{4}[a-z]?(?:;\s*[A-Z][\p{L}'’.-]+\s+et al\.,\s*\d{4}[a-z]?)*$/u.test(
        prefix
      ) &&
        /^\)[.,;:]?(?:\s+[A-Za-z]{2,}|$)/u.test(lineOf(line.items.slice(split)).text))
    if (
      closedProseReference &&
      line.items[0].fontName &&
      line.items.at(-1)!.fontName === line.items[0].fontName &&
      line.items.every((item, at) => {
        const previous = line.items[at - 1]
        return (
          item.fontName &&
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          Math.abs(item.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05 &&
          (!previous ||
            (item.nativeLine === previous.nativeLine &&
              item.index > previous.index &&
              !all.some((part) => part.index > previous.index && part.index < item.index) &&
              item.x - previous.right >= -line.font * 0.05 &&
              item.x - previous.right < line.font * 0.5))
        )
      })
    )
      continue
    // A numeric citation can end a short-word author lead-in ("from Bu et al").
    // Its complete closing bracket, prose and adjacent native body runs prove
    // the citation; an open function/index or a separate column proves nothing.
    if (
      /^(?:[A-Za-z][\p{L}’‘'.-]*\s+){2,}[A-Za-z][\p{L}’‘'.-]*\s*\[\d+(?:[ ,–-]\d+)*$/u.test(
        prefix
      ) &&
      /\b[a-z]{3,}\b/u.test(prefix) &&
      /^\][,.;:]?\s+(?!where\b)[A-Za-z]{3,}/u.test(lineOf(line.items.slice(split)).text) &&
      beforeCitation.nativeLine === citation.nativeLine &&
      beforeCitation.fontName &&
      beforeCitation.fontName === citation.fontName &&
      Math.abs(beforeCitation.font - citation.font) < line.font * 0.05 &&
      Math.abs(beforeCitation.originalBaseline - citation.originalBaseline) < line.font * 0.05 &&
      citation.index > beforeCitation.index &&
      !all.some((item) => item.index > beforeCitation.index && item.index < citation.index) &&
      citation.x - beforeCitation.right >= -line.font * 0.05 &&
      citation.x - beforeCitation.right < line.font * 0.5
    )
      continue
    // A section sign with its complete numeric locator is a prose reference,
    // never a function argument. Native adjacency keeps its word lead-in intact.
    if (
      /^(?:[a-z]{3,}\s+)?\(§$/u.test(prefix) &&
      /^\d+(?:\.\d+)*\)[,;:]?\s+[A-Za-z]{2,}/u.test(lineOf(line.items.slice(split)).text) &&
      beforeCitation.nativeLine === citation.nativeLine &&
      beforeCitation.fontName &&
      Math.abs(beforeCitation.font - citation.font) < line.font * 0.05 &&
      Math.abs(beforeCitation.originalBaseline - citation.originalBaseline) < line.font * 0.05 &&
      citation.index > beforeCitation.index &&
      !all.some((item) => item.index > beforeCitation.index && item.index < citation.index) &&
      citation.x - beforeCitation.right >= -line.font * 0.05 &&
      citation.x - beforeCitation.right < line.font * 0.5
    )
      continue
    // A cited identifier or short prose lead-in belongs to the preceding
    // unfinished native body row. Linked citation objects may end the sentence
    // before the next capitalized sentence; neither boundary is a formula seam.
    // A style change after the closed citation does not change its identity.
    // Prove the citation and its first complete prose run in the body font;
    // later emphasis or a lone variable still needs one uninterrupted native row.
    const styledCitationTail =
      !/^(?:argmin|argmax)\b/iu.test(line.text) &&
      /^\][.,;:]?\s+(?:[A-Za-z]{2,}\s+){3,}[A-Za-z]{3,}$/u.test(citation.str) &&
      uninterruptedNativeRow(line) &&
      line.items.every(
        (item) => !item.unsupported && !codeItems.has(item) && !tableItems.has(item)
      ) &&
      line.items
        .slice(split + 1)
        .every(
          (item) =>
            Math.abs(item.font - line.font) < line.font * 0.05 &&
            /^[\p{L}\p{N}\s.,;:'’‐-]+$/u.test(item.str) &&
            (!symbolicExpression(item.str) || /^\p{Script=Greek}$/u.test(item.str))
        )
    // A wrapped citation may also close a prose list opened on the prior row.
    // Prove that opening and its already closed citation, not an arbitrary
    // optional parenthesis that could terminate a function or nested operand.
    const closedCitationList =
      /^[A-Z][A-Za-z0-9'’‐-]{1,19} \[\d+(?:\s*[,;–—-]\s*\d+)*\]\), [a-z]{3,}(?: [a-z][a-z‐-]+){2,}/u.test(
        line.text
      ) &&
      /^[A-Za-z0-9\s.,;:'’‐–—()[\]-]+$/u.test(line.text) &&
      !/\b[A-Za-z]\s*-\s*[A-Za-z]\b|\b(?:[A-Za-z]|sin|cos|tan|log|ln|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)\s*[([]/iu.test(
        line.text
      ) &&
      uninterruptedNativeRow(line) &&
      lines.some((previous) => {
        const lead = previous.text.match(
          /\b([a-z][a-z‐-]{2,}) \([A-Z][A-Za-z0-9'’‐-]{1,19} \[\d+(?:\s*[,;–—-]\s*\d+)*\],$/u
        )
        return (
          lead &&
          !preservedFormulaLines.has(previous) &&
          !/^(?:sin|cos|tan|log|exp|(?:arg)?min|(?:arg)?max|det|relu|softmax|sigmoid|norm|var)$/iu.test(
            lead[1]
          ) &&
          previous.text.split('(').length === previous.text.split(')').length + 1 &&
          [previous, line].every((row) =>
            row.items.every(
              (item) => !item.unsupported && !tableItems.has(item) && !codeItems.has(item)
            )
          ) &&
          uninterruptedNativeRow(previous) &&
          line.items[0].nativeLine === previous.items.at(-1)!.nativeLine + 1 &&
          continuousBodyWrap(previous, line, all, line.x, line.right)
        )
      })
    const wrappedBodyCitation =
      /^(?:[\p{L}][\p{L}\p{M}0-9.'’‐-]{1,19}\s+){1,6}\[\d+(?:\s*[,;–—-]\s*\d+)*\][.,;:]?\s+[\p{L}][\p{L}\p{N}‐-]*(?=\s|[.,;:])/u.test(
        line.text
      ) &&
      line.items[0].fontName &&
      lines.some(
        (previous) =>
          !preservedFormulaLines.has(previous) &&
          previous.items.every((item) => !codeItems.has(item) && !tableItems.has(item)) &&
          continuousBodyWrap(
            previous,
            styledCitationTail ? lineOf(line.items.slice(0, split + 1)) : line,
            all,
            line.x,
            line.right,
            // Only standalone numeric link objects inside the closed citation
            // may change font. The surrounding prose must retain its body font.
            line.items.slice(1, split).filter((item) => /^[\d\s,;–—-]+$/u.test(item.str))
          )
      )
    // A linked numeric citation may split a prose word from the rest of its
    // sentence into separate PDF objects. Require a closed citation followed
    // by prose; compact indices and named math functions still remain formulas.
    if (
      (wrappedBodyCitation ||
        closedCitationList ||
        /^(?:(?:\d+[A-Za-z]?\s+)?[A-Za-z]{3,}\s+)?\[\d+(?:\s*[,–-]\s*\d+)*\]\)?[.,;:]?\s+[A-Za-z]{2,}/u.test(
          line.text
        ) ||
        (/^\[\d+(?:\s*[,–-]\s*\d+)*\][.,;:]?\s+A\s+[a-z]{3,}/u.test(line.text) &&
          line.items[0].fontName &&
          line.items.at(-1)!.fontName === line.items[0].fontName &&
          line.items.every((item, at) => {
            const previous = line.items[at - 1]
            return (
              item.fontName &&
              Math.abs(item.font - line.font) < line.font * 0.05 &&
              Math.abs(item.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05 &&
              (!previous ||
                (item.nativeLine === previous.nativeLine &&
                  item.index > previous.index &&
                  !all.some((part) => part.index > previous.index && part.index < item.index) &&
                  item.x - previous.right >= -line.font * 0.05 &&
                  item.x - previous.right < line.font * 0.5))
            )
          }))) &&
      !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(line.text)
    )
      continue
    // Counts can introduce a parenthesized dataset label in the same sentence.
    // A complete word label distinguishes them from symbolic arguments.
    if (/^\d{1,3}(?:,\s*\d{3})+\s+\([A-Za-z]{3,}\)\s+[A-Za-z]{2,}/u.test(line.text)) continue
    // A native run can end at the decimal point while the next run contains
    // its digits and prose. Splitting here would translate only half a number.
    const before = line.items[split - 1],
      after = line.items[split]
    // Closed clinical durations and repeated treatment timepoints are prose.
    // Require native adjacency across the unfinished prefix; small numeric
    // subscripts may belong to T labels, never arbitrary variables/operands.
    // A wrapped power calculation is part of its introducing sentence. Keep
    // the complete probability and following prose with the adjacent native
    // body line; standalone equations and symbolic operands stay separate.
    const previousItem = all.findLast((item) => item.index < line.items[0].index)
    const previousLine = previousItem && lines.find((other) => other.items.includes(previousItem))
    // A noun can introduce an indexed sequence inside a wrapped body sentence.
    // Prove the complete list, returning prose and attached native subscripts;
    // display equations, open lists and detached indices supply no such proof.
    if (
      /^([a-z]{3,}) \((\p{L})\d{1,2}, \. \. \. , \2\p{L}\),$/u.test(prefix) &&
      !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(prefix) &&
      /^and (?:the|a|an) [A-Za-z]{3,}/u.test(after.str) &&
      (after.str.match(/\b[A-Za-z]{2,}\b/gu)?.length ?? 0) >= 6 &&
      previousLine &&
      /\b(?:list|sequence|set) of (?:[a-z]{2,} ){0,3}[a-z]{2,}$/u.test(previousLine.text) &&
      !preservedFormulaLines.has(previousLine) &&
      uninterruptedNativeRow(previousLine) &&
      previousLine.items[0].fontName === after.fontName &&
      previousLine.items
        .filter((part) => part.fontName !== after.fontName)
        .every(
          (part) =>
            part === previousLine.items.at(-1) && /^[a-z]{2,}(?: [a-z]{2,}){0,2}$/u.test(part.str)
        ) &&
      line.items[0].fontName === after.fontName &&
      line.items.filter((part) => part.font < line.font * 0.95).length === 2 &&
      line.items.every((part, at) => {
        const prior = line.items[at - 1]
        const script = part.font < line.font * 0.95
        return (
          !!part.fontName &&
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001 &&
          part.nativeLine === line.items[0].nativeLine &&
          (script
            ? prior &&
              /^[\p{L}\d]$/u.test(part.str) &&
              /\p{L}$/u.test(prior.str) &&
              part.font > line.font * 0.6 &&
              part.font < line.font * 0.85 &&
              part.originalBaseline - line.baseline > line.font * 0.08 &&
              part.originalBaseline - line.baseline < line.font * 0.4
            : Math.abs(part.font - line.font) < line.font * 0.05 &&
              Math.abs(part.originalBaseline - line.baseline) < line.font * 0.05) &&
          (!prior ||
            (part.index > prior.index &&
              !all.some((other) => other.index > prior.index && other.index < part.index) &&
              part.x - prior.right >= -line.font * 0.05 &&
              part.x - prior.right < line.font * 0.8))
        )
      }) &&
      continuousBodyWrap(
        previousLine,
        {
          ...line,
          items: line.items.map((part) => ({ ...part, font: line.font, fontName: after.fontName }))
        },
        all,
        line.x,
        line.right,
        previousLine.items.filter((part) => part.fontName !== after.fontName)
      )
    ) {
      verifiedProseLines.add(line)
      continue
    }
    // A wrapped parameter declaration can end mid-row before the next prose
    // sentence. The introducing comma, literal numeric assignments and native
    // body/script attachment prove inline prose, not an independent equation.
    const wrappedNumericParameters =
      /^(?:[a-z](?:[a-z ]{0,5}) = \d{1,5},? ){0,4}[a-z](?:[a-z]{1,5})? = [a-z](?:[a-z]{1,5})?$/u.test(
        prefix
      ) && /^= \d{1,5}[,.] [A-Za-z]{3,}(?:\s|,)/u.test(after.str)
    if (
      (wrappedNumericParameters ||
        (/^[a-z\p{Script=Greek}]{1,3}\s*=\s*\d{1,5}(?:\.\d+)?(?:\s+and\s+[a-z\p{Script=Greek}]{1,3}\s*=\s*(?:[a-z\p{Script=Greek}]{1,3}\s*=\s*)?\d{1,5}(?:\.\d+)?)?\.$/u.test(
          prefix
        ) &&
          /^(?!Where\b)[A-Z][A-Za-z]+\s/u.test(after.str))) &&
      (after.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6 &&
      previousLine &&
      previousLine.text.length > 40 &&
      /,$/u.test(previousLine.text) &&
      !preservedFormulaLines.has(previousLine) &&
      !symbolicExpression(previousLine.text) &&
      Math.abs(previousLine.x - line.x) < line.font * 0.15 &&
      Math.abs(previousLine.right - line.right) < line.font &&
      line.baseline - previousLine.baseline > line.font * 0.75 &&
      line.baseline - previousLine.baseline < line.font * 1.7 &&
      previousItem?.fontName === after.fontName &&
      line.items.at(-1)!.fontName === after.fontName &&
      line.items.every((item, at) => {
        const prior = at ? line.items[at - 1] : previousItem!
        const script =
          at > 0 &&
          (wrappedNumericParameters ? /^[a-z]{1,5}(?: [a-z])?$/u : /^[a-z](?:\s?[a-z])?$/u).test(
            item.str
          ) &&
          /^[a-z\p{Script=Greek}]$/u.test(prior.str) &&
          item.x - prior.right >= -line.font * 0.05 &&
          item.x - prior.right < line.font * 0.15 &&
          item.font > line.font * 0.6 &&
          item.font < line.font * 0.85 &&
          item.originalBaseline - prior.originalBaseline > line.font * 0.08 &&
          item.originalBaseline - prior.originalBaseline < line.font * 0.4
        return (
          !!item.fontName &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item) &&
          item.transform.every(Number.isFinite) &&
          Math.abs(item.transform[0] - item.font) < item.font * 0.05 &&
          Math.abs(item.transform[3] - item.font) < item.font * 0.05 &&
          Math.abs(item.transform[1]) < 0.001 &&
          Math.abs(item.transform[2]) < 0.001 &&
          item.nativeLine === line.items[0].nativeLine &&
          (script ||
            (Math.abs(item.font - line.font) < line.font * 0.05 &&
              Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
              (item.fontName === after.fontName || /^[a-z\p{Script=Greek}]$/u.test(item.str)))) &&
          item.index > prior.index &&
          !all.some((part) => part.index > prior.index && part.index < item.index) &&
          (!at ||
            (item.x - prior.right >= -line.font * 0.05 && item.x - prior.right < line.font * 0.8))
        )
      })
    ) {
      verifiedProseLines.add(line)
      continue
    }
    // A wrapped literal initial value followed by a function's prose definition
    // continues the unfinished body row. The value and function are not a
    // standalone equation merely because their native fonts differ.
    const wrappedFunctionDefinition =
      /^\d+(?:\.\d+)?, and [A-Za-z]\s*\(·\)$/u.test(prefix) &&
      previousLine &&
      previousLine.text.length > 40 &&
      !terminal(previousLine.text) &&
      !symbolicExpression(previousLine.text) &&
      Math.abs(previousLine.x - line.x) < line.font * 0.15 &&
      Math.abs(previousLine.right - line.right) < line.font &&
      line.baseline - previousLine.baseline > line.font * 0.75 &&
      line.baseline - previousLine.baseline < line.font * 1.5 &&
      previousItem?.fontName === line.items[0].fontName &&
      !all.some((item) => item.index > previousItem.index && item.index < line.items[0].index)
    // A copular explanation defines its inline subject on the same native
    // row. Keep "where α is ..." and "diag(·) denotes ..." intact; standalone
    // operands, displaced indices and other columns supply no such proof.
    const pairedSubjects =
      /^where ([A-Za-z\p{Script=Greek}]) and ([A-Za-z\p{Script=Greek}])$/u.exec(prefix)
    const pairedDefinition =
      split === 4 &&
      pairedSubjects &&
      pairedSubjects[1] !== pairedSubjects[2] &&
      line.items[0].str === 'where' &&
      line.items[2].str === 'and' &&
      line.items[2].fontName === line.items[0].fontName &&
      terminal(line.text) &&
      /^[A-Za-z\p{Script=Greek}\s.,’'-]+$/u.test(line.text) &&
      line.items.every(
        (item) =>
          item.transform.length === 6 &&
          item.transform.every(Number.isFinite) &&
          Math.abs(item.transform[0] - line.font) < line.font * 0.05 &&
          Math.abs(item.transform[3] - line.font) < line.font * 0.05 &&
          Math.abs(item.transform[1]) < 0.001 &&
          Math.abs(item.transform[2]) < 0.001
      )
    if (
      ((pairedDefinition && /^are\s+/u.test(after.str)) ||
        ((/^(?:where\s+[A-Za-z\p{Script=Greek}]|[a-z]{2,8}\(·\))$/u.test(prefix) ||
          wrappedFunctionDefinition) &&
          /^(?:is|denotes)\s+/u.test(after.str))) &&
      (after.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 5 &&
      line.items[0].fontName &&
      after.fontName === line.items[0].fontName &&
      (pairedDefinition ? line.items : line.items.slice(0, split + 1)).every((item, at) => {
        const prior = line.items[at - 1]
        return (
          !!item.fontName &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item) &&
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
          (!prior ||
            (item.nativeLine === prior.nativeLine &&
              item.index > prior.index &&
              !all.some((part) => part.index > prior.index && part.index < item.index) &&
              item.x - prior.right >= -line.font * 0.05 &&
              item.x - prior.right < line.font * 0.5))
        )
      })
    )
      continue
    // A body-sized resolved radical can be the first part of a hyphenated
    // adjective. Require an ordinary unfinished body wrap and the radical's
    // proven native radicand; displaced/standalone roots remain protected.
    const radical = line.items[0],
      radicand = line.items[1]
    if (
      split === 2 &&
      radical.str === '√' &&
      resolvedRadicands.get(radical) === radicand &&
      /^-[a-z]{3,}\s+[a-z]{2,}/u.test(after.str) &&
      (after.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 5 &&
      previousLine &&
      continuousBodyWrap(previousLine, line, all, line.x, line.right, [radical, radicand]) &&
      Math.abs(radicand.originalBaseline - after.originalBaseline) < line.font * 0.05 &&
      line.items.every((item, at) => {
        const prior = line.items[at - 1]
        return (
          !!item.fontName &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item) &&
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          item.nativeLine === radical.nativeLine &&
          (!prior ||
            (item.index > prior.index &&
              !all.some((part) => part.index > prior.index && part.index < item.index) &&
              item.x - prior.right >= -line.font * 0.05 &&
              item.x - prior.right < line.font * 0.5))
        )
      })
    )
      continue
    // A closed parenthetical modifier in a styled name belongs to body prose.
    // The unfinished previous row and immediate return to the body font prove
    // this is a name, rather than a named mathematical function's argument.
    const modifiedName = /^([A-Z][A-Za-z]{2,})\)/u.exec(after.str)?.[1]
    const namedBodyVariables = line.items.filter((item, at) => {
      const prior = line.items[at - 1],
        next = line.items[at + 1]
      return (
        at > split &&
        /^[a-z]$/u.test(item.str) &&
        item.fontName &&
        item.fontName !== line.items[0].fontName &&
        prior?.fontName === line.items[0].fontName &&
        next?.fontName === line.items[0].fontName &&
        Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
        ((modifiedName && item.str === before.str && next.str.startsWith(modifiedName + ' ')) ||
          (/\b[a-z]{3,}$/u.test(prior.str) && /^[,;:]$/u.test(next.str)))
      )
    })
    if (
      /^[A-Z][A-Za-z]{2,}(?: and)?\s+\([a-z]$/u.test(prefix) &&
      !/^(?:Sin|Cos|Tan|Log|Ln|Exp|Min|Max|Det|Relu|Softmax|Sigmoid|Norm|Var)\b/u.test(prefix) &&
      /^(?:\)[A-Z][A-Za-z]{2,}|[A-Z][A-Za-z]{2,}\))[.,]?\s+/u.test(after.str) &&
      (after.str.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
      previousLine &&
      after.fontName === line.items[0].fontName &&
      (!namedBodyVariables.length ||
        (uninterruptedNativeRow(line) &&
          !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(line.text) &&
          line.items.every(
            (item) =>
              !item.unsupported &&
              !tableItems.has(item) &&
              !codeItems.has(item) &&
              /^[A-Za-z0-9\s(),.;:'’‐-]+$/u.test(item.str) &&
              item.transform.every(Number.isFinite) &&
              item.transform[0] > 0 &&
              item.transform[3] > 0 &&
              Math.abs(item.transform[1]) < 0.001 &&
              Math.abs(item.transform[2]) < 0.001
          ))) &&
      continuousBodyWrap(previousLine, line, all, line.x, line.right, [
        before,
        ...namedBodyVariables
      ]) &&
      line.items.slice(0, split + 1).every((item, at) => {
        const prior = line.items[at - 1]
        return (
          !!item.fontName &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item) &&
          Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
          (!prior ||
            (item.nativeLine === prior.nativeLine &&
              item.index > prior.index &&
              !all.some((part) => part.index > prior.index && part.index < item.index) &&
              item.x - prior.right >= -line.font * 0.05 &&
              item.x - prior.right < line.font * 0.5))
        )
      })
    )
      continue
    // A wrapped body sentence can name a styled identifier in parentheses.
    // The complete identifier, closing punctuation and returning body prose
    // prove a reference, rather than a detached function/equation prefix.
    const identifierEnd = line.items[split + 1],
      contextItem =
        previousLine && all.findLast((item) => item.index < previousLine.items[0].index),
      contextLine = contextItem && lines.find((row) => row.items.at(-1) === contextItem)
    if (
      /^[a-z]{4,}\s+\($/u.test(prefix) &&
      !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(prefix) &&
      /^[A-Za-z]{2,}\w*_[A-Za-z]\w*$/u.test(after.str) &&
      identifierEnd?.str.startsWith('),') &&
      /^\),\s+(?:and|or)\s+[a-z]{3,}$/u.test(lineOf(line.items.slice(split + 1)).text) &&
      previousLine &&
      contextLine &&
      !terminal(contextLine.text) &&
      wordCount(contextLine.text) >= 5 &&
      previousLine.baseline - contextLine.baseline > line.font * 0.75 &&
      previousLine.baseline - contextLine.baseline < line.font * 1.7 &&
      Math.abs(contextLine.right - previousLine.right) < line.font &&
      Math.abs(contextLine.x - previousLine.x) < line.font * 2 &&
      after.fontName !== before.fontName &&
      continuousBodyWrap(
        previousLine,
        line,
        all,
        line.x,
        line.right,
        [
          after,
          ...previousLine.items.filter((item) => /^[A-Za-z]{2,}\w*_[A-Za-z]\w*$/u.test(item.str))
        ],
        `${contextLine.text} ${previousLine.text} ${line.text}`
      ) &&
      line.items.every((item, at) => {
        const prior = line.items[at - 1]
        return (
          !!item.fontName &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item) &&
          item.nativeLine === line.items[0].nativeLine &&
          Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
          (!prior ||
            (item.index > prior.index &&
              !all.some((part) => part.index > prior.index && part.index < item.index) &&
              item.x - prior.right >= -line.font * 0.05 &&
              item.x - prior.right < line.font * 2))
        )
      })
    )
      continue
    // Small capitals vary size without moving off the body baseline. A
    // parenthesized name can span several such runs; it is not a lowered index
    // or a function argument when an adjacent unfinished body row introduces
    // it and the closing run immediately returns to ordinary prose.
    const smallCapsEnd = line.items.findIndex(
      (item, at) => at >= split && /^\)[,;:]?\s+\p{Ll}{2,}/u.test(item.str)
    )
    if (
      smallCapsEnd >= split &&
      /^(?:[A-Za-z]{3,}\s+){0,3}\([A-Z]{1,3}$/u.test(prefix) &&
      previousLine &&
      previousItem?.fontName &&
      previousLine.text.length > 40 &&
      !terminal(previousLine.text) &&
      !symbolicExpression(previousLine.text) &&
      previousItem.index < line.items[0].index &&
      !all.some((item) => item.index > previousItem.index && item.index < line.items[0].index) &&
      Math.abs(previousLine.x - line.x) < line.font * 0.15 &&
      Math.abs(previousLine.right - line.right) < line.font &&
      line.baseline - previousLine.baseline > line.font * 0.75 &&
      line.baseline - previousLine.baseline < line.font * 1.5 &&
      line.items.slice(split, smallCapsEnd).every((item) => /^[A-Z]{1,12}$/u.test(item.str)) &&
      line.items.slice(0, smallCapsEnd + 1).some((item) => item.font < line.font * 0.85) &&
      line.items.slice(0, smallCapsEnd + 1).every((item, at) => {
        const prior = line.items[at - 1]
        return (
          item.fontName === previousItem.fontName &&
          !item.unsupported &&
          !tableItems.has(item) &&
          !codeItems.has(item) &&
          item.font >= line.font * 0.75 &&
          item.font <= line.font * 1.05 &&
          Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
          (!prior ||
            (item.index > prior.index &&
              !all.some((part) => part.index > prior.index && part.index < item.index) &&
              item.x - prior.right >= -line.font * 0.05 &&
              item.x - prior.right < line.font * 0.15))
        )
      })
    )
      continue
    // Wrapped literal quantities are prose when an unfinished body row supplies
    // the context. Only the comparison/multiplier glyph may use a symbol font;
    // its operands and returning prose retain contiguous native body geometry.
    const proseQuantity =
      (/^[A-Za-z]{3,}\s+\(\d+(?:\.\d+)?×$/u.test(prefix) &&
        !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(prefix) &&
        /^(?:higher|lower|faster|slower|more|less)\s+[A-Za-z][^()[\]{}=<>≤≥+*/^]{3,}\)\s+[A-Za-z]{2,}/u.test(
          lineOf(line.items.slice(split)).text
        )) ||
      /^\([<>≤≥]\s*\d+(?:\.\d+)?[kKmMbB]?\s+(?:tokens?|samples?|parameters?|words?|sequences?)\)[.!?]$/u.test(
        line.text
      )
    if (
      proseQuantity &&
      previousLine &&
      line.items.filter((item) => /^(?:×|[<>≤≥])$/u.test(item.str)).length === 1 &&
      line.items.every((item, at) => {
        const previous = line.items[at - 1]
        return (
          Math.abs(item.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05 &&
          (!previous ||
            (item.index > previous.index &&
              !all.some((part) => part.index > previous.index && part.index < item.index) &&
              item.x - previous.right >= -line.font * 0.05 &&
              item.x - previous.right < line.font * 0.5))
        )
      }) &&
      continuousBodyWrap(
        previousLine,
        line,
        all,
        previousLine.x,
        previousLine.right,
        line.items.filter((item) => /^(?:×|[<>≤≥])$/u.test(item.str))
      )
    )
      continue
    // A parenthesized variable naming the preceding prose is an inline label,
    // not a display formula. Keep its closing bracket on the same native row;
    // require an uninterrupted body wrap and at most one lowered index.
    if (
      split >= 2 &&
      split <= 3 &&
      line.items[0].str === '(' &&
      /^[A-Za-z\p{Script=Greek}]$/u.test(line.items[1].str) &&
      Math.abs(line.items[1].font - line.font) < line.font * 0.05 &&
      Math.abs(line.items[1].originalBaseline - line.items[0].originalBaseline) <
        line.font * 0.05 &&
      /^\)\s+[a-z]{2,}\b/u.test(after.str) &&
      previousLine &&
      previousItem?.fontName &&
      !terminal(previousLine.text) &&
      !symbolicExpression(previousLine.text) &&
      previousLine.text.length > 40 &&
      Math.abs(previousLine.x - line.x) < line.font * 0.15 &&
      Math.abs(previousLine.right - line.right) < line.font &&
      line.baseline - previousLine.baseline > line.font * 0.75 &&
      line.baseline - previousLine.baseline < line.font * 1.7 &&
      previousItem.fontName === line.items[0].fontName &&
      after.fontName === line.items[0].fontName &&
      Math.abs(after.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05 &&
      (split === 2 ||
        (/^[A-Za-z\p{Script=Greek}\d]{1,2}$/u.test(before.str) &&
          before.font >= line.font * 0.5 &&
          before.font < line.font * 0.85 &&
          before.originalBaseline - line.items[1].originalBaseline > line.font * 0.08 &&
          before.originalBaseline - line.items[1].originalBaseline < line.font * 0.5)) &&
      line.items.slice(0, split + 1).every((item, index) => {
        const previous = index ? line.items[index - 1] : previousItem
        return (
          item.index > previous.index &&
          !all.some((other) => other.index > previous.index && other.index < item.index) &&
          (!index ||
            (item.x - previous.right >= -line.font * 0.05 &&
              item.x - previous.right < line.font * 0.5))
        )
      })
    )
      continue
    // A reported percentage can wrap before its metric and parenthesized
    // alternate value. The complete literal metric, unfinished adjacent body
    // row and returning font prove prose; standalone equations supply none.
    const wrappedPercentageMetric =
      /^[A-Z][A-Z0-9]{1,7}\s+\(\d+(?:\.\d+)?%\s+[A-Z][A-Z0-9]{1,7}\)\s+\p{Ll}{2,}\b/u.test(
        line.text
      ) &&
      previousLine &&
      !preservedFormulaLines.has(previousLine) &&
      [...previousLine.items, ...line.items].every(
        (item) => !codeItems.has(item) && !tableItems.has(item)
      ) &&
      !symbolicExpression(previousLine.text) &&
      /\d+(?:\.\d+)?%$/u.test(previousLine.text) &&
      previousLine.text.length > 40 &&
      Math.abs(previousLine.x - line.x) < line.font * 0.15 &&
      Math.abs(previousLine.right - line.right) < line.font &&
      line.baseline - previousLine.baseline > line.font * 0.75 &&
      line.baseline - previousLine.baseline < line.font * 1.7 &&
      previousLine.items.at(-1)!.fontName === line.items[0].fontName &&
      line.items.at(-1)!.fontName === line.items[0].fontName &&
      line.items.every((item, at) => {
        const previous = line.items[at - 1]
        const metricIndex =
          previous &&
          /[A-Z]{2,7}$/u.test(previous.str) &&
          /^\d{1,3}$/u.test(item.str) &&
          item.font > line.font * 0.6 &&
          item.font < line.font * 0.85 &&
          item.originalBaseline - previous.originalBaseline > line.font * 0.08 &&
          item.originalBaseline - previous.originalBaseline < line.font * 0.5
        return (
          item.fontName &&
          item.nativeLine === line.items[0].nativeLine &&
          (metricIndex ||
            (item.fontName === line.items[0].fontName &&
              Math.abs(item.font - line.font) < line.font * 0.05 &&
              Math.abs(item.originalBaseline - line.items[0].originalBaseline) <
                line.font * 0.05)) &&
          (!previous ||
            (item.index > previous.index &&
              !all.some((part) => part.index > previous.index && part.index < item.index) &&
              item.x - previous.right >= -line.font * 0.05 &&
              item.x - previous.right < line.font * 0.5))
        )
      })
    if (wrappedPercentageMetric) continue
    // A comparative clinical statistic may wrap before its final p-value.
    // The unfinished native bracket/ranges or confidence interval, plus a
    // complete decimal RHS closing that bracket, prove prose continuation.
    // Independent p equations and table cells have no such preceding body row.
    const statisticContext = previousLine && `${previousLine.text} ${prefix}`
    if (
      /\bp\s*=\s*$/u.test(prefix) &&
      /^(?:0?\.\d{1,5}|1(?:\.0{1,5})?)\][.,;:]?\s+(?!where\b)[A-Za-z]{2,}/u.test(
        lineOf(line.items.slice(split)).text
      ) &&
      previousLine &&
      statisticContext &&
      previousLine.text.length > 40 &&
      !terminal(previousLine.text) &&
      ((/\[[^\]]*$/u.test(statisticContext) &&
        /\bvs\.?\s+/u.test(statisticContext) &&
        (statisticContext.match(/\(\d+(?:\.\d+)?[–-]\d+(?:\.\d+)?\)/gu) ?? []).length >= 2) ||
        /\b95%\s+(?:confidence interval\s+)?CI,\s*[−-]?\d+(?:\.\d+)?\s+to\s*[−-]?\d+(?:\.\d+)?\)/u.test(
          statisticContext
        )) &&
      (Math.abs(previousLine.x - line.x) < line.font * 0.15 ||
        (previousLine.x > line.x &&
          previousLine.x - line.x < line.font * 1.7 &&
          Math.abs(previousLine.right - line.right) < line.font * 0.2)) &&
      line.baseline - previousLine.baseline > line.font * 0.75 &&
      line.baseline - previousLine.baseline < line.font * 1.7 &&
      Math.abs(previousLine.font - line.font) < line.font * 0.05 &&
      previousItem!.index < line.items[0].index &&
      !all.some((item) => item.index > previousItem!.index && item.index < line.items[0].index) &&
      line.items[0].fontName &&
      previousLine.items[0].fontName === line.items[0].fontName &&
      line.items.at(-1)!.fontName === line.items[0].fontName &&
      line.items.every((item, at) => {
        const previous = line.items[at - 1]
        return (
          item.fontName &&
          item.nativeLine === line.items[0].nativeLine &&
          Math.abs(item.font - line.font) < line.font * 0.05 &&
          Math.abs(item.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05 &&
          (!previous ||
            (item.index > previous.index &&
              !all.some((part) => part.index > previous.index && part.index < item.index) &&
              item.x - previous.right >= -line.font * 0.05 &&
              (item.x - previous.right < line.font * 0.5 ||
                (item.x - previous.right < line.font * 0.6 &&
                  item.str === 'p' &&
                  /,$/u.test(previous.str) &&
                  item.fontName !== previous.fontName &&
                  item.index === previous.index + 2 &&
                  !page.items[previous.index + 1].str.trim()))))
        )
      })
    ) {
      verifiedProseLines.add(previousLine)
      verifiedProseLines.add(line)
      continue
    }
    if (
      /^1\s*[−-]\s*β\s*=\s*(?:0?\.\d+|[01](?:\.0+)?),\s+[A-Za-z]{3,}/u.test(line.text) &&
      previousItem?.fontName &&
      previousLine &&
      /\bpower of$/u.test(previousLine.text) &&
      previousLine.text.split(/\s+/u).length >= 4 &&
      Math.abs(previousLine.x - line.x) < line.font * 0.3 &&
      line.baseline > previousLine.baseline + line.font * 0.8 &&
      line.baseline < previousLine.baseline + line.font * 1.8 &&
      previousItem.fontName === line.items[0].fontName &&
      after.fontName === previousItem.fontName &&
      after.index > before.index &&
      !all.some((item) => item.index > before.index && item.index < after.index) &&
      after.x - before.right >= -line.font * 0.05 &&
      after.x - before.right <= line.font * 0.5 &&
      line.items.every(
        (item) =>
          Math.abs(item.font - previousItem.font) < line.font * 0.05 &&
          Math.abs(item.originalBaseline - before.originalBaseline) < line.font * 0.05
      )
    )
      continue
    // A P value may wrap inside a still-open confidence interval sentence.
    // Native adjacency and the closed numeric probability prove this prose
    // continuation, without absorbing a standalone equation or definition.
    if (
      /^(?:[+−-]?(?:\d+(?:\.\d+)?|\.\d+)%?;\s*)?[pP]\s*[=<>≤≥]\s*(?:0?\.\d+|[01](?:\.0+)?)\)[,;]?\s*\(?[A-Za-z]{3,}/u.test(
        line.text
      ) &&
      previousItem?.fontName &&
      previousLine &&
      /\b(?:CI|confidence interval)\b/u.test(previousLine.text) &&
      previousLine.text.lastIndexOf('(') > previousLine.text.lastIndexOf(')') &&
      previousLine.text.split(/\s+/u).length >= 4 &&
      (Math.abs(previousLine.x - line.x) < line.font * 0.3 ||
        (/\b(?:CI|confidence interval)[^()]*\bto$/u.test(previousLine.text) &&
          /^[+−-]?(?:\d+(?:\.\d+)?|\.\d+)%?;\s*[pP]/u.test(line.text) &&
          previousLine.x >= line.x &&
          previousLine.x - line.x <= line.font * 1.5)) &&
      line.baseline > previousLine.baseline + line.font * 0.8 &&
      line.baseline < previousLine.baseline + line.font * 1.8 &&
      previousItem.fontName === after.fontName &&
      after.index > before.index &&
      !all.some((item) => item.index > before.index && item.index < after.index) &&
      after.x - before.right >= -line.font * 0.05 &&
      after.x - before.right <= line.font * 0.5 &&
      Math.abs(after.originalBaseline - before.originalBaseline) < line.font * 0.05
    )
      continue
    // A dose can begin on the next native row with its unclosed parenthesis.
    // A literal unit, complete closing parenthesis and adjacent body run prove
    // prose; named functions and symbolic definitions keep their boundary.
    if (
      /^[A-Za-z]{3,}\s+\([+−-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(prefix) &&
      !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/iu.test(prefix) &&
      /^(?:[μµu]?g|mg|kg|ml|mL)(?:\/(?:kg|min|h|day))?(?:\s+[A-Za-z]{3,}[^=<>≤≥]*)?\)[.,;:]?(?:\s+[A-Za-z]{2,}|$)/u.test(
        lineOf(line.items.slice(split)).text
      ) &&
      before.fontName &&
      after.fontName === before.fontName &&
      after.index > before.index &&
      !all.some((item) => item.index > before.index && item.index < after.index) &&
      after.x - before.right >= -line.font * 0.05 &&
      after.x - before.right <= line.font * 0.5 &&
      Math.abs(after.originalBaseline - before.originalBaseline) < line.font * 0.05
    )
      continue
    const timepoints = [
      ...line.text.matchAll(/\b(?:baseline|chemotherapy|surgery|follow-up)\s+\(T(\d+)\)/gu)
    ]
    const clinicalTimepoints =
      /^(?:baseline|chemotherapy|surgery|follow-up)\s+\(T\d+\)[,;]/u.test(line.text) &&
      new Set(timepoints.map((match) => match[1])).size > 1 &&
      !/\bwhere\b|[=+*/^<>≤≥−]/u.test(line.text)
    const mainBefore = line.items.slice(0, split).findLast((item) => item.font >= line.font * 0.8)
    if (
      !prefix.includes(')') &&
      (/^\(\d+(?:\.\d+)?\s+(?:min|minutes?|hours?|seconds?|days?|weeks?|months?|years?)\)[.,;:]?\s+(?!where\b)[A-Za-z]{2,}/u.test(
        line.text
      ) ||
        clinicalTimepoints ||
        /^\(RE-AIM\)[.,;:]?\s+(?!where\b)[A-Za-z]{2,}/u.test(line.text)) &&
      after.index > before.index &&
      !all.some((item) => item.index > before.index && item.index < after.index) &&
      after.x - before.right >= -line.font * 0.05 &&
      after.x - before.right <= line.font * 0.5 &&
      mainBefore &&
      Math.abs(after.originalBaseline - mainBefore.originalBaseline) < line.font * 0.05 &&
      (before.font >= line.font * 0.8 ||
        (clinicalTimepoints &&
          /^\d+$/u.test(before.str) &&
          before.font >= line.font * 0.45 &&
          Math.abs(before.originalBaseline - mainBefore.originalBaseline) <= line.font * 0.4))
    )
      continue
    // Italic p-values can split a parenthetical statistic across native runs.
    // Keep an unfinished statistic with its closing numeric value and prose;
    // complete equations and named function calls still split normally.
    if (
      /^(?:[a-z]{3,}\s+)?\((?:\d+(?:\.\d+)?%?\s+vs\.?\s+\d+(?:\.\d+)?%?,\s*)?[pP]\s*[=<>≤≥]\s*(?:0?\.\d+|[01])\)[.,;:]?\s+[A-Za-z]{2,}/u.test(
        line.text
      ) &&
      !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(line.text) &&
      !lineOf(line.items.slice(0, split)).text.includes(')') &&
      after.x - before.right <= line.font * 0.5 &&
      Math.abs(after.originalBaseline - before.originalBaseline) < line.font * 0.05
    )
      continue
    // A wrapped clinical sentence may resume with its SD/SE statistic. The
    // complete numeric parenthesis must close inside adjacent native prose;
    // symbolic operands, definitions and independent columns retain a boundary.
    if (
      /^\((?:SD|SE)\s*=\s*(?:\d+(?:\.\d+)?|\.\d+)%?\)[.,;:]?\s+(?!where\b)[A-Za-z]{2,}/u.test(
        line.text
      ) &&
      !lineOf(line.items.slice(0, split)).text.includes(')') &&
      after.index > before.index &&
      !all.some((item) => item.index > before.index && item.index < after.index) &&
      after.x - before.right <= line.font * 0.5 &&
      Math.abs(after.originalBaseline - before.originalBaseline) < line.font * 0.05
    )
      continue
    // A separately drawn operator can begin a wrapped prose definition.
    // It has no independent operands; keep it with adjacent baseline text.
    if (
      /^[+=−-]$/u.test(lineOf(line.items.slice(0, split)).text.trim()) &&
      after.x - before.right <= line.font * 0.5 &&
      Math.abs(after.originalBaseline - before.originalBaseline) < line.font * 0.05
    )
      continue
    if (
      /\d[.,]$/u.test(lineOf(line.items.slice(0, split)).text) &&
      /^\d/u.test(after.str) &&
      after.x - before.right <= line.font * 0.25 &&
      Math.abs(after.originalBaseline - before.originalBaseline) < line.font * 0.05
    )
      continue
    // A publisher may draw the opening citation bracket as its own object.
    // Punctuation alone is not a formula to separate from the following prose.
    if (
      /^[([]+$/u.test(lineOf(line.items.slice(0, split)).text.trim()) ||
      (romanList && romanMarker.test(line.text)) ||
      (arabicList && arabicMarker.test(line.text))
    )
      continue
    // PDF.js may split a terminal punctuation glyph from the prose that shares
    // its native PDF text object. Keep that punctuation on the prose side so
    // the writer can replace the complete object without touching the formula.
    while (split > 1) {
      const mark = line.items[split - 1],
        next = line.items[split]
      if (
        !/^[,.;:]+$/u.test(mark.str) ||
        mark.fontName !== next.fontName ||
        Math.abs(mark.originalBaseline - next.originalBaseline) > line.font * 0.05 ||
        next.x - mark.right > line.font
      )
        break
      split--
    }
    const formulaPrefix = lineOf(line.items.slice(0, split))
    if (formulaPrefix.items.some((item) => wordScripts.has(item))) {
      preservedFormulaLines.add(formulaPrefix)
      wordScriptFormulas.add(formulaPrefix)
    }
    const tail = lineOf(line.items.slice(split))
    lines.splice(index, 1, formulaPrefix, tail)
    formulaTails.add(tail)
    index++
  }
  const mathLines = lines.filter(
    (line) =>
      wordScriptFormulas.has(line) ||
      (!verifiedProseLines.has(line) && symbolicExpression(line.text))
  )
  // Inline equations followed by prose are serial native rows, not two
  // independent vertical columns. Preserve each row's equation/prose order
  // when considering a vertical merge with the next row.
  const inlineFormulaPartners = new Map<Line, Line>()
  for (const tail of formulaTails) {
    if (wordCount(tail.text) < 8 || /^\(/u.test(tail.text)) continue
    const firstTailIndex = Math.min(...tail.items.map((item) => item.index))
    const prefixes = mathLines.filter((prefix) => {
      const lastPrefixIndex = Math.max(...prefix.items.map((item) => item.index))
      return (
        prefix !== tail &&
        prefix.right <= tail.x + tail.font * 0.01 &&
        tail.x - prefix.right < tail.font * 0.5 &&
        [...prefix.items, ...tail.items].every(
          (item) =>
            item.nativeLine === tail.items[0].nativeLine &&
            Math.abs(item.originalBaseline - tail.baseline) < tail.font * 0.05
        ) &&
        lastPrefixIndex < firstTailIndex &&
        !all.some((item) => item.index > lastPrefixIndex && item.index < firstTailIndex)
      )
    })
    if (prefixes.length !== 1 || inlineFormulaPartners.has(prefixes[0])) continue
    inlineFormulaPartners.set(prefixes[0], tail)
    inlineFormulaPartners.set(tail, prefixes[0])
  }
  const detachedOperators = all.filter((item) => item.detachedOperator)
  const blocks: Block[] = []
  const completedHeadingWraps = new Set<Block>()
  const leadings = new Map<number, Map<number, number>>()
  const numbered = new Map<Line, number | undefined>(),
    styleBoundaries = new Set<Line>(),
    labelStarts = new Set<Line>()
  const fontWeights = new Map<string, number>()
  for (const item of all.filter((i) => !i.unsupported && i.fontName)) {
    fontWeights.set(item.fontName!, (fontWeights.get(item.fontName!) ?? 0) + item.str.length)
  }
  const bodyFontName = [...fontWeights].sort((a, b) => b[1] - a[1])[0]?.[0]
  // A separate en dash proves a hanging list only with a matching peer.
  // Inline abbreviation dashes and operands must not start new records.
  const dashRows = lines.filter(
    (line) =>
      line.items[0]?.str === '–' &&
      line.items[1] &&
      /^\p{L}/u.test(line.items[1].str) &&
      line.items[1].x - line.x > line.font * 0.45 &&
      line.items[1].x - line.x < line.font * 2
  )
  const dashLists = new Set(
    dashRows.filter((line) =>
      dashRows.some(
        (other) =>
          other !== line &&
          line.items[0].fontName !== undefined &&
          other.items[0].fontName === line.items[0].fontName &&
          other.items[1].fontName === line.items[1].fontName &&
          Math.abs(other.font - line.font) < line.font * 0.05 &&
          Math.abs(other.x - line.x) < line.font * 0.15 &&
          Math.abs(other.items[1].x - line.items[1].x) < line.font * 0.15 &&
          Math.abs(other.baseline - line.baseline) > line.font * 0.75 &&
          Math.abs(other.baseline - line.baseline) < line.font * 20
      )
    )
  )
  // Repeated raised numbers at the foot of a page start independent notes.
  // Their paired native text origins distinguish these markers from inline
  // powers; feed the proven starts into the existing numbered-record boundary.
  const symbolicFootnotes = ['∗', '†', '‡']
  const footnoteOrdinal = (line: Line): number =>
    symbolicFootnotes.includes(line.items[0].str)
      ? symbolicFootnotes.indexOf(line.items[0].str)
      : Number(line.items[0].str)
  const footnoteRows = lines.filter((line) => {
    const [marker, body] = line.items
    if (!body) return false
    const content = lineOf(line.items.slice(1)).text
    return (
      (/^[1-9]\d{0,2}$/u.test(marker.str) || symbolicFootnotes.includes(marker.str)) &&
      /^(?:[A-Z][A-Za-z’'.-]{2,}(?:\s|$)|https?:\/\/\S+)/u.test(body.str) &&
      (/^https?:\/\/\S+$/u.test(content) ||
        ((content.match(/\b[A-Za-z]*[a-z]{2,}[A-Za-z]*\b/gu)?.length ?? 0) >=
          (symbolicFootnotes.includes(marker.str) ? 2 : 4) &&
          /^[A-Za-z0-9\s.,:;’'"“”()[\]-]+$/u.test(content) &&
          !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(content) &&
          !/\b(?:[A-Za-z]|(?:arg)?min|(?:arg)?max|log|exp|sin|cos|tan|softmax|sigmoid)\s*\(/iu.test(
            content
          ))) &&
      line.baseline > page.height * 0.8 &&
      !!marker.fontName &&
      (marker.fontName === body.fontName || symbolicFootnotes.includes(marker.str)) &&
      marker.font > body.font * 0.55 &&
      marker.font < body.font * 0.8 &&
      body.originalBaseline - marker.originalBaseline > body.font * 0.2 &&
      body.originalBaseline - marker.originalBaseline < body.font * 0.6 &&
      body.x - marker.right >= -body.font * 0.01 &&
      body.x - marker.right < body.font * 0.15 &&
      line.items.every((part, index) => {
        const previous = line.items[index - 1]
        return (
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          !!part.fontName &&
          part.nativeLine === marker.nativeLine &&
          part.transform.length === 6 &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[0] - part.transform[3]) < body.font * 0.05 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001 &&
          (!index ||
            (Math.abs(part.font - body.font) < body.font * 0.05 &&
              Math.abs(part.originalBaseline - body.originalBaseline) < body.font * 0.05 &&
              part.index > previous.index &&
              part.x >= previous.right - body.font * 0.05 &&
              !all.some((other) => other.index > previous.index && other.index < part.index)))
        )
      })
    )
  })
  const footnoteStarts = new Set(
    footnoteRows.filter((line) =>
      footnoteRows.some(
        (other) =>
          other !== line &&
          symbolicFootnotes.includes(other.items[0].str) ===
            symbolicFootnotes.includes(line.items[0].str) &&
          Math.abs(footnoteOrdinal(other) - footnoteOrdinal(line)) === 1 &&
          (other.baseline - line.baseline) * (footnoteOrdinal(other) - footnoteOrdinal(line)) > 0 &&
          (other.items[0].index - line.items[0].index) *
            (footnoteOrdinal(other) - footnoteOrdinal(line)) >
            0 &&
          other.items[0].fontName === line.items[0].fontName &&
          other.items[1].fontName === line.items[1].fontName &&
          Math.abs(other.font - line.font) < line.font * 0.05 &&
          Math.abs(other.x - line.x) < line.font * 0.1 &&
          Math.abs(other.items[1].x - line.items[1].x) < line.font * 0.1 &&
          Math.abs(other.baseline - line.baseline) > line.font * 0.8 &&
          Math.abs(other.baseline - line.baseline) < line.font * 12
      )
    )
  )
  for (const line of lines) {
    const wrappedHeading =
      /^\d+(?:\.\d+)+\.?\s+\p{Lu}/u.test(line.text) &&
      (/\p{L}[-‐]$/u.test(line.text) ||
        (line.text.length > 40 && /^\d+(?:\.\d+)+\.?\s+[A-Z][A-Z0-9 :,-]+$/u.test(line.text)))
    if (
      wrappedHeading ||
      footnoteStarts.has(line) ||
      dashLists.has(line) ||
      /^(?:(?:\[\d{1,3}\]|\d{1,3}[.)])\s+\p{L}|[•●▪]\s+(?:\p{L}|\d{1,3}(?:[-‐]\p{L}|\p{Lu}{1,3}\b))|\d{1,3}:\s+\p{L})/u.test(
        line.text
      ) ||
      (romanList && romanMarker.test(line.text)) ||
      (arabicList && arabicMarker.test(line.text))
    ) {
      const content = line.items.find(
        (i) =>
          !/^(?:\[\d{1,3}\]|\d{1,3}[.):]|\d+(?:\.\d+)+\.?|[•●▪–∗†‡]|\((?:\d{1,3}|i{1,3}|iv|v|vi{1,3}|ix|x)\))$/.test(
            i.str.trim()
          )
      )
      numbered.set(line, content?.x)
    }
  }
  // On a References page, repeated native hanging indents identify entries.
  // Reuse the record boundary/continuation map instead of treating the first
  // indented bibliography row as a new paragraph. Context never crosses pages.
  const referenceHeadings = lines.filter(
    (line) =>
      /^(?:References|Bibliography)$/u.test(line.text) &&
      uninterruptedNativeRow(line) &&
      line.items.every(
        (part) =>
          part.fontName &&
          !part.unsupported &&
          part.transform.length === 6 &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[0] - part.transform[3]) < line.font * 0.05 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001
      )
  )
  const referenceWraps = lines.flatMap((first) => {
    const heading = referenceHeadings.findLast(
      (row) =>
        row.baseline < first.baseline &&
        row.items.at(-1)!.index < first.items[0].index &&
        row.font > first.font * 1.1 &&
        Math.abs(row.x - first.x) < first.font * 0.15
    )
    if (
      !heading ||
      !/^[A-Z]/u.test(first.text) ||
      !first.text.includes(',') ||
      !/^[\p{Script=Latin}\p{M}\d\s,.;:'’"“”()[\]–—-]+$/u.test(
        first.text.replace(/\b\d[\d,]*\+(?=\s+[a-z]{3,}\b)/gu, '0')
      ) ||
      /\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(first.text) ||
      wordCount(first.text) < 8 ||
      first.right - first.x < first.font * 15 ||
      lines.some(
        (row) =>
          row !== heading &&
          row.baseline > heading.baseline &&
          row.baseline < first.baseline &&
          Math.abs(row.x - first.x) < first.font * 0.15 &&
          wordCount(row.text) <= 12 &&
          /^[A-Z]/u.test(row.text) &&
          (row.font > first.font * 1.1 ||
            (row.items[0].fontName !== first.items[0].fontName &&
              row.items.every((part) => part.fontName === row.items[0].fontName)))
      )
    )
      return []
    const lastIndex = Math.max(...first.items.map((part) => part.index))
    const nextItem = all.find((part) => part.index > lastIndex)
    const next = nextItem && lines.find((row) => row.items.includes(nextItem))
    if (
      !next ||
      next.x - first.x < first.font * 0.6 ||
      next.x - first.x > first.font * 1.5 ||
      next.baseline - first.baseline < first.font * 0.8 ||
      next.baseline - first.baseline > first.font * 1.2 ||
      next.right > first.right + first.font * 0.15 ||
      next.items[0].nativeLine !== first.items[0].nativeLine + 1 ||
      !uninterruptedNativeRow(first) ||
      !uninterruptedNativeRow(next) ||
      [first, next].some(
        (row) =>
          preservedFormulaLines.has(row) ||
          mathLines.includes(row) ||
          all.some(
            (part) => part.nativeLine === row.items[0].nativeLine && !row.items.includes(part)
          ) ||
          row.items[0].fontName !== first.items[0].fontName ||
          row.items.at(-1)!.fontName !== first.items[0].fontName
      ) ||
      [...first.items, ...next.items].some(
        (part) =>
          !part.fontName ||
          part.unsupported ||
          tableItems.has(part) ||
          codeItems.has(part) ||
          Math.abs(part.font - first.font) > first.font * 0.05 ||
          part.transform.length !== 6 ||
          !part.transform.every(Number.isFinite) ||
          part.transform[0] <= 0 ||
          part.transform[3] <= 0 ||
          Math.abs(part.transform[0] - part.transform[3]) > first.font * 0.05 ||
          Math.abs(part.transform[1]) > 0.001 ||
          Math.abs(part.transform[2]) > 0.001
      )
    )
      return []
    return [{ heading, first, next }]
  })
  for (const candidate of referenceWraps) {
    if (
      referenceWraps.some(
        (other) =>
          other !== candidate &&
          other.heading === candidate.heading &&
          other.first.items[0].fontName === candidate.first.items[0].fontName &&
          Math.abs(other.first.font - candidate.first.font) < candidate.first.font * 0.05 &&
          Math.abs(other.first.x - candidate.first.x) < candidate.first.font * 0.15 &&
          Math.abs(other.next.x - candidate.next.x) < candidate.first.font * 0.15
      )
    )
      numbered.set(candidate.first, candidate.next.x)
  }
  for (const line of lines) {
    const first = line.items[0]
    const numberedSection =
      /^\d+(?:\.\d+)*$/u.test(first.str) &&
      line.items[1] &&
      /^\p{Lu}/u.test(line.items[1].str) &&
      line.items[1].x - first.right > line.font * 0.45 &&
      line.items[1].x - first.right < line.font * 3
    // A short styled label can start a new section after a completed line;
    // inline emphasis and same-font colons do not establish a paragraph boundary.
    if (
      bodyFontName &&
      first.fontName &&
      first.fontName !== bodyFontName &&
      (/^(?:\p{Lu}[\p{L} ]{1,39}|\p{Lu}[\p{L} ]{1,29} \d{1,3}(?: [\p{L} ]{1,20})?):\s*$/u.test(
        first.str
      ) ||
        /^(?:Definition|Theorem|Lemma|Proposition|Corollary|Assumption|Remark)\s+\d+(?:\.\d+)*[.:]?\s*$/u.test(
          first.str
        )) &&
      line.items.slice(1).some((item) => item.fontName === bodyFontName)
    )
      labelStarts.add(line)
    // A short styled run-in heading without a colon starts a new paragraph
    // after a completed native body row. Require actual paragraph leading and
    // a same-row return to the body font; inline emphasis proves no boundary.
    const returnToBody = line.items[1]
    if (
      bodyFontName &&
      first.fontName &&
      first.fontName !== bodyFontName &&
      /^(?:\p{Lu}[\p{L}’'-]{1,24}\s+){1,4}\p{Lu}[\p{L}’'-]{1,24}$/u.test(first.str) &&
      returnToBody?.fontName === bodyFontName &&
      /^\p{Lu}[\p{L}’'-]{2,}/u.test(returnToBody.str) &&
      wordCount(lineOf(line.items.slice(1)).text) >= 7 &&
      returnToBody.x - first.right > line.font * 0.3 &&
      uninterruptedNativeRow(line) &&
      line.items.every(
        (part) =>
          part.fontName &&
          !part.unsupported &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          Math.abs(part.font - line.font) < line.font * 0.05 &&
          (part === first || part.fontName === bodyFontName)
      )
    ) {
      const previousItem = all.findLast((part) => part.index < first.index)
      const previous = previousItem && lines.find((row) => row.items.includes(previousItem))
      if (
        previous &&
        previous.items.at(-1) === previousItem &&
        previous.items.every((part) => part.fontName === bodyFontName) &&
        wordCount(previous.text) >= 7 &&
        terminal(previous.text) &&
        Math.abs(previous.font - line.font) < line.font * 0.05 &&
        Math.abs(previous.x - line.x) < line.font * 0.15 &&
        line.baseline - previous.baseline > line.font * 1.4 &&
        line.baseline - previous.baseline < line.font * 2.4
      )
        labelStarts.add(line)
    }
    const fonts = new Set(line.items.filter((i) => i.str.trim()).map((i) => i.fontName))
    if (
      !bodyFontName ||
      fonts.size !== 1 ||
      fonts.has(bodyFontName) ||
      fonts.has(undefined) ||
      (!numberedSection && !/^\p{Lu}/u.test(line.text)) ||
      line.text.replace(/[^\p{L}]/gu, '').length < 3 ||
      line.text.split(/\s+/).length > 12 ||
      line.text.length > 100
    )
      continue
    const next = lines
      .filter(
        (other) =>
          other.baseline > line.baseline + line.font * 0.7 &&
          other.baseline < line.baseline + line.font * 3.1 &&
          Math.abs(other.font - line.font) < line.font * 0.15 &&
          Math.abs(other.x - line.x) < line.font * 3 + 0.5
      )
      .sort((a, b) => a.baseline - b.baseline)[0]
    // Standalone short headings may be the same size and left edge as body
    // text. Require a native style change, a much shorter heading, and direct
    // native succession to a long body row; a numeric prefix alone proves none.
    const lastNativeIndex = Math.max(...line.items.map((item) => item.index))
    const nextNativeIndex = next && Math.min(...next.items.map((item) => item.index))
    // Floating tables can be drawn before the body below a numbered heading.
    // Only already-owned table/caption objects wholly outside that body column
    // may interrupt native order; left-column text and unknown objects cannot.
    const interlude = next
      ? all.filter((item) => item.index > lastNativeIndex && item.index < nextNativeIndex!)
      : []
    const captionItems = new Set([...captionProseLines].flatMap((row) => row.items))
    const floatingTableInterlude =
      numberedSection &&
      next &&
      interlude.some((item) => tableItems.has(item)) &&
      interlude.some((item) => captionItems.has(item)) &&
      interlude.every(
        (item) =>
          !item.unsupported &&
          item.x > next.right + line.font * 0.5 &&
          (tableItems.has(item) || captionItems.has(item))
      )
    const sameEdgeHeading =
      next &&
      (numberedSection || /^[\p{Lu}][\p{L} ’'-]{2,44}$/u.test(line.text)) &&
      !terminal(line.text) &&
      wordCount(line.text) <= 6 &&
      wordCount(next.text) >= 8 &&
      /^\p{Lu}/u.test(next.text) &&
      line.right - line.x < (next.right - next.x) * (numberedSection ? 1 : 0.55) &&
      Math.abs(next.x - line.x) < line.font * 0.15 &&
      next.baseline - line.baseline > line.font * 1.1 &&
      [...line.items, ...next.items].every(
        (item) => Math.abs(item.font - line.font) < line.font * 0.1
      ) &&
      next.items[0].fontName === bodyFontName &&
      next.items.every(
        (item) =>
          item.fontName === bodyFontName ||
          (numberedSection &&
            /^[A-Z]{2,7}s?$/u.test(item.str) &&
            next.text.includes(`(${item.str})`) &&
            uninterruptedNativeRow(next) &&
            next.items.filter((part) => part.fontName !== bodyFontName).length === 1)
      ) &&
      nextNativeIndex !== undefined &&
      lastNativeIndex < nextNativeIndex &&
      (!interlude.length || floatingTableInterlude)
    // Opaque font IDs signal a style change, not a particular font weight or semantic role.
    if (
      next &&
      next.items.some((i) => i.fontName === bodyFontName) &&
      (sameEdgeHeading ||
        (!numberedSection &&
          (next.x > line.x + line.font * 0.45 ||
            numbered.has(next) ||
            (line.font > next.font * 1.05 && !terminal(line.text) && /^\p{Lu}/u.test(next.text)))))
    )
      styleBoundaries.add(line)
  }
  for (const line of lines.filter((l) => l.text.length >= 40)) {
    const next = lines
      .filter(
        (other) =>
          other.text.length >= 40 &&
          Math.abs(other.font - line.font) < line.font * 0.1 &&
          Math.abs(other.x - line.x) < line.font * 3 + 0.5 &&
          other.baseline - line.baseline > line.font * 0.75 &&
          other.baseline - line.baseline < line.font * 3.1
      )
      .sort((a, b) => a.baseline - b.baseline)[0]
    if (!next) continue
    const font = Math.round(line.font * 2),
      ratio = Math.round(((next.baseline - line.baseline) / line.font) * 10) / 10
    if (!leadings.has(font)) leadings.set(font, new Map())
    const counts = leadings.get(font)!
    counts.set(ratio, (counts.get(ratio) ?? 0) + 1)
  }
  const pageFont = median(all.map((item) => item.font))
  // Some publishers draw hanging list arrows in a separate symbol font.
  // Repeated aligned markers plus their adjacent prose prove list ownership;
  // a lone implication arrow or an equation never establishes a list here.
  const arrowCandidates = lines.flatMap((line) => {
    const marker = line.items[0],
      content = line.items[1]
    return marker &&
      content &&
      marker.str === '⇒' &&
      marker.fontName &&
      content.fontName &&
      marker.fontName !== content.fontName &&
      marker.index < content.index &&
      !all.some((item) => item.index > marker.index && item.index < content.index) &&
      marker.font <= content.font &&
      content.x - marker.x > content.font * 0.75 &&
      content.x - marker.x < content.font * 2 &&
      content.x - marker.right < content.font * 0.6 &&
      Math.abs(marker.originalBaseline - content.originalBaseline) < content.font * 0.05 &&
      /^\p{Lu}/u.test(content.str) &&
      content.str.replace(/[^\p{L}]/gu, '').length > 30 &&
      !symbolicExpression(lineOf(line.items.slice(1)).text) &&
      line.items.slice(1).every((item) => item.fontName === content.fontName)
      ? [{ line, marker, content }]
      : []
  })
  const arrowRows = new Map(
    arrowCandidates
      .filter((candidate) =>
        arrowCandidates.some(
          (other) =>
            other !== candidate &&
            other.marker.fontName === candidate.marker.fontName &&
            other.content.fontName === candidate.content.fontName &&
            Math.abs(other.content.font - candidate.content.font) < candidate.content.font * 0.05 &&
            Math.abs(other.marker.x - candidate.marker.x) < candidate.content.font * 0.15 &&
            Math.abs(other.content.x - candidate.content.x) < candidate.content.font * 0.15 &&
            Math.abs(other.line.baseline - candidate.line.baseline) >
              candidate.content.font * 0.75 &&
            Math.abs(other.line.baseline - candidate.line.baseline) < candidate.content.font * 20
        )
      )
      .map(({ line, content }) => [line, content])
  )
  const arrowBulletWrap = (block: Block, line: Line): boolean => {
    const content = arrowRows.get(block.lines[0]),
      last = block.lines.at(-1)!,
      lastIndex = Math.max(...last.items.map((item) => item.index)),
      nextIndex = Math.min(...line.items.map((item) => item.index))
    return (
      !!content &&
      !arrowRows.has(line) &&
      !terminal(last.text) &&
      line.baseline - last.baseline > content.font * 0.75 &&
      line.baseline - last.baseline < content.font * 1.6 &&
      Math.abs(line.x - content.x) < content.font * 0.15 &&
      line.items.every(
        (item) =>
          item.fontName === content.fontName &&
          Math.abs(item.font - content.font) < content.font * 0.05
      ) &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex)
    )
  }
  const paperTitleWrap = (block: Block, line: Line): boolean => {
    const last = block.lines.at(-1)!,
      lastIndex = Math.max(...last.items.map((item) => item.index)),
      nextIndex = Math.min(...line.items.map((item) => item.index))
    return (
      block.y < page.height * 0.25 &&
      block.font > pageFont * 1.25 &&
      !terminal(last.text) &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex) &&
      block.right - block.x > page.width * 0.5 &&
      (Math.abs((line.x + line.right - block.x - block.right) / 2) < block.font * 0.5 ||
        // A left-aligned title can end with a narrow, unpunctuated word.
        // Native adjacency keeps nearby author/affiliation rows independent.
        (Math.abs(line.x - block.x) < block.font * 0.15 && /^\p{Ll}/u.test(line.text))) &&
      block.items[0].fontName !== undefined &&
      line.items.every((item) => item.fontName === block.items[0].fontName)
    )
  }
  const dashBulletWrap = (block: Block, line: Line): boolean => {
    const first = block.lines[0],
      content = first.items[1],
      last = block.lines.at(-1)!,
      lastIndex = Math.max(...last.items.map((item) => item.index)),
      nextIndex = Math.min(...line.items.map((item) => item.index))
    return (
      dashLists.has(first) &&
      !dashLists.has(line) &&
      !terminal(last.text) &&
      Math.abs(line.x - content.x) < content.font * 0.15 &&
      line.items[0].fontName === content.fontName &&
      Math.abs(line.font - content.font) < content.font * 0.05 &&
      line.baseline - last.baseline > content.font * 0.75 &&
      line.baseline - last.baseline < content.font * 1.7 &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex)
    )
  }
  // A publisher may justify a bullet as multiple native word runs, including
  // a combined bullet/count. Their same type and contiguous wrap prove ownership.
  const inlineBulletWrap = (block: Block, line: Line): boolean => {
    const first = block.lines[0],
      last = block.lines.at(-1)!,
      lastIndex = Math.max(...last.items.map((item) => item.index)),
      nextIndex = Math.min(...line.items.map((item) => item.index))
    return (
      ((first.items.length === 1 &&
        /^[•●▪]\s+(?:\p{L}|\d{1,3}(?:[-‐]\p{L}|\p{Lu}{1,3}\b))/u.test(first.items[0].str) &&
        !terminal(first.text)) ||
        (first.items.length > 1 &&
          /^[•●▪]\s+(?:\p{L}|\d+(?:%|\b))/u.test(first.items[0].str) &&
          !terminal(last.text) &&
          first.items[0].fontName !== undefined &&
          (block.lines.length === 1 ? line.items.slice(0, 1) : line.items).some(
            (item) =>
              item.fontName === first.items[0].fontName &&
              Math.abs(item.font - first.items[0].font) < line.font * 0.05
          ))) &&
      line.x > first.x + line.font * 0.45 &&
      line.x < first.x + line.font * 2 &&
      (block.lines.length === 1 || Math.abs(line.x - last.x) < line.font * 0.3) &&
      (block.lines.length > 1 ||
        Math.abs(line.right - first.right) < line.font * 1.5 ||
        // A short terminal noun phrase can complete an unfinished bullet.
        // Its styled single-letter label stays between ordinary body words;
        // scripts, operands and independently placed rows provide no proof.
        (block.lines.length === 1 &&
          /^[•●▪] (?:[A-Za-z][A-Za-z‐-]*\s+){5,}(?:the|a|an)$/u.test(first.text) &&
          /^[a-z]{3,} [A-Z] [a-z]{3,}[.!?]$/u.test(line.text) &&
          line.baseline - last.baseline > line.font * 0.75 &&
          line.baseline - last.baseline < line.font * 1.7 &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          line.items[0].fontName === first.items[0].fontName &&
          line.items.at(-1)!.fontName === first.items[0].fontName &&
          [...last.items, ...line.items].every(
            (item) =>
              item.fontName &&
              !item.unsupported &&
              item.transform.every(Number.isFinite) &&
              item.transform[0] > 0 &&
              item.transform[3] > 0 &&
              Math.abs(item.transform[1]) < line.font * 0.001 &&
              Math.abs(item.transform[2]) < line.font * 0.001 &&
              Math.abs(item.font - line.font) < line.font * 0.05 &&
              (item.fontName === first.items[0].fontName || /^[A-Z]$/u.test(item.str))
          )) ||
        // Numeric compound labels can wrap to a shorter terminal prose line.
        // Keep the same native type, unfinished bullet and immediate ownership.
        (/^[•●▪]\s+\d{1,3}(?:[-‐]\p{L}|\p{Lu}{1,3}\b)/u.test(first.text) &&
          /^\p{Ll}/u.test(line.text) &&
          line.text.length > 40 &&
          terminal(line.text) &&
          first.items[0].fontName !== undefined &&
          [...last.items, ...line.items].every(
            (item) => item.fontName === first.items[0].fontName
          ))) &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex) &&
      !numbered.has(line)
    )
  }
  const bundledNumberWrap = (block: Block, line: Line): boolean => {
    const first = block.lines[0],
      last = block.lines.at(-1)!,
      marker = /^(\d{1,3})[.)]\s+\p{Lu}/u.exec(first.items[0].str)
    const pageStartProse =
      marker &&
      first.baseline < page.height * 0.2 &&
      Number(marker[1]) > 1 &&
      /^\d{1,3}[.)]\s+(?:Finally|Additionally|Moreover),\s+(?:we|We)\s+/u.test(first.text)
    // Some publishers draw a list number and its body in one text object.
    // A matching adjacent number proves the list. At a page start, an explicit
    // numbered prose transition can instead prove a continued list. Both paths
    // require the same native row, typography and bounded hanging-indent proof.
    return Boolean(
      marker &&
      first.items.length === 1 &&
      numbered.has(first) &&
      !numbered.has(line) &&
      first.items[0].fontName &&
      first.items[0].fontName === bodyFontName &&
      wordCount(first.text) >= 8 &&
      (block.lines.length > 1 || !terminal(last.text)) &&
      (block.lines.length > 1 || /^\p{Ll}[\p{L}’'-]{1,}\s+/u.test(line.text)) &&
      wordCount(line.text) >= (block.lines.length > 1 ? (pageStartProse ? 2 : 3) : 6) &&
      !symbolicExpression(line.text) &&
      line.x - first.x > line.font * 0.45 &&
      line.x - first.x < line.font * 2 &&
      (block.lines.length === 1 || Math.abs(line.x - last.x) < line.font * 0.15) &&
      line.baseline - last.baseline > line.font * 0.75 &&
      line.baseline - last.baseline < line.font * 1.6 &&
      line.items[0].fontName === first.items[0].fontName &&
      line.items.at(-1)?.fontName === first.items[0].fontName &&
      line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
      [...last.items, ...line.items].every(
        (part, at, parts) =>
          !part.unsupported &&
          !!part.fontName &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001 &&
          part.font > line.font * 0.6 &&
          part.font < line.font * 1.05 &&
          Math.abs(
            part.originalBaseline -
              (part.nativeLine === last.items[0].nativeLine ? last.baseline : line.baseline)
          ) <
            line.font * 0.3 &&
          (part.nativeLine === last.items[0].nativeLine ||
            part.nativeLine === line.items[0].nativeLine) &&
          (!at ||
            (part.index > parts[at - 1].index &&
              !all.some((other) => other.index > parts[at - 1].index && other.index < part.index)))
      ) &&
      (lines.some((peer) => {
        const other = /^(\d{1,3})[.)]\s+\p{Lu}/u.exec(peer.items[0].str)
        return (
          other &&
          Math.abs(Number(other[1]) - Number(marker[1])) === 1 &&
          (peer.baseline - first.baseline) * (Number(other[1]) - Number(marker[1])) > 0 &&
          Math.abs(peer.baseline - first.baseline) < line.font * 12 &&
          Math.abs(peer.x - first.x) < line.font * 0.15 &&
          peer.items[0].fontName === first.items[0].fontName &&
          wordCount(peer.text) >= 6
        )
      }) ||
        pageStartProse)
    )
  }
  const hangingLabelWrap = (block: Block, line: Line): boolean => {
    const first = block.lines[0],
      last = block.lines.at(-1)!,
      lastIndex = Math.max(...last.items.map((item) => item.index)),
      nextIndex = Math.min(...line.items.map((item) => item.index))
    const label = first.items[0],
      body = first.items.slice(1),
      bodyFont = body.at(-1)?.fontName
    // Run-in fields use a bold label followed by a body font and a stable
    // hanging indent. Native adjacency distinguishes wraps from another field.
    const styledField =
      /^\p{Lu}[\p{L} ]{1,39}(?: \d{1,3})?:$/u.test(label.str.trim()) &&
      body.length > 0 &&
      bodyFont !== undefined &&
      label.fontName !== undefined &&
      label.fontName !== bodyFont &&
      wordCount(body.map((item) => item.str).join(' ')) >= 6 &&
      line.x - first.x < line.font * 3 &&
      line.baseline - last.baseline > line.font * 0.75 &&
      line.baseline - last.baseline < line.font * 1.6 &&
      [...body, ...line.items].every(
        (item) => item.fontName === bodyFont && Math.abs(item.font - line.font) < line.font * 0.05
      ) &&
      last.items.at(-1)?.fontName === bodyFont &&
      Math.abs(label.font - line.font) < line.font * 0.05 &&
      first.items.every(
        (item) => Math.abs(item.originalBaseline - label.originalBaseline) < line.font * 0.05
      ) &&
      line.items.every(
        (item) =>
          Math.abs(item.originalBaseline - line.items[0].originalBaseline) < line.font * 0.05
      ) &&
      wordCount(line.text) >= 2 &&
      !symbolicExpression(line.text)
    const statementStart = first.items.findIndex(
      (part, index) =>
        index > 0 &&
        part.fontName === bodyFontName &&
        part.fontName !== label.fontName &&
        !attachedScripts.has(part)
    )
    const statementLabel =
        statementStart > 0 ? lineOf(first.items.slice(0, statementStart)) : undefined,
      statementBody = statementStart > 0 ? first.items.slice(statementStart) : [],
      statementText = statementStart > 0 ? lineOf(statementBody).text : ''
    // A same-row styled statement can introduce a hanging body paragraph.
    // Native style return and the full right edge distinguish its continuation
    // from an independent heading followed by an indented paragraph.
    const styledStatement =
      statementLabel !== undefined &&
      !captionLabel.test(statementLabel.text) &&
      /^[A-Z][A-Za-z0-9 ’'(),/‐-]+\.$/u.test(statementLabel.text) &&
      wordCount(statementLabel.text) >= 5 &&
      /^[A-Z][A-Za-z ’',‐-]+$/u.test(statementText) &&
      wordCount(statementText) >= 4 &&
      /^\p{Ll}/u.test(line.text) &&
      wordCount(line.text) >= (block.lines.length > 1 ? 3 : 6) &&
      !symbolicExpression(line.text) &&
      !!label.fontName &&
      !!bodyFontName &&
      line.x - first.x > line.font * 2 &&
      line.x - first.x < line.font * 4 &&
      (block.lines.length > 1 || Math.abs(line.right - first.right) < line.font * 0.15) &&
      line.baseline - last.baseline > line.font * 0.75 &&
      line.baseline - last.baseline < line.font * 1.6 &&
      uninterruptedNativeRow(line) &&
      line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
      first.items.every((part, index) => {
        const base = first.items[index - 1]
        return (
          part.nativeLine === label.nativeLine &&
          (!base ||
            (part.index > base.index &&
              !all.some((other) => other.index > base.index && other.index < part.index))) &&
          (attachedScripts.has(part)
            ? base &&
              /^[0-9]{1,2}$/u.test(part.str) &&
              part.font > line.font * 0.6 &&
              part.font < line.font * 0.85 &&
              part.x - base.right >= -line.font * 0.05 &&
              part.x - base.right < line.font * 0.15 &&
              part.originalBaseline - base.originalBaseline > line.font * 0.08 &&
              part.originalBaseline - base.originalBaseline < line.font * 0.3
            : part.fontName === (index < statementStart ? label.fontName : bodyFontName) &&
              Math.abs(part.font - line.font) < line.font * 0.05 &&
              Math.abs(part.originalBaseline - label.originalBaseline) < line.font * 0.05)
        )
      }) &&
      [...first.items, ...last.items, ...line.items].every(
        (part) =>
          !part.unsupported &&
          !!part.fontName &&
          !tableItems.has(part) &&
          !codeItems.has(part) &&
          part.transform.every(Number.isFinite) &&
          part.transform[0] > 0 &&
          part.transform[3] > 0 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001
      ) &&
      [...statementBody, ...(block.lines.length > 1 ? last.items : []), ...line.items].every(
        (part) =>
          part.fontName === bodyFontName &&
          Math.abs(part.font - line.font) < line.font * 0.05 &&
          Math.abs(
            part.originalBaseline -
              (part.nativeLine === first.items[0].nativeLine
                ? first.baseline
                : part.nativeLine === last.items[0].nativeLine
                  ? last.baseline
                  : line.baseline)
          ) <
            line.font * 0.05
      )
    return (
      (styledField ||
        styledStatement ||
        (captionLabel.test(first.text) &&
          line.x - first.x < line.font * 8 &&
          (Math.abs(line.right - first.right) < line.font * 2 || block.lines.length > 1))) &&
      !terminal(last.text) &&
      line.x > first.x + line.font * 0.45 &&
      (block.lines.length === 1 || Math.abs(line.x - last.x) < line.font * 0.45) &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex)
    )
  }
  const numberedHeadingWrap = (block: Block, line: Line): boolean => {
    const first = block.lines[0],
      last = block.lines.at(-1)!,
      contentX = numbered.get(first),
      lastIndex = Math.max(...last.items.map((item) => item.index)),
      nextIndex = Math.min(...line.items.map((item) => item.index))
    // A numbered heading can wrap without hyphenation or uppercase styling.
    // Its separately drawn number establishes the exact hanging text origin;
    // matching non-body type and uninterrupted ownership exclude body/list rows.
    const title = first.items[1]
    if (
      block.lines.length === 1 &&
      /^\d+(?:\.\d+)*\.?$/u.test(first.items[0].str.trim()) &&
      title &&
      /^\p{Lu}/u.test(title.str) &&
      wordCount(first.text) >= 4 &&
      !terminal(first.text) &&
      /^[\p{L}][\p{L} ’'-]{2,59}\??$/u.test(line.text) &&
      wordCount(line.text) <= 6 &&
      title.x - first.x > line.font * 0.45 &&
      title.x - first.x < line.font * 4 &&
      Math.abs(line.x - title.x) < line.font * 0.15 &&
      line.baseline - last.baseline > line.font * 0.75 &&
      line.baseline - last.baseline < line.font * 1.6 &&
      bodyFontName !== undefined &&
      title.fontName !== undefined &&
      title.fontName !== bodyFontName &&
      [...first.items, ...line.items].every(
        (item) =>
          item.fontName === title.fontName && Math.abs(item.font - line.font) < line.font * 0.05
      ) &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex)
    )
      return true
    // A full-width numbered small-caps heading can end with a narrow word.
    // Its exact hanging x, same native font and uninterrupted row order prove
    // that word belongs to the heading, rather than the following body section.
    if (
      block.lines.length === 1 &&
      contentX !== undefined &&
      first.text.length > 40 &&
      /^\d+(?:\.\d+)+\.?\s+[A-Z][A-Z0-9 :,-]+$/u.test(first.text) &&
      /^[A-Z]{3,}(?:\s+[A-Z]{3,}){0,3}$/u.test(line.text) &&
      Math.abs(line.x - contentX) < line.font * 0.15 &&
      line.baseline - last.baseline > line.font * 0.75 &&
      line.baseline - last.baseline < line.font * 1.6 &&
      last.items[0].fontName &&
      [...last.items, ...line.items].every((item) => item.fontName === last.items[0].fontName) &&
      lastIndex < nextIndex &&
      !all.some((item) => item.index > lastIndex && item.index < nextIndex)
    )
      return true
    return (
      contentX !== undefined &&
      /^\d+(?:\.\d+)+\.?\s+\p{Lu}/u.test(first.text) &&
      /\p{L}[-‐]$/u.test(last.text) &&
      /^\p{L}/u.test(line.text) &&
      (Math.abs(line.x - contentX) < line.font * 0.45 ||
        // Some PDFs draw the number and heading in one run, so the content's
        // x position is unavailable. A bounded hanging indent and immediate
        // native continuation still prove this short hyphenated wrap.
        (block.lines.length === 1 &&
          first.items.length === 1 &&
          line.x > first.x &&
          line.x - first.x < line.font * 3 &&
          lastIndex < nextIndex &&
          !all.some((item) => item.index > lastIndex && item.index < nextIndex))) &&
      last.items[0].fontName !== undefined &&
      last.items[0].fontName !== bodyFontName &&
      [...last.items, ...line.items].every((item) => item.fontName === last.items[0].fontName)
    )
  }
  const dropCapWrap = (block: Block, line: Line): boolean => {
    const cap = block.lines[0]?.items.find((item) => dropCaps.has(item)),
      first = cap && dropCaps.get(cap)
    if (!cap || !first || line.baseline > cap.originalBaseline + line.font * 0.1) return false
    const previous = Math.max(...block.items.map((item) => item.index)),
      next = Math.min(...line.items.map((item) => item.index))
    return (
      Math.abs(line.x - first.x) < line.font * 0.15 &&
      previous < next &&
      !all.some((item) => item.index > previous && item.index < next)
    )
  }
  // A native parent/child section pair establishes two independent headings.
  // Their shared type and aligned, uninterrupted rows remain boundaries even
  // when repeated heading spacing dominates the page's learned body leading.
  const nativeSectionHeadings = new Set<Line>()
  const nativeHeadingRow = (line: Line): boolean =>
    line.items.every(
      (item, index) =>
        item.nativeLine === line.items[0].nativeLine &&
        Math.abs(item.originalBaseline - line.baseline) < line.font * 0.05 &&
        (!index ||
          (item.index > line.items[index - 1].index &&
            !all.some(
              (part) => part.index > line.items[index - 1].index && part.index < item.index
            ) &&
            item.x - line.items[index - 1].right >= -line.font * 0.05 &&
            item.x - line.items[index - 1].right < line.font * (index === 1 ? 1.5 : 0.8)))
    )
  for (const parent of lines) {
    const label = /^([A-Z](?:\.\d+)+|\d+(?:\.\d+)+)\.?\s+\p{Lu}/u.exec(parent.text)?.[1]
    if (!label || wordCount(parent.text) < 3 || !nativeHeadingRow(parent)) continue
    const lastIndex = Math.max(...parent.items.map((item) => item.index))
    for (const child of lines) {
      const childLabel = /^([A-Z](?:\.\d+)+|\d+(?:\.\d+)+)\.?\s+\p{Lu}/u.exec(child.text)?.[1]
      if (
        !childLabel ||
        !childLabel.startsWith(label + '.') ||
        childLabel.split('.').length !== label.split('.').length + 1 ||
        wordCount(child.text) < 3 ||
        !nativeHeadingRow(child) ||
        Math.abs(parent.x - child.x) >= child.font * 0.15 ||
        Math.abs(parent.font - child.font) >= child.font * 0.05 ||
        child.baseline - parent.baseline <= child.font * 1.3 ||
        child.baseline - parent.baseline >= child.font * 3 ||
        !parent.items[0].fontName ||
        !child.items[0].fontName
      )
        continue
      const nextIndex = Math.min(...child.items.map((item) => item.index))
      if (
        nextIndex <= lastIndex ||
        all.some((item) => item.index > lastIndex && item.index < nextIndex) ||
        [parent, child].some((row) =>
          row.items.some(
            (item) =>
              item.unsupported ||
              item.fontName !== row.items[0].fontName ||
              Math.abs(item.font - child.font) >= child.font * 0.05 ||
              attachedScripts.has(item) ||
              tableItems.has(item) ||
              codeItems.has(item)
          )
        )
      )
        continue
      nativeSectionHeadings.add(parent)
      nativeSectionHeadings.add(child)
    }
  }
  // A complete PDF text row may be split into prose and formula fragments.
  // Preserve only rows whose full native bridge and separate body peer prove
  // a single column; three disconnected prose fragments are not evidence.
  const nativeInlineRows: { items: Item[]; lines: Set<Line>; font: number }[] = []
  const inlineNativeInventory = new Map<number, typeof all>()
  for (const item of all) {
    const row = inlineNativeInventory.get(item.nativeLine) ?? []
    row.push(item)
    inlineNativeInventory.set(item.nativeLine, row)
  }
  for (const row of inlineNativeInventory.values()) {
    const first = row[0],
      last = row.at(-1)!,
      font = first.font
    if (
      row.length < 4 ||
      !last.hasEOL ||
      !first.fontName ||
      first.fontName !== last.fontName ||
      wordCount(first.str) < 3 ||
      wordCount(last.str) < 4 ||
      symbolicExpression(first.str) ||
      symbolicExpression(last.str) ||
      Math.abs(last.font - font) > font * 0.05 ||
      Math.abs(last.originalBaseline - first.originalBaseline) > font * 0.05 ||
      row.some(
        (item, index) =>
          item.unsupported ||
          tableItems.has(item) ||
          codeItems.has(item) ||
          embeddedMetadata.has(item) ||
          plotTicks.has(item) ||
          item.font < font * 0.6 ||
          item.font > font * 1.05 ||
          Math.abs(item.originalBaseline - first.originalBaseline) > font * 0.45 ||
          (index > 0 &&
            (item.x - row[index - 1].right < -font * 0.05 ||
              item.x - row[index - 1].right >= font * 0.8))
      )
    )
      continue
    const rowBounds = bounds(row),
      rowItems = new Set<Item>(row)
    if (
      all.some(
        (item) =>
          !rowItems.has(item) &&
          item.x < rowBounds.right &&
          item.right > rowBounds.x &&
          item.y < rowBounds.bottom &&
          item.bottom > rowBounds.y
      )
    )
      continue
    const parts = lines.filter((line) => line.items.some((item) => rowItems.has(item)))
    if (
      parts.length < 2 ||
      parts.some((line) => line.items.some((item) => !rowItems.has(item))) ||
      row.some(
        (item) =>
          parts.filter((line) => line.items.includes(item)).length !==
          (item.detachedOperator ? 0 : 1)
      )
    )
      continue
    // Each exposed fragment must own a complete consecutive interval of the row.
    if (
      parts.some((line) => {
        const start = Math.min(...line.items.map((item) => item.index)),
          end = Math.max(...line.items.map((item) => item.index))
        return row.some(
          (item) => item.index >= start && item.index <= end && !line.items.includes(item)
        )
      })
    )
      continue
    const peer = lines.some(
      (line) =>
        line.items[0].nativeLine !== first.nativeLine &&
        wordCount(line.text) >= 12 &&
        !symbolicExpression(line.text) &&
        Math.abs(line.x - rowBounds.x) < font * 0.45 &&
        Math.abs(line.right - rowBounds.right) < font * 0.45 &&
        Math.abs(line.baseline - first.originalBaseline) > font * 0.75 &&
        Math.abs(line.baseline - first.originalBaseline) < font * 4 &&
        line.items[0].fontName === first.fontName &&
        line.items.at(-1)!.fontName === first.fontName &&
        line.items.every(
          (item) =>
            item.nativeLine === line.items[0].nativeLine &&
            !item.unsupported &&
            !tableItems.has(item) &&
            !codeItems.has(item)
        ) &&
        inlineNativeInventory.get(line.items[0].nativeLine)?.length === line.items.length &&
        inlineNativeInventory
          .get(line.items[0].nativeLine)!
          .every((item) => line.items.includes(item)) &&
        !all.some(
          (item) =>
            !line.items.includes(item) &&
            item.x < line.right &&
            item.right > line.x &&
            item.y < line.bottom &&
            item.bottom > line.y
        ) &&
        line.items.at(-1)!.hasEOL
    )
    if (peer) nativeInlineRows.push({ items: row, lines: new Set(parts), font })
  }
  const nativeInlineLineOwners = new Map<Line, (typeof nativeInlineRows)[number]>()
  for (const row of nativeInlineRows)
    for (const line of row.lines) nativeInlineLineOwners.set(line, row)

  const detachedBulletEnds = new Map<Block, { right: number; paragraphX: number; tail: Line }>()
  const detachedIncomingEnds = new Map<Block, { right: number; tail: Line }>()
  for (const line of lines.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const blockedBulletOwners: Block[] = []
    const blockedIncomingOwners: Block[] = []
    const blockedFormulaOwners: Block[] = []
    const nativeProseSplitOwners = new Set<Block>()
    const symbolicSplitOwners = new Set<Block>()
    const leading =
      [...(leadings.get(Math.round(line.font * 2)) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      1.2
    const candidates = blocks
      .filter((b) => {
        if (
          completedHeadingWraps.has(b) ||
          sectionReferenceStarts.has(line) ||
          nativeSectionHeadings.has(line) ||
          nativeSectionHeadings.has(b.lines.at(-1)!)
        )
          return false
        const packet = nativeInlineLineOwners.get(line),
          previousPacket = nativeInlineLineOwners.get(b.lines.at(-1)!)
        if ((packet || previousPacket) && packet !== previousPacket) return false
        const last = b.lines.at(-1)!,
          gap = line.baseline - last.baseline,
          lastNativeIndex = Math.max(...last.items.map((item) => item.index)),
          nextNativeIndex = Math.min(...line.items.map((item) => item.index))
        // Repeated left-side record markers and their assignment arrows own
        // separate rows even when the right-hand prose has matching indentation.
        if (
          gap > line.font * 0.75 &&
          gap < line.font * 1.6 &&
          !symbolicExpression(last.text) &&
          !symbolicExpression(line.text)
        ) {
          const markerFor = (row: Line): Item | undefined => {
            const first = Math.min(...row.items.map((item) => item.index))
            const preceding = all.filter(
              (item) =>
                item.index < first &&
                !item.unsupported &&
                Math.abs(item.originalBaseline - row.baseline) < row.font * 0.15 &&
                item.right < row.x &&
                item.font > row.font * 0.8 &&
                item.font < row.font * 1.1
            )
            const markers = preceding.filter((item) =>
              /^(?:[•●▪]|[1-9]\d{0,2}:)$/u.test(item.str.trim())
            )
            const arrow = preceding.at(-1)
            return markers.length === 1 &&
              arrow &&
              /[←→]$/u.test(arrow.str.trim()) &&
              row.x - arrow.right < row.font * 0.8 &&
              arrow.index > markers[0].index
              ? markers[0]
              : undefined
          }
          const previousMarker = markerFor(last),
            nextMarker = markerFor(line)
          if (
            previousMarker &&
            nextMarker &&
            nextMarker.index > lastNativeIndex &&
            nextMarker.index < nextNativeIndex &&
            !!previousMarker.fontName &&
            previousMarker.fontName === nextMarker.fontName &&
            Math.abs(previousMarker.x - nextMarker.x) < line.font * 0.15 &&
            Math.abs(previousMarker.font - nextMarker.font) < line.font * 0.05 &&
            ((/^[•●▪]$/u.test(previousMarker.str) && previousMarker.str === nextMarker.str) ||
              (/^\d+:$/.test(previousMarker.str) &&
                /^\d+:$/.test(nextMarker.str) &&
                Number(nextMarker.str.slice(0, -1)) ===
                  Number(previousMarker.str.slice(0, -1)) + 1))
          )
            return false
        }
        // A right-hand fragment that returns leftward cannot continue the
        // preceding row while skipping adjacent native ink on its own row.
        // Aligned hanging markers in a stable column do not prove this.
        if (
          gap > line.font * 0.75 &&
          line.x < last.x - line.font &&
          !symbolicExpression(last.text) &&
          !symbolicExpression(line.text) &&
          all.some(
            (item) =>
              item.index > lastNativeIndex &&
              item.index < nextNativeIndex &&
              !b.items.includes(item) &&
              !item.unsupported &&
              item.right <= line.x + line.font * 0.01 &&
              line.x - item.right < line.font * 0.8 &&
              Math.abs(item.originalBaseline - line.baseline) < line.font * 0.8 &&
              item.font > line.font * 0.5 &&
              item.font < line.font * 1.1
          )
        ) {
          // A native split must not discard the established paragraph width:
          // a short terminal tail still ends before the next paragraph.
          if (
            gap < line.font * 1.7 &&
            Math.abs(b.font - line.font) < line.font * 0.05 &&
            Math.min(b.right, line.right) - Math.max(b.x, line.x) > line.font * 4
          )
            blockedIncomingOwners.push(b)
          return false
        }
        // The next native ink on this row must be read before a vertical
        // continuation, including ink beyond the current prefix's narrow box.
        const prefixIsComplete = (): boolean => {
          const stack: string[] = []
          for (const char of last.text) {
            if ('([{'.includes(char)) stack.push(char)
            else if (')]}'.includes(char) && stack.pop() !== '([{'[')]}'.indexOf(char)])
              return false
          }
          return stack.length === 0
        }
        const intervening =
          gap > line.font * 0.75 && symbolicExpression(last.text) && prefixIsComplete()
            ? all.filter((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
            : []
        const completeProseSuffix =
          intervening.length > 0 &&
          lines.some((suffix) => {
            return (
              suffix !== last &&
              wordCount(suffix.text) >= 6 &&
              !symbolicExpression(suffix.text) &&
              suffix.x >= last.right - line.font * 0.01 &&
              suffix.x - last.right < line.font * 0.8 &&
              Math.abs(suffix.baseline - last.baseline) < line.font * 0.15 &&
              Math.abs(suffix.font - last.font) < line.font * 0.05 &&
              intervening.length === suffix.items.length &&
              intervening.every(
                (item) =>
                  suffix.items.includes(item) &&
                  !item.unsupported &&
                  !!item.fontName &&
                  !tableItems.has(item) &&
                  !codeItems.has(item) &&
                  item.nativeLine === last.items.at(-1)!.nativeLine
              ) &&
              last.items.every(
                (item) =>
                  !item.unsupported &&
                  !!item.fontName &&
                  !tableItems.has(item) &&
                  !codeItems.has(item)
              )
            )
          })
        if (
          gap > line.font * 0.75 &&
          (!symbolicExpression(last.text) || completeProseSuffix) &&
          all.some(
            (item) =>
              item.index > lastNativeIndex &&
              item.index < nextNativeIndex &&
              !b.items.includes(item) &&
              !item.unsupported &&
              item.x >= last.right - line.font * 0.01 &&
              (item.x - last.right < line.font * 0.8 ||
                (b.lines.length === 1 &&
                  last.items.length === 1 &&
                  terminal(last.text) &&
                  wordCount(last.text) >= 3 &&
                  wordCount(item.str) >= 3 &&
                  !!last.items[0].fontName &&
                  item.fontName !== last.items[0].fontName &&
                  item.x - last.right < line.font * 1.2 &&
                  Math.abs(item.originalBaseline - last.baseline) < line.font * 0.05)) &&
              Math.abs(item.originalBaseline - last.baseline) < line.font * 0.8 &&
              item.font > line.font * 0.5 &&
              item.font < line.font * 1.1
          )
        ) {
          // Splitting an existing symbolic continuation repairs its position,
          // not its translation policy. Preserve a separately created symbolic
          // tail only when this one proved owner previously kept it symbolic.
          if (
            completeProseSuffix &&
            symbolicExpression(line.text) &&
            symbolicExpression(b.source + ' ' + line.text) &&
            !/^[\s.,;:]*(?:where|for)\b/iu.test(b.source)
          )
            symbolicSplitOwners.add(b)
          if (completeProseSuffix) nativeProseSplitOwners.add(b)
          else return false
        }
        // A short prefix beside an inline equation does not own the remainder
        // of that native row. Do not jump over its separately owned right-hand
        // ink when attaching the next row to this paragraph's established span.
        if (
          gap > line.font * 0.45 &&
          all.some(
            (item) =>
              item.index > lastNativeIndex &&
              item.index < nextNativeIndex &&
              Math.abs(item.originalBaseline - last.baseline) < line.font * 0.15 &&
              item.x >= last.right - line.font * 0.01 &&
              item.right <= b.right + line.font * 0.01
          )
        ) {
          // A terminal hanging bullet row may be detached by the equation,
          // but its unique native predecessor still proves the paragraph edge.
          if (
            b.lines.length >= 2 &&
            /^[•●▪]\s/u.test(b.lines[0].text) &&
            !terminal(last.text) &&
            terminal(line.text) &&
            gap > line.font * 0.75 &&
            gap < line.font * 1.6 &&
            Math.abs(b.font - line.font) < line.font * 0.05 &&
            Math.abs(line.x - last.x) < line.font * 0.15 &&
            line.x > b.lines[0].x + line.font * 0.45 &&
            line.x < b.lines[0].x + line.font * 2 &&
            line.right < b.right - line.font * 2 &&
            uninterruptedNativeRow(line) &&
            line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
            all
              .filter((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
              .every(
                (item) =>
                  item.nativeLine === last.items.at(-1)!.nativeLine &&
                  Math.abs(item.originalBaseline - last.baseline) < line.font * 0.45 &&
                  item.x >= last.right - line.font * 0.01 &&
                  item.right <= b.right + line.font * 0.01
              ) &&
            [...b.items, ...line.items].every(
              (item) => !item.unsupported && !tableItems.has(item) && !codeItems.has(item)
            )
          )
            blockedBulletOwners.push(b)
          return false
        }
        if (
          inlineFormulaPartners.has(last) &&
          inlineFormulaPartners.has(line) &&
          formulaTails.has(last) === formulaTails.has(line) &&
          [inlineFormulaPartners.get(last)!, inlineFormulaPartners.get(line)!].some((partner) =>
            partner.items.some(
              (item) => item.index > lastNativeIndex && item.index < nextNativeIndex
            )
          )
        )
          return false
        const adjacentFields =
          labelStarts.has(last) &&
          labelStarts.has(line) &&
          Math.abs(line.x - last.x) < line.font * 0.15 &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.8 &&
          last.items[0].fontName === line.items[0].fontName &&
          [last, line].every((row) =>
            row.items.every(
              (item, index) =>
                (!index || item.fontName === bodyFontName) &&
                Math.abs(item.font - line.font) < line.font * 0.05 &&
                !tableItems.has(item) &&
                !codeItems.has(item)
            )
          ) &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
        const narrativeCell = narrativeCells.get(line.items[0])
        const previousCell = narrativeCells.get(last.items[0])
        if (narrativeCell || previousCell)
          return (
            narrativeCell === previousCell &&
            gap > line.font * 0.45 &&
            gap < line.font * 1.8 &&
            Math.abs(b.font - line.font) < line.font * 0.15
          )
        // Once an arrow record is proven, generic overlap must not extend its
        // ownership past a completed sentence, style change or outdented row.
        if (arrowRows.has(b.lines[0]) && !arrowBulletWrap(b, line)) return false
        if (dashLists.has(b.lines[0]) && !dashBulletWrap(b, line)) return false
        if (
          b.lines.length === 1 &&
          /^[•●▪]\s+\d{1,3}\p{Lu}{1,3}\b/u.test(b.lines[0].text) &&
          (!last.items.at(-1)!.fontName ||
            last.items.at(-1)!.fontName !== line.items[0].fontName ||
            lastNativeIndex >= nextNativeIndex ||
            all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex))
        )
          return false
        const numberedHeading =
          numbered.has(b.lines[0]) && /^\d+(?:\.\d+)+\.?\s+\p{Lu}/u.test(b.lines[0].text)
        const headingWrap = numberedHeadingWrap(b, line)
        // A prose arithmetic word may wrap immediately before its literal
        // quantity and sentence end. A body continuation is not a new list
        // number without a break in its native font, order or column geometry.
        const literalNumberContinuation =
          /\b(?:plus|minus|Figure|Fig\.|Table|Tab\.|Section|Eq\.)$/u.test(last.text) &&
          /^\d{1,6}(?:\.\d+)?\.\s+\p{Lu}\p{L}{1,}/u.test(line.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right)
        // A justified body line can wrap immediately before its citation.
        // Keep lowercase continuations with the unfinished sentence, but keep
        // real numbered lists, indentation and intervening native content apart.
        const citationContinuation =
          /^\[\d{1,3}\]\s+\p{Ll}/u.test(line.text) &&
          !numbered.has(b.lines[0]) &&
          last.text.length > 40 &&
          (!terminal(last.text) ||
            (/\bet al\.$/u.test(last.text) &&
              uninterruptedNativeRow(last) &&
              uninterruptedNativeRow(line) &&
              last.items[0].fontName &&
              [...last.items, ...line.items].every(
                (item) => item.fontName === last.items[0].fontName
              ))) &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.7 &&
          (Math.abs(line.x - b.x) < line.font * 0.45 ||
            (b.lines.length === 1 &&
              b.x > line.x &&
              b.x - line.x < line.font * 3 &&
              Math.abs(last.right - line.right) < line.font &&
              last.items[0].fontName !== undefined &&
              [...last.items, ...line.items].every(
                (item) => item.fontName === last.items[0].fontName
              ))) &&
          Math.abs(last.right - b.right) < line.font &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
        // A closed sample count can wrap after its equals sign. Native
        // adjacency and identical body type prove that "22) received ..." is
        // the same clinical sentence, rather than a new numbered list item.
        const sampleCountContinuation =
          last.text.length > 40 &&
          /\(n\s*=\s*$/u.test(last.text) &&
          /^\d{1,5}\)\s+(?!where\b)\p{Ll}{2}/u.test(line.text) &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.7 &&
          Math.abs(line.x - last.x) < line.font * 0.15 &&
          [...last.items, ...line.items].every(
            (item) =>
              item.fontName !== undefined &&
              item.fontName === last.items[0].fontName &&
              Math.abs(item.font - line.font) < line.font * 0.05
          ) &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
        // A model's hyphenated numeric suffix can resemble a list number.
        // Its introducing example, closing parenthesis, and immediate native
        // body wrap prove the identifier; unrelated lists and operands do not.
        const modelIdentifierContinuation =
          last.text.length > 40 &&
          !numbered.has(b.lines[0]) &&
          /\((?:e\.g\.|i\.e\.)\s+[A-Z][A-Za-z]{2,}[-‐]$/u.test(last.text) &&
          /^\d{1,3}\)\s+(?!where\b)\p{Ll}{2}/u.test(line.text) &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.7 &&
          Math.abs(line.x - b.x) < line.font * 3 &&
          Math.abs(last.right - line.right) < line.font &&
          last.items[0].fontName &&
          line.items[0].fontName === last.items[0].fontName &&
          [...last.items, ...line.items].every(
            (item) => item.fontName && Math.abs(item.font - line.font) < line.font * 0.05
          ) &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
        // A narrow sentence ending belongs to the same native body flow.
        // Require complete words or a closed numeric citation, never operands.
        const legacyTerminalTail =
          b.lines.length >= 2 &&
          last.text.length > 40 &&
          !terminal(last.text) &&
          /^(?:[A-Z][A-Z0-9-]{1,19}|(?:[A-Za-z]{3,}\s+)?\[\d+(?:\s*[,–-]\s*\d+)*\])[.!?]$/u.test(
            line.text
          ) &&
          (!/^\[/u.test(line.text) ||
            [...last.items, ...line.items].every(
              (item) =>
                item.fontName &&
                item.fontName === last.items[0].fontName &&
                Math.abs(item.font - line.font) < line.font * 0.05
            )) &&
          !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\s+\[/u.test(
            line.text
          ) &&
          gap < line.font * 1.7 &&
          Math.abs(line.x - b.x) < line.font * 0.45 &&
          Math.abs(last.right - b.right) < line.font &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
        const yearCitationTail =
          /^\d{4}[a-z]?\)[.!?]$/u.test(line.text) &&
          b.source.lastIndexOf('(') > b.source.lastIndexOf(')') &&
          /[A-Za-z][A-Za-z\s.,'’-]+,$/u.test(last.text) &&
          (continuousBodyWrap(last, line, all, b.x, b.right) ||
            (() => {
              // Small caps can name the cited work without being a lowered
              // index. Prove the native body row, then normalize only the
              // classification view; source glyphs and rectangles stay intact.
              const smallcaps = last.items.filter((part) => part.font < line.font * 0.95)
              if (
                smallcaps.length !== 1 ||
                !/^[A-Z]{3,20}$/u.test(smallcaps[0].str) ||
                !/^[A-Za-z][A-Za-z ,.'’–-]+ [A-Z]{3,20} \([A-Z][A-Za-z ,.'’–-]+,$/u.test(
                  last.text
                ) ||
                /\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(last.text) ||
                last.items.indexOf(smallcaps[0]) === 0 ||
                last.items[last.items.indexOf(smallcaps[0]) + 1]?.str !== '(' ||
                !uninterruptedNativeRow(last) ||
                !uninterruptedNativeRow(line) ||
                line.items[0].nativeLine !== last.items[0].nativeLine + 1 ||
                ![...last.items, ...line.items].every(
                  (part) =>
                    !part.unsupported &&
                    !tableItems.has(part) &&
                    !codeItems.has(part) &&
                    !!part.fontName &&
                    part.fontName === last.items[0].fontName &&
                    part.transform.length === 6 &&
                    part.transform.every(Number.isFinite) &&
                    part.transform[0] > 0 &&
                    part.transform[3] > 0 &&
                    Math.abs(part.transform[0] - part.font) < line.font * 0.05 &&
                    Math.abs(part.transform[3] - part.font) < line.font * 0.05 &&
                    Math.abs(part.transform[1]) < 0.001 &&
                    Math.abs(part.transform[2]) < 0.001 &&
                    (part === smallcaps[0]
                      ? part.font > line.font * 0.75 && part.font < line.font * 0.85
                      : Math.abs(part.font - line.font) < line.font * 0.05)
                )
              )
                return false
              return continuousBodyWrap(
                {
                  ...last,
                  items: last.items.map((part) =>
                    part === smallcaps[0] ? { ...part, font: line.font } : part
                  )
                },
                line,
                all,
                b.x,
                b.right
              )
            })())
        // A complete year can finish an ordinary publication/history sentence.
        // Only closed quoted titles may differ in style; the surrounding prose
        // and terminal year retain their adjacent native body font and geometry.
        const yearProseTail =
          /^(?:in|since|until|during)\s+\d{4}[.!?]$/u.test(line.text) &&
          continuousBodyWrap(
            last,
            line,
            all,
            b.x,
            b.right,
            last.items.filter(
              (item) =>
                /^["“”][\p{L}\p{N}][^"“”]*["“”]$/u.test(item.str) &&
                wordCount(item.str) >= 2 &&
                Math.abs(item.originalBaseline - last.items[0].originalBaseline) <
                  line.font * 0.05 &&
                !symbolicExpression(item.str)
            )
          )
        // A short word can close a parenthetical prose sentence before its
        // final period. Require an already open multiword prose parenthesis,
        // not an independent function operand or a detached annotation.
        const parentheticalProseTail =
          /^[\p{L}]{3,}(?:\s+[\p{L}]{2,}){0,5}\)[.!?]$/u.test(line.text) &&
          b.source.lastIndexOf('(') > b.source.lastIndexOf(')') &&
          (b.source.slice(b.source.lastIndexOf('(')).match(/\p{L}{2,}/gu)?.length ?? 0) >= 4 &&
          continuousBodyWrap(last, line, all, b.x, b.right)
        const colonProseTail =
          /^\p{Ll}[\p{L}]{2,}(?:\s+[\p{L}]{2,}){0,5}:$/u.test(line.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right)
        // The author name may wrap immediately before its closed dated citation.
        // "et al." alone looks symbolic; only the preceding native prose owner
        // and complete year establish the citation's place in this sentence.
        const datedCitationTail =
          /\b\p{Lu}[\p{L}'’‐-]{1,39}$/u.test(last.text) &&
          /^et al\.\s+(?:\[\d{4}[a-z]?\]|\(\d{4}[a-z]?\))[.!?]$/u.test(line.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right)
        const numericProseTail =
          /^(?:at|by|to|of) \d+(?:\.\d+)?[.!?]$/u.test(line.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right)
        // A previously numbered noun can finish on a narrow body row. Native
        // adjacency distinguishes this sentence end from a diagram/list label.
        const numberedNoun = /^([a-z]{3,}) \d{1,6}[.!?]$/u.exec(line.text)
        const numberedNounTail =
          numberedNoun &&
          new RegExp(`\\b${numberedNoun[1]} \\d`, 'u').test(b.source) &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          continuousBodyWrap(last, line, all, b.x, b.right)
        // Some captions end at a prose parenthesis without a final period.
        // Prove its single open explanation and adjacent native closing row;
        // a free-standing annotation or mathematical operand is not a tail.
        const captionParentheticalTail =
          isPdfTranslationCaption(b.source) &&
          /^[^()]+\([A-Za-z][A-Za-z0-9 ,.'’‐-]*$/u.test(b.source) &&
          (b.source.slice(b.source.indexOf('(')).match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 4 &&
          !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(b.source.slice(b.source.indexOf('('))) &&
          /^[a-z]{2,}(?:\s+[A-Za-z]{2,}){1,5}\)$/u.test(line.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right) &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1
        // A caption can end with parenthesized alternative storage capacities.
        // Keep the closed quantity with its unfinished native prose owner;
        // free-standing ratios, variables and other columns remain separate.
        const captionCapacityTail =
          isPdfTranslationCaption(b.source) &&
          /^\(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)*\s*(?:[kKMGTPE]i?B)\)[.!?]$/u.test(line.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1
        // A caption can wrap its last preposition and an inline variable onto
        // a narrow terminal row. Match the variable's actual earlier type;
        // displayed operands and unknown styles provide no continuation proof.
        const captionVariableTail =
          isPdfTranslationCaption(b.source) &&
          /^(?:[\p{Ll}][\p{L}'’‐-]{1,19}\s+){1,3}\p{L}\s*[.!?]$/u.test(line.text) &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          (() => {
            const variable = line.items.find((part) => /^\p{L}$/u.test(part.str))
            const fontName = last.items[0].fontName
            if (
              !variable ||
              !fontName ||
              variable.fontName === fontName ||
              !last.items.some(
                (part) => part.str === variable.str && part.fontName === variable.fontName
              )
            )
              return false
            const variables = [...last.items, ...line.items].filter(
              (part) => part.fontName !== fontName
            )
            return (
              variables.every(
                (part) =>
                  /^[\p{L}∆]$/u.test(part.str) &&
                  !!part.fontName &&
                  !part.unsupported &&
                  !tableItems.has(part) &&
                  !codeItems.has(part)
              ) && continuousBodyWrap(last, line, all, b.x, b.right, variables)
            )
          })()
        // A complete figure/table locator can occupy the final short body
        // row. Its numeric suffix is not covered by the ordinary word tail
        // grammar; require an unfinished native introduction in the same type.
        const numberedReferenceTail =
          /^(?:Table|Tab\.|Figure|Fig\.)\s*\d+[a-z]?\.$/u.test(line.text) &&
          /\b(?:in|on|of|to|from|with|see)$/u.test(last.text) &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          continuousBodyWrap(last, line, all, b.x, b.right, [], b.source)
        // A ragged body row can introduce its final cited noun without reaching
        // the paragraph's widest row. The article and immediate same-type native
        // wrap prove prose; isolated function-like labels remain protected.
        const raggedCitedNounTail =
          b.lines.length >= 2 &&
          /\b(?:a|an|the)$/u.test(last.text) &&
          /^[a-z]{3,}(?: [a-z]{3,}){0,2} \[\d+(?:\s*[,–-]\s*\d+)*\][.!?]$/u.test(line.text) &&
          !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(
            line.text
          ) &&
          line.right - line.x < last.right - last.x &&
          continuousBodyWrap(last, line, all, b.x, last.right)
        const shortTerminalTail =
          legacyTerminalTail ||
          raggedCitedNounTail ||
          numberedReferenceTail ||
          captionVariableTail ||
          captionCapacityTail ||
          captionParentheticalTail ||
          numberedNounTail ||
          numericProseTail ||
          colonProseTail ||
          datedCitationTail ||
          yearCitationTail ||
          yearProseTail ||
          parentheticalProseTail ||
          (/^(?:(?:[\p{L}][\p{L}\p{N}'’‐-]{1,19}\s+){0,5}[\p{L}][\p{L}\p{N}'’‐-]{1,19}(?:\s+\[\d+(?:\s*[,–-]\s*\d+)*\])?|\[\d+(?:\s*[,–-]\s*\d+)*\])[.!?][”’"')\]]?$/u.test(
            line.text
          ) &&
            !/^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\s+\[/u.test(
              line.text
            ) &&
            continuousBodyWrap(
              last,
              line,
              all,
              b.x,
              b.right,
              [],
              isPdfTranslationCaption(b.source) ? b.source : undefined
            ))
        // A caption can refer to another table or figure at a native wrap.
        // The unfinished preposition, ordinary body type and exact row flow
        // distinguish that reference from a new independently styled caption.
        const captionReferenceContinuation =
          isPdfTranslationCaption(b.source) &&
          /^(?:Table|Figure|Fig\.)\s*\d+\.\s/u.test(line.text) &&
          /\b(?:in|on|of|to|from|with|see)$/u.test(last.text) &&
          continuousBodyWrap(last, line, all, b.x, b.right) &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1
        if (
          // Author names and contact lines are separate metadata rows, even
          // when their font size and leading match the affiliation below.
          (line.baseline < page.height * 0.35 &&
            [line, last].some(
              (row) =>
                /^(?:[A-Z][A-Za-z'.-]*\s+){1,4}[A-Z][A-Za-z'.-]*[∗*†‡]+$/u.test(row.text.trim()) ||
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.text.trim())
            )) ||
          // A raised leading affiliation index starts its own front-matter
          // row. Do not flow the authors and several institutions as one
          // paragraph across their differently centered source regions.
          (page.page === 1 &&
            line.baseline < page.height * 0.35 &&
            /^\d+\s*(?:School|Department|Institute|University|Faculty|Laboratory|Centre|Center)\b/u.test(
              line.text
            ) &&
            /^\d+$/u.test(line.items[0].str.trim()) &&
            line.items[0].font < line.font * 0.85 &&
            line.baseline - line.items[0].originalBaseline > line.font * 0.15) ||
          (captionLabel.test(line.text) &&
            // A body sentence can wrap immediately before "Figure 1.".
            // Full-width, unfinished prose with native adjacency is a reference.
            !(
              captionReferenceContinuation ||
              (!isPdfTranslationCaption(b.source) &&
                last.text.length > 40 &&
                !terminal(last.text) &&
                gap < line.font * 1.7 &&
                (Math.abs(line.x - b.x) < line.font * 0.45 ||
                  (b.lines.length === 1 &&
                    line.x < last.x &&
                    last.x - line.x < line.font * 3 &&
                    /\b(?:in|on|of|to|from|with|see)$/u.test(last.text) &&
                    uninterruptedNativeRow(last) &&
                    uninterruptedNativeRow(line) &&
                    line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
                    [...last.items, ...line.items].every(
                      (item) =>
                        item.fontName &&
                        item.fontName === last.items[0].fontName &&
                        Math.abs(item.font - line.font) < line.font * 0.05
                    ))) &&
                Math.abs(last.right - b.right) < line.font &&
                lastNativeIndex < nextNativeIndex &&
                !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex))
            )) ||
          // A native algorithm title and its independently printed Require
          // label are different owners. Retain that boundary before a complete
          // algorithm proof decides whether the body is source-only.
          (/^Algorithm\s+\d+\b/u.test(b.source) &&
            /^Require:\s/u.test(line.text) &&
            /^Algorithm\s+\d+$/u.test(b.items[0].str) &&
            line.items[0].str === 'Require:' &&
            !!line.items[0].fontName &&
            line.items[0].fontName === b.items[0].fontName &&
            line.y > last.bottom &&
            lastNativeIndex < nextNativeIndex &&
            !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)) ||
          arrowRows.has(line) ||
          tableItems.has(line.items[0]) ||
          tableItems.has(last.items[0]) ||
          preservedFormulaLines.has(line) ||
          preservedFormulaLines.has(last) ||
          codeItems.has(line.items[0]) !== codeItems.has(last.items[0]) ||
          (formulaTails.has(line) &&
            preservedFractions.some((fraction) => adjacentFractionTail(line, fraction))) ||
          // A complete annotation beside an equation owns that row. Joining it
          // to the next annotation moves comments away from their formulas.
          [line, last].some(
            (candidate) => formulaTails.has(candidate) && /^\([^]*\)$/u.test(candidate.text)
          ) ||
          (/\bet al\.$/u.test(last.text) &&
            /^\[\d{1,3}\]\s+\p{Ll}/u.test(line.text) &&
            !citationContinuation) ||
          (numberedHeading && !headingWrap) ||
          ((symbolicExpression(line.text) && !verifiedProseLines.has(line)) !==
            (symbolicExpression(last.text) && !verifiedProseLines.has(last)) &&
            !shortTerminalTail) ||
          (styleBoundaries.has(line) && !headingWrap) ||
          styleBoundaries.has(last) ||
          (labelStarts.has(line) &&
            (adjacentFields ||
              terminal(last.text) ||
              line.items[0].str.trim() === last.items[0].str.trim())) ||
          (numbered.has(line) &&
            !literalNumberContinuation &&
            !citationContinuation &&
            !sampleCountContinuation &&
            !modelIdentifierContinuation &&
            // A wrapped caption can finish a numeric parameter before starting
            // its next sentence; "128. Values ..." is not a new list item.
            !(
              isPdfTranslationCaption(b.source) &&
              !terminal(last.text) &&
              gap < line.font * 1.7 &&
              /^\d{1,3}\.\s+\p{Lu}/u.test(line.text) &&
              Math.abs(line.x - b.x) < line.font * 0.45
            ))
        )
          return false
        // Infer paragraph spacing from repeated body wraps, rather than the
        // absolute 1.7-em ceiling. A completed native sentence followed by a
        // substantially larger gap is a paragraph even without indentation.
        // Script glyphs do not establish the baseline or the body type.
        const observedLeading = leadings.get(Math.round(line.font * 2))
        const previousBodyItems = last.items.filter(
          (item) => Math.abs(item.font - line.font) < line.font * 0.05
        )
        const nextBodyParts = line.items.filter((item) => item.str.trim())
        const unpunctuatedRunInLabel =
          nextBodyParts.length > 1 &&
          /^(?:\p{Lu}\p{L}+\s+){1,4}\p{Lu}\p{L}+$/u.test(nextBodyParts[0].str) &&
          /^\p{Lu}/u.test(nextBodyParts[1].str)
        // A long styled lead-in can wrap before returning to body type. Its
        // closed continuation proves a fresh paragraph, not inline emphasis;
        // retain the same completed-sentence and observed-leading requirements.
        const wrappedStyledStart =
          line.items.length === 1 &&
          line.items[0].fontName &&
          line.items[0].fontName !== bodyFontName &&
          previousBodyItems[0]?.fontName === bodyFontName &&
          wordCount(line.text) >= 8 &&
          !terminal(line.text) &&
          !line.items[0].unsupported &&
          !tableItems.has(line.items[0]) &&
          lines.some((next) => {
            const [lead, body] = next.items
            return (
              lead?.fontName === line.items[0].fontName &&
              body?.fontName === bodyFontName &&
              terminal(lead.str) &&
              wordCount(lineOf(next.items.slice(1)).text) >= 8 &&
              next.baseline - line.baseline > line.font * 0.75 &&
              next.baseline - line.baseline < line.font * 1.6 &&
              Math.abs(next.x - line.x) < line.font * 0.15 &&
              lead.nativeLine === line.items[0].nativeLine + 1 &&
              uninterruptedNativeRow(next) &&
              next.items.every(
                (item) =>
                  !item.unsupported &&
                  !tableItems.has(item) &&
                  !codeItems.has(item) &&
                  Math.abs(item.font - line.font) < line.font * 0.05 &&
                  item.fontName === (item === lead ? lead.fontName : bodyFontName)
              )
            )
          })
        if (
          !unpunctuatedRunInLabel &&
          (observedLeading?.get(leading) ?? 0) >= 3 &&
          gap > line.font * leading * 1.35 &&
          (terminal(previousBodyItems.map((item) => item.str).join(' ')) ||
            /\b(?:Appendix|Section)\s+[A-Z]?\.?\d+(?:\.\d+)*$/u.test(last.text)) &&
          previousBodyItems.length > 0 &&
          previousBodyItems[0].fontName &&
          (wrappedStyledStart ||
            [previousBodyItems, line.items].every(
              (items) =>
                items
                  .filter((item) => item.fontName === previousBodyItems[0].fontName)
                  .reduce((sum, item) => sum + item.width, 0) >
                items.reduce((sum, item) => sum + item.width, 0) * 0.75
            )) &&
          Math.abs(line.x - b.x) < line.font * 0.45 &&
          !hangingLabelWrap(b, line) &&
          !isPdfTranslationCaption(b.source)
        )
          return false
        // Do not join prose across a separate equation fragment on the row
        // just read. Otherwise "set α =" followed by "β = ..." falsely drops
        // the intervening operand that occupies its own math block.
        if (
          // Extensible operators often use a top-origin baseline above the
          // prose row. Native order and overlapping bounds still prove that
          // they intervene before the next line; never skip over their RHS.
          detachedOperators.some(
            (other) =>
              other.index > lastNativeIndex &&
              other.index < nextNativeIndex &&
              other.x < Math.max(b.right, line.right) &&
              other.right > b.x &&
              other.bottom > last.y &&
              other.y < line.bottom
          ) ||
          mathLines.some(
            (other) =>
              other !== line &&
              !b.lines.includes(other) &&
              other.x < Math.max(b.right, line.right) &&
              other.right > b.x &&
              ((Math.abs(other.baseline - last.baseline) < line.font * 0.45 &&
                (other.x >= last.right || other.right <= last.x)) ||
                (other.baseline > last.baseline + line.font * 0.45 &&
                  other.baseline < line.baseline - line.font * 0.45 &&
                  // A raised numerator on the right belongs after this prose
                  // row, not between it and the preceding sentence fragment.
                  !(
                    other.x >= line.right &&
                    Math.min(...other.items.map((item) => item.index)) >
                      Math.max(...line.items.map((item) => item.index))
                  )))
          )
        )
          return false
        const originalRow = detachedProseOrigins.get(last)
        const barrierContinuation =
          originalRow &&
          b.lines.length === 1 &&
          !terminal(last.text) &&
          last.text.length > 40 &&
          // A preceding sentence in the same native run may contain numbers;
          // only the unfinished final prose sentence supplies continuation proof.
          (/^[).,;:]*\s*(?:[A-Za-z][A-Za-z'’‐-]*\s+){2,}[A-Za-z][A-Za-z'’‐-]*$/u.test(
            last.items.at(-1)!.str
          ) ||
            (/^[A-Za-z][A-Za-z0-9'’‐ ,;:.!?-]*[.!?]\s+[A-Z][a-z]+(?:\s+[a-z][a-z'’‐-]*){2,}$/u.test(
              last.items.at(-1)!.str
            ) &&
              !/\b[A-Za-z]\s*-\s*[A-Za-z]\b|\b(?:[A-Za-z]\.){2,}/u.test(last.items.at(-1)!.str))) &&
          /^[a-z]{2,}\s+[A-Za-z]/u.test(line.text) &&
          !symbolicExpression(line.text) &&
          !/[=<>≤≥+*/^−×÷∑∫]/u.test(line.text) &&
          Math.abs(line.x - originalRow.x) < line.font * 0.15 &&
          Math.abs(line.right - originalRow.right) < line.font * 0.15 &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.6 &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex) &&
          !!last.items.at(-1)?.fontName &&
          originalRow.items.every(
            (item) =>
              item.nativeLine === last.items.at(-1)!.nativeLine &&
              Math.abs(item.originalBaseline - last.baseline) < line.font * 0.05 &&
              !tableItems.has(item) &&
              !codeItems.has(item)
          ) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          [last.items.at(-1)!, ...line.items].every(
            (item) =>
              item.fontName === last.items.at(-1)!.fontName &&
              Math.abs(item.font - line.font) < line.font * 0.05 &&
              !tableItems.has(item) &&
              !codeItems.has(item)
          )
        // A protected inline formula may occupy the left of a hyphenated
        // prose row. Two resolved radicals and the preceding full prose row
        // prove the column edge without pulling the equation into the text.
        const radicalWordContinuation =
          b.lines.length === 1 &&
          formulaTails.has(last) &&
          /[a-z]{3,}[-‐]$/u.test(last.items.at(-1)!.str) &&
          /^[a-z]{2,} [a-z]{3,}\b/u.test(line.items[0].str) &&
          !!last.items.at(-1)!.fontName &&
          last.items.at(-1)!.fontName === line.items[0].fontName &&
          Math.abs(last.items.at(-1)!.font - line.items[0].font) < line.font * 0.05 &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex) &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.6 &&
          [last, line].every(
            (row) =>
              row.items.some((item) => resolvedRadicands.has(item)) &&
              row.items.every(
                (item, at) =>
                  !item.unsupported &&
                  !tableItems.has(item) &&
                  !codeItems.has(item) &&
                  item.nativeLine === row.items[0].nativeLine &&
                  (!at ||
                    (item.index > row.items[at - 1].index &&
                      !all.some(
                        (other) => other.index > row.items[at - 1].index && other.index < item.index
                      )))
              )
          ) &&
          lines.some((context) => {
            const contextEnd = Math.max(...context.items.map((item) => item.index))
            const tailStart = Math.min(...last.items.map((item) => item.index))
            const bridge = all.filter((item) => item.index > contextEnd && item.index < tailStart)
            return (
              context.text.length > 40 &&
              !terminal(context.text) &&
              !symbolicExpression(context.text) &&
              contextEnd < tailStart &&
              bridge.length > 0 &&
              bridge.length <= 20 &&
              Math.abs(context.x - line.x) < line.font * 0.15 &&
              Math.abs(context.right - last.right) < line.font * 0.15 &&
              last.baseline - context.baseline > line.font * 0.75 &&
              last.baseline - context.baseline < line.font * 1.6 &&
              context.items.every(
                (item) =>
                  !item.unsupported &&
                  item.fontName === last.items.at(-1)!.fontName &&
                  Math.abs(item.font - line.font) < line.font * 0.05 &&
                  !tableItems.has(item) &&
                  !codeItems.has(item)
              ) &&
              bridge.every(
                (item) =>
                  !item.unsupported &&
                  Math.abs(item.originalBaseline - last.baseline) < line.font &&
                  item.x >= line.x - line.font * 0.15 &&
                  item.right <= last.x + line.font * 0.05 &&
                  (preservedFractions.some((fraction) => fraction.indices.includes(item.index)) ||
                    item.detachedOperator ||
                    (/^[A-Za-z\p{Script=Greek}]$/u.test(item.str) &&
                      Math.abs(item.originalBaseline - last.baseline) < line.font * 0.05))
              )
            )
          })
        // A short but complete prose phrase can wrap after an inline formula.
        // Word and native-row proof replaces only the long-tail length test;
        // the preserved formula still establishes its original column edge.
        const shortFormulaProseTail =
          last.text.length <= 40 &&
          /^(?:[a-z]{2,} ){5,}[a-z]{2,}$/u.test(last.text) &&
          /^[a-z]{3,}(?: [a-z]{2,}){1,4}[.!?]$/u.test(line.text) &&
          gap > line.font * 0.75 &&
          gap < line.font * 1.7 &&
          uninterruptedNativeRow(last) &&
          uninterruptedNativeRow(line) &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          [...last.items, ...line.items].every(
            (item) =>
              item.fontName &&
              item.fontName === last.items[0].fontName &&
              !item.unsupported &&
              item.transform.every(Number.isFinite) &&
              item.transform[0] > 0 &&
              item.transform[3] > 0 &&
              Math.abs(item.font - line.font) < line.font * 0.05
          )
        const formulaContinuation =
          formulaTails.has(b.lines[0]) &&
          line.x <= b.x &&
          (Math.abs(line.right - b.right) < line.font * 2 ||
            // A prose tail following a separately preserved inline formula can
            // wrap back to that formula's left edge. Match the actual native
            // prefix, so arbitrary column jumps and display equations stay apart.
            (b.lines.length === 1 &&
              (last.text.length > 40 || shortFormulaProseTail) &&
              lastNativeIndex < nextNativeIndex &&
              !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex) &&
              mathLines.some(
                (prefix) =>
                  prefix !== line &&
                  (!shortFormulaProseTail ||
                    (prefix.items.every(
                      (item, at) =>
                        !item.unsupported &&
                        item.nativeLine === last.items[0].nativeLine &&
                        (!at ||
                          (item.index > prefix.items[at - 1].index &&
                            !all.some(
                              (other) =>
                                other.index > prefix.items[at - 1].index && other.index < item.index
                            )))
                    ) &&
                      !all.some(
                        (item) =>
                          item.index > Math.max(...prefix.items.map((part) => part.index)) &&
                          item.index < Math.min(...last.items.map((part) => part.index))
                      ))) &&
                  (/^[a-z]{3,}\b/u.test(line.text) ||
                    (wordScriptFormulas.has(prefix) &&
                      /^[a-z]{2} [a-z]{3,}\b/u.test(line.text) &&
                      !/^(?:ln|lg)\b/u.test(line.text) &&
                      !/[=<>≤≥+*/^−×÷∑∫]/u.test(line.text) &&
                      uninterruptedNativeRow(line) &&
                      line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
                      !!last.items.at(-1)?.fontName &&
                      [...last.items, ...line.items].every(
                        (item) =>
                          item.fontName === last.items.at(-1)!.fontName &&
                          Math.abs(item.font - line.font) < line.font * 0.05
                      ))) &&
                  Math.abs(prefix.baseline - last.baseline) < line.font * 0.1 &&
                  Math.abs(prefix.x - line.x) < line.font * 0.15 &&
                  // Independently measured adjacent glyph boxes may overlap by rounding.
                  (prefix.right <= last.x ||
                    (prefix.right - last.x <= line.font * 0.01 &&
                      !!last.items[0]?.fontName &&
                      [...last.items, ...line.items].every(
                        (part) => part.fontName === last.items[0].fontName
                      ))) &&
                  last.x - prefix.right < line.font * 0.5 &&
                  Math.max(...prefix.items.map((item) => item.index)) <
                    Math.min(...last.items.map((item) => item.index))
              )) ||
            (line.right < b.x &&
              // Only the immediate native wrap of the initial formula tail may
              // jump back to the left. Later rows can belong to another column.
              b.lines.length === 1 &&
              lastNativeIndex < nextNativeIndex &&
              !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex) &&
              line.text.split(/\s+/u).length <= 8 &&
              /[.!?]$/u.test(line.text) &&
              /^[a-z]/u.test(line.text))) &&
          !terminal(last.text)
        const hangingX = numbered.get(b.lines[0])
        // Symbolic attribution notes can wrap back to the column edge. Only
        // a proven paired footnote and its immediate native body row may do so.
        const footnoteTail =
          footnoteStarts.has(b.lines[0]) &&
          symbolicFootnotes.includes(b.lines[0].items[0].str) &&
          !terminal(last.text) &&
          /^[A-Z][a-z]{2,}(?: [A-Za-z]{2,}){0,2}[.]$/u.test(line.text) &&
          line.x < b.x &&
          b.x - line.x < line.font * 2.5 &&
          gap > line.font * 0.8 &&
          gap < line.font * 1.6 &&
          line.items[0].nativeLine === last.items.at(-1)!.nativeLine + 1 &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex) &&
          [...last.items.filter((part) => part !== b.lines[0].items[0]), ...line.items].every(
            (part) =>
              part.fontName === last.items.at(-1)!.fontName &&
              !!part.fontName &&
              !part.unsupported &&
              !tableItems.has(part) &&
              !codeItems.has(part) &&
              Math.abs(part.font - line.font) < line.font * 0.05 &&
              part.transform.every(Number.isFinite) &&
              part.transform[0] > 0 &&
              part.transform[3] > 0 &&
              Math.abs(part.transform[1]) < 0.001 &&
              Math.abs(part.transform[2]) < 0.001
          )
        const hanging =
          footnoteTail ||
          (hangingX !== undefined &&
            hangingX > b.x + line.font * 0.45 &&
            hangingX - b.x < line.font * 4 &&
            Math.abs(line.x - hangingX) < line.font * 0.45) ||
          bundledNumberWrap(b, line) ||
          hangingLabelWrap(b, line) ||
          inlineBulletWrap(b, line) ||
          arrowBulletWrap(b, line) ||
          dashBulletWrap(b, line) ||
          dropCapWrap(b, line)
        const attachedCitation =
          /^\((?:Table|Fig(?:ure)?\.?|Eq\.?)\s+[^)]+\)\.?$/i.test(line.text) &&
          !/[.!?:;][”’"')\]]?$/.test(last.text) &&
          Math.abs(last.x - line.x) < line.font * 0.4
        // A wrapped equation lead may end with one unpunctuated word. Its
        // native adjacency and the following display prove the continuation;
        // a small standalone label or a different column is not enough.
        const equationLeadTail =
          last.text.length > 40 &&
          !terminal(last.text) &&
          /^[a-z]+(?:\s+[a-z]+){0,2}$/u.test(line.text) &&
          Math.abs(line.x - b.x) < line.font * 0.15 &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex) &&
          mathLines.some(
            (other) =>
              /[=<>≤≥]/u.test(other.text) &&
              other.baseline > line.baseline + line.font * 0.45 &&
              other.baseline < line.baseline + line.font * 3 &&
              other.x >= b.x &&
              other.right <= b.right
          )
        // A caption's final parameter can wrap onto a line narrower than the
        // usual prose overlap. Require native adjacency and the same left edge
        // so nearby table cells and numbers in another column remain separate.
        const numericCaptionTail =
          isPdfTranslationCaption(b.source) &&
          !terminal(last.text) &&
          /^\d+(?:\.\d+)?%?[.!?]$/u.test(line.text.trim()) &&
          gap < line.font * 1.7 &&
          Math.abs(line.x - b.x) < line.font * 0.45 &&
          lastNativeIndex < nextNativeIndex &&
          !all.some((item) => item.index > lastNativeIndex && item.index < nextNativeIndex)
        const shortProseTail =
          last.text.length > 40 &&
          !/[.!?:;][”’"')\]]?$/.test(last.text) &&
          /^[a-z]/.test(line.text) &&
          (equationLeadTail ||
            /[.!?][”’"')\]]?$/.test(line.text) ||
            (/\p{L}[-‐]$/u.test(last.text) && /:$/.test(line.text))) &&
          line.text.split(/\s+/).length <= 6 &&
          (line.text.replace(/[^A-Za-z]/g, '').length / line.text.length > 0.7 ||
            (b.lines.length >= 2 && /^(?:of|by|to|at)\s+\d+(?:\.\d+)?%[.!?]$/u.test(line.text)) ||
            /\p{L}[-‐]$/u.test(last.text)) &&
          (equationLeadTail ||
            line.right - line.x >=
              line.font *
                (/\p{L}[-‐]$/u.test(last.text) ||
                (b.lines.length >= 2 && Math.abs(b.x - line.x) < line.font * 0.15)
                  ? 1.5
                  : 3)) &&
          line.x <= last.x + 0.5 &&
          last.x - line.x <= line.font * 3 + 0.5
        const hyphenatedPrefix =
          /\p{L}[-‐]$/u.test(last.text) &&
          /^\p{Ll}/u.test(line.text) &&
          line.x <= last.x &&
          last.x - line.x <= line.font * 3 + 0.5
        // PDF transforms can round a three-em first-line indent just beyond its nominal width.
        const indentTolerance =
          b.lines.length === 1 &&
          line.x < b.x &&
          !/[.!?:;][”’"')\]]?$/.test(last.text) &&
          /^[a-z(]/.test(line.text)
            ? 0.5
            : 0
        return (
          gap > line.font * 0.45 &&
          gap < line.font * Math.max(1.7, leading * 1.3) &&
          Math.abs(b.font - line.font) < line.font * 0.15 &&
          (hanging ||
            paperTitleWrap(b, line) ||
            formulaContinuation ||
            barrierContinuation ||
            radicalWordContinuation ||
            Math.abs(b.x - line.x) < line.font * 3 + indentTolerance) &&
          (hanging ||
            paperTitleWrap(b, line) ||
            formulaContinuation ||
            barrierContinuation ||
            radicalWordContinuation ||
            headingWrap ||
            attachedCitation ||
            numericCaptionTail ||
            shortTerminalTail ||
            shortProseTail ||
            hyphenatedPrefix ||
            Math.min(b.right, line.right) - Math.max(b.x, line.x) > line.font * 4)
        )
      })
      .filter((b) => {
        if (
          nativeProseSplitOwners.has(b) &&
          symbolicSplitOwners.has(b) &&
          Math.abs(line.x - b.x) < line.font * 0.15 &&
          Math.abs(line.right - b.right) < line.font * 0.3
        )
          blockedFormulaOwners.push(b)
        return !nativeProseSplitOwners.has(b)
      })
      .sort((a, b) => b.lines.at(-1)!.baseline - a.lines.at(-1)!.baseline)
    let block: Block | undefined = candidates[0]
    if (block) {
      const last = block.lines.at(-1)!
      const hangingX = numbered.get(block.lines[0])
      const hanging =
        (hangingX !== undefined &&
          hangingX > block.x + line.font * 0.45 &&
          Math.abs(line.x - hangingX) < line.font * 0.45) ||
        numberedHeadingWrap(block, line) ||
        bundledNumberWrap(block, line) ||
        hangingLabelWrap(block, line) ||
        inlineBulletWrap(block, line) ||
        arrowBulletWrap(block, line) ||
        dashBulletWrap(block, line) ||
        dropCapWrap(block, line)
      const indented =
        !hanging && !paperTitleWrap(block, line) && line.x - block.x > line.font * 0.45
      const detached = detachedBulletEnds.get(block)
      const incoming = detachedIncomingEnds.get(block)
      const paragraphRight =
        detached &&
        detached.tail === last &&
        Math.abs(line.x - detached.paragraphX) < line.font * 0.15
          ? Math.max(block.right, detached.right)
          : incoming?.tail === last
            ? Math.max(block.right, incoming.right)
            : block.right
      const shortEnd =
        !hanging &&
        last.right < paragraphRight - line.font * 2 &&
        /[.!?:;][”’"')\]]?$/.test(last.text)
      const metadataStart = /^(?:Keywords?|Key words|Index terms)\s*:/i.test(line.text)
      if (indented || shortEnd || metadataStart) block = undefined
    }
    if (!block) {
      if (blockedFormulaOwners.length === 1) preservedFormulaLines.add(line)
      block = { ...line, lines: [], source: '', items: [], risks: [] }
      blocks.push(block)
      if (blockedBulletOwners.length === 1) {
        const owner = blockedBulletOwners[0]
        detachedBulletEnds.set(block, {
          right: owner.right,
          paragraphX: owner.lines[0].x,
          tail: line
        })
      }
      if (blockedIncomingOwners.length === 1)
        detachedIncomingEnds.set(block, { right: blockedIncomingOwners[0].right, tail: line })
    }
    // The admitted short title tail completes the heading; a nearby body
    // paragraph must not be absorbed merely because its left edge overlaps.
    if (block.lines.length && numberedHeadingWrap(block, line)) completedHeadingWraps.add(block)
    block.lines.push(line)
    block.source = joinLines(block.source, line.text)
    block.items.push(...line.items)
    Object.assign(block, bounds(block.items))
  }
  blocks.push(...panelCaptionBlocks)
  for (const item of all.filter(
    (i) =>
      !panelCaptionItems.has(i) &&
      (i.unsupported || i.detachedOperator || embeddedMetadata.has(i) || plotTicks.has(i))
  ))
    blocks.push({
      ...item,
      source: item.str,
      ...(plotTicks.has(item) ? { sourceOnly: true as const } : {}),
      lines: [],
      items: [item],
      risks: [
        item.unsupported
          ? 'unsupported-orientation'
          : embeddedMetadata.has(item)
            ? 'metadata-extraction'
            : 'formula-extraction'
      ]
    })
  // Rotated margin stamps and centered page numbers must not bridge column
  // gutters and interleave otherwise independent body text.
  const footers = new Set(
    blocks.filter(
      (block) =>
        /^\d{1,4}$/u.test(block.source.trim()) &&
        block.y > page.height * 0.88 &&
        Math.abs((block.x + block.right) / 2 - page.width / 2) < page.width * 0.1
    )
  )
  const headers = new Set(
    blocks.filter((block) => block.items.every((item) => runningHeaders.has(item.key)))
  )
  // Treat the proved row as one XY-cut envelope, then return its unchanged
  // fragment objects in native interval order. Never merge their source text.
  const nativeInlineBlockGroups = new Map<Block, Block[]>()
  let flowBlocks = blocks.filter(
    (block) =>
      !headers.has(block) && !footers.has(block) && !block.risks.includes('unsupported-orientation')
  )
  // A proved listing and its native caption occupy one reading-order frame.
  // Keep the individual text owners; only prevent XY-cut from reading a short
  // left-aligned import before its centered caption above.
  for (const owned of listingPackets) {
    const parts = flowBlocks.filter((block) => block.items.some((item) => owned.has(item)))
    if (
      parts.length < 2 ||
      parts.some((block) => block.items.some((item) => !owned.has(item))) ||
      [...owned].some((item) => parts.filter((block) => block.items.includes(item)).length !== 1)
    )
      continue
    const items = [...owned],
      grouped: Block = {
        ...bounds(items),
        font: median(items.map((item) => item.font)),
        source: '',
        items,
        lines: [],
        risks: []
      }
    nativeInlineBlockGroups.set(
      grouped,
      parts.sort(
        (a, b) =>
          Math.min(...a.items.map((item) => item.index)) -
          Math.min(...b.items.map((item) => item.index))
      )
    )
    flowBlocks = [...flowBlocks.filter((block) => !parts.includes(block)), grouped]
  }
  for (const row of nativeInlineRows) {
    const owned = new Set(row.items),
      parts = flowBlocks.filter((block) => block.items.some((item) => owned.has(item)))
    if (
      parts.length < 2 ||
      parts.some((block) => block.items.some((item) => !owned.has(item))) ||
      row.items.some((item) => parts.filter((block) => block.items.includes(item)).length !== 1)
    )
      continue
    const grouped: Block = {
      ...bounds(row.items),
      font: row.font,
      source: '',
      items: row.items,
      lines: [],
      risks: []
    }
    nativeInlineBlockGroups.set(
      grouped,
      parts.sort(
        (a, b) =>
          Math.min(...a.items.map((item) => item.index)) -
          Math.min(...b.items.map((item) => item.index))
      )
    )
    flowBlocks = [...flowBlocks.filter((block) => !parts.includes(block)), grouped]
  }

  const ordered = [
    ...headers,
    ...(nativeNumberedReferenceColumns(flowBlocks, page) ?? readingOrder(flowBlocks)).flatMap(
      (block) => nativeInlineBlockGroups.get(block) ?? [block]
    ),
    ...footers,
    ...blocks.filter(
      (block) => !footers.has(block) && block.risks.includes('unsupported-orientation')
    )
  ]
  const separatedProse = new Set<Block>(),
    separatedMath = new Set<Block>()
  const finalOrdered = ordered.flatMap((block) => {
    if (
      block.lines.length !== 1 ||
      block.risks.length ||
      headers.has(block) ||
      footers.has(block) ||
      block.items.some((item) => tableItems.has(item) || codeItems.has(item) || item.unsupported)
    )
      return [block]
    const connectors = block.items.filter((item) =>
      /^(?:[,;.] )?(?:and hence|and therefore|therefore|thus|and so)$/u.test(item.str)
    )
    if (connectors.length !== 1 || block.items.length < 3) return [block]
    const connector = connectors[0],
      font = connector.font,
      row = inlineNativeInventory.get(connector.nativeLine)
    if (
      !connector.fontName ||
      !row ||
      !finalizedLines.has(connector.nativeLine) ||
      row.some(
        (item, i) =>
          item.unsupported ||
          tableItems.has(item) ||
          codeItems.has(item) ||
          !item.fontName ||
          ![item.x, item.y, item.right, item.bottom].every(Number.isFinite) ||
          item.width <= 0 ||
          Math.abs(item.originalBaseline - connector.originalBaseline) > font * 0.5 ||
          item.font < font * 0.6 ||
          item.font > font * 1.05 ||
          (i > 0 &&
            (item.x < row[i - 1].right - font * 0.05 || item.x > row[i - 1].right + font * 0.8))
      )
    )
      return [block]
    const rowBounds = bounds(row),
      rowSet = new Set<Item>(row),
      domain = nativeProseProofDomain(row)
    if (!domain || all.some((item) => !rowSet.has(item) && nativeTextOverlapsProof(item, domain)))
      return [block]
    const peers = all.filter(
      (item) =>
        item.fontName === connector.fontName &&
        !rowSet.has(item) &&
        !item.unsupported &&
        !tableItems.has(item) &&
        !codeItems.has(item) &&
        Math.abs(item.font - font) < font * 0.05 &&
        Math.abs(item.originalBaseline - connector.originalBaseline) < font * 12 &&
        (item.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 8 &&
        !symbolicExpression(item.str)
    )
    if (
      peers.length < 2 ||
      !peers.some(
        (item) =>
          Math.abs(item.x - rowBounds.x) < font * 0.25 &&
          Math.abs(item.originalBaseline - connector.originalBaseline) < font * 12
      )
    )
      return [block]
    const math = block.items.filter((item) => item !== connector)
    if (
      !math.some((item) => item.fontName !== connector.fontName) ||
      !symbolicExpression(lineOf([...math]).text) ||
      block.items.some((item) => !rowSet.has(item)) ||
      block.items.some((item, i) => i > 0 && item.index <= block.items[i - 1].index)
    )
      return [block]
    const at = block.items.indexOf(connector)
    return [block.items.slice(0, at), [connector], block.items.slice(at + 1)]
      .filter((items) => items.length)
      .map((items) => {
        const line = lineOf([...items]),
          part: Block = { ...line, source: line.text, items, lines: [line], risks: [] }
        if (items[0] === connector) separatedProse.add(part)
        else separatedMath.add(part)
        return part
      })
  })
  return {
    page: page.page,
    width: page.width,
    height: page.height,
    sourceItems: all.length,
    blocks: finalOrdered.map((b, index) => ({
      id: `p${page.page}-b${index + 1}`,
      ...(b.items.every((item) => tableItems.has(item)) ? { tableCell: true as const } : {}),
      ...(separatedMath.has(b) ||
      (!separatedProse.has(b) &&
        (completeDualScriptPackets.some(
          (packet) => packet.size === b.items.length && b.items.every((item) => packet.has(item))
        ) ||
          headers.has(b) ||
          b.items.every((item) => embeddedMetadata.has(item)) ||
          b.lines.some((line) => preservedFormulaLines.has(line)) ||
          b.items.every((item) => codeItems.has(item)) ||
          // A standalone variable with a native letter index is mathematical text,
          // even when its flattened spelling also names a unit (such as ml).
          // Apply after prose grouping; normal baseline text remains translatable.
          (b.items.length === 2 &&
            /^[A-Za-z\p{Script=Greek}]$/u.test(b.items[0].str) &&
            /^[A-Za-z\p{Script=Greek}]{1,3}$/u.test(b.items[1].str) &&
            attachedScripts.has(b.items[1]) &&
            !attachedScripts.has(b.items[0]) &&
            /^[A-Za-z\p{Script=Greek}]{2,4}$/u.test(b.source)) ||
          (b.items.every((item) => tableItems.has(item)) &&
            (preservedTableValue(b.source) ||
              !/\p{L}/u.test(b.source) ||
              /^[A-Za-z\p{Script=Greek}]$/u.test(b.source) ||
              (b.items.some((item) => attachedScripts.has(item)) &&
                /^[A-Za-z\p{Script=Greek}\s,∅+−–-]+$/u.test(b.source))))))
        ? { sourceOnly: true as const }
        : {}),
      page: page.page,
      source: b.source,
      items: b.items.map((i) => i.key),
      originalStrings: b.items.map((i) => i.str),
      rect: { ...(tableRects.get(b.items[0]) ?? bounds(b.items)), font: b.font },
      lines: b.lines.map((l) => ({
        text: l.text,
        items: l.items.map((i) => i.key),
        ...bounds(l.items)
      })),
      risks: [
        ...b.risks,
        // A short radicand below an independently extracted radical/accent is
        // part of the equation, even when PDF.js has split the operator's text.
        ...(/^[A-Za-z\p{Script=Greek}\d,]{1,6}$/u.test(b.source) &&
        all.some(
          (operator) =>
            /^√\u0302?$/u.test(operator.str) &&
            Math.abs(b.x - operator.right) < b.font * 0.2 &&
            b.items[0].originalBaseline - operator.originalBaseline > b.font * 0.6 &&
            b.items[0].originalBaseline - operator.originalBaseline < b.font * 1.1
        )
          ? ['formula-extraction']
          : []),
        // A smaller single-letter upper limit centered over a native large
        // operator belongs to the equation, not to a standalone prose label.
        ...(b.items.length === 1 &&
        /^[A-Za-z]$/u.test(b.source) &&
        all.some(
          (operator) =>
            operator.detachedOperator &&
            /^[∑∫∏]$/u.test(operator.str) &&
            b.font <= operator.font * 0.8 &&
            b.x >= operator.x &&
            b.right <= operator.right &&
            Math.abs((b.x + b.right - operator.x - operator.right) / 2) < operator.font * 0.3 &&
            operator.originalBaseline - b.items[0].originalBaseline > operator.font * 0.1 &&
            operator.originalBaseline - b.items[0].originalBaseline < operator.font * 1.1
        )
          ? ['formula-extraction']
          : []),
        // A fraction's numerator and denominator can be assigned to one band
        // by nearby body text. Horizontal sorting then reverses their reading
        // order; preserve the stacked formula instead of translating that string.
        ...(b.lines.length === 1 &&
        b.items.length === 2 &&
        b.items.every((i) => /^[A-Za-z\p{Script=Greek}\d\s]{1,6}$/u.test(i.str)) &&
        b.items.some((i) => /^[A-Za-z\p{Script=Greek}]$/u.test(i.str)) &&
        Math.min(b.items[0].right, b.items[1].right) > Math.max(b.items[0].x, b.items[1].x) &&
        Math.abs(b.items[0].originalBaseline - b.items[1].originalBaseline) > b.font * 0.7
          ? ['formula-extraction']
          : []),
        ...(b.source.length > 100 && !/[.!?:;][”’"')\]]?$/.test(b.source)
          ? ['possible-continuation']
          : [])
      ]
    }))
  }
}

// Geometry and native ownership supply evidence shared by inline-prefix and
// paragraph-tail decisions; a short run alone never proves a paragraph break.
function continuousBodyWrap(
  previous: Line,
  next: Line,
  all: Item[],
  left: number,
  right: number,
  citationItems: Item[] = [],
  proseContext = previous.text
): boolean {
  const lastIndex = Math.max(...previous.items.map((item) => item.index)),
    nextIndex = Math.min(...next.items.map((item) => item.index)),
    gap = next.baseline - previous.baseline
  return (
    Boolean(previous.items[0].fontName) &&
    (previous.text.length > 40 ||
      (previous.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6 ||
      (proseContext.length > 100 && (previous.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 4)) &&
    !terminal(previous.text) &&
    !symbolicExpression(previous.text) &&
    gap > next.font * 0.75 &&
    gap < next.font * 1.7 &&
    Math.abs(previous.x - left) < next.font * 0.15 &&
    Math.abs(next.x - left) < next.font * 0.15 &&
    Math.abs(previous.right - right) < next.font &&
    [...previous.items, ...next.items].every(
      (item) =>
        (item.fontName === previous.items[0].fontName || citationItems.includes(item)) &&
        Math.abs(item.font - next.font) < next.font * 0.05
    ) &&
    lastIndex < nextIndex &&
    !all.some((item) => item.index > lastIndex && item.index < nextIndex)
  )
}

const terminal = (text: string): boolean => /[.!?:;][”’"')\]]?$/.test(text.trim())
const wordCount = (text: string): number => text.trim().split(/\s+/).length
export const isPdfTranslationCaption = (text: string): boolean =>
  /^(?:Table|Tab\.|Figure|Fig\.)\s*\d/i.test(text) &&
  // A sentence referring to a figure/table is body prose. Only exclude an
  // explicit finite verb without the punctuation that introduces a caption.
  !/^(?:Table|Tab\.|Figure|Fig\.)\s*\d+(?:\s*\([a-z]\))?(?:\s+and\s+(?:Table|Tab\.|Figure|Fig\.)\s*\d+(?:\s*\([a-z]\))?)?\s+(?:shows?|illustrates?|depicts?|presents?|summari[sz]es?|reports?|provides?|flips|clarifies|assesses|compares?|demonstrates?|contains?|lists?|is|are)\b/iu.test(
    text
  )
const captionLabel = /^(?:Table|Tab\.|Figure|Fig\.)\s*\d+[.:]\s/iu
// Some PDF text maps expand formula glyphs into repeated `ffi` ligature text or
// paired Latin-1 delimiters. The visual formula is still present, but its source
// string cannot be safely matched to PDFium text objects for replacement.
const formulaExtractionArtifact = (text: string): boolean =>
  /(?:ffi){2,}|[\u00f0\u00de\ufffd]/u.test(text)
// Some LaTeX publishers overprint a c inside a separate copyright circle.
// Extraction exposes both glyphs as ©c, while PDFium exposes the circle as a
// control code. Keep this damaged metadata native rather than aborting the PDF.
const metadataExtractionArtifact = (text: string): boolean =>
  text.includes('☯') || /(?:©c|c©)\s*\d{4}\b/u.test(text)
export function groupPdfTranslationPages(raw: { pages: PdfLayoutPage[] }): PdfTranslationLayout {
  const runningHeaders = runningHeaderItems(raw.pages)
  const numbered = numberedSourcePackets(raw.pages)
  const pages = raw.pages.map((page) => extractPage(page, runningHeaders, numbered.get(page.page)))
  const rawItems = new Map(raw.pages.map((page) => [page.page, page.items]))
  const lexicon = new Set(
    raw.pages.flatMap((page) =>
      page.items.flatMap((item) =>
        (item.str.toLowerCase().match(/\p{L}+(?:[-\u2010\u2011]\p{L}+)*/gu) ?? []).map((word) =>
          word.replace(/[\u2010\u2011]/g, '-')
        )
      )
    )
  )
  const uncertainHyphen = (left: string, right: string): boolean => {
    const a = /(\p{L}+)-$/u.exec(left)?.[1],
      b = /^(\p{Ll}+)/u.exec(right)?.[1]
    if (!a || !b) return false
    return !lexicon.has((a + b).toLowerCase()) && !lexicon.has((a + '-' + b).toLowerCase())
  }
  for (const page of pages)
    for (const block of page.blocks) {
      if (!block.lines.length) continue
      const lines = block.lines.map((l) => l.text)
      block.source = joinCaptionLines(lines, lexicon)
      if (lines.some((line, i) => i > 0 && uncertainHyphen(lines[i - 1], line)))
        block.risks.push('ambiguous-line-hyphen')
      if (formulaExtractionArtifact(block.source)) block.risks.push('formula-extraction')
      if (metadataExtractionArtifact(block.source)) block.risks.push('metadata-extraction')
    }
  const weights = new Map<number, number>()
  for (const page of pages)
    for (const block of page.blocks) {
      if (
        block.risks.includes('unsupported-orientation') ||
        block.source.replace(/[^A-Za-z]/g, '').length < 40
      )
        continue
      const size = Math.round(block.rect.font * 2) / 2
      weights.set(size, (weights.get(size) ?? 0) + block.source.replace(/[^A-Za-z]/g, '').length)
    }
  const bodyFont = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 9
  const units: LayoutUnit[] = [],
    joins: PdfTranslationLayout['joins'] = []
  const repeated = new Map<string, Set<number>>()
  for (const page of pages)
    for (const block of page.blocks) {
      if (block.risks.includes('unsupported-orientation')) {
        if (!repeated.has(block.source)) repeated.set(block.source, new Set())
        repeated.get(block.source)!.add(page.page)
      }
    }
  let previousBody: LayoutUnit | undefined
  for (const page of pages)
    for (const block of page.blocks) {
      const words = wordCount(block.source)
      const footerPageNumber =
        /^\d{1,4}$/u.test(block.source.trim()) &&
        block.rect.y > page.height * 0.88 &&
        Math.abs((block.rect.x + block.rect.right) / 2 - page.width / 2) < page.width * 0.1
      const margin =
        block.items.every((key) => runningHeaders.has(key)) ||
        footerPageNumber ||
        block.rect.y < page.height * 0.055 ||
        block.rect.bottom > page.height * 0.96
      const fontMatch = Math.abs(block.rect.font - bodyFont) <= bodyFont * 0.055
      const artifact = (repeated.get(block.source)?.size ?? 0) >= 2
      const referenceStart = /^(?:\[\d{1,3}\]|\(?\d{1,3}[.)])\s+\p{Lu}/u.test(block.source)
      const letters = block.source.replace(/[^A-Za-z]/g, '').length
      const nativeItems = block.items.map(
        (key) => rawItems.get(page.page)![Number(key.split(':')[1])]
      )
      // A matrix product and its lowered variable index can be extracted as
      // the tail of a larger equation. Closing delimiters alone do not make
      // the flattened letters symbolic; require the native index geometry.
      const matrixProductTail =
        /^[A-Z]{2,4}[a-z\p{Script=Greek}]$/u.test(nativeItems[0].str) &&
        /^\){1,3}[,;:]?$/u.test(
          nativeItems
            .slice(2)
            .map((item) => item.str)
            .join('')
        )
      const letterSubscript =
        (/^[A-Za-z\p{Script=Greek}]{2}[,;:]?$/u.test(block.source) || matrixProductTail) &&
        nativeItems.length >= 2 &&
        (nativeItems[0].str.length === 1 || matrixProductTail) &&
        nativeItems[1].str.length === 1 &&
        nativeItems[1].height < nativeItems[0].height * 0.85 &&
        nativeItems[0].transform[5] - nativeItems[1].transform[5] > nativeItems[0].height * 0.08 &&
        nativeItems[0].transform[5] - nativeItems[1].transform[5] < nativeItems[0].height * 0.5 &&
        Math.abs(nativeItems[1].transform[4] - nativeItems[0].transform[4] - nativeItems[0].width) <
          nativeItems[0].height * 0.3
      // Diagram labels can flatten several overlapping base/subscript glyphs
      // into an uppercase identifier. Protect only independently extracted short
      // native pieces with visibly different baselines, never a word heading.
      const detachedOperands =
        /^[A-Z\p{Script=Greek}\d\s]{1,12}$/u.test(block.source) &&
        nativeItems.length >= 2 &&
        nativeItems.every((item) => /^[A-Z\p{Script=Greek}\d]{1,2}$/u.test(item.str.trim())) &&
        Math.max(...nativeItems.map((item) => item.transform[5])) -
          Math.min(...nativeItems.map((item) => item.transform[5])) >
          block.rect.font * 0.08
      // Some vector diagrams overprint the same short label at almost the
      // same position. PDF.js retains both native items, while PDFium suppresses
      // the duplicate in its text page. Preserve every item instead of deduplicating
      // an unverifiable replacement; ordinary repeated words and scripts stay eligible.
      const overprintedLabel =
        block.source.length <= 160 &&
        wordCount(block.source) <= 12 &&
        nativeItems.some(
          (item, index) =>
            item.str.trim().length > 1 &&
            item.str.trim().length <= 32 &&
            item.fontName !== undefined &&
            item.height > 0 &&
            nativeItems
              .slice(index + 1)
              .some(
                (other) =>
                  other.str === item.str &&
                  other.fontName === item.fontName &&
                  Math.abs(other.width - item.width) < item.height * 0.001 &&
                  Math.abs(other.height - item.height) < item.height * 0.001 &&
                  item.transform
                    .slice(0, 4)
                    .every(
                      (axis, n) => Math.abs(axis - other.transform[n]) < item.height * 0.001
                    ) &&
                  Math.abs(other.transform[4] - item.transform[4]) < item.height * 0.01 &&
                  Math.abs(other.transform[5] - item.transform[5]) < item.height * 0.15
              )
        )

      // A lowered index followed by a separate same-baseline operand can
      // flatten into a prose-looking word (W_s x -> Wsx). Insert separators
      // only into these geometry-proven three-glyph tokens; ordinary native
      // letter-by-letter prose must still be recognized as complete words.
      const attachedOperandTokens = new Set<string>()
      for (let index = 1; index + 1 < nativeItems.length; index++) {
        const base = nativeItems[index - 1],
          script = nativeItems[index],
          operand = nativeItems[index + 1]
        if (
          /^[A-Z\p{Script=Greek}]$/u.test(base.str) &&
          /^[a-z\p{Script=Greek}]$/u.test(script.str) &&
          /^[A-Za-z\p{Script=Greek}]$/u.test(operand.str) &&
          [base, script, operand].every(
            (item) =>
              item.height > 0 &&
              Number.isFinite(item.height) &&
              Number.isFinite(item.width) &&
              item.transform.every(Number.isFinite) &&
              item.transform[0] > 0 &&
              item.transform[1] === 0 &&
              item.transform[2] === 0 &&
              item.transform[3] === item.transform[0]
          ) &&
          script.height < base.height * 0.85 &&
          base.transform[5] - script.transform[5] > base.height * 0.08 &&
          base.transform[5] - script.transform[5] < base.height * 0.5 &&
          Math.abs(script.transform[4] - base.transform[4] - base.width) < base.height * 0.3 &&
          Math.abs(operand.height - base.height) < base.height * 0.05 &&
          Math.abs(operand.transform[5] - base.transform[5]) < base.height * 0.05 &&
          operand.transform[4] - script.transform[4] - script.width >= -base.height * 0.05 &&
          operand.transform[4] - script.transform[4] - script.width < base.height * 0.15
        )
          attachedOperandTokens.add(base.str + script.str + operand.str)
      }
      const nativeScriptExpression =
        attachedOperandTokens.size > 0 &&
        /^[A-Za-z\p{Script=Greek}]\s*=\s*[^=]+[.;]?$/u.test(block.source) &&
        /^[A-Za-z\p{Script=Greek}\d\s()[\]{},.;+*/^−×=]+$/u.test(block.source) &&
        (() => {
          const stack: string[] = []
          for (const char of block.source) {
            if ('([{'.includes(char)) stack.push(char)
            else if (')]}'.includes(char) && stack.pop() !== '([{'.charAt(')]}'.indexOf(char)))
              return false
          }
          return stack.length === 0
        })() &&
        symbolicExpression(
          block.source.replace(/[A-Za-z\p{Script=Greek}]{3,}/gu, (word) =>
            attachedOperandTokens.has(word) ? [...word].join(' ') : word
          )
        )
      // A complete native descriptive table label followed by its percentage
      // unit is prose, not a function call. Keep variables, known functions,
      // split glyphs and labels outside an independently proven table protected.
      const percentageTableLabel =
        block.tableCell &&
        nativeItems.length === 1 &&
        nativeItems[0].str.trim() === block.source &&
        /^[A-Z][a-z]{4,}(?:[ -][A-Za-z]{3,})* \(%\)$/u.test(block.source) &&
        !/^(?:Sin|Cos|Tan|Log|Exp|Min|Max|Det|Relu|Softmax|Sigmoid|Norm|Var)\b/u.test(block.source)
      // A named operator can sit outside a stacked fraction's native block.
      // Require a tight gap and a taller symbolic operand centered around it;
      // standalone log/min/max headings and adjacent prose remain translatable.
      const fractionOperator =
        /^(?:log|ln|exp|sin|cos|tan|min|max|det)$/u.test(block.source) &&
        nativeItems.length === 1 &&
        page.blocks.some(
          (other) =>
            other.rect.x >= block.rect.right &&
            other.rect.x - block.rect.right < block.rect.font * 0.4 &&
            other.rect.y < block.rect.y - block.rect.font * 0.3 &&
            other.rect.bottom > block.rect.bottom + block.rect.font * 0.3 &&
            symbolicExpression(other.source)
        )
      const sourceOnly =
        fractionOperator ||
        overprintedLabel ||
        nativeScriptExpression ||
        durationStatistic.test(block.source) ||
        letterSubscript ||
        detachedOperands ||
        block.sourceOnly ||
        block.risks.includes('formula-extraction') ||
        block.risks.includes('metadata-extraction') ||
        /^[()[\]{}⌊⌋|]+$/u.test(block.source) ||
        // Standalone symbolic expressions have no prose to translate. Their extraction
        // boxes can contain fraction/radical parts owned by adjacent formula units.
        // Classify attached extremum indices after grouping so a named function
        // beside them is not split off as prose. Keep the admitted source intact.
        (symbolicExpression(
          block.source.replace(/\b(?:max|min)(?=[a-z\p{Script=Greek}]∈)/gu, '')
        ) &&
          !percentageTableLabel &&
          !nativeEquationReferenceProse(block, page, raw.pages, pages) &&
          !nativeClosedReferenceProse(block, page, rawItems.get(page.page)!) &&
          !nativeNamedEquationProse(block, page, rawItems.get(page.page)!) &&
          !nativeContinuedLiteralProse(block, page, rawItems.get(page.page)!) &&
          !nativeSquareCitationProse(block, page, raw.pages) &&
          !nativeParenthesizedPathProse(block, page, rawItems.get(page.page)!) &&
          !nativeHyphenatedSectionTail(block, page, rawItems.get(page.page)!) &&
          // A leading condition/definition is prose, even if only variables follow.
          !/^[\s.,;:]*(?:where|for)\b/iu.test(block.source)) ||
        // Standalone plot ticks, citation numbers and formula glyphs carry no
        // translatable prose. Test complete grouped units, never numeric prefixes.
        /^[\d\s.,;:()[\]{}+−–—*/×÷^%=<>≤≥∗|!-]+$/u.test(block.source.trim()) ||
        // These complete literal units have no prose. Keep this check after
        // grouping so recognizing a script never splits a neighboring sentence.
        /^(?:‖[A-Za-z\p{Script=Greek}\d:,]+‖\d*|[A-Za-z\p{Script=Greek}]\d+[A-Za-z\p{Script=Greek}](?:,[A-Za-z\p{Script=Greek}])?|[A-Za-z\p{Script=Greek}]\d+[x×]\d+|[A-Za-z\p{Script=Greek}]\d*∞|\d+[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)$/u.test(
          block.source.trim()
        )
      // A short page continuation may complete a word split at the preceding
      // page bottom. Require a separately occurring complete native word and
      // matching column width; this is not a general short-prose admission.
      const currentBody = previousBody
      // A body-sized floating caption clears the normal continuation pointer.
      // Recover only a short, closed column tail as a candidate; the complete
      // native caption/interlude proof below must pass before it can be joined.
      if (
        !previousBody &&
        words >= 3 &&
        words < 12 &&
        /^[a-z]{2,} /u.test(block.source) &&
        terminal(block.source)
      )
        previousBody = units.findLast((candidate) => {
          const fragment = candidate.fragments.at(-1)
          return (
            candidate.kind === 'prose-candidate' &&
            !candidate.sourceOnly &&
            !terminal(candidate.source) &&
            fragment?.page === page.page &&
            fragment.rect.bottom > page.height * 0.75 &&
            block.rect.x > fragment.rect.x + page.width * 0.2
          )
        })
      const recoveredColumnBody = previousBody !== currentBody
      const previousFragment = previousBody?.fragments.at(-1)
      const splitWord = /([a-z]{2,})[-‐]$/u.exec(previousBody?.source ?? '')?.[1]
      const continuationWord = /^([a-z]{2,})/u.exec(block.source)?.[1]
      // A final prose row can be shorter than its column before a displayed
      // equation. Two independent full-width body rows establish the new column;
      // the equation itself supplies no width or continuation evidence.
      const shortPageColumn = (() => {
        const first = nativeItems[0],
          font = block.rect.font
        if (
          words < 8 ||
          !splitWord ||
          !continuationWord ||
          !lexicon.has(splitWord + continuationWord) ||
          lexicon.has(splitWord + '-' + continuationWord) ||
          !previousBody ||
          previousBody.sourceOnly ||
          sourceOnly ||
          block.tableCell ||
          !previousFragment ||
          previousFragment.page + 1 !== page.page ||
          previousFragment.rect.bottom < pages[previousFragment.page - 1].height * 0.75 ||
          block.rect.y > page.height * 0.15 ||
          block.rect.x > page.width * 0.4 ||
          block.lines.length !== 1 ||
          first.str !== continuationWord ||
          !/^[A-Za-z\d\s(),.:−-]+$/u.test(block.source)
        )
          return false
        const oldItems = rawItems.get(previousFragment.page)!,
          pageItems = rawItems.get(page.page)!
        const lastOld = Number(previousBody.items.at(-1)!.split(':')[1])
        const indices = block.items.map((key) => Number(key.split(':')[1]))
        const owned = new Set(indices)
        let row = 0
        const rows = pageItems.map((item) => {
          const current = row
          if (item.hasEOL) row++
          return current
        })
        const valid = (item: PdfLayoutTextItem): boolean =>
          !!item.fontName &&
          Number.isFinite(item.width) &&
          item.width > 0 &&
          Number.isFinite(item.height) &&
          item.height > 0 &&
          item.transform.length === 6 &&
          item.transform.every(Number.isFinite) &&
          Math.abs(item.transform[0] - item.height) < item.height * 0.05 &&
          Math.abs(item.transform[3] - item.height) < item.height * 0.05 &&
          Math.abs(item.transform[1]) < 0.001 &&
          Math.abs(item.transform[2]) < 0.001
        if (
          !valid(oldItems[lastOld]) ||
          oldItems[lastOld].fontName !== first.fontName ||
          Math.abs(oldItems[lastOld].height - font) > font * 0.05 ||
          oldItems
            .slice(lastOld + 1)
            .some(
              (item, n) =>
                (item.str.trim() || item.hasEOL) &&
                !runningHeaders.has(`${previousFragment.page}:${lastOld + 1 + n}`)
            ) ||
          pageItems
            .slice(0, indices[0])
            .some(
              (item, n) =>
                (item.str.trim() || item.hasEOL) && !runningHeaders.has(`${page.page}:${n}`)
            ) ||
          indices.some(
            (index, n) => (n > 0 && index <= indices[n - 1]) || rows[index] !== rows[indices[0]]
          ) ||
          pageItems.some(
            (item, index) =>
              item.str.trim() && rows[index] === rows[indices[0]] && !owned.has(index)
          ) ||
          !nativeItems.every(valid) ||
          !nativeItems.some(
            (item) =>
              item.fontName === first.fontName && /^[a-z]{2,}(?: [a-z]{2,}){2,}$/u.test(item.str)
          )
        )
          return false
        for (let n = 0; n < nativeItems.length; n++) {
          const item = nativeItems[n]
          if (Math.abs(item.height - font) < font * 0.05) {
            if (
              Math.abs(item.transform[5] - first.transform[5]) > font * 0.05 ||
              (item.fontName !== first.fontName &&
                !/^(?:[A-Za-z(),.]|,\s*(?:\.\.\.\s*,?\s*)?[A-Za-z])$/u.test(item.str))
            )
              return false
            continue
          }
          const base = nativeItems[n - 1]
          if (
            !base ||
            base.fontName === first.fontName ||
            !/[A-Za-z]$/u.test(base.str) ||
            Math.abs(base.height - font) > font * 0.05
          )
            return false
          const script: PdfLayoutTextItem[] = []
          while (n < nativeItems.length && nativeItems[n].height < font * 0.85)
            script.push(nativeItems[n++])
          n--
          if (
            !script.length ||
            !/^[A-Za-z0-9](?:[−-]\d{1,2})?$/u.test(script.map((part) => part.str).join('')) ||
            script.some((part, i) => {
              const preceding = script[i - 1] ?? base
              const gap = part.transform[4] - preceding.transform[4] - preceding.width
              return (
                part.height < font * 0.5 ||
                first.transform[5] - part.transform[5] < font * 0.08 ||
                first.transform[5] - part.transform[5] > font * 0.5 ||
                Math.abs(part.transform[5] - script[0].transform[5]) > font * 0.05 ||
                gap < -font * 0.01 ||
                gap > font * 0.15
              )
            })
          )
            return false
        }
        const width = previousFragment.rect.right - previousFragment.rect.x
        if (block.rect.right > block.rect.x + width + font * 0.15) return false
        const witnesses = page.blocks
          .filter(
            (candidate) =>
              !candidate.tableCell &&
              !candidate.sourceOnly &&
              !candidate.risks.some((risk) =>
                ['formula-extraction', 'unsupported-orientation'].includes(risk)
              )
          )
          .flatMap((candidate) => candidate.lines)
          .filter((line) => {
            const keys = line.items.map((key) => Number(key.split(':')[1])),
              parts = keys.map((key) => pageItems[key])
            return (
              line.y > block.rect.bottom &&
              line.y < page.height * 0.35 &&
              Math.abs(line.x - block.rect.x) < font * 0.15 &&
              Math.abs(line.right - line.x - width) < font * 0.15 &&
              wordCount(line.text) >= 5 &&
              /^[A-Za-z\d\s(),.;:'’‐-]+$/u.test(line.text) &&
              !/\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(line.text) &&
              parts.every(
                (part) =>
                  valid(part) &&
                  part.fontName === first.fontName &&
                  Math.abs(part.height - font) < font * 0.05 &&
                  Math.abs(part.transform[5] - parts[0].transform[5]) < font * 0.05
              ) &&
              keys.every((key) => rows[key] === rows[keys[0]]) &&
              pageItems.every(
                (part, key) => !part.str.trim() || rows[key] !== rows[keys[0]] || keys.includes(key)
              )
            )
          })
        return new Set(witnesses.map((line) => line.y)).size >= 2
      })()
      const brokenPageWord =
        words >= 8 &&
        splitWord &&
        continuationWord &&
        lexicon.has(splitWord + continuationWord) &&
        previousFragment &&
        previousFragment.page + 1 === page.page &&
        previousFragment.rect.bottom > pages[previousFragment.page - 1].height * 0.75 &&
        block.rect.x < page.width * 0.5 &&
        (shortPageColumn ||
          Math.abs(
            previousFragment.rect.right -
              previousFragment.rect.x -
              (block.rect.right - block.rect.x)
          ) <
            (block.rect.right - block.rect.x) * 0.15)
      const previousNativeIndex = previousBody?.items.at(-1)?.split(':').map(Number)[1]
      const nextNativeIndex = Number(block.items[0]?.split(':')[1])
      const pageItems = rawItems.get(page.page)!
      // A column can end mid-sentence with only a short closing clause at the
      // top of the next column. Native adjacency, matching type/column width
      // and an unfinished body sentence establish flow below the usual prose threshold.
      const columnName = /^[A-Z][A-Za-z0-9-]{2,}\b/u.exec(block.source)?.[0]
      const repeatedColumnName =
        columnName &&
        previousBody?.source.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/gu)?.includes(columnName)
      const nativeColumnContinuation =
        words >= 3 &&
        previousFragment?.page === page.page &&
        previousNativeIndex !== undefined &&
        previousNativeIndex < nextNativeIndex &&
        !terminal(previousBody!.source) &&
        (/^[a-z]/u.test(block.source) || repeatedColumnName) &&
        previousFragment.rect.bottom > page.height * 0.6 &&
        block.rect.y < page.height * 0.5 &&
        block.rect.x > previousFragment.rect.x + page.width * 0.2 &&
        Math.abs(
          previousFragment.rect.right - previousFragment.rect.x - (block.rect.right - block.rect.x)
        ) <
          (block.rect.right - block.rect.x) * 0.15 &&
        pageItems[previousNativeIndex].fontName !== undefined &&
        nativeItems[0].fontName === pageItems[previousNativeIndex].fontName &&
        Math.abs(nativeItems[0].transform[4] - block.rect.x) < block.rect.font * 0.15 &&
        (words >= 12 ||
          nativeItems.every((item) => item.fontName === pageItems[previousNativeIndex].fontName) ||
          (() => {
            // A short prose row may contain inline variables with a lowered index.
            // Prove each foreign-font glyph and the return to body text, instead
            // of allowing mathematical fonts throughout a column continuation.
            const first = nativeItems[0],
              last = nativeItems.at(-1)!,
              font = block.rect.font,
              body = (item: PdfLayoutTextItem): boolean =>
                item.fontName === first.fontName &&
                Math.abs(item.height - font) < font * 0.05 &&
                Math.abs(item.transform[5] - first.transform[5]) < font * 0.05
            if (
              block.lines.length !== 1 ||
              !/^[a-z]{2,} [a-z]{3,}/u.test(first.str) ||
              !/[A-Za-z]{2,} [a-z]{2,}$/u.test(last.str) ||
              !body(first) ||
              !body(last) ||
              !/^[A-Za-z0-9\s,.'’‐-]+$/u.test(block.source) ||
              /\b[A-Za-z]\s*-\s*[A-Za-z]\b/u.test(block.source) ||
              pageItems
                .slice(nextNativeIndex, Number(block.items.at(-1)!.split(':')[1]))
                .some((item) => item.hasEOL || (item.str.trim() && !nativeItems.includes(item)))
            )
              return false
            let lowered = false
            const valid = nativeItems.every((item, index) => {
              const previous = nativeItems[index - 1],
                next = nativeItems[index + 1]
              if (
                (index > 0 &&
                  Number(block.items[index].split(':')[1]) <=
                    Number(block.items[index - 1].split(':')[1])) ||
                !item.fontName ||
                !item.transform.every(Number.isFinite) ||
                Math.abs(item.transform[0] - item.height) > item.height * 0.05 ||
                Math.abs(item.transform[3] - item.height) > item.height * 0.05 ||
                item.transform[0] <= 0 ||
                item.transform[3] <= 0 ||
                Math.abs(item.transform[1]) > font * 0.001 ||
                Math.abs(item.transform[2]) > font * 0.001 ||
                (previous &&
                  (item.transform[4] - previous.transform[4] - previous.width < -font * 0.1 ||
                    item.transform[4] - previous.transform[4] - previous.width > font * 0.5))
              )
                return false
              if (body(item)) return true
              if (!previous || !next || !/^[A-Za-z]$/u.test(item.str)) return false
              if (
                Math.abs(item.height - font) < font * 0.05 &&
                Math.abs(item.transform[5] - first.transform[5]) < font * 0.05
              )
                return body(previous)
              const attached =
                /^[A-Za-z]$/u.test(previous.str) &&
                previous.fontName !== first.fontName &&
                Math.abs(previous.height - font) < font * 0.05 &&
                Math.abs(previous.transform[5] - first.transform[5]) < font * 0.05 &&
                item.height > previous.height * 0.5 &&
                item.height < previous.height * 0.85 &&
                previous.transform[5] - item.transform[5] > previous.height * 0.08 &&
                previous.transform[5] - item.transform[5] < previous.height * 0.5 &&
                Math.abs(item.transform[4] - previous.transform[4] - previous.width) < font * 0.3 &&
                body(next)
              lowered ||= attached
              return attached
            })
            return valid && lowered
          })()) &&
        pageItems.slice(previousNativeIndex + 1, nextNativeIndex).every((item) => !item.str.trim())
      // A floating figure may precede a short column continuation. Its complete
      // caption supplies the column width; every intervening native item must
      // be smaller figure text above that caption, or a footnote below the old
      // column. Never skip body-sized text, equations or an unlabelled region.
      const floatingCaption =
        words >= 3 &&
        words < 12 &&
        previousFragment?.page === page.page &&
        previousNativeIndex !== undefined &&
        !terminal(previousBody!.source) &&
        /^[a-z]/u.test(block.source) &&
        terminal(block.source) &&
        previousFragment.rect.bottom > page.height * 0.75 &&
        block.rect.y < page.height * 0.6 &&
        block.rect.x > previousFragment.rect.x + page.width * 0.2 &&
        pageItems[previousNativeIndex].fontName !== undefined &&
        nativeItems.every((item, index) => {
          const before = nativeItems[index - 1],
            after = nativeItems[index + 1],
            bodyFont = pageItems[previousNativeIndex].fontName,
            font = block.rect.font
          return (
            item.fontName === bodyFont ||
            (before &&
              after &&
              before.fontName === bodyFont &&
              after.fontName === bodyFont &&
              /^[A-Za-z]{2,}(?: [A-Za-z]{2,}){0,2}$/u.test(item.str) &&
              nativeItems.filter((part) => part.fontName !== bodyFont).length === 1 &&
              Math.abs(item.height - font) < font * 0.05 &&
              Math.abs(item.transform[5] - before.transform[5]) < font * 0.05 &&
              Math.abs(item.transform[5] - after.transform[5]) < font * 0.05 &&
              item.transform[4] - before.transform[4] - before.width >= -font * 0.05 &&
              item.transform[4] - before.transform[4] - before.width < font * 0.8 &&
              after.transform[4] - item.transform[4] - item.width >= -font * 0.05 &&
              after.transform[4] - item.transform[4] - item.width < font * 0.8)
          )
        }) &&
        page.blocks.find(
          (caption) =>
            isPdfTranslationCaption(caption.source) &&
            (!recoveredColumnBody || terminal(caption.source)) &&
            Math.abs(caption.rect.x - block.rect.x) < block.rect.font * 0.15 &&
            caption.rect.bottom < block.rect.y &&
            block.rect.y - caption.rect.bottom < block.rect.font * 3 &&
            block.rect.right <= caption.rect.right + block.rect.font * 0.15 &&
            Math.abs(
              caption.rect.right -
                caption.rect.x -
                (previousFragment.rect.right - previousFragment.rect.x)
            ) <
              (caption.rect.right - caption.rect.x) * 0.15 &&
            caption.items.every(
              (key) =>
                Number(key.split(':')[1]) > previousNativeIndex &&
                Number(key.split(':')[1]) < nextNativeIndex
            )
        )
      const captionColumnContinuation =
        floatingCaption &&
        pageItems.slice(previousNativeIndex! + 1, nextNativeIndex).every((item, offset) => {
          if (!item.str.trim()) return true
          if (floatingCaption.items.includes(`${page.page}:${previousNativeIndex! + 1 + offset}`))
            return true
          const x = item.transform[4],
            right = x + item.width,
            y = page.height - item.transform[5],
            tolerance = block.rect.font * 0.15
          return (
            Math.hypot(item.transform[2], item.transform[3]) < block.rect.font * 0.93 &&
            ((x >= previousFragment!.rect.x - tolerance &&
              right <= previousFragment!.rect.right + tolerance &&
              y >= previousFragment!.rect.bottom - tolerance) ||
              (x >= floatingCaption.rect.x - tolerance &&
                right <= floatingCaption.rect.right + tolerance &&
                y <= floatingCaption.rect.bottom + tolerance &&
                y > page.height * 0.055))
          )
        })
      const prose =
        !margin &&
        !referenceStart &&
        !isPdfTranslationCaption(block.source) &&
        fontMatch &&
        (words >= 12 || brokenPageWord || nativeColumnContinuation || captionColumnContinuation) &&
        letters / block.source.length > 0.5 &&
        !block.risks.includes('unsupported-orientation')
      if (recoveredColumnBody && !captionColumnContinuation) previousBody = currentBody
      const heading =
        !margin &&
        block.rect.font >= bodyFont * 0.95 &&
        words <= 8 &&
        letters > 3 &&
        !terminal(block.source) &&
        !isPdfTranslationCaption(block.source) &&
        !block.risks.includes('unsupported-orientation')
      let unit: LayoutUnit | undefined
      // A short final right-column row can continue in the next left column
      // below a full-width figure. Prove both column frames with native body
      // rows and account for every intervening object; the caption stays separate.
      const wideCaptionTail = (() => {
        const oldPage = pages[page.page - 2],
          font = block.rect.font,
          first = nativeItems[0]
        if (
          !prose ||
          sourceOnly ||
          !oldPage ||
          block.tableCell ||
          block.lines.length < 2 ||
          block.rect.x > page.width * 0.3 ||
          block.rect.y > page.height * 0.5 ||
          !/^(?:a|[a-z]{2,}) [a-z]{2,}/u.test(block.source) ||
          !terminal(block.source) ||
          !first.fontName
        )
          return undefined
        const body = (part: PdfLayoutTextItem): boolean =>
          !!part.fontName &&
          part.transform.length === 6 &&
          part.transform.every(Number.isFinite) &&
          Number.isFinite(part.width) &&
          part.width > 0 &&
          Math.abs(part.height - font) < font * 0.05 &&
          Math.abs(part.transform[0] - font) < font * 0.05 &&
          Math.abs(part.transform[3] - font) < font * 0.05 &&
          Math.abs(part.transform[1]) < 0.001 &&
          Math.abs(part.transform[2]) < 0.001 &&
          (part.fontName === first.fontName || /^[\p{Script=Greek}]$/u.test(part.str))
        if (
          !nativeItems.every(body) ||
          block.lines.some((line) => {
            const parts = line.items.map((key) => pageItems[Number(key.split(':')[1])])
            return parts.some(
              (part) => Math.abs(part.transform[5] - parts[0].transform[5]) > font * 0.05
            )
          })
        )
          return undefined
        const captions = page.blocks.filter(
            (candidate) =>
              isPdfTranslationCaption(candidate.source) &&
              terminal(candidate.source) &&
              !candidate.tableCell &&
              !candidate.sourceOnly &&
              !candidate.risks.length &&
              candidate.rect.y > page.height * 0.055 &&
              candidate.rect.bottom < block.rect.y &&
              Math.abs(candidate.rect.x - block.rect.x) < font * 0.15 &&
              candidate.rect.right > page.width * 0.8 &&
              candidate.rect.font > font * 0.8 &&
              candidate.rect.font < font * 0.95 &&
              candidate.items.every((key) => {
                const part = pageItems[Number(key.split(':')[1])],
                  size = candidate.rect.font
                return (
                  Number(key.split(':')[1]) < nextNativeIndex &&
                  !!part.fontName &&
                  part.transform.every(Number.isFinite) &&
                  Math.abs(part.height - size) < size * 0.05 &&
                  Math.abs(part.transform[0] - size) < size * 0.05 &&
                  Math.abs(part.transform[3] - size) < size * 0.05 &&
                  Math.abs(part.transform[1]) < 0.001 &&
                  Math.abs(part.transform[2]) < 0.001
                )
              })
          ),
          captionKeys = new Set(captions.flatMap((caption) => caption.items))
        if (
          captions.length !== 1 ||
          block.rect.y - captions[0].rect.bottom > font * 3 ||
          pageItems
            .slice(0, nextNativeIndex)
            .some(
              (part, index) =>
                part.str.trim() &&
                !captionKeys.has(`${page.page}:${index}`) &&
                !runningHeaders.has(`${page.page}:${index}`)
            )
        )
          return undefined
        const caption = captions[0],
          oldItems = rawItems.get(oldPage.page)!,
          tails = oldPage.blocks.filter((tail) => {
            const last = Number(tail.items.at(-1)!.split(':')[1]),
              native = oldItems[last],
              column = tail.rect.x - font,
              width = block.rect.right - block.rect.x
            if (
              tail.items.length !== 1 ||
              tail.lines.length !== 1 ||
              tail.sourceOnly ||
              tail.tableCell ||
              tail.risks.length ||
              tail.rect.x < oldPage.width * 0.5 ||
              tail.rect.bottom < oldPage.height * 0.85 ||
              !/^[A-Z][A-Za-z ,’'‐-]+\b(?:the|a|an|of|for|with|in|on|by|to|and|or)$/u.test(
                tail.source
              ) ||
              wordCount(tail.source) < 6 ||
              wordCount(tail.source) > 11 ||
              !body(native) ||
              native.fontName !== first.fontName ||
              tail.rect.right > column + width + font * 0.15 ||
              Math.abs(column + width - caption.rect.right) > font
            )
              return false
            const witnesses = oldPage.blocks
              .filter(
                (candidate) =>
                  !candidate.sourceOnly && !candidate.tableCell && !candidate.risks.length
              )
              .flatMap((candidate) => candidate.lines)
              .filter(
                (line) =>
                  line.y < tail.rect.y &&
                  Math.abs(line.x - column) < font * 0.15 &&
                  Math.abs(line.right - line.x - width) < font * 0.15 &&
                  wordCount(line.text) >= 6 &&
                  !isPdfTranslationCaption(line.text) &&
                  line.items.every(
                    (key) =>
                      Number(key.split(':')[1]) < last && body(oldItems[Number(key.split(':')[1])])
                  )
              )
            const margins = new Set(
              oldPage.blocks
                .filter(
                  (candidate) =>
                    candidate.risks.includes('unsupported-orientation') &&
                    candidate.items.every((key) => {
                      const part = oldItems[Number(key.split(':')[1])],
                        [a, b, c, d, x] = part.transform
                      return (
                        !!part.fontName &&
                        part.transform.every(Number.isFinite) &&
                        Math.abs(a) < 0.001 &&
                        Math.abs(d) < 0.001 &&
                        b > 0 &&
                        Math.abs(b + c) < 0.001 &&
                        x - b > 0 &&
                        x + b < caption.rect.x - font
                      )
                    })
                )
                .flatMap((candidate) => candidate.items)
            )
            return (
              new Set(witnesses.map((line) => line.y)).size >= 2 &&
              oldItems
                .slice(last + 1)
                .every(
                  (part, offset) =>
                    !part.str.trim() ||
                    runningHeaders.has(`${oldPage.page}:${last + 1 + offset}`) ||
                    margins.has(`${oldPage.page}:${last + 1 + offset}`)
                )
            )
          })
        return tails.length === 1 ? tails[0] : undefined
      })()
      if (wideCaptionTail) {
        unit = units.find(
          (candidate) =>
            !candidate.sourceOnly &&
            candidate.fragments.length === 1 &&
            candidate.fragments[0].id === wideCaptionTail.id
        )
        if (unit) {
          unit.kind = 'prose-candidate'
          joins.push({
            from: wideCaptionTail.id,
            to: block.id,
            kind: 'page',
            left: unit.source,
            right: block.source.slice(0, 180)
          })
        }
      }
      // A damaged block must not make neighboring readable prose source-only too.
      if (!unit && prose && previousBody && !sourceOnly && !previousBody.sourceOnly) {
        const prev = previousBody.fragments.at(-1)!,
          a = prev.rect,
          b = block.rect
        const similarWidth =
          Math.abs(a.right - a.x - (b.right - b.x)) < Math.max(a.right - a.x, b.right - b.x) * 0.15
        const similarFont = Math.abs(a.font - b.font) < bodyFont * 0.12
        const nextColumn =
          prev.page === block.page && b.x > a.x + page.width * 0.2 && b.y <= a.bottom
        const nextPage = block.page === prev.page + 1 && b.x < page.width * 0.55
        // A repeated dotted version can finish a preposition at a page break.
        // Require the exact identifier already in this paragraph and the first
        // native body row on the next page; capitalized headings prove no flow.
        const version = /^([A-Z][A-Za-z]{0,7}\d+(?:\.\d+)+) \p{Ll}/u.exec(block.source)?.[1]
        const repeatedVersionPage =
          nextPage &&
          version &&
          /\b(?:in|on|for|with|of)$/u.test(previousBody.source) &&
          previousBody.source.match(/\b[A-Z][A-Za-z]{0,7}\d+(?:\.\d+)+\b/gu)?.includes(version) &&
          a.bottom > pages[prev.page - 1].height * 0.65 &&
          b.y < page.height * 0.15 &&
          Math.abs(nativeItems[0].transform[4] - b.x) < b.font * 0.15 &&
          previousNativeIndex !== undefined &&
          rawItems.get(prev.page)![previousNativeIndex].fontName !== undefined &&
          nativeItems.every(
            (item) =>
              item.fontName === rawItems.get(prev.page)![previousNativeIndex].fontName &&
              Math.abs(Math.hypot(item.transform[2], item.transform[3]) - b.font) < b.font * 0.05
          ) &&
          pageItems
            .slice(0, nextNativeIndex)
            .every((item, index) => !item.str.trim() || runningHeaders.has(`${page.page}:${index}`))
        if (
          (nextColumn || nextPage) &&
          (similarWidth || captionColumnContinuation || shortPageColumn) &&
          similarFont &&
          !terminal(previousBody.source) &&
          (/^[a-z(\d]/.test(block.source) || nativeColumnContinuation || repeatedVersionPage)
        ) {
          unit = previousBody
          joins.push({
            from: prev.id,
            to: block.id,
            kind: nextPage ? 'page' : 'column',
            left: previousBody.source.slice(-180),
            right: block.source.slice(0, 180)
          })
        }
      }
      if (!unit) {
        unit = {
          id: `f${String(units.length + 1).padStart(4, '0')}`,
          kind: prose ? 'prose-candidate' : heading ? 'heading-candidate' : 'other',
          source: '',
          items: [],
          originalStrings: [],
          fragments: [],
          risks: []
        }
        units.push(unit)
      }
      if (uncertainHyphen(unit.source, block.source)) unit.risks.push('ambiguous-line-hyphen')
      unit.source = joinCaptionLines([unit.source, block.source], lexicon)
      unit.items.push(...block.items)
      unit.originalStrings.push(...block.originalStrings)
      unit.fragments.push({ id: block.id, page: block.page, rect: block.rect })
      unit.risks = [...new Set([...unit.risks, ...block.risks])]
      if (sourceOnly) unit.sourceOnly = true
      if (prose) previousBody = unit
      // Never leap over an unclassified body-sized line to reach a convenient continuation.
      else if (heading || (!margin && !artifact && fontMatch)) {
        const previous = previousBody?.fragments.at(-1)
        // A top-of-page floating table precedes the body continuation in
        // reading order. Retain only an explicit broken-word page tail across
        // proven cells/captions; ordinary headings and body lines still stop it.
        const floatingTable =
          previous &&
          previous.page + 1 === page.page &&
          previous.rect.bottom > pages[previous.page - 1].height * 0.75 &&
          /\p{L}[-‐]$/u.test(previousBody!.source) &&
          block.rect.bottom < page.height * 0.5 &&
          (block.tableCell || isPdfTranslationCaption(block.source))
        // Several top-of-page figures can precede a full-width continuation.
        // Every intervening native item must belong to a complete caption or
        // be smaller axis-aligned figure text. A body row, heading, equation or
        // unmatched native tail cancels the join; captions keep their own units.
        const floatingFigures = (() => {
          if (
            !previous ||
            previous.page + 1 !== page.page ||
            previousBody!.sourceOnly ||
            previous.rect.bottom < pages[previous.page - 1].height * 0.85 ||
            !/\b(?:the|a|an|of|for|with|in|on|by|to|and|or)$/u.test(previousBody!.source) ||
            !isPdfTranslationCaption(block.source)
          )
            return false
          const font = previous.rect.font,
            tolerance = font * 0.15,
            aligned = (rect: Rect): boolean =>
              Math.abs(rect.x - previous.rect.x) < tolerance &&
              Math.abs(rect.right - previous.rect.right) < font,
            continuation = page.blocks.find(
              (candidate) =>
                !candidate.tableCell &&
                !candidate.sourceOnly &&
                !candidate.risks.includes('formula-extraction') &&
                !candidate.risks.includes('unsupported-orientation') &&
                !isPdfTranslationCaption(candidate.source) &&
                /^[a-z]{2,} /u.test(candidate.source) &&
                wordCount(candidate.source) >= 12 &&
                candidate.lines.length >= 2 &&
                aligned(candidate.rect) &&
                Math.abs(candidate.rect.font - font) < font * 0.05 &&
                candidate.rect.y > block.rect.bottom &&
                candidate.rect.y < page.height * 0.8
            )
          if (!continuation) return false
          const first = Number(continuation.items[0].split(':')[1]),
            captions = page.blocks.filter(
              (candidate) =>
                isPdfTranslationCaption(candidate.source) &&
                terminal(candidate.source) &&
                aligned(candidate.rect) &&
                candidate.rect.y > page.height * 0.055 &&
                candidate.rect.bottom < continuation.rect.y &&
                candidate.items.every((key) => Number(key.split(':')[1]) < first)
            ),
            captionKeys = new Set(captions.flatMap((caption) => caption.items)),
            lastCaption = Math.max(...captions.map((caption) => caption.rect.bottom)),
            oldItems = rawItems.get(previous.page)!,
            lastOld = Number(previousBody!.items.at(-1)!.split(':')[1]),
            next = pageItems[first]
          if (
            !captions.includes(block) ||
            continuation.rect.y - lastCaption > font * 3 ||
            next.fontName === undefined ||
            next.fontName !== oldItems[lastOld].fontName ||
            oldItems.slice(lastOld + 1).some((item, n) => {
              if (!item.str.trim() || runningHeaders.has(`${previous.page}:${lastOld + n + 1}`))
                return false
              const oldPage = pages[previous.page - 1]
              return !(
                item.str.trim() === String(previous.page) &&
                oldPage.height - item.transform[5] > oldPage.height * 0.88 &&
                Math.abs(item.transform[4] + item.width / 2 - oldPage.width / 2) <
                  oldPage.width * 0.1
              )
            })
          )
            return false
          return pageItems.slice(0, first).every((item, index) => {
            if (!item.str.trim() || runningHeaders.has(`${page.page}:${index}`)) return true
            const size = Math.hypot(item.transform[2], item.transform[3]),
              baseline = page.height - item.transform[5],
              caption = captionKeys.has(`${page.page}:${index}`),
              upright =
                item.transform[0] > 0 &&
                item.transform[3] > 0 &&
                Math.abs(item.transform[1]) < 0.001 &&
                Math.abs(item.transform[2]) < 0.001,
              verticalLabel =
                !caption &&
                Math.abs(item.transform[0]) < 0.001 &&
                Math.abs(item.transform[3]) < 0.001 &&
                item.transform[1] > 0 &&
                item.transform[2] < 0 &&
                Math.abs(item.transform[1] + item.transform[2]) < size * 0.05 &&
                /^[A-Za-z]+(?:[- ][A-Za-z]+){0,4}$/u.test(item.str)
            return (
              item.fontName !== undefined &&
              Number.isFinite(item.width) &&
              Number.isFinite(item.height) &&
              item.width > 0 &&
              item.height > 0 &&
              item.transform.every(Number.isFinite) &&
              (upright || verticalLabel) &&
              item.transform[4] - (verticalLabel ? size : 0) >= previous.rect.x - tolerance &&
              item.transform[4] + (verticalLabel ? size : item.width) <=
                previous.rect.right + tolerance &&
              baseline - (verticalLabel ? item.width : item.height) > page.height * 0.055 &&
              baseline + (verticalLabel ? size : 0) < lastCaption + tolerance &&
              (caption
                ? item.fontName === next.fontName && Math.abs(size - font) < font * 0.05
                : size < font * 0.93)
            )
          })
        })()
        if (!floatingTable && !floatingFigures) previousBody = undefined
      }
    }
  // A side figure can narrow the last body rows, while its caption follows
  // them in reading order. On the next page the same sentence resumes at full
  // width below a top float. Prove every intervening owner before joining;
  // width changes alone, an unfinished sentence or a lowercase start cannot.
  for (const left of units) {
    const last = left.fragments.at(-1)!,
      oldPage = pages.find((page) => page.page === last.page)!,
      oldRaw = rawItems.get(last.page)!,
      lastIndex = Number(left.items.at(-1)!.split(':')[1]),
      font = last.rect.font
    if (
      left.sourceOnly ||
      left.kind !== 'prose-candidate' ||
      left.source.length < 100 ||
      !/\b(?:are|is|the|of|to|and|a|an)$/u.test(left.source) ||
      last.rect.bottom < oldPage.height * 0.8 ||
      last.rect.right - last.rect.x > oldPage.width * 0.55
    )
      continue
    const captions = oldPage.blocks.filter(
        (block) =>
          isPdfTranslationCaption(block.source) &&
          terminal(block.source) &&
          block.rect.x > last.rect.right &&
          block.rect.x - last.rect.right < font * 3 &&
          block.rect.y < last.rect.bottom + font &&
          block.rect.bottom > last.rect.y &&
          block.items.every(
            (key) =>
              Number(key.split(':')[1]) < Number(left.items[0].split(':')[1]) ||
              Number(key.split(':')[1]) > lastIndex
          )
      ),
      captionKeys = new Set(captions.flatMap((block) => block.items))
    if (
      captions.length !== 1 ||
      oldRaw
        .slice(lastIndex + 1)
        .some(
          (item, n) =>
            item.str.trim() &&
            !captionKeys.has(`${last.page}:${lastIndex + n + 1}`) &&
            !runningHeaders.has(`${last.page}:${lastIndex + n + 1}`) &&
            !(
              item.str.trim() === String(last.page) &&
              oldPage.height - item.transform[5] > oldPage.height * 0.88 &&
              Math.abs(item.transform[4] + item.width / 2 - oldPage.width / 2) < oldPage.width * 0.1
            )
        )
    )
      continue
    const nextPage = pages.find((page) => page.page === last.page + 1),
      nextRaw = rawItems.get(last.page + 1)
    if (!nextPage || !nextRaw) continue
    const right = units.find(
      (unit) =>
        unit.fragments[0].page === nextPage.page &&
        unit.kind === 'prose-candidate' &&
        !unit.sourceOnly &&
        !isPdfTranslationCaption(unit.source)
    )
    if (!right || !/^[a-z]{2,} /u.test(right.source) || wordCount(right.source) < 12) continue
    const first = right.fragments[0],
      firstIndex = Number(right.items[0].split(':')[1]),
      native = nextRaw[firstIndex],
      topCaptions = nextPage.blocks.filter(
        (block) =>
          isPdfTranslationCaption(block.source) &&
          terminal(block.source) &&
          block.rect.bottom < first.rect.y &&
          Math.abs(block.rect.x - first.rect.x) < font * 0.15 &&
          Math.abs(block.rect.right - first.rect.right) < font &&
          block.items.every((key) => Number(key.split(':')[1]) < firstIndex)
      ),
      topKeys = new Set(topCaptions.flatMap((block) => block.items))
    if (
      !native.fontName ||
      native.fontName !== oldRaw[lastIndex].fontName ||
      first.rect.y > nextPage.height * 0.55 ||
      first.rect.y < nextPage.height * 0.055 ||
      first.rect.right - last.rect.right < nextPage.width * 0.2 ||
      Math.abs(first.rect.x - last.rect.x) > font * 0.15 ||
      Math.abs(first.rect.font - font) > font * 0.05 ||
      topCaptions.length !== 1 ||
      first.rect.y - topCaptions[0].rect.bottom > font * 3 ||
      nextRaw.slice(0, firstIndex).some((item, index) => {
        if (!item.str.trim() || runningHeaders.has(`${nextPage.page}:${index}`)) return false
        const size = Math.hypot(item.transform[2], item.transform[3]),
          y = nextPage.height - item.transform[5]
        return !(
          item.fontName &&
          item.transform.every(Number.isFinite) &&
          item.width > 0 &&
          item.height > 0 &&
          item.transform[0] > 0 &&
          item.transform[3] > 0 &&
          Math.abs(item.transform[1]) < 0.001 &&
          Math.abs(item.transform[2]) < 0.001 &&
          item.transform[4] >= first.rect.x - font * 0.15 &&
          item.transform[4] + item.width <= first.rect.right + font * 0.15 &&
          y > nextPage.height * 0.055 &&
          y < topCaptions[0].rect.bottom + font * 0.15 &&
          (topKeys.has(`${nextPage.page}:${index}`) || size < font * 0.85)
        )
      })
    )
      continue
    joins.push({
      from: last.id,
      to: first.id,
      kind: 'page',
      left: left.source.slice(-180),
      right: right.source.slice(0, 180)
    })
    left.source = joinCaptionLines([left.source, right.source], lexicon)
    left.items.push(...right.items)
    left.originalStrings.push(...right.originalStrings)
    left.fragments.push(...right.fragments)
    left.risks = [...new Set([...left.risks, ...right.risks])]
    units.splice(units.indexOf(right), 1)
  }
  // Keep the bibliography, including wrapped entries and cross-page continuations,
  // in its original layout. Only explicit section headings end it; running headers
  // and numbered entries are not new sections. The narrow native-column proof below
  // can restore a broken reference word while retaining its first ID and all regions.
  const firstContent = new Map<number, LayoutUnit>()
  for (const unit of units) {
    const fragment = unit.fragments[0]
    const page = pages.find((page) => page.page === fragment.page)!
    if (
      fragment.rect.y < page.height * 0.055 ||
      fragment.rect.bottom > page.height * 0.96 ||
      unit.items.every((key) => runningHeaders.has(key)) ||
      /^\d{1,4}$/u.test(unit.source)
    )
      continue
    if (!firstContent.has(fragment.page)) firstContent.set(fragment.page, unit)
  }
  const joinedReferenceTails = new Set<LayoutUnit>()
  // A contents entry is not a bibliography boundary. Prove the particular
  // entry through its native page-number lane and neighboring paired entries;
  // the word Contents elsewhere on the page is insufficient.
  const nativeEntryRect = (unit: LayoutUnit): (Rect & { font: number }) | undefined => {
    if (unit.fragments.length !== 1 || !unit.items.length) return undefined
    const page = unit.fragments[0].page
    const height = pages.find((candidate) => candidate.page === page)!.height
    const items = unit.items.map((key) => rawItems.get(page)![Number(key.split(':')[1])])
    if (
      items.some(
        (item) =>
          !item ||
          item.transform[0] <= 0 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          item.transform[3] <= 0 ||
          item.width <= 0
      )
    )
      return undefined
    const font = Math.max(...items.map((item) => item.transform[3]))
    const baseline = items[0].transform[5]
    if (items.some((item) => Math.abs(item.transform[5] - baseline) > font * 0.1)) return undefined
    const y = height - baseline
    return {
      x: Math.min(...items.map((item) => item.transform[4])),
      right: Math.max(...items.map((item) => item.transform[4] + item.width)),
      y,
      bottom: y + font,
      font
    }
  }
  const isContentsEntry = (unit: LayoutUnit): boolean => {
    if (unit.fragments.length !== 1) return false
    const { page } = unit.fragments[0]
    const rect = nativeEntryRect(unit)
    if (!rect) return false
    const samePage = units.filter(
      (candidate) =>
        candidate.fragments.length === 1 &&
        candidate.fragments[0].page === page &&
        nativeEntryRect(candidate)
    )
    const headings = samePage.filter(
      (candidate) =>
        /^(?:table of )?contents$/i.test(candidate.source.trim()) &&
        nativeEntryRect(candidate)!.bottom < rect.y &&
        nativeEntryRect(candidate)!.font >= rect.font * 0.95
    )
    if (headings.length !== 1) return false
    const numbers = samePage.filter((candidate) => /^\d{1,4}$/.test(candidate.source.trim()))
    const pairs = samePage
      .flatMap((candidate) => {
        const r = nativeEntryRect(candidate)!
        if (
          !/\p{L}/u.test(candidate.source) ||
          r.y <= nativeEntryRect(headings[0])!.bottom ||
          r.y > rect.y + rect.font * 0.15 ||
          Math.abs(r.x - rect.x) > rect.font * 0.15 ||
          Math.abs(r.font - rect.font) > rect.font * 0.05 ||
          r.bottom - r.y > rect.font * 1.6
        )
          return []
        const peers = numbers.filter((number) => {
          const n = nativeEntryRect(number)!
          return (
            Math.abs(n.y - r.y) <= rect.font * 0.15 &&
            Math.abs(n.font - rect.font) <= rect.font * 0.05 &&
            n.x >= r.right - 0.01 &&
            n.x - r.x > rect.font * 4
          )
        })
        return peers.length === 1 ? [{ unit: candidate, number: peers[0], rect: r }] : []
      })
      .sort((a, b) => a.rect.y - b.rect.y)
    const target = pairs.find((pair) => pair.unit === unit)
    if (!target) return false
    const lane = pairs
      .filter(
        (pair) =>
          Math.abs(nativeEntryRect(pair.number)!.right - nativeEntryRect(target.number)!.right) <=
          rect.font * 0.15
      )
      .slice(-2)
    return (
      lane.length === 2 &&
      lane[1] === target &&
      new Set(lane.map((pair) => pair.number)).size === 2 &&
      lane.slice(1).every((pair, index) => {
        const gap = pair.rect.y - lane[index].rect.y
        return gap > rect.font * 0.5 && gap <= rect.font * 2.5
      })
    )
  }
  let references = false
  let referenceHeading: LayoutUnit | undefined
  let wrappedSupplementStyle:
    { body: string; section: string; size: number; headingSize: number } | undefined
  const wrappedSectionTails = new Set<LayoutUnit>()
  const supplementaryTitleBoundary = (unit: LayoutUnit): boolean => {
    if (
      !referenceHeading ||
      unit.sourceOnly ||
      unit.fragments.length !== 1 ||
      !/^Supplementary (?:Information|Materials?) for:\s+\p{Lu}/u.test(unit.source)
    )
      return false
    const fragment = unit.fragments[0],
      page = pages.find((page) => page.page === fragment.page)!,
      native = rawItems.get(fragment.page)!,
      titleItems = unit.items.map((key) => native[Number(key.split(':')[1])])
    if (
      fragment.page <= referenceHeading.fragments[0].page ||
      firstContent.get(fragment.page) !== unit ||
      fragment.rect.y > page.height * 0.22 ||
      fragment.rect.font < bodyFont * 1.3 ||
      fragment.rect.right - fragment.rect.x < page.width * 0.5 ||
      Math.abs((fragment.rect.x + fragment.rect.right) / 2 - page.width / 2) > page.width * 0.1 ||
      titleItems.length < 2 ||
      titleItems.some((item) => !item) ||
      new Set(titleItems.map((item) => item.transform[5])).size < 2 ||
      !titleItems[0].fontName ||
      titleItems.some(
        (item) =>
          item.fontName !== titleItems[0].fontName ||
          item.transform[0] <= 0 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          Math.abs(item.height - fragment.rect.font) > bodyFont * 0.05
      )
    )
      return false
    const notes = units.filter(
      (candidate) =>
        candidate.kind === 'heading-candidate' &&
        !candidate.sourceOnly &&
        candidate.fragments.length === 1 &&
        candidate.fragments[0].page === fragment.page &&
        /^Supplementary Note [1-9]\d{0,2}:\s+\p{L}/u.test(candidate.source) &&
        candidate.fragments[0].rect.y > fragment.rect.bottom + bodyFont &&
        candidate.fragments[0].rect.y < page.height * 0.7 &&
        candidate.fragments[0].rect.font > bodyFont * 1.15
    )
    if (notes.length !== 1) return false
    const note = notes[0],
      next = units[units.indexOf(note) + 1],
      following = next?.kind === 'heading-candidate' ? units[units.indexOf(note) + 2] : next,
      body = following?.fragments[0]
    return (
      !!following &&
      following.kind === 'prose-candidate' &&
      !following.sourceOnly &&
      following.fragments.length === 1 &&
      body?.page === fragment.page &&
      Math.abs(body.rect.x - note.fragments[0].rect.x) < bodyFont * 0.2 &&
      (body.rect.right - body.rect.x > page.width * 0.5 ||
        (body.rect.right - body.rect.x > page.width * 0.3 &&
          units.some(
            (peer) =>
              peer !== following &&
              peer.kind === 'prose-candidate' &&
              !peer.sourceOnly &&
              peer.fragments.length === 1 &&
              peer.fragments[0].page === fragment.page &&
              Math.abs(peer.fragments[0].rect.x - body.rect.x) < bodyFont * 0.2 &&
              peer.fragments[0].rect.y >= body.rect.bottom &&
              peer.fragments[0].rect.y - body.rect.bottom < bodyFont * 2 &&
              Math.abs(peer.fragments[0].rect.font - body.rect.font) < bodyFont * 0.05 &&
              Math.abs(
                peer.fragments[0].rect.right -
                  peer.fragments[0].rect.x -
                  (body.rect.right - body.rect.x)
              ) <
                bodyFont * 0.2 &&
              wordCount(peer.source) >= 24 &&
              terminal(peer.source)
          ))) &&
      wordCount(following.source) >= 24 &&
      terminal(following.source) &&
      !/^(?:\[\d|\(?\d+[.)])/u.test(following.source) &&
      body.rect.y > note.fragments[0].rect.bottom &&
      body.rect.y - note.fragments[0].rect.bottom < bodyFont * 8
    )
  }
  // Same-page declarations and S-numbered supplements need the bibliography's
  // native section style plus independent following content, not a title alone.
  const nativeSupplementBoundary = (unit: LayoutUnit, index: number): boolean => {
    if (!referenceHeading || unit.sourceOnly || unit.risks.length || unit.fragments.length !== 1)
      return false
    const declaration = unit.source === 'Declarations'
    if (!declaration && !/^S\d+(?:\.\d+)*\s+\p{Lu}/u.test(unit.source)) return false
    const fragment = unit.fragments[0],
      reference = referenceHeading.fragments[0]
    const raw = rawItems.get(fragment.page)!,
      page = pages.find((p) => p.page === fragment.page)!
    const sectionFont = rawItems.get(reference.page)![
      Number(referenceHeading.items[0].split(':')[1])
    ].fontName
    const ownsNative = (part: LayoutUnit): boolean => {
      const owned = new Set(part.items.map((key) => Number(key.split(':')[1])))
      // This proves text flow, not glyph ink or a region safe to overwrite.
      // Symbol fonts can have zero ascent/descent even for an ordinary bullet;
      // their finite native advance and baseline still locate the list marker.
      const advance = (item: PdfLayoutTextItem): Rect | undefined => {
        const [a, b, c, d, x, y] = item.transform
        if (
          item.dir !== 'ltr' ||
          !item.fontName ||
          item.transform.length !== 6 ||
          ![...item.transform, item.width, item.height].every(Number.isFinite) ||
          a <= 0 ||
          d <= 0 ||
          b !== 0 ||
          c !== 0 ||
          item.width <= 0 ||
          item.height <= 0
        )
          return
        return { x, right: x + item.width, y: y - item.height, bottom: y }
      }
      const rectangles = [...owned].map((i) => advance(raw[i]))
      if (rectangles.some((rect) => !rect)) return false
      const domain = bounds(rectangles as Rect[])
      return !raw.some((item, i) => {
        if (owned.has(i) || !item.str.trim()) return false
        const rect = advance(item)
        return (
          !rect ||
          (rect.x < domain.right &&
            rect.right > domain.x &&
            rect.y < domain.bottom &&
            rect.bottom > domain.y)
        )
      })
    }
    const heading = (part: LayoutUnit): boolean =>
      part.kind === 'heading-candidate' &&
      !part.sourceOnly &&
      !part.risks.length &&
      part.fragments.length === 1 &&
      part.fragments[0].page === fragment.page &&
      Math.abs(part.fragments[0].rect.font - reference.rect.font) < bodyFont * 0.02 &&
      part.fragments[0].rect.font > bodyFont * 1.15 &&
      !!sectionFont &&
      part.items.every((key) => raw[Number(key.split(':')[1])].fontName === sectionFont) &&
      ownsNative(part)
    if (!heading(unit) || Math.abs(fragment.rect.x - reference.rect.x) > bodyFont * 0.2)
      return false
    let end = fragment.rect.bottom,
      cursor = index + 1
    const tail = units[cursor]
    if (
      !declaration &&
      tail &&
      heading(tail) &&
      /^[\p{L}][\p{L}\d ,:().–—-]{2,100}$/u.test(tail.source)
    ) {
      const rect = tail.fragments[0].rect
      if (
        rect.y < end ||
        rect.y - end > bodyFont ||
        rect.x < fragment.rect.x ||
        rect.x - fragment.rect.x > fragment.rect.font * 2 ||
        rect.right > fragment.rect.right
      )
        return false
      end = rect.bottom
      cursor++
    }
    const adjacentBody = (part: LayoutUnit | undefined): part is LayoutUnit => {
      if (!part || part.sourceOnly || part.fragments.length !== 1) return false
      const next = part.fragments[0]
      return (
        next.page === fragment.page &&
        Math.abs(next.rect.font - bodyFont) < bodyFont * 0.1 &&
        Math.abs(next.rect.x - fragment.rect.x) < bodyFont * 0.2 &&
        next.rect.y >= end - bodyFont * 0.1 &&
        next.rect.y - end < bodyFont * 3 &&
        ownsNative(part)
      )
    }
    if (declaration) {
      const labels = new Set<string>()
      for (const part of units.slice(cursor, cursor + 2)) {
        const label =
          /^• (Funding|Competing interests|Conflicts? of interest(?:\/Competing interests)?|Data availability|Code availability|Ethics approval[^:]*|Author contributions?):\s+(.+)$/u.exec(
            part.source
          )
        if (
          !label ||
          labels.has(label[1]) ||
          !adjacentBody(part) ||
          wordCount(label[2]) < 4 ||
          !terminal(part.source)
        )
          return false
        labels.add(label[1])
        end = part.fragments[0].rect.bottom
      }
      return labels.size === 2
    }
    const body = units[cursor]
    return (
      adjacentBody(body) &&
      body.kind === 'prose-candidate' &&
      body.fragments[0].rect.right - body.fragments[0].rect.x > page.width * 0.5 &&
      wordCount(body.source) >= 12 &&
      terminal(body.source) &&
      /^\p{Lu}/u.test(body.source)
    )
  }
  // A caption-only leaf after the bibliography is independently formatted
  // material. Exempt only its complete native captions, never reference mode
  // for subsequent pages or a page also containing bibliographic entries.
  const nativeCaptionItems = (unit: LayoutUnit): PdfLayoutTextItem[] =>
    unit.fragments.length === 1
      ? unit.items.map((key) => rawItems.get(unit.fragments[0].page)![Number(key.split(':')[1])])
      : []
  const completeNativeText = (item: PdfLayoutTextItem): boolean =>
    !!item.fontName &&
    item.width > 0 &&
    item.height > 0 &&
    Number.isFinite(item.fontAscent) &&
    Number.isFinite(item.fontDescent) &&
    item.fontAscent! > item.fontDescent! &&
    item.transform.every(Number.isFinite) &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    Math.abs(item.transform[1]) < 0.001 &&
    Math.abs(item.transform[2]) < 0.001
  // A wrapped supplement title needs a closed quotation, an independently
  // complete overview and its numbered section. A citation title alone cannot
  // release bibliography mode. These are native text-flow bounds, not ink.
  const nativeWrappedSupplementBoundary = (unit: LayoutUnit, index: number): boolean => {
    const tail = units[index + 1],
      overview = units[index + 2],
      section = units[index + 3]
    if (
      !referenceHeading ||
      !tail ||
      !overview ||
      !section ||
      !/^Supplementary (?:Information|Materials?) for [“"]/u.test(unit.source) ||
      !/[”"]$/u.test(tail.source)
    )
      return false
    const parts = [unit, tail, overview, section]
    if (parts.some((part) => part.sourceOnly || part.risks.length || part.fragments.length !== 1))
      return false
    const fragment = unit.fragments[0],
      page = pages.find((p) => p.page === fragment.page)!,
      raw = rawItems.get(fragment.page)!,
      reference = referenceHeading.fragments[0]
    if (
      fragment.page <= reference.page ||
      firstContent.get(fragment.page) !== unit ||
      parts.some((part) => part.fragments[0].page !== fragment.page) ||
      fragment.rect.y > page.height * 0.16
    )
      return false
    const native = parts.map(nativeCaptionItems)
    if (
      native.some(
        (items) =>
          !items.length ||
          !items.every(
            (item) =>
              completeNativeText(item) &&
              item.dir === 'ltr' &&
              item.transform.length === 6 &&
              Number.isFinite(item.width) &&
              Number.isFinite(item.height)
          )
      )
    )
      return false
    const sectionFont = nativeCaptionItems(referenceHeading)[0]?.fontName,
      titleFont = native[0][0].fontName,
      titleSize = fragment.rect.font,
      end = tail.fragments[0].rect,
      body = overview.fragments[0].rect,
      heading = section.fragments[0].rect
    const quote = unit.source.includes('“') ? '”' : '"'
    if (
      !tail.source.endsWith(quote) ||
      titleFont !== sectionFont ||
      native
        .slice(0, 2)
        .flat()
        .some(
          (item) =>
            item.fontName !== titleFont || Math.abs(item.height - titleSize) > bodyFont * 0.02
        ) ||
      titleSize <= bodyFont * 1.15 ||
      [fragment.rect, end].some(
        (rect) =>
          rect.right - rect.x < page.width * 0.5 ||
          Math.abs((rect.x + rect.right) / 2 - page.width / 2) > page.width * 0.1
      ) ||
      end.y <= fragment.rect.bottom ||
      end.y - fragment.rect.bottom > bodyFont * 1.5 ||
      overview.kind !== 'prose-candidate' ||
      wordCount(overview.source) < 24 ||
      !terminal(overview.source) ||
      !/^The supplementary materials?\b/iu.test(overview.source) ||
      Math.abs(body.font - bodyFont) > bodyFont * 0.055 ||
      body.right - body.x < page.width * 0.5 ||
      body.y <= end.bottom ||
      body.y - end.bottom > bodyFont * 3 ||
      native[2].some(
        (item) => item.fontName === titleFont || item.fontName !== native[2][0].fontName
      ) ||
      section.kind !== 'heading-candidate' ||
      !/^S[1-9]\d*\s+\p{Lu}/u.test(section.source) ||
      Math.abs(heading.font - reference.rect.font) > bodyFont * 0.02 ||
      heading.font <= titleSize ||
      native[3].some((item) => item.fontName !== sectionFont) ||
      Math.abs(heading.x - body.x) > bodyFont * 0.2 ||
      heading.y <= body.bottom ||
      heading.y - body.bottom > bodyFont * 5
    )
      return false
    const labels = new Set(
      [...overview.source.matchAll(/\bSection (S[1-9]\d*)\b/gu)].map((match) => match[1])
    )
    if (labels.size < 2 || !labels.has(section.source.split(' ')[0])) return false
    const owned = parts.flatMap((part) => part.items.map((key) => Number(key.split(':')[1])))
    if (
      new Set(owned).size !== owned.length ||
      owned.some((value, at) => at > 0 && value <= owned[at - 1])
    )
      return false
    const keys = new Set(owned)
    if (
      raw
        .slice(owned[0], owned.at(-1)! + 1)
        .some((item, offset) => item.str.trim() && !keys.has(owned[0] + offset))
    )
      return false
    wrappedSupplementStyle = {
      body: native[2][0].fontName!,
      section: sectionFont!,
      size: body.font,
      headingSize: heading.font
    }
    return true
  }
  // A short second heading line is eligible only as the complete continuation
  // of an already admitted numbered supplementary heading, never as short prose.
  const nativeWrappedSectionTail = (head: LayoutUnit, index: number): LayoutUnit | undefined => {
    const tail = units[index + 1],
      next = units[index + 2],
      style = wrappedSupplementStyle
    if (
      !style ||
      !tail ||
      !next ||
      head.sourceOnly ||
      tail.sourceOnly ||
      [head, tail, next].some((u) => u.risks.length || u.fragments.length !== 1) ||
      head.kind !== 'heading-candidate' ||
      tail.kind !== 'heading-candidate' ||
      !/^\p{Lu}[\p{L}\p{M}]*(?:[ -][\p{L}\p{M}]+)?$/u.test(tail.source)
    )
      return
    const first = head.fragments[0],
      end = tail.fragments[0],
      after = next.fragments[0],
      page = pages.find((p) => p.page === first.page)!,
      raw = rawItems.get(first.page)!,
      a = nativeCaptionItems(head),
      b = nativeCaptionItems(tail),
      c = nativeCaptionItems(next)
    if (
      end.page !== first.page ||
      after.page !== first.page ||
      a.length !== 2 ||
      b.length !== 1 ||
      !c.length ||
      !/^S[1-9]\d*(?:\.\d+)*$/u.test(a[0].str) ||
      wordCount(a[1].str) < 3 ||
      head.source !== a[0].str + ' ' + a[1].str ||
      a[0].hasEOL !== false ||
      a[1].hasEOL !== true ||
      b[0].hasEOL !== false ||
      a
        .concat(b, c)
        .some(
          (i) =>
            !completeNativeText(i) ||
            i.dir !== 'ltr' ||
            i.transform.length !== 6 ||
            !Number.isFinite(i.width) ||
            !Number.isFinite(i.height) ||
            i.transform[1] !== 0 ||
            i.transform[2] !== 0 ||
            i.fontAscent! <= 0 ||
            i.fontAscent! > 1 ||
            i.fontDescent! < -1 ||
            i.fontDescent! > 0 ||
            Math.abs(i.transform[3] - i.height) > 1e-6
        ) ||
      a
        .concat(b)
        .some((i) => i.fontName !== style.section || Math.abs(i.height - first.rect.font) > 1e-6) ||
      c.some((i) => i.height > style.size * 1.1) ||
      first.rect.font <= style.size * 1.15 ||
      Math.abs(a[0].transform[5] - a[1].transform[5]) > 1e-6 ||
      a[1].transform[4] - a[0].transform[4] - a[0].width <= first.rect.font * 0.5 ||
      Math.abs(b[0].transform[4] - a[1].transform[4]) > 1e-6 ||
      a[1].transform[5] - b[0].transform[5] < first.rect.font * 1.2 ||
      a[1].transform[5] - b[0].transform[5] > first.rect.font * 1.6 ||
      first.rect.right - first.rect.x < page.width * 0.65 ||
      first.rect.right < page.width - first.rect.x - first.rect.font ||
      end.rect.right >= first.rect.right ||
      end.rect.y <= first.rect.bottom ||
      after.rect.y - end.rect.bottom < first.rect.font * 0.5 ||
      after.rect.y - end.rect.bottom > first.rect.font * 1.5 ||
      Math.abs(after.rect.x - first.rect.x) > first.rect.font * 0.2 ||
      [first.rect, end.rect, after.rect].some(
        (r) => r.x < 0 || r.y < 0 || r.right > page.width || r.bottom > page.height
      )
    )
      return
    const keys = head.items.concat(tail.items).map((k) => Number(k.split(':')[1])),
      following = Number(next.items[0].split(':')[1]),
      owned = new Set(keys)
    if (
      owned.size !== keys.length ||
      keys.some((k, i) => i && k <= keys[i - 1]) ||
      following <= keys.at(-1)! ||
      raw
        .slice(keys[0], keys.at(-1)! + 1)
        .some((i, offset) => i.str.trim() && !owned.has(keys[0] + offset)) ||
      !raw.slice(keys.at(-1)! + 1, following).some((i) => !i.str.trim() && i.hasEOL === true) ||
      raw.slice(keys.at(-1)! + 1, following).some((i) => i.str.trim()) ||
      page.blocks.some(
        (block) =>
          block.id !== first.id &&
          block.id !== end.id &&
          block.rect.y < end.rect.bottom &&
          block.rect.bottom > first.rect.y
      )
    )
      return
    return tail
  }
  const nativeCaption = (unit: LayoutUnit): boolean => {
    if (
      unit.sourceOnly ||
      unit.risks.length ||
      unit.fragments.length !== 1 ||
      !/^(?:Figure|Fig\.|Table|Tab\.)\s+\d+[.:]\s+\p{Lu}/u.test(unit.source) ||
      wordCount(unit.source) < 8 ||
      !terminal(unit.source)
    )
      return false
    const items = nativeCaptionItems(unit),
      first = items[0]
    if (!first || !items.every(completeNativeText)) return false
    const body = items.find((item) => item.fontName !== first.fontName)
    return (
      !!body &&
      /^(?:Figure|Fig\.|Table|Tab\.)(?:\s+\d+\.?)?$/u.test(first.str.trim()) &&
      Math.abs(body.transform[5] - first.transform[5]) < first.height * 0.05 &&
      Math.abs(body.height - first.height) < first.height * 0.05 &&
      items
        .slice(0, items.indexOf(body))
        .every((item) => Math.abs(item.transform[5] - first.transform[5]) < first.height * 0.05) &&
      unit.fragments[0].rect.right - unit.fragments[0].rect.x >
        pages.find((page) => page.page === unit.fragments[0].page)!.width * 0.5
    )
  }
  const isolatedCaptions = new Set<LayoutUnit>()
  for (const page of pages) {
    const parts = units.filter((unit) =>
      unit.fragments.some((fragment) => fragment.page === page.page)
    )
    const captions = parts.filter(nativeCaption)
    if (
      !captions.length ||
      parts.some(
        (unit) =>
          !captions.includes(unit) &&
          !(
            unit.fragments.length === 1 &&
            /^(?:Figures|Tables):$/u.test(unit.source) &&
            nativeCaptionItems(unit).every(completeNativeText)
          )
      )
    )
      continue
    const owned = new Set(parts.flatMap((unit) => unit.items))
    if (
      rawItems
        .get(page.page)!
        .some((item, index) => item.str.trim() && !owned.has(page.page + ':' + index))
    )
      continue
    for (const unit of captions) isolatedCaptions.add(unit)
  }
  // A styled panel letter can split an otherwise ordinary caption noun. Keep
  // its established unit and literal text; restore eligibility only when a
  // second native panel marker proves the style and the prose returns inline.
  const nativeCaptionPanel = (unit: LayoutUnit, index: number): boolean => {
    const before = units[index - 1],
      after = units[index + 1]
    if (
      !unit.sourceOnly ||
      unit.risks.length ||
      !before ||
      !after ||
      before.sourceOnly ||
      after.sourceOnly ||
      !/^(?:Figure|Fig\.)\s*\d+[.:]\s/iu.test(before.source) ||
      terminal(before.source) ||
      !/^[a-z]{3,} \([A-Z]$/u.test(unit.source) ||
      /^(?:sin|cos|tan|log|ln|exp|min|max|det|relu|softmax|sigmoid|norm|var)\b/u.test(
        unit.source
      ) ||
      !/^\)[.,;:]?\s+\p{Lu}[\p{L}-]{2,}/u.test(after.source) ||
      [before, unit, after].some(
        (part) => part.fragments.length !== 1 || part.fragments[0].page !== unit.fragments[0].page
      )
    )
      return false
    const body = nativeCaptionItems(before),
      prefix = nativeCaptionItems(unit),
      tail = nativeCaptionItems(after)
    if (prefix.length !== 2 || ![...body, ...prefix, ...tail].every(completeNativeText))
      return false
    const [noun, label] = prefix,
      last = body.at(-1)!,
      close = tail[0],
      font = noun.height
    const adjacent = (left: PdfLayoutTextItem, right: PdfLayoutTextItem): boolean =>
      Math.abs(left.transform[5] - right.transform[5]) < font * 0.05 &&
      Math.abs(right.height - font) < font * 0.05 &&
      right.transform[4] - (left.transform[4] + left.width) >= -font * 0.05 &&
      right.transform[4] - (left.transform[4] + left.width) < font * 0.5
    const raw = rawItems.get(unit.fragments[0].page)!,
      indexes = [before.items.at(-1)!, ...unit.items, after.items[0]].map((key) =>
        Number(key.split(':')[1])
      )
    if (
      indexes.some(
        (value, at) =>
          at > 0 &&
          (value <= indexes[at - 1] ||
            raw.slice(indexes[at - 1] + 1, value).some((item) => item.str.trim()))
      )
    )
      return false
    return (
      /^\p{Ll}{3,} \($/u.test(noun.str) &&
      /^[A-Z]$/u.test(label.str) &&
      last.fontName === noun.fontName &&
      close.fontName === noun.fontName &&
      label.fontName !== noun.fontName &&
      adjacent(noun, label) &&
      adjacent(label, close) &&
      last.transform[5] - noun.transform[5] > font * 0.75 &&
      last.transform[5] - noun.transform[5] < font * 1.7 &&
      Math.abs(last.transform[4] - noun.transform[4]) < font * 0.15 &&
      last.width > font * 20 &&
      tail.some(
        (item, at) =>
          at > 0 &&
          at < tail.length - 1 &&
          /^[A-Z]$/u.test(item.str) &&
          item.str !== label.str &&
          item.fontName === label.fontName &&
          /\($/u.test(tail[at - 1].str) &&
          /^\)/u.test(tail[at + 1].str) &&
          tail[at - 1].fontName === noun.fontName &&
          tail[at + 1].fontName === noun.fontName &&
          adjacent(tail[at - 1], item) &&
          adjacent(item, tail[at + 1])
      )
    )
  }
  for (const [index, unit] of units.entries()) {
    if (nativeCaptionPanel(unit, index)) delete unit.sourceOnly
    const heading = unit.source
      .trim()
      .replace(/^(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[.)])\s+/i, '')
      .replace(/[:：]$/, '')
    if (
      /^(?:references|bibliography|literature cited|works cited|参考文献|參考文獻)$/i.test(
        heading
      ) &&
      !isContentsEntry(unit)
    ) {
      references = true
      referenceHeading = unit
    } else if (
      references &&
      // Only appendix/supplement headings allow a subtitle. A citation such as
      // "8. Funding: A study ..." must not end the bibliography.
      (nativePostReferenceSections(unit, pages, rawItems) ||
        nativeSupplementBoundary(unit, index) ||
        nativeWrappedSupplementBoundary(unit, index) ||
        supplementaryTitleBoundary(unit) ||
        (unit.kind === 'heading-candidate' &&
          (/^[A-Z] [A-Z][A-Z0-9 ,:()–—-]{3,100}$/.test(heading) ||
            // Title-case lettered appendices use a distinct, larger heading.
            // A body-sized bibliographic title must not release reference mode.
            (/^[A-Z]\.? [A-Z][A-Za-z0-9 ,:()–—-]{3,100}$/.test(
              // Decimal section references are part of a title; an author's
              // initial or sentence period still cannot end the bibliography.
              heading.replace(/(?<=\d)\.(?=\d)/g, '')
            ) &&
              unit.fragments.length === 1 &&
              unit.fragments[0].rect.font > bodyFont * 1.05))) ||
        /^(?:appendix|appendices|supplement(?:ary)?(?: material| materials| information)?|supporting information|附录|附錄)(?:\s+[A-Z0-9]+)?(?:[.:：]\s+.{1,80})?$/i.test(
          heading
        ) ||
        /^(?:acknowledg(?:e)?ments?|funding|author contributions|disclosures|conflicts? of interest|(?:data|code|data and code) availability(?: statement)?)$/i.test(
          heading
        ))
    )
      references = false
    if (
      references &&
      referenceHeading &&
      // An appendix heading just inside the page-margin cutoff can have kind
      // "other". The native section/subsection/body proof below still applies.
      (unit.kind === 'heading-candidate' || /^[A-Z] Appendix$/u.test(unit.source)) &&
      !unit.sourceOnly &&
      unit.fragments.length === 1 &&
      /^[\p{Lu}][\p{L} ]{3,70}$/u.test(unit.source)
    ) {
      const fragment = unit.fragments[0],
        reference = referenceHeading.fragments[0]
      const subsection = units[index + 1],
        subsectionFragment = subsection?.fragments[0]
      const letteredAppendix =
        /^[A-Z] Appendix$/u.test(unit.source) &&
        subsection?.kind === 'heading-candidate' &&
        subsection.source[0] === unit.source[0] &&
        /^[A-Z]\.\d+(?:\.\d+)*\s+\p{Lu}/u.test(subsection.source) &&
        subsection.fragments.length === 1 &&
        subsectionFragment?.page === fragment.page &&
        Math.abs(subsectionFragment.rect.x - fragment.rect.x) < bodyFont * 0.2 &&
        subsectionFragment.rect.y - fragment.rect.bottom > bodyFont * 0.5 &&
        subsectionFragment.rect.y - fragment.rect.bottom < bodyFont * 3
      const firstSection = letteredAppendix ? subsection : unit,
        following = units[index + (letteredAppendix ? 2 : 1)],
        body = following?.fragments[0]
      const page = pages.find((page) => page.page === fragment.page)!
      const fontName = rawItems.get(reference.page)![
        Number(referenceHeading.items[0].split(':')[1])
      ].fontName
      // An unnumbered section can restart after a bibliography. Prove a new
      // page's first heading in the same native section font/alignment, followed
      // immediately by a complete, wide body paragraph. Running titles, entry
      // titles, small headings and formulas cannot release reference mode.
      if (
        fontName &&
        firstContent.get(fragment.page) === firstSection &&
        fragment.page > reference.page &&
        fragment.rect.y < page.height * 0.16 &&
        fragment.rect.font > bodyFont * 1.15 &&
        Math.abs(fragment.rect.font - reference.rect.font) < bodyFont * 0.02 &&
        Math.abs(fragment.rect.x - reference.rect.x) < bodyFont * 0.2 &&
        unit.items.every(
          (key) => rawItems.get(fragment.page)![Number(key.split(':')[1])].fontName === fontName
        ) &&
        following?.kind === 'prose-candidate' &&
        !following.sourceOnly &&
        following.fragments.length === 1 &&
        body?.page === fragment.page &&
        Math.abs(body.rect.x - fragment.rect.x) < bodyFont * 0.2 &&
        body.rect.right - body.rect.x > page.width * 0.5 &&
        body.rect.y - firstSection.fragments[0].rect.bottom > bodyFont * 0.5 &&
        body.rect.y - firstSection.fragments[0].rect.bottom < bodyFont * 3 &&
        wordCount(following.source) >= 24 &&
        terminal(following.source) &&
        !/^(?:\[\d|\(?\d+[.)])/u.test(following.source) &&
        Math.abs(body.rect.font - bodyFont) < bodyFont * 0.055
      )
        references = false
    }
    // An appendix float may be placed before its section heading. It is
    // independently captioned material, not a bibliography continuation.
    const appendixCaption = /^(?:Table|Tab\.|Figure|Fig\.)\s+([A-Z])\.\d+[.:]\s+\p{Lu}/u.exec(
      unit.source
    )
    const floatingAppendixCaption =
      references &&
      appendixCaption &&
      !unit.sourceOnly &&
      unit.fragments.length === 1 &&
      units.slice(index + 1).some((section) => {
        const caption = unit.fragments[0],
          heading = section.fragments[0]
        return (
          section.kind === 'heading-candidate' &&
          section.fragments.length === 1 &&
          new RegExp('^Appendix ' + appendixCaption[1] + '(?:[.:] |$)', 'u').test(section.source) &&
          heading.page === caption.page &&
          heading.rect.y > caption.rect.bottom &&
          heading.rect.font > caption.rect.font * 1.1 &&
          !units
            .slice(index + 1, units.indexOf(section))
            .some(
              (between) =>
                between.kind === 'heading-candidate' &&
                /^(?:References|Bibliography|Appendix)\b/u.test(between.source)
            )
        )
      })
    if (references && !floatingAppendixCaption && !isolatedCaptions.has(unit))
      unit.sourceOnly = true
    // Ending a mis-scoped bibliography must not release short formula pieces
    // or an algorithm merely because they escaped the earlier classification.
    // Restore only the complete native body style proved by this supplement's
    // overview, or its independently styled numbered section headings.
    if (wrappedSupplementStyle && !references && !unit.sourceOnly) {
      const style = wrappedSupplementStyle,
        items = nativeCaptionItems(unit)
      const complete =
        items.length > 0 &&
        items.every(
          (item) =>
            completeNativeText(item) &&
            item.dir === 'ltr' &&
            item.transform.length === 6 &&
            Number.isFinite(item.width) &&
            Number.isFinite(item.height)
        )
      const prose =
        complete &&
        unit.kind === 'prose-candidate' &&
        unit.risks.every((risk) => risk === 'possible-continuation') &&
        wordCount(unit.source) >= 12 &&
        /^\p{Lu}/u.test(unit.source) &&
        /[.!?](?:$|\s+\p{Lu})/u.test(unit.source) &&
        items.every(
          (item) =>
            item.fontName === style.body && Math.abs(item.height - style.size) < style.size * 0.055
        )
      const section =
        complete &&
        !unit.risks.length &&
        unit.kind === 'heading-candidate' &&
        /^S[1-9]\d*(?:\.\d+)*\s+\p{Lu}/u.test(unit.source) &&
        items.every(
          (item) =>
            item.fontName === style.section &&
            item.height > style.size * 1.15 &&
            item.height <= style.headingSize * 1.02
        )
      if (section) {
        const tail = nativeWrappedSectionTail(unit, index)
        if (tail) wrappedSectionTails.add(tail)
      }
      if (!prose && !section && !wrappedSectionTails.has(unit)) unit.sourceOnly = true
    }
    // A bibliography's smaller type intentionally bypasses body paragraph flow.
    // Restore only a native-adjacent broken word across two columns, with an
    // independently occurring complete word and the next author's hanging reset.
    const previous = units[index - 1],
      following = units[index + 1]
    const left = previous?.fragments.at(-1),
      right = unit.fragments[0]
    const next = following?.fragments[0]
    const prefix = /([a-z]{3,})-$/u.exec(previous?.source ?? '')?.[1]
    const suffix = /^([a-z]{2,})\s+[a-z]{3,}/u.exec(unit.source)?.[1]
    // Numbered bibliography entries can split at their bracket-only marker or
    // an ordinary hanging wrap. Reference mode provides the semantic boundary;
    // native order, type and geometry still prove every item belongs to it.
    if (
      references &&
      previous?.sourceOnly &&
      !joinedReferenceTails.has(previous) &&
      /^\[\d{1,3}\](?:\s+\p{L}|$)/u.test(previous.source) &&
      !/^\[\d/u.test(unit.source) &&
      /^[\p{Script=Latin}\p{M}]/u.test(unit.source) &&
      wordCount(unit.source) >= 4 &&
      left?.page === right.page &&
      Math.abs(left.rect.font - right.rect.font) < bodyFont * 0.05
    ) {
      const items = rawItems.get(right.page)!,
        before = Number(previous.items.at(-1)!.split(':')[1]),
        after = Number(unit.items[0].split(':')[1]),
        last = items[before],
        first = items[after],
        font = left.rect.font,
        gap = last.transform[5] - first.transform[5]
      const marker = /^\[\d{1,3}\]$/u.test(previous.source)
      const markerRow =
        marker &&
        Math.abs(gap) < font * 0.05 &&
        !last.hasEOL &&
        first.transform[4] - last.transform[4] - last.width > 0 &&
        first.transform[4] - last.transform[4] - last.width < font * 0.8
      const hangingWrap =
        !marker &&
        !terminal(previous.source) &&
        last.hasEOL &&
        gap > font * 0.8 &&
        gap < font * 1.25 &&
        right.rect.x - previous.fragments[0].rect.x > font * 0.5 &&
        right.rect.x - previous.fragments[0].rect.x < font * 3 &&
        right.rect.right <= left.rect.right + font * 0.2
      const keys = [...previous.items, ...unit.items].map((key) => Number(key.split(':')[1]))
      const owned = new Set(keys)
      if (
        (markerRow || hangingWrap) &&
        last.fontName &&
        first.fontName === last.fontName &&
        keys.every((key, at) => !at || key > keys[at - 1]) &&
        items.slice(before + 1, after).every((item) => !item.str.trim()) &&
        items
          .slice(keys[0], keys.at(-1)! + 1)
          .every((item, at) => !item.str.trim() || owned.has(keys[0] + at)) &&
        keys.every((key) => {
          const item = items[key]
          return (
            item.fontName &&
            item.transform.every(Number.isFinite) &&
            Math.abs(item.height - font) < font * 0.05 &&
            Math.abs(item.transform[0] - item.height) < font * 0.05 &&
            Math.abs(item.transform[3] - item.height) < font * 0.05 &&
            Math.abs(item.transform[1]) < 0.001 &&
            Math.abs(item.transform[2]) < 0.001 &&
            item.width > 0
          )
        }) &&
        !pages
          .find((page) => page.page === right.page)!
          .blocks.some(
            (block) =>
              block.tableCell && block.items.some((key) => owned.has(Number(key.split(':')[1])))
          )
      ) {
        previous.source = joinCaptionLines([previous.source, unit.source], lexicon)
        previous.items.push(...unit.items)
        previous.originalStrings.push(...unit.originalStrings)
        previous.fragments.push(...unit.fragments)
        previous.risks = [...new Set([...previous.risks, ...unit.risks])]
        joinedReferenceTails.add(unit)
        continue
      }
    }
    if (
      !references ||
      !referenceHeading ||
      !previous?.sourceOnly ||
      !prefix ||
      !suffix ||
      !lexicon.has(prefix + suffix) ||
      lexicon.has(prefix + '-' + suffix) ||
      previous.fragments.length !== 1 ||
      unit.fragments.length !== 1 ||
      !next ||
      left!.page !== right.page ||
      next.page !== right.page ||
      referenceHeading.fragments[0].page !== right.page ||
      !/^[A-Z][^=+*/<>]*,.*\b(?:19|20)\d{2}\b/u.test(previous.source) ||
      wordCount(previous.source) < 16 ||
      !/^[A-Z][^,]+,/u.test(following.source) ||
      wordCount(following.source) < 5 ||
      !/^[\p{Script=Latin}\p{M}\d\s,.;:'’"“”()[\]–—:/-]+$/u.test(previous.source + unit.source) ||
      /\b[A-Za-z]\s*[-/]\s*[A-Za-z]\b/u.test(previous.source + unit.source) ||
      /\b(?:sin|cos|tan|log|exp|(?:arg)?min|(?:arg)?max)\s*\(/u.test(
        previous.source + unit.source
      ) ||
      [previous, unit].some((part) =>
        part.risks.some(
          (risk) => risk !== 'ambiguous-line-hyphen' && risk !== 'possible-continuation'
        )
      )
    )
      continue
    const page = pages.find((page) => page.page === right.page)!,
      items = rawItems.get(right.page)!
    const before = Number(previous.items.at(-1)!.split(':')[1]),
      after = Number(unit.items[0].split(':')[1])
    const last = items[before],
      first = items[after],
      author = items[Number(following.items[0].split(':')[1])]
    const font = left!.rect.font,
      indent = last.transform[4] - left!.rect.x
    const keys = [...previous.items, ...unit.items].map((key) => Number(key.split(':')[1]))
    const owned = new Set(keys)
    let nativeRow = 0
    const rows = items.map((item) => {
      const row = nativeRow
      if (item.hasEOL) nativeRow++
      return row
    })
    const ownedRows = new Set(keys.map((key) => rows[key]))
    const rowBaselines = new Map<number, number>()
    for (const key of keys)
      if (!rowBaselines.has(rows[key])) rowBaselines.set(rows[key], items[key].transform[5])
    if (
      keys.some(
        (key) => Math.abs(items[key].transform[5] - rowBaselines.get(rows[key])!) > font * 0.05
      ) ||
      Math.abs(author.height - font) > font * 0.05 ||
      items.some((item, key) => item.str.trim() && ownedRows.has(rows[key]) && !owned.has(key)) ||
      left!.rect.bottom < page.height * 0.8 ||
      right.rect.y > page.height * 0.16 ||
      left!.rect.x > page.width * 0.4 ||
      right.rect.x < left!.rect.x + page.width * 0.2 ||
      Math.abs(left!.rect.right - left!.rect.x - (right.rect.right - right.rect.x)) >
        (left!.rect.right - left!.rect.x) * 0.15 ||
      Math.abs(right.rect.font - font) > font * 0.05 ||
      indent < font * 0.6 ||
      indent > font * 1.5 ||
      Math.abs(first.transform[4] - right.rect.x) > font * 0.05 ||
      Math.abs(right.rect.x - author.transform[4] - indent) > font * 0.15 ||
      next.rect.y - right.rect.bottom < font * 0.4 ||
      next.rect.y - right.rect.bottom > font * 2 ||
      last.fontName !== first.fontName ||
      author.fontName !== first.fontName ||
      before >= after ||
      !last.hasEOL ||
      items.slice(before, after).filter((item) => item.hasEOL).length !== 1 ||
      items.slice(before + 1, after).some((item) => item.str.trim()) ||
      keys.some((key, n) => n > 0 && key <= keys[n - 1]) ||
      items
        .slice(keys[0], keys.at(-1)! + 1)
        .some((item, n) => item.str.trim() && !owned.has(keys[0] + n)) ||
      [
        ...keys.map((key) => items[key]),
        author,
        ...referenceHeading.items.map((key) => items[Number(key.split(':')[1])])
      ].some(
        (item) =>
          !item.fontName ||
          item.transform.length !== 6 ||
          !item.transform.every(Number.isFinite) ||
          !Number.isFinite(item.height) ||
          !Number.isFinite(item.width) ||
          item.width <= 0 ||
          item.height <= 0 ||
          Math.abs(item.transform[0] - item.height) > item.height * 0.05 ||
          Math.abs(item.transform[3] - item.height) > item.height * 0.05 ||
          Math.abs(item.transform[1]) > 0.001 ||
          Math.abs(item.transform[2]) > 0.001
      ) ||
      keys.some((key) => Math.abs(items[key].height - font) > font * 0.05) ||
      page.blocks.some(
        (block) =>
          block.tableCell && block.items.some((key) => owned.has(Number(key.split(':')[1])))
      )
    )
      continue
    joins.push({
      from: left!.id,
      to: right.id,
      kind: 'column',
      left: previous.source.slice(-180),
      right: unit.source.slice(0, 180)
    })
    previous.source = joinCaptionLines([previous.source, unit.source], lexicon)
    previous.items.push(...unit.items)
    previous.originalStrings.push(...unit.originalStrings)
    previous.fragments.push(...unit.fragments)
    previous.risks = [...new Set([...previous.risks, ...unit.risks])]
    joinedReferenceTails.add(unit)
  }
  return { bodyFont, pages, units: units.filter((unit) => !joinedReferenceTails.has(unit)), joins }
}

// Use the same native font extent for owned text and competing text.
function nativeProseProofDomain(items: PdfLayoutTextItem[]): Rect | undefined {
  const rects: Rect[] = []
  for (const item of items) {
    if (!item.str.trim()) continue
    if (
      item.transform.length !== 6 ||
      ![...item.transform, item.width, item.height].every(Number.isFinite) ||
      item.transform[0] <= 0 ||
      item.transform[3] <= 0 ||
      item.transform[1] !== 0 ||
      item.transform[2] !== 0 ||
      item.width < 0 ||
      item.height <= 0 ||
      !Number.isFinite(item.fontAscent) ||
      !Number.isFinite(item.fontDescent)
    )
      return undefined
    const ascent = item.fontAscent!,
      descent = item.fontDescent!
    if (ascent <= descent) return undefined
    rects.push({
      x: item.transform[4],
      right: item.transform[4] + item.width,
      y: item.transform[5] + item.height * descent,
      bottom: item.transform[5] + item.height * ascent
    })
  }
  return rects.length ? bounds(rects) : undefined
}
function nativeTextOverlapsProof(item: PdfLayoutTextItem, domain: Rect): boolean {
  if (!item.str.trim()) return false
  const rect = nativeProseProofDomain([item])
  return (
    !rect ||
    (rect.x < domain.right &&
      rect.right >= domain.x &&
      rect.bottom > domain.y &&
      rect.y < domain.bottom)
  )
}

// Short closed references can resemble function calls after symbolic token removal.
// Release only complete native text with an adjacent, independently owned prose row.
function nativeClosedReferenceProse(
  block: LayoutBlock,
  page: LayoutPage,
  raw: PdfLayoutTextItem[]
): boolean {
  const numbered = /^\((\d+)\) [A-Z][a-z]+(?: [a-z]+)+ \((\d+)\)\.$/u.exec(block.source)
  const citation = /^[a-z]{3,} from \[\d+\]\.$/u.test(block.source)
  if (
    (!numbered && !citation) ||
    block.sourceOnly ||
    block.tableCell ||
    block.risks.length ||
    block.lines.length !== 1 ||
    block.items.length !== (numbered ? 1 : 3)
  )
    return false
  const indices = block.items.map((key) => Number(key.split(':')[1]))
  const current = indices.map((index) => raw[index]),
    first = current[0]
  if (!first?.fontName || current.some((item) => !item)) return false
  const font = first.height,
    y = first.transform[5],
    x = first.transform[4]
  if (
    current.some(
      (item, i) =>
        !item.fontName ||
        item.dir !== 'ltr' ||
        item.width <= 0 ||
        Math.abs(item.height - font) > font * 0.05 ||
        Math.abs(item.transform[5] - y) > font * 0.05 ||
        (i > 0 &&
          (indices[i] <= indices[i - 1] ||
            current[i - 1].hasEOL ||
            Math.abs(item.transform[4] - current[i - 1].transform[4] - current[i - 1].width) >
              font * 0.15))
    )
  )
    return false
  if (numbered) {
    if (first.str !== block.source || Number(numbered[1]) !== Number(numbered[2]) + 1) return false
  } else if (
    !/^[a-z]{3,} from \[$/u.test(first.str) ||
    !/^\d+$/u.test(current[1].str) ||
    current[2].str !== '].' ||
    current[2].fontName !== first.fontName
  )
    return false
  const previous = page.blocks.filter((owner) => {
    if (
      owner === block ||
      owner.tableCell ||
      owner.sourceOnly ||
      owner.risks.some((risk) => !['ambiguous-line-hyphen', 'possible-continuation'].includes(risk))
    )
      return false
    const line = owner.lines.at(-1)!
    const keys = line.items.map((key) => Number(key.split(':')[1]))
    const items = keys.map((index) => raw[index]),
      last = items.at(-1)!
    if (
      !items.length ||
      !last?.hasEOL ||
      Math.max(...keys) >= indices[0] ||
      raw.slice(Math.max(...keys) + 1, indices[0]).some((item) => item.str.trim()) ||
      Math.abs(line.x - x) > font * 0.15 ||
      last.transform[5] - y < font * 0.75 ||
      last.transform[5] - y > font * 1.7 ||
      items[0].fontName !== first.fontName ||
      last.fontName !== first.fontName ||
      Math.abs(items[0].height - font) > font * 0.05 ||
      Math.abs(last.height - font) > font * 0.05 ||
      symbolicExpression(line.text) ||
      (line.text.match(/[A-Za-z]{2,}/gu)?.length ?? 0) < (numbered ? 6 : 8)
    )
      return false
    if (numbered) {
      if (!owner.source.startsWith('(' + numbered[2] + ') ')) return false
    } else if (
      !/[a-z]{2,}-$/u.test(line.text) ||
      current.at(-1)!.transform[4] + current.at(-1)!.width >= line.right - font * 2
    )
      return false
    const used = new Set([...keys, ...indices])
    if (
      [...used].some(
        (index) =>
          !raw[index].fontName ||
          Math.abs(raw[index].transform[3] - raw[index].height) > raw[index].height * 0.05 ||
          page.blocks.filter((owner) => owner.items.includes(`${page.page}:${index}`)).length !== 1
      )
    )
      return false
    const domains = [
      nativeProseProofDomain(current),
      ...items.map((item) => nativeProseProofDomain([item]))
    ]
    return (
      domains.every((domain) => !!domain) &&
      !raw.some(
        (item, index) =>
          !used.has(index) && domains.some((domain) => nativeTextOverlapsProof(item, domain!))
      )
    )
  })
  return previous.length === 1
}

// A date-bearing continuation requires two complete native prose rows.
function nativeContinuedLiteralProse(
  block: LayoutBlock,
  page: LayoutPage,
  raw: PdfLayoutTextItem[]
): boolean {
  if (
    block.sourceOnly ||
    block.tableCell ||
    block.risks.length ||
    block.lines.length !== 1 ||
    !/^(?:(?:day|date) \((?:[1-9]|1[0-2])\/(?:[1-9]|[12]\d|3[01])\) and)$/u.test(block.source)
  )
    return false
  const firstIndex = Number(block.items[0].split(':')[1]),
    first = raw[firstIndex]
  if (!first?.fontName) return false
  let start = firstIndex
  while (start > 0 && !raw[start - 1].hasEOL) start--
  let end = start
  while (end < raw.length && !raw[end].hasEOL) end++
  if (start === 0 || end === raw.length) return false
  let previousStart = start - 1
  while (previousStart > 0 && !raw[previousStart - 1].hasEOL) previousStart--
  const current = raw.slice(start, end + 1).filter((item) => item.str.trim()),
    previous = raw.slice(previousStart, start).filter((item) => item.str.trim()),
    font = first.height
  if (!current.length || !previous.length || current[0] !== first) return false
  const valid = (item: PdfLayoutTextItem): boolean =>
    item.fontName === first.fontName &&
    item.dir === 'ltr' &&
    item.width > 0 &&
    font > 0 &&
    [...item.transform, item.width, item.height].every(Number.isFinite) &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    item.transform[1] === 0 &&
    item.transform[2] === 0 &&
    Math.abs(item.height - font) < font * 0.05
  const text = (items: PdfLayoutTextItem[]): string => items.map((item) => item.str).join(' ')
  if (
    ![...current, ...previous].every(valid) ||
    [current, previous].some(
      (row) =>
        (text(row).match(/[A-Za-z]{2,}/gu)?.length ?? 0) < 8 ||
        !/^[A-Za-z0-9\s.,;:'’()[\]/–—-]+$/u.test(text(row)) ||
        row.some(
          (item, i) =>
            Math.abs(item.transform[5] - row[0].transform[5]) > font * 0.05 ||
            (i > 0 &&
              (item.transform[4] < row[i - 1].transform[4] + row[i - 1].width - font * 0.05 ||
                item.transform[4] > row[i - 1].transform[4] + row[i - 1].width + font * 0.8))
        )
    ) ||
    /[.!?:;]$/u.test(text(previous).trim())
  )
    return false
  const joined = text(current)
  for (const [opening, closing] of [
    ['(', ')'],
    ['[', ']']
  ]) {
    let depth = 0
    for (const char of joined) {
      if (char === opening) depth++
      if (char === closing && --depth < 0) return false
    }
    if (depth) return false
  }
  const x = first.transform[4],
    y = first.transform[5],
    oldY = previous[0].transform[5],
    right = previous.at(-1)!.transform[4] + previous.at(-1)!.width
  if (
    Math.abs(previous[0].transform[4] - x) > font * 0.2 ||
    oldY - y < font * 0.75 ||
    oldY - y > font * 2 ||
    current.at(-1)!.transform[4] + current.at(-1)!.width > right + font * 0.2
  )
    return false
  const domain = nativeProseProofDomain([...current, ...previous])
  if (!domain) return false
  return (
    !raw.some(
      (item, index) =>
        (index < previousStart || index > end) && nativeTextOverlapsProof(item, domain)
    ) &&
    block.items.every(
      (key) => page.blocks.filter((owner) => owner.items.includes(key)).length === 1
    )
  )
}

// Explicit equation references retain the native body font and nearby prose.
function nativeNamedEquationProse(
  block: LayoutBlock,
  page: LayoutPage,
  raw: PdfLayoutTextItem[]
): boolean {
  if (
    block.sourceOnly ||
    block.tableCell ||
    block.risks.length ||
    block.lines.length !== 1 ||
    !/^(?:(?:Hence|From|By|Using|See) Eq\.|Equations?) \((?:[A-Z]|\d+)\.\d+\)(?: and \((?:[A-Z]|\d+)\.\d+\))?[,.:]?$/u.test(
      block.source
    )
  )
    return false
  const indices = block.items.map((key) => Number(key.split(':')[1])),
    items = indices.map((i) => raw[i]),
    first = items[0],
    last = items.at(-1)!
  if (!first?.fontName || !last || indices.some((i, n) => n > 0 && i <= indices[n - 1]))
    return false
  const font = first.height,
    y = first.transform[5],
    x = first.transform[4]
  const valid = (item: PdfLayoutTextItem): boolean =>
    !!item &&
    item.fontName === first.fontName &&
    item.dir === 'ltr' &&
    item.width > 0 &&
    font > 0 &&
    [...item.transform, item.width, item.height].every(Number.isFinite) &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    item.transform[1] === 0 &&
    item.transform[2] === 0 &&
    Math.abs(item.height - font) < font * 0.05
  if (
    !items.every(valid) ||
    raw.some(
      (item) =>
        item.str.trim() &&
        (![...item.transform, item.width, item.height].every(Number.isFinite) ||
          ((item.width <= 0 || item.height <= 0) && Math.abs(item.transform[5] - y) < font * 2))
    )
  )
    return false
  const used = new Set(indices)
  if (
    raw
      .slice(indices[0], indices.at(-1)! + 1)
      .some((item, n) => item.str.trim() && !used.has(indices[0] + n))
  )
    return false
  for (let i = 0; i < items.length; i++) {
    if (Math.abs(items[i].transform[5] - y) > font * 0.05) return false
    if (
      i &&
      (items[i].transform[4] < items[i - 1].transform[4] + items[i - 1].width - font * 0.05 ||
        items[i].transform[4] > items[i - 1].transform[4] + items[i - 1].width + font * 0.65)
    )
      return false
  }
  const peers = raw.filter(
    (item) =>
      valid(item) &&
      !items.includes(item) &&
      Math.abs(item.transform[5] - y) < font * 20 &&
      (item.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 8 &&
      !symbolicExpression(item.str) &&
      item.width > font * 15
  )
  if (peers.length < 2 || !peers.some((item) => Math.abs(item.transform[4] - x) < font * 0.2))
    return false
  const domain = nativeProseProofDomain(items)
  if (!domain) return false
  return (
    items.every(
      (_, n) => page.blocks.filter((owner) => owner.items.includes(block.items[n])).length === 1
    ) && !raw.some((item, i) => !used.has(i) && nativeTextOverlapsProof(item, domain))
  )
}

// Repeated native post-bibliography headings can share one grouped prose unit.
function nativePostReferenceSections(
  unit: LayoutUnit,
  pages: LayoutPage[],
  rawItems: Map<number, PdfLayoutTextItem[]>
): boolean {
  if (unit.sourceOnly || unit.risks.length || unit.fragments.length !== 1) return false
  const page = pages.find((page) => page.page === unit.fragments[0].page),
    raw = rawItems.get(unit.fragments[0].page)
  if (!page || !raw) return false
  if (
    raw.some(
      (item) =>
        item.str.trim() &&
        (![...item.transform, item.width, item.height].every(Number.isFinite) ||
          item.width <= 0 ||
          item.height <= 0)
    )
  )
    return false
  const lines = page.blocks.flatMap((block) => block.lines).sort((a, b) => a.y - b.y || a.x - b.x),
    start = lines.findIndex((line) => line.items[0] === unit.items[0])
  if (start < 0 || !/^(?:Acknowledgements|Acknowledgments|Funding)$/u.test(lines[start].text))
    return false
  const first = raw[Number(lines[start].items[0].split(':')[1])]
  if (!first?.fontName) return false
  const font = first.height,
    x = first.transform[4]
  const titles =
    /^(?:Acknowledgements|Acknowledgments|Funding|Author contributions|Competing interests|Conflicts of interest|Data availability|Code availability)$/u
  let headings = 0,
    proseLines = 0,
    lastHeading = -1,
    bodyFont: string | undefined
  const owned = new Set<string>(),
    names = new Set<string>()
  let bottom = lines[start].bottom
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (i > start && line.y - bottom > font * 1.5) break
    const items = line.items.map((key) => raw[Number(key.split(':')[1])])
    if (
      !items.length ||
      items.some(
        (item) =>
          !item ||
          !item.fontName ||
          item.dir !== 'ltr' ||
          ![...item.transform, item.width, item.height].every(Number.isFinite) ||
          item.width <= 0 ||
          item.transform[0] <= 0 ||
          item.transform[3] <= 0 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          Math.abs(item.height - font) > font * 0.05
      )
    )
      return false
    if (Math.abs(line.x - x) > font * 0.2) return false
    if (titles.test(line.text)) {
      if (
        line.items.length !== 1 ||
        items[0].fontName !== first.fontName ||
        names.has(line.text) ||
        (headings > 0 && lastHeading === i - 1)
      )
        return false
      names.add(line.text)
      headings++
      lastHeading = i
    } else {
      if (
        /^(?:\[\d+\]|\d+[.)])\s+\p{L}/u.test(line.text) ||
        items.some((item) => item.fontName === first.fontName)
      )
        return false
      bodyFont ??= items[0].fontName
      if (items.some((item) => item.fontName !== bodyFont)) return false
      if ((line.text.match(/[A-Za-z]{2,}/gu)?.length ?? 0) >= 6) proseLines++
    }
    for (const key of line.items) owned.add(key)
    bottom = line.bottom
    if (headings >= 3 && i > lastHeading && proseLines >= 3) break
  }
  if (headings < 3 || proseLines < 3 || !font || bottom <= lines[start].bottom) return false
  const domain = nativeProseProofDomain([...owned].map((key) => raw[Number(key.split(':')[1])]))
  if (!domain) return false
  return !raw.some(
    (item, i) => !owned.has(`${page.page}:${i}`) && nativeTextOverlapsProof(item, domain)
  )
}

// A word before an inline document path belongs to the surrounding prose only
// when native rows, fonts and the complete parenthesis independently agree.
function nativeParenthesizedPathProse(
  block: LayoutBlock,
  page: LayoutPage,
  raw: PdfLayoutTextItem[]
): boolean {
  if (
    block.sourceOnly ||
    block.tableCell ||
    block.risks.length ||
    block.items.length !== 1 ||
    !/^[a-z]{4,} \($/u.test(block.source)
  )
    return false
  if (
    raw.some(
      (item) =>
        item.str.trim() &&
        (![...item.transform, item.width, item.height].every(Number.isFinite) ||
          item.width <= 0 ||
          item.height <= 0)
    )
  )
    return false
  const index = Number(block.items[0].split(':')[1]),
    word = raw[index]
  if (!word || word.str !== block.source || !word.fontName || word.hasEOL) return false
  const font = word.height,
    x = word.transform[4],
    y = word.transform[5]
  const valid = (item: PdfLayoutTextItem): boolean =>
    !!item.fontName &&
    item.dir === 'ltr' &&
    item.width > 0 &&
    font > 0 &&
    [...item.transform, item.width, item.height].every(Number.isFinite) &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    item.transform[1] === 0 &&
    item.transform[2] === 0 &&
    Math.abs(item.height - font) < font * 0.05
  const path = raw[index + 1],
    tail = raw[index + 2],
    previous = raw[index - 1]
  if (!path || !tail || !previous || ![word, path, tail, previous].every(valid)) return false
  if (
    path.hasEOL ||
    !tail.hasEOL ||
    !previous.hasEOL ||
    path.fontName === word.fontName ||
    tail.fontName !== word.fontName ||
    previous.fontName !== word.fontName ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+\.[A-Za-z]{1,8}$/u.test(path.str) ||
    !/^\) [A-Za-z][A-Za-z ,.'’-]+(?:[A-Za-z]|[.!?])$/u.test(tail.str) ||
    (tail.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0) < 6 ||
    !/^[A-Za-z][A-Za-z0-9 ,.'’-]+[A-Za-z]$/u.test(previous.str) ||
    (previous.str.match(/[A-Za-z]{2,}/gu)?.length ?? 0) < 8 ||
    Math.abs(previous.transform[4] - x) > font * 0.15 ||
    previous.transform[5] - y < font * 0.75 ||
    previous.transform[5] - y > font * 1.7
  )
    return false
  for (const [left, right] of [
    [word, path],
    [path, tail]
  ]) {
    if (
      Math.abs(right.transform[5] - y) > font * 0.05 ||
      Math.abs(right.transform[4] - left.transform[4] - left.width) > font * 0.15
    )
      return false
  }
  const right = tail.transform[4] + tail.width
  if (Math.abs(previous.transform[4] + previous.width - right) > font * 0.5) return false
  const used = new Set([index - 1, index, index + 1, index + 2])
  const domain = nativeProseProofDomain([...used].map((i) => raw[i]))
  if (!domain) return false
  if (raw.some((item, i) => !used.has(i) && nativeTextOverlapsProof(item, domain))) return false
  return [...used].every(
    (i) => page.blocks.filter((owner) => owner.items.includes(`${page.page}:${i}`)).length === 1
  )
}

// Preserve a native prose word continued before a complete section locator.
function nativeHyphenatedSectionTail(
  block: LayoutBlock,
  page: LayoutPage,
  raw: PdfLayoutTextItem[]
): boolean {
  if (
    block.sourceOnly ||
    block.tableCell ||
    block.items.length !== 1 ||
    block.risks.length ||
    !/^[a-z]{3,} \(§\d+(?:\.\d+)+\)\.$/u.test(block.source)
  )
    return false
  const index = Number(block.items[0].split(':')[1]),
    tail = raw[index]
  if (!tail || tail.str !== block.source || !tail.fontName || tail.dir !== 'ltr') return false
  const font = tail.height,
    x = tail.transform[4],
    y = tail.transform[5]
  if (
    !(font > 0) ||
    tail.transform[1] !== 0 ||
    tail.transform[2] !== 0 ||
    tail.transform[0] <= 0 ||
    tail.transform[3] <= 0
  )
    return false
  const owners = page.blocks.filter((owner) => {
    if (
      owner === block ||
      owner.sourceOnly ||
      owner.tableCell ||
      owner.lines.length < 2 ||
      owner.risks.some((risk) => !['ambiguous-line-hyphen', 'possible-continuation'].includes(risk))
    )
      return false
    const line = owner.lines.at(-1)!
    if (
      !/[a-z]{2,}-$/u.test(line.text) ||
      (line.text.match(/\p{L}{2,}/gu)?.length ?? 0) < 6 ||
      symbolicExpression(line.text)
    )
      return false
    const indices = line.items.map((key) => Number(key.split(':')[1])),
      previous = indices.map((i) => raw[i])
    if (
      Math.max(...indices) >= index ||
      raw.slice(Math.max(...indices) + 1, index).some((item) => item.str.trim())
    )
      return false
    const last = previous.at(-1)!
    if (
      !last.hasEOL ||
      previous.some(
        (item) =>
          !item ||
          item.dir !== 'ltr' ||
          item.fontName !== tail.fontName ||
          Math.abs(item.height - font) > font * 0.05 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          Math.abs(item.transform[5] - last.transform[5]) > font * 0.05
      )
    )
      return false
    const gap = last.transform[5] - y
    if (
      gap <= font * 0.75 ||
      gap >= font * 1.7 ||
      Math.abs(line.x - x) >= font * 0.15 ||
      tail.width >= line.right - line.x - font * 2
    )
      return false
    // An earlier complete prose row independently establishes this body's left edge.
    if (
      !owner.lines
        .slice(0, -1)
        .some(
          (peer) =>
            Math.abs(peer.x - line.x) < font * 0.15 &&
            (peer.text.match(/\p{L}{2,}/gu)?.length ?? 0) >= 6 &&
            !symbolicExpression(peer.text)
        )
    )
      return false
    const owned = new Set([...indices, index])
    // No unowned native ink may cross the two adjacent row domains, even when
    // the PDF emits that competing source outside their native index interval.
    return !raw.some(
      (item, i) =>
        !owned.has(i) &&
        item.str.trim() &&
        item.width > 0 &&
        item.height > 0 &&
        item.transform[4] < line.right &&
        item.transform[4] + item.width > Math.min(x, line.x) &&
        item.transform[5] >= y - font * 0.1 &&
        item.transform[5] <= last.transform[5] + font * 0.1
    )
  })
  return owners.length === 1
}

// Native proof: an isolated word+decimal reference has both a numbered-equation
// target and a contiguous native prose continuation. No grouping is changed.
function nativeEquationReferenceProse(
  block: LayoutPage['blocks'][number],
  page: LayoutPage,
  rawPages: PdfLayoutPage[],
  layoutPages: LayoutPage[]
): boolean {
  const match = /^[A-Za-z]{3,} \((\d+\.\d+)\)$/u.exec(block.source)
  if (
    !match ||
    block.tableCell ||
    block.lines.length !== 1 ||
    block.sourceOnly ||
    block.risks.length
  )
    return false
  const raw = rawPages.find((raw) => raw.page === page.page)
  if (!raw || raw.rotation !== 0) return false
  const indices = block.items.map((key) => Number(key.split(':')[1])).sort((a, b) => a - b)
  if (indices.length !== 2) return false
  const [word, ref] = indices.map((index) => raw.items[index])
  if (
    !word ||
    !ref ||
    !/^[A-Za-z]{3,}$/u.test(word.str) ||
    ref.str !== '(' + match[1] + ')' ||
    !word.fontName
  )
    return false
  const font = word.height,
    y = word.transform[5]
  const valid = (item: PdfLayoutPage['items'][number]): boolean =>
    item.dir === 'ltr' &&
    !!item.fontName &&
    item.width > 0 &&
    font > 0 &&
    [...item.transform, item.width, item.height].every(Number.isFinite) &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    Math.abs(item.transform[1]) < 0.001 &&
    Math.abs(item.transform[2]) < 0.001 &&
    Math.abs(item.height - font) < font * 0.05 &&
    Math.abs(item.transform[5] - y) < font * 0.05
  if (!valid(word) || !valid(ref) || word.hasEOL) return false
  let previous = word,
    words = 0
  const used = new Set([indices[0]])
  for (let index = indices[0] + 1; index < raw.items.length; index++) {
    const item = raw.items[index]
    if (!item.str.trim()) {
      if (item.hasEOL) break
      continue
    }
    if (
      !valid(item) ||
      previous.hasEOL ||
      item.transform[4] - previous.transform[4] - previous.width < -font * 0.05 ||
      item.transform[4] - previous.transform[4] - previous.width > font * 0.8
    )
      break
    if (used.size === 1 && index !== indices[1]) return false
    if (index === indices[1] || /^\(\d+\.\d+\)$/u.test(item.str)) {
      used.add(index)
      previous = item
      continue
    }
    if (!/^[A-Za-z\s,.;'’-]+$/u.test(item.str) || item.fontName !== word.fontName) break
    const owners = page.blocks.filter((b) => b.items.includes(page.page + ':' + index))
    if (
      owners.length !== 1 ||
      owners[0].tableCell ||
      owners[0].sourceOnly ||
      owners[0].risks.some((r) => r === 'formula-extraction' || r === 'metadata-extraction')
    )
      return false
    words += (item.str.match(/[A-Za-z]{2,}/gu) ?? []).length
    used.add(index)
    previous = item
  }
  if (words < 3) return false
  if (
    raw.items.some(
      (item, index) =>
        !used.has(index) &&
        item.str.trim() &&
        item.transform[4] < previous.transform[4] + previous.width &&
        item.transform[4] + item.width > word.transform[4] &&
        Math.abs(item.transform[5] - y) < font * 0.5
    )
  )
    return false
  const targets = layoutPages.flatMap((p) =>
    p.blocks
      .filter(
        (b) => b.source === '(' + match[1] + ')' && b.items.length === 1 && b.rect.x > p.width * 0.7
      )
      .map((b) => ({ page: p, block: b }))
  )
  if (targets.length !== 1) return false
  const target = targets[0],
    label = target.block
  const peers = layoutPages
    .filter((p) => p.width === target.page.width)
    .flatMap((p) => p.blocks)
    .filter(
      (b) =>
        /^\(\d+\.\d+\)$/u.test(b.source) &&
        b.items.length === 1 &&
        Math.abs(b.rect.right - label.rect.right) < font * 0.1
    )
  if (new Set(peers.map((b) => b.source)).size < 3) return false
  return target.page.blocks.some(
    (b) =>
      b !== label &&
      b.rect.right < label.rect.x - font * 2 &&
      b.rect.bottom > label.rect.y &&
      b.rect.y < label.rect.bottom &&
      /[=≤≥]/u.test(b.source) &&
      symbolicExpression(b.source)
  )
}

function nativeSquareCitationProse(
  block: LayoutPage['blocks'][number],
  page: LayoutPage,
  rawPages: PdfLayoutPage[]
): boolean {
  if (
    block.items.length !== 1 ||
    block.lines.length !== 1 ||
    block.tableCell ||
    block.sourceOnly ||
    block.risks.length
  )
    return false
  if (
    !/\[\d+\]/u.test(block.source) ||
    !/^[A-Za-z ,.'’-]+$/u.test(block.source.replace(/\[\d+\]/gu, '')) ||
    !/^[A-Za-z]{3,}/u.test(block.source)
  )
    return false
  const raw = rawPages.find((p) => p.page === page.page)
  if (!raw || raw.rotation !== 0) return false
  const index = Number(block.items[0].split(':')[1]),
    current = raw.items[index]
  if (!current || current.str !== block.source || !current.hasEOL || !current.fontName) return false
  const font = current.height,
    x = current.transform[4],
    y = current.transform[5]
  const preceding = raw.items
    .map((item, index) => ({ item, index }))
    .slice(0, index)
    .filter((x) => x.item.str.trim())
    .slice(-2)
  if (preceding.length !== 2) return false
  const [peer, previous] = preceding.map((x) => x.item)
  const valid = (item: PdfLayoutPage['items'][number]): boolean =>
    item.dir === 'ltr' &&
    item.hasEOL === true &&
    item.fontName === current.fontName &&
    [...item.transform, item.width, item.height].every(Number.isFinite) &&
    font > 0 &&
    item.width > 0 &&
    item.transform[0] > 0 &&
    item.transform[3] > 0 &&
    Math.abs(item.transform[1]) < 0.001 &&
    Math.abs(item.transform[2]) < 0.001 &&
    Math.abs(item.height - font) < font * 0.05
  if (
    Math.abs(previous.transform[4] - x) > font * 0.05 ||
    peer.transform[4] < x - font * 0.05 ||
    peer.transform[4] > x + font * 1.5 ||
    ![peer, previous, current].every(valid) ||
    /[.!?:;][”’"')\]]?$/u.test(previous.str.trim())
  )
    return false
  const gap = previous.transform[5] - y,
    oldGap = peer.transform[5] - previous.transform[5]
  if (
    gap < font * 0.75 ||
    gap > font * 2 ||
    Math.abs(gap - oldGap) > font * 0.05 ||
    current.width > previous.width + font * 0.05 ||
    Math.abs(peer.transform[4] + peer.width - previous.transform[4] - previous.width) > font * 0.05
  )
    return false
  for (const { item, index } of preceding) {
    if ((item.str.match(/[A-Za-z]{3,}/gu) ?? []).length < 6 || symbolicExpression(item.str))
      return false
    const owners = page.blocks.filter((b) => b.items.includes(page.page + ':' + index))
    if (
      owners.length !== 1 ||
      owners[0].tableCell ||
      owners[0].sourceOnly ||
      owners[0].risks.some((r) => r === 'formula-extraction' || r === 'metadata-extraction')
    )
      return false
  }
  const used = new Set([...preceding.map((x) => x.index), index])
  return !raw.items.some(
    (item, i) =>
      !used.has(i) &&
      item.str.trim() &&
      item.transform[4] < x + previous.width &&
      item.transform[4] + item.width > x &&
      item.transform[5] > y - font * 0.5 &&
      item.transform[5] < peer.transform[5] + font * 0.5
  )
}

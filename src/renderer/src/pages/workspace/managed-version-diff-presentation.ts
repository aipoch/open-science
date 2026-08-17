import { marked } from 'marked'

import type { ManagedFileVersionDiffResult } from '../../../../shared/managed-file-versions'

type DiffLine = ManagedFileVersionDiffResult['lines'][number]
type DiffSegment = DiffLine['segments'][number]
type DiffPresentationKind = 'markdown' | 'prose' | 'structured'
type MarkdownChangeTags = { added: string; removed: string }

type IndexedDiffLine = {
  index: number
  line: DiffLine
}

type DiffRange = { start: number; end: number }

const MARKDOWN_SEMANTIC_LEX_MAX_CHARS = 64 * 1024
const MARKDOWN_SEMANTIC_LEX_MAX_LINE_CHARS = 2 * 1024
const MARKDOWN_BLOCK_SIGNAL =
  /(?:^ {0,3}(?:>|[-+*][ \t]+|\d+[.)][ \t]+|`{3,}|~{3,}|<|(?:=+|-+)\s*$)|^ {4}\S|\|)/mu
const MARKDOWN_ENTITY = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/iu
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/u
const MARKDOWN_LINK_OR_REFERENCE = /!?\[[^\]\n]+\](?:(?:\([^\n)]*\))|(?:\[[^\]\n]*\]))?/u
const MARKDOWN_SETEXT_MARKER = /^ {0,3}(?:=+|-+)\s*$/u
const MARKDOWN_THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:_\s*){3,}|(?:-\s*){3,})$/u
const MARKDOWN_LIST_ITEM_PREFIX = /^(( {0,3})(?:[-+*]|\d+[.)])[ \t]+)(.*)$/u
const MARKDOWN_INDENTED_LIST_ITEM_PREFIX = /^(([ \t]*)(?:[-+*]|\d+[.)])[ \t]+)(.*)$/u
const MARKDOWN_TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u
const MARKDOWN_ATX_CLOSING_MARKER = /[ \t]+#+[ \t]*$/u
const DEFAULT_MARKDOWN_CHANGE_TAGS: MarkdownChangeTags = {
  added: 'managed-diff-added',
  removed: 'managed-diff-removed'
}

type DiffRenderBlock =
  | {
      kind: 'text'
      changeKind: 'context' | 'mixed' | 'added' | 'removed'
      segments: DiffSegment[]
      startIndex: number
    }
  | {
      kind: 'markdown'
      changeKind: 'context' | 'mixed' | 'added' | 'removed'
      content: string
      startIndex: number
    }

const isSimpleMarkdownText = (content: string): boolean => {
  const trimmed = content.trimStart()
  return !(
    /^(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```|~~~|\|)/.test(trimmed) ||
    /(?:!\[|\[[^\]]*\]\(|<[^>]+>|`|\*\*|__|~~|\|)/.test(content)
  )
}

const isInlineMarkdownText = (content: string): boolean => {
  const body = content.replace(/^ {0,3}#{1,6}[ \t]+/u, '')
  const trimmed = body.trimStart()
  return !(
    /^(?:>|[-+*]\s|\d+[.)]\s|```|~~~|\|)/u.test(trimmed) ||
    /(?:!\[|\[[^\]]*\]\(|<|>|`|[*_$]|~~|\||\\)/u.test(body) ||
    MARKDOWN_LINK_OR_REFERENCE.test(body) ||
    MARKDOWN_ENTITY.test(body) ||
    MARKDOWN_REFERENCE_DEFINITION.test(content) ||
    MARKDOWN_SETEXT_MARKER.test(content) ||
    MARKDOWN_THEMATIC_BREAK.test(content)
  )
}

const markdownHeadingPrefix = (content: string): string =>
  content.match(/^ {0,3}#{1,6}[ \t]+/u)?.[0] ?? ''

const markdownHeadingClosingMarker = (content: string): string =>
  markdownHeadingPrefix(content) === ''
    ? ''
    : (content.match(MARKDOWN_ATX_CLOSING_MARKER)?.[0] ?? '')

const isMarkdownSourceOnlyLine = (content: string): boolean =>
  MARKDOWN_REFERENCE_DEFINITION.test(content)

const diffLineText = (line: DiffLine): string =>
  line.segments.map((segment) => segment.text).join('')

const isComplexMarkdownToken = (type: string, raw: string): boolean =>
  type !== 'space' &&
  (type !== 'paragraph' || raw.split('\n').some((line) => !isSimpleMarkdownText(line)))

const lineIndexAtOffset = (lineStarts: number[], offset: number): number => {
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (lineStarts[middle]! <= offset) low = middle + 1
    else high = middle
  }
  return low - 1
}

const markdownSemanticRanges = (
  entries: IndexedDiffLine[],
  changedKind: 'added' | 'removed'
): DiffRange[] | undefined => {
  if (entries.length === 0) return []

  const source = entries.map(({ line }) => diffLineText(line)).join('\n')
  if (!MARKDOWN_BLOCK_SIGNAL.test(source)) {
    return []
  }
  let tokens: ReturnType<typeof marked.lexer>
  try {
    tokens = marked.lexer(source)
  } catch {
    return undefined
  }

  const lineStarts: number[] = []
  let lineStart = 0
  for (const entry of entries) {
    lineStarts.push(lineStart)
    lineStart += diffLineText(entry.line).length + 1
  }

  const ranges: DiffRange[] = []
  let tokenStart = 0
  for (const token of tokens) {
    const tokenEnd = tokenStart + token.raw.length
    const contentEnd = tokenStart + token.raw.replace(/(?:\r?\n[ \t]*)+$/u, '').length
    if (isComplexMarkdownToken(token.type, token.raw) && contentEnd > tokenStart) {
      const start = lineIndexAtOffset(lineStarts, tokenStart)
      const end = lineIndexAtOffset(lineStarts, contentEnd - 1)
      if (
        start >= 0 &&
        end >= start &&
        entries.slice(start, end + 1).some(({ line }) => line.kind === changedKind)
      ) {
        ranges.push({ start: entries[start]!.index, end: entries[end]!.index })
      }
    }
    tokenStart = tokenEnd
  }
  return ranges
}

const escapeHtmlText = (content: string): string =>
  content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const markdownChangeMarkup = (
  kind: 'added' | 'removed',
  content: string,
  tags: MarkdownChangeTags
): string => `<${tags[kind]}>${escapeHtmlText(content)}</${tags[kind]}>`

const markdownChangeMarker = (kind: 'added' | 'removed', tags: MarkdownChangeTags): string =>
  `<${tags[kind]}></${tags[kind]}>`

const isSafeInlineTableRow = (line: DiffLine, allowChangedDelimiters = false): boolean => {
  const content = diffLineText(line)
  if (!content.includes('|') || MARKDOWN_TABLE_DELIMITER_ROW.test(content)) return false
  if (
    !allowChangedDelimiters &&
    line.segments.some((segment) => segment.kind !== 'context' && segment.text.includes('|'))
  ) {
    return false
  }
  return content
    .split('|')
    .filter((cell) => cell.trim().length > 0)
    .every((cell) => isInlineMarkdownText(cell.trim()))
}

const isRenderableStandaloneInlineMarkdown = (content: string): boolean =>
  content.length > 0 &&
  !/[<>\n]/u.test(content) &&
  !MARKDOWN_REFERENCE_DEFINITION.test(content) &&
  !MARKDOWN_SETEXT_MARKER.test(content) &&
  !MARKDOWN_THEMATIC_BREAK.test(content)

const isRenderableStandaloneTableRow = (line: DiffLine): boolean => {
  const content = diffLineText(line)
  if (!content.includes('|') || MARKDOWN_TABLE_DELIMITER_ROW.test(content)) return false
  return content
    .split('|')
    .filter((cell) => cell.trim().length > 0)
    .every((cell) => isRenderableStandaloneInlineMarkdown(cell.trim()))
}

const indentationWidth = (indentation: string): number =>
  Array.from(indentation).reduce((width, character) => width + (character === '\t' ? 4 : 1), 0)

const hasListAncestor = (
  lines: ManagedFileVersionDiffResult['lines'],
  index: number,
  indentation: string
): boolean => {
  const currentIndentation = indentationWidth(indentation)
  if (currentIndentation < 4) return true
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previousText = diffLineText(lines[previousIndex]!)
    if (previousText.trim() === '') return false
    const previousList = previousText.match(MARKDOWN_INDENTED_LIST_ITEM_PREFIX)
    if (previousList && indentationWidth(previousList[2]!) < currentIndentation) return true
  }
  return false
}

const mergeDiffRanges = (ranges: DiffRange[]): DiffRange[] => {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: DiffRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

const toInlineMarkdownReplacement = (
  removed: DiffLine,
  added: DiffLine,
  tags: MarkdownChangeTags
): string | undefined => {
  const before = diffLineText(removed)
  const after = diffLineText(added)
  const beforeList = before.match(MARKDOWN_LIST_ITEM_PREFIX)
  const afterList = after.match(MARKDOWN_LIST_ITEM_PREFIX)
  const isSameListItem = beforeList !== null && afterList !== null && beforeList[1] === afterList[1]
  const isSameTableRow =
    isSafeInlineTableRow(removed) &&
    isSafeInlineTableRow(added) &&
    before.split('|').length === after.split('|').length
  const isSafeInlinePair =
    (isSameListItem &&
      isInlineMarkdownText(beforeList[3]!) &&
      isInlineMarkdownText(afterList[3]!)) ||
    isSameTableRow ||
    (isInlineMarkdownText(before) && isInlineMarkdownText(after))
  if (!isSafeInlinePair || markdownHeadingPrefix(before) !== markdownHeadingPrefix(after)) {
    return undefined
  }
  if (markdownHeadingClosingMarker(before) !== markdownHeadingClosingMarker(after)) return undefined

  const content: string[] = []
  let changed = false
  let removedIndex = 0
  let addedIndex = 0
  while (removedIndex < removed.segments.length || addedIndex < added.segments.length) {
    const removedSegment = removed.segments[removedIndex]
    const addedSegment = added.segments[addedIndex]
    if (
      removedSegment?.kind === 'context' &&
      addedSegment?.kind === 'context' &&
      removedSegment.text === addedSegment.text
    ) {
      content.push(removedSegment.text)
      removedIndex += 1
      addedIndex += 1
      continue
    }

    if (removedSegment?.kind === 'removed') {
      content.push(markdownChangeMarkup('removed', removedSegment.text, tags))
      changed = true
      removedIndex += 1
      continue
    }
    if (addedSegment?.kind === 'added') {
      content.push(markdownChangeMarkup('added', addedSegment.text, tags))
      changed = true
      addedIndex += 1
      continue
    }
    return undefined
  }
  return changed ? content.join('') : undefined
}

const toInlineTextReplacement = (removed: DiffLine, added: DiffLine): DiffSegment[] | undefined => {
  const segments: DiffSegment[] = []
  let removedIndex = 0
  let addedIndex = 0
  while (removedIndex < removed.segments.length || addedIndex < added.segments.length) {
    const removedSegment = removed.segments[removedIndex]
    const addedSegment = added.segments[addedIndex]
    if (
      removedSegment?.kind === 'context' &&
      addedSegment?.kind === 'context' &&
      removedSegment.text === addedSegment.text
    ) {
      segments.push(removedSegment)
      removedIndex += 1
      addedIndex += 1
      continue
    }
    if (removedSegment?.kind === 'removed') {
      segments.push(removedSegment)
      removedIndex += 1
      continue
    }
    if (addedSegment?.kind === 'added') {
      segments.push(addedSegment)
      addedIndex += 1
      continue
    }
    return undefined
  }
  return segments
}

type InlineMarkdownChange = { content: string; endIndex: number }

const toStandaloneMarkdownChange = (
  line: DiffLine,
  tags: MarkdownChangeTags,
  allowIndentedListItem: boolean
): string | undefined => {
  const kind = line.kind
  if (kind === 'context') return undefined
  const content = diffLineText(line)
  const list = content.match(MARKDOWN_INDENTED_LIST_ITEM_PREFIX)
  if (
    list &&
    (list[2]!.length <= 3 || allowIndentedListItem) &&
    isRenderableStandaloneInlineMarkdown(list[3]!)
  ) {
    const body = list[3]!
    const change = isInlineMarkdownText(body)
      ? markdownChangeMarkup(kind, body, tags)
      : `${markdownChangeMarker(kind, tags)}${body}`
    return `${list[1]}${change}`
  }
  if (!isRenderableStandaloneTableRow(line)) return undefined

  return content
    .split('|')
    .map((cell) => {
      const body = cell.trim()
      if (body.length === 0) return cell
      const leading = cell.slice(0, cell.indexOf(body))
      const trailing = cell.slice(cell.indexOf(body) + body.length)
      const change = isInlineMarkdownText(body)
        ? markdownChangeMarkup(kind, body, tags)
        : `${markdownChangeMarker(kind, tags)}${body}`
      return `${leading}${change}${trailing}`
    })
    .join('|')
}

const inlineMarkdownPairs = (
  lines: ManagedFileVersionDiffResult['lines'],
  tags: MarkdownChangeTags
): { pairs: Map<number, InlineMarkdownChange>; indexes: Set<number> } => {
  const pairs = new Map<number, InlineMarkdownChange>()
  const indexes = new Set<number>()
  for (let index = 0; index < lines.length - 1; index += 1) {
    const removed = lines[index]
    const added = lines[index + 1]
    if (removed?.kind !== 'removed' || added?.kind !== 'added') continue
    const content = toInlineMarkdownReplacement(removed, added, tags)
    if (content === undefined) continue
    pairs.set(index, { content, endIndex: index + 1 })
    indexes.add(index)
    indexes.add(index + 1)
    index += 1
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (indexes.has(index)) continue
    const lineText = diffLineText(lines[index]!)
    const list = lineText.match(MARKDOWN_INDENTED_LIST_ITEM_PREFIX)
    const content = toStandaloneMarkdownChange(
      lines[index]!,
      tags,
      list !== null && hasListAncestor(lines, index, list[2]!)
    )
    if (content === undefined) continue
    pairs.set(index, { content, endIndex: index })
    indexes.add(index)
  }
  return { pairs, indexes }
}

const markdownContent = (lines: ManagedFileVersionDiffResult['lines']): string =>
  lines.map(diffLineText).join('\n')

const isMarkdownParagraphLine = (line: DiffLine): boolean => {
  const content = diffLineText(line)
  const trimmed = content.trimStart()
  return (
    content.trim().length > 0 &&
    !/^(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|```|~~~|<|\|)/u.test(trimmed) &&
    !/^ {4}\S/u.test(content) &&
    !MARKDOWN_REFERENCE_DEFINITION.test(content) &&
    !MARKDOWN_SETEXT_MARKER.test(content) &&
    !MARKDOWN_THEMATIC_BREAK.test(content) &&
    !content.includes('|')
  )
}

const nonInlineParagraphRanges = (
  lines: ManagedFileVersionDiffResult['lines'],
  inlinePairs: ReadonlyMap<number, InlineMarkdownChange>
): DiffRange[] => {
  const ranges: DiffRange[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      lines[index]?.kind !== 'removed' ||
      lines[index + 1]?.kind !== 'added' ||
      inlinePairs.has(index) ||
      !isMarkdownParagraphLine(lines[index]!) ||
      !isMarkdownParagraphLine(lines[index + 1]!)
    ) {
      continue
    }

    let start = index
    while (
      start > 0 &&
      lines[start - 1]?.kind === 'context' &&
      isMarkdownParagraphLine(lines[start - 1]!)
    ) {
      start -= 1
    }
    let end = index + 1
    while (
      end + 1 < lines.length &&
      lines[end + 1]?.kind === 'context' &&
      isMarkdownParagraphLine(lines[end + 1]!)
    ) {
      end += 1
    }
    if (start < index || end > index + 1) ranges.push({ start, end })
    index += 1
  }
  return ranges
}

const toTextRenderBlocks = (
  result: ManagedFileVersionDiffResult,
  presentationKind: Exclude<DiffPresentationKind, 'markdown'>,
  mergeStructuredReplacements = false
): DiffRenderBlock[] => {
  const blocks: DiffRenderBlock[] = []
  for (let index = 0; index < result.lines.length; index += 1) {
    const line = result.lines[index]!
    const nextLine = result.lines[index + 1]
    // Markdown raw fallback stays line-based; only explicit prose/structured views merge replacements.
    if (
      (presentationKind === 'prose' || mergeStructuredReplacements) &&
      line.kind === 'removed' &&
      nextLine?.kind === 'added'
    ) {
      const segments = toInlineTextReplacement(line, nextLine)
      if (segments) {
        blocks.push({ kind: 'text', changeKind: 'mixed', segments, startIndex: index })
        index += 1
        continue
      }
    }

    blocks.push({
      kind: 'text',
      changeKind: line.kind,
      segments:
        presentationKind === 'structured' && line.kind !== 'context'
          ? [{ kind: line.kind, text: diffLineText(line) }]
          : line.segments,
      startIndex: index
    })
  }
  return blocks
}

const requiresRawMarkdownDiff = (result: ManagedFileVersionDiffResult): boolean => {
  const before = markdownContent(result.lines.filter((line) => line.kind !== 'added'))
  const after = markdownContent(result.lines.filter((line) => line.kind !== 'removed'))
  return [before, after].some(
    (source) =>
      source.length > MARKDOWN_SEMANTIC_LEX_MAX_CHARS ||
      source.split('\n').some((line) => line.length > MARKDOWN_SEMANTIC_LEX_MAX_LINE_CHARS)
  )
}

const isInlineSemanticRange = (
  lines: ManagedFileVersionDiffResult['lines'],
  range: DiffRange,
  inlineChangeIndexes: ReadonlySet<number>
): boolean => {
  const rangeLines = lines.slice(range.start, range.end + 1)
  if (
    rangeLines.some(
      (line, offset) => line.kind !== 'context' && !inlineChangeIndexes.has(range.start + offset)
    )
  ) {
    return false
  }
  const before = markdownContent(rangeLines.filter((line) => line.kind !== 'added'))
  const after = markdownContent(rangeLines.filter((line) => line.kind !== 'removed'))
  const semanticType = (content: string): string | undefined => {
    try {
      const tokens = marked.lexer(content).filter((token) => token.type !== 'space')
      if (tokens.length !== 1) return undefined
      const type = tokens[0]?.type
      return type === 'heading' || type === 'list' || type === 'table' ? type : undefined
    } catch {
      return undefined
    }
  }
  const beforeType = semanticType(before)
  return beforeType !== undefined && beforeType === semanticType(after)
}

const toMarkdownRenderBlocks = (
  result: ManagedFileVersionDiffResult,
  tags: MarkdownChangeTags
): DiffRenderBlock[] => {
  if (requiresRawMarkdownDiff(result)) return toTextRenderBlocks(result, 'structured')

  const inline = inlineMarkdownPairs(result.lines, tags)
  const before = result.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.kind !== 'added')
  const after = result.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.kind !== 'removed')
  const beforeSemanticRanges = markdownSemanticRanges(before, 'removed')
  const afterSemanticRanges = markdownSemanticRanges(after, 'added')
  if (beforeSemanticRanges === undefined || afterSemanticRanges === undefined) {
    return toTextRenderBlocks(result, 'structured')
  }
  const complexChangedRanges = result.lines.flatMap((line, index) =>
    line.kind !== 'context' &&
    !inline.indexes.has(index) &&
    !isSimpleMarkdownText(diffLineText(line))
      ? [{ start: index, end: index }]
      : []
  )
  const markdownRanges = mergeDiffRanges([
    ...beforeSemanticRanges,
    ...afterSemanticRanges,
    ...nonInlineParagraphRanges(result.lines, inline.pairs),
    ...complexChangedRanges
  ]).filter(
    (range) =>
      !result.lines
        .slice(range.start, range.end + 1)
        .some((line) => isMarkdownSourceOnlyLine(diffLineText(line))) &&
      !isInlineSemanticRange(result.lines, range, inline.indexes)
  )

  const blocks: DiffRenderBlock[] = []
  let pendingLines: string[] = []
  let pendingStart = 0
  let pendingMixed = false
  const flushPending = (): void => {
    while (pendingLines.at(-1) === '') pendingLines.pop()
    if (pendingLines.length > 0) {
      blocks.push({
        kind: 'markdown',
        changeKind: pendingMixed ? 'mixed' : 'context',
        content: pendingLines.join('\n'),
        startIndex: pendingStart
      })
    }
    pendingLines = []
    pendingMixed = false
  }
  const appendPending = (content: string, index: number, mixed = false): void => {
    if (pendingLines.length === 0) pendingStart = index
    pendingLines.push(content)
    pendingMixed ||= mixed
  }

  let rangeIndex = 0
  for (let index = 0; index < result.lines.length; index += 1) {
    const range = markdownRanges[rangeIndex]
    if (range && index === range.start) {
      flushPending()
      const lines = result.lines.slice(range.start, range.end + 1)
      const removed = lines.filter((line) => line.kind !== 'added')
      const added = lines.filter((line) => line.kind !== 'removed')
      if (removed.some((line) => line.kind === 'removed')) {
        blocks.push({
          kind: 'markdown',
          changeKind: 'removed',
          content: markdownContent(removed),
          startIndex: range.start
        })
      }
      if (added.some((line) => line.kind === 'added')) {
        blocks.push({
          kind: 'markdown',
          changeKind: 'added',
          content: markdownContent(added),
          startIndex: range.start
        })
      }
      index = range.end
      rangeIndex += 1
      continue
    }

    const pair = inline.pairs.get(index)
    if (pair) {
      appendPending(pair.content, index, true)
      index = pair.endIndex
      continue
    }

    const line = result.lines[index]!
    if (line.kind === 'context') {
      appendPending(diffLineText(line), index)
      continue
    }

    const lineText = diffLineText(line)
    if (lineText === '' || isMarkdownSourceOnlyLine(lineText)) {
      flushPending()
      blocks.push({
        kind: 'text',
        changeKind: line.kind,
        segments: [{ kind: line.kind, text: lineText }],
        startIndex: index
      })
      continue
    }

    const nextLine = result.lines[index + 1]
    const belongsToSimpleParagraph =
      isInlineMarkdownText(lineText) &&
      (pendingLines.length > 0 ||
        (nextLine?.kind === 'context' && isInlineMarkdownText(diffLineText(nextLine))))
    if (belongsToSimpleParagraph) {
      appendPending(markdownChangeMarkup(line.kind, lineText, tags), index, true)
      continue
    }

    flushPending()
    const changedLines = [line]
    while (index + 1 < result.lines.length && result.lines[index + 1]?.kind === line.kind) {
      const nextIndex = index + 1
      const nextRange = markdownRanges[rangeIndex]
      if (nextRange?.start === nextIndex || inline.pairs.has(nextIndex)) break
      changedLines.push(result.lines[nextIndex]!)
      index = nextIndex
    }
    blocks.push({
      kind: 'markdown',
      changeKind: line.kind,
      content: markdownContent(changedLines),
      startIndex: index - changedLines.length + 1
    })
  }
  flushPending()
  return blocks
}

const toDiffPresentationBlocks = (
  result: ManagedFileVersionDiffResult,
  presentationKind: DiffPresentationKind,
  markdownChangeTags: MarkdownChangeTags = DEFAULT_MARKDOWN_CHANGE_TAGS
): DiffRenderBlock[] => {
  if (presentationKind === 'markdown') return toMarkdownRenderBlocks(result, markdownChangeTags)
  return toTextRenderBlocks(result, presentationKind, presentationKind === 'structured')
}

export { toDiffPresentationBlocks }
export type { DiffPresentationKind, DiffRenderBlock, MarkdownChangeTags }

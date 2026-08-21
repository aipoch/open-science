import { diffArrays } from 'diff'
import { marked } from 'marked'
import { html, parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

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
const MARKDOWN_RENDERED_DIFF_MAX_MARKERS = 256
const MARKDOWN_RENDERED_DIFF_MAX_CHARS = 128 * 1024
const MARKDOWN_GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined
const MARKDOWN_BLOCK_SIGNAL =
  /(?:^ {0,3}(?:>|[-+*][ \t]+|\d+[.)][ \t]+|`{3,}|~{3,}|<|(?:=+|-+)\s*$)|^ {4}\S|\|)/mu
const MARKDOWN_ENTITY = /&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/iu
const HTML_CHARACTER_REFERENCE_SOURCE = /&(?:#[xX][\da-fA-F]+;?|#\d+;?|[a-zA-Z][a-zA-Z0-9]+;?)/gu
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/u
const MARKDOWN_LINK_OR_REFERENCE = /!?\[[^\]\n]+\](?:(?:\([^\n)]*\))|(?:\[[^\]\n]*\]))?/u
const MARKDOWN_REFERENCE_LINK = /!?\[[^\]\n]+\]\[[^\]\n]*\]/u
const MARKDOWN_SETEXT_MARKER = /^ {0,3}(?:=+|-+)\s*$/u
const MARKDOWN_THEMATIC_BREAK = /^ {0,3}(?:(?:\*\s*){3,}|(?:_\s*){3,}|(?:-\s*){3,})$/u
const MARKDOWN_LIST_ITEM_PREFIX = /^(( {0,3})(?:[-+*]|\d+[.)])[ \t]+)(.*)$/u
const MARKDOWN_INDENTED_LIST_ITEM_PREFIX = /^(([ \t]*)(?:[-+*]|\d+[.)])[ \t]+)(.*)$/u
const MARKDOWN_TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u
const MARKDOWN_ATX_CLOSING_MARKER = /[ \t]+#+[ \t]*$/u
const MARKDOWN_FENCE_MARKER = /(`{3,}|~{3,})(.*)$/u
const MARKDOWN_STRUCTURE_SKELETON_LINE_CHARS = 128
const DEFAULT_MARKDOWN_CHANGE_TAGS: MarkdownChangeTags = {
  added: 'managed-diff-added',
  removed: 'managed-diff-removed'
}
const HTML_RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'template'
])

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
      fallbackSegments?: DiffSegment[]
      startIndex: number
    }

type HtmlTextSpan = { start: number; end: number }
type SafeHtmlSource = {
  structure: string
  nonTextSource: string
  textSpans: HtmlTextSpan[]
}
type HtmlMarkerExpectation = { tagName: string; text: string }
type MarkdownToken = {
  type: string
  raw: string
  text?: string
  tokens?: MarkdownToken[]
  href?: string
  title?: string | null
  depth?: number
}
type MarkdownMarkerEvent = {
  tagName: string
  closing: boolean
  start: number
  end: number
}
type SafeInlineMarkdownSource = SafeHtmlSource & {
  markerEvents: MarkdownMarkerEvent[]
}
type HtmlStructureOptions = {
  markerExpectations?: HtmlMarkerExpectation[]
  markerIndex: number
  rejectedMarkerTags: ReadonlySet<string>
}
type MarkedInlineReplacement = {
  content: string
  markers: HtmlMarkerExpectation[]
}
type InlineMarkdownReplacement = {
  content: string
  semanticSafety: 'simple' | 'html' | 'markdown'
  requiresSourceFallback?: boolean
}

type RenderedMarkdownTextNode = {
  htmlStart: number
  htmlEnd: number
  textStart: number
  textEnd: number
  value: string
  ancestors: string[]
}

type RenderedInlineMarkdown = {
  content: string
  structure: string
  text: string
  textNodes: RenderedMarkdownTextNode[]
}

type VisibleMarkdownChange = DiffSegment & {
  beforeStart: number
  beforeEnd: number
  afterStart: number
  afterEnd: number
}

type RenderedMarkdownBoundary = {
  htmlOffset: number
  ancestors: string[]
}

type RenderedHtmlChange = {
  start: number
  end: number
  content: string
  markers: HtmlMarkerExpectation[]
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

const diffLineSourceText = (line: DiffLine): string =>
  line.segments.map((segment) => segment.text).join('')

const diffLineText = (line: DiffLine): string =>
  diffLineSourceText(line).replace(/(?:\r\n|\n)$/u, '')

const joinLineTexts = (lines: string[]): { content: string; lineStarts: number[] } => {
  let content = ''
  let previousLineHasExplicitEnding = false
  const lineStarts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && !previousLineHasExplicitEnding) content += '\n'
    lineStarts.push(content.length)
    const line = lines[index]!
    content += line
    previousLineHasExplicitEnding = line.endsWith('\n')
  }
  return { content, lineStarts }
}

const markdownSource = (lines: DiffLine[]): { content: string; lineStarts: number[] } =>
  joinLineTexts(lines.map(diffLineSourceText))

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
  changedKind: 'added' | 'removed' | undefined,
  lineSource: (line: DiffLine) => string = diffLineSourceText,
  trimTrailingWhitespace = true
): DiffRange[] | undefined => {
  if (entries.length === 0) return []

  const { content: source, lineStarts } = joinLineTexts(entries.map(({ line }) => lineSource(line)))
  if (!MARKDOWN_BLOCK_SIGNAL.test(source)) {
    return []
  }
  let tokens: ReturnType<typeof marked.lexer>
  try {
    tokens = marked.lexer(source)
  } catch {
    return undefined
  }

  const ranges: DiffRange[] = []
  let tokenStart = 0
  for (const token of tokens) {
    const tokenEnd = tokenStart + token.raw.length
    const contentEnd =
      tokenStart +
      (trimTrailingWhitespace
        ? token.raw.replace(/(?:\r?\n[ \t]*)+$/u, '').length
        : token.raw.length)
    if (isComplexMarkdownToken(token.type, token.raw) && contentEnd > tokenStart) {
      const start = lineIndexAtOffset(lineStarts, tokenStart)
      const end = lineIndexAtOffset(lineStarts, contentEnd - 1)
      if (
        start >= 0 &&
        end >= start &&
        (changedKind === undefined ||
          entries.slice(start, end + 1).some(({ line }) => line.kind === changedKind))
      ) {
        ranges.push({ start: entries[start]!.index, end: entries[end]!.index })
      }
    }
    tokenStart = tokenEnd
  }
  return ranges
}

const markdownStructureSkeletonLine = (line: DiffLine): string => {
  const source = diffLineSourceText(line)
  const ending = source.match(/(?:\r\n|\n)$/u)?.[0] ?? ''
  const content = source.slice(0, source.length - ending.length)
  const skeleton = content.slice(0, MARKDOWN_STRUCTURE_SKELETON_LINE_CHARS)
  const candidate = content.match(MARKDOWN_FENCE_MARKER)
  const marker = candidate?.[1]
  const markerIndex = marker === undefined ? -1 : content.indexOf(marker)
  const skeletonTail = marker === undefined ? '' : skeleton.slice(markerIndex + marker.length)
  if (marker?.startsWith('`') && candidate?.[2]?.includes('`') && !skeletonTail.includes('`')) {
    return `${skeleton}\`${ending}`
  }
  if (candidate?.[2]?.trim().length && skeletonTail.trim().length === 0) {
    return `${skeleton}x${ending}`
  }
  return `${skeleton}${ending}`
}

const conservativeMarkdownContainerRanges = (entries: IndexedDiffLine[]): DiffRange[] => {
  type MarkdownContainer = { kind: 'blockquote' } | { kind: 'list'; contentIndent: number }
  type FenceCandidate = {
    marker: string
    tail: string
    containers: MarkdownContainer[]
  }
  type FenceOpening = FenceCandidate & { index: number }

  const indentation = (value: string): number =>
    Array.from(value).reduce((width, character) => width + (character === '\t' ? 4 : 1), 0)
  const openingContainers = (prefix: string): MarkdownContainer[] | undefined => {
    const containers: MarkdownContainer[] = []
    let remainder = prefix
    while (true) {
      const quote = remainder.match(/^ {0,3}>[ \t]?/u)?.[0]
      if (quote) {
        containers.push({ kind: 'blockquote' })
        remainder = remainder.slice(quote.length)
        continue
      }
      const list = remainder.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/u)?.[0]
      if (!list) break
      containers.push({ kind: 'list', contentIndent: indentation(list) })
      remainder = remainder.slice(list.length)
    }
    return remainder.trim().length === 0 && indentation(remainder) <= 3 ? containers : undefined
  }
  const fenceCandidate = (content: string): FenceCandidate | undefined => {
    const match = content.match(MARKDOWN_FENCE_MARKER)
    if (!match || match.index === undefined) return undefined
    const containers = openingContainers(content.slice(0, match.index))
    if (!containers) return undefined
    return {
      marker: match[1]!,
      tail: match[2]!,
      containers
    }
  }
  const consumeIndentation = (content: string, expected: number): string | undefined => {
    let width = 0
    let index = 0
    while (index < content.length && width < expected) {
      const character = content[index]!
      if (character !== ' ' && character !== '\t') return undefined
      width += character === '\t' ? 4 : 1
      index += 1
    }
    return width >= expected ? content.slice(index) : undefined
  }
  const containerRemainder = (
    content: string,
    containers: MarkdownContainer[]
  ): string | undefined => {
    let remainder = content
    for (const container of containers) {
      if (container.kind === 'blockquote') {
        const quote = remainder.match(/^ {0,3}>[ \t]?/u)?.[0]
        if (!quote) return undefined
        remainder = remainder.slice(quote.length)
        continue
      }
      const afterIndentation = consumeIndentation(remainder, container.contentIndent)
      if (afterIndentation === undefined) return undefined
      remainder = afterIndentation
    }
    return remainder
  }
  const closesFence = (content: string, opening: FenceOpening): boolean => {
    const remainder = containerRemainder(content, opening.containers)
    if (remainder === undefined) return false
    const candidate = remainder.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u)
    return Boolean(
      candidate &&
      candidate[1]![0] === opening.marker[0] &&
      candidate[1]!.length >= opening.marker.length &&
      candidate[2]!.trim().length === 0
    )
  }

  const ranges: DiffRange[] = []
  let opening: FenceOpening | undefined

  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position]!
    const content = diffLineText(entry.line)
    if (opening) {
      const remainsInContainer =
        opening.containers.length === 0 ||
        content.trim().length === 0 ||
        containerRemainder(content, opening.containers) !== undefined
      if (!remainsInContainer) {
        ranges.push({ start: opening.index, end: entries[position - 1]!.index })
        opening = undefined
      } else {
        if (closesFence(content, opening)) {
          ranges.push({ start: opening.index, end: entry.index })
          opening = undefined
        }
        continue
      }
    }

    const candidate = fenceCandidate(content)
    if (!candidate || (candidate.marker.startsWith('`') && candidate.tail.includes('`'))) continue
    opening = { ...candidate, index: entry.index }
  }

  if (opening && entries.length > 0) {
    ranges.push({ start: opening.index, end: entries.at(-1)!.index })
  }
  return ranges
}

const markdownContainerRanges = (
  before: IndexedDiffLine[],
  after: IndexedDiffLine[],
  lines: ManagedFileVersionDiffResult['lines'],
  useStructureSkeleton: boolean
): DiffRange[] | undefined => {
  if (![...before, ...after].some(({ line }) => MARKDOWN_FENCE_MARKER.test(diffLineText(line)))) {
    return []
  }

  const lineSource = useStructureSkeleton ? markdownStructureSkeletonLine : diffLineSourceText
  const beforeRanges = markdownSemanticRanges(before, undefined, lineSource, false)
  const afterRanges = markdownSemanticRanges(after, undefined, lineSource, false)
  if (beforeRanges === undefined || afterRanges === undefined) {
    return mergeOverlappingDiffRanges([
      ...conservativeMarkdownContainerRanges(before),
      ...conservativeMarkdownContainerRanges(after)
    ]).filter((range) =>
      lines.slice(range.start, range.end + 1).some((line) => line.kind !== 'context')
    )
  }

  return mergeOverlappingDiffRanges([...beforeRanges, ...afterRanges]).filter((range) =>
    lines.slice(range.start, range.end + 1).some((line) => line.kind !== 'context')
  )
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

const isPureHtmlSource = (source: string): boolean => {
  try {
    const tokens = marked.lexer(source).filter((token) => token.type !== 'space')
    return tokens.length === 1 && tokens[0]?.type === 'html' && tokens[0].raw === source
  } catch {
    return false
  }
}

const isValidSourceLocation = (
  location: { startOffset: number; endOffset: number } | null | undefined,
  source: string
): location is { startOffset: number; endOffset: number } =>
  location !== null &&
  location !== undefined &&
  location.startOffset >= 0 &&
  location.endOffset >= location.startOffset &&
  location.endOffset <= source.length

const isSafeHtmlMarkerTag = (tagName: string): boolean =>
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(tagName)

const isHtmlTextNode = (
  node: DefaultTreeAdapterTypes.ChildNode
): node is DefaultTreeAdapterTypes.TextNode => node.nodeName === '#text' && 'value' in node

const isHtmlCommentNode = (
  node: DefaultTreeAdapterTypes.ChildNode
): node is DefaultTreeAdapterTypes.CommentNode => node.nodeName === '#comment' && 'data' in node

const isHtmlElement = (
  node: DefaultTreeAdapterTypes.ChildNode
): node is DefaultTreeAdapterTypes.Element => 'tagName' in node

const htmlChildrenStructure = (
  nodes: DefaultTreeAdapterTypes.ChildNode[],
  source: string,
  textSpans: HtmlTextSpan[],
  options: HtmlStructureOptions
): unknown[] | undefined => {
  const structure: unknown[] = []
  for (const node of nodes) {
    const entry = htmlNodeStructure(node, source, textSpans, options)
    if (entry === undefined) return undefined
    if (entry === '#text') continue
    structure.push(entry)
  }
  return structure
}

const htmlNodeStructure = (
  node: DefaultTreeAdapterTypes.ChildNode,
  source: string,
  textSpans: HtmlTextSpan[],
  options: HtmlStructureOptions
): unknown | undefined => {
  if (isHtmlTextNode(node)) {
    const location = node.sourceCodeLocation
    if (!isValidSourceLocation(location, source)) return undefined

    const rawText = source.slice(location.startOffset, location.endOffset)
    let plainTextStart = location.startOffset
    for (const reference of rawText.matchAll(HTML_CHARACTER_REFERENCE_SOURCE)) {
      const referenceStart = location.startOffset + reference.index
      if (referenceStart > plainTextStart) {
        textSpans.push({ start: plainTextStart, end: referenceStart })
      }
      plainTextStart = referenceStart + reference[0].length
    }
    if (plainTextStart < location.endOffset) {
      textSpans.push({ start: plainTextStart, end: location.endOffset })
    }
    return '#text'
  }
  if (isHtmlCommentNode(node)) {
    return isValidSourceLocation(node.sourceCodeLocation, source)
      ? ['comment', node.data]
      : undefined
  }
  if (node.nodeName === '#documentType') return undefined
  if (!isHtmlElement(node)) return undefined

  const markerExpectation = options.markerExpectations?.[options.markerIndex]
  if (markerExpectation !== undefined && markerExpectation.tagName === node.tagName) {
    const location = node.sourceCodeLocation
    const markerText = node.childNodes[0]
    if (
      node.namespaceURI !== html.NS.HTML ||
      node.attrs.length !== 0 ||
      !isValidSourceLocation(location?.startTag, source) ||
      !isValidSourceLocation(location?.endTag, source) ||
      node.childNodes.length !== 1 ||
      markerText === undefined ||
      !isHtmlTextNode(markerText) ||
      markerText.value !== markerExpectation.text
    ) {
      return undefined
    }
    options.markerIndex += 1
    return '#text'
  }

  if (
    node.namespaceURI !== html.NS.HTML ||
    HTML_RAW_TEXT_TAGS.has(node.tagName) ||
    options.rejectedMarkerTags.has(node.tagName) ||
    !isValidSourceLocation(node.sourceCodeLocation?.startTag, source)
  ) {
    return undefined
  }
  const attributeStructure: unknown[] = []
  for (const attribute of node.attrs) {
    const location = node.sourceCodeLocation?.attrs?.[attribute.name]
    if (
      attribute.namespace !== undefined ||
      attribute.prefix !== undefined ||
      !isValidSourceLocation(location, source)
    ) {
      return undefined
    }
    attributeStructure.push([attribute.name, attribute.value])
  }
  const children = htmlChildrenStructure(node.childNodes, source, textSpans, options)
  return children === undefined
    ? undefined
    : ['element', node.tagName, node.namespaceURI, attributeStructure, children]
}

const parseSafeHtmlFragmentSource = (
  source: string,
  rejectedMarkerTags: ReadonlySet<string>
): SafeHtmlSource | undefined => {
  let hasParseError = false
  let fragment: DefaultTreeAdapterTypes.DocumentFragment
  try {
    fragment = parseFragment(source, {
      sourceCodeLocationInfo: true,
      onParseError: () => {
        hasParseError = true
      }
    })
  } catch {
    return undefined
  }
  if (hasParseError) return undefined

  const textSpans: HtmlTextSpan[] = []
  const options: HtmlStructureOptions = {
    markerIndex: 0,
    rejectedMarkerTags
  }
  const structure = htmlChildrenStructure(fragment.childNodes, source, textSpans, options)
  if (structure === undefined) return undefined

  textSpans.sort((left, right) => left.start - right.start || left.end - right.end)
  let nonTextSource = ''
  let cursor = 0
  for (const span of textSpans) {
    if (span.start < cursor) return undefined
    nonTextSource += source.slice(cursor, span.start)
    cursor = span.end
  }
  nonTextSource += source.slice(cursor)
  return { structure: JSON.stringify(structure), nonTextSource, textSpans }
}

const parseSafeHtmlSource = (
  source: string,
  rejectedMarkerTags: ReadonlySet<string>
): SafeHtmlSource | undefined =>
  isPureHtmlSource(source) ? parseSafeHtmlFragmentSource(source, rejectedMarkerTags) : undefined

const markdownTokenProperties = (token: MarkdownToken): unknown[] => {
  if (token.type === 'heading') return [token.depth]
  if (token.type === 'link') return [token.href, token.title]
  return []
}

const markdownHtmlTagName = (source: string): string | undefined =>
  source.match(/^<\/?\s*([a-z][a-z0-9-]*)\b/iu)?.[1]?.toLowerCase()

const appendMarkdownTextSpans = (
  source: string,
  start: number,
  textSpans: HtmlTextSpan[]
): void => {
  if (source.includes('$')) return

  let plainTextStart = start
  for (const reference of source.matchAll(HTML_CHARACTER_REFERENCE_SOURCE)) {
    const referenceStart = start + reference.index
    if (referenceStart > plainTextStart) {
      textSpans.push({ start: plainTextStart, end: referenceStart })
    }
    plainTextStart = referenceStart + reference[0].length
  }
  if (plainTextStart < start + source.length) {
    textSpans.push({ start: plainTextStart, end: start + source.length })
  }
}

const markdownTokenStructure = (
  token: MarkdownToken,
  source: string,
  start: number,
  textSpans: HtmlTextSpan[],
  rejectedMarkerTags: ReadonlySet<string>,
  acceptedMarkerTags: ReadonlySet<string>,
  markerEvents: MarkdownMarkerEvent[]
): unknown | undefined => {
  const end = start + token.raw.length
  if (start < 0 || end > source.length || source.slice(start, end) !== token.raw) return undefined

  if (token.type === 'text') {
    appendMarkdownTextSpans(token.raw, start, textSpans)
    return '#text'
  }

  if (token.type === 'html') {
    for (const tagName of acceptedMarkerTags) {
      if (token.raw === `<${tagName}>` || token.raw === `</${tagName}>`) {
        markerEvents.push({
          tagName,
          closing: token.raw.startsWith('</'),
          start,
          end
        })
        return '#text'
      }
    }
    if (
      [...rejectedMarkerTags].some((tagName) =>
        new RegExp(`^<\\/?${tagName}(?:\\s|/?>)`, 'u').test(token.raw)
      )
    ) {
      return undefined
    }
    const tagName = markdownHtmlTagName(token.raw)
    if (tagName && (HTML_RAW_TEXT_TAGS.has(tagName) || tagName === 'svg' || tagName === 'math')) {
      return undefined
    }
    return ['html', token.raw]
  }

  const children = token.tokens
  if (!children || children.length === 0 || (token.type === 'link' && !token.raw.startsWith('['))) {
    return [token.type, markdownTokenProperties(token), token.raw]
  }

  const childStructure: unknown[] = []
  let childCursor = 0
  for (const child of children) {
    if (child.raw.length === 0) return undefined
    const relativeStart = token.raw.indexOf(child.raw, childCursor)
    if (relativeStart < 0) return undefined
    const structure = markdownTokenStructure(
      child,
      source,
      start + relativeStart,
      textSpans,
      rejectedMarkerTags,
      acceptedMarkerTags,
      markerEvents
    )
    if (structure === undefined) return undefined
    if (structure !== '#text') childStructure.push(structure)
    childCursor = relativeStart + child.raw.length
  }
  return [token.type, markdownTokenProperties(token), childStructure]
}

const parseSafeInlineMarkdownSource = (
  source: string,
  rejectedMarkerTags: ReadonlySet<string>,
  acceptedMarkerTags: ReadonlySet<string> = new Set()
): SafeInlineMarkdownSource | undefined => {
  if (MARKDOWN_REFERENCE_LINK.test(source) || MARKDOWN_TABLE_DELIMITER_ROW.test(source)) {
    return undefined
  }
  let tokens: MarkdownToken[]
  try {
    tokens = marked.lexer(source).filter((token) => token.type !== 'space') as MarkdownToken[]
  } catch {
    return undefined
  }
  const token = tokens[0]
  if (
    tokens.length !== 1 ||
    token === undefined ||
    (token.type !== 'paragraph' && token.type !== 'heading') ||
    token.raw !== source
  ) {
    return undefined
  }

  const textSpans: HtmlTextSpan[] = []
  const markerEvents: MarkdownMarkerEvent[] = []
  const structure = markdownTokenStructure(
    token,
    source,
    0,
    textSpans,
    rejectedMarkerTags,
    acceptedMarkerTags,
    markerEvents
  )
  if (structure === undefined) return undefined

  textSpans.sort((left, right) => left.start - right.start || left.end - right.end)
  let nonTextSource = ''
  let cursor = 0
  for (const span of textSpans) {
    if (span.start < cursor) return undefined
    nonTextSource += source.slice(cursor, span.start)
    cursor = span.end
  }
  nonTextSource += source.slice(cursor)
  return {
    structure: JSON.stringify(structure),
    nonTextSource,
    textSpans,
    markerEvents
  }
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

const withoutTrailingContextLineEnding = (segments: DiffSegment[]): DiffSegment[] => {
  if (segments.some((segment) => segment.kind !== 'context' && segment.text.includes('\r'))) {
    return segments
  }
  const last = segments.at(-1)
  if (last?.kind !== 'context') return segments
  const ending = last.text.match(/(?:\r\n|\n)$/u)?.[0]
  if (ending === undefined) return segments

  const result = segments.map((segment) => ({ ...segment }))
  const resultLast = result.at(-1)!
  resultLast.text = resultLast.text.slice(0, -ending.length)
  if (resultLast.text.length === 0) result.pop()
  return result
}

const changedSegmentsFitHtmlText = (
  segments: DiffSegment[],
  changedKind: 'added' | 'removed',
  source: string,
  textSpans: HtmlTextSpan[]
): boolean => {
  let offset = 0
  let spanIndex = 0
  for (const segment of segments) {
    if (segment.kind !== 'context' && segment.kind !== changedKind) continue
    const start = offset
    offset += segment.text.length
    if (segment.kind === 'context') continue
    while (textSpans[spanIndex] && textSpans[spanIndex]!.end <= start) spanIndex += 1
    const span = textSpans[spanIndex]
    if (
      segment.kind !== changedKind ||
      segment.text.length === 0 ||
      span === undefined ||
      start < span.start ||
      offset > span.end
    ) {
      return false
    }
  }
  return offset === source.length
}

const toMarkedSegmentsReplacement = (
  segments: DiffSegment[],
  tags: MarkdownChangeTags
): MarkedInlineReplacement | undefined => {
  const changedSegments = segments.filter((segment) => segment.kind !== 'context')
  if (changedSegments.length === 0 || changedSegments.length > MARKDOWN_RENDERED_DIFF_MAX_MARKERS) {
    return undefined
  }
  const content: string[] = []
  const markers: HtmlMarkerExpectation[] = []
  for (const segment of segments) {
    if (segment.kind === 'context') {
      content.push(segment.text)
      continue
    }
    content.push(markdownChangeMarkup(segment.kind, segment.text, tags))
    markers.push({ tagName: tags[segment.kind], text: segment.text })
  }
  const replacement = content.join('')
  return replacement.length <= MARKDOWN_RENDERED_DIFF_MAX_CHARS
    ? { content: replacement, markers }
    : undefined
}

const hasValidInjectedHtmlFragmentMarkers = (
  content: string,
  expectedStructure: string,
  markers: HtmlMarkerExpectation[],
  tags: MarkdownChangeTags
): boolean => {
  let hasParseError = false
  let fragment: DefaultTreeAdapterTypes.DocumentFragment
  try {
    fragment = parseFragment(content, {
      sourceCodeLocationInfo: true,
      onParseError: () => {
        hasParseError = true
      }
    })
  } catch {
    return false
  }
  if (hasParseError) return false

  const options: HtmlStructureOptions = {
    markerExpectations: markers,
    markerIndex: 0,
    rejectedMarkerTags: new Set([tags.added, tags.removed])
  }
  const structure = htmlChildrenStructure(fragment.childNodes, content, [], options)
  return (
    structure !== undefined &&
    options.markerIndex === markers.length &&
    JSON.stringify(structure) === expectedStructure
  )
}

const hasValidInjectedHtmlMarkers = (
  content: string,
  expectedStructure: string,
  markers: HtmlMarkerExpectation[],
  tags: MarkdownChangeTags
): boolean =>
  isPureHtmlSource(content) &&
  hasValidInjectedHtmlFragmentMarkers(content, expectedStructure, markers, tags)

const hasValidInjectedMarkdownMarkers = (
  content: string,
  expectedStructure: string,
  markers: HtmlMarkerExpectation[],
  tags: MarkdownChangeTags
): boolean => {
  const markerTags = new Set([tags.added, tags.removed])
  const parsed = parseSafeInlineMarkdownSource(content, markerTags, markerTags)
  if (parsed === undefined || parsed.structure !== expectedStructure) return false
  if (parsed.markerEvents.length !== markers.length * 2) return false

  return markers.every((marker, index) => {
    const opening = parsed.markerEvents[index * 2]
    const closing = parsed.markerEvents[index * 2 + 1]
    return (
      opening !== undefined &&
      closing !== undefined &&
      !opening.closing &&
      closing.closing &&
      opening.tagName === marker.tagName &&
      closing.tagName === marker.tagName &&
      content.slice(opening.end, closing.start) === escapeHtmlText(marker.text)
    )
  })
}

const RENDERED_INLINE_MARKDOWN_TOKEN_TYPES = new Set(['text', 'escape', 'strong', 'em', 'del'])

const markdownGraphemes = (content: string): string[] =>
  MARKDOWN_GRAPHEME_SEGMENTER
    ? Array.from(MARKDOWN_GRAPHEME_SEGMENTER.segment(content), ({ segment }) => segment)
    : Array.from(content)

const isSafeRenderedInlineMarkdownToken = (token: MarkdownToken): boolean =>
  RENDERED_INLINE_MARKDOWN_TOKEN_TYPES.has(token.type) &&
  (token.tokens?.every(isSafeRenderedInlineMarkdownToken) ?? true)

const renderedInlineMarkdown = (
  source: string,
  rejectedMarkerTags: ReadonlySet<string>
): RenderedInlineMarkdown | undefined => {
  if (
    source.length > MARKDOWN_RENDERED_DIFF_MAX_CHARS ||
    /[\r\n$`|]/u.test(source) ||
    MARKDOWN_ENTITY.test(source) ||
    MARKDOWN_LINK_OR_REFERENCE.test(source) ||
    MARKDOWN_REFERENCE_LINK.test(source)
  ) {
    return undefined
  }

  let rendered: string
  try {
    const tokens = marked.lexer(source).filter((token) => token.type !== 'space') as MarkdownToken[]
    const token = tokens[0]
    if (
      tokens.length !== 1 ||
      token?.type !== 'paragraph' ||
      token.raw !== source ||
      token.tokens === undefined ||
      !token.tokens.every(isSafeRenderedInlineMarkdownToken)
    ) {
      return undefined
    }
    rendered = marked.parseInline(source) as string
  } catch {
    return undefined
  }

  if (rendered.length > MARKDOWN_RENDERED_DIFF_MAX_CHARS) return undefined
  const safeHtml = parseSafeHtmlFragmentSource(rendered, rejectedMarkerTags)
  if (safeHtml === undefined) return undefined

  let hasParseError = false
  let fragment: DefaultTreeAdapterTypes.DocumentFragment
  try {
    fragment = parseFragment(rendered, {
      sourceCodeLocationInfo: true,
      onParseError: () => {
        hasParseError = true
      }
    })
  } catch {
    return undefined
  }
  if (hasParseError) return undefined

  const textNodes: RenderedMarkdownTextNode[] = []
  let text = ''
  const collectTextNodes = (
    nodes: DefaultTreeAdapterTypes.ChildNode[],
    ancestors: string[]
  ): boolean => {
    for (const node of nodes) {
      if (isHtmlTextNode(node)) {
        const location = node.sourceCodeLocation
        if (!isValidSourceLocation(location, rendered)) return false
        const textStart = text.length
        text += node.value
        textNodes.push({
          htmlStart: location.startOffset,
          htmlEnd: location.endOffset,
          textStart,
          textEnd: text.length,
          value: node.value,
          ancestors
        })
        continue
      }
      if (
        !isHtmlElement(node) ||
        !collectTextNodes(node.childNodes, [...ancestors, node.tagName])
      ) {
        return false
      }
    }
    return true
  }
  if (!collectTextNodes(fragment.childNodes, []) || textNodes.length === 0) return undefined

  return { content: rendered, structure: safeHtml.structure, text, textNodes }
}

// Common affixes are fixed before Myers runs so repeated punctuation stays anchored to the nearest
// natural-language boundary instead of an earlier identical character in a removed paragraph.
const visibleMarkdownChanges = (
  before: string,
  after: string
): VisibleMarkdownChange[] | undefined => {
  if (before === after) return undefined
  const beforeCharacters = markdownGraphemes(before)
  const afterCharacters = markdownGraphemes(after)
  let prefixLength = 0
  while (
    prefixLength < beforeCharacters.length &&
    prefixLength < afterCharacters.length &&
    beforeCharacters[prefixLength] === afterCharacters[prefixLength]
  ) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < beforeCharacters.length - prefixLength &&
    suffixLength < afterCharacters.length - prefixLength &&
    beforeCharacters[beforeCharacters.length - suffixLength - 1] ===
      afterCharacters[afterCharacters.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }
  if (suffixLength > 0) {
    const beforeSuffixStart = beforeCharacters.length - suffixLength
    const afterSuffixStart = afterCharacters.length - suffixLength
    const suffixStartsInsideWord =
      /[\p{L}\p{M}\p{N}_]/u.test(beforeCharacters[beforeSuffixStart]!) &&
      (/[\p{L}\p{M}\p{N}_]/u.test(beforeCharacters[beforeSuffixStart - 1] ?? '') ||
        /[\p{L}\p{M}\p{N}_]/u.test(afterCharacters[afterSuffixStart - 1] ?? ''))
    if (suffixStartsInsideWord) suffixLength = 0
  }

  const prefix = beforeCharacters.slice(0, prefixLength).join('')
  const suffix = suffixLength === 0 ? '' : beforeCharacters.slice(-suffixLength).join('')
  const beforeMiddle = beforeCharacters.slice(prefixLength, beforeCharacters.length - suffixLength)
  const afterMiddle = afterCharacters.slice(prefixLength, afterCharacters.length - suffixLength)
  const middleChanges = diffArrays(beforeMiddle, afterMiddle, {
    maxEditLength: 10_000,
    timeout: 100
  })
  if (middleChanges === undefined) return undefined

  const segments: DiffSegment[] = []
  if (prefix.length > 0) appendTextSegment(segments, { kind: 'context', text: prefix })
  for (const change of middleChanges) {
    appendTextSegment(segments, {
      kind: change.added ? 'added' : change.removed ? 'removed' : 'context',
      text: change.value.join('')
    })
  }
  if (suffix.length > 0) appendTextSegment(segments, { kind: 'context', text: suffix })

  let beforeOffset = 0
  let afterOffset = 0
  const changes = segments.map((segment) => {
    const beforeStart = beforeOffset
    const afterStart = afterOffset
    if (segment.kind !== 'added') beforeOffset += segment.text.length
    if (segment.kind !== 'removed') afterOffset += segment.text.length
    return {
      ...segment,
      beforeStart,
      beforeEnd: beforeOffset,
      afterStart,
      afterEnd: afterOffset
    }
  })
  const reconstructedBefore = segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text)
    .join('')
  const reconstructedAfter = segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text)
    .join('')
  return reconstructedBefore === before && reconstructedAfter === after ? changes : undefined
}

const sameFormattingAncestors = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((ancestor, index) => ancestor === right[index])

const commonFormattingAncestors = (left: string[], right: string[]): string[] => {
  const common: string[] = []
  while (common.length < left.length && left[common.length] === right[common.length]) {
    common.push(left[common.length]!)
  }
  return common
}

const renderedTextNodeAt = (
  rendered: RenderedInlineMarkdown,
  offset: number
): RenderedMarkdownTextNode | undefined =>
  rendered.textNodes.find((node) => node.textStart <= offset && offset < node.textEnd)

const renderedGraphemesFitTextNodes = (rendered: RenderedInlineMarkdown): boolean => {
  let offset = 0
  for (const grapheme of markdownGraphemes(rendered.text)) {
    const end = offset + grapheme.length
    const node = renderedTextNodeAt(rendered, offset)
    if (node === undefined || end > node.textEnd) return false
    offset = end
  }
  return offset === rendered.text.length
}

const renderedContextFormattingMatches = (
  before: RenderedInlineMarkdown,
  after: RenderedInlineMarkdown,
  changes: VisibleMarkdownChange[]
): boolean => {
  for (const change of changes) {
    if (change.kind !== 'context') continue
    let beforeOffset = change.beforeStart
    let afterOffset = change.afterStart
    while (beforeOffset < change.beforeEnd && afterOffset < change.afterEnd) {
      const beforeNode = renderedTextNodeAt(before, beforeOffset)
      const afterNode = renderedTextNodeAt(after, afterOffset)
      if (
        beforeNode === undefined ||
        afterNode === undefined ||
        !sameFormattingAncestors(beforeNode.ancestors, afterNode.ancestors)
      ) {
        return false
      }
      const length = Math.min(
        beforeNode.textEnd - beforeOffset,
        afterNode.textEnd - afterOffset,
        change.beforeEnd - beforeOffset,
        change.afterEnd - afterOffset
      )
      if (length <= 0) return false
      beforeOffset += length
      afterOffset += length
    }
    if (beforeOffset !== change.beforeEnd || afterOffset !== change.afterEnd) return false
  }
  return true
}

const removalCanUseFormatting = (
  before: RenderedInlineMarkdown,
  change: VisibleMarkdownChange,
  insertionAncestors: string[]
): boolean => {
  const sourceNodes = before.textNodes.filter(
    (node) => node.textStart < change.beforeEnd && node.textEnd > change.beforeStart
  )
  return (
    sourceNodes.length > 0 &&
    sourceNodes.every((node) =>
      insertionAncestors.every((ancestor, index) => node.ancestors[index] === ancestor)
    )
  )
}

const renderedBoundary = (
  rendered: RenderedInlineMarkdown,
  textOffset: number
): RenderedMarkdownBoundary | undefined => {
  if (textOffset === 0) return { htmlOffset: 0, ancestors: [] }
  if (textOffset === rendered.text.length) {
    return { htmlOffset: rendered.content.length, ancestors: [] }
  }
  const previous = rendered.textNodes.findLast((node) => node.textEnd <= textOffset)
  const next = rendered.textNodes.find((node) => node.textStart >= textOffset)
  if (previous?.textEnd !== textOffset || next?.textStart !== textOffset) return undefined

  // Markers at formatting boundaries belong between the closing and opening tags. Keeping them out
  // of either sibling prevents a removed plain-text phrase from inheriting unrelated bold/emphasis.
  const separator = rendered.content.slice(previous.htmlEnd, next.htmlStart)
  const closingTags = separator.match(/^(?:<\/[a-z][a-z0-9-]*>)+/u)?.[0] ?? ''
  return {
    htmlOffset: previous.htmlEnd + closingTags.length,
    ancestors: commonFormattingAncestors(previous.ancestors, next.ancestors)
  }
}

const renderChangedTextNode = (
  node: RenderedMarkdownTextNode,
  changes: VisibleMarkdownChange[],
  tags: MarkdownChangeTags
): { content: string; markers: HtmlMarkerExpectation[] } | undefined => {
  const content: string[] = []
  const markers: HtmlMarkerExpectation[] = []
  for (const change of changes) {
    if (change.kind === 'removed') {
      if (change.afterStart > node.textStart && change.afterStart < node.textEnd) {
        content.push(markdownChangeMarkup('removed', change.text, tags))
        markers.push({ tagName: tags.removed, text: change.text })
      }
      continue
    }
    const start = Math.max(node.textStart, change.afterStart)
    const end = Math.min(node.textEnd, change.afterEnd)
    if (start >= end) continue
    const value = change.text.slice(start - change.afterStart, end - change.afterStart)
    if (change.kind === 'added') {
      content.push(markdownChangeMarkup('added', value, tags))
      markers.push({ tagName: tags.added, text: value })
    } else {
      content.push(escapeHtmlText(value))
    }
  }
  const sourceText = changes
    .filter((change) => change.kind !== 'removed')
    .map((change) => change.text)
    .join('')
    .slice(node.textStart, node.textEnd)
  return sourceText === node.value ? { content: content.join(''), markers } : undefined
}

const toRenderedInlineMarkdownReplacement = (
  segments: DiffSegment[],
  tags: MarkdownChangeTags
): string | undefined => {
  if (
    tags.added === tags.removed ||
    !isSafeHtmlMarkerTag(tags.added) ||
    !isSafeHtmlMarkerTag(tags.removed)
  ) {
    return undefined
  }
  const beforeSource = segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text)
    .join('')
  const afterSource = segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text)
    .join('')
  const markerTags = new Set([tags.added, tags.removed])
  const before = renderedInlineMarkdown(beforeSource, markerTags)
  const after = renderedInlineMarkdown(afterSource, markerTags)
  if (before === undefined || after === undefined) return undefined
  const changes = visibleMarkdownChanges(before.text, after.text)
  if (
    changes === undefined ||
    !renderedGraphemesFitTextNodes(before) ||
    !renderedGraphemesFitTextNodes(after) ||
    !renderedContextFormattingMatches(before, after, changes)
  ) {
    return undefined
  }

  for (const change of changes) {
    if (change.kind !== 'removed') continue
    const interiorNode = after.textNodes.find(
      (node) => change.afterStart > node.textStart && change.afterStart < node.textEnd
    )
    const insertionAncestors =
      interiorNode?.ancestors ?? renderedBoundary(after, change.afterStart)?.ancestors
    if (
      insertionAncestors === undefined ||
      !removalCanUseFormatting(before, change, insertionAncestors)
    ) {
      return undefined
    }
  }

  const htmlChanges: RenderedHtmlChange[] = []
  for (const node of after.textNodes) {
    const replacement = renderChangedTextNode(node, changes, tags)
    if (replacement === undefined) return undefined
    htmlChanges.push({
      start: node.htmlStart,
      end: node.htmlEnd,
      content: replacement.content,
      markers: replacement.markers
    })
  }

  const boundaryRemovals = new Map<number, DiffSegment[]>()
  for (const change of changes) {
    if (change.kind !== 'removed') continue
    const isInsideTextNode = after.textNodes.some(
      (node) => change.afterStart > node.textStart && change.afterStart < node.textEnd
    )
    if (isInsideTextNode) continue
    const boundary = renderedBoundary(after, change.afterStart)
    if (boundary === undefined) return undefined
    const removals = boundaryRemovals.get(boundary.htmlOffset) ?? []
    removals.push(change)
    boundaryRemovals.set(boundary.htmlOffset, removals)
  }
  for (const [htmlOffset, removals] of boundaryRemovals) {
    htmlChanges.push({
      start: htmlOffset,
      end: htmlOffset,
      content: removals
        .map((removal) => markdownChangeMarkup('removed', removal.text, tags))
        .join(''),
      markers: removals.map((removal) => ({ tagName: tags.removed, text: removal.text }))
    })
  }

  htmlChanges.sort((left, right) => left.start - right.start || left.end - right.end)
  const content: string[] = []
  const markers: HtmlMarkerExpectation[] = []
  let cursor = 0
  for (const change of htmlChanges) {
    if (change.start < cursor) return undefined
    content.push(after.content.slice(cursor, change.start), change.content)
    markers.push(...change.markers)
    cursor = change.end
  }
  content.push(after.content.slice(cursor))
  const replacement = content.join('')
  if (
    markers.length === 0 ||
    markers.length > MARKDOWN_RENDERED_DIFF_MAX_MARKERS ||
    replacement.length > MARKDOWN_RENDERED_DIFF_MAX_CHARS ||
    !hasValidInjectedHtmlFragmentMarkers(replacement, after.structure, markers, tags)
  ) {
    return undefined
  }
  return replacement
}

const toStableInlineMarkdownReplacement = (
  segments: DiffSegment[],
  tags: MarkdownChangeTags
): string | undefined => {
  if (
    tags.added === tags.removed ||
    !isSafeHtmlMarkerTag(tags.added) ||
    !isSafeHtmlMarkerTag(tags.removed)
  ) {
    return undefined
  }
  const before = segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text)
    .join('')
  const after = segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text)
    .join('')
  const markerTags = new Set([tags.added, tags.removed])
  const parsedBefore = parseSafeInlineMarkdownSource(before, markerTags)
  const parsedAfter = parseSafeInlineMarkdownSource(after, markerTags)
  const parsedHtmlBefore = parseSafeHtmlFragmentSource(before, markerTags)
  const parsedHtmlAfter = parseSafeHtmlFragmentSource(after, markerTags)
  if (
    parsedBefore === undefined ||
    parsedAfter === undefined ||
    parsedHtmlBefore === undefined ||
    parsedHtmlAfter === undefined ||
    parsedBefore.structure !== parsedAfter.structure ||
    parsedBefore.nonTextSource !== parsedAfter.nonTextSource ||
    parsedHtmlBefore.structure !== parsedHtmlAfter.structure ||
    parsedHtmlBefore.nonTextSource !== parsedHtmlAfter.nonTextSource ||
    !changedSegmentsFitHtmlText(segments, 'removed', before, parsedBefore.textSpans) ||
    !changedSegmentsFitHtmlText(segments, 'added', after, parsedAfter.textSpans) ||
    !changedSegmentsFitHtmlText(segments, 'removed', before, parsedHtmlBefore.textSpans) ||
    !changedSegmentsFitHtmlText(segments, 'added', after, parsedHtmlAfter.textSpans)
  ) {
    return undefined
  }

  const replacement = toMarkedSegmentsReplacement(segments, tags)
  return replacement !== undefined &&
    hasValidInjectedMarkdownMarkers(
      replacement.content,
      parsedBefore.structure,
      replacement.markers,
      tags
    ) &&
    hasValidInjectedHtmlFragmentMarkers(
      replacement.content,
      parsedHtmlBefore.structure,
      replacement.markers,
      tags
    )
    ? replacement.content
    : undefined
}

const toStableHtmlReplacement = (
  segments: DiffSegment[],
  tags: MarkdownChangeTags
): string | undefined => {
  const before = segments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text)
    .join('')
  const after = segments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text)
    .join('')
  if (
    tags.added === tags.removed ||
    !isSafeHtmlMarkerTag(tags.added) ||
    !isSafeHtmlMarkerTag(tags.removed)
  ) {
    return undefined
  }
  const markerTags = new Set([tags.added, tags.removed])
  const parsedBefore = parseSafeHtmlSource(before, markerTags)
  const parsedAfter = parseSafeHtmlSource(after, markerTags)
  if (
    parsedBefore === undefined ||
    parsedAfter === undefined ||
    parsedBefore.structure !== parsedAfter.structure ||
    parsedBefore.nonTextSource !== parsedAfter.nonTextSource ||
    !changedSegmentsFitHtmlText(segments, 'removed', before, parsedBefore.textSpans) ||
    !changedSegmentsFitHtmlText(segments, 'added', after, parsedAfter.textSpans)
  ) {
    return undefined
  }

  const replacement = toMarkedSegmentsReplacement(segments, tags)
  return replacement !== undefined &&
    hasValidInjectedHtmlMarkers(
      replacement.content,
      parsedBefore.structure,
      replacement.markers,
      tags
    )
    ? replacement.content
    : undefined
}

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

const mergeOverlappingDiffRanges = (ranges: DiffRange[]): DiffRange[] => {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: DiffRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.start > previous.end) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

const mergeMarkdownRanges = (
  ranges: DiffRange[],
  lines: ManagedFileVersionDiffResult['lines']
): DiffRange[] => {
  const merged: DiffRange[] = []
  for (const range of mergeOverlappingDiffRanges(ranges)) {
    const previous = merged.at(-1)
    const isReplacementBoundary =
      previous !== undefined &&
      range.start === previous.end + 1 &&
      lines[previous.end]?.kind === 'removed' &&
      lines[range.start]?.kind === 'added'
    if (isReplacementBoundary) previous.end = range.end
    else merged.push({ ...range })
  }
  return merged
}

const toInlineMarkdownReplacement = (
  removed: DiffLine,
  added: DiffLine,
  tags: MarkdownChangeTags
): InlineMarkdownReplacement | undefined => {
  const before = diffLineText(removed)
  const after = diffLineText(added)
  const inlineSegments = toInlineTextReplacement(removed, added)
  if (
    inlineSegments === undefined ||
    inlineSegments.some((segment) => segment.kind !== 'context' && /[\r\n]/u.test(segment.text))
  ) {
    return undefined
  }
  const displaySegments = withoutTrailingContextLineEnding(inlineSegments)
  const htmlReplacement = toStableHtmlReplacement(displaySegments, tags)
  if (htmlReplacement !== undefined) {
    return { content: htmlReplacement, semanticSafety: 'html' }
  }
  const markdownReplacement = toStableInlineMarkdownReplacement(displaySegments, tags)
  if (markdownReplacement !== undefined) {
    return { content: markdownReplacement, semanticSafety: 'markdown' }
  }
  const renderedMarkdownReplacement = toRenderedInlineMarkdownReplacement(displaySegments, tags)
  if (renderedMarkdownReplacement !== undefined) {
    return {
      content: renderedMarkdownReplacement,
      semanticSafety: 'markdown',
      requiresSourceFallback: true
    }
  }

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
  const replacement = toMarkedSegmentsReplacement(displaySegments, tags)
  return replacement === undefined
    ? undefined
    : { content: replacement.content, semanticSafety: 'simple' }
}

const isRenderedInlineMarkdownCandidate = (
  removed: DiffLine,
  added: DiffLine,
  tags: MarkdownChangeTags
): boolean => {
  const inlineSegments = toInlineTextReplacement(removed, added)
  if (
    inlineSegments === undefined ||
    inlineSegments.some((segment) => segment.kind !== 'context' && /[\r\n]/u.test(segment.text))
  ) {
    return false
  }
  const displaySegments = withoutTrailingContextLineEnding(inlineSegments)
  const beforeSource = displaySegments
    .filter((segment) => segment.kind !== 'added')
    .map((segment) => segment.text)
    .join('')
  const afterSource = displaySegments
    .filter((segment) => segment.kind !== 'removed')
    .map((segment) => segment.text)
    .join('')
  const markerTags = new Set([tags.added, tags.removed])
  return (
    renderedInlineMarkdown(beforeSource, markerTags) !== undefined &&
    renderedInlineMarkdown(afterSource, markerTags) !== undefined
  )
}

const appendTextSegment = (segments: DiffSegment[], segment: DiffSegment): void => {
  if (segment.text.length === 0) return
  const previous = segments.at(-1)
  if (previous?.kind === segment.kind) {
    previous.text += segment.text
    return
  }
  segments.push({ ...segment })
}

const toProjectedMixedTextSegments = (lines: DiffLine[]): DiffSegment[] | undefined => {
  const before = lines.filter((line) => line.kind !== 'added').flatMap((line) => line.segments)
  const after = lines.filter((line) => line.kind !== 'removed').flatMap((line) => line.segments)
  const segments: DiffSegment[] = []
  let beforeIndex = 0
  let beforeOffset = 0
  let afterIndex = 0
  let afterOffset = 0
  let changed = false
  const remaining = (items: DiffSegment[], index: number, offset: number): string =>
    items[index]?.text.slice(offset) ?? ''
  const advance = (
    items: DiffSegment[],
    index: number,
    offset: number,
    count: number
  ): [number, number] => {
    const nextOffset = offset + count
    return nextOffset === items[index]?.text.length ? [index + 1, 0] : [index, nextOffset]
  }

  while (beforeIndex < before.length || afterIndex < after.length) {
    const beforeSegment = before[beforeIndex]
    const afterSegment = after[afterIndex]
    if (beforeSegment?.kind === 'removed') {
      const text = remaining(before, beforeIndex, beforeOffset)
      appendTextSegment(segments, { kind: 'removed', text })
      ;[beforeIndex, beforeOffset] = advance(before, beforeIndex, beforeOffset, text.length)
      changed = true
      continue
    }
    if (afterSegment?.kind === 'added') {
      const text = remaining(after, afterIndex, afterOffset)
      appendTextSegment(segments, { kind: 'added', text })
      ;[afterIndex, afterOffset] = advance(after, afterIndex, afterOffset, text.length)
      changed = true
      continue
    }
    if (beforeSegment?.kind !== 'context' || afterSegment?.kind !== 'context') return undefined

    const beforeText = remaining(before, beforeIndex, beforeOffset)
    const afterText = remaining(after, afterIndex, afterOffset)
    const length = Math.min(beforeText.length, afterText.length)
    if (beforeText.slice(0, length) !== afterText.slice(0, length)) return undefined
    appendTextSegment(segments, { kind: 'context', text: beforeText.slice(0, length) })
    ;[beforeIndex, beforeOffset] = advance(before, beforeIndex, beforeOffset, length)
    ;[afterIndex, afterOffset] = advance(after, afterIndex, afterOffset, length)
  }
  return changed ? segments : undefined
}

const toMixedTextSegments = (lines: DiffLine[]): DiffSegment[] | undefined => {
  const segments: DiffSegment[] = []
  let outputLineCount = 0
  let previousLineHasExplicitEnding = false
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const nextLine = lines[index + 1]
    const replacement =
      line.kind === 'removed' && nextLine?.kind === 'added'
        ? toInlineTextReplacement(line, nextLine)
        : undefined
    if (line.kind === 'removed' && nextLine?.kind === 'added' && replacement === undefined) {
      return toProjectedMixedTextSegments(lines)
    }
    if (outputLineCount > 0 && !previousLineHasExplicitEnding) {
      appendTextSegment(segments, { kind: 'context', text: '\n' })
    }
    const lineSegments = replacement ?? line.segments
    for (const segment of lineSegments) appendTextSegment(segments, segment)
    previousLineHasExplicitEnding = lineSegments.at(-1)?.text.endsWith('\n') ?? false
    changed ||=
      replacement !== undefined
        ? replacement.some((segment) => segment.kind !== 'context')
        : line.kind !== 'context'
    outputLineCount += 1
    if (replacement) index += 1
  }
  return changed ? segments : undefined
}

type InlineMarkdownChange = {
  content: string
  endIndex: number
  semanticSafety: InlineMarkdownReplacement['semanticSafety']
  requiresSourceFallback?: boolean
}

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
): {
  pairs: Map<number, InlineMarkdownChange>
  indexes: Set<number>
  stableHtmlIndexes: Set<number>
  stableMarkdownIndexes: Set<number>
  forcedRawRanges: DiffRange[]
} => {
  const pairs = new Map<number, InlineMarkdownChange>()
  const indexes = new Set<number>()
  const stableHtmlIndexes = new Set<number>()
  const stableMarkdownIndexes = new Set<number>()
  const forcedRawRanges: DiffRange[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const removed = lines[index]
    const added = lines[index + 1]
    if (removed?.kind !== 'removed' || added?.kind !== 'added') continue
    const replacement = toInlineMarkdownReplacement(removed, added, tags)
    if (replacement === undefined) {
      if (isRenderedInlineMarkdownCandidate(removed, added, tags)) {
        forcedRawRanges.push({ start: index, end: index + 1 })
        index += 1
      }
      continue
    }
    pairs.set(index, { ...replacement, endIndex: index + 1 })
    indexes.add(index)
    indexes.add(index + 1)
    if (replacement.semanticSafety === 'html') {
      stableHtmlIndexes.add(index)
      stableHtmlIndexes.add(index + 1)
    }
    if (replacement.semanticSafety === 'markdown') {
      stableMarkdownIndexes.add(index)
      stableMarkdownIndexes.add(index + 1)
    }
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
    pairs.set(index, { content, endIndex: index, semanticSafety: 'simple' })
    indexes.add(index)
  }
  return { pairs, indexes, stableHtmlIndexes, stableMarkdownIndexes, forcedRawRanges }
}

const markdownSourceContent = (lines: ManagedFileVersionDiffResult['lines']): string =>
  markdownSource(lines).content

const markdownContent = (lines: ManagedFileVersionDiffResult['lines']): string =>
  markdownSourceContent(lines).replace(/(?:\r\n|\n)$/u, '')

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
    while (start > 0 && isMarkdownParagraphLine(lines[start - 1]!)) {
      start -= 1
    }
    let end = index + 1
    while (end + 1 < lines.length && isMarkdownParagraphLine(lines[end + 1]!)) {
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
    if ((presentationKind === 'prose' || mergeStructuredReplacements) && line.kind !== 'context') {
      let endIndex = index
      while (result.lines[endIndex + 1]?.kind !== 'context' && result.lines[endIndex + 1]) {
        endIndex += 1
      }
      const changedLines = result.lines.slice(index, endIndex + 1)
      const canContainCrossLineProjection =
        changedLines.length > 2 &&
        changedLines.some((candidate) => candidate.kind === 'removed') &&
        changedLines.some((candidate) => candidate.kind === 'added')
      if (canContainCrossLineProjection) {
        const segments = toProjectedMixedTextSegments(changedLines)
        if (segments?.some((segment) => segment.kind !== 'context')) {
          blocks.push({ kind: 'text', changeKind: 'mixed', segments, startIndex: index })
          index = endIndex
          continue
        }
      }
    }
    // Raw Markdown, prose, and structured views merge only pairs with explicit changed segments.
    if (
      (presentationKind === 'prose' || mergeStructuredReplacements) &&
      line.kind === 'removed' &&
      nextLine?.kind === 'added'
    ) {
      const segments = toInlineTextReplacement(line, nextLine)
      if (segments?.some((segment) => segment.kind !== 'context')) {
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
          ? [{ kind: line.kind, text: diffLineSourceText(line) }]
          : line.segments,
      startIndex: index
    })
  }
  return blocks
}

const toRawMarkdownRenderBlocks = (
  result: ManagedFileVersionDiffResult,
  markdownRanges: DiffRange[] = []
): DiffRenderBlock[] => {
  const blocks: DiffRenderBlock[] = []
  let contextLines: string[] = []
  let contextStart = 0
  const flushContext = (): void => {
    while (contextLines.at(-1) === '') contextLines.pop()
    if (contextLines.length > 0) {
      blocks.push({
        kind: 'markdown',
        changeKind: 'context',
        content: contextLines.join('\n'),
        startIndex: contextStart
      })
    }
    contextLines = []
  }

  let rangeIndex = 0
  for (let index = 0; index < result.lines.length; index += 1) {
    const range = markdownRanges[rangeIndex]
    if (range && index === range.start) {
      flushContext()
      const lines = result.lines.slice(range.start, range.end + 1)
      const hasContext = lines.some((line) => line.kind === 'context')
      const hasRemoved = lines.some((line) => line.kind === 'removed')
      const hasAdded = lines.some((line) => line.kind === 'added')
      const exactSegments =
        hasContext || (hasRemoved && hasAdded) ? toMixedTextSegments(lines) : undefined
      const mixedSegments =
        exactSegments === undefined ? undefined : withoutTrailingContextLineEnding(exactSegments)

      if (mixedSegments) {
        blocks.push({
          kind: 'text',
          changeKind: 'mixed',
          segments: mixedSegments,
          startIndex: range.start
        })
      } else {
        const appendChangedSource = (kind: 'removed' | 'added'): void => {
          const changedLines = lines.filter((line) => line.kind === kind)
          if (changedLines.length === 0) return
          blocks.push({
            kind: 'text',
            changeKind: kind,
            segments: [{ kind, text: markdownSourceContent(changedLines) }],
            startIndex: range.start
          })
        }
        appendChangedSource('removed')
        appendChangedSource('added')
      }

      index = range.end
      rangeIndex += 1
      continue
    }

    const line = result.lines[index]!
    if (line.kind === 'context') {
      if (contextLines.length === 0) contextStart = index
      contextLines.push(diffLineText(line))
      continue
    }

    flushContext()
    const nextLine = result.lines[index + 1]
    if (line.kind === 'removed' && nextLine?.kind === 'added') {
      const exactSegments = toMixedTextSegments([line, nextLine])
      const segments =
        exactSegments === undefined ? undefined : withoutTrailingContextLineEnding(exactSegments)
      if (segments) {
        blocks.push({ kind: 'text', changeKind: 'mixed', segments, startIndex: index })
      } else if (diffLineSourceText(line) === diffLineSourceText(nextLine)) {
        blocks.push({
          kind: 'text',
          changeKind: 'context',
          segments: [{ kind: 'context', text: diffLineSourceText(line) }],
          startIndex: index
        })
      } else {
        blocks.push({
          kind: 'text',
          changeKind: 'removed',
          segments: [{ kind: 'removed', text: diffLineSourceText(line) }],
          startIndex: index
        })
        blocks.push({
          kind: 'text',
          changeKind: 'added',
          segments: [{ kind: 'added', text: diffLineSourceText(nextLine) }],
          startIndex: index + 1
        })
      }
      index += 1
      continue
    }

    blocks.push({
      kind: 'text',
      changeKind: line.kind,
      segments: [{ kind: line.kind, text: diffLineSourceText(line) }],
      startIndex: index
    })
  }
  flushContext()
  return blocks
}

const requiresRawMarkdownDiff = (result: ManagedFileVersionDiffResult): boolean => {
  const before = markdownSourceContent(result.lines.filter((line) => line.kind !== 'added'))
  const after = markdownSourceContent(result.lines.filter((line) => line.kind !== 'removed'))
  return [before, after].some(
    (source) =>
      source.length > MARKDOWN_SEMANTIC_LEX_MAX_CHARS ||
      source.split('\n').some((line) => line.length > MARKDOWN_SEMANTIC_LEX_MAX_LINE_CHARS)
  )
}

const isInlineSemanticRange = (
  lines: ManagedFileVersionDiffResult['lines'],
  range: DiffRange,
  inlineChangeIndexes: ReadonlySet<number>,
  stableHtmlIndexes: ReadonlySet<number>,
  stableMarkdownIndexes: ReadonlySet<number>
): boolean => {
  const rangeLines = lines.slice(range.start, range.end + 1)
  if (
    rangeLines.some(
      (line, offset) => line.kind !== 'context' && !inlineChangeIndexes.has(range.start + offset)
    )
  ) {
    return false
  }
  const before = markdownSourceContent(rangeLines.filter((line) => line.kind !== 'added'))
  const after = markdownSourceContent(rangeLines.filter((line) => line.kind !== 'removed'))
  const semanticType = (content: string): string | undefined => {
    try {
      const tokens = marked.lexer(content).filter((token) => token.type !== 'space')
      if (tokens.length !== 1) return undefined
      const type = tokens[0]?.type
      return type === 'paragraph' ||
        type === 'heading' ||
        type === 'list' ||
        type === 'table' ||
        type === 'html'
        ? type
        : undefined
    } catch {
      return undefined
    }
  }
  const beforeType = semanticType(before)
  if (beforeType === undefined || beforeType !== semanticType(after)) return false
  if (beforeType !== 'html' && beforeType !== 'paragraph') return true

  const safeIndexes = beforeType === 'html' ? stableHtmlIndexes : stableMarkdownIndexes
  return rangeLines.every((line, offset) => {
    return line.kind !== 'context' && safeIndexes.has(range.start + offset)
  })
}

const toMarkdownRenderBlocks = (
  result: ManagedFileVersionDiffResult,
  tags: MarkdownChangeTags
): DiffRenderBlock[] => {
  const before = result.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.kind !== 'added')
  const after = result.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.kind !== 'removed')
  const requiresRaw = requiresRawMarkdownDiff(result)
  const detectedContainerRanges = markdownContainerRanges(before, after, result.lines, requiresRaw)
  if (detectedContainerRanges === undefined) return toRawMarkdownRenderBlocks(result)
  const containerRanges = mergeMarkdownRanges(detectedContainerRanges, result.lines)
  if (requiresRaw) return toRawMarkdownRenderBlocks(result, containerRanges)

  const inline = inlineMarkdownPairs(result.lines, tags)
  const beforeSemanticRanges = markdownSemanticRanges(before, 'removed')
  const afterSemanticRanges = markdownSemanticRanges(after, 'added')
  if (beforeSemanticRanges === undefined || afterSemanticRanges === undefined) {
    return toRawMarkdownRenderBlocks(result, containerRanges)
  }
  const complexChangedRanges = result.lines.flatMap((line, index) =>
    line.kind !== 'context' &&
    !inline.indexes.has(index) &&
    !isSimpleMarkdownText(diffLineText(line))
      ? [{ start: index, end: index }]
      : []
  )
  const markdownRanges = mergeMarkdownRanges(
    [
      ...beforeSemanticRanges,
      ...afterSemanticRanges,
      ...containerRanges,
      ...inline.forcedRawRanges,
      ...nonInlineParagraphRanges(result.lines, inline.pairs),
      ...complexChangedRanges
    ],
    result.lines
  ).filter(
    (range) =>
      !result.lines
        .slice(range.start, range.end + 1)
        .some((line) => isMarkdownSourceOnlyLine(diffLineText(line))) &&
      !isInlineSemanticRange(
        result.lines,
        range,
        inline.indexes,
        inline.stableHtmlIndexes,
        inline.stableMarkdownIndexes
      )
  )

  const blocks: DiffRenderBlock[] = []
  let pendingLines: string[] = []
  let pendingStart = 0
  let pendingEnd = 0
  let pendingMixed = false
  let pendingRequiresSourceFallback = false
  const flushPending = (): void => {
    while (pendingLines.at(-1) === '') pendingLines.pop()
    if (pendingLines.length > 0) {
      const exactSegments = pendingMixed
        ? toMixedTextSegments(result.lines.slice(pendingStart, pendingEnd + 1))
        : undefined
      blocks.push({
        kind: 'markdown',
        changeKind: pendingMixed ? 'mixed' : 'context',
        content: joinLineTexts(pendingLines).content,
        ...(exactSegments &&
        (pendingRequiresSourceFallback ||
          exactSegments.some((segment) => segment.text.includes('\r')))
          ? { fallbackSegments: exactSegments }
          : {}),
        startIndex: pendingStart
      })
    }
    pendingLines = []
    pendingMixed = false
    pendingRequiresSourceFallback = false
  }
  const appendPending = (
    content: string,
    index: number,
    mixed = false,
    endIndex = index,
    requiresSourceFallback = false
  ): void => {
    if (pendingLines.length === 0) pendingStart = index
    pendingLines.push(content)
    pendingEnd = endIndex
    pendingMixed ||= mixed
    pendingRequiresSourceFallback ||= requiresSourceFallback
  }

  let rangeIndex = 0
  for (let index = 0; index < result.lines.length; index += 1) {
    const range = markdownRanges[rangeIndex]
    if (range && index === range.start) {
      flushPending()
      const lines = result.lines.slice(range.start, range.end + 1)
      const removed = lines.filter((line) => line.kind !== 'added')
      const added = lines.filter((line) => line.kind !== 'removed')
      const hasRemoved = removed.some((line) => line.kind === 'removed')
      const hasAdded = added.some((line) => line.kind === 'added')
      const hasContext = lines.some((line) => line.kind === 'context')
      const exactSegments =
        hasContext || (hasRemoved && hasAdded) ? toMixedTextSegments(lines) : undefined
      const mixedSegments =
        exactSegments === undefined ? undefined : withoutTrailingContextLineEnding(exactSegments)
      const htmlReplacement =
        mixedSegments === undefined ? undefined : toStableHtmlReplacement(mixedSegments, tags)
      if (htmlReplacement !== undefined) {
        blocks.push({
          kind: 'markdown',
          changeKind: 'mixed',
          content: htmlReplacement,
          ...(exactSegments?.some((segment) => segment.text.includes('\r'))
            ? { fallbackSegments: exactSegments }
            : {}),
          startIndex: range.start
        })
      } else if (mixedSegments) {
        blocks.push({
          kind: 'text',
          changeKind: 'mixed',
          segments: mixedSegments,
          startIndex: range.start
        })
      } else if (hasRemoved) {
        blocks.push({
          kind: 'markdown',
          changeKind: 'removed',
          content: markdownContent(removed),
          startIndex: range.start
        })
      }
      if (!mixedSegments && hasAdded) {
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
      appendPending(pair.content, index, true, pair.endIndex, pair.requiresSourceFallback)
      index = pair.endIndex
      continue
    }

    const line = result.lines[index]!
    const nextLine = result.lines[index + 1]
    if (line.kind === 'removed' && nextLine?.kind === 'added') {
      const exactSegments = toMixedTextSegments([line, nextLine])
      const segments =
        exactSegments === undefined ? undefined : withoutTrailingContextLineEnding(exactSegments)
      if (segments) {
        flushPending()
        blocks.push({ kind: 'text', changeKind: 'mixed', segments, startIndex: index })
        index += 1
        continue
      }
    }
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
        segments: [{ kind: line.kind, text: diffLineSourceText(line) }],
        startIndex: index
      })
      continue
    }

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

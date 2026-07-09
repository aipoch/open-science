import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk'

import type { ToolActivity } from '@/stores/session-store'

type WebSearchResult = {
  title: string
  url: string
}

type WebSearchDetails = {
  query: string
  resultCount: number
  results: WebSearchResult[]
}

type WebSearchContentParts = {
  parsedContent: unknown[]
  plainTextContent: string[]
}

// Keeps expanded search details compact while preserving the full count in the header.
const WEB_SEARCH_RESULT_LIMIT = 8
// Known wrapper keys from different web-search providers and ACP payload shapes.
const STRUCTURED_RESULT_WRAPPER_KEYS = [
  'data',
  'output',
  'response',
  'search',
  'searchResults',
  'search_results',
  'webSearch',
  'web_search'
] as const
// Structured search payloads usually include a query plus one of these result containers.
const SEARCH_RESULT_CONTAINER_KEYS = [
  'items',
  'organic_results',
  'results',
  'searchResults',
  'search_results',
  'webPages',
  'web_results'
] as const
// Plain-text title extraction should skip metadata labels that often sit above URLs.
const PLAIN_TEXT_METADATA_TITLE_PATTERN =
  /^(api|count|endpoint|href|id|ids|link|metadata|provider|query|request|response|source|status|tool|total|type|uri|url)$/iu
const WEB_SEARCH_QUERY_PATTERN = /Web search results for query:\s*["“]([^"”\n]+)["”]/iu

// Normalizes optional strings so empty payload values do not override better fallbacks.
const trimDetail = (value: string | null | undefined): string | undefined => {
  const trimmedValue = value?.trim()

  return trimmedValue ? trimmedValue : undefined
}

// Removes the quote wrapper that ACP search titles often use around the raw query.
const stripWrappingQuotes = (value: string): string => value.replace(/^["'](.+)["']$/, '$1').trim()

// Narrows unknown JSON values to object records before walking provider-specific shapes.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads the first non-empty string from a list of possible provider field names.
const getStringProperty = (value: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const property = value[key]

    if (typeof property === 'string') return trimDetail(property)
  }

  return undefined
}

// Parses text as JSON when providers serialize structured results inside text blocks.
const parseJsonText = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Extracts the first balanced JSON array after a label such as "Links:".
const parseJsonArrayAfterLabel = (text: string, label: string): unknown | undefined => {
  const labelIndex = text.indexOf(label)

  if (labelIndex === -1) return undefined

  const arrayStartIndex = text.indexOf('[', labelIndex + label.length)

  if (arrayStartIndex === -1) return undefined

  let depth = 0
  let isInsideString = false
  let isEscaped = false

  // Scan manually so trailing prose after the array does not make the payload unparsable.
  for (let index = arrayStartIndex; index < text.length; index += 1) {
    const character = text[index]

    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false
      } else if (character === '\\') {
        isEscaped = true
      } else if (character === '"') {
        isInsideString = false
      }

      continue
    }

    if (character === '"') {
      isInsideString = true
      continue
    }

    if (character === '[') {
      depth += 1
      continue
    }

    if (character === ']') {
      depth -= 1

      if (depth === 0) {
        return parseJsonText(text.slice(arrayStartIndex, index + 1))
      }
    }
  }

  return undefined
}

// Removes punctuation that commonly sticks to URLs in prose or markdown-adjacent text.
const cleanUrl = (value: string): string => value.replace(/[),.;]+$/u, '')

// Accepts only absolute web URLs for clickable search results.
const isHttpUrl = (value: string | undefined): boolean =>
  Boolean(value?.startsWith('http://') || value?.startsWith('https://'))

// Converts supported ACP content block variants into text snippets for parsing.
const collectContentText = (content: ContentBlock): string[] => {
  switch (content.type) {
    case 'text':
      return [content.text]
    case 'resource_link':
      return [`${content.title ?? content.name}\n${content.uri}`]
    case 'resource':
      return 'text' in content.resource ? [content.resource.text] : []
    default:
      return []
  }
}

// Ignores non-content tool entries while preserving all text-bearing content blocks.
const collectToolContentText = (content: ToolCallContent): string[] =>
  content.type === 'content' ? collectContentText(content.content) : []

// Recursively finds a query field in nested structured payloads.
const extractQueryFromUnknown = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const query = extractQueryFromUnknown(item)

      if (query) return query
    }
  }

  if (!isRecord(value)) return undefined

  const query = getStringProperty(value, ['query', 'q', 'searchQuery', 'search_query'])

  if (query) return stripWrappingQuotes(query)

  for (const property of Object.values(value)) {
    const nestedQuery = extractQueryFromUnknown(property)

    if (nestedQuery) return nestedQuery
  }

  return undefined
}

// Converts one provider result object into the compact title/url model used by the UI.
const normalizeStructuredResult = (value: unknown): WebSearchResult | undefined => {
  if (!isRecord(value)) return undefined

  const title = getStringProperty(value, ['title', 'name'])
  const url = getStringProperty(value, ['url', 'uri', 'link', 'href'])

  return title && url && isHttpUrl(url)
    ? {
        title,
        url: cleanUrl(url)
      }
    : undefined
}

// Reads arrays of result objects from common provider container fields.
const extractResultsFromContainer = (value: unknown): WebSearchResult[] => {
  if (Array.isArray(value)) {
    return value
      .map(normalizeStructuredResult)
      .filter((result): result is WebSearchResult => Boolean(result))
  }

  if (!isRecord(value)) return []

  const webPages = value.webPages
  const webPagesValue =
    isRecord(webPages) && Array.isArray(webPages.value) ? webPages.value : undefined
  const candidateContainers = [
    value.results,
    value.items,
    value.organic_results,
    value.web_results,
    webPagesValue
  ]

  for (const candidateContainer of candidateContainers) {
    const results = extractResultsFromContainer(candidateContainer)

    if (results.length > 0) return results
  }

  return []
}

// Recursively walks wrapper objects until it finds a supported results container.
const extractResultsFromUnknown = (value: unknown): WebSearchResult[] => {
  if (Array.isArray(value)) return extractResultsFromContainer(value)
  if (!isRecord(value)) return []

  const results = extractResultsFromContainer(value)

  if (results.length > 0) return results

  for (const wrapperKey of STRUCTURED_RESULT_WRAPPER_KEYS) {
    const nestedResults = extractResultsFromUnknown(value[wrapperKey])

    if (nestedResults.length > 0) return nestedResults
  }

  return []
}

// Distinguishes human-readable plain-text titles from metadata labels before URL lines.
const isLikelyPlainTextResultTitle = (value: string): boolean => {
  const title = trimDetail(value)
  const normalizedTitle = title?.replace(/:$/u, '')

  return Boolean(
    title &&
    !isHttpUrl(title) &&
    normalizedTitle &&
    !PLAIN_TEXT_METADATA_TITLE_PATTERN.test(normalizedTitle)
  )
}

// Extracts result pairs from JSON-in-prose, markdown links, and title-line/url-line text.
const extractResultsFromText = (text: string): WebSearchResult[] => {
  const results: WebSearchResult[] = extractResultsFromUnknown(
    parseJsonArrayAfterLabel(text, 'Links:')
  )
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu
  let markdownMatch: RegExpExecArray | null

  while ((markdownMatch = markdownLinkPattern.exec(text))) {
    results.push({
      title: markdownMatch[1].trim(),
      url: cleanUrl(markdownMatch[2])
    })
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  // Some ACP payloads emit a result title on one line and its URL on the next.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const nextLine = lines[index + 1]
    const parenthesizedUrlMatch = line.match(/^(.+?)\s+\((https?:\/\/[^)\s]+)\)$/u)

    if (parenthesizedUrlMatch && isLikelyPlainTextResultTitle(parenthesizedUrlMatch[1])) {
      results.push({
        title: parenthesizedUrlMatch[1].trim(),
        url: cleanUrl(parenthesizedUrlMatch[2])
      })
      continue
    }

    if (isHttpUrl(nextLine) && isLikelyPlainTextResultTitle(line)) {
      results.push({
        title: line,
        url: cleanUrl(nextLine)
      })
      index += 1
    }
  }

  return results
}

// Reads the query phrase from Claude-style plain-text search result summaries.
const extractQueryFromText = (text: string): string | undefined => {
  const queryMatch = text.match(WEB_SEARCH_QUERY_PATTERN)

  return queryMatch?.[1] ? stripWrappingQuotes(queryMatch[1]) : undefined
}

// Keeps the first occurrence of each URL so multiple payload formats do not duplicate rows.
const dedupeWebSearchResults = (results: WebSearchResult[]): WebSearchResult[] => {
  const seenUrls = new Set<string>()

  return results.filter((result) => {
    if (seenUrls.has(result.url)) return false

    seenUrls.add(result.url)
    return true
  })
}

// Detects structured containers that make a query field likely to describe a search payload.
const hasSearchResultContainerHint = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasSearchResultContainerHint)
  if (!isRecord(value)) return false

  if (SEARCH_RESULT_CONTAINER_KEYS.some((key) => key in value)) return true

  return STRUCTURED_RESULT_WRAPPER_KEYS.some((key) => hasSearchResultContainerHint(value[key]))
}

// Splits ACP tool content into parsed JSON payloads and plain-text snippets for shared parsing.
const collectWebSearchContentParts = (activity: ToolActivity): WebSearchContentParts => {
  const contentTexts = activity.toolContent?.flatMap(collectToolContentText) ?? []
  const contentEntries = contentTexts.map((text) => ({
    text,
    parsed: parseJsonText(text)
  }))

  return {
    parsedContent: contentEntries
      .map((entry) => entry.parsed)
      .filter((value) => value !== undefined),
    plainTextContent: contentEntries
      .filter((entry) => entry.parsed === undefined)
      .map((entry) => entry.text)
  }
}

// Detects search-specific payload markers without treating ordinary links as classification proof.
const hasWebSearchContentEvidence = (activity: ToolActivity): boolean => {
  const { parsedContent, plainTextContent } = collectWebSearchContentParts(activity)
  const hasParsedSearchQuery = parsedContent.some(
    (value) => Boolean(extractQueryFromUnknown(value)) && hasSearchResultContainerHint(value)
  )
  const hasPlainTextQuery = plainTextContent.some((text) => Boolean(extractQueryFromText(text)))

  return hasParsedSearchQuery || hasPlainTextQuery
}

// Builds the UI-ready web-search details from all known ACP tool content shapes.
const formatWebSearchDetails = (activity: ToolActivity): WebSearchDetails => {
  const { parsedContent, plainTextContent } = collectWebSearchContentParts(activity)
  const parsedQuery = parsedContent.map(extractQueryFromUnknown).find(Boolean)
  const plainTextQuery = plainTextContent.map(extractQueryFromText).find(Boolean)
  const activityTitleQuery = trimDetail(activity.title)
  // Prefer explicit payload queries, then plain-text summaries, then the activity title fallback.
  const query = parsedQuery
    ? stripWrappingQuotes(parsedQuery)
    : plainTextQuery
      ? stripWrappingQuotes(plainTextQuery)
      : activityTitleQuery
        ? stripWrappingQuotes(activityTitleQuery)
        : ''
  const results = dedupeWebSearchResults([
    ...parsedContent.flatMap(extractResultsFromUnknown),
    ...plainTextContent.flatMap(extractResultsFromText)
  ])

  return {
    query: stripWrappingQuotes(query),
    resultCount: results.length,
    results: results.slice(0, WEB_SEARCH_RESULT_LIMIT)
  }
}

export { formatWebSearchDetails, hasWebSearchContentEvidence }
export type { WebSearchDetails, WebSearchResult }

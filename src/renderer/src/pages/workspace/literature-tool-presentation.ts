type LiteratureToolAction = 'format' | 'read' | 'search' | 'save'

type LiteratureToolSummary = Readonly<{
  action: LiteratureToolAction
  query?: string
  documentNames: readonly string[]
  documentCount: number
  passageCount?: number
  pageStart?: number
  pageEnd?: number
  retrievalMode?: 'bm25' | 'fallback'
  hasMore?: boolean
  libraryScope?: 'library' | 'project' | 'collection' | 'items'
  itemTitles?: readonly string[]
  itemCount?: number
  resultCount?: number
  totalCount?: number
  resultStart?: number
  resultEnd?: number
  requestedStart?: number
  requestedEnd?: number
  savedCount?: number
  styleId?: string
  locale?: string
  error?: string
}>

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

const asPositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

const asNonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

const parseJsonRecord = (value: unknown): UnknownRecord | undefined => {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined

  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const unwrapArguments = (value: unknown): UnknownRecord => {
  const record = parseJsonRecord(value)
  if (!record) return {}
  return parseJsonRecord(record.arguments) ?? record
}

const normalizeIdentity = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^mcp(?:__|\.)/u, '')
    .replace(/__/gu, '/')
    .replace(/\./gu, '/')
    .replace(/_/gu, '-')

const isLiteratureReadDocumentTool = (...identities: Array<string | undefined>): boolean =>
  identities.some((identity) => {
    if (!identity) return false
    const normalized = normalizeIdentity(identity)
    return (
      normalized === 'open-science-literature/read-document' ||
      normalized === 'open-science-literature-read-document'
    )
  })

const isLiteratureLibraryPdfReadTool = (...identities: Array<string | undefined>): boolean =>
  identities.some((identity) => {
    if (!identity) return false
    const normalized = normalizeIdentity(identity)
    return (
      normalized === 'open-science-library/read-library-pdf' ||
      normalized === 'open-science-library-read-library-pdf'
    )
  })

const isLiteratureLibraryLatexTool = (...identities: Array<string | undefined>): boolean =>
  identities.some((identity) => {
    if (!identity) return false
    const normalized = normalizeIdentity(identity)
    return (
      normalized === 'open-science-library/prepare-latex-bundle' ||
      normalized === 'open-science-library-prepare-latex-bundle'
    )
  })

const getLiteratureLibraryToolAction = (
  ...identities: Array<string | undefined>
): LiteratureToolAction | undefined => {
  for (const identity of identities) {
    if (!identity) continue
    const normalized = normalizeIdentity(identity)
    if (
      normalized === 'open-science-library/format-references' ||
      normalized === 'open-science-library-format-references' ||
      normalized === 'open-science-library/format-citation-document' ||
      normalized === 'open-science-library-format-citation-document' ||
      normalized === 'open-science-library/prepare-latex-bundle' ||
      normalized === 'open-science-library-prepare-latex-bundle'
    ) {
      return 'format'
    }
    if (
      normalized === 'open-science-library/search-library' ||
      normalized === 'open-science-library-search-library'
    ) {
      return 'search'
    }
    if (isLiteratureLibraryPdfReadTool(identity)) return 'read'
    if (
      normalized === 'open-science-library/read-library-abstract' ||
      normalized === 'open-science-library-read-library-abstract'
    ) {
      return 'read'
    }
    if (
      normalized === 'open-science-library/save-to-inbox' ||
      normalized === 'open-science-library-save-to-inbox'
    ) {
      return 'save'
    }
  }
  return undefined
}

const collectOutputRecords = (value: unknown, depth = 0): UnknownRecord[] => {
  if (depth > 8) return []
  const collect = (nested: unknown): UnknownRecord[] => collectOutputRecords(nested, depth + 1)
  if (Array.isArray(value)) return value.flatMap(collect)
  if (typeof value === 'string') {
    try {
      return collect(JSON.parse(value))
    } catch {
      return []
    }
  }
  const direct = parseJsonRecord(value)
  if (!direct) return []

  const nested = [direct.structuredContent, direct.result]
  if (Array.isArray(direct.content)) nested.push(...direct.content)
  if (direct.type === 'content') nested.push(direct.content)
  if (direct.type === 'text') nested.push(direct.text)
  return [direct, ...nested.flatMap(collect)]
}

const presentationRecord = (output: UnknownRecord | undefined): UnknownRecord | undefined =>
  output && isRecord(output.openScienceLiteraturePresentation)
    ? output.openScienceLiteraturePresentation
    : undefined

const isLiteratureOutputRecord = (output: UnknownRecord): boolean =>
  isRecord(output.document) ||
  Array.isArray(output.documents) ||
  isRecord(output.passage) ||
  Array.isArray(output.passages) ||
  output.retrievalMode === 'bm25' ||
  output.retrievalMode === 'fallback' ||
  'nextCursor' in output ||
  isRecord(output.error)

const documentNamesFromOutput = (output: UnknownRecord | undefined): string[] => {
  if (!output) return []
  const names: string[] = []
  if (isRecord(output.document)) {
    const name = asString(output.document.name)
    if (name) names.push(name)
  }
  if (Array.isArray(output.documents)) {
    for (const document of output.documents) {
      if (!isRecord(document)) continue
      const name = asString(document.name)
      if (name && !names.includes(name)) names.push(name)
    }
  }
  return names
}

const pageRangeFromOutput = (
  output: UnknownRecord | undefined
): Pick<LiteratureToolSummary, 'pageStart' | 'pageEnd'> => {
  if (!output) return {}
  const passages = Array.isArray(output.passages)
    ? output.passages.filter(isRecord)
    : isRecord(output.passage)
      ? [output.passage]
      : []
  const starts = passages
    .map((passage) => asPositiveInteger(passage.pageStart))
    .filter((value): value is number => value !== undefined)
  const ends = passages
    .map((passage) => asPositiveInteger(passage.pageEnd))
    .filter((value): value is number => value !== undefined)
  return {
    ...(starts.length > 0 ? { pageStart: Math.min(...starts) } : {}),
    ...(ends.length > 0 ? { pageEnd: Math.max(...ends) } : {})
  }
}

const buildLiteratureToolSummary = (
  inputValue: unknown,
  outputValue?: unknown
): LiteratureToolSummary => {
  const input = unwrapArguments(inputValue)
  const outputs = collectOutputRecords(outputValue)
  const presentation = outputs.map(presentationRecord).find(Boolean)
  const output = outputs.find(isLiteratureOutputRecord)
  const query = asString(input.query)
  const action: LiteratureToolAction = query ? 'search' : 'read'
  const presentationNames = Array.isArray(presentation?.documentNames)
    ? presentation.documentNames.flatMap((name) =>
        asString(name) ? [asString(name) as string] : []
      )
    : []
  const documentNames =
    presentationNames.length > 0 ? presentationNames : documentNamesFromOutput(output)
  const requestedIds = Array.isArray(input.documentIds)
    ? input.documentIds.filter((value): value is string => typeof value === 'string')
    : asString(input.documentId)
      ? [input.documentId as string]
      : []
  const passages = Array.isArray(output?.passages) ? output.passages.filter(isRecord) : undefined
  const passageCount = asPositiveInteger(presentation?.passageCount) ?? passages?.length
  const retrievalMode =
    presentation?.retrievalMode === 'bm25' || presentation?.retrievalMode === 'fallback'
      ? presentation.retrievalMode
      : output?.retrievalMode === 'bm25' || output?.retrievalMode === 'fallback'
        ? output.retrievalMode
        : undefined
  const error = isRecord(output?.error) ? asString(output.error.message) : undefined
  const outputPageRange = pageRangeFromOutput(output)
  const pageStart = asPositiveInteger(presentation?.pageStart) ?? outputPageRange.pageStart
  const pageEnd = asPositiveInteger(presentation?.pageEnd) ?? outputPageRange.pageEnd
  const hasMore =
    typeof presentation?.hasMore === 'boolean'
      ? presentation.hasMore
      : output && 'nextCursor' in output
        ? output.nextCursor !== null
        : undefined

  return {
    action,
    ...(query ? { query } : {}),
    documentNames,
    documentCount: documentNames.length || requestedIds.length,
    ...(passageCount !== undefined ? { passageCount } : {}),
    ...(pageStart !== undefined ? { pageStart } : {}),
    ...(pageEnd !== undefined ? { pageEnd } : {}),
    ...(retrievalMode ? { retrievalMode } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(error ? { error } : {})
  }
}

const itemTitlesFromInput = (input: UnknownRecord): string[] => {
  if (!Array.isArray(input.candidates)) return []
  return input.candidates.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.item)) return []
    const title = asString(candidate.item.title)
    return title ? [title] : []
  })
}

const itemTitlesFromResult = (outputs: readonly UnknownRecord[]): string[] => {
  const result = outputs.find((output) => Array.isArray(output.items))
  if (!result || !Array.isArray(result.items)) {
    const single = outputs.find((output) => typeof output.itemId === 'string')
    const title = asString(single?.title)
    return title ? [title] : []
  }
  return result.items.flatMap((item) => {
    if (!isRecord(item)) return []
    const title = asString(item.title)
    return title ? [title] : []
  })
}

const resultCountFromOutput = (
  action: LiteratureToolAction,
  outputs: readonly UnknownRecord[]
): number | undefined => {
  const collectionKey =
    action === 'format'
      ? 'references'
      : action === 'search' || action === 'read'
        ? 'items'
        : undefined
  if (!collectionKey) return undefined
  const result = outputs.find((output) => Array.isArray(output[collectionKey]))
  return result && Array.isArray(result[collectionKey]) ? result[collectionKey].length : undefined
}

const buildLiteratureLibraryToolSummary = (
  action: LiteratureToolAction,
  inputValue: unknown,
  outputValue?: unknown
): LiteratureToolSummary => {
  const input = unwrapArguments(inputValue)
  const outputs = collectOutputRecords(outputValue)
  const presentation = outputs.map(presentationRecord).find(Boolean)
  const presentedTitles = Array.isArray(presentation?.itemTitles)
    ? presentation.itemTitles.flatMap((title) => {
        const normalized = asString(title)
        return normalized ? [normalized] : []
      })
    : []
  const fallbackTitles =
    action === 'save'
      ? itemTitlesFromInput(input)
      : action === 'search' || action === 'read'
        ? itemTitlesFromResult(outputs)
        : []
  const itemTitles = (presentedTitles.length > 0 ? presentedTitles : fallbackTitles).slice(0, 3)
  const evidence = outputs.find(isLiteratureOutputRecord)
  const documentNames = Array.isArray(presentation?.documentNames)
    ? presentation.documentNames.flatMap((name) => {
        const normalized = asString(name)
        return normalized ? [normalized] : []
      })
    : documentNamesFromOutput(evidence)
  const passageCount =
    asNonNegativeInteger(presentation?.passageCount) ??
    (Array.isArray(evidence?.passages) ? evidence.passages.length : undefined)
  const outputPages = pageRangeFromOutput(evidence)
  const pageStart = asPositiveInteger(presentation?.pageStart) ?? outputPages.pageStart
  const pageEnd = asPositiveInteger(presentation?.pageEnd) ?? outputPages.pageEnd
  const retrievalMode =
    presentation?.retrievalMode === 'bm25' || presentation?.retrievalMode === 'fallback'
      ? presentation.retrievalMode
      : undefined
  const resultCount =
    asNonNegativeInteger(presentation?.resultCount) ?? resultCountFromOutput(action, outputs)
  const result = outputs.find(
    (output) => Array.isArray(output.items) || Array.isArray(output.references)
  )
  const totalCount =
    asNonNegativeInteger(presentation?.totalCount) ?? asNonNegativeInteger(result?.totalCount)
  const candidateCount =
    asNonNegativeInteger(presentation?.candidateCount) ??
    (action === 'save' && Array.isArray(input.candidates) ? input.candidates.length : undefined)
  const savedCount = asNonNegativeInteger(presentation?.savedCount)
  const offset =
    asNonNegativeInteger(presentation?.offset) ??
    asNonNegativeInteger(input.offset) ??
    (parseJsonRecord(inputValue) ? 0 : undefined)
  const limit = asPositiveInteger(presentation?.limit) ?? asPositiveInteger(input.limit)
  const presentedScope =
    presentation?.libraryScope === 'project' ||
    presentation?.libraryScope === 'collection' ||
    presentation?.libraryScope === 'items'
      ? presentation.libraryScope
      : presentation?.libraryScope === 'library'
        ? 'library'
        : undefined
  const inputScope =
    input.scope === 'library' ||
    input.scope === 'project' ||
    input.scope === 'collection' ||
    input.scope === 'items'
      ? input.scope
      : undefined
  const libraryScope =
    presentedScope ?? inputScope ?? (input.projectOnly === false ? 'library' : 'project')
  const hasMore =
    typeof presentation?.hasMore === 'boolean'
      ? presentation.hasMore
      : typeof result?.hasMore === 'boolean'
        ? result.hasMore
        : asNonNegativeInteger(result?.nextOffset) !== undefined
  const itemCount =
    action === 'search'
      ? (totalCount ?? resultCount ?? (presentedTitles.length > 0 ? itemTitles.length : undefined))
      : action === 'save'
        ? candidateCount
        : action === 'format'
          ? (resultCount ?? (Array.isArray(input.itemIds) ? input.itemIds.length : undefined))
          : (resultCount ??
            (Array.isArray(input.itemIds) ? input.itemIds.length : undefined) ??
            (asString(input.itemId) ? 1 : undefined) ??
            (itemTitles.length > 0 ? itemTitles.length : undefined))
  const resultStart =
    action === 'search' && resultCount && offset !== undefined ? offset + 1 : undefined
  const resultEnd =
    resultStart !== undefined && resultCount !== undefined
      ? resultStart + resultCount - 1
      : undefined
  return {
    action,
    ...(action !== 'save' && asString(input.query) ? { query: asString(input.query) } : {}),
    documentNames,
    documentCount: documentNames.length,
    ...(passageCount !== undefined ? { passageCount } : {}),
    ...(pageStart !== undefined ? { pageStart } : {}),
    ...(pageEnd !== undefined ? { pageEnd } : {}),
    ...(retrievalMode ? { retrievalMode } : {}),
    libraryScope,
    itemTitles,
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
    ...(resultStart !== undefined ? { resultStart } : {}),
    ...(resultEnd !== undefined ? { resultEnd } : {}),
    ...(action === 'search' && offset !== undefined ? { requestedStart: offset + 1 } : {}),
    ...(action === 'search' && offset !== undefined && limit !== undefined
      ? { requestedEnd: offset + limit }
      : {}),
    ...(savedCount !== undefined ? { savedCount } : {}),
    ...(action === 'format' && asString(input.styleId) ? { styleId: asString(input.styleId) } : {}),
    ...(action === 'format' && asString(input.locale) ? { locale: asString(input.locale) } : {}),
    ...(hasMore !== undefined ? { hasMore } : {})
  }
}

export {
  buildLiteratureLibraryToolSummary,
  buildLiteratureToolSummary,
  getLiteratureLibraryToolAction,
  isLiteratureLibraryLatexTool,
  isLiteratureLibraryPdfReadTool,
  isLiteratureReadDocumentTool
}
export type { LiteratureToolAction, LiteratureToolSummary }

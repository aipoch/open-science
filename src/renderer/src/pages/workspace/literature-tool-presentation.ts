type LiteratureToolAction = 'read' | 'search'

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
  return isRecord(record.arguments) ? record.arguments : record
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

const collectOutputRecords = (value: unknown): UnknownRecord[] => {
  if (Array.isArray(value)) return value.flatMap(collectOutputRecords)
  const direct = parseJsonRecord(value)
  if (!direct) return []

  const nested = [direct.structuredContent, direct.result]
  if (Array.isArray(direct.content)) nested.push(...direct.content)
  if (direct.type === 'content') nested.push(direct.content)
  if (direct.type === 'text') nested.push(direct.text)
  return [direct, ...nested.flatMap(collectOutputRecords)]
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
  const presentedQuery = query && !/\p{Script=Han}/u.test(query) ? query : undefined
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
    ...(presentedQuery ? { query: presentedQuery } : {}),
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

export { buildLiteratureToolSummary, isLiteratureReadDocumentTool }
export type { LiteratureToolAction, LiteratureToolSummary }

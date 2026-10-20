const PDF_BOOKMARK_LIMITS = Object.freeze({ id: 512, name: 1024, path: 4096 })

export type PdfDocumentSource = Readonly<{
  kind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
  projectId?: string
  sourceFileId: string
  versionId: string
  sessionId?: string
  checksum: string
  name: string
  path: string
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key))
const SOURCE_KEYS = new Set([
  'kind',
  'projectId',
  'sourceFileId',
  'versionId',
  'sessionId',
  'checksum',
  'name',
  'path'
])

const boundedString = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined

export const sanitizePdfDocumentSource = (value: unknown): PdfDocumentSource | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, SOURCE_KEYS)) return undefined
  const kind = value.kind
  if (
    kind !== 'artifact-version' &&
    kind !== 'upload-version' &&
    kind !== 'literature-attachment-version'
  ) {
    return undefined
  }
  const projectId = boundedString(value.projectId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const sourceFileId = boundedString(value.sourceFileId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const versionId = boundedString(value.versionId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const sessionId =
    value.sessionId === undefined
      ? undefined
      : boundedString(value.sessionId, PDF_BOOKMARK_LIMITS.id)?.trim()
  const name = boundedString(value.name, PDF_BOOKMARK_LIMITS.name)?.trim()
  const path = boundedString(value.path, PDF_BOOKMARK_LIMITS.path)?.trim()
  if (
    (!projectId && kind !== 'literature-attachment-version') ||
    (value.projectId !== undefined && !projectId) ||
    !sourceFileId ||
    !versionId ||
    !name ||
    !path ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    (value.sessionId !== undefined && !sessionId)
  ) {
    return undefined
  }
  return {
    kind,
    projectId,
    sourceFileId,
    versionId,
    ...(sessionId ? { sessionId } : {}),
    checksum: value.checksum,
    name,
    path
  }
}

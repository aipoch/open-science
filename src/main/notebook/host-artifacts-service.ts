import { createHash } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'

import { fuzzyScore } from '../../shared/fuzzy-match'
import type {
  HostArtifact,
  HostArtifactCatalogItem,
  HostArtifactsResult
} from '../../shared/project-files'
import { isRecord } from '../value-guards'
import type { ImmutableInputAuthority } from '../immutable-input-authority'

type HostArtifactCatalog = {
  readHostArtifactCatalog(request: {
    projectId: string
    versionId?: string
  }): Promise<HostArtifactCatalogItem[]>
}

type HostArtifactReadContext = { projectId: string; sessionId: string }

type NormalizedOptions = {
  frameId?: string
  filename?: string
  exact: boolean
  search?: string
  contentType?: string
  afterMs?: number
  beforeMs?: number
  cursor?: string
  limit: number
}

type Cursor = {
  version: 2
  queryKey: string
  snapshotFingerprint: string
  score: number
  sortAtMs: number
  identity: string
}

type RankedArtifact = {
  item: HostArtifactCatalogItem
  score: number
  identity: string
}

const HOST_ARTIFACTS_CURSOR_SNAPSHOT_CHANGED = 'HOST_ARTIFACTS_CURSOR_SNAPSHOT_CHANGED'

const OPTION_KEYS = new Set([
  'frame_id',
  'filename',
  'exact',
  'search',
  'content_type',
  'after',
  'before',
  'cursor',
  'limit'
])
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const VALID_MIME_TOP_LEVELS = new Set([
  'application',
  'audio',
  'chemical',
  'font',
  'image',
  'message',
  'model',
  'multipart',
  'text',
  'video'
])
const MIME_FILTER_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*)?$/u

const optionalString = (
  options: Record<string, unknown>,
  key: string,
  maxLength = 256
): string | undefined => {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(
      `host.artifacts ${key} must be a non-empty string of at most ${maxLength} characters.`
    )
  }
  return value
}

const parseUtcTime = (value: string, key: 'after' | 'before'): number => {
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      normalized
    )
  ) {
    throw new Error(`host.artifacts ${key} must be a UTC date or ISO timestamp with an offset.`)
  }
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new Error(`host.artifacts ${key} is not a valid time.`)
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value) && new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(`host.artifacts ${key} is not a valid UTC date.`)
  }
  return parsed
}

const normalizeContentType = (value: Record<string, unknown>): string | undefined => {
  const contentType = optionalString(value, 'content_type')?.trim().toLowerCase()
  if (contentType === undefined) return undefined
  const topLevel = contentType.split('/', 1)[0]
  if (!MIME_FILTER_PATTERN.test(contentType) || !VALID_MIME_TOP_LEVELS.has(topLevel)) {
    throw new Error(
      'host.artifacts contentType must be a valid MIME type or top-level prefix such as "text/csv" or "image/".'
    )
  }
  return contentType
}

const normalizeOptions = (value: unknown): NormalizedOptions => {
  if (value === undefined) value = {}
  if (!isRecord(value)) throw new Error('host.artifacts options must be an object.')
  const unknown = Object.keys(value).filter((key) => !OPTION_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`host.artifacts unknown option: ${unknown[0]}`)

  const frameId = optionalString(value, 'frame_id', 512)
  const filename = optionalString(value, 'filename')
  const search = optionalString(value, 'search')
  const contentType = normalizeContentType(value)
  const after = optionalString(value, 'after', 64)
  const before = optionalString(value, 'before', 64)
  const cursor = optionalString(value, 'cursor', 4096)
  const exact = value.exact === undefined ? false : value.exact
  if (typeof exact !== 'boolean') throw new Error('host.artifacts exact must be a boolean.')
  if (exact && !filename) throw new Error('host.artifacts exact requires filename.')
  if (search && filename) throw new Error('host.artifacts search cannot be combined with filename.')
  const limit = value.limit === undefined ? DEFAULT_LIMIT : value.limit
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    throw new Error(`host.artifacts limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  const afterMs = after ? parseUtcTime(after, 'after') : undefined
  const beforeMs = before ? parseUtcTime(before, 'before') : undefined
  if (afterMs !== undefined && beforeMs !== undefined && afterMs >= beforeMs) {
    throw new Error('host.artifacts after must be earlier than before.')
  }

  return {
    frameId,
    filename,
    exact,
    search,
    contentType,
    afterMs,
    beforeMs,
    cursor,
    limit: limit as number
  }
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const decodeCursor = (value: string, queryKey: string): Cursor => {
  let cursor: unknown
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('host.artifacts cursor is invalid.')
  }
  if (isRecord(cursor) && cursor.version === 1) {
    throw new Error('host.artifacts cursor format is obsolete; restart from the first page.')
  }
  if (
    !isRecord(cursor) ||
    cursor.version !== 2 ||
    cursor.queryKey !== queryKey ||
    typeof cursor.snapshotFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(cursor.snapshotFingerprint) ||
    typeof cursor.score !== 'number' ||
    !Number.isFinite(cursor.score) ||
    typeof cursor.sortAtMs !== 'number' ||
    !Number.isFinite(cursor.sortAtMs) ||
    typeof cursor.identity !== 'string' ||
    cursor.identity.length === 0
  ) {
    throw new Error('host.artifacts cursor does not match the requested filters.')
  }
  return cursor as Cursor
}

const artifactIdentity = (item: HostArtifactCatalogItem): string =>
  `${item.source}:${item.sourceFileId}`

const compareRankedArtifacts = (
  left: Pick<RankedArtifact, 'score' | 'identity'> & {
    item: Pick<HostArtifactCatalogItem, 'sortAtMs'>
  },
  right: Pick<RankedArtifact, 'score' | 'identity'> & {
    item: Pick<HostArtifactCatalogItem, 'sortAtMs'>
  }
): number =>
  right.score - left.score ||
  right.item.sortAtMs - left.item.sortAtMs ||
  left.identity.localeCompare(right.identity)

const catalogSnapshotFingerprint = (items: HostArtifactCatalogItem[]): string => {
  const identities = items
    .map((item) => ({
      identity: artifactIdentity(item),
      versionId: item.versionId,
      checksum: item.checksum ?? '',
      projectId: item.projectId,
      sessionId: item.sessionId,
      filename: item.filename,
      contentType: item.contentType ?? '',
      sizeBytes: item.sizeBytes,
      sortAtMs: item.sortAtMs,
      rootFrameId: item.rootFrameId
    }))
    .sort((left, right) => left.identity.localeCompare(right.identity))
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex')
}

const toHostArtifact = (item: HostArtifactCatalogItem): HostArtifact => {
  if (!item.sourceFileCreatedAt) {
    throw new Error(`Host Artifact source file metadata is incomplete: ${item.versionId}`)
  }
  return {
    id: item.sourceFileId,
    filename: item.filename,
    contentType: item.contentType ?? null,
    sizeBytes: item.sizeBytes,
    latestVersionId: item.versionId,
    checksum: item.checksum ?? null,
    projectId: item.projectId,
    sessionId: item.sessionId,
    rootFrameId: item.rootFrameId,
    agentFrameId: item.agentFrameId,
    isUserUpload: item.source === 'upload',
    createdAt: item.sourceFileCreatedAt,
    latestVersionCreatedAt: item.createdAt
  }
}

const matchesContentType = (actual: string | undefined, requested: string): boolean => {
  if (!actual) return false
  const normalizedActual = actual.toLowerCase()
  const normalizedRequested = requested.toLowerCase()
  return normalizedRequested.endsWith('/')
    ? normalizedActual.startsWith(normalizedRequested)
    : normalizedActual === normalizedRequested
}

class HostArtifactsService {
  constructor(
    private readonly catalog: HostArtifactCatalog,
    private readonly inputAuthority: Pick<ImmutableInputAuthority, 'stageVersion'>
  ) {}

  async list(options: unknown, context: HostArtifactReadContext): Promise<HostArtifactsResult> {
    const normalized = normalizeOptions(options)
    const candidates = await this.catalog.readHostArtifactCatalog({ projectId: context.projectId })
    const snapshotFingerprint = catalogSnapshotFingerprint(candidates)
    const ranked: RankedArtifact[] = candidates.flatMap((item) => {
      if (
        normalized.frameId &&
        (item.source !== 'artifact' || item.agentFrameId !== normalized.frameId)
      ) {
        return []
      }
      if (normalized.filename) {
        const matches = normalized.exact
          ? basename(item.filename) === normalized.filename
          : item.filename.toLowerCase().includes(normalized.filename.toLowerCase())
        if (!matches) return []
      }
      if (normalized.contentType && !matchesContentType(item.contentType, normalized.contentType)) {
        return []
      }
      if (normalized.afterMs !== undefined && item.sortAtMs < normalized.afterMs) return []
      if (normalized.beforeMs !== undefined && item.sortAtMs >= normalized.beforeMs) return []
      const match = normalized.search ? fuzzyScore(normalized.search, item.filename) : undefined
      if (normalized.search && !match) return []
      return [{ item, score: match?.score ?? 0, identity: artifactIdentity(item) }]
    })
    ranked.sort(compareRankedArtifacts)

    const queryKey = JSON.stringify({
      projectId: context.projectId,
      frameId: normalized.frameId,
      filename: normalized.filename,
      exact: normalized.exact,
      search: normalized.search,
      contentType: normalized.contentType,
      afterMs: normalized.afterMs,
      beforeMs: normalized.beforeMs
    })
    const cursor = normalized.cursor ? decodeCursor(normalized.cursor, queryKey) : undefined
    if (cursor && cursor.snapshotFingerprint !== snapshotFingerprint) {
      throw new Error(
        `${HOST_ARTIFACTS_CURSOR_SNAPSHOT_CHANGED}: host.artifacts catalog changed; restart from the first page.`
      )
    }
    const remaining = cursor
      ? ranked.filter(
          (candidate) =>
            compareRankedArtifacts(candidate, {
              score: cursor.score,
              identity: cursor.identity,
              item: { sortAtMs: cursor.sortAtMs }
            }) > 0
        )
      : ranked
    const page = remaining.slice(0, normalized.limit)
    const truncated = page.length < remaining.length
    const artifacts = page.map(({ item }) => toHostArtifact(item))
    const last = page.at(-1)
    return {
      count: ranked.length,
      projectId: context.projectId,
      truncated,
      ...(truncated && last
        ? {
            nextCursor: encodeCursor({
              version: 2,
              queryKey,
              snapshotFingerprint,
              score: last.score,
              sortAtMs: last.item.sortAtMs,
              identity: last.identity
            })
          }
        : {}),
      artifacts
    }
  }

  async resolvePath(versionIdValue: unknown, context: HostArtifactReadContext): Promise<string> {
    if (typeof versionIdValue !== 'string' || !versionIdValue || versionIdValue.length > 512) {
      throw new Error('host.artifactPath versionId must be a non-empty string.')
    }
    const [item] = await this.catalog.readHostArtifactCatalog({
      projectId: context.projectId,
      versionId: versionIdValue
    })
    if (!item)
      throw new Error(`Artifact Version not found in the current Project: ${versionIdValue}`)

    const path = await this.inputAuthority.stageVersion({
      projectId: context.projectId,
      targetSessionId: context.sessionId,
      sourceKind: item.source === 'artifact' ? 'artifact-version' : 'upload-version',
      inputFileVersionId: versionIdValue,
      expectedSourceFileId: item.sourceFileId
    })
    if (!isAbsolute(path)) throw new Error('Notebook input stager returned a relative path.')
    return path
  }
}

export { HOST_ARTIFACTS_CURSOR_SNAPSHOT_CHANGED, HostArtifactsService }
export type { HostArtifactCatalog, HostArtifactReadContext }

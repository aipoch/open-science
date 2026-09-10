import { StringDecoder } from 'node:string_decoder'
import type {
  ProjectFileItem,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../../shared/project-files'
import { findSearchMatches, normalizeSearchText, searchTitleRank } from '../../shared/search-text'
import type { ManagedFilePreviewReadLease } from '../managed-file-preview'
import { normalizeLimit, normalizeSearch, requireIdentifier } from './query-support'

export type SearchFileOpener = (file: ProjectFileItem) => Promise<ManagedFilePreviewReadLease>
type SearchRepository = {
  searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
}
type Match = NonNullable<ProjectFileItem['contentMatch']>
const TEXT_EXTENSIONS = new Set(
  'txt text md markdown csv tsv json jsonl yaml yml xml html htm css js jsx ts tsx py r rmd qmd ipynb log ini cfg conf toml sh bash zsh sql tex bib rst c h cpp hpp java go rs rb php swift kt m julia jl'.split(
    ' '
  )
)

const isTextFile = (file: ProjectFileItem): boolean =>
  file.mimeType?.startsWith('text/') === true ||
  TEXT_EXTENSIONS.has(file.name.split('.').at(-1)?.toLowerCase() ?? '')

// Scan immutable Versions in bounded chunks. Preserve overlap for cross-chunk matches and return
// nearby context so the existing paged reader can open near a late-file hit.
const findContentMatch = async (
  file: ProjectFileItem,
  query: string,
  open: SearchFileOpener
): Promise<Match | undefined> => {
  const lease = await open(file)
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const decoder = new StringDecoder('utf8')
    let position = 0
    let decodedBytes = 0
    let line = 1
    let tail = ''
    let tailOffset = 0
    let tailLine = 1
    while (position < lease.size) {
      const { bytesRead } = await lease.read(
        buffer,
        0,
        Math.min(buffer.length, lease.size - position),
        position
      )
      if (!bytesRead) throw new Error('Managed search content ended before its declared size.')
      position += bytesRead
      const chunk =
        decoder.write(buffer.subarray(0, bytesRead)) +
        (position === lease.size ? decoder.end() : '')
      if (chunk.includes('\0')) return undefined
      const text = tail + chunk
      const match = findSearchMatches(text, query, 1)[0]
      if (match) {
        let start = match.start
        for (let context = 0; context < 4; context++) {
          const newline = text.lastIndexOf('\n', start - 1)
          if (newline < 0) {
            start = 0
            break
          }
          start = newline
        }
        if (start > 0) start++
        const prefix = text.slice(0, start)
        await lease.verifyUnchanged()
        return {
          offset: (tail ? tailOffset : decodedBytes) + Buffer.byteLength(prefix),
          startingLineNumber: (tail ? tailLine : line) + (prefix.match(/\n/g)?.length ?? 0)
        }
      }
      const keep = Math.max(256, query.length * 4)
      let split = Math.max(0, text.length - keep)
      if (split > 0 && /[\uDC00-\uDFFF]/.test(text[split]!)) split--
      const prefix = text.slice(0, split)
      tailOffset = (tail ? tailOffset : decodedBytes) + Buffer.byteLength(prefix)
      tailLine = (tail ? tailLine : line) + (prefix.match(/\n/g)?.length ?? 0)
      tail = text.slice(split)
      decodedBytes += Buffer.byteLength(chunk)
      line += chunk.match(/\n/g)?.length ?? 0
    }
    await lease.verifyUnchanged()
    return undefined
  } finally {
    await lease.close()
  }
}

// Metadata membership is re-read for every search; only immutable Version match locations are
// cached, so archived/deleted files cannot survive through a cached result page.
export const createFileContentSearch = (repository: SearchRepository, open: SearchFileOpener) => {
  let cachedQuery = ''
  let cache = new Map<string, Match | undefined>()
  return async (request: SearchArtifactsRequest): Promise<SearchArtifactsResult> => {
    const limit = normalizeLimit(request.primaryLimit)
    if (
      !Array.isArray(request.primaryProjectIds) ||
      !request.primaryProjectIds.length ||
      !Array.isArray(request.otherProjectIds)
    )
      throw new Error('Invalid content search Projects.')
    for (const id of [...request.primaryProjectIds, ...request.otherProjectIds])
      requireIdentifier(id, 'projectId')
    if (!Number.isInteger(request.otherLimit) || request.otherLimit < 0 || request.otherLimit > 5)
      throw new Error('Invalid content search otherLimit.')
    normalizeSearch({
      filenameContains: request.filenameContains ?? '',
      excludedSessionIds: request.excludedSessionIds,
      format: request.format,
      updatedAfter: request.updatedAfter,
      sort: request.sort
    })
    const query = request.filenameContains?.trim() ?? ''
    const key = JSON.stringify({
      projects: [...request.primaryProjectIds].sort(),
      other: [...request.otherProjectIds].sort(),
      excluded: [...(request.excludedSessionIds ?? [])].sort(),
      source: request.source,
      session: request.sessionId,
      query: normalizeSearchText(query),
      sort: request.sort,
      format: request.format,
      updatedAfter: request.updatedAfter
    })
    // Keep locations for the complete current query, rather than evicting the front of each scan.
    // Each request captures its own map so an older query cannot populate its successor's cache.
    if (cachedQuery !== key) {
      cachedQuery = key
      cache = new Map()
    }
    const locations = cache
    const currentVersions = new Set<string>()
    let cursor: { key: string; rank: number; sortAtMs: number; id: string } | undefined
    if (request.primaryCursor) {
      try {
        cursor = JSON.parse(Buffer.from(request.primaryCursor, 'base64url').toString())
      } catch {
        throw new Error('Invalid content search cursor.')
      }
      if (
        !cursor ||
        cursor.key !== key ||
        !Number.isFinite(cursor.rank) ||
        !Number.isFinite(cursor.sortAtMs) ||
        typeof cursor.id !== 'string'
      )
        throw new Error('Content search cursor does not match the requested search.')
    }
    const readSet = async (
      projectIds: string[]
    ): Promise<{ items: ProjectFileItem[]; complete: boolean }> => {
      if (!projectIds.length) return { items: [], complete: true }
      const items: ProjectFileItem[] = []
      let nextCursor: string | undefined
      let complete = true
      do {
        const page = await repository.searchArtifacts({
          ...request,
          searchContent: false,
          filenameContains: '',
          sort: 'recent',
          primaryProjectIds: projectIds,
          otherProjectIds: [],
          primaryLimit: 100,
          primaryCursor: nextCursor,
          otherLimit: 0
        })
        complete &&= page.isIndexComplete
        // Four concurrent leases bound disk pressure without serializing a project with many files.
        for (let offset = 0; offset < page.primary.items.length; offset += 4) {
          const batch = await Promise.all(
            page.primary.items.slice(offset, offset + 4).map(async (file) => {
              if (searchTitleRank(file.name, query)) return file
              if (!isTextFile(file)) return undefined
              try {
                const cacheKey = JSON.stringify([
                  file.projectId,
                  file.source,
                  file.sourceFileId,
                  file.sourceVersionId
                ])
                currentVersions.add(cacheKey)
                const match = locations.has(cacheKey)
                  ? locations.get(cacheKey)
                  : await findContentMatch(file, query, open)
                locations.set(cacheKey, match)
                return match ? { ...file, contentMatch: match } : undefined
              } catch {
                complete = false
                return undefined
              }
            })
          )
          items.push(...batch.filter((file): file is ProjectFileItem => file !== undefined))
        }
        nextCursor = page.primary.nextCursor
      } while (nextCursor)
      return { items, complete }
    }
    const primary = await readSet(request.primaryProjectIds)
    const other = await readSet(
      request.otherLimit
        ? request.otherProjectIds.filter((id) => !request.primaryProjectIds.includes(id))
        : []
    )
    // Removed files and superseded Versions leave no retained locations after a catalog scan.
    for (const version of locations.keys())
      if (!currentVersions.has(version)) locations.delete(version)
    const rank = (file: ProjectFileItem): number =>
      request.sort === 'recent' ? 0 : searchTitleRank(file.name, query)
    const compare = (a: { rank: number; sortAtMs: number; id: string }, b: typeof a): number =>
      b.rank - a.rank || b.sortAtMs - a.sortAtMs || a.id.localeCompare(b.id)
    const sort = (a: ProjectFileItem, b: ProjectFileItem): number =>
      compare({ ...a, rank: rank(a) }, { ...b, rank: rank(b) })
    primary.items.sort(sort)
    other.items.sort(sort)
    const remaining = cursor
      ? primary.items.filter((file) => compare({ ...file, rank: rank(file) }, cursor!) > 0)
      : primary.items
    const items = remaining.slice(0, limit)
    const last = items.at(-1)
    return {
      primary: {
        items,
        totalCount: primary.items.length,
        nextCursor:
          remaining.length > limit && last
            ? Buffer.from(
                JSON.stringify({ key, rank: rank(last), sortAtMs: last.sortAtMs, id: last.id })
              ).toString('base64url')
            : undefined
      },
      other: other.items.slice(0, request.otherLimit),
      isIndexComplete: primary.complete && other.complete
    }
  }
}

import { randomUUID } from 'node:crypto'
import { Prisma, type Bookmark as BookmarkRow, type PrismaClient } from '@prisma/client'
import { isDeepStrictEqual } from 'node:util'

import {
  bookmarkSchema,
  sanitizeBookmarkTarget,
  type Bookmark,
  type BookmarkListResult,
  type BookmarkTarget,
  type CreateBookmarkRequest,
  type ListBookmarksRequest,
  type UpdateBookmarkNoteRequest
} from '../../shared/bookmarks'

type BookmarkClient = Pick<PrismaClient, '$transaction' | 'bookmark'>
type BookmarkClientProvider = () => Promise<BookmarkClient>

const canonicalTarget = (target: BookmarkTarget): BookmarkTarget => {
  const jsonCompatible: unknown = JSON.parse(JSON.stringify(target))
  const canonical = sanitizeBookmarkTarget(jsonCompatible)
  if (!canonical) throw new Error('Bookmark target is invalid.')
  return canonical
}

const storedParts = (
  target: BookmarkTarget
): {
  kind: 'text' | 'pdf-text' | 'pdf-region'
  sourceKind: string
  sourceId: string
  sourceJson: string
  selectorJson: string
  quote: string | null
} => {
  if (target.kind === 'text') {
    const sourceId =
      target.source.kind === 'agent-message'
        ? target.source.messageId
        : target.source.kind === 'session-item'
          ? target.source.itemId
          : (target.source.sourceFileId ?? target.source.path)
    return {
      kind: 'text',
      sourceKind: target.source.kind,
      sourceId,
      sourceJson: JSON.stringify({ version: 1, source: target.source }),
      selectorJson: JSON.stringify({ version: 1, selector: target.anchor ?? {} }),
      quote: target.quote
    }
  }
  return {
    kind: target.selector.kind === 'text' ? 'pdf-text' : 'pdf-region',
    sourceKind: target.source.kind,
    sourceId: target.source.sourceFileId,
    sourceJson: JSON.stringify({ version: 1, source: target.source }),
    selectorJson: JSON.stringify({ version: 1, selector: target.selector }),
    quote:
      target.selector.kind === 'text'
        ? target.selector.exact
        : target.selector.kind === 'region'
          ? (target.selector.text ?? null)
          : null
  }
}

const targetFromRow = (row: BookmarkRow): BookmarkTarget => {
  const storedSource: unknown = JSON.parse(row.sourceJson)
  const storedSelector: unknown = JSON.parse(row.selectorJson)
  if (
    typeof storedSource !== 'object' ||
    storedSource === null ||
    !('version' in storedSource) ||
    storedSource.version !== 1 ||
    !('source' in storedSource) ||
    typeof storedSelector !== 'object' ||
    storedSelector === null ||
    !('version' in storedSelector) ||
    storedSelector.version !== 1 ||
    !('selector' in storedSelector)
  ) {
    throw new Error(`Stored Bookmark envelope is invalid: ${row.id}`)
  }
  const source: unknown = storedSource.source
  const selector: unknown = storedSelector.selector
  const candidate: unknown =
    row.kind === 'text'
      ? {
          kind: 'text',
          source,
          quote: row.quote,
          ...(Object.keys(selector as object).length > 0 ? { anchor: selector } : {})
        }
      : { kind: 'pdf', source, selector }
  const target = sanitizeBookmarkTarget(candidate)
  if (!target) throw new Error(`Stored Bookmark target is invalid: ${row.id}`)
  const expected = storedParts(target)
  if (
    row.kind !== expected.kind ||
    row.sourceKind !== expected.sourceKind ||
    row.sourceId !== expected.sourceId ||
    row.quote !== expected.quote
  ) {
    throw new Error(`Stored Bookmark identity columns are inconsistent: ${row.id}`)
  }
  return target
}

const toBookmark = (row: BookmarkRow): Bookmark =>
  bookmarkSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    version: 1,
    target: targetFromRow(row),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })

const sameCreate = (row: BookmarkRow, request: CreateBookmarkRequest): boolean => {
  if (
    row.projectId !== request.projectId ||
    row.sessionId !== request.sessionId ||
    row.note !== request.note
  ) {
    return false
  }
  return isDeepStrictEqual(targetFromRow(row), canonicalTarget(request.target))
}

class BookmarkRepository {
  constructor(private readonly getClient: BookmarkClientProvider) {}

  async list(request: ListBookmarksRequest): Promise<BookmarkListResult> {
    const client = await this.getClient()
    const limit = request.limit ?? 50
    const scope = { projectId: request.projectId, sessionId: request.sessionId }
    const after = request.cursor
      ? {
          OR: [
            { createdAt: { gt: new Date(request.cursor.createdAt) } },
            { createdAt: new Date(request.cursor.createdAt), id: { gt: request.cursor.id } }
          ]
        }
      : {}
    const [rows, total] = await client.$transaction([
      client.bookmark.findMany({
        where: { ...scope, ...after },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1
      }),
      client.bookmark.count({ where: scope })
    ])
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).map(toBookmark)
    const last = hasMore ? page.at(-1) : undefined
    return {
      items: page,
      total,
      ...(last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {})
    }
  }

  async create(request: CreateBookmarkRequest): Promise<Bookmark> {
    const client = await this.getClient()
    const parts = storedParts(canonicalTarget(request.target))
    const existing = await client.bookmark.findUnique({ where: { id: request.id } })
    if (existing) return this.resolveCreateRetry(existing, request)
    try {
      return toBookmark(
        await client.bookmark.create({
          data: {
            id: request.id,
            projectId: request.projectId,
            sessionId: request.sessionId,
            ...parts,
            note: request.note
          }
        })
      )
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }
      const raced = await client.bookmark.findUnique({ where: { id: request.id } })
      if (!raced) throw error
      return this.resolveCreateRetry(raced, request)
    }
  }

  async recoverCreate(request: CreateBookmarkRequest): Promise<Bookmark | undefined> {
    const client = await this.getClient()
    const existing = await client.bookmark.findUnique({ where: { id: request.id } })
    return existing ? this.resolveCreateRetry(existing, request) : undefined
  }

  private resolveCreateRetry(row: BookmarkRow, request: CreateBookmarkRequest): Bookmark {
    if (!sameCreate(row, request)) {
      throw new Error('Bookmark identity already exists with different content.')
    }
    return toBookmark(row)
  }

  async updateNote(request: UpdateBookmarkNoteRequest): Promise<Bookmark> {
    const client = await this.getClient()
    const scope = { id: request.id, projectId: request.projectId, sessionId: request.sessionId }
    const updated = await client.bookmark.updateMany({ where: scope, data: { note: request.note } })
    if (updated.count === 0) throw new Error('Bookmark not found.')
    const row = await client.bookmark.findFirst({ where: scope })
    if (!row) throw new Error('Bookmark not found.')
    return toBookmark(row)
  }

  async delete(request: { id: string; projectId: string; sessionId: string }): Promise<boolean> {
    const client = await this.getClient()
    const deleted = await client.bookmark.deleteMany({ where: request })
    return deleted.count > 0
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    const client = await this.getClient()
    await client.bookmark.deleteMany({ where: { projectId, sessionId } })
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    const client = await this.getClient()
    await client.bookmark.deleteMany({ where: { sessionId: { in: [...new Set(sessionIds)] } } })
  }

  async deleteProject(projectId: string): Promise<void> {
    const client = await this.getClient()
    await client.bookmark.deleteMany({ where: { projectId } })
  }
}

export const readSessionBookmarkTargets = async (
  client: Pick<Prisma.TransactionClient, 'bookmark'>,
  source: { projectId: string; sessionId: string }
): Promise<BookmarkTarget[]> =>
  (await client.bookmark.findMany({ where: source })).map(targetFromRow)

// Fork stays inside this installation: private notes are copied transactionally, never added
// to an export package. The caller remaps only the target using the research copy's identity map.
export const copySessionBookmarks = async (
  client: Pick<Prisma.TransactionClient, 'bookmark'>,
  source: { projectId: string; sessionId: string },
  target: { projectId: string; sessionId: string },
  mapTarget: (target: BookmarkTarget) => BookmarkTarget
): Promise<void> => {
  const rows = await client.bookmark.findMany({
    where: source,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  })
  if (!rows.length) return
  await client.bookmark.createMany({
    data: rows.map((row) => ({
      id: randomUUID(),
      ...target,
      ...storedParts(canonicalTarget(mapTarget(targetFromRow(row)))),
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }))
  })
}

export { BookmarkRepository }
export type { BookmarkClient, BookmarkClientProvider }

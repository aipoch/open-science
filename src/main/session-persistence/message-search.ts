import {
  messageSearchRequestSchema,
  type MessageSearchItem,
  type MessageSearchPage,
  type MessageSearchRequest
} from '../../shared/message-search'
import {
  isHiddenControlMessage,
  type LoadSessionRequest,
  type PersistedChatSession,
  type SessionSummary
} from '../../shared/session-persistence'
import { findSearchMatches } from '../../shared/search-text'
import { z } from 'zod'

type SearchBackend = {
  list: () => Promise<{
    sessions: readonly SessionSummary[]
    diagnostics?: { isComplete: boolean; isProjectDeletionRecoveryComplete?: boolean }
  }>
  loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
}

const cursorSchema = z
  .object({
    queryKey: z.string(),
    rank: z.number().int().min(0).max(3),
    createdAt: z.number(),
    projectId: z.string(),
    sessionId: z.string(),
    messageId: z.string()
  })
  .strict()
type MessagePosition = Omit<z.infer<typeof cursorSchema>, 'queryKey'>
const comparePositions = (a: MessagePosition, b: MessagePosition): number =>
  b.rank - a.rank ||
  b.createdAt - a.createdAt ||
  a.projectId.localeCompare(b.projectId) ||
  a.sessionId.localeCompare(b.sessionId) ||
  a.messageId.localeCompare(b.messageId)
type SearchSnapshot = {
  items: MessageSearchItem[]
  ranks: Map<MessageSearchItem, number>
  isComplete: boolean
}
type ClientSearch = {
  query: string
  generation: number
  cache?: { key: string; generation: number; page: Promise<SearchSnapshot> }
}

export const createMessageSearch = (backend: SearchBackend) => {
  // Cancellation belongs to a search surface, not the shared main-process service. Callers without
  // a client identity have independent queries; bounded retention also releases closed windows.
  const clients = new Map<string, ClientSearch>()
  let scanning: Promise<unknown> = Promise.resolve()
  return async (input: MessageSearchRequest): Promise<MessageSearchPage> => {
    const request = messageSearchRequestSchema.parse(input)
    const queryKey = JSON.stringify([
      request.query.trim(),
      [...request.projectIds].sort(),
      [...(request.excludedSessionIds ?? [])].sort(),
      request.updatedAfter,
      request.role,
      request.sort
    ])
    const clientKey = request.clientId ? `client:${request.clientId}` : `query:${queryKey}`
    const client = clients.get(clientKey) ?? { query: '', generation: 0 }
    clients.delete(clientKey)
    clients.set(clientKey, client)
    if (clients.size > 32) clients.delete(clients.keys().next().value!)
    if (queryKey !== client.query) {
      client.query = queryKey
      client.generation++
    }
    const requestGeneration = client.generation
    const cursor = request.cursor
      ? cursorSchema.parse(JSON.parse(Buffer.from(request.cursor, 'base64url').toString()))
      : undefined
    if (cursor && cursor.queryKey !== queryKey)
      throw new Error('Message cursor does not match the requested search.')
    const projects = new Set(request.projectIds)
    const excluded = new Set(request.excludedSessionIds)
    const { sessions: all, diagnostics } = await backend.list()
    if (requestGeneration !== client.generation)
      return { items: [], totalCount: 0, isComplete: false }
    const catalogComplete =
      diagnostics?.isComplete !== false && diagnostics?.isProjectDeletionRecoveryComplete !== false
    const sessions = all
      .filter((s) => projects.has(s.projectId) && s.archivedAt === undefined && !excluded.has(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const key = JSON.stringify([
      request.query.trim(),
      catalogComplete,
      sessions.map((s) => [s.projectId, s.id, s.revision, s.updatedAt])
    ])
    if (client.cache?.key !== key || client.cache.generation !== requestGeneration) {
      const page = scanning
        .catch(() => undefined)
        .then(async () => {
          const items: MessageSearchItem[] = []
          const ranks = new Map<MessageSearchItem, number>()
          let isComplete = catalogComplete
          let next = 0
          await Promise.all(
            Array.from({ length: Math.min(4, sessions.length) }, async () => {
              while (next < sessions.length && requestGeneration === client.generation) {
                const summary = sessions[next++]!
                try {
                  const session = await backend.loadOne({
                    projectId: summary.projectId,
                    sessionId: summary.id
                  })
                  if (!session) {
                    isComplete = false
                    continue
                  }
                  if (session.archivedAt !== undefined) continue
                  const turnHits = new Map<string, { item: MessageSearchItem; rank: number }>()
                  for (const message of session.messages) {
                    if (isHiddenControlMessage(message) || !message.content?.trim()) continue
                    const createdAt = message.createdAt ?? summary.updatedAt
                    if (request.role && message.role !== request.role) continue
                    if (request.updatedAfter !== undefined && createdAt < request.updatedAfter)
                      continue
                    const matches = findSearchMatches(message.content, request.query, 3)
                    const hit = matches[0]
                    if (request.query.trim() && !hit) continue
                    // Only an explicit turn link can combine fragments. Keep the winning Message's
                    // identity and content together so previews still jump to the actual match.
                    const turnKey =
                      message.role === 'agent' && message.responseToMessageId
                        ? `turn:${message.responseToMessageId}`
                        : `message:${message.id}`
                    const previous = turnHits.get(turnKey)
                    const rank = matches.length
                    if (
                      previous &&
                      (previous.rank > rank ||
                        (previous.rank === rank && previous.item.createdAt > createdAt))
                    )
                      continue
                    const start = Math.max(0, (hit?.start ?? 0) - 4000)
                    const content = message.content.slice(
                      start,
                      Math.max(hit?.end ?? 0, start) + 4000
                    )
                    const item: MessageSearchItem = {
                      projectId: summary.projectId,
                      sessionId: summary.id,
                      sessionTitle: summary.title,
                      sessionNumber: summary.number,
                      messageId: message.id,
                      role: message.role,
                      title: message.content.trim().slice(0, 240).split(/\r?\n/, 1)[0],
                      content,
                      ...(content.length < message.content.length
                        ? { contentTruncated: true }
                        : {}),
                      createdAt
                    }
                    turnHits.set(turnKey, { item, rank })
                  }
                  for (const { item, rank } of turnHits.values()) {
                    items.push(item)
                    if (request.sort === 'relevance') ranks.set(item, rank)
                  }
                } catch {
                  isComplete = false
                }
              }
            })
          )
          items.sort((a, b) =>
            comparePositions({ ...a, rank: ranks.get(a) ?? 0 }, { ...b, rank: ranks.get(b) ?? 0 })
          )
          return {
            items,
            ranks,
            isComplete: isComplete && requestGeneration === client.generation
          }
        })
      scanning = page
      client.cache = { key, generation: requestGeneration, page }
    }
    const pending = client.cache
    const result = await pending.page
    if (!result.isComplete && client.cache === pending) client.cache = undefined
    // A deleted/reordered earlier hit must not shift the next page's starting position.
    const position = (item: MessageSearchItem): MessagePosition => ({
      rank: result.ranks.get(item) ?? 0,
      createdAt: item.createdAt,
      projectId: item.projectId,
      sessionId: item.sessionId,
      messageId: item.messageId
    })
    const remaining = cursor
      ? result.items.filter((item) => comparePositions(position(item), cursor) > 0)
      : result.items
    const items = remaining.slice(0, request.limit)
    const last = items.at(-1)
    return {
      items,
      totalCount: result.items.length,
      isComplete: result.isComplete,
      nextCursor:
        remaining.length > request.limit && last
          ? Buffer.from(JSON.stringify({ queryKey, ...position(last) })).toString('base64url')
          : undefined
    }
  }
}

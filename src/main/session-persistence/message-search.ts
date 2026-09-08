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

type SearchBackend = {
  list: () => Promise<{
    sessions: readonly SessionSummary[]
    diagnostics?: { isComplete: boolean; isProjectDeletionRecoveryComplete?: boolean }
  }>
  loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
}

export const createMessageSearch = (backend: SearchBackend) => {
  // Only retain the latest query. Summary revisions invalidate pages without hydrating transcripts
  // into the renderer; failed reads are retried instead of caching an incomplete snapshot.
  let cache:
    | { key: string; generation: number; page: Promise<Omit<MessageSearchPage, 'nextOffset'>> }
    | undefined
  let generation = 0
  let latestQuery = ''
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
    if (queryKey !== latestQuery) {
      latestQuery = queryKey
      generation++
    }
    const requestGeneration = generation
    const projects = new Set(request.projectIds)
    const excluded = new Set(request.excludedSessionIds)
    const { sessions: all, diagnostics } = await backend.list()
    if (requestGeneration !== generation) return { items: [], totalCount: 0, isComplete: false }
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
    if (cache?.key !== key || cache.generation !== requestGeneration) {
      const page = scanning
        .catch(() => undefined)
        .then(async () => {
          const items: MessageSearchItem[] = []
          const ranks = new Map<MessageSearchItem, number>()
          let isComplete = catalogComplete
          let next = 0
          await Promise.all(
            Array.from({ length: Math.min(4, sessions.length) }, async () => {
              while (next < sessions.length && requestGeneration === generation) {
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
                    const item: MessageSearchItem = {
                      projectId: summary.projectId,
                      sessionId: summary.id,
                      sessionTitle: summary.title,
                      sessionNumber: summary.number,
                      messageId: message.id,
                      role: message.role,
                      title: message.content.trim().slice(0, 240).split(/\r?\n/, 1)[0],
                      content: message.content.slice(start, Math.max(hit?.end ?? 0, start) + 4000),
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
          items.sort(
            (a, b) =>
              (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0) ||
              b.createdAt - a.createdAt ||
              a.projectId.localeCompare(b.projectId) ||
              a.sessionId.localeCompare(b.sessionId) ||
              a.messageId.localeCompare(b.messageId)
          )
          return {
            items,
            totalCount: items.length,
            isComplete: isComplete && requestGeneration === generation
          }
        })
      scanning = page
      cache = { key, generation: requestGeneration, page }
    }
    const pending = cache
    const result = await pending.page
    if (!result.isComplete && cache === pending) cache = undefined
    const offset = request.offset ?? 0
    return {
      ...result,
      items: result.items.slice(offset, offset + request.limit),
      nextOffset: offset + request.limit < result.totalCount ? offset + request.limit : undefined
    }
  }
}

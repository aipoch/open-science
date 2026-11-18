import { z } from 'zod'
import type { PersistedChatSession } from './session-persistence'

// A display page contains complete messages/tool records, not a complete save authority.
export const SESSION_HISTORY_PAGE_SIZE = 80
export const SESSION_HISTORY_CURSOR_STALE = 'SESSION_HISTORY_CURSOR_STALE'

export const loadSessionHistoryPageRequestSchema = z
  .object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    beforeCursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(200).optional()
  })
  .strict()

export type LoadSessionHistoryPageRequest = z.infer<typeof loadSessionHistoryPageRequestSchema>

export type SessionHistoryPage = {
  projectId: string
  sessionId: string
  revision: number
  // Display scope survives the later upgrade to complete authority without copying the graph.
  messageBranchId?: string
  // Only a complete response contains all branches and may become save authority.
  // hasMore=false alone means the last display page, not a complete conversation.
  complete?: true
  session: PersistedChatSession
  hasMore: boolean
  beforeCursor?: string
  totalItems: number
}

export class SessionHistoryCursorStaleError extends Error {
  readonly code = SESSION_HISTORY_CURSOR_STALE

  constructor() {
    super(`${SESSION_HISTORY_CURSOR_STALE}: Session history changed. Reload its first page.`)
    this.name = 'SessionHistoryCursorStaleError'
  }
}

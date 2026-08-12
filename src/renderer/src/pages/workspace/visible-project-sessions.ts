import type { ChatSession } from '@/stores/session-store'

// Only sessions belonging to the active project are visible in this workspace.
const visibleProjectSessions = (sessions: ChatSession[], projectId: string): ChatSession[] =>
  sessions.filter((session) => session.projectId === projectId && session.archivedAt === undefined)

// Shared empty list so selectors that have nothing visible stay referentially stable.
const NO_VISIBLE_SESSIONS: ChatSession[] = []

export { NO_VISIBLE_SESSIONS, visibleProjectSessions }

export const SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL = 'sessions:flush-request'
export const SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL = 'sessions:flush-response'
export const SESSION_PERSISTENCE_FLUSH_ABORTED_CHANNEL = 'sessions:flush-aborted'

export type SessionPersistenceFlushRequest = {
  requestId: string
  // Web events are replayed to every connected renderer; this transient identity scopes handoffs
  // to the tab that issued the data-root command. Electron's window-specific IPC omits it.
  targetLifecycleClientId?: string
}
export type SessionPersistenceFlushStatus = 'completed' | 'conflict' | 'failed'
export type SessionPersistenceFlushAbortReason = 'conflict' | 'renderer-failed'
export type SessionPersistenceFlushAbortedEvent = {
  reason: SessionPersistenceFlushAbortReason
}
export type SessionPersistenceFlushResponse = {
  requestId: string
  status: SessionPersistenceFlushStatus
}

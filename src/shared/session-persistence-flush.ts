export const SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL = 'sessions:flush-request'
export const SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL = 'sessions:flush-response'

export type SessionPersistenceFlushRequest = { requestId: string }
export type SessionPersistenceFlushResponse = { requestId: string }

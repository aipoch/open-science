import { checkState } from './session-state'
import type { AgentCheckpoint, AgentStore } from './session-types'

/** Isolated process-local CAS store. Share the returned instance to reopen or fork sessions.
 * No disk writes, global registry, or recovery across process exits. */
export function createMemoryAgentStore(): AgentStore {
  const rows = new Map<string, AgentCheckpoint>()
  return {
    async load(sessionId) {
      return structuredClone(rows.get(sessionId))
    },
    async commit(sessionId, expectedRevision, next) {
      if ((rows.get(sessionId)?.revision ?? null) !== expectedRevision) return false
      checkState(next, sessionId)
      if (next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1))
        throw new Error('Invalid checkpoint revision')
      // No await between comparison and replacement: competing calls cannot both succeed.
      rows.set(sessionId, structuredClone(next))
      return true
    }
  }
}

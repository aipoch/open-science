import type { ApplicationEvent } from './application-events'
import { RUNTIME_PAYLOAD_INLINE_BYTES } from '../shared/runtime-payload-transfer'
import type { SessionInvalidation } from '../shared/session-event-hydrator'

export function projectSessionEventPayload(event: { channel: string; payload: unknown }): unknown {
  if (event.channel !== 'session:created' && event.channel !== 'session:updated')
    return event.payload
  const { session, originClientId } = (
    event as Extract<ApplicationEvent, { channel: 'session:updated' }>
  ).payload
  if (Buffer.byteLength(JSON.stringify(event.payload)) <= RUNTIME_PAYLOAD_INLINE_BYTES)
    return event.payload
  return {
    kind: 'session-invalidation',
    projectId: session.projectId,
    sessionId: session.id,
    revision: session.revision ?? 0,
    originClientId
  } satisfies SessionInvalidation
}

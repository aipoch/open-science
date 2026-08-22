import type { AgentFrameworkId } from '../../shared/settings'
import type { AcpConnectionCapabilities } from './connection-resource-owner'

// Host compatibility layer for mid-turn Send now.
//
// Claude Agent ACP and Codex ACP advertise unofficial `_session/steering` and inject
// into the live prompt. OpenCode ACP never advertises that method. ACP `session/prompt`
// drives the v1 SessionPrompt loop. HTTP POST `/api/session/{id}/prompt` with
// `delivery: "steer"` only admits to the v2 inbox (`admittedSeq`) and never appears
// in v1 `/session/{id}/message`, so the live ACP turn cannot see it. Persist into that
// v1 session with POST `/session/{id}/message` `{ parts, noReply: true }` instead —
// `noReply` skips Runner.ensureRunning so the HTTP abort cannot cancel the ACP turn.
// Overlapping `session/prompt` is not a Send now path: it is queue-and-handoff
// (Claude 0.60), admit-and-join-runner (OpenCode), or replace-and-interrupt
// (Codex ACP 1.1.4). This layer never opens a second prompt interaction.

export const ACP_STEERING_METHOD = '_session/steering'
export const STEERING_IDLE_BEHAVIOR = 'promptRequired' as const
export const OPENCODE_HTTP_FOLLOW_UP_NO_REPLY = true as const
export const OPENCODE_HTTP_STEER_TIMEOUT_MS = 8_000

export type NativeFollowUpTransport = 'acp-steering' | 'opencode-http'

export type NativeFollowUpRefuseReason =
  | 'empty-text'
  | 'attachments'
  | 'no-live-turn'
  | 'not-advertised'
  | 'started-new-turn'
  | 'prompt-required'
  | 'unrecognized-success'
  | 'missing-outcome'
  | 'unknown-outcome'
  | 'dispatch-failed'

export type NativeFollowUpRoute =
  | Readonly<{ transport: NativeFollowUpTransport }>
  | Readonly<{ transport: 'unsupported'; reason: NativeFollowUpRefuseReason }>

export type SteeringAdvertisement = Readonly<{
  supported: boolean
}>

export type SteerOutcome =
  | Readonly<{ kind: 'injected' }>
  | Readonly<{ kind: 'started-new-turn' }>
  | Readonly<{ kind: 'prompt-required'; reason: string }>
  | Readonly<{
      kind: 'rejected'
      reason: 'unrecognized-success' | 'missing-outcome' | 'unknown-outcome'
      raw: unknown
    }>

export type NativeFollowUpDispatchResult =
  | Readonly<{ kind: 'injected'; transport: NativeFollowUpTransport }>
  | Readonly<{ kind: 'refused'; reason: NativeFollowUpRefuseReason }>

export type AcpSteeringParams = Readonly<{
  sessionId: string
  prompt: ReadonlyArray<{ type: 'text'; text: string }>
  _meta: Readonly<{
    steering: Readonly<{ idleBehavior: typeof STEERING_IDLE_BEHAVIOR }>
  }>
}>

export type OpenCodeHttpFollowUpBody = Readonly<{
  parts: ReadonlyArray<{ type: 'text'; text: string }>
  noReply: typeof OPENCODE_HTTP_FOLLOW_UP_NO_REPLY
}>

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const steeringRecord = (value: unknown): Record<string, unknown> | undefined =>
  recordValue(recordValue(value)?.steering)

const isSteeringSupported = (value: unknown): boolean => {
  const steering = steeringRecord(value)
  if (!steering) return false
  if (steering.supported === true) return true
  return Array.isArray(steering.modes) && steering.modes.includes('steer')
}

// Claude Agent ACP advertises on the top-level initialize `_meta`. Other adapters
// may nest the same flag under `agentCapabilities._meta`. Either location counts.
export const readSteeringAdvertisement = (initialize: unknown): SteeringAdvertisement => {
  const record = recordValue(initialize)
  const supported =
    isSteeringSupported(record?._meta) ||
    isSteeringSupported(recordValue(record?.agentCapabilities)?._meta)
  return Object.freeze({ supported })
}

export const retainInitializeCapabilities = (initialize: unknown): AcpConnectionCapabilities => {
  const record = recordValue(initialize)
  const sessionCapabilities = recordValue(
    recordValue(record?.agentCapabilities)?.sessionCapabilities
  )
  return Object.freeze({
    close: Boolean(sessionCapabilities?.close),
    delete: Boolean(sessionCapabilities?.delete),
    resume: Boolean(sessionCapabilities?.resume),
    steering: readSteeringAdvertisement(initialize).supported
  })
}

export const resolveNativeFollowUpRoute = (input: {
  advertisedSteering: boolean
  hasLivePrompt: boolean
  frameworkId: AgentFrameworkId
  hasOpenCodeHttp: boolean
  text: string
  hasAttachments?: boolean
}): NativeFollowUpRoute => {
  if (input.hasAttachments) {
    return Object.freeze({ transport: 'unsupported', reason: 'attachments' })
  }
  if (!input.text.trim()) {
    return Object.freeze({ transport: 'unsupported', reason: 'empty-text' })
  }
  if (!input.hasLivePrompt) {
    return Object.freeze({ transport: 'unsupported', reason: 'no-live-turn' })
  }
  if (input.advertisedSteering) {
    return Object.freeze({ transport: 'acp-steering' })
  }
  if (input.frameworkId === 'opencode' && input.hasOpenCodeHttp) {
    return Object.freeze({ transport: 'opencode-http' })
  }
  return Object.freeze({ transport: 'unsupported', reason: 'not-advertised' })
}

export const buildAcpSteeringParams = (sessionId: string, text: string): AcpSteeringParams =>
  Object.freeze({
    sessionId,
    prompt: Object.freeze([{ type: 'text' as const, text }]),
    _meta: Object.freeze({
      steering: Object.freeze({ idleBehavior: STEERING_IDLE_BEHAVIOR })
    })
  })

export const buildOpenCodeHttpFollowUpBody = (text: string): OpenCodeHttpFollowUpBody =>
  Object.freeze({
    parts: Object.freeze([{ type: 'text' as const, text }]),
    noReply: OPENCODE_HTTP_FOLLOW_UP_NO_REPLY
  })

export const openCodeHttpFollowUpPath = (sessionId: string): string =>
  `/session/${encodeURIComponent(sessionId)}/message`

const followUpRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = recordValue(value)
  if (!record) return undefined
  if (recordValue(record.info)) return record
  return recordValue(record.data) ?? record
}

export const parseOpenCodeHttpFollowUp = (result: unknown, text: string): boolean => {
  const record = followUpRecord(result)
  if (!record) return false
  const info = recordValue(record.info)
  if (info?.role !== 'user') return false
  const parts = record.parts
  if (!Array.isArray(parts)) return false
  return parts.some((part) => {
    const item = recordValue(part)
    return item?.type === 'text' && item.text === text
  })
}

// Some adapters answer unknown extension methods with `{}` instead of method-not-found.
// Treating that as injected would drop the user's message. Empty and outcome-less
// objects are therefore rejected. Idle `startedNewTurn` is a detached adapter turn
// the host does not own.
export const parseSteerOutcome = (result: unknown): SteerOutcome => {
  const record = recordValue(result)
  if (!record) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'missing-outcome' as const,
      raw: result
    })
  }

  const keys = Object.keys(record)
  if (keys.length === 0) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'unrecognized-success' as const,
      raw: result
    })
  }

  const outcome = record.outcome
  if (outcome === 'injected') return Object.freeze({ kind: 'injected' as const })
  if (outcome === 'startedNewTurn') return Object.freeze({ kind: 'started-new-turn' as const })
  if (outcome === 'promptRequired') {
    const reason =
      typeof record.reason === 'string' && record.reason.trim() ? record.reason : 'noRunningTurn'
    return Object.freeze({ kind: 'prompt-required' as const, reason })
  }
  if (typeof outcome !== 'string') {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'missing-outcome' as const,
      raw: result
    })
  }
  return Object.freeze({
    kind: 'rejected' as const,
    reason: 'unknown-outcome' as const,
    raw: result
  })
}

export const interpretSteerOutcome = (outcome: SteerOutcome): NativeFollowUpDispatchResult => {
  if (outcome.kind === 'injected') {
    return Object.freeze({ kind: 'injected', transport: 'acp-steering' })
  }
  if (outcome.kind === 'started-new-turn') {
    return Object.freeze({ kind: 'refused', reason: 'started-new-turn' })
  }
  if (outcome.kind === 'prompt-required') {
    return Object.freeze({ kind: 'refused', reason: 'prompt-required' })
  }
  return Object.freeze({ kind: 'refused', reason: outcome.reason })
}

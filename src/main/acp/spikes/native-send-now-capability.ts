import type { AgentFrameworkId } from '../../../shared/settings'
import type { AgentModelRoute } from '../../agent-framework/types'

// Spike: native mid-turn Send now without `session/cancel`.
//
// ACP v1 has no `session/inject`. The only standard mid-turn lever is
// `session/cancel` plus a fresh `session/prompt`. Frameworks expose two unofficial
// substitutes:
//   - `_session/steering` when advertised on initialize `_meta`
//   - a second in-flight `session/prompt` that some adapters queue themselves
// This module is the fail-closed decoder for those substitutes. Production Send now
// still interrupts; nothing here is wired into the prompt turn workflow.

export const ACP_STEERING_METHOD = '_session/steering'

export const SHIPPED_CLAUDE_AGENT_ACP_VERSION = '0.60.0'
export const SHIPPED_CODEX_ACP_VERSION = '1.1.4'

// Host still rejects a second `session/prompt` while an interaction is active.
// Native queued-prompt therefore cannot be dispatched until that guard is lifted.
export const HOST_CONCURRENT_PROMPT_POLICY = 'reject' as const

export type NativeSendNowKind = 'steering-extension' | 'queued-prompt' | 'none'

export type NativeSendNowDelivery = 'safe-breakpoint' | 'next-model-pause' | 'unavailable'

export type NativeSendNowCapability = Readonly<{
  kind: NativeSendNowKind
  delivery: NativeSendNowDelivery
  method?: typeof ACP_STEERING_METHOD
  hostCanDispatch: boolean
}>

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

export type SteerRequest = Readonly<{
  sessionId: string
  prompt: unknown[]
}>

export type NativeSendNowLookup = Readonly<{
  frameworkId: AgentFrameworkId
  route?: AgentModelRoute
  advertisement?: SteeringAdvertisement
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

export const buildSteerRequest = (sessionId: string, prompt: unknown[]): SteerRequest =>
  Object.freeze({ sessionId, prompt })

// Some adapters answer unknown extension methods with `{}` instead of method-not-found.
// Treating that as injected would drop the user's message. Empty and outcome-less
// objects are therefore rejected.
export const parseSteerOutcome = (result: unknown): SteerOutcome => {
  const record = recordValue(result)
  if (!record) {
    return Object.freeze({ kind: 'rejected', reason: 'missing-outcome', raw: result })
  }

  const keys = Object.keys(record)
  if (keys.length === 0) {
    return Object.freeze({ kind: 'rejected', reason: 'unrecognized-success', raw: result })
  }

  const outcome = record.outcome
  if (outcome === 'injected') return Object.freeze({ kind: 'injected' })
  if (outcome === 'startedNewTurn') return Object.freeze({ kind: 'started-new-turn' })
  if (outcome === 'promptRequired') {
    const reason =
      typeof record.reason === 'string' && record.reason.trim() ? record.reason : 'noRunningTurn'
    return Object.freeze({ kind: 'prompt-required', reason })
  }
  if (typeof outcome !== 'string') {
    return Object.freeze({ kind: 'rejected', reason: 'missing-outcome', raw: result })
  }
  return Object.freeze({ kind: 'rejected', reason: 'unknown-outcome', raw: result })
}

const cannotDispatch = (
  kind: NativeSendNowKind,
  delivery: NativeSendNowDelivery,
  method?: typeof ACP_STEERING_METHOD
): NativeSendNowCapability =>
  Object.freeze({
    kind,
    delivery,
    ...(method ? { method } : {}),
    hostCanDispatch: false
  })

const advertisedSteering = (): NativeSendNowCapability =>
  Object.freeze({
    kind: 'steering-extension',
    delivery: 'safe-breakpoint',
    method: ACP_STEERING_METHOD,
    // The host still owns one prompt interaction at a time. Steering is a side-band
    // and is not dispatchable until that owner grows an inject path.
    hostCanDispatch: false
  })

// Advertisement always wins. Without it, only the shipped Claude adapter is known to
// queue a second `session/prompt`. Codex `turn/steer` and OpenCode pending-steer stay
// off ACP unless they advertise. Codex-response and Codex-bridge share that adapter.
export const resolveShippedNativeSendNowCapability = (
  lookup: NativeSendNowLookup
): NativeSendNowCapability => {
  if (lookup.advertisement?.supported) return advertisedSteering()

  if (lookup.frameworkId === 'claude-code') {
    return cannotDispatch('queued-prompt', 'next-model-pause')
  }

  return cannotDispatch('none', 'unavailable')
}

export type { AgentFrameworkId, AgentModelRoute }

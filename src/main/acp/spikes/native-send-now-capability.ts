import type { AgentFrameworkId } from '../../../shared/settings'
import type { AgentModelRoute } from '../../agent-framework/types'

// Spike: native mid-turn Send now without `session/cancel`.
//
// The "already running" throw is project-defined. ACP v1 does not forbid a second
// `session/prompt` while one is outstanding. Lifting that throw is still not enough:
// the host stores one interaction per session, stamps every session/update with
// `current()`, and drains a single `ActiveSession.nextUpdate()` consumer.
// Production Send now still interrupts; nothing here is wired into the prompt turn.

export const ACP_STEERING_METHOD = '_session/steering'

export const SHIPPED_CLAUDE_AGENT_ACP_VERSION = '0.60.0'
export const SHIPPED_CODEX_ACP_VERSION = '1.1.4'

// Production policy. A second `session/prompt` is rejected before it reaches the agent.
export const HOST_CONCURRENT_PROMPT_POLICY = 'reject' as const

export const PRODUCTION_HOST_FOLLOW_UP_BLOCKERS = Object.freeze([
  'single-interaction',
  'single-update-consumer',
  'single-executor-observation'
] as const)

export type NativeSendNowKind = 'steering-extension' | 'queued-prompt' | 'none'

export type NativeSendNowDelivery = 'safe-breakpoint' | 'next-model-pause' | 'unavailable'

export type HostFollowUpBlocker =
  | (typeof PRODUCTION_HOST_FOLLOW_UP_BLOCKERS)[number]
  | 'no-steering-side-band'
  | 'framework-unsupported'

export type NativeSendNowCapability = Readonly<{
  kind: NativeSendNowKind
  delivery: NativeSendNowDelivery
  method?: typeof ACP_STEERING_METHOD
  frameworkCanDispatch: boolean
  hostCanDispatch: boolean
  usesSecondSessionPrompt: boolean
  hostBlockers: readonly HostFollowUpBlocker[]
}>

export type SecondSessionPromptAdmission =
  | Readonly<{ allowed: true; mode: 'queued-prompt-adopt-after-stop' }>
  | Readonly<{
      allowed: false
      reason: 'framework-unsupported' | 'wrong-mechanism' | 'host-not-ready'
      hostBlockers: readonly HostFollowUpBlocker[]
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

const withHostBlockers = (
  capability: Omit<NativeSendNowCapability, 'hostCanDispatch' | 'hostBlockers'>,
  hostBlockers: readonly HostFollowUpBlocker[]
): NativeSendNowCapability =>
  Object.freeze({
    ...capability,
    hostCanDispatch: false,
    hostBlockers
  })

const advertisedSteering = (): NativeSendNowCapability =>
  withHostBlockers(
    {
      kind: 'steering-extension',
      delivery: 'safe-breakpoint',
      method: ACP_STEERING_METHOD,
      frameworkCanDispatch: true,
      usesSecondSessionPrompt: false
    },
    ['no-steering-side-band']
  )

// Advertisement always wins. Without it, only the shipped Claude adapter is known to
// queue a second `session/prompt`. Codex-response and Codex-bridge share one adapter.
export const resolveShippedNativeSendNowCapability = (
  lookup: NativeSendNowLookup
): NativeSendNowCapability => {
  if (lookup.advertisement?.supported) return advertisedSteering()

  if (lookup.frameworkId === 'claude-code') {
    return withHostBlockers(
      {
        kind: 'queued-prompt',
        delivery: 'next-model-pause',
        frameworkCanDispatch: true,
        usesSecondSessionPrompt: true
      },
      PRODUCTION_HOST_FOLLOW_UP_BLOCKERS
    )
  }

  return withHostBlockers(
    {
      kind: 'none',
      delivery: 'unavailable',
      frameworkCanDispatch: false,
      usesSecondSessionPrompt: false
    },
    ['framework-unsupported']
  )
}

// A second `session/prompt` is the Claude queued-prompt mechanism. Steering uses a
// different method and must not lift the prompt interaction lock.
export const admitSecondSessionPrompt = (
  capability: NativeSendNowCapability
): SecondSessionPromptAdmission => {
  if (capability.kind === 'steering-extension') {
    return Object.freeze({
      allowed: false,
      reason: 'wrong-mechanism',
      hostBlockers: capability.hostBlockers
    })
  }
  if (!capability.usesSecondSessionPrompt || !capability.frameworkCanDispatch) {
    return Object.freeze({
      allowed: false,
      reason: 'framework-unsupported',
      hostBlockers: capability.hostBlockers
    })
  }
  if (capability.hostBlockers.length > 0) {
    return Object.freeze({
      allowed: false,
      reason: 'host-not-ready',
      hostBlockers: capability.hostBlockers
    })
  }
  return Object.freeze({ allowed: true, mode: 'queued-prompt-adopt-after-stop' })
}

export type { AgentFrameworkId, AgentModelRoute }

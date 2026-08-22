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
export const SHIPPED_OPENCODE_VERSION = '1.18.3'

// Steering first appears in these adapters. Idle `promptRequired` is later
// (Claude 0.70.0). Host dispatch still refuses `startedNewTurn`.
export const FIRST_CLAUDE_STEERING_ACP_VERSION = '0.61.0'
export const FIRST_CODEX_STEERING_ACP_VERSION = '1.2.0'

// Latest adapters inspected 2026-08-22. Claude 0.70.0 and Codex 1.6.2 advertise
// `_session/steering` and inject into the live turn. OpenCode ACP still has no
// `_session/steering`; the same process exposes HTTP POST
// `/api/session/{id}/prompt` with `delivery: "steer" | "queue"`.
export const LATEST_CLAUDE_AGENT_ACP_VERSION = '0.70.0'
export const LATEST_CODEX_ACP_VERSION = '1.6.2'
export const LATEST_OPENCODE_VERSION = '1.18.3'

// Live ACP probe 2026-08-22 against isolated latest adapters. Codex 1.6.2 was
// spawned with the shipped native CLI 0.144.6. OpenCode used local 1.18.3.
export const LIVE_LATEST_IDLE_STEER = Object.freeze({
  claude: Object.freeze({ kind: 'prompt-required', reason: 'noRunningTurn' }),
  codex: Object.freeze({ kind: 'started-new-turn' }),
  opencode: Object.freeze({ kind: 'method-not-found' })
})

export const LIVE_LATEST_INJECT_STEER = Object.freeze({
  claude: Object.freeze({ kind: 'injected' }),
  codex: Object.freeze({ kind: 'injected' })
})

// Production policy. A second `session/prompt` is rejected before it reaches the agent.
export const HOST_CONCURRENT_PROMPT_POLICY = 'reject' as const

export const PRODUCTION_HOST_FOLLOW_UP_BLOCKERS = Object.freeze([
  'single-interaction',
  'single-update-consumer',
  'single-executor-observation'
] as const)

export type NativeSendNowKind = 'steering-extension' | 'queued-prompt' | 'none'

export type NativeSendNowDelivery = 'safe-breakpoint' | 'next-model-pause' | 'unavailable'

// What a second outstanding `session/prompt` does in the shipped ACP adapter.
// Native CLI steer/queue is a different surface and is not this field.
export type OverlappingSessionPromptBehavior =
  'queue-and-handoff' | 'admit-and-join-runner' | 'replace-and-interrupt' | 'none'

export type HostFollowUpBlocker =
  | (typeof PRODUCTION_HOST_FOLLOW_UP_BLOCKERS)[number]
  | 'no-steering-side-band'
  | 'framework-unsupported'
  | 'admit-and-join-runner'
  | 'replace-and-interrupt'

export type NativeSendNowCapability = Readonly<{
  kind: NativeSendNowKind
  delivery: NativeSendNowDelivery
  method?: typeof ACP_STEERING_METHOD
  overlappingPrompt: OverlappingSessionPromptBehavior
  // Native CLI/TUI mid-turn input (Codex turn/steer, OpenCode session.steer / busy queue).
  nativeCliHasMidTurnInput: boolean
  // Shipped ACP adapter accepts a second `session/prompt` while one is outstanding.
  // Acceptance is not the same as Send now without interrupt.
  frameworkCanDispatch: boolean
  hostCanDispatch: boolean
  usesSecondSessionPrompt: boolean
  hostBlockers: readonly HostFollowUpBlocker[]
}>

export type SecondSessionPromptAdmission =
  | Readonly<{ allowed: true; mode: 'queued-prompt-adopt-after-stop' }>
  | Readonly<{
      allowed: false
      reason:
        | 'framework-unsupported'
        | 'wrong-mechanism'
        | 'host-not-ready'
        | 'admit-and-join-runner'
        | 'replace-and-interrupt'
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
      overlappingPrompt: 'none',
      nativeCliHasMidTurnInput: true,
      frameworkCanDispatch: true,
      usesSecondSessionPrompt: false
    },
    ['no-steering-side-band']
  )

// Advertisement always wins. Without it, overlapping `session/prompt` is the only
// ACP lever. Claude 0.60.0 queues and hands off. OpenCode 1.18.3 persists the
// user then joins the running loop. Codex ACP 1.1.4 overwrites the tracked
// prompt and interrupts the previous turn. Codex-response and Codex-bridge
// share that adapter.
export const resolveShippedNativeSendNowCapability = (
  lookup: NativeSendNowLookup
): NativeSendNowCapability => {
  if (lookup.advertisement?.supported) return advertisedSteering()

  if (lookup.frameworkId === 'claude-code') {
    return withHostBlockers(
      {
        kind: 'queued-prompt',
        delivery: 'next-model-pause',
        overlappingPrompt: 'queue-and-handoff',
        nativeCliHasMidTurnInput: true,
        frameworkCanDispatch: true,
        usesSecondSessionPrompt: true
      },
      PRODUCTION_HOST_FOLLOW_UP_BLOCKERS
    )
  }

  if (lookup.frameworkId === 'opencode') {
    return withHostBlockers(
      {
        kind: 'none',
        delivery: 'unavailable',
        overlappingPrompt: 'admit-and-join-runner',
        nativeCliHasMidTurnInput: true,
        // ACP overlapping prompt is not Send now. HTTP `delivery: steer` on the
        // same `opencode acp --port` process is the native side-band.
        frameworkCanDispatch: true,
        usesSecondSessionPrompt: false
      },
      ['admit-and-join-runner']
    )
  }

  return withHostBlockers(
    {
      kind: 'none',
      delivery: 'unavailable',
      overlappingPrompt: 'replace-and-interrupt',
      nativeCliHasMidTurnInput: true,
      frameworkCanDispatch: true,
      usesSecondSessionPrompt: false
    },
    ['replace-and-interrupt']
  )
}

// A second `session/prompt` is only Claude queued-prompt. Steering is a side-band.
// OpenCode join and Codex replace both accept the RPC; neither is Send now
// without interrupt, so an empty host-blocker list still must not admit them.
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
  if (capability.overlappingPrompt === 'replace-and-interrupt') {
    return Object.freeze({
      allowed: false,
      reason: 'replace-and-interrupt',
      hostBlockers: capability.hostBlockers
    })
  }
  if (capability.overlappingPrompt === 'admit-and-join-runner') {
    return Object.freeze({
      allowed: false,
      reason: 'admit-and-join-runner',
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

// What the host would see after upgrading adapters, without a live initialize.
// Latest Claude and Codex always advertise steering. OpenCode still does not.
export const resolveLatestNativeSendNowCapability = (
  lookup: NativeSendNowLookup
): NativeSendNowCapability => {
  if (lookup.advertisement) return resolveShippedNativeSendNowCapability(lookup)
  if (lookup.frameworkId === 'opencode') return resolveShippedNativeSendNowCapability(lookup)
  return advertisedSteering()
}

export type { AgentFrameworkId, AgentModelRoute }

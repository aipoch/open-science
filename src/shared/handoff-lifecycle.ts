// Read-only handoff lifecycle contract shared by the coordinator boundary and renderer.
//
// This is intentionally a projection contract: it lets the renderer describe an already-authorized
// handoff, but exposes no operation that can start, retry, cancel, or otherwise affect execution.

export type HandoffLifecyclePhase =
  | 'awaiting-approval'
  | 'switching'
  | 'reconfiguring'
  | 'continuation-start'
  | 'continued'
  | 'failed'

export type HandoffTarget = { kind: 'main' } | { kind: 'specialist'; name: string }

// The continuation retains the original user-turn identity. Attachment and artifact ids are the
// only renderer-safe provenance references; raw completion envelopes, transcript text, credentials,
// and connector arguments never cross this boundary.
export type HandoffTurnProvenance = {
  originatingTurnId: string
  originatingUserMessageId: string
  attachmentIds: string[]
  artifactIds: string[]
}

// A sanitized renderer summary. `outcome` preserves whether the captured outer tool completed
// normally or threw, without exposing its value/error to broadcasts.
export type HandoffContinuationSummary = {
  outcome: 'returned' | 'threw'
  switchReadback: { target: HandoffTarget }
}

export type HandoffCapturedCompletion =
  { kind: 'returned'; value: unknown } | { kind: 'threw'; error: unknown }

// App-owned continuation input. This remains in main/runtime and is never placed on the renderer
// lifecycle channel. Framework adapters receive it after reconfiguration succeeds.
export type HandoffContinuationContext = {
  sessionId: string
  originatingTurnId: string
  originatingUserMessageId: string
  toolInvocationId: string
  target: HandoffTarget
  completion: HandoffCapturedCompletion
  switchReadback: { target: HandoffTarget }
  attachmentIds: string[]
  artifactIds: string[]
}

export type HandoffApprovalContext = Omit<
  HandoffContinuationContext,
  'completion' | 'switchReadback'
> & {
  // The app-owned control invocation identity is required before a pending approval can become a
  // durable handoff record. Sandbox code never supplies these values.
  turnId: string
  controlInvocationGeneration: number
}

export type HandoffLifecycleFailure = {
  retryFrom: 'switching' | 'reconfiguring' | 'continuation-start'
  message: string
}

export type HandoffLifecycleEvent = {
  id: string
  sessionId: string
  // Monotonic only within the coordinator's handoff for this originating turn. Renderers may miss a
  // broadcast, but must never regress their read-only projection when a delayed event arrives.
  sequence: number
  observedAt: number
  phase: HandoffLifecyclePhase
  target: HandoffTarget
  provenance: HandoffTurnProvenance
  continuation?: HandoffContinuationSummary
  failure?: HandoffLifecycleFailure
}

export type HandoffLifecycleChange =
  | { kind: 'upsert'; event: HandoffLifecycleEvent }
  | { kind: 'remove'; sessionId: string; eventIds: string[] }

export type HandoffRetryRequest = {
  sessionId: string
  originatingTurnId: string
}

export type HandoffEventsRequest = { sessionId: string }

export const HANDOFF_LIFECYCLE_IPC = {
  LIST: 'handoff-lifecycle:list',
  RETRY: 'handoff-lifecycle:retry',
  CHANGED: 'handoff-lifecycle:changed'
} as const

// Public renderer seam. The source is a one-way stream plus a current snapshot; it deliberately has
// no command methods, so missing or delayed events can never change coordinator execution authority.
export type HandoffLifecycleEventSource = {
  getEvents(sessionId: string): readonly HandoffLifecycleEvent[]
  subscribe(listener: () => void): () => void
  load?(sessionId: string): Promise<void>
}

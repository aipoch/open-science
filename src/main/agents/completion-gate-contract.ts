// The application-owned completion boundary for an approved host.agents.switch().
//
// The control-plane REPL is allowed to finish the JavaScript that follows `await switch()`, but its
// outer tool result must be claimed here before an ACP prompt can receive it. A renderer broadcast is
// intentionally not involved: this coordinator chooses the delivery disposition synchronously and
// preserves the captured envelope until the runtime has explicitly released old-prompt ownership.
import type {
  ApprovedSwitchReadback,
  TrustedControlInvocationIdentity
} from '../../shared/agents-contract'
import type {
  HandoffCapturedCompletion,
  HandoffContinuationContext,
  HandoffLifecycleFailure,
  HandoffLifecyclePhase
} from '../../shared/handoff-lifecycle'

export type TrustedToolCompletionContext = TrustedControlInvocationIdentity & {
  // These identifiers are supplied by the application tool runner, not sandbox JavaScript. The
  // current tracer route has a trusted session id; later framework adapters thread turn/tool ids too.
  sessionId: string
  originatingTurnId?: string
  originatingUserMessageId?: string
  attachmentIds?: string[]
  artifactIds?: string[]
}

export type ToolCompletionEnvelope = HandoffCapturedCompletion

export type ApprovedCompletionHandoffTarget = {
  targetName: string | null
  approvedSpecialistId?: string
  approvedSpecialistRevision?: number
}

export type CompletionDisposition =
  | { kind: 'deliver-to-current-prompt'; envelope: ToolCompletionEnvelope }
  | {
      kind: 'capture-for-handoff'
      envelope: ToolCompletionEnvelope
      targetName: string | null
      generation: number
      continuationContext?: HandoffContinuationContext
      approvedSpecialistId?: string
      approvedSpecialistRevision?: number
      switchReadback?: ApprovedSwitchReadback
      handoffGeneration?: number
    }

// Safe-to-publish coordination telemetry. It deliberately carries only trusted correlation metadata,
// a public target identifier, and a coarse lifecycle failure classification. Completion envelopes,
// sandbox payloads, credentials, transcripts, connector arguments, and raw error values never cross
// this boundary.
export type CompletionGateLifecycleEvent = TrustedControlInvocationIdentity & {
  order: number
  kind:
    | 'approval-committed'
    | 'completion-captured'
    | 'ownership-released'
    | 'reconfigured'
    | 'continuation-started'
    | 'handoff-superseded'
    | 'handoff-failed'
  sessionId: string
  handoffGeneration: number
  targetName: string | null
  failureStage?: 'stop-old-prompt' | 'ownership-release' | 'reconfigure' | 'continuation'
}

export type CompletionGateLifecycleListener = (event: CompletionGateLifecycleEvent) => void

export type CompletionGateRuntime = {
  // Framework adapters may opt out for sessions they do not own. This keeps the shared gate
  // fail-safe while adapters arrive independently: an unsupported framework keeps the established
  // next-message behavior instead of capturing a completion it cannot continue.
  canHandle?(context: TrustedToolCompletionContext): boolean
  // A composed registry may host adapters for more than one framework. The coordinator asks this
  // synchronously while the approved SwitchNotifier is still on the trusted control-tool stack, so an
  // unsupported session keeps the established completion path rather than being captured halfway.
  canCapture?(context: TrustedToolCompletionContext): boolean
  // Requests old-prompt stop. This alone is NOT evidence that runtime ownership was released.
  stopOldPrompt(context: TrustedToolCompletionContext): Promise<void>
  // Resolves only on the runtime's explicit in-flight ownership/lease-release acknowledgement.
  waitForOwnershipRelease(context: TrustedToolCompletionContext): Promise<void>
  // Release adapter-owned handoff context after explicit cancellation without publishing failure.
  cleanupCancelledHandoff?(context: TrustedToolCompletionContext): Promise<void>
  reconfigure(
    handoff:
      | Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>
      | ApprovedCompletionHandoffTarget,
    context: TrustedToolCompletionContext,
    // Synchronous attempt authority; wrappers must check after their final await before entry.
    isCurrentAttempt?: () => boolean
  ): Promise<void>
  continueAsApproved(
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext,
    continuationContext?: HandoffContinuationContext
  ): Promise<void>
  // A claimed completion is already owned by the handoff. Lifecycle failures must be reported on
  // that new ownership path, never rethrown into the legacy repl_execute transport.
  reportHandoffFailure(
    error: unknown,
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext
  ): Promise<void>
}

export type CompletionGateLifecycle = {
  onCaptured(context: HandoffContinuationContext): void
  onPhase(context: HandoffContinuationContext, phase: HandoffLifecyclePhase): void
  onFailed(
    context: HandoffContinuationContext,
    retryFrom: HandoffLifecycleFailure['retryFrom']
  ): void
}

// The application-owned completion boundary for an approved host.agents.switch().
//
// The control-plane REPL is allowed to finish the JavaScript that follows `await switch()`, but its
// outer tool result must be claimed here before an ACP prompt can receive it. A renderer broadcast is
// intentionally not involved: this coordinator chooses the delivery disposition synchronously and
// preserves the captured envelope until the runtime has explicitly released old-prompt ownership.

import type {
  ApprovedSwitchReadback,
  PendingSwitch,
  SwitchNotifier,
  TrustedControlInvocationIdentity
} from '../../shared/agents-contract'
import type { CompletionHandoffLifecycle } from './completion-handoff-lifecycle'
import type {
  HandoffCapturedCompletion,
  HandoffContinuationContext,
  HandoffLifecycleFailure,
  HandoffLifecyclePhase,
  HandoffTarget
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

export const completionContextKey = (context: TrustedToolCompletionContext): string =>
  `${context.sessionId}\u0000${context.turnId}\u0000${context.controlInvocationGeneration}\u0000${context.toolInvocationId}`

export const completionHandoffKey = completionContextKey

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
  reconfigure(
    handoff:
      | Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>
      | ApprovedCompletionHandoffTarget,
    context: TrustedToolCompletionContext
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

// Production startup installs this registry even before a framework-specific runtime can satisfy the
// full handoff contract. An unregistered registry is deliberately fail-safe: switches still follow
// the established next-message path, but no outer completion is captured halfway through a handoff.
export class CompletionGateRuntimeRegistry implements CompletionGateRuntime {
  private readonly runtimes: CompletionGateRuntime[] = []

  register(runtime: CompletionGateRuntime): void {
    this.runtimes.push(runtime)
  }

  isRegistered(): boolean {
    return this.runtimes.length > 0
  }

  canCapture(context: TrustedToolCompletionContext): boolean {
    return this.runtimeFor(context) !== undefined
  }

  async stopOldPrompt(context: TrustedToolCompletionContext): Promise<void> {
    return this.requireRuntime(context).stopOldPrompt(context)
  }

  async waitForOwnershipRelease(context: TrustedToolCompletionContext): Promise<void> {
    return this.requireRuntime(context).waitForOwnershipRelease(context)
  }

  async reconfigure(
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    return this.requireRuntime(context).reconfigure(handoff, context)
  }

  async continueAsApproved(
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext,
    continuationContext?: HandoffContinuationContext
  ): Promise<void> {
    return this.requireRuntime(context).continueAsApproved(handoff, context, continuationContext)
  }

  async reportHandoffFailure(
    error: unknown,
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    return this.requireRuntime(context).reportHandoffFailure(error, handoff, context)
  }

  private runtimeFor(context: TrustedToolCompletionContext): CompletionGateRuntime | undefined {
    return (
      this.runtimes.find(
        (runtime) => runtime.canCapture?.(context) === true || runtime.canHandle?.(context) === true
      ) ?? this.runtimes.find((runtime) => !runtime.canCapture && !runtime.canHandle)
    )
  }

  private requireRuntime(context: TrustedToolCompletionContext): CompletionGateRuntime {
    const runtime = this.runtimeFor(context)
    if (!runtime) throw new Error('Completion handoff runtime is not registered for this session.')
    return runtime
  }
}

type ArmedHandoff = {
  target: HandoffTarget
  generation: number
  handoffGeneration: number
  switchReadback?: ApprovedSwitchReadback
}

export type CompletionGateLifecycle = {
  onCaptured(context: HandoffContinuationContext): void
  onPhase(context: HandoffContinuationContext, phase: HandoffLifecyclePhase): void
  onFailed(
    context: HandoffContinuationContext,
    retryFrom: HandoffLifecycleFailure['retryFrom']
  ): void
}

// Session-scoped gate authority. It deliberately exposes completion disposition rather than private
// lifecycle maps: the tool runner only needs one atomic answer before it decides whether the old prompt
// may receive a completed envelope.
export class CompletionGateCoordinator {
  private readonly armedBySession = new Map<string, ArmedHandoff>()
  private readonly armedKeysBySession = new Map<string, Set<string>>()
  private readonly newestHandoffGenerationBySession = new Map<string, number>()
  private readonly lifecycleListeners = new Set<CompletionGateLifecycleListener>()
  private nextHandoffGeneration = 0
  private nextLifecycleOrder = 0

  constructor(
    private readonly runtime: CompletionGateRuntime,
    private readonly lifecycle?: CompletionGateLifecycle | CompletionHandoffLifecycle
  ) {}

  subscribeLifecycle(listener: CompletionGateLifecycleListener): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  releaseSession(sessionId: string): void {
    const keys = this.armedKeysBySession.get(sessionId)
    if (keys) {
      for (const key of keys) this.armedBySession.delete(key)
    }
    this.armedKeysBySession.delete(sessionId)
    this.newestHandoffGenerationBySession.delete(sessionId)
  }

  // Called from the approved SwitchNotifier path. It is synchronous, so the gate is installed while
  // SwitchOperation is still awaiting notifier.notify(), before agentsCall can return to JavaScript.
  arm(
    context: TrustedToolCompletionContext,
    requestedTarget: string | null | HandoffTarget,
    switchReadback?: ApprovedSwitchReadback
  ): Promise<void> | void {
    if (
      this.runtime instanceof CompletionGateRuntimeRegistry &&
      (!this.runtime.isRegistered() || !this.runtime.canCapture(context))
    ) {
      return
    }
    if (
      !(this.runtime instanceof CompletionGateRuntimeRegistry) &&
      ((this.runtime.canCapture !== undefined && !this.runtime.canCapture(context)) ||
        (this.runtime.canHandle !== undefined && !this.runtime.canHandle(context)))
    ) {
      return
    }
    this.nextHandoffGeneration += 1
    const target =
      requestedTarget !== null && typeof requestedTarget === 'object'
        ? requestedTarget
        : requestedTarget === null
          ? { kind: 'main' as const }
          : { kind: 'specialist' as const, name: requestedTarget }
    const handoff: ArmedHandoff = {
      target,
      generation: this.nextHandoffGeneration,
      handoffGeneration: this.nextHandoffGeneration,
      ...(switchReadback ? { switchReadback } : {})
    }
    const key = this.keyFor(context)
    this.armedBySession.set(key, handoff)
    const sessionKeys = this.armedKeysBySession.get(context.sessionId) ?? new Set<string>()
    sessionKeys.add(key)
    this.armedKeysBySession.set(context.sessionId, sessionKeys)
    this.newestHandoffGenerationBySession.set(context.sessionId, handoff.handoffGeneration)
    this.emitLifecycle('approval-committed', context, {
      handoffGeneration: handoff.handoffGeneration ?? 0,
      targetName: target.kind === 'specialist' ? target.name : null
    })
    if (this.lifecycle && 'approve' in this.lifecycle) {
      return this.lifecycle
        .approve({
          context,
          targetName: target.kind === 'specialist' ? target.name : null,
          generation: handoff.generation,
          provenance: {
            originatingUserMessageId: context.originatingUserMessageId,
            attachmentIds: context.attachmentIds ?? [],
            artifactIds: context.artifactIds ?? []
          },
          ...(switchReadback ? { continuation: { outcome: 'pending', switchReadback } } : {})
        })
        .then(() => undefined)
        .catch((error: unknown) => {
          this.armedBySession.delete(key)
          const pendingKeys = this.armedKeysBySession.get(context.sessionId)
          pendingKeys?.delete(key)
          if (pendingKeys?.size === 0) this.armedKeysBySession.delete(context.sessionId)
          if (
            this.newestHandoffGenerationBySession.get(context.sessionId) ===
            handoff.handoffGeneration
          ) {
            this.newestHandoffGenerationBySession.delete(context.sessionId)
          }
          throw error
        })
    }
  }

  // Atomically consumes the current session's newest approval. Once this returns capture, no caller can
  // obtain a later deliver disposition for the same envelope, even if stopping/reconfiguration awaits.
  claimCompletion(
    context: TrustedToolCompletionContext,
    envelope: ToolCompletionEnvelope
  ): CompletionDisposition {
    const key = this.keyFor(context)
    const armed = this.armedBySession.get(key)
    if (!armed) return { kind: 'deliver-to-current-prompt', envelope }

    this.armedBySession.delete(key)
    const sessionKeys = this.armedKeysBySession.get(context.sessionId)
    sessionKeys?.delete(key)
    if (sessionKeys?.size === 0) this.armedKeysBySession.delete(context.sessionId)
    const originatingTurnId = context.originatingTurnId ?? context.turnId
    const continuationContext: HandoffContinuationContext = {
      sessionId: context.sessionId,
      originatingTurnId,
      originatingUserMessageId: context.originatingUserMessageId ?? originatingTurnId,
      toolInvocationId: context.toolInvocationId,
      target: armed.target,
      completion: envelope,
      switchReadback: { target: armed.target },
      attachmentIds: context.attachmentIds ?? [],
      artifactIds: context.artifactIds ?? []
    }
    const disposition: CompletionDisposition = {
      kind: 'capture-for-handoff',
      envelope,
      targetName: armed.target.kind === 'specialist' ? armed.target.name : null,
      generation: armed.generation,
      handoffGeneration: armed.handoffGeneration,
      continuationContext,
      ...(armed.switchReadback ? { switchReadback: armed.switchReadback } : {})
    }
    if (this.lifecycle && 'onCaptured' in this.lifecycle)
      this.lifecycle.onCaptured(continuationContext)
    this.emitLifecycle('completion-captured', context, disposition)
    return disposition
  }

  private keyFor(context: TrustedToolCompletionContext): string {
    return completionHandoffKey(context)
  }
  // Completes the captured handoff. Reconfiguration cannot begin until the old runtime explicitly
  // acknowledges ownership release; cancellation/stop timing is never used as a substitute.
  async complete(
    disposition: CompletionDisposition,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    if (disposition.kind === 'deliver-to-current-prompt') return

    let retryFrom: HandoffLifecycleFailure['retryFrom'] = 'switching'
    if (this.lifecycle && 'capture' in this.lifecycle) {
      try {
        await this.lifecycle.capture(context, disposition.envelope)
        if (this.isSuperseded(context, disposition)) {
          await this.lifecycle.cancel(context)
          this.emitLifecycle('handoff-superseded', context, disposition)
          return
        }
        await this.lifecycle.run(context)
      } catch (error) {
        await this.runtime.reportHandoffFailure(error, disposition, context).catch(() => undefined)
      } finally {
        this.clearCurrentHandoffGeneration(context, disposition)
      }
      return
    }
    try {
      await this.runtime.stopOldPrompt(context)
      await this.runtime.waitForOwnershipRelease(context)
      this.emitLifecycle('ownership-released', context, disposition)
      if (this.isSuperseded(context, disposition)) {
        this.emitLifecycle('handoff-superseded', context, disposition)
        return
      }
      retryFrom = 'reconfiguring'
      if (this.lifecycle && 'onPhase' in this.lifecycle && disposition.continuationContext)
        this.lifecycle.onPhase(disposition.continuationContext, 'reconfiguring')
      await this.runtime.reconfigure(disposition, context)
      this.emitLifecycle('reconfigured', context, disposition)
      retryFrom = 'continuation-start'
      if (this.lifecycle && 'onPhase' in this.lifecycle && disposition.continuationContext)
        this.lifecycle.onPhase(disposition.continuationContext, 'continuation-start')
      await this.runtime.continueAsApproved(disposition, context, disposition.continuationContext)
      this.emitLifecycle('continuation-started', context, disposition)
      if (this.lifecycle && 'onPhase' in this.lifecycle && disposition.continuationContext)
        this.lifecycle.onPhase(disposition.continuationContext, 'continued')
    } catch (error) {
      if (this.lifecycle && 'onFailed' in this.lifecycle && disposition.continuationContext)
        this.lifecycle.onFailed(disposition.continuationContext, retryFrom)
      try {
        await this.runtime.reportHandoffFailure(error, disposition, context)
      } catch {
        // A failure reporter is itself new-ownership work. Never reopen the old completion route.
      }
      this.emitLifecycle(
        'handoff-failed',
        context,
        disposition,
        retryFrom === 'switching'
          ? 'stop-old-prompt'
          : retryFrom === 'reconfiguring'
            ? 'reconfigure'
            : 'continuation'
      )
    } finally {
      this.clearCurrentHandoffGeneration(context, disposition)
    }
  }

  private isSuperseded(
    context: TrustedToolCompletionContext,
    disposition: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>
  ): boolean {
    return (
      this.newestHandoffGenerationBySession.get(context.sessionId) !== disposition.handoffGeneration
    )
  }

  private clearCurrentHandoffGeneration(
    context: TrustedToolCompletionContext,
    disposition: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>
  ): void {
    if (!this.isSuperseded(context, disposition)) {
      this.newestHandoffGenerationBySession.delete(context.sessionId)
    }
  }

  private emitLifecycle(
    kind: CompletionGateLifecycleEvent['kind'],
    context: TrustedToolCompletionContext,
    handoff: Pick<
      Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
      'handoffGeneration' | 'targetName'
    >,
    failureStage?: CompletionGateLifecycleEvent['failureStage']
  ): void {
    const event: CompletionGateLifecycleEvent = {
      order: ++this.nextLifecycleOrder,
      kind,
      sessionId: context.sessionId,
      turnId: context.turnId,
      controlInvocationGeneration: context.controlInvocationGeneration,
      toolInvocationId: context.toolInvocationId,
      handoffGeneration: handoff.handoffGeneration ?? 0,
      targetName: handoff.targetName,
      ...(failureStage ? { failureStage } : {})
    }
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event)
      } catch {
        // Lifecycle diagnostics are observational and must not interfere with trusted routing.
      }
    }
  }
}

// Adapts the existing SwitchNotifier seam to this coordinator. The optional downstream notification
// preserves the pre-existing renderer compatibility broadcast, but it cannot affect the gate's
// authority or timing: arm() executes first and synchronously.
export const createCompletionGateSwitchNotifier = (
  coordinator: CompletionGateCoordinator,
  downstream?: SwitchNotifier
): SwitchNotifier => {
  const notify = async (
    pending: PendingSwitch,
    switchReadback?: ApprovedSwitchReadback
  ): Promise<void> => {
    if (
      pending.turnId &&
      pending.controlInvocationGeneration !== undefined &&
      pending.toolInvocationId
    ) {
      await coordinator.arm(
        {
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          controlInvocationGeneration: pending.controlInvocationGeneration,
          toolInvocationId: pending.toolInvocationId,
          originatingTurnId: pending.originatingTurnId,
          originatingUserMessageId: pending.originatingUserMessageId,
          attachmentIds: pending.attachmentIds,
          artifactIds: pending.artifactIds
        },
        pending.targetName,
        switchReadback
      )
    }
    try {
      await downstream?.notify(pending)
    } catch {
      // Renderer notification is a best-effort projection. Gate persistence above is authoritative.
    }
  }
  return {
    authority: 'completion-gate',
    notify,
    notifyApproved: notify
  }
}

export type CompletionGatedToolOptions<T> = {
  coordinator: CompletionGateCoordinator
  context: TrustedToolCompletionContext
  execute(): Promise<T>
  // The sole route to the old prompt's tool-result callback. It is invoked only after a synchronous
  // `deliver-to-current-prompt` decision, never while a captured handoff is in progress.
  deliverToCurrentPrompt(envelope: ToolCompletionEnvelope): Promise<void>
}

// The narrow interface an application-side tool runner implements to intercept a completed control
// invocation before it returns through its legacy prompt/RPC callback. It intentionally does not name
// ACP, Codex, or a provider: issues 02–04 provide those concrete continuation adapters.
export type CompletionGatedControlToolInterceptor = {
  intercept<T>(options: {
    context: TrustedToolCompletionContext
    execute(): Promise<T>
  }): Promise<{ kind: 'deliver'; result: T } | { kind: 'captured' }>
}

// Minimal framework-independent application-side tool-runner interceptor. It owns the full outer
// completion envelope (normal value OR thrown error), claims it before any old-prompt callback, then
// either delivers it exactly once or starts the app-owned approved continuation.
export const runCompletionGatedTool = async <T>(
  options: CompletionGatedToolOptions<T>
): Promise<CompletionDisposition> => {
  let envelope: ToolCompletionEnvelope
  try {
    envelope = { kind: 'returned', value: await options.execute() }
  } catch (error) {
    envelope = { kind: 'threw', error }
  }

  const disposition = options.coordinator.claimCompletion(options.context, envelope)
  if (disposition.kind === 'deliver-to-current-prompt') {
    await options.deliverToCurrentPrompt(disposition.envelope)
  } else {
    await options.coordinator.complete(disposition, options.context)
  }
  return disposition
}

// Converts the public envelope-level gate into the framework-independent shape consumed by the
// Notebook control tool runner. A captured result deliberately has no value: returning the REPL
// outcome here would hand it back to the old prompt after the handoff was approved.
export const createCompletionGatedControlToolInterceptor = (
  coordinator: CompletionGateCoordinator,
  deliverToCurrentPrompt: (envelope: ToolCompletionEnvelope) => Promise<void>
): CompletionGatedControlToolInterceptor => ({
  intercept: async <T>({
    context,
    execute
  }: {
    context: TrustedToolCompletionContext
    execute(): Promise<T>
  }): Promise<{ kind: 'deliver'; result: T } | { kind: 'captured' }> => {
    const disposition = await runCompletionGatedTool({
      coordinator,
      context,
      execute,
      deliverToCurrentPrompt
    })
    if (disposition.kind === 'capture-for-handoff') return { kind: 'captured' }

    if (disposition.envelope.kind === 'threw') throw disposition.envelope.error
    return { kind: 'deliver', result: disposition.envelope.value as T }
  }
})

// OpenCode's immediate-handoff adapter. The shared completion coordinator owns the outer-tool
// disposition and lifecycle ordering; this module owns only the runtime projection needed once that
// coordinator has captured an OpenCode completion.

import type {
  CompletionDisposition,
  CompletionGateRuntime,
  TrustedToolCompletionContext
} from '../agents/completion-gate'
import type { AcpPromptRequest } from '../../shared/acp'
import type { AcpRuntimeCoordinator } from './runtime-coordinator'

export type OpenCodePromptContinuation = {
  prompt: AcpPromptRequest
  originatingTurnToken: string
  targetName: string | null
  completion: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>['envelope']
}

export type OpenCodeHandoffFailure = {
  sessionId: string
  turnId: string
  toolInvocationId: string
  generation: number
  targetName: string | null
  failedPhase: 'stop-or-reconfigure' | 'continuation-startup'
  errorMessage: string
  completion: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>['envelope']
  continuation?: OpenCodePromptContinuation
}

const MAX_RETAINED_HANDOFF_FAILURES = 100

// The latest failed handoff for each session stays owned by the main process until retry/cancel work
// explicitly clears it. Issue 06 can layer durable retry orchestration over this narrow source
// without recovering the envelope from logs, renderer state, or the stopped provider.
export class OpenCodeHandoffFailureStore {
  private readonly failuresBySession = new Map<string, OpenCodeHandoffFailure>()

  record(failure: OpenCodeHandoffFailure): void {
    // Refresh insertion order for a session's newest failure, then cap retained sensitive context.
    this.failuresBySession.delete(failure.sessionId)
    this.failuresBySession.set(failure.sessionId, failure)
    while (this.failuresBySession.size > MAX_RETAINED_HANDOFF_FAILURES) {
      const oldestSessionId = this.failuresBySession.keys().next().value
      if (oldestSessionId === undefined) break
      this.failuresBySession.delete(oldestSessionId)
    }
  }

  get(sessionId: string): OpenCodeHandoffFailure | undefined {
    return this.failuresBySession.get(sessionId)
  }

  list(): OpenCodeHandoffFailure[] {
    return [...this.failuresBySession.values()]
  }

  clear(sessionId: string): void {
    this.failuresBySession.delete(sessionId)
  }

  clearAll(): void {
    this.failuresBySession.clear()
  }
}

export type OpenCodeCapturedPrompt = {
  prompt: AcpPromptRequest
  originatingTurnToken: string
}

type OpenCodeImmediateHandoffDeps = {
  isOpenCodeSession(sessionId: string): boolean
  // Returns the original app-owned user prompt while its old provider request is still active.
  captureCurrentPrompt(sessionId: string): OpenCodeCapturedPrompt | undefined
  stopOldPrompt(sessionId: string): Promise<void>
  waitForOwnershipRelease(sessionId: string): Promise<void>
  resolveSpecialistId(sessionId: string): Promise<string | undefined>
  // Applies the complete projection to the live runtime before its next provider request.
  applySpecialistProjection(sessionId: string, specialistId: string | undefined): Promise<void>
  continueOriginalTurn(request: OpenCodePromptContinuation): Promise<void>
  reportHandoffFailure(failure: OpenCodeHandoffFailure): Promise<void>
}

type OpenCodeImmediateHandoffRuntimeOptions = {
  runtime: Pick<
    AcpRuntimeCoordinator,
    | 'getSessionFramework'
    | 'capturePromptForHandoff'
    | 'cancelPrompt'
    | 'waitForPromptOwnershipRelease'
    | 'switchSpecialist'
    | 'startContinuation'
  >
  resolveSpecialistId(sessionId: string): string | undefined
  reportHandoffFailure(failure: OpenCodeHandoffFailure): Promise<void>
}

type CapturedContinuation = {
  prompt: AcpPromptRequest
  originatingTurnToken: string
  reconfigured: boolean
}

const keyFor = (context: TrustedToolCompletionContext): string =>
  `${context.sessionId}\u0000${context.turnId}\u0000${context.toolInvocationId}`

export class OpenCodeImmediateHandoffRuntime implements CompletionGateRuntime {
  private readonly capturedByInvocation = new Map<string, CapturedContinuation>()

  constructor(private readonly deps: OpenCodeImmediateHandoffDeps) {}

  canHandle(context: TrustedToolCompletionContext): boolean {
    return this.deps.isOpenCodeSession(context.sessionId)
  }

  async stopOldPrompt(context: TrustedToolCompletionContext): Promise<void> {
    const prompt = this.deps.captureCurrentPrompt(context.sessionId)
    if (!prompt) throw new Error('The originating OpenCode prompt is unavailable for handoff.')

    this.capturedByInvocation.set(keyFor(context), {
      // The completion envelope is assigned in continueAsApproved after the shared coordinator has
      // atomically claimed it. The originating user-turn request is already app-owned before the old
      // prompt is cancelled, preserving attachments and provenance for the automatic continuation.
      prompt: prompt.prompt,
      originatingTurnToken: prompt.originatingTurnToken,
      reconfigured: false
    })
    await this.deps.stopOldPrompt(context.sessionId)
  }

  async waitForOwnershipRelease(context: TrustedToolCompletionContext): Promise<void> {
    await this.deps.waitForOwnershipRelease(context.sessionId)
  }

  async reconfigure(
    _handoff: Pick<Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>, 'targetName'>,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    const captured = this.requireCaptured(context)
    const specialistId = await this.deps.resolveSpecialistId(context.sessionId)
    await this.deps.applySpecialistProjection(context.sessionId, specialistId)
    captured.reconfigured = true
  }

  async continueAsApproved(
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    const key = keyFor(context)
    const captured = this.requireCaptured(context)
    if (!captured.reconfigured)
      throw new Error('OpenCode Specialist projection was not reconfigured.')

    await this.deps.continueOriginalTurn({
      prompt: captured.prompt,
      originatingTurnToken: captured.originatingTurnToken,
      targetName: handoff.targetName,
      completion: handoff.envelope
    })
    this.capturedByInvocation.delete(key)
  }

  async reportHandoffFailure(
    error: unknown,
    handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    const captured = this.capturedByInvocation.get(keyFor(context))
    await this.deps.reportHandoffFailure({
      ...context,
      generation: handoff.generation,
      targetName: handoff.targetName,
      failedPhase: captured?.reconfigured ? 'continuation-startup' : 'stop-or-reconfigure',
      errorMessage: error instanceof Error ? error.message : String(error),
      completion: handoff.envelope,
      ...(captured
        ? {
            continuation: {
              prompt: captured.prompt,
              originatingTurnToken: captured.originatingTurnToken,
              targetName: handoff.targetName,
              completion: handoff.envelope
            }
          }
        : {})
    })
  }

  private requireCaptured(context: TrustedToolCompletionContext): CapturedContinuation {
    const captured = this.capturedByInvocation.get(keyFor(context))
    if (!captured) throw new Error('The captured OpenCode completion is unavailable.')
    return captured
  }
}

// Production composition kept beside the adapter so tests exercise the same continuation envelope,
// ownership, and provider-acceptance wiring used by the application startup path.
export const createOpenCodeImmediateHandoffRuntime = (
  options: OpenCodeImmediateHandoffRuntimeOptions
): OpenCodeImmediateHandoffRuntime =>
  new OpenCodeImmediateHandoffRuntime({
    isOpenCodeSession: (sessionId) => options.runtime.getSessionFramework(sessionId) === 'opencode',
    captureCurrentPrompt: (sessionId) => options.runtime.capturePromptForHandoff(sessionId),
    stopOldPrompt: async (sessionId) => {
      await options.runtime.cancelPrompt({ sessionId })
    },
    waitForOwnershipRelease: (sessionId) =>
      options.runtime.waitForPromptOwnershipRelease(sessionId),
    resolveSpecialistId: async (sessionId) => options.resolveSpecialistId(sessionId),
    applySpecialistProjection: async (sessionId, specialistId) => {
      await options.runtime.switchSpecialist(sessionId, specialistId)
    },
    continueOriginalTurn: async ({ prompt, originatingTurnToken, targetName, completion }) => {
      await options.runtime.startContinuation({
        ...prompt,
        continuation: {
          kind: 'specialist-handoff',
          originatingTurnToken,
          targetName,
          completion:
            completion.kind === 'returned'
              ? completion
              : {
                  kind: 'threw',
                  errorMessage:
                    completion.error instanceof Error
                      ? completion.error.message
                      : String(completion.error)
                }
        }
      })
    },
    reportHandoffFailure: options.reportHandoffFailure
  })

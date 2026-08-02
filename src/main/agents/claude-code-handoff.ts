import type { AcpPromptRequest } from '../../shared/acp'
import type {
  CompletionDisposition,
  CompletionGateRuntime,
  CompletionGateRuntimeRegistry,
  ToolCompletionEnvelope,
  TrustedToolCompletionContext
} from './completion-gate'
import { completionContextKey } from './completion-gate'
import type { SwitchBindingReadBack } from './switch-operation'

type CapturedHandoff = Extract<CompletionDisposition, { kind: 'capture-for-handoff' }>

export type ClaudeCodeContinuationInput = {
  sessionId: string
  switchReadBack: ApprovedSwitchReadBack
}

export type ApprovedSwitchReadBack = {
  status: 'approved'
  operation: 'switch'
  binding: SwitchBindingReadBack
}

export type HandoffUserTask = {
  messageId: string
  text: string
}

export type ClaudeCodeReplayInput = ClaudeCodeContinuationInput & {
  capturedCompletion: ToolCompletionEnvelope
  supportedTaskContext?: ReadonlyArray<HandoffUserTask>
}

export const selectPersistedUserTaskContext = (
  messages: ReadonlyArray<{ id: string; role: string; content: string; status?: string }>
): HandoffUserTask[] =>
  messages.flatMap((message) => {
    const text = message.content.trim()
    return message.role === 'user' && message.status !== 'error' && text
      ? [{ messageId: message.id, text }]
      : []
  })

// The adapter deliberately depends on the application's ACP-facing operations instead of Claude's
// private session state. This keeps the completion coordinator framework-neutral while preserving the
// one Claude-specific fact: identity is baked into session/new, so reconfiguration must replace the
// session before replay can create the continuation prompt.
export type ClaudeCodeCompletionGateDependencies = {
  sessionFramework(sessionId: string): string | undefined
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
  waitForPromptOwnershipRelease(sessionId: string): Promise<void>
  resolveSpecialistId(sessionId: string): string | undefined
  resolveSwitchReadBack(
    sessionId: string,
    targetName: string | null
  ): Promise<ApprovedSwitchReadBack>
  prepareReplayContext(input: ClaudeCodeReplayInput): Promise<void>
  discardReplayContext(sessionId: string): Promise<void>
  switchSpecialist(
    sessionId: string,
    specialistId: string | undefined
  ): Promise<{ contextReset: boolean }>
  createContinuationRequest(input: ClaudeCodeContinuationInput): Promise<AcpPromptRequest>
  // A captured handoff continuation is application-owned rather than a fresh user turn. It must
  // bypass the user-prompt admission guard while its own lifecycle is in `continuation-start`.
  sendAppContinuation(request: AcpPromptRequest): Promise<unknown>
  reportHandoffFailure?(
    error: unknown,
    handoff: CapturedHandoff,
    context: TrustedToolCompletionContext
  ): Promise<void>
}

export class ClaudeCodeCompletionGateRuntime implements CompletionGateRuntime {
  private readonly switchReadBacks = new Map<string, ApprovedSwitchReadBack>()

  constructor(private readonly dependencies: ClaudeCodeCompletionGateDependencies) {}

  canCapture(context: TrustedToolCompletionContext): boolean {
    return this.dependencies.sessionFramework(context.sessionId) === 'claude-code'
  }

  async stopOldPrompt(context: TrustedToolCompletionContext): Promise<void> {
    await this.dependencies.cancelPrompt({ sessionId: context.sessionId })
  }

  async waitForOwnershipRelease(context: TrustedToolCompletionContext): Promise<void> {
    await this.dependencies.waitForPromptOwnershipRelease(context.sessionId)
  }

  async reconfigure(
    handoff: CapturedHandoff,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    const specialistId = this.dependencies.resolveSpecialistId(context.sessionId)
    const switchReadBack = await this.dependencies.resolveSwitchReadBack(
      context.sessionId,
      handoff.targetName
    )
    if (
      switchReadBack.binding.sessionId !== context.sessionId ||
      switchReadBack.binding.specialistId !== specialistId ||
      switchReadBack.binding.targetName !== handoff.targetName
    ) {
      throw new Error('Claude Code handoff read-back does not match the approved binding.')
    }
    await this.dependencies.prepareReplayContext({
      sessionId: context.sessionId,
      capturedCompletion: handoff.envelope,
      switchReadBack
    })
    this.switchReadBacks.set(completionContextKey(context), switchReadBack)
    const replacement = await this.dependencies.switchSpecialist(context.sessionId, specialistId)
    if (!replacement.contextReset) {
      throw new Error('Claude Code handoff did not replace the agent session.')
    }
    // targetName is intentionally not resolved here: the durable UUID binding is the runtime authority.
    void handoff
  }

  async continueAsApproved(
    handoff: CapturedHandoff,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    const key = completionContextKey(context)
    const switchReadBack = this.switchReadBacks.get(key)
    if (!switchReadBack) throw new Error('Claude Code handoff read-back is unavailable.')
    const request = await this.dependencies.createContinuationRequest({
      sessionId: context.sessionId,
      switchReadBack
    })
    try {
      await this.dependencies.sendAppContinuation(request)
    } finally {
      this.switchReadBacks.delete(key)
    }
    void handoff
  }

  async reportHandoffFailure(
    error: unknown,
    handoff: CapturedHandoff,
    context: TrustedToolCompletionContext
  ): Promise<void> {
    this.switchReadBacks.delete(completionContextKey(context))
    await this.dependencies.discardReplayContext(context.sessionId)
    await this.dependencies.reportHandoffFailure?.(error, handoff, context)
  }
}

export const createClaudeCodeCompletionGateRuntime = (
  dependencies: ClaudeCodeCompletionGateDependencies
): ClaudeCodeCompletionGateRuntime => new ClaudeCodeCompletionGateRuntime(dependencies)

// Production composition calls this small registration seam after the ACP coordinator is available.
// It appends rather than replaces a handler, so framework adapters can coexist in one public gate.
export const registerClaudeCodeCompletionGateRuntime = (
  registry: CompletionGateRuntimeRegistry,
  dependencies: ClaudeCodeCompletionGateDependencies
): ClaudeCodeCompletionGateRuntime => {
  const runtime = createClaudeCodeCompletionGateRuntime(dependencies)
  registry.register(runtime)
  return runtime
}

type ToolFailureObservation = Readonly<{
  interactionSequence: number
  reason?: string
  sessionId: string
  tool?: string
  toolCallId?: string
}>

type SessionFailureState = {
  interactionSequence: number
  callIdsByTool: Map<string, Set<string>>
  stoppedTools: Set<string>
}

const isMcpInputValidationFailure = (reason: string | undefined): boolean =>
  reason === 'MCP input validation failed.' ||
  (reason?.includes('MCP error -32602') === true &&
    reason.includes('Input validation error: Invalid arguments for tool'))

// Keeps malformed model output from turning into an unbounded tool loop. The first validation
// failure remains visible to the model so it can correct its arguments; the repeated failure trips
// once for the active prompt and lets Runtime cancel that prompt through the normal ACP lifecycle.
class RepeatedToolFailureGuard {
  private readonly failuresBySession = new Map<string, SessionFailureState>()

  observe(observation: ToolFailureObservation): boolean {
    if (
      !observation.tool ||
      !observation.toolCallId ||
      !isMcpInputValidationFailure(observation.reason)
    ) {
      return false
    }

    let state = this.failuresBySession.get(observation.sessionId)
    if (!state || state.interactionSequence !== observation.interactionSequence) {
      state = {
        interactionSequence: observation.interactionSequence,
        callIdsByTool: new Map(),
        stoppedTools: new Set()
      }
      this.failuresBySession.set(observation.sessionId, state)
    }

    if (state.stoppedTools.has(observation.tool)) return false
    const callIds = state.callIdsByTool.get(observation.tool) ?? new Set<string>()
    if (callIds.has(observation.toolCallId)) return false
    callIds.add(observation.toolCallId)
    state.callIdsByTool.set(observation.tool, callIds)
    if (callIds.size < 2) return false

    state.stoppedTools.add(observation.tool)
    return true
  }

  clearSession(sessionId: string): void {
    this.failuresBySession.delete(sessionId)
  }
}

export { RepeatedToolFailureGuard }
export type { ToolFailureObservation }

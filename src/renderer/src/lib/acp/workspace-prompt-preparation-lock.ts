// Adoption, Branch reset, and answer replacement finish before the optimistic run opens. This
// shared lease closes that otherwise idle-looking interval across prompts and elicitation replies.
const preparationsInFlight = new Set<string>()

const isWorkspacePromptPreparationInFlight = (sessionId: string): boolean =>
  preparationsInFlight.has(sessionId)

const acquireWorkspacePromptPreparation = (
  sessionId: string,
  onPreparationStateChange?: (sessionId: string, inFlight: boolean) => void
): (() => void) | undefined => {
  if (preparationsInFlight.has(sessionId)) return undefined
  preparationsInFlight.add(sessionId)
  onPreparationStateChange?.(sessionId, true)

  let released = false
  return () => {
    if (released) return
    released = true
    preparationsInFlight.delete(sessionId)
    onPreparationStateChange?.(sessionId, false)
  }
}

export { acquireWorkspacePromptPreparation, isWorkspacePromptPreparationInFlight }

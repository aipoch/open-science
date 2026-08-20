let revealingSessionIds: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

const getWorkspacePresentationRevealingSnapshot = (): ReadonlySet<string> => revealingSessionIds

const subscribeWorkspacePresentationRevealing = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const setWorkspacePresentationRevealing = (sessionId: string, revealing: boolean): void => {
  if (revealingSessionIds.has(sessionId) === revealing) return
  const next = new Set(revealingSessionIds)
  if (revealing) next.add(sessionId)
  else next.delete(sessionId)
  revealingSessionIds = next
  for (const listener of listeners) listener()
}

const isWorkspacePresentationRevealing = (sessionId: string): boolean =>
  revealingSessionIds.has(sessionId)

export {
  getWorkspacePresentationRevealingSnapshot,
  isWorkspacePresentationRevealing,
  setWorkspacePresentationRevealing,
  subscribeWorkspacePresentationRevealing
}

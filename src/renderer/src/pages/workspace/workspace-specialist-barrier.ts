let inFlightSessionIds: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

const getWorkspaceSpecialistBarrierSnapshot = (): ReadonlySet<string> => inFlightSessionIds

const subscribeWorkspaceSpecialistBarriers = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const setWorkspaceSpecialistBarrier = (sessionId: string, inFlight: boolean): void => {
  if (inFlightSessionIds.has(sessionId) === inFlight) return
  const next = new Set(inFlightSessionIds)
  if (inFlight) next.add(sessionId)
  else next.delete(sessionId)
  inFlightSessionIds = next
  for (const listener of listeners) listener()
}

const isWorkspaceSpecialistBarrierInFlight = (sessionId: string): boolean =>
  inFlightSessionIds.has(sessionId)

export {
  getWorkspaceSpecialistBarrierSnapshot,
  isWorkspaceSpecialistBarrierInFlight,
  setWorkspaceSpecialistBarrier,
  subscribeWorkspaceSpecialistBarriers
}

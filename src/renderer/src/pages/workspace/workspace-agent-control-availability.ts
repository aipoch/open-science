import type { SessionActionabilityProjection } from '@/stores/session-store'

type WorkspaceAgentControlAvailability = Readonly<{
  canChange: boolean
  canChangeAutoReview: boolean
  canChangeMemory: boolean
  canChangeSpecialist: boolean
}>

const resolveWorkspaceAgentControlAvailability = (
  ready: boolean,
  specialistBarrierInFlight: boolean,
  actions: SessionActionabilityProjection['actions'] | undefined
): WorkspaceAgentControlAvailability => {
  const providerReady = ready && !specialistBarrierInFlight
  return {
    canChange: providerReady && actions?.changeAgentControls.allowed !== false,
    canChangeAutoReview: ready && actions?.changeAutoReview.allowed !== false,
    canChangeMemory: providerReady && actions?.changeMemory.allowed !== false,
    canChangeSpecialist: providerReady && actions?.changeSpecialist.allowed !== false
  }
}

export { resolveWorkspaceAgentControlAvailability }
export type { WorkspaceAgentControlAvailability }

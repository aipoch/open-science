import { useMemo } from 'react'

import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSkillImportStore } from '@/stores/skill-import-store'
import type { SessionActionabilityFacts } from '@/stores/session-actionability'

export type SessionPendingInteractionFacts = Pick<
  SessionActionabilityFacts,
  'rootPermissionPending' | 'credentialPending'
>

// These application modules park calls outside the ACP permission broker. Derive their live
// presentation facts from the existing queues without changing their decision or replay authority.
export const useSessionPendingInteractions = (): ReadonlyMap<
  string,
  SessionPendingInteractionFacts
> => {
  const computeApprovals = useComputeStore((state) => state.pendingApprovals)
  const connectorApprovals = useSettingsStore((state) => state.pendingApprovals)
  const credentials = useSettingsStore((state) => state.pendingCredentialRequests)
  const skillApprovals = useSkillImportStore((state) => state.pending)
  const closedSkillIds = useSkillImportStore((state) => state.closedIds)

  return useMemo(() => {
    const facts = new Map<string, SessionPendingInteractionFacts>()
    const add = (sessionId: string | undefined, patch: SessionPendingInteractionFacts): void => {
      if (sessionId) facts.set(sessionId, { ...facts.get(sessionId), ...patch })
    }
    for (const request of computeApprovals) {
      if (!request.closed) add(request.sessionId, { rootPermissionPending: true })
    }
    for (const request of connectorApprovals) {
      if (!request.closed) add(request.sessionId, { rootPermissionPending: true })
    }
    for (const request of skillApprovals) {
      if (!closedSkillIds.includes(request.id))
        add(request.sessionId, { rootPermissionPending: true })
    }
    for (const request of credentials) {
      if (!request.closed) add(request.sessionId, { credentialPending: true })
    }
    return facts
  }, [computeApprovals, connectorApprovals, credentials, skillApprovals, closedSkillIds])
}

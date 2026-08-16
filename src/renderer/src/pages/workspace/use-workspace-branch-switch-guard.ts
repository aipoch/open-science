import { useEffect } from 'react'

import { useSessionStore } from '@/stores/session-store'

const useWorkspaceBranchSwitchGuard = (sessionId: string | undefined, blocked: boolean): void => {
  useEffect(() => {
    if (!sessionId) return
    useSessionStore.getState().setBranchSwitchBlocked(sessionId, blocked)
    return () => useSessionStore.getState().setBranchSwitchBlocked(sessionId, false)
  }, [blocked, sessionId])
}

export { useWorkspaceBranchSwitchGuard }

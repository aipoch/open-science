import { drainWorkspaceRuntimeEventsForPersistence } from '@/lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { projectSessionActionability, type ChatSession } from '@/stores/session-store'
import { hasCurrentRunningDelegatedAttempt } from '../../../shared/delegated-work-projection'

export const sessionPackageExportAvailable = (): boolean =>
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' &&
  Boolean(window.api?.sessions?.exportPackage)

export const exportSessionPackage = async (session: ChatSession): Promise<void> => {
  if (
    !sessionPackageExportAvailable() ||
    projectSessionActionability(session, {
      hasRunningWork: hasCurrentRunningDelegatedAttempt(session)
    }).activity !== 'inactive' ||
    (!session.packageOrigin &&
      (session.compacting ||
        session.runtimeContext?.permission?.state === 'pending' ||
        session.runtimeContext?.plan?.approval === 'pending')) ||
    packageOperationActive(usePackageOperationStore.getState().operation)
  )
    return
  await drainWorkspaceRuntimeEventsForPersistence(session.id)
  await flushSessionPersistence()
  // The main owner rechecks idle admission and reserves the persisted Session before reading it.
  await window.api.sessions.exportPackage({ projectId: session.projectId, sessionId: session.id })
}

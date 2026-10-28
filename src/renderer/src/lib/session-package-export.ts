import { drainWorkspaceRuntimeEventsForPersistence } from '@/lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { projectSessionActionability } from '@/stores/session-actionability'
import type { ChatSession } from '@/stores/session-store-contract'
import { hasCurrentRunningDelegatedAttempt } from '../../../shared/delegated-work-projection'

// Local Web shares the desktop capability; remote Web keeps it hidden because it cannot
// hand the caller a staged package file.
export const sessionPackageExportAvailable = (): boolean =>
  Boolean(window.api?.sessions?.exportPackage) &&
  (document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' ||
    document.documentElement.getAttribute(WEB_CALLER_LOCATION_ATTRIBUTE) === 'local')

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

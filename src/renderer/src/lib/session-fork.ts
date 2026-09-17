import { drainWorkspaceRuntimeEventsForPersistence } from '@/lib/acp/useWorkspaceAgentRuntime'
import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { i18next as i18n } from '@/i18n'

export const sessionForkAvailable = (): boolean =>
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) !== 'true' &&
  Boolean(window.api?.sessions?.fork)

let forking = false
export const forkSession = async (session: { id: string; projectId: string }): Promise<void> => {
  let ownsAttempt = false
  const previousId = usePackageOperationStore.getState().operation?.id
  const navigationRevision = useNavigationStore.getState().explicitNavigationRevision
  try {
    if (!sessionForkAvailable()) throw new Error(i18n.t('Fork is available in the desktop app.'))
    if (forking || packageOperationActive(usePackageOperationStore.getState().operation)) {
      usePackageOperationStore.getState().setOpen(true)
      throw new Error(i18n.t('Wait for the current transfer to finish before forking a Session.'))
    }
    forking = true
    ownsAttempt = true
    usePackageOperationStore.getState().setImportError(undefined)
    await drainWorkspaceRuntimeEventsForPersistence(session.id)
    await flushSessionPersistence()
    const result = await window.api.sessions.fork({
      projectId: session.projectId,
      sessionId: session.id
    })
    if (result && useNavigationStore.getState().explicitNavigationRevision === navigationRevision) {
      useNavigationStore.getState().openSession(result.projectId, result.sessionId, 'user')
      if (!usePackageOperationStore.getState().operation?.cleanupPending)
        usePackageOperationStore.getState().setOpen(false)
    }
  } catch (caught) {
    const observed = usePackageOperationStore.getState().operation
    const snapshot = await window.api?.sessions
      ?.packageOperation?.({ action: 'snapshot' })
      .catch(() => null)
    const store = usePackageOperationStore.getState()
    const current = store.operation !== observed ? store.operation : (snapshot ?? store.operation)
    if (current?.id !== previousId && current?.kind === 'fork') {
      store.receive(current)
      store.setOpen(true)
    } else {
      usePackageOperationStore.setState({ errorKind: 'fork' })
      store.setImportError(caught instanceof Error ? caught.message : String(caught))
    }
  } finally {
    if (ownsAttempt) forking = false
  }
}

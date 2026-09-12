import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { useProjectStore } from '@/stores/project-store'
import { sessionPackageImportAvailable } from '@/components/session-package-import-menu-model'

export const importSessionPackage = async (projectId: string): Promise<void> => {
  if (
    !sessionPackageImportAvailable() ||
    packageOperationActive(usePackageOperationStore.getState().operation)
  )
    return
  usePackageOperationStore.getState().setImportError(undefined)
  const previousId = usePackageOperationStore.getState().operation?.id
  try {
    const result = await window.api.sessions.importPackage({
      projectId
    })
    if (result) await useProjectStore.getState().loadProjects()
  } catch (caught) {
    // IPC rejection may reach the renderer before the terminal progress event. Read the
    // existing owner snapshot so a fast preflight failure still has the normal retry surface.
    const observed = usePackageOperationStore.getState().operation
    const snapshot = await window.api.sessions
      .packageOperation?.({ action: 'snapshot' })
      .catch(() => null)
    const store = usePackageOperationStore.getState()
    // Events received during the query are newer evidence, including a user's retry.
    const current = store.operation !== observed ? store.operation : (snapshot ?? store.operation)
    if (current?.id !== previousId && current?.kind === 'import') {
      if (current.state === 'failed') {
        store.receive(current)
        if (store.dismissedId !== current.id) store.setOpen(true)
      }
      return
    }
    usePackageOperationStore
      .getState()
      .setImportError(caught instanceof Error ? caught.message : String(caught))
  }
}

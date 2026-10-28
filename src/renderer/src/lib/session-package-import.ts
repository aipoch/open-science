import { packageOperationActive, usePackageOperationStore } from '@/stores/package-operation-store'
import { useProjectStore } from '@/stores/project-store'
import { sessionPackageImportAvailable } from '@/lib/session-package-capabilities'
import { stageUploadFile } from '@/lib/upload-transfer'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'

let importing = false

const isWebSurface = (): boolean =>
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true'

// Web RPC cannot carry a File through JSON, so a caller without a file picks one here. The
// hidden input stays inside the user gesture that opened it; a dismissal resolves undefined.
const pickScienceFile = (): Promise<File | undefined> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.science,.SCIENCE'
    input.style.display = 'none'
    let settled = false
    const finish = (file?: File): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(file)
    }
    const onFocus = (): void => {
      // Older engines never emit cancel; the window regains focus when the picker closes.
      window.setTimeout(() => finish(undefined), 0)
    }
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true })
    input.addEventListener('cancel', () => finish(undefined), { once: true })
    window.addEventListener('focus', onFocus)
    document.body.append(input)
    input.click()
  })

export const importSessionPackage = async (projectId?: string, file?: File): Promise<void> => {
  if (!sessionPackageImportAvailable()) return
  if (importing || packageOperationActive(usePackageOperationStore.getState().operation)) {
    usePackageOperationStore.getState().setOpen(true)
    return
  }
  usePackageOperationStore.setState({ errorKind: undefined })
  importing = true
  usePackageOperationStore.getState().setImportError(undefined)
  const previousId = usePackageOperationStore.getState().operation?.id
  try {
    const target = projectId === undefined ? {} : { projectId }
    if (isWebSurface()) {
      const selected = file ?? (await pickScienceFile())
      // The user dismissed the picker: nothing was staged and there is nothing to report.
      if (!selected) return
      if (!/\.science$/i.test(selected.name))
        throw new Error(`Only .science packages can be imported, not ${selected.name}.`)
      const attachment = await stageUploadFile(selected, window.api.uploads, {
        transferId: crypto.randomUUID(),
        name: selected.name
      })
      const result = await window.api.sessions.importPackage(target, attachment.path)
      if (result) {
        await useProjectStore.getState().loadProjects()
      }
      return
    }
    const result = await (file
      ? window.api.sessions.importPackage(target, file)
      : window.api.sessions.importPackage(target))
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
  } finally {
    importing = false
  }
}

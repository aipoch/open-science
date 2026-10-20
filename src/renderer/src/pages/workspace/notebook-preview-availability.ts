import type { NotebookSessionReference } from '../../../../shared/notebook'
import {
  createNotebookPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

// Registers the entry without opening the panel or replacing the user's active preview.
// Waits for preview persistence to activate the notebook's project before touching its slice.
export const registerNotebookWhenProjectActive = (
  notebook: NotebookSessionReference
): (() => void) => {
  let cancelled = false
  let unsubscribe = (): void => undefined
  const register = (): void => {
    if (cancelled) return
    const preview = usePreviewWorkbenchStore.getState()
    if (preview.activeProjectId !== notebook.projectId) return

    cancelled = true
    unsubscribe()
    preview.upsertItem(createNotebookPreviewItem(notebook))
  }

  unsubscribe = usePreviewWorkbenchStore.subscribe(register)
  register()
  return () => {
    cancelled = true
    unsubscribe()
  }
}

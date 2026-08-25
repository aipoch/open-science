import type { NotebookSessionReference } from '../../../../shared/notebook'
import {
  createNotebookPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

// Waits for preview persistence to activate the notebook's project before touching its slice.
export const revealNotebookWhenProjectActive = (
  notebook: NotebookSessionReference
): (() => void) => {
  let cancelled = false
  let unsubscribe = (): void => undefined
  const reveal = (): void => {
    if (cancelled) return
    const preview = usePreviewWorkbenchStore.getState()
    if (preview.activeProjectId !== notebook.projectId) return

    cancelled = true
    unsubscribe()
    const previewItem = createNotebookPreviewItem(notebook)
    preview.items.some(({ id }) => id === previewItem.id)
      ? preview.upsertItem(previewItem)
      : preview.upsertAndActivateItem(previewItem)
  }

  unsubscribe = usePreviewWorkbenchStore.subscribe(reveal)
  reveal()
  return () => {
    cancelled = true
    unsubscribe()
  }
}

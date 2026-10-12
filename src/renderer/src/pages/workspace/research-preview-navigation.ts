import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createSessionReplayItem } from './workspace-session-actions'

// Research navigation supplies a default, never replaces a reference explicitly chosen by the
// user. Ownership is transient and is cleared by the workbench's ordinary tab activation path.
export const ensureResearchPreview = (
  source: { projectId: string; sourceSessionId: string; sourceTitle: string },
  workspaceProjectId: string
): void => {
  const store = usePreviewWorkbenchStore.getState()
  if (store.activeProjectId !== workspaceProjectId) return
  const active = store.items.find((item) => item.id === store.activeItemId)
  if (active && (active.type !== 'tool' || !active.replayAutomatic)) return
  const item = createSessionReplayItem(
    source.projectId,
    source.sourceSessionId,
    source.sourceTitle,
    workspaceProjectId
  )
  if (active?.id === item.id) return
  store.upsertAndActivateItem({ ...item, replayAutomatic: true })
}

export const releaseAutomaticResearchPreview = (projectId: string): void => {
  const store = usePreviewWorkbenchStore.getState()
  if (store.activeProjectId !== projectId) return
  // Remove only defaults; user-selected files and recordings retain their source and position.
  for (const item of store.items) {
    if (item.type === 'tool' && item.replayAutomatic) store.removeItem(item.id)
  }
}

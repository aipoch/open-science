import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import type { SessionDiscussionCapture } from './replay/replay-context'

export const loadSessionDiscussionContext = async (
  projectId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<SessionDiscussionCapture | undefined> => {
  const [{ loadReplayDocument }, { captureDiscussionSession }] = await Promise.all([
    import('@/lib/replay'),
    import('./replay/replay-context')
  ])
  const document = await loadReplayDocument(window.api, { projectId, sessionId }, { signal })
  return captureDiscussionSession(document)
}

// The pane belongs to the destination workspace; archive reads always use the source identity.
export const createSessionReplayItem = (
  projectId: string,
  sourceSessionId: string,
  title: string,
  workspaceProjectId = projectId
): PreviewToolItem => ({
  id: `tool:${sourceSessionId}:replay`,
  type: 'tool',
  toolKind: 'replay',
  projectId: workspaceProjectId,
  sessionId: sourceSessionId,
  replaySourceProjectId: projectId,
  replaySourceSessionId: sourceSessionId,
  title
})

let replayRevealRequest = 0

// Explicit "View replay" actions reveal the player inside an existing research tab. Ordinary
// workspace/tab activation keeps its current materials view and never restarts the player.
export const showSessionReplay = (
  projectId: string,
  sourceSessionId: string,
  title: string,
  workspaceProjectId = projectId,
  mode: 'replay' | 'runs' = 'replay'
): void => {
  usePreviewWorkbenchStore.getState().upsertAndActivateItem({
    ...createSessionReplayItem(projectId, sourceSessionId, title, workspaceProjectId),
    replayRevealMode: mode,
    replayRevealRequest: ++replayRevealRequest
  })
}

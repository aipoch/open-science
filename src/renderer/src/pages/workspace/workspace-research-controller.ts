import type { PreviewToolItem } from '@/stores/preview-workbench-store'
import type { ReplayStepContext } from './replay/replay-context'

export const loadSessionDiscussionContext = async (
  projectId: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<ReplayStepContext | undefined> => {
  const [{ loadReplayDocument }, { captureSessionDiscussionContext }] = await Promise.all([
    import('@/lib/replay'),
    import('./replay/replay-context')
  ])
  const document = await loadReplayDocument(window.api, { projectId, sessionId }, { signal })
  return captureSessionDiscussionContext(document)
}

// The pane belongs to the destination workspace; archive reads always use the source identity.
export const createResearchReplayItem = (
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

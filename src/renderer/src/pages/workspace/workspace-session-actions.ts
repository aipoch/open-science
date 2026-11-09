import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import type { PreviewToolItem } from '@/stores/preview-workbench-contract'
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
  return document.source.packageOrigin ? captureDiscussionSession(document) : undefined
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

export const DISCUSSION_DRAFT_CONFLICT = 'discussion-draft-conflict'

export const openDiscussionDraft = (
  context: SessionDiscussionCapture,
  fromReplay = false
): boolean => {
  const navigation = useNavigationStore.getState()
  const { sessions, selectedSessionId } = useSessionStore.getState()
  const child = fromReplay && sessions.find((session) => session.id === selectedSessionId)
  if (
    child &&
    !child.isPending &&
    navigation.view === 'workspace' &&
    navigation.activeProjectId === context.projectId &&
    child.projectId === context.projectId &&
    child.parentSessionId === context.sourceSessionId &&
    child.archivedAt === undefined
  ) {
    const graph = child.conversationGraph
    const frame = graph?.frames.find((entry) => entry.id === graph.activeFrameId)
    useSessionReplayStore.getState().ask(context, {
      projectId: child.projectId,
      sessionId: child.id,
      frameId: frame?.id,
      branchId: frame?.activeBranchId,
      navigationRevision: navigation.explicitNavigationRevision
    })
    usePreviewWorkbenchStore.getState().setToolItemExpanded(null)
    return true
  }
  return navigation.openProject(context.projectId, 'user', () => {
    useSessionStore.getState().clearSelection()
    useSessionReplayStore.getState().ask(context, {
      projectId: context.projectId,
      navigationRevision: useNavigationStore.getState().explicitNavigationRevision
    })
    const previews = usePreviewWorkbenchStore.getState()
    previews.upsertAndActivateItem(
      createSessionReplayItem(context.projectId, context.sourceSessionId, context.sourceTitle)
    )
    previews.setToolItemExpanded(null)
  })
}

import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import { createSessionReplayItem, loadSessionDiscussionContext } from './workspace-session-actions'
import {
  ordinaryDraftKey,
  researchDraftKey,
  researchIdentity,
  sameResearch
} from './research-draft-identity'
import type { SessionDiscussionCapture } from './replay/replay-context'

const writable = (session: ChatSession | undefined): session is ChatSession =>
  Boolean(
    session &&
    !session.packageOrigin &&
    !session.importedResearch &&
    session.archivedAt === undefined &&
    !session.isPending
  )

export const researchSourceFromSession = (
  session: ChatSession | undefined
): ResearchMembership | undefined => {
  const importId = session?.packageOrigin?.importId ?? session?.importedResearch?.importId
  return session && importId
    ? {
        sourceProjectId: session.projectId,
        sourceSessionId: session.id,
        sourceImportId: importId,
        sourceTitle: session.title
      }
    : undefined
}

const availableSource = (source: ResearchMembership): boolean => {
  const session = useSessionStore
    .getState()
    .sessions.find(
      (row) => row.id === source.sourceSessionId && row.projectId === source.sourceProjectId
    )
  const project = useProjectStore
    .getState()
    .projects.find((row) => row.id === source.sourceProjectId)
  return Boolean(
    project &&
    project.archivedAt === undefined &&
    session &&
    session.archivedAt === undefined &&
    sameResearch(researchSourceFromSession(session), source)
  )
}

const openReplay = (
  source: { projectId: string; sourceSessionId: string; sourceTitle: string },
  projectId: string
): void => {
  usePreviewWorkbenchStore
    .getState()
    .upsertAndActivateItem(
      createSessionReplayItem(
        source.projectId,
        source.sourceSessionId,
        source.sourceTitle,
        projectId
      )
    )
  usePreviewWorkbenchStore.getState().setToolItemExpanded(null)
}

// An explicit chooser stages a reference without assigning ownership. Research navigation passes
// a membership only for a new, source-scoped draft; existing Sessions are never reparented here.
export const stageSessionDiscussion = (
  context: SessionDiscussionCapture,
  target: {
    projectId: string
    sessionId?: string
    researchMembership?: ResearchMembership
    onlyIfUnlinked?: boolean
  },
  onStaged?: () => void
): boolean => {
  const { projectId, sessionId, researchMembership } = target
  const available = (): boolean => {
    const project = useProjectStore.getState().projects.find((row) => row.id === projectId)
    const session = useSessionStore.getState().sessions.find((row) => row.id === sessionId)
    return Boolean(
      project &&
      project.archivedAt === undefined &&
      sessionId !== context.sourceSessionId &&
      (!sessionId || (writable(session) && session.projectId === projectId)) &&
      (!researchMembership ||
        (researchMembership.sourceProjectId === projectId &&
          availableSource(researchMembership) &&
          (!sessionId || sameResearch(session?.researchMembership, researchMembership))))
    )
  }
  if (!available()) return false
  // Capture now: a dirty-preview guard can postpone navigation while replay continues playing.
  const captured = structuredClone(context)
  const stage = (): void => {
    if (!available()) return
    if (!sessionId) {
      if (researchMembership) useResearchWorkspaceStore.getState().openDraft(researchMembership)
      else useResearchWorkspaceStore.getState().leaveDraft(projectId)
      useSessionStore.getState().clearSelection()
    }
    if (sessionId && researchMembership)
      useResearchWorkspaceStore.getState().rememberDiscussion(researchMembership, sessionId)
    const selected = useSessionStore.getState().sessions.find((row) => row.id === sessionId)
    const graph = selected?.conversationGraph
    const frame = graph?.frames.find((row) => row.id === graph.activeFrameId)
    useSessionReplayStore.getState().ask(captured, {
      projectId,
      sessionId,
      ...(!sessionId
        ? {
            draftKey: researchMembership
              ? researchDraftKey(researchMembership)
              : ordinaryDraftKey(projectId)
          }
        : {}),
      ...(target.onlyIfUnlinked ? { onlyIfUnlinked: true } : {}),
      frameId: frame?.id,
      branchId: frame?.activeBranchId,
      navigationRevision: useNavigationStore.getState().explicitNavigationRevision
    })
    openReplay(captured, projectId)
    onStaged?.()
  }
  const navigation = useNavigationStore.getState()
  return sessionId
    ? navigation.openSession(projectId, sessionId, 'user', stage)
    : navigation.openProject(projectId, 'user', stage)
}

const discussionFor = async (source: ResearchMembership): Promise<string | undefined> => {
  const sessions = useSessionStore.getState()
  const owned = (id: string | undefined): ChatSession | undefined =>
    sessions.sessions.find(
      (session) =>
        session.id === id &&
        session.projectId === source.sourceProjectId &&
        writable(session) &&
        sameResearch(session.researchMembership, source)
    )
  if (
    !sessions.selectedSessionId &&
    sameResearch(
      useResearchWorkspaceStore.getState().draftResearchByProject[source.sourceProjectId],
      source
    )
  )
    return undefined
  const current = owned(sessions.selectedSessionId)
  if (current) return current.id
  const remembered = owned(
    useResearchWorkspaceStore.getState().lastDiscussionByResearch[researchIdentity(source)]
  )
  if (remembered) return remembered.id
  const match = await window.api.sessionReplay.findDiscussion({
    projectId: source.sourceProjectId,
    sourceSessionId: source.sourceSessionId
  })
  // Main validates the durable association. The startup projection must agree before navigation.
  return owned(match?.sessionId)?.id
}

const navigationGuard = (signal?: AbortSignal): (() => boolean) => {
  const navigation = useNavigationStore.getState()
  const selected = useSessionStore.getState().selectedSessionId
  return () =>
    !signal?.aborted &&
    useNavigationStore.getState().explicitNavigationRevision ===
      navigation.explicitNavigationRevision &&
    useSessionStore.getState().selectedSessionId === selected
}

export const openResearchDiscussion = async (
  context: SessionDiscussionCapture,
  signal?: AbortSignal
): Promise<boolean> => {
  if (signal?.aborted) return true
  const current = navigationGuard(signal)
  const captured = structuredClone(context)
  const source = researchSourceFromSession(
    useSessionStore
      .getState()
      .sessions.find(
        (row) => row.id === captured.sourceSessionId && row.projectId === captured.projectId
      )
  )
  if (!source) {
    const original = useSessionStore
      .getState()
      .sessions.find(
        (row) => row.id === captured.sourceSessionId && row.projectId === captured.projectId
      )
    if (!original || original.archivedAt !== undefined) return false
    // Ordinary Session replay remains available without creating an imported-research group.
    // A direct action never changes ownership, even when an ordinary draft already has references.
    const selected = useSessionStore
      .getState()
      .sessions.find((row) => row.id === useSessionStore.getState().selectedSessionId)
    const binding = selected?.runtimeContext?.sessionContext?.bindings.at(-1)
    const receiver =
      writable(selected) &&
      !selected.researchMembership &&
      binding?.projectId === captured.projectId &&
      binding.sessionId === captured.sourceSessionId
        ? selected
        : undefined
    return stageSessionDiscussion(captured, {
      projectId: receiver?.projectId ?? captured.projectId,
      sessionId: receiver?.id
    })
  }
  if (!availableSource(source)) return false
  const sessionId = await discussionFor(source)
  if (!current()) return true
  return stageSessionDiscussion(captured, {
    projectId: source.sourceProjectId,
    sessionId,
    researchMembership: source
  })
}

// Opening a research restores its last valid discussion. Only a genuinely new draft needs a
// whole-research reference; re-entering a discussion must not replace a user's selected step.
export const openResearchWorkspace = async (
  source: ResearchMembership,
  options: { newDiscussion?: boolean; signal?: AbortSignal } = {}
): Promise<boolean> => {
  if (options.signal?.aborted) return true
  if (!availableSource(source)) return false
  const current = navigationGuard(options.signal)
  const sessionId = options.newDiscussion ? undefined : await discussionFor(source)
  if (!current()) return true
  if (sessionId) {
    return useNavigationStore
      .getState()
      .openSession(source.sourceProjectId, sessionId, 'user', () => {
        const session = useSessionStore.getState().sessions.find((row) => row.id === sessionId)
        if (
          !availableSource(source) ||
          !writable(session) ||
          !sameResearch(session.researchMembership, source)
        )
          return
        useResearchWorkspaceStore.getState().rememberDiscussion(source, sessionId)
        openReplay(
          {
            projectId: source.sourceProjectId,
            sourceSessionId: source.sourceSessionId,
            sourceTitle: source.sourceTitle
          },
          source.sourceProjectId
        )
      })
  }
  const context = await loadSessionDiscussionContext(
    source.sourceProjectId,
    source.sourceSessionId,
    options.signal
  )
  if (!current()) return true
  if (!context) {
    // An archive can validly contain metadata/files without replayable steps. Enter its draft
    // and the replay's existing empty state; never invent a selected step or evidence snapshot.
    return useNavigationStore.getState().openProject(source.sourceProjectId, 'user', () => {
      if (!availableSource(source)) return
      useResearchWorkspaceStore.getState().openDraft(source)
      useSessionStore.getState().clearSelection()
      useSessionReplayStore.getState().ask(undefined)
      openReplay(
        {
          projectId: source.sourceProjectId,
          sourceSessionId: source.sourceSessionId,
          sourceTitle: source.sourceTitle
        },
        source.sourceProjectId
      )
    })
  }
  return stageSessionDiscussion(context, {
    projectId: source.sourceProjectId,
    researchMembership: source,
    onlyIfUnlinked: true
  })
}

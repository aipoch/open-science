import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { rememberResearchProjectDestination } from '@/lib/research-project-entry'
import { ensureResearchPreview } from './research-preview-navigation'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import type { ResearchMembership } from '../../../../shared/session-persistence'
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
  ensureResearchPreview(source, projectId)
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
    signal?: AbortSignal
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
  const current = navigationGuard(target.signal)
  const stage = (): void => {
    if (!available()) return
    if (!sessionId) {
      if (researchMembership) useResearchWorkspaceStore.getState().openDraft(researchMembership)
      else useResearchWorkspaceStore.getState().leaveDraft(projectId)
      if (researchMembership)
        useSessionStore.getState().selectSession(researchMembership.sourceSessionId)
      else useSessionStore.getState().clearSelection()
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
    if (researchMembership)
      rememberResearchProjectDestination(
        projectId,
        {
          kind: 'research',
          sourceSessionId: researchMembership.sourceSessionId,
          sourceImportId: researchMembership.sourceImportId
        },
        useSessionStore.getState().sessions
      )
    onStaged?.()
  }
  const navigation = useNavigationStore.getState()
  return sessionId
    ? navigation.openSession(projectId, sessionId, 'user', stage, () => current() && available())
    : researchMembership
      ? navigation.openSession(
          projectId,
          researchMembership.sourceSessionId,
          'user',
          stage,
          () => current() && available()
        )
      : navigation.openProject(projectId, 'user', stage, () => current() && available())
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
  // The original research owns a new-question draft; Ask must never silently jump to
  // a previous discussion merely because that discussion was opened earlier.
  if (sessions.selectedSessionId === source.sourceSessionId) return undefined
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
      sessionId: receiver?.id,
      signal
    })
  }
  if (!availableSource(source)) return false
  const sessionId = await discussionFor(source)
  if (!current()) return true
  return stageSessionDiscussion(captured, {
    projectId: source.sourceProjectId,
    sessionId,
    researchMembership: source,
    signal
  })
}

// Research names and "New discussion" lead to the original transcript with its source-scoped
// question draft. Only submitting that draft creates a discussion; existing discussions remain
// explicit child Session destinations.
export const openResearchWorkspace = async (
  source: ResearchMembership,
  options: {
    newDiscussion?: boolean
    signal?: AbortSignal
    preservePreview?: boolean
    afterNavigate?: (destination: {
      projectId: string
      sessionId?: string
      draftKey: string
    }) => void
  } = {}
): Promise<boolean> => {
  if (options.signal?.aborted) return true
  if (!availableSource(source)) return false
  const stillAtEntry = navigationGuard(options.signal)
  const current = (): boolean => stillAtEntry() && availableSource(source)
  return useNavigationStore.getState().openSession(
    source.sourceProjectId,
    source.sourceSessionId,
    'user',
    () => {
      if (!availableSource(source)) return
      useResearchWorkspaceStore.getState().openDraft(source)
      if (!options.preservePreview)
        openReplay(
          {
            projectId: source.sourceProjectId,
            sourceSessionId: source.sourceSessionId,
            sourceTitle: source.sourceTitle
          },
          source.sourceProjectId
        )
      rememberResearchProjectDestination(
        source.sourceProjectId,
        {
          kind: 'research',
          sourceSessionId: source.sourceSessionId,
          sourceImportId: source.sourceImportId
        },
        useSessionStore.getState().sessions
      )
      options.afterNavigate?.({
        projectId: source.sourceProjectId,
        draftKey: researchDraftKey(source)
      })
    },
    current
  )
}

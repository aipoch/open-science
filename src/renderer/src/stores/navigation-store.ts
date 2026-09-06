import { create } from 'zustand'

import { recordLastOpenedProject } from '@/lib/last-opened-project'
import type { CustomizeGoal } from '@/lib/customize-chat'
import type { ComposerDoc } from '@/pages/workspace/composer/composer-doc'

import { useProjectStore } from './project-store'
import {
  dialogPreviewGuardScope,
  previewLeaveGuards,
  workbenchPreviewGuardScope
} from './preview-leave-guard'
import {
  createPendingPdfContext,
  usePreviewWorkbenchStore,
  type PreviewFileItem
} from './preview-workbench-store'
import {
  findMostRecentSessionId as findMostRecentProjectSessionId,
  useSessionStore
} from './session-store'
import type { ProjectFileItem } from '../../../shared/project-files'
import {
  MAX_SESSION_PDF_CONTEXTS,
  type LiteratureScopeReference,
  type SessionPdfContextSource
} from '../../../shared/session-persistence'

export type NavigationView = 'home' | 'library' | 'workspace'
export type NavigationOrigin = 'user' | 'notification' | 'automatic'

// Workspace owns the mutable composer draft. It projects only the capability Global Search needs,
// avoiding a second draft model or cross-Project mention handoff.
export type ArtifactMentionAvailability = {
  projectId: string
  canMention: boolean
}

export type CustomizePrefillIntent = {
  projectId: string
  goal: CustomizeGoal
  requestId: number
}

export type LiteratureReviewPrefillIntent = {
  projectId: string
  scope: LiteratureScopeReference
  prompt: string
  requestId: number
}

export type PdfReadingDocument = Readonly<{
  item: PreviewFileItem
  source: SessionPdfContextSource
}>

export type WslSupportPrefillIntent = {
  projectId: string
  doc: ComposerDoc
  requestId: number
}

type NavigationStore = {
  view: NavigationView
  activeProjectId: string | undefined
  // Advances only for explicit user navigation. Deferred startup intents observe this instead of
  // treating lifecycle/deep-link redirects as user choices.
  userNavigationRevision: number
  // Advances when an explicit navigation intent should supersede a deferred startup deep link.
  // Desktop-notification clicks count here, but not as in-app user navigation above.
  explicitNavigationRevision: number
  // Project id targeted by a pending `Chat with agent` prefill, consumed once by WorkspacePage when it
  // opens that project's New Conversation draft. Undefined means no prefill is pending.
  pendingCustomizePrefill: CustomizePrefillIntent | undefined
  // A Library entry can open a normal New Conversation with its visible retrieval scope already
  // staged. Workspace consumes this once; the user can still edit or discard the draft.
  pendingLiteratureReviewPrefill: LiteratureReviewPrefillIntent | undefined
  pendingWslSupportPrefill: WslSupportPrefillIntent | undefined
  // Home consumes this one-shot intent to open its existing New Project dialog.
  pendingProjectCreation: boolean
  // A same-Project Artifact selected from global search. WorkspacePage consumes it once and appends
  // its immutable Version reference to the currently active composer draft.
  pendingArtifactMention: ProjectFileItem | undefined
  // One user-level Literature Item selected outside Workspace Preview. Library consumes this once
  // and opens its detail without encoding transient UI selection into a route or persisted state.
  pendingLiteratureItemId: string | undefined
  // One explicit Project scope selected outside the Library. Library consumes this once instead of
  // inferring scope from the retained activeProjectId, which also survives user-level Library opens.
  pendingLiteratureProjectId: string | undefined
  // One explicit Collection scope selected outside the Library. Library consumes this once after
  // routing so sent Collection mentions can reopen their matching view.
  pendingLiteratureCollectionId: string | undefined
  // The active Workspace composer publishes whether it can currently accept one more Artifact.
  artifactMentionAvailability: ArtifactMentionAvailability | undefined
  recordUserNavigation: () => void
  goHome: (origin: NavigationOrigin) => void
  openLibrary: (origin: NavigationOrigin) => void
  openLiteratureItem: (itemId: string, origin: NavigationOrigin) => void
  openProjectLiterature: (projectId: string, origin: NavigationOrigin) => boolean
  openCollectionLiterature: (collectionId: string, origin: NavigationOrigin) => boolean
  openProject: (projectId: string, origin: NavigationOrigin, afterNavigate?: () => void) => boolean
  openSession: (
    projectId: string,
    sessionId: string,
    origin: NavigationOrigin,
    afterNavigate?: () => void
  ) => boolean
  // Opens a session knowing only its id (e.g. a desktop-notification click); a no-op when the
  // session no longer exists or hasn't loaded yet.
  openSessionById: (
    sessionId: string,
    origin: NavigationOrigin,
    afterNavigate?: () => void
  ) => boolean
  // Leaves a Workspace whose Project disappeared from the authoritative Project list. This recovery
  // bypasses preview leave guards because the missing Project is no longer a valid editing scope.
  discardInvalidProject: (projectId: string) => void
  // Opens a project's New Conversation draft (no Specialist binding) carrying a `/customize` prefill.
  // The intent does not send, create a session, or imply mutation approval; WorkspacePage consumes the
  // prefill once and clears it.
  startCustomizeConversation: (projectId: string, goal?: CustomizeGoal) => void
  startLiteratureReviewConversation: (
    projectId: string,
    scope: LiteratureScopeReference,
    prompt: string
  ) => boolean
  // Opens a project's New Conversation draft with one immutable Library PDF staged as Reading.
  // The Session and durable PDF binding are still created only when the user sends the first turn.
  startPdfReadingConversation: (
    projectId: string,
    item: PreviewFileItem,
    source: SessionPdfContextSource
  ) => boolean
  startPdfReadingConversations: (
    projectId: string,
    documents: readonly PdfReadingDocument[]
  ) => boolean
  consumeCustomizePrefill: () => void
  consumeLiteratureReviewPrefill: () => void
  startWslSupportConversation: (projectId: string, doc: ComposerDoc) => boolean
  consumeWslSupportPrefill: () => void
  requestProjectCreation: () => void
  consumeProjectCreation: () => void
  requestArtifactMention: (file: ProjectFileItem) => void
  consumeArtifactMention: () => ProjectFileItem | undefined
  consumeLiteratureItem: (expectedItemId?: string) => string | undefined
  consumeLiteratureProject: (expectedProjectId?: string) => string | undefined
  consumeLiteratureCollection: (expectedCollectionId?: string) => string | undefined
  setArtifactMentionAvailability: (availability: ArtifactMentionAvailability | undefined) => void
}

const navigationState = (
  state: NavigationStore,
  origin: NavigationOrigin,
  next: Pick<NavigationStore, 'view'> & Partial<Pick<NavigationStore, 'activeProjectId'>>
): Pick<
  NavigationStore,
  'view' | 'activeProjectId' | 'userNavigationRevision' | 'explicitNavigationRevision'
> => ({
  view: next.view,
  activeProjectId:
    next.view === 'home' ? undefined : (next.activeProjectId ?? state.activeProjectId),
  userNavigationRevision:
    origin === 'user' ? state.userNavigationRevision + 1 : state.userNavigationRevision,
  explicitNavigationRevision:
    origin === 'automatic' ? state.explicitNavigationRevision : state.explicitNavigationRevision + 1
})

// Picks the most recently updated non-pending session in a project so opening a project lands on its
// latest conversation instead of a blank workspace.
const findMostRecentSessionId = (projectId: string): string | undefined =>
  findMostRecentProjectSessionId(useSessionStore.getState().sessions, projectId)

const isActiveProject = (projectId: string): boolean =>
  useProjectStore
    .getState()
    .projects.some((project) => project.id === projectId && project.archivedAt === undefined)

const isActiveSession = (projectId: string, sessionId: string): boolean =>
  isActiveProject(projectId) &&
  useSessionStore
    .getState()
    .sessions.some(
      (session) =>
        session.id === sessionId &&
        session.projectId === projectId &&
        session.archivedAt === undefined
    )

const requestPreviewLeaveForNavigation = (
  target: { view: NavigationView; projectId?: string },
  action: () => void
): boolean => {
  const navigation = useNavigationStore.getState()
  const staysInCurrentWorkspace =
    navigation.view !== 'workspace' ||
    (target.view === 'workspace' && target.projectId === navigation.activeProjectId)
  if (staysInCurrentWorkspace) {
    action()
    return true
  }

  const preview = usePreviewWorkbenchStore.getState()
  const dialogScope = dialogPreviewGuardScope(
    preview.fileDialogItem?.projectId,
    preview.fileDialogItem?.id
  )
  const workbenchScope = workbenchPreviewGuardScope(preview.activeProjectId, preview.activeItemId)
  return previewLeaveGuards.request(dialogScope, () =>
    previewLeaveGuards.request(workbenchScope, action)
  )
}

// Owns which top-level screen is visible and which project the workspace is scoped to. Session
// selection stays in the session store; this store coordinates it when navigating.
export const useNavigationStore = create<NavigationStore>((set, get) => ({
  view: 'home',
  activeProjectId: undefined,
  userNavigationRevision: 0,
  explicitNavigationRevision: 0,
  pendingCustomizePrefill: undefined,
  pendingLiteratureReviewPrefill: undefined,
  pendingWslSupportPrefill: undefined,
  pendingProjectCreation: false,
  pendingArtifactMention: undefined,
  pendingLiteratureItemId: undefined,
  pendingLiteratureProjectId: undefined,
  pendingLiteratureCollectionId: undefined,
  artifactMentionAvailability: undefined,

  // Records user-owned navigation that changes another store (for example, opening the local New
  // Conversation draft clears Session selection without changing the top-level view).
  recordUserNavigation: () =>
    set((state) => ({
      userNavigationRevision: state.userNavigationRevision + 1,
      explicitNavigationRevision: state.explicitNavigationRevision + 1
    })),

  // Returns to the home screen without discarding session state.
  goHome: (origin) => {
    requestPreviewLeaveForNavigation({ view: 'home' }, () =>
      set((state) => navigationState(state, origin, { view: 'home' }))
    )
  },

  openLibrary: (origin) =>
    requestPreviewLeaveForNavigation({ view: 'library' }, () =>
      set((state) => ({
        ...navigationState(state, origin, { view: 'library' }),
        pendingLiteratureProjectId: undefined,
        pendingLiteratureCollectionId: undefined
      }))
    ),

  openLiteratureItem: (itemId, origin) =>
    requestPreviewLeaveForNavigation({ view: 'library' }, () =>
      set((state) => ({
        ...navigationState(state, origin, { view: 'library' }),
        pendingLiteratureItemId: itemId,
        pendingLiteratureProjectId: undefined,
        pendingLiteratureCollectionId: undefined
      }))
    ),

  openProjectLiterature: (projectId, origin) => {
    if (!isActiveProject(projectId)) return false
    return requestPreviewLeaveForNavigation({ view: 'library' }, () =>
      set((state) => ({
        ...navigationState(state, origin, {
          view: 'library',
          activeProjectId: projectId
        }),
        pendingLiteratureProjectId: projectId,
        pendingLiteratureCollectionId: undefined
      }))
    )
  },

  openCollectionLiterature: (collectionId, origin) =>
    requestPreviewLeaveForNavigation({ view: 'library' }, () =>
      set((state) => ({
        ...navigationState(state, origin, { view: 'library' }),
        pendingLiteratureProjectId: undefined,
        pendingLiteratureCollectionId: collectionId
      }))
    ),

  // Enters a project's workspace, selecting its most recent session when one exists. An explicit user
  // open also records the durable last-opened project so `Chat with agent` re-opens it next time.
  openProject: (projectId, origin, afterNavigate) => {
    if (!isActiveProject(projectId)) return false
    return requestPreviewLeaveForNavigation({ view: 'workspace', projectId }, () => {
      if (!isActiveProject(projectId)) return false
      const mostRecentSessionId = findMostRecentSessionId(projectId)

      if (mostRecentSessionId) {
        useSessionStore.getState().selectSession(mostRecentSessionId)
      } else {
        useSessionStore.getState().clearSelection()
      }

      if (origin === 'user') recordLastOpenedProject(projectId)

      set((state) =>
        navigationState(state, origin, { view: 'workspace', activeProjectId: projectId })
      )
      usePreviewWorkbenchStore.getState().activateProject(projectId, undefined, true)
      afterNavigate?.()
      return true
    })
  },

  // Opens a specific session inside its project's workspace. An optional continuation runs only
  // after navigation, including when a dirty-preview confirmation deferred it.
  openSession: (projectId, sessionId, origin, afterNavigate) => {
    if (!isActiveSession(projectId, sessionId)) return false
    return requestPreviewLeaveForNavigation({ view: 'workspace', projectId }, () => {
      if (!isActiveSession(projectId, sessionId)) return false
      useSessionStore.getState().selectSession(sessionId)

      if (origin === 'user') recordLastOpenedProject(projectId)

      set((state) =>
        navigationState(state, origin, { view: 'workspace', activeProjectId: projectId })
      )
      usePreviewWorkbenchStore.getState().activateProject(projectId, undefined, true)
      afterNavigate?.()
      return true
    })
  },

  // Resolves the session's project from the session store, then navigates exactly like
  // openSession. Unknown ids stay put: a notification for a deleted conversation must not
  // yank the user to a blank workspace.
  openSessionById: (sessionId, origin, afterNavigate) => {
    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)

    if (!session) return false
    return get().openSession(session.projectId, session.id, origin, afterNavigate)
  },

  discardInvalidProject: (projectId) => {
    const navigation = get()
    if (navigation.view !== 'workspace' || navigation.activeProjectId !== projectId) return

    useSessionStore.getState().clearSelection()
    set({ view: 'home', activeProjectId: undefined })
  },

  // Opens a project's New Conversation draft carrying a `/customize` prefill. Clears session selection
  // so the fresh draft has no Specialist binding, records the target as the last-opened project, and
  // stamps a pending prefill intent that WorkspacePage consumes once. The intent never sends or creates
  // a session; it is a navigation/prefill intent only.
  startCustomizeConversation: (projectId, goal = 'specialist') => {
    if (!isActiveProject(projectId)) return
    requestPreviewLeaveForNavigation({ view: 'workspace', projectId }, () => {
      useSessionStore.getState().clearSelection()
      recordLastOpenedProject(projectId)

      set((state) => {
        const navigation = navigationState(state, 'user', {
          view: 'workspace',
          activeProjectId: projectId
        })
        return {
          ...navigation,
          pendingWslSupportPrefill: undefined,
          pendingCustomizePrefill: {
            projectId,
            goal,
            requestId: navigation.explicitNavigationRevision
          }
        }
      })
      usePreviewWorkbenchStore.getState().activateProject(projectId, undefined, true)
    })
  },

  startLiteratureReviewConversation: (projectId, scope, prompt) => {
    if (!isActiveProject(projectId)) return false
    return requestPreviewLeaveForNavigation({ view: 'workspace', projectId }, () => {
      useSessionStore.getState().clearSelection()
      recordLastOpenedProject(projectId)
      set((state) => {
        const navigation = navigationState(state, 'user', {
          view: 'workspace',
          activeProjectId: projectId
        })
        return {
          ...navigation,
          pendingLiteratureReviewPrefill: {
            projectId,
            scope,
            prompt,
            requestId: navigation.explicitNavigationRevision
          }
        }
      })
      usePreviewWorkbenchStore.getState().activateProject(projectId, undefined, true)
    })
  },

  startPdfReadingConversation: (projectId, item, source) => {
    return get().startPdfReadingConversations(projectId, [{ item, source }])
  },

  startPdfReadingConversations: (projectId, documents) => {
    const unique = [
      ...new Map(
        documents.map((document) => [
          `${document.source.sourceKind}:${document.source.sourceVersionId}`,
          document
        ])
      ).values()
    ]
    if (
      !isActiveProject(projectId) ||
      unique.length === 0 ||
      unique.length > MAX_SESSION_PDF_CONTEXTS
    )
      return false
    return requestPreviewLeaveForNavigation({ view: 'workspace', projectId }, () => {
      useSessionStore.getState().clearSelection()
      recordLastOpenedProject(projectId)
      set((state) =>
        navigationState(state, 'user', { view: 'workspace', activeProjectId: projectId })
      )

      const preview = usePreviewWorkbenchStore.getState()
      preview.activateProject(projectId, undefined, true)
      for (const { item } of unique) preview.upsertItem({ ...item, projectId }, true)
      preview.activateItem(unique[0].item.id)
      preview.openPanel()
      preview.setPendingPdfContext(
        projectId,
        createPendingPdfContext(
          unique.map(({ item, source }) => ({
            kind: 'version',
            ...source,
            previewItemId: item.id
          }))
        )
      )
    })
  },

  // Clears the consumed prefill intent so a later normal open starts fresh.
  consumeCustomizePrefill: () => set({ pendingCustomizePrefill: undefined }),

  consumeLiteratureReviewPrefill: () => set({ pendingLiteratureReviewPrefill: undefined }),

  startWslSupportConversation: (projectId, doc) => {
    if (!isActiveProject(projectId)) return false
    return requestPreviewLeaveForNavigation({ view: 'workspace', projectId }, () => {
      useSessionStore.getState().clearSelection()
      recordLastOpenedProject(projectId)

      set((state) => {
        const navigation = navigationState(state, 'user', {
          view: 'workspace',
          activeProjectId: projectId
        })
        return {
          ...navigation,
          pendingCustomizePrefill: undefined,
          pendingWslSupportPrefill: {
            projectId,
            doc,
            requestId: navigation.explicitNavigationRevision
          }
        }
      })
      usePreviewWorkbenchStore.getState().activateProject(projectId, undefined, true)
    })
  },

  consumeWslSupportPrefill: () => set({ pendingWslSupportPrefill: undefined }),

  requestProjectCreation: () => {
    requestPreviewLeaveForNavigation({ view: 'home' }, () =>
      set((state) => ({
        ...navigationState(state, 'user', { view: 'home' }),
        pendingProjectCreation: true
      }))
    )
  },

  consumeProjectCreation: () => set({ pendingProjectCreation: false }),

  // Mentions never route between Projects. Keeping this guard at the Navigation boundary prevents a
  // dialog caller from leaking an Artifact locator into whichever composer happens to mount next.
  requestArtifactMention: (file) =>
    set((state) =>
      state.view === 'workspace' && state.activeProjectId === file.projectId
        ? { pendingArtifactMention: file }
        : state
    ),

  consumeArtifactMention: () => {
    const file = get().pendingArtifactMention
    set({ pendingArtifactMention: undefined })
    return file
  },

  consumeLiteratureItem: (expectedItemId) => {
    const itemId = get().pendingLiteratureItemId
    if (expectedItemId !== undefined && itemId !== expectedItemId) return undefined
    set({ pendingLiteratureItemId: undefined })
    return itemId
  },

  consumeLiteratureProject: (expectedProjectId) => {
    const projectId = get().pendingLiteratureProjectId
    if (expectedProjectId !== undefined && projectId !== expectedProjectId) return undefined
    set({ pendingLiteratureProjectId: undefined })
    return projectId
  },

  consumeLiteratureCollection: (expectedCollectionId) => {
    const collectionId = get().pendingLiteratureCollectionId
    if (expectedCollectionId !== undefined && collectionId !== expectedCollectionId)
      return undefined
    set({ pendingLiteratureCollectionId: undefined })
    return collectionId
  },

  setArtifactMentionAvailability: (availability) =>
    set({ artifactMentionAvailability: availability })
}))

// Notification surfaces can appear before the startup Project query finishes. Wait for an
// authoritative list before accepting or rejecting the target so a transient empty cache neither
// loses a valid click nor consumes a notification for a deleted or archived Project.
export const openNotificationProject = async (
  projectId: string,
  afterNavigate?: () => void
): Promise<boolean> => {
  const projectState = useProjectStore.getState()
  if (!projectState.isLoaded || projectState.loadError !== undefined) {
    await projectState.loadProjects()
  }

  const loadedProjectState = useProjectStore.getState()
  if (!loadedProjectState.isLoaded || loadedProjectState.loadError !== undefined) return false

  return useNavigationStore.getState().openProject(projectId, 'notification', afterNavigate)
}

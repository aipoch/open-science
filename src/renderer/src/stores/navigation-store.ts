import { create } from 'zustand'

import { useSessionStore } from './session-store'

export type NavigationView = 'home' | 'workspace'
export type NavigationOrigin = 'user' | 'notification' | 'automatic'

type NavigationStore = {
  view: NavigationView
  activeProjectId: string | undefined
  // Advances only for explicit user navigation. Deferred startup intents observe this instead of
  // treating lifecycle/deep-link redirects as user choices.
  userNavigationRevision: number
  // Advances when an explicit navigation intent should supersede a deferred startup deep link.
  // Desktop-notification clicks count here, but not as in-app user navigation above.
  explicitNavigationRevision: number
  recordUserNavigation: () => void
  goHome: (origin: NavigationOrigin) => void
  openProject: (projectId: string, origin: NavigationOrigin) => void
  openSession: (projectId: string, sessionId: string, origin: NavigationOrigin) => void
  // Opens a session knowing only its id (e.g. a desktop-notification click); a no-op when the
  // session no longer exists or hasn't loaded yet.
  openSessionById: (sessionId: string, origin: NavigationOrigin) => void
}

const navigationState = (
  state: NavigationStore,
  origin: NavigationOrigin,
  next: Pick<NavigationStore, 'view'> & Partial<Pick<NavigationStore, 'activeProjectId'>>
): Pick<
  NavigationStore,
  'view' | 'activeProjectId' | 'userNavigationRevision' | 'explicitNavigationRevision'
> => ({
  activeProjectId: state.activeProjectId,
  userNavigationRevision:
    origin === 'user' ? state.userNavigationRevision + 1 : state.userNavigationRevision,
  explicitNavigationRevision:
    origin === 'automatic'
      ? state.explicitNavigationRevision
      : state.explicitNavigationRevision + 1,
  ...next
})

// Picks the most recently updated non-pending session in a project so opening a project lands on its
// latest conversation instead of a blank workspace.
const findMostRecentSessionId = (projectId: string): string | undefined =>
  useSessionStore
    .getState()
    .sessions.filter((session) => session.projectId === projectId && !session.isPending)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id

// Owns which top-level screen is visible and which project the workspace is scoped to. Session
// selection stays in the session store; this store coordinates it when navigating.
export const useNavigationStore = create<NavigationStore>((set) => ({
  view: 'home',
  activeProjectId: undefined,
  userNavigationRevision: 0,
  explicitNavigationRevision: 0,

  // Records user-owned navigation that changes another store (for example, opening the local New
  // Conversation draft clears Session selection without changing the top-level view).
  recordUserNavigation: () =>
    set((state) => ({
      userNavigationRevision: state.userNavigationRevision + 1,
      explicitNavigationRevision: state.explicitNavigationRevision + 1
    })),

  // Returns to the home screen without discarding session state.
  goHome: (origin) => set((state) => navigationState(state, origin, { view: 'home' })),

  // Enters a project's workspace, selecting its most recent session when one exists.
  openProject: (projectId, origin) => {
    const mostRecentSessionId = findMostRecentSessionId(projectId)

    if (mostRecentSessionId) {
      useSessionStore.getState().selectSession(mostRecentSessionId)
    } else {
      useSessionStore.getState().clearSelection()
    }

    set((state) =>
      navigationState(state, origin, { view: 'workspace', activeProjectId: projectId })
    )
  },

  // Opens a specific session inside its project's workspace.
  openSession: (projectId, sessionId, origin) => {
    useSessionStore.getState().selectSession(sessionId)

    set((state) =>
      navigationState(state, origin, { view: 'workspace', activeProjectId: projectId })
    )
  },

  // Resolves the session's project from the session store, then navigates exactly like
  // openSession. Unknown ids stay put: a notification for a deleted conversation must not
  // yank the user to a blank workspace.
  openSessionById: (sessionId, origin) => {
    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)

    if (!session) return

    useSessionStore.getState().selectSession(sessionId)

    set((state) =>
      navigationState(state, origin, {
        view: 'workspace',
        activeProjectId: session.projectId
      })
    )
  }
}))

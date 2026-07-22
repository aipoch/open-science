import { create } from 'zustand'

import { useSessionStore } from './session-store'

export type NavigationView = 'home' | 'workspace'

type NavigationStore = {
  view: NavigationView
  activeProjectId: string | undefined
  goHome: () => void
  openProject: (projectId: string) => void
  openSession: (projectId: string, sessionId: string) => void
  // Opens a session knowing only its id (e.g. a desktop-notification click); a no-op when the
  // session no longer exists or hasn't loaded yet.
  openSessionById: (sessionId: string) => void
}

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

  // Returns to the home screen without discarding session state.
  goHome: () => set({ view: 'home' }),

  // Enters a project's workspace, selecting its most recent session when one exists.
  openProject: (projectId) => {
    const mostRecentSessionId = findMostRecentSessionId(projectId)

    if (mostRecentSessionId) {
      useSessionStore.getState().selectSession(mostRecentSessionId)
    } else {
      useSessionStore.getState().clearSelection()
    }

    set({ view: 'workspace', activeProjectId: projectId })
  },

  // Opens a specific session inside its project's workspace.
  openSession: (projectId, sessionId) => {
    useSessionStore.getState().selectSession(sessionId)

    set({ view: 'workspace', activeProjectId: projectId })
  },

  // Resolves the session's project from the session store, then navigates exactly like
  // openSession. Unknown ids stay put: a notification for a deleted conversation must not
  // yank the user to a blank workspace.
  openSessionById: (sessionId) => {
    const session = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)

    if (!session) return

    useSessionStore.getState().selectSession(sessionId)

    set({ view: 'workspace', activeProjectId: session.projectId })
  }
}))

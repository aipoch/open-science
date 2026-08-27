import { useCallback, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '@/lib/session-persistence/session-persistence'
import { useSessionStore } from '@/stores/session-store'

import { NO_VISIBLE_SESSIONS, visibleProjectSessions } from './visible-project-sessions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

type WorkspaceSidebarContainerProps = Omit<
  React.ComponentProps<typeof WorkspaceSidebar>,
  'sessions' | 'starNudgeKey' | 'onPreviewSession'
> & {
  projectId: string
  isProjectArchived: boolean
}

// Owns the live session-list subscription so per-chunk session commits re-render the sidebar
// (status dots, sectioning) without re-rendering the whole page. useShallow keeps the filtered
// list stable across commits that only touch other projects' sessions.
const WorkspaceSidebarContainer = ({
  projectId,
  isProjectArchived,
  ...sidebarProps
}: WorkspaceSidebarContainerProps): React.JSX.Element => {
  const previewLoadsRef = useRef(new Map<string, Promise<void>>())
  const sessions = useSessionStore(
    useShallow((state) =>
      isProjectArchived ? NO_VISIBLE_SESSIONS : visibleProjectSessions(state.sessions, projectId)
    )
  )
  const loadPreviewSession = useCallback(
    (sessionId: string): Promise<void> | void => {
      const session = useSessionStore
        .getState()
        .sessions.find(
          (candidate) => candidate.id === sessionId && candidate.projectId === projectId
        )
      if (!session || session.contentLoaded !== false) return

      const pending = previewLoadsRef.current.get(sessionId)
      if (pending) return pending

      const load = loadPersistedSession({ projectId, sessionId })
        .then((persisted) => {
          if (persisted) hydratePersistedSessionIfPresent(persisted)
        })
        .catch(() => undefined)
        .finally(() => {
          previewLoadsRef.current.delete(sessionId)
        })
      previewLoadsRef.current.set(sessionId, load)
      return load
    },
    [projectId]
  )

  return (
    <WorkspaceSidebar
      {...sidebarProps}
      starNudgeKey={projectId}
      sessions={sessions}
      onPreviewSession={loadPreviewSession}
    />
  )
}

export { WorkspaceSidebarContainer }

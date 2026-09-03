import { useCallback, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'

import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '@/lib/session-persistence/session-persistence'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'

import { NO_VISIBLE_SESSIONS, visibleProjectSessions } from './visible-project-sessions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

type WorkspaceSidebarContainerProps = Omit<
  React.ComponentProps<typeof WorkspaceSidebar>,
  'sessions' | 'starNudgeKey' | 'onPreviewSession' | 'otherProjects' | 'onOpenProject'
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
  onMobileClose,
  ...sidebarProps
}: WorkspaceSidebarContainerProps): React.JSX.Element => {
  const previewLoadsRef = useRef(new Map<string, Promise<void>>())
  const sessions = useSessionStore(
    useShallow((state) =>
      isProjectArchived ? NO_VISIBLE_SESSIONS : visibleProjectSessions(state.sessions, projectId)
    )
  )
  const pendingCredentialRequests = useSettingsStore((state) => state.pendingCredentialRequests)
  const credentialPendingSessionIds = useMemo(
    () =>
      new Set(
        pendingCredentialRequests.flatMap((request) =>
          request.sessionId ? [request.sessionId] : []
        )
      ),
    [pendingCredentialRequests]
  )
  const otherProjects = useProjectStore(
    useShallow((state) =>
      state.projects.filter(
        (project) => project.id !== projectId && project.archivedAt === undefined
      )
    )
  )
  const openProject = useNavigationStore((state) => state.openProject)
  const handleOpenProject = useCallback(
    (targetProjectId: string): void => {
      openProject(targetProjectId, 'user', onMobileClose)
    },
    [onMobileClose, openProject]
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
      onMobileClose={onMobileClose}
      starNudgeKey={projectId}
      sessions={sessions}
      credentialPendingSessionIds={credentialPendingSessionIds}
      otherProjects={otherProjects}
      onOpenProject={handleOpenProject}
      onPreviewSession={loadPreviewSession}
    />
  )
}

export { WorkspaceSidebarContainer }

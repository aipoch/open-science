import { useCallback, useMemo, useRef, useState } from 'react'
import { openProjectWorkspace } from './project-workspace-entry'
import { useShallow } from 'zustand/react/shallow'

import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '@/lib/session-persistence/session-persistence'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useResearchDemoCarriers } from '@/stores/research-demo-store'

import { NO_VISIBLE_SESSIONS, visibleProjectSessions } from './visible-project-sessions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

type WorkspaceSidebarContainerProps = Omit<
  React.ComponentProps<typeof WorkspaceSidebar>,
  'sessions' | 'onPreviewSession' | 'otherProjects' | 'onOpenProject'
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
  const demoCarriers = useResearchDemoCarriers(
    [projectId],
    sessions.map((session) => session.id).join(',')
  )
  const visibleSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          session.id === sidebarProps.activeSessionId ||
          !demoCarriers[projectId]?.some((carrier) => carrier.sessionId === session.id)
      ),
    [sessions, projectId, demoCarriers, sidebarProps.activeSessionId]
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
  const [projectEntryFailed, setProjectEntryFailed] = useState(false)
  const handleOpenProject = useCallback(
    (targetProjectId: string): void => {
      setProjectEntryFailed(false)
      void openProjectWorkspace(targetProjectId, onMobileClose).catch(() =>
        setProjectEntryFailed(true)
      )
    },
    [onMobileClose]
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
      importProjectId={projectId}
      onMobileClose={onMobileClose}
      sessions={visibleSessions}
      credentialPendingSessionIds={credentialPendingSessionIds}
      otherProjects={otherProjects}
      onOpenProject={handleOpenProject}
      projectEntryFailed={projectEntryFailed}
      onDismissProjectEntryError={() => setProjectEntryFailed(false)}
      onPreviewSession={loadPreviewSession}
    />
  )
}

export { WorkspaceSidebarContainer }

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { loadSessionHistoryPage } from '@/lib/session-persistence/session-history'
import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { ResearchVideoActiveSession } from '../../../../shared/research-video-presentation'

import { NO_VISIBLE_SESSIONS, visibleProjectSessions } from './visible-project-sessions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set()

const useActiveFilmSessionIds = (projectId: string): ReadonlySet<string> => {
  const connected = useDesktopRuntimeRecoveryStore((state) => state.phase === 'connected')
  const epoch = useDesktopRuntimeRecoveryStore((state) => state.epoch)
  const [snapshot, setSnapshot] = useState<{
    epoch: number
    sessions: readonly ResearchVideoActiveSession[]
  }>()

  useEffect(() => {
    const researchVideo = window.api?.researchVideo
    if (!connected || !researchVideo?.activeSessions || !researchVideo.onActivityChanged) return
    let subscribed = true
    let changed = false
    const apply = (sessions: readonly ResearchVideoActiveSession[]): void => {
      if (subscribed) setSnapshot({ epoch, sessions })
    }
    const remove = researchVideo.onActivityChanged((next) => {
      changed = true
      apply(next)
    })
    void researchVideo
      .activeSessions()
      .then((next) => {
        // A live transition already owns a newer projection than this initial read.
        if (!changed) apply(next)
      })
      .catch(() => undefined)
    return () => {
      subscribed = false
      remove()
    }
  }, [connected, epoch])

  return useMemo(() => {
    if (!connected || snapshot?.epoch !== epoch) return EMPTY_SESSION_IDS
    const ids = snapshot.sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => session.sessionId)
    return ids.length ? new Set(ids) : EMPTY_SESSION_IDS
  }, [connected, epoch, projectId, snapshot])
}

type WorkspaceSidebarContainerProps = Omit<
  React.ComponentProps<typeof WorkspaceSidebar>,
  'sessions' | 'onPreviewSession' | 'otherProjects' | 'onOpenProject' | 'activeFilmSessionIds'
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
  const activeFilmSessionIds = useActiveFilmSessionIds(projectId)
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
          request.sessionId && !request.closed ? [request.sessionId] : []
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
      if (!session || session.contentLoaded !== false || session.historyPage) return

      const pending = previewLoadsRef.current.get(sessionId)
      if (pending) return pending

      const load = loadSessionHistoryPage({ projectId, sessionId })
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
      sessions={sessions}
      credentialPendingSessionIds={credentialPendingSessionIds}
      activeFilmSessionIds={activeFilmSessionIds}
      otherProjects={otherProjects}
      onOpenProject={handleOpenProject}
      onPreviewSession={loadPreviewSession}
    />
  )
}

export { WorkspaceSidebarContainer }

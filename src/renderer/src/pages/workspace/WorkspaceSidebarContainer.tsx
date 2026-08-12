import { useShallow } from 'zustand/react/shallow'

import { useSessionStore } from '@/stores/session-store'

import { NO_VISIBLE_SESSIONS, visibleProjectSessions } from './visible-project-sessions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

type WorkspaceSidebarContainerProps = Omit<
  React.ComponentProps<typeof WorkspaceSidebar>,
  'sessions'
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
  const sessions = useSessionStore(
    useShallow((state) =>
      isProjectArchived ? NO_VISIBLE_SESSIONS : visibleProjectSessions(state.sessions, projectId)
    )
  )
  return <WorkspaceSidebar {...sidebarProps} sessions={sessions} />
}

export { WorkspaceSidebarContainer }

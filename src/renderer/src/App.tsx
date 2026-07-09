import { useEffect } from 'react'

import { useSessionPersistence } from '@/lib/session-persistence/session-persistence'
import { HomePage } from '@/pages/home/HomePage'
import { WorkspacePage } from '@/pages/workspace/WorkspacePage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'

const App = (): React.JSX.Element => {
  // Persistence is started once at the top so sessions stay loaded for both Home and Workspace.
  const isSessionPersistenceReady = useSessionPersistence()
  const view = useNavigationStore((state) => state.view)
  const loadProjects = useProjectStore((state) => state.loadProjects)

  // Load the project list once on startup so Home can render immediately after hydration.
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  if (view === 'home') {
    return <HomePage />
  }

  return <WorkspacePage isSessionPersistenceReady={isSessionPersistenceReady} />
}

export default App

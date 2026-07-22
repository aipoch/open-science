import { useEffect, useRef, useState } from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'

type DeepLinkParams = {
  projectId: string | undefined
  sessionId: string | undefined
}

const isWebLocation = (): boolean =>
  typeof window !== 'undefined' &&
  (window.location.protocol === 'http:' || window.location.protocol === 'https:')

const readDeepLinkParams = (search = window.location.search): DeepLinkParams => {
  const params = new URLSearchParams(search)

  return {
    projectId: params.get('project') || undefined,
    sessionId: params.get('session') || undefined
  }
}

const replaceNavigationParams = (
  view: 'home' | 'workspace',
  projectId: string | undefined,
  sessionId: string | undefined
): void => {
  if (!isWebLocation()) return

  const url = new URL(window.location.href)
  url.searchParams.delete('project')
  url.searchParams.delete('session')

  if (view === 'workspace' && projectId) {
    url.searchParams.set('project', projectId)
    if (sessionId) url.searchParams.set('session', sessionId)
  }

  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

// Applies the initial URL only after both persisted data sources are ready, then keeps navigation
// reflected in the address bar without introducing a client-side router.
const useDeepLinkNavigation = (isSessionPersistenceReady: boolean): void => {
  const isProjectsLoaded = useProjectStore((state) => state.isLoaded)
  const initialParams = useRef<DeepLinkParams | undefined>(
    isWebLocation() ? readDeepLinkParams() : undefined
  )
  const initialized = useRef(!isWebLocation())
  const [isInitialized, setIsInitialized] = useState(() => !isWebLocation())

  useEffect(() => {
    if (initialized.current || !isProjectsLoaded || !isSessionPersistenceReady) return

    initialized.current = true
    const { projectId, sessionId } = initialParams.current ?? {}
    const projectExists = useProjectStore
      .getState()
      .projects.some((project) => project.id === projectId)
    const sessionExists =
      projectExists &&
      sessionId !== undefined &&
      useSessionStore
        .getState()
        .sessions.some((session) => session.id === sessionId && session.projectId === projectId)

    if (projectId && sessionId && sessionExists) {
      useNavigationStore.getState().openSession(projectId, sessionId)
    } else {
      useNavigationStore.getState().goHome()
    }

    setIsInitialized(true)
  }, [isProjectsLoaded, isSessionPersistenceReady])

  useEffect(() => {
    if (!isInitialized) return

    const syncUrl = (): void => {
      const navigation = useNavigationStore.getState()
      replaceNavigationParams(
        navigation.view,
        navigation.activeProjectId,
        useSessionStore.getState().selectedSessionId
      )
    }

    syncUrl()
    const unsubscribeNavigation = useNavigationStore.subscribe(syncUrl)
    const unsubscribeSession = useSessionStore.subscribe((state, previousState) => {
      if (state.selectedSessionId !== previousState.selectedSessionId) syncUrl()
    })

    return () => {
      unsubscribeNavigation()
      unsubscribeSession()
    }
  }, [isInitialized])
}

export { isWebLocation, readDeepLinkParams, replaceNavigationParams, useDeepLinkNavigation }
export type { DeepLinkParams }

import { useEffect, useRef, useState } from 'react'

import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'

type DeepLinkParams = {
  projectId: string | undefined
  sessionId: string | undefined
}

type DeepLinkNavigationReadiness = {
  isHydrated: boolean
  isReady: boolean
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

// Opens already-hydrated targets during recovery, but retains unresolved initial parameters until a
// complete Session scan can distinguish a missing target from one that was temporarily omitted.
const useDeepLinkNavigation = ({ isHydrated, isReady }: DeepLinkNavigationReadiness): void => {
  const isProjectsLoaded = useProjectStore((state) => state.isLoaded)
  const projectLoadError = useProjectStore((state) => state.loadError)
  const initialParams = useRef<DeepLinkParams | undefined>(
    isWebLocation() ? readDeepLinkParams() : undefined
  )
  const initialized = useRef(!isWebLocation())
  const [isInitialized, setIsInitialized] = useState(() => !isWebLocation())

  // While an initial target is deferred by partial recovery, an explicit in-app or notification
  // navigation takes control. Drop the stale target so later loading cannot override that choice.
  // Lifecycle redirects and Session hydration do not advance this revision.
  useEffect(() => {
    if (isInitialized) return

    return useNavigationStore.subscribe((state, previousState) => {
      if (
        initialized.current ||
        state.explicitNavigationRevision === previousState.explicitNavigationRevision
      ) {
        return
      }

      initialized.current = true
      initialParams.current = undefined
      setIsInitialized(true)
    })
  }, [isInitialized])

  useEffect(() => {
    if (initialized.current || !isProjectsLoaded || projectLoadError !== undefined || !isHydrated) {
      return
    }

    const { projectId, sessionId } = initialParams.current ?? {}

    // No launch target means this hook has nothing to resolve. Preserve navigation that may already
    // have been applied by a desktop-notification click while projects were still loading.
    if (!projectId && !sessionId) {
      initialized.current = true
      setIsInitialized(true)
      return
    }

    const projectExists = useProjectStore
      .getState()
      .projects.some((project) => project.id === projectId && project.archivedAt === undefined)
    const sessionExists =
      projectExists &&
      sessionId !== undefined &&
      useSessionStore
        .getState()
        .sessions.some(
          (session) =>
            session.id === sessionId &&
            session.projectId === projectId &&
            session.archivedAt === undefined
        )

    if (projectId && sessionId && sessionExists) {
      initialized.current = true
      useNavigationStore.getState().openSession(projectId, sessionId, 'automatic')
    } else if (projectId && sessionId && projectExists && !isReady) {
      return
    } else {
      initialized.current = true
      useNavigationStore.getState().goHome('automatic')
    }

    setIsInitialized(true)
  }, [isHydrated, isProjectsLoaded, isReady, projectLoadError])

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
export type { DeepLinkNavigationReadiness, DeepLinkParams }

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import type { SessionUpsertEvent } from '../../../shared/lifecycle-events'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'

type ExternalSessionNotice = {
  projectId: string
  sessionId: string
  title: string
}

type LifecycleSyncResult = {
  notice: ExternalSessionNotice | undefined
  dismissNotice: () => void
  viewNotice: () => void
}

type LifecycleSyncOptions = {
  isSessionPersistenceReady: boolean
}

const useLifecycleSync = ({
  isSessionPersistenceReady
}: LifecycleSyncOptions): LifecycleSyncResult => {
  const [notice, setNotice] = useState<ExternalSessionNotice | undefined>()
  const isProjectPersistenceReady = useProjectStore((state) => state.isLoaded)
  const isHydrated = isSessionPersistenceReady && isProjectPersistenceReady
  const isHydratedRef = useRef(isHydrated)
  const lifecycleClientIdRef = useRef<string | null | undefined>(undefined)
  const pendingActionsRef = useRef<Array<() => void>>([])

  const flushPendingActions = useCallback((): void => {
    if (!isHydratedRef.current || lifecycleClientIdRef.current === undefined) return

    const pendingActions = pendingActionsRef.current.splice(0)
    for (const action of pendingActions) action()
  }, [])

  useLayoutEffect(() => {
    isHydratedRef.current = isHydrated
    flushPendingActions()
  }, [flushPendingActions, isHydrated])

  useLayoutEffect(() => {
    let isSubscribed = true
    const applyOrQueue = (action: () => void): void => {
      if (isHydratedRef.current && lifecycleClientIdRef.current !== undefined) action()
      else pendingActionsRef.current.push(action)
    }
    void window.api.lifecycle
      .getClientId()
      .then((clientId) => {
        if (!isSubscribed) return
        lifecycleClientIdRef.current = clientId
        flushPendingActions()
      })
      .catch((error: unknown) => {
        if (!isSubscribed) return
        console.warn('Unable to identify lifecycle client', error)
        lifecycleClientIdRef.current = null
        flushPendingActions()
      })
    const removeProjectCreated = window.api.projects.onCreated((project) => {
      applyOrQueue(() => useProjectStore.getState().upsertProject(project))
    })
    const removeProjectUpdated = window.api.projects.onUpdated((project) => {
      applyOrQueue(() => useProjectStore.getState().upsertProject(project))
    })
    const removeProjectDeleted = window.api.projects.onDeleted(({ projectId }) => {
      applyOrQueue(() => {
        useProjectStore.getState().removeProject(projectId)
        useSessionStore.getState().removeSessionsForProject(projectId)
        if (useNavigationStore.getState().activeProjectId === projectId) {
          useNavigationStore.getState().goHome()
        }
        setNotice((current) => (current?.projectId === projectId ? undefined : current))
      })
    })
    const removeSessionCreated = window.api.sessions.onCreated(
      ({ session, originClientId }: SessionUpsertEvent) => {
        applyOrQueue(() => {
          useSessionStore.getState().upsertPersistedSession(session)

          if (originClientId !== lifecycleClientIdRef.current) {
            setNotice({
              projectId: session.projectId,
              sessionId: session.id,
              title: session.title
            })
          }
        })
      }
    )
    const removeSessionUpdated = window.api.sessions.onUpdated(({ session }) => {
      applyOrQueue(() => useSessionStore.getState().upsertPersistedSession(session))
    })
    const removeSessionDeleted = window.api.sessions.onDeleted(({ sessionId }) => {
      applyOrQueue(() => {
        useSessionStore.getState().deleteSession(sessionId)
        setNotice((current) => (current?.sessionId === sessionId ? undefined : current))
      })
    })

    return () => {
      isSubscribed = false
      removeProjectCreated()
      removeProjectUpdated()
      removeProjectDeleted()
      removeSessionCreated()
      removeSessionUpdated()
      removeSessionDeleted()
      pendingActionsRef.current = []
    }
  }, [flushPendingActions])

  const dismissNotice = useCallback(() => setNotice(undefined), [])
  const viewNotice = useCallback(() => {
    if (!notice) return
    useNavigationStore.getState().openSession(notice.projectId, notice.sessionId)
    setNotice(undefined)
  }, [notice])

  return { notice, dismissNotice, viewNotice }
}

export { useLifecycleSync }
export type { ExternalSessionNotice, LifecycleSyncOptions, LifecycleSyncResult }

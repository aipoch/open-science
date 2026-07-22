import { useCallback, useEffect, useState } from 'react'

import type { SessionSavedEvent } from '../../../shared/lifecycle-events'
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

const useLifecycleSync = (): LifecycleSyncResult => {
  const [notice, setNotice] = useState<ExternalSessionNotice | undefined>()

  useEffect(() => {
    const removeProjectCreated = window.api.projects.onCreated((project) => {
      useProjectStore.getState().upsertProject(project)
    })
    const removeProjectUpdated = window.api.projects.onUpdated((project) => {
      useProjectStore.getState().upsertProject(project)
    })
    const removeProjectDeleted = window.api.projects.onDeleted(({ projectId }) => {
      useProjectStore.getState().removeProject(projectId)
      useSessionStore.getState().removeSessionsForProject(projectId)
      if (useNavigationStore.getState().activeProjectId === projectId) {
        useNavigationStore.getState().goHome()
      }
      setNotice((current) => (current?.projectId === projectId ? undefined : current))
    })
    const removeSessionSaved = window.api.sessions.onSaved(
      ({ session, created }: SessionSavedEvent) => {
        const existed = useSessionStore
          .getState()
          .sessions.some((candidate) => candidate.id === session.id)
        useSessionStore.getState().upsertPersistedSession(session)

        if (created && !existed) {
          setNotice({
            projectId: session.projectId,
            sessionId: session.id,
            title: session.title
          })
        }
      }
    )
    const removeSessionDeleted = window.api.sessions.onDeleted(({ sessionId }) => {
      useSessionStore.getState().deleteSession(sessionId)
      setNotice((current) => (current?.sessionId === sessionId ? undefined : current))
    })

    return () => {
      removeProjectCreated()
      removeProjectUpdated()
      removeProjectDeleted()
      removeSessionSaved()
      removeSessionDeleted()
    }
  }, [])

  const dismissNotice = useCallback(() => setNotice(undefined), [])
  const viewNotice = useCallback(() => {
    if (!notice) return
    useNavigationStore.getState().openSession(notice.projectId, notice.sessionId)
    setNotice(undefined)
  }, [notice])

  return { notice, dismissNotice, viewNotice }
}

export { useLifecycleSync }
export type { ExternalSessionNotice, LifecycleSyncResult }

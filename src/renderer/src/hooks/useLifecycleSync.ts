import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import {
  MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
  MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID,
  MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID,
  MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID,
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
  MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID,
  MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID,
  type SessionUpsertEvent
} from '../../../shared/lifecycle-events'
import { useNavigationStore } from '@/stores/navigation-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
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
  isSessionPersistenceHydrated: boolean
}

type PendingLifecycleAction = {
  isDeletion: boolean
  creationOriginClientId: string | undefined
  run: (context: PendingLifecycleContext) => void
}

type PendingLifecycleContext = {
  coalescedCreationOriginClientId?: string
}

type QueueLifecycleOptions = {
  isDeletion?: boolean
  creationOriginClientId?: string
}

const useLifecycleSync = ({
  isSessionPersistenceHydrated
}: LifecycleSyncOptions): LifecycleSyncResult => {
  const [notice, setNotice] = useState<ExternalSessionNotice | undefined>()
  const isProjectPersistenceReady = useProjectStore((state) => state.isLoaded)
  const isHydrated = isSessionPersistenceHydrated && isProjectPersistenceReady
  const isHydratedRef = useRef(isHydrated)
  const lifecycleClientIdRef = useRef<string | null | undefined>(undefined)
  const pendingActionsRef = useRef(new Map<string, PendingLifecycleAction>())

  const flushPendingActions = useCallback((): void => {
    if (!isHydratedRef.current || lifecycleClientIdRef.current === undefined) return

    const pendingActions = [...pendingActionsRef.current.values()]
    pendingActionsRef.current.clear()
    for (const action of pendingActions) {
      action.run({ coalescedCreationOriginClientId: action.creationOriginClientId })
    }
  }, [])

  useLayoutEffect(() => {
    isHydratedRef.current = isHydrated
    flushPendingActions()
  }, [flushPendingActions, isHydrated])

  useLayoutEffect(() => {
    let isSubscribed = true
    const pendingActions = pendingActionsRef.current
    const applyOrQueue = (
      key: string,
      action: (context: PendingLifecycleContext) => void,
      options: QueueLifecycleOptions = {}
    ): void => {
      const isDeletion = options.isDeletion ?? false
      if (isHydratedRef.current && lifecycleClientIdRef.current !== undefined) action({})
      else {
        const current = pendingActions.get(key)
        if (!current?.isDeletion || isDeletion) {
          pendingActions.set(key, {
            isDeletion,
            creationOriginClientId: isDeletion
              ? undefined
              : (current?.creationOriginClientId ?? options.creationOriginClientId),
            run: action
          })
        }
      }
    }
    const showExternalSessionNotice = (
      session: SessionUpsertEvent['session'],
      originClientId: string
    ): void => {
      const lifecycleClientId = lifecycleClientIdRef.current
      if (lifecycleClientId === null || lifecycleClientId === undefined) return
      if (originClientId === lifecycleClientId) return
      setNotice({
        projectId: session.projectId,
        sessionId: session.id,
        title: session.title
      })
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
      applyOrQueue(`project:${project.id}`, () => useProjectStore.getState().upsertProject(project))
    })
    const removeProjectUpdated = window.api.projects.onUpdated((project) => {
      applyOrQueue(`project:${project.id}`, () => {
        useProjectStore.getState().upsertProject(project)
        useArchiveUndoStore.getState().reconcileProject(project)
        if (project.archivedAt !== undefined) {
          setNotice((current) => (current?.projectId === project.id ? undefined : current))
        }
        if (
          project.archivedAt !== undefined &&
          useNavigationStore.getState().activeProjectId === project.id
        ) {
          useSessionStore.getState().clearSelection()
          useNavigationStore.getState().goHome('automatic')
        }
      })
    })
    const removeProjectDeleted = window.api.projects.onDeleted(({ projectId, status }) => {
      applyOrQueue(
        `project:${projectId}`,
        () => {
          useProjectStore.getState().removeProject(projectId, { status })
          useSessionStore.getState().removeSessionsForProject(projectId)
          if (useNavigationStore.getState().activeProjectId === projectId) {
            useNavigationStore.getState().goHome('automatic')
          }
          setNotice((current) => (current?.projectId === projectId ? undefined : current))
        },
        { isDeletion: true }
      )
    })
    const removeProjectDeletionCleanupChanged = window.api.projects.onDeletionCleanupChanged(() => {
      void useProjectStore.getState().loadDeletionCleanup()
    })
    const removeSessionCreated = window.api.sessions.onCreated(
      ({ session, originClientId }: SessionUpsertEvent) => {
        applyOrQueue(
          `session:${session.id}`,
          () => {
            useSessionStore.getState().upsertPersistedSession(session)
            showExternalSessionNotice(session, originClientId)
          },
          { creationOriginClientId: originClientId }
        )
      }
    )
    const removeSessionUpdated = window.api.sessions.onUpdated(({ session, originClientId }) => {
      applyOrQueue(`session:${session.id}`, ({ coalescedCreationOriginClientId }) => {
        // The ordered persistence owner already applies this renderer's save result. Its lifecycle
        // echo may describe an earlier graph with a later main-owned timestamp, so replacing the
        // live projection here can discard a prompt and the Runtime Segment used by its artifact
        // claim. Events from other clients remain authoritative synchronization input; same-client
        // command results return through their direct IPC path.
        if (originClientId === MAIN_DELEGATION_POLICY_LIFECYCLE_CLIENT_ID) {
          useSessionStore.getState().applyDelegationPolicyAuthority(session)
        } else if (originClientId === MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID) {
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source) {
            store.applyDurableSessionProjection({
              source,
              session,
              mode: 'replace-persisted-if-current'
            })
          } else {
            store.upsertPersistedSession(session)
          }
        } else if (originClientId === MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID) {
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source) {
            store.applyDurableSessionProjection({
              source,
              session,
              mode: 'runtime-context-authority'
            })
          } else {
            store.upsertPersistedSession(session)
          }
        } else if (originClientId === MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID) {
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source) {
            store.applyDurableSessionProjection({
              source,
              session,
              mode: 'session-details-authority'
            })
          } else {
            store.upsertPersistedSession(session)
          }
        } else if (originClientId === MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID) {
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source) {
            store.applyDurableSessionProjection({
              source,
              session,
              mode: 'permission-authority'
            })
          } else {
            store.upsertPersistedSession(session)
          }
        } else if (originClientId === MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID) {
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source) {
            store.applyDurableSessionProjection({
              source,
              session,
              mode: 'delegated-authority'
            })
          } else {
            store.upsertPersistedSession(session)
          }
        } else if (originClientId === MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID) {
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source) {
            store.applyDurableSessionProjection({
              source,
              session,
              mode: 'compute-host-access-authority'
            })
          } else {
            store.upsertPersistedSession(session)
          }
        } else if (
          coalescedCreationOriginClientId !== undefined ||
          lifecycleClientIdRef.current === null ||
          originClientId !== lifecycleClientIdRef.current
        ) {
          useSessionStore.getState().upsertPersistedSession(session)
        } else {
          // Same-client echoes still carry archive authority, but must not replace local content.
          const store = useSessionStore.getState()
          const source = store.sessions.find((candidate) => candidate.id === session.id)
          if (source)
            store.applyDurableSessionProjection({ source, session, mode: 'archive-authority' })
        }
        if (coalescedCreationOriginClientId !== undefined) {
          showExternalSessionNotice(session, coalescedCreationOriginClientId)
        }
        const current = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === session.id)
        if (!current) return
        useArchiveUndoStore.getState().reconcileSession(current)
        if (
          current.archivedAt !== undefined &&
          useSessionStore.getState().selectedSessionId === session.id
        ) {
          useSessionStore.getState().clearSelection()
        }
        if (current.archivedAt !== undefined) {
          usePreviewWorkbenchStore.getState().removeSessionItems(session.id)
          setNotice((current) => (current?.sessionId === session.id ? undefined : current))
        }
      })
    })
    const removeSessionDeleted = window.api.sessions.onDeleted(({ sessionId }) => {
      applyOrQueue(
        `session:${sessionId}`,
        () => {
          useSessionStore.getState().deleteSession(sessionId)
          setNotice((current) => (current?.sessionId === sessionId ? undefined : current))
        },
        { isDeletion: true }
      )
    })

    return () => {
      isSubscribed = false
      removeProjectCreated()
      removeProjectUpdated()
      removeProjectDeleted()
      removeProjectDeletionCleanupChanged()
      removeSessionCreated()
      removeSessionUpdated()
      removeSessionDeleted()
      pendingActions.clear()
    }
  }, [flushPendingActions])

  const dismissNotice = useCallback(() => setNotice(undefined), [])
  const viewNotice = useCallback(() => {
    if (!notice) return
    useNavigationStore
      .getState()
      .openSession(notice.projectId, notice.sessionId, 'user', () => setNotice(undefined))
  }, [notice])

  return { notice, dismissNotice, viewNotice }
}

export { useLifecycleSync }
export type { ExternalSessionNotice, LifecycleSyncOptions, LifecycleSyncResult }

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import type { ConversationExportFormat } from '../../../../shared/conversation-export'
import type {
  CompletionHandoffLifecycleEvent,
  SpecialistListItem
} from '../../../../shared/specialist'
import { useNavigationStore } from '@/stores/navigation-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'

type ReconfigureError = {
  sessionId: string
  specialistName: string
  message: string
}

type WorkspaceSessionControllerOptions = {
  activeSession: ChatSession | undefined
  selectedSessionId: string | undefined
  isPersistenceHydrated: boolean
  isPersistenceReady: boolean
  canDeleteConversations: boolean
  specialistCatalogLoaded: boolean
  specialistItems: SpecialistListItem[]
  loadSpecialists: () => Promise<void>
  promptInFlightSessionIds: string[]
  sendPreparationInFlightSessionIds: string[]
  hasUnfinishedTransfers: (sessionId: string) => boolean
  beginSessionDeletion: (sessionId: string) => boolean
  settleSessionDeletion: (sessionId: string, deleted: boolean) => void
  deleteRuntimeSession: (sessionId: string) => Promise<boolean>
}

type SpecialistSendIntent = {
  draftSpecialistId: string | null | undefined
  hasPendingSwitch: boolean
  pendingSpecialistId: string | undefined
}

type WorkspaceSessionController = {
  view: {
    dialogs: {
      rename: { session: ChatSession; draft: string } | null
      delete: ChatSession | null
      downloadArtifacts: ChatSession | null
      notebook: ChatSession | null
      jobList: { open: boolean; sessionId: string }
    }
    exportError: string | null
    deletingIds: ReadonlySet<string>
    specialist: {
      newConversationId: string | undefined
      historyId: string | undefined
      unavailable: boolean
      hasPendingSwitch: boolean
      barrierInFlight: boolean
      reconfigureError: ReconfigureError | null
    }
  }
  actions: {
    clearExportError: () => void
    openRename: (session: ChatSession) => void
    closeRename: () => void
    changeRenameDraft: (draft: string) => void
    confirmRename: (event: FormEvent<HTMLFormElement>) => void
    togglePin: (session: ChatSession) => void
    archive: (session: ChatSession) => void
    exportConversation: (session: ChatSession, format: ConversationExportFormat) => void
    openDelete: (session: ChatSession) => void
    closeDelete: () => void
    confirmDelete: () => void
    openDownloadArtifacts: (session: ChatSession | null) => void
    closeDownloadArtifacts: () => void
    openNotebook: (session: ChatSession | null) => void
    closeNotebook: () => void
    openJobList: (sessionId: string) => void
    closeJobList: () => void
    selectSpecialist: (specialistId: string | undefined) => void
    resetNewConversationSpecialist: () => void
    beginReconfigureRetry: () => boolean
    chooseOtherSpecialist: () => void
    useMainAgent: () => void
  }
  lifecycle: {
    canArchive: (session: ChatSession) => boolean
    canStartSend: () => boolean
    captureSendIntent: (branchInNewSession: boolean) => SpecialistSendIntent
    prepareSpecialistSend: (sessionId: string, specialistId: string | undefined) => Promise<boolean>
    isBarrierInFlight: (sessionId: string) => boolean
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const compareHandoffEventOrder = (
  left: Pick<CompletionHandoffLifecycleEvent, 'commitOrder' | 'observedAt' | 'sequence' | 'id'>,
  right: Pick<CompletionHandoffLifecycleEvent, 'commitOrder' | 'observedAt' | 'sequence' | 'id'>
): number =>
  (left.commitOrder !== undefined || right.commitOrder !== undefined
    ? left.commitOrder === undefined
      ? -1
      : right.commitOrder === undefined
        ? 1
        : left.commitOrder - right.commitOrder
    : left.observedAt - right.observedAt) ||
  left.sequence - right.sequence ||
  left.id.localeCompare(right.id)

// Owns Workspace session transactions and Specialist identity without taking over message dispatch.
const useWorkspaceSessionController = ({
  activeSession,
  selectedSessionId,
  isPersistenceHydrated,
  isPersistenceReady,
  canDeleteConversations,
  specialistCatalogLoaded,
  specialistItems,
  loadSpecialists,
  promptInFlightSessionIds,
  sendPreparationInFlightSessionIds,
  hasUnfinishedTransfers,
  beginSessionDeletion,
  settleSessionDeletion,
  deleteRuntimeSession
}: WorkspaceSessionControllerOptions): WorkspaceSessionController => {
  const renameSession = useSessionStore((state) => state.renameSession)
  const togglePinned = useSessionStore((state) => state.togglePinned)
  const updateSessionArchive = useSessionStore((state) => state.updateSessionArchive)
  const clearSelection = useSessionStore((state) => state.clearSelection)
  const setSessionSpecialistId = useSessionStore((state) => state.setSessionSpecialistId)
  const markSpecialistSwitchResetRequired = useSessionStore(
    (state) => state.markSpecialistSwitchResetRequired
  )
  const enqueueSessionArchive = useArchiveUndoStore((state) => state.enqueueSession)

  const [newConversationSpecialistId, setNewConversationSpecialistId] = useState<
    string | undefined
  >(undefined)
  const [pendingSpecialists, setPendingSpecialists] = useState<Record<string, string | undefined>>(
    {}
  )
  const [reconfigureError, setReconfigureError] = useState<ReconfigureError | null>(null)
  const [barrierInFlightIds, setBarrierInFlightIds] = useState<ReadonlySet<string>>(new Set())
  const barrierInFlightRef = useRef(new Set<string>())
  const specialistItemsRef = useRef(specialistItems)

  const [exportError, setExportError] = useState<string | null>(null)
  const [renameDialog, setRenameDialog] = useState<{
    session: ChatSession
    draft: string
  } | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<ChatSession | null>(null)
  const [downloadArtifactsDialog, setDownloadArtifactsDialog] = useState<ChatSession | null>(null)
  const [notebookDialog, setNotebookDialog] = useState<ChatSession | null>(null)
  const [jobListDialog, setJobListDialog] = useState({ open: false, sessionId: '' })
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set())
  const [archivingIds, setArchivingIds] = useState<ReadonlySet<string>>(new Set())

  const activeHasPending = Boolean(
    activeSession && Object.hasOwn(pendingSpecialists, activeSession.id)
  )
  const historySpecialistId = activeSession
    ? activeHasPending
      ? pendingSpecialists[activeSession.id]
      : activeSession.specialistId
    : newConversationSpecialistId
  const newConversationSpecialistUnavailable =
    specialistCatalogLoaded &&
    newConversationSpecialistId !== undefined &&
    !specialistItems.some(
      (item) => item.kind === 'custom' && item.enabled && item.id === newConversationSpecialistId
    )
  const activeSpecialistUnavailable = activeSession
    ? specialistCatalogLoaded &&
      activeSession.specialistId !== undefined &&
      !activeHasPending &&
      !specialistItems.some(
        (item) => item.kind === 'custom' && item.enabled && item.id === activeSession.specialistId
      )
    : newConversationSpecialistUnavailable
  const activeHasPendingSwitch = Boolean(
    activeSession &&
    activeHasPending &&
    (activeSession.status === 'running' ||
      activeSession.status === 'waiting-for-user' ||
      activeSession.status === 'waiting-permission')
  )

  const setBarrier = useCallback((sessionId: string, inFlight: boolean): void => {
    if (inFlight) barrierInFlightRef.current.add(sessionId)
    else barrierInFlightRef.current.delete(sessionId)
    setBarrierInFlightIds((current) => {
      const next = new Set(current)
      if (inFlight) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])

  const clearPending = useCallback((sessionId: string): void => {
    setPendingSpecialists((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [])

  const canArchive = (session: ChatSession): boolean =>
    isPersistenceReady &&
    !session.isPending &&
    session.archivedAt === undefined &&
    !archivingIds.has(session.id) &&
    !deletingIds.has(session.id) &&
    !promptInFlightSessionIds.includes(session.id) &&
    !sendPreparationInFlightSessionIds.includes(session.id) &&
    session.status !== 'running' &&
    session.status !== 'waiting-for-user' &&
    session.status !== 'waiting-permission' &&
    session.status !== 'waiting-plan-approval' &&
    !hasUnfinishedTransfers(session.id)

  const openRename = (session: ChatSession): void => {
    if (isPersistenceReady) setRenameDialog({ session, draft: session.title })
  }

  const closeRename = (): void => setRenameDialog(null)

  const confirmRename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!isPersistenceReady || !renameDialog || renameDialog.draft.trim().length === 0) return
    renameSession(renameDialog.session.id, renameDialog.draft)
    closeRename()
  }

  const exportConversation = (session: ChatSession, format: ConversationExportFormat): void => {
    const exporter = window.api?.sessions?.exportConversation
    if (!exporter) return
    setExportError(null)
    void exporter({ projectId: session.projectId, sessionId: session.id, format }).catch(
      (error: unknown) => setExportError(errorMessage(error))
    )
  }

  const archive = (session: ChatSession): void => {
    if (!canArchive(session)) return
    setArchivingIds((current) => new Set(current).add(session.id))
    setExportError(null)
    void updateSessionArchive({
      projectId: session.projectId,
      sessionId: session.id,
      archived: true,
      expectedArchivedAt: null
    })
      .then((archived) => {
        enqueueSessionArchive(archived)
        if (selectedSessionId === session.id) clearSelection()
      })
      .catch((error: unknown) => setExportError(errorMessage(error)))
      .finally(() => {
        setArchivingIds((current) => {
          const next = new Set(current)
          next.delete(session.id)
          return next
        })
      })
  }

  const openDelete = (session: ChatSession): void => {
    if (isPersistenceHydrated && canDeleteConversations) setDeleteDialog(session)
  }

  const confirmDelete = (): void => {
    if (!isPersistenceHydrated || !canDeleteConversations || !deleteDialog) return
    useNavigationStore.getState().recordUserNavigation()
    const sessionId = deleteDialog.id
    if (!beginSessionDeletion(sessionId)) {
      setDeleteDialog(null)
      return
    }
    setDeletingIds((current) => new Set(current).add(sessionId))
    setDeleteDialog(null)
    void deleteRuntimeSession(sessionId).then((deleted) => {
      setDeletingIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      settleSessionDeletion(sessionId, deleted)
    })
  }

  const selectSpecialist = (specialistId: string | undefined): void => {
    if (!activeSession) {
      setNewConversationSpecialistId(specialistId)
      return
    }
    const sessionId = activeSession.id
    if (barrierInFlightRef.current.has(sessionId)) return
    const running =
      activeSession.status === 'running' ||
      activeSession.status === 'waiting-for-user' ||
      activeSession.status === 'waiting-permission'
    if (running) {
      setPendingSpecialists((current) => ({ ...current, [sessionId]: specialistId }))
    } else {
      const previousSpecialistId = activeSession.specialistId
      setSessionSpecialistId(sessionId, specialistId)
      clearPending(sessionId)
      void window.api?.specialist
        ?.setSessionSpecialist?.({ sessionId, specialistId })
        ?.then((result) => {
          if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
        })
        ?.catch((error: unknown) => {
          setSessionSpecialistId(sessionId, previousSpecialistId)
          console.warn('setSessionSpecialist failed', error)
        })
    }
    if (reconfigureError?.sessionId === sessionId) setReconfigureError(null)
  }

  const canStartSend = (): boolean => {
    if (!activeSession) return !newConversationSpecialistUnavailable
    if (barrierInFlightRef.current.has(activeSession.id)) return false
    if (activeSession.specialistId === undefined) return true
    if (!specialistCatalogLoaded) {
      void loadSpecialists()
      return false
    }
    return activeHasPending || !activeSpecialistUnavailable
  }

  const captureSendIntent = (branchInNewSession: boolean): SpecialistSendIntent => {
    const hasPending = Boolean(activeSession && Object.hasOwn(pendingSpecialists, activeSession.id))
    const pendingSpecialistId = activeSession ? pendingSpecialists[activeSession.id] : undefined
    return {
      draftSpecialistId: branchInNewSession
        ? hasPending
          ? (pendingSpecialistId ?? null)
          : activeSession?.specialistId
        : !activeSession
          ? newConversationSpecialistId
          : undefined,
      hasPendingSwitch: !branchInNewSession && hasPending,
      pendingSpecialistId
    }
  }

  const prepareSpecialistSend = async (
    sessionId: string,
    specialistId: string | undefined
  ): Promise<boolean> => {
    if (barrierInFlightRef.current.has(sessionId)) return false
    setBarrier(sessionId, true)
    try {
      const result = await window.api?.specialist?.setSessionSpecialist?.({
        sessionId,
        specialistId
      })
      if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
    } catch (error: unknown) {
      const pendingProfile = specialistItems.find(
        (item) => item.kind === 'custom' && item.id === specialistId
      )
      setReconfigureError({
        sessionId,
        specialistName:
          specialistId === undefined
            ? 'Main Agent'
            : pendingProfile?.kind === 'custom'
              ? pendingProfile.name
              : 'the selected specialist',
        message: errorMessage(error)
      })
      setBarrier(sessionId, false)
      return false
    }
    setSessionSpecialistId(sessionId, specialistId)
    clearPending(sessionId)
    setReconfigureError(null)
    setBarrier(sessionId, false)
    return true
  }

  const beginReconfigureRetry = (): boolean => {
    if (!reconfigureError || !Object.hasOwn(pendingSpecialists, reconfigureError.sessionId)) {
      setReconfigureError(null)
      return false
    }
    setReconfigureError(null)
    return true
  }

  const chooseOtherSpecialist = (): void => {
    if (!activeSession || !reconfigureError) return
    clearPending(activeSession.id)
    setReconfigureError(null)
  }

  const useMainAgent = (): void => {
    if (!activeSession || !reconfigureError) return
    const sessionId = activeSession.id
    const setter = window.api?.specialist?.setSessionSpecialist
    if (!setter || barrierInFlightRef.current.has(sessionId)) return
    setBarrier(sessionId, true)
    void setter({ sessionId, specialistId: undefined })
      .then((result) => {
        if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
        setSessionSpecialistId(sessionId, undefined)
        clearPending(sessionId)
        setReconfigureError(null)
      })
      .catch((error: unknown) => console.warn('setSessionSpecialist (none) failed', error))
      .finally(() => setBarrier(sessionId, false))
  }

  useEffect(() => {
    if (typeof window.api?.specialist?.list !== 'function') return
    void loadSpecialists()
    return window.api.specialist.onCatalogChanged(() => void loadSpecialists())
  }, [loadSpecialists])

  useEffect(() => {
    specialistItemsRef.current = specialistItems
  }, [specialistItems])

  useEffect(() => {
    const specialistApi = window.api?.specialist
    if (!specialistApi?.onPendingSwitch) return
    return specialistApi.onPendingSwitch((pending) => {
      if (pending.targetName === null) {
        setPendingSpecialists((current) => ({
          ...current,
          [pending.sessionId]: undefined
        }))
        return
      }
      const match = specialistItemsRef.current.find(
        (item) => item.kind === 'custom' && item.name === pending.targetName
      )
      if (match?.kind === 'custom') {
        setPendingSpecialists((current) => ({
          ...current,
          [pending.sessionId]: match.id
        }))
        return
      }
      const resolver = specialistApi.resolveSessionSpecialist
      if (!resolver) return
      void resolver
        .call(specialistApi, { sessionId: pending.sessionId })
        .then((resolution) => {
          if (resolution.kind === 'bound') {
            setPendingSpecialists((current) => ({
              ...current,
              [pending.sessionId]: resolution.profile.id
            }))
          }
        })
        .catch(() => undefined)
    })
  }, [])

  const applyHandoffLifecycleEvent = useCallback(
    (event: CompletionHandoffLifecycleEvent): void => {
      if (event.phase !== 'continuation-start' && event.phase !== 'continued') return
      const specialistApi = window.api?.specialist
      const resolver = specialistApi?.resolveSessionSpecialist
      if (!resolver) return
      void resolver
        .call(specialistApi, { sessionId: event.sessionId })
        .then((resolution) => {
          if (resolution.kind === 'bound') {
            setSessionSpecialistId(event.sessionId, resolution.profile.id)
          } else if (resolution.kind === 'main') {
            setSessionSpecialistId(event.sessionId, undefined)
          }
        })
        .catch(() => undefined)
    },
    [setSessionSpecialistId]
  )

  useEffect(() => {
    const specialistApi = window.api?.specialist
    if (!specialistApi?.onHandoffLifecycleEvent) return
    return specialistApi.onHandoffLifecycleEvent(applyHandoffLifecycleEvent)
  }, [applyHandoffLifecycleEvent])

  useEffect(() => {
    const specialistApi = window.api?.specialist
    if (!activeSession?.id || !specialistApi?.getHandoffEvents) return
    void specialistApi
      .getHandoffEvents(activeSession.id)
      .then((events) => {
        const latest = events.sort(compareHandoffEventOrder).at(-1)
        if (latest) applyHandoffLifecycleEvent(latest)
      })
      .catch(() => undefined)
  }, [activeSession?.id, applyHandoffLifecycleEvent])

  return {
    view: {
      dialogs: {
        rename: renameDialog,
        delete: deleteDialog,
        downloadArtifacts: downloadArtifactsDialog,
        notebook: notebookDialog,
        jobList: jobListDialog
      },
      exportError,
      deletingIds,
      specialist: {
        newConversationId: newConversationSpecialistId,
        historyId: historySpecialistId,
        unavailable: activeSpecialistUnavailable,
        hasPendingSwitch: activeHasPendingSwitch,
        barrierInFlight: barrierInFlightIds.has(activeSession?.id ?? ''),
        reconfigureError:
          reconfigureError?.sessionId === activeSession?.id ? reconfigureError : null
      }
    },
    actions: {
      clearExportError: () => setExportError(null),
      openRename,
      closeRename,
      changeRenameDraft: (draft: string) =>
        setRenameDialog((current) => (current ? { ...current, draft } : current)),
      confirmRename,
      togglePin: (session: ChatSession) => {
        if (isPersistenceReady) togglePinned(session.id)
      },
      archive,
      exportConversation,
      openDelete,
      closeDelete: () => setDeleteDialog(null),
      confirmDelete,
      openDownloadArtifacts: setDownloadArtifactsDialog,
      closeDownloadArtifacts: () => setDownloadArtifactsDialog(null),
      openNotebook: setNotebookDialog,
      closeNotebook: () => setNotebookDialog(null),
      openJobList: (sessionId: string) => setJobListDialog({ open: true, sessionId }),
      closeJobList: () => setJobListDialog((current) => ({ ...current, open: false })),
      selectSpecialist,
      resetNewConversationSpecialist: () => setNewConversationSpecialistId(undefined),
      beginReconfigureRetry,
      chooseOtherSpecialist,
      useMainAgent
    },
    lifecycle: {
      canArchive,
      canStartSend,
      captureSendIntent,
      prepareSpecialistSend,
      isBarrierInFlight: (sessionId: string) => barrierInFlightRef.current.has(sessionId)
    }
  }
}

export { useWorkspaceSessionController }
export type { ReconfigureError, SpecialistSendIntent, WorkspaceSessionController }

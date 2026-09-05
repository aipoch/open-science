import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent
} from 'react'
import { useTranslation } from 'react-i18next'

import type {
  DeleteSessionRequest,
  SessionDeletionResult
} from '../../../../shared/session-persistence'
import { isSessionSizeLimitError } from '../../../../shared/session-persistence'
import type {
  CompletionHandoffLifecycleEvent,
  SpecialistListItem
} from '../../../../shared/specialist'
import { useNavigationStore } from '@/stores/navigation-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { projectSessionActionability, useSessionStore } from '@/stores/session-store'
import type { ChatSession } from '@/stores/session-store'
import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '@/lib/session-persistence/session-persistence'

import {
  getWorkspaceSpecialistBarrierSnapshot,
  isWorkspaceSpecialistBarrierInFlight,
  setWorkspaceSpecialistBarrier,
  subscribeWorkspaceSpecialistBarriers
} from './workspace-specialist-barrier'
import {
  compareHandoffEventOrder,
  pendingSpecialistReconfigureError,
  specialistNameFor,
  useWorkspaceSpecialistReconfiguration,
  type WorkspaceSpecialistReconfigureError as ReconfigureError
} from './workspace-specialist-reconfiguration'
import { useWorkspaceSessionDetailsController } from './workspace-session-details-controller'
import { projectPresentedSessionActionability } from './session-wait-reason'

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
  saveAsSkillInFlightSessionIds: string[]
  hasUnfinishedTransfers: (sessionId: string) => boolean
  beginSessionDeletion: (sessionId: string) => boolean
  settleSessionDeletion: (sessionId: string, deleted: boolean) => void
  deleteSession: (request: DeleteSessionRequest) => Promise<SessionDeletionResult>
  onSessionSizeLimit?: (sessionId: string) => void
}
type SessionDeletionFailureReason = Extract<SessionDeletionResult, { status: 'failed' }>['reason']
type SessionDeleteDialogState = {
  session: ChatSession
  isDeleting: boolean
  error: SessionDeletionFailureReason | null
}
type SpecialistSendIntent = {
  draftSpecialistId: string | null | undefined
  hasPendingSwitch: boolean
  pendingSpecialistId: string | undefined
}
type WorkspaceSessionController = {
  view: {
    dialogs: {
      edit: {
        session: ChatSession
        titleDraft: string
        descriptionDraft: string
        isSaving: boolean
        error: string | null
      } | null
      delete: SessionDeleteDialogState | null
      downloadArtifacts: ChatSession | null
      notebook: ChatSession | null
      exportConversation: ChatSession | null
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
      sendAvailable: boolean
      reconfigureError: ReconfigureError | null
    }
  }
  actions: {
    clearExportError: () => void
    openEdit: (session: ChatSession) => void
    closeEdit: () => void
    changeEditTitleDraft: (draft: string) => void
    changeEditDescriptionDraft: (draft: string) => void
    confirmEdit: (event: FormEvent<HTMLFormElement>) => void
    renameTitle: (session: ChatSession, title: string, expectedTitle?: string) => Promise<boolean>
    togglePin: (session: ChatSession) => void
    archive: (session: ChatSession) => void
    openExportConversation: (session: ChatSession) => void
    closeExportConversation: () => void
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
    retrySpecialistSelection: () => boolean
    resetNewConversationSpecialist: () => void
    beginReconfigureRetry: () => boolean
    chooseOtherSpecialist: () => void
    useMainAgent: () => void
  }
  lifecycle: {
    canArchive: (session: ChatSession) => boolean
    canStartSend: (sessionId?: string) => boolean
    captureSendIntent: (branchInNewSession: boolean) => SpecialistSendIntent
    prepareSpecialistSend: (sessionId: string, specialistId: string | undefined) => Promise<boolean>
    isBarrierInFlight: (sessionId: string) => boolean
  }
}
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
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
  saveAsSkillInFlightSessionIds,
  hasUnfinishedTransfers,
  beginSessionDeletion,
  settleSessionDeletion,
  deleteSession,
  onSessionSizeLimit
}: WorkspaceSessionControllerOptions): WorkspaceSessionController => {
  const { t } = useTranslation()
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
  const reconfiguration = useWorkspaceSpecialistReconfiguration(specialistItems)
  const { error: reconfigureError, setError: setReconfigureError, clearIdleRetry } = reconfiguration
  const activeReconfigureError =
    reconfiguration.idleErrorFor(activeSession?.id) ??
    (reconfigureError?.sessionId === activeSession?.id ? reconfigureError : null)
  const barrierInFlightIds = useSyncExternalStore(
    subscribeWorkspaceSpecialistBarriers,
    getWorkspaceSpecialistBarrierSnapshot,
    getWorkspaceSpecialistBarrierSnapshot
  )
  const specialistItemsRef = useRef(specialistItems)
  const [exportError, setExportError] = useState<string | null>(null)
  const sessionDetails = useWorkspaceSessionDetailsController(
    isPersistenceReady,
    () => setExportError(t('Could not load this session for editing.')),
    onSessionSizeLimit
  )
  const [deleteDialog, setDeleteDialog] = useState<SessionDeleteDialogState | null>(null)
  const [downloadArtifactsDialog, setDownloadArtifactsDialog] = useState<ChatSession | null>(null)
  const [notebookDialog, setNotebookDialog] = useState<ChatSession | null>(null)
  const [exportConversationDialog, setExportConversationDialog] = useState<ChatSession | null>(null)
  const exportConversationIntentRef = useRef(0)
  const [jobListDialog, setJobListDialog] = useState({ open: false, sessionId: '' })
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set())
  const deletingIdsRef = useRef(new Set<string>())
  const [archivingIds, setArchivingIds] = useState<ReadonlySet<string>>(new Set())
  const activeHasPending = Boolean(
    activeSession &&
    (activeSession.specialistBindingPending === true ||
      Object.hasOwn(pendingSpecialists, activeSession.id))
  )
  const historySpecialistId = activeSession
    ? Object.hasOwn(pendingSpecialists, activeSession.id)
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
      !Object.hasOwn(pendingSpecialists, activeSession.id) &&
      activeSession.specialistId !== undefined &&
      !specialistItems.some(
        (item) => item.kind === 'custom' && item.enabled && item.id === activeSession.specialistId
      )
    : newConversationSpecialistUnavailable
  const specialistSendAvailable = activeSession
    ? activeSession.specialistBindingPending !== true &&
      (activeSession.specialistId === undefined ||
        (specialistCatalogLoaded && (activeHasPending || !activeSpecialistUnavailable)))
    : !newConversationSpecialistUnavailable
  const activeHasPendingSwitch = Boolean(
    activeSession &&
    activeHasPending &&
    projectSessionActionability(activeSession).activity !== 'inactive'
  )
  const setBarrier = useCallback((sessionId: string, inFlight: boolean): void => {
    setWorkspaceSpecialistBarrier(sessionId, inFlight)
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
    !session.compacting &&
    session.archivedAt === undefined &&
    !archivingIds.has(session.id) &&
    !deletingIds.has(session.id) &&
    !promptInFlightSessionIds.includes(session.id) &&
    !sendPreparationInFlightSessionIds.includes(session.id) &&
    !saveAsSkillInFlightSessionIds.includes(session.id) &&
    projectPresentedSessionActionability(session).actions.archive.allowed &&
    !hasUnfinishedTransfers(session.id)
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
        if (clearIdleRetry(session.id)) clearPending(session.id)
        enqueueSessionArchive(archived)
        if (selectedSessionId === session.id) clearSelection()
      })
      .catch((error: unknown) => {
        if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(session.id)
        setExportError(errorMessage(error))
      })
      .finally(() => {
        setArchivingIds((current) => {
          const next = new Set(current)
          next.delete(session.id)
          return next
        })
      })
  }
  const openDelete = (session: ChatSession): void => {
    if (isPersistenceHydrated && canDeleteConversations && deletingIdsRef.current.size === 0) {
      setDeleteDialog({
        session,
        isDeleting: false,
        error: null
      })
    }
  }
  const confirmDelete = (): void => {
    if (!isPersistenceHydrated || !canDeleteConversations || !deleteDialog) return
    useNavigationStore.getState().recordUserNavigation()
    const { session } = deleteDialog
    const sessionId = session.id
    if (deletingIdsRef.current.has(sessionId) || !beginSessionDeletion(sessionId)) return
    deletingIdsRef.current.add(sessionId)
    setDeletingIds((current) => new Set(current).add(sessionId))
    setDeleteDialog((current) =>
      current?.session.id === sessionId ? { ...current, isDeleting: true, error: null } : current
    )
    void deleteSession({ projectId: session.projectId, sessionId })
      .then((result) => {
        const deleted = result.status === 'deleted'
        settleSessionDeletion(sessionId, deleted)
        if (deleted) {
          if (result.cleanupPending)
            setExportError(t('The Session was deleted, but some cleanup could not be completed.'))
          if (clearIdleRetry(sessionId)) clearPending(sessionId)
          setDeleteDialog((current) => (current?.session.id === sessionId ? null : current))
          return
        }
        setDeleteDialog((current) =>
          current?.session.id === sessionId
            ? {
                ...current,
                isDeleting: false,
                error: result.reason
              }
            : current
        )
      })
      .catch((error: unknown) => {
        console.warn('Unexpected Session deletion failure', error)
        settleSessionDeletion(sessionId, false)
        setDeleteDialog((current) =>
          current?.session.id === sessionId
            ? { ...current, isDeleting: false, error: 'runtime' }
            : current
        )
      })
      .finally(() => {
        deletingIdsRef.current.delete(sessionId)
        setDeletingIds((current) => {
          const next = new Set(current)
          next.delete(sessionId)
          return next
        })
      })
  }
  const selectSpecialist = (specialistId: string | undefined): void => {
    if (!activeSession) {
      setNewConversationSpecialistId(specialistId)
      return
    }
    const sessionId = activeSession.id
    if (isWorkspaceSpecialistBarrierInFlight(sessionId)) return
    if (clearIdleRetry(sessionId)) clearPending(sessionId)
    const running = projectSessionActionability(activeSession).activity !== 'inactive'
    if (running) {
      setPendingSpecialists((current) => ({ ...current, [sessionId]: specialistId }))
    } else {
      const setter = window.api?.specialist?.setSessionSpecialist
      if (!setter) return
      const attempt = reconfiguration.beginIdleAttempt(sessionId, specialistId)
      setPendingSpecialists((current) => ({ ...current, [sessionId]: specialistId }))
      setBarrier(sessionId, true)
      void setter({ sessionId, specialistId })
        .then((result) => {
          if (!attempt.complete()) return
          if (result?.status === 'pending') {
            setSessionSpecialistId(sessionId, specialistId, true)
            setPendingSpecialists((current) => ({ ...current, [sessionId]: specialistId }))
            setReconfigureError(
              pendingSpecialistReconfigureError(sessionId, specialistItems, specialistId)
            )
            return
          }
          setSessionSpecialistId(sessionId, specialistId)
          if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
          clearPending(sessionId)
        })
        .catch((error: unknown) => {
          console.warn('setSessionSpecialist failed', error)
          if (attempt.recordFailure(errorMessage(error))) clearPending(sessionId)
        })
        .finally(() => setBarrier(sessionId, false))
    }
    if (reconfigureError?.sessionId === sessionId) setReconfigureError(null)
  }
  const canStartSend = (sessionId?: string): boolean => {
    if (sessionId && sessionId !== activeSession?.id) {
      const session = useSessionStore
        .getState()
        .sessions.find((candidate) => candidate.id === sessionId)
      if (
        !session ||
        session.contentLoaded === false ||
        session.specialistBindingPending === true ||
        isWorkspaceSpecialistBarrierInFlight(sessionId)
      )
        return false
      if (session.specialistId === undefined) return true
      if (!specialistCatalogLoaded) {
        void loadSpecialists()
        return false
      }
      return specialistItems.some(
        (item) => item.kind === 'custom' && item.enabled && item.id === session.specialistId
      )
    }
    if (!activeSession) return !newConversationSpecialistUnavailable
    if (activeSession.contentLoaded === false) return false
    if (activeSession.specialistBindingPending === true) return false
    if (isWorkspaceSpecialistBarrierInFlight(activeSession.id)) return false
    if (activeSession.specialistId === undefined) return specialistSendAvailable
    if (!specialistCatalogLoaded) {
      void loadSpecialists()
      return false
    }
    return specialistSendAvailable
  }
  const captureSendIntent = (branchInNewSession: boolean): SpecialistSendIntent => {
    const hasPending = Boolean(
      activeSession &&
      (activeSession.specialistBindingPending === true ||
        Object.hasOwn(pendingSpecialists, activeSession.id))
    )
    const pendingSpecialistId = activeSession
      ? Object.hasOwn(pendingSpecialists, activeSession.id)
        ? pendingSpecialists[activeSession.id]
        : activeSession.specialistId
      : undefined
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
    if (isWorkspaceSpecialistBarrierInFlight(sessionId)) return false
    const previous = useSessionStore
      .getState()
      .sessions.find((candidate) => candidate.id === sessionId)
    setBarrier(sessionId, true)
    try {
      const setter = window.api?.specialist?.setSessionSpecialist
      if (!setter) throw new Error('Specialist switching is unavailable.')
      const result = await setter({
        sessionId,
        specialistId
      })
      if (result?.status === 'pending') {
        setSessionSpecialistId(sessionId, specialistId, true)
        setReconfigureError(
          pendingSpecialistReconfigureError(sessionId, specialistItems, specialistId)
        )
        setBarrier(sessionId, false)
        return false
      }
      if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
    } catch (error: unknown) {
      setReconfigureError({
        sessionId,
        specialistName: specialistNameFor(specialistItems, specialistId),
        message: errorMessage(error),
        committed: previous?.specialistBindingPending === true
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
    if (!activeSession || !activeReconfigureError) return
    clearPending(activeSession.id)
    clearIdleRetry(activeSession.id)
    setReconfigureError(null)
  }
  const useMainAgent = (): void => {
    if (!activeSession || !activeReconfigureError) return
    const sessionId = activeSession.id
    const setter = window.api?.specialist?.setSessionSpecialist
    if (!setter || isWorkspaceSpecialistBarrierInFlight(sessionId)) return
    const attempt = reconfiguration.beginIdleAttempt(sessionId, undefined)
    setBarrier(sessionId, true)
    void setter({ sessionId, specialistId: undefined })
      .then((result) => {
        if (!attempt.complete()) return
        if (result?.status === 'pending') {
          setSessionSpecialistId(sessionId, undefined, true)
          setPendingSpecialists((current) => ({ ...current, [sessionId]: undefined }))
          setReconfigureError(
            pendingSpecialistReconfigureError(sessionId, specialistItems, undefined)
          )
          return
        }
        if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
        setSessionSpecialistId(sessionId, undefined)
        clearPending(sessionId)
        setReconfigureError(null)
      })
      .catch((error: unknown) => {
        console.warn('setSessionSpecialist (none) failed', error)
        attempt.recordFailure(errorMessage(error))
      })
      .finally(() => setBarrier(sessionId, false))
  }
  useEffect(() => {
    if (!activeSession || activeSession.specialistBindingPending !== true) return
    // The durable Session store is an external source. Mirror its restored recovery state so the
    // existing retry/choose-another interaction remains available after an application restart.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingSpecialists((current) =>
      Object.hasOwn(current, activeSession.id)
        ? current
        : { ...current, [activeSession.id]: activeSession.specialistId }
    )
    setReconfigureError((current) =>
      current?.sessionId === activeSession.id
        ? current
        : pendingSpecialistReconfigureError(
            activeSession.id,
            specialistItems,
            activeSession.specialistId
          )
    )
  }, [activeSession, setReconfigureError, specialistItems])

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
      if (clearIdleRetry(pending.sessionId)) clearPending(pending.sessionId)
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
  }, [clearIdleRetry, clearPending])
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
          } else return
          if (clearIdleRetry(event.sessionId)) clearPending(event.sessionId)
        })
        .catch(() => undefined)
    },
    [clearIdleRetry, clearPending, setSessionSpecialistId]
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
        edit: sessionDetails.dialog,
        delete: deleteDialog,
        downloadArtifacts: downloadArtifactsDialog,
        notebook: notebookDialog,
        exportConversation: exportConversationDialog,
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
        sendAvailable: specialistSendAvailable && !barrierInFlightIds.has(activeSession?.id ?? ''),
        reconfigureError: activeReconfigureError
      }
    },
    actions: {
      clearExportError: () => setExportError(null),
      openEdit: sessionDetails.open,
      closeEdit: sessionDetails.close,
      changeEditTitleDraft: sessionDetails.changeTitle,
      changeEditDescriptionDraft: sessionDetails.changeDescription,
      confirmEdit: sessionDetails.confirm,
      renameTitle: sessionDetails.rename,
      togglePin: (session: ChatSession) => {
        if (isPersistenceReady) togglePinned(session.id)
      },
      archive,
      openExportConversation: (session: ChatSession) => {
        const intent = ++exportConversationIntentRef.current
        setExportError(null)
        if (session.contentLoaded === false) {
          void loadPersistedSession({ projectId: session.projectId, sessionId: session.id })
            .then((persisted) => {
              if (!persisted) throw new Error('Selected Session JSON is missing.')
              const hydrated = hydratePersistedSessionIfPresent(persisted)
              if (!hydrated || intent !== exportConversationIntentRef.current) return
              setExportConversationDialog(hydrated)
            })
            .catch(() => {
              if (intent === exportConversationIntentRef.current)
                setExportError(t('Could not load this session for export.'))
            })
          return
        }
        setExportConversationDialog(session)
      },
      closeExportConversation: () => {
        exportConversationIntentRef.current += 1
        setExportConversationDialog(null)
      },
      openDelete,
      closeDelete: () => setDeleteDialog((current) => (current?.isDeleting ? current : null)),
      confirmDelete,
      openDownloadArtifacts: setDownloadArtifactsDialog,
      closeDownloadArtifacts: () => setDownloadArtifactsDialog(null),
      openNotebook: setNotebookDialog,
      closeNotebook: () => setNotebookDialog(null),
      openJobList: (sessionId: string) => setJobListDialog({ open: true, sessionId }),
      closeJobList: () => setJobListDialog((current) => ({ ...current, open: false })),
      selectSpecialist,
      retrySpecialistSelection: () =>
        reconfiguration.retryIdle(activeSession?.id, selectSpecialist),
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
      isBarrierInFlight: isWorkspaceSpecialistBarrierInFlight
    }
  }
}
export { useWorkspaceSessionController }
export type {
  ReconfigureError,
  SessionDeleteDialogState,
  SessionDeletionFailureReason,
  SpecialistSendIntent,
  WorkspaceSessionController
}

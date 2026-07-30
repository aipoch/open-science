import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animate } from 'motion'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import type { NotebookSessionReference } from '../../../../shared/notebook'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import { ResizableHandle, ResizablePanelGroup } from '@/components/ui/resizable'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import { usePreviewPersistence } from '@/lib/preview-persistence/preview-persistence'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  createNotebookPreviewItem,
  createProjectFilesPreviewItem,
  PROJECT_FILES_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import { useSessionStore } from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
import {
  assembleReviewRunRequest,
  suppressNextAutoReview,
  clearSuppressNextAutoReview
} from '@/lib/acp/workspace-events'
import type { UploadedAttachment } from '../../../../shared/uploads'

import { planComposerAttachmentIntake } from './composer-attachment-intake'
import { stageComposerFile, type ComposerUploadTransfer } from './composer-upload-transfer'
import {
  docIsEmpty,
  docToArtifactRefs,
  docToSkillIds,
  docToText,
  emptyDoc,
  type ComposerDoc
} from './composer/composer-doc'
import { ConversationPanel } from './ConversationPanel'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { PreviewPanel } from './PreviewPanel'
import { RenameSessionDialog } from './RenameSessionDialog'
import { SessionNotebookDialog } from './SessionNotebookDialog'
import { JobDetailModal } from '@/components/JobDetailModal'
import { getVisiblePermissionRequests } from './session-permissions'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { useJobAnalysisEffect } from '@/lib/compute/useJobAnalysisEffect'

type WorkspacePageProps = {
  isSessionPersistenceHydrated: boolean
  isSessionPersistenceReady: boolean
  canDeleteConversations: boolean
}

// Converts unknown async failures into composer-visible text.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Stable draft-map key for the "new conversation" composer, which has no selected session id.
const NEW_CONVERSATION_DRAFT_KEY = '__new_conversation__'

const PREVIEW_PANEL_DEFAULT_SIZE = 40
const PREVIEW_PANEL_DEFAULT_SIZE_CSS = `${PREVIEW_PANEL_DEFAULT_SIZE}%`
const PREVIEW_PANEL_MIN_OPEN_SIZE = 30
const PREVIEW_PANEL_MIN_OPEN_SIZE_CSS = `${PREVIEW_PANEL_MIN_OPEN_SIZE}%`
const PREVIEW_PANEL_COLLAPSED_SIZE = 0
const PREVIEW_PANEL_COLLAPSED_SIZE_CSS = `${PREVIEW_PANEL_COLLAPSED_SIZE}%`
const PREVIEW_PANEL_COLLAPSED_THRESHOLD = 0.1
const PREVIEW_PANEL_ANIMATING_MIN_SIZE = PREVIEW_PANEL_COLLAPSED_SIZE_CSS
const previewPanelAnimation = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number]
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

// Provides stable names for pasted images, which often arrive without a useful filename.
const getUploadFilename = (file: File, index: number): string => {
  const fileName = file.name.trim()

  return fileName || `pasted-image-${Date.now()}-${index + 1}.png`
}

// Renders the workspace shell and bridges the chat surface to the session store.
const WorkspacePage = ({
  isSessionPersistenceHydrated,
  isSessionPersistenceReady,
  canDeleteConversations
}: WorkspacePageProps): React.JSX.Element => {
  // The page owns the imperative panel handle because open requests come from outside PreviewPanel.
  const previewPanelRef = useRef<PanelImperativeHandle | null>(null)
  const previewPanelAnimationRef = useRef<{ stop: () => void } | null>(null)
  const previewPanelAnimationFrameRef = useRef<number | null>(null)
  const previewPanelAnimationDirectionRef = useRef<'opening' | 'closing' | null>(null)
  const lastOpenPreviewPanelSizeRef = useRef(PREVIEW_PANEL_DEFAULT_SIZE)
  const hasSyncedInitialPreviewPanelSizeRef = useRef(false)
  const [isPreviewPanelAnimationMinSizeRelaxed, setIsPreviewPanelAnimationMinSizeRelaxed] =
    useState(false)

  // The active project scopes which sessions are visible and stamps newly created ones. The workspace
  // is only reachable via openProject/openSession (which set it); '' is a defensive sentinel that
  // matches no session and triggers the redirect below.
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const goHome = useNavigationStore((state) => state.goHome)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const supportsImageInput = useSettingsStore(
    (state) =>
      state.providers.find((provider) => provider.id === activeProviderId)?.supportsImageInput
  )
  const scopedProjectId = activeProjectId ?? ''
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === scopedProjectId)
  )

  // Specialist catalog for new-conversation draft validation.
  const specialistItems = useSpecialistStore((state) => state.items)
  const specialistCatalogLoaded = useSpecialistStore((state) => state.isLoaded)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const allSessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const clearSelection = useSessionStore((state) => state.clearSelection)
  const renameSession = useSessionStore((state) => state.renameSession)
  const togglePinned = useSessionStore((state) => state.togglePinned)
  const setAutoReviewEnabled = useSessionStore((state) => state.setAutoReviewEnabled)
  const setEnabledComputeHosts = useSessionStore((state) => state.setEnabledComputeHosts)
  const setSessionSpecialistId = useSessionStore((state) => state.setSessionSpecialistId)
  const markSpecialistSwitchResetRequired = useSessionStore(
    (state) => state.markSpecialistSwitchResetRequired
  )
  const setFixLoopActive = useSessionStore((state) => state.setFixLoopActive)
  // Only sessions belonging to the active project are shown in this workspace.
  const sessions = useMemo(
    () => allSessions.filter((session) => session.projectId === scopedProjectId),
    [allSessions, scopedProjectId]
  )
  const previewPanelState = usePreviewWorkbenchStore((state) => state.panelState)
  const [initialPreviewPanelDefaultSize] = useState(() =>
    previewPanelState === 'collapsed'
      ? PREVIEW_PANEL_COLLAPSED_SIZE_CSS
      : PREVIEW_PANEL_DEFAULT_SIZE_CSS
  )
  const activePreviewItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const previewOpenRequestVersion = usePreviewWorkbenchStore((state) => state.openRequestVersion)
  const upsertPreviewItem = usePreviewWorkbenchStore((state) => state.upsertItem)
  const upsertAndActivatePreviewItem = usePreviewWorkbenchStore(
    (state) => state.upsertAndActivateItem
  )
  const togglePreviewPanel = usePreviewWorkbenchStore((state) => state.togglePanel)
  const syncPreviewPanelState = usePreviewWorkbenchStore((state) => state.syncPanelState)
  const {
    actionError,
    pendingPermissions,
    permissionProfiles,
    permissionGrants,
    contextUsageBySession,
    promptInFlightSessionIds = [],
    nativeContextCompactionSessionIds,
    compactContext,
    sendMessage,
    resendEditedMessage,
    cancelRun,
    resumeInterruptedSession,
    deleteRuntimeSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  } = useWorkspaceAgentRuntime()

  // Auto-trigger an analysis turn when a remote job finishes (design §11).
  useJobAnalysisEffect({ enabled: isSessionPersistenceReady, sendMessage })
  const [draftDoc, setDraftDoc] = useState<ComposerDoc>(emptyDoc)
  const [newConversationPermissionProfile, setNewConversationPermissionProfile] =
    useState<PermissionProfileId>(DEFAULT_PERMISSION_PROFILE)
  // Draft auto-review state for a not-yet-created conversation. Auto-review defaults off, so a new
  // conversation starts disabled; the user can toggle it on before sending. On send it is stamped
  // onto the created session (see sendCurrentMessage).
  const [newConversationAutoReviewEnabled, setNewConversationAutoReviewEnabled] = useState(false)
  // Draft compute hosts for a not-yet-created conversation. Cleared when a new conversation draft
  // is started, and stamped onto the session when the first message is sent (see sendCurrentMessage).
  const [newConversationEnabledComputeHosts, setNewConversationEnabledComputeHosts] = useState<
    string[]
  >([])
  // Draft specialist selection for a not-yet-created conversation. Stored in memory only (not
  // persisted across restarts). Reset when clicking New; restored when switching back to the draft.
  // On first send, the UUID is forwarded to createSession; the main process resolves the latest Profile.
  const [newConversationSpecialistId, setNewConversationSpecialistId] = useState<
    string | undefined
  >(undefined)
  // Keep availability derived from the current catalog, rather than caching it at click time: a profile
  // can be disabled or deleted while a new-conversation draft is open.
  const newConversationSpecialistUnavailable =
    specialistCatalogLoaded &&
    newConversationSpecialistId !== undefined &&
    !specialistItems.some(
      (item) => item.kind === 'custom' && item.enabled && item.id === newConversationSpecialistId
    )

  // Per-session pending specialist selection for existing conversations.
  // Key: sessionId. Value: the pending UUID (or undefined to clear binding).
  // The pending value is the user's last selection; it takes effect on the next send via reconfigure
  // barrier. Multiple switches before send only keep the last one (last-write-wins).
  const [pendingSessionSpecialist, setPendingSessionSpecialist] = useState<
    Record<string, string | undefined>
  >({})

  // Reconfigure failure state: set when a pre-send dispose/resume fails.
  // Keeps the draft intact, shows the recovery banner above the composer.
  const [reconfigureError, setReconfigureError] = useState<{
    sessionId: string
    specialistName: string
    message: string
  } | null>(null)
  // Per-session set of session IDs currently running the reconfigure barrier (async send in flight).
  // The Set is reactive (drives canSendMessage) so a second Enter press disables send after the first
  // barrier starts. The ref mirrors it for synchronous reads inside the event handler itself.
  const [barrierInFlightSessions, setBarrierInFlightSessions] = useState<ReadonlySet<string>>(
    new Set()
  )
  const barrierInFlightRef = useRef<Set<string>>(new Set())
  // Unsent composer state (rich doc + staged attachments) is kept per session (and per new conversation)
  // so switching away and back restores it. The active key's state is live; this map holds inactive keys.
  const composerDraftsRef = useRef<
    Record<
      string,
      {
        doc: ComposerDoc
        attachments: UploadedAttachment[]
        attachmentTransfers: ComposerUploadTransfer[]
      }
    >
  >({})
  // Mutable cleanup ledgers bridge the async runtime-deletion window. Uploads that finish or queue
  // after confirmation are added here so a successful deletion cannot strand staged files.
  const sessionDeletionCleanupRef = useRef<
    Record<
      string,
      {
        attachments: UploadedAttachment[]
        attachmentTransfers: ComposerUploadTransfer[]
      }
    >
  >({})
  const previousDraftKeyRef = useRef<string>(selectedSessionId ?? NEW_CONVERSATION_DRAFT_KEY)
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [attachmentTransfers, setAttachmentTransfers] = useState<ComposerUploadTransfer[]>([])
  const attachmentTransfersRef = useRef<ComposerUploadTransfer[]>([])
  const attachmentTransferControllersRef = useRef<Record<string, AbortController>>({})
  const cancelledAttachmentTransfersRef = useRef(new Set<string>())
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [notebookReferences, setNotebookReferences] = useState<
    Record<string, NotebookSessionReference>
  >({})
  const [sessionToRename, setSessionToRename] = useState<ChatSession | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | undefined>(undefined)
  const [sessionDeletionInProgressIds, setSessionDeletionInProgressIds] = useState<
    ReadonlySet<string>
  >(new Set())
  const [sessionToViewNotebook, setSessionToViewNotebook] = useState<ChatSession | undefined>(
    undefined
  )
  const [jobListModal, setJobListModal] = useState({ open: false, sessionId: '' })

  useEffect(() => {
    attachmentTransfersRef.current = attachmentTransfers
  }, [attachmentTransfers])

  useEffect(
    () => () => {
      const transferIds = new Set(Object.keys(attachmentTransferControllersRef.current))
      for (const transfer of attachmentTransfersRef.current) transferIds.add(transfer.transferId)
      for (const draft of Object.values(composerDraftsRef.current)) {
        for (const transfer of draft.attachmentTransfers) transferIds.add(transfer.transferId)
      }
      for (const transferId of transferIds) {
        cancelledAttachmentTransfersRef.current.add(transferId)
        attachmentTransferControllersRef.current[transferId]?.abort()
        void window.api.uploads.abortTransfer({ transferId })
      }
    },
    []
  )
  // The selected session is the only conversation rendered in the center panel.
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, sessions]
  )
  const activeSessionHasRuntimeInteraction = activeSession
    ? promptInFlightSessionIds.includes(activeSession.id)
    : false
  const visiblePermissionRequests = useMemo(
    () => getVisiblePermissionRequests(pendingPermissions, activeSession?.id),
    [activeSession?.id, pendingPermissions]
  )
  const activeNotebookReference = activeSession ? notebookReferences[activeSession.id] : undefined
  const activePermissionProfile =
    activeSession?.permissionProfile ?? newConversationPermissionProfile
  const activePermissionProfileState = activeSession
    ? permissionProfiles?.[activeSession.id]
    : undefined
  // Session grants only exist for a bound Agent session; new conversations have none yet.
  const activePermissionGrants = activeSession ? (permissionGrants?.[activeSession.id] ?? []) : []
  const activeContextUsage = activeSession ? contextUsageBySession?.[activeSession.id] : undefined
  const activeSessionSupportsNativeCompaction = activeSession
    ? nativeContextCompactionSessionIds?.includes(activeSession.id) === true
    : false
  // Auto-review defaults off: an existing session is enabled only when explicitly turned on; a new
  // conversation uses the draft toggle (which also starts off).
  const activeAutoReviewEnabled = activeSession
    ? activeSession.autoReviewEnabled === true
    : newConversationAutoReviewEnabled
  // Per-session enabled compute hosts (providerIds like "ssh:<alias>"). Empty when no host is selected.
  // New conversations use the draft state, which is cleared when a new conversation draft is started.
  const activeEnabledComputeHosts = activeSession
    ? (activeSession.enabledComputeHosts ?? [])
    : newConversationEnabledComputeHosts
  // True while any review for the active session is in the 'running' lifecycle.
  // Select the Project-scoped review array so pushes stay reactive without cross-Project collisions.
  const activeSessionId = activeSession?.id
  const isReviewing = useReviewStore((state) => {
    if (!activeSessionId) return false
    const reviews = selectProjectSessionReviews(
      state.reviewsBySession,
      activeSession?.projectId,
      activeSessionId
    )
    return reviews.some((review) => review.lifecycle === 'running')
  })
  // "Request review" is disabled when:
  //   - there is no active session or no completed agent turn yet, OR
  //   - the last turn already has a NON-STALE review (no duplicate reviews), OR
  //   - any review for this session is currently running (no concurrency).
  // A stale last-turn review (its turn changed after it ran) does NOT disable the button — re-running
  // is the explicit refresh path the stale notice points the user to.
  const isRequestReviewDisabled = useReviewStore((state) => {
    if (!activeSessionId) return true
    if (!activeSession) return true
    const lastAgentMessage = [...activeSession.messages].reverse().find((m) => m.role === 'agent')
    if (!lastAgentMessage) return true
    if (isReviewing) return true
    const reviews = selectProjectSessionReviews(
      state.reviewsBySession,
      activeSession.projectId,
      activeSessionId
    )
    // Newest-first, so find() returns the most recent review for the last turn. Only a fresh,
    // completed verdict blocks a new review; a stale one (turn changed) or an errored one must stay
    // retriable so the user isn't stuck without any review entry point.
    const lastTurnReview = reviews.find((r) => r.turnMessageId === lastAgentMessage.id)
    if (lastTurnReview && lastTurnReview.lifecycle === 'complete' && !lastTurnReview.stale) {
      return true
    }
    return false
  })
  const handleReviewUpdate = useReviewStore((state) => state.handleReviewUpdate)
  // Composer controls follow only the selected session and persistence readiness.
  const canEditDraft = isSessionPersistenceReady
  const isUploadingAttachments = attachmentTransfers.some(
    (transfer) =>
      transfer.status === 'queued' ||
      transfer.status === 'uploading' ||
      transfer.status === 'cancelling'
  )
  // Sending is disabled while the current session is running, awaiting a decision, or locked by the
  // fix loop (fixLoopActive). The fix loop lock persists across both the reviewer-review sub-phase and
  // the main agent-fix sub-phase; typing does not override the lock.
  const canSendMessage =
    isSessionPersistenceReady &&
    attachmentTransfers.length === 0 &&
    (!docIsEmpty(draftDoc) || attachments.length > 0) &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-permission' &&
    !activeSessionHasRuntimeInteraction &&
    !activeSession?.fixLoopActive &&
    // A graph-integrity failure keeps only the in-memory terminal projection. Require restart before
    // another prompt can mutate or persist this Session over its last valid durable Branch graph.
    !activeSession?.conversationGraphSyncBlocked &&
    // Auto-recovery drops the session to idle while it resets context and replays the transcript; block
    // sends in that window so a manual prompt can't race the recovery resend into the same session.
    !activeSession?.compacting &&
    // Block while the reconfigure barrier is running (async, between Enter and sendMessage). This
    // prevents a second Enter press from racing the first one through the same pending-switch barrier.
    !barrierInFlightSessions.has(activeSession?.id ?? '')
  // Re-editing a sent prompt is allowed under the same settled-run conditions as sending, so the
  // resent prompt can never overlap an in-flight turn, permission wait, fix loop, or compaction.
  const canEditMessage =
    isSessionPersistenceReady &&
    attachmentTransfers.length === 0 &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-permission' &&
    !activeSessionHasRuntimeInteraction &&
    !isReviewing &&
    !activeSession?.fixLoopActive &&
    !activeSession?.conversationGraphSyncBlocked &&
    !activeSession?.compacting &&
    !sessionDeletionInProgressIds.has(activeSession?.id ?? '')
  useEffect(() => {
    const sessionId = activeSession?.id
    if (!sessionId) return
    useSessionStore.getState().setBranchSwitchBlocked(sessionId, !canEditMessage)
    return () => useSessionStore.getState().setBranchSwitchBlocked(sessionId, false)
  }, [activeSession?.id, canEditMessage])
  const canChangePermissionProfile =
    isSessionPersistenceReady &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-permission' &&
    !activeSessionHasRuntimeInteraction &&
    !activeSession?.compacting
  const canCompactContext =
    isSessionPersistenceReady &&
    activeSessionSupportsNativeCompaction &&
    activeSession?.status === 'idle' &&
    !activeSessionHasRuntimeInteraction &&
    !activeSession.interrupted &&
    !activeSession.fixLoopActive &&
    !activeSession.compacting
  const compactContextDisabledReason = !activeSessionSupportsNativeCompaction
    ? 'Send a message to reconnect this session before compacting.'
    : activeSession?.status === 'error'
      ? 'Resolve the current session error before compacting.'
      : 'Wait for the current agent activity to finish.'
  const visibleActionError = attachmentError ?? (activeSession ? null : actionError)

  const compactActiveContext = useCallback((): void => {
    if (!activeSession || !canCompactContext) return
    void compactContext?.(activeSession.id)
  }, [activeSession, canCompactContext, compactContext])

  const animatePreviewPanelSize = useCallback(
    (
      targetSize: number,
      direction: 'opening' | 'closing',
      options?: { animate?: boolean }
    ): void => {
      const panel = previewPanelRef.current

      if (!panel) return

      previewPanelAnimationRef.current?.stop()
      if (previewPanelAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(previewPanelAnimationFrameRef.current)
        previewPanelAnimationFrameRef.current = null
      }

      const currentSize = panel.getSize().asPercentage
      const resizePanel = (size: number): boolean => {
        const currentPanel = previewPanelRef.current

        // Ignore motion callbacks that outlive the panel handle they were created for.
        if (currentPanel !== panel) return false

        currentPanel.resize(`${Number(size.toFixed(3))}%`)
        return true
      }

      if (
        options?.animate === false ||
        Math.abs(currentSize - targetSize) <= PREVIEW_PANEL_COLLAPSED_THRESHOLD ||
        prefersReducedMotion()
      ) {
        resizePanel(targetSize)
        if (direction === 'opening') lastOpenPreviewPanelSizeRef.current = targetSize
        previewPanelAnimationDirectionRef.current = null
        previewPanelAnimationRef.current = null
        setIsPreviewPanelAnimationMinSizeRelaxed(false)
        return
      }

      previewPanelAnimationDirectionRef.current = direction
      setIsPreviewPanelAnimationMinSizeRelaxed(true)
      previewPanelAnimationFrameRef.current = window.requestAnimationFrame(() => {
        previewPanelAnimationFrameRef.current = null
        const nextPanel = previewPanelRef.current

        if (!nextPanel) return

        const nextCurrentSize = nextPanel.getSize().asPercentage
        previewPanelAnimationRef.current = animate(nextCurrentSize, targetSize, {
          ...previewPanelAnimation,
          onUpdate: resizePanel,
          onComplete: () => {
            const didResize = resizePanel(targetSize)
            if (didResize && direction === 'opening') {
              lastOpenPreviewPanelSizeRef.current = targetSize
            }
            previewPanelAnimationDirectionRef.current = null
            previewPanelAnimationRef.current = null
            setIsPreviewPanelAnimationMinSizeRelaxed(false)
          }
        })
      })
    },
    []
  )

  // The workspace requires an active project; if none is set (e.g. after a project delete), go home.
  useEffect(() => {
    if (!activeProjectId) goHome('automatic')
  }, [activeProjectId, goHome])

  // Switches the preview panel to the active project's own tabs (never another project's stale
  // previews) and persists/restores each project's panel state across switches and restarts.
  usePreviewPersistence(activeProjectId, isSessionPersistenceReady)

  // Preview workbench open requests come through the store; the shell owns the panel ref.
  useLayoutEffect(() => {
    const shouldAnimate = hasSyncedInitialPreviewPanelSizeRef.current
    hasSyncedInitialPreviewPanelSizeRef.current = true

    if (previewPanelState === 'collapsed') {
      animatePreviewPanelSize(PREVIEW_PANEL_COLLAPSED_SIZE, 'closing', {
        animate: shouldAnimate
      })
      return
    }

    const targetSize = Math.max(lastOpenPreviewPanelSizeRef.current, PREVIEW_PANEL_MIN_OPEN_SIZE)
    animatePreviewPanelSize(targetSize, 'opening', { animate: shouldAnimate })
  }, [animatePreviewPanelSize, previewOpenRequestVersion, previewPanelState])

  useEffect(
    () => () => {
      previewPanelAnimationRef.current?.stop()
      if (previewPanelAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(previewPanelAnimationFrameRef.current)
      }
    },
    []
  )

  // Save the outgoing draft and load the incoming one whenever the selected session changes, covering
  // every selection path (session list, new conversation, project switch, deletes) in one place.
  useEffect(() => {
    const currentDraftKey = selectedSessionId ?? NEW_CONVERSATION_DRAFT_KEY
    const previousDraftKey = previousDraftKeyRef.current

    if (currentDraftKey === previousDraftKey) return

    composerDraftsRef.current[previousDraftKey] = {
      doc: draftDoc,
      attachments,
      attachmentTransfers
    }
    const nextDraft = composerDraftsRef.current[currentDraftKey] ?? {
      doc: emptyDoc,
      attachments: [],
      attachmentTransfers: []
    }
    setDraftDoc(nextDraft.doc)
    setAttachments(nextDraft.attachments)
    setAttachmentTransfers(nextDraft.attachmentTransfers)
    previousDraftKeyRef.current = currentDraftKey
  }, [selectedSessionId, draftDoc, attachments, attachmentTransfers])

  // The first agent-side notebook call promotes a notebook entry into the composer status bar.
  useEffect(() => {
    const removeNotebookAvailableListener = window.api.notebook.onAvailable((notebook) => {
      setNotebookReferences((references) => ({
        ...references,
        [notebook.sessionId]: notebook
      }))
      upsertPreviewItem(createNotebookPreviewItem(notebook))
    })

    return () => {
      removeNotebookAvailableListener()
    }
  }, [upsertPreviewItem])

  // Subscribe to reviewer lifecycle updates so the card and Reviewing indicator stay live.
  useEffect(() => {
    const removeUpdatedListener = window.api.reviewer.onUpdated(handleReviewUpdate)

    return () => {
      removeUpdatedListener()
    }
  }, [handleReviewUpdate])

  // Subscribe to the loop-guard channel: suppress the next auto-review when the [Auditor]
  // correction prompt is about to fire, so the correction turn's stop does not re-trigger a review.
  // A clear=true event cancels that suppression if the correction turn failed to send.
  useEffect(() => {
    const removeSuppressListener = window.api.reviewer.onSuppressNextAutoReview(
      ({ projectId, appSessionId, clear }) => {
        if (projectId !== scopedProjectId) return
        if (clear) {
          clearSuppressNextAutoReview(appSessionId)
        } else {
          suppressNextAutoReview(appSessionId)
        }
      }
    )

    return () => {
      removeSuppressListener()
    }
  }, [scopedProjectId])

  // Subscribe to fix loop lifecycle events from the main process. When a fix loop starts for a
  // session, set fixLoopActive=true to disable the send button. When it ends or is aborted, clear
  // the flag. The lock is per-session: other sessions remain interactive.
  useEffect(() => {
    const removeStartListener = window.api.reviewer.onFixLoopStart(
      ({ projectId, appSessionId }) => {
        if (projectId === scopedProjectId) setFixLoopActive(appSessionId, true)
      }
    )
    const removeEndListener = window.api.reviewer.onFixLoopEnd(({ projectId, appSessionId }) => {
      if (projectId === scopedProjectId) setFixLoopActive(appSessionId, false)
    })

    return () => {
      removeStartListener()
      removeEndListener()
    }
  }, [scopedProjectId, setFixLoopActive])

  // The availability event only fires while the agent is live, so a session opened after relaunch
  // would lose its notebook entry until the next call. Probe persisted run.json on selection to
  // restore the composer entry immediately for any session that has used the notebook before.
  const activeSessionCwd = activeSession?.cwd
  // Notebooks are stored per project id (notebooks/<projectId>/<sessionId>), so the probe must pass
  // the session's project or it would look under the default project name and never find run.json.
  const activeSessionProjectId = activeSession?.projectId
  useEffect(() => {
    if (!activeSessionId) return

    let cancelled = false

    void window.api.notebook
      .getReference({
        sessionId: activeSessionId,
        workspaceCwd: activeSessionCwd ?? '',
        projectName: activeSessionProjectId
      })
      .then((reference) => {
        if (cancelled || !reference) return

        // Never clobber a reference the live availability event may have set in the meantime.
        setNotebookReferences((references) =>
          references[activeSessionId] ? references : { ...references, [activeSessionId]: reference }
        )
      })
      .catch((error) => {
        console.warn('Notebook reference hydration failed', error)
      })

    return () => {
      cancelled = true
    }
  }, [activeSessionId, activeSessionCwd, activeSessionProjectId])

  // Sync the active session's enabled compute hosts to the main-process registry when switching
  // sessions. The registry is the runtime source for list_compute RPC ops; the session JSON is the
  // durable source. Toggle updates also sync directly in handleComputeHostToggle.
  useEffect(() => {
    if (!activeSessionId) return
    // Read from store snapshot to avoid stale closure on activeEnabledComputeHosts.
    const session = useSessionStore.getState().sessions.find((s) => s.id === activeSessionId)
    void window.api.compute
      .enabledHostsSet(activeSessionId, session?.enabledComputeHosts ?? [])
      .catch((err: unknown) => {
        console.warn('Failed to sync enabled compute hosts to registry', err)
      })
    // Only re-run when the active session changes (session switch). Toggle handler syncs directly.
  }, [activeSessionId])

  // Resizable drag/collapse state is mirrored back into the transient preview workbench store.
  const syncPreviewPanelResize = (
    panelSize: PanelSize,
    previousPanelSize: PanelSize | undefined
  ): void => {
    const isNearCollapsedSize = panelSize.asPercentage <= PREVIEW_PANEL_COLLAPSED_THRESHOLD
    const animationDirection = previewPanelAnimationDirectionRef.current
    const isOpeningAnimationResize =
      animationDirection === 'opening' &&
      (previousPanelSize === undefined || panelSize.asPercentage >= previousPanelSize.asPercentage)
    const isClosingAnimationResize =
      animationDirection === 'closing' &&
      (previousPanelSize === undefined || panelSize.asPercentage <= previousPanelSize.asPercentage)

    if (isNearCollapsedSize && isOpeningAnimationResize) return
    if (!isNearCollapsedSize && isClosingAnimationResize) return

    if (!isNearCollapsedSize && animationDirection === null) {
      lastOpenPreviewPanelSizeRef.current = panelSize.asPercentage
    }

    syncPreviewPanelState(isNearCollapsedSize ? 'collapsed' : 'open')
  }

  // Deletes staged files when the user abandons the current composer draft.
  const deleteAttachmentFiles = (items: UploadedAttachment[]): void => {
    if (items.length === 0) return

    void Promise.all(
      items.map((attachment) => window.api.uploads.deleteUpload({ path: attachment.path }))
    ).catch((error) => {
      setAttachmentError(getErrorMessage(error))
    })
  }

  const updateDraftTransfers = (
    draftKey: string,
    update: (transfers: ComposerUploadTransfer[]) => ComposerUploadTransfer[]
  ): void => {
    if (previousDraftKeyRef.current === draftKey) {
      setAttachmentTransfers(update)
      return
    }

    const draft = composerDraftsRef.current[draftKey]
    if (draft) draft.attachmentTransfers = update(draft.attachmentTransfers)
  }

  const commitDraftAttachment = (
    draftKey: string,
    transferId: string,
    attachment: UploadedAttachment
  ): void => {
    const deletionCleanup = sessionDeletionCleanupRef.current[draftKey]
    if (deletionCleanup) {
      deletionCleanup.attachmentTransfers = deletionCleanup.attachmentTransfers.filter(
        (transfer) => transfer.transferId !== transferId
      )
      deletionCleanup.attachments.push(attachment)
    }

    if (previousDraftKeyRef.current === draftKey) {
      setAttachmentTransfers((transfers) =>
        transfers.filter((transfer) => transfer.transferId !== transferId)
      )
      setAttachments((currentAttachments) => [...currentAttachments, attachment])
      return
    }

    const draft = composerDraftsRef.current[draftKey]
    if (!draft) return
    draft.attachmentTransfers = draft.attachmentTransfers.filter(
      (transfer) => transfer.transferId !== transferId
    )
    draft.attachments.push(attachment)
  }

  // Keeps New as a local draft reset after persistence hydration has selected restored sessions.
  const openNewConversation = (): void => {
    if (!isSessionPersistenceReady) return

    // The draft effect saves the outgoing doc/attachments and restores the new-conversation state.
    setAttachmentError(null)
    setNewConversationPermissionProfile(DEFAULT_PERMISSION_PROFILE)
    setNewConversationAutoReviewEnabled(false)
    setNewConversationEnabledComputeHosts([])
    useNavigationStore.getState().recordUserNavigation()
    setNewConversationSpecialistId(undefined)
    clearSelection()
  }

  // Synchronizes the hidden chat session id with the selected session list item.
  const openSession = (sessionId: string): void => {
    // The draft effect saves the outgoing doc/attachments and restores the target session's state.
    setAttachmentError(null)
    useNavigationStore.getState().openSession(scopedProjectId, sessionId, 'user')
  }

  // Converts selected or pasted files into app-managed uploads before they appear in the composer.
  const stageAttachmentFiles = (files: File[]): void => {
    if (!canEditDraft || files.length === 0) return
    if (files.some((file) => file.type.startsWith('image/')) && supportsImageInput !== true) {
      setAttachmentError('The selected model is not configured for image input.')
      return
    }

    // Enforce the size and count limits up front so rejected files are never read or uploaded.
    const { accepted, error } = planComposerAttachmentIntake(
      files,
      attachments.length + attachmentTransfers.length
    )

    setAttachmentError(error)

    if (accepted.length === 0) return

    const draftKey = previousDraftKeyRef.current
    const pending = accepted.map(
      (file, index): { file: File; transfer: ComposerUploadTransfer } => {
        const name = getUploadFilename(file, index)
        return {
          file,
          transfer: {
            transferId: crypto.randomUUID(),
            name,
            mimeType: file.type || undefined,
            receivedBytes: 0,
            totalBytes: file.size,
            status: 'queued'
          }
        }
      }
    )
    setAttachmentTransfers((transfers) => [
      ...transfers,
      ...pending.map(({ transfer }) => transfer)
    ])
    const deletionCleanup = sessionDeletionCleanupRef.current[draftKey]
    if (deletionCleanup) {
      deletionCleanup.attachmentTransfers.push(...pending.map(({ transfer }) => transfer))
    }

    void (async () => {
      // Serialize files so a multi-select never holds one chunk per attachment in memory at once.
      for (const { file, transfer } of pending) {
        if (cancelledAttachmentTransfersRef.current.delete(transfer.transferId)) continue
        const controller = new AbortController()
        attachmentTransferControllersRef.current[transfer.transferId] = controller
        updateDraftTransfers(draftKey, (transfers) =>
          transfers.map((candidate) =>
            candidate.transferId === transfer.transferId
              ? { ...candidate, status: 'uploading' }
              : candidate
          )
        )

        try {
          const attachment = await stageComposerFile(file, window.api.uploads, {
            transferId: transfer.transferId,
            name: transfer.name,
            signal: controller.signal,
            onProgress: (progress) => {
              updateDraftTransfers(draftKey, (transfers) =>
                transfers.map((candidate) =>
                  candidate.transferId === transfer.transferId
                    ? { ...candidate, ...progress, status: 'uploading' }
                    : candidate
                )
              )
            }
          })
          if (controller.signal.aborted) {
            await Promise.all([
              window.api.uploads.deleteUpload({ path: attachment.path }).catch(() => undefined),
              window.api.uploads
                .abortTransfer({ transferId: transfer.transferId })
                .catch(() => undefined)
            ])
            continue
          }
          commitDraftAttachment(draftKey, transfer.transferId, attachment)
          await window.api.uploads
            .claimLocalFile?.({ transferId: transfer.transferId })
            .catch((error) => console.warn('Failed to claim staged local upload', error))
        } catch (uploadError) {
          if (controller.signal.aborted) {
            updateDraftTransfers(draftKey, (transfers) =>
              transfers.filter((candidate) => candidate.transferId !== transfer.transferId)
            )
          } else {
            const message = getErrorMessage(uploadError)
            updateDraftTransfers(draftKey, (transfers) =>
              transfers.map((candidate) =>
                candidate.transferId === transfer.transferId
                  ? { ...candidate, status: 'error', error: message }
                  : candidate
              )
            )
            if (previousDraftKeyRef.current === draftKey) setAttachmentError(message)
          }
        } finally {
          delete attachmentTransferControllersRef.current[transfer.transferId]
          cancelledAttachmentTransfersRef.current.delete(transfer.transferId)
        }
      }
    })()
  }

  const cancelAttachmentTransfer = (transfer: ComposerUploadTransfer): void => {
    const draftKey = previousDraftKeyRef.current
    cancelledAttachmentTransfersRef.current.add(transfer.transferId)
    attachmentTransferControllersRef.current[transfer.transferId]?.abort()
    updateDraftTransfers(draftKey, (transfers) =>
      transfers.map((candidate) =>
        candidate.transferId === transfer.transferId
          ? { ...candidate, status: 'cancelling' }
          : candidate
      )
    )
    void window.api.uploads
      .abortTransfer({ transferId: transfer.transferId })
      .catch(() => undefined)
      .finally(() => {
        updateDraftTransfers(draftKey, (transfers) =>
          transfers.filter((candidate) => candidate.transferId !== transfer.transferId)
        )
      })
  }

  // Removes one staged attachment from both local UI state and managed upload storage.
  const removeComposerAttachment = (attachment: UploadedAttachment): void => {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((item) => item.id !== attachment.id)
    )
    const deletionCleanup = sessionDeletionCleanupRef.current[previousDraftKeyRef.current]
    if (deletionCleanup) {
      deletionCleanup.attachments = deletionCleanup.attachments.filter(
        (item) => item.id !== attachment.id
      )
    }
    void window.api.uploads.deleteUpload({ path: attachment.path }).catch((error) => {
      setAttachmentError(getErrorMessage(error))
    })
  }

  // Resends an inline-edited prompt: the conversation is truncated at the edited message, the agent
  // context resets, and the kept turns replay as a preamble on the resent prompt. The gate mirrors
  // canEditMessage so a resend never overlaps an in-flight turn.
  const sendEditedMessage = (messageId: string, doc: ComposerDoc): void => {
    if (!canEditMessage || docIsEmpty(doc) || !activeSession) return

    void resendEditedMessage(activeSession.id, messageId, {
      text: docToText(doc),
      parts: doc.nodes,
      forcedSkillIds: docToSkillIds(doc),
      referencedArtifacts: docToArtifactRefs(doc)
    })
  }

  // Sends the current draft only after hydration so restored selection cannot overwrite intent.
  // ConversationPanel owns preventDefault and passes the skills picked as inline chips.
  // For existing sessions with a pending specialist switch, the reconfigure barrier runs first:
  // dispose + resume the Claude ACP session with the new specialist identity. On failure, the
  // draft is preserved, no user turn is created, and a recovery banner is shown (fail-closed —
  // never silently fall back to Main Agent).
  const sendCurrentMessage = (forcedSkillIds: string[]): void => {
    if (!canSendMessage) return
    // Secondary synchronous guard: blocks a second Enter press that arrives before the state update
    // from the first barrier start triggers a re-render and disables canSendMessage.
    if (activeSession && barrierInFlightRef.current.has(activeSession.id)) return
    if (
      supportsImageInput !== true &&
      attachments.some((attachment) => attachment.mimeType?.startsWith('image/'))
    ) {
      setAttachmentError('The selected model is not configured for image input.')
      return
    }
    // Block send if the draft specialist is unavailable (disabled/deleted/corrupt).
    if (!activeSession && newConversationSpecialistUnavailable) {
      return
    }
    // Block send for existing sessions when the bound specialist is unavailable (fail-closed).
    // Hole A fix: use Object.hasOwn to distinguish "no pending entry" from "pending entry whose
    // value is None (undefined)" — a falsy check would skip the guard for any pending switch.
    // Hole B fix: treat an unloaded catalog as blocking (kick off the load so the next attempt
    // succeeds). Gating on specialistCatalogLoaded=true would skip the guard before catalog
    // resolves; the submenu only loads on open, so isLoaded is plausibly false on a fresh workspace.
    if (activeSession?.specialistId !== undefined) {
      if (!specialistCatalogLoaded) {
        void loadSpecialists()
        return
      }
      if (
        !Object.hasOwn(pendingSessionSpecialist, activeSession.id) &&
        !specialistItems.some(
          (item) => item.kind === 'custom' && item.enabled && item.id === activeSession.specialistId
        )
      ) {
        return
      }
    }

    const doc = draftDoc
    const attachmentsForSend = attachments
    // Capture new-conversation intent before send: auto-review defaults off, so only an explicit
    // "on" needs to be stamped onto the created session (absent = off downstream).
    const wasNewConversation = !activeSession
    const draftAutoReviewEnabled = newConversationAutoReviewEnabled
    const draftEnabledComputeHosts = newConversationEnabledComputeHosts
    // Capture the final specialist selection (last change wins before first send).
    const draftSpecialistId = wasNewConversation ? newConversationSpecialistId : undefined
    // Capture pending specialist for existing sessions (last change wins).
    const pendingSpecialistId = activeSession
      ? pendingSessionSpecialist[activeSession.id]
      : undefined
    const hasPendingSwitch = activeSession !== undefined && pendingSpecialistId !== undefined

    // Dispatches the final send after draft/attachment state has been cleared.
    // Shared by the normal send path and the Retry recovery action so the logic stays in sync.
    const dispatchSend = (sessionId: string | undefined): void => {
      void sendMessage({
        sessionId,
        text: docToText(doc),
        attachments: attachmentsForSend,
        // Existing files the user referenced via `@`; the runtime attaches each as a content block.
        referencedArtifacts: docToArtifactRefs(doc),
        // Persist the draft's structural segments so the sent bubble renders styled mention pills.
        parts: doc.nodes,
        cwd: activeSession?.cwd,
        projectId: activeSession?.projectId ?? scopedProjectId,
        projectName: activeSession?.projectId ?? scopedProjectId,
        permissionProfile: activePermissionProfile,
        forcedSkillIds,
        // New-conversation only: the UUID is forwarded to createSession; main process reads latest Profile.
        specialistId: draftSpecialistId
      }).then((result) => {
        if (!result) {
          setDraftDoc(doc)
          setAttachments(attachmentsForSend)
          return
        }

        // Carry the composer's auto-review choice onto the freshly created session. bindPendingSession
        // preserves the field, so stamping the (pending) session id here survives the durable-id swap.
        if (wasNewConversation && draftAutoReviewEnabled) {
          setAutoReviewEnabled(result.sessionId, true)
        }
        // Carry the draft compute host selection onto the newly created session.
        if (wasNewConversation && draftEnabledComputeHosts.length > 0) {
          setEnabledComputeHosts(result.sessionId, draftEnabledComputeHosts)
          void window.api.compute
            .enabledHostsSet(result.sessionId, draftEnabledComputeHosts)
            .catch((err: unknown) => {
              console.warn('Failed to sync draft compute hosts to registry for new session', err)
            })
        }
        setNewConversationAutoReviewEnabled(false)
        setNewConversationEnabledComputeHosts([])
        setNewConversationSpecialistId(undefined)
      })
    }

    // Runs the reconfigure barrier then dispatches the send on success. Extracted so that both the
    // initial send path and the Retry recovery action can invoke the same ordered sequence.
    const runBarrierAndSend = async (sessionId: string, specialistId: string): Promise<void> => {
      // Mark the barrier as in-flight synchronously (ref) and reactively (state). The ref allows
      // the sendCurrentMessage guard to block a second call before the state re-render fires;
      // the state drives canSendMessage so the Send button also disables on the next render.
      barrierInFlightRef.current.add(sessionId)
      setBarrierInFlightSessions((prev) => new Set(prev).add(sessionId))
      try {
        // Apply the pending binding to main process (validates the UUID is still available, then
        // hot-switches the live agent session). contextReset signals the agent session was replaced
        // (Claude bakes identity into the session at creation) so history must be replayed below.
        const switchResult = await window.api?.specialist?.setSessionSpecialist?.({
          sessionId,
          specialistId
        })
        if (switchResult?.contextReset) {
          markSpecialistSwitchResetRequired(sessionId)
        }
      } catch (err: unknown) {
        // Reconfigure failed — preserve draft (pendingSessionSpecialist is intentionally left set
        // so Retry has the specialist to re-attempt), do not send, show the recovery banner.
        const pendingProfile = specialistItems.find(
          (item) => item.kind === 'custom' && item.id === specialistId
        )
        const name =
          pendingProfile?.kind === 'custom' ? pendingProfile.name : 'the selected specialist'
        setReconfigureError({
          sessionId,
          specialistName: name,
          message: err instanceof Error ? err.message : String(err)
        })
        barrierInFlightRef.current.delete(sessionId)
        setBarrierInFlightSessions((prev) => {
          const next = new Set(prev)
          next.delete(sessionId)
          return next
        })
        return
      }

      // Reconfigure succeeded: update the session's persisted specialist binding,
      // clear the pending state, and proceed to send.
      // Updating the session store's specialistId here ensures the next sendMessage
      // call (which reads currentSession.specialistId for resumeSession) uses the
      // new UUID — triggering the ACP dispose+resume that re-injects the new identity.
      setSessionSpecialistId(sessionId, specialistId)
      setPendingSessionSpecialist((prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      setDraftDoc(emptyDoc)
      delete composerDraftsRef.current[sessionId]
      setAttachments([])
      setAttachmentError(null)
      setReconfigureError(null)

      barrierInFlightRef.current.delete(sessionId)
      setBarrierInFlightSessions((prev) => {
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
      dispatchSend(sessionId)
    }

    // If there is a pending specialist switch for an existing session, run the reconfigure barrier
    // BEFORE appending the user turn. The barrier is strictly ordered: reconfigure must succeed
    // before any message is sent. On failure, the draft is restored, no user turn is created, and
    // the recovery banner is shown.
    if (hasPendingSwitch) {
      void runBarrierAndSend(activeSession.id, pendingSpecialistId)
      return
    }

    // No pending switch: proceed with the normal send path.
    setDraftDoc(emptyDoc)
    // Drop the stored draft for this key so a sent message never lingers as a restorable draft.
    delete composerDraftsRef.current[selectedSessionId ?? NEW_CONVERSATION_DRAFT_KEY]
    setAttachments([])
    setAttachmentError(null)

    dispatchSend(activeSession?.id)
  }

  // Opens the rename dialog with the current title prefilled.
  const openRenameDialog = (session: ChatSession): void => {
    if (!isSessionPersistenceReady) return

    setSessionToRename(session)
    setRenameDraft(session.title)
  }

  // Resets rename state from either cancel action or Radix open state changes.
  const closeRenameDialog = (): void => {
    setSessionToRename(undefined)
    setRenameDraft('')
  }

  // Commits a non-empty title change and closes the rename dialog.
  const confirmRenameSession = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (!isSessionPersistenceReady || !sessionToRename || renameDraft.trim().length === 0) return

    renameSession(sessionToRename.id, renameDraft)
    closeRenameDialog()
  }

  // Explicit deletion is target-validated and may remain available after a partial Session scan, but
  // main requires Project deletion-journal recovery before either deletion IPC can safely run.
  const openDeleteDialog = (session: ChatSession): void => {
    if (!isSessionPersistenceHydrated || !canDeleteConversations) return

    setSessionToDelete(session)
  }

  // Deletes the selected session and repairs the chat surface if it was showing that session.
  const confirmDeleteSession = (): void => {
    if (!isSessionPersistenceHydrated || !canDeleteConversations || !sessionToDelete) return

    // Cancel deferred notification/deep-link navigation before the asynchronous authoritative
    // deletion begins. The user's destructive action owns the view even if the target is unrelated.
    useNavigationStore.getState().recordUserNavigation()
    const deletedSessionId = sessionToDelete.id
    const isActiveSession = deletedSessionId === selectedSessionId
    if (sessionDeletionCleanupRef.current[deletedSessionId]) {
      setSessionToDelete(undefined)
      return
    }
    const storedDraft = composerDraftsRef.current[deletedSessionId]
    sessionDeletionCleanupRef.current[deletedSessionId] = {
      attachments: [...(isActiveSession ? attachments : (storedDraft?.attachments ?? []))],
      attachmentTransfers: [
        ...(isActiveSession ? attachmentTransfers : (storedDraft?.attachmentTransfers ?? []))
      ]
    }
    setSessionDeletionInProgressIds((current) => new Set(current).add(deletedSessionId))

    setSessionToDelete(undefined)
    // Staged bytes and local draft state are owned by the session until runtime and durable deletion
    // both succeed. The store's successful deletion updates selection and lets the draft effect load
    // the fallback session without clearing that replacement draft here.
    void deleteRuntimeSession(deletedSessionId).then((deleted) => {
      const deletionCleanup = sessionDeletionCleanupRef.current[deletedSessionId]
      delete sessionDeletionCleanupRef.current[deletedSessionId]
      setSessionDeletionInProgressIds((current) => {
        const next = new Set(current)
        next.delete(deletedSessionId)
        return next
      })
      if (!deleted || !deletionCleanup) return

      delete composerDraftsRef.current[deletedSessionId]
      for (const transfer of deletionCleanup.attachmentTransfers) {
        // Queued files have no controller yet. Mark every transfer before aborting the active one so
        // the serialized loop skips later entries after the in-flight request settles.
        cancelledAttachmentTransfersRef.current.add(transfer.transferId)
        attachmentTransferControllersRef.current[transfer.transferId]?.abort()
        void window.api.uploads.abortTransfer({ transferId: transfer.transferId })
      }
      deleteAttachmentFiles(deletionCleanup.attachments)
    })
  }

  // Closes the delete dialog without changing runtime or store state.
  const closeDeleteDialog = (): void => {
    setSessionToDelete(undefined)
  }

  // Cancels the run for the currently visible session when one is selected. During an active fix
  // loop, also sends an abort signal to the main process to stop the loop and unlock the composer.
  const cancelActiveRun = (): void => {
    if (!activeSession) return

    const sessionId = activeSession.id

    // If a fix loop is running, abort it. The abort handler in the main process will stop the loop;
    // the renderer reacts to the FIX_LOOP_END event broadcast and clears fixLoopActive.
    if (activeSession.fixLoopActive) {
      void window.api.reviewer
        .abortFixLoop({ projectId: activeSession.projectId, appSessionId: sessionId })
        .catch((error) => {
          console.warn('Failed to abort fix loop:', error)
        })
    }

    void cancelRun(sessionId)
  }

  // Re-attaches the visible interrupted session only after durable Session writes are available;
  // awaited by the banner so it can keep duplicate clicks disabled while reconnecting.
  const resumeActiveSession = async (): Promise<void> => {
    if (!isSessionPersistenceReady || !activeSession) return
    await resumeInterruptedSession(activeSession.id)
  }

  // Forwards visible permission decisions to the runtime bridge.
  const respondToVisiblePermission = (requestId: string, optionId?: string): Promise<void> =>
    respondToPermission(requestId, optionId)

  // Runtime mode is changed before the durable session preference, so a failed capability check
  // leaves the current selection untouched. New conversations apply their choice during creation.
  const changePermissionProfile = (profile: PermissionProfileId): void => {
    if (!canChangePermissionProfile) return

    if (!activeSession) {
      setNewConversationPermissionProfile(profile)
      return
    }

    void setPermissionProfile(activeSession.id, profile)
  }

  // Persists the auto-review toggle for the active session; for a not-yet-created conversation it
  // updates the draft state, which sendCurrentMessage stamps onto the new session.
  const changeAutoReviewEnabled = (enabled: boolean): void => {
    if (!activeSession) {
      setNewConversationAutoReviewEnabled(enabled)
      return
    }

    setAutoReviewEnabled(activeSession.id, enabled)
  }

  // Enables or disables a compute host for the active session (single-select semantics).
  // Enabling one host replaces any existing selection; disabling clears the set.
  // For a not-yet-created conversation, updates the draft state; sendCurrentMessage stamps it onto
  // the new session. For an existing session, updates the session store and main-process registry.
  const handleComputeHostToggle = (providerId: string, enabled: boolean): void => {
    // Single-select: enable one host ↔ clear all others; disabling clears the selection entirely.
    const newEnabledHosts = enabled ? [providerId] : []
    if (!activeSession) {
      setNewConversationEnabledComputeHosts(newEnabledHosts)
      return
    }
    const sessionId = activeSession.id
    setEnabledComputeHosts(sessionId, newEnabledHosts)
    // Keep the main-process registry in sync immediately so list_compute() reflects the change
    // without waiting for the next session-switch effect.
    void window.api.compute.enabledHostsSet(sessionId, newEnabledHosts).catch((err: unknown) => {
      console.warn('Failed to sync enabled compute hosts to registry', err)
    })
  }

  // Manually triggers a review of the last completed turn, bypassing autoReviewEnabled and the
  // suppressAutoReviewOnceFor loop guard. Disabled logic is enforced by isRequestReviewDisabled.
  const requestManualReview = (): void => {
    if (!activeSession) return

    const request = assembleReviewRunRequest(activeSession.id)

    if (!request) return

    // Explicit user action: bypass main's auto-only per-turn idempotency so a manual review always runs.
    void window.api.reviewer.run({ ...request, origin: 'manual' })
  }

  // Revokes one app-owned grant for the visible Agent session; new conversations have no grants.
  const revokeActivePermissionGrant = (categoryKey: string): void => {
    if (!activeSession) return

    void revokePermissionGrant(activeSession.id, categoryKey)
  }

  // Clears every app-owned grant for the visible Agent session. Revokes are awaited in sequence so the
  // final snapshot reflects the emptied set rather than a partial one racing back from the broker.
  const clearActivePermissionGrants = (): void => {
    if (!activeSession) return

    const sessionId = activeSession.id
    const categoryKeys = activePermissionGrants.map((grant) => grant.categoryKey)

    void (async () => {
      for (const categoryKey of categoryKeys) {
        await revokePermissionGrant(sessionId, categoryKey)
      }
    })()
  }

  // Opens the right preview on demand instead of stealing focus when the agent first uses notebook.
  const openNotebookPreview = (notebook: NotebookSessionReference): void => {
    upsertAndActivatePreviewItem(createNotebookPreviewItem(notebook))
  }

  // Opens the project file library as a stable preview workbench tool tab.
  const openFilesPreview = (): void => {
    if (!isSessionPersistenceReady) return

    upsertAndActivatePreviewItem(createProjectFilesPreviewItem())
  }

  // Handles specialist selection for the new-conversation draft. Availability is derived from the
  // catalog above so a later disable/delete is reflected before the next send.
  const handleNewConversationSpecialistChange = (specialistId: string | undefined): void => {
    setNewConversationSpecialistId(specialistId)
  }

  // Handles specialist selection for an existing conversation.
  // For idle sessions: immediately write the binding via IPC (no reconfigure yet — lazy).
  // For running sessions: record as pending; the chip appears; binding takes effect next send.
  const handleExistingSessionSpecialistChange = (specialistId: string | undefined): void => {
    if (!activeSession) return
    const sessionId = activeSession.id
    const isRunning =
      activeSession.status === 'running' || activeSession.status === 'waiting-permission'

    if (isRunning) {
      // Pending switch: will be applied at next send via reconfigure barrier.
      setPendingSessionSpecialist((prev) => ({ ...prev, [sessionId]: specialistId }))
    } else {
      // Idle: apply immediately (write to main process binding store + persist UUID).
      const previousSpecialistId = activeSession.specialistId
      // Optimistically update the session store so the specialist chip reflects the new selection
      // right away and the persistence bridge writes the new UUID. Reverted on IPC failure so a
      // rejected switch (e.g. specialist disabled between render and click) leaves the UI consistent.
      setSessionSpecialistId(sessionId, specialistId)
      setPendingSessionSpecialist((prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      void window.api?.specialist
        ?.setSessionSpecialist?.({ sessionId, specialistId })
        ?.then((result) => {
          // The agent session was replaced on the main side; replay history on the next send so the
          // new specialist keeps conversation continuity.
          if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
        })
        ?.catch((err: unknown) => {
          setSessionSpecialistId(sessionId, previousSpecialistId)
          console.warn('setSessionSpecialist failed', err)
        })
    }
    // Clear any prior reconfigure error when the user picks a new specialist.
    if (reconfigureError?.sessionId === sessionId) {
      setReconfigureError(null)
    }
  }

  // Subscribe to specialist catalog changes so unavailability state stays fresh.
  useEffect(() => {
    // Guard: window.api.specialist may be absent in test/headless environments.
    if (!window.api?.specialist) return
    void loadSpecialists()
    const remove = window.api.specialist.onCatalogChanged(() => {
      void loadSpecialists()
    })
    return remove
  }, [loadSpecialists])

  return (
    <main className="h-screen overflow-hidden bg-bg-10 p-[10px] text-[13px] leading-normal text-text-000">
      <div className="flex h-full gap-2">
        <WorkspaceSidebar
          projectName={activeProject?.name ?? 'Project'}
          sessions={sessions}
          activeSessionId={selectedSessionId}
          canCreateConversation={isSessionPersistenceReady}
          canMutateConversations={isSessionPersistenceReady}
          canDeleteConversations={canDeleteConversations}
          onGoHome={() => goHome('user')}
          onNewConversation={openNewConversation}
          isFilesOpen={activePreviewItemId === PROJECT_FILES_PREVIEW_ID}
          onOpenFiles={openFilesPreview}
          onOpenSession={openSession}
          onRenameSession={openRenameDialog}
          onViewNotebook={setSessionToViewNotebook}
          onTogglePin={(session) => {
            if (isSessionPersistenceReady) togglePinned(session.id)
          }}
          onDeleteSession={openDeleteDialog}
          onOpenSettings={openSettings}
        />

        {/* Cancel the workspace's vertical and trailing padding so panel dividers meet the app edges. */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="-my-[10px] -mr-[10px] h-[calc(100%+20px)] min-w-0 flex-1"
        >
          <ConversationPanel
            activeSession={activeSession}
            draftDoc={draftDoc}
            canSendMessage={canSendMessage}
            canEditDraft={canEditDraft}
            canResumeSession={isSessionPersistenceReady}
            actionError={visibleActionError}
            isPreviewPanelCollapsed={previewPanelState === 'collapsed'}
            attachments={attachments}
            attachmentTransfers={attachmentTransfers}
            isUploadingAttachments={isUploadingAttachments}
            notebookReference={activeNotebookReference}
            pendingPermissions={visiblePermissionRequests}
            permissionProfile={activePermissionProfile}
            permissionProfileState={activePermissionProfileState}
            permissionGrants={activePermissionGrants}
            contextUsage={activeContextUsage}
            canCompactContext={canCompactContext}
            compactContextDisabledReason={compactContextDisabledReason}
            onCompactContext={compactActiveContext}
            canChangePermissionProfile={canChangePermissionProfile}
            autoReviewEnabled={activeAutoReviewEnabled}
            onDraftDocChange={setDraftDoc}
            onSendMessage={sendCurrentMessage}
            onStageAttachmentFiles={stageAttachmentFiles}
            onRemoveAttachment={removeComposerAttachment}
            onCancelAttachmentTransfer={cancelAttachmentTransfer}
            onCancelRun={cancelActiveRun}
            onResumeSession={resumeActiveSession}
            onOpenNotebook={openNotebookPreview}
            onTogglePreviewPanel={togglePreviewPanel}
            onRespondToPermission={respondToVisiblePermission}
            onPermissionProfileChange={changePermissionProfile}
            onRevokePermissionGrant={revokeActivePermissionGrant}
            onClearPermissionGrants={clearActivePermissionGrants}
            onAutoReviewToggle={changeAutoReviewEnabled}
            enabledComputeHosts={activeEnabledComputeHosts}
            onComputeHostToggle={handleComputeHostToggle}
            onRequestReview={requestManualReview}
            isRequestReviewDisabled={isRequestReviewDisabled}
            canEditMessage={canEditMessage}
            onSendEditedMessage={sendEditedMessage}
            onOpenJobList={(sessionId) => setJobListModal({ open: true, sessionId })}
            specialistId={
              // For existing sessions: badge shows the currently-effective specialist (session
              // binding). A pending switch is signalled by the chip, not by overriding the badge.
              activeSession ? activeSession.specialistId : newConversationSpecialistId
            }
            specialistUnavailable={
              activeSession
                ? specialistCatalogLoaded &&
                  activeSession.specialistId !== undefined &&
                  // A pending switch overrides: the new selection is checked for availability.
                  !Object.hasOwn(pendingSessionSpecialist, activeSession.id) &&
                  !specialistItems.some(
                    (item) =>
                      item.kind === 'custom' &&
                      item.enabled &&
                      item.id === activeSession.specialistId
                  )
                : newConversationSpecialistUnavailable
            }
            specialistHasPendingSwitch={
              activeSession !== undefined &&
              pendingSessionSpecialist[activeSession.id] !== undefined &&
              (activeSession.status === 'running' || activeSession.status === 'waiting-permission')
            }
            reconfigureError={
              reconfigureError?.sessionId === activeSession?.id ? reconfigureError : null
            }
            onReconfigureRetry={() => {
              // Re-run the full barrier: clears the banner first, then re-attempts the switch
              // and, on success, dispatches the send — identical to the original send path.
              if (!reconfigureError || !activeSession) return
              const pendingId = pendingSessionSpecialist[reconfigureError.sessionId]
              if (pendingId === undefined) {
                setReconfigureError(null)
                return
              }
              setReconfigureError(null)
              sendCurrentMessage(docToSkillIds(draftDoc))
            }}
            onReconfigureChooseOther={() => {
              // Clear the failed pending selection so the picker reflects the currently-effective
              // specialist. The user can then pick a new one from the menu and send again.
              // No mechanism exists to programmatically open the picker, so we note it here.
              if (activeSession && reconfigureError) {
                setPendingSessionSpecialist((prev) => {
                  const next = { ...prev }
                  delete next[activeSession.id]
                  return next
                })
                setReconfigureError(null)
              }
            }}
            onReconfigureUseNone={() => {
              if (activeSession && reconfigureError) {
                setPendingSessionSpecialist((prev) => {
                  const next = { ...prev }
                  delete next[activeSession.id]
                  return next
                })
                setReconfigureError(null)
                void window.api?.specialist
                  ?.setSessionSpecialist?.({ sessionId: activeSession.id, specialistId: undefined })
                  ?.then((result) => {
                    if (result?.contextReset) markSpecialistSwitchResetRequired(activeSession.id)
                  })
                  ?.catch((err: unknown) => console.warn('setSessionSpecialist (none) failed', err))
              }
            }}
            onSpecialistChange={
              activeSession
                ? handleExistingSessionSpecialistChange
                : handleNewConversationSpecialistChange
            }
          />

          <ResizableHandle
            aria-label="Resize right panel"
            disabled={previewPanelState === 'collapsed'}
            aria-hidden={previewPanelState === 'collapsed'}
            className={`transition-opacity duration-200 ease-out ${
              previewPanelState === 'collapsed' ? 'opacity-0' : 'opacity-100'
            }`}
          />

          <PreviewPanel
            panelRef={previewPanelRef}
            defaultSize={initialPreviewPanelDefaultSize}
            minSize={
              isPreviewPanelAnimationMinSizeRelaxed
                ? PREVIEW_PANEL_ANIMATING_MIN_SIZE
                : PREVIEW_PANEL_MIN_OPEN_SIZE_CSS
            }
            onResize={syncPreviewPanelResize}
          />
        </ResizablePanelGroup>
      </div>

      <RenameSessionDialog
        session={sessionToRename}
        renameDraft={renameDraft}
        onRenameDraftChange={setRenameDraft}
        onCancel={closeRenameDialog}
        onConfirmRename={confirmRenameSession}
      />

      <DeleteSessionDialog
        session={sessionToDelete}
        canDelete={canDeleteConversations}
        onCancel={closeDeleteDialog}
        onConfirmDelete={confirmDeleteSession}
      />

      <SessionNotebookDialog
        session={sessionToViewNotebook}
        onClose={() => setSessionToViewNotebook(undefined)}
      />

      <JobDetailModal
        key={jobListModal.sessionId}
        open={jobListModal.open}
        sessionId={jobListModal.sessionId}
        onClose={() => setJobListModal((modal) => ({ ...modal, open: false }))}
      />
    </main>
  )
}

export { WorkspacePage }

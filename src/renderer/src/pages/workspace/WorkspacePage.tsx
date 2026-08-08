import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { NotebookSessionReference } from '../../../../shared/notebook'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import {
  pendingWorkspaceElicitations,
  useWorkspaceElicitation
} from '@/lib/acp/useWorkspaceElicitation'
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
import { useSessionStore } from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
import {
  assembleReviewRunRequest,
  suppressNextAutoReview,
  clearSuppressNextAutoReview
} from '@/lib/acp/workspace-events'
import { resolveEffectiveSpecialistSkills } from '../../../../shared/specialist'

import {
  appendArtifactMention,
  docArtifactCount,
  docIsEmpty,
  docToArtifactRefs,
  docToSkillIds,
  docToText,
  MAX_COMPOSER_ARTIFACT_MENTIONS,
  type ComposerDoc
} from './composer/composer-doc'
import {
  buildSessionComposerHistory,
  buildStarterComposerHistory
} from './composer/composer-history'
import { ConversationPanel } from './ConversationPanel'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { DownloadSessionArtifactsDialog } from './DownloadSessionArtifactsDialog'
import { FilePreviewDialog } from './FilePreviewDialog'
import { RenameSessionDialog } from './RenameSessionDialog'
import { SessionNotebookDialog } from './SessionNotebookDialog'
import { JobDetailModal } from '@/components/JobDetailModal'
import { getVisiblePermissionRequests } from './session-permissions'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { useJobAnalysisEffect } from '@/lib/compute/useJobAnalysisEffect'
import { selectActiveBranchPlan } from './session-plan/active-branch-plan'
import { WorkspacePanelLayout } from './workspace-panel-layout'
import { useWorkspaceComposerController } from './workspace-composer-controller'
import { useWorkspaceSessionController } from './workspace-session-controller'

type WorkspacePageProps = {
  isSessionPersistenceHydrated: boolean
  isSessionPersistenceReady: boolean
  canDeleteConversations: boolean
}

// Converts unknown async failures into composer-visible text.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// New-conversation drafts are project-scoped so switching projects never leaks unsent intent.
const newConversationDraftKeyFor = (projectId: string): string => `new:${projectId}`

// Renders the workspace shell and bridges the chat surface to the session store.
const WorkspacePage = ({
  isSessionPersistenceHydrated,
  isSessionPersistenceReady,
  canDeleteConversations
}: WorkspacePageProps): React.JSX.Element => {
  // The active project scopes which sessions are visible and stamps newly created ones. The workspace
  // is only reachable via openProject/openSession (which set it); '' is a defensive sentinel that
  // matches no session and triggers the redirect below.
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const pendingCustomizePrefill = useNavigationStore((state) => state.pendingCustomizePrefill)
  const pendingArtifactMention = useNavigationStore((state) => state.pendingArtifactMention)
  const consumeCustomizePrefill = useNavigationStore((state) => state.consumeCustomizePrefill)
  const consumeArtifactMention = useNavigationStore((state) => state.consumeArtifactMention)
  const setArtifactMentionAvailability = useNavigationStore(
    (state) => state.setArtifactMentionAvailability
  )
  const goHome = useNavigationStore((state) => state.goHome)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const defaultPermissionProfile = useSettingsStore((state) => state.defaultPermissionProfile)
  const catalogSkills = useSettingsStore((state) => state.skills)
  const loadSkills = useSettingsStore((state) => state.loadSkills)
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
  const newConversationDraftKey = newConversationDraftKeyFor(scopedProjectId)
  const currentDraftKey = selectedSessionId ?? newConversationDraftKey
  const clearSelection = useSessionStore((state) => state.clearSelection)
  const setAutoReviewEnabled = useSessionStore((state) => state.setAutoReviewEnabled)
  const setEnabledComputeHosts = useSessionStore((state) => state.setEnabledComputeHosts)
  const setFixLoopActive = useSessionStore((state) => state.setFixLoopActive)
  const setActivePlanProjection = useSessionStore((state) => state.setActivePlanProjection)
  // Only sessions belonging to the active project are shown in this workspace.
  const sessions = useMemo(
    () =>
      activeProject?.archivedAt === undefined
        ? allSessions.filter(
            (session) => session.projectId === scopedProjectId && session.archivedAt === undefined
          )
        : [],
    [activeProject?.archivedAt, allSessions, scopedProjectId]
  )
  const previewItems = usePreviewWorkbenchStore((state) => state.items)
  const previewPanelState = usePreviewWorkbenchStore((state) => state.panelState)
  const previewOpenRequestVersion = usePreviewWorkbenchStore((state) => state.openRequestVersion)
  const activePreviewItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const fileDialogItem = usePreviewWorkbenchStore((state) => state.fileDialogItem)
  const closeFileDialog = usePreviewWorkbenchStore((state) => state.closeFileDialog)
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
    sendPreparationInFlightSessionIds = [],
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
  const { respondToElicitation } = useWorkspaceElicitation()

  // Auto-trigger an analysis turn when a remote job finishes (design §11).
  useJobAnalysisEffect({ enabled: isSessionPersistenceReady, sendMessage })
  const [newConversationPermissionProfile, setNewConversationPermissionProfile] =
    useState<PermissionProfileId>(defaultPermissionProfile)
  // Draft auto-review state for a not-yet-created conversation. Auto-review defaults off, so a new
  // conversation starts disabled; the user can toggle it on before sending. On send it is stamped
  // onto the created session (see sendCurrentMessage).
  const [newConversationAutoReviewEnabled, setNewConversationAutoReviewEnabled] = useState(false)
  // Draft compute hosts for a not-yet-created conversation. Cleared when a new conversation draft
  // is started, and stamped onto the session when the first message is sent (see sendCurrentMessage).
  const [newConversationEnabledComputeHosts, setNewConversationEnabledComputeHosts] = useState<
    string[]
  >([])
  // Closes the synchronous gap before the hook's reactive preparation state re-renders this page.
  // A second submit for the same draft key returns without clearing its possibly newer local draft.
  const sendRequestsInFlightRef = useRef(new Set<string>())
  const [notebookReferences, setNotebookReferences] = useState<
    Record<string, NotebookSessionReference>
  >({})

  // The selected session is the only conversation rendered in the center panel.
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, sessions]
  )
  const composerHistoryEntries = useMemo(
    () =>
      activeSession
        ? buildSessionComposerHistory(activeSession)
        : buildStarterComposerHistory(sessions),
    [activeSession, sessions]
  )
  // Composer ports are lazy event-time callbacks. The controller does not invoke them while its hook
  // initializes, so the composer owner below is established before any archive/delete action can run.
  const sessionController = useWorkspaceSessionController({
    activeSession,
    selectedSessionId,
    isPersistenceHydrated: isSessionPersistenceHydrated,
    isPersistenceReady: isSessionPersistenceReady,
    canDeleteConversations,
    specialistCatalogLoaded,
    specialistItems,
    loadSpecialists,
    promptInFlightSessionIds,
    sendPreparationInFlightSessionIds,
    hasUnfinishedTransfers: (sessionId) => composer.lifecycle.hasUnfinishedTransfers(sessionId),
    beginSessionDeletion: (sessionId) => composer.lifecycle.beginSessionDeletion(sessionId),
    settleSessionDeletion: (sessionId, deleted) =>
      composer.lifecycle.settleSessionDeletion(sessionId, deleted),
    deleteRuntimeSession
  })
  const historySpecialistId = sessionController.view.specialist.historyId
  const newConversationSpecialistId = sessionController.view.specialist.newConversationId
  const catalogSkillIds = useMemo(
    () => new Set(catalogSkills.map((skill) => skill.id)),
    [catalogSkills]
  )
  const historyAllowedSkillIds = useMemo(() => {
    if (historySpecialistId === undefined) return undefined
    const specialist = specialistItems.find(
      (item) => item.kind === 'custom' && item.enabled && item.id === historySpecialistId
    )
    if (specialist?.kind !== 'custom') return new Set<string>()
    const effective = resolveEffectiveSpecialistSkills(
      specialist,
      catalogSkills.map((skill) => ({
        id: skill.id,
        frameworkName: skill.source === 'featured' ? skill.id : skill.name,
        displayName: skill.name
      }))
    )
    return effective.kind === 'specialist' ? new Set(effective.skillIds) : new Set<string>()
  }, [catalogSkills, historySpecialistId, specialistItems])
  const activeSessionHasSendPreparation = activeSession
    ? sendPreparationInFlightSessionIds.includes(activeSession.id)
    : false
  const activeSessionHasRuntimeInteraction = activeSession
    ? promptInFlightSessionIds.includes(activeSession.id) || activeSessionHasSendPreparation
    : false
  const canEditDraft =
    isSessionPersistenceReady &&
    !activeSessionHasSendPreparation &&
    activeSession?.status !== 'waiting-plan-approval'
  const composerHistoryPolicy = useMemo(
    () => ({
      catalogSkillIds,
      allowedSkillIds: historyAllowedSkillIds,
      skillCatalogReady: catalogSkills.length > 0 || !window.api?.settings?.listSkills,
      refreshSkillCatalog: Boolean(window.api?.settings?.listSkills),
      specialistCatalogReady: specialistCatalogLoaded,
      specialistId: historySpecialistId,
      loadSkills,
      loadSpecialists
    }),
    [
      catalogSkillIds,
      catalogSkills.length,
      historyAllowedSkillIds,
      historySpecialistId,
      loadSkills,
      loadSpecialists,
      specialistCatalogLoaded
    ]
  )
  const composer = useWorkspaceComposerController({
    currentDraftKey,
    newConversationDraftKey,
    activeProjectId,
    pendingCustomizePrefill,
    onCustomizePrefillApplied: sessionController.actions.resetNewConversationSpecialist,
    historyEntries: composerHistoryEntries,
    hasActiveSession: activeSession !== undefined,
    historyPolicy: composerHistoryPolicy,
    canStageAttachments: canEditDraft,
    supportsImageInput,
    uploads: window.api.uploads
  })
  const {
    doc: draftDoc,
    attachments,
    transfers: attachmentTransfers,
    error: attachmentError,
    historyStatus,
    isHistoryBrowsing,
    isUploading: isUploadingAttachments
  } = composer.view
  const {
    changeDoc: changeComposerDraftDoc,
    navigateHistory: navigateComposerHistory,
    stageFiles: stageAttachmentFiles,
    cancelTransfer: cancelAttachmentTransfer,
    removeAttachment: removeComposerAttachment,
    setError: setAttachmentError
  } = composer.actions
  useEffect(() => {
    const getPlanProjection = window.api.acp?.getPlanProjection
    if (!activeSession || activeSession.activePlanProjection || !getPlanProjection) return
    let cancelled = false
    void getPlanProjection(activeSession.projectId, activeSession.id)
      .then((projection) => {
        if (cancelled) return
        if (projection) {
          setActivePlanProjection(activeSession.id, projection)
          return
        }
        const current = useSessionStore
          .getState()
          .sessions.find((session) => session.id === activeSession.id)
        if (current?.status === 'waiting-plan-approval' && !current.activePlanProjection) {
          useSessionStore.getState().finishRun(activeSession.id)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeSession, setActivePlanProjection])
  const canArchiveSession = sessionController.lifecycle.canArchive
  const visiblePermissionRequests = useMemo(
    () => getVisiblePermissionRequests(pendingPermissions, activeSession?.id),
    [activeSession?.id, pendingPermissions]
  )
  const visibleElicitationRequests = useMemo(
    () => pendingWorkspaceElicitations(activeSession),
    [activeSession]
  )
  const activeNotebookReference = activeSession ? notebookReferences[activeSession.id] : undefined
  const activePermissionProfile =
    activeSession?.permissionProfile ?? newConversationPermissionProfile
  const activePermissionProfileState = activeSession
    ? permissionProfiles?.[activeSession.id]
    : undefined
  // Session grants only exist for a bound Agent session; new conversations have none yet.
  const activePermissionGrants = activeSession ? (permissionGrants?.[activeSession.id] ?? []) : []
  const activeContextUsage = activeSession
    ? (contextUsageBySession?.[activeSession.id] ?? activeSession.contextUsage)
    : undefined
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
    !sessionController.view.specialist.barrierInFlight

  // Make the composer-owned mention capability available to Global Search without exposing its draft.
  // The value is transient and Project-scoped; cleanup prevents a stale Project from accepting an
  // Artifact after navigation.
  useEffect(() => {
    if (!activeProjectId) {
      setArtifactMentionAvailability(undefined)
      return
    }
    setArtifactMentionAvailability({
      projectId: activeProjectId,
      canMention: canEditDraft && docArtifactCount(draftDoc) < MAX_COMPOSER_ARTIFACT_MENTIONS
    })
    return () => setArtifactMentionAvailability(undefined)
  }, [activeProjectId, canEditDraft, draftDoc, setArtifactMentionAvailability])

  // Global Search can only request a same-Project mention. Consume it once in the composer owner so
  // a palette never reaches into this page's local draft state or carries a reference across routing.
  useEffect(() => {
    if (!pendingArtifactMention) return
    const file = consumeArtifactMention()
    if (!file || file.projectId !== activeProjectId || !canEditDraft) return

    changeComposerDraftDoc(
      appendArtifactMention(draftDoc, {
        id: file.id,
        name: file.name,
        path: file.path,
        source: file.source,
        mimeType: file.mimeType,
        versionId: file.sourceVersionId
      })
    )
  }, [
    activeProjectId,
    canEditDraft,
    changeComposerDraftDoc,
    consumeArtifactMention,
    draftDoc,
    pendingArtifactMention
  ])
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
    !sessionController.view.deletingIds.has(activeSession?.id ?? '')
  const canEditMessageRef = useRef(canEditMessage)
  useLayoutEffect(() => {
    canEditMessageRef.current = canEditMessage
  }, [canEditMessage])
  useEffect(() => {
    const sessionId = activeSession?.id
    if (!sessionId) return
    useSessionStore.getState().setBranchSwitchBlocked(sessionId, !canEditMessage)
    return () => useSessionStore.getState().setBranchSwitchBlocked(sessionId, false)
  }, [activeSession?.id, canEditMessage])
  const canChangeAgentControls =
    isSessionPersistenceReady &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-permission' &&
    !activeSessionHasRuntimeInteraction &&
    !activeSession?.compacting
  const canChangePermissionProfile =
    isSessionPersistenceReady && !activeSessionHasSendPreparation && !activeSession?.compacting
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
  const visibleActionError =
    attachmentError ?? sessionController.view.exportError ?? (activeSession ? null : actionError)

  const compactActiveContext = useCallback((): void => {
    if (!activeSession || !canCompactContext) return
    void compactContext?.(activeSession.id)
  }, [activeSession, canCompactContext, compactContext])

  // The workspace requires an active project; if none is set (e.g. after a project delete), go home.
  useEffect(() => {
    if (!activeProjectId) goHome('automatic')
  }, [activeProjectId, goHome])

  useEffect(() => {
    if (activeProject?.archivedAt === undefined) return
    clearSelection()
    goHome('automatic')
  }, [activeProject?.archivedAt, clearSelection, goHome])

  // Switches the preview panel to the active project's own tabs (never another project's stale
  // previews) and persists/restores each project's panel state across switches and restarts.
  usePreviewPersistence(activeProjectId, isSessionPersistenceReady)

  // Clear the consumed `Chat with agent` prefill intent from the store once it has been applied in the
  // render phase above, so a later normal open starts fresh. (Calling a store action — not a React
  // setter — so this does not trip the set-state-in-effect rule.)
  useEffect(() => {
    if (pendingCustomizePrefill !== undefined) consumeCustomizePrefill()
  }, [pendingCustomizePrefill, consumeCustomizePrefill])

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

  // Keeps New as a local draft reset after persistence hydration has selected restored sessions.
  const openNewConversation = (): void => {
    if (!isSessionPersistenceReady) return

    // The draft effect saves the outgoing doc/attachments and restores the new-conversation state.
    setAttachmentError(null)
    setNewConversationPermissionProfile(defaultPermissionProfile)
    setNewConversationAutoReviewEnabled(false)
    setNewConversationEnabledComputeHosts([])
    useNavigationStore.getState().recordUserNavigation()
    sessionController.actions.resetNewConversationSpecialist()
    clearSelection()
  }

  // Synchronizes the hidden chat session id with the selected session list item.
  const openSession = (sessionId: string): void => {
    // The draft effect saves the outgoing doc/attachments and restores the target session's state.
    setAttachmentError(null)
    useNavigationStore.getState().openSession(scopedProjectId, sessionId, 'user')
  }

  // Resends an inline-edited prompt: the conversation is truncated at the edited message, the agent
  // context resets, and the kept turns replay as a preamble on the resent prompt. The gate mirrors
  // canEditMessage so a resend never overlaps an in-flight turn.
  const sendEditedMessage = useCallback(
    (messageId: string, doc: ComposerDoc): void => {
      if (!canEditMessageRef.current || docIsEmpty(doc) || !activeSessionId) return

      void resendEditedMessage(activeSessionId, messageId, {
        text: docToText(doc),
        parts: doc.nodes,
        forcedSkillIds: docToSkillIds(doc),
        referencedArtifacts: docToArtifactRefs(doc)
      })
    },
    [activeSessionId, resendEditedMessage]
  )

  // Restart recovery intentionally does not revive the expired generate_plan interaction. Each card
  // action starts a fresh user turn bound to the exact pending Plan. Main commits explicit decisions
  // only after activating that turn; feedback receives protected Plan context without authority.
  const respondToRestoredPlan = useCallback(
    async (
      response: { decision: 'approved' | 'rejected' } | { feedback: string }
    ): Promise<void> => {
      const session = activeSessionId
        ? useSessionStore.getState().sessions.find((candidate) => candidate.id === activeSessionId)
        : undefined
      const plan = selectActiveBranchPlan(session)
      if (!session || session.activeRun || plan?.approval !== 'pending') {
        throw new Error('The pending Plan is no longer available for a response.')
      }
      const pendingAction =
        'feedback' in response
          ? ('review' as const)
          : response.decision === 'approved'
            ? ('approve' as const)
            : ('reject' as const)
      const text =
        'feedback' in response
          ? response.feedback
          : response.decision === 'approved'
            ? 'Approve the current Plan and continue.'
            : 'Dismiss the current Plan.'

      const result = await sendMessage({
        sessionId: session.id,
        text,
        planContinuation: {
          artifactVersionId: plan.artifactVersionId,
          revision: plan.revision,
          pendingAction
        },
        attachments: [],
        cwd: session.cwd,
        projectId: session.projectId,
        projectName: session.projectId,
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
      })
      if (!result) throw new Error('Unable to respond to the Plan.')
    },
    [activeSessionId, sendMessage]
  )

  // Sends the current draft only after hydration so restored selection cannot overwrite intent.
  // ConversationPanel owns preventDefault and passes the skills picked as inline chips.
  // For existing sessions with a pending specialist switch, the reconfigure barrier runs first:
  // dispose + resume the Claude ACP session with the new specialist identity. On failure, the
  // draft is preserved, no user turn is created, and a recovery banner is shown (fail-closed —
  // never silently fall back to Main Agent).
  const sendCurrentMessage = (
    forcedSkillIds: string[],
    options: { branchInNewSession?: boolean; turnIntent?: 'plan-first' } = {}
  ): void => {
    const branchInNewSession = options.branchInNewSession === true
    if (!canSendMessage) return
    // A blank New conversation has no source transcript to snapshot; ordinary Send already creates the
    // fresh Session for that case.
    if (branchInNewSession && !activeSession) return
    // Secondary synchronous guard: blocks a second Enter press that arrives before the state update
    // from the first barrier start triggers a re-render and disables canSendMessage.
    if (activeSession && sessionController.lifecycle.isBarrierInFlight(activeSession.id)) return
    if (
      supportsImageInput !== true &&
      attachments.some((attachment) => attachment.mimeType?.startsWith('image/'))
    ) {
      setAttachmentError('The selected model is not configured for image input.')
      return
    }
    if (!sessionController.lifecycle.canStartSend()) return

    const sendSnapshot = composer.lifecycle.captureSend()
    const sendRequestKey = sendSnapshot.draftKey
    if (sendRequestsInFlightRef.current.has(sendRequestKey)) return
    sendRequestsInFlightRef.current.add(sendRequestKey)
    const { doc, attachments: attachmentsForSend } = sendSnapshot
    // Capture new-conversation intent before send: auto-review defaults off, so only an explicit
    // "on" needs to be stamped onto the created session (absent = off downstream).
    const wasNewConversation = !activeSession
    const draftAutoReviewEnabled = newConversationAutoReviewEnabled
    const draftEnabledComputeHosts = newConversationEnabledComputeHosts
    // Capture pending specialist for existing sessions (last change wins). `undefined` is a valid
    // pending choice meaning Main Agent, so ownership—not truthiness—distinguishes it from no choice.
    const { draftSpecialistId, hasPendingSwitch, pendingSpecialistId } =
      sessionController.lifecycle.captureSendIntent(branchInNewSession)

    // Dispatches the final send after draft/attachment state has been cleared.
    // Shared by the normal send path and the Retry recovery action so the logic stays in sync.
    const dispatchSend = (sessionId: string | undefined): void => {
      const send = async (): ReturnType<typeof sendMessage> => {
        return sendMessage({
          sessionId,
          ...(branchInNewSession && activeSession
            ? { branchSourceSessionId: activeSession.id }
            : {}),
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
          ...(options.turnIntent ? { turnIntent: options.turnIntent } : {}),
          // New-conversation only: the UUID is forwarded to createSession; main process reads latest Profile.
          specialistId: draftSpecialistId
        })
      }
      void send()
        .catch((error: unknown) => {
          setAttachmentError(getErrorMessage(error))
          return undefined
        })
        .then((result) => {
          if (!result) {
            composer.lifecycle.restoreFailedSend(sendSnapshot)
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
          sessionController.actions.resetNewConversationSpecialist()
        })
        .finally(() => sendRequestsInFlightRef.current.delete(sendRequestKey))
    }

    // If there is a pending specialist switch for an existing session, run the reconfigure barrier
    // BEFORE appending the user turn. The barrier is strictly ordered: reconfigure must succeed
    // before any message is sent. On failure, the draft is restored, no user turn is created, and
    // the recovery banner is shown.
    if (hasPendingSwitch && activeSession) {
      const sessionId = activeSession.id
      void sessionController.lifecycle
        .prepareSpecialistSend(sessionId, pendingSpecialistId)
        .then((ready) => {
          if (!ready) {
            sendRequestsInFlightRef.current.delete(sendRequestKey)
            return
          }
          composer.lifecycle.clearDraft(sessionId)
          dispatchSend(sessionId)
        })
      return
    }

    // No pending switch: proceed with the normal send path.
    composer.lifecycle.clearDraft(currentDraftKey)

    dispatchSend(branchInNewSession ? undefined : activeSession?.id)
  }

  const branchCurrentMessage = (forcedSkillIds: string[]): void => {
    sendCurrentMessage(forcedSkillIds, { branchInNewSession: true })
  }

  const planCurrentMessage = (forcedSkillIds: string[]): void => {
    sendCurrentMessage(forcedSkillIds, { turnIntent: 'plan-first' })
  }

  const openSessionWithoutExportError = (sessionId: string): void => {
    sessionController.actions.clearExportError()
    openSession(sessionId)
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

  return (
    <main className="h-[100dvh] overflow-hidden bg-bg-10 text-[13px] leading-normal text-text-000 md:h-screen md:p-[10px]">
      <WorkspacePanelLayout
        hasPreviewItems={previewItems.length > 0}
        preview={{
          state: previewPanelState,
          openRequestVersion: previewOpenRequestVersion,
          toggle: togglePreviewPanel,
          syncState: syncPreviewPanelState
        }}
        desktopSidebar={
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
            onOpenSession={openSessionWithoutExportError}
            onRenameSession={sessionController.actions.openRename}
            canDownloadArtifacts={typeof window.api?.saveSessionArtifacts === 'function'}
            onDownloadArtifacts={sessionController.actions.openDownloadArtifacts}
            onViewNotebook={sessionController.actions.openNotebook}
            onExportSession={
              typeof window.api.sessions?.exportConversation === 'function'
                ? sessionController.actions.exportConversation
                : undefined
            }
            onTogglePin={(session) => {
              sessionController.actions.togglePin(session)
            }}
            canArchiveSession={canArchiveSession}
            onArchiveSession={sessionController.actions.archive}
            onDeleteSession={sessionController.actions.openDelete}
            onOpenSettings={openSettings}
          />
        }
        renderMobileSidebar={({ isOpen, close }) => (
          <WorkspaceSidebar
            projectName={activeProject?.name ?? 'Project'}
            sessions={sessions}
            activeSessionId={selectedSessionId}
            canCreateConversation={isSessionPersistenceReady}
            canMutateConversations={isSessionPersistenceReady}
            canDeleteConversations={canDeleteConversations}
            onGoHome={() => {
              close()
              goHome('user')
            }}
            onNewConversation={() => {
              close()
              openNewConversation()
            }}
            isFilesOpen={activePreviewItemId === PROJECT_FILES_PREVIEW_ID}
            onOpenFiles={() => {
              close()
              openFilesPreview()
            }}
            onOpenSession={(sessionId) => {
              close()
              openSessionWithoutExportError(sessionId)
            }}
            onRenameSession={(session) => {
              close()
              sessionController.actions.openRename(session)
            }}
            canDownloadArtifacts={typeof window.api?.saveSessionArtifacts === 'function'}
            onDownloadArtifacts={(session) => {
              close()
              sessionController.actions.openDownloadArtifacts(session)
            }}
            onViewNotebook={(session) => {
              close()
              sessionController.actions.openNotebook(session)
            }}
            onExportSession={
              typeof window.api.sessions?.exportConversation === 'function'
                ? (session, format) => {
                    close()
                    sessionController.actions.exportConversation(session, format)
                  }
                : undefined
            }
            onTogglePin={(session) => {
              close()
              sessionController.actions.togglePin(session)
            }}
            canArchiveSession={canArchiveSession}
            onArchiveSession={(session) => {
              close()
              sessionController.actions.archive(session)
            }}
            onDeleteSession={(session) => {
              close()
              sessionController.actions.openDelete(session)
            }}
            onOpenSettings={() => {
              close()
              openSettings()
            }}
            mobileMode
            isMobileOpen={isOpen}
            onMobileClose={close}
          />
        )}
        renderConversation={({
          isPreviewPanelCollapsed,
          togglePreviewPanel: togglePreviewPanelFromLayout,
          openMobileSidebar
        }) => (
          <ConversationPanel
            activeSession={activeSession}
            draftDoc={draftDoc}
            canSendMessage={canSendMessage}
            canEditDraft={canEditDraft}
            canResumeSession={isSessionPersistenceReady}
            actionError={visibleActionError}
            isPreviewPanelCollapsed={isPreviewPanelCollapsed}
            attachments={attachments}
            attachmentTransfers={attachmentTransfers}
            isUploadingAttachments={isUploadingAttachments}
            notebookReference={activeNotebookReference}
            pendingPermissions={visiblePermissionRequests}
            pendingElicitations={visibleElicitationRequests}
            permissionProfile={activePermissionProfile}
            permissionProfileState={activePermissionProfileState}
            permissionGrants={activePermissionGrants}
            contextUsage={activeContextUsage}
            canCompactContext={canCompactContext}
            compactContextDisabledReason={compactContextDisabledReason}
            onCompactContext={compactActiveContext}
            canChangeAgentControls={canChangeAgentControls}
            canChangePermissionProfile={canChangePermissionProfile}
            autoReviewEnabled={activeAutoReviewEnabled}
            onDraftDocChange={changeComposerDraftDoc}
            isHistoryBrowsing={isHistoryBrowsing}
            historyStatus={historyStatus}
            onNavigateHistory={navigateComposerHistory}
            onSendMessage={sendCurrentMessage}
            onPlanFirst={planCurrentMessage}
            onRespondToRestoredPlan={respondToRestoredPlan}
            onBranchInNewSession={activeSession ? branchCurrentMessage : undefined}
            onStageAttachmentFiles={stageAttachmentFiles}
            onRemoveAttachment={removeComposerAttachment}
            onCancelAttachmentTransfer={cancelAttachmentTransfer}
            onCancelRun={cancelActiveRun}
            onResumeSession={resumeActiveSession}
            onOpenNotebook={openNotebookPreview}
            onTogglePreviewPanel={togglePreviewPanelFromLayout}
            onOpenSidebar={openMobileSidebar}
            onRespondToPermission={respondToVisiblePermission}
            onRespondToElicitation={respondToElicitation}
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
            onOpenJobList={sessionController.actions.openJobList}
            specialistId={
              // For existing sessions: badge shows the currently-effective specialist (session
              // binding). A pending switch is signalled by the chip, not by overriding the badge.
              activeSession ? activeSession.specialistId : newConversationSpecialistId
            }
            specialistUnavailable={sessionController.view.specialist.unavailable}
            specialistHasPendingSwitch={sessionController.view.specialist.hasPendingSwitch}
            reconfigureError={sessionController.view.specialist.reconfigureError}
            onReconfigureRetry={() => {
              if (sessionController.actions.beginReconfigureRetry()) {
                sendCurrentMessage(docToSkillIds(draftDoc))
              }
            }}
            onReconfigureChooseOther={sessionController.actions.chooseOtherSpecialist}
            onReconfigureUseNone={sessionController.actions.useMainAgent}
            onSpecialistChange={sessionController.actions.selectSpecialist}
          />
        )}
      />

      <RenameSessionDialog
        session={sessionController.view.dialogs.rename?.session}
        renameDraft={sessionController.view.dialogs.rename?.draft ?? ''}
        onRenameDraftChange={sessionController.actions.changeRenameDraft}
        onCancel={sessionController.actions.closeRename}
        onConfirmRename={sessionController.actions.confirmRename}
      />

      <DeleteSessionDialog
        session={sessionController.view.dialogs.delete ?? undefined}
        canDelete={canDeleteConversations}
        onCancel={sessionController.actions.closeDelete}
        onConfirmDelete={sessionController.actions.confirmDelete}
      />

      <DownloadSessionArtifactsDialog
        session={sessionController.view.dialogs.downloadArtifacts ?? undefined}
        onClose={sessionController.actions.closeDownloadArtifacts}
      />

      <FilePreviewDialog
        item={fileDialogItem?.projectId === activeProjectId ? fileDialogItem : undefined}
        onClose={closeFileDialog}
      />

      <SessionNotebookDialog
        session={sessionController.view.dialogs.notebook ?? undefined}
        onClose={sessionController.actions.closeNotebook}
      />

      <JobDetailModal
        key={sessionController.view.dialogs.jobList.sessionId}
        open={sessionController.view.dialogs.jobList.open}
        sessionId={sessionController.view.dialogs.jobList.sessionId}
        onClose={sessionController.actions.closeJobList}
      />
    </main>
  )
}

export { WorkspacePage }

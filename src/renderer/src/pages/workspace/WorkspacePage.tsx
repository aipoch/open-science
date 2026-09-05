import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import type { NotebookSessionReference } from '../../../../shared/notebook'
import type { PermissionProfileId } from '../../../../shared/permission-profiles'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import {
  pendingWorkspaceElicitations,
  useWorkspaceElicitation
} from '@/lib/acp/useWorkspaceElicitation'
import { usePreviewPersistence } from '@/lib/preview-persistence/preview-persistence'
import {
  deleteSession,
  retryPendingArtifactFinalization
} from '@/lib/session-persistence/session-persistence'
import { useMemoryStore } from '@/stores/memory-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  createNotebookPreviewItem,
  createProjectFilesPreviewItem,
  PROJECT_FILES_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import {
  projectSessionActionability,
  resolveRootPermissionPending,
  sessionAwaitsHistoryReplay,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import {
  selectProjectSessionReviewLoadError,
  selectProjectSessionReviewSnapshot,
  selectProjectSessionReviews,
  useReviewStore
} from '@/stores/review-store'
import {
  assembleReviewRunRequest,
  suppressNextAutoReview,
  clearSuppressNextAutoReview
} from '@/lib/acp/workspace-events'
import { resolveEffectiveSpecialistSkills } from '../../../../shared/specialist'
import { revealNotebookWhenProjectActive } from './notebook-preview-availability'
import { invalidateSessionNotebookCache } from './session-notebook-data'
import { isCodexSubscriptionProvider } from '../../../../shared/settings'
import { hasCurrentRunningDelegatedAttempt } from '../../../../shared/delegated-work-projection'
import {
  appendArtifactMention,
  docArtifactCount,
  MAX_COMPOSER_ARTIFACT_MENTIONS
} from './composer/composer-doc'
import {
  buildSessionComposerHistory,
  buildStarterComposerHistory,
  starterHistorySessionSelector
} from './composer/composer-history'
import { ConversationPanel } from './ConversationPanel'
import { ConversationExportDialog } from './ConversationExportDialog'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { DownloadProjectArtifactsDialog } from './DownloadProjectArtifactsDialog'
import { DownloadSessionArtifactsDialog } from './DownloadSessionArtifactsDialog'
import { FilePreviewDialog } from './FilePreviewDialog'
import { EditSessionDialog } from './EditSessionDialog'
import { SessionNotebookDialog } from './SessionNotebookDialog'
import { JobDetailModal } from '@/components/JobDetailModal'
import { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import { ProjectFormDialog } from '../home/ProjectFormDialog'
import { getVisiblePermissionRequests } from './session-permissions'
import { WorkspaceSidebarContainer } from './WorkspaceSidebarContainer'
import { WorkspacePanelLayout } from './workspace-panel-layout'
import { useWorkspaceComposerController } from './workspace-composer-controller'
import { useWorkspaceConversationController } from './workspace-conversation-controller'
import { useWorkspaceSessionController } from './workspace-session-controller'
import { useWorkspaceBranchSwitchGuard } from './use-workspace-branch-switch-guard'
import { useSideChatController } from './use-side-chat-controller'
import { isSaveAsSkillRunning, resolveSaveAsSkillAvailability } from './save-as-skill-availability'
import { createWorkspaceComputeHostAccessController } from './workspace-compute-host-access-controller'
import { useWorkspaceSessionAgentConfiguration } from './workspace-session-agent-configuration-controller'
import { resolveWorkspaceAgentControlAvailability } from './workspace-agent-control-availability'
import { useWorkspaceSessionDelegationControlOwner } from './workspace-session-delegation-control-owner'
import { annotationValidationMessage } from './annotations/annotation-validation-message'
import { annotationRequiresImageInput } from '../../../../shared/annotations'

type WorkspacePageProps = {
  isSessionPersistenceHydrated: boolean
  isSessionPersistenceReady: boolean
  canDeleteConversations: boolean
  isPreviewPresentationActive?: boolean
}

type ManualReviewRequestState = Readonly<{
  pending: boolean
  error: string | null
}>

const newConversationDraftKeyFor = (projectId: string): string => `new:${projectId}`
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
const planProjectionRecoveryPorts = {
  getProjection: (projectId: string, sessionId: string) =>
    window.api.acp.getPlanProjection(projectId, sessionId),
  getSession: (sessionId: string) =>
    useSessionStore.getState().sessions.find((session) => session.id === sessionId),
  setProjection: (
    sessionId: string,
    projection: NonNullable<ChatSession['activePlanProjection']>
  ) => useSessionStore.getState().setActivePlanProjection(sessionId, projection),
  finishRun: (sessionId: string) => useSessionStore.getState().finishRun(sessionId)
}

const WorkspacePage = ({
  isSessionPersistenceHydrated,
  isSessionPersistenceReady,
  canDeleteConversations,
  isPreviewPresentationActive = true
}: WorkspacePageProps): React.JSX.Element => {
  const { t } = useTranslation()
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
  const activeProviderType = useSettingsStore(
    (state) => state.providers.find((provider) => provider.id === activeProviderId)?.type
  )
  const defaultPermissionProfile = useSettingsStore((state) => state.defaultPermissionProfile)
  const settingsSkills = useSettingsStore((state) => state.skills)
  const catalogSkills = useMemo(
    () => settingsSkills.filter((skill) => skill.available !== false),
    [settingsSkills]
  )
  const loadSkills = useSettingsStore((state) => state.loadSkills)
  const pendingCredentialRequests = useSettingsStore((state) => state.pendingCredentialRequests)
  const selectedAgentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const memoryGloballyEnabled = useMemoryStore((state) => state.enabled)
  const loadMemory = useMemoryStore((state) => state.load)
  const listenForMemoryChanges = useMemoryStore((state) => state.listen)
  // The store starts disabled, so new conversations fail closed until the global setting loads.
  const isGlobalMemoryEnabled = memoryGloballyEnabled
  const scopedProjectId = activeProjectId ?? ''
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === scopedProjectId)
  )
  const isProjectListLoaded = useProjectStore((state) => state.isLoaded)
  const projectLoadError = useProjectStore((state) => state.loadError)
  const discardInvalidProject = useNavigationStore((state) => state.discardInvalidProject)

  const specialistItems = useSpecialistStore((state) => state.items)
  const specialistCatalogLoaded = useSpecialistStore((state) => state.isLoaded)
  const loadSpecialists = useSpecialistStore((state) => state.load)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const newConversationDraftKey = newConversationDraftKeyFor(scopedProjectId)
  const currentDraftKey = selectedSessionId ?? newConversationDraftKey
  const clearSelection = useSessionStore((state) => state.clearSelection)
  const setAutoReviewEnabled = useSessionStore((state) => state.setAutoReviewEnabled)
  const setFixLoopActive = useSessionStore((state) => state.setFixLoopActive)
  const previewItems = usePreviewWorkbenchStore((state) => state.items)
  const previewPanelState = usePreviewWorkbenchStore((state) => state.panelState)
  const previewOpenRequestVersion = usePreviewWorkbenchStore((state) => state.openRequestVersion)
  const activePreviewItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const fileDialogItem = usePreviewWorkbenchStore((state) => state.fileDialogItem)
  const togglePreviewPanel = usePreviewWorkbenchStore((state) => state.togglePanel)
  const projectFormDialog = useProjectFormDialog()
  const [projectFileCount, setProjectFileCount] = useState<{
    projectId: string
    total: number
    complete: boolean
  } | null>(null)
  const activeProjectFileCount =
    projectFileCount && projectFileCount.projectId === activeProjectId ? projectFileCount : null
  const canCollectProjectArtifacts =
    activeProjectFileCount === null ||
    !activeProjectFileCount.complete ||
    activeProjectFileCount.total > 0
  useEffect(() => {
    const projectFilesApi = window.api?.projectFiles
    if (!activeProjectId || !projectFilesApi) {
      return
    }

    let cancelled = false
    let requestVersion = 0
    const refresh = async (): Promise<void> => {
      const request = ++requestVersion
      try {
        const overview = await projectFilesApi.getOverview({ projectId: activeProjectId })
        if (!cancelled && request === requestVersion) {
          setProjectFileCount({
            projectId: activeProjectId,
            total: overview.totalCount,
            complete: overview.isIndexComplete
          })
        }
      } catch {
        // An unavailable index is not authoritative; leave the menu item in its previous state.
      }
    }
    void refresh()

    const removeChangedListener = projectFilesApi.onChanged((event) => {
      if (event.projectId === activeProjectId) void refresh()
    })

    return () => {
      cancelled = true
      removeChangedListener()
    }
  }, [activeProjectId])

  // The menu item opens the checklist dialog, which owns the collect-then-save orchestration;
  // this state mirrors "download in flight" (reported by the dialog) so the menu item stays
  // disabled as the first defense.
  const [isDownloadingProjectArtifacts, setIsDownloadingProjectArtifacts] = useState(false)
  const [isProjectDownloadOpen, setIsProjectDownloadOpen] = useState(false)
  const [artifactFinalizationRetrySessionId, setArtifactFinalizationRetrySessionId] =
    useState<string>()
  const [manualReviewRequests, setManualReviewRequests] = useState<
    Record<string, ManualReviewRequestState>
  >({})
  const manualReviewPendingSessionIdsRef = useRef(new Set<string>())
  const syncPreviewPanelState = usePreviewWorkbenchStore((state) => state.syncPanelState)
  const runtime = useWorkspaceAgentRuntime()
  const {
    actionError,
    pendingPermissions,
    permissionProfiles,
    permissionGrants,
    contextUsageBySession,
    delegatedWorkUnavailableBySession = {},
    promptInFlightSessionIds = [],
    sendPreparationInFlightSessionIds = [],
    saveAsSkillInFlightSessionIds = [],
    nativeContextCompactionSessionIds,
    compactContext,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  } = runtime
  const { respondToElicitation } = useWorkspaceElicitation(runtime.resolveSessionRuntimeSelection)

  const [newConversationPermissionProfile, setNewConversationPermissionProfile] =
    useState<PermissionProfileId>(defaultPermissionProfile)
  // Draft auto-review state for a not-yet-created conversation. Auto-review defaults off, so a new
  // conversation starts disabled; the user can toggle it on before sending. On send it is stamped
  // onto the created session through the Conversation submit transaction.
  const [newConversationAutoReviewEnabled, setNewConversationAutoReviewEnabled] = useState(false)
  const [newConversationMemoryPreference, setNewConversationMemoryPreference] = useState<
    boolean | undefined
  >()
  const newConversationMemoryEnabled =
    isGlobalMemoryEnabled && (newConversationMemoryPreference ?? true)
  // Draft compute hosts for a not-yet-created conversation. Cleared when a new conversation draft
  // is started, and stamped onto the session by the Conversation submit transaction.
  const [newConversationEnabledComputeHosts, setNewConversationEnabledComputeHosts] = useState<
    string[]
  >([])
  const [newConversationSelectedComputeHosts, setNewConversationSelectedComputeHosts] = useState<
    string[]
  >([])
  const [notebookReferences, setNotebookReferences] = useState<
    Record<string, NotebookSessionReference>
  >({})

  useEffect(() => {
    void loadMemory()
    return listenForMemoryChanges()
  }, [listenForMemoryChanges, loadMemory])

  // The selected session is the only conversation rendered in the center panel. Selecting it by
  // id (instead of deriving it from the full list) keeps chunk commits for other sessions from
  // re-rendering the page. In-flight streaming text lives in the store's streaming slice, so pure
  // text-growth ticks keep even the active session's identity stable and this selector bails out.
  const storedActiveSession = useSessionStore((state) => {
    if (activeProject?.archivedAt !== undefined) return undefined
    const selected = state.sessions.find((session) => session.id === selectedSessionId)
    if (!selected || selected.projectId !== scopedProjectId || selected.archivedAt !== undefined) {
      return undefined
    }
    return selected
  })
  const persistedReviewSnapshot = useReviewStore((state) => {
    if (!storedActiveSession) return undefined
    return selectProjectSessionReviewSnapshot(
      state.reviewsBySession,
      storedActiveSession.projectId,
      storedActiveSession.id,
      state.loadedReviewSessions
    )
  })
  const reviewLoadError = useReviewStore((state) =>
    selectProjectSessionReviewLoadError(
      state.loadErrorsBySession,
      storedActiveSession?.projectId,
      storedActiveSession?.id
    )
  )
  const hasPersistedActiveFixLoop = useReviewStore((state) => {
    if (!storedActiveSession) return false
    return selectProjectSessionReviews(
      state.reviewsBySession,
      storedActiveSession.projectId,
      storedActiveSession.id
    ).some(
      (review) =>
        review.lifecycle === 'running' &&
        review.checks.some((check) => check.status === 'warn' || check.status === 'fail')
    )
  })
  const activeSession = useMemo(
    () =>
      storedActiveSession && hasPersistedActiveFixLoop && !storedActiveSession.fixLoopActive
        ? { ...storedActiveSession, fixLoopActive: true }
        : storedActiveSession,
    [hasPersistedActiveFixLoop, storedActiveSession]
  )
  const isReviewHistoryUnavailable =
    storedActiveSession !== undefined &&
    (persistedReviewSnapshot === undefined || reviewLoadError !== undefined)
  const {
    activeAgentConfiguration,
    agentConfigurationUnavailable,
    supportsImageInput,
    changeAgentConfiguration,
    resetNewConversationConfiguration
  } = useWorkspaceSessionAgentConfiguration(activeSession)
  // Starter history is only consumed when no session is active, so this subscription collapses to
  // a stable empty list while a session is selected — background session updates then never
  // re-render the page through it.
  const hideStarterHistory = activeSession !== undefined || activeProject?.archivedAt !== undefined
  const starterHistorySessions = useSessionStore(
    useShallow(starterHistorySessionSelector(scopedProjectId, hideStarterHistory))
  )
  const composerHistoryEntries = useMemo(
    () =>
      activeSession
        ? buildSessionComposerHistory(activeSession)
        : buildStarterComposerHistory(starterHistorySessions),
    [activeSession, starterHistorySessions]
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
    saveAsSkillInFlightSessionIds,
    hasUnfinishedTransfers: (sessionId) => composer.lifecycle.hasUnfinishedTransfers(sessionId),
    beginSessionDeletion: (sessionId) => composer.lifecycle.beginSessionDeletion(sessionId),
    settleSessionDeletion: (sessionId, deleted) =>
      composer.lifecycle.settleSessionDeletion(sessionId, deleted),
    deleteSession
  })
  const exportConversationSessionId = sessionController.view.dialogs.exportConversation?.id
  const currentExportConversationSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === exportConversationSessionId)
  )
  const historySpecialistId = sessionController.view.specialist.historyId
  const activeSpecialistId = activeSession?.specialistId
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
  const activeSpecialistAllowedSkillIds = useMemo(() => {
    if (activeSpecialistId === undefined) return undefined
    const specialist = specialistItems.find(
      (item) => item.kind === 'custom' && item.enabled && item.id === activeSpecialistId
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
  }, [activeSpecialistId, catalogSkills, specialistItems])
  const activeSessionHasSendPreparation = activeSession
    ? sendPreparationInFlightSessionIds.includes(activeSession.id)
    : false
  const activeSessionSaveAsSkillPending = activeSession
    ? saveAsSkillInFlightSessionIds.includes(activeSession.id)
    : false
  const activeSessionHasRuntimeInteraction = activeSession
    ? promptInFlightSessionIds.includes(activeSession.id) ||
      activeSessionHasSendPreparation ||
      activeSessionSaveAsSkillPending
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
    activeSession,
    historyPolicy: composerHistoryPolicy,
    canStageAttachments: canEditDraft,
    supportsImageInput,
    uploads: window.api.uploads
  })
  const { doc: draftDoc, error: attachmentError } = composer.view
  const { changeDoc: changeComposerDraftDoc, setError: setAttachmentError } = composer.actions
  const delegationControl = useWorkspaceSessionDelegationControlOwner({
    activeSession,
    selectedSessionId,
    selectedFrameworkId: selectedAgentFrameworkId,
    frameworks: agentFrameworks,
    setError: setAttachmentError
  })
  const previewAnnotations = {
    activeAnnotations: composer.view.annotations,
    onAddAnnotation: (annotation: Parameters<typeof composer.actions.addAnnotation>[0]) => {
      if (annotationRequiresImageInput(annotation) && supportsImageInput !== true) {
        composer.actions.setError(annotationValidationMessage('visual-model-required', t))
        return 'visual-model-required' as const
      }
      const error = composer.actions.addAnnotation(annotation)
      composer.actions.setError(error ? annotationValidationMessage(error, t) : null)
      return error
    },
    onUpdateAnnotationNote: composer.actions.updateAnnotationNote,
    onRemoveAnnotation: composer.actions.removeAnnotation,
    onUndoAnnotation: composer.actions.undo,
    onRedoAnnotation: composer.actions.redo,
    onAnnotationError: (error: Parameters<typeof annotationValidationMessage>[0]) =>
      composer.actions.setError(annotationValidationMessage(error, t)),
    onLinkReadingContext: composer.actions.linkReadingContext,
    onUnlinkReadingContext: composer.actions.unlinkReadingContext
  }

  const sideChat = useSideChatController(
    activeSession ? { sessionId: activeSession.id, projectId: activeSession.projectId } : undefined
  )
  const awaitsHistoryReplay = sessionAwaitsHistoryReplay(activeSession)
  const sideChatDisabledReason = awaitsHistoryReplay
    ? t('Resolve the current Session operation first.')
    : (sideChat.unavailableReason ??
      (activeProviderType !== undefined && isCodexSubscriptionProvider(activeProviderType)
        ? 'Side chat is unavailable for Codex subscription because strict tool isolation cannot be enforced.'
        : undefined))
  const canArchiveSession = sessionController.lifecycle.canArchive
  const visiblePermissionRequests = useMemo(
    () =>
      getVisiblePermissionRequests(
        pendingPermissions,
        activeSession?.id,
        activeSession?.conversationGraph
      ),
    [activeSession?.conversationGraph, activeSession?.id, pendingPermissions]
  )
  const visibleElicitationRequests = useMemo(
    () => pendingWorkspaceElicitations(activeSession),
    [activeSession]
  )
  const visibleCredentialRequests = useMemo(
    () =>
      activeSession
        ? pendingCredentialRequests.filter((request) => request.sessionId === activeSession.id)
        : [],
    [activeSession, pendingCredentialRequests]
  )
  const activeSessionActionability = activeSession
    ? projectSessionActionability(activeSession, {
        rootPermissionPending: resolveRootPermissionPending(pendingPermissions, activeSession.id),
        credentialPending: visibleCredentialRequests.length > 0,
        presentedWaitReason: visibleCredentialRequests.length > 0 ? 'waiting-for-user' : undefined
      })
    : undefined
  const activeNotebookReference = activeSession ? notebookReferences[activeSession.id] : undefined
  const activePermissionProfile =
    activeSession?.permissionProfile ?? newConversationPermissionProfile
  const activePermissionProfileState = activeSession
    ? permissionProfiles?.[activeSession.id]
    : undefined
  const activePermissionGrants = activeSession ? (permissionGrants?.[activeSession.id] ?? []) : []
  const activeContextUsage = activeSession
    ? (contextUsageBySession?.[activeSession.id] ?? activeSession.contextUsage)
    : undefined
  const activeSessionSupportsNativeCompaction = activeSession
    ? nativeContextCompactionSessionIds?.includes(activeSession.id) === true
    : false
  const activeAutoReviewEnabled = activeSession
    ? activeSession.autoReviewEnabled === true
    : newConversationAutoReviewEnabled
  const activeMemoryEnabled = activeSession
    ? isGlobalMemoryEnabled && activeSession.memoryEnabled !== false
    : newConversationMemoryEnabled
  const computeHostAccess = createWorkspaceComputeHostAccessController({
    activeSession,
    newConversationEnabledComputeHosts,
    newConversationSelectedComputeHosts,
    setNewConversationEnabledComputeHosts,
    setNewConversationSelectedComputeHosts,
    setError: setAttachmentError
  })
  const activeSessionId = activeSession?.id
  const activeManualReviewRequest = activeSessionId
    ? manualReviewRequests[activeSessionId]
    : undefined
  const isManualReviewRequestPending = activeManualReviewRequest?.pending === true
  const isReviewing = useReviewStore((state) => {
    if (!activeSessionId) return false
    const reviews = selectProjectSessionReviews(
      state.reviewsBySession,
      activeSession?.projectId,
      activeSessionId
    )
    return reviews.some((review) => review.lifecycle === 'running')
  })
  const isReviewBusy = isReviewing || isManualReviewRequestPending
  const conversation = useWorkspaceConversationController({
    activeSession,
    projectId: scopedProjectId,
    currentDraftKey,
    isPersistenceReady: isSessionPersistenceReady,
    supportsImageInput,
    agentConfiguration: activeAgentConfiguration,
    agentConfigurationReady: !agentConfigurationUnavailable,
    permissionProfile: activePermissionProfile,
    isReviewing: isReviewBusy,
    isTurnAdmissionBlocked: isReviewHistoryUnavailable,
    promptInFlightSessionIds,
    sendPreparationInFlightSessionIds,
    saveAsSkillInFlightSessionIds,
    actionability: activeSessionActionability,
    hasPendingPermissionRequest: (sessionId) =>
      pendingPermissions.some((request) => request.sessionId === sessionId),
    newConversationAutoReviewEnabled,
    newConversationMemoryEnabled,
    newConversationDelegationPolicyOverride: delegationControl.newConversationPolicyOverride,
    newConversationEnabledComputeHosts,
    newConversationSelectedComputeHosts,
    composer,
    session: sessionController,
    runtime,
    sideChat: canEditDraft && !sideChatDisabledReason ? { start: sideChat.start } : undefined,
    sideChatOpen: sideChat.view !== undefined,
    setAutoReviewEnabled,
    resetNewConversationSettings: () => {
      setNewConversationAutoReviewEnabled(false)
      setNewConversationMemoryPreference(undefined)
      delegationControl.resetNewConversation()
      setNewConversationEnabledComputeHosts([])
      setNewConversationSelectedComputeHosts([])
      resetNewConversationConfiguration()
    },
    abortFixLoop: (request) => window.api.reviewer.abortFixLoop(request),
    getSession: (sessionId) =>
      useSessionStore.getState().sessions.find((candidate) => candidate.id === sessionId),
    subscribeSessionChanges: useSessionStore.subscribe,
    planProjectionRecovery:
      typeof window.api.acp?.getPlanProjection === 'function'
        ? planProjectionRecoveryPorts
        : undefined
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
    if (isReviewHistoryUnavailable) return true
    if (sessionAwaitsHistoryReplay(activeSession)) return true
    const lastAgentMessage = [...activeSession.messages].reverse().find((m) => m.role === 'agent')
    if (!lastAgentMessage) return true
    if (isReviewBusy) return true
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
        sourceFileId: file.sourceFileId,
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
  const canEditMessage = conversation.availability.revise
  useWorkspaceBranchSwitchGuard(
    activeSession?.id,
    !canEditMessage || activeSessionSaveAsSkillPending || conversation.queue.hasPendingWork
  )
  const agentControlAvailability = resolveWorkspaceAgentControlAvailability(
    isSessionPersistenceReady &&
      !activeSessionHasRuntimeInteraction &&
      !activeSession?.compacting &&
      !conversation.queue.hasPendingWork,
    sessionController.view.specialist.barrierInFlight,
    activeSessionActionability?.actions
  )
  const canChangePermissionProfile =
    isSessionPersistenceReady &&
    !activeSessionHasSendPreparation &&
    !activeSession?.compacting &&
    !awaitsHistoryReplay &&
    !conversation.queue.hasPendingWork
  const canCompactContext =
    isSessionPersistenceReady &&
    !isReviewHistoryUnavailable &&
    activeSessionSupportsNativeCompaction &&
    activeSession?.status === 'idle' &&
    !activeSessionHasRuntimeInteraction &&
    !activeSession.interrupted &&
    !activeSession.fixLoopActive &&
    !activeSession.compacting &&
    !awaitsHistoryReplay
  const customizeAvailable =
    catalogSkillIds.has('customize') &&
    !sessionController.view.specialist.unavailable &&
    (!activeSpecialistAllowedSkillIds || activeSpecialistAllowedSkillIds.has('customize'))
  const activeSessionSaveAsSkillRunning =
    activeSessionSaveAsSkillPending || isSaveAsSkillRunning(activeSession)
  const saveAsSkillAvailability = resolveSaveAsSkillAvailability({
    session: activeSession,
    persistenceReady: isSessionPersistenceReady,
    runtimeInteraction: activeSessionHasRuntimeInteraction,
    pending: activeSessionSaveAsSkillPending,
    running: activeSessionSaveAsSkillRunning,
    customizeAvailable,
    hasRunningSubagents: hasCurrentRunningDelegatedAttempt(activeSession),
    sideChatOpen: sideChat.view !== undefined
  })
  const compactContextDisabledReason =
    !activeSessionSupportsNativeCompaction || awaitsHistoryReplay
      ? 'Send a message to reconnect this session before compacting.'
      : activeSession?.status === 'error'
        ? 'Resolve the current session error before compacting.'
        : 'Wait for the current agent activity to finish.'
  const durablePermissionError =
    activeSession?.status === 'waiting-permission' &&
    activeSession.runtimeContext?.permission?.state === 'pending'
      ? (activeSession.error ?? actionError)
      : null
  const planProjectionRecoveryError = conversation.planProjectionRecoveryError
    ? t('Unable to restore plan state. Retrying…')
    : null
  const visibleActionError =
    planProjectionRecoveryError ??
    activeManualReviewRequest?.error ??
    attachmentError ??
    sessionController.view.exportError ??
    (activeSession ? durablePermissionError : actionError)

  const compactActiveContext = useCallback((): void => {
    if (!activeSession || !canCompactContext) return
    void compactContext?.(activeSession.id)
  }, [activeSession, canCompactContext, compactContext])

  // The workspace requires an active project; if none is set (e.g. after a project delete), go home.
  useEffect(() => {
    if (!activeProjectId) goHome('automatic')
  }, [activeProjectId, goHome])

  useEffect(() => {
    if (
      !activeProjectId ||
      !isProjectListLoaded ||
      projectLoadError !== undefined ||
      activeProject !== undefined
    )
      return
    discardInvalidProject(activeProjectId)
  }, [activeProject, activeProjectId, discardInvalidProject, isProjectListLoaded, projectLoadError])

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

  // The first agent-side notebook call reveals the new notebook entry and its preview together.
  useEffect(() => {
    let cancelPendingOpen = (): void => undefined
    const removeNotebookAvailableListener = window.api.notebook.onAvailable((notebook) => {
      setNotebookReferences((references) => ({
        ...references,
        [notebook.sessionId]: notebook
      }))
      if (notebook.projectId !== scopedProjectId || notebook.sessionId !== activeSessionId) return
      cancelPendingOpen()
      cancelPendingOpen = revealNotebookWhenProjectActive(notebook)
    })

    return () => {
      removeNotebookAvailableListener()
      cancelPendingOpen()
    }
  }, [activeSessionId, scopedProjectId])

  useEffect(() => {
    return window.api.notebook.onChanged?.(invalidateSessionNotebookCache) ?? (() => undefined)
  }, [])

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
        projectId: activeSessionProjectId
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

  const resetNewConversationDelegation = delegationControl.resetNewConversation

  // Keeps New as a local draft reset after persistence hydration has selected restored sessions.
  const openNewConversation = useCallback((): void => {
    if (!isSessionPersistenceReady) return

    // The draft effect saves the outgoing doc/attachments and restores the new-conversation state.
    setAttachmentError(null)
    setNewConversationPermissionProfile(defaultPermissionProfile)
    setNewConversationAutoReviewEnabled(false)
    setNewConversationMemoryPreference(undefined)
    setNewConversationEnabledComputeHosts([])
    setNewConversationSelectedComputeHosts([])
    resetNewConversationDelegation()
    resetNewConversationConfiguration()
    useNavigationStore.getState().recordUserNavigation()
    sessionController.actions.resetNewConversationSpecialist()
    clearSelection()
  }, [
    clearSelection,
    defaultPermissionProfile,
    isSessionPersistenceReady,
    resetNewConversationConfiguration,
    resetNewConversationDelegation,
    sessionController.actions,
    setAttachmentError
  ])
  const activeSessionHasMessages = (activeSession?.messages.length ?? 0) > 0

  useEffect(() => {
    const openNewConversationFromShortcut = (event: KeyboardEvent): void => {
      const isMac = window.api?.platform === 'darwin'
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'n' ||
        event.altKey ||
        event.shiftKey ||
        !(isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
        document.querySelector(OPEN_DIALOG_SELECTOR) !== null
      ) {
        return
      }

      event.preventDefault()
      if (!activeSessionHasMessages) return
      openNewConversation()
    }

    window.addEventListener('keydown', openNewConversationFromShortcut)
    return () => window.removeEventListener('keydown', openNewConversationFromShortcut)
  }, [activeSessionHasMessages, openNewConversation])

  // Synchronizes the hidden chat session id with the selected session list item.
  const openSession = (sessionId: string): void => {
    // The draft effect saves the outgoing doc/attachments and restores the target session's state.
    setAttachmentError(null)
    useNavigationStore.getState().openSession(scopedProjectId, sessionId, 'user')
  }

  const openSessionWithoutExportError = (sessionId: string): void => {
    sessionController.actions.clearExportError()
    openSession(sessionId)
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

  const changeAutoReviewEnabled = (enabled: boolean): void => {
    if (!activeSession) {
      setNewConversationAutoReviewEnabled(enabled)
      return
    }

    setAutoReviewEnabled(activeSession.id, enabled)
  }

  const changeMemoryEnabled = (enabled: boolean): void => {
    if (!isGlobalMemoryEnabled) return
    if (!activeSession) return setNewConversationMemoryPreference(enabled)

    setAttachmentError(null)
    void runtime.setMemoryEnabled(activeSession.id, enabled).catch((error: unknown) => {
      setAttachmentError(error instanceof Error ? error.message : String(error))
    })
  }

  const requestManualReview = (): void => {
    if (!activeSession || isReviewHistoryUnavailable) return

    const request = assembleReviewRunRequest(activeSession.id)

    if (!request) return

    const sessionId = activeSession.id
    if (manualReviewPendingSessionIdsRef.current.has(sessionId)) return

    manualReviewPendingSessionIdsRef.current.add(sessionId)
    setManualReviewRequests((current) => ({
      ...current,
      [sessionId]: { pending: true, error: null }
    }))

    // Explicit user action: bypass main's auto-only per-turn idempotency so a manual review always runs.
    void (async () => {
      let error: string | null = null
      try {
        const result = await window.api.reviewer.run({ ...request, origin: 'manual' })
        if (!result.started && result.reason !== 'already-in-flight') {
          error = t('Review could not start. Try again.')
        }
      } catch {
        error = t('Review could not start. Try again.')
      } finally {
        manualReviewPendingSessionIdsRef.current.delete(sessionId)
        setManualReviewRequests((current) => {
          if (error) {
            return { ...current, [sessionId]: { pending: false, error } }
          }
          const next = { ...current }
          delete next[sessionId]
          return next
        })
      }
    })()
  }

  const requestArtifactFinalizationRetry = (): void => {
    if (!activeSession || artifactFinalizationRetrySessionId) return
    const sessionId = activeSession.id
    setArtifactFinalizationRetrySessionId(sessionId)
    void retryPendingArtifactFinalization(sessionId)
      .catch(() => undefined)
      .finally(() => {
        setArtifactFinalizationRetrySessionId((current) =>
          current === sessionId ? undefined : current
        )
      })
  }

  const requestSaveAsSkill = (): void => {
    if (!activeSession || !saveAsSkillAvailability.enabled) return
    const graph = activeSession.conversationGraph
    const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
    if (!frame) return
    setAttachmentError(null)
    void runtime
      .saveAsSkill({
        projectId: activeSession.projectId,
        sessionId: activeSession.id,
        agentFrameId: frame.id,
        messageBranchId: frame.activeBranchId
      })
      .catch((error: unknown) => {
        setAttachmentError(error instanceof Error ? error.message : String(error))
      })
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

  // Opens the right preview when the user explicitly selects the notebook entry.
  const openNotebookPreview = (notebook: NotebookSessionReference): void => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createNotebookPreviewItem(notebook))
  }

  // Opens the project file library as a stable preview workbench tool tab.
  const openFilesPreview = (): void => {
    if (!isSessionPersistenceReady) return

    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectFilesPreviewItem())
  }

  return (
    <main className="h-[100dvh] overflow-hidden bg-bg-10 text-[13px] leading-normal text-text-000 md:h-screen md:p-[10px]">
      <WorkspacePanelLayout
        hasPreviewItems={previewItems.length > 0}
        isPreviewPresentationActive={isPreviewPresentationActive}
        onPdfContextError={setAttachmentError}
        restoredPlanResponder={
          activeSession
            ? {
                sessionId: activeSession.id,
                respond: conversation.actions.submit.restoredPlan
              }
            : undefined
        }
        preview={{
          state: previewPanelState,
          openRequestVersion: previewOpenRequestVersion,
          toggle: togglePreviewPanel,
          syncState: syncPreviewPanelState
        }}
        previewAnnotations={previewAnnotations}
        renderDesktopSidebar={({ sidebarToggle, sidebarToggleRef }) => (
          <WorkspaceSidebarContainer
            projectId={scopedProjectId}
            isProjectArchived={activeProject?.archivedAt !== undefined}
            projectName={activeProject?.name ?? t('Project')}
            activeSessionId={selectedSessionId}
            canCreateConversation={isSessionPersistenceReady}
            canMutateConversations={isSessionPersistenceReady}
            canDeleteConversations={canDeleteConversations}
            onGoHome={() => goHome('user')}
            onNewConversation={openNewConversation}
            isFilesOpen={activePreviewItemId === PROJECT_FILES_PREVIEW_ID}
            onOpenFiles={openFilesPreview}
            onOpenSession={openSessionWithoutExportError}
            onRenameSession={sessionController.actions.openEdit}
            onRenameSessionTitle={sessionController.actions.renameTitle}
            canDownloadArtifacts={typeof window.api?.saveSessionArtifacts === 'function'}
            onDownloadArtifacts={sessionController.actions.openDownloadArtifacts}
            onViewNotebook={sessionController.actions.openNotebook}
            onExportSession={
              typeof window.api.sessions?.exportConversation === 'function'
                ? sessionController.actions.openExportConversation
                : undefined
            }
            onTogglePin={(session) => {
              sessionController.actions.togglePin(session)
            }}
            canArchiveSession={canArchiveSession}
            onArchiveSession={sessionController.actions.archive}
            onDeleteSession={sessionController.actions.openDelete}
            onOpenSettings={openSettings}
            onOpenProjectSettings={() => {
              if (activeProject) projectFormDialog.openEditDialog(activeProject)
            }}
            onNewProject={projectFormDialog.openCreateDialog}
            canDownloadProjectArtifacts={
              typeof window.api?.saveProjectArtifacts === 'function' &&
              !isDownloadingProjectArtifacts &&
              canCollectProjectArtifacts
            }
            onDownloadProjectArtifacts={() => setIsProjectDownloadOpen(true)}
            sidebarToggle={sidebarToggle}
            sidebarToggleButtonRef={sidebarToggleRef}
          />
        )}
        renderMobileSidebar={({ isOpen, close }) => (
          <WorkspaceSidebarContainer
            projectId={scopedProjectId}
            isProjectArchived={activeProject?.archivedAt !== undefined}
            projectName={activeProject?.name ?? t('Project')}
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
              sessionController.actions.openEdit(session)
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
                ? (session) => {
                    close()
                    sessionController.actions.openExportConversation(session)
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
            onOpenProjectSettings={() => {
              close()
              if (activeProject) projectFormDialog.openEditDialog(activeProject)
            }}
            onNewProject={() => {
              close()
              projectFormDialog.openCreateDialog()
            }}
            canDownloadProjectArtifacts={
              typeof window.api?.saveProjectArtifacts === 'function' &&
              !isDownloadingProjectArtifacts &&
              canCollectProjectArtifacts
            }
            onDownloadProjectArtifacts={() => {
              close()
              setIsProjectDownloadOpen(true)
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
            view={{
              activeSession,
              composerFocusKey: currentDraftKey,
              canEditDraft,
              actionError: visibleActionError,
              sideChatDisabledReason
            }}
            composer={composer}
            conversation={conversation}
            sideChat={sideChat}
            specialist={sessionController}
            layout={{
              isPreviewPanelCollapsed,
              togglePreviewPanel: togglePreviewPanelFromLayout,
              openSidebar: openMobileSidebar
            }}
            permissions={{
              requests: visiblePermissionRequests,
              credentialRequests: visibleCredentialRequests,
              permissionProfile: activePermissionProfile,
              permissionProfileState: activePermissionProfileState,
              permissionGrants: activePermissionGrants,
              canChangePermissionProfile,
              respond: respondToVisiblePermission,
              changeProfile: changePermissionProfile,
              revokeGrant: revokeActivePermissionGrant,
              clearGrants: clearActivePermissionGrants
            }}
            elicitation={{
              requests: visibleElicitationRequests,
              respond: respondToElicitation
            }}
            agentControls={{
              ...agentControlAvailability,
              canChangeMemory: agentControlAvailability.canChangeMemory && isGlobalMemoryEnabled,
              modelConfiguration: activeAgentConfiguration,
              modelUnavailable: agentConfigurationUnavailable,
              changeModelConfiguration: changeAgentConfiguration,
              autoReviewEnabled: activeAutoReviewEnabled,
              memoryEnabled: activeMemoryEnabled,
              delegationEnabled: delegationControl.enabled,
              delegationPending: delegationControl.pending,
              delegationHasLiveAttempts: delegationControl.hasLiveDelegatedAttempts,
              canChangeDelegation:
                isSessionPersistenceReady &&
                delegationControl.frameworkSupported &&
                delegationControl.sessionAuthoritative,
              delegationDisabledReason: delegationControl.frameworkSupported
                ? undefined
                : t('The selected agent framework does not support delegated work.'),
              memoryDisabledReason: isGlobalMemoryEnabled
                ? undefined
                : t('Memory is off in Settings. Turn it on to use Memory in this conversation.'),
              enabledComputeHosts: computeHostAccess.enabledProviderIds,
              selectedComputeHosts: computeHostAccess.selectedProviderIds,
              toggleAutoReview: changeAutoReviewEnabled,
              toggleMemory: changeMemoryEnabled,
              toggleDelegation: delegationControl.change,
              setComputeHostEnabled: computeHostAccess.setHostEnabled,
              setComputeHostSelected: computeHostAccess.setHostSelected
            }}
            contextWindow={{
              usage: activeContextUsage,
              canCompact: canCompactContext,
              compactDisabledReason: compactContextDisabledReason,
              compact: compactActiveContext
            }}
            workflows={{
              artifactFinalization: {
                running: artifactFinalizationRetrySessionId !== undefined,
                request: requestArtifactFinalizationRetry
              },
              review: {
                disabled: isRequestReviewDisabled,
                running: isReviewBusy,
                request: requestManualReview
              },
              saveAsSkill: {
                disabled: !saveAsSkillAvailability.enabled,
                disabledReason: saveAsSkillAvailability.disabledReason,
                running: activeSessionSaveAsSkillRunning,
                request: requestSaveAsSkill
              }
            }}
            sessionTools={{
              notebookReference: activeNotebookReference,
              openNotebook: openNotebookPreview,
              openJobs: sessionController.actions.openJobList
            }}
            subagents={{
              unavailable: activeSession
                ? delegatedWorkUnavailableBySession[activeSession.id]
                : undefined,
              stop: () => {
                if (!activeSession) return
                return window.api.acp
                  .cancel({ sessionId: activeSession.id, scope: 'subagents' })
                  .then(() => undefined)
              }
            }}
          />
        )}
      />

      <EditSessionDialog
        session={sessionController.view.dialogs.edit?.session}
        titleDraft={sessionController.view.dialogs.edit?.titleDraft ?? ''}
        descriptionDraft={sessionController.view.dialogs.edit?.descriptionDraft ?? ''}
        isSaving={sessionController.view.dialogs.edit?.isSaving}
        error={sessionController.view.dialogs.edit?.error}
        onTitleDraftChange={sessionController.actions.changeEditTitleDraft}
        onDescriptionDraftChange={sessionController.actions.changeEditDescriptionDraft}
        onCancel={sessionController.actions.closeEdit}
        onConfirmEdit={sessionController.actions.confirmEdit}
      />
      <DeleteSessionDialog
        session={sessionController.view.dialogs.delete?.session}
        canDelete={canDeleteConversations}
        isDeleting={sessionController.view.dialogs.delete?.isDeleting}
        error={sessionController.view.dialogs.delete?.error ?? undefined}
        onCancel={sessionController.actions.closeDelete}
        onConfirmDelete={conversation.actions.delete}
      />
      <DownloadSessionArtifactsDialog
        session={sessionController.view.dialogs.downloadArtifacts ?? undefined}
        onClose={sessionController.actions.closeDownloadArtifacts}
      />
      <ConversationExportDialog
        session={sessionController.view.dialogs.exportConversation ?? undefined}
        currentSession={currentExportConversationSession}
        onClose={sessionController.actions.closeExportConversation}
      />
      <DownloadProjectArtifactsDialog
        project={isProjectDownloadOpen ? activeProject : undefined}
        onClose={() => setIsProjectDownloadOpen(false)}
        onDownloadingChange={setIsDownloadingProjectArtifacts}
      />

      <FilePreviewDialog
        item={
          isPreviewPresentationActive && fileDialogItem?.projectId === activeProjectId
            ? fileDialogItem
            : undefined
        }
        onClose={usePreviewWorkbenchStore.getState().closeFileDialog}
        onItemChange={usePreviewWorkbenchStore.getState().openFileDialog}
        {...previewAnnotations}
        onPdfContextError={setAttachmentError}
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

      <ProjectFormDialog {...projectFormDialog.dialogProps} />
    </main>
  )
}

export { WorkspacePage }

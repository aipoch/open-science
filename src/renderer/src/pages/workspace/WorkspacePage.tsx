import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animate } from 'motion'
import { PanelLeft, PanelRight } from 'lucide-react'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import type { NotebookSessionReference } from '../../../../shared/notebook'
import {
  DEFAULT_PERMISSION_PROFILE,
  type PermissionProfileId
} from '../../../../shared/permission-profiles'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import { usePreviewPersistence } from '@/lib/preview-persistence/preview-persistence'
import { useNavigationStore } from '@/stores/navigation-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
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
import type { ConversationExportFormat } from '../../../../shared/conversation-export'
import {
  resolveEffectiveSpecialistSkills,
  type CompletionHandoffLifecycleEvent
} from '../../../../shared/specialist'

import { planComposerAttachmentIntake } from './composer-attachment-intake'
import { stageComposerFile, type ComposerUploadTransfer } from './composer-upload-transfer'
import {
  appendArtifactMention,
  docArtifactCount,
  docIsEmpty,
  docToArtifactRefs,
  docToSkillIds,
  docToText,
  emptyDoc,
  MAX_COMPOSER_ARTIFACT_MENTIONS,
  type ComposerDoc
} from './composer/composer-doc'
import {
  buildSessionComposerHistory,
  buildStarterComposerHistory,
  normalizeHistorySkills,
  type ComposerHistoryEntry
} from './composer/composer-history'
import { buildCustomizePrefillDoc } from '@/lib/customize-chat'
import { ConversationPanel } from './ConversationPanel'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { MobilePreviewSheet } from './MobilePreviewSheet'
import { DownloadSessionArtifactsDialog } from './DownloadSessionArtifactsDialog'
import { FilePreviewDialog } from './FilePreviewDialog'
import { PreviewPanel } from './PreviewPanel'
import { RenameSessionDialog } from './RenameSessionDialog'
import { SessionNotebookDialog } from './SessionNotebookDialog'
import { JobDetailModal } from '@/components/JobDetailModal'
import { getVisiblePermissionRequests } from './session-permissions'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { useJobAnalysisEffect } from '@/lib/compute/useJobAnalysisEffect'
import { selectActiveBranchPlan } from './session-plan/active-branch-plan'

type WorkspacePageProps = {
  isSessionPersistenceHydrated: boolean
  isSessionPersistenceReady: boolean
  canDeleteConversations: boolean
}

type ComposerHistoryNavigation = {
  entries: ComposerHistoryEntry[]
  cursorId: string
  scratch: ComposerDoc
}

// Converts unknown async failures into composer-visible text.
const getErrorMessage = (error: unknown): string =>
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

// New-conversation drafts are project-scoped so switching projects never leaks unsent intent.
const newConversationDraftKeyFor = (projectId: string): string => `new:${projectId}`

const PANEL_COLLAPSED_SIZE = 0
const PANEL_COLLAPSED_SIZE_CSS = `${PANEL_COLLAPSED_SIZE}%`
const PANEL_COLLAPSED_THRESHOLD = 0.1

const SIDEBAR_PANEL_DEFAULT_SIZE = 16
const SIDEBAR_PANEL_DEFAULT_SIZE_CSS = `${SIDEBAR_PANEL_DEFAULT_SIZE}%`
const SIDEBAR_PANEL_MIN_OPEN_SIZE = 16
const SIDEBAR_PANEL_MIN_OPEN_SIZE_CSS = `${SIDEBAR_PANEL_MIN_OPEN_SIZE}%`
const SIDEBAR_PANEL_ANIMATING_MIN_SIZE = PANEL_COLLAPSED_SIZE_CSS
const SIDEBAR_TOGGLE_RIGHT_INSET = 38

const PREVIEW_PANEL_DEFAULT_SIZE = 40
const PREVIEW_PANEL_DEFAULT_SIZE_CSS = `${PREVIEW_PANEL_DEFAULT_SIZE}%`
const PREVIEW_PANEL_MIN_OPEN_SIZE = 30
const PREVIEW_PANEL_MIN_OPEN_SIZE_CSS = `${PREVIEW_PANEL_MIN_OPEN_SIZE}%`
const PREVIEW_PANEL_ANIMATING_MIN_SIZE = PANEL_COLLAPSED_SIZE_CSS
const previewPanelAnimation = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number]
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

type ResizablePanelState = 'open' | 'collapsed'
type PanelAnimationDirection = 'opening' | 'closing'

type AnimatedResizablePanelOptions = {
  panelState: ResizablePanelState
  defaultOpenSize: number
  minOpenSize: number
  collapsedSize: number
  collapsedThreshold: number
  requestVersion?: number
  onPanelStateChange: (state: ResizablePanelState) => void
  onPixelWidthChange?: (width: number) => void
  collapseFocusTargetRef: React.RefObject<HTMLButtonElement | null>
}

// Shares the imperative animation lifecycle while each panel keeps ownership of its business state.
const useAnimatedResizablePanel = ({
  panelState,
  defaultOpenSize,
  minOpenSize,
  collapsedSize,
  collapsedThreshold,
  requestVersion = 0,
  onPanelStateChange,
  onPixelWidthChange,
  collapseFocusTargetRef
}: AnimatedResizablePanelOptions): {
  panelRef: React.RefObject<PanelImperativeHandle | null>
  separatorRef: React.RefObject<HTMLDivElement | null>
  isAnimationMinSizeRelaxed: boolean
  syncPanelResize: (panelSize: PanelSize, previousPanelSize: PanelSize | undefined) => void
} => {
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  const separatorRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<{ stop: () => void } | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const animationDirectionRef = useRef<PanelAnimationDirection | null>(null)
  const lastOpenSizeRef = useRef(defaultOpenSize)
  const hasSyncedInitialSizeRef = useRef(false)
  const [isAnimationMinSizeRelaxed, setIsAnimationMinSizeRelaxed] = useState(false)

  const animatePanelSize = useCallback(
    (
      targetSize: number,
      direction: PanelAnimationDirection,
      options?: { animate?: boolean }
    ): void => {
      const panel = panelRef.current
      if (!panel) return

      animationRef.current?.stop()
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }

      const resizePanel = (size: number): boolean => {
        const currentPanel = panelRef.current

        // Ignore motion callbacks that outlive the panel handle they were created for.
        if (currentPanel !== panel) return false

        currentPanel.resize(`${Number(size.toFixed(3))}%`)
        return true
      }

      const startFromSize = (currentSize: number): void => {
        if (
          options?.animate === false ||
          Math.abs(currentSize - targetSize) <= collapsedThreshold ||
          prefersReducedMotion()
        ) {
          resizePanel(targetSize)
          if (direction === 'opening') lastOpenSizeRef.current = targetSize
          animationDirectionRef.current = null
          animationRef.current = null
          setIsAnimationMinSizeRelaxed(false)
          return
        }

        animationDirectionRef.current = direction
        setIsAnimationMinSizeRelaxed(true)
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null
          const nextPanel = panelRef.current
          if (!nextPanel) return

          const nextCurrentSize = nextPanel.getSize().asPercentage
          animationRef.current = animate(nextCurrentSize, targetSize, {
            ...previewPanelAnimation,
            onUpdate: resizePanel,
            onComplete: () => {
              const didResize = resizePanel(targetSize)
              if (didResize && direction === 'opening') lastOpenSizeRef.current = targetSize
              animationDirectionRef.current = null
              animationRef.current = null
              setIsAnimationMinSizeRelaxed(false)
            }
          })
        })
      }

      try {
        startFromSize(panel.getSize().asPercentage)
      } catch {
        // react-resizable-panels can briefly expose the handle before its layout is registered.
        // Retry once on the next frame instead of dropping the requested restored state.
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null
          const nextPanel = panelRef.current
          if (nextPanel !== panel) return

          try {
            startFromSize(nextPanel.getSize().asPercentage)
          } catch {
            // A detached/unregistered panel will be synchronized by the next state/layout pass.
          }
        })
      }
    },
    [collapsedThreshold]
  )

  const syncPanelResize = useCallback(
    (panelSize: PanelSize, previousPanelSize: PanelSize | undefined): void => {
      onPixelWidthChange?.(panelSize.inPixels)

      const isNearCollapsedSize = panelSize.asPercentage <= collapsedThreshold
      const animationDirection = animationDirectionRef.current
      const isOpeningAnimationResize =
        animationDirection === 'opening' &&
        (previousPanelSize === undefined ||
          panelSize.asPercentage >= previousPanelSize.asPercentage)
      const isClosingAnimationResize =
        animationDirection === 'closing' &&
        (previousPanelSize === undefined ||
          panelSize.asPercentage <= previousPanelSize.asPercentage)

      // Ignore same-direction intermediate sizes, but allow an opposite drag to interrupt animation.
      if (isNearCollapsedSize && isOpeningAnimationResize) return
      if (!isNearCollapsedSize && isClosingAnimationResize) return

      if (!isNearCollapsedSize && animationDirection === null) {
        lastOpenSizeRef.current = panelSize.asPercentage
      }

      // A keyboard collapse must not leave focus on the separator that is about to be hidden.
      if (isNearCollapsedSize && document.activeElement === separatorRef.current) {
        collapseFocusTargetRef.current?.focus()
      }

      onPanelStateChange(isNearCollapsedSize ? 'collapsed' : 'open')
    },
    [collapseFocusTargetRef, collapsedThreshold, onPanelStateChange, onPixelWidthChange]
  )

  // The first layout pass synchronizes restored state without introducing an entrance animation.
  useLayoutEffect(() => {
    const shouldAnimate = hasSyncedInitialSizeRef.current
    hasSyncedInitialSizeRef.current = true

    if (panelState === 'collapsed') {
      animatePanelSize(collapsedSize, 'closing', { animate: shouldAnimate })
      return
    }

    const targetSize = Math.max(lastOpenSizeRef.current, minOpenSize)
    animatePanelSize(targetSize, 'opening', { animate: shouldAnimate })
  }, [animatePanelSize, collapsedSize, minOpenSize, panelState, requestVersion])

  useEffect(
    () => () => {
      animationRef.current?.stop()
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current)
      }
    },
    []
  )

  return { panelRef, separatorRef, isAnimationMinSizeRelaxed, syncPanelResize }
}

// Mirrors the right preview toggle while staying outside the collapsible sidebar panel.
const SidebarPanelToggleButton = ({
  buttonRef,
  isCollapsed,
  left,
  onToggle
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  isCollapsed: boolean
  left: string
  onToggle: () => void
}): React.JSX.Element => (
  <button
    ref={buttonRef}
    type="button"
    data-testid="workspace-sidebar-toggle"
    className="absolute top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-action-panel-toggle shadow-none hover:bg-surface-control-hover"
    style={{ left }}
    aria-label={isCollapsed ? 'Expand sidebar panel' : 'Collapse sidebar panel'}
    aria-expanded={!isCollapsed}
    aria-controls="left-panel"
    title={isCollapsed ? 'Expand sidebar panel' : 'Collapse sidebar panel'}
    onClick={onToggle}
  >
    <PanelLeft className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
  </button>
)

// The preview toggle lives outside the collapsible panel so it remains clickable at 0% width.
const PreviewPanelToggleButton = ({
  buttonRef,
  isCollapsed,
  onToggle
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  isCollapsed: boolean
  onToggle: () => void
}): React.JSX.Element => (
  <button
    ref={buttonRef}
    type="button"
    data-testid="workspace-preview-toggle"
    className={`absolute right-2 top-0 z-40 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg ${
      isCollapsed
        ? 'bg-transparent shadow-none text-action-panel-toggle hover:bg-surface-control-hover'
        : 'bg-primary/20 shadow-card backdrop-blur text-action-panel-toggle'
    }`}
    aria-label={isCollapsed ? 'Expand preview panel' : 'Collapse preview panel'}
    aria-expanded={!isCollapsed}
    aria-controls="right-panel"
    title={isCollapsed ? 'Expand preview panel' : 'Collapse preview panel'}
    onClick={onToggle}
  >
    <PanelRight className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
  </button>
)

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
  const [sidebarPanelState, setSidebarPanelState] = useState<'open' | 'collapsed'>('open')
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null)
  const previewToggleRef = useRef<HTMLButtonElement | null>(null)
  const syncSidebarTogglePosition = useCallback((panelWidth: number): void => {
    const toggle = sidebarToggleRef.current
    if (!toggle) return

    toggle.style.left = `${Math.max(0, panelWidth - SIDEBAR_TOGGLE_RIGHT_INSET)}px`
  }, [])
  const {
    panelRef: sidebarPanelRef,
    separatorRef: sidebarSeparatorRef,
    isAnimationMinSizeRelaxed: isSidebarPanelAnimationMinSizeRelaxed,
    syncPanelResize: syncSidebarPanelResize
  } = useAnimatedResizablePanel({
    panelState: sidebarPanelState,
    defaultOpenSize: SIDEBAR_PANEL_DEFAULT_SIZE,
    minOpenSize: SIDEBAR_PANEL_MIN_OPEN_SIZE,
    collapsedSize: PANEL_COLLAPSED_SIZE,
    collapsedThreshold: PANEL_COLLAPSED_THRESHOLD,
    onPanelStateChange: setSidebarPanelState,
    onPixelWidthChange: syncSidebarTogglePosition,
    collapseFocusTargetRef: sidebarToggleRef
  })
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

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
  const renameSession = useSessionStore((state) => state.renameSession)
  const togglePinned = useSessionStore((state) => state.togglePinned)
  const updateSessionArchive = useSessionStore((state) => state.updateSessionArchive)
  const enqueueSessionArchive = useArchiveUndoStore((state) => state.enqueueSession)
  const setAutoReviewEnabled = useSessionStore((state) => state.setAutoReviewEnabled)
  const setEnabledComputeHosts = useSessionStore((state) => state.setEnabledComputeHosts)
  const setSessionSpecialistId = useSessionStore((state) => state.setSessionSpecialistId)
  const markSpecialistSwitchResetRequired = useSessionStore(
    (state) => state.markSpecialistSwitchResetRequired
  )
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
  const previewPanelState = usePreviewWorkbenchStore((state) => state.panelState)
  const previewItems = usePreviewWorkbenchStore((state) => state.items)
  const [initialPreviewPanelDefaultSize] = useState(() =>
    previewPanelState === 'collapsed' ? PANEL_COLLAPSED_SIZE_CSS : PREVIEW_PANEL_DEFAULT_SIZE_CSS
  )
  const activePreviewItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const previewOpenRequestVersion = usePreviewWorkbenchStore((state) => state.openRequestVersion)
  const fileDialogItem = usePreviewWorkbenchStore((state) => state.fileDialogItem)
  const closeFileDialog = usePreviewWorkbenchStore((state) => state.closeFileDialog)
  const upsertPreviewItem = usePreviewWorkbenchStore((state) => state.upsertItem)
  const upsertAndActivatePreviewItem = usePreviewWorkbenchStore(
    (state) => state.upsertAndActivateItem
  )
  const togglePreviewPanel = usePreviewWorkbenchStore((state) => state.togglePanel)
  const syncPreviewPanelState = usePreviewWorkbenchStore((state) => state.syncPanelState)
  const {
    panelRef: previewPanelRef,
    separatorRef: previewSeparatorRef,
    isAnimationMinSizeRelaxed: isPreviewPanelAnimationMinSizeRelaxed,
    syncPanelResize: syncPreviewPanelResize
  } = useAnimatedResizablePanel({
    panelState: previewPanelState,
    defaultOpenSize: PREVIEW_PANEL_DEFAULT_SIZE,
    minOpenSize: PREVIEW_PANEL_MIN_OPEN_SIZE,
    collapsedSize: PANEL_COLLAPSED_SIZE,
    collapsedThreshold: PANEL_COLLAPSED_THRESHOLD,
    requestVersion: previewOpenRequestVersion,
    onPanelStateChange: syncPreviewPanelState,
    collapseFocusTargetRef: previewToggleRef
  })
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

  // Auto-trigger an analysis turn when a remote job finishes (design §11).
  useJobAnalysisEffect({ enabled: isSessionPersistenceReady, sendMessage })
  const [draftDoc, setDraftDoc] = useState<ComposerDoc>(emptyDoc)
  const [historySkillCatalogReady, setHistorySkillCatalogReady] = useState(
    () => catalogSkills.length > 0 || !window.api?.settings?.listSkills
  )
  const previousDraftKeyRef = useRef<string>(currentDraftKey)
  const composerHistoryRef = useRef<Record<string, ComposerHistoryNavigation>>({})
  const [historyBrowsingKey, setHistoryBrowsingKey] = useState<string | undefined>(undefined)
  const [historyStatus, setHistoryStatus] = useState('')
  const clearComposerHistory = useCallback(
    (draftKey: string): void => {
      delete composerHistoryRef.current[draftKey]
      setHistoryBrowsingKey((current) => (current === draftKey ? undefined : current))
      if (previousDraftKeyRef.current === draftKey) setHistoryStatus('')
    },
    [previousDraftKeyRef, setHistoryBrowsingKey, setHistoryStatus]
  )
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

  // Consume the `Chat with agent` prefill intent in the render phase (matching the pending-skill /
  // pending-panel pattern): land the exact `/customize` ComposerDoc on the New Conversation draft once,
  // clear any Specialist binding for that fresh draft, then clear the store intent below. The intent is
  // navigation/prefill only — it never sends, creates a session, or implies mutation approval. The
  // appliedCustomizePrefill state tracks the intent already applied so a re-render does not clobber an
  // edited draft.
  const [appliedCustomizePrefill, setAppliedCustomizePrefill] = useState<string | undefined>(
    undefined
  )
  if (
    pendingCustomizePrefill !== undefined &&
    pendingCustomizePrefill === activeProjectId &&
    selectedSessionId === undefined &&
    appliedCustomizePrefill !== pendingCustomizePrefill
  ) {
    setAppliedCustomizePrefill(pendingCustomizePrefill)
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('')
    setDraftDoc(buildCustomizePrefillDoc())
    // A fresh New Conversation draft carries no Specialist binding (no badge, no Customize Profile).
    setNewConversationSpecialistId(undefined)
  }

  useLayoutEffect(() => {
    if (appliedCustomizePrefill === activeProjectId) {
      delete composerHistoryRef.current[newConversationDraftKey]
    }
  }, [activeProjectId, appliedCustomizePrefill, composerHistoryRef, newConversationDraftKey])

  // Per-session pending specialist selection for existing conversations.
  // Key: sessionId. Value: the pending UUID (or undefined to clear binding).
  // The pending value is the user's last selection; it takes effect on the next send via reconfigure
  // barrier. Multiple switches before send only keep the last one (last-write-wins).
  const [pendingSessionSpecialist, setPendingSessionSpecialist] = useState<
    Record<string, string | undefined>
  >({})

  // Latest specialist catalog, mirrored into a ref so the pending-switch broadcast subscription
  // stays stable (subscribes once on mount) while still reading fresh data when a host.agents.switch()
  // broadcast arrives. Set in an effect (never during render) to comply with the react-hooks/refs rule.
  const specialistItemsRef = useRef(specialistItems)

  // Reconfigure failure state: set when a user-initiated pre-send dispose/resume fails.
  // Approved handoff failures belong solely to their transcript lifecycle row, which owns Retry.
  // This keeps a single handoff failure from rendering a second composer banner.
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
  // Closes the synchronous gap before the hook's reactive preparation state re-renders this page.
  // A second submit for the same draft key returns without clearing its possibly newer local draft.
  const sendRequestsInFlightRef = useRef(new Set<string>())
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
  // Tracks user-authored mutations separately from optimistic send clearing and conversation switches.
  // A failed prepared send may restore its captured draft only if this version has not advanced.
  const composerDraftVersionsRef = useRef<Record<string, number>>({})
  const markComposerDraftChanged = useCallback(
    (draftKey = previousDraftKeyRef.current): void => {
      composerDraftVersionsRef.current[draftKey] =
        (composerDraftVersionsRef.current[draftKey] ?? 0) + 1
    },
    [composerDraftVersionsRef, previousDraftKeyRef]
  )
  const changeComposerDraftDoc = useCallback(
    (doc: ComposerDoc): void => {
      clearComposerHistory(previousDraftKeyRef.current)
      markComposerDraftChanged()
      setDraftDoc(doc)
    },
    [clearComposerHistory, markComposerDraftChanged, previousDraftKeyRef, setDraftDoc]
  )
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [attachmentTransfers, setAttachmentTransfers] = useState<ComposerUploadTransfer[]>([])
  const attachmentTransfersRef = useRef<ComposerUploadTransfer[]>([])
  const attachmentTransferControllersRef = useRef<Record<string, AbortController>>({})
  const cancelledAttachmentTransfersRef = useRef(new Set<string>())
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [notebookReferences, setNotebookReferences] = useState<
    Record<string, NotebookSessionReference>
  >({})
  const [sessionToRename, setSessionToRename] = useState<ChatSession | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')
  const [sessionToDownloadArtifacts, setSessionToDownloadArtifacts] = useState<
    ChatSession | undefined
  >(undefined)
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | undefined>(undefined)
  const [sessionDeletionInProgressIds, setSessionDeletionInProgressIds] = useState<
    ReadonlySet<string>
  >(new Set())
  const [archivingSessionIds, setArchivingSessionIds] = useState<ReadonlySet<string>>(new Set())
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
  const composerHistoryEntries = useMemo(
    () =>
      activeSession
        ? buildSessionComposerHistory(activeSession)
        : buildStarterComposerHistory(sessions),
    [activeSession, sessions]
  )
  const historySpecialistId = activeSession
    ? Object.hasOwn(pendingSessionSpecialist, activeSession.id)
      ? pendingSessionSpecialist[activeSession.id]
      : activeSession.specialistId
    : newConversationSpecialistId
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
  const navigateComposerHistory = useCallback(
    (direction: 'previous' | 'next'): boolean => {
      if (attachments.length > 0 || attachmentTransfers.length > 0) return false

      let navigation = composerHistoryRef.current[currentDraftKey]
      if (!navigation) {
        if (direction === 'next' || composerHistoryEntries.length === 0) return false
        navigation = {
          entries: composerHistoryEntries,
          cursorId: composerHistoryEntries[0].id,
          scratch: draftDoc
        }
        composerHistoryRef.current[currentDraftKey] = navigation
      } else {
        const cursor = navigation.entries.findIndex((entry) => entry.id === navigation.cursorId)
        if (cursor < 0) return false
        if (direction === 'next' && cursor === 0) {
          delete composerHistoryRef.current[currentDraftKey]
          markComposerDraftChanged(currentDraftKey)
          setDraftDoc(navigation.scratch)
          setHistoryBrowsingKey(undefined)
          setHistoryStatus('Draft restored')
          return true
        }
        const nextCursor = direction === 'previous' ? cursor + 1 : cursor - 1
        if (nextCursor < 0 || nextCursor >= navigation.entries.length) return false
        navigation.cursorId = navigation.entries[nextCursor].id
      }

      const cursor = navigation.entries.findIndex((entry) => entry.id === navigation.cursorId)
      const entry = navigation.entries[cursor]
      if (!entry) return false
      if (
        entry.doc.nodes.some((node) => node.type === 'skill') &&
        (!historySkillCatalogReady ||
          (historySpecialistId !== undefined && !specialistCatalogLoaded))
      ) {
        delete composerHistoryRef.current[currentDraftKey]
        if (!historySkillCatalogReady) {
          void loadSkills()
            .then(() => setHistorySkillCatalogReady(true))
            .catch(() => undefined)
        }
        if (historySpecialistId !== undefined && !specialistCatalogLoaded) {
          void loadSpecialists()
        }
        setHistoryStatus('Prompt history is loading. Press Up Arrow again shortly.')
        return false
      }

      const normalized = normalizeHistorySkills(entry.doc, catalogSkillIds, historyAllowedSkillIds)
      markComposerDraftChanged(currentDraftKey)
      setDraftDoc(normalized.doc)
      setHistoryBrowsingKey(currentDraftKey)
      setHistoryStatus(
        `History item ${cursor + 1} of ${navigation.entries.length}${
          normalized.unavailableSkillNames.length > 0
            ? `. ${normalized.unavailableSkillNames.map((name) => `/${name}`).join(', ')} unavailable`
            : ''
        }`
      )
      return true
    },
    [
      attachmentTransfers.length,
      attachments.length,
      catalogSkillIds,
      composerHistoryRef,
      composerHistoryEntries,
      currentDraftKey,
      draftDoc,
      historyAllowedSkillIds,
      historySkillCatalogReady,
      historySpecialistId,
      loadSkills,
      loadSpecialists,
      markComposerDraftChanged,
      setDraftDoc,
      setHistoryBrowsingKey,
      setHistorySkillCatalogReady,
      setHistoryStatus,
      specialistCatalogLoaded
    ]
  )

  // Catalog or Specialist policy can change after a prompt was recalled; remove newly-invalid chips
  // before the user can send a turn that the runtime would reject after optimistic append.
  useEffect(() => {
    if (
      historyBrowsingKey !== currentDraftKey ||
      !historySkillCatalogReady ||
      (historySpecialistId !== undefined && !specialistCatalogLoaded)
    ) {
      return
    }
    const navigation = composerHistoryRef.current[currentDraftKey]
    const cursor = navigation?.entries.findIndex((entry) => entry.id === navigation.cursorId) ?? -1
    const entry = navigation?.entries[cursor]
    if (!navigation || !entry) return
    const normalized = normalizeHistorySkills(entry.doc, catalogSkillIds, historyAllowedSkillIds)
    if (JSON.stringify(normalized.doc) !== JSON.stringify(draftDoc)) {
      markComposerDraftChanged(currentDraftKey)
      setDraftDoc(normalized.doc)
    }
    setHistoryStatus(
      `History item ${cursor + 1} of ${navigation.entries.length}${
        normalized.unavailableSkillNames.length > 0
          ? `. ${normalized.unavailableSkillNames.map((name) => `/${name}`).join(', ')} unavailable`
          : ''
      }`
    )
  }, [
    catalogSkillIds,
    currentDraftKey,
    draftDoc,
    historyAllowedSkillIds,
    historyBrowsingKey,
    historySkillCatalogReady,
    historySpecialistId,
    markComposerDraftChanged,
    specialistCatalogLoaded
  ])

  // A Branch switch or deleted starter source replaces the visible history projection; abandon the
  // frozen round and restore its scratch instead of exposing prompts from a no-longer-visible source.
  useEffect(() => {
    if (historyBrowsingKey !== currentDraftKey) return
    const navigation = composerHistoryRef.current[currentDraftKey]
    if (!navigation) return
    const visibleIds = new Set(composerHistoryEntries.map((entry) => entry.id))
    const frozenSourcesStillVisible = navigation.entries.every((entry) => visibleIds.has(entry.id))
    if (
      frozenSourcesStillVisible &&
      (!activeSession || navigation.entries.length === composerHistoryEntries.length)
    ) {
      return
    }
    delete composerHistoryRef.current[currentDraftKey]
    markComposerDraftChanged(currentDraftKey)
    setDraftDoc(navigation.scratch)
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('Draft restored')
  }, [
    activeSession,
    composerHistoryEntries,
    currentDraftKey,
    historyBrowsingKey,
    markComposerDraftChanged
  ])
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
  const activeSessionHasSendPreparation = activeSession
    ? sendPreparationInFlightSessionIds.includes(activeSession.id)
    : false
  const activeSessionHasRuntimeInteraction = activeSession
    ? promptInFlightSessionIds.includes(activeSession.id) || activeSessionHasSendPreparation
    : false
  const canArchiveSession = (session: ChatSession): boolean => {
    const hasUnfinishedTransfer = (transfers: readonly ComposerUploadTransfer[]): boolean =>
      transfers.some(
        (transfer) =>
          transfer.status === 'queued' ||
          transfer.status === 'uploading' ||
          transfer.status === 'cancelling'
      )

    return (
      isSessionPersistenceReady &&
      !session.isPending &&
      session.archivedAt === undefined &&
      !archivingSessionIds.has(session.id) &&
      !sessionDeletionInProgressIds.has(session.id) &&
      !promptInFlightSessionIds.includes(session.id) &&
      !sendPreparationInFlightSessionIds.includes(session.id) &&
      session.status !== 'running' &&
      session.status !== 'waiting-permission' &&
      session.status !== 'waiting-plan-approval' &&
      !hasUnfinishedTransfer(
        session.id === activeSessionId
          ? attachmentTransfers
          : (composerDraftsRef.current[session.id]?.attachmentTransfers ?? [])
      )
    )
  }
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
  // Composer controls follow only the selected session and persistence readiness.
  const canEditDraft =
    isSessionPersistenceReady &&
    !activeSessionHasSendPreparation &&
    activeSession?.status !== 'waiting-plan-approval'
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
    !sessionDeletionInProgressIds.has(activeSession?.id ?? '')
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
  const visibleActionError = attachmentError ?? exportError ?? (activeSession ? null : actionError)

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

  // History can revive executable Skill chips, so resolve the catalog before recalling such entries.
  useEffect(() => {
    if (!window.api?.settings?.listSkills) return
    let active = true
    void loadSkills()
      .then(() => {
        if (active) setHistorySkillCatalogReady(true)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [loadSkills])

  // Escape closes the mobile navigation drawer without touching the active session or draft.
  useEffect(() => {
    if (!isMobile || !isMobileSidebarOpen) return

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMobileSidebarOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isMobile, isMobileSidebarOpen])
  // Save the outgoing draft and load the incoming one whenever the selected session changes, covering
  // every selection path (session list, new conversation, project switch, deletes) in one place.
  useEffect(() => {
    const previousDraftKey = previousDraftKeyRef.current

    if (currentDraftKey === previousDraftKey) return

    const outgoingHistory = composerHistoryRef.current[previousDraftKey]
    composerDraftsRef.current[previousDraftKey] = {
      doc: outgoingHistory?.scratch ?? draftDoc,
      attachments,
      attachmentTransfers
    }
    delete composerHistoryRef.current[previousDraftKey]
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('')
    // When the selection lands on the New Conversation key while a `Chat with agent` prefill is
    // pending for the active project, the render-phase consumer above has already set the exact
    // `/customize` doc. This effect runs AFTER that render-phase write, so loading the stored/empty
    // draft here would clobber the prefill (the last writer wins). Bail out instead: advance the
    // tracked key so a later switch still saves the prefill draft, and clear any attachments that
    // leaked from the previously-selected session so the fresh draft starts clean.
    const customizePrefillPending =
      currentDraftKey === newConversationDraftKey &&
      pendingCustomizePrefill !== undefined &&
      pendingCustomizePrefill === activeProjectId
    if (customizePrefillPending) {
      // The render-phase consumer above has already landed the exact `/customize` doc. Only the
      // attachments need clearing here (they may have leaked from the previously-selected session).
      // Do NOT reload the stored/empty draft doc — that would clobber the prefill (last writer wins).
      const freshDraft = composerDraftsRef.current[currentDraftKey] ?? {
        doc: emptyDoc,
        attachments: [],
        attachmentTransfers: []
      }
      setAttachments(freshDraft.attachments)
      setAttachmentTransfers(freshDraft.attachmentTransfers)
      previousDraftKeyRef.current = currentDraftKey
      return
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
  }, [
    currentDraftKey,
    newConversationDraftKey,
    draftDoc,
    attachments,
    attachmentTransfers,
    pendingCustomizePrefill,
    activeProjectId
  ])

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
    setNewConversationPermissionProfile(defaultPermissionProfile)
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
    clearComposerHistory(draftKey)
    markComposerDraftChanged(draftKey)
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
    markComposerDraftChanged(draftKey)
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
    markComposerDraftChanged()
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

    const sendRequestKey = activeSession?.id ?? newConversationDraftKey
    if (sendRequestsInFlightRef.current.has(sendRequestKey)) return
    sendRequestsInFlightRef.current.add(sendRequestKey)
    const sendDraftVersion = composerDraftVersionsRef.current[sendRequestKey] ?? 0

    const doc = draftDoc
    const attachmentsForSend = attachments
    // Capture new-conversation intent before send: auto-review defaults off, so only an explicit
    // "on" needs to be stamped onto the created session (absent = off downstream).
    const wasNewConversation = !activeSession
    const draftAutoReviewEnabled = newConversationAutoReviewEnabled
    const draftEnabledComputeHosts = newConversationEnabledComputeHosts
    // Capture pending specialist for existing sessions (last change wins). `undefined` is a valid
    // pending choice meaning Main Agent, so ownership—not truthiness—distinguishes it from no choice.
    const hasStoredPendingSpecialist =
      activeSession !== undefined && Object.hasOwn(pendingSessionSpecialist, activeSession.id)
    const pendingSpecialistId = activeSession
      ? pendingSessionSpecialist[activeSession.id]
      : undefined
    // Capture the final specialist selection (last change wins before first send).
    const draftSpecialistId = branchInNewSession
      ? hasStoredPendingSpecialist
        ? (pendingSpecialistId ?? null)
        : activeSession?.specialistId
      : wasNewConversation
        ? newConversationSpecialistId
        : undefined
    const hasPendingSwitch = !branchInNewSession && hasStoredPendingSpecialist

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
            // A newer edit on the same draft key wins over this failed request. Otherwise restore the
            // captured draft either to the active composer or to its inactive conversation slot.
            if ((composerDraftVersionsRef.current[sendRequestKey] ?? 0) === sendDraftVersion) {
              if (previousDraftKeyRef.current === sendRequestKey) {
                setDraftDoc(doc)
                setAttachments(attachmentsForSend)
              } else {
                composerDraftsRef.current[sendRequestKey] = {
                  doc,
                  attachments: attachmentsForSend,
                  attachmentTransfers:
                    composerDraftsRef.current[sendRequestKey]?.attachmentTransfers ?? []
                }
              }
            } else {
              // The user replaced this draft while preparation was pending. Keep that newer intent and
              // discard staged files that now belong only to the superseded failed request.
              deleteAttachmentFiles(attachmentsForSend)
            }
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
        .finally(() => sendRequestsInFlightRef.current.delete(sendRequestKey))
    }

    // Runs the reconfigure barrier then dispatches the send on success. Extracted so that both the
    // initial send path and the Retry recovery action can invoke the same ordered sequence.
    const runBarrierAndSend = async (
      sessionId: string,
      specialistId: string | undefined
    ): Promise<void> => {
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
          specialistId === undefined
            ? 'Main Agent'
            : pendingProfile?.kind === 'custom'
              ? pendingProfile.name
              : 'the selected specialist'
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
        sendRequestsInFlightRef.current.delete(sendRequestKey)
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
      clearComposerHistory(sessionId)
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
    clearComposerHistory(currentDraftKey)
    // Drop the stored draft for this key so a sent message never lingers as a restorable draft.
    delete composerDraftsRef.current[currentDraftKey]
    setAttachments([])
    setAttachmentError(null)

    dispatchSend(branchInNewSession ? undefined : activeSession?.id)
  }

  const branchCurrentMessage = (forcedSkillIds: string[]): void => {
    sendCurrentMessage(forcedSkillIds, { branchInNewSession: true })
  }

  const planCurrentMessage = (forcedSkillIds: string[]): void => {
    sendCurrentMessage(forcedSkillIds, { turnIntent: 'plan-first' })
  }

  // Opens the rename dialog with the current title prefilled.
  const openRenameDialog = (session: ChatSession): void => {
    if (!isSessionPersistenceReady) return

    setSessionToRename(session)
    setRenameDraft(session.title)
  }

  // Main reloads the durable session and owns both normalization and the native Save As operation.
  const exportConversation = (session: ChatSession, format: ConversationExportFormat): void => {
    setExportError(null)
    void window.api.sessions
      .exportConversation({
        projectId: session.projectId,
        sessionId: session.id,
        format
      })
      .catch((error: unknown) => setExportError(getErrorMessage(error)))
  }

  const openSessionWithoutExportError = (sessionId: string): void => {
    setExportError(null)
    openSession(sessionId)
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

  const archiveSession = (session: ChatSession): void => {
    if (!canArchiveSession(session)) return

    setArchivingSessionIds((current) => new Set(current).add(session.id))
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
      .catch((error: unknown) => setExportError(getErrorMessage(error)))
      .finally(() => {
        setArchivingSessionIds((current) => {
          const next = new Set(current)
          next.delete(session.id)
          return next
        })
      })
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
      clearComposerHistory(deletedSessionId)
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
    if (barrierInFlightRef.current.has(sessionId)) return
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
    // Guard: specialist.list is Electron-only and unavailable in the web gateway.
    if (typeof window.api?.specialist?.list !== 'function') return
    void loadSpecialists()
    const remove = window.api.specialist.onCatalogChanged(() => {
      void loadSpecialists()
    })
    return remove
  }, [loadSpecialists])

  // Keep the latest specialist catalog in a ref so the stable broadcast subscription below reads
  // fresh data without re-subscribing on every catalog change.
  useEffect(() => {
    specialistItemsRef.current = specialistItems
  }, [specialistItems])

  // Compatibility-only pending-selection subscription. Production approved SDK switches no longer
  // emit this channel: their durable lifecycle row is read-only and their continuation is owned by
  // the completion gate, never by a renderer send barrier.
  useEffect(() => {
    if (!window.api?.specialist?.onPendingSwitch) return
    const remove = window.api.specialist.onPendingSwitch((pending) => {
      // null target => revert to Main Agent. main already persisted the clear BEFORE broadcasting
      // (host.agents.switch(null) writes the Main binding, then notifies), so the renderer only
      // mirrors it here — no resolveSessionSpecialist round-trip is needed, unlike the named-target
      // fallthrough below. The pending entry is set to undefined so the next-send barrier, which keys
      // on pendingSessionSpecialist ownership, clears the binding. If a target resolves unavailable
      // between approval and broadcast the pending entry is simply unset and the failure surfaces
      // fail-closed at the next send; the message never runs under the wrong identity.
      if (pending.targetName === null) {
        setPendingSessionSpecialist((prev) => ({ ...prev, [pending.sessionId]: undefined }))
        return
      }
      // Resolve the public name to a UUID against the live catalog (last-write-wins: each broadcast
      // overwrites the pending entry).
      const match = specialistItemsRef.current.find(
        (item) => item.kind === 'custom' && item.name === pending.targetName
      )
      if (match && match.kind === 'custom') {
        setPendingSessionSpecialist((prev) => ({ ...prev, [pending.sessionId]: match.id }))
        return
      }
      // Catalog not yet loaded or the target was renamed/deleted between approval and broadcast:
      // resolve the durable binding that host.agents.switch already persisted on main. The result is
      // mirrored as the pending target so the barrier still reconfigures at the next send.
      const resolver = window.api?.specialist?.resolveSessionSpecialist
      if (!resolver) return
      void resolver
        .call(window.api.specialist, { sessionId: pending.sessionId })
        .then((resolution) => {
          if (resolution.kind === 'bound') {
            setPendingSessionSpecialist((prev) => ({
              ...prev,
              [pending.sessionId]: resolution.profile.id
            }))
          }
        })
        .catch(() => {
          // Resolution failed: the durable binding still applies on the next session create/resume;
          // leave the pending state unset so the user can retry explicitly.
        })
    })
    return remove
  }, [])

  // An approved SDK handoff reconfigures the runtime on main, without using the legacy pending
  // switch broadcast. Once reconfiguration has succeeded, read the authoritative binding back so
  // the session store (and therefore the specialist menu) reflects the live identity. A completed
  // lifecycle replay uses the same path after the renderer reconnects.
  const syncCompletedHandoffSpecialist = useCallback(
    (event: CompletionHandoffLifecycleEvent): void => {
      if (event.phase !== 'continuation-start' && event.phase !== 'continued') return
      const resolver = window.api?.specialist?.resolveSessionSpecialist
      if (!resolver) return
      void resolver
        .call(window.api.specialist, { sessionId: event.sessionId })
        .then((resolution) => {
          if (resolution.kind === 'bound') {
            setSessionSpecialistId(event.sessionId, resolution.profile.id)
          } else if (resolution.kind === 'main') {
            setSessionSpecialistId(event.sessionId, undefined)
          }
        })
        .catch(() => {
          // The lifecycle projection is observational; a transient readback failure must not affect
          // the already-authorized runtime handoff or turn into a misleading composer error.
        })
    },
    [setSessionSpecialistId]
  )

  const applyHandoffLifecycleEvent = useCallback(
    (event: CompletionHandoffLifecycleEvent): void => {
      syncCompletedHandoffSpecialist(event)
    },
    [syncCompletedHandoffSpecialist]
  )

  // The renderer is a read-only lifecycle projection. Replay catches failures persisted before a
  // reload; subscription follows later transitions. Neither route grants execution authority.
  useEffect(() => {
    const specialistApi = window.api?.specialist
    if (!specialistApi?.onHandoffLifecycleEvent) return
    return specialistApi.onHandoffLifecycleEvent(applyHandoffLifecycleEvent)
  }, [applyHandoffLifecycleEvent])

  useEffect(() => {
    const specialistApi = window.api?.specialist
    if (!activeSessionId || !specialistApi?.getHandoffEvents) return
    void specialistApi
      .getHandoffEvents(activeSessionId)
      .then((events) => {
        const latest = events.sort(compareHandoffEventOrder).at(-1)
        if (latest) applyHandoffLifecycleEvent(latest)
      })
      .catch(() => undefined)
  }, [activeSessionId, applyHandoffLifecycleEvent])

  const toggleSidebarPanel = (): void => {
    setSidebarPanelState((state) => (state === 'collapsed' ? 'open' : 'collapsed'))
  }

  return (
    <main className="h-[100dvh] overflow-hidden bg-bg-10 text-[13px] leading-normal text-text-000 md:h-screen md:p-[10px]">
      <div className="relative flex h-full">
        {isMobileSidebarOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-[65] bg-black/45 md:hidden"
            aria-label="Close navigation"
            onClick={() => setIsMobileSidebarOpen(false)}
          />
        ) : null}
        {isMobile ? (
          <WorkspaceSidebar
            projectName={activeProject?.name ?? 'Project'}
            sessions={sessions}
            activeSessionId={selectedSessionId}
            canCreateConversation={isSessionPersistenceReady}
            canMutateConversations={isSessionPersistenceReady}
            canDeleteConversations={canDeleteConversations}
            onGoHome={() => {
              setIsMobileSidebarOpen(false)
              goHome('user')
            }}
            onNewConversation={() => {
              setIsMobileSidebarOpen(false)
              openNewConversation()
            }}
            isFilesOpen={activePreviewItemId === PROJECT_FILES_PREVIEW_ID}
            onOpenFiles={() => {
              setIsMobileSidebarOpen(false)
              openFilesPreview()
            }}
            onOpenSession={(sessionId) => {
              setIsMobileSidebarOpen(false)
              openSessionWithoutExportError(sessionId)
            }}
            onRenameSession={(session) => {
              setIsMobileSidebarOpen(false)
              openRenameDialog(session)
            }}
            canDownloadArtifacts={typeof window.api?.saveSessionArtifacts === 'function'}
            onDownloadArtifacts={(session) => {
              setIsMobileSidebarOpen(false)
              setSessionToDownloadArtifacts(session)
            }}
            onViewNotebook={(session) => {
              setIsMobileSidebarOpen(false)
              setSessionToViewNotebook(session)
            }}
            onExportSession={
              typeof window.api.sessions?.exportConversation === 'function'
                ? (session, format) => {
                    setIsMobileSidebarOpen(false)
                    exportConversation(session, format)
                  }
                : undefined
            }
            onTogglePin={(session) => {
              setIsMobileSidebarOpen(false)
              if (isSessionPersistenceReady) togglePinned(session.id)
            }}
            canArchiveSession={canArchiveSession}
            onArchiveSession={(session) => {
              setIsMobileSidebarOpen(false)
              archiveSession(session)
            }}
            onDeleteSession={(session) => {
              setIsMobileSidebarOpen(false)
              openDeleteDialog(session)
            }}
            onOpenSettings={() => {
              setIsMobileSidebarOpen(false)
              openSettings()
            }}
            mobileMode
            isMobileOpen={isMobileSidebarOpen}
            onMobileClose={() => setIsMobileSidebarOpen(false)}
          />
        ) : null}
        {/* Cancel the workspace's vertical and trailing padding so panel dividers meet the app edges. */}
        <ResizablePanelGroup
          orientation="horizontal"
          className={
            isMobile ? 'min-w-0 flex-1' : '-my-[10px] -mr-[10px] h-[calc(100%+20px)] min-w-0 flex-1'
          }
        >
          {!isMobile ? (
            <>
              <ResizablePanel
                id="left-panel"
                panelRef={sidebarPanelRef}
                defaultSize={SIDEBAR_PANEL_DEFAULT_SIZE_CSS}
                minSize={
                  isSidebarPanelAnimationMinSizeRelaxed
                    ? SIDEBAR_PANEL_ANIMATING_MIN_SIZE
                    : SIDEBAR_PANEL_MIN_OPEN_SIZE_CSS
                }
                collapsible
                collapsedSize="0%"
                onResize={(panelSize, _panelId, previousPanelSize) =>
                  syncSidebarPanelResize(panelSize, previousPanelSize)
                }
              >
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
                  onRenameSession={openRenameDialog}
                  canDownloadArtifacts={typeof window.api?.saveSessionArtifacts === 'function'}
                  onDownloadArtifacts={setSessionToDownloadArtifacts}
                  onViewNotebook={setSessionToViewNotebook}
                  onExportSession={
                    typeof window.api.sessions?.exportConversation === 'function'
                      ? exportConversation
                      : undefined
                  }
                  onTogglePin={(session) => {
                    if (isSessionPersistenceReady) togglePinned(session.id)
                  }}
                  canArchiveSession={canArchiveSession}
                  onArchiveSession={archiveSession}
                  onDeleteSession={openDeleteDialog}
                  onOpenSettings={openSettings}
                />
              </ResizablePanel>

              <ResizableHandle
                elementRef={sidebarSeparatorRef}
                aria-label="Resize left panel"
                disabled={sidebarPanelState === 'collapsed'}
                aria-hidden={sidebarPanelState === 'collapsed'}
                className={`before:left-auto before:right-full before:mr-[3px] before:translate-x-0 transition-opacity duration-200 ease-out ${
                  sidebarPanelState === 'collapsed' ? 'opacity-0' : 'opacity-100'
                }`}
              />
            </>
          ) : null}

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
            canChangeAgentControls={canChangeAgentControls}
            canChangePermissionProfile={canChangePermissionProfile}
            autoReviewEnabled={activeAutoReviewEnabled}
            onDraftDocChange={changeComposerDraftDoc}
            isHistoryBrowsing={historyBrowsingKey === currentDraftKey}
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
            onTogglePreviewPanel={togglePreviewPanel}
            onOpenSidebar={() => setIsMobileSidebarOpen(true)}
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
              Object.hasOwn(pendingSessionSpecialist, activeSession.id) &&
              (activeSession.status === 'running' || activeSession.status === 'waiting-permission')
            }
            reconfigureError={
              reconfigureError?.sessionId === activeSession?.id ? reconfigureError : null
            }
            onReconfigureRetry={() => {
              // Re-run the full barrier: clears the banner first, then re-attempts the switch
              // and, on success, dispatches the send — identical to the original send path.
              if (!reconfigureError || !activeSession) return
              if (!Object.hasOwn(pendingSessionSpecialist, reconfigureError.sessionId)) {
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
                const sessionId = activeSession.id
                const specialistApi = window.api?.specialist
                if (
                  !specialistApi?.setSessionSpecialist ||
                  barrierInFlightRef.current.has(sessionId)
                ) {
                  return
                }
                barrierInFlightRef.current.add(sessionId)
                setBarrierInFlightSessions((prev) => new Set(prev).add(sessionId))
                void specialistApi
                  .setSessionSpecialist({ sessionId, specialistId: undefined })
                  ?.then((result) => {
                    if (result?.contextReset) markSpecialistSwitchResetRequired(sessionId)
                    setSessionSpecialistId(sessionId, undefined)
                    setPendingSessionSpecialist((prev) => {
                      const next = { ...prev }
                      delete next[sessionId]
                      return next
                    })
                    setReconfigureError(null)
                  })
                  ?.catch((err: unknown) => console.warn('setSessionSpecialist (none) failed', err))
                  ?.finally(() => {
                    barrierInFlightRef.current.delete(sessionId)
                    setBarrierInFlightSessions((prev) => {
                      const next = new Set(prev)
                      next.delete(sessionId)
                      return next
                    })
                  })
              }
            }}
            onSpecialistChange={
              activeSession
                ? handleExistingSessionSpecialistChange
                : handleNewConversationSpecialistChange
            }
          />

          {!isMobile ? (
            <>
              <ResizableHandle
                elementRef={previewSeparatorRef}
                aria-label="Resize right panel"
                disabled={previewPanelState === 'collapsed'}
                aria-hidden={previewPanelState === 'collapsed'}
                className={`bg-border shadow-[1px_0_3px_rgba(30,28,24,0.08)] before:left-auto before:right-full before:mr-0.5 before:w-1 before:translate-x-0 transition-opacity duration-200 ease-out ${
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
            </>
          ) : null}
        </ResizablePanelGroup>
        {!isMobile && previewItems.length > 0 ? (
          <PreviewPanelToggleButton
            buttonRef={previewToggleRef}
            isCollapsed={previewPanelState === 'collapsed'}
            onToggle={togglePreviewPanel}
          />
        ) : null}
        {!isMobile ? (
          <SidebarPanelToggleButton
            buttonRef={sidebarToggleRef}
            isCollapsed={sidebarPanelState === 'collapsed'}
            left={`calc(${SIDEBAR_PANEL_DEFAULT_SIZE_CSS} - ${SIDEBAR_TOGGLE_RIGHT_INSET}px)`}
            onToggle={toggleSidebarPanel}
          />
        ) : null}
      </div>

      {isMobile ? (
        <MobilePreviewSheet
          open={previewPanelState === 'open'}
          onClose={() => syncPreviewPanelState('collapsed')}
        />
      ) : null}

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

      <DownloadSessionArtifactsDialog
        session={sessionToDownloadArtifacts}
        onClose={() => setSessionToDownloadArtifacts(undefined)}
      />

      <FilePreviewDialog
        item={fileDialogItem?.projectId === activeProjectId ? fileDialogItem : undefined}
        onClose={closeFileDialog}
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

import { forkSession, sessionForkAvailable } from '@/lib/session-fork'
import { sideChatBlock, sideChatBlockMessage } from './side-chat-availability'
import {
  PackageExportProgressButton,
  PackageOperationIndicator
} from '@/components/SessionPackageOperation'
import { SessionInfoPopover } from './SessionInfoPopover'
import { sessionExportLocked, usePackageOperationStore } from '@/stores/package-operation-store'
import { AnnotationTransferSource } from './annotations/AnnotationTransferSource'
import { useAnnotationDrop } from './annotations/use-annotation-drop'
import { UnavailablePlanNotice } from './session-plan/UnavailablePlanNotice'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  ConnectorCredentialRequest,
  SessionAgentConfiguration
} from '../../../../shared/settings'

import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpContextUsage,
  DelegatedWorkUnavailableReason,
  ElicitationAnswer,
  ElicitationProjection,
  ElicitationResponse,
  PendingElicitationRequest
} from '../../../../shared/acp'
import type { LinkedFolderFileReference } from '../../../../shared/artifacts'
import type { NotebookSessionReference } from '../../../../shared/notebook'
import type { JobSummary } from '../../../../shared/compute'
import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import { MAX_UPLOAD_FILE_BYTES, formatUploadSizeLimit } from '../../../../shared/uploads'
import { MAX_SESSION_PDF_CONTEXTS } from '../../../../shared/session-persistence'
import {
  isReportableRunFailure,
  VISION_MODEL_NOT_CONFIGURED_MESSAGE,
  visionRunFailureMessage
} from '../../../../shared/run-error-classification'
import {
  AlertTriangle,
  ArrowUp,
  BookMarked,
  BookOpen,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Flag,
  GitBranch,
  Loader2,
  LockKeyhole,
  Link2,
  ListChecks,
  Menu,
  MessageCircleMore,
  PanelRight,
  Plus,
  RotateCcw,
  ScanEye,
  Square,
  Stethoscope,
  X
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resolveEffectiveSpecialistSkills } from '../../../../shared/specialist'
import { isUnsupportedCodexAcpVersionError } from '../../../../shared/codex-runtime'
import {
  validateAnnotations,
  type AnnotationValidationError,
  type TextAnnotation
} from '../../../../shared/annotations'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { sessionPackageImportAvailable } from '@/components/session-package-import-menu-model'
import { DiagnosticDetails } from '@/components/diagnostic-details'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { ResizablePanel } from '@/components/ui/resizable'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { cn } from '@/lib/utils'
import {
  isRetryableArtifactFinalizationError,
  projectSessionActionability,
  useSessionStore,
  type ChatSession
} from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ConnectorCredentialControls } from '@/pages/settings/ConnectorCredentialDialog'

import { ComposerEditor } from './composer/ComposerEditor'
import { FileTypeIcon } from './file-type-icon'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'
import {
  appendArtifactMention,
  docToSkillIds,
  docToText,
  pastedTextAttachmentDomId,
  pastedTextPreviewName,
  type ComposerPastedTextNode
} from './composer/composer-doc'
import { ComposerAgentControlsMenu } from './ComposerAgentControlsMenu'
import { ComposerComputeTargetIndicator } from './ComposerComputeTargetIndicator'
import { NotificationBell } from '@/components/NotificationBell'
import { ComposerContextUsage } from './ComposerContextUsage'
import { BackgroundTasksChip } from './BackgroundTasksChip'
import { SessionBackgroundActivity } from './SessionBackgroundActivity'
import { useSessionBackgroundTasks } from './use-session-background-tasks'
import { ComposerMessageQueueContent, ComposerMessageQueueTrigger } from './ComposerMessageQueue'
import { ContextWindowDialog } from './ContextWindowDialog'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerSpecialistPicker } from './ComposerSpecialistPicker'
import { ComposerYourFilesMenu } from './ComposerYourFilesMenu'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { ReadingContextPicker } from './ReadingContextPicker'
import { normalizeRunFailureError } from './error-report'
import { isClaudeCliCompatibilityError } from '../../../../shared/claude-runtime'
import { ReportErrorDialog } from './ReportErrorDialog'
import { SessionInterruptedBanner } from './SessionInterruptedBanner'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { WorkspaceElicitationCard } from './WorkspaceElicitationCard'
import { WorkspaceDelegatedQuestionCard } from './WorkspaceDelegatedQuestionCard'
import { WorkspaceMessageScroller } from './WorkspaceMessageScroller'
import { AnnotationDraftCards } from './annotations/AnnotationCards'
import { requestAnnotationReveal } from './annotations/annotation-reveal'
import { annotationValidationMessage } from './annotations/annotation-validation-message'
import { SessionSwitchSkeleton } from './SessionSwitchSkeleton'
import { PlanProgressChip, WorkspacePlanCard } from './session-plan/SessionPlanSurfaces'
import { projectDelegatedQuestionQueue } from './subagent-release-projection'
import { selectActiveBranchPlan } from './session-plan/active-branch-plan'
import { isPlanProgressVisible } from './session-plan/plan-progress'
import { respondToSessionPlan } from './session-plan/respond-to-session-plan'
import {
  createSessionPlanPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { WorkspaceMessageEditStateProvider } from './workspace-message-edit-state'
import { workspaceHandoffLifecycleClient } from './handoff-lifecycle-source'
import { SubagentAvailabilityNotice, SubagentsBar } from './SubagentReleaseSurfaces'
import { projectSessionSubagents } from './subagent-release-projection'
import { ResizableBottomPanel } from './ResizableBottomPanel'
import { type SideChatController } from './use-side-chat-controller'
import type { WorkspaceComposerController } from './workspace-composer-controller'
import type { WorkspaceConversationController } from './workspace-conversation-controller'
import type { WorkspaceSessionController } from './workspace-session-controller'
import { getAvatarColor } from '../settings/specialist-icons'
import { localizeImageAnnotationSourceError } from './annotations/image-annotation-source-validation'
import { BookmarksPopover } from './bookmarks/BookmarksPopover'
import { useBookmarks } from './bookmarks/bookmark-context'

const localizeVisionRunFailure = (
  error: string | null | undefined,
  t: TFunction
): string | undefined => {
  switch (visionRunFailureMessage(error)) {
    case VISION_MODEL_NOT_CONFIGURED_MESSAGE:
      return t(
        "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
      )
    case 'The attached image is too large to prepare for the Vision model.':
      return t('The attached image is too large to prepare for the Vision model.')
    case 'The attached image is invalid.':
      return t('The attached image is invalid.')
    case 'The current images exceed the Vision evidence request budget.':
      return t('The current images exceed the Vision evidence request budget.')
    case 'The current Vision evidence exceeds the request budget.':
      return t('The current Vision evidence exceeds the request budget.')
    case 'The Vision model returned invalid image evidence.':
      return t('The Vision model returned invalid image evidence.')
    default:
      return undefined
  }
}

const composerInteractiveTransitionClassName = 'transition-colors duration-200 ease-out'

const composerIconButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-200 hover:text-text-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
  composerInteractiveTransitionClassName
)

const composerSplitSendPrimaryButtonClassName = cn(
  "relative h-8 w-8 rounded-l-md rounded-r-none border-0 bg-transparent bg-clip-border text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-100 disabled:hover:bg-transparent [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-1.5 [@media(pointer:coarse)]:before:-left-3 [@media(pointer:coarse)]:before:right-0 [@media(pointer:coarse)]:before:content-['']",
  composerInteractiveTransitionClassName
)

const composerSplitSendMenuButtonClassName = cn(
  "relative h-8 w-8 rounded-l-none rounded-r-md border-0 bg-transparent bg-clip-border text-primary-foreground after:pointer-events-none after:absolute after:inset-y-1 after:left-0 after:w-px after:bg-primary-foreground/20 after:content-[''] hover:bg-primary-foreground/10 hover:text-primary-foreground active:translate-y-px aria-expanded:bg-primary-foreground/10 aria-expanded:text-primary-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-100 disabled:hover:bg-transparent [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-1.5 [@media(pointer:coarse)]:before:left-0 [@media(pointer:coarse)]:before:-right-3 [@media(pointer:coarse)]:before:content-['']",
  composerInteractiveTransitionClassName
)

const composerCancelButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-200 text-text-000 hover:bg-bg-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
  composerInteractiveTransitionClassName
)
const composerContentClassName = 'mx-auto w-full max-w-4xl'
const attachmentChipClassName =
  'flex h-9 min-w-0 max-w-[220px] items-center gap-2 rounded-lg border border-border-200 bg-bg-200 px-2 text-text-000'
const attachmentRemoveButtonClassName = cn(
  "relative flex size-6 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-300 hover:text-text-000 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-2 [@media(pointer:coarse)]:before:content-['']",
  composerInteractiveTransitionClassName
)
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4
 * component: reversible paste attachment + inline locator · genre: modern-minimal · theme: existing
 * states: default · hover · focus · active · disabled · loading · error · success
 * slop: pass (1–58) · contrast: inherited semantic tokens · mobile: pass (34, 49–57)
 */
const pastedTextRestoreButtonClassName = cn(
  'flex h-full min-w-0 flex-1 flex-col justify-center rounded-md text-left hover:text-text-100 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50',
  composerInteractiveTransitionClassName
)
// Read from two places (pointer-fine tooltip and coarse-pointer hint), so it takes t rather than
// holding a formatted English string that would reach the screen untranslated.
const attachmentLimitsText = (t: TFunction): string =>
  t('Any file type · {{size}} per file. Large files are linked, not embedded.', {
    size: formatUploadSizeLimit(MAX_UPLOAD_FILE_BYTES)
  })

const ResizableElicitationComposer = ({ children }: React.PropsWithChildren): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ResizableBottomPanel
      ariaLabel={t('Resize question panel')}
      testId="elicitation-composer"
      scrollTestId="elicitation-composer-scroll"
      constrainGrowthToOverflow
      minimumContentSelector='[data-elicitation-option-row="true"]'
      minimumContentIndex={1}
    >
      {children}
    </ResizableBottomPanel>
  )
}

const ResizablePermissionComposer = ({ children }: React.PropsWithChildren): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ResizableBottomPanel
      ariaLabel={t('Resize permission panel')}
      testId="permission-composer"
      scrollTestId="permission-composer-scroll"
      constrainGrowthToOverflow
    >
      {children}
    </ResizableBottomPanel>
  )
}

const ResizableCredentialComposer = ({ children }: React.PropsWithChildren): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ResizableBottomPanel
      ariaLabel={t('Resize credential panel')}
      testId="credential-composer"
      scrollTestId="credential-composer-scroll"
      constrainGrowthToOverflow
    >
      {children}
    </ResizableBottomPanel>
  )
}

const ResizablePlanComposer = ({
  children
}: {
  children: (expanded: boolean) => React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true)
  return (
    <ResizableBottomPanel
      ariaLabel={t('Resize Plan panel')}
      testId="plan-composer"
      scrollTestId="plan-composer-scroll"
      constrainGrowthToOverflow
      collapsed={!expanded}
      collapseControl={{
        label: expanded ? t('Collapse Plan') : t('Expand Plan'),
        onToggle: () => setExpanded((value) => !value)
      }}
    >
      {children(expanded)}
    </ResizableBottomPanel>
  )
}

// Formats the compact size label shown under each composer attachment chip.
const formatAttachmentSize = (size: number): string => {
  if (size < 1024) return `${size} B`

  const kilobytes = size / 1024

  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`

  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${Math.round(megabytes)} MB`

  return `${(megabytes / 1024).toFixed(1)} GB`
}

type ConversationPanelView = {
  activeSession: ChatSession | undefined
  composerFocusKey?: string
  canEditDraft: boolean
  actionError: string | null
  sideChatDisabledReason?: string
}

type ConversationPanelSpecialist = {
  view: {
    specialist: WorkspaceSessionController['view']['specialist']
  }
  actions: Pick<
    WorkspaceSessionController['actions'],
    'selectSpecialist' | 'retrySpecialistSelection' | 'chooseOtherSpecialist' | 'useMainAgent'
  >
}

type ConversationPanelLayout = {
  isPreviewPanelCollapsed: boolean
  togglePreviewPanel: () => void
  openSidebar: () => void
}

type ConversationPanelPermissions = {
  requests: AcpPermissionRequest[]
  credentialRequests: ConnectorCredentialRequest[]
  permissionProfile: PermissionProfileId
  permissionProfileState: SessionPermissionProfileState | undefined
  permissionGrants: AcpPermissionGrant[]
  canChangePermissionProfile: boolean
  respond: (requestId: string, optionId?: string) => Promise<void>
  changeProfile: (profile: PermissionProfileId) => void
  revokeGrant: (categoryKey: string) => void
  clearGrants: () => void
}

type ConversationPanelElicitation = {
  requests: PendingElicitationRequest[]
  respond: (response: ElicitationResponse) => Promise<void>
}

type ConversationPanelAgentControls = {
  canChange: boolean
  canChangeAutoReview: boolean
  canChangeMemory: boolean
  canChangeSpecialist: boolean
  modelConfiguration?: SessionAgentConfiguration
  modelUnavailable?: boolean
  changeModelConfiguration?: (configuration: SessionAgentConfiguration) => void
  autoReviewEnabled: boolean
  memoryEnabled?: boolean
  delegationEnabled?: boolean
  delegationPending?: boolean
  delegationHasLiveAttempts?: boolean
  canChangeDelegation?: boolean
  delegationDisabledReason?: string
  memoryDisabledReason?: string
  enabledComputeHosts: string[]
  selectedComputeHosts?: string[]
  toggleAutoReview: (enabled: boolean) => void
  toggleMemory?: (enabled: boolean) => void
  toggleDelegation?: (enabled: boolean) => void | Promise<void>
  setComputeHostEnabled?: (providerId: string, enabled: boolean) => void
  setComputeHostSelected?: (providerId: string, selected: boolean) => void
}

type ConversationPanelContextWindow = {
  usage: AcpContextUsage | undefined
  canCompact: boolean
  compactDisabledReason: string
  compact: () => void
}

type ConversationPanelReview = {
  disabled: boolean
  running: boolean
  request: () => void
}

type ConversationPanelSaveAsSkill = {
  disabled: boolean
  disabledReason?: string
  running: boolean
  request: () => void
}

type ConversationPanelWslSetup = {
  start: () => Promise<boolean>
}

type ConversationPanelWorkflows = {
  artifactFinalization: {
    running: boolean
    request: () => void
  }
  review: ConversationPanelReview
  saveAsSkill: ConversationPanelSaveAsSkill
  wslSetup: ConversationPanelWslSetup
}

type ConversationPanelSessionTools = {
  exportDiagnostics?: (session: ChatSession) => void
  togglePin?: (session: ChatSession) => void
  editSession?: (session: ChatSession) => void
  notebookReference: NotebookSessionReference | undefined
  openNotebook: (notebook: NotebookSessionReference, runId?: string) => void
  openJobs: (sessionId: string) => void
  openJob?: (job: JobSummary) => void
  openSession?: (sessionId: string) => void
}

type ConversationPanelSubagents = {
  unavailable?: DelegatedWorkUnavailableReason
  stop: () => void | Promise<void>
}

type StopSubmissionState = Readonly<{
  pending: boolean
  error?: string
}>

type ConversationPanelProps = {
  view: ConversationPanelView
  onOpenLibraryMention?: (scope: { collectionId?: string; collectionName?: string }) => void
  composer: Pick<WorkspaceComposerController, 'view' | 'actions'>
  conversation: WorkspaceConversationController
  sideChat: SideChatController
  specialist: ConversationPanelSpecialist
  layout: ConversationPanelLayout
  permissions: ConversationPanelPermissions
  elicitation: ConversationPanelElicitation
  agentControls: ConversationPanelAgentControls
  contextWindow: ConversationPanelContextWindow
  workflows: ConversationPanelWorkflows
  sessionTools: ConversationPanelSessionTools
  subagents: ConversationPanelSubagents
}

const DismissibleConversationError = ({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  return (
    <div className="relative mb-2 flex flex-col gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-300">
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('Dismiss error')}
        className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-red-900/40"
      >
        <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
      </button>
      {children}
    </div>
  )
}

// Middle chat surface owns the visible conversation and local message composer UI.
const ConversationPanel = ({
  view,
  onOpenLibraryMention,
  composer,
  conversation,
  sideChat: sideChatController,
  specialist,
  layout,
  permissions,
  elicitation,
  agentControls,
  contextWindow,
  workflows,
  sessionTools,
  subagents
}: ConversationPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const { total: bookmarkCount, loadError: bookmarkLoadError } = useBookmarks()
  const { activeSession, composerFocusKey, canEditDraft, actionError, sideChatDisabledReason } =
    view
  const sourceSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === activeSession?.branchSource?.sessionId)
  )
  const sourceSessionNumber = sourceSession?.number
  const hasBookmarkEntry = Boolean(activeSession && (bookmarkCount > 0 || bookmarkLoadError))
  const {
    view: {
      doc: draftDoc,
      annotations,
      attachments,
      transfers: attachmentTransfers,
      error: composerError,
      errorDetail: composerErrorDetail,
      historyStatus,
      isHistoryBrowsing,
      isUploading: isUploadingAttachments,
      isWslSetupDraft,
      caretRequest,
      readingContext: pdfContext
    },
    actions: {
      discardWslSetupDraft,
      changeDoc: onDraftDocChange,
      addAnnotation: onAddAnnotation,
      updateAnnotationNote: onUpdateAnnotationNote,
      removeAnnotation: onRemoveAnnotation,
      navigateHistory: onNavigateHistory,
      stageFiles: onStageAttachmentFiles,
      stagePastedText: onStagePastedText,
      cancelTransfer: onCancelAttachmentTransfer,
      retryTransfer: onRetryAttachmentTransfer,
      removeAttachment: onRemoveAttachment,
      restorePastedText: onRestorePastedText,
      undo: onUndo,
      redo: onRedo,
      setError: onSetComposerError,
      linkReadingContext,
      openReadingContext,
      unlinkReadingContext,
      dismissAutomaticReading
    }
  } = composer
  // Stable identities across re-renders: the transcript memo compares these callbacks, so an
  // inline closure would re-render every message on each composer state change.
  const annotationSourceId = `main:${activeSession?.projectId}:${activeSession?.id}:${composerFocusKey ?? 'composer'}`
  const annotationDrop = useAnnotationDrop({
    targetId: annotationSourceId,
    projectId: activeSession?.projectId ?? '',
    parentSessionId: activeSession?.id ?? '',
    disabled: !canEditDraft || !activeSession,
    receive: ({ annotation }) => !onAddAnnotation(annotation)
  })
  const handleAddTranscriptAnnotation = useCallback(
    (annotation: TextAnnotation): AnnotationValidationError | undefined => {
      const error = onAddAnnotation(annotation)
      if (!error) onSetComposerError(null)
      return error
    },
    [onAddAnnotation, onSetComposerError]
  )
  const handleTranscriptAnnotationError = useCallback(
    (error: AnnotationValidationError): void => {
      onSetComposerError(annotationValidationMessage(error, t))
    },
    [onSetComposerError, t]
  )
  const handleUpdateTranscriptAnnotation = useCallback(
    (id: string, note: string): AnnotationValidationError | undefined => {
      const error = onUpdateAnnotationNote(id, note)
      if (!error) onSetComposerError(null)
      return error
    },
    [onSetComposerError, onUpdateAnnotationNote]
  )
  const onValidatedDraftDocChange = (
    nextDoc: Parameters<typeof onDraftDocChange>[0],
    caret?: Parameters<typeof onDraftDocChange>[1]
  ): void => {
    if (caret) onDraftDocChange(nextDoc, caret)
    else onDraftDocChange(nextDoc)
    const validation = validateAnnotations(annotations, docToText(nextDoc))
    onSetComposerError(validation ? annotationValidationMessage(validation, t) : null)
  }
  const {
    availability: {
      submit: canSendMessage,
      submitMode,
      revise: canEditMessage,
      resume: canResumeSession,
      branch: canBranchInNewSession,
      planResponse: canRespondToPlan
    },
    actions: {
      submit: { draft: submitDraft, restoredPlan: onRespondToRestoredPlan },
      revise: onSendEditedMessage,
      branch: onBranchFromAgentMessage,
      sideChat: { start: onStartSideChat },
      reportSessionSizeLimit: onSessionSizeLimit,
      resume: onResumeSession,
      cancel: onCancelRun
    },
    queue: messageQueue,
    optimisticMessage
  } = conversation
  const { retryHydration: onRetrySideChatHydration } = sideChatController

  const {
    isPreviewPanelCollapsed,
    togglePreviewPanel: onTogglePreviewPanel,
    openSidebar: onOpenSidebar
  } = layout
  const {
    requests: pendingPermissions,
    permissionProfile,
    permissionProfileState,
    permissionGrants,
    canChangePermissionProfile,
    respond: onRespondToPermission,
    changeProfile: onPermissionProfileChange,
    revokeGrant: onRevokePermissionGrant,
    clearGrants: onClearPermissionGrants
  } = permissions
  const { requests: pendingElicitations, respond: onRespondToElicitation } = elicitation
  const {
    canChange: canChangeAgentControls,
    canChangeAutoReview,
    canChangeMemory,
    canChangeSpecialist,
    modelConfiguration,
    modelUnavailable = false,
    changeModelConfiguration = () => undefined,
    autoReviewEnabled,
    memoryEnabled = true,
    delegationEnabled = true,
    delegationPending = false,
    delegationHasLiveAttempts = false,
    canChangeDelegation = false,
    delegationDisabledReason,
    memoryDisabledReason,
    enabledComputeHosts,
    selectedComputeHosts = [],
    toggleAutoReview: onAutoReviewToggle,
    toggleMemory: onMemoryToggle = () => undefined,
    toggleDelegation: onDelegationToggle = () => undefined,
    setComputeHostEnabled: onComputeHostEnabledChange = () => undefined,
    setComputeHostSelected: onComputeHostSelectedChange = () => undefined
  } = agentControls
  const {
    usage: contextUsage,
    canCompact: canCompactContext,
    compactDisabledReason: compactContextDisabledReason,
    compact: onCompactContext
  } = contextWindow
  const { review, saveAsSkill } = workflows
  const {
    disabled: isRequestReviewDisabled,
    running: isReviewing,
    request: onRequestReview
  } = review
  const {
    disabled: isSaveAsSkillDisabledFromParent,
    disabledReason: saveAsSkillDisabledReasonFromParent,
    running: isSavingAsSkill,
    request: onSaveAsSkill
  } = saveAsSkill
  const {
    notebookReference,
    openNotebook: onOpenNotebook,
    openJobs: onOpenJobList,
    openJob: onOpenJob
  } = sessionTools
  const { unavailable: subagentUnavailable, stop: onStopSubagents } = subagents
  const specialistId = activeSession
    ? specialist.view.specialist.barrierInFlight
      ? (specialist.view.specialist.historyId ?? activeSession.specialistId)
      : activeSession.specialistId
    : specialist.view.specialist.newConversationId
  const specialistUnavailable = specialist.view.specialist.unavailable
  const specialistHasPendingSwitch = specialist.view.specialist.hasPendingSwitch
  const reconfigureError = specialist.view.specialist.reconfigureError
  const onSpecialistChange = specialist.actions.selectSpecialist
  const onReconfigureChooseOther = specialist.actions.chooseOtherSpecialist
  const onReconfigureUseNone = specialist.actions.useMainAgent
  const onSendMessage = (forcedSkillIds: string[]): void => submitDraft({ forcedSkillIds })
  const onPlanFirst = (forcedSkillIds: string[]): void =>
    submitDraft({ forcedSkillIds, mode: 'plan-first' })
  const onBranchInNewSession = activeSession
    ? (forcedSkillIds: string[]): void => submitDraft({ forcedSkillIds, mode: 'branch' })
    : undefined
  const onReconfigureRetry = (): void => {
    if (specialist.actions.retrySpecialistSelection()) return
    submitDraft({ forcedSkillIds: docToSkillIds(draftDoc), mode: 'retry-reconfigure' })
  }

  const specialistItems = useSpecialistStore((state) => state.items)
  const catalogSkills = useSettingsStore((state) => state.skills)
  const settingsLoaded = useSettingsStore((state) => state.isLoaded)
  const openSettings = useSettingsStore((state) => state.openSettings)
  const openSettingsToComputeHost = useSettingsStore((state) => state.openSettingsToComputeHost)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)
  const stopSubmissionPendingSessionIdsRef = useRef(new Set<string>())
  const [stopSubmissionsBySessionId, setStopSubmissionsBySessionId] = useState(
    () => new Map<string, StopSubmissionState>()
  )
  const [messageQueueExpanded, setMessageQueueExpanded] = useState(false)
  const setElicitationEditDraft = useSessionStore((state) => state.setElicitationEditDraft)
  const setElicitationDraftAnswers = useSessionStore((state) => state.setElicitationDraftAnswers)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const globalSearchShortcut = window.api?.platform === 'darwin' ? '⌘K' : 'Ctrl+K'
  // Local so the interrupted banner can show a spinner and block a double-resume until the request settles.
  const [resumingSessionId, setResumingSessionId] = useState<string>()
  const isResuming =
    activeSession !== undefined &&
    resumingSessionId !== undefined &&
    activeSession.id === resumingSessionId
  // Opens the reviewable, consent-gated error report dialog for a failed run.
  const [isReportOpen, setIsReportOpen] = useState(false)
  const [isContextWindowOpen, setIsContextWindowOpen] = useState(false)
  const [reportDialogEpoch, setReportDialogEpoch] = useState(0)
  const [composerRestoreFocusRequest, setComposerRestoreFocusRequest] = useState<number>()
  const [agentControlsOpenRequest, setAgentControlsOpenRequest] = useState(0)
  const [computeControlsOpenRequest, setComputeControlsOpenRequest] = useState(0)

  // Preview surfaces (PDF "Read with agent" entries) ask the composer to take focus through a
  // window event; route it into the editor's existing restore-focus counter.
  useEffect(() => {
    const focusComposer = (): void =>
      setComposerRestoreFocusRequest((request) => (request ?? 0) + 1)
    window.addEventListener(FOCUS_COMPOSER_EVENT, focusComposer)
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focusComposer)
  }, [])

  const openReportDialog = (): void => {
    setReportDialogEpoch((epoch) => epoch + 1)
    setIsReportOpen(true)
  }

  const activeStopSubmission = activeSession
    ? stopSubmissionsBySessionId.get(activeSession.id)
    : undefined
  const isStopping = activeStopSubmission?.pending === true
  const stopError = activeStopSubmission?.error

  const settleStopSubmission = (sessionId: string, error?: string): void => {
    stopSubmissionPendingSessionIdsRef.current.delete(sessionId)
    setStopSubmissionsBySessionId((current) => {
      const next = new Map(current)
      if (error !== undefined) next.set(sessionId, { pending: false, error })
      else next.delete(sessionId)
      return next
    })
  }

  const submitStop = (sessionId: string | undefined, action: () => void | Promise<void>): void => {
    if (!sessionId || stopSubmissionPendingSessionIdsRef.current.has(sessionId)) return
    stopSubmissionPendingSessionIdsRef.current.add(sessionId)
    setStopSubmissionsBySessionId((current) => {
      const next = new Map(current)
      next.set(sessionId, { pending: true })
      return next
    })
    let outcome: void | Promise<void>
    try {
      outcome = action()
    } catch (error) {
      settleStopSubmission(sessionId, error instanceof Error ? error.message : String(error))
      return
    }
    if (!outcome || typeof (outcome as Promise<void>).then !== 'function') {
      settleStopSubmission(sessionId)
      return
    }
    void outcome.then(
      () => settleStopSubmission(sessionId),
      (error: unknown) =>
        settleStopSubmission(sessionId, error instanceof Error ? error.message : String(error))
    )
  }

  const handleStop = (): void => submitStop(activeSession?.id, onCancelRun)

  const handleStopSubagents = (): void => submitStop(activeSession?.id, onStopSubagents)

  // Unconditional hook: one shared data source for the background-task strip chip and
  // the expandable ledger. Compute Jobs stay observable before the Notebook exists.
  const backgroundTasks = useSessionBackgroundTasks(
    activeSession?.id,
    activeSession?.projectId,
    notebookReference
  )
  const backgroundTasksVisible =
    activeSession !== undefined &&
    (backgroundTasks.summary.activeCount > 0 || backgroundTasks.summary.totalTasks > 0)
  const [backgroundTasksExpanded, setBackgroundTasksExpanded] = useState(false)
  const activeBranchPlan = selectActiveBranchPlan(activeSession)
  const subagentSummary = projectSessionSubagents(activeSession, pendingPermissions)
  const hasSubagents = subagentSummary.children.length > 0
  const hasRunningSubagents = subagentSummary.runningCount > 0
  const isSaveAsSkillDisabled = isSaveAsSkillDisabledFromParent || hasRunningSubagents
  const saveAsSkillDisabledReason = hasRunningSubagents
    ? t('Wait for all subagents to finish.')
    : saveAsSkillDisabledReasonFromParent
  const effectiveCanSend = canSendMessage && !isStopping
  const activePendingPlan = activeBranchPlan?.approval === 'pending' ? activeBranchPlan : undefined
  // Keep the mounted editor stable across receipts and run completion. Only a
  // different Plan or an explicit review request owns a fresh draft/collapse state.
  const activePendingPlanKey = activePendingPlan
    ? JSON.stringify([
        activeSession?.id,
        activePendingPlan.artifactVersionId,
        activePendingPlan.reviewRequestId
      ])
    : undefined
  // A completed Agent attempt may leave a previously answered Plan pending. Allow
  // that review again without remounting an editor the user is still working in.
  const activePlanReviewKey = activePendingPlanKey
    ? JSON.stringify([
        activePendingPlanKey,
        activeSession?.runtimeTranscriptLastRun?.promptMessageId,
        activeSession?.runtimeTranscriptLastRun?.startedAt
      ])
    : undefined
  const currentPlanReviewRef = useRef({
    planKey: activePendingPlanKey,
    reviewKey: activePlanReviewKey
  })
  useLayoutEffect(() => {
    currentPlanReviewRef.current = {
      planKey: activePendingPlanKey,
      reviewKey: activePlanReviewKey
    }
  }, [activePendingPlanKey, activePlanReviewKey])
  const [resolvedPlanKey, setResolvedPlanKey] = useState<string>()
  const resolvePendingPlan = (): void => {
    const current = currentPlanReviewRef.current
    // Async submission may span run completion. Resolve the current review of
    // this editor, but never dismiss a replacement Plan or explicit new request.
    if (current.planKey === activePendingPlanKey) setResolvedPlanKey(current.reviewKey)
  }
  const pendingPlan =
    activePlanReviewKey &&
    resolvedPlanKey !== activePlanReviewKey &&
    activeSession?.status === 'waiting-plan-approval'
      ? activePendingPlan
      : undefined
  const resolvedRunError =
    (isClaudeCliCompatibilityError(activeSession?.error ?? '')
      ? t(
          'The installed Claude Code CLI is incompatible or its version could not be verified. Update Claude Code to 2.1.118 or later, then re-detect it in Settings.'
        )
      : undefined) ??
    localizeImageAnnotationSourceError(activeSession?.error, t) ??
    localizeVisionRunFailure(activeSession?.error, t) ??
    normalizeRunFailureError(activeSession?.error)
  const resolvedActionError =
    (isClaudeCliCompatibilityError(actionError ?? '')
      ? t(
          'The installed Claude Code CLI is incompatible or its version could not be verified. Update Claude Code to 2.1.118 or later, then re-detect it in Settings.'
        )
      : undefined) ??
    localizeImageAnnotationSourceError(actionError, t) ??
    localizeVisionRunFailure(actionError, t) ??
    actionError
  const errorKey = JSON.stringify([
    activeSession?.id,
    activeSession?.status === 'error' ? activeSession.error : null,
    actionError
  ])
  const showVisionModelSettings =
    visionRunFailureMessage(actionError) === VISION_MODEL_NOT_CONFIGURED_MESSAGE ||
    visionRunFailureMessage(activeSession?.error) === VISION_MODEL_NOT_CONFIGURED_MESSAGE
  const hasUnsupportedCodexAcpRunError = isUnsupportedCodexAcpVersionError(activeSession?.error)
  const showCodexAcpSettings =
    isUnsupportedCodexAcpVersionError(actionError) || hasUnsupportedCodexAcpRunError
  // Only unknown/opaque ACP-layer failures offer the "Report error → GitHub issue" affordance. The
  // reportability is resolved at failure time and persisted on the session: a model-provider error is
  // tagged non-reportable at the ACP layer, and an app-crafted reminder is recognized by its own text.
  // Fall back to classifying the raw error for sessions persisted before the flag existed (undefined).
  const isRunErrorReportable =
    !hasUnsupportedCodexAcpRunError &&
    (activeSession?.errorReportable ?? isReportableRunFailure(activeSession?.error))
  const canRetryArtifactFinalization = isRetryableArtifactFinalizationError(activeSession?.error)

  const activeSpecialist = specialistId
    ? specialistItems.find((item) => item.kind === 'custom' && item.id === specialistId)
    : undefined
  const selectedSpecialist = specialistId
    ? specialistItems.find((item) => item.kind !== 'reviewer' && item.id === specialistId)
    : undefined
  const specialistComposerColor =
    selectedSpecialist && selectedSpecialist.kind !== 'reviewer' && !specialistUnavailable
      ? getAvatarColor(selectedSpecialist.colorKey)
      : undefined
  const effectiveSpecialistSkills = resolveEffectiveSpecialistSkills(
    activeSpecialist?.kind === 'custom' ? activeSpecialist : undefined,
    catalogSkills
      .filter((skill) => skill.available !== false)
      .map((skill) => ({
        id: skill.id,
        frameworkName: skill.source === 'featured' ? skill.id : skill.name,
        displayName: skill.name
      }))
  )
  const allowedSkillIds =
    effectiveSpecialistSkills.kind === 'specialist'
      ? effectiveSpecialistSkills.skillIds
      : specialistId
        ? []
        : undefined

  const sessionActivities = activeSession?.activities ?? []
  const sessionPendingElicitations = activeSession
    ? pendingElicitations.filter((request) => request.sessionId === activeSession.id)
    : []
  const pendingCredentialRequest = permissions.credentialRequests[0]
  // Runtime requests and activity events can reach the renderer in either order. Whichever arrives
  // first must reserve the single bottom interaction lane so the ordinary composer never competes
  // with a question that is waiting for an answer. A projection without a live request is
  // actionable only when its durable context can reconstruct that request.
  const livePendingElicitationRequest = sessionPendingElicitations.find((request) => {
    const state = sessionActivities.find((activity) => activity.id === request.toolCallId)
      ?.elicitation?.state
    return state === undefined || state === 'pending'
  })
  const pendingElicitationActivity = livePendingElicitationRequest
    ? sessionActivities.find((activity) => activity.id === livePendingElicitationRequest.toolCallId)
    : sessionActivities.find(
        (activity) =>
          activity.elicitation?.state === 'pending' &&
          activity.elicitation.durable?.kind === 'agent-user-choice'
      )
  const restoredElicitation = pendingElicitationActivity?.elicitation
  const pendingElicitationRequest: PendingElicitationRequest | undefined =
    livePendingElicitationRequest ??
    (activeSession &&
    pendingElicitationActivity &&
    restoredElicitation?.state === 'pending' &&
    restoredElicitation.durable
      ? {
          requestId: restoredElicitation.durable.requestId,
          sessionId: activeSession.id,
          toolCallId: pendingElicitationActivity.id,
          message: restoredElicitation.message,
          fields: restoredElicitation.fields,
          durable: restoredElicitation.durable
        }
      : undefined)
  const pendingElicitation: ElicitationProjection | undefined =
    pendingElicitationActivity?.elicitation?.state === 'pending'
      ? pendingElicitationActivity.elicitation
      : !pendingElicitationActivity && pendingElicitationRequest
        ? {
            message: pendingElicitationRequest.message,
            fields: pendingElicitationRequest.fields,
            state: 'pending'
          }
        : undefined
  const rootPermissionRequests = pendingPermissions.filter((request) => !request.delegated)
  const rootPermissionPending =
    rootPermissionRequests.length > 0 ? true : pendingPermissions.length > 0 ? false : undefined
  const actionability = activeSession
    ? projectSessionActionability(activeSession, {
        rootPermissionPending,
        credentialPending: pendingCredentialRequest ? true : undefined,
        presentedWaitReason: pendingCredentialRequest ? 'waiting-for-user' : undefined,
        elicitationPending: pendingElicitation ? true : undefined,
        planPending:
          pendingPlan !== undefined
            ? true
            : activePlanReviewKey && resolvedPlanKey === activePlanReviewKey
              ? false
              : undefined
      })
    : undefined
  const blockingInteraction =
    actionability?.blockingInteraction ??
    (rootPermissionRequests.length > 0
      ? 'permission'
      : pendingCredentialRequest
        ? 'credential'
        : pendingElicitation
          ? 'elicitation'
          : pendingPlan
            ? 'plan'
            : undefined)
  const hasPendingPermission = blockingInteraction === 'permission'
  const hasPendingCredential = blockingInteraction === 'credential'
  const delegatedQuestion = projectDelegatedQuestionQueue(activeSession)[0]
  const packageOperation = usePackageOperationStore((state) => state.operation)
  const packageLocked = sessionExportLocked(packageOperation, activeSession)
  const ordinaryComposerBlocked = Boolean(blockingInteraction || packageLocked)
  const rootTurnBusy = Boolean(
    blockingInteraction ||
    actionability?.activity === 'running' ||
    activeSession?.compacting ||
    activeSession?.fixLoopActive
  )

  // Re-attaches the interrupted session; on success the banner unmounts, so guard the state update.
  const handleResume = async (): Promise<void> => {
    const sessionId = activeSession?.id
    if (!canResumeSession || !sessionId || isResuming) return

    setResumingSessionId(sessionId)
    try {
      await onResumeSession()
    } finally {
      setResumingSessionId((current) => (current === sessionId ? undefined : current))
    }
  }

  // Drag-and-drop shares the same staging callback as the picker and paste paths.
  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: canEditDraft && !isUploadingAttachments,
    onFiles: onStageAttachmentFiles
  })

  // Submits the current doc, passing the ids of any skills picked as inline chips.
  const handleWslSetupCommand = async (): Promise<void> => {
    if (!canEditDraft) return
    try {
      const status = await window.api.settings.getWsl2BashPreviewStatus()
      if (!status.available) {
        onSetComposerError(
          t('WSL2 setup is unavailable on this system ({{reason}}).', {
            reason: status.reason
          })
        )
        return
      }
      if (!(await workflows.wslSetup.start())) {
        onSetComposerError(t('Open-Science could not open the WSL2 setup conversation.'))
      }
    } catch {
      onSetComposerError(t('Open-Science could not open the WSL2 setup conversation.'))
    }
  }

  const handleSubmit = (): void => {
    if (!canEditDraft || !effectiveCanSend) return
    if (docToText(draftDoc).trim() === '/setup-wsl') {
      void handleWslSetupCommand()
      return
    }
    onSendMessage(docToSkillIds(draftDoc))
  }

  // The "Your files" menu appends a linked-folder mention straight into the owned draft doc (the
  // same appendArtifactMention path Global Search uses); ComposerEditor syncs the chip into the DOM.
  const handleInsertFileReference = (reference: LinkedFolderFileReference): void => {
    if (!canEditDraft) return
    onValidatedDraftDocChange(appendArtifactMention(draftDoc, reference))
  }

  const handleBranchInNewSession = (): void => {
    if (!effectiveCanSend || !onBranchInNewSession || !canBranchInNewSession) return
    onBranchInNewSession(docToSkillIds(draftDoc))
  }

  const respondToPendingPlan = async (
    response: { decision: 'approved' | 'rejected' } | { feedback: string }
  ): Promise<void> => {
    if (!activeSession || !pendingPlan || !canRespondToPlan) return
    if (!activeSession.activeRun) {
      await onRespondToRestoredPlan(response)
      return
    }
    await respondToSessionPlan(
      {
        projectId: activeSession.projectId,
        sessionId: activeSession.id,
        projection: pendingPlan
      },
      response,
      { onSessionSizeLimit }
    )
  }

  const openPendingPlan = (): void => {
    if (!activeSession || !pendingPlan) return
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createSessionPlanPreviewItem(
        activeSession.id,
        activeSession.projectId,
        // Version-scoped id keeps this tab identical to the progress chip / "view plan" entry.
        pendingPlan.artifactVersionId
      )
    )
  }

  const hasTextDraft = draftDoc.nodes.some(
    (node) => node.type === 'text' && node.text.trim().length > 0
  )
  const pastedTextNodes = draftDoc.nodes.filter(
    (node): node is ComposerPastedTextNode => node.type === 'pasted-text'
  )
  const pastedTextById = new Map(pastedTextNodes.map((node) => [node.id, node]))
  const pastedTextByAttachmentId = new Map(
    pastedTextNodes.flatMap((node) =>
      node.attachmentId ? ([[node.attachmentId, node]] as const) : []
    )
  )
  const canPlanFirst = effectiveCanSend && hasTextDraft
  const hasSideChatDraft = hasTextDraft || annotations.length > 0
  const openSideChatReason =
    sideChatController.openDisabledReason ??
    sideChatBlockMessage(sideChatBlock({ action: 'open', parent: activeSession }), t)
  const sendSideChatReason =
    sideChatDisabledReason ??
    sideChatBlockMessage(
      sideChatBlock({
        action: 'send',
        parent: activeSession,
        hasAttachments: attachments.length > 0 || attachmentTransfers.length > 0,
        hasContent: hasSideChatDraft
      }),
      t
    )
  const canOpenSideChat = !openSideChatReason && Boolean(sideChatController.createDraft)
  const canStartSideChat = !sendSideChatReason
  const canRetrySideChatHydration = Boolean(onRetrySideChatHydration)
  const canOpenSendOptions =
    canPlanFirst ||
    canOpenSideChat ||
    canStartSideChat ||
    canRetrySideChatHydration ||
    (effectiveCanSend && Boolean(onBranchInNewSession) && canBranchInNewSession)

  const handlePlanFirst = (): void => {
    if (!canPlanFirst) return
    onPlanFirst(docToSkillIds(draftDoc))
  }

  const sendsSideChatDraft = hasSideChatDraft && canStartSideChat
  const sideChatHint =
    openSideChatReason ??
    (sendsSideChatDraft
      ? t('Send draft to Side chat')
      : t('Opens an empty Side chat; keeps your draft.'))
  const handleSideChat = (): void => {
    if (!canOpenSideChat) return
    if (sendsSideChatDraft) onStartSideChat()
    else sideChatController.createDraft?.()
  }
  const sideChatMenuItems = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem
            data-testid="menu-side-chat"
            aria-disabled={!canOpenSideChat}
            className="h-8 whitespace-nowrap aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
            onSelect={(event) => {
              if (!canOpenSideChat) event.preventDefault()
              else handleSideChat()
            }}
          >
            <MessageCircleMore className="mr-2 size-4 shrink-0 text-text-300" aria-hidden="true" />
            {t('New side chat')}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left">{sideChatHint}</TooltipContent>
      </Tooltip>
      {canRetrySideChatHydration ? (
        <DropdownMenuItem data-testid="menu-retry-side-chat" onSelect={onRetrySideChatHydration}>
          {t('Retry Side chat restore')}
        </DropdownMenuItem>
      ) : null}
    </>
  )

  // Converts the hidden file input selection into the shared staging callback.
  const handleAttachmentInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? [])

    // Reset the input so choosing the same file again still triggers a change event.
    event.target.value = ''

    if (files.length > 0) {
      onStageAttachmentFiles(files)
    }
  }

  // Treats pasted clipboard files exactly like selected files, then keeps text paste behavior intact.
  const handleMessageDraftPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (!canEditDraft || isUploadingAttachments) return

    const files = Array.from(event.clipboardData.files)

    if (files.length === 0) return

    event.preventDefault()
    onStageAttachmentFiles(files)
  }

  const handleRemoveAttachment = (attachment: (typeof attachments)[number]): void => {
    onRemoveAttachment(attachment)
    if (pastedTextByAttachmentId.has(attachment.id)) {
      setComposerRestoreFocusRequest((request) => (request ?? 0) + 1)
    }
  }

  const handleCancelAttachmentTransfer = (transfer: (typeof attachmentTransfers)[number]): void => {
    onCancelAttachmentTransfer(transfer)
    if (transfer.pastedTextId) {
      setComposerRestoreFocusRequest((request) => (request ?? 0) + 1)
    }
  }

  const handleLocatePastedText = (pastedTextId: string): void => {
    const attachment = document.getElementById(pastedTextAttachmentDomId(pastedTextId))
    if (!attachment) return
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    attachment.scrollIntoView?.({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest'
    })
    attachment.animate?.(
      reducedMotion
        ? [{ opacity: 1 }, { opacity: 0.72 }, { opacity: 1 }]
        : [
            { transform: 'scale(1)', opacity: 1 },
            { transform: 'scale(1.012)', opacity: 0.72 },
            { transform: 'scale(1)', opacity: 1 }
          ],
      {
        duration: reducedMotion ? 140 : 480,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
      }
    )
  }

  return (
    <ResizablePanel id="main-content" defaultSize="60%" minSize="30%">
      <section
        className="flex h-full min-w-0 flex-col overflow-hidden bg-bg-10 p-[6px] pl-4 max-md:p-0"
        data-session-id={activeSession?.id ?? ''}
        data-agent-running={activeSession?.status === 'running' ? 'true' : 'false'}
      >
        <header
          data-testid="conversation-header"
          className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-2 max-md:px-2 max-md:pb-2 max-md:pt-[max(env(safe-area-inset-top),0.5rem)]"
        >
          <button
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-text-300 hover:bg-surface-control-hover hover:text-text-000 md:hidden"
            aria-label={t('Open navigation')}
            onClick={onOpenSidebar}
          >
            <Menu className="size-5" strokeWidth={2} aria-hidden="true" />
          </button>
          <h1 className="min-w-0 flex-1 text-[13px] font-semibold text-text-000">
            {activeSession ? (
              <SessionInfoPopover
                key={activeSession.id}
                session={activeSession}
                sourceSession={sourceSession}
                onOpenSession={sessionTools.openSession}
                onEdit={sessionTools.editSession}
                onTogglePin={sessionTools.togglePin}
              />
            ) : (
              <span className="block truncate">{t('New conversation')}</span>
            )}
          </h1>
          {activeSession && sessionTools.exportDiagnostics && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <button
                    type="button"
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-text-300 transition-colors hover:bg-surface-control-hover hover:text-text-000 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('Export diagnostics…')}
                    onClick={() => sessionTools.exportDiagnostics?.(activeSession)}
                  >
                    <Stethoscope className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" className="space-y-2 p-3 leading-relaxed">
                  <p className="font-medium">{t('Export diagnostics…')}</p>
                  <p>
                    {t(
                      'If this session fails or behaves unexpectedly, export a diagnostic package to help developers investigate.'
                    )}
                  </p>
                  <p>
                    {t(
                      'Choose diagnostic metadata to include. Private content fields are excluded. Saved locally; nothing is uploaded or sent to an LLM.'
                    )}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <PackageExportProgressButton />
          <NotificationBell className="md:hidden" />
          <button
            type="button"
            className={`flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-surface-control-hover md:hidden ${
              isPreviewPanelCollapsed ? 'text-action-panel-toggle' : 'text-primary'
            }`}
            aria-label={t(
              isPreviewPanelCollapsed ? 'Expand preview panel' : 'Collapse preview panel'
            )}
            aria-expanded={!isPreviewPanelCollapsed}
            aria-controls="right-panel"
            onClick={onTogglePreviewPanel}
          >
            <PanelRight className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
          </button>
        </header>
        <PackageOperationIndicator />

        {activeSession?.contentLoaded === false ? (
          <SessionSwitchSkeleton />
        ) : (
          <WorkspaceMessageEditStateProvider canEditMessage={canEditMessage}>
            <WorkspaceMessageScroller
              activeSession={activeSession}
              onOpenLibraryMention={onOpenLibraryMention}
              forkSourceContent={
                activeSession?.branchSource && sessionTools.openSession ? (
                  <div className="mb-2 flex items-center gap-2 text-xs">
                    <span className="h-px flex-1 bg-border" aria-hidden="true" />
                    <GitBranch className="size-3 text-muted-foreground" aria-hidden="true" />
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() =>
                        sessionTools.openSession?.(activeSession.branchSource!.sessionId)
                      }
                    >
                      {sourceSessionNumber !== undefined
                        ? t('Continued from chat #{{number}}', { number: sourceSessionNumber })
                        : t('Continued from chat')}
                    </button>
                    <span className="h-px flex-1 bg-border" aria-hidden="true" />
                  </div>
                ) : null
              }
              credentialPending={pendingCredentialRequest !== undefined}
              visiblePermissionPending={pendingPermissions.length > 0}
              optimisticMessage={optimisticMessage}
              isResumingSession={isResuming}
              notebookReference={notebookReference}
              onSendEditedMessage={onSendEditedMessage}
              canBranchInNewSession={canBranchInNewSession}
              onBranchInNewSession={onBranchFromAgentMessage}
              pendingElicitations={sessionPendingElicitations}
              handoffLifecycleSource={workspaceHandoffLifecycleClient}
              onRetryHandoff={(request) => workspaceHandoffLifecycleClient.retry(request)}
              reportPresentationRevealing
              annotations={annotations}
              onAddAnnotation={handleAddTranscriptAnnotation}
              onUpdateAnnotationNote={handleUpdateTranscriptAnnotation}
              onRemoveAnnotation={onRemoveAnnotation}
              onAnnotationError={handleTranscriptAnnotationError}
            />
          </WorkspaceMessageEditStateProvider>
        )}

        <div className="relative shrink-0">
          <div
            aria-hidden="true"
            data-testid="composer-surface-fade"
            className={cn(
              'pointer-events-none absolute inset-x-0 bg-gradient-to-t from-bg-10 to-bg-10/0',
              hasPendingPermission || pendingElicitation ? '-top-18 h-18' : '-top-12 h-12'
            )}
          />

          <div className="px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] md:px-4 md:pb-[6px]">
            {/* Runtime and session errors stay near the composer so recovery is visible. */}
            <div className={composerContentClassName}>
              <div className="px-1 md:px-3">
                {conversation.planProjectionRecoveryError && activeSession ? (
                  <UnavailablePlanNotice
                    key={`${activeSession.id}:${String(activeSession.runtimeContext?.revision)}`}
                    session={activeSession}
                  />
                ) : null}
                {composerError && composerError !== actionError ? (
                  <div role="alert" className="mb-2">
                    <ErrorNotice inline icon={AlertTriangle} tone="red" title={composerError} />
                  </div>
                ) : null}
                {composerError && composerErrorDetail ? (
                  <DiagnosticDetails detail={composerErrorDetail} />
                ) : null}
                {/* Interrupted sessions get a neutral banner with a Resume action instead of the
                    red error box, so the user can re-attach and continue the interrupted turn. */}
                {activeSession?.interrupted && !hasUnsupportedCodexAcpRunError ? (
                  <SessionInterruptedBanner
                    message={activeSession.error ?? t('This session was interrupted.')}
                    isDisabled={!canResumeSession}
                    isResuming={isResuming}
                    onResume={() => void handleResume()}
                  />
                ) : activeSession?.compacting ? (
                  // Auto-recovery after a request-size overflow: a neutral note, not the red error box,
                  // while the agent context is reset and the conversation is replayed as text.
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-border-200 bg-bg-200 px-3 py-2 text-[12px] leading-5 text-text-300">
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
                    {t('Compacting conversation to fit the context limit…')}
                  </div>
                ) : resolvedActionError || activeSession?.status === 'error' ? (
                  <DismissibleConversationError key={errorKey}>
                    {/* Transient action errors and a run failure can coexist; show each on its own row
                        so the run's report affordance is never suppressed by a transient error. */}
                    {resolvedActionError ? (
                      <span className="min-w-0 break-words pr-6">{resolvedActionError}</span>
                    ) : null}
                    {activeSession?.status === 'error' ? (
                      <div className="flex flex-col items-stretch gap-2">
                        <span className="min-w-0 break-words pr-6">{resolvedRunError}</span>
                        {/* Actions stay with the run's own error, so the shown and reported text are
                            always the same error. Shown only for an unknown failure — a recognized one
                            (app guidance or a known provider error) keeps its message but is not a bug
                            worth a GitHub issue. */}
                        {canRetryArtifactFinalization || isRunErrorReportable ? (
                          <div className="flex flex-wrap items-center justify-end gap-1 self-end">
                            {canRetryArtifactFinalization ? (
                              <button
                                type="button"
                                onClick={workflows.artifactFinalization.request}
                                disabled={workflows.artifactFinalization.running}
                                className="inline-flex h-6 items-center gap-1 rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
                                aria-label={t('Retry Artifact publication')}
                              >
                                {workflows.artifactFinalization.running ? (
                                  <Loader2
                                    className="size-3 animate-spin"
                                    strokeWidth={2.2}
                                    aria-hidden="true"
                                  />
                                ) : null}
                                {t('Retry Artifact publication')}
                              </button>
                            ) : null}
                            {isRunErrorReportable ? (
                              <button
                                type="button"
                                onClick={openReportDialog}
                                className="inline-flex h-6 items-center gap-1 rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
                                aria-label={t('Report this error')}
                              >
                                <Flag className="size-3" strokeWidth={2.2} aria-hidden="true" />
                                {t('Report error')}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {showVisionModelSettings || showCodexAcpSettings ? (
                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            openSettingsToPanel(showVisionModelSettings ? 'model' : 'agent')
                          }
                          className="inline-flex h-6 items-center rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
                        >
                          {showVisionModelSettings ? t('Model settings') : t('Agent settings')}
                        </button>
                      </div>
                    ) : null}
                  </DismissibleConversationError>
                ) : null}

                {settingsLoaded ? (
                  <SubagentAvailabilityNotice
                    unavailable={subagentUnavailable}
                    onTurnOnDelegation={() => setAgentControlsOpenRequest((request) => request + 1)}
                    onOpenSettings={openSettings}
                  />
                ) : null}

                {activeSession && delegatedQuestion ? (
                  <WorkspaceDelegatedQuestionCard
                    key={delegatedQuestion.requestId}
                    projectId={activeSession.projectId}
                    sessionId={activeSession.id}
                    request={delegatedQuestion}
                    onRespond={onRespondToElicitation}
                  />
                ) : null}

                {/* Delegated permission cards stay in the transcript; the root card owns the
                    resizable composer surface below. Side chat hides both main interaction lanes. */}
                {pendingPermissions.some((request) => request.delegated) ? (
                  <PermissionApprovalControls
                    requests={pendingPermissions.filter((request) => request.delegated)}
                    onRespond={onRespondToPermission}
                    disabled={isStopping}
                    notebookLookup={
                      activeSession
                        ? {
                            sessionId: activeSession.id,
                            workspaceCwd: activeSession.cwd ?? '',
                            projectId: activeSession.projectId
                          }
                        : undefined
                    }
                  />
                ) : null}

                {activeSession && specialistUnavailable ? (
                  <ErrorNotice
                    role="status"
                    aria-live="polite"
                    data-testid="specialist-unavailable-notice"
                    className="mb-3"
                    title={t('This Specialist is no longer available')}
                    description={`${t('Choose another Specialist before sending a message.')} ${t('Your draft is preserved.')}`}
                    primaryButton={{
                      label: t('Choose Specialist'),
                      onClick: () => setAgentControlsOpenRequest((request) => request + 1)
                    }}
                  />
                ) : null}

                {/* The expanded ledger opens above the strip; the strip (Notebook entry, chip,
                    message queue) stays in place. */}
                {backgroundTasksExpanded && activeSession ? (
                  <SessionBackgroundActivity
                    sessionId={activeSession.id}
                    projectId={activeSession.projectId}
                    notebook={notebookReference}
                    runs={backgroundTasks.runs}
                    jobs={backgroundTasks.jobs}
                    now={backgroundTasks.now}
                    onOpenNotebook={onOpenNotebook}
                    onOpenComputeJob={onOpenJob ?? ((job) => onOpenJobList(job.session_id))}
                    onOpenJobList={onOpenJobList}
                  />
                ) : null}

                {/* Keep guidance above this joined strip/composer dock: the negative margin below
                    tucks the strip behind the composer, so a notice between them would overlap.
                    Switching between a compact job bar and Notebook chrome remounts this layer so a
                    Notebook that becomes available after jobs still receives its entrance animation. */}
                {notebookReference ||
                messageQueue.items.length > 0 ||
                backgroundTasksVisible ||
                hasSubagents ||
                hasBookmarkEntry ||
                (activeBranchPlan ? isPlanProgressVisible(activeBranchPlan) : false) ? (
                  <div
                    aria-hidden={ordinaryComposerBlocked || undefined}
                    inert={ordinaryComposerBlocked || undefined}
                    key={
                      notebookReference
                        ? `notebook-${notebookReference.sessionId}`
                        : messageQueue.items.length > 0
                          ? 'message-queue'
                          : 'jobs'
                    }
                    className={cn(
                      'flex px-2',
                      notebookReference || messageQueue.items.length > 0 || hasBookmarkEntry
                        ? 'relative -mb-8 min-h-[68px] items-start rounded-2xl bg-bg-200 pt-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-out'
                        : 'mb-2 min-h-9 items-center rounded-lg border border-border-200 bg-bg-000 shadow-card',
                      ordinaryComposerBlocked && 'invisible pointer-events-none'
                    )}
                  >
                    {activeSession &&
                    activeBranchPlan &&
                    isPlanProgressVisible(activeBranchPlan) ? (
                      <PlanProgressChip
                        projection={activeBranchPlan}
                        onOpen={() => {
                          usePreviewWorkbenchStore
                            .getState()
                            .upsertAndActivateItem(
                              createSessionPlanPreviewItem(
                                activeSession.id,
                                activeSession.projectId,
                                activeBranchPlan.artifactVersionId
                              )
                            )
                        }}
                      />
                    ) : null}
                    <SubagentsBar session={activeSession} permissions={pendingPermissions} />
                    {activeSession ? <BookmarksPopover /> : null}
                    {notebookReference ? (
                      <button
                        type="button"
                        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-normal text-text-100 transition-colors duration-200 ease-out hover:bg-bg-300 hover:text-text-000"
                        aria-label={t('Open notebook')}
                        aria-controls="right-panel"
                        onClick={() => onOpenNotebook(notebookReference)}
                      >
                        <BookOpen className="size-3.5" strokeWidth={2} aria-hidden="true" />
                        {t('Notebook')}
                      </button>
                    ) : null}
                    <div className="flex-1" />
                    {backgroundTasksVisible && activeSession ? (
                      <BackgroundTasksChip
                        summary={backgroundTasks.summary}
                        now={backgroundTasks.now}
                        expanded={backgroundTasksExpanded}
                        onToggle={() => setBackgroundTasksExpanded((expanded) => !expanded)}
                      />
                    ) : null}
                    <ComposerMessageQueueTrigger
                      items={messageQueue.items}
                      expanded={messageQueueExpanded}
                      onExpandedChange={setMessageQueueExpanded}
                    />
                  </div>
                ) : null}

                <div className="relative">
                  <div
                    aria-hidden="true"
                    data-testid="composer-card-backdrop"
                    className={cn(
                      'relative -mb-8 rounded-2xl bg-bg-200 pb-8',
                      (packageLocked ||
                        hasPendingPermission ||
                        pendingElicitation ||
                        pendingPlan ||
                        specialistUnavailable) &&
                        'hidden'
                    )}
                  />

                  {/* Reconfigure failure banner: shown directly above the composer when a pre-send
                      specialist reconfigure failed. Draft is preserved; three recovery actions. */}
                  {reconfigureError ? (
                    <div className="relative z-10 mb-2" data-testid="reconfigure-error-banner">
                      <ErrorNotice
                        role="alert"
                        title={
                          reconfigureError.committed
                            ? t('Specialist switch is pending for {{name}}', {
                                name: reconfigureError.specialistName
                              })
                            : t('Could not switch to {{name}}', {
                                name: reconfigureError.specialistName
                              })
                        }
                        description={
                          reconfigureError.committed
                            ? t(
                                'The selection is saved, but the Agent runtime has not applied it yet. Your draft and queued messages are preserved.'
                              )
                            : t(
                                'The agent session could not be reconfigured. Your draft has been preserved.'
                              )
                        }
                      >
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={onReconfigureRetry}>
                            {t('Retry')}
                          </Button>
                          <Button size="sm" variant="outline" onClick={onReconfigureChooseOther}>
                            {t('Choose another specialist')}
                          </Button>
                          <Button size="sm" variant="outline" onClick={onReconfigureUseNone}>
                            {t('Use None (Main Agent)')}
                          </Button>
                        </div>
                      </ErrorNotice>
                    </div>
                  ) : null}

                  {ordinaryComposerBlocked ? (
                    <div
                      data-testid="blocking-composer-overlay"
                      className="absolute inset-x-0 bottom-0 z-30"
                    >
                      {hasPendingPermission ? (
                        <ResizablePermissionComposer key={rootPermissionRequests[0]?.requestId}>
                          <PermissionApprovalControls
                            requests={rootPermissionRequests}
                            onRespond={onRespondToPermission}
                            embedded
                            notebookLookup={
                              activeSession
                                ? {
                                    sessionId: activeSession.id,
                                    workspaceCwd: activeSession.cwd ?? '',
                                    projectId: activeSession.projectId
                                  }
                                : undefined
                            }
                          />
                        </ResizablePermissionComposer>
                      ) : hasPendingCredential && pendingCredentialRequest ? (
                        <ResizableCredentialComposer key={pendingCredentialRequest.id}>
                          <ConnectorCredentialControls
                            request={pendingCredentialRequest}
                            embedded
                          />
                        </ResizableCredentialComposer>
                      ) : pendingElicitation ? (
                        <ResizableElicitationComposer
                          key={
                            pendingElicitationRequest?.requestId ?? pendingElicitationActivity?.id
                          }
                        >
                          <WorkspaceElicitationCard
                            elicitation={pendingElicitation}
                            request={pendingElicitationRequest}
                            embedded
                            onRespond={onRespondToElicitation}
                            editDraft={
                              pendingElicitationActivity
                                ? activeSession?.elicitationEditDrafts?.[
                                    pendingElicitationActivity.id
                                  ]
                                : undefined
                            }
                            onEditDraftChange={
                              activeSession &&
                              pendingElicitationActivity &&
                              pendingElicitationRequest
                                ? (draft) =>
                                    setElicitationEditDraft(
                                      activeSession.id,
                                      pendingElicitationActivity.id,
                                      pendingElicitationRequest.requestId,
                                      draft
                                    )
                                : undefined
                            }
                            onDraftChange={(answers: ElicitationAnswer[]) => {
                              if (!activeSession || !pendingElicitationActivity) return
                              setElicitationDraftAnswers(
                                activeSession.id,
                                pendingElicitationActivity.id,
                                answers
                              )
                            }}
                          />
                        </ResizableElicitationComposer>
                      ) : pendingPlan ? (
                        <ResizablePlanComposer key={activePendingPlanKey}>
                          {(expanded) => (
                            <WorkspacePlanCard
                              expanded={expanded}
                              embedded
                              enabled={canRespondToPlan}
                              projection={pendingPlan}
                              onOpen={openPendingPlan}
                              onRespond={(decision) => respondToPendingPlan({ decision })}
                              onSubmitResponse={(text) => respondToPendingPlan({ feedback: text })}
                              onResolved={resolvePendingPlan}
                            />
                          )}
                        </ResizablePlanComposer>
                      ) : null}
                    </div>
                  ) : null}

                  {/* The ordinary composer keeps this lane's geometry while a blocking interaction
                      overlays it, so panel entry/resize/exit never resizes the transcript viewport. */}
                  <TooltipProvider>
                    {packageLocked ? (
                      <section
                        className="relative z-10 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 py-4 text-muted-foreground"
                        aria-label={t('Session export in progress')}
                      >
                        <LockKeyhole className="size-4 shrink-0" aria-hidden="true" />
                        <p className="text-sm">
                          {packageOperation?.kind === 'fork'
                            ? t('Temporarily read-only during fork')
                            : t('Temporarily read-only during export')}
                        </p>
                      </section>
                    ) : activeSession?.packageOrigin ? (
                      <section
                        className="relative z-10 rounded-xl border border-border bg-muted/50 px-4 py-3"
                        aria-label={t('Imported research history')}
                      >
                        <p className="text-sm font-medium text-foreground">
                          {t('Imported research history')}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('Imported on {{date}}', {
                            date: new Date(activeSession.packageOrigin.importedAt).toLocaleString()
                          })}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {t(
                            'Read-only. Browse the conversation, files and recorded results. Code execution and continuation are disabled.'
                          )}
                        </p>
                        {sessionForkAvailable() ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-2"
                            onClick={() => {
                              void forkSession(activeSession)
                            }}
                          >
                            <GitBranch className="size-4" aria-hidden="true" />
                            {t('Fork to continue')}
                          </Button>
                        ) : null}
                        <details className="mt-2 text-xs leading-5 text-muted-foreground">
                          <summary className="cursor-pointer">{t('Package source')}</summary>
                          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                            <dt>{t('Source project')}</dt>
                            <dd className="break-all font-mono">
                              {activeSession.packageOrigin.sourceProjectId}
                            </dd>
                            <dt>{t('Source Session')}</dt>
                            <dd className="break-all font-mono">
                              {activeSession.packageOrigin.sourceSessionId}
                            </dd>
                          </dl>
                          <p className="mt-1">
                            {t(
                              'Original evidence is retained separately; local references and evidence hashes are derived during import.'
                            )}
                          </p>
                        </details>
                        {activeSession.packageOrigin.excludedFiles?.length ? (
                          <details className="mt-2 text-xs text-muted-foreground">
                            <summary className="cursor-pointer">
                              {t('Not included in this package')}
                            </summary>
                            <ul className="mt-1 max-h-36 list-disc overflow-y-auto pl-4">
                              {[
                                ...new Set(
                                  activeSession.packageOrigin.excludedFiles.map(
                                    (file) => file.filename
                                  )
                                )
                              ].map((filename) => (
                                <li key={filename}>{filename}</li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </section>
                    ) : (
                      <form
                        aria-hidden={ordinaryComposerBlocked || undefined}
                        data-testid="ordinary-composer-form"
                        inert={ordinaryComposerBlocked || undefined}
                        className={cn(
                          'relative z-10 flex flex-col gap-2 rounded-2xl border border-border-200 bg-bg-000 px-3 py-2',
                          ordinaryComposerBlocked && 'invisible pointer-events-none'
                        )}
                        data-specialist-color={specialistComposerColor}
                        onSubmit={(event) => event.preventDefault()}
                        {...dropZoneProps}
                        {...annotationDrop.props}
                      >
                        {annotationDrop.over ? (
                          <div className="rounded-md border border-primary px-2 py-1 text-xs text-text-200">
                            {t('Add to main conversation')}
                          </div>
                        ) : null}
                        {annotationDrop.error ? (
                          <p role="alert" className="text-xs text-danger-000">
                            {t(
                              'Could not move this annotation. It may have changed or the target is full.'
                            )}
                          </p>
                        ) : null}
                        {specialistComposerColor && selectedSpecialist ? (
                          <span
                            key={selectedSpecialist.id}
                            className="composer-specialist-color-in"
                            style={{ borderColor: specialistComposerColor }}
                            aria-hidden="true"
                          />
                        ) : null}
                        {/* File-drag overlay is scoped to the composer input card only. */}
                        {isDragging ? (
                          <FileDropOverlay
                            label={
                              sessionPackageImportAvailable()
                                ? t('Drop files')
                                : t('Drop files to attach')
                            }
                            className="rounded-2xl"
                          />
                        ) : null}
                        {pdfContext.bindings.length > 0 ? (
                          <div
                            data-testid="pdf-context-bar"
                            className="-mx-3 -mt-2 flex min-h-9 items-center gap-1 rounded-t-2xl border-b border-border-200 bg-bg-10 px-2 py-1"
                          >
                            {activeSession ? (
                              <ReadingContextPicker
                                projectId={activeSession.projectId}
                                linkedSources={pdfContext.bindings.flatMap((binding) =>
                                  'sourceKind' in binding
                                    ? [
                                        {
                                          sourceKind: binding.sourceKind,
                                          sourceFileId: binding.sourceFileId,
                                          sourceVersionId: binding.sourceVersionId
                                        }
                                      ]
                                    : []
                                )}
                                atLimit={pdfContext.bindings.length >= MAX_SESSION_PDF_CONTEXTS}
                                onSelect={linkReadingContext}
                              >
                                <button
                                  type="button"
                                  disabled={pdfContext.isPending}
                                  aria-label={t('Choose PDFs for Reading')}
                                  className={cn(
                                    'flex h-7 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12px] font-medium leading-4 text-text-000 hover:bg-bg-200 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0',
                                    composerInteractiveTransitionClassName
                                  )}
                                >
                                  <Link2
                                    className="size-4 shrink-0 text-primary"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                  {t('Reading')}
                                  <ChevronDown
                                    className="size-3 shrink-0 text-text-300"
                                    strokeWidth={2}
                                    aria-hidden="true"
                                  />
                                </button>
                              </ReadingContextPicker>
                            ) : (
                              <>
                                <Link2
                                  className="size-4 shrink-0 text-primary"
                                  strokeWidth={2}
                                  aria-hidden="true"
                                />
                                <span className="shrink-0 text-[12px] font-medium leading-4 text-text-000">
                                  {t('Reading')}
                                </span>
                              </>
                            )}
                            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                              <TooltipProvider>
                                {pdfContext.bindings.map((binding) => {
                                  const pending = pdfContext.pendingBindingId === binding.bindingId
                                  return (
                                    <span
                                      key={binding.bindingId}
                                      className="flex min-w-0 max-w-56 shrink items-center rounded-lg bg-bg-200 text-text-100"
                                    >
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className={cn(
                                              'min-w-0 flex-1 rounded-l-lg px-2 py-1 text-left hover:bg-bg-300 hover:text-text-000 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0',
                                              composerInteractiveTransitionClassName
                                            )}
                                            aria-label={t('Open PDF context {{name}}', {
                                              name: binding.name
                                            })}
                                            onClick={() => openReadingContext(binding.bindingId)}
                                          >
                                            <ExtensionPreservingFileName
                                              name={binding.name}
                                              className="min-w-0 text-[12px] font-medium leading-4"
                                            />
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">
                                          {t(
                                            'Linked to this conversation. The Agent reads only the pages needed for your question.'
                                          )}
                                        </TooltipContent>
                                      </Tooltip>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className={attachmentRemoveButtonClassName}
                                            disabled={pending || pdfContext.isPending}
                                            aria-label={t('Remove PDF context {{name}}', {
                                              name: binding.name
                                            })}
                                            onClick={() => unlinkReadingContext(binding.bindingId)}
                                          >
                                            {pending ? (
                                              <Loader2
                                                className="size-3.5 animate-spin"
                                                strokeWidth={2}
                                                aria-hidden="true"
                                              />
                                            ) : (
                                              <X
                                                className="size-3.5"
                                                strokeWidth={2.2}
                                                aria-hidden="true"
                                              />
                                            )}
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">
                                          {t('Remove PDF context {{name}}', { name: binding.name })}
                                        </TooltipContent>
                                      </Tooltip>
                                    </span>
                                  )
                                })}
                              </TooltipProvider>
                            </div>
                          </div>
                        ) : null}
                        {pdfContext.automaticAttachmentCount > 0 ? (
                          <div
                            data-testid="automatic-reading-suggestion"
                            className={cn(
                              '-mx-3 flex min-h-9 items-center gap-2 border-b border-border-200 bg-primary/[0.05] px-2 py-1',
                              pdfContext.bindings.length === 0 && '-mt-2 rounded-t-2xl'
                            )}
                          >
                            <Link2
                              className="size-4 shrink-0 text-primary"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                            <span className="shrink-0 text-[12px] font-medium leading-4 text-text-000">
                              {t('Reading')}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-text-300">
                              {t('{{count}} PDFs will be linked when sent', {
                                count: pdfContext.automaticAttachmentCount,
                                defaultValue_one: '{{count}} PDF will be linked when sent'
                              })}
                            </span>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    aria-label={t('Keep as attachments')}
                                    onClick={dismissAutomaticReading}
                                    className={cn(
                                      'relative flex size-7 shrink-0 items-center justify-center rounded-lg text-text-300 before:absolute before:-inset-2 hover:bg-bg-200 hover:text-text-000 active:translate-y-px focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:active:translate-y-0',
                                      composerInteractiveTransitionClassName
                                    )}
                                  >
                                    <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  {t('Keep as attachments')}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        ) : null}
                        <ComposerMessageQueueContent
                          {...messageQueue}
                          expanded={messageQueueExpanded}
                        />
                        {isWslSetupDraft || activeSession?.wslSetup === true ? (
                          <div
                            className="flex items-center justify-between gap-3 rounded-lg border border-status-info-accent/30 bg-status-info-surface px-3 py-2 text-xs text-status-info-foreground"
                            data-testid="wsl-setup-conversation-actions"
                          >
                            <span>
                              {isWslSetupDraft
                                ? t(
                                    'This draft will open a guided WSL2 setup conversation. Review the diagnostics, then send it.'
                                  )
                                : t('This is a guided WSL2 setup conversation.')}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                              {isWslSetupDraft ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={discardWslSetupDraft}
                                >
                                  {t('Discard setup draft')}
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  useSettingsStore.getState().openSettingsToPanel('runtimes')
                                }
                              >
                                {t('Check and activate in Settings')}
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        {composer.view.queuedEdit ? (
                          <div className="flex items-center justify-between gap-2 text-xs text-text-300">
                            <span>
                              {composer.view.queuedEdit.revisionMessageId
                                ? t('Editing a historical revision')
                                : t('Editing a queued message')}
                            </span>
                            <button
                              type="button"
                              onClick={composer.actions.cancelQueuedEdit}
                              className="rounded px-2 py-1 hover:bg-bg-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              disabled={!canEditDraft}
                            >
                              {t('Exit queued editing')}
                            </button>
                          </div>
                        ) : null}
                        <AnnotationTransferSource
                          sourceId={annotationSourceId}
                          projectId={activeSession?.projectId ?? ''}
                          parentSessionId={activeSession?.id ?? ''}
                          annotations={annotations}
                          disabled={Boolean(openSideChatReason)}
                          onRemove={onRemoveAnnotation}
                        >
                          <AnnotationDraftCards
                            annotations={annotations}
                            disabled={!canEditDraft}
                            onReveal={requestAnnotationReveal}
                            onUpdateNote={(id, note) => {
                              const error = onUpdateAnnotationNote(id, note)
                              if (error) onSetComposerError(annotationValidationMessage(error, t))
                              else onSetComposerError(null)
                              return error
                            }}
                            onRemove={(id) => {
                              onRemoveAnnotation(id)
                              const validation = validateAnnotations(
                                annotations.filter((annotation) => annotation.id !== id),
                                docToText(draftDoc)
                              )
                              onSetComposerError(
                                validation ? annotationValidationMessage(validation, t) : null
                              )
                            }}
                          />
                        </AnnotationTransferSource>
                        <div className="flex flex-col gap-2">
                          {attachments.length > 0 || attachmentTransfers.length > 0 ? (
                            <div className="flex max-h-[92px] flex-wrap gap-2 overflow-y-auto border-b border-border-200 pb-2">
                              {/* Composer attachments remain removable until the prompt is submitted. */}
                              {attachments.map((attachment) => {
                                const attachmentName = attachment.originalName || attachment.name
                                const pastedText = pastedTextByAttachmentId.get(attachment.id)

                                return (
                                  <div
                                    key={attachment.id}
                                    id={
                                      pastedText
                                        ? pastedTextAttachmentDomId(pastedText.id)
                                        : undefined
                                    }
                                    data-pasted-text-attachment={pastedText ? 'true' : undefined}
                                    data-state={pastedText ? 'success' : undefined}
                                    className={attachmentChipClassName}
                                  >
                                    <FileTypeIcon
                                      name={attachmentName}
                                      mimeType={attachment.mimeType}
                                    />
                                    {pastedText ? (
                                      <button
                                        type="button"
                                        className={pastedTextRestoreButtonClassName}
                                        disabled={!canEditDraft}
                                        onClick={() => onRestorePastedText(pastedText.id)}
                                      >
                                        <span className="w-full truncate whitespace-nowrap text-[12px] leading-4">
                                          {pastedTextPreviewName(pastedText.text)}
                                        </span>
                                        <span className="flex items-center gap-0.5 whitespace-nowrap text-[11px] leading-3 text-text-300">
                                          {t('Show in text field')}
                                          <ChevronRight
                                            className="size-3 shrink-0"
                                            strokeWidth={2}
                                            aria-hidden="true"
                                          />
                                        </span>
                                      </button>
                                    ) : (
                                      <div className="min-w-0 flex-1">
                                        <ExtensionPreservingFileName
                                          name={attachmentName}
                                          className="text-[12px] leading-4"
                                        />
                                        <div className="truncate text-[11px] leading-3 text-text-300">
                                          {formatAttachmentSize(attachment.size)}
                                        </div>
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      className={attachmentRemoveButtonClassName}
                                      disabled={!canEditDraft}
                                      aria-label={t('Remove attachment {{name}}', {
                                        name: attachmentName
                                      })}
                                      onClick={() => handleRemoveAttachment(attachment)}
                                    >
                                      <X
                                        className="size-3.5"
                                        strokeWidth={2.2}
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </div>
                                )
                              })}
                              {attachmentTransfers.map((transfer) => {
                                const percent =
                                  transfer.totalBytes === 0
                                    ? 100
                                    : Math.min(
                                        100,
                                        Math.round(
                                          (transfer.receivedBytes / transfer.totalBytes) * 100
                                        )
                                      )
                                const statusLabel =
                                  transfer.status === 'queued'
                                    ? t('Queued')
                                    : transfer.status === 'cancelling'
                                      ? t('Cancelling…')
                                      : transfer.status === 'error'
                                        ? transfer.error || t('Upload failed')
                                        : t('{{percent}}% of {{size}}', {
                                            percent,
                                            size: formatAttachmentSize(transfer.totalBytes)
                                          })
                                const pastedText = transfer.pastedTextId
                                  ? pastedTextById.get(transfer.pastedTextId)
                                  : undefined

                                return (
                                  <div
                                    key={transfer.transferId}
                                    id={
                                      pastedText
                                        ? pastedTextAttachmentDomId(pastedText.id)
                                        : undefined
                                    }
                                    data-pasted-text-attachment={pastedText ? 'true' : undefined}
                                    data-state={pastedText ? transfer.status : undefined}
                                    className={attachmentChipClassName}
                                  >
                                    <FileTypeIcon
                                      name={transfer.name}
                                      mimeType={transfer.mimeType}
                                    />
                                    <div className="min-w-0 flex-1">
                                      {pastedText ? (
                                        <div className="truncate text-[12px] leading-4">
                                          {pastedTextPreviewName(pastedText.text)}
                                        </div>
                                      ) : (
                                        <ExtensionPreservingFileName
                                          name={transfer.name}
                                          className="text-[12px] leading-4"
                                        />
                                      )}
                                      <div
                                        className={`truncate text-[11px] leading-3 ${
                                          transfer.status === 'error'
                                            ? 'text-red-600'
                                            : 'text-text-300'
                                        }`}
                                        title={transfer.errorDetail ?? statusLabel}
                                      >
                                        {statusLabel}
                                      </div>
                                      {transfer.status === 'uploading' ? (
                                        <div
                                          className="mt-1 h-0.5 overflow-hidden rounded-full bg-bg-300"
                                          role="progressbar"
                                          aria-label={t('Uploading {{name}}', {
                                            name: transfer.name
                                          })}
                                          aria-valuemin={0}
                                          aria-valuemax={100}
                                          aria-valuenow={percent}
                                        >
                                          <div
                                            className="h-full rounded-full bg-primary transition-[width]"
                                            style={{ width: `${percent}%` }}
                                          />
                                        </div>
                                      ) : null}
                                    </div>
                                    {transfer.canRetry ? (
                                      <button
                                        type="button"
                                        className={attachmentRemoveButtonClassName}
                                        disabled={!canEditDraft}
                                        aria-label={t('Retry attachment {{name}}', {
                                          name: transfer.name
                                        })}
                                        onClick={() => onRetryAttachmentTransfer(transfer)}
                                      >
                                        <RotateCcw className="size-3.5" aria-hidden="true" />
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className={attachmentRemoveButtonClassName}
                                      disabled={!canEditDraft || transfer.status === 'cancelling'}
                                      aria-label={t(
                                        transfer.status === 'error'
                                          ? 'Remove failed attachment {{name}}'
                                          : 'Cancel attachment {{name}}',
                                        { name: transfer.name }
                                      )}
                                      onClick={() => handleCancelAttachmentTransfer(transfer)}
                                    >
                                      <X
                                        className="size-3.5"
                                        strokeWidth={2.2}
                                        aria-hidden="true"
                                      />
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}

                          <div className="relative min-w-0 flex-1">
                            {/* Draft editing waits for persistence hydration to avoid targeting the wrong session. */}
                            <ComposerEditor
                              doc={draftDoc}
                              onDocChange={onValidatedDraftDocChange}
                              onSubmit={handleSubmit}
                              onPaste={handleMessageDraftPaste}
                              onLongTextPaste={onStagePastedText}
                              onLocatePastedText={handleLocatePastedText}
                              onUndo={onUndo}
                              onRedo={onRedo}
                              disabled={!canEditDraft}
                              placeholder={t(
                                'Ask anything — / skills · @ files · # sessions · {{shortcut}} search · ↑↓ history',
                                {
                                  shortcut: globalSearchShortcut
                                }
                              )}
                              ariaLabel={t('Ask anything')}
                              allowedSkillIds={allowedSkillIds}
                              onSelectWslSetup={() => void handleWslSetupCommand()}
                              isHistoryBrowsing={isHistoryBrowsing}
                              historyStatus={historyStatus}
                              onNavigateHistory={onNavigateHistory}
                              mentionPreviewContext={
                                activeSession
                                  ? {
                                      sessionId: activeSession.id,
                                      projectId: activeSession.projectId
                                    }
                                  : undefined
                              }
                              focusRequest={composerFocusKey}
                              restoreFocusRequest={composerRestoreFocusRequest}
                              caretRequest={ordinaryComposerBlocked ? undefined : caretRequest}
                            />
                          </div>

                          <div className="@container/composer flex items-center gap-1">
                            {/* The + button opens a dropdown for attachments and session actions. */}
                            <DropdownMenu>
                              <>
                                <Tooltip>
                                  {/* Radix opens tooltips on focus as well as hover, and a dropdown
                                  close returns programmatic focus to the trigger — which would
                                  re-open the tooltip with the pointer elsewhere. Only real keyboard
                                  focus (":focus-visible") may open it (radix-ui/primitives#2248). */}
                                  <TooltipTrigger
                                    asChild
                                    onFocus={(event) => {
                                      if (!event.currentTarget.matches(':focus-visible')) {
                                        event.preventDefault()
                                      }
                                    }}
                                  >
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        type="button"
                                        disabled={
                                          isUploadingAttachments ||
                                          (!canEditDraft && !activeBranchPlan && !activeSession)
                                        }
                                        className={composerIconButtonClassName}
                                        aria-label={
                                          activeBranchPlan
                                            ? t(
                                                'Add attachment, save as skill, view context window, view plan, or request review'
                                              )
                                            : t(
                                                'Add attachment, save as skill, view context window, or request review'
                                              )
                                        }
                                        data-testid="composer-plus-trigger"
                                      >
                                        <Plus
                                          className="size-4"
                                          strokeWidth={2}
                                          aria-hidden="true"
                                        />
                                      </button>
                                    </DropdownMenuTrigger>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    {activeBranchPlan
                                      ? t(
                                          'Add attachment, save as skill, view context window, view plan, or request review'
                                        )
                                      : t(
                                          'Add attachment, save as skill, view context window, or request review'
                                        )}
                                  </TooltipContent>
                                </Tooltip>
                              </>
                              <DropdownMenuContent side="top" align="start" className="w-56">
                                <>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <DropdownMenuItem
                                        data-testid="menu-attach-files"
                                        disabled={!canEditDraft || isUploadingAttachments}
                                        onSelect={() => fileInputRef.current?.click()}
                                      >
                                        <FileText
                                          className="mr-2 size-4 text-text-300"
                                          aria-hidden="true"
                                        />
                                        <span className="flex-1">{t('Attach files')}</span>
                                        <CircleHelp
                                          className="size-3.5 text-text-300"
                                          aria-hidden="true"
                                        />
                                      </DropdownMenuItem>
                                    </TooltipTrigger>
                                    <TooltipContent
                                      side="right"
                                      className="max-w-[280px] px-3 py-2 leading-5 whitespace-normal"
                                      data-testid="attachment-limits"
                                    >
                                      {attachmentLimitsText(t)}
                                    </TooltipContent>
                                  </Tooltip>
                                </>
                                <div
                                  className={cn(
                                    'px-2 py-1.5 text-[11px] leading-4 text-text-300',
                                    canEditDraft && !isUploadingAttachments
                                      ? 'hidden [@media(pointer:coarse)]:block'
                                      : 'block'
                                  )}
                                  data-testid="attachment-limits-touch"
                                >
                                  {attachmentLimitsText(t)}
                                </div>
                                <ComposerYourFilesMenu
                                  onInsertFileReference={handleInsertFileReference}
                                />
                                <DropdownMenuSeparator />
                                {activeSession && activeBranchPlan ? (
                                  <>
                                    <DropdownMenuItem
                                      data-testid="menu-view-plan"
                                      onSelect={() => {
                                        usePreviewWorkbenchStore
                                          .getState()
                                          .upsertAndActivateItem(
                                            createSessionPlanPreviewItem(
                                              activeSession.id,
                                              activeSession.projectId,
                                              activeBranchPlan.artifactVersionId
                                            )
                                          )
                                      }}
                                    >
                                      <BookOpen
                                        className="mr-2 size-4 text-text-300"
                                        aria-hidden="true"
                                      />
                                      <span className="flex-1">{t('View plan')}</span>
                                      <span className="text-[11px] text-text-300">
                                        {activeBranchPlan.counts.completed}/
                                        {activeBranchPlan.counts.steps}
                                      </span>
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                  </>
                                ) : null}
                                <DropdownMenuItem
                                  data-testid="menu-request-review"
                                  disabled={!canEditDraft || isRequestReviewDisabled || isReviewing}
                                  aria-busy={isReviewing || undefined}
                                  onSelect={() => {
                                    if (canEditDraft && !isRequestReviewDisabled && !isReviewing) {
                                      onRequestReview()
                                    }
                                  }}
                                  className="items-center gap-2"
                                >
                                  {isReviewing ? (
                                    <Loader2
                                      className="size-4 shrink-0 animate-spin text-text-200 motion-reduce:animate-none"
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <ScanEye
                                      className="size-4 shrink-0 text-text-200"
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span className="text-[13px] font-medium leading-5">
                                    {isReviewing ? t('Reviewing…') : t('Request review')}
                                  </span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <DropdownMenuItem
                                        data-testid="menu-save-as-skill"
                                        aria-disabled={isSaveAsSkillDisabled}
                                        aria-busy={isSavingAsSkill}
                                        onSelect={(event) => {
                                          if (isSaveAsSkillDisabled) {
                                            event.preventDefault()
                                            return
                                          }
                                          onSaveAsSkill()
                                        }}
                                        className={cn(
                                          'items-center gap-2',
                                          isSaveAsSkillDisabled && 'cursor-not-allowed opacity-50'
                                        )}
                                      >
                                        {isSavingAsSkill ? (
                                          <Loader2
                                            className="size-4 shrink-0 animate-spin text-text-200 motion-reduce:animate-none"
                                            strokeWidth={2}
                                            aria-hidden="true"
                                          />
                                        ) : (
                                          <BookMarked
                                            className="size-4 shrink-0 text-text-200"
                                            strokeWidth={2}
                                            aria-hidden="true"
                                          />
                                        )}
                                        <span className="text-[13px] font-medium leading-5">
                                          {isSavingAsSkill
                                            ? t('Saving as skill…')
                                            : t('Save as skill')}
                                        </span>
                                      </DropdownMenuItem>
                                    </TooltipTrigger>
                                    {saveAsSkillDisabledReason ? (
                                      <TooltipContent
                                        side="right"
                                        className="max-w-[280px] px-3 py-2 leading-5 whitespace-normal"
                                      >
                                        {saveAsSkillDisabledReason}
                                      </TooltipContent>
                                    ) : null}
                                  </Tooltip>
                                </>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  data-testid="menu-context-window"
                                  disabled={!activeSession}
                                  onSelect={() => {
                                    if (activeSession) setIsContextWindowOpen(true)
                                  }}
                                >
                                  <ChartNoAxesCombined
                                    className="mr-2 size-4 text-text-300"
                                    aria-hidden="true"
                                  />
                                  {t('Context window')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {/* The native picker is hidden because the composer button carries the UI. */}
                            <input
                              ref={fileInputRef}
                              type="file"
                              multiple
                              className="hidden"
                              tabIndex={-1}
                              onChange={handleAttachmentInputChange}
                            />

                            <ComposerAgentControlsMenu
                              profile={permissionProfile}
                              profileState={permissionProfileState}
                              grants={permissionGrants}
                              autoReviewEnabled={autoReviewEnabled}
                              memoryEnabled={memoryEnabled}
                              delegationEnabled={delegationEnabled}
                              delegationPending={delegationPending}
                              delegationHasLiveAttempts={delegationHasLiveAttempts}
                              delegationDisabledReason={delegationDisabledReason}
                              memoryDisabledReason={memoryDisabledReason}
                              readOnly={!canChangeAgentControls}
                              autoReviewReadOnly={!canChangeAutoReview}
                              memoryReadOnly={!canChangeMemory}
                              delegationReadOnly={!canChangeDelegation}
                              permissionProfileReadOnly={!canChangePermissionProfile}
                              grantActionsReadOnly={false}
                              autoReviewDisabled={!canEditDraft}
                              enabledComputeHosts={enabledComputeHosts}
                              selectedComputeHosts={selectedComputeHosts}
                              onComputeHostEnabledChange={onComputeHostEnabledChange}
                              onComputeHostSelectedChange={onComputeHostSelectedChange}
                              onProfileChange={onPermissionProfileChange}
                              onAutoReviewChange={onAutoReviewToggle}
                              onMemoryChange={onMemoryToggle}
                              onDelegationChange={onDelegationToggle}
                              onRevokeGrant={onRevokePermissionGrant}
                              onClearGrants={onClearPermissionGrants}
                              showSpecialist={
                                // Show for new conversations when a change handler is provided,
                                // or for any existing session (so the user can always switch).
                                (!activeSession && onSpecialistChange !== undefined) ||
                                activeSession !== undefined
                              }
                              specialistId={specialistId}
                              specialistUnavailable={specialistUnavailable}
                              specialistReadOnly={!canChangeSpecialist}
                              onSpecialistChange={onSpecialistChange}
                              openRequest={agentControlsOpenRequest}
                              computeOpenRequest={computeControlsOpenRequest}
                            />

                            <ComposerSpecialistPicker
                              selectedId={specialistId}
                              readOnly={!canChangeSpecialist}
                              onChange={onSpecialistChange}
                            />

                            <ComposerComputeTargetIndicator
                              targetProviderIds={selectedComputeHosts}
                              onOpenTarget={() =>
                                setComputeControlsOpenRequest((request) => request + 1)
                              }
                              onOpenSettings={openSettingsToComputeHost}
                            />

                            {/* Compatibility indicator for an explicit user selection while a turn is
                            running. Approved SDK switches are represented by the durable lifecycle
                            row and never wait for another user message. */}
                            {specialistHasPendingSwitch ? (
                              <span
                                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 text-[11px] italic text-blue-400"
                                data-testid="specialist-pending-switch-chip"
                                aria-label={t('Specialist switch pending')}
                              >
                                {t('Switching in this turn')}
                              </span>
                            ) : null}

                            <div className="flex-1" />

                            {/* Context-window usage for the active session (renders nothing when the
                            framework doesn't report usage). Sits with the model it pertains to. */}
                            <ComposerContextUsage
                              contextUsage={contextUsage}
                              canCompact={canCompactContext}
                              compacting={activeSession?.compacting === true}
                              compactDisabledReason={compactContextDisabledReason}
                              onCompact={onCompactContext}
                            />

                            {/* Model/provider switcher; hides itself unless more than one is configured.
                            Grouped on the right with Send, mirroring the reference composer layout. */}
                            <ComposerModelPicker
                              configuration={modelConfiguration}
                              unavailable={modelUnavailable}
                              includeAllClaudeSubscriptions={activeSession !== undefined}
                              onChange={changeModelConfiguration}
                            />

                            {rootTurnBusy ? (
                              // Running sessions expose cancel instead of send to prevent overlapping turns.
                              // Detached children can outlive a wait=false Main turn, so their durable
                              // running aggregate keeps the same root cascade reachable after Main settles.
                              // During a fix loop the main agent may be idle (the reviewer-review sub-phase runs
                              // in a separate ACP session), so fixLoopActive keeps the cancel affordance
                              // reachable across the whole loop, not just the agent-fix running turn.
                              <div
                                data-testid="composer-running-control-slot"
                                className="flex w-24 shrink-0 justify-end [@media(pointer:coarse)]:mx-3"
                              >
                                <button
                                  type="button"
                                  onClick={handleSubmit}
                                  disabled={!effectiveCanSend || submitMode !== 'queue'}
                                  className={composerIconButtonClassName}
                                  aria-label={t('Add message to queue')}
                                  data-testid="composer-queue-submit"
                                >
                                  <ArrowUp
                                    className="size-4"
                                    strokeWidth={2.2}
                                    aria-hidden="true"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={handleStop}
                                  disabled={isStopping}
                                  className={composerCancelButtonClassName}
                                  aria-label={
                                    isStopping ? t('Stopping run and subagents') : t('Cancel run')
                                  }
                                >
                                  {isStopping ? (
                                    <Loader2
                                      className="size-3.5 animate-spin"
                                      strokeWidth={2.2}
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <Square
                                      className="size-3.5"
                                      strokeWidth={2.2}
                                      aria-hidden="true"
                                    />
                                  )}
                                </button>
                                {stopError ? (
                                  <span className="sr-only" role="alert">
                                    {stopError}
                                  </span>
                                ) : null}
                                <DropdownMenu>
                                  <>
                                    <Tooltip>
                                      <TooltipTrigger
                                        asChild
                                        onFocus={(event) => {
                                          if (
                                            !(event.target instanceof Element) ||
                                            !event.target.matches(':focus-visible')
                                          ) {
                                            event.preventDefault()
                                          }
                                        }}
                                      >
                                        <span className="inline-flex">
                                          <DropdownMenuTrigger asChild>
                                            <button
                                              type="button"
                                              className={composerIconButtonClassName}
                                              disabled={
                                                !canOpenSideChat &&
                                                !canStartSideChat &&
                                                !canRetrySideChatHydration
                                              }
                                              aria-label={t('More send options')}
                                              data-testid="running-side-chat-menu-trigger"
                                            >
                                              <ChevronDown
                                                className="size-3.5"
                                                aria-hidden="true"
                                              />
                                            </button>
                                          </DropdownMenuTrigger>
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent side="top">
                                        {sideChatDisabledReason ?? t('More send options')}
                                      </TooltipContent>
                                    </Tooltip>
                                  </>
                                  <DropdownMenuContent side="top" align="end" className="w-64">
                                    {sideChatMenuItems}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            ) : (
                              <>
                                <div
                                  role="group"
                                  aria-label={t('Send message options')}
                                  className={cn(
                                    'flex rounded-md bg-primary text-primary-foreground [@media(pointer:coarse)]:mx-3',
                                    !effectiveCanSend && !canOpenSendOptions && 'opacity-50'
                                  )}
                                >
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={handleSubmit}
                                        disabled={!effectiveCanSend}
                                        className={cn(
                                          composerSplitSendPrimaryButtonClassName,
                                          canOpenSendOptions && 'disabled:opacity-50'
                                        )}
                                        aria-label={t('Send message')}
                                      >
                                        <ArrowUp
                                          className="size-4"
                                          strokeWidth={2.2}
                                          aria-hidden="true"
                                        />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">{t('Send message')}</TooltipContent>
                                  </Tooltip>
                                  <DropdownMenu>
                                    <Tooltip>
                                      {/* Same focus guard as the + trigger: a dropdown close returns
                                      programmatic focus, which must not re-open the tooltip. */}
                                      <TooltipTrigger
                                        asChild
                                        onFocus={(event) => {
                                          if (!event.currentTarget.matches(':focus-visible')) {
                                            event.preventDefault()
                                          }
                                        }}
                                      >
                                        <DropdownMenuTrigger asChild>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            disabled={!canOpenSendOptions}
                                            className={cn(
                                              composerSplitSendMenuButtonClassName,
                                              effectiveCanSend && 'disabled:opacity-50'
                                            )}
                                            aria-label={t('More send options')}
                                            aria-haspopup="menu"
                                            data-testid="branch-send-menu-trigger"
                                          >
                                            <ChevronDown
                                              className="size-3.5"
                                              strokeWidth={2.2}
                                              aria-hidden="true"
                                            />
                                          </Button>
                                        </DropdownMenuTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent side="top">
                                        {t('More send options')}
                                      </TooltipContent>
                                    </Tooltip>
                                    <DropdownMenuContent side="top" align="end" className="w-56">
                                      <DropdownMenuItem
                                        data-testid="menu-plan-first"
                                        disabled={!canPlanFirst}
                                        onSelect={handlePlanFirst}
                                        className="whitespace-nowrap [@media(pointer:coarse)]:min-h-11"
                                      >
                                        <ListChecks
                                          className="mr-2 size-4 text-text-300"
                                          aria-hidden="true"
                                        />
                                        {t('Plan first')}
                                      </DropdownMenuItem>
                                      {sideChatMenuItems}
                                      <DropdownMenuItem
                                        data-testid="menu-branch-in-new-session"
                                        disabled={
                                          !effectiveCanSend ||
                                          !onBranchInNewSession ||
                                          !canBranchInNewSession
                                        }
                                        onSelect={handleBranchInNewSession}
                                        className="whitespace-nowrap [@media(pointer:coarse)]:min-h-11"
                                      >
                                        <GitBranch
                                          className="mr-2 size-4 text-text-300"
                                          aria-hidden="true"
                                        />
                                        {t('Branch in new session')}
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </>
                            )}
                            {hasRunningSubagents && !rootTurnBusy ? (
                              <>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      onClick={handleStopSubagents}
                                      disabled={isStopping}
                                      className={composerCancelButtonClassName}
                                      aria-label={
                                        isStopping ? t('Stopping subagents') : t('Stop subagents')
                                      }
                                    >
                                      {isStopping ? (
                                        <Loader2
                                          className="size-3.5 animate-spin"
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        <Square
                                          className="size-3.5"
                                          strokeWidth={2.2}
                                          aria-hidden="true"
                                        />
                                      )}
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {isStopping ? t('Stopping subagents') : t('Stop subagents')}
                                  </TooltipContent>
                                </Tooltip>
                              </>
                            ) : null}
                            {stopError ? (
                              <span
                                className="max-w-48 whitespace-normal [overflow-wrap:anywhere] text-[11px] text-danger-000"
                                role="alert"
                                title={stopError}
                              >
                                {stopError}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </form>
                    )}
                  </TooltipProvider>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Remount on each open so editable report state resets, then stay mounted for Radix's exit. */}
        <ReportErrorDialog
          key={reportDialogEpoch}
          open={isReportOpen}
          error={resolvedRunError}
          subject={{
            agentFrameworkId: activeSession?.agentFrameworkId,
            agentBackendId: activeSession?.agentBackendId,
            model: activeSession?.agentModel
          }}
          onClose={() => setIsReportOpen(false)}
        />
        <ContextWindowDialog
          open={isContextWindowOpen}
          session={activeSession}
          contextUsage={contextUsage}
          onOpenChange={setIsContextWindowOpen}
        />
      </section>
    </ResizablePanel>
  )
}

export { ConversationPanel }

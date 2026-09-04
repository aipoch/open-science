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
  Image as ImageIcon,
  Loader2,
  Link2,
  ListChecks,
  Menu,
  MessageCircleMore,
  PanelRight,
  Plus,
  ScanEye,
  Square,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveEffectiveSpecialistSkills } from '../../../../shared/specialist'
import { isUnsupportedCodexAcpVersionError } from '../../../../shared/codex-runtime'
import {
  validateAnnotations,
  type AnnotationValidationError,
  type TextAnnotation
} from '../../../../shared/annotations'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { ErrorNotice } from '@/components/error-notice'
import { RemoteJobBadge } from '@/components/RemoteJobBadge'
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
import { useSessionJobStore } from '@/stores/session-job-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ConnectorCredentialControls } from '@/pages/settings/ConnectorCredentialDialog'

import { ComposerEditor } from './composer/ComposerEditor'
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
import { ComposerMessageQueueContent, ComposerMessageQueueTrigger } from './ComposerMessageQueue'
import { ContextWindowDialog } from './ContextWindowDialog'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerSpecialistPicker } from './ComposerSpecialistPicker'
import { ComposerYourFilesMenu } from './ComposerYourFilesMenu'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { ReadingContextPicker } from './ReadingContextPicker'
import { normalizeRunFailureError } from './error-report'
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
import { SideChatPanel } from './SideChatPanel'
import { hasMainConversation, type SideChatController } from './use-side-chat-controller'
import type { WorkspaceComposerController } from './workspace-composer-controller'
import type { WorkspaceConversationController } from './workspace-conversation-controller'
import type { WorkspaceSessionController } from './workspace-session-controller'
import { getAvatarColor } from '../settings/specialist-icons'
import { localizeImageAnnotationSourceError } from './annotations/image-annotation-source-validation'

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

const ResizablePlanComposer = ({ children }: React.PropsWithChildren): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ResizableBottomPanel
      ariaLabel={t('Resize Plan panel')}
      testId="plan-composer"
      scrollTestId="plan-composer-scroll"
      constrainGrowthToOverflow
    >
      {children}
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

type ConversationPanelWorkflows = {
  artifactFinalization: {
    running: boolean
    request: () => void
  }
  review: ConversationPanelReview
  saveAsSkill: ConversationPanelSaveAsSkill
}

type ConversationPanelSessionTools = {
  notebookReference: NotebookSessionReference | undefined
  openNotebook: (notebook: NotebookSessionReference) => void
  openJobs: (sessionId: string) => void
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

// Middle chat surface owns the visible conversation and local message composer UI.
const ConversationPanel = ({
  view,
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
  const { activeSession, composerFocusKey, canEditDraft, actionError, sideChatDisabledReason } =
    view
  const {
    view: {
      doc: draftDoc,
      annotations,
      attachments,
      transfers: attachmentTransfers,
      error: composerError,
      historyStatus,
      isHistoryBrowsing,
      isUploading: isUploadingAttachments,
      caretRequest,
      readingContext: pdfContext
    },
    actions: {
      changeDoc: onDraftDocChange,
      addAnnotation: onAddAnnotation,
      updateAnnotationNote: onUpdateAnnotationNote,
      removeAnnotation: onRemoveAnnotation,
      navigateHistory: onNavigateHistory,
      stageFiles: onStageAttachmentFiles,
      stagePastedText: onStagePastedText,
      cancelTransfer: onCancelAttachmentTransfer,
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
      branch: canBranchInNewSession
    },
    actions: {
      submit: { draft: submitDraft, restoredPlan: onRespondToRestoredPlan },
      revise: onSendEditedMessage,
      branch: onBranchFromAgentMessage,
      sideChat: { start: onStartSideChat },
      resume: onResumeSession,
      cancel: onCancelRun
    },
    queue: messageQueue,
    optimisticMessage
  } = conversation
  const {
    view: sideChat,
    send: onSendSideChat,
    retryHydration: onRetrySideChatHydration,
    setDraft: onSideChatDraftChange,
    cancel: onCancelSideChat,
    close: onCloseSideChat
  } = sideChatController

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
  const { notebookReference, openNotebook: onOpenNotebook, openJobs: onOpenJobList } = sessionTools
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

  // Unconditional hook: check if the active session has any jobs (running or finished).
  const allJobsForSession = useSessionJobStore((s) => s.allJobsForSession)
  const hasAnyJobs = activeSession !== undefined && allJobsForSession(activeSession.id).length > 0
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
  const activePendingPlanKey = activePendingPlan
    ? `${activePendingPlan.artifactVersionId}:${activePendingPlan.revision}`
    : undefined
  const [resolvedPlanKey, setResolvedPlanKey] = useState<string>()
  const pendingPlan =
    activePendingPlanKey &&
    resolvedPlanKey !== activePendingPlanKey &&
    activeSession?.status === 'waiting-plan-approval'
      ? activePendingPlan
      : undefined
  const resolvedRunError =
    localizeImageAnnotationSourceError(activeSession?.error, t) ??
    localizeVisionRunFailure(activeSession?.error, t) ??
    normalizeRunFailureError(activeSession?.error)
  const resolvedActionError =
    localizeImageAnnotationSourceError(actionError, t) ??
    localizeVisionRunFailure(actionError, t) ??
    actionError
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
            : activePendingPlanKey && resolvedPlanKey === activePendingPlanKey
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
  const ordinaryComposerBlocked = Boolean(sideChat || blockingInteraction)
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
  const handleSubmit = (): void => {
    if (!canEditDraft || !effectiveCanSend) return
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
    if (!activeSession || !pendingPlan) return
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
      response
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
  const canStartSideChat =
    Boolean(activeSession) &&
    hasMainConversation(activeSession) &&
    actionability?.actions.startSideChat.allowed !== false &&
    canEditDraft &&
    hasSideChatDraft &&
    attachments.length === 0 &&
    attachmentTransfers.length === 0 &&
    !sideChatDisabledReason
  const canRetrySideChatHydration = Boolean(onRetrySideChatHydration)

  const handlePlanFirst = (): void => {
    if (!canPlanFirst) return
    onPlanFirst(docToSkillIds(draftDoc))
  }

  const handleSideChat = (): void => {
    if (canStartSideChat) onStartSideChat()
    else onRetrySideChatHydration?.()
  }

  const handleCloseSideChat = (): void => {
    onCloseSideChat()
    setComposerRestoreFocusRequest((request) => (request ?? 0) + 1)
  }

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
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-000">
            {activeSession?.title ?? t('New conversation')}
          </h1>
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

        {activeSession?.contentLoaded === false ? (
          <SessionSwitchSkeleton />
        ) : (
          <WorkspaceMessageEditStateProvider canEditMessage={canEditMessage && !sideChat}>
            <WorkspaceMessageScroller
              activeSession={activeSession}
              credentialPending={pendingCredentialRequest !== undefined}
              visiblePermissionPending={pendingPermissions.length > 0}
              optimisticMessage={optimisticMessage}
              isResumingSession={isResuming}
              notebookReference={notebookReference}
              onSendEditedMessage={onSendEditedMessage}
              canBranchInNewSession={canBranchInNewSession}
              onBranchInNewSession={onBranchFromAgentMessage}
              pendingElicitations={sideChat ? [] : sessionPendingElicitations}
              handoffLifecycleSource={workspaceHandoffLifecycleClient}
              onRetryHandoff={(request) => workspaceHandoffLifecycleClient.retry(request)}
              reportPresentationRevealing
              annotations={annotations}
              onAddAnnotation={handleAddTranscriptAnnotation}
              onUpdateAnnotationNote={handleUpdateTranscriptAnnotation}
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
                {composerError ? (
                  <div
                    role="alert"
                    className="mb-2 [&>section]:max-w-none [&>section]:items-start [&>section]:gap-2 [&>section>svg]:hidden [&_h1]:text-xs"
                  >
                    <ErrorNotice icon={AlertTriangle} tone="red" title={composerError} />
                  </div>
                ) : null}
                {/* Interrupted sessions get a neutral banner with a Resume action instead of the
                    red error box, so the user can re-attach and continue the interrupted turn. */}
                {!sideChat && activeSession?.interrupted && !hasUnsupportedCodexAcpRunError ? (
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
                  <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-300">
                    {/* Transient action errors and a run failure can coexist; show each on its own row
                        so the run's report affordance is never suppressed by a transient error. */}
                    {resolvedActionError ? (
                      <span className="min-w-0 break-words">{resolvedActionError}</span>
                    ) : null}
                    {activeSession?.status === 'error' ? (
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 break-words">{resolvedRunError}</span>
                        {/* The button sits on the failure row beside the run's own error, so the shown
                            text and the reported text are always the same error. Shown only for an
                            unknown failure — a recognized one (app guidance or a known provider error)
                            keeps its message but is not a bug worth a GitHub issue. */}
                        {canRetryArtifactFinalization || isRunErrorReportable ? (
                          <div className="flex shrink-0 items-center gap-1">
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
                  </div>
                ) : null}

                {settingsLoaded ? (
                  <SubagentAvailabilityNotice
                    unavailable={subagentUnavailable}
                    onTurnOnDelegation={() => setAgentControlsOpenRequest((request) => request + 1)}
                    onOpenSettings={openSettings}
                  />
                ) : null}

                {!sideChat && activeSession && delegatedQuestion ? (
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
                {!sideChat && pendingPermissions.some((request) => request.delegated) ? (
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

                {/* Switching between a compact job bar and Notebook chrome remounts this layer so a
                    Notebook that becomes available after jobs still receives its entrance animation. */}
                {notebookReference ||
                messageQueue.items.length > 0 ||
                hasAnyJobs ||
                hasSubagents ||
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
                      notebookReference || messageQueue.items.length > 0
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
                    {hasAnyJobs && activeSession ? (
                      <RemoteJobBadge
                        sessionId={activeSession.id}
                        onOpenJobList={
                          onOpenJobList ? () => onOpenJobList(activeSession.id) : undefined
                        }
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
                      (sideChat ||
                        hasPendingPermission ||
                        pendingElicitation ||
                        specialistUnavailable) &&
                        'hidden'
                    )}
                  />

                  {!sideChat && activeSession && specialistUnavailable ? (
                    <div
                      role="status"
                      aria-live="polite"
                      data-testid="specialist-unavailable-notice"
                      className="relative z-10 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-warning-100/50 bg-warning-100/10 px-3 py-2"
                    >
                      <AlertTriangle
                        className="mt-0.5 size-3.5 shrink-0 text-warning-900"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium leading-5 text-warning-900">
                          {t('This Specialist is no longer available')}
                        </div>
                        <div className="text-[11px] leading-4 text-text-100">
                          {t('Choose another Specialist before sending a message.')}{' '}
                          {t('Your draft is preserved.')}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="ml-auto border-warning-100/50 bg-transparent text-warning-900 hover:bg-warning-100/20 hover:text-warning-900"
                        onClick={() => setAgentControlsOpenRequest((request) => request + 1)}
                      >
                        {t('Choose Specialist')}
                      </Button>
                    </div>
                  ) : null}

                  {/* Reconfigure failure banner: shown directly above the composer when a pre-send
                      specialist reconfigure failed. Draft is preserved; three recovery actions. */}
                  {!sideChat && reconfigureError ? (
                    <div
                      className="relative z-10 mb-2 flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.08] px-3 py-2.5"
                      role="alert"
                      data-testid="reconfigure-error-banner"
                    >
                      <AlertTriangle
                        className="mt-0.5 size-3.5 shrink-0 text-red-400"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium leading-5 text-red-300">
                          {reconfigureError.committed
                            ? t('Specialist switch is pending for {{name}}', {
                                name: reconfigureError.specialistName
                              })
                            : t('Could not switch to {{name}}', {
                                name: reconfigureError.specialistName
                              })}
                        </div>
                        <div className="text-[11px] leading-4 text-red-400/80">
                          {reconfigureError.committed
                            ? t(
                                'The selection is saved, but the Agent runtime has not applied it yet. Your draft and queued messages are preserved.'
                              )
                            : t(
                                'The agent session could not be reconfigured. Your draft has been preserved.'
                              )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={onReconfigureRetry}
                            className="flex h-6 items-center rounded px-2 text-[11px] font-medium text-red-300 hover:bg-red-500/15 border border-red-500/30"
                          >
                            {t('Retry')}
                          </button>
                          <button
                            type="button"
                            onClick={onReconfigureChooseOther}
                            className="flex h-6 items-center rounded px-2 text-[11px] text-red-400/80 hover:bg-red-500/10 border border-red-500/20"
                          >
                            {t('Choose another specialist')}
                          </button>
                          <button
                            type="button"
                            onClick={onReconfigureUseNone}
                            className="flex h-6 items-center rounded px-2 text-[11px] text-red-400/80 hover:bg-red-500/10 border border-red-500/20"
                          >
                            {t('Use None (Main Agent)')}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {ordinaryComposerBlocked ? (
                    <div
                      data-testid="blocking-composer-overlay"
                      className="absolute inset-x-0 bottom-0 z-30"
                    >
                      {sideChat ? (
                        <SideChatPanel
                          view={sideChat}
                          onSend={onSendSideChat}
                          onDraftChange={onSideChatDraftChange}
                          onCancel={onCancelSideChat}
                          onClose={handleCloseSideChat}
                          controls={
                            <ComposerAgentControlsMenu
                              profile={permissionProfile}
                              profileState={permissionProfileState}
                              grants={permissionGrants}
                              autoReviewEnabled={autoReviewEnabled}
                              memoryEnabled={memoryEnabled}
                              delegationEnabled={delegationEnabled}
                              delegationPending={delegationPending}
                              delegationHasLiveAttempts={delegationHasLiveAttempts}
                              delegationReadOnly={!canChangeDelegation}
                              delegationDisabledReason={delegationDisabledReason}
                              memoryDisabledReason={memoryDisabledReason}
                              readOnly
                              permissionProfileReadOnly
                              grantActionsReadOnly
                              autoReviewDisabled
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
                              showSpecialist={activeSession !== undefined}
                              specialistId={specialistId}
                              specialistUnavailable={specialistUnavailable}
                              specialistReadOnly
                              onSpecialistChange={onSpecialistChange}
                            />
                          }
                        />
                      ) : hasPendingPermission ? (
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
                          <WorkspacePlanCard
                            embedded
                            projection={pendingPlan}
                            onOpen={openPendingPlan}
                            onRespond={(decision) => respondToPendingPlan({ decision })}
                            onSubmitResponse={(text) => respondToPendingPlan({ feedback: text })}
                            onResolved={() => setResolvedPlanKey(activePendingPlanKey)}
                          />
                        </ResizablePlanComposer>
                      ) : null}
                    </div>
                  ) : null}

                  {/* The ordinary composer keeps this lane's geometry while a blocking interaction
                      overlays it, so panel entry/resize/exit never resizes the transcript viewport. */}
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
                  >
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
                      <FileDropOverlay label={t('Drop files to attach')} className="rounded-2xl" />
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
                          <TooltipProvider delayDuration={300}>
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
                        <TooltipProvider delayDuration={800}>
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
                            <TooltipContent side="top">{t('Keep as attachments')}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    ) : null}
                    <ComposerMessageQueueContent
                      {...messageQueue}
                      expanded={messageQueueExpanded}
                    />
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
                    <div className="flex flex-col gap-2">
                      {attachments.length > 0 || attachmentTransfers.length > 0 ? (
                        <div className="flex max-h-[92px] flex-wrap gap-2 overflow-y-auto border-b border-border-200 pb-2">
                          {/* Composer attachments remain removable until the prompt is submitted. */}
                          {attachments.map((attachment) => {
                            const AttachmentIcon = attachment.mimeType?.startsWith('image/')
                              ? ImageIcon
                              : FileText
                            const attachmentName = attachment.originalName || attachment.name
                            const pastedText = pastedTextByAttachmentId.get(attachment.id)

                            return (
                              <div
                                key={attachment.id}
                                id={
                                  pastedText ? pastedTextAttachmentDomId(pastedText.id) : undefined
                                }
                                data-pasted-text-attachment={pastedText ? 'true' : undefined}
                                data-state={pastedText ? 'success' : undefined}
                                className={attachmentChipClassName}
                              >
                                <AttachmentIcon
                                  className="size-4 shrink-0 text-text-300"
                                  strokeWidth={2}
                                  aria-hidden="true"
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
                                  <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
                                </button>
                              </div>
                            )
                          })}
                          {attachmentTransfers.map((transfer) => {
                            const AttachmentIcon = transfer.mimeType?.startsWith('image/')
                              ? ImageIcon
                              : FileText
                            const percent =
                              transfer.totalBytes === 0
                                ? 100
                                : Math.min(
                                    100,
                                    Math.round((transfer.receivedBytes / transfer.totalBytes) * 100)
                                  )
                            const statusLabel =
                              transfer.status === 'queued'
                                ? t('Queued')
                                : transfer.status === 'cancelling'
                                  ? t('Cancelling…')
                                  : transfer.status === 'error'
                                    ? transfer.error || t('Upload failed')
                                    : `${percent}% of ${formatAttachmentSize(transfer.totalBytes)}`
                            const pastedText = transfer.pastedTextId
                              ? pastedTextById.get(transfer.pastedTextId)
                              : undefined

                            return (
                              <div
                                key={transfer.transferId}
                                id={
                                  pastedText ? pastedTextAttachmentDomId(pastedText.id) : undefined
                                }
                                data-pasted-text-attachment={pastedText ? 'true' : undefined}
                                data-state={pastedText ? transfer.status : undefined}
                                className={attachmentChipClassName}
                              >
                                <AttachmentIcon
                                  className="size-4 shrink-0 text-text-300"
                                  strokeWidth={2}
                                  aria-hidden="true"
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
                                      transfer.status === 'error' ? 'text-red-600' : 'text-text-300'
                                    }`}
                                    title={statusLabel}
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
                                  <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
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
                          isHistoryBrowsing={isHistoryBrowsing}
                          historyStatus={historyStatus}
                          onNavigateHistory={onNavigateHistory}
                          mentionPreviewContext={
                            activeSession
                              ? { sessionId: activeSession.id, projectId: activeSession.projectId }
                              : undefined
                          }
                          focusRequest={ordinaryComposerBlocked ? undefined : composerFocusKey}
                          restoreFocusRequest={
                            ordinaryComposerBlocked ? undefined : composerRestoreFocusRequest
                          }
                          caretRequest={ordinaryComposerBlocked ? undefined : caretRequest}
                        />
                      </div>

                      <div className="@container/composer flex items-center gap-1">
                        {/* The + button opens a dropdown for attachments and session actions. */}
                        <DropdownMenu>
                          <TooltipProvider delayDuration={200}>
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
                                    <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
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
                          </TooltipProvider>
                          <DropdownMenuContent side="top" align="start" className="w-56">
                            <TooltipProvider delayDuration={200}>
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
                            </TooltipProvider>
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
                            <TooltipProvider delayDuration={200}>
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
                                      {isSavingAsSkill ? t('Saving as skill…') : t('Save as skill')}
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
                            </TooltipProvider>
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
                              <ArrowUp className="size-4" strokeWidth={2.2} aria-hidden="true" />
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
                                <Square className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
                              )}
                            </button>
                            {stopError ? (
                              <span className="sr-only" role="alert">
                                {stopError}
                              </span>
                            ) : null}
                            <DropdownMenu>
                              <TooltipProvider delayDuration={200}>
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
                                          disabled={!canStartSideChat && !canRetrySideChatHydration}
                                          aria-label={t('More send options')}
                                          data-testid="running-side-chat-menu-trigger"
                                        >
                                          <ChevronDown className="size-3.5" aria-hidden="true" />
                                        </button>
                                      </DropdownMenuTrigger>
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">
                                    {sideChatDisabledReason ?? t('More send options')}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              <DropdownMenuContent side="top" align="end" className="w-64">
                                <DropdownMenuItem
                                  data-testid="menu-side-chat"
                                  disabled={!canStartSideChat && !canRetrySideChatHydration}
                                  onSelect={handleSideChat}
                                  title={sideChatDisabledReason}
                                >
                                  <MessageCircleMore
                                    className="mr-2 size-4 text-text-300"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    {canRetrySideChatHydration
                                      ? t('Retry Side chat restore')
                                      : t('Side chat')}
                                    {sideChatDisabledReason ? (
                                      <span className="block text-[11px] text-text-300">
                                        {sideChatDisabledReason}
                                      </span>
                                    ) : null}
                                  </span>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        ) : (
                          <TooltipProvider delayDuration={200}>
                            <div
                              role="group"
                              aria-label={t('Send message options')}
                              className={cn(
                                'flex rounded-md bg-primary text-primary-foreground [@media(pointer:coarse)]:mx-3',
                                !effectiveCanSend && 'opacity-50'
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
                                    className={composerSplitSendPrimaryButtonClassName}
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
                                        disabled={
                                          !canPlanFirst &&
                                          !canStartSideChat &&
                                          !canRetrySideChatHydration &&
                                          (!effectiveCanSend ||
                                            !onBranchInNewSession ||
                                            !canBranchInNewSession)
                                        }
                                        className={composerSplitSendMenuButtonClassName}
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
                                  <DropdownMenuItem
                                    data-testid="menu-side-chat"
                                    disabled={!canStartSideChat && !canRetrySideChatHydration}
                                    onSelect={handleSideChat}
                                    title={sideChatDisabledReason}
                                    className="whitespace-nowrap [@media(pointer:coarse)]:min-h-11"
                                  >
                                    <MessageCircleMore
                                      className="mr-2 size-4 text-text-300"
                                      aria-hidden="true"
                                    />
                                    <span>
                                      {canRetrySideChatHydration
                                        ? t('Retry Side chat restore')
                                        : t('Side chat')}
                                      {sideChatDisabledReason ? (
                                        <span className="block text-[11px] text-text-300">
                                          {sideChatDisabledReason}
                                        </span>
                                      ) : null}
                                    </span>
                                  </DropdownMenuItem>
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
                          </TooltipProvider>
                        )}
                        {hasRunningSubagents && !rootTurnBusy ? (
                          <TooltipProvider delayDuration={200}>
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
                                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
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
                          </TooltipProvider>
                        ) : null}
                        {stopError ? (
                          <span
                            className="max-w-48 truncate text-[11px] text-danger-000"
                            role="alert"
                            title={stopError}
                          >
                            {stopError}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </form>
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

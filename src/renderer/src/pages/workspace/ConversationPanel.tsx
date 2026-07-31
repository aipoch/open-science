import type {
  AcpPermissionGrant,
  AcpPermissionRequest,
  AcpContextUsage
} from '../../../../shared/acp'
import type { NotebookSessionReference } from '../../../../shared/notebook'
import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import {
  MAX_UPLOAD_FILE_BYTES,
  formatUploadSizeLimit,
  type UploadedAttachment
} from '../../../../shared/uploads'
import { isReportableRunFailure } from '../../../../shared/run-error-classification'
import {
  AlertTriangle,
  ArrowUp,
  BookOpen,
  FileText,
  Flag,
  Image as ImageIcon,
  Loader2,
  Plus,
  ScanEye,
  Square,
  X
} from 'lucide-react'
import { useRef, useState } from 'react'
import { resolveEffectiveSpecialistSkills } from '../../../../shared/specialist'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { RemoteJobBadge } from '@/components/RemoteJobBadge'
import { ResizablePanel } from '@/components/ui/resizable'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { cn } from '@/lib/utils'
import type { ChatSession } from '@/stores/session-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'

import { ComposerEditor } from './composer/ComposerEditor'
import type { ComposerUploadTransfer } from './composer-upload-transfer'
import { docToSkillIds, type ComposerDoc } from './composer/composer-doc'
import { ComposerAgentControlsMenu } from './ComposerAgentControlsMenu'
import { ComposerContextUsage } from './ComposerContextUsage'
import { ComposerModelPicker } from './ComposerModelPicker'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { normalizeRunFailureError } from './error-report'
import { ReportErrorDialog } from './ReportErrorDialog'
import { SessionInterruptedBanner } from './SessionInterruptedBanner'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { WorkspaceMessageScroller } from './WorkspaceMessageScroller'

const composerInteractiveTransitionClassName = 'transition-colors duration-200 ease-out'

const composerIconButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50',
  composerInteractiveTransitionClassName
)

const composerSendButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary',
  composerInteractiveTransitionClassName
)

const composerCancelButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-200 text-text-000 hover:bg-bg-300',
  composerInteractiveTransitionClassName
)
const composerContentClassName = 'mx-auto w-full max-w-4xl'
const attachmentChipClassName =
  'flex h-9 min-w-0 max-w-[220px] items-center gap-2 rounded-lg border border-border-200 bg-bg-200 px-2 text-text-000'
const attachmentRemoveButtonClassName = cn(
  'flex size-6 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-300 hover:text-text-000 disabled:cursor-not-allowed disabled:opacity-50',
  composerInteractiveTransitionClassName
)

// Formats the compact size label shown under each composer attachment chip.
const formatAttachmentSize = (size: number): string => {
  if (size < 1024) return `${size} B`

  const kilobytes = size / 1024

  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`

  const megabytes = kilobytes / 1024
  if (megabytes < 1024) return `${Math.round(megabytes)} MB`

  return `${(megabytes / 1024).toFixed(1)} GB`
}

type ConversationPanelProps = {
  activeSession: ChatSession | undefined
  draftDoc: ComposerDoc
  canSendMessage: boolean
  canEditDraft: boolean
  canResumeSession: boolean
  actionError: string | null
  attachments: UploadedAttachment[]
  attachmentTransfers: ComposerUploadTransfer[]
  isUploadingAttachments: boolean
  notebookReference: NotebookSessionReference | undefined
  pendingPermissions: AcpPermissionRequest[]
  permissionProfile: PermissionProfileId
  permissionProfileState: SessionPermissionProfileState | undefined
  permissionGrants: AcpPermissionGrant[]
  // Latest context-window usage for the active session (undefined when the framework never reported it).
  contextUsage: AcpContextUsage | undefined
  canCompactContext?: boolean
  compactContextDisabledReason?: string
  onCompactContext?: () => void
  canChangePermissionProfile: boolean
  // Auto-review toggle: whether the current session has auto-review enabled (default false).
  autoReviewEnabled: boolean
  onDraftDocChange: (doc: ComposerDoc) => void
  onSendMessage: (forcedSkillIds: string[]) => void
  onStageAttachmentFiles: (files: File[]) => void
  onRemoveAttachment: (attachment: UploadedAttachment) => void
  onCancelAttachmentTransfer: (transfer: ComposerUploadTransfer) => void
  onCancelRun: () => void
  onResumeSession: () => Promise<void>
  onOpenNotebook: (notebook: NotebookSessionReference) => void
  onRespondToPermission: (requestId: string, optionId?: string) => Promise<void>
  onPermissionProfileChange: (profile: PermissionProfileId) => void
  onRevokePermissionGrant: (categoryKey: string) => void
  onClearPermissionGrants: () => void
  onAutoReviewToggle: (enabled: boolean) => void
  // Enabled compute hosts for this session (providerIds); toggling is single-select.
  enabledComputeHosts: string[]
  onComputeHostToggle: (providerId: string, enabled: boolean) => void
  // Manual review: invoked by the "Request review" + menu item.
  onRequestReview: () => void
  // True when "Request review" should be disabled: no completed turn, already reviewed, or currently reviewing.
  isRequestReviewDisabled: boolean
  // Inline editing of a sent prompt is only allowed once the run settles; confirming truncates the
  // conversation at that message and resends the adjusted doc.
  canEditMessage: boolean
  onSendEditedMessage: (messageId: string, doc: ComposerDoc) => void
  // Open job list modal for a specific session.
  onOpenJobList?: (sessionId: string) => void
  // Specialist picker. For new conversations: undefined = None. For existing sessions: always shown.
  specialistId?: string
  specialistUnavailable?: boolean
  // True when the user has selected a different specialist while the current turn is still running.
  specialistHasPendingSwitch?: boolean
  onSpecialistChange?: (specialistId: string | undefined) => void
  // Reconfigure failure recovery callbacks.
  reconfigureError?: { sessionId: string; specialistName: string; message: string } | null
  onReconfigureRetry?: () => void
  onReconfigureChooseOther?: () => void
  onReconfigureUseNone?: () => void
}

// Middle chat surface owns the visible conversation and local message composer UI.
const ConversationPanel = ({
  activeSession,
  draftDoc,
  canSendMessage,
  canEditDraft,
  canResumeSession,
  actionError,
  attachments,
  attachmentTransfers,
  isUploadingAttachments,
  notebookReference,
  pendingPermissions,
  permissionProfile,
  permissionProfileState,
  permissionGrants,
  contextUsage,
  canCompactContext = false,
  compactContextDisabledReason,
  onCompactContext,
  canChangePermissionProfile,
  autoReviewEnabled,
  onDraftDocChange,
  onSendMessage,
  onStageAttachmentFiles,
  onRemoveAttachment,
  onCancelAttachmentTransfer,
  onCancelRun,
  onResumeSession,
  onOpenNotebook,
  onRespondToPermission,
  onPermissionProfileChange,
  onRevokePermissionGrant,
  onClearPermissionGrants,
  onAutoReviewToggle,
  enabledComputeHosts,
  onComputeHostToggle,
  onRequestReview,
  isRequestReviewDisabled,
  canEditMessage,
  onSendEditedMessage,
  onOpenJobList,
  specialistId,
  specialistUnavailable = false,
  specialistHasPendingSwitch = false,
  onSpecialistChange,
  reconfigureError,
  onReconfigureRetry,
  onReconfigureChooseOther,
  onReconfigureUseNone
}: ConversationPanelProps): React.JSX.Element => {
  const specialistItems = useSpecialistStore((state) => state.items)
  const catalogSkills = useSettingsStore((state) => state.skills)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Local so the interrupted banner can show a spinner and block a double-resume until the request settles.
  const [isResuming, setIsResuming] = useState(false)
  // Opens the reviewable, consent-gated error report dialog for a failed run.
  const [isReportOpen, setIsReportOpen] = useState(false)
  const [reportDialogEpoch, setReportDialogEpoch] = useState(0)

  const openReportDialog = (): void => {
    setReportDialogEpoch((epoch) => epoch + 1)
    setIsReportOpen(true)
  }

  // Unconditional hook: check if the active session has any jobs (running or finished).
  const allJobsForSession = useSessionJobStore((s) => s.allJobsForSession)
  const hasAnyJobs = activeSession !== undefined && allJobsForSession(activeSession.id).length > 0
  const resolvedRunError = normalizeRunFailureError(activeSession?.error)
  // Only unknown/opaque ACP-layer failures offer the "Report error → GitHub issue" affordance. The
  // reportability is resolved at failure time and persisted on the session: a model-provider error is
  // tagged non-reportable at the ACP layer, and an app-crafted reminder is recognized by its own text.
  // Fall back to classifying the raw error for sessions persisted before the flag existed (undefined).
  const isRunErrorReportable =
    activeSession?.errorReportable ?? isReportableRunFailure(activeSession?.error)

  const activeSpecialist = specialistId
    ? specialistItems.find((item) => item.kind === 'custom' && item.id === specialistId)
    : undefined
  const effectiveSpecialistSkills = resolveEffectiveSpecialistSkills(
    activeSpecialist?.kind === 'custom' ? activeSpecialist : undefined,
    catalogSkills.map((skill) => ({
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

  // Re-attaches the interrupted session; on success the banner unmounts, so guard the state update.
  const handleResume = async (): Promise<void> => {
    if (!canResumeSession || isResuming) return

    setIsResuming(true)
    try {
      await onResumeSession()
    } finally {
      setIsResuming(false)
    }
  }

  // Drag-and-drop shares the same staging callback as the picker and paste paths.
  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: canEditDraft && !isUploadingAttachments,
    onFiles: onStageAttachmentFiles
  })

  // Submits the current doc, passing the ids of any skills picked as inline chips.
  const handleSubmit = (): void => {
    if (!canEditDraft) return
    onSendMessage(docToSkillIds(draftDoc))
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

  return (
    <ResizablePanel id="main-content" defaultSize="60%" minSize="30%">
      <section
        className="flex h-full min-w-0 flex-col overflow-hidden bg-bg-10 p-2 pl-4"
        data-session-id={activeSession?.id ?? ''}
        data-agent-running={activeSession?.status === 'running' ? 'true' : 'false'}
      >
        <header
          data-testid="conversation-header"
          className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-2"
        >
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-000">
            {activeSession?.title ?? 'New conversation'}
          </h1>
        </header>

        <WorkspaceMessageScroller
          activeSession={activeSession}
          canEditMessage={canEditMessage}
          onSendEditedMessage={onSendEditedMessage}
        />

        <div className="relative shrink-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-bg-10 to-bg-10/0"
          />

          <div className="px-4 pb-2">
            {/* Runtime and session errors stay near the composer so recovery is visible. */}
            <div className={composerContentClassName}>
              <div className="px-1 md:px-3">
                {/* Interrupted sessions get a neutral banner with a Resume action instead of the
                    red error box, so the user can re-attach the runtime and keep chatting. */}
                {activeSession?.interrupted ? (
                  <SessionInterruptedBanner
                    message={activeSession.error ?? 'This session was interrupted.'}
                    isDisabled={!canResumeSession}
                    isResuming={isResuming}
                    onResume={() => void handleResume()}
                  />
                ) : activeSession?.compacting ? (
                  // Auto-recovery after a request-size overflow: a neutral note, not the red error box,
                  // while the agent context is reset and the conversation is replayed as text.
                  <div className="mb-2 flex items-center gap-2 rounded-lg border border-border-200 bg-bg-200 px-3 py-2 text-[12px] leading-5 text-text-300">
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
                    Compacting conversation to fit the context limit…
                  </div>
                ) : actionError || activeSession?.status === 'error' ? (
                  <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-800/50 dark:bg-red-950/20 dark:text-red-300">
                    {/* Transient action errors and a run failure can coexist; show each on its own row
                        so the run's report affordance is never suppressed by a transient error. */}
                    {actionError ? (
                      <span className="min-w-0 break-words">{actionError}</span>
                    ) : null}
                    {activeSession?.status === 'error' ? (
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 break-words">{resolvedRunError}</span>
                        {/* The button sits on the failure row beside the run's own error, so the shown
                            text and the reported text are always the same error. Shown only for an
                            unknown failure — a recognized one (app guidance or a known provider error)
                            keeps its message but is not a bug worth a GitHub issue. */}
                        {isRunErrorReportable ? (
                          <button
                            type="button"
                            onClick={openReportDialog}
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-red-200 bg-red-100/60 px-2 font-medium text-red-700 hover:bg-red-100 dark:border-red-800/50 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/40"
                            aria-label="Report this error"
                          >
                            <Flag className="size-3" strokeWidth={2.2} aria-hidden="true" />
                            Report error
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Permission controls are already filtered to the visible session by the page. */}
                <PermissionApprovalControls
                  requests={pendingPermissions}
                  onRespond={onRespondToPermission}
                  notebookLookup={
                    activeSession
                      ? {
                          sessionId: activeSession.id,
                          workspaceCwd: activeSession.cwd ?? '',
                          projectName: activeSession.projectId
                        }
                      : undefined
                  }
                />

                {/* Switching between a compact job bar and Notebook chrome remounts this layer so a
                    Notebook that becomes available after jobs still receives its entrance animation. */}
                {notebookReference || hasAnyJobs ? (
                  <div
                    key={notebookReference ? `notebook-${notebookReference.sessionId}` : 'jobs'}
                    className={cn(
                      'flex px-2',
                      notebookReference
                        ? 'relative -mb-8 min-h-[68px] items-start rounded-2xl bg-bg-200 pt-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-out'
                        : 'mb-2 min-h-9 items-center rounded-lg border border-border-200 bg-bg-000 shadow-card'
                    )}
                  >
                    {notebookReference ? (
                      <button
                        type="button"
                        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-normal text-text-100 transition-colors duration-200 ease-out hover:bg-bg-300 hover:text-text-000"
                        aria-label="Open notebook"
                        aria-controls="right-panel"
                        onClick={() => onOpenNotebook(notebookReference)}
                      >
                        <BookOpen className="size-3.5" strokeWidth={2} aria-hidden="true" />
                        Notebook
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
                  </div>
                ) : null}

                <div className="relative">
                  <div aria-hidden="true" className="relative -mb-8 rounded-2xl bg-bg-200 pb-8" />

                  {/* Reconfigure failure banner: shown directly above the composer when a pre-send
                      specialist reconfigure failed. Draft is preserved; three recovery actions. */}
                  {reconfigureError ? (
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
                          Could not switch to {reconfigureError.specialistName}
                        </div>
                        <div className="text-[11px] leading-4 text-red-400/80">
                          The agent session could not be reconfigured. Your draft has been
                          preserved.
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={onReconfigureRetry}
                            className="flex h-6 items-center rounded px-2 text-[11px] font-medium text-red-300 hover:bg-red-500/15 border border-red-500/30"
                          >
                            Retry
                          </button>
                          <button
                            type="button"
                            onClick={onReconfigureChooseOther}
                            className="flex h-6 items-center rounded px-2 text-[11px] text-red-400/80 hover:bg-red-500/10 border border-red-500/20"
                          >
                            Choose another specialist
                          </button>
                          <button
                            type="button"
                            onClick={onReconfigureUseNone}
                            className="flex h-6 items-center rounded px-2 text-[11px] text-red-400/80 hover:bg-red-500/10 border border-red-500/20"
                          >
                            Use None (Main Agent)
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* Composer keeps draft input local until submit delegates to the session store.
                      Enter-to-send is owned by ComposerEditor; the form only guards native submit. */}
                  <form
                    className="relative z-10 flex flex-col gap-2 rounded-2xl border border-border-200 bg-bg-000 px-3 py-2"
                    onSubmit={(event) => event.preventDefault()}
                    {...dropZoneProps}
                  >
                    {/* File-drag overlay is scoped to the composer input card only. */}
                    {isDragging ? (
                      <FileDropOverlay label="Drop files to attach" className="rounded-2xl" />
                    ) : null}
                    <div className="flex flex-col gap-2">
                      {attachments.length > 0 || attachmentTransfers.length > 0 ? (
                        <div className="flex max-h-[92px] flex-wrap gap-2 overflow-y-auto border-b border-border-200 pb-2">
                          {/* Composer attachments remain removable until the prompt is submitted. */}
                          {attachments.map((attachment) => {
                            const AttachmentIcon = attachment.mimeType?.startsWith('image/')
                              ? ImageIcon
                              : FileText
                            const attachmentName = attachment.originalName || attachment.name

                            return (
                              <div key={attachment.id} className={attachmentChipClassName}>
                                <AttachmentIcon
                                  className="size-4 shrink-0 text-text-300"
                                  strokeWidth={2}
                                  aria-hidden="true"
                                />
                                <div className="min-w-0 flex-1">
                                  <ExtensionPreservingFileName
                                    name={attachmentName}
                                    className="text-[12px] leading-4"
                                  />
                                  <div className="truncate text-[11px] leading-3 text-text-300">
                                    {formatAttachmentSize(attachment.size)}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className={attachmentRemoveButtonClassName}
                                  disabled={!canEditDraft}
                                  aria-label={`Remove attachment ${attachmentName}`}
                                  onClick={() => onRemoveAttachment(attachment)}
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
                                ? 'Queued'
                                : transfer.status === 'cancelling'
                                  ? 'Cancelling…'
                                  : transfer.status === 'error'
                                    ? transfer.error || 'Upload failed'
                                    : `${percent}% of ${formatAttachmentSize(transfer.totalBytes)}`

                            return (
                              <div
                                key={transfer.transferId}
                                className={`${attachmentChipClassName} h-11`}
                              >
                                <AttachmentIcon
                                  className="size-4 shrink-0 text-text-300"
                                  strokeWidth={2}
                                  aria-hidden="true"
                                />
                                <div className="min-w-0 flex-1">
                                  <ExtensionPreservingFileName
                                    name={transfer.name}
                                    className="text-[12px] leading-4"
                                  />
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
                                      aria-label={`Uploading ${transfer.name}`}
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
                                  aria-label={`${
                                    transfer.status === 'error' ? 'Remove failed' : 'Cancel'
                                  } attachment ${transfer.name}`}
                                  onClick={() => onCancelAttachmentTransfer(transfer)}
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
                          onDocChange={onDraftDocChange}
                          onSubmit={handleSubmit}
                          onPaste={handleMessageDraftPaste}
                          disabled={!canEditDraft}
                          placeholder="Ask anything — / for skills, @ for files"
                          ariaLabel="Ask anything"
                          allowedSkillIds={allowedSkillIds}
                        />
                      </div>

                      <div className="@container/composer flex items-center gap-1">
                        {/* The + button opens a dropdown for Attach files and Request review actions. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              disabled={!canEditDraft || isUploadingAttachments}
                              className={composerIconButtonClassName}
                              aria-label="Add attachment or request review"
                              data-testid="composer-plus-trigger"
                            >
                              <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="top" align="start" className="w-64">
                            <DropdownMenuItem
                              data-testid="menu-attach-files"
                              onSelect={() => fileInputRef.current?.click()}
                            >
                              <FileText className="mr-2 size-4 text-text-300" aria-hidden="true" />
                              Attach files
                            </DropdownMenuItem>
                            <div
                              className="px-2 py-1.5 text-[11px] leading-4 text-text-300"
                              data-testid="attachment-limits"
                            >
                              Any file type · {formatUploadSizeLimit(MAX_UPLOAD_FILE_BYTES)} per
                              file. Large files are linked, not embedded.
                            </div>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              data-testid="menu-request-review"
                              disabled={isRequestReviewDisabled}
                              onSelect={() => {
                                if (!isRequestReviewDisabled) onRequestReview()
                              }}
                            >
                              <ScanEye className="mr-2 size-4 text-text-300" aria-hidden="true" />
                              Request review
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
                          readOnly={!canChangePermissionProfile}
                          grantActionsReadOnly={false}
                          autoReviewDisabled={!canEditDraft}
                          enabledComputeHosts={enabledComputeHosts}
                          onComputeHostToggle={onComputeHostToggle}
                          onProfileChange={onPermissionProfileChange}
                          onAutoReviewChange={onAutoReviewToggle}
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
                          onSpecialistChange={onSpecialistChange}
                        />

                        {/* Pending-switch chip: appears to the right of the specialist badge when
                            the user picked a different specialist during a running turn. The badge
                            still shows the currently-effective specialist; this chip signals the
                            next message will use the newly selected one. */}
                        {specialistHasPendingSwitch ? (
                          <span
                            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-blue-500/25 bg-blue-500/10 px-2 py-0.5 text-[11px] italic text-blue-400"
                            data-testid="specialist-pending-switch-chip"
                            aria-label="Specialist switch pending"
                          >
                            Switches after this response
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
                        <ComposerModelPicker />

                        {activeSession?.status === 'running' ||
                        activeSession?.status === 'waiting-permission' ||
                        activeSession?.compacting ||
                        activeSession?.fixLoopActive ? (
                          // Running sessions expose cancel instead of send to prevent overlapping turns.
                          // During a fix loop the main agent may be idle (the reviewer-review sub-phase runs
                          // in a separate ACP session), so fixLoopActive keeps the cancel affordance
                          // reachable across the whole loop, not just the agent-fix running turn.
                          <button
                            type="button"
                            onClick={onCancelRun}
                            className={composerCancelButtonClassName}
                            aria-label="Cancel run"
                          >
                            <Square className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={!canSendMessage}
                            className={composerSendButtonClassName}
                            aria-label="Send message"
                          >
                            <ArrowUp className="size-4" strokeWidth={2.2} aria-hidden="true" />
                          </button>
                        )}
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
      </section>
    </ResizablePanel>
  )
}

export { ConversationPanel }

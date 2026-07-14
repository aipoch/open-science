import type { AcpPermissionGrant, AcpPermissionRequest } from '../../../../shared/acp'
import type { NotebookSessionReference } from '../../../../shared/notebook'
import type {
  PermissionProfileId,
  SessionPermissionProfileState
} from '../../../../shared/permission-profiles'
import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  ArrowUp,
  BookOpen,
  FileText,
  Image as ImageIcon,
  PanelRight,
  Plus,
  Square,
  X
} from 'lucide-react'
import { useRef } from 'react'

import { FileDropOverlay } from '@/components/FileDropOverlay'
import { ResizablePanel } from '@/components/ui/resizable'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { cn } from '@/lib/utils'
import type { ChatSession } from '@/stores/session-store'

import { ComposerEditor } from './composer/ComposerEditor'
import { docToSkillIds, type ComposerDoc } from './composer/composer-doc'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerPermissionProfilePicker } from './ComposerPermissionProfilePicker'
import { PermissionApprovalControls } from './PermissionApprovalControls'
import { WorkspaceMessageScroller } from './WorkspaceMessageScroller'

const composerInteractiveTransitionClassName = 'transition-colors duration-200 ease-out'

const composerIconButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50',
  composerInteractiveTransitionClassName
)

const composerSendButtonClassName = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary',
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

  return `${Math.round(kilobytes / 1024)} MB`
}

type ConversationPanelProps = {
  activeSession: ChatSession | undefined
  draftDoc: ComposerDoc
  canSendMessage: boolean
  canEditDraft: boolean
  actionError: string | null
  isPreviewPanelCollapsed: boolean
  attachments: UploadedAttachment[]
  isUploadingAttachments: boolean
  notebookReference: NotebookSessionReference | undefined
  pendingPermissions: AcpPermissionRequest[]
  permissionProfile: PermissionProfileId
  permissionProfileState: SessionPermissionProfileState | undefined
  permissionGrants: AcpPermissionGrant[]
  canChangePermissionProfile: boolean
  onDraftDocChange: (doc: ComposerDoc) => void
  onSendMessage: (forcedSkillIds: string[]) => void
  onStageAttachmentFiles: (files: File[]) => void
  onRemoveAttachment: (attachment: UploadedAttachment) => void
  onCancelRun: () => void
  onOpenNotebook: (notebook: NotebookSessionReference) => void
  onTogglePreviewPanel: () => void
  onRespondToPermission: (requestId: string, optionId?: string) => void
  onPermissionProfileChange: (profile: PermissionProfileId) => void
  onRevokePermissionGrant: (categoryKey: string) => void
  onClearPermissionGrants: () => void
}

// Middle chat surface owns the visible conversation and local message composer UI.
const ConversationPanel = ({
  activeSession,
  draftDoc,
  canSendMessage,
  canEditDraft,
  actionError,
  isPreviewPanelCollapsed,
  attachments,
  isUploadingAttachments,
  notebookReference,
  pendingPermissions,
  permissionProfile,
  permissionProfileState,
  permissionGrants,
  canChangePermissionProfile,
  onDraftDocChange,
  onSendMessage,
  onStageAttachmentFiles,
  onRemoveAttachment,
  onCancelRun,
  onOpenNotebook,
  onTogglePreviewPanel,
  onRespondToPermission,
  onPermissionProfileChange,
  onRevokePermissionGrant,
  onClearPermissionGrants
}: ConversationPanelProps): React.JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Drag-and-drop shares the same staging callback as the picker and paste paths.
  const { isDragging, dropZoneProps } = useFileDropZone({
    enabled: canEditDraft,
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
    if (!canEditDraft) return

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
        <header className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-1">
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-000">
            {activeSession?.title ?? 'New conversation'}
          </h1>
          {/* The conversation title row is the stable place to manually expand or collapse preview. */}
          <button
            type="button"
            className={`flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-surface-control-hover ${
              isPreviewPanelCollapsed ? 'text-action-panel-toggle' : 'text-action-primary'
            }`}
            aria-label={isPreviewPanelCollapsed ? 'Expand preview panel' : 'Collapse preview panel'}
            aria-expanded={!isPreviewPanelCollapsed}
            aria-controls="right-panel"
            onClick={onTogglePreviewPanel}
          >
            <PanelRight className="size-4" strokeWidth={2} fill="none" aria-hidden="true" />
          </button>
        </header>

        <WorkspaceMessageScroller activeSession={activeSession} />

        <div className="relative shrink-0">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-bg-10 to-bg-10/0"
          />

          <div className="px-4 pb-2">
            {/* Runtime and session errors stay near the composer so recovery is visible. */}
            <div className={composerContentClassName}>
              <div className="px-1 md:px-3">
                {actionError || activeSession?.error ? (
                  <div className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700">
                    {actionError ?? activeSession?.error}
                  </div>
                ) : null}

                {/* Permission controls are already filtered to the visible session by the page. */}
                <PermissionApprovalControls
                  requests={pendingPermissions}
                  onRespond={onRespondToPermission}
                />

                {notebookReference ? (
                  <div className="mb-2 flex min-h-9 items-center rounded-lg border border-border-200 bg-bg-000 px-2 shadow-card">
                    <button
                      type="button"
                      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-text-100 transition-colors duration-200 ease-out hover:bg-bg-200 hover:text-text-000"
                      aria-label="Open notebook"
                      aria-controls="right-panel"
                      onClick={() => onOpenNotebook(notebookReference)}
                    >
                      <BookOpen className="size-3.5" strokeWidth={2} aria-hidden="true" />
                      Notebook
                    </button>
                  </div>
                ) : null}

                <div className="relative">
                  <div
                    aria-hidden="true"
                    className="relative -mb-8 rounded-2xl bg-bg-200 pb-8 shadow-card"
                  />

                  {/* Composer keeps draft input local until submit delegates to the session store.
                      Enter-to-send is owned by ComposerEditor; the form only guards native submit. */}
                  <form
                    className="relative z-10 flex flex-col gap-2 rounded-2xl bg-bg-000 px-3 py-2 shadow-card-opaque transition-shadow duration-[180ms] ease-out"
                    onSubmit={(event) => event.preventDefault()}
                    {...dropZoneProps}
                  >
                    {/* File-drag overlay is scoped to the composer input card only. */}
                    {isDragging ? (
                      <FileDropOverlay label="Drop files to attach" className="rounded-2xl" />
                    ) : null}
                    <div className="flex flex-col gap-2">
                      {attachments.length > 0 ? (
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
                                  <div className="truncate text-[12px] leading-4">
                                    {attachmentName}
                                  </div>
                                  <div className="truncate text-[11px] leading-3 text-text-300">
                                    {formatAttachmentSize(attachment.size)}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className={attachmentRemoveButtonClassName}
                                  disabled={!canEditDraft || isUploadingAttachments}
                                  aria-label={`Remove attachment ${attachmentName}`}
                                  onClick={() => onRemoveAttachment(attachment)}
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
                          placeholder="Ask anything — / for skills, @ for artifacts"
                          ariaLabel="Ask anything"
                        />
                      </div>

                      <div className="@container/composer flex items-center gap-1">
                        <button
                          type="button"
                          disabled={!canEditDraft || isUploadingAttachments}
                          className={composerIconButtonClassName}
                          aria-label="Add attachment"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Plus className="size-4" strokeWidth={2} aria-hidden="true" />
                        </button>
                        {/* The native picker is hidden because the composer button carries the UI. */}
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          className="hidden"
                          tabIndex={-1}
                          onChange={handleAttachmentInputChange}
                        />

                        <ComposerPermissionProfilePicker
                          value={permissionProfile}
                          state={permissionProfileState}
                          grants={permissionGrants}
                          disabled={!canChangePermissionProfile}
                          onChange={onPermissionProfileChange}
                          onRevokeGrant={onRevokePermissionGrant}
                          onClearGrants={onClearPermissionGrants}
                        />

                        <div className="flex-1" />

                        {/* Model/provider switcher; hides itself unless more than one is configured.
                            Grouped on the right with Send, mirroring the reference composer layout. */}
                        <ComposerModelPicker />

                        {activeSession?.status === 'running' ||
                        activeSession?.status === 'waiting-permission' ? (
                          // Running sessions expose cancel instead of send to prevent overlapping turns.
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
      </section>
    </ResizablePanel>
  )
}

export { ConversationPanel }

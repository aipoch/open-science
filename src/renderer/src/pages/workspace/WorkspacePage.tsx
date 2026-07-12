import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { animate } from 'motion'
import type { PanelImperativeHandle, PanelSize } from 'react-resizable-panels'

import type { NotebookSessionReference } from '../../../../shared/notebook'
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
import type { StageUploadFile, UploadedAttachment } from '../../../../shared/uploads'

import { ConversationPanel } from './ConversationPanel'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { PreviewPanel } from './PreviewPanel'
import { RenameSessionDialog } from './RenameSessionDialog'
import { getVisiblePermissionRequests } from './session-permissions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

type WorkspacePageProps = {
  isSessionPersistenceReady: boolean
}

// Converts unknown async failures into composer-visible text.
const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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

// Reads a browser File into the base64 payload expected by the upload IPC layer.
const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')

      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('File could not be read.'))
    reader.readAsDataURL(file)
  })

// Provides stable names for pasted images, which often arrive without a useful filename.
const getUploadFilename = (file: File, index: number): string => {
  const fileName = file.name.trim()

  return fileName || `pasted-image-${Date.now()}-${index + 1}.png`
}

// Renders the workspace shell and bridges the chat surface to the session store.
const WorkspacePage = ({ isSessionPersistenceReady }: WorkspacePageProps): React.JSX.Element => {
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
  const scopedProjectId = activeProjectId ?? ''
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === scopedProjectId)
  )

  // Session data lives in zustand while draft/new-conversation state stays local to the chat surface.
  const allSessions = useSessionStore((state) => state.sessions)
  const selectedSessionId = useSessionStore((state) => state.selectedSessionId)
  const selectSession = useSessionStore((state) => state.selectSession)
  const clearSelection = useSessionStore((state) => state.clearSelection)
  const renameSession = useSessionStore((state) => state.renameSession)
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
    sendMessage,
    cancelRun,
    deleteRuntimeSession,
    respondToPermission
  } = useWorkspaceAgentRuntime()
  const [messageDraft, setMessageDraft] = useState('')
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [notebookReferences, setNotebookReferences] = useState<
    Record<string, NotebookSessionReference>
  >({})
  const [sessionToRename, setSessionToRename] = useState<ChatSession | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | undefined>(undefined)
  // The selected session is the only conversation rendered in the center panel.
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [selectedSessionId, sessions]
  )
  const visiblePermissionRequests = useMemo(
    () => getVisiblePermissionRequests(pendingPermissions, activeSession?.id),
    [activeSession?.id, pendingPermissions]
  )
  const activeNotebookReference = activeSession ? notebookReferences[activeSession.id] : undefined
  // Composer controls follow only the selected session and persistence readiness.
  const canEditDraft = isSessionPersistenceReady
  // Sending is disabled while the current session is running or awaiting a decision.
  const canSendMessage =
    isSessionPersistenceReady &&
    !isUploadingAttachments &&
    (messageDraft.trim().length > 0 || attachments.length > 0) &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-permission'
  const visibleActionError = attachmentError ?? (activeSession ? null : actionError)

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
      const resizePanel = (size: number): void => {
        panel.resize(`${Number(size.toFixed(3))}%`)
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
            resizePanel(targetSize)
            if (direction === 'opening') lastOpenPreviewPanelSizeRef.current = targetSize
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
    if (!activeProjectId) goHome()
  }, [activeProjectId, goHome])

  // Switches the preview panel to the active project's own tabs (never another project's stale
  // previews) and persists/restores each project's panel state across switches and restarts.
  usePreviewPersistence(activeProjectId)

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

  // The availability event only fires while the agent is live, so a session opened after relaunch
  // would lose its notebook entry until the next call. Probe persisted run.json on selection to
  // restore the composer entry immediately for any session that has used the notebook before.
  const activeSessionId = activeSession?.id
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

  // Keeps New as a local draft reset after persistence hydration has selected restored sessions.
  const openNewConversation = (): void => {
    if (!isSessionPersistenceReady) return

    // Staged files belong to the current draft, not the next new conversation.
    deleteAttachmentFiles(attachments)
    setAttachments([])
    setAttachmentError(null)
    clearSelection()
    setMessageDraft('')
  }

  // Synchronizes the hidden chat session id with the selected session list item.
  const openSession = (sessionId: string): void => {
    // Switching sessions abandons unsent attachments so they cannot leak into another chat.
    deleteAttachmentFiles(attachments)
    setAttachments([])
    setAttachmentError(null)
    selectSession(sessionId)
    setMessageDraft('')
  }

  // Converts selected or pasted files into app-managed uploads before they appear in the composer.
  const stageAttachmentFiles = (files: File[]): void => {
    if (!canEditDraft || files.length === 0) return

    setAttachmentError(null)
    setIsUploadingAttachments(true)

    void (async () => {
      try {
        // Browser File objects cannot cross IPC directly, so send base64 content plus metadata.
        const stagedFiles: StageUploadFile[] = await Promise.all(
          files.map(async (file, index) => ({
            name: getUploadFilename(file, index),
            mimeType: file.type || undefined,
            content: await readFileAsBase64(file)
          }))
        )
        const stagedAttachments = await window.api.uploads.stageFiles({ files: stagedFiles })

        setAttachments((currentAttachments) => [...currentAttachments, ...stagedAttachments])
      } catch (error) {
        setAttachmentError(getErrorMessage(error))
      } finally {
        setIsUploadingAttachments(false)
      }
    })()
  }

  // Removes one staged attachment from both local UI state and managed upload storage.
  const removeComposerAttachment = (attachment: UploadedAttachment): void => {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((item) => item.id !== attachment.id)
    )
    void window.api.uploads.deleteUpload({ path: attachment.path }).catch((error) => {
      setAttachmentError(getErrorMessage(error))
    })
  }

  // Sends the current draft only after hydration so restored selection cannot overwrite intent.
  const sendCurrentMessage = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (!canSendMessage) return

    const draft = messageDraft
    const attachmentsForSend = attachments

    // Optimistically clear composer state; failed sends restore both text and attachments below.
    setMessageDraft('')
    setAttachments([])
    setAttachmentError(null)

    // The bridge creates the runtime session if this is the first message. New sessions are stamped
    // with the active project (both as the durable projectId and the MCP storage projectName).
    void sendMessage({
      sessionId: activeSession?.id,
      text: draft,
      attachments: attachmentsForSend,
      cwd: activeSession?.cwd,
      projectId: activeSession?.projectId ?? scopedProjectId,
      projectName: activeSession?.projectId ?? scopedProjectId
    }).then((result) => {
      if (!result) {
        setMessageDraft(draft)
        setAttachments(attachmentsForSend)
      }
    })
  }

  // Opens the rename dialog with the current title prefilled.
  const openRenameDialog = (session: ChatSession): void => {
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

    if (!sessionToRename || renameDraft.trim().length === 0) return

    renameSession(sessionToRename.id, renameDraft)
    closeRenameDialog()
  }

  // Deletes the selected session and repairs the chat surface if it was showing that session.
  const confirmDeleteSession = (): void => {
    if (!sessionToDelete) return

    const deletedSessionId = sessionToDelete.id

    setSessionToDelete(undefined)
    void deleteRuntimeSession(deletedSessionId)
  }

  // Closes the delete dialog without changing runtime or store state.
  const closeDeleteDialog = (): void => {
    setSessionToDelete(undefined)
  }

  // Cancels the run for the currently visible session when one is selected.
  const cancelActiveRun = (): void => {
    if (activeSession) void cancelRun(activeSession.id)
  }

  // Forwards visible permission decisions to the runtime bridge.
  const respondToVisiblePermission = (requestId: string, optionId?: string): void => {
    void respondToPermission(requestId, optionId)
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
    <main className="h-screen overflow-hidden bg-bg-10 p-[10px] text-[13px] leading-normal text-text-000">
      <div className="flex h-full gap-2">
        <WorkspaceSidebar
          projectName={activeProject?.name ?? 'Project'}
          sessions={sessions}
          activeSessionId={selectedSessionId}
          canCreateConversation={isSessionPersistenceReady}
          onGoHome={goHome}
          onNewConversation={openNewConversation}
          isFilesOpen={activePreviewItemId === PROJECT_FILES_PREVIEW_ID}
          onOpenFiles={openFilesPreview}
          onOpenSession={openSession}
          onRenameSession={openRenameDialog}
          onDeleteSession={setSessionToDelete}
          onOpenSettings={openSettings}
        />

        {/* Resizable panels follow the existing workspace layout; main content owns chat state. */}
        <ResizablePanelGroup
          orientation="horizontal"
          className="-my-[10px] h-[calc(100%+20px)] min-w-0 flex-1"
        >
          <ConversationPanel
            activeSession={activeSession}
            messageDraft={messageDraft}
            canSendMessage={canSendMessage}
            canEditDraft={canEditDraft}
            actionError={visibleActionError}
            isPreviewPanelCollapsed={previewPanelState === 'collapsed'}
            attachments={attachments}
            isUploadingAttachments={isUploadingAttachments}
            notebookReference={activeNotebookReference}
            pendingPermissions={visiblePermissionRequests}
            onMessageDraftChange={setMessageDraft}
            onSendMessage={sendCurrentMessage}
            onStageAttachmentFiles={stageAttachmentFiles}
            onRemoveAttachment={removeComposerAttachment}
            onCancelRun={cancelActiveRun}
            onOpenNotebook={openNotebookPreview}
            onTogglePreviewPanel={togglePreviewPanel}
            onRespondToPermission={respondToVisiblePermission}
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
        onCancel={closeDeleteDialog}
        onConfirmDelete={confirmDeleteSession}
      />
    </main>
  )
}

export { WorkspacePage }

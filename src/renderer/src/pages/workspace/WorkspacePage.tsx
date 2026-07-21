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
import { useReviewStore } from '@/stores/review-store'
import {
  assembleReviewRunRequest,
  suppressNextAutoReview,
  clearSuppressNextAutoReview
} from '@/lib/acp/workspace-events'
import type { StageUploadFile, UploadedAttachment } from '../../../../shared/uploads'

import { planComposerAttachmentIntake } from './composer-attachment-intake'
import {
  docIsEmpty,
  docToArtifactRefs,
  docToText,
  emptyDoc,
  type ComposerDoc
} from './composer/composer-doc'
import { ConversationPanel } from './ConversationPanel'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { PreviewPanel } from './PreviewPanel'
import { RenameSessionDialog } from './RenameSessionDialog'
import { SessionNotebookDialog } from './SessionNotebookDialog'
import { getVisiblePermissionRequests } from './session-permissions'
import { WorkspaceSidebar } from './WorkspaceSidebar'

type WorkspacePageProps = {
  isSessionPersistenceReady: boolean
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
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const supportsImageInput = useSettingsStore(
    (state) =>
      state.providers.find((provider) => provider.id === activeProviderId)?.supportsImageInput
  )
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
  const setAutoReviewEnabled = useSessionStore((state) => state.setAutoReviewEnabled)
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
    sendMessage,
    cancelRun,
    resumeInterruptedSession,
    deleteRuntimeSession,
    respondToPermission,
    setPermissionProfile,
    revokePermissionGrant
  } = useWorkspaceAgentRuntime()
  const [draftDoc, setDraftDoc] = useState<ComposerDoc>(emptyDoc)
  const [newConversationPermissionProfile, setNewConversationPermissionProfile] =
    useState<PermissionProfileId>(DEFAULT_PERMISSION_PROFILE)
  // Draft auto-review state for a not-yet-created conversation. Auto-review defaults off, so a new
  // conversation starts disabled; the user can toggle it on before sending. On send it is stamped
  // onto the created session (see sendCurrentMessage).
  const [newConversationAutoReviewEnabled, setNewConversationAutoReviewEnabled] = useState(false)
  // Unsent composer state (rich doc + staged attachments) is kept per session (and per new conversation)
  // so switching away and back restores it. The active key's state is live; this map holds inactive keys.
  const composerDraftsRef = useRef<
    Record<string, { doc: ComposerDoc; attachments: UploadedAttachment[] }>
  >({})
  const previousDraftKeyRef = useRef<string>(selectedSessionId ?? NEW_CONVERSATION_DRAFT_KEY)
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [notebookReferences, setNotebookReferences] = useState<
    Record<string, NotebookSessionReference>
  >({})
  const [sessionToRename, setSessionToRename] = useState<ChatSession | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | undefined>(undefined)
  const [sessionToViewNotebook, setSessionToViewNotebook] = useState<ChatSession | undefined>(
    undefined
  )
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
  const activePermissionProfile =
    activeSession?.permissionProfile ?? newConversationPermissionProfile
  const activePermissionProfileState = activeSession
    ? permissionProfiles?.[activeSession.id]
    : undefined
  // Always-allow grants only exist for a bound session; new conversations have none yet.
  const activePermissionGrants = activeSession ? (permissionGrants?.[activeSession.id] ?? []) : []
  // Auto-review defaults off: an existing session is enabled only when explicitly turned on; a new
  // conversation uses the draft toggle (which also starts off).
  const activeAutoReviewEnabled = activeSession
    ? activeSession.autoReviewEnabled === true
    : newConversationAutoReviewEnabled
  // True while any review for the active session is in the 'running' lifecycle.
  // Using a shallow comparison via reviewsBySession to avoid new array reference on every render.
  const activeSessionId = activeSession?.id
  const isReviewing = useReviewStore((state) => {
    if (!activeSessionId) return false
    const reviews = state.reviewsBySession[activeSessionId]
    return reviews ? reviews.some((review) => review.lifecycle === 'running') : false
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
    const reviews = state.reviewsBySession[activeSessionId]
    if (reviews) {
      // Newest-first, so find() returns the most recent review for the last turn. Only a fresh,
      // completed verdict blocks a new review; a stale one (turn changed) or an errored one must stay
      // retriable so the user isn't stuck without any review entry point.
      const lastTurnReview = reviews.find((r) => r.turnMessageId === lastAgentMessage.id)
      if (lastTurnReview && lastTurnReview.lifecycle === 'complete' && !lastTurnReview.stale) {
        return true
      }
    }
    return false
  })
  const handleReviewUpdate = useReviewStore((state) => state.handleReviewUpdate)
  // Composer controls follow only the selected session and persistence readiness.
  const canEditDraft = isSessionPersistenceReady
  // Sending is disabled while the current session is running, awaiting a decision, or locked by the
  // fix loop (fixLoopActive). The fix loop lock persists across both the reviewer-review sub-phase and
  // the main agent-fix sub-phase; typing does not override the lock.
  const canSendMessage =
    isSessionPersistenceReady &&
    !isUploadingAttachments &&
    (!docIsEmpty(draftDoc) || attachments.length > 0) &&
    activeSession?.status !== 'running' &&
    activeSession?.status !== 'waiting-permission' &&
    !activeSession?.fixLoopActive &&
    // Auto-recovery drops the session to idle while it resets context and replays the transcript; block
    // sends in that window so a manual prompt can't race the recovery resend into the same session.
    !activeSession?.compacting
  const canChangePermissionProfile =
    isSessionPersistenceReady &&
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
    if (!activeProjectId) goHome()
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

    composerDraftsRef.current[previousDraftKey] = { doc: draftDoc, attachments }
    const nextDraft = composerDraftsRef.current[currentDraftKey] ?? {
      doc: emptyDoc,
      attachments: []
    }
    setDraftDoc(nextDraft.doc)
    setAttachments(nextDraft.attachments)
    previousDraftKeyRef.current = currentDraftKey
  }, [selectedSessionId, draftDoc, attachments])

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
      ({ sessionId, clear }) => {
        if (clear) {
          clearSuppressNextAutoReview(sessionId)
        } else {
          suppressNextAutoReview(sessionId)
        }
      }
    )

    return () => {
      removeSuppressListener()
    }
  }, [])

  // Subscribe to fix loop lifecycle events from the main process. When a fix loop starts for a
  // session, set fixLoopActive=true to disable the send button. When it ends or is aborted, clear
  // the flag. The lock is per-session: other sessions remain interactive.
  useEffect(() => {
    const removeStartListener = window.api.reviewer.onFixLoopStart(({ sessionId }) => {
      setFixLoopActive(sessionId, true)
    })
    const removeEndListener = window.api.reviewer.onFixLoopEnd(({ sessionId }) => {
      setFixLoopActive(sessionId, false)
    })

    return () => {
      removeStartListener()
      removeEndListener()
    }
  }, [setFixLoopActive])

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

    // The draft effect saves the outgoing doc/attachments and restores the new-conversation state.
    setAttachmentError(null)
    setNewConversationPermissionProfile(DEFAULT_PERMISSION_PROFILE)
    setNewConversationAutoReviewEnabled(false)
    clearSelection()
  }

  // Synchronizes the hidden chat session id with the selected session list item.
  const openSession = (sessionId: string): void => {
    // The draft effect saves the outgoing doc/attachments and restores the target session's state.
    setAttachmentError(null)
    selectSession(sessionId)
  }

  // Converts selected or pasted files into app-managed uploads before they appear in the composer.
  const stageAttachmentFiles = (files: File[]): void => {
    if (!canEditDraft || files.length === 0) return
    if (files.some((file) => file.type.startsWith('image/')) && supportsImageInput !== true) {
      setAttachmentError('The selected model is not configured for image input.')
      return
    }

    // Enforce the size and count limits up front so rejected files are never read or uploaded.
    const { accepted, error } = planComposerAttachmentIntake(files, attachments.length)

    setAttachmentError(error)

    if (accepted.length === 0) return

    setIsUploadingAttachments(true)

    void (async () => {
      try {
        // Browser File objects cannot cross IPC directly, so send base64 content plus metadata.
        const stagedFiles: StageUploadFile[] = await Promise.all(
          accepted.map(async (file, index) => ({
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
  // ConversationPanel owns preventDefault and passes the skills picked as inline chips.
  const sendCurrentMessage = (forcedSkillIds: string[]): void => {
    if (!canSendMessage) return
    if (
      supportsImageInput !== true &&
      attachments.some((attachment) => attachment.mimeType?.startsWith('image/'))
    ) {
      setAttachmentError('The selected model is not configured for image input.')
      return
    }

    const doc = draftDoc
    const attachmentsForSend = attachments
    // Capture new-conversation intent before send: auto-review defaults off, so only an explicit
    // "on" needs to be stamped onto the created session (absent = off downstream).
    const wasNewConversation = !activeSession
    const draftAutoReviewEnabled = newConversationAutoReviewEnabled

    // Optimistically clear composer state; failed sends restore both doc and attachments below. Staged
    // files are consumed (moved into the session dir) by the runtime, so they are not deleted here.
    setDraftDoc(emptyDoc)
    // Drop the stored draft for this key so a sent message never lingers as a restorable draft.
    delete composerDraftsRef.current[selectedSessionId ?? NEW_CONVERSATION_DRAFT_KEY]
    setAttachments([])
    setAttachmentError(null)

    // The bridge creates the runtime session if this is the first message. New sessions are stamped
    // with the active project (both as the durable projectId and the MCP storage projectName).
    void sendMessage({
      sessionId: activeSession?.id,
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
      forcedSkillIds
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
      setNewConversationAutoReviewEnabled(false)
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
    // The session's unsent draft is abandoned, so drop it and delete its now-orphaned staged files.
    const storedDraft = composerDraftsRef.current[deletedSessionId]
    if (storedDraft) deleteAttachmentFiles(storedDraft.attachments)
    delete composerDraftsRef.current[deletedSessionId]
    // The active session's live draft is not in the map yet, so clear and delete its files directly.
    if (deletedSessionId === selectedSessionId) {
      deleteAttachmentFiles(attachments)
      setAttachments([])
      setDraftDoc(emptyDoc)
    }
    void deleteRuntimeSession(deletedSessionId)
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
      void window.api.reviewer.abortFixLoop(sessionId).catch((error) => {
        console.warn('Failed to abort fix loop:', error)
      })
    }

    void cancelRun(sessionId)
  }

  // Re-attaches the visible interrupted session so the user can keep chatting; awaited by the banner.
  const resumeActiveSession = async (): Promise<void> => {
    if (activeSession) await resumeInterruptedSession(activeSession.id)
  }

  // Forwards visible permission decisions to the runtime bridge.
  const respondToVisiblePermission = (requestId: string, optionId?: string): void => {
    void respondToPermission(requestId, optionId)
  }

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

  // Manually triggers a review of the last completed turn, bypassing autoReviewEnabled and the
  // suppressAutoReviewOnceFor loop guard. Disabled logic is enforced by isRequestReviewDisabled.
  const requestManualReview = (): void => {
    if (!activeSession) return

    const request = assembleReviewRunRequest(activeSession.id)

    if (!request) return

    // Explicit user action: bypass main's auto-only per-turn idempotency so a manual review always runs.
    void window.api.reviewer.run({ ...request, origin: 'manual' })
  }

  // Revokes one always-allow grant for the visible session; new conversations have no grants.
  const revokeActivePermissionGrant = (categoryKey: string): void => {
    if (!activeSession) return

    void revokePermissionGrant(activeSession.id, categoryKey)
  }

  // Clears every always-allow grant for the visible session. Revokes are awaited in sequence so the
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
          onViewNotebook={setSessionToViewNotebook}
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
            draftDoc={draftDoc}
            canSendMessage={canSendMessage}
            canEditDraft={canEditDraft}
            actionError={visibleActionError}
            isPreviewPanelCollapsed={previewPanelState === 'collapsed'}
            attachments={attachments}
            isUploadingAttachments={isUploadingAttachments}
            notebookReference={activeNotebookReference}
            pendingPermissions={visiblePermissionRequests}
            permissionProfile={activePermissionProfile}
            permissionProfileState={activePermissionProfileState}
            permissionGrants={activePermissionGrants}
            canChangePermissionProfile={canChangePermissionProfile}
            autoReviewEnabled={activeAutoReviewEnabled}
            onDraftDocChange={setDraftDoc}
            onSendMessage={sendCurrentMessage}
            onStageAttachmentFiles={stageAttachmentFiles}
            onRemoveAttachment={removeComposerAttachment}
            onCancelRun={cancelActiveRun}
            onResumeSession={resumeActiveSession}
            onOpenNotebook={openNotebookPreview}
            onTogglePreviewPanel={togglePreviewPanel}
            onRespondToPermission={respondToVisiblePermission}
            onPermissionProfileChange={changePermissionProfile}
            onRevokePermissionGrant={revokeActivePermissionGrant}
            onClearPermissionGrants={clearActivePermissionGrants}
            onAutoReviewToggle={changeAutoReviewEnabled}
            onRequestReview={requestManualReview}
            isRequestReviewDisabled={isRequestReviewDisabled}
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

      <SessionNotebookDialog
        session={sessionToViewNotebook}
        onClose={() => setSessionToViewNotebook(undefined)}
      />
    </main>
  )
}

export { WorkspacePage }

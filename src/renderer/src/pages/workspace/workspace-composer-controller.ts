import { useTranslation } from 'react-i18next'
import {
  composerDraftStorageFailed,
  readComposerDraft,
  writeComposerDraft,
  registerComposerDraftWriter,
  removeComposerDrafts
} from './composer-draft-storage'
import type { PdfReadingPositionSource } from '../../../../shared/session-pdf-context'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  validateAnnotations,
  type Annotation,
  type AnnotationValidationError
} from '../../../../shared/annotations'
import {
  isSessionSizeLimitError,
  MAX_SESSION_PDF_CONTEXTS,
  type MessagePdfContextSnapshot,
  type PdfReadingPosition,
  type SessionPdfBinding,
  type SessionPdfContext,
  type SessionPdfContextSource
} from '../../../../shared/session-persistence'
import { buildCustomizePrefillDoc } from '@/lib/customize-chat'
import type { CustomizePrefillIntent, WslSupportPrefillIntent } from '@/stores/navigation-store'
import {
  pendingPdfContextBindingId,
  pendingPdfContextSelections,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

import { useWorkspaceComposerDrafts } from './workspace-composer-drafts'
import type { ComposerUploadTransfer } from './composer-upload-transfer'
import {
  docIsEmpty,
  docToPdfContextSources,
  docToText,
  emptyDoc,
  type ComposerCaretPosition,
  type ComposerDoc,
  type ComposerPastedTextStage
} from './composer/composer-doc'
import { normalizeHistorySkills, type ComposerHistoryEntry } from './composer/composer-history'
import {
  useWorkspaceComposerUploadController,
  type ComposerDraft,
  type ComposerUploadApi
} from './workspace-composer-upload-controller'
import {
  createPreviewFileItemFromPdfContext,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import { getPreviewFormatForFile } from './preview-support'

type ComposerHistoryNavigation = {
  entries: ComposerHistoryEntry[]
  cursorId: string
  scratch: ComposerDoc
}

type ComposerSessionContext = {
  id: string
  projectId: string
  runtimeContext?: { revision: number; pdfContext?: SessionPdfContext }
}

type ComposerReadingContextBinding =
  SessionPdfBinding | { bindingId: string; name: string; draftSelection: true }

type ReadingMutationRuntime = {
  revision: number
  pdfContext?: SessionPdfContext
}

const pdfContextSourceKey = ({ sourceKind, sourceVersionId }: SessionPdfContextSource): string =>
  `${sourceKind}:${sourceVersionId}`

const samePdfContextSources = (
  left: readonly SessionPdfContextSource[],
  right: readonly SessionPdfContextSource[]
): boolean =>
  left.length === right.length &&
  left.every((source, index) => pdfContextSourceKey(source) === pdfContextSourceKey(right[index]))

export type ComposerSendSnapshot = {
  setupSessionToken?: string
  queuedEdit?: ComposerDraft['queuedEdit']
  draftKey: string
  version: number
  doc: ComposerDoc
  annotations: Annotation[]
  attachments: UploadedAttachment[]
  automaticReadingEnabled?: boolean
  pdfContext?: MessagePdfContextSnapshot
  pdfReadingPosition?: PdfReadingPosition
  pdfReadingPositionSource?: PdfReadingPositionSource
  pendingPdfContextAttachmentIds?: string[]
  pendingPdfContextVersions?: Array<{
    sourceKind: SessionPdfContextSource['sourceKind']
    sourceFileId?: string
    sourceVersionId: string
  }>
}

type WorkspaceComposerControllerInput = {
  currentDraftKey: string
  newConversationDraftKey: string
  activeProjectId: string | undefined
  pendingCustomizePrefill: CustomizePrefillIntent | undefined
  pendingWslSupportPrefill?: WslSupportPrefillIntent | undefined
  onCustomizePrefillApplied: () => void
  onWslSupportPrefillApplied?: () => void
  historyEntries: ComposerHistoryEntry[]
  activeSession: ComposerSessionContext | undefined
  historyPolicy: {
    catalogSkillIds: ReadonlySet<string>
    allowedSkillIds: ReadonlySet<string> | undefined
    skillCatalogReady: boolean
    refreshSkillCatalog: boolean
    specialistCatalogReady: boolean
    specialistId: string | undefined
    loadSkills: () => Promise<unknown>
    loadSpecialists: () => Promise<unknown>
  }
  canStageAttachments: boolean
  supportsImageInput: boolean | undefined
  uploads: ComposerUploadApi
  onSessionSizeLimit?: (sessionId: string) => void
}

type WorkspaceComposerController = {
  view: {
    queuedEdit?: ComposerDraft['queuedEdit']
    doc: ComposerDoc
    annotations: Annotation[]
    attachments: UploadedAttachment[]
    transfers: ComposerUploadTransfer[]
    error: string | null
    errorDetail?: string
    historyStatus: string
    isHistoryBrowsing: boolean
    isUploading: boolean
    isWslSetupDraft: boolean
    caretRequest: { key: number; position: ComposerCaretPosition } | undefined
    readingContext: {
      bindings: ComposerReadingContextBinding[]
      pendingBindingId: string | undefined
      isPending: boolean
      automaticAttachmentCount: number
    }
  }
  actions: {
    cancelQueuedEdit?: () => void
    discardWslSetupDraft: () => boolean
    changeDoc: (doc: ComposerDoc, caret?: ComposerCaretPosition) => void
    addAnnotation: (annotation: Annotation) => AnnotationValidationError | undefined
    updateAnnotationNote: (id: string, note: string) => AnnotationValidationError | undefined
    removeAnnotation: (id: string) => void
    navigateHistory: (direction: 'previous' | 'next') => boolean
    stageFiles: (files: File[]) => void
    stagePastedText: (
      doc: ComposerDoc,
      node: ComposerPastedTextStage,
      caret?: ComposerCaretPosition
    ) => void
    cancelTransfer: (transfer: ComposerUploadTransfer) => void
    retryTransfer: (transfer: ComposerUploadTransfer) => void
    removeAttachment: (attachment: UploadedAttachment) => void
    restorePastedText: (pastedTextId: string) => void
    undo: (caret?: ComposerCaretPosition) => boolean
    redo: (caret?: ComposerCaretPosition) => boolean
    setError: (error: string | null) => void
    linkReadingContext: (source: SessionPdfContextSource) => Promise<void>
    openReadingContext: (bindingId: string) => void
    unlinkReadingContext: (bindingId: string) => void
    dismissAutomaticReading: () => void
  }
  lifecycle: {
    captureSend: (includeReadingContext?: boolean) => ComposerSendSnapshot
    captureRevision: (doc: ComposerDoc, annotations: Annotation[]) => ComposerSendSnapshot
    clearDraft: (draftKey: string, expectedVersion?: number) => boolean
    restoreFailedSend: (snapshot: ComposerSendSnapshot, preserveOnConflict?: boolean) => boolean
    discardSnapshot: (snapshot: ComposerSendSnapshot) => void
    hasUnfinishedTransfers: (draftKey: string) => boolean
    beginSessionDeletion: (draftKey: string) => boolean
    settleSessionDeletion: (draftKey: string, deleted: boolean) => void
  }
}

class SetupSessionTokenStore {
  private value: string | undefined
  private readonly listeners = new Set<() => void>()

  constructor(initialValue: string | undefined) {
    this.value = initialValue
  }

  readonly getSnapshot = (): string | undefined => this.value

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(token: string | undefined): void {
    if (this.value === token) return
    this.value = token
    this.listeners.forEach((listener) => listener())
  }
}

const blank = (): ComposerDraft => ({
  doc: emptyDoc,
  annotations: [],
  attachments: [],
  attachmentTransfers: [],
  automaticReadingEnabled: true
})

const useWorkspaceComposerController = ({
  currentDraftKey,
  newConversationDraftKey,
  activeProjectId,
  pendingCustomizePrefill,
  pendingWslSupportPrefill,
  onCustomizePrefillApplied,
  onWslSupportPrefillApplied = () => undefined,
  historyEntries,
  activeSession,
  historyPolicy,
  canStageAttachments,
  supportsImageInput,
  uploads,
  onSessionSizeLimit
}: WorkspaceComposerControllerInput): WorkspaceComposerController => {
  const { t } = useTranslation()
  const retryMessage = t('Upload interrupted or unavailable. Remove it and select the file again.')
  const projectIdRef = useRef(activeProjectId ?? 'default-project')
  const { draftsRef, versionsRef, deletedDraftKeysRef } = useWorkspaceComposerDrafts()
  // Read the parked memory snapshot once at mount; subsequent edits use live controller state.
  const [initialDraft] = useState(
    // eslint-disable-next-line react-hooks/refs
    () =>
      draftsRef.current[currentDraftKey] ??
      readComposerDraft(activeProjectId ?? 'default-project', currentDraftKey, retryMessage) ??
      blank()
  )
  const [queuedEdit, setQueuedEdit] = useState(initialDraft.queuedEdit)
  const queuedEditRef = useRef<ComposerDraft['queuedEdit']>(initialDraft.queuedEdit)
  const setupSessionTokenRef = useRef(initialDraft.setupSessionToken)
  const setupSessionTokenStore = useMemo(
    () => new SetupSessionTokenStore(initialDraft.setupSessionToken),
    [initialDraft.setupSessionToken]
  )
  const setupSessionToken = useSyncExternalStore(
    setupSessionTokenStore.subscribe,
    setupSessionTokenStore.getSnapshot,
    setupSessionTokenStore.getSnapshot
  )
  const setActiveSetupSessionToken = useCallback(
    (token: string | undefined): void => {
      setupSessionTokenRef.current = token
      setupSessionTokenStore.set(token)
    },
    [setupSessionTokenStore]
  )
  const setActiveQueuedEdit = useCallback((intent: ComposerDraft['queuedEdit']): void => {
    queuedEditRef.current = intent
    setQueuedEdit(intent)
  }, [])
  const [doc, setDoc] = useState<ComposerDoc>(initialDraft.doc)
  const [annotations, setAnnotations] = useState<Annotation[]>(initialDraft.annotations)
  const [historyBrowsingKey, setHistoryBrowsingKey] = useState<string>()
  const [historyStatus, setHistoryStatus] = useState('')
  const [skillCatalogReady, setSkillCatalogReady] = useState(historyPolicy.skillCatalogReady)
  const appliedConversationPrefillRef = useRef<{
    kind: 'customize' | 'wsl-support'
    projectId: string
    requestId: number
  }>(undefined)
  const [caretRequest, setCaretRequest] = useState<{
    key: number
    position: ComposerCaretPosition
  }>()
  const draftProjectsRef = useRef<Record<string, string>>({
    [currentDraftKey]: activeProjectId ?? 'default-project'
  })
  const activeDraftKeyRef = useRef(currentDraftKey)
  const docRef = useRef(doc)
  const annotationsRef = useRef(annotations)
  const [automaticReadingEnabled, setAutomaticReadingEnabled] = useState(
    initialDraft.automaticReadingEnabled
  )
  const automaticReadingEnabledRef = useRef(initialDraft.automaticReadingEnabled)
  const historyRef = useRef<Record<string, ComposerHistoryNavigation>>({})
  const caretRequestKeyRef = useRef(0)
  const durableReadingContext = activeSession?.runtimeContext?.pdfContext
  const durableReadingBindings = useMemo(
    () => durableReadingContext?.bindings ?? [],
    [durableReadingContext]
  )
  const durableReadingSources = useMemo(
    () =>
      durableReadingBindings.map(({ sourceKind, sourceFileId, sourceVersionId }) => ({
        sourceKind,
        sourceFileId,
        sourceVersionId
      })),
    [durableReadingBindings]
  )
  const readingContextSourcesRef = useRef<SessionPdfContextSource[]>(durableReadingSources)
  const restoreReadingContextSourcesRef = useRef<
    (sources: SessionPdfContextSource[]) => Promise<void>
  >(() => Promise.resolve())
  const restoreReadingContextSources = useCallback((sources: SessionPdfContextSource[]): void => {
    void restoreReadingContextSourcesRef.current(sources).catch(() => undefined)
  }, [])

  const setActiveDoc = useCallback((next: ComposerDoc): void => {
    docRef.current = next
    setDoc(next)
  }, [])

  const setActiveAnnotations = useCallback((next: Annotation[]): void => {
    annotationsRef.current = next
    setAnnotations(next)
  }, [])

  const setActiveAutomaticReadingEnabled = useCallback((enabled: boolean): void => {
    automaticReadingEnabledRef.current = enabled
    setAutomaticReadingEnabled(enabled)
  }, [])

  const requestCaret = useCallback((position: ComposerCaretPosition): void => {
    caretRequestKeyRef.current += 1
    setCaretRequest({ key: caretRequestKeyRef.current, position })
  }, [])

  const persistDraftsRef = useRef((): void => undefined)
  const markChanged = useCallback(
    (draftKey = activeDraftKeyRef.current): void => {
      versionsRef.current[draftKey] = (versionsRef.current[draftKey] ?? 0) + 1
      queueMicrotask(() => persistDraftsRef.current())
    },
    [versionsRef]
  )

  const clearHistory = useCallback((draftKey: string): void => {
    delete historyRef.current[draftKey]
    setHistoryBrowsingKey((current) => (current === draftKey ? undefined : current))
    if (activeDraftKeyRef.current === draftKey) setHistoryStatus('')
  }, [])

  const uploadController = useWorkspaceComposerUploadController({
    initialDraft,
    activeDraftKeyRef,
    docRef,
    annotationsRef,
    draftsRef,
    setActiveDoc,
    setActiveAnnotations,
    clearHistory,
    markChanged,
    requestCaret,
    canStageAttachments,
    supportsImageInput,
    uploads,
    readingContextSourcesRef,
    restoreReadingContextSources,
    automaticReadingEnabledRef,
    setActiveAutomaticReadingEnabled
  })
  const { attachments, transfers, error, errorDetail, isUploading } = uploadController.view
  const {
    changeDoc,
    stageFiles,
    stagePastedText,
    cancelTransfer,
    retryTransfer,
    removeAttachment,
    restorePastedText,
    undo,
    redo,
    setError,
    clearPastedTextUndo,
    clearUndo,
    captureUndo,
    beginUndoTransaction
  } = uploadController.actions
  const {
    captureDraftAttachments,
    activateDraftAttachments,
    clearActiveAttachments,
    setActiveAttachments,
    releaseHistoryResources,
    hasUnfinishedTransfers,
    beginSessionDeletion,
    settleSessionDeletion
  } = uploadController.lifecycle
  useLayoutEffect(() => {
    const drafts = draftsRef.current
    const deletedDraftKeys = deletedDraftKeysRef.current
    const history = historyRef.current
    // Remove the parked copy: active attachments must have only their live owner.
    delete draftsRef.current[activeDraftKeyRef.current]
    return () => {
      const draftKey = activeDraftKeyRef.current
      if (!deletedDraftKeys.has(draftKey)) {
        drafts[draftKey] = {
          doc: history[draftKey]?.scratch ?? docRef.current,
          annotations: annotationsRef.current,
          ...captureDraftAttachments(),
          queuedEdit: queuedEditRef.current,
          automaticReadingEnabled: automaticReadingEnabledRef.current
        }
        writeComposerDraft(projectIdRef.current, draftKey, drafts[draftKey])
      }
    }
  }, [draftsRef, deletedDraftKeysRef, captureDraftAttachments])

  const persistDrafts = useCallback((): void => {
    const projectId = projectIdRef.current
    const key = activeDraftKeyRef.current
    if (!deletedDraftKeysRef.current.has(key))
      writeComposerDraft(projectId, key, {
        doc: historyRef.current[key]?.scratch ?? docRef.current,
        annotations: annotationsRef.current,
        ...captureDraftAttachments(),
        automaticReadingEnabled: automaticReadingEnabledRef.current
      })
    // Parked drafts are saved at the route boundary; asynchronous upload completions need a flush too.
    for (const [draftKey, draft] of Object.entries(draftsRef.current)) {
      const draftProject = draftProjectsRef.current[draftKey]
      if (draftProject && !deletedDraftKeysRef.current.has(draftKey))
        writeComposerDraft(draftProject, draftKey, draft)
    }
    if (composerDraftStorageFailed())
      setError(t('Draft storage is unavailable. Copy your draft before leaving this page.'))
  }, [captureDraftAttachments, deletedDraftKeysRef, draftsRef, setError, t])
  useLayoutEffect(() => {
    persistDraftsRef.current = persistDrafts
    persistDrafts()
  })
  useEffect(() => {
    persistDraftsRef.current = persistDrafts
    const unregister = registerComposerDraftWriter(persistDrafts)
    window.addEventListener('pagehide', persistDrafts)
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      persistDrafts()
      if (composerDraftStorageFailed()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      persistDraftsRef.current = (): void => undefined
      unregister()
      window.removeEventListener('pagehide', persistDrafts)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [persistDrafts])

  const pendingPdfContextSelection = usePreviewWorkbenchStore((state) =>
    !activeSession && activeProjectId
      ? state.pendingPdfContextByProject[activeProjectId]
      : undefined
  )
  const pendingReadingSelections = useMemo(
    () => pendingPdfContextSelections(pendingPdfContextSelection),
    [pendingPdfContextSelection]
  )
  const stagedReadingContexts = useMemo(
    () =>
      pendingReadingSelections.flatMap((selection) => {
        const attachment =
          selection.kind === 'staged-upload'
            ? attachments.find((entry) => entry.id === selection.attachmentId)
            : undefined
        return attachment ? [attachment] : []
      }),
    [attachments, pendingReadingSelections]
  )
  const automaticStagedReadingContexts = useMemo(
    () =>
      (!activeSession || durableReadingBindings.length > 0) &&
      !pendingPdfContextSelection &&
      transfers.length === 0 &&
      attachments.length >= 1 &&
      attachments.length <= MAX_SESSION_PDF_CONTEXTS - durableReadingBindings.length &&
      attachments.every(
        (attachment) =>
          getPreviewFormatForFile({ name: attachment.name, mimeType: attachment.mimeType }) ===
          'pdf'
      )
        ? attachments
        : [],
    [
      activeSession,
      attachments,
      durableReadingBindings.length,
      pendingPdfContextSelection,
      transfers.length
    ]
  )
  const previewItems = usePreviewWorkbenchStore((state) => state.items)
  const pendingReadingItems = useMemo(
    () =>
      pendingReadingSelections.flatMap((selection) => {
        const item = previewItems.find((candidate) => candidate.id === selection.previewItemId)
        const attachment =
          selection.kind === 'staged-upload'
            ? attachments.find((candidate) => candidate.id === selection.attachmentId)
            : undefined
        if (selection.kind === 'staged-upload' ? !attachment : item?.type !== 'file') return []
        return [
          { selection, item, name: attachment?.name ?? (item?.type === 'file' ? item.name : '') }
        ]
      }),
    [attachments, pendingReadingSelections, previewItems]
  )
  const readingContexts: ComposerReadingContextBinding[] =
    durableReadingBindings.length > 0
      ? [...durableReadingBindings]
      : pendingReadingItems.map(({ selection, name }) => ({
          bindingId: pendingPdfContextBindingId(selection),
          name,
          draftSelection: true
        }))
  const activePreviewItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const activeReadingBinding =
    durableReadingBindings.find(
      (binding) =>
        activeSession &&
        createPreviewFileItemFromPdfContext(binding, activeSession.projectId).id ===
          activePreviewItemId
    ) ?? durableReadingBindings[0]
  const activePendingReading = (
    pendingReadingItems.find(({ selection }) => selection.previewItemId === activePreviewItemId) ??
    pendingReadingItems[0]
  )?.selection
  const readingPositionBindingId =
    activeReadingBinding?.bindingId ??
    (activePendingReading ? pendingPdfContextBindingId(activePendingReading) : undefined)
  const pdfReadingPosition = usePreviewWorkbenchStore((state) =>
    readingPositionBindingId
      ? state.pdfReadingPositionByBindingId[readingPositionBindingId]
      : undefined
  )

  // Mirror the active new-conversation draft's attachment ids so preview surfaces can tell
  // linkable staged uploads apart from stale ones (a preview tab can outlive its attachment).
  useEffect(() => {
    usePreviewWorkbenchStore
      .getState()
      .setDraftStagedUploadIds(activeSession ? [] : attachments.map((attachment) => attachment.id))
  }, [activeSession, attachments])

  // A staged-upload draft selection only holds while its attachment is in the active draft: the
  // first send finalizes the binding through that attachment. If the attachment is gone (removed
  // from the draft, an earlier same-named intake), clear the selection rather than letting the
  // preview header read linked while neither the chip nor a send could honor it.
  useEffect(() => {
    if (!activeProjectId) return
    for (const selection of pendingReadingSelections) {
      if (
        selection.kind === 'staged-upload' &&
        !attachments.some(({ id }) => id === selection.attachmentId)
      ) {
        usePreviewWorkbenchStore.getState().clearPendingPdfContext(activeProjectId, selection)
      }
    }
  }, [activeProjectId, attachments, pendingReadingSelections])
  const [pdfContextPendingBindingId, setPdfContextPendingBindingId] = useState<string>()
  const [isPdfContextPending, setIsPdfContextPending] = useState(false)
  const readingMutationRuntimeRef = useRef<
    | {
        sessionId: string
        projectId: string
        runtimeContext: ReadingMutationRuntime
      }
    | undefined
  >(undefined)
  const readingMutationPromiseRef = useRef<Promise<void> | undefined>(undefined)
  const readingMutationPromiseRuntimeRef =
    useRef<typeof readingMutationRuntimeRef.current>(undefined)
  useLayoutEffect(() => {
    const current = readingMutationRuntimeRef.current
    if (
      activeSession &&
      (current?.sessionId !== activeSession.id ||
        current?.projectId !== activeSession.projectId ||
        (!readingMutationPromiseRef.current &&
          (activeSession.runtimeContext?.revision ?? 0) >= current.runtimeContext.revision))
    ) {
      readingMutationRuntimeRef.current = {
        sessionId: activeSession.id,
        projectId: activeSession.projectId,
        runtimeContext: activeSession.runtimeContext ?? { revision: 0 }
      }
      readingContextSourcesRef.current = durableReadingSources
    } else if (!activeSession && current) {
      readingMutationRuntimeRef.current = undefined
      readingContextSourcesRef.current = []
    }
  }, [activeSession, durableReadingSources, readingContextSourcesRef])

  const reconcileReadingContextSources = useCallback(
    (requestedSources: SessionPdfContextSource[]): Promise<void> => {
      if (!activeSession) return Promise.resolve()
      const operationRuntime = readingMutationRuntimeRef.current
      if (!operationRuntime) return Promise.resolve()
      const uniqueSources = [
        ...new Map(requestedSources.map((source) => [pdfContextSourceKey(source), source])).values()
      ].slice(0, MAX_SESSION_PDF_CONTEXTS)
      readingContextSourcesRef.current = uniqueSources
      if (readingMutationPromiseRef.current) {
        const pending = readingMutationPromiseRef.current
        if (readingMutationPromiseRuntimeRef.current === operationRuntime) return pending
        return pending
          .catch(() => undefined)
          .then(() => {
            // Leaving the originating Project/Session invalidates this queued intent, even
            // if the user returns before the preceding IPC finishes.
            if (readingMutationRuntimeRef.current !== operationRuntime) return
            return restoreReadingContextSourcesRef.current(readingContextSourcesRef.current)
          })
      }
      const currentSources = (
        readingMutationRuntimeRef.current?.runtimeContext.pdfContext?.bindings ?? []
      ).map(({ sourceKind, sourceFileId, sourceVersionId }) => ({
        sourceKind,
        sourceFileId,
        sourceVersionId
      }))
      if (samePdfContextSources(uniqueSources, currentSources)) return Promise.resolve()

      const operationSessionId = activeSession.id
      const operationProjectId = activeSession.projectId
      setError(null)
      setIsPdfContextPending(true)
      const run = (async (): Promise<void> => {
        try {
          while (readingMutationRuntimeRef.current === operationRuntime) {
            const runtime = readingMutationRuntimeRef.current.runtimeContext
            const target = readingContextSourcesRef.current
            const targetKeys = new Set(target.map(pdfContextSourceKey))
            const currentBindings = runtime.pdfContext?.bindings ?? []
            const removed = currentBindings.find(
              (binding) => !targetKeys.has(pdfContextSourceKey(binding))
            )
            if (removed) {
              setPdfContextPendingBindingId(removed.bindingId)
              const nextRuntime = await window.api.sessions.unlinkPdfContext({
                projectId: operationProjectId,
                sessionId: operationSessionId,
                expectedRevision: runtime.revision,
                bindingId: removed.bindingId
              })
              if (readingMutationRuntimeRef.current !== operationRuntime) return
              readingMutationRuntimeRef.current.runtimeContext = nextRuntime
              usePreviewWorkbenchStore.getState().clearPdfReadingPosition(removed.bindingId)
              continue
            }

            const currentKeys = new Set(currentBindings.map(pdfContextSourceKey))
            const added = target.filter((source) => !currentKeys.has(pdfContextSourceKey(source)))
            if (added.length > 0) {
              const nextRuntime = await window.api.sessions.linkPdfContext({
                projectId: operationProjectId,
                sessionId: operationSessionId,
                expectedRevision: runtime.revision,
                sources: added
              })
              if (readingMutationRuntimeRef.current !== operationRuntime) return
              readingMutationRuntimeRef.current.runtimeContext = nextRuntime
              continue
            }
            break
          }
        } catch (error) {
          if (readingMutationRuntimeRef.current !== operationRuntime) throw error
          const currentBindings =
            readingMutationRuntimeRef.current?.runtimeContext.pdfContext?.bindings ?? []
          readingContextSourcesRef.current = currentBindings.map(
            ({ sourceKind, sourceFileId, sourceVersionId }) => ({
              sourceKind,
              sourceFileId,
              sourceVersionId
            })
          )
          setError(error instanceof Error ? error.message : String(error))
          if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(operationSessionId)
          throw error
        }
      })()
      const tracked = run.finally(() => {
        if (readingMutationPromiseRef.current !== tracked) return
        readingMutationPromiseRef.current = undefined
        readingMutationPromiseRuntimeRef.current = undefined
        setPdfContextPendingBindingId(undefined)
        setIsPdfContextPending(false)
      })
      readingMutationPromiseRef.current = tracked
      readingMutationPromiseRuntimeRef.current = operationRuntime
      return tracked
    },
    [activeSession, onSessionSizeLimit, setError]
  )
  useLayoutEffect(() => {
    restoreReadingContextSourcesRef.current = reconcileReadingContextSources
  }, [reconcileReadingContextSources])

  const beginReadingContextUndo = useCallback(() => {
    const draftKey = activeDraftKeyRef.current
    clearPastedTextUndo(draftKey)
    clearHistory(draftKey)
    markChanged(draftKey)
    return beginUndoTransaction(draftKey)
  }, [beginUndoTransaction, clearHistory, clearPastedTextUndo, markChanged])

  const linkReadingContext = useCallback(
    async (source: SessionPdfContextSource): Promise<void> => {
      if (!activeSession) return
      const current = readingContextSourcesRef.current
      if (
        current.some((candidate) => pdfContextSourceKey(candidate) === pdfContextSourceKey(source))
      )
        return
      const transaction =
        !readingMutationPromiseRef.current ||
        readingMutationPromiseRuntimeRef.current !== readingMutationRuntimeRef.current
          ? beginReadingContextUndo()
          : undefined
      try {
        await reconcileReadingContextSources([...current, source])
        transaction?.commit()
      } catch (error) {
        transaction?.rollback(readingContextSourcesRef.current)
        throw error
      }
    },
    [activeSession, beginReadingContextUndo, reconcileReadingContextSources]
  )
  const openReadingContext = useCallback(
    (bindingId: string): void => {
      const durableBinding = durableReadingBindings.find(
        (binding) => binding.bindingId === bindingId
      )
      if (durableBinding && activeSession) {
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(
            createPreviewFileItemFromPdfContext(durableBinding, activeSession.projectId)
          )
        return
      }
      const pending = pendingReadingItems.find(
        ({ selection }) => pendingPdfContextBindingId(selection) === bindingId
      )
      if (pending?.item && pending.selection.kind === 'version') {
        const preview = usePreviewWorkbenchStore.getState()
        preview.activateItem(pending.item.id)
        preview.openPanel()
        return
      }
      const staged =
        pending?.selection.kind === 'staged-upload'
          ? attachments.find(
              ({ id }) =>
                pending.selection.kind === 'staged-upload' && id === pending.selection.attachmentId
            )
          : undefined
      if (!staged || !activeProjectId) return
      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(
          createPreviewFileItemFromUpload(staged, staged.sessionId, activeProjectId)
        )
    },
    [activeProjectId, activeSession, durableReadingBindings, attachments, pendingReadingItems]
  )
  const unlinkReadingContext = useCallback(
    (bindingId: string): void => {
      const pending = pendingReadingSelections.find(
        (selection) => pendingPdfContextBindingId(selection) === bindingId
      )
      if (pending && activeProjectId && !activeSession) {
        usePreviewWorkbenchStore.getState().clearPdfReadingPosition(bindingId)
        usePreviewWorkbenchStore.getState().clearPendingPdfContext(activeProjectId, pending)
        return
      }
      const durableBinding = durableReadingBindings.find(
        (binding) => binding.bindingId === bindingId
      )
      if (!durableBinding || !activeSession) return
      const transaction =
        !readingMutationPromiseRef.current ||
        readingMutationPromiseRuntimeRef.current !== readingMutationRuntimeRef.current
          ? beginReadingContextUndo()
          : undefined
      void reconcileReadingContextSources(
        readingContextSourcesRef.current.filter(
          (source) => pdfContextSourceKey(source) !== pdfContextSourceKey(durableBinding)
        )
      ).then(
        () => transaction?.commit(),
        () => transaction?.rollback(readingContextSourcesRef.current)
      )
    },
    [
      activeProjectId,
      activeSession,
      beginReadingContextUndo,
      durableReadingBindings,
      pendingReadingSelections,
      reconcileReadingContextSources
    ]
  )
  const dismissAutomaticReading = useCallback((): void => {
    if (!automaticReadingEnabledRef.current) return
    clearPastedTextUndo()
    clearHistory(activeDraftKeyRef.current)
    captureUndo()
    markChanged()
    setActiveAutomaticReadingEnabled(false)
  }, [
    captureUndo,
    clearHistory,
    clearPastedTextUndo,
    markChanged,
    setActiveAutomaticReadingEnabled
  ])

  const removeComposerAttachment = useCallback(
    (attachment: UploadedAttachment): void => {
      const pending = pendingReadingSelections.find(
        (selection) =>
          selection.kind === 'staged-upload' && selection.attachmentId === attachment.id
      )
      if (pending && activeProjectId) {
        usePreviewWorkbenchStore.getState().clearPendingPdfContext(activeProjectId, pending)
      }
      removeAttachment(attachment)
    },
    [activeProjectId, pendingReadingSelections, removeAttachment]
  )

  useLayoutEffect(() => {
    docRef.current = doc
  }, [doc])

  useLayoutEffect(() => {
    annotationsRef.current = annotations
  }, [annotations])

  const { loadSkills, refreshSkillCatalog } = historyPolicy
  const ready = skillCatalogReady || historyPolicy.skillCatalogReady || !refreshSkillCatalog
  useEffect(() => {
    if (!refreshSkillCatalog) return
    let active = true
    void loadSkills()
      .then(() => {
        if (active) setSkillCatalogReady(true)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [loadSkills, refreshSkillCatalog])

  useLayoutEffect(() => {
    const previousDraftKey = activeDraftKeyRef.current
    if (currentDraftKey === previousDraftKey) return

    const outgoingHistory = historyRef.current[previousDraftKey]
    if (deletedDraftKeysRef.current.delete(previousDraftKey)) {
      delete draftsRef.current[previousDraftKey]
    } else {
      draftsRef.current[previousDraftKey] = {
        setupSessionToken: setupSessionTokenRef.current,
        doc: outgoingHistory?.scratch ?? doc,
        annotations,
        attachments,
        attachmentTransfers: transfers,
        queuedEdit: queuedEditRef.current,
        automaticReadingEnabled: automaticReadingEnabledRef.current
      }
    }
    const outgoingDraft = draftsRef.current[previousDraftKey]
    if (outgoingDraft) writeComposerDraft(projectIdRef.current, previousDraftKey, outgoingDraft)
    projectIdRef.current = activeProjectId ?? 'default-project'
    draftProjectsRef.current[currentDraftKey] = projectIdRef.current
    delete historyRef.current[previousDraftKey]
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('')
    setCaretRequest(undefined)

    const nextDraft =
      draftsRef.current[currentDraftKey] ??
      readComposerDraft(activeProjectId ?? 'default-project', currentDraftKey, retryMessage) ??
      blank()
    setActiveDoc(nextDraft.doc)
    setActiveAnnotations(nextDraft.annotations)
    activateDraftAttachments(nextDraft)
    setActiveAutomaticReadingEnabled(nextDraft.automaticReadingEnabled)
    setActiveQueuedEdit(nextDraft.queuedEdit)
    setActiveSetupSessionToken(nextDraft.setupSessionToken)
    activeDraftKeyRef.current = currentDraftKey
    delete draftsRef.current[currentDraftKey]
  }, [
    activeProjectId,
    annotations,
    attachments,
    currentDraftKey,
    doc,
    deletedDraftKeysRef,
    draftsRef,
    setActiveAutomaticReadingEnabled,
    setActiveQueuedEdit,
    setActiveSetupSessionToken,
    activateDraftAttachments,
    setActiveAnnotations,
    setActiveDoc,
    transfers,
    retryMessage
  ])

  // Save the outgoing draft and activate the target before applying its prefill.
  useLayoutEffect(() => {
    const pendingConversationPrefill = pendingWslSupportPrefill
      ? { ...pendingWslSupportPrefill, kind: 'wsl-support' as const }
      : pendingCustomizePrefill
        ? {
            ...pendingCustomizePrefill,
            kind: 'customize' as const,
            doc: buildCustomizePrefillDoc(pendingCustomizePrefill.goal)
          }
        : undefined
    const applied = appliedConversationPrefillRef.current
    if (
      !pendingConversationPrefill ||
      pendingConversationPrefill.projectId !== activeProjectId ||
      currentDraftKey !== newConversationDraftKey ||
      (applied?.kind === pendingConversationPrefill.kind &&
        applied.projectId === pendingConversationPrefill.projectId &&
        applied.requestId === pendingConversationPrefill.requestId)
    )
      return
    appliedConversationPrefillRef.current = pendingConversationPrefill
    clearHistory(currentDraftKey)
    clearPastedTextUndo(currentDraftKey)
    clearUndo(currentDraftKey)
    markChanged(currentDraftKey)
    setActiveDoc(pendingConversationPrefill.doc)
    if (pendingConversationPrefill.kind === 'wsl-support') {
      setActiveSetupSessionToken(pendingConversationPrefill.setupSessionToken)
      onWslSupportPrefillApplied()
    } else {
      setActiveSetupSessionToken(undefined)
      onCustomizePrefillApplied()
    }
  }, [
    activeProjectId,
    clearHistory,
    clearPastedTextUndo,
    clearUndo,
    currentDraftKey,
    markChanged,
    newConversationDraftKey,
    onCustomizePrefillApplied,
    onWslSupportPrefillApplied,
    pendingCustomizePrefill,
    pendingWslSupportPrefill,
    setActiveDoc,
    setActiveSetupSessionToken
  ])

  const navigateHistory = useCallback(
    (direction: 'previous' | 'next'): boolean => {
      if (queuedEditRef.current || attachments.length > 0 || transfers.length > 0) return false

      let navigation = historyRef.current[currentDraftKey]
      const previousCursorId = navigation?.cursorId
      if (!navigation) {
        if (direction === 'next' || historyEntries.length === 0) return false
        navigation = {
          entries: historyEntries,
          cursorId: historyEntries[0].id,
          scratch: doc
        }
        historyRef.current[currentDraftKey] = navigation
      } else {
        const cursor = navigation.entries.findIndex((entry) => entry.id === navigation.cursorId)
        if (cursor < 0) return false
        if (direction === 'next' && cursor === 0) {
          delete historyRef.current[currentDraftKey]
          markChanged(currentDraftKey)
          clearPastedTextUndo(currentDraftKey)
          clearUndo(currentDraftKey)
          setActiveDoc(navigation.scratch)
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
        (!ready ||
          (historyPolicy.specialistId !== undefined && !historyPolicy.specialistCatalogReady))
      ) {
        if (previousCursorId) navigation.cursorId = previousCursorId
        else delete historyRef.current[currentDraftKey]
        if (!ready) {
          void historyPolicy
            .loadSkills()
            .then(() => setSkillCatalogReady(true))
            .catch(() => undefined)
        }
        if (historyPolicy.specialistId !== undefined && !historyPolicy.specialistCatalogReady) {
          void historyPolicy.loadSpecialists()
        }
        setHistoryStatus('Prompt history is loading. Press Up Arrow again shortly.')
        return false
      }

      const normalized = normalizeHistorySkills(
        entry.doc,
        historyPolicy.catalogSkillIds,
        historyPolicy.allowedSkillIds
      )
      markChanged(currentDraftKey)
      clearPastedTextUndo(currentDraftKey)
      clearUndo(currentDraftKey)
      setActiveDoc(normalized.doc)
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
      attachments.length,
      currentDraftKey,
      doc,
      historyEntries,
      historyPolicy,
      markChanged,
      ready,
      clearPastedTextUndo,
      clearUndo,
      setActiveDoc,
      transfers.length
    ]
  )

  useEffect(() => {
    if (
      historyBrowsingKey !== currentDraftKey ||
      !ready ||
      (historyPolicy.specialistId !== undefined && !historyPolicy.specialistCatalogReady)
    ) {
      return
    }
    const navigation = historyRef.current[currentDraftKey]
    const cursor = navigation?.entries.findIndex((entry) => entry.id === navigation.cursorId) ?? -1
    const entry = navigation?.entries[cursor]
    if (!navigation || !entry) return
    const normalized = normalizeHistorySkills(
      entry.doc,
      historyPolicy.catalogSkillIds,
      historyPolicy.allowedSkillIds
    )
    if (JSON.stringify(normalized.doc) !== JSON.stringify(doc)) {
      markChanged(currentDraftKey)
      clearPastedTextUndo(currentDraftKey)
      clearUndo(currentDraftKey)
      setActiveDoc(normalized.doc)
    }
    setHistoryStatus(
      `History item ${cursor + 1} of ${navigation.entries.length}${
        normalized.unavailableSkillNames.length > 0
          ? `. ${normalized.unavailableSkillNames.map((name) => `/${name}`).join(', ')} unavailable`
          : ''
      }`
    )
  }, [
    clearPastedTextUndo,
    clearUndo,
    currentDraftKey,
    doc,
    historyBrowsingKey,
    historyPolicy,
    markChanged,
    ready,
    setActiveDoc
  ])

  useEffect(() => {
    if (historyBrowsingKey !== currentDraftKey) return
    const navigation = historyRef.current[currentDraftKey]
    if (!navigation) return
    const visibleIds = new Set(historyEntries.map((entry) => entry.id))
    const sourcesStillVisible = navigation.entries.every((entry) => visibleIds.has(entry.id))
    if (
      sourcesStillVisible &&
      (!activeSession || navigation.entries.length === historyEntries.length)
    )
      return
    delete historyRef.current[currentDraftKey]
    markChanged(currentDraftKey)
    clearPastedTextUndo(currentDraftKey)
    clearUndo(currentDraftKey)
    setActiveDoc(navigation.scratch)
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('Draft restored')
  }, [
    clearPastedTextUndo,
    clearUndo,
    currentDraftKey,
    activeSession,
    historyBrowsingKey,
    historyEntries,
    markChanged,
    setActiveDoc
  ])

  const captureSend = useCallback(
    (includeReadingContext = true): ComposerSendSnapshot => {
      clearPastedTextUndo()
      clearUndo()
      const pendingPdfContextAttachmentIds =
        stagedReadingContexts.length > 0
          ? [...stagedReadingContexts]
              .sort((left, right) =>
                activePendingReading?.kind === 'staged-upload'
                  ? Number(right.id === activePendingReading.attachmentId) -
                    Number(left.id === activePendingReading.attachmentId)
                  : 0
              )
              .map(({ id }) => id)
          : automaticReadingEnabledRef.current
            ? automaticStagedReadingContexts.map(({ id }) => id)
            : []
      const includedDurableBindings = includeReadingContext ? durableReadingBindings : []
      const occupied = new Set(
        includedDurableBindings.map(
          ({ sourceKind, sourceVersionId }) => `${sourceKind}:${sourceVersionId}`
        )
      )
      const candidates: SessionPdfContextSource[] = [
        ...(includeReadingContext
          ? [...pendingReadingSelections]
              .sort(
                (left, right) =>
                  Number(right === activePendingReading) - Number(left === activePendingReading)
              )
              .flatMap((selection) =>
                selection.kind === 'version'
                  ? [
                      {
                        sourceKind: selection.sourceKind,
                        sourceFileId: selection.sourceFileId,
                        sourceVersionId: selection.sourceVersionId
                      }
                    ]
                  : []
              )
          : []),
        ...docToPdfContextSources(docRef.current)
      ]
      const pendingPdfContextVersions = candidates
        .filter((source) => {
          const identity = `${source.sourceKind}:${source.sourceVersionId}`
          if (occupied.has(identity)) return false
          occupied.add(identity)
          return true
        })
        .slice(0, Math.max(0, MAX_SESSION_PDF_CONTEXTS - includedDurableBindings.length))
      return {
        setupSessionToken: setupSessionTokenRef.current,
        draftKey: activeDraftKeyRef.current,
        version: versionsRef.current[activeDraftKeyRef.current] ?? 0,
        doc: docRef.current,
        annotations: [...annotationsRef.current],
        attachments,
        queuedEdit: queuedEditRef.current,
        automaticReadingEnabled: automaticReadingEnabledRef.current,
        ...(includeReadingContext && durableReadingContext
          ? {
              pdfContext: {
                ...durableReadingContext,
                ...(activeReadingBinding
                  ? { activeBindingId: activeReadingBinding.bindingId }
                  : {}),
                ...(activeReadingBinding && pdfReadingPosition
                  ? { readingPosition: pdfReadingPosition }
                  : {})
              }
            }
          : {}),
        ...(includeReadingContext && pdfReadingPosition
          ? {
              pdfReadingPosition,
              pdfReadingPositionSource: activeReadingBinding
                ? {
                    sourceKind: activeReadingBinding.sourceKind,
                    sourceVersionId: activeReadingBinding.sourceVersionId
                  }
                : activePendingReading?.kind === 'staged-upload'
                  ? { attachmentId: activePendingReading.attachmentId }
                  : activePendingReading
                    ? {
                        sourceKind: activePendingReading.sourceKind,
                        sourceVersionId: activePendingReading.sourceVersionId
                      }
                    : undefined
            }
          : {}),
        ...(pendingPdfContextAttachmentIds.length > 0 ? { pendingPdfContextAttachmentIds } : {}),
        ...(pendingPdfContextVersions.length > 0 ? { pendingPdfContextVersions } : {})
      }
    },
    [
      attachments,
      activeReadingBinding,
      activePendingReading,
      automaticStagedReadingContexts,
      clearPastedTextUndo,
      clearUndo,
      durableReadingContext,
      durableReadingBindings,
      pendingReadingSelections,
      pdfReadingPosition,
      stagedReadingContexts,
      versionsRef
    ]
  )
  const clearDraft = useCallback(
    (draftKey: string, expectedVersion?: number): boolean => {
      const currentVersion = versionsRef.current[draftKey] ?? 0
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) return false
      clearHistory(draftKey)
      clearPastedTextUndo(draftKey)
      clearUndo(draftKey)
      delete draftsRef.current[draftKey]
      writeComposerDraft(
        draftProjectsRef.current[draftKey] ?? projectIdRef.current,
        draftKey,
        blank()
      )
      if (activeDraftKeyRef.current !== draftKey) return true
      setActiveSetupSessionToken(undefined)
      setActiveDoc(emptyDoc)
      setActiveQueuedEdit(undefined)
      setActiveAnnotations([])
      clearActiveAttachments()
      setActiveAutomaticReadingEnabled(true)
      setError(null)
      return true
    },
    [
      draftsRef,
      versionsRef,
      clearActiveAttachments,
      clearHistory,
      clearPastedTextUndo,
      clearUndo,
      setActiveAnnotations,
      setActiveDoc,
      setActiveAutomaticReadingEnabled,
      setActiveQueuedEdit,
      setActiveSetupSessionToken,
      setError
    ]
  )
  const restoreFailedSend = useCallback(
    (snapshot: ComposerSendSnapshot, preserveOnConflict = false): boolean => {
      if (deletedDraftKeysRef.current.has(snapshot.draftKey)) {
        if (!preserveOnConflict)
          releaseHistoryResources([{ attachments: snapshot.attachments, attachmentTransfers: [] }])
        return false
      }
      if (
        preserveOnConflict &&
        (activeDraftKeyRef.current !== snapshot.draftKey ||
          !docIsEmpty(docRef.current) ||
          annotationsRef.current.length > 0 ||
          attachments.length > 0 ||
          transfers.length > 0 ||
          queuedEditRef.current)
      )
        return false
      if (
        !preserveOnConflict &&
        (versionsRef.current[snapshot.draftKey] ?? 0) !== snapshot.version
      ) {
        setError(
          t(
            'Sending failed. Your newer draft was kept. Copy the earlier draft from the details below.'
          ),
          [
            docToText(snapshot.doc),
            ...snapshot.annotations.map((annotation) => JSON.stringify(annotation)),
            ...snapshot.attachments.map((attachment) => attachment.originalName || attachment.name)
          ].join('\n')
        )
        releaseHistoryResources([{ attachments: snapshot.attachments, attachmentTransfers: [] }])
        return false
      }
      if (preserveOnConflict) markChanged(snapshot.draftKey)
      clearUndo(snapshot.draftKey)
      clearPastedTextUndo(snapshot.draftKey)
      clearHistory(snapshot.draftKey)
      if (activeDraftKeyRef.current === snapshot.draftKey) {
        setActiveSetupSessionToken(snapshot.setupSessionToken)
        setActiveQueuedEdit(snapshot.queuedEdit)
        setActiveDoc(snapshot.doc)
        setActiveAnnotations([...snapshot.annotations])
        setActiveAttachments(snapshot.attachments)
        setActiveAutomaticReadingEnabled(snapshot.automaticReadingEnabled !== false)
        return true
      }
      draftsRef.current[snapshot.draftKey] = {
        setupSessionToken: snapshot.setupSessionToken,
        queuedEdit: snapshot.queuedEdit,
        doc: snapshot.doc,
        annotations: [...snapshot.annotations],
        attachments: snapshot.attachments,
        attachmentTransfers: draftsRef.current[snapshot.draftKey]?.attachmentTransfers ?? [],
        automaticReadingEnabled: snapshot.automaticReadingEnabled !== false
      }
      return true
    },
    [
      attachments.length,
      draftsRef,
      versionsRef,
      deletedDraftKeysRef,
      clearUndo,
      clearPastedTextUndo,
      clearHistory,
      markChanged,
      setActiveQueuedEdit,
      setActiveSetupSessionToken,
      releaseHistoryResources,
      setActiveAttachments,
      setActiveAnnotations,
      setActiveDoc,
      setActiveAutomaticReadingEnabled,
      transfers.length,
      setError,
      t
    ]
  )

  const captureRevision = useCallback(
    (revisionDoc: ComposerDoc, revisionAnnotations: Annotation[]): ComposerSendSnapshot => ({
      draftKey: currentDraftKey,
      version: versionsRef.current[currentDraftKey] ?? 0,
      doc: revisionDoc,
      annotations: [...revisionAnnotations],
      attachments: [],
      automaticReadingEnabled: true
    }),
    [currentDraftKey, versionsRef]
  )
  // Stable identity across renders: the transcript memo compares the annotation callbacks it
  // receives, so an inline closure here would defeat that memo on every composer re-render.
  const addAnnotation = useCallback(
    (annotation: Annotation): AnnotationValidationError | undefined => {
      const next = [...annotationsRef.current, annotation]
      const validation = validateAnnotations(next, docToText(docRef.current))
      if (validation) return validation
      clearPastedTextUndo()
      clearHistory(activeDraftKeyRef.current)
      captureUndo()
      markChanged()
      setActiveAnnotations(next)
      return undefined
    },
    [captureUndo, clearHistory, clearPastedTextUndo, markChanged, setActiveAnnotations]
  )

  return {
    view: {
      queuedEdit,
      doc,
      annotations,
      attachments,
      transfers,
      error,
      errorDetail,
      historyStatus,
      isHistoryBrowsing: historyBrowsingKey === currentDraftKey,
      isUploading,
      isWslSetupDraft: setupSessionToken !== undefined,
      caretRequest,
      // The live reading position stays out of the view: the chip no longer displays it, and
      // captureSend snapshots it straight from the store.
      readingContext: {
        bindings: readingContexts,
        pendingBindingId: pdfContextPendingBindingId,
        isPending: isPdfContextPending,
        automaticAttachmentCount: automaticReadingEnabled
          ? automaticStagedReadingContexts.length
          : 0
      }
    },
    actions: {
      cancelQueuedEdit: (): void => {
        clearUndo()
        clearHistory(activeDraftKeyRef.current)
        markChanged()
        setActiveQueuedEdit(undefined)
      },
      discardWslSetupDraft: (): boolean => {
        if (setupSessionTokenRef.current === undefined) return false
        return clearDraft(activeDraftKeyRef.current)
      },
      changeDoc,
      addAnnotation,
      updateAnnotationNote: (id, note): AnnotationValidationError | undefined => {
        const next = annotationsRef.current.map((annotation) =>
          annotation.id === id
            ? annotation.kind === 'text'
              ? { ...annotation, note: note.trim() || undefined }
              : { ...annotation, note: note.trim() }
            : annotation
        )
        const validation = validateAnnotations(next, docToText(docRef.current))
        if (validation) return validation
        clearPastedTextUndo()
        clearHistory(activeDraftKeyRef.current)
        captureUndo()
        markChanged()
        setActiveAnnotations(next)
        return undefined
      },
      removeAnnotation: (id): void => {
        const next = annotationsRef.current.filter((annotation) => annotation.id !== id)
        if (next.length === annotationsRef.current.length) return
        clearPastedTextUndo()
        clearHistory(activeDraftKeyRef.current)
        captureUndo()
        markChanged()
        setActiveAnnotations(next)
      },
      navigateHistory,
      stageFiles,
      stagePastedText,
      cancelTransfer,
      retryTransfer,
      removeAttachment: removeComposerAttachment,
      restorePastedText,
      undo,
      redo,
      setError,
      linkReadingContext,
      openReadingContext,
      unlinkReadingContext,
      dismissAutomaticReading
    },
    lifecycle: {
      captureSend,
      captureRevision,
      clearDraft,
      restoreFailedSend,
      discardSnapshot: (snapshot) =>
        releaseHistoryResources([{ attachments: snapshot.attachments, attachmentTransfers: [] }]),
      hasUnfinishedTransfers,
      beginSessionDeletion,
      settleSessionDeletion: (draftKey, deleted): void => {
        settleSessionDeletion(draftKey, deleted)
        if (!deleted) return
        removeComposerDrafts(draftProjectsRef.current[draftKey] ?? projectIdRef.current, draftKey)
        delete draftsRef.current[draftKey]
        delete versionsRef.current[draftKey]
        deletedDraftKeysRef.current.add(draftKey)
        if (activeDraftKeyRef.current !== draftKey) return
        setActiveSetupSessionToken(undefined)
        clearHistory(draftKey)
        setActiveDoc(emptyDoc)
        setActiveQueuedEdit(undefined)
        setActiveAnnotations([])
        clearActiveAttachments()
        setError(null)
      }
    }
  }
}
export { useWorkspaceComposerController, type WorkspaceComposerController }

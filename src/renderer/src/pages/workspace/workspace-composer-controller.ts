import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  validateAnnotations,
  type Annotation,
  type AnnotationValidationError
} from '../../../../shared/annotations'
import {
  MAX_SESSION_PDF_CONTEXTS,
  type MessagePdfContextSnapshot,
  type PdfReadingPosition,
  type SessionPdfBinding,
  type SessionPdfContext,
  type SessionPdfContextSource
} from '../../../../shared/session-persistence'
import { buildCustomizePrefillDoc } from '@/lib/customize-chat'
import type { CustomizePrefillIntent } from '@/stores/navigation-store'
import {
  pendingPdfContextBindingId,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'

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
  draftKey: string
  version: number
  doc: ComposerDoc
  annotations: Annotation[]
  attachments: UploadedAttachment[]
  automaticReadingEnabled?: boolean
  pdfContext?: MessagePdfContextSnapshot
  pdfReadingPosition?: PdfReadingPosition
  pendingPdfContextAttachmentIds?: string[]
  pendingPdfContextVersions?: Array<{
    sourceKind: 'artifact-version' | 'upload-version'
    sourceFileId: string
    sourceVersionId: string
  }>
}

type WorkspaceComposerControllerInput = {
  currentDraftKey: string
  newConversationDraftKey: string
  activeProjectId: string | undefined
  pendingCustomizePrefill: CustomizePrefillIntent | undefined
  onCustomizePrefillApplied: () => void
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
}

type WorkspaceComposerController = {
  view: {
    doc: ComposerDoc
    annotations: Annotation[]
    attachments: UploadedAttachment[]
    transfers: ComposerUploadTransfer[]
    error: string | null
    errorDetail?: string
    historyStatus: string
    isHistoryBrowsing: boolean
    isUploading: boolean
    caretRequest: { key: number; position: ComposerCaretPosition } | undefined
    readingContext: {
      bindings: ComposerReadingContextBinding[]
      pendingBindingId: string | undefined
      isPending: boolean
      automaticAttachmentCount: number
    }
  }
  actions: {
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
  onCustomizePrefillApplied,
  historyEntries,
  activeSession,
  historyPolicy,
  canStageAttachments,
  supportsImageInput,
  uploads
}: WorkspaceComposerControllerInput): WorkspaceComposerController => {
  const [doc, setDoc] = useState<ComposerDoc>(emptyDoc)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [historyBrowsingKey, setHistoryBrowsingKey] = useState<string>()
  const [historyStatus, setHistoryStatus] = useState('')
  const [skillCatalogReady, setSkillCatalogReady] = useState(historyPolicy.skillCatalogReady)
  const [appliedCustomizePrefill, setAppliedCustomizePrefill] = useState<CustomizePrefillIntent>()
  const [caretRequest, setCaretRequest] = useState<{
    key: number
    position: ComposerCaretPosition
  }>()
  const activeDraftKeyRef = useRef(currentDraftKey)
  const docRef = useRef(doc)
  const annotationsRef = useRef(annotations)
  const [automaticReadingEnabled, setAutomaticReadingEnabled] = useState(true)
  const automaticReadingEnabledRef = useRef(true)
  const draftsRef = useRef<Record<string, ComposerDraft>>({})
  const versionsRef = useRef<Record<string, number>>({})
  const deletedDraftKeysRef = useRef(new Set<string>())
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

  const markChanged = useCallback((draftKey = activeDraftKeyRef.current): void => {
    versionsRef.current[draftKey] = (versionsRef.current[draftKey] ?? 0) + 1
  }, [])

  const clearHistory = useCallback((draftKey: string): void => {
    delete historyRef.current[draftKey]
    setHistoryBrowsingKey((current) => (current === draftKey ? undefined : current))
    if (activeDraftKeyRef.current === draftKey) setHistoryStatus('')
  }, [])

  const uploadController = useWorkspaceComposerUploadController({
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
    activateDraftAttachments,
    clearActiveAttachments,
    setActiveAttachments,
    deleteAttachmentFiles,
    hasUnfinishedTransfers,
    beginSessionDeletion,
    settleSessionDeletion
  } = uploadController.lifecycle
  const pendingPdfContextSelection = usePreviewWorkbenchStore((state) =>
    !activeSession && activeProjectId
      ? state.pendingPdfContextByProject[activeProjectId]
      : undefined
  )
  const stagedReadingContext =
    pendingPdfContextSelection?.kind === 'staged-upload'
      ? attachments.find((attachment) => attachment.id === pendingPdfContextSelection.attachmentId)
      : undefined
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
  const versionReadingContextItem = usePreviewWorkbenchStore((state) => {
    if (pendingPdfContextSelection?.kind !== 'version') return undefined
    const item = state.items.find(
      (candidate) => candidate.id === pendingPdfContextSelection.previewItemId
    )
    return item?.type === 'file' ? item : undefined
  })
  const readingContexts: ComposerReadingContextBinding[] =
    durableReadingBindings.length > 0
      ? [...durableReadingBindings]
      : stagedReadingContext || versionReadingContextItem
        ? [
            {
              bindingId:
                pendingPdfContextSelection !== undefined
                  ? pendingPdfContextBindingId(pendingPdfContextSelection)
                  : `staged:${stagedReadingContext!.id}`,
              name: stagedReadingContext?.name ?? versionReadingContextItem!.name,
              draftSelection: true as const
            }
          ]
        : []
  const activePreviewItemId = usePreviewWorkbenchStore((state) => state.activeItemId)
  const activeReadingBinding =
    durableReadingBindings.find(
      (binding) =>
        activeSession &&
        createPreviewFileItemFromPdfContext(binding, activeSession.projectId).id ===
          activePreviewItemId
    ) ?? durableReadingBindings[0]
  const readingPositionBindingId =
    activeReadingBinding?.bindingId ??
    (pendingPdfContextSelection
      ? pendingPdfContextBindingId(pendingPdfContextSelection)
      : undefined)
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
    if (
      pendingPdfContextSelection?.kind !== 'staged-upload' ||
      stagedReadingContext ||
      !activeProjectId
    ) {
      return
    }
    usePreviewWorkbenchStore.getState().setPendingPdfContext(activeProjectId, undefined)
  }, [activeProjectId, pendingPdfContextSelection, stagedReadingContext])
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
  const readingMutationPromiseSessionIdRef = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const current = readingMutationRuntimeRef.current
    if (
      activeSession &&
      (current?.sessionId !== activeSession.id ||
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
      const uniqueSources = [
        ...new Map(requestedSources.map((source) => [pdfContextSourceKey(source), source])).values()
      ].slice(0, MAX_SESSION_PDF_CONTEXTS)
      readingContextSourcesRef.current = uniqueSources
      if (readingMutationPromiseRef.current) {
        const pending = readingMutationPromiseRef.current
        if (readingMutationPromiseSessionIdRef.current === activeSession.id) return pending
        return pending
          .catch(() => undefined)
          .then(() => restoreReadingContextSourcesRef.current(uniqueSources))
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
          while (readingMutationRuntimeRef.current?.sessionId === operationSessionId) {
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
              if (readingMutationRuntimeRef.current?.sessionId !== operationSessionId) return
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
              if (readingMutationRuntimeRef.current?.sessionId !== operationSessionId) return
              readingMutationRuntimeRef.current.runtimeContext = nextRuntime
              continue
            }
            break
          }
        } catch (error) {
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
          throw error
        }
      })()
      const tracked = run.finally(() => {
        if (readingMutationPromiseRef.current !== tracked) return
        readingMutationPromiseRef.current = undefined
        readingMutationPromiseSessionIdRef.current = undefined
        setPdfContextPendingBindingId(undefined)
        setIsPdfContextPending(false)
      })
      readingMutationPromiseRef.current = tracked
      readingMutationPromiseSessionIdRef.current = operationSessionId
      return tracked
    },
    [activeSession, setError]
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
        readingMutationPromiseSessionIdRef.current !== activeSession.id
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
      if (versionReadingContextItem) {
        const preview = usePreviewWorkbenchStore.getState()
        preview.activateItem(versionReadingContextItem.id)
        preview.openPanel()
        return
      }
      if (!stagedReadingContext || !activeProjectId) return
      usePreviewWorkbenchStore
        .getState()
        .upsertAndActivateItem(
          createPreviewFileItemFromUpload(
            stagedReadingContext,
            stagedReadingContext.sessionId,
            activeProjectId
          )
        )
    },
    [
      activeProjectId,
      activeSession,
      durableReadingBindings,
      stagedReadingContext,
      versionReadingContextItem
    ]
  )
  const unlinkReadingContext = useCallback(
    (bindingId: string): void => {
      if (pendingPdfContextSelection && activeProjectId && !activeSession) {
        usePreviewWorkbenchStore
          .getState()
          .clearPdfReadingPosition(pendingPdfContextBindingId(pendingPdfContextSelection))
        usePreviewWorkbenchStore.getState().setPendingPdfContext(activeProjectId, undefined)
        return
      }
      const durableBinding = durableReadingBindings.find(
        (binding) => binding.bindingId === bindingId
      )
      if (!durableBinding || !activeSession) return
      const transaction =
        !readingMutationPromiseRef.current ||
        readingMutationPromiseSessionIdRef.current !== activeSession.id
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
      pendingPdfContextSelection,
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
      if (
        pendingPdfContextSelection?.kind === 'staged-upload' &&
        attachment.id === pendingPdfContextSelection.attachmentId &&
        activeProjectId
      ) {
        usePreviewWorkbenchStore.getState().setPendingPdfContext(activeProjectId, undefined)
      }
      removeAttachment(attachment)
    },
    [activeProjectId, pendingPdfContextSelection, removeAttachment]
  )

  if (
    pendingCustomizePrefill !== undefined &&
    pendingCustomizePrefill.projectId === activeProjectId &&
    currentDraftKey === newConversationDraftKey &&
    appliedCustomizePrefill?.requestId !== pendingCustomizePrefill.requestId
  ) {
    setAppliedCustomizePrefill(pendingCustomizePrefill)
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('')
    setDoc(buildCustomizePrefillDoc(pendingCustomizePrefill.goal))
    onCustomizePrefillApplied()
  }

  useLayoutEffect(() => {
    if (appliedCustomizePrefill?.projectId === activeProjectId) {
      delete historyRef.current[newConversationDraftKey]
      clearPastedTextUndo(newConversationDraftKey)
      clearUndo(newConversationDraftKey)
    }
  }, [
    activeProjectId,
    appliedCustomizePrefill,
    clearPastedTextUndo,
    clearUndo,
    newConversationDraftKey
  ])

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

  useEffect(() => {
    const previousDraftKey = activeDraftKeyRef.current
    if (currentDraftKey === previousDraftKey) return

    const outgoingHistory = historyRef.current[previousDraftKey]
    if (deletedDraftKeysRef.current.delete(previousDraftKey)) {
      delete draftsRef.current[previousDraftKey]
    } else {
      draftsRef.current[previousDraftKey] = {
        doc: outgoingHistory?.scratch ?? doc,
        annotations,
        attachments,
        attachmentTransfers: transfers,
        automaticReadingEnabled: automaticReadingEnabledRef.current
      }
    }
    delete historyRef.current[previousDraftKey]
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('')
    setCaretRequest(undefined)

    const customizePrefillPending =
      currentDraftKey === newConversationDraftKey &&
      pendingCustomizePrefill !== undefined &&
      pendingCustomizePrefill.projectId === activeProjectId
    const nextDraft = draftsRef.current[currentDraftKey] ?? blank()
    if (!customizePrefillPending) setActiveDoc(nextDraft.doc)
    setActiveAnnotations(nextDraft.annotations)
    activateDraftAttachments(nextDraft)
    setActiveAutomaticReadingEnabled(nextDraft.automaticReadingEnabled)
    activeDraftKeyRef.current = currentDraftKey
  }, [
    activeProjectId,
    annotations,
    attachments,
    currentDraftKey,
    doc,
    newConversationDraftKey,
    pendingCustomizePrefill,
    setActiveAutomaticReadingEnabled,
    activateDraftAttachments,
    setActiveAnnotations,
    setActiveDoc,
    transfers
  ])

  const navigateHistory = useCallback(
    (direction: 'previous' | 'next'): boolean => {
      if (attachments.length > 0 || transfers.length > 0) return false

      let navigation = historyRef.current[currentDraftKey]
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
        delete historyRef.current[currentDraftKey]
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
      const pendingPdfContextAttachmentIds = stagedReadingContext
        ? [stagedReadingContext.id]
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
        ...(includeReadingContext && pendingPdfContextSelection?.kind === 'version'
          ? [
              {
                sourceKind: pendingPdfContextSelection.sourceKind,
                sourceFileId: pendingPdfContextSelection.sourceFileId,
                sourceVersionId: pendingPdfContextSelection.sourceVersionId
              }
            ]
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
        draftKey: activeDraftKeyRef.current,
        version: versionsRef.current[activeDraftKeyRef.current] ?? 0,
        doc: docRef.current,
        annotations: [...annotationsRef.current],
        attachments,
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
        ...(includeReadingContext && pdfReadingPosition ? { pdfReadingPosition } : {}),
        ...(pendingPdfContextAttachmentIds.length > 0 ? { pendingPdfContextAttachmentIds } : {}),
        ...(pendingPdfContextVersions.length > 0 ? { pendingPdfContextVersions } : {})
      }
    },
    [
      attachments,
      activeReadingBinding,
      automaticStagedReadingContexts,
      clearPastedTextUndo,
      clearUndo,
      durableReadingContext,
      durableReadingBindings,
      pendingPdfContextSelection,
      pdfReadingPosition,
      stagedReadingContext
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
      if (activeDraftKeyRef.current !== draftKey) return true
      setActiveDoc(emptyDoc)
      setActiveAnnotations([])
      clearActiveAttachments()
      setActiveAutomaticReadingEnabled(true)
      setError(null)
      return true
    },
    [
      clearActiveAttachments,
      clearHistory,
      clearPastedTextUndo,
      clearUndo,
      setActiveAnnotations,
      setActiveDoc,
      setActiveAutomaticReadingEnabled,
      setError
    ]
  )
  const restoreFailedSend = useCallback(
    (snapshot: ComposerSendSnapshot, preserveOnConflict = false): boolean => {
      if (deletedDraftKeysRef.current.has(snapshot.draftKey)) {
        if (!preserveOnConflict) deleteAttachmentFiles(snapshot.attachments)
        return false
      }
      if (
        (versionsRef.current[snapshot.draftKey] ?? 0) !== snapshot.version &&
        !(
          preserveOnConflict &&
          activeDraftKeyRef.current === snapshot.draftKey &&
          docIsEmpty(doc) &&
          annotations.length === 0 &&
          attachments.length === 0 &&
          transfers.length === 0
        )
      ) {
        if (!preserveOnConflict) deleteAttachmentFiles(snapshot.attachments)
        return false
      }
      if (activeDraftKeyRef.current === snapshot.draftKey) {
        setActiveDoc(snapshot.doc)
        setActiveAnnotations([...snapshot.annotations])
        setActiveAttachments(snapshot.attachments)
        setActiveAutomaticReadingEnabled(snapshot.automaticReadingEnabled !== false)
        return true
      }
      draftsRef.current[snapshot.draftKey] = {
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
      annotations.length,
      deleteAttachmentFiles,
      doc,
      setActiveAttachments,
      setActiveAnnotations,
      setActiveDoc,
      setActiveAutomaticReadingEnabled,
      transfers.length
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
    [currentDraftKey]
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
      doc,
      annotations,
      attachments,
      transfers,
      error,
      errorDetail,
      historyStatus,
      isHistoryBrowsing: historyBrowsingKey === currentDraftKey,
      isUploading,
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
      discardSnapshot: (snapshot) => deleteAttachmentFiles(snapshot.attachments),
      hasUnfinishedTransfers,
      beginSessionDeletion,
      settleSessionDeletion: (draftKey, deleted): void => {
        settleSessionDeletion(draftKey, deleted)
        if (!deleted) return
        delete draftsRef.current[draftKey]
        delete versionsRef.current[draftKey]
        deletedDraftKeysRef.current.add(draftKey)
        if (activeDraftKeyRef.current !== draftKey) return
        clearHistory(draftKey)
        setActiveDoc(emptyDoc)
        setActiveAnnotations([])
        clearActiveAttachments()
        setError(null)
      }
    }
  }
}
export { useWorkspaceComposerController, type WorkspaceComposerController }

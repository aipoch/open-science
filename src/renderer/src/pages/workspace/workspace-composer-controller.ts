import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { UploadedAttachment } from '../../../../shared/uploads'
import {
  validateAnnotations,
  type Annotation,
  type AnnotationValidationError
} from '../../../../shared/annotations'
import { buildCustomizePrefillDoc } from '@/lib/customize-chat'
import type { CustomizePrefillIntent } from '@/stores/navigation-store'

import type { ComposerUploadTransfer } from './composer-upload-transfer'
import {
  docIsEmpty,
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

type ComposerHistoryNavigation = {
  entries: ComposerHistoryEntry[]
  cursorId: string
  scratch: ComposerDoc
}

export type ComposerSendSnapshot = {
  draftKey: string
  version: number
  doc: ComposerDoc
  annotations: Annotation[]
  attachments: UploadedAttachment[]
}

type WorkspaceComposerControllerInput = {
  currentDraftKey: string
  newConversationDraftKey: string
  activeProjectId: string | undefined
  pendingCustomizePrefill: CustomizePrefillIntent | undefined
  onCustomizePrefillApplied: () => void
  historyEntries: ComposerHistoryEntry[]
  hasActiveSession: boolean
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
    historyStatus: string
    isHistoryBrowsing: boolean
    isUploading: boolean
    caretRequest: { key: number; position: ComposerCaretPosition } | undefined
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
  }
  lifecycle: {
    captureSend: () => ComposerSendSnapshot
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
  attachmentTransfers: []
})

const useWorkspaceComposerController = ({
  currentDraftKey,
  newConversationDraftKey,
  activeProjectId,
  pendingCustomizePrefill,
  onCustomizePrefillApplied,
  historyEntries,
  hasActiveSession,
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
  const draftsRef = useRef<Record<string, ComposerDraft>>({})
  const versionsRef = useRef<Record<string, number>>({})
  const deletedDraftKeysRef = useRef(new Set<string>())
  const historyRef = useRef<Record<string, ComposerHistoryNavigation>>({})
  const caretRequestKeyRef = useRef(0)

  const setActiveDoc = useCallback((next: ComposerDoc): void => {
    docRef.current = next
    setDoc(next)
  }, [])

  const setActiveAnnotations = useCallback((next: Annotation[]): void => {
    annotationsRef.current = next
    setAnnotations(next)
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
    draftsRef,
    setActiveDoc,
    clearHistory,
    markChanged,
    requestCaret,
    canStageAttachments,
    supportsImageInput,
    uploads
  })
  const { attachments, transfers, error, isUploading } = uploadController.view
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
    clearUndo
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
        attachmentTransfers: transfers
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
    activeDraftKeyRef.current = currentDraftKey
  }, [
    activeProjectId,
    annotations,
    attachments,
    currentDraftKey,
    doc,
    newConversationDraftKey,
    pendingCustomizePrefill,
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
      (!hasActiveSession || navigation.entries.length === historyEntries.length)
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
    hasActiveSession,
    historyBrowsingKey,
    historyEntries,
    markChanged,
    setActiveDoc
  ])

  const captureSend = useCallback((): ComposerSendSnapshot => {
    clearPastedTextUndo()
    clearUndo()
    return {
      draftKey: activeDraftKeyRef.current,
      version: versionsRef.current[activeDraftKeyRef.current] ?? 0,
      doc: docRef.current,
      annotations: [...annotationsRef.current],
      attachments
    }
  }, [attachments, clearPastedTextUndo, clearUndo])
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
        return true
      }
      draftsRef.current[snapshot.draftKey] = {
        doc: snapshot.doc,
        annotations: [...snapshot.annotations],
        attachments: snapshot.attachments,
        attachmentTransfers: draftsRef.current[snapshot.draftKey]?.attachmentTransfers ?? []
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
      transfers.length
    ]
  )

  const captureRevision = useCallback(
    (revisionDoc: ComposerDoc, revisionAnnotations: Annotation[]): ComposerSendSnapshot => ({
      draftKey: currentDraftKey,
      version: versionsRef.current[currentDraftKey] ?? 0,
      doc: revisionDoc,
      annotations: [...revisionAnnotations],
      attachments: []
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
      markChanged()
      setActiveAnnotations(next)
      return undefined
    },
    [markChanged, setActiveAnnotations]
  )

  return {
    view: {
      doc,
      annotations,
      attachments,
      transfers,
      error,
      historyStatus,
      isHistoryBrowsing: historyBrowsingKey === currentDraftKey,
      isUploading,
      caretRequest
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
        markChanged()
        setActiveAnnotations(next)
        return undefined
      },
      removeAnnotation: (id): void => {
        const next = annotationsRef.current.filter((annotation) => annotation.id !== id)
        if (next.length === annotationsRef.current.length) return
        markChanged()
        setActiveAnnotations(next)
      },
      navigateHistory,
      stageFiles,
      stagePastedText,
      cancelTransfer,
      removeAttachment,
      restorePastedText,
      undo,
      redo,
      setError
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

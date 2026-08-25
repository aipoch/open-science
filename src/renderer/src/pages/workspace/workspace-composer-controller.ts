import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { UploadedAttachment } from '../../../../shared/uploads'
import { buildCustomizePrefillDoc } from '@/lib/customize-chat'
import type { CustomizePrefillIntent } from '@/stores/navigation-store'

import type { ComposerUploadTransfer } from './composer-upload-transfer'
import {
  docIsEmpty,
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
    attachments: UploadedAttachment[]
    transfers: ComposerUploadTransfer[]
    error: string | null
    historyStatus: string
    isHistoryBrowsing: boolean
    isUploading: boolean
    caretRequest: { key: number; position: ComposerCaretPosition } | undefined
  }
  actions: {
    changeDoc: (doc: ComposerDoc) => void
    navigateHistory: (direction: 'previous' | 'next') => boolean
    stageFiles: (files: File[]) => void
    stagePastedText: (doc: ComposerDoc, node: ComposerPastedTextStage) => void
    cancelTransfer: (transfer: ComposerUploadTransfer) => void
    removeAttachment: (attachment: UploadedAttachment) => void
    restorePastedText: (pastedTextId: string) => void
    undoPastedTextRemoval: () => boolean
    setError: (error: string | null) => void
  }
  lifecycle: {
    captureSend: () => ComposerSendSnapshot
    clearDraft: (draftKey: string, expectedVersion?: number) => boolean
    restoreFailedSend: (snapshot: ComposerSendSnapshot, preserveOnConflict?: boolean) => boolean
    discardSnapshot: (snapshot: ComposerSendSnapshot) => void
    hasUnfinishedTransfers: (draftKey: string) => boolean
    beginSessionDeletion: (draftKey: string) => boolean
    settleSessionDeletion: (draftKey: string, deleted: boolean) => void
  }
}

const blank = (): ComposerDraft => ({ doc: emptyDoc, attachments: [], attachmentTransfers: [] })

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
  const draftsRef = useRef<Record<string, ComposerDraft>>({})
  const versionsRef = useRef<Record<string, number>>({})
  const historyRef = useRef<Record<string, ComposerHistoryNavigation>>({})
  const caretRequestKeyRef = useRef(0)

  const setActiveDoc = useCallback((next: ComposerDoc): void => {
    docRef.current = next
    setDoc(next)
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
    undoPastedTextRemoval,
    setError,
    clearPastedTextUndo
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
    }
  }, [activeProjectId, appliedCustomizePrefill, clearPastedTextUndo, newConversationDraftKey])

  useLayoutEffect(() => {
    docRef.current = doc
  }, [doc])

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
    draftsRef.current[previousDraftKey] = {
      doc: outgoingHistory?.scratch ?? doc,
      attachments,
      attachmentTransfers: transfers
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
    activateDraftAttachments(nextDraft)
    activeDraftKeyRef.current = currentDraftKey
  }, [
    activeProjectId,
    attachments,
    currentDraftKey,
    doc,
    newConversationDraftKey,
    pendingCustomizePrefill,
    activateDraftAttachments,
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
    setActiveDoc(navigation.scratch)
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('Draft restored')
  }, [
    clearPastedTextUndo,
    currentDraftKey,
    hasActiveSession,
    historyBrowsingKey,
    historyEntries,
    markChanged,
    setActiveDoc
  ])

  const captureSend = useCallback((): ComposerSendSnapshot => {
    clearPastedTextUndo()
    return {
      draftKey: activeDraftKeyRef.current,
      version: versionsRef.current[activeDraftKeyRef.current] ?? 0,
      doc,
      attachments
    }
  }, [attachments, clearPastedTextUndo, doc])
  const clearDraft = useCallback(
    (draftKey: string, expectedVersion?: number): boolean => {
      const currentVersion = versionsRef.current[draftKey] ?? 0
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) return false
      clearHistory(draftKey)
      clearPastedTextUndo(draftKey)
      delete draftsRef.current[draftKey]
      if (activeDraftKeyRef.current !== draftKey) return true
      setActiveDoc(emptyDoc)
      clearActiveAttachments()
      setError(null)
      return true
    },
    [clearActiveAttachments, clearHistory, clearPastedTextUndo, setActiveDoc, setError]
  )
  const restoreFailedSend = useCallback(
    (snapshot: ComposerSendSnapshot, preserveOnConflict = false): boolean => {
      if (
        (versionsRef.current[snapshot.draftKey] ?? 0) !== snapshot.version &&
        !(
          preserveOnConflict &&
          activeDraftKeyRef.current === snapshot.draftKey &&
          docIsEmpty(doc) &&
          attachments.length === 0 &&
          transfers.length === 0
        )
      ) {
        if (!preserveOnConflict) deleteAttachmentFiles(snapshot.attachments)
        return false
      }
      if (activeDraftKeyRef.current === snapshot.draftKey) {
        setActiveDoc(snapshot.doc)
        setActiveAttachments(snapshot.attachments)
        return true
      }
      draftsRef.current[snapshot.draftKey] = {
        doc: snapshot.doc,
        attachments: snapshot.attachments,
        attachmentTransfers: draftsRef.current[snapshot.draftKey]?.attachmentTransfers ?? []
      }
      return true
    },
    [
      attachments.length,
      deleteAttachmentFiles,
      doc,
      setActiveAttachments,
      setActiveDoc,
      transfers.length
    ]
  )
  return {
    view: {
      doc,
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
      navigateHistory,
      stageFiles,
      stagePastedText,
      cancelTransfer,
      removeAttachment,
      restorePastedText,
      undoPastedTextRemoval,
      setError
    },
    lifecycle: {
      captureSend,
      clearDraft,
      restoreFailedSend,
      discardSnapshot: (snapshot) => deleteAttachmentFiles(snapshot.attachments),
      hasUnfinishedTransfers,
      beginSessionDeletion,
      settleSessionDeletion
    }
  }
}
export { useWorkspaceComposerController, type WorkspaceComposerController }

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { UploadedAttachment } from '../../../../shared/uploads'
import { buildCustomizePrefillDoc } from '@/lib/customize-chat'
import type { CustomizePrefillIntent } from '@/stores/navigation-store'

import { planComposerAttachmentIntake } from './composer-attachment-intake'
import {
  stageComposerFile,
  type ComposerUploadTransfer,
  type UploadStagingApi
} from './composer-upload-transfer'
import { emptyDoc, type ComposerDoc } from './composer/composer-doc'
import { normalizeHistorySkills, type ComposerHistoryEntry } from './composer/composer-history'

type ComposerDraft = {
  doc: ComposerDoc
  attachments: UploadedAttachment[]
  attachmentTransfers: ComposerUploadTransfer[]
}

type ComposerHistoryNavigation = {
  entries: ComposerHistoryEntry[]
  cursorId: string
  scratch: ComposerDoc
}

type ComposerSendSnapshot = {
  draftKey: string
  version: number
  doc: ComposerDoc
  attachments: UploadedAttachment[]
}

type ComposerDeletionCleanup = Pick<ComposerDraft, 'attachments' | 'attachmentTransfers'>

type ComposerUploadApi = UploadStagingApi & {
  claimLocalFile?: (request: { transferId: string }) => Promise<void>
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
  }
  actions: {
    changeDoc: (doc: ComposerDoc) => void
    navigateHistory: (direction: 'previous' | 'next') => boolean
    stageFiles: (files: File[]) => void
    cancelTransfer: (transfer: ComposerUploadTransfer) => void
    removeAttachment: (attachment: UploadedAttachment) => void
    setError: (error: string | null) => void
  }
  lifecycle: {
    captureSend: () => ComposerSendSnapshot
    clearDraft: (draftKey: string, expectedVersion?: number) => boolean
    restoreFailedSend: (snapshot: ComposerSendSnapshot) => void
    hasUnfinishedTransfers: (draftKey: string) => boolean
    beginSessionDeletion: (draftKey: string) => boolean
    settleSessionDeletion: (draftKey: string, deleted: boolean) => void
  }
}

const blank = (): ComposerDraft => ({ doc: emptyDoc, attachments: [], attachmentTransfers: [] })

const asText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const uploadFilename = (file: File, index: number): string =>
  file.name.trim() || `pasted-image-${Date.now()}-${index + 1}.png`

const unfinished = (transfer: ComposerUploadTransfer): boolean => transfer.status !== 'error'

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
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [transfers, setTransfers] = useState<ComposerUploadTransfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [historyBrowsingKey, setHistoryBrowsingKey] = useState<string>()
  const [historyStatus, setHistoryStatus] = useState('')
  const [skillCatalogReady, setSkillCatalogReady] = useState(historyPolicy.skillCatalogReady)
  const [appliedCustomizePrefill, setAppliedCustomizePrefill] = useState<CustomizePrefillIntent>()
  const activeDraftKeyRef = useRef(currentDraftKey)
  const draftsRef = useRef<Record<string, ComposerDraft>>({})
  const versionsRef = useRef<Record<string, number>>({})
  const historyRef = useRef<Record<string, ComposerHistoryNavigation>>({})
  const transfersRef = useRef<ComposerUploadTransfer[]>([])
  const controllersRef = useRef<Record<string, AbortController>>({})
  const cancelledTransfersRef = useRef(new Set<string>())
  const deletionCleanupRef = useRef<Record<string, ComposerDeletionCleanup>>({})

  const markChanged = useCallback((draftKey = activeDraftKeyRef.current): void => {
    versionsRef.current[draftKey] = (versionsRef.current[draftKey] ?? 0) + 1
  }, [])

  const clearHistory = useCallback((draftKey: string): void => {
    delete historyRef.current[draftKey]
    setHistoryBrowsingKey((current) => (current === draftKey ? undefined : current))
    if (activeDraftKeyRef.current === draftKey) setHistoryStatus('')
  }, [])

  const changeDoc = useCallback(
    (nextDoc: ComposerDoc): void => {
      clearHistory(activeDraftKeyRef.current)
      markChanged()
      setDoc(nextDoc)
    },
    [clearHistory, markChanged]
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
    }
  }, [activeProjectId, appliedCustomizePrefill, newConversationDraftKey])

  useEffect(() => {
    transfersRef.current = transfers
  }, [transfers])

  useEffect(
    () => () => {
      const transferIds = new Set(Object.keys(controllersRef.current))
      for (const transfer of transfersRef.current) transferIds.add(transfer.transferId)
      for (const draft of Object.values(draftsRef.current)) {
        for (const transfer of draft.attachmentTransfers) transferIds.add(transfer.transferId)
      }
      for (const transferId of transferIds) {
        cancelledTransfersRef.current.add(transferId)
        controllersRef.current[transferId]?.abort()
        void uploads.abortTransfer({ transferId })
      }
    },
    [uploads]
  )

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

    const customizePrefillPending =
      currentDraftKey === newConversationDraftKey &&
      pendingCustomizePrefill !== undefined &&
      pendingCustomizePrefill.projectId === activeProjectId
    const nextDraft = draftsRef.current[currentDraftKey] ?? blank()
    if (!customizePrefillPending) setDoc(nextDraft.doc)
    setAttachments(nextDraft.attachments)
    setTransfers(nextDraft.attachmentTransfers)
    activeDraftKeyRef.current = currentDraftKey
  }, [
    activeProjectId,
    attachments,
    currentDraftKey,
    doc,
    newConversationDraftKey,
    pendingCustomizePrefill,
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
          setDoc(navigation.scratch)
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
      setDoc(normalized.doc)
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
      setDoc(normalized.doc)
    }
    setHistoryStatus(
      `History item ${cursor + 1} of ${navigation.entries.length}${
        normalized.unavailableSkillNames.length > 0
          ? `. ${normalized.unavailableSkillNames.map((name) => `/${name}`).join(', ')} unavailable`
          : ''
      }`
    )
  }, [currentDraftKey, doc, historyBrowsingKey, historyPolicy, markChanged, ready])

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
    setDoc(navigation.scratch)
    setHistoryBrowsingKey(undefined)
    setHistoryStatus('Draft restored')
  }, [currentDraftKey, hasActiveSession, historyBrowsingKey, historyEntries, markChanged])

  const deleteAttachmentFiles = useCallback(
    (items: UploadedAttachment[]): void => {
      if (items.length === 0) return
      void Promise.all(items.map((item) => uploads.deleteUpload({ path: item.path }))).catch(
        (deleteError) => setError(asText(deleteError))
      )
    },
    [uploads]
  )

  const updateDraftTransfers = useCallback(
    (
      draftKey: string,
      update: (current: ComposerUploadTransfer[]) => ComposerUploadTransfer[]
    ): void => {
      if (activeDraftKeyRef.current === draftKey) {
        setTransfers(update)
        return
      }
      const draft = draftsRef.current[draftKey]
      if (draft) draft.attachmentTransfers = update(draft.attachmentTransfers)
    },
    []
  )

  const commitDraftAttachment = useCallback(
    (draftKey: string, transferId: string, attachment: UploadedAttachment): void => {
      const cleanup = deletionCleanupRef.current[draftKey]
      if (cleanup) {
        cleanup.attachmentTransfers = cleanup.attachmentTransfers.filter(
          (transfer) => transfer.transferId !== transferId
        )
        cleanup.attachments.push(attachment)
      }
      if (activeDraftKeyRef.current === draftKey) {
        setTransfers((current) => current.filter((transfer) => transfer.transferId !== transferId))
        setAttachments((current) => [...current, attachment])
        return
      }
      const draft = draftsRef.current[draftKey]
      if (!draft) return
      draft.attachmentTransfers = draft.attachmentTransfers.filter(
        (transfer) => transfer.transferId !== transferId
      )
      draft.attachments.push(attachment)
    },
    []
  )

  const stageFiles = useCallback(
    (files: File[]): void => {
      if (!canStageAttachments || files.length === 0) return
      if (files.some((file) => file.type.startsWith('image/')) && supportsImageInput !== true) {
        setError('The selected model is not configured for image input.')
        return
      }
      const intake = planComposerAttachmentIntake(files, attachments.length + transfers.length)
      setError(intake.error)
      if (intake.accepted.length === 0) return

      const draftKey = activeDraftKeyRef.current
      clearHistory(draftKey)
      markChanged(draftKey)
      const pending = intake.accepted.map((file, index) => ({
        file,
        transfer: {
          transferId: crypto.randomUUID(),
          name: uploadFilename(file, index),
          mimeType: file.type || undefined,
          receivedBytes: 0,
          totalBytes: file.size,
          status: 'queued' as const
        }
      }))
      setTransfers((current) => [...current, ...pending.map(({ transfer }) => transfer)])
      deletionCleanupRef.current[draftKey]?.attachmentTransfers.push(
        ...pending.map(({ transfer }) => transfer)
      )

      void (async () => {
        for (const { file, transfer } of pending) {
          if (cancelledTransfersRef.current.delete(transfer.transferId)) continue
          const controller = new AbortController()
          controllersRef.current[transfer.transferId] = controller
          const updateTransfer = (
            update: Partial<ComposerUploadTransfer> | { remove: true }
          ): void =>
            updateDraftTransfers(draftKey, (current) =>
              'remove' in update
                ? current.filter((candidate) => candidate.transferId !== transfer.transferId)
                : current.map((candidate) =>
                    candidate.transferId === transfer.transferId
                      ? { ...candidate, ...update }
                      : candidate
                  )
            )
          updateTransfer({ status: 'uploading' })
          try {
            const attachment = await stageComposerFile(file, uploads, {
              transferId: transfer.transferId,
              name: transfer.name,
              signal: controller.signal,
              onProgress: (progress) => updateTransfer({ ...progress, status: 'uploading' })
            })
            if (controller.signal.aborted) {
              await Promise.all([
                uploads.deleteUpload({ path: attachment.path }).catch(() => undefined),
                uploads.abortTransfer({ transferId: transfer.transferId }).catch(() => undefined)
              ])
              continue
            }
            commitDraftAttachment(draftKey, transfer.transferId, attachment)
            await uploads
              .claimLocalFile?.({ transferId: transfer.transferId })
              .catch((claimError) =>
                console.warn('Failed to claim staged local upload', claimError)
              )
          } catch (uploadError) {
            if (controller.signal.aborted) updateTransfer({ remove: true })
            else {
              const message = asText(uploadError)
              updateTransfer({ status: 'error', error: message })
              if (activeDraftKeyRef.current === draftKey) setError(message)
            }
          } finally {
            delete controllersRef.current[transfer.transferId]
            cancelledTransfersRef.current.delete(transfer.transferId)
          }
        }
      })()
    },
    [
      attachments.length,
      canStageAttachments,
      clearHistory,
      commitDraftAttachment,
      markChanged,
      supportsImageInput,
      transfers.length,
      updateDraftTransfers,
      uploads
    ]
  )

  const cancelTransfer = useCallback(
    (transfer: ComposerUploadTransfer): void => {
      const draftKey = activeDraftKeyRef.current
      markChanged(draftKey)
      cancelledTransfersRef.current.add(transfer.transferId)
      controllersRef.current[transfer.transferId]?.abort()
      updateDraftTransfers(draftKey, (current) =>
        current.map((candidate) =>
          candidate.transferId === transfer.transferId
            ? { ...candidate, status: 'cancelling' }
            : candidate
        )
      )
      void uploads
        .abortTransfer({ transferId: transfer.transferId })
        .catch(() => undefined)
        .finally(() =>
          updateDraftTransfers(draftKey, (current) =>
            current.filter((candidate) => candidate.transferId !== transfer.transferId)
          )
        )
    },
    [markChanged, updateDraftTransfers, uploads]
  )

  const removeAttachment = useCallback(
    (attachment: UploadedAttachment): void => {
      markChanged()
      setAttachments((current) => current.filter((item) => item.id !== attachment.id))
      const cleanup = deletionCleanupRef.current[activeDraftKeyRef.current]
      if (cleanup) {
        cleanup.attachments = cleanup.attachments.filter((item) => item.id !== attachment.id)
      }
      void uploads.deleteUpload({ path: attachment.path }).catch((deleteError) => {
        setError(asText(deleteError))
      })
    },
    [markChanged, uploads]
  )
  const captureSend = useCallback(
    (): ComposerSendSnapshot => ({
      draftKey: activeDraftKeyRef.current,
      version: versionsRef.current[activeDraftKeyRef.current] ?? 0,
      doc,
      attachments
    }),
    [attachments, doc]
  )
  const clearDraft = useCallback(
    (draftKey: string, expectedVersion?: number): boolean => {
      const currentVersion = versionsRef.current[draftKey] ?? 0
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) return false
      clearHistory(draftKey)
      delete draftsRef.current[draftKey]
      if (activeDraftKeyRef.current !== draftKey) return true
      setDoc(emptyDoc)
      setAttachments([])
      setError(null)
      return true
    },
    [clearHistory]
  )
  const restoreFailedSend = useCallback(
    (snapshot: ComposerSendSnapshot): void => {
      if ((versionsRef.current[snapshot.draftKey] ?? 0) !== snapshot.version) {
        deleteAttachmentFiles(snapshot.attachments)
        return
      }
      if (activeDraftKeyRef.current === snapshot.draftKey) {
        setDoc(snapshot.doc)
        setAttachments(snapshot.attachments)
        return
      }
      draftsRef.current[snapshot.draftKey] = {
        doc: snapshot.doc,
        attachments: snapshot.attachments,
        attachmentTransfers: draftsRef.current[snapshot.draftKey]?.attachmentTransfers ?? []
      }
    },
    [deleteAttachmentFiles]
  )

  const hasUnfinishedTransfers = useCallback(
    (draftKey: string): boolean =>
      (activeDraftKeyRef.current === draftKey
        ? transfers
        : (draftsRef.current[draftKey]?.attachmentTransfers ?? [])
      ).some(unfinished),
    [transfers]
  )

  const beginSessionDeletion = useCallback(
    (draftKey: string): boolean => {
      if (deletionCleanupRef.current[draftKey]) return false
      const stored = draftsRef.current[draftKey]
      const isActive = activeDraftKeyRef.current === draftKey
      deletionCleanupRef.current[draftKey] = {
        attachments: [...(isActive ? attachments : (stored?.attachments ?? []))],
        attachmentTransfers: [...(isActive ? transfers : (stored?.attachmentTransfers ?? []))]
      }
      return true
    },
    [attachments, transfers]
  )

  const settleSessionDeletion = useCallback(
    (draftKey: string, deleted: boolean): void => {
      const cleanup = deletionCleanupRef.current[draftKey]
      delete deletionCleanupRef.current[draftKey]
      if (!deleted || !cleanup) return
      delete draftsRef.current[draftKey]
      clearHistory(draftKey)
      for (const transfer of cleanup.attachmentTransfers) {
        cancelledTransfersRef.current.add(transfer.transferId)
        controllersRef.current[transfer.transferId]?.abort()
        void uploads.abortTransfer({ transferId: transfer.transferId })
      }
      deleteAttachmentFiles(cleanup.attachments)
    },
    [clearHistory, deleteAttachmentFiles, uploads]
  )

  return {
    view: {
      doc,
      attachments,
      transfers,
      error,
      historyStatus,
      isHistoryBrowsing: historyBrowsingKey === currentDraftKey,
      isUploading: transfers.some(unfinished)
    },
    actions: {
      changeDoc,
      navigateHistory,
      stageFiles,
      cancelTransfer,
      removeAttachment,
      setError
    },
    lifecycle: {
      captureSend,
      clearDraft,
      restoreFailedSend,
      hasUnfinishedTransfers,
      beginSessionDeletion,
      settleSessionDeletion
    }
  }
}

export { useWorkspaceComposerController, type WorkspaceComposerController }

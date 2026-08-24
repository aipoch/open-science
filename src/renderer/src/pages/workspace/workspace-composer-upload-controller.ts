import { useCallback, useEffect, useRef, useState } from 'react'

import { VISION_MODEL_NOT_CONFIGURED_MESSAGE } from '../../../../shared/run-error-classification'
import type { UploadedAttachment } from '../../../../shared/uploads'

import { planComposerAttachmentIntake } from './composer-attachment-intake'
import {
  stageComposerFile,
  type ComposerUploadTransfer,
  type UploadStagingApi
} from './composer-upload-transfer'
import {
  insertPastedTextNodeAtLogicalOffset,
  pastedTextLogicalOffset,
  removePastedTextNode,
  restorePastedTextNode,
  updatePastedTextNode,
  type ComposerCaretPosition,
  type ComposerDoc,
  type ComposerPastedTextNode
} from './composer/composer-doc'

export type ComposerDraft = {
  doc: ComposerDoc
  attachments: UploadedAttachment[]
  attachmentTransfers: ComposerUploadTransfer[]
}

type ComposerDeletionCleanup = Pick<ComposerDraft, 'attachments' | 'attachmentTransfers'>

type PastedTextUndoReceipt = {
  logicalOffset: number
  node: ComposerPastedTextNode
  attachmentDoc?: ComposerDoc
}

export type ComposerUploadApi = UploadStagingApi & {
  claimLocalFile?: (request: { transferId: string }) => Promise<void>
}

type WorkspaceComposerUploadControllerInput = {
  activeDraftKeyRef: { current: string }
  docRef: { current: ComposerDoc }
  draftsRef: { current: Record<string, ComposerDraft> }
  setActiveDoc: (doc: ComposerDoc) => void
  clearHistory: (draftKey: string) => void
  markChanged: (draftKey?: string) => void
  requestCaret: (position: ComposerCaretPosition) => void
  canStageAttachments: boolean
  supportsImageInput: boolean | undefined
  uploads: ComposerUploadApi
}

type WorkspaceComposerUploadController = {
  view: {
    attachments: UploadedAttachment[]
    transfers: ComposerUploadTransfer[]
    error: string | null
    isUploading: boolean
  }
  actions: {
    changeDoc: (doc: ComposerDoc) => void
    stageFiles: (files: File[]) => void
    stagePastedText: (doc: ComposerDoc, node: ComposerPastedTextNode) => void
    cancelTransfer: (transfer: ComposerUploadTransfer) => void
    removeAttachment: (attachment: UploadedAttachment) => void
    restorePastedText: (pastedTextId: string) => void
    undoPastedTextRemoval: () => boolean
    setError: (error: string | null) => void
    clearPastedTextUndo: (draftKey?: string) => void
  }
  lifecycle: {
    activateDraftAttachments: (draft: ComposerDraft) => void
    clearActiveAttachments: () => void
    setActiveAttachments: (attachments: UploadedAttachment[]) => void
    deleteAttachmentFiles: (attachments: UploadedAttachment[]) => void
    hasUnfinishedTransfers: (draftKey: string) => boolean
    beginSessionDeletion: (draftKey: string) => boolean
    settleSessionDeletion: (draftKey: string, deleted: boolean) => void
  }
}

const PASTED_TEXT_FILENAME = 'Pasted text.txt'

const asText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const uploadFilename = (file: File, index: number): string =>
  file.name.trim() || `pasted-image-${Date.now()}-${index + 1}.png`

export const unfinishedComposerUpload = (transfer: ComposerUploadTransfer): boolean =>
  transfer.status !== 'error'

export const useWorkspaceComposerUploadController = ({
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
}: WorkspaceComposerUploadControllerInput): WorkspaceComposerUploadController => {
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [transfers, setTransfers] = useState<ComposerUploadTransfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const attachmentsRef = useRef(attachments)
  const transfersRef = useRef<ComposerUploadTransfer[]>([])
  const controllersRef = useRef<Record<string, AbortController>>({})
  const cancelledTransfersRef = useRef(new Set<string>())
  const deletionCleanupRef = useRef<Record<string, ComposerDeletionCleanup>>({})
  const removedPastedTextRef = useRef<Record<string, PastedTextUndoReceipt[]>>({})
  const setActiveAttachments = useCallback((next: UploadedAttachment[]): void => {
    attachmentsRef.current = next
    setAttachments(next)
  }, [])
  const updateActiveAttachments = useCallback(
    (update: (current: UploadedAttachment[]) => UploadedAttachment[]): void => {
      setActiveAttachments(update(attachmentsRef.current))
    },
    [setActiveAttachments]
  )
  const clearPastedTextUndo = useCallback(
    (draftKey = activeDraftKeyRef.current): void => {
      delete removedPastedTextRef.current[draftKey]
    },
    [activeDraftKeyRef]
  )
  const clearAllPastedTextUndo = useCallback((): void => {
    removedPastedTextRef.current = {}
  }, [])

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
    [draftsRef, uploads]
  )
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
    [activeDraftKeyRef, draftsRef]
  )
  const updateDraftDoc = useCallback(
    (draftKey: string, update: (current: ComposerDoc) => ComposerDoc): void => {
      if (activeDraftKeyRef.current === draftKey) {
        setActiveDoc(update(docRef.current))
        return
      }
      const draft = draftsRef.current[draftKey]
      if (draft) draft.doc = update(draft.doc)
    },
    [activeDraftKeyRef, docRef, draftsRef, setActiveDoc]
  )
  const commitDraftAttachment = useCallback(
    (
      draftKey: string,
      transferId: string,
      attachment: UploadedAttachment,
      pastedTextId?: string
    ): void => {
      const cleanup = deletionCleanupRef.current[draftKey]
      if (cleanup) {
        cleanup.attachmentTransfers = cleanup.attachmentTransfers.filter(
          (transfer) => transfer.transferId !== transferId
        )
        cleanup.attachments.push(attachment)
      }
      const targetDoc =
        activeDraftKeyRef.current === draftKey ? docRef.current : draftsRef.current[draftKey]?.doc
      if (
        pastedTextId &&
        !targetDoc?.nodes.some((node) => node.type === 'pasted-text' && node.id === pastedTextId)
      ) {
        updateDraftTransfers(draftKey, (current) =>
          current.filter((transfer) => transfer.transferId !== transferId)
        )
        void uploads.deleteUpload({ path: attachment.path }).catch(() => undefined)
        return
      }
      if (activeDraftKeyRef.current === draftKey) {
        setTransfers((current) => current.filter((transfer) => transfer.transferId !== transferId))
        updateActiveAttachments((current) => [...current, attachment])
      } else {
        const draft = draftsRef.current[draftKey]
        if (!draft) return
        draft.attachmentTransfers = draft.attachmentTransfers.filter(
          (transfer) => transfer.transferId !== transferId
        )
        draft.attachments.push(attachment)
      }
      if (pastedTextId) {
        updateDraftDoc(draftKey, (current) =>
          updatePastedTextNode(current, pastedTextId, (node) => ({
            ...node,
            transferId: undefined,
            attachmentId: attachment.id
          }))
        )
      }
    },
    [
      activeDraftKeyRef,
      docRef,
      draftsRef,
      updateActiveAttachments,
      updateDraftDoc,
      updateDraftTransfers,
      uploads
    ]
  )

  const restorePastedTextInline = useCallback(
    (draftKey: string, pastedTextId: string): void => {
      let caret: ComposerCaretPosition | undefined
      updateDraftDoc(draftKey, (current) => {
        const restored = restorePastedTextNode(current, pastedTextId)
        caret = restored?.caret
        return restored?.doc ?? current
      })
      if (activeDraftKeyRef.current === draftKey && caret) requestCaret(caret)
    },
    [activeDraftKeyRef, requestCaret, updateDraftDoc]
  )

  const runPendingUploads = useCallback(
    (draftKey: string, pending: Array<{ file: File; transfer: ComposerUploadTransfer }>): void => {
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
            commitDraftAttachment(draftKey, transfer.transferId, attachment, transfer.pastedTextId)
            await uploads
              .claimLocalFile?.({ transferId: transfer.transferId })
              .catch((claimError) =>
                console.warn('Failed to claim staged local upload', claimError)
              )
          } catch (uploadError) {
            if (controller.signal.aborted) {
              updateTransfer({ remove: true })
            } else {
              const message = asText(uploadError)
              if (transfer.pastedTextId) {
                updateTransfer({ remove: true })
                restorePastedTextInline(draftKey, transfer.pastedTextId)
              } else {
                updateTransfer({ status: 'error', error: message })
              }
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
      activeDraftKeyRef,
      commitDraftAttachment,
      restorePastedTextInline,
      updateDraftTransfers,
      uploads
    ]
  )

  const stageFiles = useCallback(
    (files: File[]): void => {
      if (!canStageAttachments || files.length === 0) return
      if (files.some((file) => file.type.startsWith('image/')) && supportsImageInput !== true) {
        setError(VISION_MODEL_NOT_CONFIGURED_MESSAGE)
        return
      }
      const intake = planComposerAttachmentIntake(files, attachments.length + transfers.length)
      setError(intake.error)
      if (intake.accepted.length === 0) return
      const draftKey = activeDraftKeyRef.current
      clearPastedTextUndo(draftKey)
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
      runPendingUploads(draftKey, pending)
    },
    [
      activeDraftKeyRef,
      attachments.length,
      canStageAttachments,
      clearHistory,
      clearPastedTextUndo,
      markChanged,
      runPendingUploads,
      supportsImageInput,
      transfers.length
    ]
  )

  const deletePastedTextUpload = useCallback(
    (node: ComposerPastedTextNode, draftKey: string): void => {
      if (node.transferId) {
        cancelledTransfersRef.current.add(node.transferId)
        controllersRef.current[node.transferId]?.abort()
        setTransfers((current) =>
          current.filter((transfer) => transfer.transferId !== node.transferId)
        )
        void uploads.abortTransfer({ transferId: node.transferId }).catch(() => undefined)
      }
      if (!node.attachmentId) return
      const attachment = attachmentsRef.current.find((item) => item.id === node.attachmentId)
      if (!attachment) return
      updateActiveAttachments((current) => current.filter((item) => item.id !== attachment.id))
      const cleanup = deletionCleanupRef.current[draftKey]
      if (cleanup) {
        cleanup.attachments = cleanup.attachments.filter((item) => item.id !== attachment.id)
      }
      void uploads
        .deleteUpload({ path: attachment.path })
        .catch((deleteError) => setError(asText(deleteError)))
    },
    [updateActiveAttachments, uploads]
  )

  const reconcileRemovedPastedTextUploads = useCallback(
    (nextDoc: ComposerDoc, draftKey: string): number => {
      const nextPastedIds = new Set(
        nextDoc.nodes.flatMap((node) => (node.type === 'pasted-text' ? [node.id] : []))
      )
      let releasedSlots = 0
      for (const node of docRef.current.nodes) {
        if (node.type === 'pasted-text' && !nextPastedIds.has(node.id)) {
          if (node.transferId || node.attachmentId) releasedSlots += 1
          deletePastedTextUpload(node, draftKey)
        }
      }
      return releasedSlots
    },
    [deletePastedTextUpload, docRef]
  )

  const stagePastedText = useCallback(
    (nextDoc: ComposerDoc, node: ComposerPastedTextNode, preserveRemovalUndo = false): void => {
      const draftKey = activeDraftKeyRef.current
      if (!preserveRemovalUndo) clearPastedTextUndo(draftKey)
      clearHistory(draftKey)
      markChanged(draftKey)
      const releasedSlots = reconcileRemovedPastedTextUploads(nextDoc, draftKey)
      const file = new File([node.text], PASTED_TEXT_FILENAME, { type: 'text/plain' })
      const intake = canStageAttachments
        ? planComposerAttachmentIntake(
            [file],
            Math.max(0, attachments.length + transfers.length - releasedSlots)
          )
        : { accepted: [], error: null }
      setError(intake.error)
      if (intake.accepted.length === 0) {
        const restored = restorePastedTextNode(nextDoc, node.id)
        setActiveDoc(restored?.doc ?? nextDoc)
        if (restored) requestCaret(restored.caret)
        return
      }
      const transfer: ComposerUploadTransfer = {
        transferId: crypto.randomUUID(),
        pastedTextId: node.id,
        name: PASTED_TEXT_FILENAME,
        mimeType: file.type,
        receivedBytes: 0,
        totalBytes: file.size,
        status: 'queued'
      }
      setActiveDoc(
        updatePastedTextNode(nextDoc, node.id, (current) => ({
          ...current,
          transferId: transfer.transferId,
          attachmentId: undefined
        }))
      )
      setTransfers((current) => [...current, transfer])
      deletionCleanupRef.current[draftKey]?.attachmentTransfers.push(transfer)
      runPendingUploads(draftKey, [{ file, transfer }])
    },
    [
      activeDraftKeyRef,
      attachments.length,
      canStageAttachments,
      clearHistory,
      clearPastedTextUndo,
      markChanged,
      reconcileRemovedPastedTextUploads,
      requestCaret,
      runPendingUploads,
      setActiveDoc,
      transfers.length
    ]
  )

  const removePastedText = useCallback(
    (node: ComposerPastedTextNode): void => {
      const draftKey = activeDraftKeyRef.current
      const stack = removedPastedTextRef.current[draftKey] ?? []
      removedPastedTextRef.current[draftKey] = [
        ...stack,
        {
          logicalOffset: pastedTextLogicalOffset(docRef.current, node.id) ?? 0,
          node: { ...node }
        }
      ].slice(-10)
      clearHistory(draftKey)
      markChanged(draftKey)
      setActiveDoc(removePastedTextNode(docRef.current, node.id))
      deletePastedTextUpload(node, draftKey)
    },
    [activeDraftKeyRef, clearHistory, deletePastedTextUpload, docRef, markChanged, setActiveDoc]
  )

  const restorePastedText = useCallback(
    (pastedTextId: string): void => {
      const node = docRef.current.nodes.find(
        (candidate): candidate is ComposerPastedTextNode =>
          candidate.type === 'pasted-text' && candidate.id === pastedTextId
      )
      if (!node) return
      const draftKey = activeDraftKeyRef.current
      const stack = removedPastedTextRef.current[draftKey] ?? []
      removedPastedTextRef.current[draftKey] = [
        ...stack,
        {
          logicalOffset: pastedTextLogicalOffset(docRef.current, node.id) ?? 0,
          node: { ...node },
          attachmentDoc: docRef.current
        }
      ].slice(-10)
      clearHistory(draftKey)
      markChanged(draftKey)
      restorePastedTextInline(draftKey, pastedTextId)
      deletePastedTextUpload(node, draftKey)
    },
    [
      activeDraftKeyRef,
      clearHistory,
      deletePastedTextUpload,
      docRef,
      markChanged,
      restorePastedTextInline
    ]
  )

  const undoPastedTextRemoval = useCallback((): boolean => {
    const draftKey = activeDraftKeyRef.current
    const stack = removedPastedTextRef.current[draftKey]
    const receipt = stack?.at(-1)
    if (!receipt) return false
    if (stack && stack.length > 1) removedPastedTextRef.current[draftKey] = stack.slice(0, -1)
    else delete removedPastedTextRef.current[draftKey]

    const restoredNode = { ...receipt.node, transferId: undefined, attachmentId: undefined }
    stagePastedText(
      receipt.attachmentDoc
        ? updatePastedTextNode(receipt.attachmentDoc, restoredNode.id, () => restoredNode)
        : insertPastedTextNodeAtLogicalOffset(docRef.current, restoredNode, receipt.logicalOffset),
      restoredNode,
      true
    )
    return true
  }, [activeDraftKeyRef, docRef, stagePastedText])

  const changeDoc = useCallback(
    (nextDoc: ComposerDoc): void => {
      const draftKey = activeDraftKeyRef.current
      clearPastedTextUndo(draftKey)
      clearHistory(draftKey)
      reconcileRemovedPastedTextUploads(nextDoc, draftKey)
      markChanged(draftKey)
      setActiveDoc(nextDoc)
    },
    [
      activeDraftKeyRef,
      clearHistory,
      clearPastedTextUndo,
      markChanged,
      reconcileRemovedPastedTextUploads,
      setActiveDoc
    ]
  )

  const cancelTransfer = useCallback(
    (transfer: ComposerUploadTransfer): void => {
      const pastedText = transfer.pastedTextId
        ? docRef.current.nodes.find(
            (node): node is ComposerPastedTextNode =>
              node.type === 'pasted-text' && node.id === transfer.pastedTextId
          )
        : undefined
      if (pastedText) {
        removePastedText(pastedText)
        return
      }
      const draftKey = activeDraftKeyRef.current
      clearPastedTextUndo(draftKey)
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
    [
      activeDraftKeyRef,
      clearPastedTextUndo,
      docRef,
      markChanged,
      removePastedText,
      updateDraftTransfers,
      uploads
    ]
  )

  const removeAttachment = useCallback(
    (attachment: UploadedAttachment): void => {
      const pastedText = docRef.current.nodes.find(
        (node): node is ComposerPastedTextNode =>
          node.type === 'pasted-text' && node.attachmentId === attachment.id
      )
      if (pastedText) {
        removePastedText(pastedText)
        return
      }
      clearPastedTextUndo()
      markChanged()
      updateActiveAttachments((current) => current.filter((item) => item.id !== attachment.id))
      const cleanup = deletionCleanupRef.current[activeDraftKeyRef.current]
      if (cleanup) {
        cleanup.attachments = cleanup.attachments.filter((item) => item.id !== attachment.id)
      }
      void uploads.deleteUpload({ path: attachment.path }).catch((deleteError) => {
        setError(asText(deleteError))
      })
    },
    [
      activeDraftKeyRef,
      clearPastedTextUndo,
      docRef,
      markChanged,
      removePastedText,
      updateActiveAttachments,
      uploads
    ]
  )

  const activateDraftAttachments = useCallback(
    (draft: ComposerDraft): void => {
      setActiveAttachments(draft.attachments)
      setTransfers(draft.attachmentTransfers)
      clearAllPastedTextUndo()
    },
    [clearAllPastedTextUndo, setActiveAttachments]
  )

  const clearActiveAttachments = useCallback(
    (): void => setActiveAttachments([]),
    [setActiveAttachments]
  )

  const hasUnfinishedTransfers = useCallback(
    (draftKey: string): boolean =>
      (activeDraftKeyRef.current === draftKey
        ? transfers
        : (draftsRef.current[draftKey]?.attachmentTransfers ?? [])
      ).some(unfinishedComposerUpload),
    [activeDraftKeyRef, draftsRef, transfers]
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
    [activeDraftKeyRef, attachments, draftsRef, transfers]
  )

  const settleSessionDeletion = useCallback(
    (draftKey: string, deleted: boolean): void => {
      const cleanup = deletionCleanupRef.current[draftKey]
      delete deletionCleanupRef.current[draftKey]
      if (!deleted || !cleanup) return
      delete draftsRef.current[draftKey]
      clearHistory(draftKey)
      clearPastedTextUndo(draftKey)
      for (const transfer of cleanup.attachmentTransfers) {
        cancelledTransfersRef.current.add(transfer.transferId)
        controllersRef.current[transfer.transferId]?.abort()
        void uploads.abortTransfer({ transferId: transfer.transferId })
      }
      deleteAttachmentFiles(cleanup.attachments)
    },
    [clearHistory, clearPastedTextUndo, deleteAttachmentFiles, draftsRef, uploads]
  )

  return {
    view: {
      attachments,
      transfers,
      error,
      isUploading: transfers.some(unfinishedComposerUpload)
    },
    actions: {
      changeDoc,
      stageFiles,
      stagePastedText,
      cancelTransfer,
      removeAttachment,
      restorePastedText,
      undoPastedTextRemoval,
      setError,
      clearPastedTextUndo
    },
    lifecycle: {
      activateDraftAttachments,
      clearActiveAttachments,
      setActiveAttachments,
      deleteAttachmentFiles,
      hasUnfinishedTransfers,
      beginSessionDeletion,
      settleSessionDeletion
    }
  }
}

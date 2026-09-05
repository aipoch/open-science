import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'

import { VISION_MODEL_NOT_CONFIGURED_MESSAGE } from '../../../../shared/run-error-classification'
import { imageAttachmentMimeType, type UploadedAttachment } from '../../../../shared/uploads'
import type { Annotation } from '../../../../shared/annotations'
import type { SessionPdfContextSource } from '../../../../shared/session-persistence'

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
  type ComposerPastedTextNode,
  type ComposerPastedTextStage
} from './composer/composer-doc'

export type ComposerDraft = {
  doc: ComposerDoc
  annotations: Annotation[]
  attachments: UploadedAttachment[]
  attachmentTransfers: ComposerUploadTransfer[]
  automaticReadingEnabled: boolean
}

type ComposerDeletionCleanup = Pick<ComposerDraft, 'attachments' | 'attachmentTransfers'>

type PastedTextUndoReceipt = {
  logicalOffset: number
  node: ComposerPastedTextNode
  attachmentDoc?: ComposerDoc
}

type ComposerHistorySnapshot = ComposerDraft & {
  caret?: ComposerCaretPosition
  readingContextSources: SessionPdfContextSource[]
  historySequence: number
}
type ComposerHistoryRef = { current: Record<string, ComposerHistorySnapshot[]> }

type ComposerUndoTransaction = {
  commit: () => void
  rollback: (readingContextSources: SessionPdfContextSource[]) => void
}

export type ComposerUploadApi = UploadStagingApi & {
  claimLocalFile?: (request: { transferId: string }) => Promise<void>
}

type WorkspaceComposerUploadControllerInput = {
  activeDraftKeyRef: { current: string }
  docRef: { current: ComposerDoc }
  annotationsRef: { current: Annotation[] }
  draftsRef: { current: Record<string, ComposerDraft> }
  setActiveDoc: (doc: ComposerDoc) => void
  setActiveAnnotations: (annotations: Annotation[]) => void
  clearHistory: (draftKey: string) => void
  markChanged: (draftKey?: string) => void
  requestCaret: (position: ComposerCaretPosition) => void
  canStageAttachments: boolean
  supportsImageInput: boolean | undefined
  uploads: ComposerUploadApi
  readingContextSourcesRef: { current: SessionPdfContextSource[] }
  restoreReadingContextSources: (sources: SessionPdfContextSource[]) => void
  automaticReadingEnabledRef: { current: boolean }
  setActiveAutomaticReadingEnabled: (enabled: boolean) => void
}

type WorkspaceComposerUploadController = {
  view: {
    attachments: UploadedAttachment[]
    transfers: ComposerUploadTransfer[]
    error: string | null
    errorDetail?: string
    isUploading: boolean
  }
  actions: {
    changeDoc: (doc: ComposerDoc, caret?: ComposerCaretPosition) => void
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
    clearPastedTextUndo: (draftKey?: string) => void
    clearUndo: (draftKey?: string) => void
    captureUndo: (draftKey?: string, caret?: ComposerCaretPosition) => void
    beginUndoTransaction: (
      draftKey?: string,
      caret?: ComposerCaretPosition
    ) => ComposerUndoTransaction
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

const pastedTextFilename = (text: string): string => {
  const safePrefix = Array.from(
    text
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/[-_]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
  )
    .slice(0, 20)
    .join('')
    .replace(/-+$/u, '')

  return safePrefix ? `Pastedtext-${safePrefix}.txt` : 'Pastedtext.txt'
}

const asText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const uploadFilename = (file: File, index: number): string =>
  file.name.trim() || `pasted-image-${Date.now()}-${index + 1}.png`

export const unfinishedComposerUpload = (transfer: ComposerUploadTransfer): boolean =>
  transfer.status !== 'error'

export const useWorkspaceComposerUploadController = ({
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
}: WorkspaceComposerUploadControllerInput): WorkspaceComposerUploadController => {
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [transfers, setTransfers] = useState<ComposerUploadTransfer[]>([])
  const { t } = useTranslation()
  const [error, setErrorText] = useState<string | null>(null)
  const [errorDetail, setErrorDetail] = useState<string>()
  const setError = useCallback((message: string | null): void => {
    setErrorText(message)
    setErrorDetail(undefined)
  }, [])
  const attachmentsRef = useRef(attachments)
  const transfersRef = useRef<ComposerUploadTransfer[]>([])
  const controllersRef = useRef<Record<string, AbortController>>({})
  const cancelledTransfersRef = useRef(new Set<string>())
  const deletionCleanupRef = useRef<Record<string, ComposerDeletionCleanup>>({})
  const removedPastedTextRef = useRef<Record<string, PastedTextUndoReceipt[]>>({})
  const preferSnapshotUndoRef = useRef(new Set<string>())
  const undoRef = useRef<Record<string, ComposerHistorySnapshot[]>>({})
  const redoRef = useRef<Record<string, ComposerHistorySnapshot[]>>({})
  const historySequenceRef = useRef(0)
  const transferFilesRef = useRef<Record<string, File>>({})
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
  const setActiveTransfers = useCallback((next: ComposerUploadTransfer[]): void => {
    transfersRef.current = next
    setTransfers(next)
  }, [])
  const updateActiveTransfers = useCallback(
    (update: (current: ComposerUploadTransfer[]) => ComposerUploadTransfer[]): void => {
      setActiveTransfers(update(transfersRef.current))
    },
    [setActiveTransfers]
  )
  const clearPastedTextUndo = useCallback(
    (draftKey = activeDraftKeyRef.current): void => {
      delete removedPastedTextRef.current[draftKey]
      preferSnapshotUndoRef.current.delete(draftKey)
    },
    [activeDraftKeyRef]
  )
  const clearAllPastedTextUndo = useCallback((): void => {
    removedPastedTextRef.current = {}
    preferSnapshotUndoRef.current.clear()
  }, [])
  useEffect(
    () => () => {
      const transferIds = new Set(Object.keys(controllersRef.current))
      const retainedAttachmentPaths = new Set(attachmentsRef.current.map(({ path }) => path))
      const historyAttachments = new Map<string, UploadedAttachment>()
      for (const transfer of transfersRef.current) transferIds.add(transfer.transferId)
      for (const draft of Object.values(draftsRef.current)) {
        for (const transfer of draft.attachmentTransfers) transferIds.add(transfer.transferId)
        for (const attachment of draft.attachments) retainedAttachmentPaths.add(attachment.path)
      }
      for (const history of [undoRef.current, redoRef.current]) {
        for (const stack of Object.values(history)) {
          for (const snapshot of stack) {
            for (const transfer of snapshot.attachmentTransfers)
              transferIds.add(transfer.transferId)
            for (const attachment of snapshot.attachments)
              historyAttachments.set(attachment.path, attachment)
          }
        }
      }
      for (const transferId of transferIds) {
        cancelledTransfersRef.current.add(transferId)
        controllersRef.current[transferId]?.abort()
        void uploads.abortTransfer({ transferId }).catch(() => undefined)
      }
      for (const [path] of historyAttachments) {
        if (!retainedAttachmentPaths.has(path))
          void uploads.deleteUpload({ path }).catch(() => undefined)
      }
      transferFilesRef.current = {}
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
    [uploads, setError]
  )
  const currentSnapshot = useCallback(
    (caret?: ComposerCaretPosition): ComposerHistorySnapshot => {
      historySequenceRef.current += 1
      return {
        doc: docRef.current,
        annotations: [...annotationsRef.current],
        attachments: [...attachmentsRef.current],
        attachmentTransfers: [...transfersRef.current],
        automaticReadingEnabled: automaticReadingEnabledRef.current,
        readingContextSources: [...readingContextSourcesRef.current],
        caret,
        historySequence: historySequenceRef.current
      }
    },
    [annotationsRef, automaticReadingEnabledRef, docRef, readingContextSourcesRef]
  )
  const releaseHistoryResources = useCallback(
    (snapshots: readonly ComposerHistorySnapshot[]): void => {
      if (snapshots.length === 0) return
      const retainedAttachmentPaths = new Set(attachmentsRef.current.map(({ path }) => path))
      const retainedTransferIds = new Set(transfersRef.current.map(({ transferId }) => transferId))
      for (const draft of Object.values(draftsRef.current)) {
        for (const attachment of draft.attachments) retainedAttachmentPaths.add(attachment.path)
        for (const transfer of draft.attachmentTransfers)
          retainedTransferIds.add(transfer.transferId)
      }
      for (const cleanup of Object.values(deletionCleanupRef.current)) {
        for (const attachment of cleanup.attachments) retainedAttachmentPaths.add(attachment.path)
        for (const transfer of cleanup.attachmentTransfers)
          retainedTransferIds.add(transfer.transferId)
      }
      for (const history of [undoRef.current, redoRef.current]) {
        for (const stack of Object.values(history)) {
          for (const snapshot of stack) {
            for (const attachment of snapshot.attachments)
              retainedAttachmentPaths.add(attachment.path)
            for (const transfer of snapshot.attachmentTransfers)
              retainedTransferIds.add(transfer.transferId)
          }
        }
      }

      const discardedAttachments = new Map<string, UploadedAttachment>()
      const discardedTransferIds = new Set<string>()
      for (const snapshot of snapshots) {
        for (const attachment of snapshot.attachments) {
          if (!retainedAttachmentPaths.has(attachment.path))
            discardedAttachments.set(attachment.path, attachment)
        }
        for (const transfer of snapshot.attachmentTransfers) {
          if (!retainedTransferIds.has(transfer.transferId))
            discardedTransferIds.add(transfer.transferId)
        }
      }
      deleteAttachmentFiles([...discardedAttachments.values()])
      for (const transferId of discardedTransferIds) delete transferFilesRef.current[transferId]
    },
    [deleteAttachmentFiles, draftsRef]
  )
  const clearRedo = useCallback(
    (draftKey: string): void => {
      const discarded = redoRef.current[draftKey] ?? []
      delete redoRef.current[draftKey]
      releaseHistoryResources(discarded)
    },
    [releaseHistoryResources]
  )
  const clearUndo = useCallback(
    (draftKey = activeDraftKeyRef.current): void => {
      const discarded = [...(undoRef.current[draftKey] ?? []), ...(redoRef.current[draftKey] ?? [])]
      delete undoRef.current[draftKey]
      delete redoRef.current[draftKey]
      preferSnapshotUndoRef.current.delete(draftKey)
      releaseHistoryResources(discarded)
    },
    [activeDraftKeyRef, releaseHistoryResources]
  )
  const pushSnapshot = useCallback(
    (history: ComposerHistoryRef, draftKey: string, snapshot: ComposerHistorySnapshot): void => {
      const stack = history.current[draftKey] ?? []
      const next = [...stack, snapshot]
      history.current[draftKey] = next.slice(-100)
      releaseHistoryResources(next.slice(0, -100))
    },
    [releaseHistoryResources]
  )
  const captureUndo = useCallback(
    (draftKey = activeDraftKeyRef.current, caret?: ComposerCaretPosition): void => {
      clearRedo(draftKey)
      pushSnapshot(undoRef, draftKey, currentSnapshot(caret))
    },
    [activeDraftKeyRef, clearRedo, currentSnapshot, pushSnapshot]
  )
  const beginUndoTransaction = useCallback(
    (
      draftKey = activeDraftKeyRef.current,
      caret?: ComposerCaretPosition
    ): ComposerUndoTransaction => {
      const snapshot = currentSnapshot(caret)
      const previousRedo = redoRef.current[draftKey] ?? []
      delete redoRef.current[draftKey]
      pushSnapshot(undoRef, draftKey, snapshot)
      let settled = false

      const sameItems = <Value>(left: readonly Value[], right: readonly Value[]): boolean =>
        left.length === right.length && left.every((item, index) => item === right[index])
      const sameSources = (
        left: readonly SessionPdfContextSource[],
        right: readonly SessionPdfContextSource[]
      ): boolean =>
        left.length === right.length &&
        left.every(
          (source, index) =>
            source.sourceKind === right[index]?.sourceKind &&
            source.sourceVersionId === right[index]?.sourceVersionId
        )
      const sameContent = (
        left: ComposerHistorySnapshot,
        right: ComposerHistorySnapshot
      ): boolean =>
        left.doc === right.doc &&
        sameItems(left.annotations, right.annotations) &&
        sameItems(left.attachments, right.attachments) &&
        sameItems(left.attachmentTransfers, right.attachmentTransfers) &&
        sameSources(left.readingContextSources, right.readingContextSources)
      const sameNonReadingContent = (candidate: ComposerHistorySnapshot): boolean =>
        candidate.doc === snapshot.doc &&
        sameItems(candidate.annotations, snapshot.annotations) &&
        sameItems(candidate.attachments, snapshot.attachments) &&
        sameItems(candidate.attachmentTransfers, snapshot.attachmentTransfers)

      return {
        commit: (): void => {
          if (settled) return
          settled = true
          releaseHistoryResources(previousRedo)
        },
        rollback: (durableSources): void => {
          if (settled) return
          settled = true
          const newSnapshots = [
            ...(undoRef.current[draftKey] ?? []),
            ...(redoRef.current[draftKey] ?? [])
          ].filter((candidate) => candidate.historySequence >= snapshot.historySequence)
          const preservePreviousRedo = newSnapshots.every(sameNonReadingContent)
          const current = currentSnapshot()
          current.readingContextSources = [...durableSources]
          const discarded: ComposerHistorySnapshot[] = []

          const normalize = (stack: ComposerHistorySnapshot[]): ComposerHistorySnapshot[] => {
            const compacted: ComposerHistorySnapshot[] = []
            for (const candidate of stack) {
              const normalized =
                candidate.historySequence >= snapshot.historySequence
                  ? { ...candidate, readingContextSources: [...durableSources] }
                  : candidate
              const previous = compacted.at(-1)
              if (previous && sameContent(previous, normalized)) discarded.push(candidate)
              else compacted.push(normalized)
            }
            while (compacted.at(-1) && sameContent(compacted.at(-1)!, current)) {
              discarded.push(compacted.pop()!)
            }
            return compacted
          }

          const undo = normalize(undoRef.current[draftKey] ?? [])
          const redo = normalize(redoRef.current[draftKey] ?? [])
          if (undo.length > 0) undoRef.current[draftKey] = undo
          else delete undoRef.current[draftKey]
          if (preservePreviousRedo) {
            discarded.push(...redo)
            if (previousRedo.length > 0) redoRef.current[draftKey] = previousRedo
            else delete redoRef.current[draftKey]
          } else {
            discarded.push(...previousRedo)
            if (redo.length > 0) redoRef.current[draftKey] = redo
            else delete redoRef.current[draftKey]
          }
          releaseHistoryResources(discarded)
        }
      }
    },
    [activeDraftKeyRef, currentSnapshot, pushSnapshot, releaseHistoryResources]
  )
  const reconcileHistorySnapshots = useCallback(
    (
      draftKey: string,
      update: (snapshot: ComposerHistorySnapshot) => ComposerHistorySnapshot
    ): void => {
      for (const history of [undoRef, redoRef]) {
        const stack = history.current[draftKey]
        if (stack) history.current[draftKey] = stack.map(update)
      }
    },
    []
  )
  const reconcileFailedPastedTextUndo = useCallback(
    (draftKey: string, pastedTextId: string, transferId: string): void => {
      reconcileHistorySnapshots(draftKey, (snapshot) => ({
        ...snapshot,
        doc: restorePastedTextNode(snapshot.doc, pastedTextId)?.doc ?? snapshot.doc,
        attachmentTransfers: snapshot.attachmentTransfers.filter(
          (candidate) => candidate.transferId !== transferId
        )
      }))
      delete transferFilesRef.current[transferId]
    },
    [reconcileHistorySnapshots]
  )
  const updateDraftTransfers = useCallback(
    (
      draftKey: string,
      update: (current: ComposerUploadTransfer[]) => ComposerUploadTransfer[]
    ): void => {
      if (activeDraftKeyRef.current === draftKey) {
        updateActiveTransfers(update)
        return
      }
      const draft = draftsRef.current[draftKey]
      if (draft) draft.attachmentTransfers = update(draft.attachmentTransfers)
    },
    [activeDraftKeyRef, draftsRef, updateActiveTransfers]
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
        updateActiveTransfers((current) =>
          current.filter((transfer) => transfer.transferId !== transferId)
        )
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
      reconcileHistorySnapshots(draftKey, (snapshot) =>
        snapshot.attachmentTransfers.some((transfer) => transfer.transferId === transferId)
          ? {
              ...snapshot,
              doc: pastedTextId
                ? updatePastedTextNode(snapshot.doc, pastedTextId, (node) => ({
                    ...node,
                    transferId: undefined,
                    attachmentId: attachment.id
                  }))
                : snapshot.doc,
              attachmentTransfers: snapshot.attachmentTransfers.filter(
                (transfer) => transfer.transferId !== transferId
              ),
              attachments: [...snapshot.attachments, attachment]
            }
          : snapshot
      )
      delete transferFilesRef.current[transferId]
    },
    [
      activeDraftKeyRef,
      docRef,
      draftsRef,
      reconcileHistorySnapshots,
      updateActiveAttachments,
      updateActiveTransfers,
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
            try {
              await uploads.claimLocalFile?.({ transferId: transfer.transferId })
            } catch (claimError) {
              await uploads
                .abortTransfer({ transferId: transfer.transferId })
                .catch(() => undefined)
              throw claimError
            }
            commitDraftAttachment(draftKey, transfer.transferId, attachment, transfer.pastedTextId)
          } catch (uploadError) {
            if (controller.signal.aborted) {
              updateTransfer({ remove: true })
            } else {
              const message = t('Could not attach the file. Check available storage and try again.')
              if (transfer.pastedTextId) {
                updateTransfer({ remove: true })
                reconcileFailedPastedTextUndo(draftKey, transfer.pastedTextId, transfer.transferId)
                restorePastedTextInline(draftKey, transfer.pastedTextId)
              } else {
                updateTransfer({ status: 'error', error: message })
              }
              delete transferFilesRef.current[transfer.transferId]
              if (activeDraftKeyRef.current === draftKey) {
                setError(message)
                setErrorDetail(asText(uploadError))
              }
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
      reconcileFailedPastedTextUndo,
      updateDraftTransfers,
      uploads,
      setError,
      t
    ]
  )

  const stageFiles = useCallback(
    (files: File[]): void => {
      if (!canStageAttachments || files.length === 0) return
      if (
        files.some((file) => imageAttachmentMimeType(file.name, file.type) !== undefined) &&
        supportsImageInput !== true
      ) {
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
      for (const item of pending) transferFilesRef.current[item.transfer.transferId] = item.file
      captureUndo(draftKey)
      updateActiveTransfers((current) => [...current, ...pending.map(({ transfer }) => transfer)])
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
      transfers.length,
      captureUndo,
      updateActiveTransfers,
      setError
    ]
  )

  const deletePastedTextUpload = useCallback(
    (node: ComposerPastedTextNode, draftKey: string): void => {
      if (node.transferId) {
        cancelledTransfersRef.current.add(node.transferId)
        controllersRef.current[node.transferId]?.abort()
        updateActiveTransfers((current) =>
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
    [updateActiveAttachments, updateActiveTransfers, uploads, setError]
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
    (
      nextDoc: ComposerDoc,
      staged: ComposerPastedTextStage,
      preserveRemovalUndo = false,
      caret?: ComposerCaretPosition
    ): void => {
      const draftKey = activeDraftKeyRef.current
      if (!preserveRemovalUndo) clearPastedTextUndo(draftKey)
      clearHistory(draftKey)
      markChanged(draftKey)
      if (!preserveRemovalUndo) captureUndo(draftKey, caret)
      const releasedSlots = reconcileRemovedPastedTextUploads(nextDoc, draftKey)
      const nodes: readonly ComposerPastedTextNode[] = Array.isArray(staged)
        ? staged
        : [staged as ComposerPastedTextNode]
      const records = nodes.map((node) => ({
        node,
        file: new File([node.text], pastedTextFilename(node.text), { type: 'text/plain' })
      }))
      const intake = canStageAttachments
        ? planComposerAttachmentIntake(
            records.map(({ file }) => file),
            Math.max(0, attachments.length + transfers.length - releasedSlots)
          )
        : { accepted: [], error: null }
      setError(intake.error)
      const acceptedFiles = new Set(intake.accepted)
      const pending: Array<{ file: File; transfer: ComposerUploadTransfer }> = []
      let stagedDoc = nextDoc
      let restoredCaret: ComposerCaretPosition | undefined
      for (const { node, file } of records) {
        if (!acceptedFiles.has(file)) {
          const restored = restorePastedTextNode(stagedDoc, node.id)
          stagedDoc = restored?.doc ?? stagedDoc
          restoredCaret = restored?.caret ?? restoredCaret
          continue
        }
        const transfer: ComposerUploadTransfer = {
          transferId: crypto.randomUUID(),
          pastedTextId: node.id,
          name: file.name,
          mimeType: file.type,
          receivedBytes: 0,
          totalBytes: file.size,
          status: 'queued'
        }
        stagedDoc = updatePastedTextNode(stagedDoc, node.id, (current) => ({
          ...current,
          transferId: transfer.transferId,
          attachmentId: undefined
        }))
        pending.push({ file, transfer })
      }
      setActiveDoc(stagedDoc)
      if (restoredCaret) requestCaret(restoredCaret)
      if (pending.length === 0) return
      for (const item of pending) transferFilesRef.current[item.transfer.transferId] = item.file
      const pendingTransfers = pending.map(({ transfer }) => transfer)
      updateActiveTransfers((current) => [...current, ...pendingTransfers])
      deletionCleanupRef.current[draftKey]?.attachmentTransfers.push(...pendingTransfers)
      runPendingUploads(draftKey, pending)
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
      transfers.length,
      captureUndo,
      updateActiveTransfers,
      setError
    ]
  )

  const removePastedText = useCallback(
    (node: ComposerPastedTextNode): void => {
      const draftKey = activeDraftKeyRef.current
      clearUndo(draftKey)
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
    [
      activeDraftKeyRef,
      clearHistory,
      clearUndo,
      deletePastedTextUpload,
      docRef,
      markChanged,
      setActiveDoc
    ]
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
      clearRedo(draftKey)
      clearHistory(draftKey)
      markChanged(draftKey)
      restorePastedTextInline(draftKey, pastedTextId)
      deletePastedTextUpload(node, draftKey)
    },
    [
      activeDraftKeyRef,
      clearHistory,
      clearRedo,
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
    (nextDoc: ComposerDoc, caret?: ComposerCaretPosition): void => {
      const draftKey = activeDraftKeyRef.current
      const serializedNextDoc = JSON.stringify(nextDoc)
      // Backspace/Delete emits the current doc with exactly one atomic marker removed. Reuse the
      // attachment-close path so Cmd/Ctrl-Z receives the same restaging receipt.
      const atomicallyRemovedPastedText = docRef.current.nodes.find(
        (node): node is ComposerPastedTextNode =>
          node.type === 'pasted-text' &&
          JSON.stringify(removePastedTextNode(docRef.current, node.id)) === serializedNextDoc
      )
      if (atomicallyRemovedPastedText) {
        removePastedText(atomicallyRemovedPastedText)
        return
      }
      if (serializedNextDoc === JSON.stringify(docRef.current)) return
      captureUndo(draftKey, caret)
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
      docRef,
      markChanged,
      reconcileRemovedPastedTextUploads,
      removePastedText,
      setActiveDoc,
      captureUndo
    ]
  )

  const popSnapshot = useCallback(
    (history: ComposerHistoryRef, draftKey: string): ComposerHistorySnapshot | undefined => {
      const stack = history.current[draftKey]
      const snapshot = stack?.at(-1)
      if (!snapshot) return undefined
      if (stack.length > 1) history.current[draftKey] = stack.slice(0, -1)
      else delete history.current[draftKey]
      return snapshot
    },
    []
  )
  const applySnapshot = useCallback(
    (snapshot: ComposerHistorySnapshot, restartTransfers: boolean): void => {
      const draftKey = activeDraftKeyRef.current
      const resourcesToRelease = [currentSnapshot(), snapshot]
      let targetDoc = snapshot.doc
      const currentAttachmentIds = new Set(attachmentsRef.current.map(({ id }) => id))
      const targetAttachments = restartTransfers
        ? [...snapshot.attachments]
        : snapshot.attachments.filter(({ id }) => currentAttachmentIds.has(id))
      const currentTransferIds = new Set(transfersRef.current.map(({ transferId }) => transferId))
      const targetTransfers = restartTransfers
        ? []
        : snapshot.attachmentTransfers.filter(({ transferId }) =>
            currentTransferIds.has(transferId)
          )
      const pending: Array<{ file: File; transfer: ComposerUploadTransfer }> = []

      if (restartTransfers) {
        for (const previous of snapshot.attachmentTransfers) {
          const active = transfersRef.current.find(
            ({ transferId }) => transferId === previous.transferId
          )
          if (active) {
            targetTransfers.push(active)
            continue
          }
          if (previous.status === 'error') {
            targetTransfers.push(previous)
            continue
          }
          if (previous.status !== 'queued' && previous.status !== 'uploading') continue
          const file = transferFilesRef.current[previous.transferId]
          if (!file) continue
          const transfer: ComposerUploadTransfer = {
            ...previous,
            transferId: crypto.randomUUID(),
            receivedBytes: 0,
            status: 'queued',
            error: undefined
          }
          transferFilesRef.current[transfer.transferId] = file
          delete transferFilesRef.current[previous.transferId]
          targetTransfers.push(transfer)
          pending.push({ file, transfer })
          if (previous.pastedTextId) {
            targetDoc = updatePastedTextNode(targetDoc, previous.pastedTextId, (node) => ({
              ...node,
              transferId: transfer.transferId,
              attachmentId: undefined
            }))
          }
          reconcileHistorySnapshots(draftKey, (stored) => ({
            ...stored,
            doc: previous.pastedTextId
              ? updatePastedTextNode(stored.doc, previous.pastedTextId, (node) => ({
                  ...node,
                  transferId: transfer.transferId,
                  attachmentId: undefined
                }))
              : stored.doc,
            attachmentTransfers: stored.attachmentTransfers.map((candidate) =>
              candidate.transferId === previous.transferId ? transfer : candidate
            )
          }))
        }
      }

      const targetTransferIds = new Set(targetTransfers.map(({ transferId }) => transferId))
      for (const transfer of transfersRef.current) {
        if (targetTransferIds.has(transfer.transferId)) continue
        cancelledTransfersRef.current.add(transfer.transferId)
        controllersRef.current[transfer.transferId]?.abort()
        void uploads.abortTransfer({ transferId: transfer.transferId }).catch(() => undefined)
      }

      clearHistory(draftKey)
      markChanged(draftKey)
      const availableAttachmentIds = new Set(targetAttachments.map(({ id }) => id))
      const availableTransferIds = new Set(targetTransfers.map(({ transferId }) => transferId))
      const pastedTextToRestage = targetDoc.nodes.filter(
        (node): node is ComposerPastedTextNode =>
          node.type === 'pasted-text' &&
          (node.attachmentId
            ? !availableAttachmentIds.has(node.attachmentId)
            : !node.transferId || !availableTransferIds.has(node.transferId))
      )
      setActiveAttachments(targetAttachments)
      setActiveTransfers(targetTransfers)
      setActiveAnnotations([...snapshot.annotations])
      setActiveAutomaticReadingEnabled(snapshot.automaticReadingEnabled)
      if (pastedTextToRestage.length > 0) {
        const restagedIds = new Set(pastedTextToRestage.map(({ id }) => id))
        stagePastedText(
          {
            nodes: targetDoc.nodes.map((node) =>
              node.type === 'pasted-text' && restagedIds.has(node.id)
                ? { ...node, attachmentId: undefined, transferId: undefined }
                : node
            )
          },
          pastedTextToRestage.map((node) => ({
            ...node,
            attachmentId: undefined,
            transferId: undefined
          })),
          true
        )
      } else {
        setActiveDoc(targetDoc)
      }
      if (pending.length > 0) runPendingUploads(draftKey, pending)
      restoreReadingContextSources(snapshot.readingContextSources)
      releaseHistoryResources(resourcesToRelease)
      requestCaret(snapshot.caret ?? { nodeIndex: targetDoc.nodes.length, offset: 0 })
    },
    [
      activeDraftKeyRef,
      clearHistory,
      currentSnapshot,
      markChanged,
      reconcileHistorySnapshots,
      releaseHistoryResources,
      requestCaret,
      runPendingUploads,
      setActiveAttachments,
      setActiveAnnotations,
      setActiveDoc,
      setActiveTransfers,
      setActiveAutomaticReadingEnabled,
      stagePastedText,
      restoreReadingContextSources,
      uploads
    ]
  )
  const undo = useCallback(
    (caret?: ComposerCaretPosition): boolean => {
      const draftKey = activeDraftKeyRef.current
      const preferSnapshot = preferSnapshotUndoRef.current.delete(draftKey)
      if (!preferSnapshot && removedPastedTextRef.current[draftKey]?.length) {
        pushSnapshot(redoRef, draftKey, currentSnapshot(caret))
        return undoPastedTextRemoval()
      }
      const snapshot = popSnapshot(undoRef, draftKey)
      if (!snapshot) return false
      pushSnapshot(redoRef, draftKey, currentSnapshot(caret))
      applySnapshot(snapshot, false)
      return true
    },
    [
      activeDraftKeyRef,
      applySnapshot,
      currentSnapshot,
      popSnapshot,
      pushSnapshot,
      undoPastedTextRemoval
    ]
  )
  const redo = useCallback(
    (caret?: ComposerCaretPosition): boolean => {
      const draftKey = activeDraftKeyRef.current
      const snapshot = popSnapshot(redoRef, draftKey)
      if (!snapshot) return false
      pushSnapshot(undoRef, draftKey, currentSnapshot(caret))
      if (removedPastedTextRef.current[draftKey]?.length)
        preferSnapshotUndoRef.current.add(draftKey)
      applySnapshot(snapshot, true)
      return true
    },
    [activeDraftKeyRef, applySnapshot, currentSnapshot, popSnapshot, pushSnapshot]
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
      clearUndo(draftKey)
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
        .finally(() => {
          delete transferFilesRef.current[transfer.transferId]
          updateDraftTransfers(draftKey, (current) =>
            current.filter((candidate) => candidate.transferId !== transfer.transferId)
          )
        })
    },
    [
      activeDraftKeyRef,
      clearPastedTextUndo,
      clearUndo,
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
      clearUndo()
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
      clearUndo,
      docRef,
      markChanged,
      removePastedText,
      updateActiveAttachments,
      uploads,
      setError
    ]
  )

  const activateDraftAttachments = useCallback(
    (draft: ComposerDraft): void => {
      setActiveAttachments(draft.attachments)
      setActiveTransfers(draft.attachmentTransfers)
      clearAllPastedTextUndo()
    },
    [clearAllPastedTextUndo, setActiveAttachments, setActiveTransfers]
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
      clearUndo(draftKey)
      if (activeDraftKeyRef.current === draftKey) {
        setActiveAttachments([])
        setActiveTransfers([])
        setError(null)
      }
      for (const transfer of cleanup.attachmentTransfers) {
        delete transferFilesRef.current[transfer.transferId]
        cancelledTransfersRef.current.add(transfer.transferId)
        controllersRef.current[transfer.transferId]?.abort()
        void uploads.abortTransfer({ transferId: transfer.transferId })
      }
      deleteAttachmentFiles(cleanup.attachments)
    },
    [
      activeDraftKeyRef,
      clearHistory,
      clearPastedTextUndo,
      clearUndo,
      deleteAttachmentFiles,
      draftsRef,
      setActiveAttachments,
      setActiveTransfers,
      uploads,
      setError
    ]
  )

  return {
    view: {
      attachments,
      transfers,
      error,
      errorDetail,
      isUploading: transfers.some(unfinishedComposerUpload)
    },
    actions: {
      changeDoc,
      stageFiles,
      stagePastedText: (doc, node, caret) => stagePastedText(doc, node, false, caret),
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

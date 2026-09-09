import { create } from 'zustand'
import type { LiteratureCatalogReceipt, LiteratureItemView } from '../../../../shared/literature'

export type AttachmentAction = 'verify' | 'remove'
export type AttachmentOperation = {
  itemId: string
  attachmentId: string
  title: string
  action: AttachmentAction
  pending: boolean
  item?: LiteratureItemView
  receipt?: LiteratureCatalogReceipt
  error?: unknown
  refreshFailed?: boolean
}

type AttachmentOperations = {
  operations: AttachmentOperation[]
  run: (
    item: LiteratureItemView,
    attachmentId: string,
    action: AttachmentAction,
    versionId?: string
  ) => Promise<void>
  dismiss: (operation: AttachmentOperation) => void
}

// Renderer-memory ownership survives detail and page mounts, not application restarts.
export const useAttachmentOperations = create<AttachmentOperations>((set, get) => ({
  operations: [],
  dismiss: (operation) => {
    if (!operation.pending)
      set({ operations: get().operations.filter((entry) => entry !== operation) })
  },
  run: async (item, attachmentId, action, versionId) => {
    // Preserve the existing per-item exclusion, including conflicting actions on other attachments.
    if (get().operations.some((entry) => entry.itemId === item.id && entry.pending)) return
    const attachment = item.attachments.find((entry) => entry.id === attachmentId)
    if (!attachment || (action === 'verify' && !versionId)) return
    const operation: AttachmentOperation = {
      itemId: item.id,
      attachmentId,
      title: attachment.versions[0]?.filename ?? attachment.title,
      action,
      pending: true
    }
    set({
      operations: [
        ...get().operations.filter(
          (entry) => entry.itemId !== item.id || entry.attachmentId !== attachmentId
        ),
        operation
      ]
    })
    let receipt: LiteratureCatalogReceipt | undefined
    let error: unknown
    try {
      receipt = await window.api.literature.transact(
        action === 'remove'
          ? { kind: 'delete-attachment', itemId: item.id, attachmentId }
          : { kind: 'verify-attachment', itemId: item.id, versionId: versionId! }
      )
    } catch (failure) {
      error = failure
    }
    const updated =
      receipt || action === 'verify'
        ? await window.api.literature.get(item.id).catch(() => undefined)
        : undefined
    // A refresh failure cannot restore an attachment whose deletion has committed.
    const result =
      updated ??
      (receipt && action === 'remove'
        ? { ...item, attachments: item.attachments.filter((entry) => entry.id !== attachmentId) }
        : undefined)
    set({
      operations: get().operations.map((entry) =>
        entry === operation
          ? {
              ...operation,
              pending: false,
              receipt,
              error,
              item: result,
              refreshFailed: !!receipt && !updated
            }
          : entry
      )
    })
  }
}))

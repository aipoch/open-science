import type {
  BrowserPackageTransfer,
  PackageOperationSnapshot
} from '../../../shared/session-package'
import { packageOperationActive } from '@/stores/package-operation-store'

const unsettled = (transfer: BrowserPackageTransfer): boolean =>
  transfer.state !== 'cancelled' && transfer.state !== 'failed'

export const primaryBrowserTransfer = (
  operation: PackageOperationSnapshot
): BrowserPackageTransfer | undefined => operation.browserTransfers?.at(-1)

// Project only the display: queue actions, retries and cleanup still address the original owner.
export const packageOperationPresentation = (
  operation: PackageOperationSnapshot | null,
  receipt?: BrowserPackageTransfer
): PackageOperationSnapshot | null => {
  if (!operation) return null
  const live =
    operation.browserTransfers?.filter(
      (transfer) => unsettled(transfer) || transfer.cleanupPending
    ) ?? []
  if (receipt && !live.some((t) => t.id === receipt.id)) live.push(receipt)
  if (!live.length) return operation
  const current = { ...operation, browserTransfers: live }
  if (
    (!operation.browserReceiptOnly && packageOperationActive(operation)) ||
    operation.result?.recovery
  )
    return current
  const primary = primaryBrowserTransfer(current)!
  return {
    id: operation.id,
    kind: 'import',
    browserReceiptOnly: true,
    state: live.some((t) => unsettled(t) || t.cleanupPending)
      ? 'running'
      : primary.state === 'failed'
        ? 'failed'
        : 'cancelled',
    progress: { phase: 'preparing' },
    importFilename: primary.filename,
    presentationRevision: operation.presentationRevision,
    browserTransfers: live,
    pendingImports: operation.pendingImports,
    importQueueFull: operation.importQueueFull
  }
}

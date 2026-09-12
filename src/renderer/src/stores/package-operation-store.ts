import { create } from 'zustand'
import { PACKAGE_MAX_FILE_BYTES } from '../../../shared/session-package'
import type { PackageOperationSnapshot } from '../../../shared/session-package'

export const usePackageOperationStore = create<{
  operation: PackageOperationSnapshot | null
  importError?: string
  setImportError: (error: string | undefined) => void
  open: boolean
  dismissedId?: string
  dismiss: () => void
  excludedStorageKeys: string[] | null
  selectionPreset: 'full' | 'compact' | 'custom'
  threshold: string
  setThreshold: (threshold: string) => void
  receive: (operation: PackageOperationSnapshot | null) => void
  setOpen: (open: boolean) => void
}>((set) => ({
  operation: null,
  setImportError: (importError) => set({ importError }),
  open: false,
  excludedStorageKeys: null,
  selectionPreset: 'full',
  threshold: '256',
  setThreshold: (threshold) => set({ threshold }),
  dismiss: () =>
    set((state) =>
      packageOperationActive(state.operation)
        ? {}
        : { open: false, dismissedId: state.operation?.id }
    ),
  receive: (operation) =>
    set((state) => {
      const same = operation?.id === state.operation?.id
      const retry =
        state.operation?.state === 'failed' &&
        operation?.kind === 'export' &&
        state.operation.kind === 'export' &&
        operation.session?.projectId === state.operation.session?.projectId &&
        operation.session?.sessionId === state.operation.session?.sessionId
      const draft = same || retry ? state.excludedStorageKeys : null
      const available =
        operation?.files &&
        new Set(
          operation.files.filter((file) => !file.requiredForEvidence).map((file) => file.storageKey)
        )
      return {
        operation,
        dismissedId: same ? state.dismissedId : undefined,
        excludedStorageKeys: operation?.files
          ? [
              ...new Set([
                ...((same || retry) && state.selectionPreset === 'compact'
                  ? operation.files
                      .filter((file) => !file.requiredForEvidence)
                      .map((file) => file.storageKey)
                  : (draft ?? []).filter((key) => available!.has(key))),
                ...operation.files
                  .filter(
                    (file) => !file.requiredForEvidence && file.sizeBytes > PACKAGE_MAX_FILE_BYTES
                  )
                  .map((file) => file.storageKey)
              ])
            ]
          : draft,
        selectionPreset:
          operation?.files?.some((file) => file.sizeBytes > PACKAGE_MAX_FILE_BYTES) &&
          (!(same || retry) || state.selectionPreset === 'full')
            ? 'custom'
            : same || retry
              ? state.selectionPreset
              : 'full',
        threshold: same || retry ? state.threshold : '256',
        open:
          same && state.dismissedId === operation?.id
            ? false
            : (same && operation?.presentationRevision !== state.operation?.presentationRevision) ||
                operation?.state === 'awaiting-selection' ||
                (!same && operation?.state === 'running')
              ? true
              : state.open
      }
    }),
  setOpen: (open) => set({ open })
}))

export const packageOperationActive = (operation: PackageOperationSnapshot | null): boolean =>
  operation !== null && ['running', 'awaiting-selection', 'cancelling'].includes(operation.state)

export const sessionExportLocked = (
  operation: PackageOperationSnapshot | null,
  session: { id: string; projectId: string } | undefined
): boolean =>
  Boolean(
    session &&
    operation?.kind === 'export' &&
    operation.progress.phase !== 'cleaning' &&
    packageOperationActive(operation) &&
    operation.session?.sessionId === session.id &&
    operation.session.projectId === session.projectId
  )

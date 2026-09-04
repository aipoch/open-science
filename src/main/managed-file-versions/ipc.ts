import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type {
  ManagedFileVersionInspectRequest,
  ManagedFileVersionInspectResult,
  ManagedFileVersionIpcResult,
  ManagedFileVersionSaveTextEditRequest,
  ManagedFileVersionCancelDiffRequest,
  ManagedFileVersionDiffRequest,
  ManagedFileVersionDiffResult,
  SaveTextEditResult
} from '../../shared/managed-file-versions'
import { ipcMainHandle } from '../ipc-handler-registry'
import { ManagedFileVersionError } from './error'

type ManagedFileVersionIpcService = {
  inspect(request: ManagedFileVersionInspectRequest): Promise<ManagedFileVersionInspectResult>
  diffText(request: ManagedFileVersionDiffRequest): Promise<ManagedFileVersionDiffResult>
  cancelDiff(requestId: string): boolean
  saveTextEdit(request: ManagedFileVersionSaveTextEditRequest): Promise<SaveTextEditResult>
}

type ManagedFileVersionHandlerDependencies = {
  withDataRootWrite<Result>(write: () => Promise<Result>): Promise<Result>
  onChanged?(event: ProjectFilesChangedEvent): void
}

type ManagedFileVersionHandlers = {
  inspect(
    request: ManagedFileVersionInspectRequest
  ): Promise<ManagedFileVersionIpcResult<ManagedFileVersionInspectResult>>
  diffText(
    request: ManagedFileVersionDiffRequest
  ): Promise<ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>>
  cancelDiff(
    request: ManagedFileVersionCancelDiffRequest
  ): ManagedFileVersionIpcResult<{ cancelled: boolean }>
  saveTextEdit(
    request: ManagedFileVersionSaveTextEditRequest
  ): Promise<ManagedFileVersionIpcResult<SaveTextEditResult>>
}

const rendererResult = async <Value>(
  operation: () => Promise<Value>
): Promise<ManagedFileVersionIpcResult<Value>> => {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (error instanceof ManagedFileVersionError) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return {
      ok: false,
      error: {
        code: 'CONTENT_INTEGRITY_FAILED',
        message: 'Managed file operation failed.'
      }
    }
  }
}

const createManagedFileVersionHandlers = (
  service: ManagedFileVersionIpcService,
  dependencies: ManagedFileVersionHandlerDependencies
): ManagedFileVersionHandlers => ({
  inspect: (request) => rendererResult(() => service.inspect(request)),
  diffText: (request) => rendererResult(() => service.diffText(request)),
  cancelDiff: ({ requestId }) => ({
    ok: true,
    value: { cancelled: service.cancelDiff(requestId) }
  }),
  saveTextEdit: (request) =>
    rendererResult(async () => {
      const result = await dependencies.withDataRootWrite(() => service.saveTextEdit(request))
      if (result.kind === 'created' && !result.replayed) {
        dependencies.onChanged?.({
          projectId: request.projectId,
          sources: [request.source],
          kind: 'upsert'
        })
      }
      return result
    })
})

const registerManagedFileVersionIpcHandlers = (handlers: ManagedFileVersionHandlers): void => {
  const maxActiveDiffsPerSender = 2
  const maxActiveDiffsGlobal = 4
  const requestOwner = new Map<string, number>()
  const senderRequests = new Map<number, Set<string>>()
  const observedSenders = new Set<number>()
  const destroyedSenders = new Set<number>()
  const cancellationRequested = new Set<string>()

  const ownRequest = (
    sender: { id: number; once(event: 'destroyed', listener: () => void): unknown },
    requestId: string
  ): 'owned' | 'collision' | 'limit' => {
    if (requestOwner.has(requestId)) return 'collision'
    if (
      requestOwner.size >= maxActiveDiffsGlobal ||
      (senderRequests.get(sender.id)?.size ?? 0) >= maxActiveDiffsPerSender
    )
      return 'limit'
    requestOwner.set(requestId, sender.id)
    let requests = senderRequests.get(sender.id)
    if (!requests) {
      requests = new Set()
      senderRequests.set(sender.id, requests)
    }
    requests.add(requestId)
    if (observedSenders.has(sender.id)) return 'owned'
    observedSenders.add(sender.id)
    sender.once('destroyed', () => {
      if ((senderRequests.get(sender.id)?.size ?? 0) === 0) {
        observedSenders.delete(sender.id)
        destroyedSenders.delete(sender.id)
        return
      }
      destroyedSenders.add(sender.id)
      for (const ownedRequestId of senderRequests.get(sender.id) ?? []) {
        if (requestOwner.get(ownedRequestId) !== sender.id) continue
        if (cancellationRequested.has(ownedRequestId)) continue
        cancellationRequested.add(ownedRequestId)
        handlers.cancelDiff({ requestId: ownedRequestId })
      }
    })
    return 'owned'
  }

  const releaseRequest = (senderId: number, requestId: string): void => {
    if (requestOwner.get(requestId) !== senderId) return
    requestOwner.delete(requestId)
    cancellationRequested.delete(requestId)
    const requests = senderRequests.get(senderId)
    requests?.delete(requestId)
    if (requests?.size === 0) {
      senderRequests.delete(senderId)
      if (destroyedSenders.delete(senderId)) observedSenders.delete(senderId)
    }
  }

  ipcMainHandle(
    'managed-file-versions:inspect',
    (_event, request: ManagedFileVersionInspectRequest) => handlers.inspect(request)
  )
  ipcMainHandle(
    'managed-file-versions:diff-text',
    async (
      event: { sender: { id: number; once(event: 'destroyed', listener: () => void): unknown } },
      request: ManagedFileVersionDiffRequest
    ) => {
      const ownership = ownRequest(event.sender, request.requestId)
      if (ownership !== 'owned') {
        return {
          ok: false as const,
          error: {
            code:
              ownership === 'collision'
                ? ('INVALID_REQUEST' as const)
                : ('DIFF_CONCURRENCY_LIMIT' as const),
            message:
              ownership === 'collision'
                ? 'Diff request id is already active.'
                : 'Too many diff requests are active.'
          }
        }
      }
      try {
        return await handlers.diffText(request)
      } finally {
        releaseRequest(event.sender.id, request.requestId)
      }
    }
  )
  ipcMainHandle(
    'managed-file-versions:cancel-diff',
    (event: { sender: { id: number } }, request: ManagedFileVersionCancelDiffRequest) => {
      if (requestOwner.get(request.requestId) !== event.sender.id) {
        return { ok: true as const, value: { cancelled: false } }
      }
      if (cancellationRequested.has(request.requestId)) {
        return { ok: true as const, value: { cancelled: false } }
      }
      cancellationRequested.add(request.requestId)
      handlers.cancelDiff(request)
      return { ok: true as const, value: { cancelled: true } }
    }
  )
  ipcMainHandle(
    'managed-file-versions:save-text-edit',
    (_event, request: ManagedFileVersionSaveTextEditRequest) => handlers.saveTextEdit(request)
  )
}

export { createManagedFileVersionHandlers, registerManagedFileVersionIpcHandlers }
export type {
  ManagedFileVersionHandlerDependencies,
  ManagedFileVersionHandlers,
  ManagedFileVersionIpcService
}

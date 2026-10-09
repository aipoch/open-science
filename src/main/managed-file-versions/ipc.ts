import type { ApplicationCallerLease, ApplicationInvocation } from '../application-command-router'
import { callerContextForEvent } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
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

export type ManagedFileVersionCommandOwner = Readonly<{
  inspect: ManagedFileVersionHandlers['inspect']
  saveTextEdit: ManagedFileVersionHandlers['saveTextEdit']
  diffText(
    invocation: ApplicationInvocation<readonly [ManagedFileVersionDiffRequest]>
  ): ReturnType<ManagedFileVersionHandlers['diffText']>
  cancelDiff(
    invocation: ApplicationInvocation<readonly [ManagedFileVersionCancelDiffRequest]>
  ): ReturnType<ManagedFileVersionHandlers['cancelDiff']>
}>

// One owner retains diff admission through cancellation until the worker settles. Lifetimes come
// from the application caller lease, so navigation, a crash and a disconnected desktop revoke
// exactly the same work without keeping WebContents objects in the core.
export const createManagedFileVersionCommandOwner = (
  handlers: ManagedFileVersionHandlers
): ManagedFileVersionCommandOwner => {
  const requestOwners = new Map<string, ApplicationCallerLease>()
  const callers = new Map<ApplicationCallerLease, { requests: Set<string>; cancel: () => void }>()
  const cancellationRequested = new Set<string>()
  const cancel = (lease: ApplicationCallerLease, requestId: string): boolean => {
    if (requestOwners.get(requestId) !== lease || cancellationRequested.has(requestId)) return false
    cancellationRequested.add(requestId)
    handlers.cancelDiff({ requestId })
    return true
  }
  return {
    inspect: handlers.inspect,
    saveTextEdit: handlers.saveTextEdit,
    diffText: async ({ callerLease, args: [request] }) => {
      if (
        callerLease.signal.aborted ||
        !callerLease.isCurrent() ||
        typeof request?.requestId !== 'string' ||
        !request.requestId
      ) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'Diff caller or request is no longer valid.' }
        }
      }
      const existing = callers.get(callerLease)
      if (requestOwners.has(request.requestId)) {
        return {
          ok: false,
          error: { code: 'INVALID_REQUEST', message: 'Diff request id is already active.' }
        }
      }
      if (requestOwners.size >= 4 || (existing?.requests.size ?? 0) >= 2) {
        return {
          ok: false,
          error: { code: 'DIFF_CONCURRENCY_LIMIT', message: 'Too many diff requests are active.' }
        }
      }
      const caller = existing ?? {
        requests: new Set<string>(),
        cancel: () => {
          for (const requestId of callers.get(callerLease)?.requests ?? [])
            cancel(callerLease, requestId)
        }
      }
      callers.set(callerLease, caller)
      if (!existing) callerLease.signal.addEventListener('abort', caller.cancel, { once: true })
      requestOwners.set(request.requestId, callerLease)
      caller.requests.add(request.requestId)
      try {
        return await handlers.diffText(request)
      } finally {
        requestOwners.delete(request.requestId)
        cancellationRequested.delete(request.requestId)
        caller.requests.delete(request.requestId)
        if (caller.requests.size === 0) {
          callers.delete(callerLease)
          callerLease.signal.removeEventListener('abort', caller.cancel)
        }
      }
    },
    cancelDiff: ({ callerLease, args: [request] }) => ({
      ok: true,
      value: { cancelled: cancel(callerLease, request.requestId) }
    })
  }
}

const registerManagedFileVersionIpcHandlers = (owner: ManagedFileVersionCommandOwner): void => {
  ipcMainHandle(
    'managed-file-versions:inspect',
    (_event, request: ManagedFileVersionInspectRequest) => owner.inspect(request)
  )
  ipcMainHandle(
    'managed-file-versions:save-text-edit',
    (_event, request: ManagedFileVersionSaveTextEditRequest) => owner.saveTextEdit(request)
  )
  ipcMainHandle(
    'managed-file-versions:diff-text',
    (event, request: ManagedFileVersionDiffRequest) =>
      owner.diffText({
        callerContext: callerContextForEvent(event),
        callerLease: callerLeaseForEvent(event),
        args: [request]
      })
  )
  ipcMainHandle(
    'managed-file-versions:cancel-diff',
    (event, request: ManagedFileVersionCancelDiffRequest) =>
      owner.cancelDiff({
        callerContext: callerContextForEvent(event),
        callerLease: callerLeaseForEvent(event),
        args: [request]
      })
  )
}

export { createManagedFileVersionHandlers, registerManagedFileVersionIpcHandlers }
export type {
  ManagedFileVersionHandlerDependencies,
  ManagedFileVersionHandlers,
  ManagedFileVersionIpcService
}

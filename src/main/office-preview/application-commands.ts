import { createLogger, diagnosticErrorFields } from '../logger'
import { randomUUID } from 'node:crypto'
import type { ApplicationCallerLease, ApplicationInvocation } from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
import type { ManagedPreviewResources } from '../managed-preview-resources'
import type { ManagedPreviewOwnerRegistry } from '../managed-preview-owner-registry'
import {
  OfficePreviewSupervisor,
  OfficePreviewOpenSupersededError
} from './office-preview-supervisor'
import { createOfficePreviewRuntimeUrl } from './office-preview-runtime-protocol'
import {
  isOfficePreviewRuntimeState,
  isOfficePreviewOpenRequest,
  type OfficePreviewOpenRequest,
  type OfficePreviewOpenResult,
  type OfficePreviewAttachResult,
  type OfficePreviewRuntimeState
} from '../../shared/office-preview'
import type { AcquireManagedPreviewRequest } from '../../shared/preview-resources'
import { DesktopCapabilityUnavailable } from '../desktop-interaction'
import type { DesktopNativeOperation } from '../desktop-native-contract'

export type OfficePreviewHost = {
  resolveFrame(
    clientId: string,
    runtimeUrl: string
  ): Promise<{ frameProcessId: number; parentProcessId: number } | undefined>
  processMemory(processId: number): Promise<number>
}
let host: OfficePreviewHost | undefined
export function configureOfficePreviewHost(value: OfficePreviewHost): void {
  if (host) throw new Error('Office preview host is already configured.')
  host = value
}
export function createRemoteOfficePreviewHost(
  request: (operation: DesktopNativeOperation, clientId?: string) => Promise<unknown>
): OfficePreviewHost {
  return {
    resolveFrame: async (clientId, runtimeUrl) =>
      (await request({ operation: 'office-frame', runtimeUrl }, clientId)) as Awaited<
        ReturnType<OfficePreviewHost['resolveFrame']>
      >,
    processMemory: async (processId) =>
      (await request({ operation: 'process-memory', processId })) as number
  }
}
export type OfficePreviewCommands = {
  open(
    invocation: ApplicationInvocation<readonly [OfficePreviewOpenRequest]>
  ): Promise<OfficePreviewOpenResult>
  attachFrame(
    invocation: ApplicationInvocation<readonly [string]>
  ): Promise<OfficePreviewAttachResult | undefined>
  close(invocation: ApplicationInvocation<readonly [string]>): Promise<void>
  reportState(invocation: ApplicationInvocation<readonly [string, OfficePreviewRuntimeState]>): void
  dispose(): Promise<void>
}

export function createOfficePreviewCommands(
  resources: Pick<ManagedPreviewResources, 'inspect' | 'acquire' | 'release' | 'releaseOwner'>,
  registry: ManagedPreviewOwnerRegistry,
  report: (clientId: string, state: OfficePreviewRuntimeState) => void,
  previewHost: OfficePreviewHost = {
    resolveFrame: (clientId, runtimeUrl) => {
      if (!host) throw new DesktopCapabilityUnavailable('Office preview')
      return host.resolveFrame(clientId, runtimeUrl)
    },
    processMemory: (processId) => {
      if (!host) throw new DesktopCapabilityUnavailable('Office preview')
      return host.processMemory(processId)
    }
  }
): OfficePreviewCommands {
  const callers = new Map<
    number,
    { clientId: string; lease: ApplicationCallerLease; release(): void }
  >()
  const toRequest = (request: OfficePreviewOpenRequest): AcquireManagedPreviewRequest =>
    request.source === 'notebook-input'
      ? { source: request.source, path: request.path }
      : {
          source: request.source,
          projectId: request.projectId,
          fileId: request.fileId,
          ...(request.versionId ? { versionId: request.versionId } : {})
        }
  const supervisor = new OfficePreviewSupervisor({
    inspectResource: (request) => resources.inspect(toRequest(request)),
    acquireResource: (ownerId, request, snapshot, maxBytes) =>
      resources.acquire(ownerId, toRequest(request), { snapshot, maxBytes }),
    releaseResource: (ownerId, resourceId) => {
      if (callers.has(ownerId)) resources.release(ownerId, { resourceId })
      else resources.releaseOwner(ownerId)
    },
    createSessionId: randomUUID,
    createRuntimeUrl: createOfficePreviewRuntimeUrl,
    resolveFrameProcess: async (ownerId, runtimeUrl) => {
      const caller = callers.get(ownerId)
      if (!caller || caller.lease.signal.aborted || !caller.lease.isCurrent()) return undefined
      return previewHost.resolveFrame(caller.clientId, runtimeUrl)
    },
    getProcessMemoryUsageBytes: previewHost.processMemory,
    publishState: (ownerId, state) => {
      const caller = callers.get(ownerId)
      if (caller && !caller.lease.signal.aborted && caller.lease.isCurrent())
        report(caller.clientId, state)
    }
  })
  const pendingCleanup = new Set<Promise<void>>()
  let disposed = false
  const caller = (invocation: ApplicationInvocation<readonly unknown[]>): number => {
    requireDesktopCaller(invocation.callerContext)
    if (disposed) throw new Error('Office preview commands are disposed.')
    const { ownerId } = registry.register(invocation.callerLease)
    if (!callers.has(ownerId)) {
      const { callerLease: lease } = invocation
      const release = (): void => {
        lease.signal.removeEventListener('abort', release)
        callers.delete(ownerId)
        const cleanup = supervisor.closeOwner(ownerId)
        pendingCleanup.add(cleanup)
        void cleanup
          .finally(() => pendingCleanup.delete(cleanup))
          .catch((error) =>
            createLogger('office-preview').error(
              'failed to close preview owner',
              diagnosticErrorFields(error)
            )
          )
      }
      callers.set(ownerId, { clientId: invocation.callerContext.clientId, lease, release })
      lease.signal.addEventListener('abort', release, { once: true })
    }
    return ownerId
  }
  return {
    open: async (invocation) => {
      const ownerId = caller(invocation)
      if (!isOfficePreviewOpenRequest(invocation.args[0]))
        throw new Error('Invalid Office preview request.')
      try {
        return await supervisor.open(ownerId, invocation.args[0])
      } catch (error) {
        if (error instanceof OfficePreviewOpenSupersededError) return { kind: 'cancelled' }
        throw error
      }
    },
    attachFrame: (invocation) => {
      const ownerId = caller(invocation)
      return typeof invocation.args[0] === 'string' && invocation.args[0]
        ? supervisor.attachFrame(ownerId, invocation.args[0])
        : Promise.resolve(undefined)
    },
    close: (invocation) => {
      const ownerId = caller(invocation)
      return typeof invocation.args[0] === 'string' && invocation.args[0]
        ? supervisor.close(ownerId, invocation.args[0])
        : Promise.resolve()
    },
    reportState: (invocation) => {
      const ownerId = caller(invocation)
      const [sessionId, state] = invocation.args
      if (
        typeof sessionId === 'string' &&
        sessionId &&
        isOfficePreviewRuntimeState(state) &&
        state.sessionId === sessionId
      )
        supervisor.reportState(ownerId, sessionId, state)
    },
    dispose: async () => {
      disposed = true
      for (const current of callers.values()) current.release()
      await Promise.all([...pendingCleanup])
    }
  }
}

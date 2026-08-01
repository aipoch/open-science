import { installAcpIpcHandlers } from './acp/ipc'
import type { AcpRuntimeCoordinator } from './acp/runtime-coordinator'
import { installComputeIpcHandlers, type ComputeIpcModule } from './compute/ipc'
import type { TaskNotificationService } from './notifications/task-notifications'

export type NamedElectronSurfaceAdapter = {
  readonly name: string
  install(): void | Promise<void>
}

export type ElectronRuntimeAdapterInterfaces = {
  readonly beforeCompute: readonly NamedElectronSurfaceAdapter[]
  readonly compute: Pick<ComputeIpcModule, 'handlers' | 'enabledComputeHostsRegistry'>
  readonly beforeAcp: readonly NamedElectronSurfaceAdapter[]
  readonly acp: {
    runtime: AcpRuntimeCoordinator
    taskNotifications: TaskNotificationService
  }
  readonly afterAcp: readonly NamedElectronSurfaceAdapter[]
}

// Production transport wiring for application-owned runtimes. Compute and ACP are required named
// interfaces rather than optional entries in a generic list, so composition cannot silently omit one.
export const installElectronRuntimeAdapters = async ({
  beforeCompute,
  compute,
  beforeAcp,
  acp,
  afterAcp
}: ElectronRuntimeAdapterInterfaces): Promise<void> => {
  for (const surface of beforeCompute) await surface.install()
  installComputeIpcHandlers(compute)
  for (const surface of beforeAcp) await surface.install()
  installAcpIpcHandlers(acp.runtime, acp.taskNotifications)
  for (const surface of afterAcp) await surface.install()
}

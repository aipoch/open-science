import {
  installAcpIpcHandlers,
  type AcpIpcSessionAdmission,
  type AcpSessionMemoryPreferenceResolver
} from './acp/ipc'
import type { AcpHandlerWorkflows } from './acp/handler-workflows'
import type { AcpRuntimeCoordinator } from './acp/runtime-coordinator'
import { installComputeIpcHandlers, type ComputeIpcAdapter } from './compute/ipc'

type Awaitable<T> = T | Promise<T>

export type InstalledElectronSurfaceAdapter = {
  uninstall(): Awaitable<void>
}

export type NamedElectronSurfaceAdapter = {
  readonly name: string
  install(): Awaitable<InstalledElectronSurfaceAdapter>
}

export type ElectronRuntimeAdapterInterfaces = {
  readonly beforeCompute: readonly NamedElectronSurfaceAdapter[]
  readonly compute: ComputeIpcAdapter
  readonly beforeAcp: readonly NamedElectronSurfaceAdapter[]
  readonly acp: {
    runtime: AcpRuntimeCoordinator
    workflows: AcpHandlerWorkflows
    sessionAdmission: AcpIpcSessionAdmission
    resolveMemoryEnabled?: AcpSessionMemoryPreferenceResolver
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
}: ElectronRuntimeAdapterInterfaces): Promise<InstalledElectronSurfaceAdapter> => {
  const installed: Array<{ name: string; installation: InstalledElectronSurfaceAdapter }> = []
  const install = async (
    name: string,
    operation: () => Awaitable<InstalledElectronSurfaceAdapter>
  ): Promise<void> => {
    installed.push({ name, installation: await operation() })
  }
  const uninstall = async (): Promise<void> => {
    const failures: unknown[] = []
    for (const { installation } of [...installed].reverse()) {
      try {
        await installation.uninstall()
      } catch (error) {
        failures.push(error)
      }
    }
    installed.length = 0
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Electron runtime adapter uninstall failed.')
    }
  }

  try {
    for (const surface of beforeCompute) await install(surface.name, () => surface.install())
    await install('compute', () => installComputeIpcHandlers(compute))
    for (const surface of beforeAcp) await install(surface.name, () => surface.install())
    await install('acp', () =>
      installAcpIpcHandlers(
        acp.runtime,
        acp.workflows,
        acp.sessionAdmission,
        acp.resolveMemoryEnabled
      )
    )
    for (const surface of afterAcp) await install(surface.name, () => surface.install())
  } catch (error) {
    try {
      await uninstall()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Electron runtime adapter installation and rollback failed.'
      )
    }
    throw error
  }

  return { uninstall }
}

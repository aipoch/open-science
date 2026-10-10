import { composeApplicationRuntime } from './application-runtime'
import {
  createApplicationModules,
  type ApplicationRuntimeInterfaces,
  type IpcRegistrationOptions
} from './ipc-application-composition'
import type {
  ElectronRuntimeAdapterInterfaces,
  InstalledElectronSurfaceAdapter
} from './runtime-electron-wiring'
import { startDiagnosticOperation } from './diagnostics/operation'
import { createLogger } from './logger'

// Both hosts construct this exact owner graph. Only the desktop supplies transport installation.
export async function createCoreRuntime(
  options: IpcRegistrationOptions,
  installDesktop?: (
    adapters: ElectronRuntimeAdapterInterfaces
  ) => Promise<InstalledElectronSurfaceAdapter>
): Promise<ApplicationRuntimeInterfaces & { dispose(): Promise<void> }> {
  const composition = startDiagnosticOperation(createLogger('startup'), {
    operation: 'application-composition',
    cpuUsage: process.cpuUsage
  })
  try {
    const runtime = await composeApplicationRuntime(async (modules) => {
      const { electronAdapters, ...interfaces } = await createApplicationModules(
        options,
        modules,
        composition
      )
      if (installDesktop) {
        const installation = await installDesktop(electronAdapters)
        await modules.add(installation, (installed) => ({
          name: 'electron-runtime-adapters',
          capability: undefined,
          rollback: () => installed.uninstall(),
          dispose: () => installed.uninstall()
        }))
        composition.phase('ipc-adapters')
      }
      return interfaces
    })
    composition.complete()
    return { ...runtime.interfaces, dispose: runtime.dispose }
  } catch (error) {
    composition.fail(error)
    throw error
  }
}

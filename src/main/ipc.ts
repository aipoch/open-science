import { bindElectronSurfaceFactories } from './desktop-surface-factories'
import { createCoreRuntime } from './core-runtime'
import { installElectronRuntimeAdapters } from './runtime-electron-wiring'
import type { IpcRegistration, IpcRegistrationOptions } from './ipc-application-composition'
export type { ApplicationRuntimeInterfaces } from './ipc-application-composition'

export const registerIpcHandlers = async (
  options: IpcRegistrationOptions
): Promise<IpcRegistration> => {
  bindElectronSurfaceFactories()
  performance.mark('open-science:ipc-registration-start')
  const runtime = await createCoreRuntime(options, installElectronRuntimeAdapters)
  performance.mark('open-science:ipc-registration-complete')
  performance.measure(
    'open-science:ipc-registration',
    'open-science:ipc-registration-start',
    'open-science:ipc-registration-complete'
  )
  return runtime
}

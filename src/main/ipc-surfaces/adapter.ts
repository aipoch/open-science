import { createIpcHandlerInstallationScope } from '../ipc-handler-registry'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'

// Installation is synchronous: a failed registrar must roll back its partial channel set before
// the runtime wiring uninstalls earlier surfaces. The returned handle owns successful installation.
export const createElectronSurfaceAdapter = (
  name: string,
  register: () => void | (() => void)
): NamedElectronSurfaceAdapter => ({
  name,
  install: () => {
    const scope = createIpcHandlerInstallationScope()
    try {
      const cleanup = register()
      return scope.complete(typeof cleanup === 'function' ? cleanup : undefined)
    } catch (error) {
      scope.rollback()
      throw error
    }
  }
})

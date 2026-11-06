import { watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import {
  assertNativeInstallationUpdateAuthorized,
  installationStateDirectory,
  isNativeInstallationUpdateOwner,
  readNativeInstallationUpdate,
  type InstallationLocation,
  type NativeInstallationUpdateRecord
} from './installation-protection'

/** Existing Desktops observe the installation's narrow close request. This grants no controller
 * capability and never launches an installer or terminates another process. Old clients without
 * this observer remain covered by the initiating owner's object-bound shutdown. */
export function observeNativeInstallationUpdate(options: {
  location: InstallationLocation
  close(record: NativeInstallationUpdateRecord & { shutdownDeadlineAt: number }): Promise<void>
  onError(error: unknown): void
}): () => void {
  const path = join(installationStateDirectory(options.location), 'windows-update-in-progress.json')
  const handled = new Set<string>()
  let disposed = false
  const inspect = (): void => {
    if (disposed) return
    try {
      const record = readNativeInstallationUpdate(options.location)
      if (
        !record ||
        record.phase !== 'preparing' ||
        record.shutdownDeadlineAt === undefined ||
        handled.has(record.operationId) ||
        isNativeInstallationUpdateOwner(options.location, record.operationId)
      )
        return
      assertNativeInstallationUpdateAuthorized(options.location, record.operationId)
      handled.add(record.operationId)
      void options
        .close({ ...record, shutdownDeadlineAt: record.shutdownDeadlineAt })
        .catch(options.onError)
    } catch (error) {
      options.onError(error)
    }
  }
  // Poll only the existing operation file's metadata; take the short coordinator lock only when
  // it changes. This also handles atomic replacement without watching unrelated Runtime leases.
  watchFile(path, { persistent: false, interval: 250 }, inspect)
  queueMicrotask(inspect)
  return () => {
    disposed = true
    unwatchFile(path, inspect)
  }
}

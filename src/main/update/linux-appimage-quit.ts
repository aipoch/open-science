import { constants, accessSync, lstatSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { isNewer } from '../../shared/update'
import { currentApplicationShutdownTrigger } from '../application-shutdown-trigger'
import { verifyArtifactChecksum } from './installation-artifact'
import { inspectOwnedLinuxAppImageLauncher } from './installation-occupancy'
import { inspectInstallationAvailability } from './installation-protection'
import type { UpdateStrategy } from './strategy'

/** Rename the verified SDK file under the existing installation coordinator, before releasing
 * the desktop lock. A different cache filesystem retains the package for explicit installation. */
export async function applyLinuxAppImageOnQuit(
  strategy: UpdateStrategy,
  image: string,
  allowedProcessIds: () => number[],
  signal: AbortSignal
): Promise<boolean> {
  const ready = strategy.getStatus()
  if (
    !ready.automaticDownloads ||
    ready.state !== 'ready' ||
    ready.recovery ||
    !ready.latest ||
    !isNewer(ready.latest, ready.current) ||
    !ready.localPath ||
    !ready.artifactSha512 ||
    (await strategy.getInstaller())?.format !== 'appimage'
  )
    return false
  const archive = ready.localPath
  const before = lstatSync(archive, { bigint: true })
  const original = lstatSync(image, { bigint: true })
  if (
    !before.isFile() ||
    !original.isFile() ||
    before.dev !== original.dev ||
    before.ino === original.ino ||
    (before.mode & 0o111n) === 0n
  )
    return false
  // APPIMAGE is inherited by child processes. Bind replacement to the actual outer executable.
  const [launcher] = inspectOwnedLinuxAppImageLauncher()
  if (!launcher) return false
  const running = statSync('/proc/' + launcher + '/exe', { bigint: true })
  if (running.dev !== original.dev || running.ino !== original.ino) return false
  await verifyArtifactChecksum(archive, ready.artifactSha512, signal)
  let installed = false
  await inspectInstallationAvailability(
    {
      installationRoot: image,
      allowedProcessIds,
      replaceIfIdle() {
        if (currentApplicationShutdownTrigger() !== 'quit' || strategy.getStatus() !== ready) return
        const target = lstatSync(image, { bigint: true })
        const source = lstatSync(archive, { bigint: true })
        if (
          target.ino !== original.ino ||
          target.dev !== original.dev ||
          target.ctimeNs !== original.ctimeNs ||
          before.ino !== source.ino ||
          before.dev !== source.dev ||
          before.ctimeNs !== source.ctimeNs
        )
          return
        accessSync(image, constants.W_OK)
        accessSync(dirname(image), constants.W_OK | constants.X_OK)
        renameSync(archive, image)
        installed = true
      }
    },
    signal
  )
  return installed
}

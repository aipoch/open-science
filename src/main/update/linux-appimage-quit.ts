import { createLogger, runtimeChildProcessErrorFields } from '@aipoch/diagnostics/node'
import { spawn } from 'node:child_process'
import {
  constants,
  accessSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  type BigIntStats
} from 'node:fs'
import { dirname } from 'node:path'
import { isNewer } from '../../shared/update'
import { currentApplicationShutdownTrigger } from '../application-shutdown-trigger'
import { verifyArtifactChecksum } from './installation-artifact'
import { inspectOwnedLinuxAppImageLauncher } from './installation-occupancy'
import { inspectInstallationAvailability } from './installation-protection'
import type { UpdateStrategy } from './strategy'

type ImageIdentity = Pick<BigIntStats, 'dev' | 'ino'>

/** Rename the verified SDK file under the existing installation coordinator, before releasing
 * the desktop lock. A different cache filesystem retains the package for explicit installation. */
export async function applyLinuxAppImageOnQuit(
  strategy: UpdateStrategy,
  image: string,
  allowedProcessIds: () => number[],
  signal: AbortSignal
): Promise<ImageIdentity | undefined> {
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
    return undefined
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
    return undefined
  // APPIMAGE is inherited by child processes. Bind replacement to the actual outer executable.
  const [launcher] = inspectOwnedLinuxAppImageLauncher()
  if (!launcher) return undefined
  const running = statSync('/proc/' + launcher + '/exe', { bigint: true })
  if (running.dev !== original.dev || running.ino !== original.ino) return undefined
  await verifyArtifactChecksum(archive, ready.artifactSha512, signal)
  let installed: ImageIdentity | undefined
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
        installed = { dev: source.dev, ino: source.ino }
      }
    },
    signal
  )
  return installed
}

// Electron's relaunch helper lives inside the old AppImage. A system shell can wait
// for the old Desktop to close its descriptors even after that mount has disappeared.
export function forwardLinuxAppImageLaunch(
  image: string,
  startupArgs: string[],
  requests: string[],
  installed: ImageIdentity | undefined
): void {
  const descriptor = openSync(image, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const target = fstatSync(descriptor, { bigint: true })
    if (!target.isFile()) return
    const deliver = installed && installed.ino === target.ino && installed.dev === target.dev
    // An external replacement cannot inherit this installation's document or link.
    if (installed && !deliver) return
    if (!installed) {
      const [launcher] = inspectOwnedLinuxAppImageLauncher()
      if (!launcher) return
      const running = statSync('/proc/' + launcher + '/exe', { bigint: true })
      if (target.ino !== running.ino || target.dev !== running.dev) return
    }
    const env = { ...process.env }
    delete env.APPDIR
    delete env.APPIMAGE
    delete env.APPIMAGE_EXIT_AFTER_INSTALL
    delete env.APPIMAGE_SILENT_INSTALL
    if (!deliver && requests.length) env.OPEN_SCIENCE_UPDATE_OPEN_INTERRUPTED = '1'
    // AppRun itself uses /usr/bin/env bash. Keep the interpreter's command line fixed.
    // Separate environment entries preserve whitespace, quotes and newlines in paths and URLs.
    const args = [image, ...startupArgs, ...(deliver ? requests : [])]
    for (const [index, arg] of args.entries()) env['OPEN_SCIENCE_HANDOFF_ARG_' + index] = arg
    env.OPEN_SCIENCE_HANDOFF_ARG_COUNT = String(args.length)
    const launch = [
      'IFS= read -r _',
      'args=()',
      'for ((i=0; i<OPEN_SCIENCE_HANDOFF_ARG_COUNT; i++)); do',
      '  key="OPEN_SCIENCE_HANDOFF_ARG_$i"',
      '  args+=("${!key}")',
      '  unset "$key"',
      'done',
      'unset OPEN_SCIENCE_HANDOFF_ARG_COUNT',
      '[ "${args[0]}" -ef /proc/self/fd/3 ] || exit 1',
      'exec 3<&-',
      'exec "${args[@]}"'
    ].join('\n')
    const child = spawn('/usr/bin/env', ['bash', '-p', '-c', launch], {
      cwd: dirname(image),
      detached: true,
      env,
      stdio: ['pipe', 'ignore', 'ignore', descriptor]
    })
    child.once('error', (error) => {
      createLogger('update').error(
        'Linux AppImage relaunch failed',
        runtimeChildProcessErrorFields(error)
      )
    })
    child.unref()
  } finally {
    closeSync(descriptor)
  }
}

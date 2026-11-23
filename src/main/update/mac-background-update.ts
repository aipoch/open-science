import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, realpath, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { AutoUpdater } from 'electron'
import { verifyArtifactChecksum } from './installation-artifact'
import type { UpdateStrategy } from './strategy'

const run = promisify(execFile)

async function writableInstallation(bundle: string): Promise<boolean> {
  const path = await realpath(bundle)
  if (path.split('/').some((part) => ['AppTranslocation', '.Trash', '.Trashes'].includes(part)))
    return false
  await Promise.all([
    access(path, constants.W_OK),
    access(dirname(path), constants.W_OK | constants.X_OK)
  ])
  return true
}

async function availableBytes(path: string): Promise<bigint> {
  const { bavail, bsize } = await statfs(path, { bigint: true })
  return bavail * bsize
}

export async function canDownloadMacUpdate(
  bundle: string,
  cache: string,
  bytes: number
): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return false
  try {
    if (!(await writableInstallation(bundle))) return false
    const size = BigInt(bytes)
    // Two SDK ZIPs, Squirrel's ZIP and room for the expanded application.
    if ((await availableBytes(cache)) < size * 7n || (await availableBytes(bundle)) < size * 4n)
      return false
    await run(join(bundle, 'Contents/MacOS/mac-update-network'), [], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

export const MAC_NATIVE_PREPARATION_TIMEOUT_MS = 60_000

export async function planMacUpdateOnQuit(
  strategy: UpdateStrategy,
  native: AutoUpdater,
  bundle: string,
  cache: string,
  checkOccupancy: () => Promise<void>
): Promise<false | (() => Promise<void>)> {
  const ready = strategy.getStatus()
  if (
    !ready.automaticDownloads ||
    ready.state !== 'ready' ||
    ready.recovery ||
    !ready.artifactSha512 ||
    !ready.localPath
  )
    return false
  if ((await strategy.getInstaller())?.format !== 'zip' || !(await writableInstallation(bundle)))
    return false
  // MacUpdater 6.8.9 has already opened an authenticated loopback feed over this exact ZIP.
  // Calling the provider's downloadUpdate again could pull another copy during quit.
  const feed = native.getFeedURL()
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(feed)) return false
  await verifyArtifactChecksum(ready.localPath, ready.artifactSha512)
  const { stdout } = await run('/usr/bin/zipinfo', ['-t', ready.localPath], {
    timeout: 5000,
    env: { ...process.env, LC_ALL: 'C' }
  })
  const sizes = /(\d+) bytes uncompressed, (\d+) bytes compressed/.exec(stdout)
  if (
    !sizes ||
    (await availableBytes(cache)) < BigInt(sizes[1]) + BigInt(sizes[2]) ||
    (await availableBytes(bundle)) < BigInt(sizes[1])
  )
    return false
  await checkOccupancy()
  if (
    !(await writableInstallation(bundle)) ||
    strategy.getStatus() !== ready ||
    native.getFeedURL() !== feed
  )
    return false
  return async () => {
    const cancellation = new AbortController()
    const signal = AbortSignal.any([
      cancellation.signal,
      AbortSignal.timeout(MAC_NATIVE_PREPARATION_TIMEOUT_MS)
    ])
    const refused = (): void => cancellation.abort(new Error('No staged macOS update'))
    native.once('update-not-available', refused)
    const prepared = once(native, 'update-downloaded', { signal })
    try {
      native.checkForUpdates()
      await prepared
    } finally {
      native.removeListener('update-not-available', refused)
      cancellation.abort()
      await prepared.catch(() => undefined)
    }
  }
}

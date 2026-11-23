import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, readFile, realpath, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { load } from 'js-yaml'
import { APP } from '../../shared/app-config'
import { profileDownloadPreference } from './download-preference'
import type { DownloadPreference } from './strategy'

const run = promisify(execFile)
const nm = 'org.freedesktop.NetworkManager'

async function networkAllowsDownload(): Promise<boolean> {
  const { stdout } = await run(
    '/usr/bin/busctl',
    [
      '--system',
      '--auto-start=no',
      'get-property',
      nm,
      '/org/freedesktop/NetworkManager',
      nm,
      'Connectivity',
      'Metered'
    ],
    { timeout: 3000, maxBuffer: 1024 }
  )
  // NM_CONNECTIVITY_FULL and NM_METERED_NO. Guessed costs cannot authorize a transfer.
  return stdout.trim() === 'u 4\nu 2'
}

async function cacheHasSpace(directory: string, bytes: number): Promise<boolean> {
  // The SDK creates its pending directory on first download. Inspect the volume which
  // will actually contain it, including a separately mounted cache or pending directory.
  try {
    await access(directory, constants.W_OK | constants.X_OK)
    const volume = await statfs(directory, { bigint: true })
    return volume.bavail * volume.bsize >= BigInt(bytes) * 2n
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(directory) === directory)
      throw error
    return cacheHasSpace(dirname(directory), bytes)
  }
}

export async function loadLinuxBackgroundDownloads(
  profile: string,
  resources: string,
  cacheRoot: string,
  image: string | undefined,
  appDir: string | undefined
): Promise<
  { preference: DownloadPreference; canDownload(bytes: number): Promise<boolean> } | undefined
> {
  try {
    const config = load(await readFile(join(resources, 'app-update.yml'), 'utf8')) as {
      provider?: string
      channel?: string
      url?: string
      updaterCacheDirName?: string
    }
    if (
      config?.provider !== 'generic' ||
      (config.channel && config.channel !== 'latest') ||
      config.url !== APP.cdnBaseUrl + '/app/stable' ||
      !config.updaterCacheDirName ||
      !/^[\w-]+$/.test(config.updaterCacheDirName) ||
      !isAbsolute(cacheRoot)
    )
      return undefined

    const packageType = await readFile(join(resources, 'package-type'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return ''
      }
    )
    if (image || appDir) {
      if (
        !image ||
        !isAbsolute(image) ||
        !appDir ||
        !isAbsolute(appDir) ||
        (packageType.trim() && packageType.trim() !== 'appimage') ||
        (await realpath(join(appDir, 'resources'))) !== (await realpath(resources)) ||
        !(await lstat(image)).isFile()
      )
        return undefined
    } else if (packageType.trim() !== 'deb') return undefined

    const pending = join(cacheRoot, config.updaterCacheDirName, 'pending')
    return {
      preference: profileDownloadPreference(profile),
      async canDownload(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes <= 0) return false
        try {
          if (image) {
            await access(image, constants.W_OK)
            await access(dirname(image), constants.W_OK | constants.X_OK)
          }
          return (await cacheHasSpace(pending, bytes)) && (await networkAllowsDownload())
        } catch {
          return false
        }
      }
    }
  } catch {
    return undefined
  }
}

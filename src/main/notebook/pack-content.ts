import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'

import { pkgsCache } from './runtime-paths'
import { md5File } from './provisioner-runtime'
import { micromambaCacheLockKey, type MicromambaCache } from './micromamba-cache'
import { withExclusiveCacheLock } from './pkgs-cache-lock'

export type LockPackage = { file: string; md5: string }

// A lock line's URL basename doubles as the cached tarball's filename AND the local download
// destination, so it must be a plain conda archive basename — never a path. A `\` survives a naive
// `url.split('/')` and lets `join(staging, '..\\..\\x')` escape the staging dir on Windows (and a
// URL-legal dot-segment like `.`/`..` is equally unsafe), so validate with BOTH path modules'
// basename semantics (pure functions — host-independent) plus the conda archive extension.
// Shared by every lock parser so the download, seed, and micromamba sides cannot drift.
export const isSafePackageBasename = (file: string): boolean =>
  file !== '.' &&
  file !== '..' &&
  /^[^/\\]+$/.test(file) &&
  posix.basename(file) === file &&
  win32.basename(file) === file &&
  /\.(conda|tar\.bz2)$/i.test(file)

// Parses the @EXPLICIT entries and rejects malformed lines before any file is copied into the shared
// micromamba cache. Package URLs are expected to end in a basename and a 32-char md5 digest.
export const lockPackages = (lockText: string): LockPackage[] => {
  const packages = lockText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .map((line) => {
      const [url, md5] = line.split('#')
      const file = url.slice(url.lastIndexOf('/') + 1)
      return { file, md5: md5 ?? '' }
    })

  if (packages.length === 0) throw new Error('runtime pack lock contains no package entries')
  for (const pkg of packages) {
    if (!isSafePackageBasename(pkg.file) || !/^[0-9a-f]{32}$/i.test(pkg.md5)) {
      throw new Error(`runtime pack lock contains a malformed package entry: ${pkg.file}`)
    }
  }
  return packages
}

export const validateAndSeedPackIntoCache = async (
  packDir: string,
  lockPath: string,
  cache: MicromambaCache,
  onProgress?: (completed: number, total: number) => void
): Promise<LockPackage[]> => {
  const entries = lockPackages(await readFile(lockPath, 'utf8'))
  const present = new Set(await readdir(packDir))
  await mkdir(cache.path, { recursive: true })

  await withExclusiveCacheLock(cache.lockKey, async () => {
    for (const [index, entry] of entries.entries()) {
      if (!present.has(entry.file)) {
        throw new Error(`runtime pack is missing lock tarball ${entry.file}`)
      }
      const source = join(packDir, entry.file)
      const sourceStat = await stat(source)
      if (
        !sourceStat.isFile() ||
        (await md5File(source)).toLowerCase() !== entry.md5.toLowerCase()
      ) {
        throw new Error(`runtime pack tarball failed md5 verification: ${entry.file}`)
      }

      const destination = join(cache.path, entry.file)
      let destinationValid = false
      try {
        const destinationStat = await stat(destination)
        destinationValid =
          destinationStat.isFile() &&
          (await md5File(destination)).toLowerCase() === entry.md5.toLowerCase()
      } catch {
        destinationValid = false
      }
      if (!destinationValid) await copyFile(source, destination)
      onProgress?.(index + 1, entries.length)
    }
  })
  return entries
}

export const validateAndSeedPack = async (
  root: string,
  packDir: string,
  lockPath: string,
  onProgress?: (completed: number, total: number) => void
): Promise<LockPackage[]> => {
  const path = pkgsCache(root)
  return validateAndSeedPackIntoCache(
    packDir,
    lockPath,
    { path, lockKey: micromambaCacheLockKey(path) },
    onProgress
  )
}

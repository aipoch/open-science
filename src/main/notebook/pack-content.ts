import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { pkgsCache } from './runtime-paths'
import { md5File } from './provisioner-runtime'

export type LockPackage = { file: string; md5: string }

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
    if (!pkg.file || pkg.file.includes('/') || !/^[0-9a-f]{32}$/i.test(pkg.md5)) {
      throw new Error(`runtime pack lock contains a malformed package entry: ${pkg.file}`)
    }
  }
  return packages
}

export const validateAndSeedPack = async (
  root: string,
  packDir: string,
  lockPath: string,
  onProgress?: (completed: number, total: number) => void
): Promise<LockPackage[]> => {
  const entries = lockPackages(await readFile(lockPath, 'utf8'))
  const present = new Set(await readdir(packDir))
  const cache = pkgsCache(root)
  await mkdir(cache, { recursive: true })

  for (const [index, entry] of entries.entries()) {
    if (!present.has(entry.file)) {
      throw new Error(`runtime pack is missing lock tarball ${entry.file}`)
    }
    const source = join(packDir, entry.file)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile() || (await md5File(source)).toLowerCase() !== entry.md5.toLowerCase()) {
      throw new Error(`runtime pack tarball failed md5 verification: ${entry.file}`)
    }

    const destination = join(cache, entry.file)
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
  return entries
}

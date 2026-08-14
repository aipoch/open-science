import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { createLogger, diagnosticErrorFields } from '../logger'

const log = createLogger('skills')
const CACHE_VERSION = 1
const COMPATIBILITY_VERSION = 'sha256-tree-v2'
const SHA256_HEX = /^[a-f0-9]{64}$/
const NON_NEGATIVE_INTEGER = /^\d+$/
const INTEGER = /^-?\d+$/

type FileMetadata = {
  size: string
  mtimeNs: string
  ctimeNs: string
}

type CachedFile = FileMetadata & {
  sha256: string
}

type CachedPackage = {
  files: Record<string, CachedFile>
}

type CompatibilityCache = {
  version: typeof CACHE_VERSION
  packages: Record<string, CachedPackage>
}

type HashFile = (path: string) => Promise<string>

type UserSkillCompatibilityIndexOptions = {
  hashFile?: HashFile
}

type UserSkillCompatibilityResult =
  | { sourceDir: string; compatibility: string }
  | {
      sourceDir: string
      error: unknown
    }

const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

const emptyCache = (): CompatibilityCache => ({
  version: CACHE_VERSION,
  packages: dictionary()
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sameMetadata = (left: FileMetadata | undefined, right: FileMetadata): boolean =>
  left?.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs

const streamFileHash: HashFile = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

// Owns the rebuildable compatibility cache for writable User Skills. Callers provide the complete
// current package set; this module hides metadata comparison, changed-file streaming, pruning, and
// atomic persistence behind one scan operation.
class UserSkillCompatibilityIndex {
  private readonly skillsRoot: string
  private readonly cachePath: string
  private readonly hashFile: HashFile
  private cache: Promise<CompatibilityCache> | undefined

  constructor(storageRoot: string, options: UserSkillCompatibilityIndexOptions = {}) {
    this.skillsRoot = resolve(storageRoot, 'skills')
    this.cachePath = join(storageRoot, 'runtime-support', 'user-skill-compatibility-v1.json')
    this.hashFile = options.hashFile ?? streamFileHash
  }

  async scan(sourceDirs: readonly string[]): Promise<readonly UserSkillCompatibilityResult[]> {
    const cache = await (this.cache ??= this.readCache())
    const activeKeys = new Set<string>()
    const results: UserSkillCompatibilityResult[] = []
    let changed = false

    for (const sourceDir of sourceDirs) {
      try {
        const key = this.packageKey(sourceDir)
        activeKeys.add(key)
        const next = await this.scanPackage(sourceDir, cache.packages[key])
        changed ||= next.changed
        cache.packages[key] = next.package
        results.push({ sourceDir, compatibility: next.compatibility })
      } catch (error) {
        results.push({ sourceDir, error })
      }
    }

    for (const key of Object.keys(cache.packages)) {
      if (!activeKeys.has(key)) {
        delete cache.packages[key]
        changed = true
      }
    }

    if (changed) await this.writeCache(cache)
    return results
  }

  private packageKey(sourceDir: string): string {
    const key = relative(this.skillsRoot, resolve(sourceDir))
    if (!key || isAbsolute(key) || key === '..' || key.startsWith(`..${sep}`)) {
      throw new Error('User Skill compatibility paths must stay inside the writable skills root.')
    }
    return key.split(sep).join('/')
  }

  private async scanPackage(
    sourceDir: string,
    previous: CachedPackage | undefined
  ): Promise<{ package: CachedPackage; compatibility: string; changed: boolean }> {
    const files = dictionary<CachedFile>()
    let changed = previous === undefined

    const visit = async (directory: string, prefix = ''): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        const absolutePath = join(directory, entry.name)
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath)
          continue
        }
        if (!entry.isFile()) continue

        let nextMetadata = await this.fileMetadata(absolutePath)
        if (!nextMetadata) continue
        const cached = previous?.files[relativePath]
        const reusable = cached !== undefined && sameMetadata(cached, nextMetadata)
        if (!reusable) changed = true
        let sha256 = cached?.sha256 ?? ''
        if (!reusable) {
          let stable = false
          for (let attempt = 0; attempt < 2; attempt += 1) {
            sha256 = await this.hashFile(absolutePath)
            const afterHash = await this.fileMetadata(absolutePath)
            if (afterHash && sameMetadata(nextMetadata, afterHash)) {
              nextMetadata = afterHash
              stable = true
              break
            }
            if (!afterHash) break
            nextMetadata = afterHash
          }
          if (!stable) {
            throw new Error(`User Skill file changed repeatedly while hashing: ${relativePath}`)
          }
        }
        files[relativePath] = {
          ...nextMetadata,
          sha256
        }
      }
    }

    await visit(sourceDir)
    if (previous && Object.keys(previous.files).length !== Object.keys(files).length) changed = true
    const compatibilityHash = createHash('sha256')
    for (const [path, file] of Object.entries(files)) {
      compatibilityHash.update(path)
      compatibilityHash.update('\0')
      compatibilityHash.update(file.sha256)
      compatibilityHash.update('\0')
    }
    return {
      package: { files },
      compatibility: `${COMPATIBILITY_VERSION}:${compatibilityHash.digest('hex')}`,
      changed
    }
  }

  private async fileMetadata(path: string): Promise<FileMetadata | undefined> {
    const metadata = await lstat(path, { bigint: true })
    return metadata.isFile()
      ? {
          size: metadata.size.toString(),
          mtimeNs: metadata.mtimeNs.toString(),
          ctimeNs: metadata.ctimeNs.toString()
        }
      : undefined
  }

  private async readCache(): Promise<CompatibilityCache> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, 'utf8')) as unknown
      if (!isRecord(parsed) || parsed.version !== CACHE_VERSION || !isRecord(parsed.packages)) {
        return emptyCache()
      }
      const cache = emptyCache()
      for (const [packageKey, packageValue] of Object.entries(parsed.packages)) {
        if (!isRecord(packageValue) || !isRecord(packageValue.files)) continue
        const files = dictionary<CachedFile>()
        for (const [path, fileValue] of Object.entries(packageValue.files)) {
          if (
            isRecord(fileValue) &&
            typeof fileValue.size === 'string' &&
            NON_NEGATIVE_INTEGER.test(fileValue.size) &&
            typeof fileValue.mtimeNs === 'string' &&
            INTEGER.test(fileValue.mtimeNs) &&
            typeof fileValue.ctimeNs === 'string' &&
            INTEGER.test(fileValue.ctimeNs) &&
            typeof fileValue.sha256 === 'string' &&
            SHA256_HEX.test(fileValue.sha256)
          ) {
            files[path] = {
              size: fileValue.size,
              mtimeNs: fileValue.mtimeNs,
              ctimeNs: fileValue.ctimeNs,
              sha256: fileValue.sha256
            }
          }
        }
        cache.packages[packageKey] = { files }
      }
      return cache
    } catch {
      // Missing or corrupt rebuildable state is equivalent to an empty cache.
    }
    return emptyCache()
  }

  private async writeCache(cache: CompatibilityCache): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true })
      const staging = `${this.cachePath}.tmp`
      await writeFile(staging, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, this.cachePath)
    } catch (error) {
      log.warn('failed to persist user Skill compatibility cache', diagnosticErrorFields(error))
    }
  }
}

export { UserSkillCompatibilityIndex }
export type { UserSkillCompatibilityIndexOptions, UserSkillCompatibilityResult }

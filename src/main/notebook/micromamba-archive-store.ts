import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import { withExclusiveCacheLock } from './pkgs-cache-lock'
import { pkgsCache } from './runtime-paths'

const isPackageArchive = (path: string): boolean => /\.(?:conda|tar\.bz2)$/i.test(path)

export type MicromambaArchiveAuthorization = {
  file: string
  algorithm: 'md5' | 'sha256'
  digest: string
}

const archiveFileName = (record: Record<string, unknown>): string | undefined => {
  if (typeof record.fn === 'string') return record.fn
  if (typeof record.url !== 'string') return undefined
  try {
    return basename(new URL(record.url).pathname)
  } catch {
    return undefined
  }
}

const digestFile = (
  path: string,
  algorithm: MicromambaArchiveAuthorization['algorithm']
): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })

const authorizationFromRecord = (
  record: Record<string, unknown>
): MicromambaArchiveAuthorization | undefined => {
  if (
    typeof record.file === 'string' &&
    basename(record.file) === record.file &&
    isPackageArchive(record.file) &&
    record.algorithm === 'sha256' &&
    typeof record.digest === 'string' &&
    /^[0-9a-f]{64}$/i.test(record.digest)
  ) {
    return { file: record.file, algorithm: 'sha256', digest: record.digest.toLowerCase() }
  }
  if (
    typeof record.file === 'string' &&
    basename(record.file) === record.file &&
    isPackageArchive(record.file) &&
    record.algorithm === 'md5' &&
    typeof record.digest === 'string' &&
    /^[0-9a-f]{32}$/i.test(record.digest)
  ) {
    return { file: record.file, algorithm: 'md5', digest: record.digest.toLowerCase() }
  }
  const file = archiveFileName(record)
  if (!file || basename(file) !== file || !isPackageArchive(file)) return undefined
  if (typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(record.sha256)) {
    return { file, algorithm: 'sha256', digest: record.sha256.toLowerCase() }
  }
  if (typeof record.md5 === 'string' && /^[0-9a-f]{32}$/i.test(record.md5)) {
    return { file, algorithm: 'md5', digest: record.md5.toLowerCase() }
  }
  return undefined
}

export const archiveAuthorizationsFromCondaResult = (
  value: unknown
): MicromambaArchiveAuthorization[] => {
  const authorizations: MicromambaArchiveAuthorization[] = []
  const visit = (nested: unknown): void => {
    if (Array.isArray(nested)) {
      nested.forEach(visit)
      return
    }
    if (typeof nested !== 'object' || nested === null) return
    const record = nested as Record<string, unknown>
    const authorization = authorizationFromRecord(record)
    if (authorization) authorizations.push(authorization)
    Object.values(record).forEach(visit)
  }
  visit(value)
  return authorizations
}

export const archiveAuthorizationsFromExplicitLock = (
  lock: string
): MicromambaArchiveAuthorization[] =>
  lock
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^(https?:\/\/[^#]+)#([0-9a-f]{32}|[0-9a-f]{64})$/iu.exec(line)
      if (!match) return []
      const file = basename(new URL(match[1]).pathname)
      if (!file || !isPackageArchive(file)) return []
      return [
        {
          file,
          algorithm: match[2].length === 64 ? ('sha256' as const) : ('md5' as const),
          digest: match[2].toLowerCase()
        }
      ]
    })

const trustedArchiveDigests = (
  authorizations: readonly MicromambaArchiveAuthorization[]
): Map<string, MicromambaArchiveAuthorization[]> => {
  const trusted = new Map<string, MicromambaArchiveAuthorization[]>()
  for (const authorization of authorizations) {
    if (
      basename(authorization.file) !== authorization.file ||
      !isPackageArchive(authorization.file) ||
      !new RegExp(
        authorization.algorithm === 'sha256' ? '^[0-9a-f]{64}$' : '^[0-9a-f]{32}$',
        'i'
      ).test(authorization.digest)
    ) {
      continue
    }
    const normalized = { ...authorization, digest: authorization.digest.toLowerCase() }
    const previous = trusted.get(normalized.file) ?? []
    const sameAlgorithm = previous.find((entry) => entry.algorithm === normalized.algorithm)
    if (sameAlgorithm && sameAlgorithm.digest !== normalized.digest) {
      throw new Error(`package transaction authorizations conflict for ${normalized.file}`)
    }
    if (!sameAlgorithm) trusted.set(normalized.file, [...previous, normalized])
  }
  return trusted
}

const matchesAuthorizations = async (
  path: string,
  authorizations: readonly MicromambaArchiveAuthorization[]
): Promise<boolean> => {
  for (const authorization of authorizations) {
    if ((await digestFile(path, authorization.algorithm)) !== authorization.digest) return false
  }
  return true
}

const isInsideOrEqual = (root: string, candidate: string): boolean => {
  const nested = relative(root, candidate)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

const archiveFiles = async (root: string, validateRoot?: () => boolean): Promise<string[]> => {
  const files: string[] = []
  if (validateRoot && !validateRoot()) {
    throw new Error('Micromamba working cache changed before archive traversal.')
  }
  const physicalRoot = await realpath(root)
  const visit = async (dir: string): Promise<void> => {
    const before = await lstat(dir)
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('Micromamba working cache contains an untrusted directory link.')
    }
    const physicalDir = await realpath(dir)
    if (!isInsideOrEqual(physicalRoot, physicalDir)) {
      throw new Error('Micromamba working cache traversal escaped its validated root.')
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (validateRoot && !validateRoot()) {
      throw new Error('Micromamba working cache changed during archive traversal.')
    }
    if ((await realpath(dir)) !== physicalDir) {
      throw new Error('Micromamba working cache directory identity changed during traversal.')
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const state = await lstat(path)
      if (state.isSymbolicLink()) {
        // Extracted Conda packages legitimately contain executable/library links.
        // Never follow them or consider them archive sources, even if their names
        // match an authorization; missing authorized archives still fail publication.
        continue
      }
      const physical = await realpath(path)
      if (!isInsideOrEqual(physicalRoot, physical)) {
        throw new Error('Micromamba working cache entry escaped its validated root.')
      }
      if (state.isDirectory()) await visit(path)
      else if (state.isFile() && isPackageArchive(entry.name)) files.push(path)
    }
  }
  await visit(root)
  return files
}

export const publishMicromambaArchives = async (
  runtimeRoot: string,
  workingRoot: string,
  authorizations: readonly MicromambaArchiveAuthorization[],
  durableLockKey = pkgsCache(runtimeRoot),
  validateWorkingRoot?: () => boolean
): Promise<number> => {
  const durableRoot = pkgsCache(runtimeRoot)
  // Notebook processes can write the working cache, so its names and bytes are never authority.
  // Only archives matching immutable main-process transaction/lock authorizations may cross into
  // the durable package store used for offline rebuilds.
  const trusted = trustedArchiveDigests(authorizations)
  if (trusted.size === 0) return 0

  await mkdir(durableRoot, { recursive: true })
  return withExclusiveCacheLock(durableLockKey, async () => {
    const missing: Array<[string, MicromambaArchiveAuthorization[]]> = []
    for (const [file, expected] of trusted) {
      const destination = join(durableRoot, file)
      try {
        const destinationState = await stat(destination)
        if (!destinationState.isFile() || !(await matchesAuthorizations(destination, expected))) {
          throw new Error(`durable package archive conflicts with ${file}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push([file, expected])
      }
    }
    // Recovery can crash after removing one of several working roots but before clearing the shared
    // journal record. If every authorized archive is already durable, an absent source is a completed
    // publication, not permanent corruption; avoid traversing or trusting any source path in this case.
    if (missing.length === 0) return 0
    if (validateWorkingRoot && !validateWorkingRoot()) {
      throw new Error('Micromamba working cache failed recovery trust validation.')
    }

    const sourcesByFile = new Map<string, string[]>()
    for (const source of await archiveFiles(workingRoot, validateWorkingRoot)) {
      const file = basename(source)
      sourcesByFile.set(file, [...(sourcesByFile.get(file) ?? []), source])
    }
    let published = 0
    for (const [file, expected] of missing) {
      const destination = join(durableRoot, file)
      let source: string | undefined
      for (const candidate of sourcesByFile.get(file) ?? []) {
        if (await matchesAuthorizations(candidate, expected)) {
          source = candidate
          break
        }
      }
      if (!source) {
        throw new Error(`authorized package archive is unavailable or failed verification: ${file}`)
      }

      const temp = `${destination}.${process.pid}-${randomUUID()}.tmp`
      try {
        await copyFile(source, temp)
        if (!(await matchesAuthorizations(temp, expected))) {
          throw new Error(`copied package archive failed verification: ${file}`)
        }
        await rename(temp, destination)
        published += 1
      } finally {
        await rm(temp, { force: true }).catch(() => undefined)
      }
    }
    return published
  })
}

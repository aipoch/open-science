import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { deriveCondaRuntimeSubsetPlan } from '@aipoch/environment'
import type { CondaRuntimeSubsetPlan, NotebookEnvironmentLock } from '@aipoch/environment/contracts'

export type RRuntimeFootprint = {
  processId: number
  packages: Array<{ name: string; version: string }>
  libraryPaths: string[]
}

const MAX_METADATA_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_METADATA_BYTES = 32 * 1024 * 1024
const MAX_FILES = 200_000
const execute = promisify(execFile)
const within = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}
const systemLibrary = (path: string): boolean =>
  ['/System/Library/', '/usr/lib/', '/Library/Apple/System/Library/'].some((root) =>
    path.startsWith(root)
  )
type ObservedFileMetadata = {
  kind: 'directory' | 'file' | 'symlink' | 'other'
  uid: number
  mode: number
}
type LoggingCacheFileSystem = {
  realpath(path: string): Promise<string>
  metadata(path: string): Promise<ObservedFileMetadata>
}
const loggingCacheFileSystem: LoggingCacheFileSystem = {
  realpath,
  metadata: async (path) => {
    const info = await lstat(path)
    return {
      kind: info.isSymbolicLink()
        ? 'symlink'
        : info.isDirectory()
          ? 'directory'
          : info.isFile()
            ? 'file'
            : 'other',
      uid: info.uid,
      mode: info.mode
    }
  }
}
const protectedMetadata = (metadata: ObservedFileMetadata, kind: 'directory' | 'file'): boolean =>
  metadata.kind === kind &&
  metadata.uid === 0 &&
  Number.isInteger(metadata.mode) &&
  (metadata.mode & 0o022) === 0

// lsof's txt set also includes Darwin's logging data mmap. The OS unlinks these
// random cache files while their mapping remains live. This narrowly recognizes
// that protected data cache; missing or external native libraries still reject.
const protectedLoggingCache = async (
  path: string,
  fileSystem: LoggingCacheFileSystem
): Promise<boolean> => {
  const parent = '/Library/Preferences/Logging'
  if (
    path !== resolve(path) ||
    !/^\/Library\/Preferences\/Logging\/\.plist-cache\.[A-Za-z0-9]{8}$/u.test(path)
  )
    return false
  try {
    if (
      (await fileSystem.realpath(parent)) !== parent ||
      !protectedMetadata(await fileSystem.metadata(parent), 'directory')
    )
      return false
    try {
      const metadata = await fileSystem.metadata(path)
      return protectedMetadata(metadata, 'file') && (await fileSystem.realpath(path)) === path
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  } catch {
    return false
  }
}
const validFootprint = (value: RRuntimeFootprint): boolean =>
  Number.isSafeInteger(value.processId) &&
  value.processId > 0 &&
  Array.isArray(value.packages) &&
  value.packages.length > 0 &&
  value.packages.length <= 4096 &&
  new Set(value.packages.map((pkg) => pkg.name)).size === value.packages.length &&
  value.packages.every(
    (pkg) =>
      /^[A-Za-z][A-Za-z0-9.]{0,127}$/u.test(pkg.name) &&
      /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(pkg.version)
  ) &&
  Array.isArray(value.libraryPaths) &&
  value.libraryPaths.length > 0 &&
  value.libraryPaths.length <= 4096 &&
  value.libraryPaths.every(
    (path) => typeof path === 'string' && path.length <= 4096 && isAbsolute(path)
  )

// Observe mappings only. This is deliberately not a shell command and never runs source
// code. A process-footprint proposal remains untrusted until the independent frozen replay.
const listMappedFiles = async (pid: number, signal?: AbortSignal): Promise<string[]> => {
  const { stdout } = await execute(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-F', 'n'],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal, encoding: 'utf8' }
  )
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('n/'))
    .map((line) => line.slice(1))
}

type CandidateInput = {
  lock: NotebookEnvironmentLock
  sourceLockChecksum: string
  scopeChecksum: string
  prefix: string
  footprint: RRuntimeFootprint
  platform?: NodeJS.Platform
  signal?: AbortSignal
}

// Native mappings and loaded namespaces propose a payload inventory for this frozen run;
// they do not prove completeness of Conda's declared dependencies. The caller must replay
// the candidate in a new prefix and compare every original scientific state and file.
export const proposeCondaRuntimeSubset = async (
  input: CandidateInput,
  dependencies: {
    listMappedFiles?: typeof listMappedFiles
    loggingCacheFileSystem?: LoggingCacheFileSystem
  } = {}
): Promise<CondaRuntimeSubsetPlan | undefined> => {
  input.signal?.throwIfAborted()
  if ((input.platform ?? process.platform) !== 'darwin' || !validFootprint(input.footprint))
    return undefined
  try {
    const component = input.lock.components.find((entry) => entry.ecosystem === 'conda')
    const graph = component?.dependencyGraph
    if (!graph?.rPackageOwnership) return undefined
    const root = await realpath(input.prefix)
    const metadataRoot = join(root, 'conda-meta')
    if ((await lstat(metadataRoot)).isSymbolicLink()) return undefined
    const sourcePackages = new Map(graph.packages.map((pkg) => [pkg.name, pkg]))
    const installed = new Map<string, string>()
    const files = new Map<string, Set<string>>()
    let totalBytes = 0
    let totalFiles = 0
    const metadataFiles = (await readdir(metadataRoot)).filter((name) => name.endsWith('.json'))
    if (metadataFiles.length === 0 || metadataFiles.length > 10_000) return undefined
    for (const name of metadataFiles) {
      input.signal?.throwIfAborted()
      const path = join(metadataRoot, name)
      if ((await lstat(path)).isSymbolicLink()) return undefined
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let record: Record<string, unknown>
      try {
        const stat = await file.stat()
        totalBytes += stat.size
        if (
          !stat.isFile() ||
          stat.size > MAX_METADATA_BYTES ||
          totalBytes > MAX_TOTAL_METADATA_BYTES
        )
          return undefined
        const bytes = Buffer.alloc(stat.size + 1)
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length !== stat.size) return undefined
        record = JSON.parse(bytes.subarray(0, length).toString('utf8')) as Record<string, unknown>
      } finally {
        await file.close()
      }
      const pkg = sourcePackages.get(String(record.name))
      if (
        !pkg ||
        record.version !== pkg.version ||
        record.build !== pkg.build ||
        record.url !== pkg.url ||
        record.md5 !== pkg.md5 ||
        installed.has(pkg.name) ||
        !Array.isArray(record.files)
      )
        return undefined
      const archive = basename(new URL(pkg.url).pathname)
      if (name !== archive.replace(/\.(?:conda|tar\.bz2)$/u, '.json')) return undefined
      installed.set(pkg.name, archive)
      totalFiles += record.files.length
      if (totalFiles > MAX_FILES) return undefined
      for (const part of record.files) {
        if (
          typeof part !== 'string' ||
          part.length === 0 ||
          part.length > 4096 ||
          part.includes('\\') ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          isAbsolute(part) ||
          part.split('/').some((segment) => segment === '..' || segment === '')
        )
          return undefined
        const path = resolve(root, part)
        if (!within(root, path)) return undefined
        const owners = files.get(path) ?? new Set<string>()
        owners.add(pkg.name)
        files.set(path, owners)
      }
    }
    const selected = new Set(['r-base', 'r-jsonlite'])
    for (const pkg of input.footprint.packages) {
      const owners = graph.rPackageOwnership.packages.filter((entry) => entry.name === pkg.name)
      if (owners.length !== 1 || owners[0]!.version !== pkg.version) return undefined
      selected.add(owners[0]!.condaPackage)
    }
    const mapped = await (dependencies.listMappedFiles ?? listMappedFiles)(
      input.footprint.processId,
      input.signal
    )
    if (mapped.length === 0 || mapped.length > 4096) return undefined
    const mappedReal = new Set<string>()
    const selectOwner = (path: string): boolean => {
      const owners = files.get(path)
      if (owners?.size !== 1) return false
      selected.add([...owners][0]!)
      return true
    }
    const dllPaths = new Set(input.footprint.libraryPaths.map((path) => resolve(path)))
    for (const path of new Set([...mapped, ...input.footprint.libraryPaths])) {
      input.signal?.throwIfAborted()
      if (!isAbsolute(path) || path.length > 4096) return undefined
      const location = resolve(path)
      // Darwin shared-cache images can have a canonical system path without a
      // separately addressable file. These protected OS roots are not Conda payloads.
      if (systemLibrary(location)) continue
      if (
        !dllPaths.has(location) &&
        (await protectedLoggingCache(
          path,
          dependencies.loggingCacheFileSystem ?? loggingCacheFileSystem
        ))
      )
        continue
      const actual = await realpath(path)
      const lexicalRoot = resolve(input.prefix)
      const logical = within(root, location)
        ? location
        : within(lexicalRoot, location)
          ? resolve(root, relative(lexicalRoot, location))
          : undefined
      if (!logical || !within(root, logical) || !within(root, actual)) return undefined
      if (!selectOwner(logical) || !selectOwner(actual)) return undefined
      mappedReal.add(actual)
    }
    const interpreter = await realpath(join(root, 'lib/R/bin/exec/R'))
    if (!mappedReal.has(interpreter)) return undefined
    // The loader reports resolved targets. Retain archive-owned aliases needed to find
    // those targets (e.g. libblas -> libopenblas), without copying files or following
    // arbitrary directory trees outside the exact installed archive inventories.
    for (const [path] of files) {
      if (!/(?:\.dylib|\.so(?:\.\d+)*)$/u.test(path)) continue
      input.signal?.throwIfAborted()
      const stat = await lstat(path)
      if (!stat.isSymbolicLink()) continue
      const actual = await realpath(path)
      if (!within(root, actual)) return undefined
      if (mappedReal.has(actual) && !selectOwner(path)) return undefined
    }
    const archives: string[] = []
    for (const name of selected) {
      const archive = installed.get(name)
      if (!archive) return undefined
      archives.push(archive)
    }
    return deriveCondaRuntimeSubsetPlan(
      input.lock,
      input.sourceLockChecksum,
      input.scopeChecksum,
      archives
    )
  } catch {
    input.signal?.throwIfAborted()
    return undefined
  }
}

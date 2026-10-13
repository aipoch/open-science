import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  statfs,
  rename,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type { NotebookEnvironmentManifest } from './contracts'
import { pythonBin } from './runtime-paths'
import { withExclusiveCacheLock } from './pkgs-cache-lock'

// A snapshot describes installed bytes, including conflicting metadata and residual files.
// Capturing these files does not by itself establish that the environment is relocatable.
export type EnvironmentSnapshotEntry =
  | { path: string; kind: 'directory'; mode: number }
  | {
      path: string
      kind: 'file'
      mode: number
      checksum: string
      size: number
      condaBinaryPrefix?: true
    }
  | { path: string; kind: 'symlink'; target: string }

export type EnvironmentSnapshot = {
  schemaVersion: 1
  sourcePrefix: string
  entries: EnvironmentSnapshotEntry[]
  observation?: {
    runtimeVersion: string
    packages: NotebookEnvironmentManifest['packages']
  }
}

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const digestPattern = /^[a-f0-9]{64}$/u
export class EnvironmentSnapshotInUseError extends Error {
  constructor(
    cause: unknown,
    readonly retryTermination?: () => Promise<boolean>
  ) {
    super('Environment snapshot verification process termination is unconfirmed.', { cause })
  }
}
const portablePath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length <= 4096 &&
  !/[\\:]/u.test(path) &&
  [...path].every((character) => character.charCodeAt(0) >= 32) &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

const contained = (root: string, path: string): boolean => {
  const nested = relative(root, path)
  return nested === '' || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`))
}

const canonicalDestination = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(resolve(path))
    if (parent === resolve(path)) throw error
    return join(await canonicalDestination(parent), basename(path))
  }
}

const objectPath = (store: string, checksum: string): string => {
  if (!digestPattern.test(checksum)) throw new Error('Invalid environment snapshot checksum.')
  return join(store, 'objects', checksum)
}

const MAX_ENTRIES = 500_000
const MAX_METADATA_BYTES = 64 * 1024 * 1024
const DISK_RESERVE_BYTES = 512 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

const directoryNames = async (path: string, limit = MAX_ENTRIES): Promise<string[]> => {
  const names: string[] = []
  for await (const entry of await opendir(path)) {
    if (names.length >= limit) throw new Error('Environment snapshot has too many entries.')
    names.push(entry.name)
  }
  return names.sort()
}

const requireDiskSpace = async (path: string, bytes: number): Promise<void> => {
  const disk = await statfs(path)
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes + DISK_RESERVE_BYTES > disk.bavail * disk.bsize
  )
    throw new Error('Insufficient free space for environment snapshot and restoration.')
}

const writeChunk = async (handle: FileHandle, bytes: Buffer): Promise<void> => {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
    if (!bytesWritten) throw new Error('Environment snapshot write made no progress.')
    offset += bytesWritten
  }
}

// Hash and consume the same no-follow descriptor in bounded chunks, including on restore.
const streamFile = async (
  path: string,
  consume?: (bytes: Buffer) => Promise<void> | void,
  expectedSize?: number
): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || (expectedSize !== undefined && before.size !== expectedSize))
      throw new Error('Environment snapshot file size or type changed.')
    const digest = createHash('sha256')
    let size = 0
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: CHUNK_BYTES
    })) {
      const bytes = chunk as Buffer
      size += bytes.length
      if (size > before.size) throw new Error('Environment changed during capture.')
      digest.update(bytes)
      await consume?.(bytes)
    }
    const after = await handle.stat()
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Environment changed during capture.')
    return digest.digest('hex')
  } finally {
    await handle.close()
  }
}

const writeFileObject = async (
  store: string,
  path: string,
  size: number,
  created: Set<string>
): Promise<string> => {
  const expected = await streamFile(path, undefined, size)
  const existing = objectPath(store, expected)
  try {
    if ((await streamFile(existing, undefined, size)) !== expected)
      throw new Error('Environment snapshot object failed integrity verification.')
    return expected
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await requireDiskSpace(store, size)
  const temporary = join(store, 'objects', `.incoming-${randomUUID()}`)
  const target = await open(temporary, 'wx', 0o600)
  try {
    const checksum = await streamFile(path, (bytes) => writeChunk(target, bytes), size)
    if (checksum !== expected) throw new Error('Environment changed during capture.')
    await target.close()
    const destination = objectPath(store, checksum)
    try {
      await link(temporary, destination)
      created.add(checksum)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if ((await streamFile(destination, undefined, size)) !== checksum)
      throw new Error('Environment snapshot object failed integrity verification.')
    return checksum
  } finally {
    await target.close()
    await rm(temporary, { force: true })
  }
}

const writeObject = async (store: string, bytes: Buffer, created: Set<string>): Promise<string> => {
  if (bytes.length > MAX_METADATA_BYTES)
    throw new Error('Environment snapshot metadata is too large.')
  const checksum = hash(bytes)
  const destination = objectPath(store, checksum)
  try {
    const saved = await lstat(destination)
    if (!saved.isFile() || saved.isSymbolicLink() || (await streamFile(destination)) !== checksum)
      throw new Error('Environment snapshot object failed integrity verification.')
    return checksum
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(store, 'objects', `.incoming-${randomUUID()}`)
  await mkdir(dirname(destination), { recursive: true })
  await requireDiskSpace(store, bytes.length)
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try {
      await link(temporary, destination)
      created.add(checksum)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const saved = await lstat(destination)
    if (!saved.isFile() || saved.isSymbolicLink() || (await streamFile(destination)) !== checksum)
      throw new Error('Environment snapshot object failed integrity verification.')
    return checksum
  } finally {
    await rm(temporary, { force: true })
  }
}

const readObject = async (store: string, checksum: string): Promise<Buffer> => {
  const path = objectPath(store, checksum)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Environment snapshot object is not a regular file.')
  if (metadata.size > MAX_METADATA_BYTES)
    throw new Error('Environment snapshot metadata is too large.')
  const chunks: Buffer[] = []
  const digest = await streamFile(
    path,
    (bytes) => {
      chunks.push(bytes)
    },
    metadata.size
  )
  const bytes = Buffer.concat(chunks)
  if (digest !== checksum) throw new Error('Environment snapshot object checksum changed.')
  return bytes
}

// Call only after the owner has established that no process is using this private clone.
// Package directories may be read-only; do not follow links while making removal possible.
export const removeEnvironmentSnapshot = async (destination: string): Promise<void> => {
  const writableDirectories = async (path: string): Promise<void> => {
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return
    await chmod(path, (metadata.mode & 0o777) | 0o700)
    for (const name of await readdir(path)) await writableDirectories(join(path, name))
  }
  await writableDirectories(destination)
  await rm(destination, { recursive: true, force: true })
}

const captureSnapshot = async (
  prefix: string,
  store: string,
  manifest: Pick<NotebookEnvironmentManifest, 'runtimeVersion' | 'packages'> | undefined,
  created: Set<string>
): Promise<{ checksum: string; snapshot: EnvironmentSnapshot }> => {
  const sourcePrefix = await realpath(prefix)
  if (contained(sourcePrefix, await canonicalDestination(store)))
    throw new Error('Environment snapshot storage must be outside the source environment.')
  const entries: EnvironmentSnapshotEntry[] = []
  const observed = new Map<string, { stamp: string; identity: string }>()
  let totalBytes = 0
  let metadataBytes = 0
  const identity = (metadata: Awaited<ReturnType<typeof lstat>>): string =>
    [metadata.dev, metadata.ino, metadata.mode, metadata.size, metadata.mtimeMs].join(':')
  const stamp = (metadata: Awaited<ReturnType<typeof lstat>>): string =>
    `${identity(metadata)}:${metadata.ctimeMs}`
  const walk = async (directory: string): Promise<void> => {
    for (const name of await directoryNames(directory, MAX_ENTRIES - entries.length)) {
      const path = join(directory, name)
      const key = relative(sourcePrefix, path).split(sep).join('/')
      if (!portablePath(key)) throw new Error('Environment contains a nonportable snapshot path.')
      if (entries.length >= MAX_ENTRIES)
        throw new Error('Environment snapshot has too many entries.')
      metadataBytes += Buffer.byteLength(key) + 512
      if (metadataBytes > MAX_METADATA_BYTES)
        throw new Error('Environment snapshot metadata is too large.')
      const metadata = await lstat(path)
      observed.set(key, { stamp: stamp(metadata), identity: identity(metadata) })
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path)
        const targetPath = resolve(dirname(path), target)
        const resolved = join(await realpath(dirname(targetPath)), basename(targetPath))
        if (!contained(sourcePrefix, resolved) || !contained(sourcePrefix, await realpath(path)))
          throw new Error('Environment snapshot contains an external symbolic link.')
        // Store root-relative link targets so an absolute internal link cannot reach the source.
        const targetKey = relative(sourcePrefix, resolved).split(sep).join('/')
        entries.push({ path: key, kind: 'symlink', target: targetKey || '.' })
      } else if (metadata.isDirectory()) {
        entries.push({ path: key, kind: 'directory', mode: metadata.mode & 0o777 })
        await walk(path)
      } else if (metadata.isFile()) {
        totalBytes += metadata.size
        if (!Number.isSafeInteger(totalBytes))
          throw new Error('Environment snapshot size is invalid.')
        entries.push({
          path: key,
          kind: 'file',
          mode: metadata.mode & 0o777,
          checksum: '',
          size: metadata.size
        })
      } else throw new Error('Environment contains an unsupported filesystem entry.')
    }
  }
  await walk(sourcePrefix)
  await mkdir(join(store, 'objects'), { recursive: true })
  // Existing content needs no second disk allocation. Missing objects and restoration each
  // reserve their actual allocation while retaining headroom for ordinary application writes.
  await requireDiskSpace(store, 0)
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const path = join(sourcePrefix, entry.path)
    if (identity(await lstat(path)) !== observed.get(entry.path)?.identity)
      throw new Error('Environment changed during capture.')
    entry.checksum = await writeFileObject(store, path, entry.size, created)
  }
  // Package operations are serialized by the caller; detect unrelated writes as well.
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const check = async (directory: string): Promise<void> => {
    for (const name of await directoryNames(directory)) {
      const path = join(directory, name)
      const key = relative(sourcePrefix, path).split(sep).join('/')
      const metadata = await lstat(path)
      const before = observed.get(key)
      if (before?.stamp !== stamp(metadata)) {
        const entry = byPath.get(key)
        // Extended-attribute updates can change ctime without changing captured content.
        // Only ordinary files may use a fresh byte hash as proof; retain every identity check.
        if (
          !before ||
          !metadata.isFile() ||
          entry?.kind !== 'file' ||
          identity(metadata) !== before.identity ||
          (await streamFile(path, undefined, entry.size)) !== entry.checksum ||
          identity(await lstat(path)) !== before.identity
        )
          throw new Error('Environment changed during capture.')
      }
      observed.delete(key)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await check(path)
    }
  }
  await check(sourcePrefix)
  if (observed.size) throw new Error('Environment changed during capture.')
  // Cache metadata supplies relocation declarations, never replacement package bytes.
  // Both its archive hash and the installed hash must match the captured Conda record.
  type CondaPath = {
    _path?: string
    sha256?: string
    sha256_in_prefix?: string
    file_mode?: string
    prefix_placeholder?: string
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || !/^conda-meta\/[^/]+\.json$/u.test(entry.path)) continue
    let record: { link?: { source?: string }; paths_data?: { paths?: CondaPath[] } }
    try {
      record = JSON.parse((await readObject(store, entry.checksum)).toString('utf8'))
    } catch {
      continue
    }
    let cachedPaths: CondaPath[] = []
    if (typeof record?.link?.source === 'string' && isAbsolute(record.link.source)) {
      try {
        const path = join(record.link.source, 'info', 'paths.json')
        const metadata = await lstat(path)
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 16 * 1024 * 1024) {
          const cached = JSON.parse(await readFile(path, 'utf8'))
          if (Array.isArray(cached?.paths)) cachedPaths = cached.paths
        }
      } catch {
        /* Cache eviction leaves captured bytes intact, without relocation evidence. */
      }
    }
    const cachedByPath = new Map(
      cachedPaths
        .filter((item) => item && portablePath(item._path))
        .map((item) => [item._path, item])
    )
    for (const installed of Array.isArray(record?.paths_data?.paths)
      ? record.paths_data.paths
      : []) {
      if (!installed || !portablePath(installed._path)) continue
      const file = byPath.get(installed._path)
      if (file?.kind !== 'file' || installed.sha256_in_prefix !== file.checksum) continue
      const cached = cachedByPath.get(installed._path)
      const metadata = installed.file_mode
        ? installed
        : digestPattern.test(installed.sha256 ?? '') && cached?.sha256 === installed.sha256
          ? cached
          : undefined
      if (
        metadata?.file_mode === 'binary' &&
        typeof metadata.prefix_placeholder === 'string' &&
        metadata.prefix_placeholder
      )
        file.condaBinaryPrefix = true
    }
  }
  const snapshot: EnvironmentSnapshot = {
    schemaVersion: 1,
    sourcePrefix,
    entries,
    ...(manifest?.runtimeVersion
      ? { observation: { runtimeVersion: manifest.runtimeVersion, packages: manifest.packages } }
      : {})
  }
  return {
    checksum: await writeObject(store, Buffer.from(JSON.stringify(snapshot)), created),
    snapshot
  }
}

// Serialize publication/rollback for this CAS: another capture cannot adopt an object while
// its creator may still roll it back. Pre-existing objects always belong to earlier captures.
export const captureEnvironmentSnapshot = async (
  prefix: string,
  store: string,
  manifest?: Pick<NotebookEnvironmentManifest, 'runtimeVersion' | 'packages'>
): Promise<{ checksum: string; snapshot: EnvironmentSnapshot }> => {
  store = await canonicalDestination(store)
  return withExclusiveCacheLock(`snapshot-capture:${store}`, async () => {
    const created = new Set<string>()
    try {
      return await captureSnapshot(prefix, store, manifest, created)
    } catch (error) {
      let cleanupError: unknown
      for (const checksum of created) {
        try {
          await rm(objectPath(store, checksum), { force: true })
        } catch (failure) {
          cleanupError ??= failure
        }
      }
      if (cleanupError)
        throw new AggregateError(
          [error, cleanupError],
          'Environment snapshot capture and rollback failed.'
        )
      throw error
    }
  })
}

export const readEnvironmentSnapshot = async (
  store: string,
  checksum: string
): Promise<EnvironmentSnapshot> => {
  const value = JSON.parse(
    (await readObject(store, checksum)).toString('utf8')
  ) as EnvironmentSnapshot
  if (
    value?.schemaVersion !== 1 ||
    typeof value.sourcePrefix !== 'string' ||
    value.sourcePrefix.includes('\0') ||
    !isAbsolute(value.sourcePrefix) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  )
    throw new Error('Invalid environment snapshot manifest.')
  const paths = new Map<string, EnvironmentSnapshotEntry['kind']>()
  for (const entry of value.entries) {
    if (!entry || !portablePath(entry.path) || paths.has(entry.path.toLowerCase()))
      throw new Error('Invalid or duplicate environment snapshot path.')
    const parent = entry.path.split('/').slice(0, -1).join('/')
    if (parent && paths.get(parent.toLowerCase()) !== 'directory')
      throw new Error('Environment snapshot parent is not a directory.')
    if (entry.kind === 'symlink') {
      if (entry.target !== '.' && !portablePath(entry.target))
        throw new Error('Invalid environment snapshot link.')
    } else if (entry.kind === 'file' || entry.kind === 'directory') {
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
        throw new Error('Invalid environment snapshot mode.')
      if (
        entry.kind === 'file' &&
        (!digestPattern.test(entry.checksum) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          (entry.condaBinaryPrefix !== undefined && entry.condaBinaryPrefix !== true))
      )
        throw new Error('Invalid environment snapshot file.')
    } else throw new Error('Invalid environment snapshot entry.')
    paths.set(entry.path.toLowerCase(), entry.kind)
  }
  if (value.observation) {
    const observation = value.observation
    if (
      typeof observation.runtimeVersion !== 'string' ||
      !/^\d+\.\d+\.\d+$/u.test(observation.runtimeVersion) ||
      !Array.isArray(observation.packages) ||
      observation.packages.length > 100_000 ||
      observation.packages.some(
        (pkg) =>
          !pkg ||
          typeof pkg.name !== 'string' ||
          !pkg.name ||
          !['python', 'r', 'native', 'unknown'].includes(pkg.ecosystem) ||
          !['known', 'unavailable'].includes(pkg.versionStatus) ||
          (pkg.versionStatus === 'known' && (typeof pkg.version !== 'string' || !pkg.version)) ||
          !Array.isArray(pkg.evidenceSources) ||
          pkg.evidenceSources.some((source) => typeof source !== 'string')
      )
    )
      throw new Error('Invalid environment snapshot observation.')
  }
  return value
}

export const verifyEnvironmentSnapshot = async (
  snapshot: EnvironmentSnapshot,
  prefix: string,
  execute: (argv: string[]) => Promise<string>
): Promise<void> => {
  if (!snapshot.observation) throw new Error('Environment snapshot has no runtime observation.')
  const script = `import importlib, importlib.metadata, importlib.util, json, pathlib, re, sys
expected = json.loads(${JSON.stringify(JSON.stringify(snapshot.observation))})
prefix = pathlib.Path(sys.prefix).resolve()
assert prefix == pathlib.Path(${JSON.stringify(prefix)}).resolve(), "Snapshot interpreter escaped its prefix"
assert '.'.join(map(str, sys.version_info[:3])) == expected['runtimeVersion'], "Snapshot Python version changed"
normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
distributions = list(importlib.metadata.distributions())
installed = {(normalize(d.metadata.get('Name', '')), d.version) for d in distributions}
expected_installed = {(normalize(p['name']), p['version']) for p in expected['packages'] if p['ecosystem'] == 'python' and p['versionStatus'] == 'known' and 'python-importlib-metadata' in p['evidenceSources']}
assert installed == expected_installed, 'Snapshot installed distribution inventory changed'
roots = importlib.metadata.packages_distributions()
def versions_match(left, right):
    if left == right:
        return True
    if not re.fullmatch(r'[0-9]+(?:\\.[0-9]+)*', left or '') or not re.fullmatch(r'[0-9]+(?:\\.[0-9]+)*', right or ''):
        return False
    def release(value):
        parts = [int(part) for part in value.split('.')]
        while len(parts) > 1 and parts[-1] == 0:
            parts.pop()
        return parts
    return release(left) == release(right)
for package in expected['packages']:
    if package['ecosystem'] != 'python' or package['versionStatus'] != 'known':
        continue
    name, version = package['name'], package['version']
    if 'python-importlib-metadata' in package['evidenceSources']:
        assert (normalize(name), version) in installed, 'Snapshot distribution missing: ' + name + '==' + version
    if package.get('loadedState') != 'loaded' or 'python-kernel-modules' not in package['evidenceSources']:
        continue
    candidates = [name] if name.isidentifier() and importlib.util.find_spec(name) else [root for root, distributions in roots.items() if any(normalize(d) == normalize(name) for d in distributions)]
    assert candidates, 'Snapshot loaded module missing: ' + name
    modules = [importlib.import_module(root) for root in candidates]
    observed_versions = [str(module.__version__) for module in modules if getattr(module, '__version__', None) is not None]
    if observed_versions:
        assert any(versions_match(version, observed) for observed in observed_versions), 'Snapshot loaded module version changed: ' + name
    else:
        # The kernel can establish a loaded distribution through RECORD ownership even when
        # its module has no __version__. Retain that same proof instead of requiring a new API.
        owners = [dist for dist in distributions if normalize(dist.metadata.get('Name', '')) == normalize(name)]
        assert owners and all(versions_match(version, dist.version) for dist in owners), 'Snapshot loaded distribution is ambiguous: ' + name
        paths = {pathlib.Path(module.__file__).resolve() for module in modules if getattr(module, '__file__', None)}
        assert any(pathlib.Path(dist.locate_file(file)).resolve() in paths for dist in owners for file in (dist.files if dist.files is not None else [candidate for root in candidates for candidate in (root + '.py', root + '/__init__.py')])), 'Snapshot loaded distribution ownership changed: ' + name
for module in list(sys.modules.values()):
    path = getattr(module, '__file__', None)
    if path and not path.startswith('<'):
        assert pathlib.Path(path).resolve().is_relative_to(prefix), 'Snapshot module escaped its prefix: ' + str(getattr(module, '__name__', ''))
print('OPEN_SCIENCE_SNAPSHOT_VERIFIED')
`
  const output = await execute([pythonBin(prefix, process.platform), '-I', '-B', '-c', script])
  if (output.trim().split(/\r?\n/u).at(-1) !== 'OPEN_SCIENCE_SNAPSHOT_VERIFIED')
    throw new Error('Environment snapshot runtime verification did not complete.')
}

export const restoreEnvironmentSnapshot = async (
  store: string,
  checksum: string,
  destination: string,
  execute: (argv: string[]) => Promise<string>
): Promise<void> => {
  const snapshot = await materializeEnvironmentSnapshot(store, checksum, destination)
  try {
    await relocateEnvironmentSnapshot(snapshot, destination)
    await verifyEnvironmentSnapshot(snapshot, destination, execute)
  } catch (error) {
    if (!(error instanceof EnvironmentSnapshotInUseError))
      await removeEnvironmentSnapshot(destination)
    throw error
  }
}

// Materialization intentionally does not claim runtime restoration. The relocation/verification
// owner must finish before the resulting prefix can be exposed to an execution kernel.
export const materializeEnvironmentSnapshot = async (
  store: string,
  checksum: string,
  destination: string
): Promise<EnvironmentSnapshot> => {
  const snapshot = await readEnvironmentSnapshot(store, checksum)
  destination = await canonicalDestination(destination)
  if (contained(snapshot.sourcePrefix, destination))
    throw new Error('Cannot restore over the source environment.')
  await requireDiskSpace(
    dirname(destination),
    snapshot.entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0) +
      snapshot.entries.reduce(
        (largest, entry) => Math.max(largest, entry.kind === 'file' ? entry.size : 0),
        0
      )
  )
  await mkdir(destination, { recursive: false })
  try {
    for (const entry of snapshot.entries) {
      const path = join(destination, ...entry.path.split('/'))
      if (entry.kind === 'directory') await mkdir(path)
    }
    // Keep disk/memory pressure bounded, without serializing thousands of independent files.
    // Drain each batch before cleanup so failed copies cannot continue writing into a removed clone.
    const files = snapshot.entries.filter((entry) => entry.kind === 'file')
    for (let offset = 0; offset < files.length; offset += 8) {
      const results = await Promise.allSettled(
        files.slice(offset, offset + 8).map(async (entry) => {
          const path = join(destination, ...entry.path.split('/'))
          const target = await open(path, 'wx', entry.mode)
          try {
            const checksum = await streamFile(
              objectPath(store, entry.checksum),
              (bytes) => writeChunk(target, bytes),
              entry.size
            )
            if (checksum !== entry.checksum)
              throw new Error('Environment snapshot object checksum changed.')
          } finally {
            await target.close()
          }
          await chmod(path, entry.mode)
        })
      )
      for (const result of results) if (result.status === 'rejected') throw result.reason
    }
    // Create links last: no content write can traverse a manifest-provided link.
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'symlink') continue
      const path = join(destination, ...entry.path.split('/'))
      const target = resolve(destination, entry.target)
      await symlink(relative(dirname(path), target) || '.', path)
    }
    for (const entry of snapshot.entries)
      if (
        entry.kind === 'symlink' &&
        !contained(resolve(destination), await realpath(join(destination, entry.path)))
      )
        throw new Error('Environment snapshot link escapes its prefix.')
    for (const entry of [...snapshot.entries].reverse())
      if (entry.kind === 'directory') await chmod(join(destination, entry.path), entry.mode)
    return snapshot
  } catch (error) {
    await removeEnvironmentSnapshot(destination)
    throw error
  }
}

// Follow Conda's null-padded binary prefix relocation, using installed bytes rather than a
// package-cache payload: https://github.com/conda/conda-pack/blob/main/conda_pack/prefixes.py.
// Installed hashes establish file identity, not relocation mode. Restrict padded replacement
// to native ELF/Mach-O files or Conda-declared binary prefix files; arbitrary serialization
// without that declaration is never rewritten this way.
// A shorter destination preserves every subsequent binary offset and its original allocation.
const relocateFile = async (
  path: string,
  temporary: string,
  source: Buffer,
  destination: Buffer,
  binary: boolean
): Promise<string> => {
  if (binary && destination.length > source.length)
    throw new Error('Environment snapshot requires a shorter restoration path.')
  const target = await open(temporary, 'wx', 0o600)
  let carry = Buffer.alloc(0)
  let padding = 0
  let needsTerminator = false
  try {
    const checksum = await streamFile(path, async (chunk) => {
      let bytes = Buffer.concat([carry, chunk])
      while (bytes.length) {
        const match = bytes.indexOf(source)
        const terminator = binary && needsTerminator ? bytes.indexOf(0) : -1
        if (terminator !== -1 && (match === -1 || terminator < match)) {
          await writeChunk(target, bytes.subarray(0, terminator))
          while (padding) {
            const count = Math.min(padding, CHUNK_BYTES)
            await writeChunk(target, Buffer.alloc(count))
            padding -= count
          }
          await writeChunk(target, bytes.subarray(terminator, terminator + 1))
          needsTerminator = false
          bytes = bytes.subarray(terminator + 1)
        } else if (match !== -1) {
          await writeChunk(target, bytes.subarray(0, match))
          await writeChunk(target, destination)
          if (binary) {
            padding += source.length - destination.length
            needsTerminator = true
          }
          bytes = bytes.subarray(match + source.length)
        } else {
          const end = Math.max(0, bytes.length - source.length + 1)
          await writeChunk(target, bytes.subarray(0, end))
          bytes = bytes.subarray(end)
          break
        }
      }
      carry = Buffer.from(bytes)
    })
    if (needsTerminator) throw new Error('Environment binary prefix has no null terminator.')
    await writeChunk(target, carry)
    return checksum
  } finally {
    await target.close()
  }
}

export const relocateEnvironmentSnapshot = async (
  snapshot: EnvironmentSnapshot,
  destination: string
): Promise<void> => {
  destination = await realpath(destination)
  if (contained(snapshot.sourcePrefix, destination))
    throw new Error('Cannot relocate the source environment.')
  const binaryEvidence = new Map<string, Set<string>>()
  for (const entry of snapshot.entries) {
    if (entry.kind !== 'file' || !/^conda-meta\/[^/]+\.json$/u.test(entry.path)) continue
    if (entry.size > MAX_METADATA_BYTES)
      throw new Error('Environment snapshot metadata is too large.')
    const chunks: Buffer[] = []
    const checksum = await streamFile(
      join(destination, entry.path),
      (bytes) => {
        chunks.push(bytes)
      },
      entry.size
    )
    if (checksum !== entry.checksum) throw new Error('Environment changed before relocation.')
    const record = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    for (const item of record.paths_data?.paths ?? []) {
      if (!portablePath(item._path) || !digestPattern.test(item.sha256_in_prefix ?? '')) continue
      const hashes = binaryEvidence.get(item._path) ?? new Set<string>()
      hashes.add(item.sha256_in_prefix)
      binaryEvidence.set(item._path, hashes)
    }
  }
  const source = Buffer.from(snapshot.sourcePrefix),
    target = Buffer.from(destination)
  for (const entry of snapshot.entries) {
    if (entry.kind !== 'file') continue
    const path = join(destination, entry.path)
    let tail = Buffer.alloc(0),
      magic = ''
    let hasPrefix = false,
      binary = false,
      utf8 = true
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const checksum = await streamFile(
      path,
      (bytes) => {
        if (!magic) magic = bytes.subarray(0, 4).toString('hex')
        const joined = Buffer.concat([tail, bytes])
        hasPrefix ||= joined.includes(source)
        tail = Buffer.from(joined.subarray(Math.max(0, joined.length - source.length + 1)))
        binary ||= bytes.includes(0)
        if (utf8) {
          try {
            decoder.decode(bytes, { stream: true })
          } catch {
            utf8 = false
          }
        }
      },
      entry.size
    )
    if (checksum !== entry.checksum) throw new Error('Environment changed before relocation.')
    if (!hasPrefix || entry.path.endsWith('.pyc')) continue
    if (utf8) {
      try {
        decoder.decode()
      } catch {
        utf8 = false
      }
    }
    if (!binary && !utf8) throw new Error('Environment prefix text is not valid UTF-8.')
    if (
      binary &&
      (!binaryEvidence.get(entry.path)?.has(entry.checksum) ||
        (!entry.condaBinaryPrefix &&
          ![
            '7f454c46',
            'cffaedfe',
            'cefaedfe',
            'feedfacf',
            'feedface',
            'cafebabe',
            'bebafeca'
          ].includes(magic)))
    )
      throw new Error(`Environment binary relocation evidence is unavailable: ${entry.path}`)
    const temporary = join(destination, `.relocating-${randomUUID()}`)
    const parentMode = (await lstat(dirname(path))).mode & 0o777
    // Package files can be read-only. Temporarily enable writes on this isolated copy only.
    try {
      await requireDiskSpace(
        destination,
        Math.ceil(entry.size * Math.max(1, target.length / source.length))
      )
      if ((await relocateFile(path, temporary, source, target, binary)) !== entry.checksum)
        throw new Error('Environment changed before relocation.')
      await chmod(dirname(path), parentMode | 0o700)
      await chmod(path, entry.mode | 0o200)
      await rename(temporary, path)
      // Apple Silicon rejects modified Mach-O signatures. Sign only the isolated copy.
      if (
        process.platform === 'darwin' &&
        process.arch === 'arm64' &&
        ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(magic)
      )
        await promisify(execFile)('/usr/bin/codesign', ['--force', '--sign', '-', path], {
          timeout: 30_000
        })
    } finally {
      await rm(temporary, { force: true })
      await chmod(path, entry.mode)
      await chmod(dirname(path), parentMode)
    }
  }
}

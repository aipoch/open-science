import { isPortableComputeFileName, type FileEntry } from '@aipoch/compute/node'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export { inspectRayDashboard } from '@aipoch/compute/node'

const marker = '.open-science-owner'
const timeoutMarker = '.open-science-timeout'
type RayDirectory = { sharedRoot: string; runId: string }
type DirectoryIdentity = { dev: string; ino: string }
export type RayOutputScope = RayDirectory & DirectoryIdentity

async function directoryPath({ sharedRoot, runId }: RayDirectory): Promise<string> {
  if (!isAbsolute(sharedRoot) || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId))
    throw new Error('Invalid Ray output scope.')
  return join(await realpath(sharedRoot), runId)
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory() || (await realpath(path)) !== path)
    throw new Error('Unsafe Ray output directory.')
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function verifyIdentity(actual: DirectoryIdentity, expected: DirectoryIdentity): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino)
    throw new Error('Ray output directory was replaced.')
}

async function matchesNonce(file: FileHandle, size: bigint, nonce: string): Promise<boolean> {
  const bytes = Buffer.alloc(Buffer.byteLength(nonce))
  return (
    size === BigInt(bytes.length) &&
    (await file.read(bytes, 0, bytes.length, 0)).bytesRead === bytes.length &&
    bytes.toString() === nonce
  )
}

export async function reserveRayOutputDirectory(
  directory: RayDirectory,
  nonce: string,
  signal?: AbortSignal
): Promise<DirectoryIdentity> {
  signal?.throwIfAborted()
  if (!/^[a-fA-F0-9-]{36}$/.test(nonce)) throw new Error('Invalid Ray output reservation.')
  const path = await directoryPath(directory)
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const identity = await directoryIdentity(path)
  const flags = created
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : constants.O_RDONLY
  const file = await open(
    join(path, marker),
    flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    0o600
  )
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== identity.dev)
      throw new Error('Unsafe Ray output reservation.')
    if (created) {
      await file.writeFile(nonce)
      await file.sync()
    } else if (!(await matchesNonce(file, stat.size, nonce))) {
      throw new Error('Ray output directory is owned by another reservation.')
    }
    const current = await lstat(join(path, marker), { bigint: true })
    if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile())
      throw new Error('Ray output reservation changed.')
    verifyIdentity(await directoryIdentity(path), identity)
    signal?.throwIfAborted()
    return identity
  } finally {
    await file.close()
  }
}

/** Ray's full log response can exceed the byte limit. Check the driver receipt on SIGKILL. */
export async function readRayTimeoutMarker(scope: RayOutputScope, nonce: string): Promise<boolean> {
  const root = await directoryPath(scope)
  verifyIdentity(await directoryIdentity(root), scope)
  let file: FileHandle
  try {
    if (!(await lstat(join(root, timeoutMarker))).isFile()) return false
    file = await open(
      join(root, timeoutMarker),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== scope.dev) return false
    const matches = await matchesNonce(file, stat.size, nonce)
    verifyIdentity(await directoryIdentity(root), scope)
    return matches
  } finally {
    await file.close()
  }
}

/** Traverse only the approved directory on the private, pre-mounted filesystem. */
export async function listRayJobOutputs(
  scope: RayOutputScope,
  signal?: AbortSignal
): Promise<FileEntry[]> {
  signal?.throwIfAborted()
  const root = await directoryPath(scope)
  verifyIdentity(await directoryIdentity(root), scope)
  const files: FileEntry[] = []
  const pending = ['']
  const seen = new Set<string>()
  let count = 0
  while (pending.length) {
    const prefix = pending.pop()!
    const path = join(root, prefix)
    if ((await realpath(path)) !== path) throw new Error('Ray output directory was replaced.')
    const dir = await opendir(path)
    for await (const entry of dir) {
      signal?.throwIfAborted()
      if (++count > 10000) throw new Error('Ray output directory exceeds its entry limit.')
      if (!prefix && (entry.name === marker || entry.name === timeoutMarker)) continue
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      if (
        !isPortableComputeFileName(entry.name) ||
        relative.length > 1024 ||
        relative.split('/').length > 32
      )
        throw new Error('Unsafe Ray output path.')
      const key = relative.normalize('NFC').toLowerCase()
      if (seen.has(key)) throw new Error('Conflicting Ray output paths.')
      seen.add(key)
      const stat = await lstat(join(root, relative), { bigint: true })
      if (String(stat.dev) !== scope.dev)
        throw new Error('Ray output crosses a filesystem boundary.')
      if (stat.isDirectory()) pending.push(relative)
      else if (stat.isFile() && stat.nlink === 1n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER))
        files.push({ path: relative, size_bytes: Number(stat.size) })
      else throw new Error('Unsafe Ray output entry.')
    }
    if ((await realpath(path)) !== path) throw new Error('Ray output directory was replaced.')
  }
  verifyIdentity(await directoryIdentity(root), scope)
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

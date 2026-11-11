import { isPortableComputeFileName } from './remote-path-security'
import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

type ArchivedOutput = Readonly<{ path: string; localPath: string; bytes: number; sha256: string }>

/**
 * Read declared files after the driver stops, from an administrator-provisioned private share.
 * The caller owns the staging directory and publishes the returned generation after verification.
 */
export async function stageRayJobOutputs(request: {
  sharedRoot: string
  submissionId: string
  expectedIdentity?: { dev: string; ino: string }
  paths: readonly string[]
  stagingDirectory: string
  maxBytes: number
  signal?: AbortSignal
}): Promise<ArchivedOutput[]> {
  const { sharedRoot, submissionId, stagingDirectory, maxBytes, signal } = request
  const paths = [...request.paths]
  signal?.throwIfAborted()
  if (
    !isAbsolute(sharedRoot) ||
    !isAbsolute(stagingDirectory) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0
  )
    throw new Error('Invalid Ray output scope.')
  const seen = new Set<string>()
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase()
    if (seen.has(key) || !path.split('/').every(isPortableComputeFileName))
      throw new Error('Unsafe Ray output path.')
    seen.add(key)
  }
  if (!paths.length) return []
  const root = join(await realpath(sharedRoot), submissionId)
  const dir = await lstat(root, { bigint: true })
  if (
    !dir.isDirectory() ||
    (await realpath(root)) !== root ||
    (request.expectedIdentity &&
      (String(dir.dev) !== request.expectedIdentity.dev ||
        String(dir.ino) !== request.expectedIdentity.ino))
  )
    throw new Error('Invalid Ray job directory.')
  const stage = await realpath(stagingDirectory)
  const within = relative(root, stage)
  if (!isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep))
    throw new Error('Ray archive staging must be outside the run directory.')
  const attempt = await mkdtemp(join(stage, 'ray-outputs-'))
  const result: ArchivedOutput[] = []
  let remaining = maxBytes
  try {
    for (const path of paths) {
      signal?.throwIfAborted()
      const source = join(root, path)
      const before = await lstat(source, { bigint: true })
      if (
        before.dev !== dir.dev ||
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(remaining) ||
        (await realpath(source)) !== source
      )
        throw new Error('Ray output is unsafe or exceeds its approved budget.')
      const file = await open(
        source,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      )
      try {
        const matches = (value: typeof before): boolean =>
          value.isFile() &&
          value.nlink === 1n &&
          value.dev === before.dev &&
          value.ino === before.ino &&
          value.size === before.size &&
          value.ctimeNs === before.ctimeNs &&
          value.mtimeNs === before.mtimeNs
        if (!matches(await file.stat({ bigint: true })))
          throw new Error('Ray output changed before transfer.')
        const localPath = join(attempt, path)
        await mkdir(dirname(localPath), { recursive: true, mode: 0o700 })
        let bytes = 0
        const hash = createHash('sha256')
        const size = Number(before.size)
        async function* chunks(): AsyncGenerator<Buffer> {
          while (bytes < size) {
            signal?.throwIfAborted()
            const chunk = Buffer.allocUnsafe(Math.min(size - bytes, 64 * 1024))
            const { bytesRead } = await file.read(chunk, 0, chunk.length, bytes)
            if (!bytesRead) throw new Error('Incomplete Ray output.')
            bytes += bytesRead
            const data = chunk.subarray(0, bytesRead)
            hash.update(data)
            yield data
          }
        }
        await pipeline(chunks(), createWriteStream(localPath, { flags: 'wx', mode: 0o600 }), {
          signal
        })
        if (
          BigInt(bytes) !== before.size ||
          !matches(await file.stat({ bigint: true })) ||
          !matches(await lstat(source, { bigint: true })) ||
          (await realpath(source)) !== source
        )
          throw new Error('Ray output changed during transfer.')
        remaining -= bytes
        result.push({ path, localPath, bytes, sha256: hash.digest('hex') })
      } finally {
        await file.close()
      }
    }
    const current = await lstat(root, { bigint: true })
    if (current.dev !== dir.dev || current.ino !== dir.ino || !current.isDirectory())
      throw new Error('Ray job directory was replaced.')
    return result
  } catch (error) {
    await rm(attempt, { recursive: true, force: true })
    throw error
  }
}

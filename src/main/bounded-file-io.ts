import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type Stats } from 'node:fs'
import { open, rm, type FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'

import { ResourceBudgetExceededError, assertWithinResourceBudget } from './resource-budget'

type FileDigest = {
  sizeBytes: number
  checksum: string
}

type FileObservation = {
  device: number
  inode: number
  sizeBytes: number
  modifiedAtMs: number
  changedAtMs: number
}

class FileObservationMismatchError extends Error {
  readonly name = 'FileObservationMismatchError'
}

type FilePage = {
  page: Buffer
  offset: number
  returnedBytes: number
  truncated: boolean
}

const observeFile = (stats: Stats): FileObservation => ({
  device: stats.dev,
  inode: stats.ino,
  sizeBytes: stats.size,
  modifiedAtMs: stats.mtimeMs,
  changedAtMs: stats.ctimeMs
})

const sameFileObservation = (left: FileObservation, right: FileObservation): boolean =>
  left.device === right.device &&
  left.inode === right.inode &&
  left.sizeBytes === right.sizeBytes &&
  left.modifiedAtMs === right.modifiedAtMs &&
  left.changedAtMs === right.changedAtMs

const assertFileObservation = (
  actual: FileObservation,
  expected: FileObservation,
  message: string
): void => {
  if (!sameFileObservation(actual, expected)) throw new Error(message)
}

const countingHashTransform = (
  maxBytes: number,
  onComplete: (digest: FileDigest) => void
): Transform => {
  const hash = createHash('sha256')
  let sizeBytes = 0

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength
      try {
        assertWithinResourceBudget('file', sizeBytes, maxBytes)
        hash.update(chunk)
        callback(null, chunk)
      } catch (error) {
        callback(error as Error)
      }
    },
    flush(callback) {
      onComplete({ sizeBytes, checksum: hash.digest('hex') })
      callback()
    }
  })
}

const copyFileWithinBudget = async (
  sourcePath: string,
  targetPath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<FileDigest> => {
  let digest: FileDigest | undefined
  let targetOpened = false
  const target = createWriteStream(targetPath, { flags: 'wx' })
  target.once('open', () => {
    targetOpened = true
  })
  try {
    await pipeline(
      createReadStream(sourcePath),
      countingHashTransform(maxBytes, (value) => {
        digest = value
      }),
      target,
      { signal }
    )
  } catch (error) {
    if (targetOpened) await rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  }
  if (!digest) throw new Error('Artifact file copy completed without a digest.')
  return digest
}

const copyOpenFileWithinBudget = async (
  sourceHandle: Pick<FileHandle, 'read'>,
  targetPath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<FileDigest> => {
  let digest: FileDigest | undefined
  let targetOpened = false
  const target = createWriteStream(targetPath, { flags: 'wx' })
  target.once('open', () => {
    targetOpened = true
  })
  try {
    await pipeline(
      Readable.from(readOpenFileChunks(sourceHandle)),
      countingHashTransform(maxBytes, (value) => {
        digest = value
      }),
      target,
      { signal }
    )
  } catch (error) {
    if (targetOpened) await rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  }
  if (!digest) throw new Error('Artifact file copy completed without a digest.')
  return digest
}

const readOpenFileChunks = async function* (
  sourceHandle: Pick<FileHandle, 'read'>,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  const chunkBytes = 64 * 1024
  let position = 0
  while (true) {
    signal?.throwIfAborted()
    const chunk = Buffer.allocUnsafe(chunkBytes)
    const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.byteLength, position)
    signal?.throwIfAborted()
    if (bytesRead === 0) return
    position += bytesRead
    yield chunk.subarray(0, bytesRead)
  }
}

const inlineChunks = function* (content: string, encoding: 'utf8' | 'base64'): Generator<Buffer> {
  if (encoding === 'utf8') {
    const chunkCharacters = 16 * 1024
    for (let offset = 0; offset < content.length;) {
      let end = Math.min(offset + chunkCharacters, content.length)
      if (end < content.length && end > offset && /[\uD800-\uDBFF]/u.test(content[end - 1]!)) {
        end += 1
      }
      yield Buffer.from(content.slice(offset, end), 'utf8')
      offset = end
    }
    return
  }

  let carry = ''
  for (let offset = 0; offset < content.length; offset += 64 * 1024) {
    const normalized = carry + content.slice(offset, offset + 64 * 1024).replace(/\s/gu, '')
    const completeLength = normalized.length - (normalized.length % 4)
    if (completeLength > 0) {
      yield Buffer.from(normalized.slice(0, completeLength), 'base64')
    }
    carry = normalized.slice(completeLength)
  }
  if (carry) yield Buffer.from(carry, 'base64')
}

const inlineDecodedSize = (content: string, encoding: 'utf8' | 'base64'): number => {
  let sizeBytes = 0
  for (const chunk of inlineChunks(content, encoding)) sizeBytes += chunk.byteLength
  return sizeBytes
}

const writeInlineWithinBudget = async (
  targetPath: string,
  content: string,
  encoding: 'utf8' | 'base64',
  maxBytes: number,
  signal?: AbortSignal
): Promise<FileDigest> => {
  const declaredBytes = inlineDecodedSize(content, encoding)
  assertWithinResourceBudget('file', declaredBytes, maxBytes)

  let digest: FileDigest | undefined
  let targetOpened = false
  const target = createWriteStream(targetPath, { flags: 'wx' })
  target.once('open', () => {
    targetOpened = true
  })
  try {
    await pipeline(
      Readable.from(inlineChunks(content, encoding)),
      countingHashTransform(maxBytes, (value) => {
        digest = value
      }),
      target,
      { signal }
    )
  } catch (error) {
    if (targetOpened) await rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  }
  if (!digest) throw new Error('Artifact inline write completed without a digest.')
  return digest
}

const digestFileWithinBudget = async (
  path: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<FileDigest> => {
  const hash = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    sizeBytes += chunk.byteLength
    assertWithinResourceBudget('file', sizeBytes, maxBytes)
    hash.update(chunk)
  }
  return { sizeBytes, checksum: hash.digest('hex') }
}

const readFilePageAndDigest = async (
  path: string,
  offset: number,
  maxReturnedBytes: number,
  signal?: AbortSignal
): Promise<
  FileDigest & {
    page: Buffer
    sample: Buffer
    observation: FileObservation
    offset: number
    returnedBytes: number
    truncated: boolean
  }
> => {
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  const sampleChunks: Buffer[] = []
  let sizeBytes = 0
  let returnedBytes = 0
  let sampleBytes = 0

  const sourceHandle = await open(path, 'r')
  try {
    const observation = observeFile(await sourceHandle.stat())
    for await (const chunk of readOpenFileChunks(sourceHandle, signal)) {
      const chunkStart = sizeBytes
      sizeBytes += chunk.byteLength
      hash.update(chunk)
      if (sampleBytes < 512) {
        const sample = chunk.subarray(0, Math.min(chunk.byteLength, 512 - sampleBytes))
        sampleChunks.push(sample)
        sampleBytes += sample.byteLength
      }
      const chunkEnd = sizeBytes
      const pageEnd = offset + maxReturnedBytes
      if (chunkEnd > offset && chunkStart < pageEnd) {
        const retained = chunk.subarray(
          Math.max(0, offset - chunkStart),
          Math.min(chunk.byteLength, pageEnd - chunkStart)
        )
        chunks.push(retained)
        returnedBytes += retained.byteLength
      }
    }

    const completedObservation = observeFile(await sourceHandle.stat())
    assertFileObservation(
      completedObservation,
      observation,
      'Artifact file changed while being verified.'
    )
    if (sizeBytes !== completedObservation.sizeBytes) {
      throw new Error('Artifact file size changed while being verified.')
    }

    return {
      page: Buffer.concat(chunks, returnedBytes),
      sample: Buffer.concat(sampleChunks, sampleBytes),
      sizeBytes,
      observation: completedObservation,
      offset,
      returnedBytes,
      truncated: offset + returnedBytes < sizeBytes,
      checksum: hash.digest('hex')
    }
  } finally {
    await sourceHandle.close()
  }
}

const readVerifiedFilePage = async (
  path: string,
  offset: number,
  maxReturnedBytes: number,
  observation: FileObservation,
  signal?: AbortSignal
): Promise<FilePage> => {
  const sourceHandle = await open(path, 'r')
  try {
    assertFileObservation(
      observeFile(await sourceHandle.stat()),
      observation,
      'Artifact file changed since verification.'
    )
    const returnedLimit = Math.min(maxReturnedBytes, Math.max(0, observation.sizeBytes - offset))
    const page = Buffer.allocUnsafe(returnedLimit)
    let returnedBytes = 0
    while (returnedBytes < returnedLimit) {
      signal?.throwIfAborted()
      const read = await sourceHandle.read(
        page,
        returnedBytes,
        returnedLimit - returnedBytes,
        offset + returnedBytes
      )
      signal?.throwIfAborted()
      if (read.bytesRead === 0) break
      returnedBytes += read.bytesRead
    }
    assertFileObservation(
      observeFile(await sourceHandle.stat()),
      observation,
      'Artifact file changed while reading a verified page.'
    )
    if (returnedBytes !== returnedLimit) {
      throw new Error('Artifact file ended before the verified page was read.')
    }
    return {
      page: page.subarray(0, returnedBytes),
      offset,
      returnedBytes,
      truncated: offset + returnedBytes < observation.sizeBytes
    }
  } finally {
    await sourceHandle.close()
  }
}

const assertDiskReserve = (
  availableBytes: number,
  writeBytes: number,
  reserveBytes: number
): void => {
  const requiredBytes = writeBytes + reserveBytes
  if (availableBytes < requiredBytes) {
    throw new ResourceBudgetExceededError('disk-reserve', requiredBytes, availableBytes)
  }
}

export {
  assertDiskReserve,
  copyFileWithinBudget,
  copyOpenFileWithinBudget,
  digestFileWithinBudget,
  FileObservationMismatchError,
  inlineDecodedSize,
  readFilePageAndDigest,
  readVerifiedFilePage,
  writeInlineWithinBudget
}
export type { FileDigest, FileObservation, FilePage }

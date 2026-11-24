/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { link, lstat, open, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AgentError } from './agent-adapter.mjs'

const targetExists = () =>
  new AgentError('delivery_target_exists', {
    owner: 'agent',
    message: 'The delivery path already exists. Choose an unused file path.',
    next: [{ action: 'choose_output_path' }]
  })

const integrityMismatch = () =>
  new AgentError('delivery_integrity_mismatch', {
    owner: 'service',
    message: 'The download did not match the source size or checksum. No file was published.',
    next: [{ action: 'inspect_source' }]
  })

// A sibling is staged on the destination filesystem. A hard link publishes it atomically
// without replacing any entry at the destination, even if one appeared during the transfer.
export async function deliverLocalFile(
  fetchContent,
  outputPath,
  { signal, expectedBytes, expectedSha256 } = {}
) {
  const path = resolve(outputPath)
  const temporary = join(dirname(path), `.open-science-${randomUUID()}.tmp`)
  let response
  try {
    const exists = await lstat(path).then(
      () => true,
      (error) => {
        if (error.code !== 'ENOENT') throw error
        return false
      }
    )
    if (exists) throw targetExists()
    response = await fetchContent()
    if (response.status === 206 || !response.body) throw integrityMismatch()
    const contentLength = response.headers.get('content-length')
    const length =
      !response.headers.has('content-encoding') && /^\d+$/u.test(contentLength ?? '')
        ? Number(contentLength)
        : undefined
    if (expectedBytes !== undefined && length !== undefined && expectedBytes !== length) {
      throw integrityMismatch()
    }
    const limit = expectedBytes ?? length
    let bytes = 0
    const hash = createHash('sha256')
    const measure = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (limit !== undefined && bytes > limit) return callback(integrityMismatch())
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body),
      measure,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal }
    )
    const sha256 = hash.digest('hex')
    if ((limit !== undefined && limit !== bytes) || (expectedSha256 && sha256 !== expectedSha256)) {
      throw integrityMismatch()
    }
    signal?.throwIfAborted()
    await link(temporary, path)
    return { path, bytes, sha256, verified: expectedBytes !== undefined && !!expectedSha256 }
  } catch (error) {
    if (error.code === 'EEXIST') throw targetExists()
    if (
      ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'ENOSPC', 'ENOTSUP'].includes(error.code)
    ) {
      throw new AgentError('delivery_path_unavailable', {
        owner: 'agent',
        message:
          'The output directory cannot publish a file. Choose an existing writable directory on a filesystem that supports hard links.',
        next: [{ action: 'choose_output_path' }]
      })
    }
    throw error
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function verifyLocalFile(path, { bytes, sha256 }, signal) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/u.test(sha256 ?? '')) {
    return false
  }
  const sameFile = (a, b) =>
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  let file
  try {
    signal?.throwIfAborted()
    const initial = await lstat(path, { bigint: true })
    if (!initial.isFile() || initial.size !== BigInt(bytes)) return false
    file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    if (!sameFile(initial, await file.stat({ bigint: true }))) return false
    const hash = createHash('sha256')
    let read = 0
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      read += chunk.length
      if (read > bytes) return false
      hash.update(chunk)
    }
    return (
      read === bytes &&
      hash.digest('hex') === sha256 &&
      sameFile(initial, await lstat(path, { bigint: true }))
    )
  } catch {
    signal?.throwIfAborted()
    return false
  } finally {
    await file?.close()
  }
}

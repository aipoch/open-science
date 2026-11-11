import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isPortableComputeFileName } from './remote-path-security'
import JSZip from 'jszip'
import { requestRayDashboard, type RayJobsTarget } from './ray-jobs-http'

type FrozenInput = Readonly<{
  localPath: string
  dstFilename: string
  sizeBytes: number
  checksum: string
}>
type PreparedInputs = Readonly<{ zip: Buffer; sha256: string }>
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Pack the approved frozen files into a reproducible flat Ray working_dir. */
export async function prepareRayJobInputs(
  files: readonly FrozenInput[],
  maxBytes: number,
  signal?: AbortSignal
): Promise<PreparedInputs> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || files.length > 65535)
    throw new Error('Invalid Ray input budget.')
  const archive = new JSZip()
  const seen = new Set<string>()
  let remaining = maxBytes
  for (const file of files
    .map((entry) => ({ ...entry }))
    .sort((a, b) => (a.dstFilename < b.dstFilename ? -1 : a.dstFilename > b.dstFilename ? 1 : 0))) {
    signal?.throwIfAborted()
    const name = file.dstFilename
    const key = name.normalize('NFC').toLowerCase()
    if (
      !isPortableComputeFileName(name) ||
      name === '__proto__' ||
      seen.has(key) ||
      !isAbsolute(file.localPath) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > remaining ||
      !/^[a-f0-9]{64}$/.test(file.checksum)
    )
      throw new Error('Invalid or over-budget frozen Ray input.')
    seen.add(key)
    remaining -= file.sizeBytes
    const before = await lstat(file.localPath)
    if (!before.isFile() || before.size !== file.sizeBytes)
      throw new Error('Ray input is not the approved file.')
    const handle = await open(
      file.localPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const snapshot = await handle.stat()
      if (
        !snapshot.isFile() ||
        before.dev !== snapshot.dev ||
        before.ino !== snapshot.ino ||
        snapshot.size !== file.sizeBytes
      )
        throw new Error('Ray input changed before packaging.')
      const bytes = Buffer.alloc(file.sizeBytes)
      let cursor = 0
      while (cursor < bytes.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(
          bytes,
          cursor,
          Math.min(bytes.length - cursor, 1024 * 1024),
          cursor
        )
        if (!bytesRead) throw new Error('Incomplete Ray input.')
        cursor += bytesRead
      }
      if ((await handle.stat()).size !== bytes.length || digest(bytes) !== file.checksum)
        throw new Error('Ray input no longer matches its approved checksum.')
      archive.file(name, bytes, {
        date: new Date('1980-01-01T00:00:00Z'),
        unixPermissions: 0o100644,
        createFolders: false
      })
    } finally {
      await handle.close()
    }
  }
  const zip = await archive.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: 'STORE'
  })
  signal?.throwIfAborted()
  return { zip, sha256: digest(zip) }
}

/** Pin an existing content-addressed package, or upload it before submitting the job. */
export async function uploadRayWorkingDirectory(
  connection: RayJobsTarget & { signal?: AbortSignal },
  inputs: PreparedInputs
): Promise<string> {
  const timeout = AbortSignal.timeout(120_000)
  const signal = connection.signal ? AbortSignal.any([connection.signal, timeout]) : timeout
  signal.throwIfAborted()
  // Snapshot the caller-owned Buffer before awaiting a cache lookup.
  const bytes = Buffer.from(inputs.zip)
  const sha256 = inputs.sha256
  if (digest(bytes) !== sha256) throw new Error('Ray package checksum mismatch.')
  const name = '_ray_pkg_' + sha256 + '.zip'
  const path = '/api/packages/gcs/' + name
  const target = { ...connection }
  const get = await requestRayDashboard(target, path, { method: 'GET', signal })
  await get.body?.cancel()
  if (get.status === 404) {
    const put = await requestRayDashboard(target, path, { method: 'PUT', body: bytes, signal })
    await put.body?.cancel()
    if (!put.ok) throw new Error(`Ray package upload failed (HTTP ${put.status}).`)
  } else if (get.status !== 200) throw new Error(`Ray package lookup failed (HTTP ${get.status}).`)
  return 'gcs://' + name
}

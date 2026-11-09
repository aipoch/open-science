import { createHash } from 'node:crypto'
import { readJobArchiveReceipt } from './job-archive-receipt'
import { constants, type BigIntStats } from 'node:fs'
import { open, realpath, lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import { parseComputeOutputPreviewKey } from '../../shared/compute'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import { readBoundedManagedFilePreviewLease } from '../managed-file-preview'
import { getNotebookSessionRoot } from '../notebook/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'

type ComputeOutputLease = Pick<
  ManagedFileReadLease,
  | 'path'
  | 'size'
  | 'snapshot'
  | 'versionToken'
  | 'read'
  | 'readRange'
  | 'verifyUnchanged'
  | 'close'
  | 'copyTo'
  | 'assertCanCopyTo'
>
type Request = Pick<ReadArtifactPreviewRequest, 'path' | 'projectId' | 'sessionId'>
const unavailable = (): Error => new Error('Archived compute output is unavailable.')
const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  right.isFile() &&
  right.nlink === 1n &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs
/** Open through the owning Session only. Keep one checked inode for preview, range reads and save. */
export async function openComputeOutputPreview(
  request: Request,
  options: { storageRoot?: string; client?: Awaited<ReturnType<typeof getProjectDbClient>> } = {}
): Promise<ComputeOutputLease> {
  const scope = parseComputeOutputPreviewKey(request.path)
  if (
    (request.projectId !== undefined && request.projectId !== scope.projectId) ||
    (request.sessionId !== undefined && request.sessionId !== scope.sessionId)
  )
    throw unavailable()
  const client = options.client ?? (await getProjectDbClient(resolveConfigRoot()))
  const job = await client.computeJob.findFirst({
    where: {
      id: scope.jobId,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      status: { in: ['success', 'failed', 'timeout'] },
      harvestedAt: { not: null },
      harvestError: null
    },
    select: { id: true, fileEvidence: true, producerRunId: true }
  })
  if (!job) throw unavailable()
  const root = await realpath(options.storageRoot ?? resolveDataRoot())
  const receipt = await readJobArchiveReceipt(
    root,
    scope,
    job.producerRunId ?? undefined,
    job.fileEvidence ? JSON.parse(job.fileEvidence) : undefined
  )
  const expected = receipt?.get(scope.path)
  if (receipt && !expected) throw unavailable()
  const session = getNotebookSessionRoot(root, scope.projectId, scope.sessionId)
  const path = join(session, ...scope.path.split('/'))
  async function checkedStat(): Promise<BigIntStats> {
    if ((await realpath(path)) !== path) throw unavailable()
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw unavailable()
    return info
  }
  const snapshot = await checkedStat()
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  const size = Number(snapshot.size)
  const verifyUnchanged = async (): Promise<void> => {
    if (
      !sameFile(snapshot, await handle.stat({ bigint: true })) ||
      !sameFile(snapshot, await checkedStat())
    )
      throw unavailable()
  }
  try {
    await verifyUnchanged()
    if (expected?.checksum) {
      if (expected.sizeBytes !== size) throw unavailable()
      const hash = createHash('sha256')
      if (size > 0) {
        for await (const chunk of handle.createReadStream({
          autoClose: false,
          start: 0,
          end: size - 1
        }))
          hash.update(chunk)
      }
      if (hash.digest('hex') !== expected.checksum) throw unavailable()
      await verifyUnchanged()
    }
  } catch (error) {
    await handle.close()
    throw error
  }
  const read: ComputeOutputLease['read'] = async (buffer, offset, length, position) => {
    await verifyUnchanged()
    const { bytesRead } = await handle.read(buffer, offset, length, position)
    await verifyUnchanged()
    return { bytesRead }
  }
  const readRange: ComputeOutputLease['readRange'] = async (begin, end) => {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end < begin ||
      end > size
    )
      throw unavailable()
    const result = Buffer.alloc(end - begin)
    let used = 0
    while (used < result.byteLength) {
      const { bytesRead } = await read(result, used, result.length - used, begin + used)
      if (!bytesRead) throw unavailable()
      used += bytesRead
    }
    return result
  }
  const assertDestination = (info: BigIntStats): void => {
    if (!info.isFile() || (info.dev === snapshot.dev && info.ino === snapshot.ino))
      throw new Error('Cannot save over the compute output.')
  }
  return {
    path,
    size,
    snapshot,
    versionToken: Number(snapshot.mtimeNs / 1_000_000n),
    read,
    readRange,
    verifyUnchanged,
    close: () => handle.close(),
    async assertCanCopyTo(destination) {
      try {
        assertDestination(await stat(destination, { bigint: true }))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    async copyTo(destination, opts) {
      const out = await open(
        destination,
        constants.O_CREAT |
          constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0) |
          (opts?.exclusive ? constants.O_EXCL : 0),
        0o600
      )
      try {
        assertDestination(await out.stat({ bigint: true }))
        await out.truncate(0)
        for (let offset = 0; offset < size;) {
          const data = await readRange(offset, Math.min(size, offset + 1024 * 1024))
          await out.writeFile(data)
          offset += data.length
        }
        await verifyUnchanged()
      } finally {
        await out.close()
      }
    }
  }
}
export async function readComputeOutputPreview(
  request: ReadArtifactPreviewRequest
): Promise<ArtifactPreviewResult> {
  const lease = await openComputeOutputPreview(request)
  try {
    return await readBoundedManagedFilePreviewLease(
      lease,
      request,
      'Invalid compute output encoding.'
    )
  } finally {
    await lease.close()
  }
}

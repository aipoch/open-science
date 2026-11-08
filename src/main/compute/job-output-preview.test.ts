import { randomBytes, createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createComputeOutputPreviewKey } from '../../shared/compute'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { publishComputeJobFileEvidence } from '../notebook/working-file-observer'
import { openComputeOutputPreview } from './job-output-preview'
import { getJobHarvestDir } from './workspace-path'

it('reads only the archived job scope, pins the opened file across range reads and copies its original bytes', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'compute-output-preview-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    const scope = { projectId: 'project', sessionId: 'session', jobId: 'job' }
    const dir = join(
      getJobHarvestDir(storageRoot, scope.projectId, scope.sessionId, scope.jobId),
      'hidden'
    )
    await mkdir(dir, { recursive: true })
    const source = join(dir, 'a b.bin')
    const bytes = randomBytes(1024 * 1024 + 71)
    await writeFile(source, bytes)
    const key = (name: string, sessionId = scope.sessionId): string =>
      createComputeOutputPreviewKey({ ...scope, sessionId, path: 'hpc/job/hidden/' + name })
    const acquire = (path: string): ReturnType<typeof openComputeOutputPreview> =>
      openComputeOutputPreview({ path }, { storageRoot, client })
    const original = key('a b.bin')
    await client.computeJob.create({
      data: {
        id: scope.jobId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        providerId: 'ssh:lab',
        shape: 'direct_ssh',
        status: 'success',
        intent: 'test',
        command: 'true',
        commandHash: 'hash'
      }
    })
    await expect(acquire(original)).rejects.toThrow(/unavailable/)
    await client.computeJob.update({
      where: { id: scope.jobId },
      data: { harvestedAt: new Date(), harvestError: 'incomplete' }
    })
    await expect(acquire(original)).rejects.toThrow(/unavailable/)
    await client.computeJob.update({ where: { id: scope.jobId }, data: { harvestError: null } })
    await expect(acquire(key('a b.bin', 'different'))).rejects.toThrow(/unavailable/)
    await expect(
      openComputeOutputPreview({ path: original, projectId: 'other' }, { storageRoot, client })
    ).rejects.toThrow(/unavailable/)
    await expect(acquire(original.replace('a%20b.bin', '%2E%2E%2Ffile'))).rejects.toThrow()
    const lease = await acquire(original)
    try {
      expect(Buffer.from(await lease.readRange(8, 16))).toEqual(bytes.subarray(8, 16))
      const copy = join(storageRoot, 'copy.bin')
      await lease.copyTo(copy, { exclusive: true })
      const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
      expect(hash(await readFile(copy))).toBe(hash(bytes))
      await expect(lease.copyTo(source)).rejects.toThrow()
      await rename(source, source + '.old')
      await writeFile(source, 'replacement')
      await expect(lease.readRange(0, 4)).rejects.toThrow(/unavailable/)
      await link(copy, join(dir, 'alias.bin'))
      await expect(acquire(key('alias.bin'))).rejects.toThrow(/unavailable/)
      // Directory junctions also exercise the symlink boundary on Windows without file-link privileges.
      await symlink(storageRoot, join(dir, 'linked-dir'), 'junction')
      await expect(acquire(key('linked-dir/copy.bin'))).rejects.toThrow(/unavailable/)
    } finally {
      await lease.close()
    }
    const receipt = await publishComputeJobFileEvidence({
      storageRoot,
      ...scope,
      outputs: [{ localPath: source, relativePath: 'hpc/job/hidden/a b.bin' }]
    })
    await client.computeJob.update({
      where: { id: scope.jobId },
      data: { fileEvidence: JSON.stringify(receipt) }
    })
    const confirmed = await acquire(original)
    try {
      expect(Buffer.from(await confirmed.readRange(0, 11)).toString()).toBe('replacement')
    } finally {
      await confirmed.close()
    }
    await writeFile(join(dir, 'added.bin'), 'not published')
    await expect(acquire(key('added.bin'))).rejects.toThrow(/unavailable/)
    await writeFile(source, 'tamperbytes')
    await expect(acquire(original)).rejects.toThrow(/unavailable/)
  } finally {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

configureTestRuntimeMetadata()

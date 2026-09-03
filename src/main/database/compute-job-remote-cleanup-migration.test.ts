import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from './migration-service'

describe('Compute Job remote cleanup migration', () => {
  let storageRoot: string | undefined
  let client: ReturnType<typeof createProjectDbClient> | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('keeps historical Jobs pending until remote cleanup is explicitly settled', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-job-cleanup-migration-'))
    const databasePath = join(storageRoot, 'open-science.db')
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE "id" = '0026_compute_job_remote_cleanup'`
    )
    await client.$executeRawUnsafe(
      `ALTER TABLE "ComputeJob" DROP COLUMN "remoteCleanupDisposition"`
    )
    await client.$executeRawUnsafe(`INSERT INTO "ComputeJob" (
      "id", "providerId", "shape", "sessionId", "projectId", "intent", "command",
      "commandHash", "status"
    ) VALUES (
      'historical-job', 'ssh:retired-host', 'direct_ssh', 'session-1', 'project-1',
      'completed research', 'true', 'hash', 'success'
    )`)

    await expect(migrateApplicationDatabase(client, { databasePath })).resolves.toMatchObject({
      applied: ['0026_compute_job_remote_cleanup'],
      from: '0025_managed_file_version_foundation',
      to: '0026_compute_job_remote_cleanup'
    })
    await expect(
      client.$queryRawUnsafe<Array<{ remoteCleanupDisposition: string }>>(
        `SELECT "remoteCleanupDisposition" FROM "ComputeJob" WHERE "id" = 'historical-job'`
      )
    ).resolves.toEqual([{ remoteCleanupDisposition: 'pending' }])
  })
})

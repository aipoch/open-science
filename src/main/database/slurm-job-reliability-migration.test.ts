import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { MIGRATION_MANIFEST } from './migration-service'

let root: string | undefined
let client: ReturnType<typeof createProjectDbClient> | undefined
afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Slurm reliability schema migration', () => {
  it.each(['0049_pascalcase_table_names', '0053_slurm_job_reliability'])(
    'preserves an active cancellation and opaque job payload from the schema before %s',
    async (nextMigration) => {
      root = await mkdtemp(join(tmpdir(), 'slurm-reliability-schema-'))
      client = createProjectDbClient(root)
      await createDatabaseAtReleasedManifest(
        client,
        MIGRATION_MANIFEST.filter(({ id }) => id < nextMigration)
      )
      await client.$executeRawUnsafe(
        `INSERT INTO "ComputeJob" ("id","providerId","shape","sessionId","projectId","intent","command","commandHash","status") VALUES ('job','ssh:test','scheduler_cluster','session','project','protected-intent','protected-command','hash','running')`
      )
      await client.$executeRawUnsafe(
        `INSERT INTO "ComputeJobOperation" ("id","jobId","kind","phase","revision","attemptCount","claimToken","claimExpiresAt","createdAt","updatedAt") VALUES ('operation','job','cancel','active',9,3,'lease',9999999999999,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
      )
      await migrateApplicationDatabase(client)
      expect(await client.computeJob.findUnique({ where: { id: 'job' } })).toMatchObject({
        status: 'running',
        intent: 'protected-intent',
        command: 'protected-command',
        errorMessage: null
      })
      expect(
        await client.computeJobOperation.findUnique({ where: { id: 'operation' } })
      ).toMatchObject({
        phase: 'active',
        revision: 9,
        attemptCount: 3,
        claimToken: 'lease',
        errorCode: null,
        errorMessage: null
      })
      await client.computeJob.update({
        where: { id: 'job' },
        data: {
          status: 'error',
          errorCode: 'job_status_unavailable',
          errorMessage: 'No record; remote process may still run.'
        }
      })
      await client.computeJobOperation.update({
        where: { id: 'operation' },
        data: {
          phase: 'settled',
          outcome: 'failed',
          errorCode: 'cancel_confirmation_failed',
          errorMessage: 'No confirmation path',
          settledAt: new Date(),
          claimToken: null,
          claimExpiresAt: null
        }
      })
      await client.backgroundResultDelivery.create({
        data: {
          id: 'compute-cancellation:operation:10',
          sourceKind: 'compute-cancellation',
          sourceId: 'operation:10',
          sourceSnapshot: 'immutable diagnostic',
          projectId: 'project',
          sessionId: 'session',
          state: 'pending'
        }
      })
      await migrateApplicationDatabase(client)
      expect(await client.computeJob.count()).toBe(1)
      expect(await client.computeJobOperation.count()).toBe(1)
      expect(
        (
          await client.backgroundResultDelivery.findUnique({
            where: { id: 'compute-cancellation:operation:10' }
          })
        )?.sourceSnapshot
      ).toBe('immutable diagnostic')
    }
  )
})

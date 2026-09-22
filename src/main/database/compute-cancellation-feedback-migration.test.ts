import { expect, it } from 'vitest'
import { createMigratedComputeTestDatabase } from '../compute/compute-integration.test-support'
import { migrateApplicationDatabase } from '../projects/prisma-client'
it('adds cancellation feedback without rewriting jobs or existing claims and is idempotent', async () => {
  const db = await createMigratedComputeTestDatabase('cancellation-feedback-upgrade-')
  try {
    const {
      client,
      repositories: { jobs, operations }
    } = db
    await jobs.create({
      id: 'job',
      providerId: 'ssh:test',
      projectId: 'project',
      sessionId: 'session',
      shape: 'direct_ssh',
      intent: 'work',
      command: 'sleep 100',
      commandHash: 'hash',
      initialStatus: 'running',
      allowUnencryptedPersistence: true
    })
    await operations.request(
      'job',
      'cancel',
      { projectId: 'project', sessionId: 'session', providerId: 'ssh:test' },
      new Date()
    )
    await operations.claimNext('cancel', new Date(), 30_000, 'existing-claim')
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJobOperation" DROP COLUMN "failureCode"')
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJobOperation" DROP COLUMN "requestedAt"')
    await client.$executeRawUnsafe('ALTER TABLE "ComputeJobOperation" DROP COLUMN "forceRequested"')
    await client.$executeRawUnsafe(
      `DELETE FROM "_open_science_migrations" WHERE id = '0045_compute_cancellation_feedback'`
    )
    const before = await client.$queryRawUnsafe('SELECT * FROM "ComputeJobOperation"')
    const jobsBefore = await client.$queryRawUnsafe('SELECT * FROM "ComputeJob"')
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: ['0045_compute_cancellation_feedback']
    })
    const after = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'SELECT * FROM "ComputeJobOperation"'
    )
    expect(
      after.map(({ failureCode, requestedAt, forceRequested, ...rest }) => {
        expect(failureCode).toBeNull()
        expect(requestedAt).toBeNull()
        expect(forceRequested).toBe(false)
        return rest
      })
    ).toEqual(before)
    expect(await client.$queryRawUnsafe('SELECT * FROM "ComputeJob"')).toEqual(jobsBefore)
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  } finally {
    await db.dispose()
  }
})

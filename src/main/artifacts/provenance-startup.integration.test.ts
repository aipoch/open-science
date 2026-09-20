import * as fs from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { migrateApplicationDatabase } from '../projects/prisma-client'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from './provenance-test-fixtures'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>())
}))

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

describe('artifact provenance startup contract (issue 2544)', () => {
  it.each(['same artifact twice', 'one artifact once', 'two different artifacts'] as const)(
    'reopens the database after saving %s before turn finalization',
    async (scenario) => {
      const fixture = await createProvenanceTestFixture()
      fixtures.push(fixture)

      await fixture.stagePng('first revision')
      await fixture.repository.createVersion(createArtifactVersionRequest())
      if (scenario !== 'one artifact once') {
        const filename = scenario === 'same artifact twice' ? 'plot.png' : 'other.png'
        await fixture.stagePng('second revision', filename)
        await fixture.repository.createVersion(
          createArtifactVersionRequest({
            filename,
            writeOperationId: 'write-2',
            writeRequestChecksum: 'b'.repeat(64)
          })
        )
      }

      // Simulate restart while the turn has not yet attached its final Message.
      const versions = await fixture.client.artifactVersion.findMany({ orderBy: { id: 'asc' } })
      await fixture.client.$disconnect()
      await expect(migrateApplicationDatabase(fixture.client)).resolves.toMatchObject({
        applied: []
      })
      await expect(
        fixture.client.artifactVersion.findMany({ orderBy: { id: 'asc' } })
      ).resolves.toEqual(versions)
    }
  )
})

it('copies a migrated empty database without sharing fixture data or lifetime', async () => {
  vi.resetModules()
  const database = await import('../projects/prisma-client')
  const { createProvenanceTestFixture } = await import('./provenance-test-fixtures')
  const directories: string[] = []
  const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
  const mkdtemp = fs.mkdtemp
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix) => {
    const directory = await mkdtemp(prefix)
    directories.push(directory)
    return directory
  })
  const migrate = vi
    .spyOn(database, 'migrateApplicationDatabase')
    .mockRejectedValueOnce(new Error('fixture migration failed'))

  try {
    await expect(createProvenanceTestFixture()).rejects.toThrow('fixture migration failed')
    await expect(fs.stat(directories[0])).rejects.toMatchObject({ code: 'ENOENT' })

    const [first, second] = await Promise.all([
      createProvenanceTestFixture(),
      createProvenanceTestFixture()
    ])
    fixtures.push(first, second)
    expect(migrate).toHaveBeenCalledTimes(2) // One failed attempt, one real migration.
    expect(first.storageRoot).not.toBe(second.storageRoot)
    await first.client.project.create({ data: { id: 'isolated', name: 'First fixture' } })
    expect(await second.client.project.count()).toBe(0)

    await first.dispose()
    await expect(fs.stat(first.storageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const third = await createProvenanceTestFixture()
    fixtures.push(third)
    expect(migrate).toHaveBeenCalledTimes(2)
    expect(await third.client.project.count()).toBe(0)
    await second.client.project.create({ data: { id: 'isolated', name: 'Second fixture' } })
    expect(await third.client.project.count()).toBe(0)
    // Exercise real schema/ledger validation on a clone, without replaying migrations.
    await expect(database.migrateApplicationDatabase(third.client)).resolves.toMatchObject({
      applied: []
    })
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.dispose()))
    vi.restoreAllMocks()
    await Promise.all(
      directories.map((directory) => fs.rm(directory, { recursive: true, force: true }))
    )
  }
})

import { afterEach, describe, expect, it } from 'vitest'

import { migrateApplicationDatabase } from '../projects/prisma-client'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from './provenance-test-fixtures'

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

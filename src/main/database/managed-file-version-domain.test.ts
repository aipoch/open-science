import { afterEach, describe, expect, it } from 'vitest'

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from '../artifacts/provenance-test-fixtures'
import { migrateApplicationDatabase } from './migration-service'

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

const createPendingChain = async (): Promise<{
  client: Fixture['client']
  parent: ArtifactVersionFile
  child: ArtifactVersionFile
}> => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  await fixture.stagePng('first revision')
  const parent = await fixture.repository.createVersion(createArtifactVersionRequest())
  await fixture.stagePng('second revision')
  const child = await fixture.repository.createVersion(
    createArtifactVersionRequest({
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64)
    })
  )
  return { client: fixture.client, parent, child }
}

describe('managed file version startup domain', () => {
  it.each([
    'artifactRunId',
    'rootFrameId',
    'agentFrameId',
    'messageBranchId',
    'runtimeSegmentId',
    'promptMessageId'
  ] as const)('rejects a pending parent with a different %s', async (field) => {
    const { client, parent, child } = await createPendingChain()
    await client.artifactVersion.update({
      where: { id: parent.versionId },
      data: { [field]: 'another-owner' }
    })
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      cause: {
        message: `Managed file version domain audit failed for artifact-based-on: ${child.versionId}`
      }
    })
  })

  it.each([
    ['parent', { state: 'staging' }],
    ['parent', { originKind: 'legacy' }],
    ['parent', { versionNumber: 3 }],
    ['child', { state: 'finalized' }],
    ['child', { originKind: 'legacy' }]
  ] as const)('rejects invalid ancestry after changing %s to %j', async (target, data) => {
    const { client, parent, child } = await createPendingChain()
    await client.artifactVersion.update({
      where: { id: target === 'parent' ? parent.versionId : child.versionId },
      data
    })
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      cause: {
        message: `Managed file version domain audit failed for artifact-based-on: ${child.versionId}`
      }
    })
  })

  it('rejects self-referencing pending versions', async () => {
    const { client, child } = await createPendingChain()
    await client.artifactVersion.update({
      where: { id: child.versionId },
      data: { basedOnVersionId: child.versionId }
    })
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      cause: {
        message: `Managed file version domain audit failed for artifact-based-on: ${child.versionId}`
      }
    })
  })

  it('still rejects a pending version as the visible artifact head', async () => {
    const { client, parent } = await createPendingChain()
    await client.artifactLineage.update({
      where: { id: parent.artifactId },
      data: { currentVersionId: parent.versionId }
    })
    await expect(migrateApplicationDatabase(client)).rejects.toMatchObject({
      code: 'database_validation_failed',
      cause: {
        message: `Managed file version domain audit failed for artifact-head: ${parent.artifactId}`
      }
    })
  })

  it('preserves finalized ancestry across different turns and branches', async () => {
    const { client, parent } = await createPendingChain()
    await client.artifactVersion.update({
      where: { id: parent.versionId },
      data: {
        state: 'finalized',
        artifactRunId: 'previous-run',
        messageBranchId: 'previous-branch'
      }
    })
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
  })
})

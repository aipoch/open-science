import { afterEach, describe, expect, it } from 'vitest'

import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from './provenance-test-fixtures'

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>
const fixtures: Fixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

describe('Artifact Provenance dependency reads', () => {
  it('projects the same typed input relation upstream and downstream', async () => {
    const fixture = await createProvenanceTestFixture()
    fixtures.push(fixture)
    await fixture.stagePng('upstream', 'input.png')
    const upstream = await fixture.repository.createVersion(
      createArtifactVersionRequest({
        filename: 'input.png',
        writeOperationId: 'write-upstream',
        writeRequestChecksum: 'b'.repeat(64)
      })
    )
    await fixture.stagePng('downstream', 'output.png')
    const downstream = await fixture.repository.createVersion(
      createArtifactVersionRequest({
        filename: 'output.png',
        writeOperationId: 'write-downstream',
        writeRequestChecksum: 'c'.repeat(64)
      })
    )
    const source = await fixture.client.artifactVersion.findUniqueOrThrow({
      where: { id: upstream.versionId }
    })
    await fixture.client.artifactVersionInput.create({
      data: {
        id: 'input-relation-1',
        artifactVersionId: downstream.versionId,
        ordinal: 0,
        inputFileVersionId: upstream.versionId,
        sourceKind: 'artifact-version',
        sourceFileId: upstream.artifactId,
        sourceArtifactVersionId: upstream.versionId,
        sourceVersionNumber: upstream.versionNumber,
        sourceCreatedAt: new Date(upstream.createdAt),
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-1',
        filename: 'input.png',
        contentType: 'image/png',
        sizeBytes: BigInt(upstream.size),
        checksum: upstream.checksum,
        storageKey: source.contentStorageKey,
        strongestAssociation: 'resolver-accessed'
      }
    })

    const expected = [
      {
        versionId: downstream.versionId,
        dependsOnVersionId: upstream.versionId,
        ordinal: 0,
        sourceKind: 'artifact-version',
        inputFilename: 'input.png',
        association: 'resolver-accessed'
      }
    ]
    await expect(
      fixture.repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: downstream.versionId,
        direction: 'up'
      })
    ).resolves.toEqual(expected)
    await expect(
      fixture.repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: upstream.versionId,
        direction: 'down'
      })
    ).resolves.toEqual(expected)

    await fixture.client.uploadFile.create({
      data: {
        id: 'upload-file-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'source.csv',
        originalFilename: 'source.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: 'uploads/project-1/session-1/upload-version-1/content',
            filename: 'source.csv',
            originalFilename: 'source.csv',
            contentType: 'text/csv',
            sizeBytes: 7n,
            checksum: 'd'.repeat(64),
            createdAt: new Date('2026-08-02T00:00:00.000Z')
          }
        }
      }
    })
    await fixture.client.artifactVersionInput.create({
      data: {
        id: 'input-relation-upload',
        artifactVersionId: downstream.versionId,
        ordinal: 1,
        inputFileVersionId: 'upload-version-1',
        sourceKind: 'upload-version',
        sourceFileId: 'upload-file-1',
        sourceUploadVersionId: 'upload-version-1',
        sourceVersionNumber: 1,
        sourceCreatedAt: new Date('2026-08-02T00:00:00.000Z'),
        sourceProjectId: 'project-1',
        sourceSessionId: 'session-1',
        filename: 'source.csv',
        contentType: 'text/csv',
        sizeBytes: 7n,
        checksum: 'd'.repeat(64),
        storageKey: 'uploads/project-1/session-1/upload-version-1/content',
        strongestAssociation: 'turn-attached'
      }
    })
    await expect(
      fixture.repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: 'upload-version-1',
        direction: 'down'
      })
    ).resolves.toEqual([
      {
        versionId: downstream.versionId,
        dependsOnVersionId: 'upload-version-1',
        ordinal: 1,
        sourceKind: 'upload-version',
        inputFilename: 'source.csv',
        association: 'turn-attached'
      }
    ])

    await fixture.client.fileOriginSession.create({
      data: { projectId: 'project-2', sessionId: 'session-1' }
    })
    await fixture.client.artifactVersionInput.update({
      where: { id: 'input-relation-1' },
      data: { sourceProjectId: 'project-2' }
    })
    await expect(
      fixture.repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: downstream.versionId,
        direction: 'up'
      })
    ).rejects.toThrow('Artifact dependency relation is corrupt')

    await fixture.client.artifactVersionInput.update({
      where: { id: 'input-relation-1' },
      data: { sourceProjectId: 'project-1' }
    })
    await fixture.client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
    await fixture.client.artifactVersionInput.update({
      where: { id: 'input-relation-1' },
      data: {
        inputFileVersionId: 'missing-version',
        sourceArtifactVersionId: 'missing-version'
      }
    })
    await fixture.client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
    await expect(
      fixture.repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: downstream.versionId,
        direction: 'up'
      })
    ).rejects.toThrow('Artifact dependency relation is corrupt')
  })
})

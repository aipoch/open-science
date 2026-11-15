import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { createProjectDbClient } from '../projects/prisma-client'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'

it('preserves existing versions and inbound heads while admitting only explicit independent image provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-task-migration-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id < '0060_image_models')
    )
    await client.fileOriginSession.create({ data: { projectId: 'p', sessionId: 's' } })
    await client.artifactLineage.create({
      data: {
        id: 'file',
        projectId: 'p',
        sessionId: 's',
        filename: 'image.png',
        normalizedFilename: 'image.png'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'version',
        artifactId: 'file',
        versionNumber: 1,
        filename: 'image.png',
        originKind: 'agent_generated',
        state: 'finalized',
        artifactRunId: 'run',
        rootFrameId: 'root',
        agentFrameId: 'root',
        messageBranchId: 'branch',
        runtimeSegmentId: 'runtime',
        promptMessageId: 'prompt',
        evidenceStorageKey: 'evidence',
        evidenceJson: '{}',
        evidenceChecksum: 'b'.repeat(64),
        evidenceSchemaVersion: 1,
        contentStorageKey: 'content',
        sizeBytes: 10,
        checksum: 'a'.repeat(64)
      }
    })
    await client.artifactLineage.update({
      where: { id: 'file' },
      data: { currentVersionId: 'version' }
    })
    const before = await client.artifactVersion.findUniqueOrThrow({ where: { id: 'version' } })
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: ['0060_image_models']
    })
    expect(await client.artifactVersion.findUniqueOrThrow({ where: { id: 'version' } })).toEqual(
      before
    )
    expect(
      (await client.artifactLineage.findUniqueOrThrow({ where: { id: 'file' } })).currentVersionId
    ).toBe('version')
    const update = (evidenceJson: string): ReturnType<typeof client.artifactVersion.update> =>
      client.artifactVersion.update({
        where: { id: 'version' },
        data: { promptMessageId: null, runtimeSegmentId: null, evidenceJson }
      })
    for (const evidence of [
      {},
      { image_task_id: 'other', producer: { kind: 'connector', connector_id: 'image-model' } },
      { image_task_id: 'run', producer: { kind: 'connector', connector_id: 'other' } }
    ])
      await expect(update(JSON.stringify(evidence))).rejects.toThrow('CHECK')
    await update(
      JSON.stringify({
        image_task_id: 'run',
        producer: { kind: 'connector', connector_id: 'image-model' }
      })
    )
    await expect(
      client.artifactVersion.update({
        where: { id: 'version' },
        data: { messageId: 'fake-message' }
      })
    ).rejects.toThrow('CHECK')
    expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([])
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

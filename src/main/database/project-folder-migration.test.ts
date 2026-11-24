import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { createDatabaseAtReleasedManifest } from '../../../test/fixtures/application-database'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import type { NotebookRunDocument } from '../../shared/notebook'
import { createProjectDbClient } from '../projects/prisma-client'
import { ArtifactRepository } from '../artifacts/repository'
import { createRootNotebookLane } from '../notebook/lane-identity'
import { NotebookRunRepository } from '../notebook/repository'
import { ProjectRepository } from '../projects/repository'
import { getProjectRecordRoot, readProjectRecordManifest } from '../projects/record-storage'
import { getProjectSessionOutputLayout } from '../projects/session-output-layout'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { MIGRATION_MANIFEST, migrateApplicationDatabase } from './migration-service'

configureTestRuntimeMetadata()

it('adds nullable project folders to released databases without changing historical rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-folder-migration-'))
  const client = createProjectDbClient(root)
  try {
    await createDatabaseAtReleasedManifest(client)
    await client.$executeRaw`INSERT INTO "Project" (id, name, updatedAt) VALUES ('historical', 'Historical', CURRENT_TIMESTAMP)`
    const before = await client.$queryRaw`SELECT id, name, updatedAt FROM "Project"`
    await expect(
      migrateApplicationDatabase(client, { databasePath: join(root, 'open-science.db') })
    ).resolves.toMatchObject({ applied: expect.arrayContaining(['0061_project_folder']) })
    expect(await client.$queryRaw`SELECT id, name, updatedAt FROM "Project"`).toEqual(before)
    expect(await client.$queryRaw`SELECT rootPath FROM "Project"`).toEqual([{ rootPath: null }])
    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({ applied: [] })
    await client.$executeRawUnsafe('ALTER TABLE "Project" DROP COLUMN "rootPath"')
    await expect(migrateApplicationDatabase(client)).rejects.toThrow()
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('continues reading and writing main-era managed Session, Notebook and Artifact data after migration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-project-migration-')))
  initDataRoot(root)
  const client = createProjectDbClient(root)
  const projectId = 'historical'
  const sessionId = 'session'
  const lane = createRootNotebookLane(projectId, sessionId, 'root-frame')
  const scope = { projectId, sessionId, workspaceCwd: root, lane }

  const publish = async (
    artifacts: ArtifactRepository,
    id: string,
    content: string
  ): Promise<void> => {
    await artifacts.writePendingFile({
      projectId,
      sessionId,
      runId: id,
      filename: 'result.txt',
      mimeType: 'text/plain',
      source: { kind: 'inline', content, encoding: 'utf8' }
    })
    await artifacts.finalizeRunArtifacts({ projectId, sessionId, runId: id, messageId: id })
  }
  const appendRun = (
    notebooks: NotebookRunRepository,
    id: string,
    startedAt: number
  ): Promise<NotebookRunDocument> =>
    notebooks.appendRun({
      ...scope,
      run: {
        runId: id,
        cellId: id,
        source: 'user',
        kernelKind: 'python',
        status: 'completed',
        startedAt,
        script: 'print(42)',
        text: { stdout: '42', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: []
      }
    })

  try {
    await createDatabaseAtReleasedManifest(
      client,
      MIGRATION_MANIFEST.filter(({ id }) => id <= '0060_image_models')
    )
    await client.$executeRaw`INSERT INTO "Project" (id, name, updatedAt) VALUES (${projectId}, 'Historical', CURRENT_TIMESTAMP)`
    await new SessionRepository(root).saveSession({
      id: sessionId,
      projectId,
      title: 'Existing conversation',
      cwd: root,
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'historical-prompt',
          role: 'user',
          content: 'Keep the original conversation.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })
    const originalNotebooks = new NotebookRunRepository(root)
    await originalNotebooks.loadOrCreate(scope)
    await appendRun(originalNotebooks, 'old-run', 1)
    await publish(new ArtifactRepository(root), 'old-message', 'Historical research')

    await expect(migrateApplicationDatabase(client)).resolves.toMatchObject({
      applied: ['0061_project_folder', '0062_artifact_output_delivery']
    })

    const projects = new ProjectRepository(async () => client, undefined, undefined, {
      storageRoot: () => root
    })
    expect(await projects.get(projectId)).toMatchObject({ id: projectId, name: 'Historical' })
    expect(await projects.assertProjectFolderHealthy(projectId)).toBeUndefined()
    expect(getProjectRecordRoot(root, projectId)).toBeUndefined()
    expect(getProjectSessionOutputLayout(root, projectId, sessionId)).toBeUndefined()
    expect(readProjectRecordManifest(root)).toBeUndefined()

    const sessions = new SessionRepository(root)
    const session = await sessions.loadSession(projectId, sessionId)
    expect(session?.messages).toEqual([
      expect.objectContaining({
        id: 'historical-prompt',
        content: 'Keep the original conversation.'
      })
    ])
    await sessions.saveSession({ ...session!, title: 'Continued conversation' }, session!.revision)
    expect(await new SessionRepository(root).loadSession(projectId, sessionId)).toMatchObject({
      id: sessionId,
      title: 'Continued conversation'
    })

    const notebooks = new NotebookRunRepository(root)
    expect(await notebooks.readSessionRuns(projectId, sessionId)).toMatchObject([
      { runId: 'old-run', text: { stdout: '42' } }
    ])
    await appendRun(notebooks, 'new-run', 2)
    expect(await notebooks.readSessionRuns(projectId, sessionId)).toMatchObject([
      { runId: 'old-run' },
      { runId: 'new-run' }
    ])
    expect(notebooks.runJsonPath(projectId, sessionId, lane)).toBe(
      join(root, 'notebooks', projectId, sessionId, 'run.json')
    )

    const artifacts = new ArtifactRepository(root)
    for (const [messageId, contents] of [
      ['old-message', 'Historical research'],
      ['new-message', 'Continued research']
    ]) {
      if (messageId === 'new-message') await publish(artifacts, messageId, contents)
      const [file] = await artifacts.listMessageFiles({ projectId, sessionId, messageId })
      expect(file.path).toBe(join(root, 'artifacts', projectId, sessionId, messageId, 'result.txt'))
      await expect(readFile(file.path, 'utf8')).resolves.toBe(contents)
    }
    expect(readProjectRecordManifest(root)).toBeUndefined()
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

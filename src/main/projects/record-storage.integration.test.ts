import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerDatabaseFixture } from '../database/migrated-database.test-support'
import { ProjectRepository } from './repository'
import { ensureProjectNotebookOutputDirectory } from './session-output-layout'
import type { createProjectDbClient } from './prisma-client'
import {
  getProjectRecordRoot,
  getProjectRecordRoute,
  readProjectRecordManifest
} from './record-storage'

const database = registerDatabaseFixture()
let root: string
let client: ReturnType<typeof createProjectDbClient>
let repository: ProjectRepository
let folder: string
let dataRoot: string
const assertLocation = vi.fn(async () => undefined)
const restoreIndexes = vi.fn(async () => undefined)
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-record-storage-')))
  folder = join(root, 'research')
  dataRoot = join(root, 'data')
  for (const name of ['research', 'data', 'config', 'home']) await mkdir(join(root, name))
  client = await database(join(root, 'config'))
  assertLocation.mockClear()
  restoreIndexes.mockClear()
  repository = new ProjectRepository(
    async () => client,
    undefined,
    {
      dataRoot,
      configRoot: join(root, 'config'),
      homePath: join(root, 'home'),
      preflight: async () => undefined
    },
    { storageRoot: () => dataRoot, assertLocation, restoreIndexes }
  )
})
afterEach(async () => {
  await client?.$disconnect()
  if (root) await rm(root, { recursive: true, force: true })
})

it('enables durable records for new bindings, leaving legacy and managed projects unchanged', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  expect(getProjectRecordRoot(dataRoot, project.id)).toBe(join(folder, '.open-science'))
  expect(readProjectRecordManifest(folder)).toMatchObject({
    projectId: project.id,
    version: 2,
    outputLayout: 'session-v1'
  })
  expect(assertLocation).toHaveBeenCalledWith(folder)
  const oldFolder = join(root, 'legacy')
  await mkdir(oldFolder)
  const legacy = await client.project.create({ data: { name: 'Legacy', rootPath: oldFolder } })
  await repository.assertProjectFolderHealthy(legacy.id)
  expect(getProjectRecordRoot(dataRoot, legacy.id)).toBeUndefined()
  expect(readProjectRecordManifest(oldFolder)).toBeUndefined()
  const managed = await repository.create({ name: 'Managed' })
  expect(getProjectRecordRoot(dataRoot, managed.id)).toBeUndefined()
})

it('locates the same durable identity and rejects empty replacement folders', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  const moved = folder + '-moved'
  await rename(folder, moved)
  expect(() => getProjectRecordRoot(dataRoot, project.id)).toThrow()
  const empty = join(root, 'empty')
  await mkdir(empty)
  await expect(
    repository.locateFolder(
      { projectId: project.id, path: empty, expectedRootPath: folder },
      (commit) => commit()
    )
  ).rejects.toThrow('research records')
  await repository.locateFolder(
    { projectId: project.id, path: moved, expectedRootPath: folder },
    (commit) => commit()
  )
  expect(getProjectRecordRoot(dataRoot, project.id)).toBe(join(moved, '.open-science'))
  expect((await repository.get(project.id))?.rootPath).toBe(moved)
})

it('retains records on removal and reopens the same identity with index restoration', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  const evidence = join(folder, '.open-science', 'evidence.json')
  await writeFile(evidence, 'research evidence')
  await repository.createDeletionIntent(project.id)
  expect(getProjectRecordRoute(dataRoot, project.id)?.detached).toBe(true)
  await client.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } })
  await expect(repository.create({ name: 'Research', rootPath: folder })).rejects.toThrow(
    'cleanup completes'
  )
  await repository.deleteDeletionIntent(project.id)
  const reopened = await repository.create({ name: 'Reopened research', rootPath: folder })
  expect(reopened.id).toBe(project.id)
  expect(restoreIndexes).toHaveBeenCalledWith(expect.anything(), project.id)
  expect(getProjectRecordRoute(dataRoot, project.id)?.detached).toBeUndefined()
  expect(await readFile(evidence, 'utf8')).toBe('research evidence')
})

it('never treats missing or damaged registered records as a new empty managed project', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  await writeFile(join(folder, '.open-science', 'project.json'), '{broken')
  expect(() => getProjectRecordRoot(dataRoot, project.id)).toThrow()
  await expect(repository.assertProjectFolderHealthy(project.id)).rejects.toThrow()
  await expect(repository.create({ name: 'Replacement', rootPath: folder })).rejects.toThrow()
  expect(await client.project.count()).toBe(1)
})

it('does not detach active records when the durable deletion intent cannot be saved', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  const failure = vi
    .spyOn(client.projectDeletionIntent, 'upsert')
    .mockRejectedValueOnce(new Error('database unavailable'))
  await expect(repository.createDeletionIntent(project.id)).rejects.toThrow('database unavailable')
  expect(getProjectRecordRoute(dataRoot, project.id)?.detached).toBeUndefined()
  expect(await client.projectDeletionIntent.count()).toBe(0)
  failure.mockRestore()
  await repository.assertProjectFolderHealthy(project.id)
  await repository.createDeletionIntent(project.id)
  expect(getProjectRecordRoute(dataRoot, project.id)?.detached).toBe(true)
})

it('requires explicit enable for reopened v1 records and never upgrades a stale edit', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  const manifest = readProjectRecordManifest(folder)!
  const legacy = {
    format: manifest.format,
    projectId: manifest.projectId,
    name: manifest.name,
    createdAt: manifest.createdAt
  }
  await writeFile(
    join(folder, '.open-science', 'project.json'),
    JSON.stringify({ ...legacy, version: 1 })
  )
  expect((await repository.get(project.id))?.outputLayout).toBe('legacy')
  await repository.update({ id: project.id, expectedUpdatedAt: project.updatedAt, name: 'Renamed' })
  expect(readProjectRecordManifest(folder)?.version).toBe(1)
  await expect(
    repository.update({
      id: project.id,
      expectedUpdatedAt: project.updatedAt,
      enableSessionOutputs: true
    })
  ).rejects.toThrow('changed elsewhere')
  expect(readProjectRecordManifest(folder)?.version).toBe(1)
  const latest = (await repository.get(project.id))!
  const enabled = await repository.update({
    id: project.id,
    expectedUpdatedAt: latest.updatedAt,
    enableSessionOutputs: true
  })
  expect(enabled.outputLayout).toBe('session-v1')
  expect(readProjectRecordManifest(folder)?.version).toBe(2)
})

it('revalidates known output directories only on explicit copied-folder locate and reopen', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  const output = (await ensureProjectNotebookOutputDirectory(dataRoot, project.id, 'app-session'))!
  await writeFile(join(output, 'result.txt'), 'preserve')
  const moved = folder + '-copied'
  await cp(folder, moved, { recursive: true })
  await rm(folder, { recursive: true })
  await repository.locateFolder(
    { projectId: project.id, path: moved, expectedRootPath: folder },
    (commit) => commit()
  )
  const relativeOutput = 'notebooks/' + project.id + '/app-session/data'
  expect(await ensureProjectNotebookOutputDirectory(dataRoot, project.id, 'app-session')).toBe(
    join(moved, relativeOutput)
  )
  expect(await readFile(join(moved, relativeOutput, 'result.txt'), 'utf8')).toBe('preserve')
  const reopenedCopy = folder + '-reopened'
  await cp(moved, reopenedCopy, { recursive: true })
  await client.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } })
  const reopened = await repository.create({ name: 'Reopened', rootPath: reopenedCopy })
  await repository.completeRecordRecovery(project.id)
  expect(reopened.id).toBe(project.id)
  expect(await ensureProjectNotebookOutputDirectory(dataRoot, project.id, 'app-session')).toBe(
    join(reopenedCopy, relativeOutput)
  )
  expect(await readFile(join(reopenedCopy, relativeOutput, 'result.txt'), 'utf8')).toBe('preserve')
})

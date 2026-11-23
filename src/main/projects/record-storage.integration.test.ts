import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerDatabaseFixture } from '../database/migrated-database.test-support'
import { ProjectRepository } from './repository'
import { ensureProjectNotebookOutputDirectory } from './session-output-layout'
import type { createProjectDbClient } from './prisma-client'
import { projectRecordRoutePath } from '../storage/data-location-identity'
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

it('binds existing input bytes with one project manifest and keeps managed projects unbound', async () => {
  const raw = Buffer.from('sample,value\r\nA,12\r\n')
  await writeFile(join(folder, 'raw.csv'), raw)
  const project = await repository.create({ name: 'Research', rootPath: folder })
  expect(getProjectRecordRoot(dataRoot, project.id)).toBe(join(folder, '.open-science'))
  expect(readProjectRecordManifest(folder)).toEqual({
    format: 'open-science-project',
    version: 1,
    projectId: project.id,
    name: 'Research',
    createdAt: expect.any(Number)
  })
  expect(await readFile(join(folder, 'raw.csv'))).toEqual(raw)
  expect(assertLocation).toHaveBeenCalledWith(folder)
  const managed = await repository.create({ name: 'Managed' })
  expect(managed.rootPath).toBeUndefined()
  expect(getProjectRecordRoot(dataRoot, managed.id)).toBeUndefined()
})

it('locates the same durable identity and rejects empty replacement folders even without a route', async () => {
  const project = await repository.create({ name: 'Research', rootPath: folder })
  const moved = folder + '-moved'
  await rename(folder, moved)
  expect(() => getProjectRecordRoot(dataRoot, project.id)).toThrow()
  await rm(projectRecordRoutePath(dataRoot, project.id))
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

it('never treats missing or damaged bound records as a new empty managed project', async () => {
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

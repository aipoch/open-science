import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDatabaseFixture } from '../database/migrated-database.test-support'
import { ArtifactRepository } from '../artifacts/repository'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { createProjectHandlers } from './ipc'
import type { ProjectHandlers } from './ipc'
import { createProjectDbClient } from './prisma-client'
import { ProjectFolderFiles } from './project-folder-files'
import { initializeProjectRecordStorage } from './record-storage'
import { ProjectRepository } from './repository'

const openInterception = vi.hoisted(() => ({
  before: undefined as undefined | ((path: unknown) => Promise<void>)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await openInterception.before?.(args[0])
      return actual.open(...args)
    }
  }
})

const linkType = process.platform === 'win32' ? 'junction' : 'dir'
describe('Project folder file authority', () => {
  const database = registerDatabaseFixture()
  let root: string
  let folder: string
  let outside: string
  let projectId: string
  let client: ReturnType<typeof createProjectDbClient>
  let repository: ProjectRepository
  let handlers: ProjectHandlers
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'project-folder-files-')))
    for (const name of ['home', 'data', 'config', 'project', 'outside'])
      await mkdir(join(root, name))
    folder = join(root, 'project')
    outside = join(root, 'outside')
    client = await database(join(root, 'config'))
    repository = new ProjectRepository(async () => client, undefined, {
      homePath: join(root, 'home'),
      dataRoot: join(root, 'data'),
      configRoot: join(root, 'config'),
      preflight: async () => undefined
    })
    projectId = (await repository.create({ name: 'Research', rootPath: folder })).id
    handlers = createProjectHandlers(repository, {
      waitForProjectOperations: async () => undefined,
      deleteProject: async () => ({ status: 'deleted' }),
      listDeletionCleanup: async () => [],
      retryDeletionCleanup: async () => undefined
    })
  })
  afterEach(async () => {
    openInterception.before = undefined
    vi.restoreAllMocks()
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('pages one live directory, defers development folders and creates no managed file records', async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        writeFile(join(folder, `result-${String(index).padStart(3, '0')}.csv`), 'a,b')
      )
    )
    for (const name of ['analysis', '.git', 'node_modules']) await mkdir(join(folder, name))
    await writeFile(join(folder, 'analysis', 'nested.csv'), 'not a root entry')
    const names: string[] = []
    let cursor: string | undefined
    do {
      const page = await handlers.listFolder({ projectId, relativePath: '', limit: 50, cursor })
      expect(page.entries.length).toBeLessThanOrEqual(50)
      expect(page.totalCount).toBe(207)
      names.push(...page.entries.map((entry) => entry.name))
      cursor = page.nextCursor
    } while (cursor)
    expect(names).toHaveLength(207)
    expect(new Set(names).size).toBe(207)
    expect(names[0]).toBe('analysis')
    expect(names.at(-1)).toBe('node_modules')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('nested.csv')
    expect(await client.managedFile.count()).toBe(0)
    await writeFile(join(folder, 'external-change.csv'), 'new')
    const refreshed = await handlers.listFolder({
      projectId,
      relativePath: '',
      query: 'external-change',
      limit: 100
    })
    expect(refreshed.entries.map((entry) => entry.name)).toEqual(['external-change.csv'])
  })

  it('rejects a cursor reused in another directory or Project', async () => {
    await mkdir(join(folder, 'analysis'))
    await writeFile(join(folder, 'raw.csv'), 'data')
    const page = await handlers.listFolder({ projectId, relativePath: '', limit: 1 })
    expect(page.nextCursor).toBeDefined()
    await expect(
      handlers.listFolder({
        projectId,
        relativePath: 'analysis',
        limit: 1,
        cursor: page.nextCursor
      })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    const other = await repository.create({ name: 'Other', rootPath: outside })
    await expect(
      handlers.listFolder({
        projectId: other.id,
        relativePath: '',
        limit: 1,
        cursor: page.nextCursor
      })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
  })

  it('lists nested folders on demand and reads current bytes with a bounded preview', async () => {
    await mkdir(join(folder, 'analysis'))
    await writeFile(join(folder, 'analysis', '..data.csv'), 'original content')
    await writeFile(join(folder, 'analysis', 'data.csv'), 'visible content')
    const nested = await handlers.listFolder({ projectId, relativePath: 'analysis', limit: 100 })
    expect(nested.entries.map((entry) => entry.name)).toEqual(['data.csv'])
    expect(
      await handlers.readFolderPreview({
        projectId,
        relativePath: 'analysis/..data.csv',
        maxBytes: 8
      })
    ).toMatchObject({ content: 'original', truncated: true })
    await writeFile(join(folder, 'analysis', '..data.csv'), 'changed')
    expect(
      await handlers.readFolderPreview({ projectId, relativePath: 'analysis/..data.csv' })
    ).toMatchObject({ content: 'changed', truncated: false })
  })

  it('rejects absolute paths, parent traversal, escaping symlinks and junctions', async () => {
    await writeFile(join(outside, 'secret.csv'), 'SECRET')
    await symlink(outside, join(folder, 'linked-data'), linkType)
    for (const relativePath of [outside, '../outside', 'linked-data']) {
      await expect(
        handlers.listFolder({ projectId, relativePath, limit: 100 })
      ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    }
    for (const relativePath of [
      join(outside, 'secret.csv'),
      '../outside/secret.csv',
      'linked-data/secret.csv'
    ]) {
      await expect(handlers.readFolderPreview({ projectId, relativePath })).rejects.toMatchObject({
        code: 'project-folder-unavailable'
      })
    }
    expect(
      (await handlers.listFolder({ projectId, relativePath: '', limit: 100 })).entries
    ).toEqual([])
  })

  it('rejects a replaced binding and a Project without a bound folder', async () => {
    const managed = await repository.create({ name: 'Managed' })
    await expect(
      handlers.listFolder({ projectId: managed.id, relativePath: '', limit: 100 })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    await rename(folder, `${folder}-moved`)
    await symlink(outside, folder, linkType)
    await expect(
      handlers.listFolder({ projectId, relativePath: '', limit: 100 })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    await rm(folder, { force: true, recursive: true })
    await expect(
      handlers.listFolder({ projectId, relativePath: '', limit: 100 })
    ).rejects.toMatchObject({ code: 'project-folder-not-found' })
  })

  it('rejects a different ordinary directory created at the same recorded path', async () => {
    const storageRoot = join(root, 'data')
    await initializeProjectRecordStorage(storageRoot, folder, {
      format: 'open-science-project',
      version: 2,
      outputLayout: 'session-v1',
      projectId,
      name: 'Research',
      createdAt: 1
    })
    const folders = new ProjectFolderFiles(
      (id) => repository.get(id),
      () => storageRoot
    )
    const relativePath = 'table.csv'
    await writeFile(join(folder, relativePath), 'original')
    await expect(folders.resolveFile(projectId, relativePath)).resolves.toBe(
      join(folder, relativePath)
    )

    await rename(folder, join(root, 'moved'))
    await mkdir(folder)
    await writeFile(join(folder, relativePath), 'replacement')
    const unavailable = { code: 'project-folder-unavailable' }
    await expect(folders.resolveFile(projectId, relativePath)).rejects.toMatchObject(unavailable)
    await expect(
      folders.listFolder({ projectId, relativePath: '', limit: 10 })
    ).rejects.toMatchObject(unavailable)
    await expect(folders.readFolderPreview({ projectId, relativePath })).rejects.toMatchObject(
      unavailable
    )
  })

  it('rejects an opened file if an attacker swaps its parent before the open completes', async () => {
    const directory = join(folder, 'analysis')
    await mkdir(directory)
    await writeFile(join(directory, 'raw.csv'), 'original')
    await writeFile(join(outside, 'raw.csv'), 'SECRET')
    let swapped = false
    openInterception.before = async (path) => {
      if (!swapped && path === join(directory, 'raw.csv')) {
        swapped = true
        await rename(directory, `${directory}-original`)
        await symlink(outside, directory, linkType)
      }
    }
    await expect(
      handlers.readFolderPreview({ projectId, relativePath: 'analysis/raw.csv' })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    expect(swapped).toBe(true)
  })

  it('does not follow a link to a distinct case-sensitive sibling', async ({ skip }) => {
    const upper = join(root, 'CaseStudy')
    const lower = join(root, 'casestudy')
    await mkdir(upper)
    await mkdir(lower, { recursive: true })
    if ((await realpath(upper)) === (await realpath(lower))) {
      skip()
      return
    }
    const bound = await repository.create({ name: 'Case-sensitive', rootPath: upper })
    await writeFile(join(lower, 'secret.csv'), 'SECRET')
    await symlink(lower, join(upper, 'escape'), linkType)
    await expect(
      handlers.readFolderPreview({ projectId: bound.id, relativePath: 'escape/secret.csv' })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
  })

  it('streams from a scoped lease and revokes the observed bytes when the file changes', async () => {
    const folders = new ProjectFolderFiles((id) => repository.get(id))
    const resolvePath = vi.fn()
    const resources = new ManagedPreviewResources({
      resolvePath,
      openProjectFolderFile: ({ projectId, path }) =>
        folders.openPreview({ projectId, relativePath: path })
    })
    const path = 'table.csv'
    await writeFile(join(folder, path), 'x,y\n1,2')
    const request = { source: 'project-folder' as const, projectId, path }
    try {
      const opened = await resources.acquire(1, request)
      const range = await resources.readRange(1, { resourceId: opened.id, begin: 0, end: 4 })
      expect(Buffer.from(range.data).toString()).toBe('x,y\n')
      await expect(resources.acquire(1, { ...request, projectId: 'unbound' })).rejects.toThrow()
      await expect(resources.acquire(1, { ...request, path: join(folder, path) })).rejects.toThrow()
      expect(resolvePath).not.toHaveBeenCalled()

      await writeFile(join(folder, path), 'a,b\n3,42')
      await expect(resources.resolveProtocolResource(opened.id)).rejects.toThrow('file changed')
      await expect(
        resources.readRange(1, { resourceId: opened.id, begin: 0, end: 4 })
      ).rejects.toThrow('file changed')
      const refreshed = await resources.acquire(1, request)
      const updated = await resources.readRange(1, { resourceId: refreshed.id, begin: 0, end: 4 })
      expect(Buffer.from(updated.data).toString()).toBe('a,b\n')
    } finally {
      resources.releaseOwner(1)
    }
  })

  it('keeps saved artifacts immutable when the live folder source is edited or removed', async () => {
    const source = join(folder, 'result.csv')
    await writeFile(source, 'original result')
    const artifacts = new ArtifactRepository(join(root, 'data'))
    const saved = await artifacts.writePendingFile(
      {
        projectId,
        sessionId: 'session',
        runId: 'run',
        filename: 'result.csv',
        source: { kind: 'localPath', path: source }
      },
      { allowedImportRoots: [folder] }
    )
    await writeFile(source, 'changed result')
    expect(await readFile(saved.path, 'utf8')).toBe('original result')
    await rm(source)
    expect(await readFile(saved.path, 'utf8')).toBe('original result')
  })
})

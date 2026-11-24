import {
  chmod,
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
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PreflightGrantedLocalRoot } from '../local-fs/service'
import type { ProjectFolderValidationOptions } from './project-folder-validation'

import { registerDatabaseFixture } from '../database/migrated-database.test-support'
import { createProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'
import { createAcpCreateSessionWorkflow } from '../acp/create-session-workflow'
import { createManagedSessionWorkspaceCapability } from '../acp/managed-session-workspace'
import { sameProjectFolderSpelling } from '../storage/data-location-identity'
import { projectFolderWarnings } from './project-folder-binding'

describe('Project folder binding authority', () => {
  const database = registerDatabaseFixture()
  let root: string
  let client: ReturnType<typeof createProjectDbClient>
  let secondClient: ReturnType<typeof createProjectDbClient> | undefined
  let repository: ProjectRepository
  let preflight: Mock<PreflightGrantedLocalRoot>
  let options: ProjectFolderValidationOptions

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'project-folder-binding-')))
    for (const name of ['home', 'data', 'config', 'project']) await mkdir(join(root, name))
    client = await database(join(root, 'config'))
    preflight = vi.fn<PreflightGrantedLocalRoot>(async () => undefined)
    options = {
      homePath: join(root, 'home'),
      dataRoot: join(root, 'data'),
      configRoot: join(root, 'config'),
      preflight
    }
    repository = new ProjectRepository(async () => client, undefined, options)
  })

  afterEach(async () => {
    await secondClient?.$disconnect()
    secondClient = undefined
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('stores the canonical create-only binding separately from Session defaults and retains user bytes on deletion', async () => {
    const folder = join(root, 'project')
    await writeFile(join(folder, 'raw.csv'), 'original bytes')
    await symlink(folder, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const project = await repository.create({ name: 'Research', rootPath: join(root, 'alias') })
    expect(project.rootPath).toBe(folder)
    expect(preflight).toHaveBeenCalledWith(folder, 'rw', join(root, 'alias'), 'tree')
    const stored = await client.project.findUniqueOrThrow({ where: { id: project.id } })
    await repository.assertProjectFolderHealthy(project.id)
    expect(preflight).toHaveBeenLastCalledWith(folder, 'rw', folder, 'target')
    expect(stored.rootPath).toBe(folder)
    expect(stored.sessionDefaults).not.toContain(folder)
    await repository.delete(project.id)
    expect(await readFile(join(folder, 'raw.csv'), 'utf8')).toBe('original bytes')
    expect(await repository.get(project.id)).toBeNull()
  })

  it('rejects overlapping active roots, but permits siblings and archived/deleted bindings', async () => {
    const folder = join(root, 'project')
    const child = join(folder, 'nested')
    await mkdir(child)
    const a = await repository.create({ name: 'A', rootPath: child })
    await expect(repository.create({ name: 'Same', rootPath: child })).rejects.toMatchObject({
      code: 'project-folder-conflict'
    })
    await expect(repository.create({ name: 'Ancestor', rootPath: folder })).rejects.toMatchObject({
      code: 'project-folder-conflict'
    })
    const sibling = join(folder, process.platform === 'win32' ? 'sibling' : '..\\sibling')
    await mkdir(sibling)
    await expect(repository.create({ name: 'Sibling', rootPath: sibling })).resolves.toMatchObject({
      rootPath: sibling
    })
    const archived = await repository.updateArchive(
      { id: a.id, archived: true, expectedArchiveRevision: a.archiveRevision! },
      1000
    )
    const b = await repository.create({ name: 'B', rootPath: child })
    await expect(
      repository.updateArchive(
        { id: a.id, archived: false, expectedArchiveRevision: archived.archiveRevision! },
        2000
      )
    ).rejects.toMatchObject({ code: 'project-folder-conflict' })
    expect(await repository.get(a.id)).toMatchObject({
      archivedAt: 1000,
      rootPath: child,
      archiveRevision: archived.archiveRevision
    })
    await repository.updateArchive(
      { id: b.id, archived: true, expectedArchiveRevision: b.archiveRevision! },
      3000
    )
    await expect(
      repository.updateArchive(
        { id: a.id, archived: false, expectedArchiveRevision: archived.archiveRevision! },
        4000
      )
    ).resolves.not.toHaveProperty('archivedAt')
    await repository.delete(a.id)
    await expect(
      repository.create({ name: 'After deletion', rootPath: child })
    ).resolves.toMatchObject({ rootPath: child })
  })

  it('serializes concurrent bindings across repository instances', async () => {
    secondClient = createProjectDbClient(join(root, 'config'))
    const other = new ProjectRepository(async () => secondClient!, undefined, options)
    const results = await Promise.allSettled([
      repository.create({ name: 'First', rootPath: join(root, 'project') }),
      other.create({ name: 'Second', rootPath: join(root, 'project') })
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(
      await client.project.count({
        where: { rootPath: join(root, 'project'), archivedAt: null, deletedAt: null }
      })
    ).toBe(1)
  })

  it('restores a moved archived binding only after reserving its saved location, then locates it in Workspace', async () => {
    const parent = join(root, 'group')
    const saved = join(parent, 'research')
    const moved = join(root, 'moved')
    await mkdir(saved, { recursive: true })
    await writeFile(join(saved, 'raw.csv'), 'ORIGINAL')
    const project = await repository.create({ name: 'Archived research', rootPath: saved })
    const archived = await repository.updateArchive(
      { id: project.id, archived: true, expectedArchiveRevision: project.archiveRevision! },
      1000
    )
    await rename(saved, moved)
    const occupant = await repository.create({ name: 'Ancestor reservation', rootPath: parent })
    const restore = {
      id: project.id,
      archived: false,
      expectedArchiveRevision: archived.archiveRevision!
    }
    await expect(repository.updateArchive(restore, 2000)).rejects.toMatchObject({
      code: 'project-folder-conflict'
    })
    expect(await repository.get(project.id)).toMatchObject({ archivedAt: 1000, rootPath: saved })
    await repository.updateArchive(
      { id: occupant.id, archived: true, expectedArchiveRevision: occupant.archiveRevision! },
      3000
    )
    const restored = await repository.updateArchive(restore, 4000)
    expect(restored).not.toHaveProperty('archivedAt')
    expect(restored.rootPath).toBe(saved)
    expect(await repository.checkFolder({ projectId: project.id })).toMatchObject({
      ok: false,
      kind: 'not-found'
    })
    await expect(repository.assertProjectFolderHealthy(project.id)).rejects.toMatchObject({
      code: 'project-folder-not-found'
    })
    await expect(
      repository.locateFolder(
        { projectId: project.id, expectedRootPath: saved, path: moved },
        (commit) => commit()
      )
    ).resolves.toMatchObject({ id: project.id, rootPath: moved })
    expect(await repository.assertProjectFolderHealthy(project.id)).toBe(moved)
    expect(await readFile(join(moved, 'raw.csv'), 'utf8')).toBe('ORIGINAL')
  })

  it('serializes restoration of missing archived bindings across repository instances', async () => {
    const saved = join(root, 'project')
    const first = await repository.create({ name: 'First', rootPath: saved })
    const archivedFirst = await repository.updateArchive(
      { id: first.id, archived: true, expectedArchiveRevision: first.archiveRevision! },
      1000
    )
    const second = await repository.create({ name: 'Second', rootPath: saved })
    const archivedSecond = await repository.updateArchive(
      { id: second.id, archived: true, expectedArchiveRevision: second.archiveRevision! },
      2000
    )
    await rename(saved, join(root, 'moved'))
    secondClient = createProjectDbClient(join(root, 'config'))
    const other = new ProjectRepository(async () => secondClient!, undefined, options)
    const results = await Promise.allSettled([
      repository.updateArchive(
        { id: first.id, archived: false, expectedArchiveRevision: archivedFirst.archiveRevision! },
        3000
      ),
      other.updateArchive(
        {
          id: second.id,
          archived: false,
          expectedArchiveRevision: archivedSecond.archiveRevision!
        },
        3000
      )
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'project-folder-conflict' }
    })
    expect(
      await client.project.count({ where: { rootPath: saved, archivedAt: null, deletedAt: null } })
    ).toBe(1)
  })

  it('retains archive state when an existing folder fails access preflight or is replaced by a symlink', async () => {
    const saved = join(root, 'project')
    const project = await repository.create({ name: 'Archived', rootPath: saved })
    const archived = await repository.updateArchive(
      { id: project.id, archived: true, expectedArchiveRevision: project.archiveRevision! },
      1000
    )
    const restore = {
      id: project.id,
      archived: false,
      expectedArchiveRevision: archived.archiveRevision!
    }
    preflight.mockRejectedValueOnce(Object.assign(new Error('Access denied'), { code: 'EACCES' }))
    await expect(repository.updateArchive(restore, 2000)).rejects.toMatchObject({
      code: 'project-folder-unavailable'
    })
    await rm(saved, { recursive: true })
    await symlink(
      join(root, 'missing-target'),
      saved,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(repository.updateArchive(restore, 2000)).rejects.toMatchObject({
      code: 'project-folder-unavailable'
    })
    expect(await repository.get(project.id)).toMatchObject({
      archivedAt: 1000,
      rootPath: saved,
      archiveRevision: archived.archiveRevision
    })
  })

  it.each([
    'self-loop',
    'not-a-directory',
    ...(process.platform === 'win32' || process.getuid?.() === 0 ? [] : ['inaccessible'])
  ])(
    'keeps healthy siblings usable while retaining the D6 reservation of an unrelated %s binding',
    async (failure) => {
      const healthy = await repository.create({
        name: 'Healthy A',
        rootPath: join(root, 'project')
      })
      const group = join(root, 'group')
      const parent = join(group, 'parent')
      const broken = join(parent, 'research')
      await mkdir(broken, { recursive: true })
      const sibling = await repository.create({ name: 'Unavailable B', rootPath: broken })
      if (failure === 'inaccessible') await chmod(parent, 0)
      else {
        await rm(parent, { recursive: true })
        if (failure === 'self-loop')
          await symlink(parent, parent, process.platform === 'win32' ? 'junction' : 'dir')
        else await writeFile(parent, 'This ancestor is now a file')
      }
      try {
        expect(await repository.checkFolder({ projectId: sibling.id })).toMatchObject({
          ok: false,
          kind: 'unavailable'
        })
        expect(await repository.assertProjectFolderHealthy(healthy.id)).toBe(join(root, 'project'))
        const third = join(root, 'third')
        await mkdir(third)
        await expect(
          repository.create({ name: 'Healthy C', rootPath: third })
        ).resolves.toMatchObject({ rootPath: third })
        await expect(
          repository.create({ name: 'Occupied ancestor', rootPath: group })
        ).rejects.toMatchObject({ code: 'project-folder-conflict' })
        const alias = join(root, 'group-alias')
        await symlink(group, alias, process.platform === 'win32' ? 'junction' : 'dir')
        await expect(
          repository.create({ name: 'Alias ancestor', rootPath: alias })
        ).rejects.toMatchObject({ code: 'project-folder-conflict' })
        await expect(repository.validateFolder({ path: broken })).resolves.toMatchObject({
          ok: false,
          kind: 'unavailable'
        })
      } finally {
        if (failure === 'inaccessible') await chmod(parent, 0o700)
      }
    }
  )

  it('reports only a missing selected folder as not-found and preserves other failures as unavailable', async () => {
    expect(await repository.validateFolder({ path: join(root, 'missing') })).toMatchObject({
      ok: false,
      kind: 'not-found'
    })
    await writeFile(join(root, 'storage-file'), 'not a directory')
    const unavailableStorage = new ProjectRepository(async () => client, undefined, {
      ...options,
      dataRoot: join(root, 'storage-file', 'child')
    })
    expect(await unavailableStorage.validateFolder({ path: join(root, 'project') })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })
    preflight.mockRejectedValueOnce(
      Object.assign(new Error('Protection connection failed'), { code: 'ENOENT' })
    )
    expect(await repository.validateFolder({ path: join(root, 'project') })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })
    const closed = new ProjectRepository(async () => client)
    await expect(
      closed.create({ name: 'No preflight', rootPath: join(root, 'project') })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
  })

  it('revalidates create after advisory validation and never inserts a rejected execution location', async () => {
    expect(await repository.validateFolder({ path: join(root, 'project') })).toMatchObject({
      ok: true
    })
    preflight.mockRejectedValueOnce(new Error('This execution mode does not support this location'))
    await expect(
      repository.create({ name: 'Rejected', rootPath: join(root, 'project') })
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    expect(await client.project.count()).toBe(0)
  })

  it('recognizes OS cloud directories, OneDrive environment roots and explicit UNC locations', () => {
    expect(
      projectFolderWarnings('/Users/user/Library/CloudStorage/OneDrive-Team/data', {})
    ).toEqual(['cloud-synced'])
    expect(
      projectFolderWarnings('/Users/user/Library/Mobile Documents/com~apple~CloudDocs/data', {})
    ).toEqual(['cloud-synced'])
    expect(
      projectFolderWarnings(join(root, 'OneDrive', 'data'), { OneDrive: join(root, 'OneDrive') })
    ).toEqual(['cloud-synced'])
    expect(
      projectFolderWarnings(join(root, 'OneDrive-other'), { OneDrive: join(root, 'OneDrive') })
    ).toEqual([])
    expect(projectFolderWarnings('\\\\server\\share\\data', {})).toEqual(['network'])
  })
  it('locates a genuinely missing folder after quiescence while retaining its bytes and provider-independent binding', async () => {
    const oldPath = join(root, 'project')
    const moved = join(root, 'moved')
    await writeFile(join(oldPath, 'raw.csv'), 'ORIGINAL')
    const project = await repository.create({ name: 'Research', rootPath: oldPath })
    expect(await repository.assertProjectFolderHealthy(project.id)).toBe(oldPath)
    await rename(oldPath, moved)
    expect(await repository.checkFolder({ projectId: project.id })).toMatchObject({
      ok: false,
      kind: 'not-found',
      path: oldPath
    })
    await expect(repository.assertProjectFolderHealthy(project.id)).rejects.toMatchObject({
      code: 'project-folder-not-found'
    })
    const stop = vi.fn(async (commit: () => Promise<import('../../shared/projects').Project>) => {
      expect((await repository.get(project.id))?.rootPath).toBe(oldPath)
      return commit()
    })
    await expect(
      repository.locateFolder(
        { projectId: project.id, path: moved, expectedRootPath: oldPath },
        stop
      )
    ).resolves.toMatchObject({ rootPath: moved })
    expect(stop).toHaveBeenCalledOnce()
    expect(await repository.assertProjectFolderHealthy(project.id)).toBe(moved)
    expect(await readFile(join(moved, 'raw.csv'), 'utf8')).toBe('ORIGINAL')
    expect(await repository.checkFolder({ projectId: project.id })).toMatchObject({
      ok: true,
      path: moved
    })
  })

  it('never offers path replacement for existing, inaccessible or symlink-replaced bindings', async () => {
    const oldPath = join(root, 'project')
    const replacement = join(root, 'replacement')
    await mkdir(replacement)
    const project = await repository.create({ name: 'Research', rootPath: oldPath })
    const stop = vi.fn(async (commit: () => Promise<import('../../shared/projects').Project>) =>
      commit()
    )
    await expect(
      repository.locateFolder(
        { projectId: project.id, path: replacement, expectedRootPath: oldPath },
        stop
      )
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    preflight.mockRejectedValueOnce(Object.assign(new Error('Read-only volume'), { code: 'EROFS' }))
    expect(await repository.checkFolder({ projectId: project.id })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })
    expect(stop).not.toHaveBeenCalled()
    await rm(oldPath, { recursive: true })
    await symlink(replacement, oldPath, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await repository.checkFolder({ projectId: project.id })).toMatchObject({
      ok: false,
      kind: 'unavailable'
    })
    await expect(
      repository.locateFolder(
        { projectId: project.id, path: replacement, expectedRootPath: oldPath },
        stop
      )
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    expect((await repository.get(project.id))?.rootPath).toBe(oldPath)
  })

  it('rechecks missing state, expected binding and D6 after runtime invalidation', async () => {
    const oldPath = join(root, 'project')
    const moved = join(root, 'moved')
    const project = await repository.create({ name: 'Research', rootPath: oldPath })
    await rename(oldPath, moved)
    await expect(
      repository.locateFolder(
        { projectId: project.id, path: moved, expectedRootPath: oldPath },
        async (commit) => {
          await mkdir(oldPath)
          return commit()
        }
      )
    ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
    expect((await repository.get(project.id))?.rootPath).toBe(oldPath)
    await rm(oldPath, { recursive: true })
    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    await repository.create({ name: 'Occupant', rootPath: occupied })
    const stop = vi.fn(async (commit: () => Promise<import('../../shared/projects').Project>) =>
      commit()
    )
    await expect(
      repository.locateFolder(
        { projectId: project.id, path: occupied, expectedRootPath: oldPath },
        stop
      )
    ).rejects.toMatchObject({ code: 'project-folder-conflict' })
    expect(stop).not.toHaveBeenCalled()
    await expect(
      repository.locateFolder(
        { projectId: project.id, path: moved, expectedRootPath: oldPath },
        async () => {
          throw new Error('Kernel termination failed')
        }
      )
    ).rejects.toThrow('Kernel termination failed')
    expect((await repository.get(project.id))?.rootPath).toBe(oldPath)
  })

  it('commits only one of two concurrent locate attempts', async () => {
    const oldPath = join(root, 'project')
    const first = join(root, 'first')
    const second = join(root, 'second')
    const project = await repository.create({ name: 'Research', rootPath: oldPath })
    await rename(oldPath, first)
    await mkdir(second)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stop = async (
      commit: () => Promise<import('../../shared/projects').Project>
    ): Promise<import('../../shared/projects').Project> => {
      arrivals++
      if (arrivals === 2) release()
      await gate
      return commit()
    }
    const result = await Promise.allSettled([
      repository.locateFolder(
        { projectId: project.id, path: first, expectedRootPath: oldPath },
        stop
      ),
      repository.locateFolder(
        { projectId: project.id, path: second, expectedRootPath: oldPath },
        stop
      )
    ])
    expect(result.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const current = await repository.get(project.id)
    expect([first, second]).toContain(current?.rootPath)
  })
  it('accepts case-only spelling changes only with matching filesystem identity and no symlink rebinding', async () => {
    const folder = join(root, 'project')
    const upper = join(root, 'PROJECT')
    await rename(folder, upper)
    const oldResolves = await realpath(folder).then(
      () => true,
      () => false
    )
    if (oldResolves) {
      expect(sameProjectFolderSpelling(folder, upper)).toBe(true)
    } else {
      await mkdir(folder)
      expect(sameProjectFolderSpelling(folder, upper)).toBe(false)
    }
    const child = join(upper, 'child')
    await mkdir(child)
    if (oldResolves) await rename(upper, join(root, 'retired'))
    else await rm(folder, { recursive: true })
    await symlink(
      oldResolves ? join(root, 'retired') : upper,
      folder,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const canonical = await realpath(join(folder, 'child'))
    expect(sameProjectFolderSpelling(join(folder, 'child'), canonical)).toBe(false)
  })
  it('allocates a distinct managed provider directory for bound projects containing AGENTS.md', async () => {
    const folder = join(root, 'project')
    await writeFile(join(folder, 'AGENTS.md'), 'User project instructions')
    const project = await repository.create({ name: 'Bound research', rootPath: folder })
    const createSession = vi.fn(
      async (request: import('../../shared/acp').AcpCreateSessionRequest) => {
        await repository.assertProjectFolderHealthy(request.projectId!)
        return { sessionId: 'session-managed', cwd: request.cwd }
      }
    )
    const workflow = createAcpCreateSessionWorkflow(
      { createSession, deleteSession: vi.fn() },
      {
        workspaces: createManagedSessionWorkspaceCapability({
          resolveRoot: () => options.dataRoot!
        })
      }
    )
    const session = await workflow.create({ projectId: project.id })
    const cwd = await realpath(session.cwd!)
    expect(cwd.startsWith(join(options.dataRoot!, 'workspaces') + sep)).toBe(true)
    expect(cwd).not.toBe(folder)
    expect(cwd.startsWith(folder + sep)).toBe(false)
    expect(folder.startsWith(cwd + sep)).toBe(false)
    expect((await repository.get(project.id))?.rootPath).toBe(folder)
    expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('User project instructions')
  })
})

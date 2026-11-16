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
import { afterEach, expect, it } from 'vitest'
import type { Project } from '../../shared/projects'
import type { ProjectFolderListing } from '../../shared/project-folder-files'
import { sanitizeMessageParts } from '../../shared/session-persistence/message-content'
import { createManagedFileReferenceResolver } from '../acp/file-reference-resolver'
import { ProjectFolderFiles } from './project-folder-files'

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

it('searches nested filenames and resolves live references from the current binding after relocation', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-mention-')))
  let folder = join(root, 'project')
  await mkdir(join(folder, 'nested'), { recursive: true })
  await writeFile(join(folder, 'nested/sample.csv'), 'id,value\n1,2\n')
  const service = new ProjectFolderFiles(async (id) =>
    id === 'p' ? ({ rootPath: folder } as Project) : null
  )
  const page = await service.listFolder({
    projectId: 'p',
    relativePath: '',
    query: 'sample',
    limit: 50,
    searchDescendants: true
  })
  expect(page.entries).toEqual([
    expect.objectContaining({ name: 'sample.csv', relativePath: 'nested/sample.csv' })
  ])
  const reference = {
    id: 'project-folder:p:nested/sample.csv',
    name: 'sample.csv',
    source: 'project-folder' as const,
    projectId: 'p',
    path: 'nested/sample.csv'
  }
  expect(
    sanitizeMessageParts([
      { type: 'artifact', ...reference, versionId: 'invented', sourceFileId: 'invented' }
    ])
  ).toEqual([{ type: 'artifact', ...reference }])
  const resolver = createManagedFileReferenceResolver({ projectFolders: service })
  const context = { projectId: 'p', sessionId: 's' }
  const resolved = await resolver.resolve(context, reference)
  expect(await readFile(resolved.absolutePath, 'utf8')).toBe('id,value\n1,2\n')
  expect(resolved.versionId).toBeUndefined()
  const moved = join(root, 'moved')
  await rename(folder, moved)
  folder = moved
  expect((await resolver.resolve(context, reference)).absolutePath).toBe(
    join(moved, 'nested/sample.csv')
  )
  await expect(resolver.resolve({ ...context, projectId: 'other' }, reference)).rejects.toThrow(
    'another Project'
  )
  await expect(
    resolver.resolve(context, { ...reference, path: '../outside.csv' })
  ).rejects.toThrow()
})

it('bounds results, skips dependency trees, and rejects symlinks outside the binding', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-mention-')))
  const folder = join(root, 'project')
  await mkdir(join(folder, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'outside.csv'), 'secret')
  await writeFile(join(folder, 'node_modules/hidden.csv'), 'dependency')
  await symlink(join(root, 'outside.csv'), join(folder, 'escape.csv'))
  for (let i = 0; i < 5; i++) await writeFile(join(folder, `sample-${i}.csv`), 'data')
  const service = new ProjectFolderFiles(async () => ({ rootPath: folder }) as Project)
  const all = await service.listFolder({
    projectId: 'p',
    relativePath: '',
    query: '.csv',
    limit: 50,
    searchDescendants: true
  })
  expect(all.entries.map((entry) => entry.name).sort()).toEqual(
    Array.from({ length: 5 }, (_, i) => `sample-${i}.csv`)
  )
  const limited = await service.listFolder({
    projectId: 'p',
    relativePath: '',
    query: '.csv',
    limit: 2,
    searchDescendants: true
  })
  expect(limited.entries).toHaveLength(2)
  expect(limited.truncated).toBe(true)
  await expect(service.resolveFile('p', 'escape.csv')).rejects.toThrow()
})

it('reports a bounded partial search when more than 100 empty directories are pending', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-mention-')))
  await Promise.all(Array.from({ length: 150 }, (_, index) => mkdir(join(root!, `empty-${index}`))))
  const service = new ProjectFolderFiles(async () => ({ rootPath: root }) as Project)
  const result = await service.listFolder({
    projectId: 'p',
    relativePath: '',
    query: 'missing',
    limit: 50,
    searchDescendants: true
  })
  expect(result.entries).toEqual([])
  expect(result.truncated).toBe(true)
})

it('hides dotfiles and hidden subtrees consistently in browsing and mention search', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-mention-')))
  const folder = join(root, '.project')
  await mkdir(join(folder, 'analysis', '.private'), { recursive: true })
  await writeFile(join(folder, '.DS_Store'), 'metadata')
  await writeFile(join(folder, 'analysis', '.sample.csv'), 'hidden input')
  await writeFile(join(folder, 'analysis', '.private', 'sample.csv'), 'hidden input')
  await writeFile(join(folder, 'analysis', 'sample.v1.csv'), 'visible input')
  await symlink(join(folder, 'analysis', '.sample.csv'), join(folder, 'alias.csv'), 'file')
  await symlink(
    join(folder, 'analysis', '.private'),
    join(folder, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const service = new ProjectFolderFiles(async () => ({ rootPath: folder }) as Project)
  const list = (relativePath: string, searchDescendants = false): Promise<ProjectFolderListing> =>
    service.listFolder({ projectId: 'p', relativePath, limit: 50, searchDescendants })
  expect(await list('')).toMatchObject({
    entries: [expect.objectContaining({ name: 'analysis' })],
    totalCount: 1
  })
  expect(await list('analysis')).toMatchObject({
    entries: [expect.objectContaining({ name: 'sample.v1.csv' })],
    totalCount: 1
  })
  expect(await list('', true)).toMatchObject({
    entries: [expect.objectContaining({ relativePath: 'analysis/sample.v1.csv' })],
    totalCount: 1
  })
  for (const path of ['analysis/.private', 'alias']) {
    await expect(list(path)).rejects.toThrow()
    await expect(list(path, true)).rejects.toThrow()
  }
  await expect(service.resolveFile('p', 'analysis/.sample.csv')).resolves.toBe(
    join(folder, 'analysis', '.sample.csv')
  )
})

it('isolates internal records from browsing, mentions, preview and symlink aliases', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-record-isolation-')))
  await mkdir(join(root, '.open-science/notebook'), { recursive: true })
  await writeFile(join(root, '.open-science/notebook/record.csv'), 'private record')
  await writeFile(join(root, 'sample.csv'), 'input')
  await symlink(join(root, '.open-science'), join(root, 'alias'))
  await symlink(join(root, '.open-science/notebook/record.csv'), join(root, 'alias.csv'))
  const service = new ProjectFolderFiles(async () => ({ rootPath: root }) as Project)
  const list = await service.listFolder({ projectId: 'p', relativePath: '', limit: 50 })
  expect(list.entries.map((entry) => entry.name)).toEqual(['sample.csv'])
  const search = await service.listFolder({
    projectId: 'p',
    relativePath: '',
    limit: 50,
    query: '.csv',
    searchDescendants: true
  })
  expect(search.entries.map((entry) => entry.name)).toEqual(['sample.csv'])
  for (const path of [
    '.open-science/notebook/record.csv',
    'alias/notebook/record.csv',
    'alias.csv'
  ]) {
    await expect(service.resolveFile('p', path)).rejects.toThrow()
    await expect(
      service.readFolderPreview({ projectId: 'p', relativePath: path })
    ).rejects.toThrow()
  }
  await expect(
    service.listFolder({ projectId: 'p', relativePath: '.open-science', limit: 50 })
  ).rejects.toThrow()
})

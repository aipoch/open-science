import {
  cp,
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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeDurableJsonFile } from '@aipoch/durable-files'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
vi.mock('@aipoch/durable-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/durable-files')>()
  return { ...actual, writeDurableJsonFile: vi.fn(actual.writeDurableJsonFile) }
})
import {
  initializeProjectRecordStorage,
  readProjectRecordManifest,
  registerProjectRecordStorage
} from './record-storage'
import {
  ensureProjectNotebookOutputDirectory,
  getNotebookSessionOutputRelativePath,
  getProjectSessionOutputLayout,
  isOwnedProjectNotebookOutputDirectory,
  revalidateProjectNotebookOutputDirectories
} from './session-output-layout'

let root: string
let projectRoot: string
let storageRoot: string
beforeEach(async () => {
  vi.clearAllMocks()
  root = await realpath(await mkdtemp(join(tmpdir(), 'session-output-layout-')))
  storageRoot = join(root, 'managed')
  projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  await initializeProjectRecordStorage(storageRoot, projectRoot, {
    format: 'open-science-project',
    version: 1,
    projectId: 'project-id',
    name: 'Research',
    createdAt: 1
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('routes only bound project outputs by stable project and session IDs', async () => {
  await writeFile(join(projectRoot, 'old-result.csv'), 'original')
  expect(
    getProjectSessionOutputLayout(storageRoot, 'managed-project', 'app-session')
  ).toBeUndefined()
  expect(await readFile(join(projectRoot, 'old-result.csv'), 'utf8')).toBe('original')
  const layout = getProjectSessionOutputLayout(storageRoot, 'project-id', 'app-session')!
  expect(layout).toEqual({
    projectRoot,
    notebookDataRelativePath: 'notebooks/project-id/app-session/data',
    artifactDirectoryRelativePath: 'artifacts/project-id/app-session'
  })
  await expect(readFile(join(projectRoot, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' })
  const moved = projectRoot + '-moved'
  await rename(projectRoot, moved)
  await registerProjectRecordStorage(storageRoot, moved, 'project-id')
  expect(getProjectSessionOutputLayout(storageRoot, 'project-id', 'app-session')).toEqual({
    ...layout,
    projectRoot: moved
  })
  expect(getNotebookSessionOutputRelativePath('project-id', 'app-session', 'child-frame')).toBe(
    'notebooks/project-id/app-session/frames/child-frame/data'
  )
  expect(() => getNotebookSessionOutputRelativePath('project-id', '../provider')).toThrow()
})

it.each([{ version: 2 }, { format: 'other-project' }, { layout: 'future-layout' }])(
  'rejects unsupported manifests without a managed fallback: %j',
  async (layout) => {
    const manifest = readProjectRecordManifest(projectRoot)!
    await writeFile(
      join(projectRoot, '.open-science/project.json'),
      JSON.stringify({ ...manifest, ...layout })
    )
    expect(() => readProjectRecordManifest(projectRoot)).toThrow('Unsupported')
    expect(() => getProjectSessionOutputLayout(storageRoot, 'project-id', 'app-session')).toThrow(
      'Unsupported'
    )
  }
)

it('provisions only owned session leaves, keeps ownership portable and refuses links and unowned leaves', async () => {
  const relative = 'notebooks/project-id/app-session/data'
  const [first, second] = await Promise.all([
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session'),
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ])
  expect(first).toBe(join(projectRoot, relative))
  expect(second).toBe(first)
  expect(isOwnedProjectNotebookOutputDirectory(storageRoot, 'project-id', relative)).toBe(true)
  const unowned = join(projectRoot, 'notebooks/project-id/user-session/data')
  await mkdir(unowned, { recursive: true })
  await writeFile(join(unowned, 'user.txt'), 'keep')
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'user-session')
  ).rejects.toThrow('not owned')
  expect(await readFile(join(unowned, 'user.txt'), 'utf8')).toBe('keep')
  await symlink(
    root,
    join(projectRoot, 'notebooks/project-id/linked-session'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'linked-session')
  ).rejects.toThrow('links')
  const moved = projectRoot + '-moved'
  await rename(projectRoot, moved)
  await registerProjectRecordStorage(storageRoot, moved, 'project-id')
  expect(await ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')).toBe(
    join(moved, relative)
  )
})

it.each(['before rename', 'after rename'] as const)(
  'recovers a prepared directory after failure %s without adopting unrelated files',
  async (boundary) => {
    const target = join(projectRoot, 'notebooks/project-id/app-session/data')
    const actualRename =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    if (boundary === 'before rename')
      vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash'))
    else
      vi.mocked(rename).mockImplementationOnce(async (...args) => {
        await actualRename.rename(...args)
        throw new Error('simulated crash')
      })
    await expect(
      ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
    ).rejects.toThrow('simulated crash')
    const journalPath = join(projectRoot, '.open-science/session-output-directories.json')
    const prepared = JSON.parse(await readFile(journalPath, 'utf8')).directories[0]
    expect(prepared.state).toBe('prepared')
    expect(
      isOwnedProjectNotebookOutputDirectory(storageRoot, 'project-id', prepared.relativePath)
    ).toBe(false)
    expect(
      await ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
    ).toBe(target)
    const committed = JSON.parse(await readFile(journalPath, 'utf8')).directories[0]
    expect(committed.state).toBe('committed')
    expect(committed.identity).toEqual(prepared.identity)
  }
)

it('never exposes an unrecorded public leaf when the prepared journal write fails', async () => {
  vi.mocked(writeDurableJsonFile).mockRejectedValueOnce(new Error('journal unavailable'))
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ).rejects.toThrow('journal unavailable')
  await expect(
    readFile(join(projectRoot, 'notebooks/project-id/app-session/data'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')).toBe(
    join(projectRoot, 'notebooks/project-id/app-session/data')
  )
})

it('retries the committed journal write against the same exposed directory identity', async () => {
  const actual =
    await vi.importActual<typeof import('@aipoch/durable-files')>('@aipoch/durable-files')
  vi.mocked(writeDurableJsonFile)
    .mockImplementationOnce(actual.writeDurableJsonFile)
    .mockRejectedValueOnce(new Error('commit unavailable'))
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ).rejects.toThrow('commit unavailable')
  const target = join(projectRoot, 'notebooks/project-id/app-session/data')
  expect(await ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')).toBe(
    target
  )
  expect(
    isOwnedProjectNotebookOutputDirectory(
      storageRoot,
      'project-id',
      'notebooks/project-id/app-session/data'
    )
  ).toBe(true)
})

it('refuses a replaced committed directory or a copied project without silently adopting new identities', async () => {
  const target = (await ensureProjectNotebookOutputDirectory(
    storageRoot,
    'project-id',
    'app-session'
  ))!
  await rename(target, target + '-original')
  await mkdir(target)
  await writeFile(join(target, 'user.txt'), 'keep')
  expect(
    isOwnedProjectNotebookOutputDirectory(
      storageRoot,
      'project-id',
      'notebooks/project-id/app-session/data'
    )
  ).toBe(false)
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ).rejects.toThrow('replaced')
  expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('keep')
  await rm(target, { recursive: true })
  await rename(target + '-original', target)
  await writeFile(join(target, 'result.txt'), 'saved output')
  const copied = projectRoot + '-copy'
  await cp(projectRoot, copied, { recursive: true })
  await registerProjectRecordStorage(storageRoot, copied, 'project-id')
  expect(
    isOwnedProjectNotebookOutputDirectory(
      storageRoot,
      'project-id',
      'notebooks/project-id/app-session/data'
    )
  ).toBe(false)
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ).rejects.toThrow('revalidation')
  await revalidateProjectNotebookOutputDirectories(storageRoot, 'project-id', copied)
  expect(await ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')).toBe(
    join(copied, 'notebooks/project-id/app-session/data')
  )
  expect(
    await readFile(join(copied, 'notebooks/project-id/app-session/data/result.txt'), 'utf8')
  ).toBe('saved output')
})

it('does not overwrite an unrelated leaf that appears while a prepared directory awaits retry', async () => {
  vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash'))
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ).rejects.toThrow('simulated crash')
  const target = join(projectRoot, 'notebooks/project-id/app-session/data')
  await mkdir(target)
  await writeFile(join(target, 'user.txt'), 'keep')
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')
  ).rejects.toThrow('replaced')
  expect(await readFile(join(target, 'user.txt'), 'utf8')).toBe('keep')
})

it('recreates only an empty missing leaf on explicit Notebook use, without restoring deleted output files', async () => {
  const target = (await ensureProjectNotebookOutputDirectory(
    storageRoot,
    'project-id',
    'app-session'
  ))!
  await writeFile(join(target, 'deleted-result.txt'), 'deleted')
  await rm(target, { recursive: true })
  expect(
    isOwnedProjectNotebookOutputDirectory(
      storageRoot,
      'project-id',
      'notebooks/project-id/app-session/data'
    )
  ).toBe(false)
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'app-session')).toBe(
    target
  )
  await expect(readFile(join(target, 'deleted-result.txt'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})

it('explicit revalidation preserves only recorded paths and rejects links or another project subtree', async () => {
  const target = (await ensureProjectNotebookOutputDirectory(
    storageRoot,
    'project-id',
    'app-session'
  ))!
  const unowned = join(projectRoot, 'notebooks/project-id/user-session/data')
  await mkdir(unowned, { recursive: true })
  await revalidateProjectNotebookOutputDirectories(storageRoot, 'project-id', projectRoot)
  await expect(
    ensureProjectNotebookOutputDirectory(storageRoot, 'project-id', 'user-session')
  ).rejects.toThrow('not owned')
  await rename(target, target + '-original')
  await symlink(target + '-original', target, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(
    revalidateProjectNotebookOutputDirectories(storageRoot, 'project-id', projectRoot)
  ).rejects.toThrow('links')
  const journalPath = join(projectRoot, '.open-science/session-output-directories.json')
  const journal = JSON.parse(await readFile(journalPath, 'utf8'))
  journal.directories[0].relativePath = 'notebooks/other-project/app-session/data'
  await writeFile(journalPath, JSON.stringify(journal))
  await expect(
    revalidateProjectNotebookOutputDirectories(storageRoot, 'project-id', projectRoot)
  ).rejects.toThrow('another Project')
})

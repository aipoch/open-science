import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { mapProjectFolderAcpPath } from './project-folder-file-path'

it('maps normalized new filenames while preserving existing Session files and unrelated absolute paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'acp-project-filename-'))
  const cwd = join(temp, 'managed')
  const project = join(temp, 'project')
  await mkdir(cwd)
  await mkdir(project)
  await writeFile(join(cwd, 'existing.txt'), 'MANAGED')
  try {
    expect(await mapProjectFolderAcpPath(cwd, project, join(cwd, 'raw.csv'))).toBe(
      join(project, 'raw.csv')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, join(cwd, 'existing.txt'))).toBe(
      join(cwd, 'existing.txt')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, join(temp, 'unrelated.txt'))).toBe(
      join(temp, 'unrelated.txt')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, join(cwd + '-sibling', 'raw.csv'))).toBe(
      join(cwd + '-sibling', 'raw.csv')
    )
    expect(await mapProjectFolderAcpPath(cwd, project, 'raw.csv')).toBe('raw.csv')
    const traversal = `${cwd}/nested/../raw.csv`
    expect(await mapProjectFolderAcpPath(cwd, project, traversal)).toBe(traversal)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

it('maps Windows spelling aliases while respecting distinct case-sensitive directories', async () => {
  const cwd = 'C:\\Cache\\Session'
  const alias = 'c:\\cache\\session'
  const project = 'C:\\Research'
  const missing = Object.assign(new Error('missing file'), { code: 'ENOENT' })
  const stat = vi.fn().mockRejectedValue(missing)
  const canonical = vi.fn((_path: string, callback: (error: null, path: string) => void) =>
    callback(null, cwd)
  )
  vi.doMock('node:path', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:path')>()
    return { ...actual, ...actual.win32 }
  })
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, realpath: Object.assign(vi.fn(), { native: canonical }) }
  })
  vi.doMock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    lstat: stat
  }))
  vi.resetModules()
  try {
    const { mapProjectFolderAcpPath: map } = await import('./project-folder-file-path')
    const newFile = alias + '\\nested\\Raw.csv'
    expect(await map(cwd, project, newFile)).toBe(project + '\\nested\\Raw.csv')
    expect(canonical.mock.calls.map(([path]) => path)).toEqual([alias, cwd])

    const managedFile = alias + '\\existing.txt'
    stat.mockResolvedValueOnce({})
    expect(await map(cwd, project, managedFile)).toBe(managedFile)

    canonical.mockImplementationOnce((path, callback) => callback(null, path))
    expect(await map(cwd, project, newFile)).toBe(newFile)
    const otherDrive = 'D:\\Cache\\Session\\Raw.csv'
    expect(await map(cwd, project, otherDrive)).toBe(otherDrive)
  } finally {
    vi.doUnmock('node:path')
    vi.doUnmock('node:fs')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  }
})

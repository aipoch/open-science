import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// electron's app/shell are unavailable in the test runner; stub the two calls the service makes.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/home/testuser' : '/tmp') },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
}))

import { LocalFsService } from './service'

let root = ''
const service = new LocalFsService()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-fs-test-'))
  await mkdir(join(root, 'sub'))
  await mkdir(join(root, 'Alpha'))
  await writeFile(join(root, 'notes.md'), '# Title\n\nHello world.\n', 'utf8')
  await writeFile(join(root, 'data.csv'), 'a,b\n1,2\n', 'utf8')
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('LocalFsService.listDir', () => {
  it('lists entries directories-first, alphabetical', async () => {
    const listing = await service.listDir(root)
    expect(listing.entries.map((e) => e.name)).toEqual(['Alpha', 'sub', 'data.csv', 'notes.md'])
    expect(listing.entries[0].isDirectory).toBe(true)
    expect(listing.entries.find((e) => e.name === 'notes.md')?.size).toBeGreaterThan(0)
  })

  it('resolves symlinks and .. via realpath', async () => {
    const link = join(root, 'link-to-sub')
    await symlink(join(root, 'sub'), link)
    const listing = await service.listDir(link)
    // realpath both sides: macOS resolves the tmp dir through a /private symlink prefix.
    expect(listing.resolvedPath).toBe(await realpath(join(root, 'sub')))
  })

  it('rejects relative paths', async () => {
    await expect(service.listDir('relative')).rejects.toThrow(/absolute/)
  })

  it('rejects paths with control characters', async () => {
    await expect(service.listDir('/tmp/\x00x')).rejects.toThrow(/invalid characters/)
  })
})

describe('LocalFsService.readPreview', () => {
  it('reads a bounded UTF-8 preview', async () => {
    const result = await service.readPreview({ path: join(root, 'notes.md') })
    expect(result.content).toContain('# Title')
    expect(result.encoding).toBe('utf8')
  })

  it('refuses to preview a directory', async () => {
    await expect(service.readPreview({ path: join(root, 'sub') })).rejects.toThrow(/not a file/)
  })

  it('rejects relative preview paths', async () => {
    await expect(service.readPreview({ path: 'notes.md' })).rejects.toThrow(/absolute/)
  })
})

describe('LocalFsService.getRoots', () => {
  it('returns home and a machine name', () => {
    const roots = service.getRoots()
    expect(roots.home).toBe('/home/testuser')
    expect(roots.machineName.length).toBeGreaterThan(0)
  })
})

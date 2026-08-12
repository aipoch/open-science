import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// electron's app/shell are unavailable in the test runner; stub the two calls the service makes.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/home/testuser' : '/tmp') },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
}))

import { app } from 'electron'

import type { GrantedLocalRoot } from '../../shared/local-fs'
import { LocalFsService, type GrantedLocalRootsStore } from './service'

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

describe('LocalFsService granted roots', () => {
  // Home must be pre-realpath'd: the service compares realpath(candidate) against home verbatim,
  // and macOS resolves the tmp dir through a /private symlink prefix.
  let home = ''
  let outside = ''
  let store: GrantedLocalRoot[] = []
  let grantService: LocalFsService
  // In-memory row-level store matching the SQLite repository's contract. Plain closures, not
  // vi.fn: the afterEach restoreAllMocks (for the app.getPath spy) must not reset the stub's
  // implementations between tests.
  const storeStub: GrantedLocalRootsStore = {
    list: async () => store,
    upsertByPath: async (root: GrantedLocalRoot) => {
      const existing = store.find((entry) => entry.path === root.path)
      if (existing) {
        store = store.map((entry) =>
          entry.id === existing.id ? { ...entry, access: root.access, name: root.name } : entry
        )
        return { ...existing, access: root.access, name: root.name }
      }
      store = [...store, root]
      return root
    },
    setAccess: async (id: string, access: GrantedLocalRoot['access']) => {
      store = store.map((entry) => (entry.id === id ? { ...entry, access } : entry))
    },
    remove: async (id: string) => {
      store = store.filter((entry) => entry.id !== id)
    }
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'local-fs-home-')))
    outside = await realpath(await mkdtemp(join(tmpdir(), 'local-fs-outside-')))
    await mkdir(join(home, 'Documents'))
    store = []
    vi.spyOn(app, 'getPath').mockImplementation((name: string) => (name === 'home' ? home : '/tmp'))
    grantService = new LocalFsService(storeStub)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('grants a folder inside home, canonicalized via realpath', async () => {
    const updated = await grantService.grantRoot({ path: join(home, 'Documents'), access: 'ro' })

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      path: join(home, 'Documents'),
      name: 'Documents',
      access: 'ro'
    })
    expect(updated[0].id).toMatch(/^[0-9a-f-]{36}$/)
    await expect(grantService.listGrantedRoots()).resolves.toEqual(updated)
  })

  it('grants a folder inside home even when home itself sits behind a symlink', async () => {
    // app.getPath('home') may return a path with symlinked segments (/var on macOS, /home mounts
    // on Linux): validation must compare against the canonical home, not the verbatim string.
    const symlinkedHome = join(outside, 'home-link')
    await symlink(home, symlinkedHome)
    vi.mocked(app.getPath).mockImplementation((name: string) =>
      name === 'home' ? symlinkedHome : '/tmp'
    )

    const updated = await grantService.grantRoot({
      path: join(symlinkedHome, 'Documents'),
      access: 'ro'
    })

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ path: join(home, 'Documents'), access: 'ro' })
  })

  it('rejects granting home itself', async () => {
    await expect(grantService.grantRoot({ path: home, access: 'ro' })).rejects.toThrow(/home/i)
    expect(store).toEqual([])
  })

  it('rejects granting a folder outside home and all granted roots', async () => {
    await expect(grantService.grantRoot({ path: outside, access: 'ro' })).rejects.toThrow(/scope/i)
    expect(store).toEqual([])
  })

  it('re-granting an already granted path updates its access instead of duplicating', async () => {
    const [first] = await grantService.grantRoot({ path: join(home, 'Documents'), access: 'ro' })
    const updated = await grantService.grantRoot({ path: join(home, 'Documents'), access: 'rw' })

    expect(updated).toHaveLength(1)
    expect(updated[0]).toEqual({ ...first, access: 'rw' })
  })

  it('setGrantedRootAccess updates one root and rejects unknown ids', async () => {
    const [granted] = await grantService.grantRoot({ path: join(home, 'Documents'), access: 'ro' })

    const updated = await grantService.setGrantedRootAccess({ id: granted.id, access: 'rw' })
    expect(updated).toEqual([{ ...granted, access: 'rw' }])

    await expect(grantService.setGrantedRootAccess({ id: 'nope', access: 'rw' })).rejects.toThrow(
      /unknown granted root/i
    )
  })

  it('rejects invalid access levels from crafted payloads', async () => {
    await expect(
      grantService.grantRoot({ path: join(home, 'Documents'), access: 'admin' as never })
    ).rejects.toThrow(/access/i)
  })

  it('removeGrantedRoot drops the root and persists the shorter list', async () => {
    const [granted] = await grantService.grantRoot({ path: join(home, 'Documents'), access: 'ro' })

    await expect(grantService.removeGrantedRoot({ id: granted.id })).resolves.toEqual([])
    expect(store).toEqual([])
  })

  it('fails loudly when no granted-roots store is wired', async () => {
    await expect(new LocalFsService().listGrantedRoots()).rejects.toThrow(/not configured/i)
  })
})

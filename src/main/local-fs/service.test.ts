import type { Dirent } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// electron's app/shell are unavailable in the test runner; stub the two calls the service makes.
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/home/testuser' : '/tmp') },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }
}))

// access/readdir/realpath/stat start as delegating wrappers so tests can substitute
// per-platform fakes; every other export stays real for the listDir/preview tests above.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(actual.access),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat)
  }
})

import { access, readdir, stat } from 'node:fs/promises'

import { app } from 'electron'

import { LOCAL_DIR_ENTRY_CAP, type GrantedLocalRoot } from '../../shared/local-fs'
import { LocalFsService, type GrantedLocalRootsStore } from './service'

// The unmocked fs/promises, for restoring the delegating wrappers after each listDrives test.
const realFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

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
  afterEach(() => {
    vi.mocked(readdir).mockImplementation(realFsPromises.readdir as never)
    vi.mocked(stat).mockImplementation(realFsPromises.stat)
  })

  it('lists entries directories-first, alphabetical', async () => {
    const listing = await service.listDir(root)
    expect(listing.entries.map((e) => e.name)).toEqual(['Alpha', 'sub', 'data.csv', 'notes.md'])
    expect(listing.entries[0].isDirectory).toBe(true)
    expect(listing.entries.find((e) => e.name === 'notes.md')?.size).toBeGreaterThan(0)
  })

  it('sorts the complete readdir result before applying the entry cap', async () => {
    const fileDirents = Array.from({ length: LOCAL_DIR_ENTRY_CAP }, (_, index) => ({
      name: `file-${String(index).padStart(4, '0')}`,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }))
    const directoryDirent = {
      name: 'zzz-directory',
      isDirectory: () => true,
      isSymbolicLink: () => false
    }
    vi.mocked(readdir).mockResolvedValueOnce([...fileDirents, directoryDirent] as never)
    vi.mocked(stat).mockResolvedValue({
      isDirectory: () => false,
      size: 1,
      mtimeMs: 1
    } as never)

    const listing = await service.listDir(root)

    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(LOCAL_DIR_ENTRY_CAP)
    expect(listing.entries[0]).toMatchObject({ name: 'zzz-directory', isDirectory: true })
    expect(listing.entries.at(-1)?.name).toBe('file-4998')
    expect(listing.entries.some((entry) => entry.name === 'file-4999')).toBe(false)
  })

  it('keeps directory symlink candidates eligible before applying the entry cap', async () => {
    const fileDirents = Array.from({ length: LOCAL_DIR_ENTRY_CAP }, (_, index) => ({
      name: `file-${String(index).padStart(4, '0')}`,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }))
    const directoryLinkDirent = {
      name: 'zzz-directory-link',
      isDirectory: () => false,
      isSymbolicLink: () => true
    }
    vi.mocked(readdir).mockResolvedValueOnce([...fileDirents, directoryLinkDirent] as never)
    vi.mocked(stat).mockImplementation(
      async (path) =>
        ({
          isDirectory: () => String(path).endsWith(directoryLinkDirent.name),
          size: 1,
          mtimeMs: 1
        }) as never
    )

    const listing = await service.listDir(root)

    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(LOCAL_DIR_ENTRY_CAP)
    expect(listing.entries[0]).toMatchObject({ name: 'zzz-directory-link', isDirectory: true })
    expect(listing.entries.at(-1)?.name).toBe('file-4998')
    expect(listing.entries.some((entry) => entry.name === 'file-4999')).toBe(false)
  })

  it('stats directory entries with bounded concurrency while preserving result order', async () => {
    const dirents = Array.from({ length: 20 }, (_, index) => ({
      name: `file-${String(index).padStart(2, '0')}`,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }))
    let releaseFirstBatch!: () => void
    const firstBatch = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve
    })
    let inFlight = 0
    let maxInFlight = 0

    vi.mocked(readdir).mockResolvedValueOnce(dirents as never)
    vi.mocked(stat).mockImplementation(async (path) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await firstBatch
      inFlight -= 1
      return {
        isDirectory: () => false,
        size: Number(String(path).slice(-2)),
        mtimeMs: 1
      } as never
    })

    const pending = service.listDir(root)
    await vi.waitFor(() => expect(stat).toHaveBeenCalled())
    const startedBeforeRelease = vi.mocked(stat).mock.calls.length
    releaseFirstBatch()
    const listing = await pending

    expect(startedBeforeRelease).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(16)
    expect(listing.entries.map((entry) => entry.name)).toEqual(dirents.map((entry) => entry.name))
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

describe('LocalFsService.listDrives', () => {
  const realPlatform = process.platform
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    // Hand the delegating wrappers back so later suites see the real filesystem again.
    vi.mocked(access).mockImplementation(realFsPromises.access)
    vi.mocked(readdir).mockImplementation(realFsPromises.readdir as never)
    vi.mocked(realpath).mockImplementation(realFsPromises.realpath as never)
  })

  // Minimal Dirent stand-in: listDrives only reads name/isDirectory/isSymbolicLink.
  const dirent = (name: string, kind: 'dir' | 'link' | 'file' = 'dir'): Dirent =>
    ({
      name,
      isDirectory: () => kind === 'dir',
      isSymbolicLink: () => kind === 'link'
    }) as Dirent

  it('probes A:–Z: on win32 and keeps only the mounted letters', async () => {
    setPlatform('win32')
    vi.mocked(access).mockImplementation(async (path) => {
      if (path === 'C:\\' || path === 'E:\\') return undefined
      throw new Error('ENOENT')
    })

    await expect(service.listDrives()).resolves.toEqual([
      { path: 'C:\\', label: 'C:' },
      { path: 'E:\\', label: 'E:' }
    ])
  })

  it('lists / plus the directory entries of /Volumes on darwin', async () => {
    setPlatform('darwin')
    vi.mocked(readdir).mockImplementation((async (path: string) => {
      // The boot volume appears in /Volumes as a symlink; plain files never do.
      if (path === '/Volumes')
        return [dirent('Macintosh HD', 'link'), dirent('External'), dirent('note.txt', 'file')]
      throw new Error('ENOENT')
    }) as never)
    // The boot-volume symlink resolves to /: the root entry takes its name and the duplicate
    // /Volumes entry is dropped.
    vi.mocked(realpath).mockImplementation((async (path: string) =>
      path === '/Volumes/Macintosh HD' ? '/' : path) as never)

    await expect(service.listDrives()).resolves.toEqual([
      { path: '/', label: 'Macintosh HD' },
      { path: '/Volumes/External', label: 'External' }
    ])
  })

  it('lists / plus existing entries under the linux mount parents', async () => {
    setPlatform('linux')
    const user = userInfo().username
    vi.mocked(readdir).mockImplementation((async (path: string) => {
      if (path === `/media/${user}`) return [dirent('usb')]
      if (path === '/mnt') return [dirent('data')]
      // /run/media/<user> not existing is the common case and must contribute nothing.
      throw new Error('ENOENT')
    }) as never)

    await expect(service.listDrives()).resolves.toEqual([
      { path: '/', label: '/' },
      { path: `/media/${user}/usb`, label: 'usb' },
      { path: '/mnt/data', label: 'data' }
    ])
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

  it('grants an absolute path outside home (cross-drive granting)', async () => {
    const updated = await grantService.grantRoot({ path: outside, access: 'ro' })

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ path: outside, access: 'ro' })
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

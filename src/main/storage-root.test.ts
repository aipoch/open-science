import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MIGRATION_MARKER_FILENAME } from './storage/migration-marker'

// Unified electron mock: getPath is a vi.fn so main's override tests can assert it isn't called,
// while our data-root tests point it at a per-test temp home via mockReturnValue.
const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: false,
    getPath: vi.fn(() => '/Users/tester')
  }
}))

vi.mock('electron', () => ({ app: appMock }))

const {
  computeDefaultDataRoot,
  dataFolderName,
  dataRootForParent,
  dataRootForPicked,
  initDataRoot,
  isPathInsideOrEqual,
  resolveConfigRoot,
  resolveDataRoot,
  resolveStorageRoot,
  samePath
} = await import('./storage-root')

let homeDir: string

describe('dataFolderName', () => {
  afterEach(() => {
    appMock.isPackaged = false
  })

  it('is OpenScience when packaged', () => {
    appMock.isPackaged = true
    expect(dataFolderName()).toBe('OpenScience')
  })

  it('is OpenScience-DEV in dev (not packaged)', () => {
    appMock.isPackaged = false
    expect(dataFolderName()).toBe('OpenScience-DEV')
  })
})

describe('dataRootForParent', () => {
  it('joins the parent with the data folder name', () => {
    appMock.isPackaged = true
    expect(dataRootForParent('/mnt/data')).toBe(join('/mnt/data', 'OpenScience'))
  })
})

describe('dataRootForPicked', () => {
  const originalPlatform = process.platform
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  afterEach(() => {
    setPlatform(originalPlatform)
    appMock.isPackaged = false
  })

  it('appends the data folder name to an ordinary picked parent', () => {
    appMock.isPackaged = true
    const picked = '/mnt/data'
    // Expected is derived with the host's own resolve/join so the assertion holds on Windows too
    // (where resolve() prepends a drive letter and uses backslashes).
    expect(dataRootForPicked(picked)).toBe(join(resolve(picked), 'OpenScience'))
  })

  it('uses the picked folder as-is when it IS already the data folder (no doubling)', () => {
    // Selecting the OpenScience folder itself must not derive <picked>/OpenScience/OpenScience.
    appMock.isPackaged = true
    const picked = '/mnt/data/OpenScience'
    expect(dataRootForPicked(picked)).toBe(resolve(picked))
  })

  it('respects the dev folder name for the no-double check', () => {
    appMock.isPackaged = false
    const devFolder = '/mnt/data/OpenScience-DEV'
    expect(dataRootForPicked(devFolder)).toBe(resolve(devFolder))
    const parent = '/mnt/data'
    expect(dataRootForPicked(parent)).toBe(join(resolve(parent), 'OpenScience-DEV'))
  })

  it('matches the folder name case-insensitively on Windows (no doubling on differing case)', () => {
    // Windows filesystems are case-insensitive, so a differently-cased OpenScience folder must
    // still be recognized as the data folder rather than getting a second one appended.
    setPlatform('win32')
    appMock.isPackaged = true
    const lower = '/mnt/data/openscience'
    expect(dataRootForPicked(lower)).toBe(resolve(lower))
    const upper = '/mnt/data/OPENSCIENCE'
    expect(dataRootForPicked(upper)).toBe(resolve(upper))
  })

  it('is case-sensitive off Windows (a differently-cased folder is not the data folder)', () => {
    setPlatform('linux')
    appMock.isPackaged = true
    const lower = '/mnt/data/openscience'
    expect(dataRootForPicked(lower)).toBe(join(resolve(lower), 'OpenScience'))
  })
})

describe('samePath / isPathInsideOrEqual (platform-aware)', () => {
  const originalPlatform = process.platform
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  afterEach(() => setPlatform(originalPlatform))

  // Build paths with the host's own separator so the separator boundary in isPathInsideOrEqual
  // matches on Windows (sep = '\\') as well as POSIX; the platform mock only flips case sensitivity.
  const p = (...segs: string[]): string => segs.map((segment) => sep + segment).join('')

  it('compares case-insensitively on win32 (NTFS is case-insensitive)', () => {
    setPlatform('win32')
    expect(samePath(p('Data', 'OpenScience'), p('data', 'openscience'))).toBe(true)
    expect(isPathInsideOrEqual(p('Data'), p('data', 'OpenScience'))).toBe(true)
  })

  it('compares case-sensitively off win32', () => {
    setPlatform('linux')
    expect(samePath(p('data', 'X'), p('data', 'x'))).toBe(false)
    expect(isPathInsideOrEqual(p('data'), p('data', 'x'))).toBe(true)
    expect(isPathInsideOrEqual(p('data'), p('DATA', 'x'))).toBe(false)
  })

  it('treats a folder as inside itself, but a prefix-sharing sibling as outside', () => {
    setPlatform('linux')
    expect(isPathInsideOrEqual(p('data', 'open'), p('data', 'open'))).toBe(true)
    // "…/open-2" shares the "…/open" prefix but is a sibling, not nested — the separator boundary
    // must keep it out (a data-loss guard, not a cosmetic one).
    expect(isPathInsideOrEqual(p('data', 'open'), p('data', 'open-2'))).toBe(false)
  })
})

describe('computeDefaultDataRoot', () => {
  beforeEach(async () => {
    appMock.isPackaged = true
    homeDir = await mkdtemp(join(tmpdir(), 'ds-storage-root-home-'))
    appMock.getPath.mockReturnValue(homeDir)
  })

  afterEach(async () => {
    appMock.isPackaged = false
    await rm(homeDir, { recursive: true, force: true })
  })

  it('defaults to <home>/OpenScience for a fresh config root', () => {
    // resolveConfigRoot() resolves under homeDir but nothing has been created there.
    expect(computeDefaultDataRoot()).toBe(join(homeDir, 'OpenScience'))
  })

  it('stays at the config root when it already has legacy data and no OpenScience subdir', async () => {
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'notebooks'), { recursive: true })

    expect(computeDefaultDataRoot()).toBe(configRoot)

    await rm(configRoot, { recursive: true, force: true })
  })

  it('does not treat a config root with an OpenScience subdir as legacy', async () => {
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'artifacts'), { recursive: true })
    await mkdir(join(configRoot, 'OpenScience'), { recursive: true })

    expect(computeDefaultDataRoot()).toBe(join(homeDir, 'OpenScience'))

    await rm(configRoot, { recursive: true, force: true })
  })

  it('checks every USER-data marker dir (artifacts, notebooks, uploads)', async () => {
    for (const marker of ['artifacts', 'notebooks', 'uploads']) {
      const configRoot = resolveConfigRoot()
      await mkdir(join(configRoot, marker), { recursive: true })

      expect(computeDefaultDataRoot()).toBe(configRoot)

      await rm(configRoot, { recursive: true, force: true })
    }
  })

  it('does NOT treat a config root holding only runtime/ as legacy (runtime is rebuildable, not data)', async () => {
    // A relocated legacy install leaves runtime/ behind; it must not keep the default stuck on the
    // config root, or "return to default" would forever point at the old hidden folder.
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'runtime'), { recursive: true })

    expect(computeDefaultDataRoot()).toBe(join(homeDir, 'OpenScience'))

    await rm(configRoot, { recursive: true, force: true })
  })

  it('stays at the legacy config root when <home>/OpenScience exists but carries a migration marker', async () => {
    // A crashed/in-flight migration left a marker-bearing staging dir at homeDefault. It is NOT the
    // committed default yet, so a legacy config root with real data must still win — otherwise the
    // half-copied staging dir would split a legacy user's data across two locations.
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'artifacts'), { recursive: true })
    const homeDefault = join(homeDir, 'OpenScience')
    await mkdir(homeDefault, { recursive: true })
    await writeFile(join(homeDefault, MIGRATION_MARKER_FILENAME), '{}')

    expect(computeDefaultDataRoot()).toBe(configRoot)

    await rm(configRoot, { recursive: true, force: true })
  })

  it('prefers a marker-LESS <home>/OpenScience over a legacy config root (committed default wins)', async () => {
    // Same layout but no marker: homeDefault is a committed data folder, so it is the default and the
    // leftover legacy config-root data no longer masks it.
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'artifacts'), { recursive: true })
    await mkdir(join(homeDir, 'OpenScience'), { recursive: true })

    expect(computeDefaultDataRoot()).toBe(join(homeDir, 'OpenScience'))

    await rm(configRoot, { recursive: true, force: true })
  })
})

describe('computeDefaultDataRoot (dev mode)', () => {
  beforeEach(async () => {
    appMock.isPackaged = false
    homeDir = await mkdtemp(join(tmpdir(), 'ds-storage-root-devhome-'))
    appMock.getPath.mockReturnValue(homeDir)
  })

  afterEach(async () => {
    appMock.isPackaged = false
    await rm(homeDir, { recursive: true, force: true })
  })

  it('stays at the (dev) config root when it already has legacy data and no OpenScience-DEV subdir', async () => {
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'artifacts'), { recursive: true })

    expect(computeDefaultDataRoot()).toBe(configRoot)

    await rm(configRoot, { recursive: true, force: true })
  })

  it('defaults to <home>/OpenScience-DEV for a fresh (dev) config root', () => {
    // resolveConfigRoot() resolves under homeDir but nothing has been created there.
    expect(computeDefaultDataRoot()).toBe(join(homeDir, 'OpenScience-DEV'))
  })

  it('prefers <home>/OpenScience-DEV once it exists, even if the config root still has legacy data', async () => {
    // A relocated legacy install: leftover markers linger in the config root, but the modern data
    // folder already exists (and is in use). It must win, or isDefault/return-to-default would keep
    // pointing at the stale legacy path.
    const configRoot = resolveConfigRoot()
    await mkdir(join(configRoot, 'artifacts'), { recursive: true })
    await mkdir(join(homeDir, 'OpenScience-DEV'), { recursive: true })

    expect(computeDefaultDataRoot()).toBe(join(homeDir, 'OpenScience-DEV'))

    await rm(configRoot, { recursive: true, force: true })
  })
})

describe('resolveDataRoot / initDataRoot', () => {
  beforeEach(async () => {
    appMock.isPackaged = true
    homeDir = await mkdtemp(join(tmpdir(), 'ds-storage-root-home2-'))
    appMock.getPath.mockReturnValue(homeDir)
  })

  afterEach(async () => {
    appMock.isPackaged = false
    initDataRoot(undefined)
    await rm(homeDir, { recursive: true, force: true })
  })

  it('falls back to computeDefaultDataRoot() when settings.dataRoot is unset', () => {
    initDataRoot(undefined)
    expect(resolveDataRoot()).toBe(computeDefaultDataRoot())
  })

  it('falls back to computeDefaultDataRoot() for a blank/whitespace-only settings.dataRoot', () => {
    initDataRoot('   ')
    expect(resolveDataRoot()).toBe(computeDefaultDataRoot())
  })

  it('prefers an explicit settings.dataRoot over the computed default', () => {
    initDataRoot('/mnt/data/open-science')
    expect(resolveDataRoot()).toBe('/mnt/data/open-science')
  })

  it('resolves via computeDefaultDataRoot() before initDataRoot has ever run', async () => {
    // A fresh module instance (never initDataRoot()'d) exercises the pre-init fallback path -
    // the module-level cache from other tests in this file would otherwise mask it.
    vi.resetModules()
    const fresh = await import('./storage-root')

    expect(fresh.resolveDataRoot()).toBe(fresh.computeDefaultDataRoot())
  })
})

describe('resolveStorageRoot', () => {
  beforeEach(() => {
    appMock.isPackaged = false
    appMock.getPath.mockClear()
    appMock.getPath.mockReturnValue('/Users/tester')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the normal development directory by default', () => {
    expect(resolveStorageRoot()).toBe(join('/Users/tester', '.open-science-project'))
  })

  it('uses an absolute development preview override without changing HOME', () => {
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', '/tmp/open-science-preview/storage')

    expect(resolveStorageRoot()).toBe(normalize('/tmp/open-science-preview/storage'))
    expect(appMock.getPath).not.toHaveBeenCalled()
  })

  it('rejects an ambiguous relative preview override', () => {
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', 'preview/storage')

    expect(() => resolveStorageRoot()).toThrow('must be an absolute path')
  })

  it('ignores the preview override in packaged builds', () => {
    appMock.isPackaged = true
    vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', '/tmp/ignored')

    expect(resolveStorageRoot()).toBe(join('/Users/tester', '.open-science'))
  })
})

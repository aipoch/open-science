import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '', packaged: true }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getPath: () => state.home
  }
}))
import {
  computeDefaultDataRoot,
  dataRootForPicked,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot
} from '../storage-root'
import { SettingsDocumentStore } from '../settings/document-store'
import { SettingsRepository } from '../settings/repository'
import { initializeDataLocation } from './initialize-location'

let fixture: string
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'brand-location-'))
  state.home = fixture
  state.packaged = true
  for (const key of [
    'OPEN_SCIENCE_CONFIG_ROOT',
    'OPEN_SCIENCE_STORAGE_ROOT',
    'OPEN_SCIENCE_E2E_STORAGE_ROOT'
  ])
    vi.stubEnv(key, '')
  initDataRoot(undefined)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(fixture, { recursive: true, force: true })
})

const seed = async (root: string): Promise<void> => {
  await mkdir(join(root, 'workspaces'), { recursive: true })
  await writeFile(join(root, 'workspaces', 'history.json'), '{"session":"retained"}')
}

describe('brand location compatibility', () => {
  it('does not infer an old installation from nested empty scaffolding', async () => {
    await mkdir(join(fixture, 'OpenScience', 'uploads', 'staging', 'empty'), { recursive: true })
    expect(computeDefaultDataRoot()).toBe(join(fixture, 'Open-Science'))
  })
  it('requires recovery when only an uncommitted copy or unrecognized old content remains', async () => {
    const old = join(fixture, 'OpenScience')
    await mkdir(old)
    await writeFile(join(old, 'unknown-history.bin'), 'preserve')
    expect(() => initDataRoot(undefined)).toThrow(/location|recover/i)
    expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
  })
  it('does not adopt a staging copy even when it contains recognizable data', async () => {
    const pending = join(fixture, 'Open-Science')
    await seed(pending)
    await writeFile(join(pending, '.open-science-migration.json'), '{}')
    expect(() => initDataRoot(undefined)).toThrow(/location|recover/i)
  })
  it('pins the inferred old path before a second launch can choose a different root', async () => {
    const old = join(fixture, 'OpenScience')
    await seed(old)
    const repository = new SettingsRepository(resolveConfigRoot())
    await initializeDataLocation(repository)
    expect((await repository.getSettings()).dataRoot).toBe(old)
    await seed(join(fixture, 'Open-Science'))
    await initializeDataLocation(repository)
    expect(resolveDataRoot()).toBe(old)
  })
  it('persists and creates the fresh default, then does not recreate a missing saved root', async () => {
    const repository = new SettingsRepository(resolveConfigRoot())
    await initializeDataLocation(repository)
    const root = join(fixture, 'Open-Science')
    expect((await repository.getSettings()).dataRoot).toBe(root)
    expect((await repository.getSettings()).dataRootIsInitialDefault).toBe(true)
    expect(existsSync(root)).toBe(true)
    await rm(root, { recursive: true })
    await initializeDataLocation(repository)
    expect(existsSync(root)).toBe(false)
    expect(resolveDataRoot()).toBe(root)
  })
  it('creates a new branded default for a fresh installation', () => {
    expect(computeDefaultDataRoot()).toBe(join(fixture, 'Open-Science'))
  })
  it('isolates development defaults from packaged data', () => {
    state.packaged = false
    expect(computeDefaultDataRoot()).toBe(join(fixture, 'Open-Science-DEV'))
  })
  it('honors the explicit config root in development and packaged certification', () => {
    const config = join(fixture, 'task-config')
    vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', config)
    expect(resolveConfigRoot()).toBe(config)
    expect(computeDefaultDataRoot()).toBe(join(config, 'Open-Science'))
  })
  it('keeps a real old default and its history when the setting was never saved', async () => {
    const old = join(fixture, 'OpenScience')
    await seed(old)
    initDataRoot(undefined)
    expect(resolveDataRoot()).toBe(old)
    expect(await readFile(join(old, 'workspaces', 'history.json'), 'utf8')).toContain('retained')
    expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
  })
  it('does not decide between two populated roots without a saved choice', async () => {
    await seed(join(fixture, 'OpenScience'))
    await seed(join(fixture, 'Open-Science'))
    expect(() => initDataRoot(undefined)).toThrow(/multiple|ambiguous/i)
  })
  it('retains an explicitly selected custom path even if both defaults exist', async () => {
    await seed(join(fixture, 'OpenScience'))
    await seed(join(fixture, 'Open-Science'))
    const custom = join(fixture, 'my OpenScience experiments')
    initDataRoot(custom)
    expect(resolveDataRoot()).toBe(custom)
    expect(existsSync(custom)).toBe(false)
  })
  it('accepts a directly picked old or custom data root without appending a new name', async () => {
    const custom = join(fixture, 'Research archive')
    await seed(custom)
    const { initializeManagedWorkspaceOwnership } = await import('./managed-workspace-ownership')
    await mkdir(join(custom, 'workspaces/project'))
    await initializeManagedWorkspaceOwnership(
      join(custom, 'workspaces/project'),
      'project',
      1,
      custom
    )
    expect(dataRootForPicked(custom)).toBe(custom)
    expect(dataRootForPicked(join(fixture, 'OpenScience'))).toBe(join(fixture, 'OpenScience'))
  })
  it('does not reinterpret corrupt saved positions as fresh settings', async () => {
    const config = join(fixture, 'config')
    await mkdir(config)
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ version: 2, dataRoot: './OpenScience' })
    )
    await expect(new SettingsDocumentStore(config).read()).rejects.toThrow(
      /data.*location|dataRoot/i
    )
  })
})

it('does not create a second data root when the saved pointer file was lost', async () => {
  const custom = join(fixture, 'custom research')
  await seed(custom)
  await mkdir(resolveConfigRoot())
  await writeFile(join(resolveConfigRoot(), 'projects.db'), 'old database')
  await expect(initializeDataLocation(new SettingsRepository(resolveConfigRoot()))).rejects.toThrow(
    /location|recover/i
  )
  expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
})

it.each(['prepare', 'initialize'])(
  'requires recovery after a completed selection is lost (%s)',
  async (entry) => {
    const old = join(fixture, 'OpenScience')
    const custom = join(fixture, 'selected-research')
    await seed(old)
    await seed(custom)
    const configRoot = resolveConfigRoot()
    const profilePath = join(fixture, 'profile')
    await mkdir(profilePath)
    vi.stubEnv('OPEN_SCIENCE_USER_DATA', profilePath)
    const repository = new SettingsRepository(configRoot)
    await repository.setDataRoot({ dataRoot: custom })
    const { prepareApplicationLocations } = await import('./initialize-location')
    await prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
    const record = await readFile(join(configRoot, 'electron-profile.json'), 'utf8')
    await rm(join(configRoot, 'settings.json'))
    const launch =
      entry === 'prepare'
        ? prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
        : initializeDataLocation(new SettingsRepository(configRoot), true)
    await expect(launch).rejects.toThrow(/settings.json.*recover|recover.*settings.json/i)
    expect(existsSync(join(configRoot, 'settings.json'))).toBe(false)
    expect(await readFile(join(configRoot, 'electron-profile.json'), 'utf8')).toBe(record)
    for (const root of [old, custom]) {
      expect(await readFile(join(root, 'workspaces/history.json'), 'utf8')).toContain('retained')
    }
  }
)

it('resumes an interrupted initial profile commit at the same recorded data location', async () => {
  const root = join(fixture, 'Open-Science')
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot)
  await writeFile(
    join(configRoot, 'electron-profile.json'),
    JSON.stringify({
      version: 1,
      path: join(fixture, 'profile'),
      bootstrap: { dataRoot: root, createDataRoot: true, createProfile: true }
    })
  )
  const repository = new SettingsRepository(configRoot)
  await initializeDataLocation(repository)
  expect((await repository.getSettings()).dataRoot).toBe(root)
  expect(resolveDataRoot()).toBe(root)
})

it('blocks a missing saved data location before startup can create runtime directories', async () => {
  const configRoot = resolveConfigRoot()
  const profilePath = join(fixture, 'profile')
  await mkdir(profilePath)
  const repository = new SettingsRepository(configRoot)
  await repository.pinInitialDataRoot(join(fixture, 'removed research'), false)
  const { prepareApplicationLocations } = await import('./initialize-location')
  await expect(
    prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
  ).rejects.toThrow(/missing.*location|location.*missing/i)
  expect(existsSync(join(fixture, 'removed research'))).toBe(false)
})

it('does not pin runtime left behind after migration when settings are lost', async () => {
  const old = join(fixture, 'OpenScience')
  const custom = join(fixture, 'custom research')
  await seed(custom)
  await mkdir(join(old, 'runtime'), { recursive: true })
  await writeFile(join(old, 'runtime', 'python'), 'retained runtime')
  const repository = new SettingsRepository(resolveConfigRoot())
  await repository.setDataRoot({ dataRoot: custom, previousDataRoot: old })
  await rm(join(resolveConfigRoot(), 'settings.json'))

  await expect(initializeDataLocation(repository)).rejects.toThrow(/recover|location/i)
  expect(existsSync(join(resolveConfigRoot(), 'settings.json'))).toBe(false)
  expect(await readFile(join(custom, 'workspaces', 'history.json'), 'utf8')).toContain('retained')
  expect(await readFile(join(old, 'runtime', 'python'), 'utf8')).toBe('retained runtime')
})

it('resumes the recorded first onboarding after runtime was created', async () => {
  const root = join(fixture, 'Open-Science')
  const configRoot = resolveConfigRoot()
  const profilePath = join(fixture, 'profile')
  await mkdir(configRoot)
  await mkdir(join(root, 'runtime'), { recursive: true })
  await writeFile(join(root, 'runtime', 'python'), 'initial runtime')
  await writeFile(
    join(configRoot, 'electron-profile.json'),
    JSON.stringify({
      version: 1,
      path: profilePath,
      bootstrap: { dataRoot: root, createDataRoot: true, createProfile: true }
    })
  )
  const { prepareApplicationLocations } = await import('./initialize-location')
  const first = await prepareApplicationLocations({
    configRoot,
    profilePath,
    existingInstallation: true
  })
  expect((await first.repository.getSettings()).dataRoot).toBe(root)
  const second = await prepareApplicationLocations({
    configRoot,
    profilePath,
    existingInstallation: true
  })
  expect((await second.repository.getSettings()).dataRoot).toBe(root)
  expect(await readFile(join(root, 'runtime', 'python'), 'utf8')).toBe('initial runtime')
})

it('does not recreate a completed missing profile during location preparation', async () => {
  const configRoot = resolveConfigRoot()
  const profilePath = join(fixture, 'lost-profile')
  const dataRoot = join(fixture, 'research')
  await seed(dataRoot)
  await new SettingsRepository(configRoot).pinInitialDataRoot(dataRoot, false)
  const contents = JSON.stringify({ version: 1, path: profilePath })
  await writeFile(join(configRoot, 'electron-profile.json'), contents)
  vi.stubEnv('OPEN_SCIENCE_USER_DATA', profilePath)
  const { prepareApplicationLocations } = await import('./initialize-location')
  await expect(
    prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
  ).rejects.toThrow(/profile.*missing/i)
  expect(existsSync(profilePath)).toBe(false)
  expect(await readFile(join(configRoot, 'electron-profile.json'), 'utf8')).toBe(contents)
})

it('requires settings recovery before interpreting a source with pending migration cleanup', async () => {
  const old = join(fixture, 'OpenScience')
  const custom = join(fixture, 'custom')
  await seed(old)
  await seed(custom)
  const configRoot = resolveConfigRoot()
  const { DataRootCleanupJournal } = await import('./data-root-cleanup')
  await new DataRootCleanupJournal(configRoot).stage({
    token: 'pending',
    source: old,
    target: custom,
    dirs: ['workspaces'],
    createdAt: Date.now()
  })
  const before = await readFile(join(configRoot, 'data-root-cleanup.json'), 'utf8')
  await expect(initializeDataLocation(new SettingsRepository(configRoot))).rejects.toThrow(
    /recover|location/i
  )
  expect(existsSync(join(configRoot, 'settings.json'))).toBe(false)
  expect(await readFile(join(configRoot, 'data-root-cleanup.json'), 'utf8')).toBe(before)
})

it('preserves conflicting initial selections before creating a profile', async () => {
  const configRoot = resolveConfigRoot()
  const profilePath = join(fixture, 'not-created')
  const saved = join(fixture, 'research')
  await seed(saved)
  await new SettingsRepository(configRoot).pinInitialDataRoot(saved, false)
  const contents = JSON.stringify({
    version: 1,
    path: profilePath,
    bootstrap: { dataRoot: join(fixture, 'other'), createDataRoot: true, createProfile: true }
  })
  await writeFile(join(configRoot, 'electron-profile.json'), contents)
  const { prepareApplicationLocations } = await import('./initialize-location')
  await expect(
    prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
  ).rejects.toThrow(/data location.*differs/i)
  expect(existsSync(profilePath)).toBe(false)
  expect(await readFile(join(configRoot, 'electron-profile.json'), 'utf8')).toBe(contents)
})

it('completes an explicit different profile choice without moving research data', async () => {
  const configRoot = resolveConfigRoot()
  const profilePath = join(fixture, 'explicit-new-profile')
  const dataRoot = join(fixture, 'research')
  await seed(dataRoot)
  await new SettingsRepository(configRoot).pinInitialDataRoot(dataRoot, false)
  await writeFile(
    join(configRoot, 'electron-profile.json'),
    JSON.stringify({ version: 1, path: join(fixture, 'lost-profile') })
  )
  vi.stubEnv('OPEN_SCIENCE_USER_DATA', profilePath)
  const { prepareApplicationLocations } = await import('./initialize-location')
  const prepared = await prepareApplicationLocations({
    configRoot,
    profilePath,
    existingInstallation: true
  })
  expect((await prepared.repository.getSettings()).dataRoot).toBe(dataRoot)
  expect(existsSync(profilePath)).toBe(true)
  expect(JSON.parse(await readFile(join(configRoot, 'electron-profile.json'), 'utf8'))).toEqual({
    version: 1,
    path: profilePath
  })
  expect(await readFile(join(dataRoot, 'workspaces', 'history.json'), 'utf8')).toContain('retained')
})

it('recovers an existing settings transaction before considering leftover runtime', async () => {
  const configRoot = resolveConfigRoot()
  const custom = join(fixture, 'custom')
  await seed(custom)
  await mkdir(join(fixture, 'OpenScience', 'runtime'), { recursive: true })
  await writeFile(join(fixture, 'OpenScience', 'runtime', 'python'), 'keep runtime')
  await mkdir(configRoot)
  await writeFile(
    join(configRoot, 'settings.json.1700000000000-1.tmp'),
    JSON.stringify({ version: 2, providers: [], dataRoot: custom })
  )
  const repository = new SettingsRepository(configRoot)
  await initializeDataLocation(repository)
  expect((await repository.getSettings()).dataRoot).toBe(custom)
  expect(resolveDataRoot()).toBe(custom)
})

it('rejects an explicit profile target that is a file before overwriting the completed record', async () => {
  const configRoot = resolveConfigRoot()
  const oldProfile = join(fixture, 'old-profile')
  const profilePath = join(fixture, 'profile-file')
  const dataRoot = join(fixture, 'research')
  await seed(dataRoot)
  await mkdir(oldProfile)
  await writeFile(profilePath, 'user file')
  await new SettingsRepository(configRoot).pinInitialDataRoot(dataRoot, false)
  const contents = JSON.stringify({ version: 1, path: oldProfile })
  await writeFile(join(configRoot, 'electron-profile.json'), contents)
  vi.stubEnv('OPEN_SCIENCE_USER_DATA', profilePath)
  const { prepareApplicationLocations } = await import('./initialize-location')
  await expect(
    prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
  ).rejects.toThrow(/profile/i)
  expect(await readFile(join(configRoot, 'electron-profile.json'), 'utf8')).toBe(contents)
  expect(await readFile(profilePath, 'utf8')).toBe('user file')
})

it.each([false, true])(
  'preserves the completed profile selection when an explicit target crosses a broken link (nested=%s)',
  async (nested) => {
    const { symlink } = await import('node:fs/promises')
    const configRoot = resolveConfigRoot()
    const oldProfile = join(fixture, 'old-profile')
    const link = join(fixture, 'broken-profile-link')
    const profilePath = nested ? join(link, 'profile') : link
    const dataRoot = join(fixture, 'research')
    await seed(dataRoot)
    await mkdir(oldProfile)
    await symlink(join(fixture, 'unmounted-target'), link, 'junction')
    await new SettingsRepository(configRoot).pinInitialDataRoot(dataRoot, false)
    const contents = JSON.stringify({ version: 1, path: oldProfile })
    await writeFile(join(configRoot, 'electron-profile.json'), contents)
    vi.stubEnv('OPEN_SCIENCE_USER_DATA', profilePath)
    const { prepareApplicationLocations } = await import('./initialize-location')
    await expect(
      prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
    ).rejects.toThrow()
    expect(await readFile(join(configRoot, 'electron-profile.json'), 'utf8')).toBe(contents)
    expect(existsSync(join(fixture, 'unmounted-target'))).toBe(false)
  }
)

it('recovers the durable settings selection before examining obsolete research copies', async () => {
  const old = join(fixture, 'OpenScience')
  const custom = join(fixture, 'selected-research')
  await seed(old)
  await seed(custom)
  const configRoot = resolveConfigRoot()
  const profilePath = join(fixture, 'profile')
  await mkdir(profilePath)
  vi.stubEnv('OPEN_SCIENCE_USER_DATA', profilePath)
  const repository = new SettingsRepository(configRoot)
  await repository.setDataRoot({ dataRoot: custom })
  const { prepareApplicationLocations } = await import('./initialize-location')
  await prepareApplicationLocations({ configRoot, profilePath, existingInstallation: true })
  const saved = await readFile(join(configRoot, 'settings.json'), 'utf8')
  await rm(join(configRoot, 'settings.json'))
  await writeFile(join(configRoot, 'settings.json.1700000000000-1.tmp'), saved)
  const recovered = await prepareApplicationLocations({
    configRoot,
    profilePath,
    existingInstallation: true
  })
  expect((await recovered.repository.getSettings()).dataRoot).toBe(custom)
  expect(resolveDataRoot()).toBe(custom)
  expect(await readFile(join(old, 'workspaces/history.json'), 'utf8')).toContain('retained')
})

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

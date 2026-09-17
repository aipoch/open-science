import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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
  dataRootForPicked,
  initDataRoot,
  resolveConfigRoot,
  resolveDataRoot
} from '../storage-root'
import { SettingsDocumentStore } from '../settings/document-store'
import { SettingsRepository } from '../settings/repository'
import { SettingsPreferencesModule } from '../settings/preferences'
import { ManagedUploadResolver } from '../uploads/managed-upload-resolver'
import { getSessionUploadDir } from '../uploads/storage-helpers'
import { initializeDataLocation, prepareApplicationLocations } from './initialize-location'

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
  await expect(new SettingsDocumentStore(config).read()).rejects.toThrow(/data.*location|dataRoot/i)
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

it('keeps a saved root with linked research instead of inferring another location', async () => {
  const saved = join(fixture, 'saved')
  const external = join(fixture, 'external')
  await mkdir(saved)
  await seed(external)
  await symlink(
    join(external, 'workspaces'),
    join(saved, 'workspaces'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const repository = new SettingsRepository(resolveConfigRoot())
  await repository.setDataRoot({ dataRoot: saved })
  await initializeDataLocation(repository)
  expect(resolveDataRoot()).toBe(saved)
  expect((await repository.getSettings()).dataRoot).toBe(saved)
})

it.each([true, false])(
  'offers a default without saving it before onboarding confirmation (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = resolveConfigRoot()
    const profilePath = join(fixture, 'profile')
    const prepared = await prepareApplicationLocations(configRoot)
    expect((await prepared.repository.getSettings()).dataRoot).toBeUndefined()
    expect(resolveDataRoot()).toBe(join(fixture, packaged ? 'Open-Science' : 'Open-Science-DEV'))
    expect(existsSync(resolveDataRoot())).toBe(false)
    expect((await prepared.repository.getSettings()).onboardingCompletedAt).toBeUndefined()
    expect(existsSync(join(configRoot, 'settings.json'))).toBe(false)
    expect(existsSync(profilePath)).toBe(false)
  }
)

it.each(['OpenScience', 'Custom research'])(
  'uses existing settings for %s without changing onboarding or runtime paths',
  async (folder) => {
    const dataRoot = join(fixture, folder)
    await seed(join(fixture, 'OpenScience'))
    await seed(join(fixture, 'Open-Science'))
    await seed(dataRoot)
    const configRoot = resolveConfigRoot()
    await mkdir(configRoot)
    const document = {
      version: 2,
      providers: [],
      dataRoot,
      onboardingCompletedAt: 1234,
      pythonPath: join(dataRoot, 'runtime/python')
    }
    const contents = JSON.stringify(document)
    await writeFile(join(configRoot, 'settings.json'), contents)
    const { repository } = await prepareApplicationLocations(configRoot)
    expect((await repository.getSettings()).dataRoot).toBe(dataRoot)
    expect((await repository.getSettings()).onboardingCompletedAt).toBe(1234)
    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(contents)
    expect(await readdir(configRoot)).toEqual(['settings.json'])
    expect(await readFile(join(dataRoot, 'workspaces/history.json'), 'utf8')).toContain('retained')
  }
)

it('continues interrupted onboarding using saved settings and its existing runtime', async () => {
  const configRoot = resolveConfigRoot()
  const first = await prepareApplicationLocations(configRoot)
  const selected = join(fixture, 'selected research')
  await seed(selected)
  await mkdir(join(selected, 'runtime'))
  await writeFile(join(selected, 'runtime/python'), 'initial runtime')
  await first.repository.setDataRoot({ dataRoot: selected })
  const second = await prepareApplicationLocations(configRoot)
  expect((await second.repository.getSettings()).dataRoot).toBe(selected)
  expect((await second.repository.getSettings()).onboardingCompletedAt).toBeUndefined()
  await second.repository.markOnboardingComplete(1234, selected)
  const third = await prepareApplicationLocations(configRoot)
  expect((await third.repository.getSettings()).onboardingCompletedAt).toBe(1234)
  expect(resolveDataRoot()).toBe(selected)
  expect(await readFile(join(selected, 'runtime/python'), 'utf8')).toBe('initial runtime')
  expect(await readdir(configRoot)).toEqual(['settings.json'])
})

it('does not infer a root from research content in the configuration directory', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await seed(join(fixture, 'OpenScience'))
  await seed(join(fixture, 'Open-Science'))
  const repository = new SettingsRepository(configRoot)
  await initializeDataLocation(repository)
  expect(resolveDataRoot()).toBe(join(fixture, 'Open-Science'))
  expect((await repository.getSettings()).dataRoot).toBeUndefined()
  expect((await repository.getSettings()).onboardingCompletedAt).toBeUndefined()
})

it('does not infer a data pointer from old copies when settings is absent', async () => {
  await seed(join(fixture, 'OpenScience'))
  const repository = new SettingsRepository(resolveConfigRoot())
  await initializeDataLocation(repository)
  expect(resolveDataRoot()).toBe(join(fixture, 'Open-Science'))
  expect((await repository.getSettings()).dataRoot).toBeUndefined()
  expect((await repository.getSettings()).onboardingCompletedAt).toBeUndefined()
  expect(await readFile(join(fixture, 'OpenScience/workspaces/history.json'), 'utf8')).toContain(
    'retained'
  )
})

it.each([true, false])(
  'keeps config/data initialization isolated (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = join(fixture, 'task-config')
    vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', configRoot)
    const profilePath = join(fixture, 'task-profile')
    const { repository } = await prepareApplicationLocations(configRoot)
    expect((await repository.getSettings()).dataRoot).toBeUndefined()
    expect(resolveDataRoot()).toBe(join(configRoot, packaged ? 'Open-Science' : 'Open-Science-DEV'))
    expect(existsSync(join(fixture, '.open-science'))).toBe(false)
    expect(existsSync(join(fixture, '.open-science-project'))).toBe(false)
    expect(existsSync(profilePath)).toBe(false)
  }
)

it('blocks a missing saved data directory without recreating it', async () => {
  const configRoot = resolveConfigRoot()
  const repository = new SettingsRepository(configRoot)
  const missing = join(fixture, 'removed research')
  await repository.setDataRoot({ dataRoot: missing })
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(
    /location.*missing|missing.*location/i
  )
  expect(existsSync(missing)).toBe(false)
})

it.each(['workspaces', 'workspaces/nested'])(
  'retains manual adoption protection against linked %s',
  async (linkedPath) => {
    const old = join(fixture, 'OpenScience')
    const unrelated = join(fixture, 'unrelated')
    await mkdir(unrelated)
    await writeFile(join(unrelated, 'history.json'), 'not application data')
    await mkdir(linkedPath.includes('/') ? join(old, 'workspaces') : old, { recursive: true })
    await symlink(
      unrelated,
      join(old, linkedPath),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const { classifyDataRoot } = await import('./migration-service')
    expect(await classifyDataRoot(old, join(fixture, 'current'))).toMatchObject({ kind: 'invalid' })
    expect(await readFile(join(unrelated, 'history.json'), 'utf8')).toBe('not application data')
  }
)

it.each([true, false])(
  'reuses the saved old location in the brand E2E fixture (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = resolveConfigRoot()
    const initial = await prepareApplicationLocations(configRoot)
    await new SettingsPreferencesModule(initial.repository, () => 1234).markOnboardingComplete()
    const { prepareBrandStorageFixture } = await import('../../../e2e/fixtures/brand-storage-data')
    await prepareBrandStorageFixture(configRoot, fixture, 'legacy', packaged)
    const prepared = await prepareApplicationLocations(configRoot)
    const expected = join(configRoot, packaged ? 'OpenScience' : 'OpenScience-DEV')
    expect((await prepared.repository.getSettings()).dataRoot).toBe(expected)
    expect((await prepared.repository.getSettings()).onboardingCompletedAt).toBeUndefined()
    expect(await readFile(join(expected, 'workspaces/historical/evidence.txt'), 'utf8')).toBe(
      'Historical research data retained verbatim'
    )
  }
)

// The absent-field fixture is deliberately literal JSON, not a helper input of undefined.
it.each([true, false])(
  'reads a completed legacy JSON without dataRoot (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = resolveConfigRoot()
    const legacy = join(fixture, packaged ? 'OpenScience' : 'OpenScience-dev')
    const attachment = join(getSessionUploadDir(legacy, 'historical-session'), 'notes.txt')
    await mkdir(getSessionUploadDir(legacy, 'historical-session'), { recursive: true })
    await writeFile(attachment, 'historical attachment')
    await seed(join(fixture, packaged ? 'Open-Science' : 'Open-Science-DEV'))
    await mkdir(configRoot, { recursive: true })
    const json = '{"version":2,"providers":[],"onboardingCompletedAt":1234}'
    await writeFile(join(configRoot, 'settings.json'), json)
    const { repository } = await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(legacy)
    expect((await repository.getSettings()).dataRoot).toBeUndefined()
    const resolved = await new ManagedUploadResolver(resolveDataRoot()).resolveSessionUploadPath(
      'historical-session',
      { path: attachment }
    )
    expect(await readFile(resolved, 'utf8')).toBe('historical attachment')
    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  }
)

it.each([null, '', '   ', '\t\n'])(
  'decodes unset dataRoot %j before startup selection',
  async (dataRoot) => {
    const configRoot = resolveConfigRoot()
    await mkdir(configRoot, { recursive: true })
    await seed(join(fixture, 'OpenScience'))
    const json = JSON.stringify({ version: 2, dataRoot, onboardingCompletedAt: 0 })
    await writeFile(join(configRoot, 'settings.json'), json)
    const { repository } = await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(join(fixture, 'OpenScience'))
    expect((await repository.getSettings()).dataRoot).toBeUndefined()
    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  }
)

it.each([42, false, {}, [], 'relative/path'])(
  'preserves invalid saved dataRoot %j and stops startup',
  async (dataRoot) => {
    const configRoot = resolveConfigRoot()
    await mkdir(configRoot, { recursive: true })
    const json = JSON.stringify({ version: 2, dataRoot, onboardingCompletedAt: 1 })
    await writeFile(join(configRoot, 'settings.json'), json)
    await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(/dataRoot|data location/)
    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
    expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
  }
)

it.each([true, false])(
  'saves the confirmed default together with completion and reuses it on restart (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = join(fixture, 'isolated-config')
    vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', configRoot)
    const first = await prepareApplicationLocations(configRoot)
    const confirmed = resolveDataRoot()
    expect((await first.repository.getSettings()).dataRoot).toBeUndefined()
    const preferences = new SettingsPreferencesModule(first.repository, () => 1234)
    await preferences.markOnboardingComplete()
    expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))).toMatchObject({
      dataRoot: confirmed,
      onboardingCompletedAt: 1234
    })
    initDataRoot(undefined)
    const restarted = await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(confirmed)
    expect((await restarted.repository.getSettings()).dataRoot).toBe(confirmed)
  }
)

it('preserves malformed JSON and does not select an alternative', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot, { recursive: true })
  await writeFile(join(configRoot, 'settings.json'), '{invalid')
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(/settings.json/)
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe('{invalid')
  expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
})

it.each([null, '', '   '])(
  'keeps unset dataRoot %j unpersisted during incomplete onboarding',
  async (dataRoot) => {
    const configRoot = resolveConfigRoot()
    await mkdir(configRoot, { recursive: true })
    const json = JSON.stringify({ version: 2, dataRoot })
    await writeFile(join(configRoot, 'settings.json'), json)
    const { repository } = await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(join(fixture, 'Open-Science'))
    expect((await repository.getSettings()).dataRoot).toBeUndefined()
    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  }
)

it('reports a missing completed legacy root without creating another root', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot, { recursive: true })
  const json = '{"version":2,"onboardingCompletedAt":1234}'
  await writeFile(join(configRoot, 'settings.json'), json)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(/OpenScience.*Reconnect/)
  expect(existsSync(join(fixture, 'OpenScience'))).toBe(false)
  expect(existsSync(join(fixture, 'Open-Science'))).toBe(false)
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
})

it('preserves whitespace in a valid saved absolute path through decoding and startup', async () => {
  const selected = join(fixture, 'custom research ')
  const other = join(fixture, 'custom research')
  await seed(selected)
  await seed(other)
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({ version: 2, dataRoot: selected })
  )
  const { repository } = await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(selected)
  expect((await repository.getSettings()).dataRoot).toBe(selected)
})

it('rejects a non-absolute path with leading whitespace rather than trimming into a valid path', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot, { recursive: true })
  await seed(join(fixture, 'research'))
  const json = JSON.stringify({ version: 2, dataRoot: ` ${join(fixture, 'research')}` })
  await writeFile(join(configRoot, 'settings.json'), json)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(/dataRoot|data location/)
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
})

it('does not collapse a saved absolute path across a symlink and parent segment', async () => {
  const external = join(fixture, 'external')
  await mkdir(join(external, 'child'), { recursive: true })
  await seed(join(external, 'research'))
  await seed(join(fixture, 'research'))
  await symlink(
    join(external, 'child'),
    join(fixture, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  // Do not use path.join: it would erase the filesystem meaning of link/.. before the test starts.
  const selected = `${join(fixture, 'link')}/../research`
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({ version: 2, dataRoot: selected })
  )
  const { repository } = await prepareApplicationLocations(configRoot)
  expect((await repository.getSettings()).dataRoot).toBe(selected)
  expect(resolveDataRoot()).toBe(selected)
})

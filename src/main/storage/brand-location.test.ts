import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
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

it.each([true, false])(
  'preserves completed pre-relocation installs in config root (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = resolveConfigRoot()
    await seed(configRoot)
    const json = '{"version":2,"providers":[],"onboardingCompletedAt":1234}'
    await writeFile(join(configRoot, 'settings.json'), json)
    await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(configRoot)
    expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))).toMatchObject({
      dataRoot: configRoot,
      onboardingCompletedAt: 1234
    })
    expect(await readFile(join(configRoot, 'workspaces/history.json'), 'utf8')).toContain(
      'retained'
    )

    // A failed historical relocation can leave a partial default tree behind.
    await seed(join(fixture, packaged ? 'OpenScience' : 'OpenScience-DEV'))
    await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(configRoot)
  }
)

it('does not route completed installs back to runtime-only config leftovers', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(join(configRoot, 'runtime'), { recursive: true })
  await seed(join(fixture, 'OpenScience'))
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1234}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(join(fixture, 'OpenScience'))
})

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
    const legacy = join(fixture, packaged ? 'OpenScience' : 'OpenScience-DEV')
    const attachment = join(getSessionUploadDir(legacy, 'historical-session'), 'notes.txt')
    await mkdir(getSessionUploadDir(legacy, 'historical-session'), { recursive: true })
    await writeFile(attachment, 'historical attachment')
    await seed(join(fixture, packaged ? 'Open-Science' : 'Open-Science-DEV'))
    await mkdir(configRoot, { recursive: true })
    const json = '{"version":2,"providers":[],"onboardingCompletedAt":1234}'
    await writeFile(join(configRoot, 'settings.json'), json)
    const { repository } = await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(legacy)
    expect((await repository.getSettings()).dataRoot).toBe(legacy)
    const resolved = await new ManagedUploadResolver(resolveDataRoot()).resolveSessionUploadPath(
      'historical-session',
      { path: attachment }
    )
    expect(await readFile(resolved, 'utf8')).toBe('historical attachment')
    expect((await repository.getSettings()).onboardingCompletedAt).toBe(1234)
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
    expect((await repository.getSettings()).dataRoot).toBe(join(fixture, 'OpenScience'))
    expect((await repository.getSettings()).onboardingCompletedAt).toBe(0)
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

it.each([1, 2])(
  'preserves version %s legacy config roots for every unset pointer encoding',
  async (version) => {
    const configRoot = resolveConfigRoot()
    await seed(configRoot)
    for (const dataRoot of [undefined, null, '', '   ']) {
      const json = JSON.stringify({ version, dataRoot, onboardingCompletedAt: 0 })
      await writeFile(join(configRoot, 'settings.json'), json)
      await prepareApplicationLocations(configRoot)
      expect(resolveDataRoot()).toBe(configRoot)
      expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))).toMatchObject({
        dataRoot: configRoot,
        onboardingCompletedAt: 0
      })
    }
  }
)

it.each([true, false])(
  'resolves completed historical defaults inside isolated overrides (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = join(fixture, 'override')
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', configRoot)
    const legacy = join(configRoot, packaged ? 'OpenScience' : 'OpenScience-DEV')
    await seed(legacy)
    await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
    await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(legacy)
  }
)

it('never falls back to legacy config data when an explicit saved root is missing', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await seed(join(fixture, 'OpenScience'))
  const dataRoot = join(fixture, 'disconnected-drive', 'research')
  const json = JSON.stringify({ version: 2, dataRoot, onboardingCompletedAt: 1 })
  await writeFile(join(configRoot, 'settings.json'), json)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(/missing/)
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  expect(existsSync(dataRoot)).toBe(false)
})

it('preserves historical empty data-directory markers instead of switching locations', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(join(configRoot, 'uploads'), { recursive: true })
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(configRoot)
})

it('does not hide config-root research behind an empty nested branded folder', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await mkdir(join(configRoot, 'OpenScience'))
  const legacy = join(fixture, 'OpenScience')
  await seed(legacy)
  const json = '{"version":2,"onboardingCompletedAt":1}'
  await writeFile(join(configRoot, 'settings.json'), json)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(configRoot)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(legacy)
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  expect(await readFile(join(configRoot, 'workspaces/history.json'), 'utf8')).toContain('retained')
})

it('selects populated config-root research despite an empty nested branded folder', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await mkdir(join(configRoot, 'OpenScience'))
  await mkdir(join(fixture, 'OpenScience'))
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(configRoot)
  expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')).dataRoot).toBe(
    configRoot
  )
})

it('retains the historical nested-folder guard for empty config-root markers', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(join(configRoot, 'uploads'), { recursive: true })
  await mkdir(join(configRoot, 'OpenScience'))
  const legacy = join(fixture, 'OpenScience')
  await mkdir(legacy)
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(legacy)
})

it('pins a legacy root once and honors a later explicit relocation', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({
      version: 2,
      onboardingCompletedAt: 1234,
      localePreference: 'zh-Hans'
    })
  )
  const { repository } = await prepareApplicationLocations(configRoot)
  const pinned = await readFile(join(configRoot, 'settings.json'), 'utf8')
  await initializeDataLocation(repository)
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(pinned)
  expect((await repository.getSettings()).localePreference).toBe('zh-Hans')
  const moved = join(fixture, 'relocated')
  await seed(moved)
  await repository.setDataRoot({ dataRoot: moved, previousDataRoot: configRoot })
  await initializeDataLocation(repository)
  expect(resolveDataRoot()).toBe(moved)
  expect((await repository.getSettings()).dataRoot).toBe(moved)
})

it('does not overwrite a selection queued after startup reads legacy settings', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  const moved = join(fixture, 'selected')
  await seed(moved)
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1234}')
  const repository = new SettingsRepository(configRoot)
  const read = repository.getSettings.bind(repository)
  vi.spyOn(repository, 'getSettings').mockImplementationOnce(async () => {
    const stale = await read()
    await repository.setDataRoot({ dataRoot: moved })
    return stale
  })
  await expect(initializeDataLocation(repository)).rejects.toThrow('data location changed')
  expect((await read()).dataRoot).toBe(moved)
})

it('stops startup when persisting the verified legacy pointer fails, then retries safely', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  const json = '{"version":2,"onboardingCompletedAt":1234}'
  await writeFile(join(configRoot, 'settings.json'), json)
  const store = new SettingsDocumentStore(configRoot)
  const repository = new SettingsRepository(store)
  const failure = vi.spyOn(store, 'mutate').mockRejectedValueOnce(new Error('disk full'))
  await expect(initializeDataLocation(repository)).rejects.toThrow('disk full')
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  failure.mockRestore()
  await initializeDataLocation(repository)
  expect((await repository.getSettings()).dataRoot).toBe(configRoot)
})

it('rechecks root availability before publishing the legacy pointer', async () => {
  const configRoot = resolveConfigRoot()
  const root = join(fixture, 'OpenScience')
  await seed(root)
  await mkdir(configRoot)
  const json = '{"version":2,"onboardingCompletedAt":1234}'
  await writeFile(join(configRoot, 'settings.json'), json)
  const store = new SettingsDocumentStore(configRoot)
  const repository = new SettingsRepository(store)
  const mutate = store.mutate.bind(store)
  vi.spyOn(store, 'mutate').mockImplementationOnce(
    (update, beforePublish, preserveDocumentExcept) =>
      mutate(
        (settings) => {
          const result = update(settings)
          rmSync(root, { recursive: true })
          return result
        },
        beforePublish,
        preserveDocumentExcept
      )
  )
  await expect(initializeDataLocation(repository)).rejects.toThrow('missing')
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  expect((await readdir(configRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  await seed(root)
  await prepareApplicationLocations(configRoot)
  expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')).dataRoot).toBe(root)
})

it.each(['workspaces', 'uploads', 'models'])(
  'refuses competing historical data in %s without writing a pointer',
  async (directory) => {
    const configRoot = resolveConfigRoot()
    await seed(configRoot)
    const homeRoot = join(fixture, 'OpenScience')
    await mkdir(join(homeRoot, directory), { recursive: true })
    await writeFile(join(homeRoot, directory, 'existing-data'), 'preserve')
    const json = '{"version":2,"onboardingCompletedAt":1234}'
    await writeFile(join(configRoot, 'settings.json'), json)
    await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(configRoot)
    await expect(prepareApplicationLocations(configRoot)).rejects.toThrow(homeRoot)
    expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
  }
)

it('chooses the only populated candidate over empty historical config markers', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(join(configRoot, 'uploads'), { recursive: true })
  const homeRoot = join(fixture, 'OpenScience')
  await seed(homeRoot)
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(homeRoot)
})

it('keeps a populated lowercase development root created by 0.31', async () => {
  state.packaged = false
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot, { recursive: true })
  const homeRoot = join(fixture, 'OpenScience-dev')
  await seed(homeRoot)
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(await readFile(join(resolveDataRoot(), 'workspaces/history.json'), 'utf8')).toContain(
    'retained'
  )
})

it('treats durable symbolic links in a competing candidate as data to preserve', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  const homeRoot = join(fixture, 'OpenScience')
  await mkdir(homeRoot)
  await symlink(join(configRoot, 'workspaces'), join(homeRoot, 'uploads'), 'junction')
  const json = '{"version":2,"onboardingCompletedAt":1}'
  await writeFile(join(configRoot, 'settings.json'), json)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow('Multiple data locations')
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
})

it('does not mistake two paths to the same historical root for conflicting data', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await symlink(configRoot, join(fixture, 'OpenScience'), 'junction')
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(configRoot)
})

it('does not pin a stale legacy root after onboarding state changes', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  const json = '{"version":2,"onboardingCompletedAt":2}'
  await writeFile(join(configRoot, 'settings.json'), json)
  const repository = new SettingsRepository(configRoot)
  await expect(repository.persistLegacyDataRoot(configRoot, 1)).rejects.toThrow(
    'data location changed'
  )
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
})

it('backfills only dataRoot and preserves opaque historical configuration exactly', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  const original = {
    version: 1,
    onboardingCompletedAt: 1234,
    unknownFutureField: { secretReference: 'opaque', numbers: [1, 2] },
    pythonPath: '/historical/python',
    providers: []
  }
  await writeFile(join(configRoot, 'settings.json'), JSON.stringify(original))
  await prepareApplicationLocations(configRoot)
  expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8'))).toEqual({
    ...original,
    dataRoot: configRoot
  })
})

it.each([true, false])(
  'recovers the historical home candidate for an ordinary config override (packaged=%s)',
  async (packaged) => {
    state.packaged = packaged
    const configRoot = join(fixture, 'config-override')
    vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', configRoot)
    await mkdir(configRoot)
    const homeRoot = join(fixture, packaged ? 'OpenScience' : 'OpenScience-DEV')
    await seed(homeRoot)
    await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
    await prepareApplicationLocations(configRoot)
    expect(resolveDataRoot()).toBe(homeRoot)
  }
)

it('never inspects home data outside a dedicated E2E storage override', async () => {
  const configRoot = join(fixture, 'isolated')
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', configRoot)
  await seed(configRoot)
  await seed(join(fixture, 'OpenScience'))
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(configRoot)
})

it('retains legacy config data when a failed move left only empty default directories', async () => {
  const configRoot = resolveConfigRoot()
  await seed(configRoot)
  await mkdir(join(fixture, 'OpenScience', 'workspaces'), { recursive: true })
  await writeFile(join(configRoot, 'settings.json'), '{"version":2,"onboardingCompletedAt":1}')
  await prepareApplicationLocations(configRoot)
  expect(resolveDataRoot()).toBe(configRoot)
  expect(JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')).dataRoot).toBe(
    configRoot
  )
})

it('preserves a dangling legacy data link when the default also has research', async () => {
  const configRoot = resolveConfigRoot()
  await mkdir(configRoot)
  await symlink(
    join(fixture, 'disconnected-research'),
    join(configRoot, 'workspaces'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await seed(join(fixture, 'OpenScience'))
  const json = '{"version":2,"onboardingCompletedAt":1}'
  await writeFile(join(configRoot, 'settings.json'), json)
  await expect(prepareApplicationLocations(configRoot)).rejects.toThrow('Multiple data locations')
  expect(await readFile(join(configRoot, 'settings.json'), 'utf8')).toBe(json)
})

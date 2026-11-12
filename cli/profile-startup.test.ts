import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(actual.homedir) }
})

import { startCommand } from './index.mjs'
import { resolveBootstrapConfigRoot } from '../src/main/storage/config-root'
import { resolveElectronProfile } from '../src/main/storage/electron-profile'

const pathKeys = [
  'OPEN_SCIENCE_CONFIG_ROOT',
  'OPEN_SCIENCE_STORAGE_ROOT',
  'OPEN_SCIENCE_E2E_STORAGE_ROOT',
  'OPEN_SCIENCE_USER_DATA'
] as const
let root: string
let home: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cli-profile-startup-'))
  home = join(root, 'home with spaces')
  await mkdir(home)
  vi.mocked(homedir).mockReturnValue(home)
  for (const key of pathKeys) vi.stubEnv(key, undefined)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('OPEN_SCIENCE_INSTALLATION_STATE_ROOT', join(root, 'installation-state'))
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

// Exercise startCommand's real spawn boundary. The tiny child records only path selection inputs
// and exits deliberately; it never starts a service or reads credentials from the host machine.
const captureChildEnvironment = async (
  packaged: boolean,
  options: { configRoot?: string } = {}
): Promise<NodeJS.ProcessEnv> => {
  const entry = join(root, 'capture.cjs')
  const output = join(root, 'child-paths.json')
  await writeFile(
    entry,
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(
      Object.fromEntries(${JSON.stringify([...pathKeys, 'OPEN_SCIENCE_WEB_PORT', 'OPEN_SCIENCE_CAPTURED_LAUNCH_OUTPUT', 'ELECTRON_RUN_AS_NODE'])}
        .map(key => [key, process.env[key]])))); process.exit(23)`
  )
  await expect(
    startCommand(
      { ...options, port: 44123 },
      {
        locateBackend: async () => ({ command: process.execPath, entry, development: !packaged }),
        findServiceState: async () => undefined,
        fetch: async () => {
          throw new Error('No service should be contacted')
        },
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
        log: () => undefined,
        warn: () => undefined
      }
    )
  ).rejects.toThrow('exit code 23')
  const environment = JSON.parse(await readFile(output, 'utf8'))
  expect(environment.OPEN_SCIENCE_WEB_PORT).toBe('44123')
  expect(environment.OPEN_SCIENCE_CAPTURED_LAUNCH_OUTPUT).toBe('1')
  expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
  return environment
}

it.each([
  { packaged: true, legacy: true },
  { packaged: true, legacy: false },
  { packaged: false, legacy: true },
  { packaged: false, legacy: false }
])('keeps the desktop default profile for %j', async ({ packaged, legacy }) => {
  const appData = join(home, 'app-data')
  const profile = join(
    appData,
    `${legacy ? 'Open Science' : 'Open-Science'}${packaged ? '' : ' (DEV)'}`
  )
  await mkdir(profile, { recursive: true })
  const configRoot = resolveBootstrapConfigRoot(home, packaged, {})
  const desktopProfile = resolveElectronProfile({ appData, configRoot, packaged, env: {} })
  expect(desktopProfile).toBe(profile)

  const environment = await captureChildEnvironment(packaged)
  expect(resolveBootstrapConfigRoot(home, packaged, environment)).toBe(configRoot)
  expect(resolveElectronProfile({ appData, configRoot, packaged, env: environment })).toBe(
    desktopProfile
  )
  expect(environment.OPEN_SCIENCE_CONFIG_ROOT).toBeUndefined()
})

it.each(['flag', 'config-env', 'storage-env', 'explicit-default'] as const)(
  'preserves deliberate profile isolation via %s',
  async (source) => {
    const configRoot =
      source === 'explicit-default'
        ? resolveBootstrapConfigRoot(home, false, {})
        : join(root, 'custom config')
    if (source === 'config-env') vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', configRoot)
    if (source === 'storage-env') vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', configRoot)
    const environment = await captureChildEnvironment(
      false,
      source === 'flag' || source === 'explicit-default' ? { configRoot } : {}
    )
    expect(resolveBootstrapConfigRoot(home, false, environment)).toBe(configRoot)
    expect(
      resolveElectronProfile({ appData: home, configRoot, packaged: false, env: environment })
    ).toBe(join(configRoot, 'electron-profile'))
  }
)

it('preserves an explicit desktop profile even with a custom config root', async () => {
  const profile = join(root, 'selected profile')
  const configRoot = join(root, 'custom config')
  vi.stubEnv('OPEN_SCIENCE_USER_DATA', profile)
  const environment = await captureChildEnvironment(true, { configRoot })
  expect(
    resolveElectronProfile({ appData: home, configRoot, packaged: true, env: environment })
  ).toBe(profile)
})

import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { prepareBrandPathMigration } from './brand-path-migration'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it('requests isolated progress UI and streams diagnostics before the synchronous startup returns', () => {
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', '/isolated/fixture')
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: '{}',
    stderr: '',
    pid: 1,
    output: [],
    signal: null
  })
  prepareBrandPathMigration({
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/unused',
    commandLine: { hasSwitch: () => false },
    on: vi.fn()
  } as never)
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]
  expect(args).toContain('--show-progress-window')
  expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'inherit'] })
})

it('keeps headless startup terminal-only while still streaming migration diagnostics', () => {
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', '/isolated/fixture')
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: '{}',
    stderr: '',
    pid: 1,
    output: [],
    signal: null
  })
  prepareBrandPathMigration({
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/unused',
    commandLine: { hasSwitch: (name: string) => name === 'open-science-headless' },
    on: vi.fn()
  } as never)
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]
  expect(args).not.toContain('--show-progress-window')
  expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'inherit'] })
})

it('returns a fixture-owned log directory instead of the real macOS application logs', () => {
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', '/isolated/fixture')
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: '{}',
    stderr: '',
    pid: 1,
    output: [],
    signal: null
  })
  const paths = prepareBrandPathMigration({
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/real/user/profile',
    commandLine: { hasSwitch: () => false },
    on: vi.fn()
  } as never)
  expect(paths.logs).toBe('/isolated/fixture/electron-logs')
})

it('leaves ordinary application log locations unchanged for a custom storage root', () => {
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', '')
  vi.stubEnv('OPEN_SCIENCE_STORAGE_ROOT', '/custom/storage')
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: '{}',
    stderr: '',
    pid: 1,
    output: [],
    signal: null
  })
  expect(
    prepareBrandPathMigration({
      isPackaged: false,
      getAppPath: () => '/app',
      getPath: () => '/real/user/profile',
      commandLine: { hasSwitch: () => false },
      on: vi.fn()
    } as never).logs
  ).toBeUndefined()
})

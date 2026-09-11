import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { prepareBrandPathMigration } from './brand-path-migration'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.skipIf(process.platform !== 'darwin')(
  'keeps the blocked owner out of the Dock until migration succeeds',
  () => {
    const policies: string[] = []
    let showOnReady: (() => void) | undefined
    vi.mocked(spawnSync).mockImplementation(() => {
      expect(policies).toEqual(['accessory'])
      return { status: 0, stdout: '{}' } as never
    })
    prepareBrandPathMigration({
      isPackaged: false,
      getAppPath: () => '/app',
      getPath: () => '/unused',
      commandLine: { hasSwitch: () => false },
      setActivationPolicy: (value: string) => policies.push(value),
      once: (event: string, callback: () => void) => {
        if (event === 'ready') showOnReady = callback
      },
      on: vi.fn()
    } as never)
    expect(policies).toEqual(['accessory'])
    expect(showOnReady).toBeTypeOf('function')
    showOnReady!()
    expect(policies).toEqual(['accessory', 'regular'])
  }
)

it.skipIf(process.platform !== 'darwin')(
  'does not restore the blocked owner Dock icon after migration failure',
  () => {
    const policies: string[] = []
    const once = vi.fn()
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stderr: 'copy failed' } as never)
    expect(() =>
      prepareBrandPathMigration({
        isPackaged: false,
        getAppPath: () => '/app',
        getPath: () => '/unused',
        commandLine: { hasSwitch: () => false },
        setActivationPolicy: (value: string) => policies.push(value),
        once,
        on: vi.fn()
      } as never)
    ).toThrow('copy failed')
    expect(policies).toEqual(['accessory'])
    expect(once).not.toHaveBeenCalled()
  }
)

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
    setActivationPolicy: vi.fn(),
    once: vi.fn(),
    on: vi.fn()
  } as never)
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]
  expect(args).toContain('--show-progress-window')
  expect(args).toContain('--fresh-dev-migration')
  expect(options).toMatchObject({ stdio: ['ignore', 'pipe', 'inherit'] })
})

it('does not discard preparing snapshots during packaged startup', () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '{}', stderr: '' } as never)
  prepareBrandPathMigration({
    isPackaged: true,
    getAppPath: () => '/app',
    getPath: () => '/unused',
    commandLine: { hasSwitch: () => false },
    setActivationPolicy: vi.fn(),
    once: vi.fn(),
    on: vi.fn()
  } as never)
  expect(vi.mocked(spawnSync).mock.calls[0][1]).not.toContain('--fresh-dev-migration')
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
    setActivationPolicy: vi.fn(),
    once: vi.fn(),
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
    setActivationPolicy: vi.fn(),
    once: vi.fn(),
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
      setActivationPolicy: vi.fn(),
      once: vi.fn(),
      on: vi.fn()
    } as never).logs
  ).toBeUndefined()
})

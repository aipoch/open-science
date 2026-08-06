import type { StoreApi } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  ClaudeInstallEvent,
  ClaudeInstallResult,
  Preflight,
  SettingsSnapshot
} from '../../../shared/settings'
import {
  createRuntimeSetupSlice,
  type RuntimeSetupSlice,
  selectAnyInstalling
} from './settings-runtime-slice'

type RuntimeCommands = Pick<
  Window['api']['settings'],
  | 'getSettings'
  | 'installClaude'
  | 'installOpencode'
  | 'installCodex'
  | 'uninstallClaude'
  | 'uninstallOpencode'
  | 'uninstallCodex'
  | 'onInstallLog'
>

type RuntimeCommandMocks = {
  [Command in keyof RuntimeCommands]: Mock<RuntimeCommands[Command]>
}

type TestStore = RuntimeSetupSlice & {
  refreshPreflight: () => Promise<Preflight>
}

const snapshot = (): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light'
})

const preflight = (): Preflight => ({
  claudeReady: false,
  opencodeReady: false,
  codexReady: false,
  agentFrameworkId: 'claude-code',
  agentReady: false,
  activeProviderReady: false
})

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const createCommands = (): RuntimeCommandMocks => ({
  getSettings: vi.fn().mockResolvedValue(snapshot()),
  installClaude: vi.fn().mockResolvedValue({ installId: 'claude-1', ok: true }),
  installOpencode: vi.fn().mockResolvedValue({ installId: 'opencode-1', ok: true }),
  installCodex: vi.fn().mockResolvedValue({ installId: 'codex-1', ok: true }),
  uninstallClaude: vi.fn().mockResolvedValue(snapshot()),
  uninstallOpencode: vi.fn().mockResolvedValue(snapshot()),
  uninstallCodex: vi.fn().mockResolvedValue(snapshot()),
  onInstallLog: vi.fn().mockReturnValue(vi.fn())
})

describe('runtime setup slice: install lifecycle', () => {
  let commands: ReturnType<typeof createCommands>
  let refreshPreflight: Mock<() => Promise<Preflight>>
  let reconcileSnapshot: Mock<(snapshot: SettingsSnapshot) => void>
  let store: StoreApi<TestStore>

  beforeEach(() => {
    commands = createCommands()
    refreshPreflight = vi.fn<() => Promise<Preflight>>().mockResolvedValue(preflight())
    reconcileSnapshot = vi.fn<(snapshot: SettingsSnapshot) => void>()
    store = createStore<TestStore>((set, get) => ({
      refreshPreflight,
      ...createRuntimeSetupSlice({
        set,
        get,
        commands: commands as RuntimeCommands,
        reconcileSnapshot
      })
    }))
  })

  it('subscribes before invoking and attributes the shared event stream to one runtime', async () => {
    const calls: string[] = []
    const install = deferred<ClaudeInstallResult>()
    const unsubscribe = vi.fn(() => calls.push('unsubscribe'))
    let emit: (event: ClaudeInstallEvent) => void = () => undefined

    commands.onInstallLog.mockImplementation((listener) => {
      calls.push('subscribe')
      emit = listener
      return unsubscribe
    })
    commands.installCodex.mockImplementation(() => {
      calls.push('invoke')
      return install.promise
    })

    const pending = store.getState().installCodex()
    expect(calls).toEqual(['subscribe', 'invoke'])

    emit({ kind: 'progress', installId: 'codex-1', phase: 'installing' })
    emit({ kind: 'log', installId: 'codex-1', stream: 'stdout', chunk: 'downloaded\n' })

    expect(store.getState().installStates.codex).toMatchObject({
      isInstalling: true,
      installLogs: ['downloaded\n'],
      installProgress: { kind: 'progress', installId: 'codex-1', phase: 'installing' }
    })
    expect(store.getState().installStates.opencode.installLogs).toEqual([])
    expect(store.getState().installStates['claude-code'].installProgress).toBeNull()

    install.resolve({ installId: 'codex-1', ok: true })
    await pending

    expect(commands.onInstallLog).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledWith(snapshot())
    expect(refreshPreflight).toHaveBeenCalledOnce()
    expect(store.getState().installStates.codex).toMatchObject({
      isInstalling: false,
      installProgress: null,
      installError: undefined
    })
  })

  it('keeps the global guard while logs are cleared and silently refuses a second install', async () => {
    const install = deferred<ClaudeInstallResult>()
    commands.installClaude.mockReturnValue(install.promise)

    const first = store.getState().installClaude('managed')
    expect(selectAnyInstalling(store.getState())).toBe(true)

    store.setState((state) => ({
      installStates: {
        ...state.installStates,
        'claude-code': {
          ...state.installStates['claude-code'],
          installLogs: ['line'],
          installError: 'stale'
        },
        opencode: { ...state.installStates.opencode, installLogs: ['other line'] },
        codex: { ...state.installStates.codex, installError: 'other stale error' }
      }
    }))
    store.getState().clearInstallLogs()

    const blocked = await store.getState().installCodex()
    expect(blocked).toEqual({
      installId: '',
      ok: false,
      error: 'Another install is already in progress.'
    })
    expect(commands.installCodex).not.toHaveBeenCalled()
    expect(commands.onInstallLog).toHaveBeenCalledOnce()
    expect(store.getState().installStates['claude-code']).toMatchObject({
      isInstalling: true,
      installLogs: [],
      installProgress: null,
      installError: undefined
    })
    expect(store.getState().installStates.codex.installError).toBeUndefined()
    expect(store.getState().installStates.opencode.installLogs).toEqual([])

    install.resolve({ installId: 'claude-1', ok: true })
    await first
  })

  it('records an invoked error, unsubscribes, and rethrows it', async () => {
    const failure = new Error('installer unavailable')
    const unsubscribe = vi.fn()
    commands.onInstallLog.mockReturnValue(unsubscribe)
    commands.installOpencode.mockRejectedValue(failure)

    await expect(store.getState().installOpencode()).rejects.toBe(failure)

    expect(commands.getSettings).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(store.getState().installStates.opencode).toMatchObject({
      isInstalling: false,
      installProgress: null,
      installError: 'installer unavailable'
    })
  })

  it('settles a non-ok result with its own error and still performs best-effort reconciliation', async () => {
    commands.installCodex.mockResolvedValue({ installId: 'codex-1', ok: false })

    await expect(store.getState().installCodex()).resolves.toEqual({
      installId: 'codex-1',
      ok: false
    })

    expect(store.getState().installStates.codex).toMatchObject({
      isInstalling: false,
      installError: 'Install failed.'
    })
    expect(reconcileSnapshot).toHaveBeenCalledOnce()
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it.each(['snapshot', 'preflight'] as const)(
    'does not relabel a successful install when %s reconciliation fails',
    async (failurePoint) => {
      if (failurePoint === 'snapshot') {
        commands.getSettings.mockRejectedValue(new Error('snapshot unavailable'))
      } else {
        refreshPreflight.mockRejectedValue(new Error('preflight unavailable'))
      }

      await expect(store.getState().installCodex()).resolves.toEqual({
        installId: 'codex-1',
        ok: true
      })

      expect(store.getState().installStates.codex).toMatchObject({
        isInstalling: false,
        installProgress: null,
        installError: undefined
      })
      expect(commands.onInstallLog).toHaveBeenCalledOnce()
      expect(commands.onInstallLog.mock.results[0]?.value).toHaveBeenCalledOnce()
    }
  )
})

describe('runtime setup slice: uninstall lifecycle', () => {
  it.each([
    ['uninstallClaude', 'uninstallClaude'],
    ['uninstallOpencode', 'uninstallOpencode'],
    ['uninstallCodex', 'uninstallCodex']
  ] as const)('reconciles and refreshes after %s', async (action, command) => {
    const commands = createCommands()
    const refreshPreflight = vi.fn().mockResolvedValue(preflight())
    const reconcileSnapshot = vi.fn()
    const store = createStore<TestStore>((set, get) => ({
      refreshPreflight,
      ...createRuntimeSetupSlice({
        set,
        get,
        commands: commands as RuntimeCommands,
        reconcileSnapshot
      })
    }))

    await store.getState()[action]()

    expect(commands[command]).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledWith(snapshot())
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it('propagates an uninstall error without reconciling stale state', async () => {
    const commands = createCommands()
    const failure = new Error('uninstall rejected')
    commands.uninstallCodex.mockRejectedValue(failure)
    const refreshPreflight = vi.fn().mockResolvedValue(preflight())
    const reconcileSnapshot = vi.fn()
    const store = createStore<TestStore>((set, get) => ({
      refreshPreflight,
      ...createRuntimeSetupSlice({
        set,
        get,
        commands: commands as RuntimeCommands,
        reconcileSnapshot
      })
    }))

    await expect(store.getState().uninstallCodex()).rejects.toBe(failure)
    expect(reconcileSnapshot).not.toHaveBeenCalled()
    expect(refreshPreflight).not.toHaveBeenCalled()
  })

  it('propagates a post-uninstall preflight failure after applying the returned snapshot', async () => {
    const commands = createCommands()
    const failure = new Error('preflight unavailable')
    const refreshPreflight = vi.fn<() => Promise<Preflight>>().mockRejectedValue(failure)
    const reconcileSnapshot = vi.fn<(snapshot: SettingsSnapshot) => void>()
    const store = createStore<TestStore>((set, get) => ({
      refreshPreflight,
      ...createRuntimeSetupSlice({
        set,
        get,
        commands: commands as RuntimeCommands,
        reconcileSnapshot
      })
    }))

    await expect(store.getState().uninstallClaude()).rejects.toBe(failure)
    expect(reconcileSnapshot).toHaveBeenCalledWith(snapshot())
  })
})

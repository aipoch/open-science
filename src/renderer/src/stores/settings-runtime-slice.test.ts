import type { StoreApi } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type {
  AgentFrameworkId,
  ClaudeDetectResult,
  ClaudeInfo,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  EnvironmentCheckResult,
  Preflight,
  SettingsSnapshot
} from '../../../shared/settings'
import {
  createRuntimeSetupLoadPatch,
  createRuntimeSetupSlice,
  INSTALL_UI_LOG_CHAR_LIMIT,
  type RuntimeSetupSlice,
  selectAnyInstalling
} from './settings-runtime-slice'

type RuntimeCommands = Pick<
  Window['api']['settings'],
  | 'getSettings'
  | 'getPreflight'
  | 'isNpmAvailable'
  | 'checkEnvironment'
  | 'detectClaude'
  | 'detectOpencode'
  | 'detectCodex'
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
  agentFrameworkId: AgentFrameworkId
  claude: ClaudeInfo
}

type EnvironmentReconcilePatch = Partial<
  Pick<RuntimeSetupSlice, 'environmentCheck' | 'preflight' | 'npmAvailable'>
>

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

const environment = (
  agentFrameworkId: AgentFrameworkId = 'claude-code',
  checkedAt = 1
): EnvironmentCheckResult => ({
  checkedAt,
  platform: 'darwin',
  architecture: 'arm64',
  checks: [],
  ready: true,
  canAutoInstall: false,
  agentFrameworkId,
  runtime: { found: true, path: `/bin/${agentFrameworkId}` }
})

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const createCommands = (): RuntimeCommandMocks => ({
  getSettings: vi.fn().mockResolvedValue(snapshot()),
  getPreflight: vi.fn().mockResolvedValue(preflight()),
  isNpmAvailable: vi.fn().mockResolvedValue(true),
  checkEnvironment: vi.fn().mockResolvedValue(environment()),
  detectClaude: vi.fn().mockResolvedValue({ found: true, path: '/bin/claude', version: '1.0.0' }),
  detectOpencode: vi.fn().mockResolvedValue(snapshot()),
  detectCodex: vi.fn().mockResolvedValue(snapshot()),
  installClaude: vi.fn().mockResolvedValue({ installId: 'claude-1', ok: true }),
  installOpencode: vi.fn().mockResolvedValue({ installId: 'opencode-1', ok: true }),
  installCodex: vi.fn().mockResolvedValue({ installId: 'codex-1', ok: true }),
  uninstallClaude: vi.fn().mockResolvedValue(snapshot()),
  uninstallOpencode: vi.fn().mockResolvedValue(snapshot()),
  uninstallCodex: vi.fn().mockResolvedValue(snapshot()),
  onInstallLog: vi.fn().mockReturnValue(vi.fn())
})

const createHarness = (): {
  commands: RuntimeCommandMocks
  reconcileSnapshot: Mock<
    (snapshot: SettingsSnapshot, runtimePatch?: EnvironmentReconcilePatch) => void
  >
  reconcileClaudeDetection: Mock<(result: ClaudeDetectResult, npmAvailable: boolean) => void>
  store: StoreApi<TestStore>
} => {
  const commands = createCommands()
  const reconcileSnapshot = vi.fn(
    (nextSnapshot: SettingsSnapshot, runtimePatch: EnvironmentReconcilePatch = {}) => {
      store.setState({ agentFrameworkId: nextSnapshot.agentFrameworkId, ...runtimePatch })
    }
  )
  const reconcileClaudeDetection = vi.fn((result: ClaudeDetectResult, npmAvailable: boolean) => {
    store.setState(
      result.found && result.path
        ? { npmAvailable, claude: { resolvedPath: result.path, version: result.version } }
        : { npmAvailable }
    )
  })

  const store = createStore<TestStore>((set, get) => ({
    agentFrameworkId: 'claude-code',
    claude: {},
    ...createRuntimeSetupSlice({
      set,
      get,
      getCommands: () => commands as RuntimeCommands,
      reconcileSnapshot,
      reconcileClaudeDetection
    })
  }))

  return { commands, reconcileSnapshot, reconcileClaudeDetection, store }
}

describe('runtime setup slice: install lifecycle', () => {
  let commands: ReturnType<typeof createCommands>
  let refreshPreflight: Mock<() => Promise<Preflight>>
  let reconcileSnapshot: ReturnType<typeof createHarness>['reconcileSnapshot']
  let store: StoreApi<TestStore>

  beforeEach(() => {
    const harness = createHarness()
    commands = harness.commands
    reconcileSnapshot = harness.reconcileSnapshot
    store = harness.store
    refreshPreflight = vi.fn<() => Promise<Preflight>>().mockResolvedValue(preflight())
    store.setState({ refreshPreflight })
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

  it('commits a 10,000-chunk log burst in two store updates and keeps the tail', async () => {
    const install = deferred<ClaudeInstallResult>()
    let emit: (event: ClaudeInstallEvent) => void = () => undefined
    commands.onInstallLog.mockImplementation((listener) => {
      emit = listener
      return vi.fn()
    })
    commands.installCodex.mockReturnValue(install.promise)

    const pending = store.getState().installCodex()
    let logCommits = 0
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.installStates.codex.installLogs !== previous.installStates.codex.installLogs) {
        logCommits += 1
      }
    })

    for (let index = 0; index < 10_000; index += 1) {
      emit({ kind: 'log', installId: 'codex-1', stream: 'stdout', chunk: 'x' })
    }

    expect(logCommits).toBe(1)
    expect(store.getState().installStates.codex.installLogs).toEqual(['x'])

    await Promise.resolve()

    expect(logCommits).toBe(2)
    expect(store.getState().installStates.codex.installLogs).toEqual(['x'.repeat(10_000)])

    unsubscribe()
    install.resolve({ installId: 'codex-1', ok: true })
    await pending
  })

  it('keeps only the last 256 KiB of install log text', async () => {
    const install = deferred<ClaudeInstallResult>()
    let emit: (event: ClaudeInstallEvent) => void = () => undefined
    commands.onInstallLog.mockImplementation((listener) => {
      emit = listener
      return vi.fn()
    })
    commands.installCodex.mockReturnValue(install.promise)

    const pending = store.getState().installCodex()
    emit({
      kind: 'log',
      installId: 'codex-1',
      stream: 'stdout',
      chunk: `head${'t'.repeat(INSTALL_UI_LOG_CHAR_LIMIT)}`
    })

    expect(store.getState().installStates.codex.installLogs).toEqual([
      't'.repeat(INSTALL_UI_LOG_CHAR_LIMIT)
    ])

    install.resolve({ installId: 'codex-1', ok: true })
    await pending
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

describe('runtime setup slice: discovery lifecycle', () => {
  let commands: RuntimeCommandMocks
  let reconcileSnapshot: ReturnType<typeof createHarness>['reconcileSnapshot']
  let reconcileClaudeDetection: ReturnType<typeof createHarness>['reconcileClaudeDetection']
  let store: StoreApi<TestStore>

  beforeEach(() => {
    const harness = createHarness()
    commands = harness.commands
    reconcileSnapshot = harness.reconcileSnapshot
    reconcileClaudeDetection = harness.reconcileClaudeDetection
    store = harness.store
  })

  it('creates the runtime-owned startup hydration patch without resetting transient state', () => {
    const ready = { ...preflight(), claudeReady: true }
    expect(createRuntimeSetupLoadPatch(ready, false)).toEqual({
      preflight: ready,
      npmAvailable: false
    })
  })

  it('refreshes preflight and propagates a failed refresh without replacing the cached value', async () => {
    const ready = { ...preflight(), claudeReady: true }
    commands.getPreflight.mockResolvedValueOnce(ready)

    await expect(store.getState().refreshPreflight()).resolves.toBe(ready)
    expect(store.getState().preflight).toBe(ready)

    const failure = new Error('preflight unavailable')
    commands.getPreflight.mockRejectedValueOnce(failure)
    await expect(store.getState().refreshPreflight()).rejects.toBe(failure)
    expect(store.getState().preflight).toBe(ready)
  })

  it('returns the cached environment value instead of reusing an in-flight Promise', async () => {
    const cached = environment('opencode', 10)
    const probe = deferred<EnvironmentCheckResult>()
    store.setState({ agentFrameworkId: 'opencode', environmentCheck: cached })
    commands.checkEnvironment.mockReturnValue(probe.promise)
    commands.getSettings.mockResolvedValue({ ...snapshot(), agentFrameworkId: 'opencode' })

    const first = store.getState().checkEnvironment()
    const duplicate = store.getState().checkEnvironment()

    expect(duplicate).not.toBe(first)
    await expect(duplicate).resolves.toBe(cached)
    expect(commands.checkEnvironment).toHaveBeenCalledOnce()
    expect(store.getState()).toMatchObject({
      isCheckingEnvironment: true,
      checkingFramework: 'opencode',
      isDetectingClaude: true
    })

    probe.resolve(environment('opencode', 20))
    await first
    expect(commands.getSettings).toHaveBeenCalledOnce()
    expect(commands.getPreflight).toHaveBeenCalledOnce()
    expect(commands.isNpmAvailable).toHaveBeenCalledOnce()
  })

  it('fences an ABA late success after all stale post-probe reads have completed', async () => {
    const probes = [
      deferred<EnvironmentCheckResult>(),
      deferred<EnvironmentCheckResult>(),
      deferred<EnvironmentCheckResult>()
    ]
    commands.checkEnvironment
      .mockReturnValueOnce(probes[0].promise)
      .mockReturnValueOnce(probes[1].promise)
      .mockReturnValueOnce(probes[2].promise)

    const first = store.getState().checkEnvironment()
    store.setState({ agentFrameworkId: 'opencode' })
    const second = store.getState().checkEnvironment()
    store.setState({ agentFrameworkId: 'claude-code' })
    const third = store.getState().checkEnvironment()
    expect(commands.checkEnvironment).toHaveBeenCalledTimes(3)

    probes[2].resolve(environment('claude-code', 30))
    await third
    expect(store.getState().environmentCheck?.checkedAt).toBe(30)
    expect(reconcileSnapshot).toHaveBeenCalledTimes(1)

    probes[0].resolve(environment('claude-code', 10))
    await first
    probes[1].resolve(environment('opencode', 20))
    await second

    expect(commands.getSettings).toHaveBeenCalledTimes(3)
    expect(commands.getPreflight).toHaveBeenCalledTimes(3)
    expect(commands.isNpmAvailable).toHaveBeenCalledTimes(3)
    expect(reconcileSnapshot).toHaveBeenCalledTimes(1)
    expect(store.getState()).toMatchObject({
      envCheckGeneration: 3,
      environmentCheck: { checkedAt: 30, agentFrameworkId: 'claude-code' },
      environmentCheckError: undefined,
      isCheckingEnvironment: false,
      checkingFramework: undefined,
      isDetectingClaude: false
    })
  })

  it('keeps a newer ABA pass loading when the stale same-framework pass rejects', async () => {
    const probes = [
      deferred<EnvironmentCheckResult>(),
      deferred<EnvironmentCheckResult>(),
      deferred<EnvironmentCheckResult>()
    ]
    commands.checkEnvironment
      .mockReturnValueOnce(probes[0].promise)
      .mockReturnValueOnce(probes[1].promise)
      .mockReturnValueOnce(probes[2].promise)

    const first = store.getState().checkEnvironment()
    store.setState({ agentFrameworkId: 'opencode' })
    const second = store.getState().checkEnvironment()
    store.setState({ agentFrameworkId: 'claude-code' })
    const third = store.getState().checkEnvironment()

    probes[0].reject(new Error('stale Claude failed'))
    await first
    expect(store.getState()).toMatchObject({
      isCheckingEnvironment: true,
      isDetectingClaude: true,
      environmentCheckError: undefined
    })

    probes[2].resolve(environment('claude-code', 30))
    await third
    probes[1].resolve(environment('opencode', 20))
    await second

    expect(store.getState()).toMatchObject({
      environmentCheck: { checkedAt: 30 },
      environmentCheckError: undefined,
      isCheckingEnvironment: false,
      isDetectingClaude: false
    })
  })

  it('surfaces a current environment failure and always clears its loading ownership', async () => {
    commands.checkEnvironment.mockRejectedValue(new Error('environment IPC unavailable'))

    await expect(store.getState().checkEnvironment()).resolves.toBeUndefined()

    expect(store.getState()).toMatchObject({
      isCheckingEnvironment: false,
      checkingFramework: undefined,
      isDetectingClaude: false,
      environmentCheckError: 'environment IPC unavailable'
    })
    expect(reconcileSnapshot).not.toHaveBeenCalled()
  })

  it('does every post-probe read but rejects a result for the no-longer-selected framework', async () => {
    const probe = deferred<EnvironmentCheckResult>()
    commands.checkEnvironment.mockReturnValue(probe.promise)

    const pending = store.getState().checkEnvironment()
    store.setState({ agentFrameworkId: 'opencode' })
    probe.resolve(environment('claude-code'))

    await expect(pending).resolves.toEqual(environment('claude-code'))
    expect(commands.getSettings).toHaveBeenCalledOnce()
    expect(commands.getPreflight).toHaveBeenCalledOnce()
    expect(commands.isNpmAvailable).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).not.toHaveBeenCalled()
    expect(store.getState().isCheckingEnvironment).toBe(false)
  })

  it('reconciles Claude and npm, refreshes preflight, and keeps the old Claude on not-found', async () => {
    await store.getState().detectClaude()

    expect(reconcileClaudeDetection).toHaveBeenCalledWith(
      { found: true, path: '/bin/claude', version: '1.0.0' },
      true
    )
    expect(store.getState()).toMatchObject({
      claude: { resolvedPath: '/bin/claude', version: '1.0.0' },
      npmAvailable: true,
      isDetectingClaude: false
    })
    expect(commands.getPreflight).toHaveBeenCalledOnce()

    commands.detectClaude.mockResolvedValueOnce({ found: false })
    commands.isNpmAvailable.mockResolvedValueOnce(false)
    await store.getState().detectClaude()

    expect(store.getState()).toMatchObject({
      claude: { resolvedPath: '/bin/claude', version: '1.0.0' },
      npmAvailable: false,
      isDetectingClaude: false
    })
  })

  it('propagates Claude preflight failure after applying detection and clears the flag', async () => {
    const failure = new Error('preflight unavailable')
    commands.getPreflight.mockRejectedValue(failure)

    await expect(store.getState().detectClaude()).rejects.toBe(failure)

    expect(store.getState()).toMatchObject({
      claude: { resolvedPath: '/bin/claude' },
      isDetectingClaude: false
    })
  })

  it.each([
    ['detectOpencode', 'isDetectingOpencode'],
    ['detectCodex', 'isDetectingCodex']
  ] as const)('reconciles the snapshot and clears the flag after %s', async (action, flag) => {
    await store.getState()[action]()

    expect(commands[action]).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledWith(snapshot())
    expect(store.getState()[flag]).toBe(false)
    expect(commands.getPreflight).not.toHaveBeenCalled()
  })

  it.each([
    ['detectOpencode', 'isDetectingOpencode'],
    ['detectCodex', 'isDetectingCodex']
  ] as const)('propagates %s failure and still clears its flag', async (action, flag) => {
    const failure = new Error(`${action} unavailable`)
    commands[action].mockRejectedValue(failure)

    await expect(store.getState()[action]()).rejects.toBe(failure)
    expect(store.getState()[flag]).toBe(false)
    expect(reconcileSnapshot).not.toHaveBeenCalled()
  })
})

describe('runtime setup slice: uninstall lifecycle', () => {
  it.each([
    ['uninstallClaude', 'uninstallClaude'],
    ['uninstallOpencode', 'uninstallOpencode'],
    ['uninstallCodex', 'uninstallCodex']
  ] as const)('reconciles and refreshes after %s', async (action, command) => {
    const { commands, reconcileSnapshot, store } = createHarness()
    const refreshPreflight = vi.fn().mockResolvedValue(preflight())
    store.setState({ refreshPreflight })

    await store.getState()[action]()

    expect(commands[command]).toHaveBeenCalledOnce()
    expect(reconcileSnapshot).toHaveBeenCalledWith(snapshot())
    expect(refreshPreflight).toHaveBeenCalledOnce()
  })

  it('propagates an uninstall error without reconciling stale state', async () => {
    const { commands, reconcileSnapshot, store } = createHarness()
    const failure = new Error('uninstall rejected')
    commands.uninstallCodex.mockRejectedValue(failure)
    const refreshPreflight = vi.fn().mockResolvedValue(preflight())
    store.setState({ refreshPreflight })

    await expect(store.getState().uninstallCodex()).rejects.toBe(failure)
    expect(reconcileSnapshot).not.toHaveBeenCalled()
    expect(refreshPreflight).not.toHaveBeenCalled()
  })

  it('propagates a post-uninstall preflight failure after applying the returned snapshot', async () => {
    const { reconcileSnapshot, store } = createHarness()
    const failure = new Error('preflight unavailable')
    const refreshPreflight = vi.fn<() => Promise<Preflight>>().mockRejectedValue(failure)
    store.setState({ refreshPreflight })

    await expect(store.getState().uninstallClaude()).rejects.toBe(failure)
    expect(reconcileSnapshot).toHaveBeenCalledWith(snapshot())
  })
})

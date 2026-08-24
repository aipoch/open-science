import type { StoreApi } from 'zustand'

import type {
  AgentFrameworkId,
  ClaudeDetectResult,
  ClaudeInstallProgressEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  CodexInstallSource,
  EnvironmentCheckResult,
  ManagedClaudeRegistry,
  Preflight,
  SettingsSnapshot
} from '../../../shared/settings'

export type RuntimeInstallState = {
  isInstalling: boolean
  installLogs: string[]
  installProgress: ClaudeInstallProgressEvent | null
  installError: string | undefined
}

// Retained UI log is a diagnostic tail, not a transcript. 256 KiB is far more than the max-h-48
// pane can show; dropping the head keeps store copies and <pre> joins bounded during a 5-minute run.
export const INSTALL_UI_LOG_CHAR_LIMIT = 256 * 1024

const appendCappedInstallLogs = (existing: string[], chunks: readonly string[]): string[] => {
  if (chunks.length === 0) return existing

  const merged = existing.length === 0 ? chunks.join('') : `${existing.join('')}${chunks.join('')}`
  if (merged.length <= INSTALL_UI_LOG_CHAR_LIMIT) return merged.length === 0 ? existing : [merged]
  return [merged.slice(-INSTALL_UI_LOG_CHAR_LIMIT)]
}

export type RuntimeSetupState = {
  preflight: Preflight
  npmAvailable: boolean
  environmentCheck: EnvironmentCheckResult | undefined
  environmentCheckError: string | undefined
  isCheckingEnvironment: boolean
  checkingFramework: AgentFrameworkId | undefined
  envCheckGeneration: number
  isDetectingClaude: boolean
  isDetectingOpencode: boolean
  isDetectingCodex: boolean
  installStates: Record<AgentFrameworkId, RuntimeInstallState>
}

export type RuntimeSetupActions = {
  refreshPreflight: () => Promise<Preflight>
  checkEnvironment: (options?: { force?: boolean }) => Promise<EnvironmentCheckResult | undefined>
  detectClaude: () => Promise<ClaudeDetectResult>
  detectOpencode: () => Promise<void>
  detectCodex: () => Promise<void>
  installClaude: (
    source: ClaudeInstallSource,
    managedRegistry?: ManagedClaudeRegistry
  ) => Promise<ClaudeInstallResult>
  installOpencode: (source?: ClaudeInstallSource) => Promise<ClaudeInstallResult>
  installCodex: (source?: CodexInstallSource) => Promise<ClaudeInstallResult>
  uninstallClaude: () => Promise<void>
  uninstallOpencode: () => Promise<void>
  uninstallCodex: () => Promise<void>
  clearInstallLogs: (runtime?: AgentFrameworkId) => void
}

export type RuntimeSetupSlice = RuntimeSetupState & RuntimeSetupActions

type RuntimeSetupHost = RuntimeSetupState & {
  agentFrameworkId: AgentFrameworkId
  refreshPreflight: RuntimeSetupActions['refreshPreflight']
}

type RuntimeSetupCommands = Pick<
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

type EnvironmentReconcilePatch = Pick<
  RuntimeSetupState,
  'environmentCheck' | 'preflight' | 'npmAvailable'
>

export type RuntimeSetupLoadPatch = Pick<RuntimeSetupState, 'preflight' | 'npmAvailable'>

type RuntimeSetupSliceOptions<Store extends RuntimeSetupHost> = {
  set: StoreApi<Store>['setState']
  get: StoreApi<Store>['getState']
  getCommands: () => RuntimeSetupCommands
  reconcileSnapshot: (
    snapshot: SettingsSnapshot,
    runtimePatch?: Partial<EnvironmentReconcilePatch>
  ) => void
  reconcileClaudeDetection: (result: ClaudeDetectResult, npmAvailable: boolean) => void
}

const createInitialRuntimeInstallState = (): RuntimeInstallState => ({
  isInstalling: false,
  installLogs: [],
  installProgress: null,
  installError: undefined
})

const createInitialPreflight = (): Preflight => ({
  claudeReady: false,
  opencodeReady: false,
  codexReady: false,
  agentFrameworkId: 'claude-code',
  agentReady: false,
  activeProviderReady: false
})

export const createInitialRuntimeSetupState = (): RuntimeSetupState => ({
  preflight: createInitialPreflight(),
  npmAvailable: true,
  environmentCheck: undefined,
  environmentCheckError: undefined,
  isCheckingEnvironment: false,
  checkingFramework: undefined,
  envCheckGeneration: 0,
  isDetectingClaude: false,
  isDetectingOpencode: false,
  isDetectingCodex: false,
  installStates: {
    'claude-code': createInitialRuntimeInstallState(),
    opencode: createInitialRuntimeInstallState(),
    codex: createInitialRuntimeInstallState()
  }
})

export const createRuntimeSetupLoadPatch = (
  preflight: Preflight,
  npmAvailable: boolean
): RuntimeSetupLoadPatch => ({ preflight, npmAvailable })

export const selectAnyInstalling = (state: RuntimeSetupState): boolean =>
  state.installStates['claude-code'].isInstalling ||
  state.installStates.opencode.isInstalling ||
  state.installStates.codex.isInstalling

const patchRuntimeSetupState = <Store extends RuntimeSetupHost>(
  set: StoreApi<Store>['setState'],
  patch: Partial<RuntimeSetupState>
): void => set(patch as Partial<Store>)

const updateInstallStates = <Store extends RuntimeSetupHost>(
  set: StoreApi<Store>['setState'],
  update: (installStates: RuntimeSetupState['installStates']) => RuntimeSetupState['installStates']
): void => set((state) => ({ installStates: update(state.installStates) }) as Partial<Store>)

const patchInstallState = <Store extends RuntimeSetupHost>(
  set: StoreApi<Store>['setState'],
  runtime: AgentFrameworkId,
  patch: Partial<RuntimeInstallState>
): void =>
  updateInstallStates(set, (installStates) => ({
    ...installStates,
    [runtime]: { ...installStates[runtime], ...patch }
  }))

const runRuntimeInstall = async <Store extends RuntimeSetupHost>(
  set: StoreApi<Store>['setState'],
  get: StoreApi<Store>['getState'],
  getCommands: () => RuntimeSetupCommands,
  reconcileSnapshot: RuntimeSetupSliceOptions<Store>['reconcileSnapshot'],
  runtime: AgentFrameworkId,
  invoke: (commands: RuntimeSetupCommands) => Promise<ClaudeInstallResult>
): Promise<ClaudeInstallResult> => {
  // Install events are broadcast without a runtime id. The synchronous global guard guarantees that
  // exactly one subscription is live, so every event can be attributed to this runtime.
  if (selectAnyInstalling(get())) {
    return { installId: '', ok: false, error: 'Another install is already in progress.' }
  }

  patchInstallState(set, runtime, {
    isInstalling: true,
    installLogs: [],
    installProgress: null,
    installError: undefined
  })

  const commands = getCommands()
  let pendingLogChunks: string[] = []
  let flushScheduled = false
  let acceptingEvents = true

  const applyLogChunks = (chunks: readonly string[]): void => {
    if (!acceptingEvents || chunks.length === 0) return
    updateInstallStates(set, (installStates) => ({
      ...installStates,
      [runtime]: {
        ...installStates[runtime],
        installLogs: appendCappedInstallLogs(installStates[runtime].installLogs, chunks)
      }
    }))
  }

  const flushPendingLogChunks = (): void => {
    flushScheduled = false
    if (pendingLogChunks.length === 0) return
    const chunks = pendingLogChunks
    pendingLogChunks = []
    applyLogChunks(chunks)
  }

  const unsubscribe = commands.onInstallLog((event) => {
    if (!acceptingEvents) return
    if (event.kind === 'progress') {
      flushPendingLogChunks()
      patchInstallState(set, runtime, { installProgress: event })
      return
    }

    // First chunk in a turn commits immediately so a single log stays synchronous for existing
    // callers; the rest of the same turn collapses into one follow-up store update.
    if (!flushScheduled && pendingLogChunks.length === 0) {
      applyLogChunks([event.chunk])
      flushScheduled = true
      queueMicrotask(flushPendingLogChunks)
      return
    }

    pendingLogChunks.push(event.chunk)
  })

  try {
    let result: ClaudeInstallResult
    try {
      result = await invoke(commands)
    } catch (error) {
      patchInstallState(set, runtime, {
        installError: error instanceof Error ? error.message : 'Install failed.'
      })
      throw error
    }

    patchInstallState(set, runtime, {
      installError: result.ok ? undefined : (result.error ?? 'Install failed.')
    })

    // Snapshot/preflight reconciliation is best-effort and must not relabel the install outcome.
    try {
      reconcileSnapshot(await commands.getSettings())
      await get().refreshPreflight()
    } catch {
      // The next detection or refresh repairs a briefly stale renderer projection.
    }

    return result
  } finally {
    flushPendingLogChunks()
    acceptingEvents = false
    unsubscribe()
    patchInstallState(set, runtime, { isInstalling: false, installProgress: null })
  }
}

export const createRuntimeSetupSlice = <Store extends RuntimeSetupHost>({
  set,
  get,
  getCommands,
  reconcileSnapshot,
  reconcileClaudeDetection
}: RuntimeSetupSliceOptions<Store>): RuntimeSetupSlice => ({
  ...createInitialRuntimeSetupState(),

  refreshPreflight: async () => {
    const preflight = await getCommands().getPreflight()
    patchRuntimeSetupState(set, { preflight })
    return preflight
  },

  checkEnvironment: async (options) => {
    const framework = get().agentFrameworkId
    // Strict Mode duplicates return the cached value immediately; they do not share the first Promise.
    if (!options?.force && get().isCheckingEnvironment && get().checkingFramework === framework) {
      return get().environmentCheck
    }

    const generation = get().envCheckGeneration + 1
    patchRuntimeSetupState(set, {
      envCheckGeneration: generation,
      isCheckingEnvironment: true,
      checkingFramework: framework,
      // Preserve the existing shared detection indicator even for OpenCode and Codex checks.
      isDetectingClaude: true,
      environmentCheckError: undefined
    })

    try {
      const commands = getCommands()
      const environmentCheck = await commands.checkEnvironment()
      // Preserve the existing ordering: even a pass that became stale while probing performs these
      // reads before generation/framework fencing decides whether it may update visible state.
      const [snapshot, preflight, npmAvailable] = await Promise.all([
        commands.getSettings(),
        commands.getPreflight(),
        commands.isNpmAvailable()
      ])

      if (
        get().envCheckGeneration !== generation ||
        environmentCheck.agentFrameworkId !== get().agentFrameworkId
      ) {
        return environmentCheck
      }

      reconcileSnapshot(snapshot, { environmentCheck, preflight, npmAvailable })
      return environmentCheck
    } catch (error) {
      if (get().envCheckGeneration === generation) {
        patchRuntimeSetupState(set, {
          environmentCheckError:
            error instanceof Error ? error.message : 'Environment detection could not be completed.'
        })
      }
      return undefined
    } finally {
      set(
        (state) =>
          (state.envCheckGeneration === generation
            ? {
                isCheckingEnvironment: false,
                checkingFramework: undefined,
                isDetectingClaude: false
              }
            : {}) as Partial<Store>
      )
    }
  },

  detectClaude: async () => {
    patchRuntimeSetupState(set, { isDetectingClaude: true })

    try {
      const commands = getCommands()
      const [result, npmAvailable] = await Promise.all([
        commands.detectClaude(),
        commands.isNpmAvailable()
      ])

      // Core retains the stable Claude projection; a not-found result intentionally leaves it intact.
      reconcileClaudeDetection(result, npmAvailable)
      await get().refreshPreflight()
      return result
    } finally {
      patchRuntimeSetupState(set, { isDetectingClaude: false })
    }
  },

  detectOpencode: async () => {
    patchRuntimeSetupState(set, { isDetectingOpencode: true })
    try {
      reconcileSnapshot(await getCommands().detectOpencode())
    } finally {
      patchRuntimeSetupState(set, { isDetectingOpencode: false })
    }
  },

  detectCodex: async () => {
    patchRuntimeSetupState(set, { isDetectingCodex: true })
    try {
      reconcileSnapshot(await getCommands().detectCodex())
    } finally {
      patchRuntimeSetupState(set, { isDetectingCodex: false })
    }
  },

  installClaude: (source, managedRegistry) =>
    runRuntimeInstall(set, get, getCommands, reconcileSnapshot, 'claude-code', (commands) =>
      commands.installClaude({ source, managedRegistry })
    ),
  installOpencode: (source = 'managed') =>
    runRuntimeInstall(set, get, getCommands, reconcileSnapshot, 'opencode', (commands) =>
      commands.installOpencode({ source })
    ),
  installCodex: (source = 'managed') =>
    runRuntimeInstall(set, get, getCommands, reconcileSnapshot, 'codex', (commands) =>
      commands.installCodex({ source })
    ),

  uninstallClaude: async () => {
    reconcileSnapshot(await getCommands().uninstallClaude())
    await get().refreshPreflight()
  },
  uninstallOpencode: async () => {
    reconcileSnapshot(await getCommands().uninstallOpencode())
    await get().refreshPreflight()
  },
  uninstallCodex: async () => {
    reconcileSnapshot(await getCommands().uninstallCodex())
    await get().refreshPreflight()
  },

  clearInstallLogs: (runtime) =>
    updateInstallStates(set, (current) => {
      const runtimes: AgentFrameworkId[] = runtime
        ? [runtime]
        : ['claude-code', 'opencode', 'codex']
      const installStates = { ...current }

      for (const id of runtimes) {
        installStates[id] = {
          ...installStates[id],
          installLogs: [],
          installProgress: null,
          installError: undefined
        }
      }

      return installStates
    })
})

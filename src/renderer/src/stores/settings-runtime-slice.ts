import type { StoreApi } from 'zustand'

import type {
  AgentFrameworkId,
  ClaudeInstallProgressEvent,
  ClaudeInstallResult,
  ClaudeInstallSource,
  CodexInstallSource,
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

export type RuntimeSetupState = {
  installStates: Record<AgentFrameworkId, RuntimeInstallState>
}

export type RuntimeSetupActions = {
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
  refreshPreflight: () => Promise<Preflight>
}

type RuntimeSetupCommands = Pick<
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

type RuntimeSetupSliceOptions<Store extends RuntimeSetupHost> = {
  set: StoreApi<Store>['setState']
  get: StoreApi<Store>['getState']
  commands: RuntimeSetupCommands
  reconcileSnapshot: (snapshot: SettingsSnapshot) => void
}

const createInitialRuntimeInstallState = (): RuntimeInstallState => ({
  isInstalling: false,
  installLogs: [],
  installProgress: null,
  installError: undefined
})

export const createInitialRuntimeSetupState = (): RuntimeSetupState => ({
  installStates: {
    'claude-code': createInitialRuntimeInstallState(),
    opencode: createInitialRuntimeInstallState(),
    codex: createInitialRuntimeInstallState()
  }
})

export const selectAnyInstalling = (state: RuntimeSetupState): boolean =>
  state.installStates['claude-code'].isInstalling ||
  state.installStates.opencode.isInstalling ||
  state.installStates.codex.isInstalling

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
  commands: RuntimeSetupCommands,
  reconcileSnapshot: (snapshot: SettingsSnapshot) => void,
  runtime: AgentFrameworkId,
  invoke: () => Promise<ClaudeInstallResult>
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

  const unsubscribe = commands.onInstallLog((event) => {
    if (event.kind === 'progress') {
      patchInstallState(set, runtime, { installProgress: event })
      return
    }

    updateInstallStates(set, (installStates) => ({
      ...installStates,
      [runtime]: {
        ...installStates[runtime],
        installLogs: [...installStates[runtime].installLogs, event.chunk]
      }
    }))
  })

  try {
    let result: ClaudeInstallResult
    try {
      result = await invoke()
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
    unsubscribe()
    patchInstallState(set, runtime, { isInstalling: false, installProgress: null })
  }
}

export const createRuntimeSetupSlice = <Store extends RuntimeSetupHost>({
  set,
  get,
  commands,
  reconcileSnapshot
}: RuntimeSetupSliceOptions<Store>): RuntimeSetupSlice => ({
  ...createInitialRuntimeSetupState(),

  installClaude: (source, managedRegistry) =>
    runRuntimeInstall(set, get, commands, reconcileSnapshot, 'claude-code', () =>
      commands.installClaude({ source, managedRegistry })
    ),
  installOpencode: (source = 'managed') =>
    runRuntimeInstall(set, get, commands, reconcileSnapshot, 'opencode', () =>
      commands.installOpencode({ source })
    ),
  installCodex: (source = 'managed') =>
    runRuntimeInstall(set, get, commands, reconcileSnapshot, 'codex', () =>
      commands.installCodex({ source })
    ),

  uninstallClaude: async () => {
    reconcileSnapshot(await commands.uninstallClaude())
    await get().refreshPreflight()
  },
  uninstallOpencode: async () => {
    reconcileSnapshot(await commands.uninstallOpencode())
    await get().refreshPreflight()
  },
  uninstallCodex: async () => {
    reconcileSnapshot(await commands.uninstallCodex())
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

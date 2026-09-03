import { create } from 'zustand'

import type { NotebookLanguage } from '../../../shared/notebook'
import type { DiscoveredInterpreter, RuntimeEnablement } from '../../../shared/notebook-runtime'

type RuntimeEnvironmentLists = {
  python: DiscoveredInterpreter[]
  r: DiscoveredInterpreter[]
}
type RuntimeEnablements = Partial<Record<NotebookLanguage, RuntimeEnablement>>
type RuntimeRegistrySnapshot = {
  envs: RuntimeEnvironmentLists
  enablement: RuntimeEnablements
  agentEnvironmentCreationEnabled: boolean
}

type RuntimeSettingsState = {
  envs: RuntimeEnvironmentLists | null
  enablement: RuntimeEnablements
  agentEnvironmentCreationEnabled: boolean
  loaded: boolean
  checkedAt: number | null
  busy: boolean
  error: string | null
  packageCounts: Record<string, number | null>
  packageCountsLoaded: Partial<Record<NotebookLanguage, boolean>>
  load: () => Promise<RuntimeRegistrySnapshot>
  recheck: () => Promise<RuntimeRegistrySnapshot>
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  setEnablement: (language: NotebookLanguage, enablement: RuntimeEnablement) => void
  setAgentEnvironmentCreationEnabled: (enabled: boolean) => void
  updatePackageCount: (envId: string, count: number) => void
}

let registryRequest: Promise<RuntimeRegistrySnapshot> | undefined
let registryGeneration = 0
let packageCountGeneration = 0
const packageCountRequests: Partial<Record<NotebookLanguage, Promise<void>>> = {}

const fetchRegistry = (): Promise<RuntimeRegistrySnapshot> =>
  Promise.all([
    window.api.runtime.listEnvironments(),
    window.api.runtime.getEnablement('python'),
    window.api.runtime.getEnablement('r'),
    window.api.runtime.getAgentEnvironmentCreationEnabled()
  ]).then(([envs, python, r, agentEnvironmentCreationEnabled]) => ({
    envs,
    enablement: { python, r },
    agentEnvironmentCreationEnabled
  }))

const useRuntimeSettingsStore = create<RuntimeSettingsState>((set, get) => {
  const loadPackageCounts = (snapshot: RuntimeRegistrySnapshot, generation: number): void => {
    for (const language of ['python', 'r'] as const) {
      if (!snapshot.envs[language].some((env) => env.runnable)) {
        set((state) => ({
          packageCountsLoaded: { ...state.packageCountsLoaded, [language]: true }
        }))
        continue
      }
      if (get().packageCountsLoaded[language] || packageCountRequests[language]) continue

      const countGeneration = packageCountGeneration
      const request = window.api.runtime
        .listPackageCounts(language)
        .then((counts) => {
          if (generation !== registryGeneration || countGeneration !== packageCountGeneration)
            return
          set((state) => ({
            packageCounts: { ...state.packageCounts, ...counts },
            packageCountsLoaded: { ...state.packageCountsLoaded, [language]: true }
          }))
        })
        .catch(() => {
          if (generation !== registryGeneration || countGeneration !== packageCountGeneration)
            return
          // Badge counts are best-effort. Mark the attempt complete so a panel remount does not turn
          // one failed secondary inventory into repeated interpreter/package subprocess work.
          set((state) => ({
            packageCountsLoaded: { ...state.packageCountsLoaded, [language]: true }
          }))
        })
        .finally(() => {
          if (packageCountRequests[language] === request) {
            delete packageCountRequests[language]
          }
        })
      packageCountRequests[language] = request
    }
  }

  const refresh = (force: boolean): Promise<RuntimeRegistrySnapshot> => {
    const state = get()
    if (!force && state.loaded && state.envs) {
      return Promise.resolve({
        envs: state.envs,
        enablement: state.enablement,
        agentEnvironmentCreationEnabled: state.agentEnvironmentCreationEnabled
      })
    }
    if (registryRequest) return registryRequest

    const generation = ++registryGeneration
    if (force) {
      packageCountGeneration += 1
      delete packageCountRequests.python
      delete packageCountRequests.r
    }
    set({
      busy: state.loaded,
      error: null
    })
    const request = fetchRegistry().then(
      (snapshot) => {
        if (generation === registryGeneration) {
          set({
            envs: snapshot.envs,
            enablement: snapshot.enablement,
            agentEnvironmentCreationEnabled: snapshot.agentEnvironmentCreationEnabled,
            loaded: true,
            checkedAt: Date.now(),
            busy: false,
            error: null,
            ...(force ? { packageCounts: {}, packageCountsLoaded: {} } : {})
          })
          loadPackageCounts(snapshot, generation)
        }
        return snapshot
      },
      (error: unknown) => {
        if (generation === registryGeneration) {
          set({
            loaded: true,
            busy: false,
            error: 'Could not load runtimes.'
          })
        }
        throw error
      }
    )
    const trackedRequest = request.finally(() => {
      if (registryRequest === trackedRequest) registryRequest = undefined
    })
    registryRequest = trackedRequest
    void trackedRequest.catch(() => undefined)
    return trackedRequest
  }

  return {
    envs: null,
    enablement: {},
    agentEnvironmentCreationEnabled: true,
    loaded: false,
    checkedAt: null,
    busy: false,
    error: null,
    packageCounts: {},
    packageCountsLoaded: {},
    load: () => refresh(false),
    recheck: () => refresh(true),
    setBusy: (busy) => set({ busy }),
    setError: (error) => set({ error }),
    setEnablement: (language, enablement) =>
      set((state) => ({ enablement: { ...state.enablement, [language]: enablement } })),
    setAgentEnvironmentCreationEnabled: (agentEnvironmentCreationEnabled) =>
      set({ agentEnvironmentCreationEnabled }),
    updatePackageCount: (envId, count) =>
      set((state) => ({ packageCounts: { ...state.packageCounts, [envId]: count } }))
  }
})

export { useRuntimeSettingsStore }
export type { RuntimeEnvironmentLists, RuntimeEnablements, RuntimeRegistrySnapshot }

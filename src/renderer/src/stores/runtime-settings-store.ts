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
  refreshPolicy: () => Promise<boolean>
  listen: () => () => void
  updatePackageCount: (envId: string, count: number) => void
}

let registryRequest: Promise<RuntimeRegistrySnapshot> | undefined
let registryGeneration = 0
let packageCountGeneration = 0
const packageCountRequests: Partial<Record<NotebookLanguage, Promise<void>>> = {}

const fetchRegistry = (): Promise<
  Omit<RuntimeRegistrySnapshot, 'agentEnvironmentCreationEnabled'>
> =>
  Promise.all([
    window.api.runtime.listEnvironments(),
    window.api.runtime.getEnablement('python'),
    window.api.runtime.getEnablement('r')
  ]).then(([envs, python, r]) => ({
    envs,
    enablement: { python, r }
  }))

const useRuntimeSettingsStore = create<RuntimeSettingsState>((set, get) => {
  let policyGeneration = 0
  let policyRequest: Promise<boolean> | undefined
  const readPolicy = (): Promise<boolean> => {
    if (policyRequest) return policyRequest
    const request = (async () => {
      for (;;) {
        const generation = policyGeneration
        try {
          const enabled = await window.api.runtime.getAgentEnvironmentCreationEnabled()
          if (generation !== policyGeneration) continue
          set({ agentEnvironmentCreationEnabled: enabled })
          return enabled
        } catch (error) {
          if (generation !== policyGeneration) continue
          set({ error: 'Could not load runtimes.' })
          throw error
        }
      }
    })().finally(() => {
      if (policyRequest === request) policyRequest = undefined
    })
    policyRequest = request
    return request
  }
  const refreshPolicy = (): Promise<boolean> => {
    // Events and completed writes invalidate any read already in flight. A burst shares one
    // request and gets a trailing read; it never repeats discovery or package inventory.
    policyGeneration += 1
    // A read can have settled just before this event while its finally cleanup is still queued.
    // Wait through that cleanup before requesting authority again.
    return policyRequest
      ? policyRequest.catch(() => undefined).then(() => readPolicy())
      : readPolicy()
  }
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
      return readPolicy().then((agentEnvironmentCreationEnabled) => ({
        envs: state.envs!,
        enablement: state.enablement,
        agentEnvironmentCreationEnabled
      }))
    }
    if (registryRequest) return registryRequest

    const generation = ++registryGeneration
    const policyAtStart = policyGeneration
    if (force) {
      packageCountGeneration += 1
      delete packageCountRequests.python
      delete packageCountRequests.r
    }
    set({
      busy: state.loaded,
      error: null
    })
    const request = Promise.all([fetchRegistry(), readPolicy()]).then(
      ([registry]) => {
        // Discovery may finish after a newer policy read. Its receipt does not own policy state.
        const snapshot = {
          ...registry,
          agentEnvironmentCreationEnabled: get().agentEnvironmentCreationEnabled
        }
        if (generation === registryGeneration) {
          set({
            envs: snapshot.envs,
            enablement: snapshot.enablement,
            loaded: true,
            checkedAt: Date.now(),
            busy: false,
            error: policyAtStart === policyGeneration ? null : get().error,
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
    refreshPolicy,
    listen: () =>
      window.api.runtime.onPolicyChanged?.(() => {
        void refreshPolicy().catch(() => undefined)
      }) ?? (() => undefined),
    updatePackageCount: (envId, count) =>
      set((state) => ({ packageCounts: { ...state.packageCounts, [envId]: count } }))
  }
})

export { useRuntimeSettingsStore }
export type { RuntimeEnvironmentLists, RuntimeEnablements, RuntimeRegistrySnapshot }

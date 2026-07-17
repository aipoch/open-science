import { create } from 'zustand'

import type { NotebookLanguage } from '../../../shared/notebook'
import type {
  ProvisionProgress,
  ProvisionScope,
  ProvisionStatus
} from '../../../shared/notebook-env'
import { deriveProvisionUi, type ProvisionUiState } from '../pages/workspace/provisioning-view'

export type NotebookEnvState = {
  status: ProvisionStatus
  progress?: ProvisionProgress
  error?: string
  // Last explicit provision request; drives upgrade-vs-python-vs-r scope inference in the reducer.
  scope?: ProvisionScope
  // Derived view state (contract §4 UI): recomputed from status/scope/progress/error on every update.
  ui: ProvisionUiState
}

type NotebookEnvStore = NotebookEnvState & {
  init: () => Promise<void>
  provision: (lang: NotebookLanguage) => Promise<void>
  retry: () => Promise<void>
}

// Base status plus the ui the reducer derives from it, shared by the initial store state and tests.
// Explicitly nulls the optional fields so a test's merge-based `setState(createInitialNotebookEnvState())`
// reset actually clears any `progress`/`error`/`scope` left over from a prior assertion.
export const createInitialNotebookEnvState = (): NotebookEnvState => {
  const status: ProvisionStatus = {
    pythonReady: false,
    rReady: false,
    version: 0,
    provisioning: false
  }
  return {
    status,
    progress: undefined,
    error: undefined,
    scope: undefined,
    ui: deriveProvisionUi(status, undefined, undefined, undefined)
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Tracks which `window.api.notebookEnv` bridge instances already have a live `onProgress`
// subscription, so a second `init()` call (App.tsx at launch + OnboardingWizard during onboarding,
// or a remount) never stacks a duplicate permanent listener. Keyed by object identity rather than
// store state so it naturally scopes to "this bridge instance" — the real bridge is a singleton for
// the renderer's lifetime, while tests install a fresh mock bridge per case and get a clean slate.
const subscribedBridges = new WeakSet<object>()

export const useNotebookEnvStore = create<NotebookEnvStore>((set, get) => {
  // Merges a partial update into state, then re-derives `ui` from the resulting status/scope/
  // progress/error so every consumer of `ui` (onboarding step, launch banner, notebook gate) sees a
  // view that always matches the latest mirrored state (reuses provisioning-view's pure reducer).
  const applyUi = (partial: Partial<NotebookEnvState>): void =>
    set((s) => {
      const next = { ...s, ...partial }
      return {
        ...partial,
        ui: deriveProvisionUi(next.status, next.scope, next.progress, next.error)
      }
    })

  return {
    ...createInitialNotebookEnvState(),

    // Mirror the main-process provisioner: hydrate once, then track each progress broadcast and
    // re-read the authoritative status so provisioning/ready flags stay in lockstep (update-store idiom).
    init: async () => {
      const bridge = window.api?.notebookEnv
      if (!bridge) return
      // Idempotency guard: only ever register one onProgress listener per bridge instance, even
      // though init() has two legitimate call sites. Still refresh getStatus() below on every call
      // so a re-mount picks up any state change that happened while unmounted.
      if (!subscribedBridges.has(bridge)) {
        subscribedBridges.add(bridge)
        bridge.onProgress((progress) => {
          applyUi({ progress })
          void bridge.getStatus().then((status) => applyUi({ status }))
        })
      }
      const status = await bridge.getStatus()
      applyUi({ status })
    },

    provision: async (lang) => {
      const bridge = window.api?.notebookEnv
      const scope: ProvisionScope = lang
      applyUi({ scope, error: undefined })
      if (!bridge) return
      try {
        await bridge.provision(lang)
        applyUi({ status: await bridge.getStatus() })
      } catch (e) {
        applyUi({ error: errorText(e) })
      }
    },

    retry: async () => {
      const scope = get().scope
      await get().provision(scope === 'r' ? 'r' : 'python')
    }
  }
})

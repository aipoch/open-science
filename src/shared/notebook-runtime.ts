import type { DiscoveredInterpreter, EnvProvenance } from '@aipoch/environment/contracts'
import type { NotebookLanguage } from './notebook-language-contract'

// Renderer-safe wire shapes for the notebook Runtime Registry (managed + external environments).
// RuntimeEnablement owns global admission while NotebookRuntimeBindings own each Session's selected
// targets. The coarse pythonReady/rReady booleans (shared/notebook-env.ts) do not capture BYO.

// Where a language's interpreter comes from: an app-owned micromamba env, or the user's own install.
export type RuntimeSource = 'managed' | 'external'

// The v4 per-language enablement state, keyed by `envId` (the interpreter's real path). `enabled` is
// an EXPLICIT override map — a present entry wins over the provenance default (see isEnvEnabled), an
// absent one falls back to it, so re-detection and new envs keep working without a migration.
// `installAuthorized` is the SEPARATE high-risk opt-in that lets Open-Science write packages into an
// external env (default OFF; execute-after-enable stays read-only until this is turned on).
export type RuntimeEnablement = {
  enabled: Record<string, boolean>
  installAuthorized: Record<string, boolean>
  // Explicit R library consent. Historical booleans alone never authorize R writes.
  installLibraries?: Record<string, string>
}

// How many live sessions are bound to a runtime, split by kernel state, so the Settings disable
// affordance can warn about impact before revoking. running = a cell is executing on it; idle = its
// kernel is live but not running; dormant = bound but no live kernel (nothing to drain/close).
export type RuntimeUsage = {
  running: number
  idle: number
  dormant: number
}

// Lifecycle status of a session binding. 'active' = usable now; 'revoking' = a disable is draining
// the in-flight lease before tearing the kernel down; 'unavailable' = the bound runtime can no longer
// back a run and the agent must switch (see reason). No silent fallback: an unavailable binding makes
// execute/install reject in the main process rather than quietly running a different interpreter.
export type RuntimeBindingStatus = 'active' | 'revoking' | 'unavailable'

// Why a binding is unavailable. 'disabled' = the runtime was turned off in Settings; 'missing' = its
// interpreter/env was deleted or moved; 'repair-required' = an interrupted env operation left it in an
// unverified state (see notebook-runtime-crash-recovery). Absent while status is active/revoking.
export type RuntimeBindingUnavailableReason = 'disabled' | 'missing' | 'repair-required'

// v4 session runtime binding: the ENABLED runtime a session runs one language on for the whole
// session (one runtime per language per session — no implicit per-call switching). `runtimeId` is the
// discovered env's stable identity (its real path), `source` mirrors the provenance ('managed' =
// app-owned env, 'external' = the user's own interpreter). Surfaced to the agent via notebook_state /
// list_notebook_runtimes so it can see and (re)choose its bindings with notebook_bind/switch_runtime.
export type NotebookRuntimeBinding = {
  language: NotebookLanguage
  runtimeId: string
  source: RuntimeSource
  provenance: EnvProvenance
  interpreterPath: string
  label: string
  version?: string
  // Lifecycle status; absent is treated as 'active' by older readers. reason is set only when status
  // is 'unavailable'. Persisted so a session's binding + why it is unusable survive a restart.
  status?: RuntimeBindingStatus
  reason?: RuntimeBindingUnavailableReason
}

// The session's current per-language bindings (absent = still resolving to the app-managed default).
export type NotebookRuntimeBindings = {
  python?: NotebookRuntimeBinding
  r?: NotebookRuntimeBinding
}

// Stable evidence for the Runtime Environment an operation would use. An absent explicit Runtime
// Binding is represented directly instead of being confused with a managed binding.
export type RuntimeTargetReceipt =
  | {
      language: NotebookLanguage
      selection: 'implicit-default' | 'explicit-binding'
      runtimeSource: RuntimeSource
      environmentName?: string
      runtimeId: string
      label: string
      prefix?: string
    }
  | {
      language: NotebookLanguage
      // Target resolution itself failed or produced no enabled runtime. Do not invent ownership or a
      // canonical identity in that case; later discovery work may attach a more specific typed error.
      selection: 'unresolved'
    }

export type RuntimeBindingOperationResult =
  | {
      bound: NotebookRuntimeBinding
      bindings: NotebookRuntimeBindings
    }
  | {
      ok: false
      // A failed durability confirmation may follow a published binding. Report the actual change.
      bindingChanged: boolean
      error: string
      bindings: NotebookRuntimeBindings
      target: RuntimeTargetReceipt
    }

// One entry in list_notebook_runtimes: an ENABLED runtime (app-managed + user-enabled external, never
// disabled) plus whether it is the session's current binding and whether it can back the kernel loop.
export type NotebookRuntimeListing = NotebookRuntimeBinding & {
  runnable: boolean
  bound: boolean
  detail?: string
}

// Whether a detected env is effective-enabled: an explicit override wins, else the provenance default.
// App-managed AND agent-created envs default ON — both are app-controlled (the agent created the
// latter for its own use, so it must be bindable without a manual enable). Only the USER'S OWN
// interpreters default OFF, requiring explicit opt-in in Settings. Pure so the main-process invariant
// and the UI share one source of truth.
export const isEnvEnabled = (
  env: DiscoveredInterpreter,
  enablement?: RuntimeEnablement
): boolean => {
  const explicit = enablement?.enabled[env.envId]
  return explicit !== undefined ? explicit : env.provenance !== 'user-own'
}

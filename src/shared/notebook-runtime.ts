import type { NotebookLanguage } from './notebook'

// Renderer-safe wire shapes for the notebook Runtime Registry (managed + external environments).
// Shared by Settings, Onboarding, the main runtime-registry, and (later) the executor/manage_packages
// so there is ONE source of truth for how a language's interpreter is chosen and whether Open Science
// may mutate its packages. The coarse pythonReady/rReady booleans (shared/notebook-env.ts) don't
// capture BYO — this model does.

// Where a language's interpreter comes from: an app-owned micromamba env, or the user's own install.
export type RuntimeSource = 'managed' | 'external'

// The user's persisted choice for a language (StoredSettings). Absent = not yet chosen (onboarding
// hasn't resolved it) — the language is then gated with a "use / choose / download / skip" prompt.
//
// `external` is the foundation's REGISTERED-VENV tier (`manage_environments(mode="register")`):
// - `appOwnedOverlay: true`  → an app-created overlay venv (register + create,
//   `python -m venv --system-site-packages`). Open Science owns it, so writes are safe by design.
// - `appOwnedOverlay: false` → the user's own pre-existing interpreter/venv. Writing here is higher
//   risk, so it stays read-only until `packageInstallAuthorized` is explicitly turned on (default OFF;
//   uninstall stays disabled regardless).
export type RuntimeSelection =
  | { source: 'managed' }
  | {
      source: 'external'
      interpreterPath: string
      // Leading args that select the interpreter (e.g. the Windows `py` launcher needs `-3`). Kept so
      // a launcher survives to overlay creation / execution instead of being dropped. Usually empty.
      interpreterArgs?: string[]
      appOwnedOverlay: boolean
      packageInstallAuthorized: boolean
    }

// How (and whether) Open Science may install packages into a runtime. `via` names the writer so a
// caller never has to re-derive it: managed uses micromamba; an authorized external Python uses the
// selected interpreter's pip; an authorized external R writes the user's R library. Read-only envs
// carry a human `reason` the agent surfaces instead of silently mutating anything.
export type PackageMutability =
  { mutable: true; via: 'micromamba' | 'pip' | 'r-library' } | { mutable: false; reason: string }

// One language's full runtime picture for the Settings/Onboarding UI: the persisted choice plus a
// survey of BOTH sources so the UI can offer "use your detected Python at <path>" vs "managed env".
// `selection` undefined => nothing chosen yet (resolves to the managed default at run time).
export type RuntimeSurvey = {
  language: NotebookLanguage
  selection: RuntimeSelection | undefined
  managed: RuntimeReadiness
  external: RuntimeReadiness
}

// Full readiness snapshot for one language's runtime, surfaced to Settings + Onboarding. Distinguishes
// the states a single boolean cannot: found-but-not-selected, selected-but-not-runnable (e.g. external
// R with no jsonlite), and runnable-but-read-only.
export type RuntimeReadiness = {
  language: NotebookLanguage
  source: RuntimeSource
  // An interpreter was found (managed: the env prefix exists; external: the interpreter is on disk).
  detected: boolean
  // The user has chosen this source as the active runtime for the language.
  selected: boolean
  // Version is acceptable AND the kernel-protocol dependencies are present (R needs jsonlite + a
  // protocol probe). NEVER true on a bare "interpreter found".
  runnable: boolean
  // Open Science may install packages here (managed: yes; external: only when authorized).
  packageMutable: boolean
  // Resolved interpreter path (external path, or the managed env's bin) when known.
  interpreterPath?: string
  // Leading interpreter-selection args (e.g. `["-3"]` for the Windows `py` launcher); usually empty.
  interpreterArgs?: string[]
  // e.g. "3.12.4" / "R 4.4.1".
  version?: string
  // Human-readable status/gap, e.g. "jsonlite is not installed" or "not selected".
  detail?: string
}

// v4 environment discovery (Settings cards). Where an interpreter came from — also gates the agent
// remove-guard: only 'agent-created' envs may be removed by the agent.
export type EnvProvenance = 'app-managed' | 'user-own' | 'agent-created'

// One detected interpreter. `envId` (its real path) is the stable identity used to persist the
// per-env enabled/disabled choice across re-detection.
export type DiscoveredInterpreter = {
  language: NotebookLanguage
  provenance: EnvProvenance
  envId: string
  interpreterPath: string
  label: string
  version?: string
  runnable: boolean
  condaEnv?: string
  detail?: string
}

// The v4 per-language enablement state, keyed by `envId` (the interpreter's real path). `enabled` is
// an EXPLICIT override map — a present entry wins over the provenance default (see isEnvEnabled), an
// absent one falls back to it, so re-detection and new envs keep working without a migration.
// `installAuthorized` is the SEPARATE high-risk opt-in that lets Open Science write packages into an
// external env (default OFF; execute-after-enable stays read-only until this is turned on).
export type RuntimeEnablement = {
  enabled: Record<string, boolean>
  installAuthorized: Record<string, boolean>
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

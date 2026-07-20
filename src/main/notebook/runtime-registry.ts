import type { NotebookLanguage } from '../../shared/notebook'
import type {
  PackageMutability,
  RuntimeReadiness,
  RuntimeSelection,
  RuntimeSource
} from '../../shared/notebook-runtime'

// The single seam every runtime consumer (Settings, Onboarding, executor, manage_packages) goes
// through, so managed and external environments are handled uniformly instead of the executor and
// package manager each hard-coding the app-owned micromamba prefix. This P0 module owns detection +
// the package-mutability POLICY; interpreter resolution and the actual executor/package-manager
// rewire land in later phases (kept additive here so nothing existing breaks).

// What an adapter's detection reports for one language. `runnable` already folds in the kernel-protocol
// checks (for R: jsonlite + a minimal protocol probe), so a bare "interpreter found" is detected:true
// but runnable:false.
export type DetectionResult = {
  detected: boolean
  runnable: boolean
  interpreterPath?: string
  // Leading interpreter-selection args (e.g. `["-3"]` for the Windows `py` launcher) so a launcher
  // survives to overlay creation / execution instead of being silently dropped.
  interpreterArgs?: string[]
  version?: string
  detail?: string
}

// The two real behaviours behind the registry. ManagedEnvironmentAdapter owns app micromamba envs
// (create/download/install/uninstall/repair — wired in later phases); ExternalEnvironmentAdapter only
// probes and (post-authorization) does restricted in-interpreter installs. Both expose detection here.
export interface EnvironmentAdapter {
  readonly source: RuntimeSource
  // Probe readiness for `language`. `selection` is the user's config for that language when the active
  // source matches this adapter; undefined means "survey what this source could offer" (auto-detect,
  // e.g. find a system interpreter on PATH) so onboarding can present the choice.
  detect(
    language: NotebookLanguage,
    selection: RuntimeSelection | undefined
  ): Promise<DetectionResult>
}

// Package-mutability POLICY (pure), aligned to the foundation's three tiers (environment-management spec).
// - managed → mutable via micromamba. (The default env's *additive-only* rule and the platform-shim
//   "installs rejected" exception are enforced at the package-manager layer, not in this gate.)
// - external = a registered venv. An APP-OWNED overlay (register + create, --system-site-packages) is
//   ours to write, so it is mutable regardless of the authorization toggle. The user's OWN pre-existing
//   interpreter/venv stays READ-ONLY until installs are explicitly authorized (higher risk). Either way
//   the writer is the selected interpreter's pip (Python) / the user's R library (R) — never the bundled
//   micromamba mutating a foreign environment. The read-only `reason` is what the agent surfaces.
export const computePackageMutability = (
  language: NotebookLanguage,
  selection: RuntimeSelection | undefined
): PackageMutability => {
  if (!selection) {
    return { mutable: false, reason: 'No runtime is selected for this language yet.' }
  }
  if (selection.source === 'managed') {
    return { mutable: true, via: 'micromamba' }
  }
  const via = language === 'r' ? 'r-library' : 'pip'
  // App-created overlay: Open Science owns this venv, so installs are always allowed.
  if (selection.appOwnedOverlay) {
    return { mutable: true, via }
  }
  if (!selection.packageInstallAuthorized) {
    return {
      mutable: false,
      reason:
        'This is your own environment; Open Science is not authorized to modify it. Install the ' +
        'package yourself, enable installs for this environment in Settings, or switch to the ' +
        'managed environment.'
    }
  }
  return { mutable: true, via }
}

// The concrete WRITE PLAN for a package install, derived from the mutability policy. package-manager
// consults this so a read-only env is REFUSED with an actionable message (never silently mutated), a
// managed env uses micromamba, an authorized/overlay external Python uses `<interpreter> -m pip`, and
// external R writes the user's R library. The pip/r-library interpreter is resolved by the caller (the
// same resolution the executor uses), so this stays pure on the selection. Uninstall on external envs
// is a separate, default-disabled capability and is intentionally NOT planned here.
export type PackageInstallPlan =
  | { action: 'refuse'; reason: string }
  | { action: 'micromamba' }
  | { action: 'pip' }
  | { action: 'r-library' }

export const planPackageInstall = (
  language: NotebookLanguage,
  selection: RuntimeSelection | undefined
): PackageInstallPlan => {
  const mutability = computePackageMutability(language, selection)
  if (!mutability.mutable) return { action: 'refuse', reason: mutability.reason }
  if (mutability.via === 'micromamba') return { action: 'micromamba' }
  return mutability.via === 'r-library' ? { action: 'r-library' } : { action: 'pip' }
}

// The active source for a language: whatever the user selected, else the managed default (source is
// never absent — an unselected language still resolves to "managed" for surveying purposes).
const activeSource = (selection: RuntimeSelection | undefined): RuntimeSource =>
  selection?.source === 'external' ? 'external' : 'managed'

// Registry deps: the two adapters. Injected so both this module and its consumers are testable without
// spawning interpreters or building envs.
export type RuntimeRegistryDeps = {
  managed: EnvironmentAdapter
  external: EnvironmentAdapter
}

export class RuntimeRegistry {
  constructor(private readonly deps: RuntimeRegistryDeps) {}

  private adapterFor(source: RuntimeSource): EnvironmentAdapter {
    return source === 'external' ? this.deps.external : this.deps.managed
  }

  // Readiness for the language's ACTIVE runtime (per the user's selection). Used by the executor gate
  // and manage_packages to decide runnability and package permission.
  async readiness(
    language: NotebookLanguage,
    selection: RuntimeSelection | undefined
  ): Promise<RuntimeReadiness> {
    const source = activeSource(selection)
    const detection = await this.adapterFor(source).detect(language, selection)
    const mutability = computePackageMutability(language, selection)
    return {
      language,
      source,
      detected: detection.detected,
      selected: selection !== undefined,
      runnable: detection.runnable,
      packageMutable: mutability.mutable,
      interpreterPath: detection.interpreterPath,
      interpreterArgs: detection.interpreterArgs,
      version: detection.version,
      detail: detection.detail ?? (selection ? undefined : 'No runtime selected yet.')
    }
  }

  // Survey BOTH sources for a language (detection only, nothing selected) so onboarding/Settings can
  // present the real choices: "managed env is downloadable/built" vs "we found your Python at <path>".
  async survey(
    language: NotebookLanguage
  ): Promise<{ managed: RuntimeReadiness; external: RuntimeReadiness }> {
    const [managed, external] = await Promise.all([
      this.surveyOne(language, 'managed'),
      this.surveyOne(language, 'external')
    ])
    return { managed, external }
  }

  private async surveyOne(
    language: NotebookLanguage,
    source: RuntimeSource
  ): Promise<RuntimeReadiness> {
    const detection = await this.adapterFor(source).detect(language, undefined)
    return {
      language,
      source,
      detected: detection.detected,
      selected: false,
      runnable: detection.runnable,
      // Surveying is source-agnostic of authorization: report the env's own mutability floor (managed
      // is always mutable; external shows read-only until selected + authorized).
      packageMutable: source === 'managed',
      interpreterPath: detection.interpreterPath,
      interpreterArgs: detection.interpreterArgs,
      version: detection.version,
      detail: detection.detail
    }
  }

  packageMutability(
    language: NotebookLanguage,
    selection: RuntimeSelection | undefined
  ): PackageMutability {
    return computePackageMutability(language, selection)
  }
}

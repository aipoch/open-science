import type { NotebookLanguage } from '../../shared/notebook'
import type {
  EnvPackage,
  RuntimeEnablement,
  RuntimeSelection,
  RuntimeSurvey,
  RuntimeUsage
} from '../../shared/notebook-runtime'
import { isCurrentAppManagedDefault } from '../../shared/notebook-runtime'
import {
  createExternalAdapter,
  createManagedAdapter,
  defaultExternalAdapterDeps
} from './runtime-adapters'
import {
  defaultDiscoveryDeps,
  discoverInterpreters,
  type DiscoveredInterpreter
} from './environment-discovery'
import { listEnvPackages } from './package-listing'
import { RuntimeRegistry } from './runtime-registry'
import { managedDefaultRuntimeIdentities } from './runtime-target'
import { prepareExternalPythonRuntime, type AppOwnedExternalSelection } from './venv-overlay'
import type { MicromambaRunner } from './windows-micromamba-runner'

type RuntimeRegistryPort = Pick<RuntimeRegistry, 'survey' | 'readiness'>

// Settings presents languages in this order; keep survey results stable for existing callers.
const RUNTIME_LANGUAGES: readonly NotebookLanguage[] = ['python', 'r']

// Upper bound on concurrent package listings inside listPackageCounts (mirrors the bounded
// probe concurrency in environment-discovery): enough to fill the Settings badges quickly without
// a subprocess storm.
const PACKAGE_COUNT_CONCURRENCY = 4

// Persisted runtime state remains Settings-owned. This narrow port keeps the workflows independent of
// the broader Settings module while preserving its normalized read-after-write behavior.
type RuntimeSelectionSettings = {
  getRuntimeSelection(language: NotebookLanguage): Promise<RuntimeSelection | undefined>
  setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<RuntimeSelection | undefined>
  getRuntimeEnablement(language: NotebookLanguage): Promise<RuntimeEnablement>
  setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement>
  setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement>
  getAgentEnvironmentCreationEnabled(): Promise<boolean>
  setAgentEnvironmentCreationEnabled(enabled: boolean): Promise<boolean>
  getManualInterpreters(language: NotebookLanguage): Promise<string[]>
  addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
  removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
}

type RuntimeSelectionWorkflowDeps = {
  settingsService: RuntimeSelectionSettings
  // Resolve lazily so a data-root switch reaches discovery and overlay preparation immediately.
  runtimeRoot: () => string
  // Production uses the managed/external registry; tests use the same two-operation seam.
  registry?: RuntimeRegistryPort
  // An app-owned overlay must be ready before its selection becomes durable.
  prepareExternalPython?: (
    selection: AppOwnedExternalSelection,
    runtimeRoot: string
  ) => Promise<void>
  // Called only after disabled state is durable; force chooses stop-now instead of drain-and-close.
  onRuntimeDisabled?: (language: NotebookLanguage, envId: string, force?: boolean) => Promise<void>
  // Optional because sessions may not be composed yet during startup; absence means no live usage.
  describeRuntimeUsage?: (language: NotebookLanguage, envId: string) => RuntimeUsage
  uninstallManagedEnvironment?: (
    language: NotebookLanguage,
    commitDisabledState: () => Promise<void>
  ) => Promise<void>
  platform?: NodeJS.Platform
  // Injectable for tests so the package-listing workflows never spawn micromamba/pip/Rscript;
  // production defaults to listEnvPackages against the real env.
  listPackages?: (env: DiscoveredInterpreter) => Promise<EnvPackage[]>
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
}

type RuntimeSelectionWorkflows = {
  survey(): Promise<RuntimeSurvey[]>
  listEnvironments(): Promise<{
    python: DiscoveredInterpreter[]
    r: DiscoveredInterpreter[]
  }>
  // Read-only installed-package inventory for one discovered env (Settings "Packages" dialog).
  listPackages(request: { language: NotebookLanguage; envId: string }): Promise<EnvPackage[]>
  // Bulk per-env package counts for the Settings card badges; null = the listing failed (badge
  // omitted). Non-runnable envs get no entry.
  listPackageCounts(request: { language: NotebookLanguage }): Promise<Record<string, number | null>>
  getEnablement(request: { language: NotebookLanguage }): Promise<RuntimeEnablement>
  getAgentEnvironmentCreationEnabled(): Promise<boolean>
  setAgentEnvironmentCreationEnabled(request: { enabled: boolean }): Promise<boolean>
  describeUsage(request: { language: NotebookLanguage; envId: string }): Promise<RuntimeUsage>
  setSelection(request: {
    language: NotebookLanguage
    selection: RuntimeSelection | null
  }): Promise<RuntimeSurvey>
  setEnvironmentEnabled(request: {
    language: NotebookLanguage
    envId: string
    enabled: boolean
    force?: boolean
  }): Promise<RuntimeEnablement>
  setInstallAuthorized(request: {
    language: NotebookLanguage
    envId: string
    authorized: boolean
  }): Promise<RuntimeEnablement>
  uninstallManagedEnvironment(request: { language: NotebookLanguage }): Promise<void>
  register(request: { language: NotebookLanguage; path: string }): Promise<string[]>
  unregister(request: { language: NotebookLanguage; path: string }): Promise<string[]>
}

const createRuntimeSelectionWorkflows = (
  deps: RuntimeSelectionWorkflowDeps
): RuntimeSelectionWorkflows => {
  const registry =
    deps.registry ??
    new RuntimeRegistry({
      managed: createManagedAdapter({ runtimeRoot: deps.runtimeRoot }),
      external: createExternalAdapter(defaultExternalAdapterDeps())
    })
  let discoveredSnapshot:
    { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] } | undefined
  let discoveredRuntimeRoot: string | undefined

  const invalidateDiscovery = (): void => {
    discoveredSnapshot = undefined
    discoveredRuntimeRoot = undefined
  }

  // A selected external runtime must report readiness for its persisted path, not the unrelated PATH
  // interpreter returned by the source-wide survey.
  const buildSurvey = async (language: NotebookLanguage): Promise<RuntimeSurvey> => {
    const [selection, surveyed] = await Promise.all([
      deps.settingsService.getRuntimeSelection(language),
      registry.survey(language)
    ])
    const external =
      selection?.source === 'external'
        ? await registry.readiness(language, selection)
        : surveyed.external

    return { language, selection, managed: surveyed.managed, external }
  }

  // One language's discovered envs for the package-listing workflows: the manual-interpreter
  // catalog snapshot merged into discovery as a sync getter. listEnvironments keeps its own
  // two-language sweep (one shared discovery construction); these workflows need a single language.
  const discoverLanguageEnvs = async (
    language: NotebookLanguage
  ): Promise<DiscoveredInterpreter[]> => {
    const manual = await deps.settingsService.getManualInterpreters(language)
    return discoverInterpreters(
      language,
      defaultDiscoveryDeps(deps.runtimeRoot(), () => manual)
    )
  }

  // The validated listing path shared by both package workflows: only ever called with a DISCOVERED
  // env (see the envId lookup in listPackages), never with renderer-supplied paths.
  const listPackagesFor = (env: DiscoveredInterpreter): Promise<EnvPackage[]> => {
    const list =
      deps.listPackages ??
      ((target: DiscoveredInterpreter) =>
        listEnvPackages(target, {
          runtimeRoot: deps.runtimeRoot(),
          micromambaRunner: deps.micromambaRunner
        }))
    return list(env)
  }

  return {
    survey: () => Promise.all(RUNTIME_LANGUAGES.map(buildSurvey)),
    listEnvironments: async () => {
      // Discovery expects a synchronous manual-path lookup, so snapshot both persisted catalogs first.
      const [manualPython, manualR] = await Promise.all([
        deps.settingsService.getManualInterpreters('python'),
        deps.settingsService.getManualInterpreters('r')
      ])
      const currentRuntimeRoot = deps.runtimeRoot()
      const discovery = defaultDiscoveryDeps(currentRuntimeRoot, (language) =>
        language === 'python' ? manualPython : manualR
      )
      const [python, r] = await Promise.all([
        discoverInterpreters('python', discovery),
        discoverInterpreters('r', discovery)
      ])
      discoveredRuntimeRoot = currentRuntimeRoot
      discoveredSnapshot = { python, r }
      return discoveredSnapshot
    },
    // Read-only installed-package inventory for one env (Settings "Packages" dialog). The envId is
    // validated against a FRESH discovery result — the renderer only names the env; the interpreter
    // path / provenance used for dispatch come from discovery, so an arbitrary renderer-supplied
    // path can never be probed.
    listPackages: async (request) => {
      const env = (await discoverLanguageEnvs(request.language)).find(
        (candidate) => candidate.envId === request.envId
      )
      if (!env) {
        throw new Error(`Unknown ${request.language} environment: ${request.envId}`)
      }
      return listPackagesFor(env)
    },
    // Bulk per-env package counts for the Settings card badges. ONE discovery sweep for the
    // language (not one per env — each sweep spawns probe subprocesses), then a listing per
    // runnable env with bounded concurrency so a machine with many envs doesn't spawn a burst of
    // subprocesses. A failed listing maps to null (the card simply omits its badge).
    listPackageCounts: async (request) => {
      const currentRuntimeRoot = deps.runtimeRoot()
      const discovered =
        discoveredSnapshot && discoveredRuntimeRoot === currentRuntimeRoot
          ? discoveredSnapshot[request.language]
          : await discoverLanguageEnvs(request.language)
      const runnable = discovered.filter((env) => env.runnable)
      const counts: Record<string, number | null> = {}
      let next = 0
      const worker = async (): Promise<void> => {
        for (let i = next++; i < runnable.length; i = next++) {
          const env = runnable[i]
          counts[env.envId] = await listPackagesFor(env)
            .then((packages) => packages.length)
            .catch(() => null)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PACKAGE_COUNT_CONCURRENCY, runnable.length) }, () => worker())
      )
      return counts
    },
    getEnablement: (request) => deps.settingsService.getRuntimeEnablement(request.language),
    getAgentEnvironmentCreationEnabled: () =>
      deps.settingsService.getAgentEnvironmentCreationEnabled(),
    setAgentEnvironmentCreationEnabled: (request) =>
      deps.settingsService.setAgentEnvironmentCreationEnabled(request.enabled),
    describeUsage: async (request) =>
      deps.describeRuntimeUsage?.(request.language, request.envId) ?? {
        running: 0,
        idle: 0,
        dormant: 0
      },
    setSelection: async (request): Promise<RuntimeSurvey> => {
      // Validate the exact external interpreter before persistence. R stays managed-only, and managed
      // selections remain runnable-by-provisioning without an eager interpreter probe.
      if (request.selection?.source === 'external') {
        if (request.language !== 'python') {
          throw new Error('R only supports the app-managed runtime.')
        }
        const readiness = await registry.readiness(request.language, request.selection)
        if (!readiness.runnable) {
          throw new Error(
            readiness.detail
              ? `That interpreter can't be used as a notebook runtime: ${readiness.detail}`
              : "That interpreter can't be used as a notebook runtime (not a runnable Python 3)."
          )
        }
        if (request.selection.appOwnedOverlay) {
          try {
            // Overlay creation and its protocol probe are a precondition: failure leaves Settings
            // unchanged, so later execution never observes a half-prepared runtime.
            await (deps.prepareExternalPython ?? prepareExternalPythonRuntime)(
              request.selection as AppOwnedExternalSelection,
              deps.runtimeRoot()
            )
          } catch (error) {
            throw new Error(
              `Could not prepare an isolated notebook runtime, so the selection was not saved: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      }
      await deps.settingsService.setRuntimeSelection(request.language, request.selection)
      return buildSurvey(request.language)
    },
    setEnvironmentEnabled: async (request) => {
      const next = await deps.settingsService.setEnvironmentEnabled(
        request.language,
        request.envId,
        request.enabled
      )
      // Persist disable before revocation. A revoke failure is surfaced without rolling the setting
      // back, preventing a failed drain from silently re-enabling the runtime for new work.
      if (!request.enabled) {
        await deps.onRuntimeDisabled?.(request.language, request.envId, request.force)
      }
      return next
    },
    setInstallAuthorized: (request) =>
      deps.settingsService.setInstallAuthorized(
        request.language,
        request.envId,
        request.authorized
      ),
    uninstallManagedEnvironment: async (request) => {
      if (!deps.uninstallManagedEnvironment) {
        throw new Error('Managed Runtime uninstall is unavailable.')
      }
      const defaultRuntimeIds = managedDefaultRuntimeIdentities(
        deps.runtimeRoot(),
        request.language,
        deps.platform
      ).map(({ runtimeId }) => runtimeId)
      const managed = (await discoverLanguageEnvs(request.language)).find(
        isCurrentAppManagedDefault
      )
      if (managed) {
        const usage = deps.describeRuntimeUsage?.(request.language, managed.envId) ?? {
          running: 0,
          idle: 0,
          dormant: 0
        }
        if (usage.running > 0) {
          throw new Error(
            `RUNTIME_UNINSTALL_IN_USE: the ${request.language} Runtime is running work. Wait for it to finish before uninstalling.`
          )
        }
      }
      await deps.uninstallManagedEnvironment(request.language, async () => {
        if (managed) {
          await deps.settingsService.setEnvironmentEnabled(request.language, managed.envId, false)
        }
        for (const runtimeId of defaultRuntimeIds) {
          if (managed?.envId === runtimeId) continue
          await deps.settingsService.setEnvironmentEnabled(request.language, runtimeId, false)
        }
      })
      invalidateDiscovery()
    },
    register: async (request) => {
      const result = await deps.settingsService.addManualInterpreter(request.language, request.path)
      invalidateDiscovery()
      return result
    },
    unregister: async (request) => {
      const result = await deps.settingsService.removeManualInterpreter(
        request.language,
        request.path
      )
      invalidateDiscovery()
      return result
    }
  }
}

export { createRuntimeSelectionWorkflows }
export type { RuntimeSelectionWorkflowDeps, RuntimeSelectionWorkflows }

import type { NotebookLanguage } from '../../shared/notebook'
import type {
  RuntimeEnablement,
  RuntimeSelection,
  RuntimeSurvey,
  RuntimeUsage
} from '../../shared/notebook-runtime'
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
import { RuntimeRegistry } from './runtime-registry'
import { prepareExternalPythonRuntime, type AppOwnedExternalSelection } from './venv-overlay'

type RuntimeRegistryPort = Pick<RuntimeRegistry, 'survey' | 'readiness'>

// Settings presents languages in this order; keep survey results stable for existing callers.
const RUNTIME_LANGUAGES: readonly NotebookLanguage[] = ['python', 'r']

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
}

type RuntimeSelectionWorkflows = {
  survey(): Promise<RuntimeSurvey[]>
  listEnvironments(): Promise<{
    python: DiscoveredInterpreter[]
    r: DiscoveredInterpreter[]
  }>
  getEnablement(request: { language: NotebookLanguage }): Promise<RuntimeEnablement>
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

  return {
    survey: () => Promise.all(RUNTIME_LANGUAGES.map(buildSurvey)),
    listEnvironments: async () => {
      // Discovery expects a synchronous manual-path lookup, so snapshot both persisted catalogs first.
      const [manualPython, manualR] = await Promise.all([
        deps.settingsService.getManualInterpreters('python'),
        deps.settingsService.getManualInterpreters('r')
      ])
      const discovery = defaultDiscoveryDeps(deps.runtimeRoot(), (language) =>
        language === 'python' ? manualPython : manualR
      )
      const [python, r] = await Promise.all([
        discoverInterpreters('python', discovery),
        discoverInterpreters('r', discovery)
      ])
      return { python, r }
    },
    getEnablement: (request) => deps.settingsService.getRuntimeEnablement(request.language),
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
    register: (request) =>
      deps.settingsService.addManualInterpreter(request.language, request.path),
    unregister: (request) =>
      deps.settingsService.removeManualInterpreter(request.language, request.path)
  }
}

export { createRuntimeSelectionWorkflows }
export type { RuntimeSelectionWorkflowDeps, RuntimeSelectionWorkflows }

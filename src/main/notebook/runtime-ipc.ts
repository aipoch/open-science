import { dialog, ipcMain } from 'electron'

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

// The languages the Runtime Selection UI surveys, in display order. R stays managed-only in v1 (the
// external resolver + overlay are Python-specific), enforced at persistence in the settings layer.
const RUNTIME_LANGUAGES: readonly NotebookLanguage[] = ['python', 'r']

// What the runtime IPC surface needs. `runtimeRoot` is a lazy getter (not a value) so a data-root
// switch is picked up without re-registering; it MUST resolve to the same root the executor/service
// use (getRuntimeRoot(<dataRoot>)). `settingsService` is the read/write seam for the persisted choice.
export type RuntimeIpcDeps = {
  settingsService: {
    getRuntimeSelection: (language: NotebookLanguage) => Promise<RuntimeSelection | undefined>
    setRuntimeSelection: (
      language: NotebookLanguage,
      selection: RuntimeSelection | null
    ) => Promise<RuntimeSelection | undefined>
    // v4 environment enablement (per-env enabled override + install-auth, keyed by envId).
    getRuntimeEnablement: (language: NotebookLanguage) => Promise<RuntimeEnablement>
    setEnvironmentEnabled: (
      language: NotebookLanguage,
      envId: string,
      enabled: boolean
    ) => Promise<RuntimeEnablement>
    setInstallAuthorized: (
      language: NotebookLanguage,
      envId: string,
      authorized: boolean
    ) => Promise<RuntimeEnablement>
    // v4 manual-interpreter catalog (paths added via "Add interpreter…"), merged into discovery.
    getManualInterpreters: (language: NotebookLanguage) => Promise<string[]>
    addManualInterpreter: (language: NotebookLanguage, path: string) => Promise<string[]>
    removeManualInterpreter: (language: NotebookLanguage, path: string) => Promise<string[]>
  }
  // The app runtime root (<dataRoot>/runtime); read lazily so a data-root switch is picked up.
  runtimeRoot: () => string
  // Injectable for tests; production defaults to the Electron native open-file dialog.
  showOpenDialog?: () => Promise<string | null>
  // Injectable for tests so survey never spawns a real interpreter; defaults to the managed +
  // external adapters wired to the real detectors.
  registry?: RuntimeRegistry
  // Prepares an app-owned overlay before its selection is persisted. Production injects mirror/CA
  // policy; tests inject a hermetic implementation.
  prepareExternalPython?: (
    selection: AppOwnedExternalSelection,
    runtimeRoot: string
  ) => Promise<void>
  // WS10: called after a runtime is DISABLED, so the notebook service can revoke it from any live
  // session bound to it (mark the binding unavailable/disabled; no silent fallback). Optional so tests
  // that don't exercise the lifecycle can omit it.
  onRuntimeDisabled?: (language: NotebookLanguage, envId: string, force?: boolean) => Promise<void>
  // WS11: how many live sessions are bound to a runtime (running/idle/dormant), so the disable
  // affordance can warn about impact before revoking. Optional; defaults to all-zero when unwired.
  describeRuntimeUsage?: (language: NotebookLanguage, envId: string) => RuntimeUsage
}

// Registers the renderer-callable runtime-selection commands: survey both languages, persist a
// per-language choice (returning the refreshed survey so the UI updates in one shot), and pick an
// interpreter file via the native dialog. Mirrors the storage IPC module.
const registerRuntimeIpcHandlers = (deps: RuntimeIpcDeps): void => {
  const registry =
    deps.registry ??
    new RuntimeRegistry({
      managed: createManagedAdapter({ runtimeRoot: deps.runtimeRoot }),
      external: createExternalAdapter(defaultExternalAdapterDeps())
    })

  // One language's full picture: the persisted choice plus a survey of BOTH sources. When an external
  // interpreter is actually SELECTED, its readiness must reflect THAT interpreter — survey()'s external
  // branch auto-detects a PATH interpreter (selection-less), which may differ from the chosen path — so
  // fold in readiness(selection), which passes the persisted path through to the adapter.
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

  ipcMain.handle('runtime:survey', (): Promise<RuntimeSurvey[]> =>
    Promise.all(RUNTIME_LANGUAGES.map(buildSurvey))
  )

  // v4 environment discovery: every detected interpreter (PATH / common dirs / pyenv / conda / app
  // envs) per language, for the Settings cards. Standard-location-only enumeration (no disk walk).
  ipcMain.handle(
    'runtime:list-environments',
    async (): Promise<{ python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }> => {
      // Snapshot the manual-interpreter catalog for both languages, then feed it into discovery as a
      // sync getter so a manually-added interpreter is probed + surfaced alongside detected ones.
      const [manualPy, manualR] = await Promise.all([
        deps.settingsService.getManualInterpreters('python'),
        deps.settingsService.getManualInterpreters('r')
      ])
      const discovery = defaultDiscoveryDeps(deps.runtimeRoot(), (language) =>
        language === 'python' ? manualPy : manualR
      )
      const [python, r] = await Promise.all([
        discoverInterpreters('python', discovery),
        discoverInterpreters('r', discovery)
      ])
      return { python, r }
    }
  )

  ipcMain.handle(
    'runtime:set-selection',
    async (
      _event,
      request: { language: NotebookLanguage; selection: RuntimeSelection | null }
    ): Promise<RuntimeSurvey> => {
      // Validate an external (BYO) selection BEFORE persisting: an interpreter that is not a runnable
      // Python 3 (a non-Python file, python2, a wrong/too-old version, a moved path) must never be
      // saved, or a later cell run would try to execute it. readiness() probes the selected path via the
      // external adapter. The managed source is runnable-by-provisioning, so it skips the probe.
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
    }
  )

  // v4: the persisted per-language enablement (explicit enabled-overrides + install-auth), so the
  // Settings cards reflect the SAVED state on load rather than re-deriving from provenance defaults.
  ipcMain.handle(
    'runtime:get-enablement',
    async (_event, request: { language: NotebookLanguage }): Promise<RuntimeEnablement> =>
      deps.settingsService.getRuntimeEnablement(request.language)
  )

  // WS11: live-session usage of a runtime (running/idle/dormant), so the disable affordance can warn
  // about impact before revoking. Unwired -> all-zero (no live sessions to consider).
  ipcMain.handle(
    'runtime:describe-usage',
    async (_event, request: { language: NotebookLanguage; envId: string }): Promise<RuntimeUsage> =>
      deps.describeRuntimeUsage?.(request.language, request.envId) ?? {
        running: 0,
        idle: 0,
        dormant: 0
      }
  )

  // v4: set one env's explicit enabled override for a language. Disabling any env — including the last
  // enabled one — is allowed: a language with zero enabled runtimes is a valid user choice (R is
  // optional; a user may want only their own interpreter). The agent is not left broken silently —
  // resolveEnabledRuntime refuses a bind/execute with an actionable "enable one in Settings" message —
  // so there is no need to trap the user in an undisablable toggle here. Returns the refreshed
  // enablement so the UI updates in one shot.
  ipcMain.handle(
    'runtime:set-environment-enabled',
    async (
      _event,
      request: { language: NotebookLanguage; envId: string; enabled: boolean; force?: boolean }
    ): Promise<RuntimeEnablement> => {
      const next = await deps.settingsService.setEnvironmentEnabled(
        request.language,
        request.envId,
        request.enabled
      )
      // WS10: revoke a just-disabled runtime from any live session bound to it. force -> abort the
      // running cell now ("stop running work"); default -> drain then close.
      if (!request.enabled) {
        await deps.onRuntimeDisabled?.(request.language, request.envId, request.force)
      }
      return next
    }
  )

  // v4: set one env's high-risk package-install authorization for a language. Independent of the enabled
  // gate (execute-after-enable stays read-only until this is turned on). Returns the refreshed enablement.
  ipcMain.handle(
    'runtime:set-install-authorized',
    async (
      _event,
      request: { language: NotebookLanguage; envId: string; authorized: boolean }
    ): Promise<RuntimeEnablement> =>
      deps.settingsService.setInstallAuthorized(request.language, request.envId, request.authorized)
  )

  ipcMain.handle('runtime:pick-interpreter', async (): Promise<string | null> => {
    try {
      if (deps.showOpenDialog) return await deps.showOpenDialog()
      const result = await dialog.showOpenDialog({ properties: ['openFile'] })
      return result.filePaths[0] ?? null
    } catch (err) {
      // Never let a picker failure surface as a raw rejection to the renderer; the choose action
      // becomes a no-op instead.
      console.error('[runtime-ipc] pick-interpreter failed', err)
      return null
    }
  })

  // v4: add a manually-picked interpreter path to the Settings catalog so discovery surfaces it as an
  // (initially user-own, disabled) runtime card. Returns the refreshed catalog for that language.
  ipcMain.handle(
    'runtime:register-interpreter',
    async (_event, request: { language: NotebookLanguage; path: string }): Promise<string[]> =>
      deps.settingsService.addManualInterpreter(request.language, request.path)
  )

  // v4: drop a manually-added interpreter from the catalog (it disappears from discovery unless it is
  // still detected by another source). Returns the refreshed catalog.
  ipcMain.handle(
    'runtime:unregister-interpreter',
    async (_event, request: { language: NotebookLanguage; path: string }): Promise<string[]> =>
      deps.settingsService.removeManualInterpreter(request.language, request.path)
  )
}

export { registerRuntimeIpcHandlers }

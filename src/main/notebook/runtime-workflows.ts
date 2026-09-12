import type { NotebookLanguage } from '../../shared/notebook'
import type { EnvPackage, RuntimeEnablement, RuntimeUsage } from '../../shared/notebook-runtime'
import {
  defaultDiscoveryDeps,
  discoverInterpreters,
  rscriptFor,
  type DiscoveredInterpreter
} from './environment-discovery'
import { listEnvPackages } from './package-listing'
import { discoverExternalRLibraries, resolveExternalRLibrary } from './external-r-library'
import type { MicromambaRunner } from './windows-micromamba-runner'
import { isMigrationInProgress, withDataRootWrite } from '../storage/migration-state'

// Upper bound on concurrent package listings inside listPackageCounts (mirrors the bounded
// probe concurrency in environment-discovery): enough to fill the Settings badges quickly without
// a subprocess storm.
const PACKAGE_COUNT_CONCURRENCY = 4

// Persisted runtime state remains Settings-owned. This narrow port keeps the workflows independent of
// the broader Settings module while preserving its normalized read-after-write behavior.
type RuntimeSettings = {
  getRuntimeEnablement(language: NotebookLanguage): Promise<RuntimeEnablement>
  setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement>
  setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean,
    library?: string
  ): Promise<RuntimeEnablement>
  getAgentEnvironmentCreationEnabled(): Promise<boolean>
  setAgentEnvironmentCreationEnabled(enabled: boolean): Promise<boolean>
  getManualInterpreters(language: NotebookLanguage): Promise<string[]>
  addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
  removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
}

type RuntimeWorkflowDeps = {
  settingsService: RuntimeSettings
  onPolicyChanged?: () => void
  // Resolve lazily so a data-root switch reaches discovery immediately.
  runtimeRoot: () => string
  // Called only after disabled state is durable; force chooses stop-now instead of drain-and-close.
  onRuntimeDisabled?: (language: NotebookLanguage, envId: string, force?: boolean) => Promise<void>
  // Optional because sessions may not be composed yet during startup; absence means no live usage.
  describeRuntimeUsage?: (language: NotebookLanguage, envId: string) => RuntimeUsage
  // Injectable for tests so the package-listing workflows never spawn micromamba/pip/Rscript;
  // production defaults to listEnvPackages against the real env.
  listPackages?: (env: DiscoveredInterpreter) => Promise<EnvPackage[]>
  discoverRLibraries?: (interpreterPath: string) => Promise<string[]>
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  setWindowsRuntimeAccess?: (
    executable: string,
    authorized: boolean
  ) => Promise<{ cancelled: boolean }>
}

type RuntimeWorkflows = {
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
    library?: string
  }): Promise<RuntimeEnablement>
  register(request: { language: NotebookLanguage; path: string }): Promise<string[]>
  setSandboxAccess(request: {
    language: NotebookLanguage
    envId: string
    authorized: boolean
  }): Promise<{ cancelled: boolean }>
  unregister(request: { language: NotebookLanguage; path: string }): Promise<string[]>
}

const createRuntimeWorkflows = (deps: RuntimeWorkflowDeps): RuntimeWorkflows => {
  let runtimeAccessUpdate = false
  const runRuntimeChange = async <T>(
    language: NotebookLanguage,
    operation: () => Promise<T>
  ): Promise<T> => {
    if (language !== 'r' || !deps.setWindowsRuntimeAccess) return operation()
    if (isMigrationInProgress()) {
      throw new Error(
        'Open Science is moving your data. Wait for the move to finish before running this.'
      )
    }
    if (runtimeAccessUpdate)
      throw new Error('An R runtime permission change is already in progress.')
    runtimeAccessUpdate = true
    try {
      return await withDataRootWrite(operation)
    } finally {
      runtimeAccessUpdate = false
    }
  }
  let discoveredSnapshot:
    { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] } | undefined
  let discoveredRuntimeRoot: string | undefined

  const invalidateDiscovery = (): void => {
    discoveredSnapshot = undefined
    discoveredRuntimeRoot = undefined
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
    setSandboxAccess: async (request) =>
      runRuntimeChange(request.language, async () => {
        if (request.language !== 'r' || !deps.setWindowsRuntimeAccess)
          throw new Error('Selected-runtime sandbox access is only available for Windows R.')
        const env = (await discoverLanguageEnvs('r')).find(
          (candidate) => candidate.envId === request.envId
        )
        if (!env || env.provenance === 'agent-created')
          throw new Error('Select a discovered managed or external R runtime.')
        if (request.authorized && !env.runnable)
          throw new Error('R must be runnable with jsonlite before verifying sandbox access.')
        if (!request.authorized) {
          await deps.settingsService.setEnvironmentEnabled('r', env.envId, false)
          await deps.onRuntimeDisabled?.('r', env.envId)
        }
        return deps.setWindowsRuntimeAccess(rscriptFor(env.interpreterPath), request.authorized)
      }),
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
      const externalR = r.filter((env) => env.provenance === 'user-own' && env.runnable)
      const libraries = new Map<string, string[]>()
      let next = 0
      const worker = async (): Promise<void> => {
        for (let i = next++; i < externalR.length; i = next++) {
          const env = externalR[i]
          try {
            libraries.set(
              env.envId,
              await (deps.discoverRLibraries ?? discoverExternalRLibraries)(env.interpreterPath)
            )
          } catch {
            // A failed optional probe must not hide an otherwise usable interpreter.
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(PACKAGE_COUNT_CONCURRENCY, externalR.length) }, worker)
      )
      discoveredRuntimeRoot = currentRuntimeRoot
      discoveredSnapshot = {
        python,
        r: r.map((env) => ({ ...env, personalRLibraries: libraries.get(env.envId) }))
      }
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
    setAgentEnvironmentCreationEnabled: async (request) => {
      if (typeof request?.enabled !== 'boolean') {
        throw new TypeError('Agent environment creation enabled must be a boolean.')
      }
      const enabled = await deps.settingsService.setAgentEnvironmentCreationEnabled(request.enabled)
      deps.onPolicyChanged?.()
      return enabled
    },
    describeUsage: async (request) =>
      deps.describeRuntimeUsage?.(request.language, request.envId) ?? {
        running: 0,
        idle: 0,
        dormant: 0
      },
    setEnvironmentEnabled: async (request) =>
      runRuntimeChange(request.language, async () => {
        const next = await deps.settingsService.setEnvironmentEnabled(
          request.language,
          request.envId,
          request.enabled
        )
        // Persist disable before revocation. A revoke failure is surfaced without rolling the setting
        // back, preventing a failed drain from silently re-enabling the runtime for new work.
        if (!request.enabled) {
          await deps.onRuntimeDisabled?.(request.language, request.envId, request.force)
          if (request.language === 'r' && deps.setWindowsRuntimeAccess) {
            const env = (await discoverLanguageEnvs('r')).find(
              (candidate) => candidate.envId === request.envId
            )
            if (env && env.provenance !== 'agent-created') {
              const result = await deps.setWindowsRuntimeAccess(
                rscriptFor(env.interpreterPath),
                false
              )
              if (result.cancelled)
                throw new Error(
                  'R was disabled, but permission removal was cancelled. Retry removing its sandbox access.'
                )
            }
          }
        }
        return next
      }),
    setInstallAuthorized: async (request) => {
      let library: string | undefined
      if (request.language === 'r' && request.authorized) {
        const runtime = (await discoverLanguageEnvs('r')).find((env) => env.envId === request.envId)
        if (!runtime || runtime.provenance !== 'user-own' || !runtime.runnable)
          throw new Error('Select a runnable external R runtime.')
        library = await resolveExternalRLibrary(request.library ?? '')
        const candidates = await (deps.discoverRLibraries ?? discoverExternalRLibraries)(
          runtime.interpreterPath
        )
        const same = (path: string): string =>
          process.platform === 'win32' ? path.toLowerCase() : path
        if (!candidates.some((path) => same(path) === same(library!)))
          throw new Error('Select an existing personal library visible to this R runtime.')
      }
      return deps.settingsService.setInstallAuthorized(
        request.language,
        request.envId,
        request.authorized,
        ...(request.language === 'r' ? [library] : [])
      )
    },
    register: async (request) => {
      const result = await deps.settingsService.addManualInterpreter(request.language, request.path)
      invalidateDiscovery()
      return result
    },
    unregister: async (request) =>
      runRuntimeChange(request.language, async () => {
        if (request.language === 'r' && deps.setWindowsRuntimeAccess) {
          const env = (await discoverLanguageEnvs('r')).find(
            (candidate) => candidate.interpreterPath === request.path
          )
          if (env) {
            await deps.settingsService.setEnvironmentEnabled('r', env.envId, false)
            await deps.onRuntimeDisabled?.('r', env.envId)
          }
          const result = await deps.setWindowsRuntimeAccess(rscriptFor(request.path), false)
          if (result.cancelled)
            throw new Error(
              'R permission removal was cancelled; the interpreter remains registered.'
            )
        }
        const result = await deps.settingsService.removeManualInterpreter(
          request.language,
          request.path
        )
        invalidateDiscovery()
        return result
      })
  }
}

export { createRuntimeWorkflows }
export type { RuntimeWorkflowDeps, RuntimeWorkflows }

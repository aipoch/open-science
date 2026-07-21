import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { app, ipcMain } from 'electron'

import { createDefaultNotebookRuntimeService, registerAcpIpcHandlers } from './acp/ipc'
import { createDefaultArtifactRepository, registerArtifactIpcHandlers } from './artifacts/ipc'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { registerComputeIpcHandlers, createJobUpdatedBroadcaster } from './compute/ipc'
import { attachEnabledComputeHosts } from './compute/enabled-hosts-registry'
import { JobPoller } from './compute/job-poller'
import { SystemSshRunner } from './compute/ssh-runner'
import { wireConnectorReload } from './connector-reload'
import { ApprovalBroker } from './connectors/approval-broker'
import { toCustomMcpConfig, selectEnabledCustomServers } from './connectors/custom-mcp-bootstrap'
import { McpClientManager } from './connectors/mcp-client-manager'
import { createMoleculePreviewHandler } from './connectors/molecule-preview'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { ConnectorService } from './connectors/service'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './connectors/provision'
import { registerFileSaveHandlers } from './file-save'
import { registerCliInstallIpcHandlers } from './cli-install/ipc'
import { registerGithubIpcHandlers } from './github-ipc'
import { BackendShutdownCoordinator, UPDATE_SHUTDOWN_BUDGET_MS } from './lifecycle-shutdown'
import { registerLogsIpcHandlers } from './logs-ipc'
import { registerWindowIpcHandlers } from './window-ipc'
import { createLogger } from './logger'
import {
  broadcastNotebookEnvProgress,
  registerNotebookEnvIpcHandlers,
  serializeProvisioner
} from './notebook/env-ipc'
import { registerManagedPreviewIpcHandlers } from './managed-preview-ipc'
import { registerManagedPreviewProtocol } from './managed-preview-protocol'
import { ManagedPreviewResources } from './managed-preview-resources'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { registerRuntimeIpcHandlers } from './notebook/runtime-ipc'
import { getRuntimeRoot } from './notebook/repository'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { effectiveMirrorAsync } from './notebook/mirror-probe'
import { createProductionProvisioner, type RuntimeProvisioner } from './notebook/provisioner'
import { runtimeRoot } from './notebook/runtime-paths'
import type { NotebookEnvironmentManager } from './notebook/runtime-service'
import type { NotebookLanguage } from '../shared/notebook'
import { prepareExternalPythonRuntime } from './notebook/venv-overlay'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  registerProjectIpcHandlers
} from './projects/ipc'
import { registerReviewerIpcHandlers } from './reviewer/ipc'
import {
  createDefaultSessionRepository,
  registerSessionPersistenceIpcHandlers
} from './session-persistence/ipc'
import { tryDecryptKey } from './settings/crypto'
import { registerSettingsIpcHandlers } from './settings/ipc'
import { getAppClaudeConfigDir } from './settings/provider-env'
import { createDefaultSettingsService, type SettingsService } from './settings/service'
import type { StoredConnectors } from './settings/types'
import { registerStorageIpcHandlers } from './storage/ipc'
import { normalizeLegacyDataPaths } from './storage/normalize-legacy-paths'
import {
  computeDefaultDataRoot,
  initDataRoot,
  resolveDataRoot,
  resolveStorageRoot,
  samePath
} from './storage-root'
import { registerUpdateIpcHandlers } from './update/ipc'
import { startUpdateScheduler } from './update/scheduler'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './uploads/ipc'
import { broadcastToRenderers } from './renderer-broadcast'

type IpcRegistrationOptions = {
  mainEntryPath: string
}

// Builds a short, human-readable preview of a connector call's arguments for the approval card.
const previewArgs = (args: Record<string, unknown>): string => {
  let json: string
  try {
    json = JSON.stringify(args)
  } catch {
    json = '{…}'
  }
  return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

// Reads the connectors settings block and refreshes the mcp-<connector>/mcp-<server> skill docs to
// match — both the bundled catalog and any enabled custom MCP servers (stdio + remote). Called at
// startup;
// a future connectors-settings mutation (Plan 2/5 UI) should call this again so enable/disable
// (bundled or custom) takes effect without an app restart. Never throws — a bad read or a
// misconfigured/unreachable custom server (e.g. bad command) is logged and leaves the previous
// snapshot and on-disk docs in place rather than breaking bootstrap.
const refreshConnectorSkillDocs = async (
  settingsService: SettingsService,
  storageRoot: string,
  mcpClientManager: McpClientManager,
  onSnapshot: (connectors: StoredConnectors | undefined) => void
): Promise<void> => {
  try {
    const connectors = await settingsService.getConnectors()

    onSnapshot(connectors)
    const skillsDir = join(getAppClaudeConfigDir(storageRoot), 'skills')

    // Opt-out model: every bundled connector is enabled unless explicitly disabled.
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])
    const enabledIds = ALL_CONNECTOR_IDS.filter((id) => !disabled.has(id))

    await syncConnectorSkillDocs(skillsDir, enabledIds)
    await syncCustomServerSkillDocs(skillsDir, selectEnabledCustomServers(connectors), (server) =>
      mcpClientManager.listTools(toCustomMcpConfig(server))
    )
  } catch (error) {
    console.error('Failed to sync connector skill docs:', error)
  }
}

// Registers every main-process IPC surface used by the renderer. Async because the notebook-env gate
// needs the configured package mirror, read from disk; callers await this before creating the main
// window so every IPC channel (incl. notebook-env) is registered before the renderer can call it.
const registerIpcHandlers = async ({
  mainEntryPath
}: IpcRegistrationOptions): Promise<{
  runtime: ReturnType<typeof registerAcpIpcHandlers>
  notebook: ReturnType<typeof createDefaultNotebookRuntimeService>
  shutdownCoordinator: BackendShutdownCoordinator
}> => {
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const settingsService = createDefaultSettingsService()
  const storedSettings = await settingsService.getStoredSettings()
  // Prime the data-root cache from settings before any data repository is constructed below. A change
  // to this value only takes effect after a restart, so reading it once here is sufficient.
  initDataRoot(storedSettings.dataRoot)
  // Recovery breadcrumb: if settings.json is ever lost/corrupted, the resolved dataRoot from the
  // last successful launch is still findable in the logs, so a user with data at a non-default
  // location isn't left guessing where it went.
  createLogger('storage').info('data root resolved', {
    dataRoot: resolveDataRoot(),
    isDefault: samePath(resolveDataRoot(), computeDefaultDataRoot())
  })

  // Constructed once here (rather than left to each register*IpcHandlers' own default) so the
  // one-time legacy-path normalization pass below can share the exact instances the IPC surface uses.
  const sessionRepository = createDefaultSessionRepository()
  const projectRepository = createDefaultProjectRepository()
  const previewStateRepository = createDefaultPreviewStateRepository()

  // One-time conversion of any legacy absolute data-root paths on disk (pre-$DATA-sentinel installs)
  // into the portable "$DATA/..." form, guarded so it only ever runs once. Never allowed to block
  // startup on failure: an error is logged and the marker stays unset, so the pass simply retries on
  // the next launch.
  if (!storedSettings.pathsNormalizedAt) {
    try {
      await normalizeLegacyDataPaths({
        sessionRepository,
        previewStateRepository,
        projectRepository,
        dataRoot: resolveDataRoot()
      })
      await settingsService.markPathsNormalized()
    } catch (error) {
      createLogger('storage').error(
        'legacy path normalization failed; will retry next launch',
        error
      )
    }
  }

  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const artifactRunRegistry = new ArtifactRunRegistry()
  // Share one upload repository so composer staging, prompt finalization, and previews agree.
  const uploadRepository = createDefaultUploadRepository()
  // One source-neutral resolver keeps previews and user-requested exports on identical trust checks.
  const resolveManagedFilePath = (
    source: 'artifact' | 'upload',
    request: { path: string }
  ): Promise<string> =>
    source === 'artifact'
      ? artifactRepository.resolveManagedFilePath(request)
      : uploadRepository.resolveManagedUploadPath(request)
  // One registry owns short-lived capability URLs for both managed artifact repositories.
  const previewResources = new ManagedPreviewResources({
    resolvePath: resolveManagedFilePath
  })
  const notebookService = createDefaultNotebookRuntimeService()

  // Read fresh on every call so a future connectors-settings mutation (Plan 2 UI) only needs to call
  // refreshConnectorSkillDocs again to take effect, without reconstructing the connector service.
  let connectorsSnapshot: StoredConnectors | undefined
  // One MCP client manager backs both dispatch (ConnectorService.call → custom server) and skill-doc
  // generation (listTools) for user-added custom MCP servers (stdio + remote). It lazily connects per
  // server, so constructing it here does not spawn anything until a custom server is actually used.
  const mcpClientManager = new McpClientManager()
  // Bridges un-trusted connector calls to the renderer approval card. A tool call that isn't
  // pre-allowed or skip-approved is held here until the user decides (or it auto-denies on timeout).
  const approvalBroker = new ApprovalBroker({
    generateId: () => randomUUID(),
    broadcast: (request) => {
      broadcastToRenderers('connectors:approval-request', request)
    }
  })
  // Late-bound app runtime for connector tools that attach a generated file to the current turn. The
  // runtime is created below (it depends on the connector service), so the handler resolves it lazily.
  const runtimeRef: { current: ReturnType<typeof registerAcpIpcHandlers> | undefined } = {
    current: undefined
  }
  const moleculePreviewHandler = createMoleculePreviewHandler({
    writeArtifactForCurrentRun: (sessionId, input) => {
      if (!runtimeRef.current) throw new Error('Artifact runtime is not initialized.')
      return runtimeRef.current.writeArtifactForCurrentRun(sessionId, input)
    }
  })
  const connectorService = new ConnectorService({
    getConnectors: () => connectorsSnapshot,
    resolveApiKey: (ref) => tryDecryptKey(ref),
    mcpClientManager,
    requestApproval: ({ connector, method, args }) =>
      approvalBroker.request({ connector, method, argsPreview: previewArgs(args) }),
    localToolHandlers: { 'molecule/preview_molecule': moleculePreviewHandler }
  })
  // Register compute IPC handlers early so computeService can be wired into the notebook RPC server.
  // The approval broker in compute/ipc.ts broadcasts via BrowserWindow.getAllWindows(), which requires
  // Electron to be ready — this is always the case here since we're inside registerIpcHandlers.
  // Adapt the artifact repository to the ArtifactResolver shape so job input staging can upload
  // absolute artifact-store paths (validated to stay inside the store by resolveManagedFilePath).
  const computeArtifactResolver = {
    resolveArtifactPath: (path: string) => artifactRepository.resolveManagedFilePath({ path })
  }
  const {
    computeService,
    jobRepository,
    hostRepository,
    enabledComputeHostsRegistry: hostsRegistry
  } = registerComputeIpcHandlers(undefined, undefined, computeArtifactResolver)
  // Start the JobPoller wired to the shared broadcaster so every state/tail change is pushed to all
  // renderer windows via 'compute:job-updated' (Phase 3d, design.md §9 + §15.3). The dispatcher
  // (inside ComputeService) uses the same hook, so submitted→running/error transitions broadcast too.
  const jobPoller = new JobPoller({
    runner: new SystemSshRunner(),
    hostRepository,
    jobRepository,
    onJobUpdated: createJobUpdatedBroadcaster(hostRepository)
  })
  jobPoller.start()
  // Augment computeService with getEnabledComputeHosts so the RPC server can serve list_compute.
  // Must preserve ComputeService's prototype methods (list/getDetails/submitJob/...) — see the helper.
  const computeServiceWithRegistry = attachEnabledComputeHosts(computeService, hostsRegistry)
  const notebookRpcServer = new NotebookLocalRpcServer(notebookService, {
    connectorService,
    computeService: computeServiceWithRegistry
  })
  // The RPC server needs the runtime service to dispatch to, and the runtime service needs the RPC
  // server's (lazily-started) connection for host.mcp() env injection — wire the second half here to
  // avoid a construction cycle.
  notebookService.setMcpRpcConnectionResolver(() => notebookRpcServer.ensureStarted())
  // Same construction-order constraint as the RPC connection above: the runtime service is created
  // before the settings service, so the package-mirror lookup is wired in after the fact.
  notebookService.setPackageMirrorResolver(() => settingsService.getPackageMirror())
  // v4 per-language enablement (which discovered runtimes the agent may bind). Same construction-order
  // reason as above; unwired -> the provenance defaults keep the enable gate closed for BYO envs.
  notebookService.setRuntimeEnablementResolver((language) =>
    settingsService.getRuntimeEnablement(language)
  )
  // Fold the manually-added interpreter catalog into the service's discovery too, so an interpreter
  // added via "Add interpreter…" (not on PATH) is bindable by the agent and survives a restart instead
  // of resolving to 'missing'. Same construction-order reason as the resolvers above.
  notebookService.setManualInterpretersResolver((language) =>
    settingsService.getManualInterpreters(language)
  )

  // The renderer's approval card responds here; the broker resolves the held connector call.
  ipcMain.handle(
    'connectors:approval-respond',
    (_event, request: { id: string; decision: 'allow' | 'deny' }) => {
      approvalBroker.respond(request.id, request.decision)
    }
  )

  void refreshConnectorSkillDocs(
    settingsService,
    resolveStorageRoot(),
    mcpClientManager,
    (connectors) => {
      connectorsSnapshot = connectors
    }
  )

  registerFileSaveHandlers({ resolveManagedFilePath })
  registerLogsIpcHandlers()
  registerGithubIpcHandlers()
  registerCliInstallIpcHandlers()
  registerWindowIpcHandlers()
  const updateService = registerUpdateIpcHandlers()
  startUpdateScheduler(updateService)
  const runtime = registerAcpIpcHandlers({
    mcpEntryPath: mainEntryPath,
    repository: artifactRepository,
    runRegistry: artifactRunRegistry,
    uploadRepository,
    notebookRpcServer,
    settingsService
  })
  runtimeRef.current = runtime
  // Single shared teardown owner for both the before-quit handler (index.ts) and the pre-update-install
  // gate. Built here because it needs the runtime, which does not exist when update IPC is registered
  // above — so the gate is injected via a late-bound closure rather than at strategy construction.
  const shutdownCoordinator = new BackendShutdownCoordinator({
    runtime,
    notebook: notebookService,
    log: createLogger('shutdown')
  })
  // Reap the agent + kernel trees before an in-place install so the NSIS uninstall step never hits files
  // still locked by a background child. Non-latching, so a refused (degraded) install leaves the app
  // usable. No-op on the manifest fallback strategy, which does not implement setInstallGate.
  updateService.setInstallGate?.(() =>
    shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS)
  )
  // Switching the active provider takes effect on the next reconnect. Defer that reconnect until any
  // in-flight prompt finishes so switching never interrupts a running turn; the shared config dir keeps
  // the conversation's context across the switch.
  registerSettingsIpcHandlers({
    service: settingsService,
    onActiveProviderChanged: () => void runtime.requestProviderReconnect(),
    onSkillsChanged: () => void runtime.requestSkillsReload(),
    // Re-sync bundled + custom skill docs and refresh the in-memory snapshot the connector
    // service reads, then request a skills reload. The reload respawns the agent on next idle so a
    // non-Claude framework (Codex, opencode) — whose connector docs are materialized into its own
    // home at spawn — picks up the change too, not just the Claude config dir.
    onConnectorsChanged: () =>
      void wireConnectorReload(
        () =>
          refreshConnectorSkillDocs(
            settingsService,
            resolveStorageRoot(),
            mcpClientManager,
            (connectors) => {
              connectorsSnapshot = connectors
            }
          ),
        () => void runtime.requestSkillsReload()
      )
  })
  registerNotebookIpcHandlers(notebookService)
  // Runtime selection UI (Settings/Onboarding): survey managed+external per language, persist the
  // choice, and pick an interpreter file. The runtime root MUST match the executor/service's
  // (getRuntimeRoot(<dataRoot>)); read lazily so a data-root switch is reflected without re-register.
  registerRuntimeIpcHandlers({
    settingsService,
    runtimeRoot: () => getRuntimeRoot(resolveDataRoot()),
    // WS10: revoke a disabled runtime from any live session bound to it (mark binding unavailable).
    onRuntimeDisabled: (language, envId, force) =>
      notebookService.revokeRuntime(language, envId, { force }),
    // WS11: live-session usage of a runtime, for the disable-impact warning.
    describeRuntimeUsage: (language, envId) =>
      notebookService.describeRuntimeUsage(language, envId),
    prepareExternalPython: async (selection, root) => {
      const configuredMirror = await settingsService.getPackageMirror()
      const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
      await prepareExternalPythonRuntime(selection, root, {
        pypiIndex: mirror.pypiIndex,
        caBundle: mirror.caBundle
      })
    }
  })
  registerManagedPreviewIpcHandlers(previewResources)
  registerManagedPreviewProtocol(previewResources)

  // Resolve the shared conda base under the app data root (relocatable, where the runtime install
  // lives) and start the env readiness gate. The conda channel comes from the effective package mirror
  // (configured override, else the region default from locale). Runtime packs use the official CDN base
  // with OPEN_SCIENCE_ENV_CDN_BASE available for private/self-hosted deployments.
  const provisioningRoot = runtimeRoot(resolveDataRoot())
  // Build the provisioner separately from registering the IPC surface: if construction fails (e.g.
  // micromamba missing in dev), `provisioner` stays undefined but the notebook-env handlers are STILL
  // registered below (as unavailable stubs), so the renderer gets an actionable "runtime unavailable"
  // status/error instead of a hard "No handler registered for notebook-env:provision" crash.
  let provisioner: ReturnType<typeof createProductionProvisioner> | undefined
  let serialized: RuntimeProvisioner | undefined
  try {
    const configuredMirror = await settingsService.getPackageMirror()
    const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
    provisioner = createProductionProvisioner({
      root: provisioningRoot,
      channel: mirror.condaChannel ?? process.env.OPEN_SCIENCE_CONDA_CHANNEL ?? 'conda-forge',
      caBundle: mirror.caBundle,
      micromamba: { resourcesPath: process.resourcesPath }
    })
    // One serialized wrapper shared by the startup gate and the notebook service's on-demand default
    // provisioning, so a concurrent build of the same default env (UI R-tab + an agent R run) can't
    // race the provisioner's shared in-flight flag; materialize is also idempotent as a backstop.
    serialized = serializeProvisioner(provisioner)
  } catch (error) {
    // micromamba missing (e.g. dev without a staged binary): the notebook env stays unprovisioned and
    // the UI surfaces "runtime unavailable" rather than crashing startup or dropping the IPC handlers.
    console.error('Notebook environment provisioning unavailable:', error)
  }
  // Crash recovery (WS13): reconcile any runtime operation the previous process left in flight (orphan
  // download staging, a half-built prefix, an interrupted install). Kicked off HERE — before the env
  // IPC gate below — so recoverInterruptedOperations() publishes its barrier synchronously and every
  // prefix-touching path (the startup gate's restore/upgrade/repair, UI provision/repair, named-env
  // create, on-demand materialize, install) can await it and never race recovery's cleanup/delete.
  // Fire-and-forget so a slow/failed recovery never blocks IPC registration; the barrier itself is what
  // actually orders the prefix work.
  void notebookService
    .recoverInterruptedOperations()
    .catch((error) => console.error('Notebook operation recovery failed:', error))
  const waitForRecovery = (): Promise<void> => notebookService.ensureRecovered()
  // Lets UI provision/repair refuse when recovery left the default env's prefix blocked (an
  // unknown-liveness orphan may still be writing it) — throws with an actionable message.
  const assertProvisionAllowed = (language: NotebookLanguage): void => {
    if (notebookService.isDefaultEnvRecoveryBlocked(language)) {
      throw new Error(
        `The ${language} runtime is recovering from an interrupted operation whose process could not be ` +
          'confirmed stopped. Restart the app to re-check and recover it before setting it up again.'
      )
    }
  }

  // Always register the handlers (serialized is undefined when the provisioner could not be built). The
  // recovery barrier is threaded in so the startup gate and UI provision/repair await recovery first.
  registerNotebookEnvIpcHandlers(
    serialized,
    provisioningRoot,
    waitForRecovery,
    assertProvisionAllowed
  )
  if (provisioner && serialized) {
    // Back the notebook service's manage_environments tool with the same provisioner that owns the env
    // gate (it is a DefaultRuntimeProvisioner, which implements createNamedEnvironment/listEnvironments/
    // removeEnvironment). Wired after construction like the mcp/mirror resolvers above.
    notebookService.setEnvironmentManager(provisioner as unknown as NotebookEnvironmentManager)
    // On first agent use of a not-yet-built default env, build it from the offline bundle (via the
    // shared serialized provisioner) instead of erroring — keeps R lazy but avoids the agent creating
    // a redundant named env.
    notebookService.setDefaultEnvProvisioner(serialized, broadcastNotebookEnvProgress)
  }

  // Registered after the acp/notebook handlers exist: migration needs to interrupt both runtimes.
  registerStorageIpcHandlers({
    runtime,
    notebook: notebookService,
    getActivePromptSessions: () => runtime.getActivePromptSessions(),
    settingsService
  })
  registerArtifactIpcHandlers(artifactRepository, artifactRunRegistry, () =>
    runtimeRef.current ? runtimeRef.current.getActiveArtifactRunIds() : []
  )
  registerUploadIpcHandlers(uploadRepository)
  registerSessionPersistenceIpcHandlers(sessionRepository, undefined, (sessionId) =>
    uploadRepository.deleteSessionUploads(sessionId)
  )
  registerProjectIpcHandlers(projectRepository, previewStateRepository)
  // Compute IPC handlers are registered earlier (before the notebook RPC server) so computeService
  // can be injected into the RPC server for the computeCall route. See above.
  // Wire the reviewer backend into the app lifecycle: installs ipcMain.handle('reviewer:run', ...)
  // and 'reviewer:get-for-session' so the renderer's fire-and-forget reviewer calls resolve to
  // real handlers instead of no-ops. Passing the already-constructed AcpRuntime so the reviewer
  // can spawn sessions under the same agent connection.
  registerReviewerIpcHandlers({ acpRuntime: runtime })

  // Return the long-lived backend handles so the app lifecycle (before-quit) can shut them down
  // cleanly on quit — the agent process tree and every notebook kernel.
  return { runtime, notebook: notebookService, shutdownCoordinator }
}

export { registerIpcHandlers }

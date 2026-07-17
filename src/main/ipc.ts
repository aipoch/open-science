import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { BrowserWindow, ipcMain } from 'electron'

import { createDefaultNotebookRuntimeService, registerAcpIpcHandlers } from './acp/ipc'
import { createDefaultArtifactRepository, registerArtifactIpcHandlers } from './artifacts/ipc'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { ApprovalBroker } from './connectors/approval-broker'
import { toCustomMcpConfig, selectEnabledCustomServers } from './connectors/custom-mcp-bootstrap'
import { McpClientManager } from './connectors/mcp-client-manager'
import { createMoleculePreviewHandler } from './connectors/molecule-preview'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { ConnectorService } from './connectors/service'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './connectors/provision'
import { registerFileSaveHandlers } from './file-save'
import { registerGithubIpcHandlers } from './github-ipc'
import { registerLogsIpcHandlers } from './logs-ipc'
import { createLogger } from './logger'
import { registerManagedPreviewIpcHandlers } from './managed-preview-ipc'
import { registerManagedPreviewProtocol } from './managed-preview-protocol'
import { ManagedPreviewResources } from './managed-preview-resources'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository,
  registerProjectIpcHandlers
} from './projects/ipc'
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

// Registers every main-process IPC surface used by the renderer.
const registerIpcHandlers = async ({ mainEntryPath }: IpcRegistrationOptions): Promise<void> => {
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
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('connectors:approval-request', request)
      }
    }
  })
  // Late-bound app runtime for connector tools that attach a generated file to the current turn. The
  // runtime is created below (it depends on the connector service), so the handler resolves it lazily.
  const runtimeRef: { current: ReturnType<typeof registerAcpIpcHandlers> | undefined } = {
    current: undefined
  }
  const moleculePreviewHandler = createMoleculePreviewHandler({
    writeArtifactForCurrentRun: (input) => {
      if (!runtimeRef.current) throw new Error('Artifact runtime is not initialized.')
      return runtimeRef.current.writeArtifactForCurrentRun(input)
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
  const notebookRpcServer = new NotebookLocalRpcServer(notebookService, { connectorService })
  // The RPC server needs the runtime service to dispatch to, and the runtime service needs the RPC
  // server's (lazily-started) connection for host.mcp() env injection — wire the second half here to
  // avoid a construction cycle.
  notebookService.setMcpRpcConnectionResolver(() => notebookRpcServer.ensureStarted())

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
  // Switching the active provider takes effect on the next reconnect. Defer that reconnect until any
  // in-flight prompt finishes so switching never interrupts a running turn; the shared config dir keeps
  // the conversation's context across the switch.
  registerSettingsIpcHandlers({
    service: settingsService,
    onActiveProviderChanged: () => void runtime.requestProviderReconnect(),
    onSkillsChanged: () => void runtime.requestSkillsReload(),
    // Re-sync bundled + custom skill docs and refresh the in-memory snapshot the connector
    // service reads, so a connector/tool/credential change takes effect without an app restart.
    onConnectorsChanged: () =>
      void refreshConnectorSkillDocs(
        settingsService,
        resolveStorageRoot(),
        mcpClientManager,
        (connectors) => {
          connectorsSnapshot = connectors
        }
      )
  })
  registerNotebookIpcHandlers(notebookService)
  registerManagedPreviewIpcHandlers(previewResources)
  registerManagedPreviewProtocol(previewResources)
  // Registered after the acp/notebook handlers exist: migration needs to interrupt both runtimes.
  registerStorageIpcHandlers({
    runtime,
    notebook: notebookService,
    getActivePromptSessions: () => runtime.getActivePromptSessions(),
    settingsService
  })
  registerArtifactIpcHandlers(artifactRepository, artifactRunRegistry)
  registerUploadIpcHandlers(uploadRepository)
  registerSessionPersistenceIpcHandlers(sessionRepository)
  registerProjectIpcHandlers(projectRepository, previewStateRepository)
}

export { registerIpcHandlers }

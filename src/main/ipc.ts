import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { BrowserWindow, ipcMain } from 'electron'

import { createDefaultNotebookRuntimeService, registerAcpIpcHandlers } from './acp/ipc'
import { createDefaultArtifactRepository, registerArtifactIpcHandlers } from './artifacts/ipc'
import { ArtifactRunRegistry } from './artifacts/run-registry'
import { ApprovalBroker } from './connectors/approval-broker'
import { toCustomMcpConfig, selectEnabledCustomServers } from './connectors/custom-mcp-bootstrap'
import { McpClientManager } from './connectors/mcp-client-manager'
import { ALL_CONNECTOR_IDS } from './connectors/registry'
import { ConnectorService } from './connectors/service'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './connectors/provision'
import { registerFileSaveHandlers } from './file-save'
import { registerGithubIpcHandlers } from './github-ipc'
import { KetcherBroker } from './ketcher/broker'
import { KetcherService, type KetcherRunContext } from './ketcher/service'
import { registerLogsIpcHandlers } from './logs-ipc'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { NotebookLocalRpcServer } from './notebook/local-rpc-server'
import { registerProjectIpcHandlers } from './projects/ipc'
import { registerSessionPersistenceIpcHandlers } from './session-persistence/ipc'
import { tryDecryptKey } from './settings/crypto'
import { registerSettingsIpcHandlers } from './settings/ipc'
import { getAppClaudeConfigDir } from './settings/provider-env'
import { createDefaultSettingsService, type SettingsService } from './settings/service'
import type { StoredConnectors } from './settings/types'
import type { KetcherMountNotice, KetcherReply, KetcherSaveRequest } from '../shared/ketcher'
import { resolveStorageRoot } from './storage-root'
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
const registerIpcHandlers = ({ mainEntryPath }: IpcRegistrationOptions): void => {
  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const artifactRunRegistry = new ArtifactRunRegistry()
  // Share one upload repository so composer staging, prompt finalization, and previews agree.
  const uploadRepository = createDefaultUploadRepository()
  const notebookService = createDefaultNotebookRuntimeService()
  // One settings service backs both the settings IPC and the ACP spawn config (single source of truth).
  const settingsService = createDefaultSettingsService()

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
  // Bridges the main-process Ketcher tool host to live sketcher tiles in the renderer(s): it pushes
  // open/command events and resolves each command when the addressed tile replies.
  const ketcherBroker = new KetcherBroker({
    generateId: () => randomUUID(),
    send: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(channel, payload)
      }
    }
  })
  // Resolved after the ACP runtime is created below (it owns the active turn's run context). open_sketcher
  // reads it to attribute its .ket artifact to the current turn's pending run.
  let resolveKetcherRunContext: () => KetcherRunContext | undefined = () => undefined
  const ketcherService = new KetcherService({
    broker: ketcherBroker,
    repository: artifactRepository,
    resolveRunContext: () => resolveKetcherRunContext()
  })
  const connectorService = new ConnectorService({
    getConnectors: () => connectorsSnapshot,
    resolveApiKey: (ref) => tryDecryptKey(ref),
    mcpClientManager,
    ketcherService,
    requestApproval: ({ connector, method, args }) =>
      approvalBroker.request({ connector, method, argsPreview: previewArgs(args) })
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

  // Sketcher tiles report their lifecycle and answer commands through the Ketcher broker.
  ipcMain.handle('ketcher:mounted', (_event, notice: KetcherMountNotice) => {
    ketcherBroker.mount(notice.artifactId)
  })
  ipcMain.handle('ketcher:unmounted', (_event, notice: KetcherMountNotice) => {
    ketcherBroker.unmount(notice.artifactId)
  })
  ipcMain.handle('ketcher:reply', (_event, reply: KetcherReply) => {
    ketcherBroker.reply(reply)
  })
  ipcMain.handle('ketcher:save', (_event, request: KetcherSaveRequest) =>
    ketcherService.save(request.artifactId, request.ket)
  )

  void refreshConnectorSkillDocs(
    settingsService,
    resolveStorageRoot(),
    mcpClientManager,
    (connectors) => {
      connectorsSnapshot = connectors
    }
  )

  registerFileSaveHandlers()
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
  // The Ketcher tool host resolves the active turn's run through the runtime, now that it exists.
  resolveKetcherRunContext = () => runtime.getActiveArtifactRunContext()
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
  registerArtifactIpcHandlers(artifactRepository, artifactRunRegistry)
  registerUploadIpcHandlers(uploadRepository)
  registerSessionPersistenceIpcHandlers()
  registerProjectIpcHandlers()
}

export { registerIpcHandlers }

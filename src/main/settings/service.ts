import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

import { z } from 'zod'

import type { CloseActionPreference } from '../../shared/window-controls'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  ConnectorDetailView,
  ConnectorsSnapshot,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetCustomServerEnabledRequest,
  UpdateCustomServerRequest,
  AgentHomeSkillView,
  CreateSkillRequest,
  DeleteSkillRequest,
  EnvironmentCheckResult,
  ImportAgentHomeSkillsRequest,
  ImportAgentHomeSkillsResult,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetPackageMirrorRequest,
  SetSkillEnabledRequest,
  SetToolPermissionRequest,
  SettingsSnapshot,
  AppIconVariant,
  SkillDetailView,
  SkillView,
  ImportSkillRequest,
  ImportSkillResult,
  ImportSkillZipRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  ReasoningEffort,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  SkillSource,
  ScanRepoRequest,
  ScanRepoResult,
  UpdateSkillRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import {
  CODEX_ISOLATED_PROVIDER_ID,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isCodexSubscriptionProvider,
  isProviderUsableByFramework,
  requiresChatCompletionsBridge
} from '../../shared/settings'
import type { PackageMirror } from '../../shared/mirror'
import {
  buildActiveModelIncompatibleMessage,
  CODEX_BRIDGE_UNSUPPORTED_MESSAGE,
  CLAUDE_EXECUTABLE_MISSING_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from '../../shared/run-error-classification'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import { isModelBridgeSupported } from '../../shared/provider-registry'
import { resolveProviderReasoningEffortProfile } from '../../shared/provider-reasoning-effort'
import {
  resolveReasoningEffortValue,
  type ModelReasoningEffort,
  type ResolvedReasoningEffort
} from '../../shared/reasoning-effort'
import { resolveStorageRoot } from '../storage-root'
import { buildAgentSpawnEnv } from '../acp/agent-process'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  listAgentFrameworks,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import { createDefaultDetectDeps, detectClaude, type ClaudeDetectDeps } from './claude-detect'
import {
  createDefaultDetectDeps as createOpencodeDetectDeps,
  detectOpencode,
  type OpencodeDetectDeps
} from './opencode-detect'
import {
  detectCodex,
  parseVersion as parseCodexVersion,
  runAcpInitializeSmoke,
  type CodexDetectDeps
} from './codex-detect'
import { openAiCompletionsBase } from './base-url'
import {
  installManagedOpencode,
  isManagedOpencodePath,
  managedOpencodeDir,
  uninstallManagedOpencode,
  type InstallManagedOpencodeOptions
} from './managed-opencode'
import { opencodeConfigDir } from '../agent-framework/opencode'
import {
  codexStorageDir,
  codexSubscriptionStorageDir,
  normalizeResponsesBaseUrl
} from '../agent-framework/codex'
import { detectNpmAvailable, runInstallWithFallback, type InstallTarget } from './claude-install'
import { OPENCODE_INSTALL_TARGET } from './opencode-install'
import {
  ensureManagedCodexContextUsage,
  installManagedCodex,
  managedCodexAdapterEntry,
  managedCodexBinary,
  uninstallManagedCodex,
  type InstallManagedCodexOptions,
  type ManagedCodexInstallOutcome
} from './managed-codex'
import { runEnvironmentCheck } from './environment-check'
import { writeAgentConfigFiles } from './agent-config-files'
import {
  DEFAULT_REGISTRIES,
  installManagedClaude,
  isManagedClaudePath,
  managedClaudeDir,
  uninstallManagedClaude,
  type InstallManagedClaudeOptions,
  type ManagedInstallOutcome
} from './managed-claude'
import { isEncryptionAvailable } from './crypto'
import { augmentedPathEnv } from './shell-path'
import { computePreflight } from './preflight'
import {
  buildProviderEnv,
  getAppClaudeConfigDir,
  getUserClaudeConfigDir,
  type ResolvedProvider
} from './provider-env'
import {
  ResponsesBridge,
  type ResponsesBridgeConnection,
  type ResponsesBridgeNamespacedTool
} from './responses-bridge'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
import { SettingsRepository } from './repository'
import { SettingsPreferencesModule, toSettingsPreferencesSnapshot } from './preferences'
import { NotebookRuntimeSettingsModule } from './notebook-runtime-settings'
import { SkillCatalogModule } from './skill-catalog'
import { ConnectorSettingsModule, type CustomServerSecurityChangeGuard } from './connector-settings'
import {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  ProviderAccountsModule,
  requiresNativeResponsesCompatibility
} from './provider-accounts'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import { syncConnectorSkillDocs } from '../connectors/provision'
import { SkillRegistry } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { requestSkillImportToolSchema } from '../skills/mcp-server'
import {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
} from '../../shared/skill-import'
import { NOTEBOOK_MCP_SERVER_NAME, NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import { ARTIFACT_MCP_SERVER_NAME, writeArtifactFileToolSchema } from '../artifacts/mcp-server'
import { beginActivityGroupToolSchema } from '../activity-groups/mcp-server'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  BEGIN_ACTIVITY_GROUP_TOOL_NAME
} from '../../shared/activity-groups'
import { REVIEWER_BRIDGE_NAMESPACED_TOOLS } from '../reviewer/bridge-tools'
import type { StoredConnectors, StoredCodexInfo, StoredSettings } from './types'
import { ensureCodexAuthHome, type CodexAuthControllerPort } from './codex-auth'

import { resolveSystemProxyEnvironment, type SystemProxyEnvironment } from './system-proxy'
import { type ClaudeIsolatedAuthControllerPort } from './claude-isolated-auth'
import { type ClaudeSharedAuthControllerPort } from './claude-shared-auth'

export type AgentBackendSelection = {
  frameworkId: AgentFrameworkId
}

export type AgentBackendResolutionContext = {
  forcedSkillIds?: string[]
}

type ResponsesBridgeEntry = {
  bridge: ResponsesBridge
  connection: Promise<ResponsesBridgeConnection>
}

type NativeResponsesCompatibilityEntry = {
  proxy: NativeResponsesCompatibilityProxy
  connection: Promise<ResponsesBridgeConnection>
}

type LeasedResponsesBridgeConnection = ResponsesBridgeConnection & {
  lease: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>
}

const allocateLoopbackPort = async (): Promise<number> => {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Could not reserve an OpenCode usage API port.')
    }
    return address.port
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

const execFileAsync = promisify(execFile)

// Hard ceiling for a Claude credential probe so a stuck process can never hang the wizard.
const CLAUDE_PROBE_TIMEOUT_MS = 20_000
const CODEX_INSTALL_TARGET: InstallTarget = {
  npmPackage: '@agentclientprotocol/codex-acp',
  // Codex exposes no supported shell installer; InstallCodexRequest cannot select this branch.
  scriptUnix: ''
}

// Codex exposes local MCP tools as namespaced Responses functions. Chat Completions has no namespace
// field, so the bridge receives the app-owned notebook schemas and aliases them for the upstream.
const CODEX_NOTEBOOK_TOOL_NAMESPACE = `mcp__${NOTEBOOK_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_NOTEBOOK_TOOLS: ResponsesBridgeNamespacedTool[] = NOTEBOOK_RPC_TOOLS.map(
  (tool) => ({
    namespace: CODEX_NOTEBOOK_TOOL_NAMESPACE,
    name: tool.name,
    description:
      tool.name === 'notebook_execute'
        ? `${tool.description} For Open Science data connectors, the Python code MUST call host.mcp(server, method, arguments). Never use requests, urllib, httpx, curl, or a raw upstream API for connector data; those bypass app permissions, credentials, and rate limits. Codex MCP resource-list tools are not connector discovery.`
        : tool.description,
    parameters: z.toJSONSchema(z.object(tool.inputSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  })
)
const CODEX_ARTIFACT_TOOL_NAMESPACE = `mcp__${ARTIFACT_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_ARTIFACT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: CODEX_ARTIFACT_TOOL_NAMESPACE,
    name: 'write_artifact_file',
    description:
      'Attach a generated image, chart, report, data export, or archive to the current Open Science response. The file must already exist before using a localPath source.',
    parameters: z.toJSONSchema(z.object(writeArtifactFileToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]
const CODEX_ACTIVITY_TOOL_NAMESPACE = `mcp__${ACTIVITY_GROUP_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_ACTIVITY_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: CODEX_ACTIVITY_TOOL_NAMESPACE,
    name: BEGIN_ACTIVITY_GROUP_TOOL_NAME,
    description:
      'Declare the concise purpose of the next coherent group of tool calls. Call once before the first tool in that group, not once per step.',
    parameters: z.toJSONSchema(z.object(beginActivityGroupToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]
const CODEX_SKILL_IMPORT_TOOL_NAMESPACE = `mcp__${SKILL_IMPORT_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_SKILL_IMPORT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: CODEX_SKILL_IMPORT_TOOL_NAMESPACE,
    name: REQUEST_SKILL_IMPORT_TOOL_NAME,
    description: REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
    parameters: z.toJSONSchema(z.object(requestSkillImportToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]
const isManagedCodexPath = (adapterPath: string, storageRoot: string): boolean =>
  adapterPath === managedCodexAdapterEntry(storageRoot)

type ExecuteClaudeProbe = (
  executablePath: string,
  env: NodeJS.ProcessEnv,
  runtimeArgs?: string[]
) => Promise<void>

const executeClaudeProbe: ExecuteClaudeProbe = async (executablePath, env, runtimeArgs = []) => {
  await execFileAsync(executablePath, [...runtimeArgs, '-p', 'ok'], {
    env,
    timeout: CLAUDE_PROBE_TIMEOUT_MS,
    // On Windows the detected claude is a `claude.cmd` shim, which execFile can't launch without a
    // shell (spawn EINVAL); route the probe through the shell there.
    shell: process.platform === 'win32',
    windowsHide: true
  })
}

const runCodexAdapterVersion = async (
  adapterPath: string,
  fallback: (path: string) => Promise<string | undefined>
): Promise<string | undefined> => {
  if (!/\.[cm]?js$/i.test(adapterPath)) return fallback(adapterPath)

  try {
    const { stdout } = await execFileAsync(process.execPath, [adapterPath, '--version'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_BROWSER: '1' },
      timeout: 5_000,
      windowsHide: true
    })
    return stdout
  } catch {
    return undefined
  }
}

// Detects a child-process timeout (SIGTERM kill or ETIMEDOUT) so the probe can report it distinctly.
const isTimeoutError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const candidate = error as { killed?: boolean; signal?: string; code?: string }

  return (
    candidate.killed === true || candidate.signal === 'SIGTERM' || candidate.code === 'ETIMEDOUT'
  )
}

const classifyClaudeProbeFailure = (error: unknown): 'auth' | 'network' | 'unknown' => {
  if (typeof error !== 'object' || error === null) return 'unknown'

  const candidate = error as {
    code?: string | number
    message?: string
    stderr?: unknown
    stdout?: unknown
  }
  if (candidate.code === 'ENOENT' || candidate.code === 'EACCES') return 'unknown'

  const detail = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|not authenticated|not logged in|authentication failed|invalid api key|api key.*invalid|please run \/login|oauth.*(?:invalid|expired|reject)|(?:invalid|expired|rejected).*token|token.*(?:invalid|expired|rejected)/i.test(
      detail
    )
  ) {
    return 'auth'
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)\b|network|fetch failed|getaddrinfo/i.test(
      detail
    )
  ) {
    return 'network'
  }

  return 'unknown'
}

// A spawn configuration the ACP runtime reads at connect time so the active provider's credentials
// are always current.
export type AgentSpawnConfig = {
  envOverrides: Record<string, string>
  executablePath: string
  contextWindow?: number
  sessionOptions?: Record<string, unknown>
}

// Outcome of uninstalling a managed runtime. `activeBackendAffected` is true only when the removed
// runtime backed the active framework, so the IPC layer reconnects the agent for that case alone —
// removing the inactive framework's runtime leaves the live agent untouched.
export type UninstallResult = {
  snapshot: SettingsSnapshot
  activeBackendAffected: boolean
}

export type SettingsServiceOptions = {
  repository?: SettingsRepository
  storageRoot?: string
  detectDeps?: ClaudeDetectDeps
  opencodeDetectDeps?: OpencodeDetectDeps
  // Reserves the authenticated loopback HTTP port exposed by `opencode acp`. Injectable so settings
  // tests do not bind real sockets.
  allocateOpenCodeUsagePort?: () => Promise<number>
  codexDetectDeps?: CodexDetectDeps
  // The machine's own Claude config dir, used by the shared provider for auth/spawn and scanned as a
  // user skill source. Injectable so tests don't touch the real ~/.claude.
  userClaudeDir?: string
  // The machine's own Codex config dir, scanned for installed skills while Codex is active.
  // Injectable for the same reason as userClaudeDir.
  userCodexDir?: string
  // The framework-neutral Agents config dir. Codex and other compatible agents discover skills
  // under ~/.agents/skills; it is scanned regardless of the active framework.
  userAgentsDir?: string
  // Bundled-skill source, injectable so tests can point at a seeded temp dir instead of app resources.
  skillRegistry?: SkillRegistry
  // Writable personal/imported skill store, injectable so tests can use a temp storage root.
  userSkills?: UserSkillRepository
  // One-shot Claude command runner, injectable so validation tests can inspect the exact auth env.
  executeClaudeProbe?: ExecuteClaudeProbe
  // One-shot managed Claude installer, injectable so tests avoid real network/fs.
  installManagedClaudeImpl?: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  // Same for the managed OpenCode installer.
  installManagedOpencodeImpl?: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedCodexImpl?: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  codexAuth?: CodexAuthControllerPort
  // Resolves the user's current native/PAC proxy for Codex subscription traffic. Injectable so
  // tests do not depend on the host machine's Electron session configuration.
  resolveCodexProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
  // Encrypted-token controller for claude-isolated; default-constructed against this.storageRoot
  // when omitted. Storage is delegated to the host's SettingsRepository + encrypt/tryDecryptKey
  // pipeline, mirroring how CodexAuthController delegates to openCodexAuthSession.
  claudeIsolatedAuth?: ClaudeIsolatedAuthControllerPort
  // Browser OAuth controller for claude-shared; default-constructed when omitted. Calls
  // `claude auth login --claudeai` to open the browser and stores credentials in ~/.claude.
  claudeSharedAuth?: ClaudeSharedAuthControllerPort
}

// Orchestrates the settings units (repository + crypto + detect/install + validate) behind one
// object shared by the settings IPC handlers and the ACP runtime. Secrets are decrypted here only
// transiently; nothing that leaves this object (views, spawn config aside) carries plaintext.
class SettingsService {
  private readonly repository: SettingsRepository
  private readonly preferences: SettingsPreferencesModule
  private readonly notebookRuntimeSettings: NotebookRuntimeSettingsModule
  private readonly skills: SkillCatalogModule
  private readonly connectors: ConnectorSettingsModule
  private readonly providers: ProviderAccountsModule
  private readonly storageRoot: string
  private readonly detectDeps: ClaudeDetectDeps
  private readonly opencodeDetectDeps: OpencodeDetectDeps
  private readonly allocateOpenCodeUsagePort: () => Promise<number>
  private readonly codexDetectDeps: CodexDetectDeps
  private readonly userClaudeDir: string
  private readonly executeClaudeProbe: ExecuteClaudeProbe
  private readonly installManagedClaudeImpl: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedOpencodeImpl: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedCodexImpl: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  private readonly resolveCodexProxyEnvironment: () => Promise<SystemProxyEnvironment | undefined>
  // A bridge owns mutable per-runtime state (reasoning override, reviewer scopes, and reasoning
  // replay). Track each backend generation separately so an overlapping reconnect cannot mutate the
  // bridge still serving the retiring generation.
  private readonly responsesBridges = new Map<string, ResponsesBridgeEntry>()
  private readonly nativeResponsesCompatibilityProxies = new Map<
    string,
    NativeResponsesCompatibilityEntry
  >()
  // Provider and runtime-install IDs historically shared one monotonic suffix. Keep that observable
  // ordering while the provider owner remains responsible for formatting provider IDs.
  private settingsIdSequence = 0

  constructor(options: SettingsServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? resolveStorageRoot()
    this.repository = options.repository ?? new SettingsRepository(this.storageRoot)
    this.preferences = new SettingsPreferencesModule(this.repository)
    this.notebookRuntimeSettings = new NotebookRuntimeSettingsModule(this.repository)
    this.connectors = new ConnectorSettingsModule(this.repository)
    // Probe the app-managed install dir too, so a managed Claude is re-detected even if the cached
    // path is ever cleared (e.g. a manual re-detect).
    const baseDetectDeps = options.detectDeps ?? createDefaultDetectDeps()
    this.detectDeps = {
      ...baseDetectDeps,
      extraDirs: [...(baseDetectDeps.extraDirs ?? []), managedClaudeDir(this.storageRoot)]
    }
    // Same rationale for opencode: probe the app-managed dir so a managed opencode is re-detected
    // (its bare `which/where` PATH lookup would otherwise never see the app-owned install dir).
    const baseOpencodeDetectDeps = options.opencodeDetectDeps ?? createOpencodeDetectDeps()
    this.opencodeDetectDeps = {
      ...baseOpencodeDetectDeps,
      extraDirs: [...(baseOpencodeDetectDeps.extraDirs ?? []), managedOpencodeDir(this.storageRoot)]
    }
    this.allocateOpenCodeUsagePort = options.allocateOpenCodeUsagePort ?? allocateLoopbackPort
    const managedAdapterPath = managedCodexAdapterEntry(this.storageRoot)
    const managedNativePath = managedCodexBinary(this.storageRoot)
    this.codexDetectDeps = options.codexDetectDeps ?? {
      env: baseOpencodeDetectDeps.env,
      homePath: baseOpencodeDetectDeps.homePath,
      platform: baseOpencodeDetectDeps.platform,
      isRunnable: baseOpencodeDetectDeps.isExecutable,
      getAdapterVersion: (path) => runCodexAdapterVersion(path, baseOpencodeDetectDeps.getVersion),
      getCodexVersion: baseOpencodeDetectDeps.getVersion,
      smokeInitialize: runAcpInitializeSmoke(baseOpencodeDetectDeps.platform),
      resolveNpmBinDirs: baseOpencodeDetectDeps.resolveNpmBinDirs,
      extraDirs: [dirname(managedAdapterPath)],
      managedAdapterPath,
      managedCodexPath: managedNativePath
    }
    this.userClaudeDir = options.userClaudeDir ?? getUserClaudeConfigDir()
    const userCodexDir = options.userCodexDir ?? join(homedir(), '.codex')
    this.skills = new SkillCatalogModule({
      repository: this.repository,
      storageRoot: this.storageRoot,
      userClaudeDir: this.userClaudeDir,
      userCodexDir,
      userAgentsDir: options.userAgentsDir ?? join(homedir(), '.agents'),
      skillRegistry: options.skillRegistry ?? new SkillRegistry(),
      userSkills: options.userSkills ?? new UserSkillRepository(this.storageRoot)
    })
    this.executeClaudeProbe = options.executeClaudeProbe ?? executeClaudeProbe
    this.installManagedClaudeImpl = options.installManagedClaudeImpl ?? installManagedClaude
    this.installManagedOpencodeImpl = options.installManagedOpencodeImpl ?? installManagedOpencode
    this.installManagedCodexImpl = options.installManagedCodexImpl ?? installManagedCodex
    this.resolveCodexProxyEnvironment =
      options.resolveCodexProxyEnvironment ?? resolveSystemProxyEnvironment
    this.providers = new ProviderAccountsModule({
      repository: this.repository,
      storageRoot: this.storageRoot,
      userClaudeDir: this.userClaudeDir,
      userCodexDir,
      allocateSettingsIdSequence: () => this.nextSettingsIdSequence(),
      resolveCodexExecutable: (adapterPath, nativePath) =>
        this.resolveCodexExecutable(adapterPath, nativePath),
      resolveCodexProxyEnvironment: this.resolveCodexProxyEnvironment,
      runClaudeSubscriptionProbe: (provider, settings) =>
        this.runClaudeSubscriptionProbe(provider, settings),
      codexAuth: options.codexAuth,
      claudeIsolatedAuth: options.claudeIsolatedAuth,
      claudeSharedAuth: options.claudeSharedAuth
    })
  }

  // Returns the raw stored settings document (unmasked), for main-process bootstrap needs (e.g. priming
  // the data-root cache) that shouldn't go through the renderer-safe view.
  async getStoredSettings(): Promise<StoredSettings> {
    return this.migrateLegacyKeyRefs(await this.repository.getSettings())
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const settings = await this.migrateLegacyKeyRefs(await this.repository.getSettings())
    const preferences = toSettingsPreferencesSnapshot(settings)

    return {
      claude: settings.claude ?? {},
      opencode: { resolvedPath: settings.opencodePath, version: settings.opencodeVersion },
      codex: {
        resolvedPath: settings.codex?.resolvedPath,
        version: settings.codex?.version,
        nativeVersion: settings.codex?.nativeVersion
      },
      claudeManaged: settings.claude?.resolvedPath
        ? isManagedClaudePath(settings.claude.resolvedPath, this.storageRoot)
        : false,
      opencodeManaged: settings.opencodePath
        ? isManagedOpencodePath(settings.opencodePath, this.storageRoot)
        : false,
      codexManaged: settings.codex?.resolvedPath
        ? isManagedCodexPath(settings.codex.resolvedPath, this.storageRoot)
        : false,
      activeProviderId: settings.activeProviderId,
      claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId,
      activeModel: settings.activeModel,
      providers: settings.providers.map((provider) =>
        this.providers.toProviderView(
          provider,
          provider.id === settings.activeProviderId ? settings.activeModel : undefined
        )
      ),
      onboardingCompletedAt: preferences.onboardingCompletedAt,
      packageMirror: settings.packageMirror,
      reasoningEffort: preferences.reasoningEffort,
      notificationsEnabled: preferences.notificationsEnabled,
      conversationSkillImportEnabled: preferences.conversationSkillImportEnabled,
      closePreference: preferences.closePreference,
      appIconVariant: preferences.appIconVariant,
      agentFrameworkId: settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID,
      agentFrameworks: listAgentFrameworks().map((framework) => ({
        id: framework.id,
        displayName: framework.displayName,
        supportsSkills: framework.supportsSkills,
        supportedApiTypes: [...framework.supportedApiTypes]
      }))
    }
  }

  // Reads the package-mirror configuration, read fresh so callers see the latest saved state.
  // Empty object means public hosts (no override configured).
  async getPackageMirror(): Promise<PackageMirror> {
    return this.notebookRuntimeSettings.getPackageMirror()
  }

  // The persisted notebook runtime selection for a language (managed vs the user's own interpreter),
  // read fresh. undefined means "not chosen" -> the notebook runtime resolves to the managed default.
  async getRuntimeSelection(language: NotebookLanguage): Promise<RuntimeSelection | undefined> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).runtimeSelection
  }

  // Sets (or clears, when `selection` is null) the persisted runtime choice for a language, returning
  // the resulting per-language selection (undefined once cleared, or when a bad value was dropped).
  // Validation/rejection (bad shape, external R) lives in the repository so it can never be bypassed.
  async setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<RuntimeSelection | undefined> {
    return this.notebookRuntimeSettings.setRuntimeSelection(language, selection)
  }

  // The persisted v4 environment enablement for a language, read fresh. Always returns a concrete
  // RuntimeEnablement (empty maps when nothing is stored) so callers can index it and apply the
  // provenance default (isEnvEnabled) without a null check.
  async getRuntimeEnablement(language: NotebookLanguage): Promise<RuntimeEnablement> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).runtimeEnablement
  }

  // Sets one env's explicit enabled override (keyed by envId) for a language, read-modify-write over
  // the per-language RuntimeEnablement, returning the refreshed value. The enabled map records the
  // explicit choice regardless of the provenance default, so it survives re-detection.
  async setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement> {
    return this.notebookRuntimeSettings.setEnvironmentEnabled(language, envId, enabled)
  }

  // Sets one env's high-risk package-install authorization (keyed by envId) for a language, returning
  // the refreshed enablement. This is the separate opt-in that lets Open Science write packages into an
  // external env; it does not affect whether the env is enabled for execution.
  async setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement> {
    return this.notebookRuntimeSettings.setInstallAuthorized(language, envId, authorized)
  }

  // The manual-interpreter catalog for a language (paths added via "Add interpreter…"), for merging
  // into environment discovery. Empty array when none.
  async getManualInterpreters(language: NotebookLanguage): Promise<string[]> {
    return (await this.notebookRuntimeSettings.getSnapshot(language)).manualInterpreters
  }

  // Adds an interpreter path to a language's manual catalog (idempotent), returning the refreshed list.
  async addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    return this.notebookRuntimeSettings.addManualInterpreter(language, path)
  }

  // Removes an interpreter path from a language's manual catalog, returning the refreshed list.
  async removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    return this.notebookRuntimeSettings.removeManualInterpreter(language, path)
  }

  // Sets (or clears) the package-mirror configuration and returns the sanitized, persisted value.
  async setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    return this.notebookRuntimeSettings.setPackageMirror(request)
  }

  private async migrateLegacyKeyRefs(settings: StoredSettings): Promise<StoredSettings> {
    if (!isEncryptionAvailable()) return settings
    let changed = await this.providers.migrateLegacyKeyRefs(settings.providers)

    changed = (await this.connectors.migrateLegacyNcbiKeyRef(settings.connectors)) || changed

    return changed ? this.repository.getSettings() : settings
  }

  // Selects the agent backend to drive; the caller reconnects so the choice applies to the next spawn.
  async setAgentFramework(id: AgentFrameworkId): Promise<SettingsSnapshot> {
    await this.repository.setAgentFramework(id)

    return this.getSettingsView()
  }

  // Sets the reasoning-effort preference. Where the framework supports it the caller applies the
  // level live over ACP (otherwise it reconnects); the persisted value drives the next spawn.
  async setReasoningEffort(effort: ReasoningEffort): Promise<SettingsSnapshot> {
    await this.preferences.setReasoningEffort(effort)

    return this.getSettingsView()
  }

  // Projects one of the app's five stable user-intent slots through the active model's static effort
  // profile. This is intentionally async only because settings are read from disk; capability lookup
  // is synchronous and never performs provider discovery or a network request.
  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    const settings = await this.repository.getSettings()

    return this.resolveReasoningEffortFromSettings(settings, intent)
  }

  // Whether desktop notifications for finished/failed agent tasks are on, read fresh so the
  // notification path sees a toggle change immediately (no restart, no cached copy to go stale).
  async getNotificationsEnabled(): Promise<boolean> {
    return (await this.preferences.getSnapshot()).notificationsEnabled
  }

  // Sets the desktop-notification preference and returns the refreshed snapshot for the renderer.
  async setNotificationsEnabled(enabled: boolean): Promise<SettingsSnapshot> {
    await this.preferences.setNotificationsEnabled(enabled)

    return this.getSettingsView()
  }

  // Read fresh for every agent-session MCP build so disabling the feature removes the server and its
  // prompt guidance after the settings-triggered reconnect without restarting the app.
  async getConversationSkillImportEnabled(): Promise<boolean> {
    return (await this.preferences.getSnapshot()).conversationSkillImportEnabled
  }

  async setConversationSkillImportEnabled(enabled: boolean): Promise<SettingsSnapshot> {
    await this.preferences.setConversationSkillImportEnabled(enabled)

    return this.getSettingsView()
  }

  async getClosePreference(): Promise<CloseActionPreference | undefined> {
    return (await this.preferences.getSnapshot()).closePreference
  }

  async setClosePreference(
    preference: CloseActionPreference | undefined
  ): Promise<SettingsSnapshot> {
    await this.preferences.setClosePreference(preference)

    return this.getSettingsView()
  }

  // The selected app-icon look, read fresh so the startup apply reflects the latest saved choice.
  async getAppIconVariant(): Promise<AppIconVariant> {
    return (await this.preferences.getSnapshot()).appIconVariant
  }

  // Persists the app-icon look; the caller applies it live to the window and dock/taskbar.
  async setAppIconVariant(variant: AppIconVariant): Promise<SettingsSnapshot> {
    await this.preferences.setAppIconVariant(variant)

    return this.getSettingsView()
  }

  // Detects the opencode executable and persists its path, mirroring detectClaude. Returns the refreshed
  // snapshot so the settings card reflects the result.
  async detectOpencode(): Promise<SettingsSnapshot> {
    const detected = await detectOpencode(this.opencodeDetectDeps)

    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)
    } else {
      // Live probe found nothing. Only forget the stored record when its binary is actually gone from
      // disk (a real uninstall) — a transient probe miss (e.g. a slow --version, a GUI PATH gap) must
      // not wipe a still-installed opencode.
      const cached = (await this.repository.getSettings()).opencodePath

      if (cached && !(await this.pathExists(cached))) {
        await this.repository.clearOpencodeInfo()
      }
    }

    return this.getSettingsView()
  }

  async detectCodex(): Promise<SettingsSnapshot> {
    const detected = await detectCodex(this.codexDetectDeps)

    if (detected) {
      await this.repository.setCodexInfo({
        resolvedPath: detected.adapterPath,
        version: detected.adapterVersion,
        nativePath: detected.nativeCodexPath,
        nativeVersion: detected.nativeCodexVersion
      })
    } else {
      const cached = (await this.repository.getSettings()).codex?.resolvedPath
      if (cached && !(await this.pathExists(cached))) await this.repository.clearCodexInfo()
    }

    return this.getSettingsView()
  }

  // Compatibility facade: Skill state and filesystem rules live in SkillCatalogModule.
  async listSkills(): Promise<SkillView[]> {
    return this.skills.listSkills()
  }

  // Specialist scopes intentionally see the installed catalog irrespective of Main Agent toggles.
  // The result is rebuilt for every caller so future imports and removals take effect on the next turn.
  async listSpecialistSkillCatalog(): Promise<
    Array<{
      id: string
      frameworkName: string
      displayName: string
      source: SkillSource
      mainEnabled: boolean
      available: boolean
    }>
  > {
    return this.skills.listSpecialistSkillCatalog()
  }

  // Returns the mcp-<id> skill names for connectors provisioned at the Main Agent level (enabled
  // bundled connectors + enabled custom MCP servers). Specialist sessions merge these into their
  // skill whitelist so the agent can discover connector tools; the per-call ConnectorService gate
  // still enforces the specialist's own connector access config.
  async provisionedConnectorSkillNames(): Promise<string[]> {
    return this.connectors.provisionedConnectorSkillNames()
  }

  // Returns the subset of forced ids that are currently disabled in settings — i.e. the picks that need
  // a respawn to materialize. Enabled picks are already present and need no reconnect.
  async skillsNeedingForceLoad(forcedIds: string[]): Promise<string[]> {
    return this.skills.skillsNeedingForceLoad(forcedIds)
  }

  // Resolves picker ids to the names the agent's Skill tool accepts. Bundled skills use their
  // manifest id as frontmatter name, while personal/imported ids have an app-owned source prefix and
  // must use the frontmatter name kept in the user skill catalog.
  async skillNudgeNamesForIds(ids: string[]): Promise<string[]> {
    return this.skills.skillNudgeNamesForIds(ids)
  }

  async codexSkillDescriptorsForIds(
    ids: string[],
    codexHome: string | undefined
  ): Promise<Array<{ name: string; path: string }>> {
    return this.skills.codexSkillDescriptorsForIds(ids, codexHome)
  }

  async codexSkillCatalog(
    codexHome: string | undefined
  ): Promise<Array<{ name: string; description: string; path: string }>> {
    return this.skills.codexSkillCatalog(codexHome, (settings) => {
      return this.connectors.enabledConnectorIds(settings.connectors).flatMap((id) => {
        const connector = CONNECTOR_CATALOG.find((candidate) => candidate.id === id)
        return connector
          ? [
              {
                directory: `mcp-${id}`,
                name: `mcp-${id}`,
                description: connector.useWhen
              }
            ]
          : []
      })
    })
  }

  // Returns one skill's view plus its SKILL.md body for the detail view (any source).
  async getSkillDetail(id: string): Promise<SkillDetailView> {
    return this.skills.getSkillDetail(id)
  }

  // Toggles a skill and returns the refreshed list. The agent picks up the change on its next reconnect
  // (driven by the IPC layer's onSkillsChanged), which re-provisions the config dir.
  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    return this.skills.setSkillEnabled(request)
  }

  // Creates a personal skill from the in-app editor, returning the refreshed list.
  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    return this.skills.createSkill(request)
  }

  // Updates an existing personal skill in place, returning the refreshed list.
  async updateSkill(request: UpdateSkillRequest): Promise<SkillView[]> {
    return this.skills.updateSkill(request)
  }

  // Deletes a personal or imported skill, returning the refreshed list.
  async deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]> {
    return this.skills.deleteSkill(request)
  }

  // Imports a skill from a public GitHub URL (deduplicated), returning the outcome + refreshed list.
  async importSkill(request: ImportSkillRequest): Promise<ImportSkillResult> {
    return this.skills.importSkill(request)
  }

  // Imports a skill from an uploaded .zip / .skill bundle, returning the outcome + refreshed list. The
  // decode is bounded by the (larger) whole-bundle cap since one upload may carry many skills.
  async importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult> {
    return this.skills.importSkillZip(request)
  }

  // Imports several skills from ONE uploaded bundle in a single call (the bundle is decoded and
  // unpacked once). Per-item failures are reported without aborting the rest; the refreshed list is
  // returned once at the end.
  async importSkillZipBatch(
    request: ImportSkillZipBatchRequest
  ): Promise<ImportSkillZipBatchResult> {
    return this.skills.importSkillZipBatch(request)
  }

  // Parses an uploaded bundle for a confirm-before-import preview, without writing anything. Returns
  // the importable skills plus any the bundle contained that were skipped (too large, no SKILL.md, ...).
  async previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreviewResult> {
    return this.skills.previewSkillZip(request)
  }

  // Main-process callers that already own validated bytes use these archive-level methods directly;
  // renderer IPC remains base64-shaped, while conversation imports avoid a redundant encode/decode.
  async previewSkillArchive(zip: Buffer): Promise<SkillBundlePreviewResult> {
    return this.skills.previewSkillArchive(zip)
  }

  async importSkillArchiveBatch(
    zip: Buffer,
    items: ImportSkillZipBatchRequest['items']
  ): ReturnType<UserSkillRepository['importFromZipBatch']> {
    return this.skills.importSkillArchiveBatch(zip, items)
  }

  // Lazily loads one selected GitHub candidate. The repository's bounded helper downloads only its
  // SKILL.md; the display label is reconstructed from the public URL and contains no host paths.
  async previewGitHubSkill(request: PreviewGitHubSkillRequest): Promise<SkillImportPreviewContent> {
    return this.skills.previewGitHubSkill(request)
  }

  // Scans a GitHub repo for importable skill directories (marking already-imported ones).
  async scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult> {
    return this.skills.scanRepoSkills(request)
  }

  // Compatibility facade for installed Skill discovery, preview, and batch import.
  async listAgentHomeSkills(): Promise<AgentHomeSkillView[]> {
    return this.skills.listAgentHomeSkills()
  }

  async previewAgentHomeSkill(
    request: PreviewAgentHomeSkillRequest
  ): Promise<SkillImportPreviewContent> {
    return this.skills.previewAgentHomeSkill(request)
  }

  async importAgentHomeSkills(
    request: ImportAgentHomeSkillsRequest
  ): Promise<ImportAgentHomeSkillsResult> {
    return this.skills.importAgentHomeSkills(request)
  }
  // Computes the two startup gates, re-checking the claude path each call as the design requires.
  async getPreflight(): Promise<Preflight> {
    const settings = await this.repository.getSettings()
    // Validate each recorded runtime exactly as the authoritative env check does — by invoking
    // `--version`, not mere X_OK — so a corrupt-but-executable binary cannot pass preflight and get
    // auto-selected as "ready" only to be rejected later by the env gate that actually runs it.
    const claudePathExists = settings.claude?.resolvedPath
      ? (await this.detectDeps.getVersion(settings.claude.resolvedPath)) !== undefined
      : false
    const opencodePathExists = settings.opencodePath
      ? (await this.opencodeDetectDeps.getVersion(settings.opencodePath)) !== undefined
      : false
    const codexPathExists = (await this.probeCodexRuntime(settings.codex)) !== undefined

    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const framework = getAgentFramework(agentFrameworkId)
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    // Resolve compatibility here where the vendor registry is available (official endpoints + the
    // static bridge-support marks) and pass the boolean into the pure preflight computation.
    const activeEndpoints = activeProvider
      ? this.providers.resolveProviderApiEndpoints(activeProvider, activeProvider.model)
      : undefined
    const activeProviderCompatible = activeProvider
      ? isProviderUsableByFramework(
          { apiEndpoints: activeEndpoints, type: activeProvider.type },
          framework
        ) &&
        (framework.id !== 'codex' ||
          isModelBridgeSupported(
            activeProvider,
            this.providers.resolveActiveModel(activeProvider, settings.activeModel)
          ))
      : false
    const activeProviderKeyUsable =
      activeProvider && activeProvider.lastValidatedAt !== undefined
        ? await this.providers.isProviderKeyUsable(activeProvider)
        : false

    return computePreflight({
      settings,
      claudePathExists,
      opencodePathExists,
      codexPathExists,
      agentFrameworkId,
      isProviderKeyUsable: (provider) =>
        provider.id === activeProvider?.id && activeProviderKeyUsable,
      activeProviderCompatible
    })
  }

  // Re-runs the complete host inspection on every app launch, for the SELECTED framework's runtime, so
  // a runtime installed outside Open Science between launches is picked up and onboarding can be
  // completed with Claude or OpenCode alone.
  async checkEnvironment(): Promise<EnvironmentCheckResult> {
    const settings = await this.repository.getSettings()
    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID

    // Detect every framework's runtime so onboarding can show them side by side; only the selected
    // one's readiness gates Continue (enforced inside runEnvironmentCheck).
    const [claudeRuntime, opencodeRuntime, codexRuntime] = await Promise.all([
      this.resolveClaudeRuntime(settings),
      this.resolveOpencodeRuntime(settings),
      this.resolveCodexRuntime(settings)
    ])

    return runEnvironmentCheck({
      storageRoot: this.storageRoot,
      agentFrameworkId,
      frameworks: [
        {
          id: 'claude-code',
          label: getAgentFramework('claude-code').displayName,
          runtime: claudeRuntime
        },
        {
          id: 'opencode',
          label: getAgentFramework('opencode').displayName,
          runtime: opencodeRuntime
        },
        {
          id: 'codex',
          label: getAgentFramework('codex').displayName,
          runtime: codexRuntime
        }
      ],
      encryptionAvailable: this.isEncryptionAvailable()
    })
  }

  // Resolves the Claude runtime for the environment check. Prefers a previously recorded runtime that
  // still runs over this launch's re-detection, keeping a healthy app-managed/manual executable from
  // being replaced by a PATH entry discovered later; the `--version` probe (not mere file existence)
  // is the usability signal, so a stale-but-present path is never reported healthy.
  private async resolveClaudeRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cached = settings.claude

    if (cached?.resolvedPath) {
      const version = await this.detectDeps.getVersion(cached.resolvedPath)

      if (version) {
        // Keep the stored version in sync when an in-place update changed it under the same path.
        if (version !== cached.version) {
          await this.repository.setClaudeInfo({ resolvedPath: cached.resolvedPath, version })
        }

        return { found: true, path: cached.resolvedPath, version }
      }
    }

    // No healthy recorded runtime: full detection, which persists what it finds.
    return this.detectClaude()
  }

  // Same recorded-runtime-first logic for OpenCode, mapped into the shared detect-result shape.
  private async resolveOpencodeRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cachedPath = settings.opencodePath

    if (cachedPath) {
      const version = await this.opencodeDetectDeps.getVersion(cachedPath)

      if (version) {
        if (version !== settings.opencodeVersion) {
          await this.repository.setOpencodeInfo(cachedPath, version)
        }

        return { found: true, path: cachedPath, version }
      }
    }

    // Probe once (not twice): detect, then persist a hit or clear a truly-gone record — same rule as
    // detectOpencode — so the card/gates stay accurate without running the full PATH/version probe again.
    const detected = await detectOpencode(this.opencodeDetectDeps)

    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)

      return { found: true, path: detected.resolvedPath, version: detected.version }
    }

    if (cachedPath && !(await this.pathExists(cachedPath))) {
      await this.repository.clearOpencodeInfo()
    }

    return { found: false }
  }

  private async resolveCodexRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cached = settings.codex

    const cachedVersions = await this.probeCodexRuntime(cached)
    if (cached?.resolvedPath && cachedVersions) {
      await this.repository.setCodexInfo({ ...cached, ...cachedVersions })

      // Build codexComponents even for successful detection so onboarding shows separate rows.
      let nativeCliFound = !!cached.nativePath
      let nativeCliPath = cached.nativePath
      let nativeCliVersion = cachedVersions.nativeVersion

      if (!cached.nativePath) {
        // A non-managed adapter only gets cached after passing the full smoke test, so a working
        // native CLI exists. Trust that (mirroring the fresh-detect branch) rather than letting a
        // narrow probe miss it and block Continue. The probe just enriches the path/version.
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(this.codexDetectDeps)
        if (nativeCodex) {
          nativeCliPath = nativeCodex.path
          nativeCliVersion = nativeCodex.version
        }
      }

      const codexComponents: ClaudeDetectResult['codexComponents'] = {
        adapterFound: true,
        adapterPath: cached.resolvedPath,
        adapterVersion: cachedVersions.version,
        nativeCliFound,
        nativeCliPath,
        nativeCliVersion
      }

      return {
        found: true,
        path: cached.resolvedPath,
        version: cachedVersions.version,
        codexComponents
      }
    }

    const detected = await detectCodex(this.codexDetectDeps)
    if (detected) {
      await this.repository.setCodexInfo({
        resolvedPath: detected.adapterPath,
        version: detected.adapterVersion,
        nativePath: detected.nativeCodexPath,
        nativeVersion: detected.nativeCodexVersion
      })

      // The controlled adapter is paired with an explicit native executable. Legacy generic
      // detection can still omit it, so retain the independent display probe for that shape.
      let nativeCliFound = !!detected.nativeCodexPath
      let nativeCliPath = detected.nativeCodexPath
      let nativeCliVersion = detected.nativeCodexVersion

      if (!detected.nativeCodexPath) {
        // Non-managed adapter passed the ACP smoke test, which proves a working native CLI exists
        // (the handshake spawns a real session). Trust that: mark native as found even if the
        // independent probe below can't pinpoint the exact path, so a successful pairing never
        // blocks Continue. The probe only enriches the display with a concrete path/version.
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(this.codexDetectDeps)
        if (nativeCodex) {
          nativeCliPath = nativeCodex.path
          nativeCliVersion = nativeCodex.version
        }
      }

      const codexComponents: ClaudeDetectResult['codexComponents'] = {
        adapterFound: true,
        adapterPath: detected.adapterPath,
        adapterVersion: detected.adapterVersion,
        nativeCliFound,
        nativeCliPath,
        nativeCliVersion
      }

      return {
        found: true,
        path: detected.adapterPath,
        version: detected.adapterVersion,
        codexComponents
      }
    }

    // Full detection failed. Perform detailed component-level detection to provide accurate
    // diagnostic information distinguishing "adapter missing" from "native Codex missing" from
    // "both present but incompatible".
    if (cached?.resolvedPath && !(await this.pathExists(cached.resolvedPath))) {
      await this.repository.clearCodexInfo()
    }

    const { detectCodexComponents } = await import('./codex-detect')
    const components = await detectCodexComponents(this.codexDetectDeps)

    // Build diagnostic message based on what was found
    let diagnostic: string | undefined
    if (components.nativeCliFound && !components.adapterFound) {
      diagnostic = `Native Codex ${components.nativeCliVersion} is installed at ${components.nativeCliPath}, but the Codex ACP adapter required by Open Science is missing.`
    } else if (!components.nativeCliFound && components.adapterFound) {
      if (components.adapterFailureReason === 'smoke-test-failed') {
        diagnostic = `Codex ACP adapter ${components.adapterVersion} is installed at ${components.adapterPath}, but it failed to initialize (native Codex CLI may be missing or incompatible).`
      } else {
        diagnostic = `Codex ACP adapter is installed at ${components.adapterPath}, but version detection failed.`
      }
    } else if (components.nativeCliFound && components.adapterFound) {
      if (components.adapterFailureReason === 'smoke-test-failed') {
        diagnostic = `Both native Codex ${components.nativeCliVersion} and ACP adapter ${components.adapterVersion} are installed, but the adapter failed to initialize with the native CLI.`
      } else if (components.adapterFailureReason === 'version-probe-failed') {
        diagnostic = `Native Codex ${components.nativeCliVersion} is installed, and an ACP adapter exists at ${components.adapterPath}, but the adapter's version could not be determined.`
      }
    }

    return {
      found: false,
      diagnostic,
      codexComponents: {
        nativeCliFound: components.nativeCliFound,
        nativeCliPath: components.nativeCliPath,
        nativeCliVersion: components.nativeCliVersion,
        adapterFound: components.adapterFound,
        adapterPath: components.adapterPath,
        adapterVersion: components.adapterVersion,
        adapterFailureReason: components.adapterFailureReason
      }
    }
  }

  private async probeCodexRuntime(
    codex: StoredCodexInfo | undefined
  ): Promise<Pick<StoredCodexInfo, 'version' | 'nativeVersion'> | undefined> {
    if (!codex?.resolvedPath) return undefined

    const controlledAdapterPath =
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.storageRoot)
    // A cached global adapter is legacy detection data, not an eligible runtime. Force a fresh
    // controlled-pair detection so its native executable can be retained while the adapter is
    // replaced with the app-owned one.
    if (codex.resolvedPath !== controlledAdapterPath) return undefined

    const adapterOutput = await this.codexDetectDeps.getAdapterVersion(codex.resolvedPath)
    const version = adapterOutput ? parseCodexVersion(adapterOutput) : undefined
    if (!version) return undefined

    if (!codex.nativePath) return undefined

    const nativeOutput = await this.codexDetectDeps.getCodexVersion(codex.nativePath)
    const nativeVersion = nativeOutput ? parseCodexVersion(nativeOutput) : undefined
    return nativeVersion ? { version, nativeVersion } : undefined
  }

  // Detects claude and persists the resolved path/version for later spawns.
  async detectClaude(): Promise<ClaudeDetectResult> {
    const result = await detectClaude(this.detectDeps)

    if (result.found && result.path) {
      await this.repository.setClaudeInfo({ resolvedPath: result.path, version: result.version })
    } else {
      // Live probe missed it. A GUI launch can have a narrower PATH than the installing shell, so only
      // forget the cached record when the stored binary is actually gone from disk (a real uninstall) —
      // mirroring checkEnvironment's cached-path resilience so the status surfaces cannot disagree.
      const cached = (await this.repository.getSettings()).claude

      if (cached?.resolvedPath && !(await this.pathExists(cached.resolvedPath))) {
        await this.repository.setClaudeInfo({})
      }
    }

    return result
  }

  private nextSettingsIdSequence(): number {
    this.settingsIdSequence += 1
    return this.settingsIdSequence
  }

  // Runs the one-click installer, then re-detects claude so a success immediately unblocks the gate.
  // The app-managed source downloads the native binary itself and persists its exact path; the npm and
  // official-script sources shell out (with an automatic npm fallback when the official script is
  // region-blocked) and rely on PATH re-detection.
  async installClaude(
    request: InstallClaudeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-${Date.now()}-${this.nextSettingsIdSequence()}`

    if (request.source === 'managed') {
      const registries =
        request.managedRegistry === 'npmmirror'
          ? [DEFAULT_REGISTRIES[1], DEFAULT_REGISTRIES[0]]
          : DEFAULT_REGISTRIES
      const outcome = await this.installManagedClaudeImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot,
        registries
      })

      if (outcome.result.ok && outcome.resolvedPath) {
        const installedVersion = await this.detectDeps.getVersion(outcome.resolvedPath)

        if (!installedVersion) {
          const error =
            'The installed Claude runtime could not report its version. It may be incompatible or incomplete. Delete it and install again.'
          onEvent({ kind: 'log', installId, stream: 'system', chunk: `${error}\n` })
          return { installId, ok: false, error }
        }

        await this.repository.setClaudeInfo({
          resolvedPath: outcome.resolvedPath,
          version: outcome.version
        })
      }

      return outcome.result
    }

    const result = await runInstallWithFallback({ source: request.source, installId, onEvent })

    if (result.ok) {
      await this.detectClaude()
    }

    return result
  }

  // Installs OpenCode from the requested source (app-managed download is the first recommendation, like
  // Claude). Managed downloads the native binary and persists its path + version; npm/script shell out
  // and then re-detect. Streams progress on the shared install-log channel.
  async installOpencode(
    request: InstallOpencodeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-opencode-${Date.now()}-${this.nextSettingsIdSequence()}`

    if (request.source === 'managed') {
      const outcome = await this.installManagedOpencodeImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot
      })

      if (outcome.result.ok && outcome.resolvedPath) {
        await this.repository.setOpencodeInfo(outcome.resolvedPath, outcome.version)
      }

      return outcome.result
    }

    const result = await runInstallWithFallback({
      source: request.source,
      installId,
      onEvent,
      installTarget: OPENCODE_INSTALL_TARGET
    })

    if (result.ok) {
      await this.detectOpencode()
    }

    return result
  }

  async installCodex(
    request: InstallCodexRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-codex-${Date.now()}-${this.nextSettingsIdSequence()}`

    if (request.source === 'managed') {
      const outcome = await this.installManagedCodexImpl({
        installId,
        onEvent,
        dataRoot: this.storageRoot
      })

      if (
        outcome.result.ok &&
        outcome.adapterPath &&
        outcome.adapterVersion &&
        outcome.codexPath &&
        outcome.codexVersion
      ) {
        await this.repository.setCodexInfo({
          resolvedPath: outcome.adapterPath,
          version: outcome.adapterVersion,
          nativePath: outcome.codexPath,
          nativeVersion: outcome.codexVersion
        })
      }

      return outcome.result
    }

    const result = await runInstallWithFallback({
      source: request.source,
      installId,
      onEvent,
      installTarget: CODEX_INSTALL_TARGET
    })
    if (result.ok) await this.detectCodex()

    return result
  }

  // Uninstalls the app-managed Claude runtime. Only an install we own (a binary inside the app's data
  // dir) is removed; a PATH/npm Claude we merely detected is left untouched (a no-op that just returns
  // the current snapshot). When Claude was the active framework, the active backend auto-switches to
  // OpenCode if that is installed. `activeBackendAffected` is true only when Claude was the active
  // framework, so the IPC layer can reconnect the agent for that case alone — uninstalling the inactive
  // runtime leaves the live agent untouched and needs no reconnect.
  async uninstallClaude(): Promise<UninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.claude?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'claude-code'

    if (!resolvedPath || !isManagedClaudePath(resolvedPath, this.storageRoot)) {
      return { snapshot: await this.getSettingsView(), activeBackendAffected: false }
    }

    await uninstallManagedClaude(this.storageRoot)
    // Re-detect resolves what remains: clears the stored path when nothing is left on disk, or adopts a
    // still-present PATH install if one also exists.
    await this.detectClaude()
    await this.autoSwitchAwayFrom('claude-code')

    return { snapshot: await this.getSettingsView(), activeBackendAffected: wasActive }
  }

  // Uninstalls the app-managed OpenCode runtime, mirroring uninstallClaude (guard, delete, re-detect,
  // auto-switch to Claude when OpenCode was active). Only an install inside the app's data dir is
  // removed; a PATH/npm opencode is left untouched. `activeBackendAffected` is true only when OpenCode
  // was active.
  async uninstallOpencode(): Promise<UninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.opencodePath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'opencode'

    if (!resolvedPath || !isManagedOpencodePath(resolvedPath, this.storageRoot)) {
      return { snapshot: await this.getSettingsView(), activeBackendAffected: false }
    }

    await uninstallManagedOpencode(this.storageRoot)
    await this.detectOpencode()
    await this.autoSwitchAwayFrom('opencode')

    return { snapshot: await this.getSettingsView(), activeBackendAffected: wasActive }
  }

  async uninstallCodex(): Promise<UninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.codex?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'codex'

    // Exact app-owned adapter entry is the authority: never delete a PATH/npm global installation.
    if (!resolvedPath || !isManagedCodexPath(resolvedPath, this.storageRoot)) {
      return { snapshot: await this.getSettingsView(), activeBackendAffected: false }
    }

    await uninstallManagedCodex(this.storageRoot)
    await this.repository.clearCodexInfo()
    await this.detectCodex()
    await this.autoSwitchAwayFrom('codex')

    return { snapshot: await this.getSettingsView(), activeBackendAffected: wasActive }
  }

  // After a framework's runtime is uninstalled, if it was the active backend and the other framework
  // has a *ready* runtime, switch the active framework to it so sessions keep a working agent. Readiness
  // means the binary reports `--version`, matching the preflight gate's rule — not merely that a file
  // exists on disk. An existing-but-broken runtime (can't run, e.g. a corrupt binary) is treated as not
  // ready, so the selection is left as-is and the preflight gate reports the active framework as not
  // ready rather than silently parking the user on an unusable agent. No reconnect happens here; the
  // caller refreshes it.
  private async autoSwitchAwayFrom(uninstalled: AgentFrameworkId): Promise<void> {
    const settings = await this.repository.getSettings()
    const active = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID

    if (active !== uninstalled) return

    const candidates: AgentFrameworkId[] = ['claude-code', 'opencode', 'codex']

    for (const candidate of candidates) {
      if (candidate === uninstalled) continue

      const path =
        candidate === 'claude-code'
          ? settings.claude?.resolvedPath
          : candidate === 'opencode'
            ? settings.opencodePath
            : settings.codex?.resolvedPath
      if (!path) continue

      const version =
        candidate === 'claude-code'
          ? await this.detectDeps.getVersion(path)
          : candidate === 'opencode'
            ? await this.opencodeDetectDeps.getVersion(path)
            : await this.codexDetectDeps.getAdapterVersion(path)
      if (version) {
        await this.repository.setAgentFramework(candidate)
        return
      }
    }
  }

  // Records that first-run onboarding finished so later launches skip the wizard.
  async markOnboardingComplete(): Promise<SettingsSnapshot> {
    await this.preferences.markOnboardingComplete()

    return this.getSettingsView()
  }

  // Records that the one-time legacy-absolute-path normalization pass has succeeded, so later
  // launches skip it. The caller is responsible for only invoking this after the pass actually
  // completed without throwing (see normalizeLegacyDataPaths).
  async markPathsNormalized(): Promise<void> {
    await this.preferences.markPathsNormalized()
  }

  // Persists the new data-root path after a successful migration (see storage/migration-service.ts).
  // The caller is responsible for only invoking this once the move itself has succeeded.
  async setDataRoot(path: string): Promise<void> {
    await this.preferences.setDataRoot(path)
  }

  // Records that the user has answered the one-time legacy-data-move prompt (moved, relocated, or
  // declined), so it is never shown again. Idempotent-once at the repository layer.
  async dismissLegacyDataMovePrompt(): Promise<void> {
    await this.preferences.dismissLegacyDataMovePrompt()
  }

  // Provider account state lives behind one owner; this façade keeps every existing transport and
  // renderer contract stable while whole-settings snapshot composition remains here.
  async upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot> {
    await this.providers.upsertProvider(request)
    return this.getSettingsView()
  }

  async deleteProvider(id: string): Promise<SettingsSnapshot> {
    await this.providers.deleteProvider(id)
    return this.getSettingsView()
  }

  cancelCodexLogin(): void {
    this.providers.cancelCodexLogin()
  }

  cancelClaudeLogin(): void {
    this.providers.cancelClaudeLogin()
  }

  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.providers.loginIsolatedCodex()
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    return this.providers.logoutIsolatedCodex()
  }

  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.providers.loginIsolatedClaude(token)
  }

  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    return this.providers.loginIsolatedClaudeBrowser()
  }

  async cancelClaudeIsolatedLogin(): Promise<void> {
    return this.providers.cancelClaudeIsolatedLogin()
  }

  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    return this.providers.logoutIsolatedClaude()
  }

  async loginClaudeShared(): Promise<ValidateProviderResult> {
    return this.providers.loginClaudeShared()
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    return this.providers.logoutClaudeShared()
  }

  async getClaudeSharedStatus(): Promise<ValidateProviderResult> {
    return this.providers.getClaudeSharedStatus()
  }

  async getClaudeIsolatedStatus(): Promise<ValidateProviderResult> {
    return this.providers.getClaudeIsolatedStatus()
  }

  async setActiveProvider(id: string, model?: string): Promise<SettingsSnapshot> {
    await this.providers.setActiveProvider(id, model)
    return this.getSettingsView()
  }

  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    return this.providers.validateProvider(request)
  }

  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<RefreshProviderModelsResult> {
    return this.providers.refreshProviderModels(request)
  }

  // Reports whether the OS keychain is usable so the UI can warn before a save is attempted.
  isEncryptionAvailable(): boolean {
    return isEncryptionAvailable()
  }

  // Reads the connector enablement/config block, read fresh so callers see the latest saved state.
  // Undefined when no connector has ever been configured.
  async getConnectors(): Promise<StoredConnectors | undefined> {
    return this.connectors.getConnectors()
  }

  // Materializes the enabled skill set into opencode's isolated config dir (same skills/<name>/SKILL.md
  // layout Claude uses), so opencode's native skill tool discovers them. A turn-forced skill overrides
  // its disabled state, mirroring the Claude provisioning path.
  private async materializeAgentSkills(
    settings: StoredSettings,
    configRoot: string,
    forcedSkillIds: ReadonlySet<string>
  ): Promise<void> {
    await this.skills.materializeSkills(configRoot, settings.disabledSkillIds ?? [], forcedSkillIds)

    // Connector skill docs (which instruct the agent to reach a service ONLY via `host.mcp` from the
    // notebook kernel) are otherwise synced only into the Claude config dir. Non-Claude frameworks
    // (Codex, opencode) read skills from their own home, so without this they never get connector
    // guidance and fall back to ad-hoc calls (e.g. curl). Materialize them into this framework's dir too.
    const connectors = await this.getConnectors()
    await syncConnectorSkillDocs(
      join(configRoot, 'skills'),
      this.connectors.enabledConnectorIds(connectors)
    )
  }

  private async provisionClaudeRuntimeConfig(
    settings: StoredSettings,
    forcedSkillIds: ReadonlySet<string> = new Set()
  ): Promise<string> {
    const configDir = getAppClaudeConfigDir(this.storageRoot)
    const disabledSkillIds = (settings.disabledSkillIds ?? []).filter(
      (id) => !forcedSkillIds.has(id)
    )

    await this.skills.provisionClaudeConfig(configDir, disabledSkillIds)

    const connectors = await this.getConnectors()
    await syncConnectorSkillDocs(
      join(configDir, 'skills'),
      this.connectors.enabledConnectorIds(connectors)
    )

    return configDir
  }

  // Lists every bundled connector with enabled / auto-allow state, plus shared NCBI credential state.
  async listConnectors(): Promise<ConnectorsSnapshot> {
    return this.connectors.listConnectors()
  }

  // Returns one connector's view plus its tools (with per-tool permission) and metadata.
  async getConnectorDetail(id: string): Promise<ConnectorDetailView> {
    return this.connectors.getConnectorDetail(id)
  }

  // Enables/disables one bundled connector and returns the refreshed snapshot.
  async setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setConnectorEnabled(request)
  }

  // Toggles "skip approvals" for one connector (autoAllowIds) and returns the refreshed snapshot.
  async setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setConnectorAutoAllow(request)
  }

  // Sets one tool's policy (allow = run without a prompt [default], ask = require approval when no
  // remembered Broker grant applies, block = denied) and returns the refreshed detail.
  async setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView> {
    return this.connectors.setToolPermission(request)
  }

  // Sets or clears the shared contact email and NCBI API key (encrypted at rest), returning state.
  async setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.setNcbiCredentials(request)
  }

  // Adds a user-provided custom MCP server (add-time trust is the caller's responsibility). The
  // config is sanitized to enforce per-transport requirements before it is persisted.
  async addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.addCustomServer(request)
  }

  // Enables/disables one custom MCP server and returns the refreshed snapshot.
  async setCustomServerEnabled(
    request: SetCustomServerEnabledRequest
  ): Promise<ConnectorsSnapshot> {
    return this.connectors.setCustomServerEnabled(request)
  }

  // Removes one custom MCP server and returns the refreshed snapshot.
  async removeCustomServer(request: RemoveCustomServerRequest): Promise<ConnectorsSnapshot> {
    return this.connectors.removeCustomServer(request)
  }

  // Edits an existing custom MCP server, keeping its immutable identity (id, name, enabled, trust).
  // Omitted env/headers keep the stored secret values; providing them replaces the set. A caller can
  // invalidate remembered authority after validation but before persistence whenever the executable,
  // endpoint, transport, arguments, or credentials change. If invalidation fails, the old server
  // configuration remains authoritative.
  async updateCustomServer(
    request: UpdateCustomServerRequest,
    beforeSecuritySensitiveUpdate?: (
      serverId: string
    ) => Promise<CustomServerSecurityChangeGuard | void>
  ): Promise<ConnectorsSnapshot> {
    return this.connectors.updateCustomServer(request, beforeSecuritySensitiveUpdate)
  }

  // Reports whether npm is on PATH so the installer UI can default to/enable the npm source.
  async isNpmAvailable(): Promise<boolean> {
    const { available } = await detectNpmAvailable()

    return available
  }

  // Returns the bookmark folders for a provider. Used by the remote file browser Go-to dropdown.
  async getComputeBookmarks(providerId: string): Promise<string[]> {
    const settings = await this.repository.getSettings()
    const store = settings.computeBookmarks ?? {}
    const folders = store[providerId]
    return Array.isArray(folders) ? folders.filter((f): f is string => typeof f === 'string') : []
  }

  // Sets the bookmark folders for a provider. Replaces the full array for that provider.
  async setComputeBookmarks(providerId: string, folders: string[]): Promise<void> {
    await this.repository.setComputeBookmarks(providerId, folders)
  }

  // Builds the spawn env for the active provider, read fresh so switching takes effect on reconnect.
  async resolveActiveSpawnConfig(
    context: AgentBackendResolutionContext = {}
  ): Promise<AgentSpawnConfig> {
    const settings = await this.repository.getSettings()

    return this.resolveSpawnConfig(settings, new Set(context.forcedSkillIds ?? []))
  }

  private async resolveSpawnConfig(
    settings: StoredSettings,
    forcedSkillIds: ReadonlySet<string>,
    resolvedSelection?: { model?: string }
  ): Promise<AgentSpawnConfig> {
    let executablePath = settings.claude?.resolvedPath

    // Trust the stored path only if it still exists. A user who uninstalled Claude leaves a stale path
    // behind; spawning it launches a ghost that dies immediately (surfacing as write EPIPE), so fall
    // back to a live detect and, if that also finds nothing, fail with a clear, actionable message.
    if (!executablePath || !(await this.pathExists(executablePath))) {
      const detected = await detectClaude(this.detectDeps)
      executablePath = detected.found ? detected.path : undefined
    }

    if (!executablePath) {
      throw new Error(CLAUDE_EXECUTABLE_MISSING_MESSAGE)
    }

    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined

    if (!activeProvider) {
      throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    }

    if (activeProvider.type === 'claude-shared' && activeProvider.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }

    // Provision the app-owned runtime bundle. Shared auth reads credentials from ~/.claude while the
    // ACP session injects this bundle as a local plugin plus highest-priority settings layer.
    const appConfigDir = await this.provisionClaudeRuntimeConfig(settings, forcedSkillIds)

    const provider = this.providers.resolveProvider(
      activeProvider,
      resolvedSelection
        ? resolvedSelection.model
        : this.providers.resolveActiveModel(activeProvider, settings.activeModel)
    )
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })

    const sessionOptions =
      activeProvider.type === 'claude-shared'
        ? {
            settings: join(appConfigDir, 'settings.json'),
            plugins: [{ type: 'local', path: appConfigDir, skipMcpDiscovery: true }]
          }
        : provider.type === 'custom'
          ? {
              // Custom Anthropic-compatible gateways may work while Anthropic's domain preflight
              // endpoint is unreachable. Keep this override scoped to the ACP session so neither
              // project/user settings nor the isolated Claude runtime configuration are mutated.
              // V1 keeps provider-native WebFetch/WebSearch Once-only. This bypass removes Claude's
              // remote preflight dependency but does not create Session, Project, or Global grants.
              settings: {
                skipWebFetchPreflight: true,
                permissions: { ask: ['WebFetch'] }
              }
            }
          : undefined

    return {
      envOverrides,
      executablePath,
      sessionOptions,
      contextWindow: provider.contextWindow
    }
  }

  // Resolves the active agent backend for one connect: the selected framework plus its spawn inputs.
  // Claude reuses the existing provider-env path unchanged; other frameworks (opencode) map the active
  // provider to their own native config (a generated opencode.json) via the framework adapter and get
  // it written to disk before spawn. The framework can be forced with OPEN_SCIENCE_AGENT_FRAMEWORK for
  // the spike until the settings selector lands.
  async resolveActiveAgentBackend(
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const settings = await this.repository.getSettings()
    const forced = process.env.OPEN_SCIENCE_AGENT_FRAMEWORK
    const frameworkId: AgentFrameworkId =
      forced === 'opencode' || forced === 'claude-code' || forced === 'codex'
        ? forced
        : (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)

    return this.resolveAgentBackendFromSettings(settings, frameworkId, context)
  }

  // Captures only non-secret backend identity. Runtime generations resolve credentials again at spawn,
  // so decrypted keys are not retained by the coordinator after AcpRuntime finishes authentication.
  async captureActiveAgentBackendSelection(): Promise<AgentBackendSelection> {
    const settings = await this.repository.getSettings()
    const forced = process.env.OPEN_SCIENCE_AGENT_FRAMEWORK
    const frameworkId: AgentFrameworkId =
      forced === 'opencode' || forced === 'claude-code' || forced === 'codex'
        ? forced
        : (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)

    return { frameworkId }
  }

  async resolveAgentBackend(
    selection: AgentBackendSelection,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const stored = await this.repository.getSettings()
    const settings: StoredSettings = {
      ...stored,
      agentFrameworkId: selection.frameworkId
    }

    return this.resolveAgentBackendFromSettings(settings, selection.frameworkId, context)
  }

  private async resolveAgentBackendFromSettings(
    settings: StoredSettings,
    frameworkId: AgentFrameworkId,
    context: AgentBackendResolutionContext
  ): Promise<ResolvedAgentBackend> {
    const forcedSkillIds = new Set(context.forcedSkillIds ?? [])
    const framework = getAgentFramework(frameworkId)
    // 'default' means "don't override": nothing is sent over ACP or framework config, so the agent
    // keeps its own default effort. A concrete intent is projected through the active model profile
    // exactly once here, then delivered through the framework config and ACP session channels. Those
    // transports receive the same model-native value and must not independently reinterpret it.

    // Enforce provider↔framework compatibility up front so an incompatible pair fails with a clear
    // message instead of spawning an agent that can't use the credentials — e.g. OpenCode + a Local
    // Claude provider (Claude-only login), or Claude + an OpenAI-only gateway.
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined

    if (!activeProvider) {
      throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    }

    // Resolve the model exactly once for this backend generation. The same selection drives the
    // model profile, bridge compatibility, and the framework config so a refreshed catalog cannot
    // make the effort belong to one model while the request is sent to another.
    const effectiveModel = this.providers.resolveActiveModel(activeProvider, settings.activeModel)
    const effortIntent = settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    const reasoningEffortProfile = resolveProviderReasoningEffortProfile(
      activeProvider,
      effectiveModel
    )
    const resolvedEffort =
      effortIntent === DEFAULT_REASONING_EFFORT
        ? DEFAULT_REASONING_EFFORT
        : resolveReasoningEffortValue(effortIntent, reasoningEffortProfile)
    const sessionEffort: ModelReasoningEffort | undefined =
      resolvedEffort === 'default' ? undefined : resolvedEffort
    const supportedReasoningEfforts = reasoningEffortProfile.supported
      ? [...new Set(reasoningEffortProfile.slots)]
      : undefined

    if (
      !isProviderUsableByFramework(
        {
          apiEndpoints: this.providers.resolveProviderApiEndpoints(activeProvider, effectiveModel),
          type: activeProvider.type
        },
        framework
      )
    ) {
      throw new Error(buildActiveModelIncompatibleMessage(framework.displayName))
    }

    const activeConnectorIds = this.connectors.enabledConnectorIds(settings.connectors)
    const connectorInstructions = renderConnectorInstructions(activeConnectorIds)

    if (framework.id === 'codex' && !isModelBridgeSupported(activeProvider, effectiveModel)) {
      throw new Error(CODEX_BRIDGE_UNSUPPORTED_MESSAGE)
    }

    if (framework.id === 'claude-code') {
      // Claude path: app-owned runtime provisioning + Anthropic-shaped env + local-auth handling.
      const { envOverrides, executablePath, sessionOptions, contextWindow } =
        await this.resolveSpawnConfig(settings, forcedSkillIds, { model: effectiveModel })

      return {
        framework,
        backendId: `${framework.id}:${activeProvider.id}`,
        executablePath,
        env: envOverrides,
        sessionOptions,
        sessionEffort,
        contextWindow,
        contextUsageModel: effectiveModel
      }
    }

    const executablePath =
      framework.id === 'codex'
        ? await this.resolveCodexExecutable(
            settings.codex?.resolvedPath,
            settings.codex?.nativePath
          )
        : await this.resolveOpencodeExecutable(settings.opencodePath)
    // Model metadata is a compatibility contract with the native Codex binary that is about to
    // start. Probe that exact executable now instead of trusting a cached version from detection;
    // a missing or stale cache must only make us choose the conservative generated catalog.
    const codexNativeVersion =
      framework.id === 'codex'
        ? await this.probeCodexNativeVersion(settings.codex?.nativePath)
        : undefined
    const provider = this.providers.resolveProvider(activeProvider, effectiveModel)
    if (framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)) {
      // Runtime resolution can be reached without opening a Settings auth session first. Enforce
      // file-backed credentials here as well so a direct prompt never falls through to the user's
      // global Codex keyring.
      await ensureCodexAuthHome('isolated', this.storageRoot)
    }
    // `codex-shared` is accepted only as a legacy/provider-time import request. Every runtime
    // subscription record converges on the same app-owned backend and profile boundary.
    const backendProviderId =
      framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)
        ? CODEX_ISOLATED_PROVIDER_ID
        : activeProvider.id
    const skillsRoot =
      framework.id === 'codex'
        ? isCodexSubscriptionProvider(provider.type)
          ? codexSubscriptionStorageDir(this.storageRoot)
          : codexStorageDir(this.storageRoot)
        : opencodeConfigDir(this.storageRoot)
    await this.materializeAgentSkills(settings, skillsRoot, forcedSkillIds)
    // Chat-only providers require protocol translation. Non-OpenAI native Responses providers keep
    // their protocol, but use a narrow compatibility proxy because Codex emits namespace tools while
    // several compatible APIs accept only flat function names. Official OpenAI and subscriptions
    // already implement Codex's native wire contract and remain direct.
    const needsChatResponsesBridge = requiresChatCompletionsBridge(provider, framework)
    const needsNativeResponsesCompatibility = requiresNativeResponsesCompatibility(
      provider,
      framework
    )
    // A bridge may still serve a live Codex runtime from an earlier framework generation. Do not stop
    // or retarget it merely because the newly selected framework/provider does not need one.
    const responsesBridge = needsChatResponsesBridge
      ? await this.ensureResponsesBridge(
          provider,
          sessionEffort,
          settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED
        )
      : needsNativeResponsesCompatibility
        ? await this.ensureNativeResponsesCompatibility(provider)
        : undefined
    try {
      const modelConfig = framework.prepareModelConfig(provider, {
        storageRoot: this.storageRoot,
        executablePath,
        ...(codexNativeVersion ? { nativeVersion: codexNativeVersion } : {}),
        responsesBridge,
        reasoningEffort: sessionEffort,
        reasoningEfforts: supportedReasoningEfforts,
        // Keep only connector calling conventions in OpenCode's baseline. Detailed tools are already
        // materialized as on-demand `mcp-*` skills above, avoiding a full catalog in every request.
        instructions: connectorInstructions
      })
      await writeAgentConfigFiles(modelConfig.configFiles)
      const opencodeUsagePort =
        framework.id === 'opencode' ? await this.allocateOpenCodeUsagePort() : undefined
      const opencodeUsagePassword = opencodeUsagePort === undefined ? undefined : randomUUID()
      const usesCodexSystemProxy =
        framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)
      const proxyEnv = usesCodexSystemProxy ? await this.resolveCodexProxyEnvironment() : undefined

      // Protocol-driven frameworks apply an explicit model through the ACP session configOption. A Codex
      // subscription with no explicit selection leaves this undefined so Codex uses the account default.
      const sessionModel = modelConfig.sessionModel ?? provider.model
      return {
        framework,
        backendId: `${framework.id}:${backendProviderId}`,
        executablePath,
        env: {
          ...(modelConfig.env ?? {}),
          ...(opencodeUsagePassword ? { OPENCODE_SERVER_PASSWORD: opencodeUsagePassword } : {}),
          ...(proxyEnv ?? {}),
          ...(framework.id === 'codex' && settings.codex?.nativePath
            ? { CODEX_PATH: settings.codex.nativePath }
            : {})
        },
        args:
          opencodeUsagePort === undefined
            ? modelConfig.args
            : [
                ...(modelConfig.args ?? []),
                '--port',
                String(opencodeUsagePort),
                '--hostname',
                '127.0.0.1'
              ],
        ...(usesCodexSystemProxy
          ? { proxyEnvironmentMode: proxyEnv === undefined ? 'inherit' : 'replace' }
          : {}),
        sessionModel,
        ...(framework.id === 'codex' && isCodexSubscriptionProvider(provider.type) && sessionModel
          ? { sessionModelRequired: true }
          : {}),
        sessionEffort,
        contextWindow: provider.contextWindow,
        contextUsageModel: provider.model,
        authentication: modelConfig.authentication,
        providerConfiguration: modelConfig.providerConfiguration,
        ...(opencodeUsagePort === undefined || !opencodeUsagePassword
          ? {}
          : {
              opencodeUsageApi: {
                baseUrl: `http://127.0.0.1:${opencodeUsagePort}`,
                authorization: `Basic ${Buffer.from(`opencode:${opencodeUsagePassword}`).toString('base64')}`
              }
            }),
        responsesBridgeLease: responsesBridge?.lease
      }
    } catch (error) {
      await responsesBridge?.lease.release()
      throw error
    }
  }

  private async ensureResponsesBridge(
    provider: ResolvedProvider,
    reasoningEffort: ModelReasoningEffort | undefined,
    conversationSkillImportEnabled: boolean
  ): Promise<LeasedResponsesBridgeConnection> {
    // Resolve to the OpenAI base the bridge appends `/chat/completions` to: an official vendor's exact
    // versioned base, or a custom gateway root normalized to `<root>/v1`.
    const targetBaseUrl = openAiCompletionsBase(provider)
    if (!targetBaseUrl) throw new Error('The Chat Completions provider has no base URL.')

    const target = {
      baseUrl: targetBaseUrl,
      key: provider.key,
      vendorId: provider.vendorId,
      reasoningEffortTransport: provider.reasoningEffortTransport,
      model: provider.model,
      reasoningEffort,
      namespacedTools: [
        ...CODEX_BRIDGE_NOTEBOOK_TOOLS,
        ...CODEX_BRIDGE_ARTIFACT_TOOLS,
        ...CODEX_BRIDGE_ACTIVITY_TOOLS,
        ...(conversationSkillImportEnabled ? CODEX_BRIDGE_SKILL_IMPORT_TOOLS : [])
      ],
      reviewerScope: {
        namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS
      }
    }
    const bridgeId = randomUUID()
    const bridge = new ResponsesBridge(target)
    const entry = { bridge, connection: bridge.start() }
    this.responsesBridges.set(bridgeId, entry)

    let connection: ResponsesBridgeConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.responsesBridges.get(bridgeId) === entry) this.responsesBridges.delete(bridgeId)
      await entry.bridge.close().catch(() => undefined)
      throw error
    }

    let released = false
    const leasedEntry = entry
    return {
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal) =>
          leasedEntry.bridge.selectSkills(text, catalog, signal),
        registerReviewerSession: (promptCacheKey) =>
          leasedEntry.bridge.registerReviewerSession(promptCacheKey),
        unregisterReviewerSession: (promptCacheKey) =>
          leasedEntry.bridge.unregisterReviewerSession(promptCacheKey),
        setReasoningEffort: (effort) => leasedEntry.bridge.setReasoningEffort(effort),
        release: async () => {
          if (released) return
          released = true
          if (this.responsesBridges.get(bridgeId) !== leasedEntry) return
          this.responsesBridges.delete(bridgeId)
          await leasedEntry.bridge.close()
        }
      }
    }
  }

  private async ensureNativeResponsesCompatibility(
    provider: ResolvedProvider
  ): Promise<LeasedResponsesBridgeConnection> {
    const targetBaseUrl = normalizeResponsesBaseUrl(provider.openaiBaseUrl ?? provider.baseUrl)
    if (!targetBaseUrl) throw new Error('The native Responses provider has no base URL.')

    const proxyId = randomUUID()
    const proxy = new NativeResponsesCompatibilityProxy({
      baseUrl: targetBaseUrl,
      key: provider.key,
      model: provider.model,
      reviewerScope: { namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS }
    })
    const entry = { proxy, connection: proxy.start() }
    this.nativeResponsesCompatibilityProxies.set(proxyId, entry)

    let connection: ResponsesBridgeConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.nativeResponsesCompatibilityProxies.get(proxyId) === entry) {
        this.nativeResponsesCompatibilityProxies.delete(proxyId)
      }
      await entry.proxy.close().catch(() => undefined)
      throw error
    }

    let released = false
    const leasedEntry = entry
    return {
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal) =>
          leasedEntry.proxy.selectSkills(text, catalog, signal),
        registerReviewerSession: (promptCacheKey) =>
          leasedEntry.proxy.registerReviewerSession(promptCacheKey),
        unregisterReviewerSession: (promptCacheKey) =>
          leasedEntry.proxy.unregisterReviewerSession(promptCacheKey),
        release: async () => {
          if (released) return
          released = true
          if (this.nativeResponsesCompatibilityProxies.get(proxyId) !== leasedEntry) return
          this.nativeResponsesCompatibilityProxies.delete(proxyId)
          await leasedEntry.proxy.close()
        }
      }
    }
  }

  // Locates the opencode binary: an explicitly stored path wins, else a best-effort PATH lookup.
  private async resolveOpencodeExecutable(storedPath: string | undefined): Promise<string> {
    // Trust the stored path only if it still exists. A user who uninstalled opencode leaves a stale
    // path behind; spawning it launches a ghost that dies immediately (surfacing as write EPIPE), so
    // fall back to a live detect and, if that also finds nothing, fail with a clear, actionable message.
    if (storedPath && (await this.pathExists(storedPath))) return storedPath

    const detected = await detectOpencode(this.opencodeDetectDeps)

    if (!detected) {
      throw new Error(
        'opencode executable not found. Install opencode or set its path in settings.'
      )
    }

    return detected.resolvedPath
  }

  private async resolveCodexExecutable(
    storedPath: string | undefined,
    nativePath: string | undefined
  ): Promise<string> {
    // `storedPath` can contain a legacy/global codex-acp path. It remains useful as migration
    // evidence only; runtime and authentication must always cross the app-controlled adapter where
    // Open Science applies its pinned ACP extensions. A global installation may supply CODEX_PATH,
    // never the adapter process itself.
    void storedPath
    if (!nativePath) {
      throw new Error('Codex native executable not found. Re-detect or install Codex in settings.')
    }
    const adapterPath =
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.storageRoot)
    if (!(await this.pathExists(adapterPath))) {
      throw new Error('Open Science Codex ACP adapter not found. Install Codex in settings.')
    }

    await ensureManagedCodexContextUsage(adapterPath)
    return adapterPath
  }

  private async probeCodexNativeVersion(
    nativePath: string | undefined
  ): Promise<string | undefined> {
    if (!nativePath) return undefined

    const output = await this.codexDetectDeps.getCodexVersion(nativePath).catch(() => undefined)
    return output ? parseCodexVersion(output) : undefined
  }

  private resolveReasoningEffortFromSettings(
    settings: StoredSettings,
    intent: ReasoningEffort
  ): ResolvedReasoningEffort {
    if (intent === DEFAULT_REASONING_EFFORT) return DEFAULT_REASONING_EFFORT

    const provider = settings.activeProviderId
      ? settings.providers.find((candidate) => candidate.id === settings.activeProviderId)
      : undefined
    if (!provider) return DEFAULT_REASONING_EFFORT

    const profile = resolveProviderReasoningEffortProfile(
      provider,
      this.providers.resolveActiveModel(provider, settings.activeModel)
    )

    return resolveReasoningEffortValue(intent, profile)
  }

  private async runClaudeSubscriptionProbe(
    provider: ResolvedProvider,
    settings: StoredSettings
  ): Promise<ValidateProviderResult> {
    const executablePath = settings.claude?.resolvedPath

    if (!executablePath) {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude executable is not configured. Complete Claude detection in settings first.'
      }
    }

    const appConfigDir = await this.provisionClaudeRuntimeConfig(settings)
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })
    const env = buildAgentSpawnEnv(augmentedPathEnv(process.env), envOverrides, executablePath)

    try {
      if (provider.type === 'claude-shared') {
        await this.executeClaudeProbe(executablePath, env, [
          '--settings',
          join(appConfigDir, 'settings.json'),
          '--plugin-dir',
          appConfigDir
        ])
      } else {
        await this.executeClaudeProbe(executablePath, env)
      }

      return { ok: true, category: 'ok' }
    } catch (error) {
      if (isTimeoutError(error)) {
        return {
          ok: false,
          category: 'timeout',
          message:
            provider.type === 'claude-shared'
              ? 'Claude shared-profile validation timed out. Try again.'
              : 'Claude token validation timed out. Try again.'
        }
      }

      const category = classifyClaudeProbeFailure(error)
      const messages =
        provider.type === 'claude-shared'
          ? {
              auth: 'Claude rejected the shared profile. Sign in again and retry.',
              network:
                'Claude could not reach Anthropic while validating the shared profile. Check your network and try again.',
              unknown:
                'Claude could not run the shared-profile validation probe. Re-detect Claude and try again.'
            }
          : {
              auth: 'Claude rejected the setup token. Run `claude setup-token` again and paste a new token.',
              network:
                'Claude could not reach Anthropic while validating the token. Check your network and try again.',
              unknown:
                'Claude could not run the token validation probe. Re-detect Claude and try again.'
            }

      return { ok: false, category, message: messages[category] }
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK)

      return true
    } catch {
      return false
    }
  }
}

// Production service rooted at the shared storage root with real detection dependencies.
const createDefaultSettingsService = (): SettingsService => new SettingsService()

export { SettingsService, createDefaultSettingsService }
export type { CustomServerSecurityChangeGuard }

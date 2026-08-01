import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { isDeepStrictEqual, promisify } from 'node:util'

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
  ChatApiEndpoint,
  Preflight,
  ProviderDraft,
  ProviderView,
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
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_ISOLATED_PROVIDER_ID,
  claudeIsolatedProviderIdentity,
  claudeSharedProviderIdentity,
  codexSubscriptionProviderIdentity,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isClaudeSubscriptionProvider,
  isClaudeSubscriptionProviderId,
  isCodexSubscriptionProvider,
  isCodexSubscriptionProviderId,
  isProviderUsableByFramework,
  providerEndpoints,
  resolveCodexSubscriptionType,
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
import {
  defaultVendorModel,
  getOfficialVendorModelIds,
  isModelBridgeSupported,
  isOfficialVendorId,
  isVendorModelMultimodal,
  isVendorModelResponsesSupported,
  resolveCustomModelContextWindow,
  resolveModelContextWindow,
  resolveVendorApiEndpoints,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile
} from '../../shared/provider-reasoning-effort'
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
  isOfficialOpenAiResponsesBase,
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
import { encryptKey, isEncryptionAvailable, maskKey, tryDecryptKey } from './crypto'
import { augmentedPathEnv } from './shell-path'
import { computePreflight } from './preflight'
import { listProviderModels } from './list-models'
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
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import { syncConnectorSkillDocs } from '../connectors/provision'
import { SkillRegistry } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { netFetchStandard } from '../skills/net-fetch'
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
import type { StoredConnectors, StoredCodexInfo, StoredProvider, StoredSettings } from './types'
import { classifyStatus, validateProvider } from './validate'
import {
  clearAppOwnedCodexAuthentication,
  clearImportedCodexProviderRoute,
  CodexAuthController,
  ensureCodexAuthHome,
  importCodexAuthentication,
  openCodexAuthSession,
  type CodexAuthControllerPort,
  type CodexAuthStatus
} from './codex-auth'

import { resolveSystemProxyEnvironment, type SystemProxyEnvironment } from './system-proxy'
import {
  ClaudeIsolatedAuthController,
  type ClaudeIsolatedAuthControllerPort,
  type ClaudeIsolatedAuthStatus
} from './claude-isolated-auth'
import {
  ClaudeSharedAuthController,
  type ClaudeSharedAuthControllerPort,
  type ClaudeSharedAuthStatus
} from './claude-shared-auth'

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
// Anthropic documents `claude setup-token` as a one-year long-lived OAuth token. We surface
// "expires <date>" on the Settings card using this estimate until the first Claude session returns
// a real expiry. A one-year window is a coarse upper bound; a token that the underlying
// subscription has already revoked surfaces as a validation failure on first use, so the worst case
// is a card that says "expires in a year" for a credential that actually expires sooner.
const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000
const CLAUDE_SHARED_AUTH_STATUS_TTL_MS = 5_000
const CLAUDE_SHARED_DISCONNECTED_MESSAGE =
  'Claude is disconnected from Open Science. Sign in again to use your shared Claude profile.'
const CODEX_INSTALL_TARGET: InstallTarget = {
  npmPackage: '@agentclientprotocol/codex-acp',
  // Codex exposes no supported shell installer; InstallCodexRequest cannot select this branch.
  scriptUnix: ''
}

// Native Responses vendors other than OpenAI run through a protocol-preserving proxy because Codex
// emits namespace tools that those upstream APIs do not accept directly. Validation and runtime must
// share this predicate so a passing test proves the same path the agent will use.
const requiresNativeResponsesCompatibility = (
  provider: ResolvedProvider,
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ChatApiEndpoint[] }
): boolean =>
  framework.id === 'codex' &&
  framework.supportedApiTypes.includes('responses') &&
  providerEndpoints(provider).includes('responses') &&
  !isCodexSubscriptionProvider(provider.type) &&
  provider.vendorId !== 'openai' &&
  !isOfficialOpenAiResponsesBase(provider.openaiBaseUrl ?? provider.baseUrl)

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
  private readonly storageRoot: string
  private readonly detectDeps: ClaudeDetectDeps
  private readonly opencodeDetectDeps: OpencodeDetectDeps
  private readonly allocateOpenCodeUsagePort: () => Promise<number>
  private readonly codexDetectDeps: CodexDetectDeps
  private readonly userClaudeDir: string
  private readonly userCodexDir: string
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
  private readonly codexAuth: CodexAuthControllerPort
  private readonly claudeIsolatedAuth: ClaudeIsolatedAuthControllerPort
  private readonly claudeSharedAuth: ClaudeSharedAuthControllerPort
  private claudeSharedAuthStatusCache: { authenticated: boolean; checkedAt: number } | undefined
  private claudeSharedAuthStatusGeneration = 0
  private claudeSharedAuthStatusPromise:
    { generation: number; promise: Promise<boolean> } | undefined
  // A bridge owns mutable per-runtime state (reasoning override, reviewer scopes, and reasoning
  // replay). Track each backend generation separately so an overlapping reconnect cannot mutate the
  // bridge still serving the retiring generation.
  private readonly responsesBridges = new Map<string, ResponsesBridgeEntry>()
  private readonly nativeResponsesCompatibilityProxies = new Map<
    string,
    NativeResponsesCompatibilityEntry
  >()
  private providerSequence = 0
  private readonly providerValidationGenerations = new Map<string, number>()

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
    this.userCodexDir = options.userCodexDir ?? join(homedir(), '.codex')
    this.skills = new SkillCatalogModule({
      repository: this.repository,
      storageRoot: this.storageRoot,
      userClaudeDir: this.userClaudeDir,
      userCodexDir: this.userCodexDir,
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
    this.codexAuth =
      options.codexAuth ??
      new CodexAuthController({
        openSession: async (mode) => {
          const settings = await this.repository.getSettings()
          return openCodexAuthSession({
            adapterPath: await this.resolveCodexExecutable(
              settings.codex?.resolvedPath,
              settings.codex?.nativePath
            ),
            nativePath: settings.codex?.nativePath,
            mode,
            storageRoot: this.storageRoot,
            proxyEnv: await this.resolveCodexProxyEnvironment()
          })
        }
      })
    // The claude-isolated token is stored on the (single) builtin-claude-isolated provider record,
    // so the controller reads/writes that record directly. The renderer creates the record before
    // sign-in; conditional writes keep a late browser result from recreating it after deletion.
    this.claudeIsolatedAuth =
      options.claudeIsolatedAuth ??
      new ClaudeIsolatedAuthController({
        store: {
          loadToken: () => this.loadClaudeIsolatedToken(),
          saveToken: (token) => this.saveClaudeIsolatedToken(token),
          clearToken: () => this.clearClaudeIsolatedToken(),
          isEncryptionAvailable: () => isEncryptionAvailable()
        },
        // Resolve the path lazily so a just-detected app-managed binary is used without requiring a
        // service restart. Falls back to 'claude' on PATH if detection hasn't run yet.
        claudePath: async () => {
          const s = await this.repository.getSettings()
          return s.claude?.resolvedPath ?? 'claude'
        },
        configDir: getAppClaudeConfigDir(this.storageRoot)
      })
    this.claudeSharedAuth =
      options.claudeSharedAuth ??
      new ClaudeSharedAuthController({
        // Same lazy resolution: use the detected absolute path so app-managed binaries not on PATH work.
        claudePath: async () => {
          const s = await this.repository.getSettings()
          return s.claude?.resolvedPath ?? 'claude'
        },
        configDir: this.userClaudeDir
      })
  }

  // Reads (and decrypts) the long-lived OAuth token stored on the single builtin-claude-isolated
  // provider record. Reading before the renderer has created that record returns undefined, which
  // the controller renders as "not signed in".
  private async loadClaudeIsolatedToken(): Promise<string | undefined> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )

    if (!provider?.keyRef) return undefined

    return tryDecryptKey(provider.keyRef)
  }

  // Persists the encrypted OAuth token only while the builtin-claude-isolated provider still exists.
  // The renderer creates the record before either sign-in flow starts; refusing to upsert here keeps
  // a late browser completion from recreating a provider that the user deleted in the meantime.
  private async saveClaudeIsolatedToken(token: string): Promise<void> {
    const keyRef = encryptKey(token)
    const applied = await this.repository.updateClaudeIsolatedCredentialsIfExists({
      keyRef,
      keyMask: maskKey(token)
    })

    if (!applied) throw new Error('The Claude provider was removed before sign-in completed.')
  }

  // Drops the stored token when the record still exists. A concurrent provider deletion wins without
  // allowing this cleanup path to recreate an empty subscription record.
  private async clearClaudeIsolatedToken(): Promise<void> {
    await this.repository.updateClaudeIsolatedCredentialsIfExists({
      keyRef: undefined,
      keyMask: undefined
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
        this.toProviderView(
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
    let changed = false

    for (const provider of settings.providers) {
      if (!provider.keyRef?.startsWith('plain:')) continue
      const key = tryDecryptKey(provider.keyRef)
      if (!key) continue
      await this.repository.upsertProvider({ ...provider, keyRef: encryptKey(key) })
      changed = true
    }

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
      ? this.resolveProviderApiEndpoints(activeProvider, activeProvider.model)
      : undefined
    const activeProviderCompatible = activeProvider
      ? isProviderUsableByFramework(
          { apiEndpoints: activeEndpoints, type: activeProvider.type },
          framework
        ) &&
        (framework.id !== 'codex' ||
          isModelBridgeSupported(
            activeProvider,
            this.resolveActiveModel(activeProvider, settings.activeModel)
          ))
      : false
    const activeProviderKeyUsable =
      activeProvider && activeProvider.lastValidatedAt !== undefined
        ? await this.isProviderKeyUsable(activeProvider)
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

  // Runs the one-click installer, then re-detects claude so a success immediately unblocks the gate.
  // The app-managed source downloads the native binary itself and persists its exact path; the npm and
  // official-script sources shell out (with an automatic npm fallback when the official script is
  // region-blocked) and rely on PATH re-detection.
  async installClaude(
    request: InstallClaudeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    this.providerSequence += 1
    const installId = `install-${Date.now()}-${this.providerSequence}`

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
    this.providerSequence += 1
    const installId = `install-opencode-${Date.now()}-${this.providerSequence}`

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
    this.providerSequence += 1
    const installId = `install-codex-${Date.now()}-${this.providerSequence}`

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

  // Encrypts any new key, recomputes its mask, and inserts/updates the provider record.
  async upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()
    // Both Codex and Claude subscription providers use a fixed builtin id so the add path, the
    // token-save path, and every id-keyed lookup in this service converge on a single record.
    // Without this, a random id from `createProviderId()` would shadow the token-holding record
    // and the active provider would spawn the agent unauthenticated.
    const subscriptionIdentity = isCodexSubscriptionProvider(request.type)
      ? codexSubscriptionProviderIdentity()
      : request.type === 'claude-isolated'
        ? claudeIsolatedProviderIdentity()
        : request.type === 'claude-shared'
          ? claudeSharedProviderIdentity()
          : undefined
    const requestedId = subscriptionIdentity?.id ?? request.id
    const existing = requestedId
      ? settings.providers.find((provider) => provider.id === requestedId)
      : undefined

    // An imported subscription becomes app-owned after the initial copy. Ordinary edits must not
    // depend on the external CLI profile still existing or re-read a route that changed afterward.
    // Only a new import, an explicit isolated -> imported switch, or the card's explicit re-import
    // action crosses that profile boundary.
    const reimportCodexAuthentication =
      request.type === 'codex-shared' && request.reimportCodexAuthentication === true
    if (
      request.type === 'codex-shared' &&
      (existing?.codexAuthMode !== 'imported' || reimportCodexAuthentication)
    ) {
      // The isolated adapter owns auth.json until its session has closed. Waiting here prevents a
      // late browser-login write from replacing the credentials copied immediately below.
      await this.codexAuth.cancelLogin()
      await importCodexAuthentication(
        this.userCodexDir,
        codexSubscriptionStorageDir(this.storageRoot)
      )
      // Re-import can replace auth.json and the loopback route without changing any persisted
      // provider field. Advance the generation so a status check started against the previous copy
      // cannot write its result onto the refreshed credentials.
      if (reimportCodexAuthentication && requestedId) {
        this.advanceProviderValidationGeneration(requestedId)
      }
    } else if (request.type === 'codex-isolated' && existing?.codexAuthMode !== 'isolated') {
      if (existing) await this.codexAuth.cancelLogin()
      const codexHome = codexSubscriptionStorageDir(this.storageRoot)
      await clearImportedCodexProviderRoute(codexHome)
      await clearAppOwnedCodexAuthentication(codexHome)
    }
    if (isCodexSubscriptionProvider(request.type)) {
      await ensureCodexAuthHome(
        request.type === 'codex-shared' ? 'shared' : 'isolated',
        this.storageRoot
      )
    }

    const provider: StoredProvider = {
      id: subscriptionIdentity?.id ?? existing?.id ?? this.createProviderId(),
      // A legacy shared selection performs a one-time credential import above, then converges on the
      // same app-owned runtime form as an in-app sign-in.
      type: request.type === 'codex-shared' ? 'codex-isolated' : request.type,
      name:
        subscriptionIdentity?.name ??
        (request.name?.trim() || existing?.name || 'Untitled provider')
    }

    // Both custom and official gateways authenticate with a bearer key; carry it (or keep the stored
    // ciphertext on edit) via one shared helper.
    const carryKey = (): boolean => {
      const hasKey = Boolean(request.key) || Boolean(existing?.keyRef)

      if (request.key) {
        provider.keyRef = encryptKey(request.key)
        provider.keyMask = maskKey(request.key)
      } else if (existing?.keyRef) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }

      return hasKey
    }

    // Tracks whether credentials/endpoint changed, which invalidates a prior validation.
    let credentialsChanged = false

    if (isCodexSubscriptionProvider(request.type)) {
      provider.apiEndpoints = ['responses']
      provider.codexAuthMode = request.type === 'codex-shared' ? 'imported' : 'isolated'
      credentialsChanged =
        existing !== undefined &&
        (existing.codexAuthMode !== provider.codexAuthMode || reimportCodexAuthentication)
    } else if (request.type === 'claude-isolated') {
      // claude-isolated has no fields of its own: the type tells the renderer/env-builder what to do
      // with the encrypted token (stored separately on login). A model override is allowed. The
      // encrypted token AND the credential's estimated expiry
      // must carry over an edit so a model change does not silently drop the stored credential or
      // hide the Expires <date> on the Settings card; sign-in itself is handled by
      // loginIsolatedClaude, which sets expiresAt on a fresh paste.
      provider.apiEndpoints = ['anthropic']
      if (existing?.keyRef) {
        provider.keyRef = existing.keyRef
        provider.keyMask = existing.keyMask
      }
      if (existing?.expiresAt !== undefined) {
        provider.expiresAt = existing.expiresAt
      }
      const model =
        request.model === undefined ? existing?.model : request.model.trim() || undefined
      credentialsChanged = model !== existing?.model

      if (model) provider.model = model
    } else if (request.type === 'claude-shared') {
      // claude-shared credentials live in ~/.claude, managed by the CLI. No token or expiry to
      // carry over; only the optional model override is stored on the record.
      provider.apiEndpoints = ['anthropic']
      const model =
        request.model === undefined ? existing?.model : request.model.trim() || undefined
      credentialsChanged = model !== existing?.model

      if (model) provider.model = model
      if (existing?.disconnectedAt !== undefined) provider.disconnectedAt = existing.disconnectedAt
    } else if (request.type === 'official') {
      // Base URL and model catalog come from the registry; the provider only stores which vendor
      // (and, for multi-region vendors, which endpoint) plus the key.
      const vendorId = isOfficialVendorId(request.vendorId) ? request.vendorId : existing?.vendorId

      if (!vendorId) throw new Error('A vendor is required for an official provider.')

      const region = request.region ?? existing?.region

      // Official providers store no model of their own: the catalog is fixed by the registry and the
      // chosen model is the global selection (activeModel). Only vendor/region/key are persisted.
      provider.vendorId = vendorId
      if (region) provider.region = region
      // Keep any live-fetched models across an edit, unless the vendor itself changed (then they're
      // stale and will be re-fetched on demand).
      if (existing?.fetchedModels && vendorId === existing.vendorId) {
        provider.fetchedModels = existing.fetchedModels
      }

      if (!carryKey()) throw new Error('API key is required for an official provider.')

      credentialsChanged =
        Boolean(request.key) ||
        provider.vendorId !== existing?.vendorId ||
        provider.region !== existing?.region
    } else if (request.type === 'custom') {
      const baseUrl = request.baseUrl?.trim() || existing?.baseUrl
      const model = request.model?.trim() || existing?.model
      const contextWindow =
        request.contextWindow === null
          ? undefined
          : (request.contextWindow ?? existing?.contextWindow)

      // Required-field guard: never persist an incomplete custom provider, even if the UI is bypassed.
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      if (!model) throw new Error('Model is required for a custom provider.')
      if (!carryKey()) throw new Error('API key is required for a custom provider.')
      if (
        contextWindow !== undefined &&
        (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
      ) {
        throw new Error('Context window must be a positive whole number of tokens.')
      }

      const apiEndpoints = request.apiEndpoints ?? existing?.apiEndpoints ?? ['anthropic']

      provider.baseUrl = baseUrl
      provider.model = model
      if (contextWindow !== undefined) provider.contextWindow = contextWindow
      provider.supportsImageInput =
        request.supportsImageInput ?? existing?.supportsImageInput ?? false
      provider.reasoningEffortPreset =
        request.reasoningEffortPreset ?? existing?.reasoningEffortPreset ?? 'standard-5'
      provider.reasoningEffortTransport =
        request.reasoningEffortTransport ?? existing?.reasoningEffortTransport ?? 'reasoning-effort'
      // Which chat APIs this gateway speaks (drives per-framework availability); defaults to anthropic.
      provider.apiEndpoints = apiEndpoints
      credentialsChanged =
        Boolean(request.key) ||
        provider.baseUrl !== existing?.baseUrl ||
        provider.model !== existing?.model ||
        provider.apiEndpoints.join(',') !== (existing?.apiEndpoints ?? []).join(',')
    }

    // A re-test is required before a changed provider can re-gate onboarding.
    if (existing?.lastValidatedAt !== undefined && !credentialsChanged) {
      provider.lastValidatedAt = existing.lastValidatedAt
    }

    // Carry a prior failure only while credentials are unchanged; a credential change invalidates it
    // (the provider must be re-tested), so it drops and the warning clears until the next test. A local
    // shared-Claude disconnect is different: model edits must keep its renderer-visible auth failure
    // until browser login clears disconnectedAt, or pickers can offer a profile runtime will reject.
    const preserveValidationFailure =
      !credentialsChanged ||
      (provider.type === 'claude-shared' && provider.disconnectedAt !== undefined)
    if (existing?.lastValidationFailure !== undefined && preserveValidationFailure) {
      provider.lastValidationFailure = existing.lastValidationFailure
    }

    // Claude auth modes own separate fixed records. Keep the sibling record so switching modes does
    // not discard its credential or validation state; the renderer collapses both records into one
    // card and prefers the active id.
    if (isClaudeSubscriptionProvider(provider.type)) {
      const outgoingId =
        provider.type === 'claude-shared' ? CLAUDE_ISOLATED_PROVIDER_ID : CLAUDE_SHARED_PROVIDER_ID
      const collapsedCardWasActive =
        settings.activeProviderId === provider.id || settings.activeProviderId === outgoingId

      await this.repository.upsertProvider(provider)

      // Move an active collapsed card to the selected mode and use that mode's saved model/default.
      // An inactive sibling remains inactive.
      if (collapsedCardWasActive) {
        await this.repository.setActiveProvider(provider.id, this.resolveActiveModel(provider))
      }

      return this.getSettingsView()
    }

    await this.repository.upsertProvider(provider)

    return this.getSettingsView()
  }

  async deleteProvider(id: string): Promise<SettingsSnapshot> {
    if (isCodexSubscriptionProviderId(id)) {
      await this.codexAuth.cancelLogin()
      const codexHome = codexSubscriptionStorageDir(this.storageRoot)
      await clearImportedCodexProviderRoute(codexHome)
      await clearAppOwnedCodexAuthentication(codexHome)
    }

    if (isClaudeSubscriptionProviderId(id)) {
      this.claudeIsolatedAuth.cancelLogin()
      this.claudeSharedAuth.cancelLogin()
    }

    await this.repository.deleteProvider(id)

    return this.getSettingsView()
  }

  cancelCodexLogin(): void {
    void this.codexAuth.cancelLogin()
  }

  cancelClaudeLogin(): void {
    this.claudeSharedAuth.cancelLogin()
  }

  // The explicit isolated sign-in — the only path that opens the browser login. Saving or testing a
  // provider never does. The outcome is recorded like a validation result, so the provider card shows
  // the verified check on success or the unverified warning (with the reason) on failure.
  async loginIsolatedCodex(): Promise<ValidateProviderResult> {
    const result = this.codexAuthValidationResult(await this.codexAuth.loginIsolated())

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    // The provider can be edited while the browser flow is open. Unless the stored record is still
    // the isolated subscription the login was started for, the outcome is stale and discarded —
    // recording it could overwrite a switched-to-imported profile's independent validation. Flag
    // it as not-applied so a caller gating navigation on success (onboarding) does not advance on a
    // result the stored provider never received.
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return { ...result, applied: false }
    }

    await this.repository.upsertProvider(
      result.ok
        ? {
            ...provider,
            lastValidatedAt: Date.now(),
            lastValidationFailure: undefined
          }
        : {
            ...provider,
            lastValidatedAt: undefined,
            lastValidationFailure: {
              at: Date.now(),
              category: result.category,
              status: result.status,
              message: result.message
            }
          }
    )

    return { ...result, applied: true }
  }

  async logoutIsolatedCodex(): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === codexSubscriptionProviderIdentity().id
    )
    if (provider?.type !== 'codex-isolated' || provider.codexAuthMode !== 'isolated') {
      return {
        ok: false,
        category: 'unknown',
        message: 'No isolated Open Science Codex login is configured.'
      }
    }

    // Never call the adapter's account/logout here. A legacy isolated profile may still hold a
    // token copied from the user's CLI profile, and remotely revoking it would sign the CLI out as
    // well. Removing only the file under the app-owned CODEX_HOME disconnects Open Science while
    // preserving every external Codex login.
    await this.codexAuth.cancelLogin()
    try {
      // Legacy isolated homes could still point at the OS keychain. Pin the app-owned profile to the
      // file store before removing auth.json so future status/runtime checks cannot re-authenticate
      // through a credential shared with the user's global CLI profile.
      await ensureCodexAuthHome('isolated', this.storageRoot)
      await clearAppOwnedCodexAuthentication(codexSubscriptionStorageDir(this.storageRoot))
    } catch {
      return {
        ok: false,
        category: 'unknown',
        message: 'The Open Science Codex login could not be removed.'
      }
    }

    await this.repository.upsertProvider({
      ...provider,
      lastValidatedAt: undefined,
      lastValidationFailure: undefined
    })

    return { ok: true, category: 'ok' }
  }

  // Stores a pasted OAuth token, then runs a one-shot Claude request with the exact isolated spawn
  // environment. Storage roundtrip success alone is not authentication: only the subprocess probe
  // can mark the provider verified or advance onboarding.
  async loginIsolatedClaude(token: string): Promise<ValidateProviderResult> {
    return this.finalizeClaudeIsolatedLogin(
      this.claudeIsolatedAuthValidationResult(await this.claudeIsolatedAuth.loginIsolated(token))
    )
  }

  // Browser sign-in for claude-isolated: the app runs `claude setup-token` (which opens the browser
  // for OAuth) under the isolated config dir, captures the returned token, and stores it — the same
  // end state as a manual paste, but with no copy/paste step. Post-login processing (probe + verified
  // markers) is shared with the paste flow via finalizeClaudeIsolatedLogin.
  async loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult> {
    const authStatus = await this.claudeIsolatedAuth.loginIsolatedBrowser()
    // A user-cancel should not mark the card as failed: the user intentionally stopped the flow,
    // so no failure marker is written and the card keeps its previous state.
    if (authStatus.cancelled) {
      return {
        ok: false,
        category: 'unknown',
        message: authStatus.message,
        applied: false,
        cancelled: true
      }
    }
    return this.finalizeClaudeIsolatedLogin(this.claudeIsolatedAuthValidationResult(authStatus))
  }

  // Cancels an in-flight claude-isolated browser sign-in (the `claude setup-token` subprocess).
  async cancelClaudeIsolatedLogin(): Promise<void> {
    this.claudeIsolatedAuth.cancelLogin()
  }

  // Shared post-login pipeline for both claude-isolated sign-in paths (paste + browser). Given the
  // controller's storage result, runs the credential probe and records verified/failed markers on the
  // provider card, so both flows converge on identical state.
  private async finalizeClaudeIsolatedLogin(
    initialResult: ValidateProviderResult
  ): Promise<ValidateProviderResult> {
    let result = initialResult

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )
    // The card can be deleted mid-sign-in. A deleted claude-isolated record means the login should
    // land fresh: create a new one carrying the now-stored token (the controller just persisted it
    // for us via upsertClaudeIsolatedProvider, which has already written the record).
    if (!provider) return { ...result, applied: false }

    if (result.ok) {
      result = await this.runClaudeSubscriptionProbe(
        this.resolveProvider(
          provider,
          settings.activeProviderId === provider.id ? settings.activeModel : undefined
        ),
        settings
      )

      const applied = await this.repository.updateClaudeIsolatedValidationIfKeyMatches(
        provider.keyRef,
        result.ok
          ? {
              expiresAt: Date.now() + SETUP_TOKEN_LIFETIME_MS,
              lastValidatedAt: Date.now(),
              lastValidationFailure: undefined
            }
          : {
              expiresAt: undefined,
              lastValidatedAt: undefined,
              lastValidationFailure: {
                at: Date.now(),
                category: result.category,
                status: result.status,
                message: result.message
              }
            }
      )

      return { ...result, applied }
    }

    // Mirror the success path: use the key-matched writer so a concurrent paste that already wrote a
    // new token does not get overwritten by the stale provider snapshot we read before the login.
    const applied = await this.repository.updateClaudeIsolatedValidationIfKeyMatches(
      provider.keyRef,
      {
        expiresAt: undefined,
        lastValidatedAt: undefined,
        lastValidationFailure: {
          at: Date.now(),
          category: result.category,
          status: result.status,
          message: result.message
        }
      }
    )

    return { ...result, applied }
  }

  // Drops the stored token. The provider card stays so the user can sign back in without a fresh
  // add; the verified markers are cleared so the next validation/test must succeed before it can
  // re-gate onboarding. When the controller reports an error (status.message set), the token may
  // still be in storage — we leave the existing validation markers untouched so the next status
  // check surfaces the real state instead of a misleading "cleared, please retest".
  async logoutIsolatedClaude(): Promise<ValidateProviderResult> {
    const status = await this.claudeIsolatedAuth.logoutIsolated()

    // Propagate the controller's error independently of `authenticated`: a failed logout can leave
    // the token in storage and still report `authenticated: false`, but the controller's `message`
    // is what the user needs to see rather than a silent success.
    if (status.message) {
      return {
        ok: false,
        category: status.message.toLowerCase().includes('timed out') ? 'timeout' : 'unknown',
        message: status.message
      }
    }

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )

    if (provider && status.authenticated === false) {
      await this.repository.upsertProvider({
        ...provider,
        expiresAt: undefined,
        lastValidatedAt: undefined,
        lastValidationFailure: undefined
      })
    }

    return { ok: true, category: 'ok' }
  }

  // Runs `claude auth login --claudeai` which opens the browser for OAuth. The CLI stores the
  // credentials in ~/.claude; the app never touches them. After success, runs a probe to validate.
  async loginClaudeShared(): Promise<ValidateProviderResult> {
    const loginTarget = await this.repository.getSettings()
    const targetProvider = loginTarget.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    this.invalidateClaudeSharedAuthStatus()
    const authStatus = await this.claudeSharedAuth.loginShared()
    this.invalidateClaudeSharedAuthStatus()
    let result = this.claudeSharedAuthValidationResult(authStatus)

    // A user-cancel: don't write a failure marker and surface the cancellation to the caller.
    if (authStatus.cancelled) {
      return { ...result, applied: false, cancelled: true }
    }

    if (targetProvider?.type !== 'claude-shared') return { ...result, applied: false }

    const settings = await this.repository.getSettings()
    const currentProvider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )
    if (
      settings.claudeSubscriptionProviderId !== loginTarget.claudeSubscriptionProviderId ||
      !isDeepStrictEqual(currentProvider, targetProvider)
    ) {
      return { ...result, applied: false }
    }

    const resolvedTarget = this.resolveProvider(
      targetProvider,
      settings.activeProviderId === targetProvider.id ? settings.activeModel : undefined
    )

    if (result.ok) {
      result = await this.runClaudeSubscriptionProbe(resolvedTarget, settings)
    }

    const applied = await this.repository.updateClaudeSharedValidationIfUnchanged(
      targetProvider,
      loginTarget.claudeSubscriptionProviderId,
      resolvedTarget.model,
      result.ok
        ? {
            disconnectedAt: undefined,
            lastValidatedAt: Date.now(),
            lastValidationFailure: undefined
          }
        : {
            disconnectedAt: authStatus.authenticated ? undefined : targetProvider.disconnectedAt,
            lastValidatedAt: undefined,
            lastValidationFailure: {
              at: Date.now(),
              category: result.category,
              status: result.status,
              message: result.message
            }
          }
    )

    return { ...result, applied }
  }

  async logoutClaudeShared(): Promise<ValidateProviderResult> {
    this.invalidateClaudeSharedAuthStatus()
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )

    if (provider) {
      const disconnectedAt = Date.now()
      await this.repository.upsertProvider({
        ...provider,
        disconnectedAt,
        lastValidatedAt: undefined,
        lastValidationFailure: {
          at: disconnectedAt,
          category: 'auth',
          message: CLAUDE_SHARED_DISCONNECTED_MESSAGE
        }
      })
    }

    return { ok: true, category: 'ok' }
  }

  async getClaudeSharedStatus(): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_SHARED_PROVIDER_ID
    )

    if (provider?.type !== 'claude-shared') {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude subscription provider is not configured.'
      }
    }

    return this.validateClaudeSharedProvider(
      this.resolveProvider(
        provider,
        settings.activeProviderId === provider.id ? settings.activeModel : undefined
      ),
      settings,
      provider
    )
  }

  private async validateClaudeSharedProvider(
    provider: ResolvedProvider,
    settings: StoredSettings,
    storedProvider?: StoredProvider
  ): Promise<ValidateProviderResult> {
    if (storedProvider?.disconnectedAt !== undefined) {
      return { ok: false, category: 'auth', message: CLAUDE_SHARED_DISCONNECTED_MESSAGE }
    }

    const status = await this.claudeSharedAuth.getStatus()
    this.claudeSharedAuthStatusCache = {
      authenticated: status.authenticated,
      checkedAt: Date.now()
    }

    if (!status.authenticated) {
      return this.claudeSharedAuthValidationResult(
        status,
        'Not signed in. Sign in via browser OAuth in the Settings card to connect your Claude subscription.'
      )
    }

    return this.runClaudeSubscriptionProbe(provider, settings)
  }

  private claudeSharedAuthValidationResult(
    status: ClaudeSharedAuthStatus,
    notSignedInMessage?: string
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    const message = status.message ?? notSignedInMessage

    return { ok: false, category: 'unknown', message }
  }

  // Re-validates a stored claude-isolated credential through the same one-shot Claude command used
  // during sign-in. Reading the encrypted token only proves storage health; the subprocess probe is
  // what detects a rejected, revoked, or expired setup-token.
  async getClaudeIsolatedStatus(): Promise<ValidateProviderResult> {
    const status = await this.claudeIsolatedAuth.getStatus()

    if (!status.authenticated) {
      return this.claudeIsolatedAuthValidationResult(
        status,
        'Not signed in. Run `claude setup-token` and paste the token to connect your Claude subscription.'
      )
    }

    const settings = await this.repository.getSettings()
    const provider = settings.providers.find(
      (candidate) => candidate.id === CLAUDE_ISOLATED_PROVIDER_ID
    )

    if (!provider) {
      return {
        ok: false,
        category: 'unknown',
        message: 'Claude subscription provider is not configured.'
      }
    }

    return this.runClaudeSubscriptionProbe(
      this.resolveProvider(
        provider,
        settings.activeProviderId === provider.id ? settings.activeModel : undefined
      ),
      settings
    )
  }

  // The Claude-auth status does not have a 'timeout' or 'incompatible' category of its own; map it
  // to the same validation-result envelope the renderer already understands for the codex path.
  private claudeIsolatedAuthValidationResult(
    status: ClaudeIsolatedAuthStatus,
    notSignedInMessage?: string
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    const message = status.message ?? notSignedInMessage

    return { ok: false, category: 'unknown', message }
  }

  // Activates a provider and the model to run within it. An omitted/unknown model falls back to the
  // provider's default (its stored model, or the vendor's first catalog entry).
  async setActiveProvider(id: string, model?: string): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()
    const provider = settings.providers.find((candidate) => candidate.id === id)
    const resolvedModel = this.resolveActiveModel(provider, model)

    await this.repository.setActiveProvider(id, resolvedModel)

    return this.getSettingsView()
  }

  // Validates a saved provider or an unsaved draft; on success for a saved provider records the time.
  async validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult> {
    const settings = await this.repository.getSettings()
    const resolved = this.resolveValidationTarget(request, settings)

    if (!resolved) {
      return { ok: false, category: 'unknown', message: 'No provider to validate.' }
    }

    const storedValidationTarget = resolved.storedId
      ? settings.providers.find((provider) => provider.id === resolved.storedId)
      : undefined

    const validationGeneration = resolved.storedId
      ? this.advanceProviderValidationGeneration(resolved.storedId)
      : undefined

    // Test against the framework the agent will actually spawn with. An OpenAI-only gateway tested
    // while Claude Code is active would otherwise fail a raw /v1/messages probe and be reported as an
    // auth error, even though the key is valid — the pairing, not the credential, is the problem. Decide
    // this before any network call so the card names the real reason (which route the framework needs).
    // codex-subscription + claude-isolated keep their own login-status branches; their usability is
    // enforced elsewhere.
    const framework = getAgentFramework(settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
    const incompatibility =
      isCodexSubscriptionProvider(resolved.provider.type) ||
      resolved.provider.type === 'claude-isolated'
        ? undefined
        : this.frameworkIncompatibilityResult(resolved.provider, framework)

    const result =
      incompatibility ??
      (isCodexSubscriptionProvider(resolved.provider.type)
        ? this.codexAuthValidationResult(
            // Validation is a read-only status check in both modes: signing in is a separate explicit
            // action (loginIsolatedCodex), so testing or saving a provider never pops a browser the
            // user didn't ask for.
            await this.codexAuth.getStatus(
              resolveCodexSubscriptionType(resolved.provider) === 'codex-shared'
                ? 'shared'
                : 'isolated'
            ),
            'Not signed in. Use Sign in to connect your ChatGPT account.'
          )
        : resolved.provider.type === 'claude-shared'
          ? await this.validateClaudeSharedProvider(
              resolved.provider,
              settings,
              resolved.storedId
                ? settings.providers.find((provider) => provider.id === resolved.storedId)
                : undefined
            )
          : resolved.provider.type === 'claude-isolated'
            ? await this.getClaudeIsolatedStatus()
            : await validateProvider(resolved.provider, {
                // Probe over Electron's network stack, which honors the system/VPN proxy. Node's global
                // fetch (undici) takes a direct path and ignores that proxy, so an official vendor reachable
                // only through a proxy (e.g. api.openai.com) would fail the probe as a false `network` error
                // even with a valid key. The local Responses-bridge loopback stays on the direct fetch.
                fetchImpl: netFetchStandard,
                // Codex reaches Chat Completions-only providers through the local Responses bridge.
                // A plain ping cannot prove the streaming function-call contract that runtime needs.
                requireBridgeToolCall: requiresChatCompletionsBridge(resolved.provider, framework),
                requireNativeResponsesCompatibility: requiresNativeResponsesCompatibility(
                  resolved.provider,
                  framework
                ),
                // For a multi-route provider, probe the route this framework actually drives so a passing
                // test proves that route (e.g. Claude Code hits /v1/messages, not /v1/chat/completions).
                // Codex is excluded: it bridges the provider's OpenAI route under its `responses` protocol,
                // so its HTTP route is decided by the bridge, not by supportedApiTypes — keep it as-is.
                frameworkEndpoints:
                  framework.id === 'codex' ? undefined : framework.supportedApiTypes
              }))

    if (resolved.storedId) {
      // Each early return here means the tested target no longer matches what is stored (a newer test
      // superseded this one, the provider was deleted, or it was edited mid-flight). The outcome is
      // real but was not recorded, so `applied: false` tells a success-gated caller not to advance.
      if (this.providerValidationGenerations.get(resolved.storedId) !== validationGeneration) {
        return { ...result, applied: false }
      }
      const latestSettings = await this.repository.getSettings()
      const stored = latestSettings.providers.find((provider) => provider.id === resolved.storedId)
      if (!stored) return { ...result, applied: false }
      const latestResolved = this.resolveProvider(
        stored,
        latestSettings.activeProviderId === stored.id ? latestSettings.activeModel : undefined
      )
      if (!this.sameValidationTarget(resolved.provider, latestResolved)) {
        return { ...result, applied: false }
      }

      // Success stamps the validated time and clears any prior failure. A failure keeps the provider
      // but records why, so the list can flag it and the model pickers exclude it until it passes.
      const validationPatch = result.ok
        ? {
            lastValidatedAt: Date.now(),
            lastValidationFailure: undefined
          }
        : {
            lastValidatedAt: undefined,
            lastValidationFailure: {
              at: Date.now(),
              category: result.category,
              status: result.status,
              message: result.message
            }
          }

      if (stored.type === 'claude-shared') {
        if (storedValidationTarget?.type !== 'claude-shared') {
          return { ...result, applied: false }
        }

        const applied = await this.repository.updateClaudeSharedValidationIfUnchanged(
          storedValidationTarget,
          settings.claudeSubscriptionProviderId,
          resolved.provider.model,
          validationPatch
        )

        return { ...result, applied }
      }

      await this.repository.upsertProvider({ ...stored, ...validationPatch })

      return { ...result, applied: true }
    }

    return result
  }

  private codexAuthValidationResult(
    status: CodexAuthStatus,
    isolatedFallback = 'Codex sign-in did not complete.'
  ): ValidateProviderResult {
    if (status.authenticated) return { ok: true, category: 'ok' }

    return {
      ok: false,
      category: status.message?.toLowerCase().includes('timed out')
        ? 'timeout'
        : status.supported
          ? 'auth'
          : 'unknown',
      message:
        status.message ??
        (status.mode === 'shared'
          ? 'No existing Codex login was found. Run `codex login` or use the isolated Open Science login.'
          : isolatedFallback)
    }
  }

  // Fetches a saved provider's live model list from the vendor and, on success, persists it as the
  // provider's models (overriding the bundled catalog). Failures leave the bundled catalog in place.
  async refreshProviderModels(
    request: RefreshProviderModelsRequest
  ): Promise<RefreshProviderModelsResult> {
    const settings = await this.repository.getSettings()
    const stored = settings.providers.find((provider) => provider.id === request.providerId)

    if (!stored) return { ok: false, category: 'unknown', message: 'Provider not found.' }

    const modelsUrl =
      stored.type === 'official' && stored.vendorId
        ? resolveVendorModelsUrl(stored.vendorId, stored.region)
        : undefined

    if (!modelsUrl) {
      return {
        ok: false,
        category: 'unknown',
        message: 'This provider has no model-list endpoint.'
      }
    }

    const result = await listProviderModels({
      url: modelsUrl,
      key: this.resolveProvider(stored).key
    })

    if (!result.ok || !result.models) {
      return {
        ok: false,
        category: result.status ? classifyStatus(result.status) : 'network',
        message: result.message
      }
    }

    await this.repository.upsertProvider({ ...stored, fetchedModels: result.models })

    return { ok: true, category: 'ok', models: result.models }
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

    const provider = this.resolveProvider(
      activeProvider,
      resolvedSelection
        ? resolvedSelection.model
        : this.resolveActiveModel(activeProvider, settings.activeModel)
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
    const effectiveModel = this.resolveActiveModel(activeProvider, settings.activeModel)
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
          apiEndpoints: this.resolveProviderApiEndpoints(activeProvider, effectiveModel),
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
    const provider = this.resolveProvider(activeProvider, effectiveModel)
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

  // The chat APIs a provider speaks: official providers come from the registry, custom gateways from
  // their stored/drafted endpoints, everything else defaults to Anthropic /v1/messages. For official
  // vendors the set is model-aware: a vendor may serve the Responses protocol for a subset of its
  // catalog (e.g. DeepSeek's deepseek-v4-flash), so 'responses' is injected only when the active model
  // is in that subset. When no active model is supplied, the vendor default model is used so the
  // resolved set always matches the model the session actually drives.
  private resolveProviderApiEndpoints(
    provider: StoredProvider,
    activeModel?: string
  ): ChatApiEndpoint[] {
    if (provider.type === 'official' && provider.vendorId) {
      const vendorEndpoints = resolveVendorApiEndpoints(provider.vendorId)
      const modelToCheck = activeModel ?? defaultVendorModel(provider.vendorId)
      if (
        !vendorEndpoints.includes('responses') &&
        isVendorModelResponsesSupported(provider.vendorId, modelToCheck)
      ) {
        return [...vendorEndpoints, 'responses']
      }
      return vendorEndpoints
    }

    return provider.apiEndpoints && provider.apiEndpoints.length > 0
      ? [...provider.apiEndpoints]
      : ['anthropic']
  }

  // Maps a stored provider to its masked renderer view, flagging custom keys that no longer decrypt.
  private toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    const hasKey = Boolean(provider.keyRef)
    // custom and official both require a decryptable key; claude-isolated carries a stored token,
    // so it follows the same "needs a decryptable keyRef" rule as custom.
    const needsKey = hasKey && tryDecryptKey(provider.keyRef) === undefined

    return {
      id: provider.id,
      type: provider.type,
      codexAuthMode: provider.codexAuthMode,
      name: provider.name,
      apiEndpoints: this.resolveProviderApiEndpoints(provider, activeModel),
      baseUrl: provider.baseUrl,
      model: provider.model,
      contextWindow: provider.contextWindow,
      supportsImageInput: this.providerSupportsImageInput(provider, activeModel),
      reasoningEffortPreset:
        provider.type === 'custom' ? provider.reasoningEffortPreset : undefined,
      reasoningEffortTransport:
        provider.type === 'custom' ? provider.reasoningEffortTransport : undefined,
      vendorId: provider.vendorId,
      region: provider.region,
      models: this.availableModels(provider),
      maskedKey: provider.keyMask,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt,
      lastValidationFailure: provider.lastValidationFailure,
      ...(provider.expiresAt !== undefined ? { expiresAt: provider.expiresAt } : {})
    }
  }

  private providerSupportsImageInput(provider: StoredProvider, activeModel?: string): boolean {
    if (isCodexSubscriptionProvider(provider.type)) return true
    // Both Claude subscription modes authenticate against Anthropic and inherit vision support.
    if (isClaudeSubscriptionProvider(provider.type)) return true

    // Custom providers: respect the user-configured supportsImageInput flag
    if (provider.type === 'custom') return provider.supportsImageInput === true

    // Official vendors: check the model against the vendor's multimodalModels registry. When no model
    // is active, fall back to the vendor's default model — the exact id resolveProvider spawns — not the
    // first of the (possibly live-refreshed) catalog, so the capability always matches the model actually
    // sent. Otherwise a refreshed list whose first entry is text-only would strip images from a default
    // that supports them (e.g. Kimi's default kimi-k3).
    if (provider.type === 'official' && provider.vendorId) {
      const modelToCheck = activeModel ?? defaultVendorModel(provider.vendorId)
      return isVendorModelMultimodal(provider.vendorId, modelToCheck)
    }

    return false
  }

  private invalidateClaudeSharedAuthStatus(): void {
    this.claudeSharedAuthStatusCache = undefined
    this.claudeSharedAuthStatusGeneration += 1
  }

  private async getClaudeSharedAuthStatus(): Promise<boolean> {
    const cached = this.claudeSharedAuthStatusCache
    if (cached && Date.now() - cached.checkedAt < CLAUDE_SHARED_AUTH_STATUS_TTL_MS) {
      return cached.authenticated
    }
    const generation = this.claudeSharedAuthStatusGeneration
    const pending = this.claudeSharedAuthStatusPromise
    if (pending?.generation === generation) return pending.promise

    const promise = this.claudeSharedAuth
      .getStatus()
      .then((status) => {
        if (this.claudeSharedAuthStatusGeneration === generation) {
          this.claudeSharedAuthStatusCache = {
            authenticated: status.authenticated,
            checkedAt: Date.now()
          }
        }
        return status.authenticated
      })
      .finally(() => {
        if (this.claudeSharedAuthStatusPromise?.promise === promise) {
          this.claudeSharedAuthStatusPromise = undefined
        }
      })

    this.claudeSharedAuthStatusPromise = { generation, promise }
    return promise
  }

  // Resolves credential usability at the provider seam. Codex subscriptions are adapter-managed;
  // claude-shared needs a cached live profile check; all key-backed providers must still decrypt.
  private async isProviderKeyUsable(provider: StoredProvider): Promise<boolean> {
    if (isCodexSubscriptionProvider(provider.type)) return true
    if (provider.type === 'claude-shared') {
      if (provider.disconnectedAt !== undefined) return false
      return this.getClaudeSharedAuthStatus()
    }

    return Boolean(provider.keyRef) && tryDecryptKey(provider.keyRef) !== undefined
  }

  // Models selectable for a provider: Codex subscriptions expose the app's curated candidate catalog,
  // official providers use their vendor catalog, and custom/local providers expose their configured
  // override. Codex validates an explicit candidate against the live session options before applying it.
  private availableModels(provider: StoredProvider): string[] {
    if (isCodexSubscriptionProvider(provider.type)) {
      return getOfficialVendorModelIds('openai')
    }

    if (provider.type === 'official' && provider.vendorId) {
      // Live-fetched models (via "refresh from vendor") take precedence over the bundled catalog.
      if (provider.fetchedModels && provider.fetchedModels.length > 0) return provider.fetchedModels

      return getOfficialVendorModelIds(provider.vendorId)
    }

    return provider.model ? [provider.model] : []
  }

  // Picks the model to activate. Codex subscriptions keep an omitted/unknown selection undefined so the
  // account default is used; other providers retain their catalog/default fallback behavior.
  private resolveActiveModel(
    provider: StoredProvider | undefined,
    requested?: string
  ): string | undefined {
    return resolveProviderEffectiveModel(
      provider ? { ...provider, models: this.availableModels(provider) } : undefined,
      requested
    )
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
      this.resolveActiveModel(provider, settings.activeModel)
    )

    return resolveReasoningEffortValue(intent, profile)
  }

  // Decrypts a stored provider into the spawn/validation shape (plaintext key held only transiently).
  // Official vendors reuse the custom HTTP/bearer path: base URL comes from the registry and the model
  // defaults to the vendor's first catalog entry unless a specific one is passed as the override.
  private resolveProvider(provider: StoredProvider, modelOverride?: string): ResolvedProvider {
    const key = provider.keyRef ? tryDecryptKey(provider.keyRef) : undefined

    if (provider.type === 'official' && provider.vendorId) {
      const model = modelOverride ?? defaultVendorModel(provider.vendorId)
      const contextWindow = resolveModelContextWindow(provider.vendorId, model)

      return {
        type: 'custom',
        vendorId: provider.vendorId,
        baseUrl: resolveVendorBaseUrl(provider.vendorId, provider.region),
        openaiBaseUrl: resolveVendorOpenAiBaseUrl(provider.vendorId, provider.region),
        model,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        key,
        apiEndpoints: this.resolveProviderApiEndpoints(provider, model),
        supportsImageInput: this.providerSupportsImageInput(provider, modelOverride)
      }
    }

    const model = modelOverride ?? provider.model
    const contextWindow =
      provider.type === 'custom'
        ? resolveCustomModelContextWindow(provider.contextWindow)
        : isClaudeSubscriptionProvider(provider.type)
          ? resolveModelContextWindow('anthropic', model)
          : undefined

    return {
      type: provider.type,
      ...(provider.codexAuthMode === undefined ? {} : { codexAuthMode: provider.codexAuthMode }),
      baseUrl: provider.baseUrl,
      model,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      key,
      apiEndpoints: this.resolveProviderApiEndpoints(provider, model),
      supportsImageInput: this.providerSupportsImageInput(provider, modelOverride),
      ...(provider.type === 'custom'
        ? { reasoningEffortTransport: provider.reasoningEffortTransport }
        : {})
    }
  }

  // Resolves an unsaved draft into the validation shape, mapping an official draft to the custom path
  // with the vendor's registry base URL + default model.
  private resolveDraft(draft: ProviderDraft): ResolvedProvider {
    if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
      const draftModel = draft.model ?? defaultVendorModel(draft.vendorId)
      const vendorEndpoints = resolveVendorApiEndpoints(draft.vendorId)
      const draftEndpoints: ChatApiEndpoint[] =
        !vendorEndpoints.includes('responses') &&
        isVendorModelResponsesSupported(draft.vendorId, draftModel)
          ? [...vendorEndpoints, 'responses']
          : vendorEndpoints
      return {
        type: 'custom',
        vendorId: draft.vendorId,
        baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
        openaiBaseUrl: resolveVendorOpenAiBaseUrl(draft.vendorId, draft.region),
        model: draftModel,
        key: draft.key,
        // Official vendors declare their own endpoints; a custom draft carries the user's choice.
        // The set is model-aware so a vendor with per-model Responses support (e.g. DeepSeek flash)
        // validates against the Responses route when the draft's model implements it.
        apiEndpoints: draftEndpoints
      }
    }

    return {
      type: draft.type,
      baseUrl: draft.baseUrl,
      model: draft.model,
      ...(draft.type === 'custom'
        ? { contextWindow: resolveCustomModelContextWindow(draft.contextWindow ?? undefined) }
        : {}),
      key: draft.key,
      apiEndpoints: draft.apiEndpoints ?? ['anthropic'],
      ...(draft.type === 'custom'
        ? { reasoningEffortTransport: draft.reasoningEffortTransport }
        : {})
    }
  }

  // A failed-validation result when the provider can't drive the active agent framework, or undefined
  // when the pair is compatible. Mirrors the spawn-time guard in resolveActiveAgentBackend so the test
  // reports the same mismatch here, instead of a misleading auth failure, before it blocks a session.
  private frameworkIncompatibilityResult(
    provider: ResolvedProvider,
    framework: ReturnType<typeof getAgentFramework>
  ): ValidateProviderResult | undefined {
    if (
      isProviderUsableByFramework(
        { apiEndpoints: provider.apiEndpoints, type: provider.type },
        framework
      )
    ) {
      return undefined
    }

    return {
      ok: false,
      category: 'incompatible',
      message: this.frameworkIncompatibilityMessage(provider, framework)
    }
  }

  // The human reason a provider can't drive a framework: a route mismatch (which endpoint the framework
  // needs vs. which the provider speaks). Route paths, not vendor names, so it reads as "which API
  // shape".
  private frameworkIncompatibilityMessage(
    provider: ResolvedProvider,
    framework: { displayName: string; supportedApiTypes: readonly ChatApiEndpoint[] }
  ): string {
    if (provider.type === 'claude-isolated') {
      return `Carries an Anthropic OAuth token (setup-token) in app-owned storage, which only Claude Code can carry. Switch to Claude Code or pick another provider.`
    }

    const routes: Record<ChatApiEndpoint, string> = {
      anthropic: '/v1/messages',
      openai: '/v1/chat/completions',
      responses: '/v1/responses'
    }
    const needs = framework.supportedApiTypes.map((endpoint) => routes[endpoint]).join(' or ')
    const speaks = providerEndpoints(provider)
      .map((endpoint) => routes[endpoint])
      .join(' or ')

    return `Not compatible with ${framework.displayName}: it needs ${needs}, but this provider speaks ${speaks}. Change the API format or switch the agent framework.`
  }

  // Resolves what validateProvider should probe: a stored provider (by id) or an inline draft.
  private resolveValidationTarget(
    request: ValidateProviderRequest,
    settings: StoredSettings
  ): { provider: ResolvedProvider; storedId?: string } | undefined {
    if (request.providerId) {
      const stored = settings.providers.find((provider) => provider.id === request.providerId)

      return stored
        ? {
            provider: this.resolveProvider(
              stored,
              settings.activeProviderId === stored.id ? settings.activeModel : undefined
            ),
            storedId: stored.id
          }
        : undefined
    }

    if (request.draft) {
      return { provider: this.resolveDraft(request.draft) }
    }

    return undefined
  }

  private sameValidationTarget(left: ResolvedProvider, right: ResolvedProvider): boolean {
    return (
      left.type === right.type &&
      left.codexAuthMode === right.codexAuthMode &&
      left.baseUrl === right.baseUrl &&
      left.openaiBaseUrl === right.openaiBaseUrl &&
      left.model === right.model &&
      left.key === right.key &&
      (left.apiEndpoints ?? []).join(',') === (right.apiEndpoints ?? []).join(',')
    )
  }

  private advanceProviderValidationGeneration(providerId: string): number {
    const generation = (this.providerValidationGenerations.get(providerId) ?? 0) + 1
    this.providerValidationGenerations.set(providerId, generation)
    return generation
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

  // Issues a fresh, monotonically-increasing provider id for an upsert.
  private createProviderId(): string {
    this.providerSequence += 1

    return `p_${Date.now()}_${this.providerSequence}`
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

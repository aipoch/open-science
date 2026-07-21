import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import { z } from 'zod'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  ConnectorDetailView,
  ConnectorsSnapshot,
  ConnectorView,
  CustomServerView,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetCustomServerEnabledRequest,
  UpdateCustomServerRequest,
  CreateSkillRequest,
  DeleteSkillRequest,
  EnvironmentCheckResult,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  ChatApiEndpoint,
  NcbiCredentialsView,
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
  SkillDetailView,
  SkillView,
  ToolPermission,
  ImportSkillRequest,
  ImportSkillResult,
  ImportSkillZipRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  PreviewSkillZipRequest,
  SkillBundlePreviewResult,
  ScanRepoRequest,
  ScanRepoResult,
  UpdateSkillRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../../shared/settings'
import type { PackageMirror } from '../../shared/mirror'
import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeEnablement, RuntimeSelection } from '../../shared/notebook-runtime'
import { isProviderUsableByFramework } from '../../shared/settings'
import {
  defaultVendorModel,
  getOfficialVendor,
  isModelBridgeSupported,
  isOfficialVendorId,
  isVendorModelMultimodal,
  resolveVendorApiEndpoints,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl,
  resolveVendorOpenAiBaseUrl
} from '../../shared/provider-registry'
import { resolveStorageRoot } from '../storage-root'
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
import { codexStorageDir } from '../agent-framework/codex'
import { ClaudeCodeSkillMaterializer } from '../skills/materializer'
import { provisionAppClaudeConfigDir } from './claude-config-provision'
import { detectNpmAvailable, runInstallWithFallback, type InstallTarget } from './claude-install'
import { OPENCODE_INSTALL_TARGET } from './opencode-install'
import {
  installManagedCodex,
  managedCodexAdapterEntry,
  managedCodexBinary,
  uninstallManagedCodex,
  type InstallManagedCodexOptions,
  type ManagedCodexInstallOutcome
} from './managed-codex'
import { runEnvironmentCheck } from './environment-check'
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
import { applyLocalClaudeAuth, defaultUserClaudeDir } from './local-claude-auth'
import { computePreflight } from './preflight'
import { listProviderModels } from './list-models'
import { buildProviderEnv, getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import {
  ResponsesBridge,
  type ResponsesBridgeConnection,
  type ResponsesBridgeNamespacedTool
} from './responses-bridge'
import { SettingsRepository } from './repository'
import { sanitizeCustomMcpServer } from './repository'
import { CONNECTOR_CATALOG } from '../connectors/catalog'
import { getConnectorTools } from '../connectors/registry'
import { renderConnectorInstructions, renderSkillDoc } from '../connectors/skill-doc'
import { syncConnectorSkillDocs } from '../connectors/provision'
import { SkillRegistry, type BundledSkill } from '../skills/registry'
import { UserSkillRepository } from '../skills/user-skill-repository'
import { netFetch } from '../skills/net-fetch'
import { decodeBoundedBase64, SKILL_IMPORT_LIMITS } from '../skills/import-limits'
import { readSkillFile } from '../skills/skill-files'
import { NOTEBOOK_MCP_SERVER_NAME, NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import { ARTIFACT_MCP_SERVER_NAME, writeArtifactFileToolSchema } from '../artifacts/mcp-server'
import type {
  StoredConnectors,
  StoredCodexInfo,
  StoredCustomMcpServer,
  StoredProvider,
  StoredSettings
} from './types'
import { classifyStatus, validateProvider, type ClaudeProbeResult } from './validate'

const execFileAsync = promisify(execFile)

// Hard ceiling for the claude-default probe so a stuck local claude can never hang the wizard.
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

const isManagedCodexPath = (adapterPath: string, storageRoot: string): boolean =>
  adapterPath === managedCodexAdapterEntry(storageRoot)

type ExecuteClaudeProbe = (executablePath: string, env: NodeJS.ProcessEnv) => Promise<void>

const executeClaudeProbe: ExecuteClaudeProbe = async (executablePath, env) => {
  await execFileAsync(executablePath, ['-p', 'ok'], {
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

// A spawn configuration the ACP runtime reads at connect time so the active provider's credentials
// are always current.
export type AgentSpawnConfig = {
  envOverrides: Record<string, string>
  executablePath: string
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
  codexDetectDeps?: CodexDetectDeps
  // The machine's own Claude config dir, read to reuse its login for the "local" provider. Injectable
  // so tests don't touch the real ~/.claude.
  userClaudeDir?: string
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
}

// Orchestrates the settings units (repository + crypto + detect/install + validate) behind one
// object shared by the settings IPC handlers and the ACP runtime. Secrets are decrypted here only
// transiently; nothing that leaves this object (views, spawn config aside) carries plaintext.
class SettingsService {
  private readonly repository: SettingsRepository
  private readonly storageRoot: string
  private readonly detectDeps: ClaudeDetectDeps
  private readonly opencodeDetectDeps: OpencodeDetectDeps
  private readonly codexDetectDeps: CodexDetectDeps
  private readonly userClaudeDir: string
  private readonly skillRegistry: SkillRegistry
  private readonly userSkills: UserSkillRepository
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
  private responsesBridge: ResponsesBridge | undefined
  private providerSequence = 0
  private readonly providerValidationGenerations = new Map<string, number>()
  // Skills force-loaded for the current turn: subtracted from the stored disabled set at spawn time so
  // a picked-but-disabled skill materializes for this prompt only, without mutating stored settings.
  private turnForcedSkillIds = new Set<string>()

  constructor(options: SettingsServiceOptions = {}) {
    this.storageRoot = options.storageRoot ?? resolveStorageRoot()
    this.repository = options.repository ?? new SettingsRepository(this.storageRoot)
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
    this.userClaudeDir = options.userClaudeDir ?? defaultUserClaudeDir()
    this.skillRegistry = options.skillRegistry ?? new SkillRegistry()
    this.userSkills = options.userSkills ?? new UserSkillRepository(this.storageRoot)
    this.executeClaudeProbe = options.executeClaudeProbe ?? executeClaudeProbe
    this.installManagedClaudeImpl = options.installManagedClaudeImpl ?? installManagedClaude
    this.installManagedOpencodeImpl = options.installManagedOpencodeImpl ?? installManagedOpencode
    this.installManagedCodexImpl = options.installManagedCodexImpl ?? installManagedCodex
  }

  // Returns the raw stored settings document (unmasked), for main-process bootstrap needs (e.g. priming
  // the data-root cache) that shouldn't go through the renderer-safe view.
  async getStoredSettings(): Promise<StoredSettings> {
    return this.migrateLegacyKeyRefs(await this.repository.getSettings())
  }

  // Returns the renderer-safe (masked) snapshot of settings.
  async getSettingsView(): Promise<SettingsSnapshot> {
    const settings = await this.migrateLegacyKeyRefs(await this.repository.getSettings())

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
      activeModel: settings.activeModel,
      providers: settings.providers.map((provider) =>
        this.toProviderView(
          provider,
          provider.id === settings.activeProviderId ? settings.activeModel : undefined
        )
      ),
      onboardingCompletedAt: settings.onboardingCompletedAt,
      packageMirror: settings.packageMirror,
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
    return (await this.repository.getSettings()).packageMirror ?? {}
  }

  // The persisted notebook runtime selection for a language (managed vs the user's own interpreter),
  // read fresh. undefined means "not chosen" -> the notebook runtime resolves to the managed default.
  async getRuntimeSelection(language: NotebookLanguage): Promise<RuntimeSelection | undefined> {
    return (await this.repository.getSettings()).notebookRuntimes?.[language]
  }

  // Sets (or clears, when `selection` is null) the persisted runtime choice for a language, returning
  // the resulting per-language selection (undefined once cleared, or when a bad value was dropped).
  // Validation/rejection (bad shape, external R) lives in the repository so it can never be bypassed.
  async setRuntimeSelection(
    language: NotebookLanguage,
    selection: RuntimeSelection | null
  ): Promise<RuntimeSelection | undefined> {
    const settings = await this.repository.setRuntimeSelection(language, selection)

    return settings.notebookRuntimes?.[language]
  }

  // The persisted v4 environment enablement for a language, read fresh. Always returns a concrete
  // RuntimeEnablement (empty maps when nothing is stored) so callers can index it and apply the
  // provenance default (isEnvEnabled) without a null check.
  async getRuntimeEnablement(language: NotebookLanguage): Promise<RuntimeEnablement> {
    const stored = (await this.repository.getSettings()).notebookRuntimeEnablement?.[language]

    return { enabled: { ...stored?.enabled }, installAuthorized: { ...stored?.installAuthorized } }
  }

  // Sets one env's explicit enabled override (keyed by envId) for a language, read-modify-write over
  // the per-language RuntimeEnablement, returning the refreshed value. The enabled map records the
  // explicit choice regardless of the provenance default, so it survives re-detection.
  async setEnvironmentEnabled(
    language: NotebookLanguage,
    envId: string,
    enabled: boolean
  ): Promise<RuntimeEnablement> {
    const current = await this.getRuntimeEnablement(language)
    const next: RuntimeEnablement = {
      enabled: { ...current.enabled, [envId]: enabled },
      installAuthorized: { ...current.installAuthorized }
    }
    const settings = await this.repository.setRuntimeEnablement(language, next)

    return settings.notebookRuntimeEnablement?.[language] ?? { enabled: {}, installAuthorized: {} }
  }

  // Sets one env's high-risk package-install authorization (keyed by envId) for a language, returning
  // the refreshed enablement. This is the separate opt-in that lets Open Science write packages into an
  // external env; it does not affect whether the env is enabled for execution.
  async setInstallAuthorized(
    language: NotebookLanguage,
    envId: string,
    authorized: boolean
  ): Promise<RuntimeEnablement> {
    const current = await this.getRuntimeEnablement(language)
    const next: RuntimeEnablement = {
      enabled: { ...current.enabled },
      installAuthorized: { ...current.installAuthorized, [envId]: authorized }
    }
    const settings = await this.repository.setRuntimeEnablement(language, next)

    return settings.notebookRuntimeEnablement?.[language] ?? { enabled: {}, installAuthorized: {} }
  }

  // The manual-interpreter catalog for a language (paths added via "Add interpreter…"), for merging
  // into environment discovery. Empty array when none.
  async getManualInterpreters(language: NotebookLanguage): Promise<string[]> {
    return (await this.repository.getSettings()).notebookManualInterpreters?.[language] ?? []
  }

  // Adds an interpreter path to a language's manual catalog (idempotent), returning the refreshed list.
  async addManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    const current = await this.getManualInterpreters(language)
    const settings = await this.repository.setManualInterpreters(language, [...current, path])
    return settings.notebookManualInterpreters?.[language] ?? []
  }

  // Removes an interpreter path from a language's manual catalog, returning the refreshed list.
  async removeManualInterpreter(language: NotebookLanguage, path: string): Promise<string[]> {
    const current = await this.getManualInterpreters(language)
    const settings = await this.repository.setManualInterpreters(
      language,
      current.filter((p) => p !== path)
    )
    return settings.notebookManualInterpreters?.[language] ?? []
  }

  // Sets (or clears) the package-mirror configuration and returns the sanitized, persisted value.
  async setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror> {
    const settings = await this.repository.setPackageMirror(request)

    return settings.packageMirror ?? {}
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

    const ncbiRef = settings.connectors?.ncbiApiKeyRef
    if (ncbiRef?.startsWith('plain:')) {
      const key = tryDecryptKey(ncbiRef)
      if (key) {
        await this.repository.setNcbiCredentials(settings.connectors?.contactEmail, encryptKey(key))
        changed = true
      }
    }

    return changed ? this.repository.getSettings() : settings
  }

  // Selects the agent backend to drive; the caller reconnects so the choice applies to the next spawn.
  async setAgentFramework(id: AgentFrameworkId): Promise<SettingsSnapshot> {
    await this.repository.setAgentFramework(id)

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
        nativePath: detected.managedCodexPath,
        nativeVersion: detected.managedCodexVersion
      })
    } else {
      const cached = (await this.repository.getSettings()).codex?.resolvedPath
      if (cached && !(await this.pathExists(cached))) await this.repository.clearCodexInfo()
    }

    return this.getSettingsView()
  }

  // The full skill catalog across every source: bundled (featured) + imported + personal.
  private async skillCatalog(): Promise<BundledSkill[]> {
    const [featured, user] = await Promise.all([this.skillRegistry.list(), this.userSkills.list()])

    return [...featured, ...user]
  }

  // Lists all skills (featured + imported + personal) with enabled state from the stored disabled set.
  async listSkills(): Promise<SkillView[]> {
    const [skills, settings] = await Promise.all([
      this.skillCatalog(),
      this.repository.getSettings()
    ])
    const disabled = new Set(settings.disabledSkillIds ?? [])

    return skills.map((skill) => this.toSkillView(skill, disabled))
  }

  // Sets the skills to force-load for the current turn (picked in the composer). Cleared after the turn.
  setTurnForcedSkillIds(ids: string[]): void {
    this.turnForcedSkillIds = new Set(ids)
  }

  // Clears the turn-scoped force-load set so later spawns use the normal enabled set.
  clearTurnForcedSkillIds(): void {
    this.turnForcedSkillIds.clear()
  }

  // Returns the subset of forced ids that are currently disabled in settings — i.e. the picks that need
  // a respawn to materialize. Enabled picks are already present and need no reconnect.
  async skillsNeedingForceLoad(forcedIds: string[]): Promise<string[]> {
    const settings = await this.repository.getSettings()
    const disabled = new Set(settings.disabledSkillIds ?? [])

    return forcedIds.filter((id) => disabled.has(id))
  }

  // Maps skill ids to their display names in the given order, skipping unknown ids. Used for the nudge.
  async skillNamesForIds(ids: string[]): Promise<string[]> {
    const skills = await this.skillCatalog()
    const nameById = new Map(skills.map((skill) => [skill.id, skill.name]))

    return ids.map((id) => nameById.get(id)).filter((name): name is string => name !== undefined)
  }

  // Returns one skill's view plus its SKILL.md body for the detail view (any source).
  async getSkillDetail(id: string): Promise<SkillDetailView> {
    const [skills, settings] = await Promise.all([
      this.skillCatalog(),
      this.repository.getSettings()
    ])
    const skill = skills.find((entry) => entry.id === id)

    if (!skill) {
      throw new Error(`Unknown skill: ${id}`)
    }

    const disabled = new Set(settings.disabledSkillIds ?? [])
    const { body } = await readSkillFile(skill.sourceDir)
    const references = await this.listSkillReferences(skill.sourceDir)

    return { ...this.toSkillView(skill, disabled), body, references }
  }

  // Lists the file names directly under a skill's `references/` directory (empty when absent).
  private async listSkillReferences(sourceDir: string): Promise<{ path: string }[]> {
    try {
      const entries = await readdir(join(sourceDir, 'references'), { withFileTypes: true })

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({ path: entry.name }))
        .sort((a, b) => a.path.localeCompare(b.path))
    } catch {
      return []
    }
  }

  // Toggles a skill and returns the refreshed list. The agent picks up the change on its next reconnect
  // (driven by the IPC layer's onSkillsChanged), which re-provisions the config dir.
  async setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]> {
    await this.repository.setSkillEnabled(request.id, request.enabled)

    return this.listSkills()
  }

  // Creates a personal skill from the in-app editor, returning the refreshed list.
  async createSkill(request: CreateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.createPersonal(request, request.slug)

    return this.listSkills()
  }

  // Updates an existing personal skill in place, returning the refreshed list.
  async updateSkill(request: UpdateSkillRequest): Promise<SkillView[]> {
    await this.userSkills.updatePersonal(request.id, {
      name: request.name,
      description: request.description,
      body: request.body,
      references: request.references
    })

    return this.listSkills()
  }

  // Deletes a personal or imported skill, returning the refreshed list.
  async deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]> {
    await this.userSkills.delete(request.id)
    // Drop any stale disabled entry so a re-created skill with the same id starts enabled.
    await this.repository.setSkillEnabled(request.id, true)

    return this.listSkills()
  }

  // Imports a skill from a public GitHub URL (deduplicated), returning the outcome + refreshed list.
  async importSkill(request: ImportSkillRequest): Promise<ImportSkillResult> {
    const outcome = await this.userSkills.importFromGitHub(request.url, netFetch)

    return { status: outcome.status, id: outcome.id, skills: await this.listSkills() }
  }

  // Imports a skill from an uploaded .zip / .skill bundle, returning the outcome + refreshed list. The
  // decode is bounded by the (larger) whole-bundle cap since one upload may carry many skills.
  async importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult> {
    const zip = decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    const outcome = await this.userSkills.importFromZip(zip, {
      subPath: request.subPath,
      replaceId: request.replaceId
    })

    return { status: outcome.status, id: outcome.id, skills: await this.listSkills() }
  }

  // Imports several skills from ONE uploaded bundle in a single call (the bundle is decoded and
  // unpacked once). Per-item failures are reported without aborting the rest; the refreshed list is
  // returned once at the end.
  async importSkillZipBatch(
    request: ImportSkillZipBatchRequest
  ): Promise<ImportSkillZipBatchResult> {
    const zip = decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    const outcomes = await this.userSkills.importFromZipBatch(zip, request.items)
    // Success and failure are mutually exclusive: a succeeded item carries status+id, a failed one
    // carries only error (never a placeholder status).
    const results: ImportSkillZipBatchResult['results'] = outcomes.map((entry) =>
      entry.outcome
        ? { subPath: entry.subPath, status: entry.outcome.status, id: entry.outcome.id }
        : { subPath: entry.subPath, error: entry.error ?? 'Import failed.' }
    )
    return { results, skills: await this.listSkills() }
  }

  // Parses an uploaded bundle for a confirm-before-import preview, without writing anything. Returns
  // the importable skills plus any the bundle contained that were skipped (too large, no SKILL.md, ...).
  async previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreviewResult> {
    return this.userSkills.previewZip(
      decodeBoundedBase64(request.dataBase64, SKILL_IMPORT_LIMITS.maxBundleBytes)
    )
  }

  // Scans a GitHub repo for importable skill directories (marking already-imported ones).
  async scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult> {
    return { skills: await this.userSkills.scanRepo(request.repo, netFetch) }
  }

  // Projects a catalog skill into its renderer-safe view given the disabled set.
  private toSkillView(skill: BundledSkill, disabled: Set<string>): SkillView {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      updatedAt: skill.updatedAt,
      enabled: !disabled.has(skill.id),
      author: skill.author,
      license: skill.license,
      thirdParty: skill.thirdParty
    }
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
      ? this.resolveProviderApiEndpoints(activeProvider)
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

    return computePreflight({
      settings,
      claudePathExists,
      opencodePathExists,
      codexPathExists,
      agentFrameworkId,
      isProviderKeyUsable: (provider) => this.isProviderKeyUsable(provider),
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

      // Build codexComponents even for successful detection so onboarding shows separate rows
      const codexComponents: ClaudeDetectResult['codexComponents'] = {
        adapterFound: true,
        adapterPath: cached.resolvedPath,
        adapterVersion: cachedVersions.version,
        nativeCliFound: !!cached.nativePath,
        nativeCliPath: cached.nativePath,
        nativeCliVersion: cachedVersions.nativeVersion
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
        nativePath: detected.managedCodexPath,
        nativeVersion: detected.managedCodexVersion
      })

      // Build codexComponents for successful detection
      const codexComponents: ClaudeDetectResult['codexComponents'] = {
        adapterFound: true,
        adapterPath: detected.adapterPath,
        adapterVersion: detected.adapterVersion,
        nativeCliFound: !!detected.managedCodexPath,
        nativeCliPath: detected.managedCodexPath,
        nativeCliVersion: detected.managedCodexVersion
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
        adapterVersion: components.adapterVersion
      }
    }
  }

  private async probeCodexRuntime(
    codex: StoredCodexInfo | undefined
  ): Promise<Pick<StoredCodexInfo, 'version' | 'nativeVersion'> | undefined> {
    if (!codex?.resolvedPath) return undefined

    const adapterOutput = await this.codexDetectDeps.getAdapterVersion(codex.resolvedPath)
    const version = adapterOutput ? parseCodexVersion(adapterOutput) : undefined
    if (!version) return undefined

    if (!isManagedCodexPath(codex.resolvedPath, this.storageRoot)) return { version }
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
    await this.repository.markOnboardingComplete(Date.now())

    return this.getSettingsView()
  }

  // Records that the one-time legacy-absolute-path normalization pass has succeeded, so later
  // launches skip it. The caller is responsible for only invoking this after the pass actually
  // completed without throwing (see normalizeLegacyDataPaths).
  async markPathsNormalized(): Promise<void> {
    await this.repository.markPathsNormalized(Date.now())
  }

  // Persists the new data-root path after a successful migration (see storage/migration-service.ts).
  // The caller is responsible for only invoking this once the move itself has succeeded.
  async setDataRoot(path: string): Promise<void> {
    await this.repository.setDataRoot(path)
  }

  // Records that the user has answered the one-time legacy-data-move prompt (moved, relocated, or
  // declined), so it is never shown again. Idempotent-once at the repository layer.
  async dismissLegacyDataMovePrompt(): Promise<void> {
    await this.repository.markLegacyDataMovePromptDismissed(Date.now())
  }

  // Encrypts any new key, recomputes its mask, and inserts/updates the provider record.
  async upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot> {
    const settings = await this.repository.getSettings()
    const existing = request.id
      ? settings.providers.find((provider) => provider.id === request.id)
      : undefined

    const provider: StoredProvider = {
      id: existing?.id ?? this.createProviderId(),
      type: request.type,
      name: request.name?.trim() || existing?.name || 'Untitled provider'
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

    if (request.type === 'official') {
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

      // Required-field guard: never persist an incomplete custom provider, even if the UI is bypassed.
      if (!baseUrl) throw new Error('Base URL is required for a custom provider.')
      if (!model) throw new Error('Model is required for a custom provider.')
      if (!carryKey()) throw new Error('API key is required for a custom provider.')

      const apiEndpoints = request.apiEndpoints ?? existing?.apiEndpoints ?? ['anthropic']

      provider.baseUrl = baseUrl
      provider.model = model
      provider.supportsImageInput =
        request.supportsImageInput ?? existing?.supportsImageInput ?? false
      // Which chat APIs this gateway speaks (drives per-framework availability); defaults to anthropic.
      provider.apiEndpoints = apiEndpoints
      credentialsChanged =
        Boolean(request.key) ||
        provider.baseUrl !== existing?.baseUrl ||
        provider.model !== existing?.model ||
        provider.apiEndpoints.join(',') !== (existing?.apiEndpoints ?? []).join(',')
    } else {
      // claude-default: optional model override, no credentials of its own.
      const model = request.model?.trim() || existing?.model

      if (model) provider.model = model
    }

    // A re-test is required before a changed provider can re-gate onboarding.
    if (existing?.lastValidatedAt !== undefined && !credentialsChanged) {
      provider.lastValidatedAt = existing.lastValidatedAt
    }

    // Carry a prior failure only while credentials are unchanged; a credential change invalidates it
    // (the provider must be re-tested), so it drops and the warning clears until the next test.
    if (existing?.lastValidationFailure !== undefined && !credentialsChanged) {
      provider.lastValidationFailure = existing.lastValidationFailure
    }

    await this.repository.upsertProvider(provider)

    return this.getSettingsView()
  }

  async deleteProvider(id: string): Promise<SettingsSnapshot> {
    await this.repository.deleteProvider(id)

    return this.getSettingsView()
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

    const validationGeneration = resolved.storedId
      ? (this.providerValidationGenerations.get(resolved.storedId) ?? 0) + 1
      : undefined
    if (resolved.storedId && validationGeneration !== undefined) {
      this.providerValidationGenerations.set(resolved.storedId, validationGeneration)
    }

    // A provider test is a connectivity/key check on the provider's first model — it confirms the key
    // and endpoint work, nothing more. Per-model Codex bridge compatibility is a static registry mark
    // (bridgeUnsupportedModels), not a runtime probe, so there is no per-model capability to stamp.
    const result = await validateProvider(resolved.provider, {
      runClaudeProbe:
        resolved.provider.type === 'claude-default'
          ? () => this.runClaudeProbe(resolved.provider, settings)
          : undefined
    })

    if (resolved.storedId) {
      if (this.providerValidationGenerations.get(resolved.storedId) !== validationGeneration) {
        return result
      }
      const latestSettings = await this.repository.getSettings()
      const stored = latestSettings.providers.find((provider) => provider.id === resolved.storedId)
      if (!stored) return result
      const latestResolved = this.resolveProvider(
        stored,
        latestSettings.activeProviderId === stored.id ? latestSettings.activeModel : undefined
      )
      if (!this.sameValidationTarget(resolved.provider, latestResolved)) return result

      // Success stamps the validated time and clears any prior failure. A failure keeps the provider
      // but records why, so the list can flag it and the model pickers exclude it until it passes.
      await this.repository.upsertProvider(
        result.ok
          ? {
              ...stored,
              lastValidatedAt: Date.now(),
              lastValidationFailure: undefined
            }
          : {
              ...stored,
              lastValidatedAt: undefined,
              lastValidationFailure: {
                at: Date.now(),
                category: result.category,
                status: result.status,
                message: result.message
              }
            }
      )
    }

    return result
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
    const settings = await this.repository.getSettings()
    const connectors = settings.connectors
    if (!connectors?.customMcpServers) return connectors

    const resolvedServers: StoredCustomMcpServer[] = []
    for (const stored of connectors.customMcpServers) {
      let secured = stored
      // Migrate pre-encryption settings on first read. The renderer never receives the resolved secrets.
      if ((stored.env || stored.headers) && isEncryptionAvailable()) {
        secured = {
          ...stored,
          ...(stored.env ? { envRefs: this.encryptSecretRecord(stored.env) } : {}),
          ...(stored.headers ? { headerRefs: this.encryptSecretRecord(stored.headers) } : {}),
          env: undefined,
          headers: undefined
        }
        await this.repository.updateCustomServer(stored.id, secured)
      }

      resolvedServers.push({
        ...secured,
        env: secured.envRefs ? this.decryptSecretRecord(secured.envRefs) : secured.env,
        headers: secured.headerRefs ? this.decryptSecretRecord(secured.headerRefs) : secured.headers
      })
    }

    return { ...connectors, customMcpServers: resolvedServers }
  }

  private encryptSecretRecord(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(values).map(([name, value]) => [name, encryptKey(value)])
    )
  }

  private decryptSecretRecord(
    refs: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    if (!refs) return undefined
    const values = Object.entries(refs).flatMap(([name, ref]) => {
      const value = tryDecryptKey(ref)
      return value === undefined ? [] : [[name, value] as const]
    })
    return values.length > 0 ? Object.fromEntries(values) : undefined
  }

  // Materializes the enabled skill set into opencode's isolated config dir (same skills/<name>/SKILL.md
  // layout Claude uses), so opencode's native skill tool discovers them. A turn-forced skill overrides
  // its disabled state, mirroring the Claude provisioning path.
  private async materializeAgentSkills(
    settings: StoredSettings,
    configRoot: string
  ): Promise<void> {
    const disabled = new Set(
      (settings.disabledSkillIds ?? []).filter((id) => !this.turnForcedSkillIds.has(id))
    )
    const enabled = (await this.skillCatalog()).filter((skill) => !disabled.has(skill.id))

    await new ClaudeCodeSkillMaterializer().sync(configRoot, enabled)

    // Connector skill docs (which instruct the agent to reach a service ONLY via `host.mcp` from the
    // notebook kernel) are otherwise synced only into the Claude config dir. Non-Claude frameworks
    // (Codex, opencode) read skills from their own home, so without this they never get connector
    // guidance and fall back to ad-hoc calls (e.g. curl). Materialize them into this framework's dir too.
    const connectors = await this.getConnectors()
    await syncConnectorSkillDocs(join(configRoot, 'skills'), this.enabledConnectorIds(connectors))
  }

  // Bundled connectors the user hasn't turned off (default-on), for opencode instruction delivery.
  private enabledConnectorIds(connectors: StoredConnectors | undefined): string[] {
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])

    return CONNECTOR_CATALOG.map((meta) => meta.id).filter((id) => !disabled.has(id))
  }

  // Projects the bundled catalog into renderer views, applying the stored opt-out / auto-allow sets.
  private toConnectorViews(connectors: StoredConnectors | undefined): ConnectorView[] {
    const disabled = new Set(connectors?.disabledConnectorIds ?? [])
    const autoAllow = new Set(connectors?.autoAllowIds ?? [])

    return CONNECTOR_CATALOG.map((meta) => ({
      id: meta.id,
      displayName: meta.displayName,
      description: meta.description,
      sources: meta.sources,
      requiresNcbi: meta.requiresNcbi,
      enabled: !disabled.has(meta.id),
      autoAllow: autoAllow.has(meta.id),
      group: meta.group ?? 'featured'
    })).sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  private ncbiView(connectors: StoredConnectors | undefined): NcbiCredentialsView {
    return { contactEmail: connectors?.contactEmail, hasApiKey: !!connectors?.ncbiApiKeyRef }
  }

  // Projects stored custom MCP servers into renderer views (no secret env/header values).
  private toCustomServerViews(connectors: StoredConnectors | undefined): CustomServerView[] {
    return (connectors?.customMcpServers ?? [])
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        transport: s.transport,
        enabled: s.enabled,
        command: s.command,
        args: s.args,
        url: s.url
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private async connectorsSnapshot(): Promise<ConnectorsSnapshot> {
    const connectors = await this.getConnectors()

    return {
      connectors: this.toConnectorViews(connectors),
      customServers: this.toCustomServerViews(connectors),
      ncbi: this.ncbiView(connectors)
    }
  }

  // Lists every bundled connector with enabled / auto-allow state, plus shared NCBI credential state.
  async listConnectors(): Promise<ConnectorsSnapshot> {
    return this.connectorsSnapshot()
  }

  // Returns one connector's view plus its tools (with per-tool permission) and metadata.
  async getConnectorDetail(id: string): Promise<ConnectorDetailView> {
    const meta = CONNECTOR_CATALOG.find((entry) => entry.id === id)

    if (!meta) throw new Error(`Unknown connector: ${id}`)

    const connectors = await this.getConnectors()
    const view = this.toConnectorViews(connectors).find((entry) => entry.id === id)
    const blocked = new Set(connectors?.blockedToolIds ?? [])
    const ask = new Set(connectors?.askToolIds ?? [])
    const tools = getConnectorTools(id).map((tool) => {
      const toolId = `${id}/${tool.id}`
      // Precedence: block > ask > allow (the default; tools run without a prompt unless opted in).
      const permission: ToolPermission = blocked.has(toolId)
        ? 'block'
        : ask.has(toolId)
          ? 'ask'
          : 'allow'

      return { id: toolId, method: tool.id, description: tool.description, permission }
    })

    return { ...view!, useWhen: meta.useWhen, termsUrl: meta.termsUrl, tools }
  }

  // Enables/disables one bundled connector and returns the refreshed snapshot.
  async setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot> {
    await this.repository.setConnectorDisabled(request.id, !request.enabled)

    return this.connectorsSnapshot()
  }

  // Toggles "skip approvals" for one connector (autoAllowIds) and returns the refreshed snapshot.
  async setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot> {
    await this.repository.setConnectorAutoAllow(request.id, request.autoAllow)

    return this.connectorsSnapshot()
  }

  // Sets one tool's permission (allow = run without a prompt [default], ask = prompt each call,
  // block = denied) and returns the connector's refreshed detail.
  async setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView> {
    await this.repository.setToolPolicy(
      request.toolId,
      request.permission === 'ask',
      request.permission === 'block'
    )
    const connectorId = request.toolId.split('/')[0]

    return this.getConnectorDetail(connectorId)
  }

  // Sets or clears the shared contact email and NCBI API key (encrypted at rest), returning state.
  async setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot> {
    const existing = await this.getConnectors()
    // An omitted apiKey leaves the stored key unchanged; an empty string clears it.
    const apiKeyRef =
      request.apiKey === undefined
        ? existing?.ncbiApiKeyRef
        : request.apiKey === ''
          ? undefined
          : encryptKey(request.apiKey)

    await this.repository.setNcbiCredentials(request.contactEmail?.trim() || undefined, apiKeyRef)

    return this.connectorsSnapshot()
  }

  // Adds a user-provided custom MCP server (add-time trust is the caller's responsibility). The
  // config is sanitized to enforce per-transport requirements before it is persisted.
  async addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    const candidate: StoredCustomMcpServer = {
      id: randomUUID(),
      name: request.name.trim(),
      transport: request.transport,
      enabled: true,
      trustedAt: Date.now(),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(request.env && Object.keys(request.env).length > 0
        ? { envRefs: this.encryptSecretRecord(request.env) }
        : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(request.headers && Object.keys(request.headers).length > 0
        ? { headerRefs: this.encryptSecretRecord(request.headers) }
        : {})
    }
    const server = sanitizeCustomMcpServer(candidate)

    if (!server) throw new Error('Invalid custom connector configuration')

    await this.repository.addCustomServer(server)

    return this.connectorsSnapshot()
  }

  // Enables/disables one custom MCP server and returns the refreshed snapshot.
  async setCustomServerEnabled(
    request: SetCustomServerEnabledRequest
  ): Promise<ConnectorsSnapshot> {
    await this.repository.setCustomServerEnabled(request.id, request.enabled)

    return this.connectorsSnapshot()
  }

  // Removes one custom MCP server and returns the refreshed snapshot.
  async removeCustomServer(request: RemoveCustomServerRequest): Promise<ConnectorsSnapshot> {
    await this.repository.removeCustomServer(request.id)

    return this.connectorsSnapshot()
  }

  // Edits an existing custom MCP server, keeping its immutable identity (id, name, enabled, trust).
  // Omitted env/headers keep the stored secret values; providing them replaces the set.
  async updateCustomServer(request: UpdateCustomServerRequest): Promise<ConnectorsSnapshot> {
    const existing = (await this.getConnectors())?.customMcpServers?.find(
      (s) => s.id === request.id
    )

    if (!existing) throw new Error(`Unknown custom connector: ${request.id}`)

    const envRefs = request.env ? this.encryptSecretRecord(request.env) : existing.envRefs
    const headerRefs = request.headers
      ? this.encryptSecretRecord(request.headers)
      : existing.headerRefs
    // Preserve legacy plaintext only when the caller leaves it untouched and safeStorage is still
    // unavailable. A later getConnectors() call migrates it as soon as encryption becomes available.
    const legacyEnv = request.env === undefined ? existing.env : undefined
    const legacyHeaders = request.headers === undefined ? existing.headers : undefined
    const merged: StoredCustomMcpServer = {
      id: existing.id,
      name: existing.name,
      transport: request.transport,
      enabled: existing.enabled,
      ...(existing.trustedAt !== undefined ? { trustedAt: existing.trustedAt } : {}),
      ...(request.description?.trim() ? { description: request.description.trim() } : {}),
      ...(request.command?.trim() ? { command: request.command.trim() } : {}),
      ...(request.args && request.args.length > 0 ? { args: request.args } : {}),
      ...(envRefs && Object.keys(envRefs).length > 0 ? { envRefs } : {}),
      ...(legacyEnv && Object.keys(legacyEnv).length > 0 ? { env: legacyEnv } : {}),
      ...(request.url?.trim() ? { url: request.url.trim() } : {}),
      ...(headerRefs && Object.keys(headerRefs).length > 0 ? { headerRefs } : {}),
      ...(legacyHeaders && Object.keys(legacyHeaders).length > 0 ? { headers: legacyHeaders } : {})
    }
    const server = sanitizeCustomMcpServer(merged)

    if (!server) throw new Error('Invalid custom connector configuration')

    await this.repository.updateCustomServer(request.id, server)

    return this.connectorsSnapshot()
  }

  // Reports whether npm is on PATH so the installer UI can default to/enable the npm source.
  async isNpmAvailable(): Promise<boolean> {
    const { available } = await detectNpmAvailable()

    return available
  }

  // Builds the spawn env for the active provider, read fresh so switching takes effect on reconnect.
  async resolveActiveSpawnConfig(): Promise<AgentSpawnConfig> {
    const settings = await this.repository.getSettings()
    let executablePath = settings.claude?.resolvedPath

    // Trust the stored path only if it still exists. A user who uninstalled Claude leaves a stale path
    // behind; spawning it launches a ghost that dies immediately (surfacing as write EPIPE), so fall
    // back to a live detect and, if that also finds nothing, fail with a clear, actionable message.
    if (!executablePath || !(await this.pathExists(executablePath))) {
      const detected = await detectClaude(this.detectDeps)
      executablePath = detected.found ? detected.path : undefined
    }

    if (!executablePath) {
      throw new Error('Claude executable is not configured. Complete onboarding in settings.')
    }

    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined

    if (!activeProvider) {
      throw new Error('No active model provider is configured. Configure one in settings.')
    }

    // Ensure the app-owned config dir exists (and app assets are injected) before the agent spawns. The
    // enabled skill set (featured + imported + personal) is materialized here, so a toggle/create/import
    // takes effect on the next spawn. Any skill force-loaded for the current turn is subtracted from the
    // disabled set so a picked-but-disabled skill materializes for this prompt without mutating settings.
    const appConfigDir = getAppClaudeConfigDir(this.storageRoot)
    const disabledSkillIds = (settings.disabledSkillIds ?? []).filter(
      (id) => !this.turnForcedSkillIds.has(id)
    )
    await provisionAppClaudeConfigDir(appConfigDir, {
      skills: await this.skillCatalog(),
      disabledSkillIds
    })

    let envOverrides = buildProviderEnv(
      this.resolveProvider(activeProvider, settings.activeModel),
      {
        storageRoot: this.storageRoot,
        claudeExecutablePath: executablePath
      }
    )

    // The "local" provider reuses the machine's own Claude login: inject its token/base URL (or copy
    // OAuth credentials) at spawn time. OS-store-only OAuth falls back to Claude's implicit default
    // config context, because setting CLAUDE_CONFIG_DIR makes that native login invisible.
    if (activeProvider.type === 'claude-default') {
      envOverrides = await applyLocalClaudeAuth(envOverrides, {
        userClaudeDir: this.userClaudeDir,
        appConfigDir
      })
    }

    return { envOverrides, executablePath }
  }

  // Resolves the active agent backend for one connect: the selected framework plus its spawn inputs.
  // Claude reuses the existing provider-env path unchanged; other frameworks (opencode) map the active
  // provider to their own native config (a generated opencode.json) via the framework adapter and get
  // it written to disk before spawn. The framework can be forced with OPEN_SCIENCE_AGENT_FRAMEWORK for
  // the spike until the settings selector lands.
  async resolveActiveAgentBackend(): Promise<ResolvedAgentBackend> {
    const settings = await this.repository.getSettings()
    const forced = process.env.OPEN_SCIENCE_AGENT_FRAMEWORK
    const frameworkId: AgentFrameworkId =
      forced === 'opencode' || forced === 'claude-code' || forced === 'codex'
        ? forced
        : (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
    const framework = getAgentFramework(frameworkId)

    // Enforce provider↔framework compatibility up front so an incompatible pair fails with a clear
    // message instead of spawning an agent that can't use the credentials — e.g. OpenCode + a Local
    // Claude provider (Claude-only login), or Claude + an OpenAI-only gateway.
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined

    if (!activeProvider) {
      throw new Error('No active model provider is configured. Configure one in settings.')
    }

    if (
      !isProviderUsableByFramework(
        {
          apiEndpoints: this.resolveProviderApiEndpoints(activeProvider),
          type: activeProvider.type
        },
        framework
      )
    ) {
      throw new Error(
        `The active model isn't compatible with ${framework.displayName}. Open Settings → Model to pick a compatible model or switch the agent framework.`
      )
    }

    if (
      framework.id === 'codex' &&
      !isModelBridgeSupported(
        activeProvider,
        this.resolveActiveModel(activeProvider, settings.activeModel)
      )
    ) {
      throw new Error(
        'The active model is not supported over the Codex Chat Completions bridge. Pick another model in Settings → Model.'
      )
    }

    if (framework.id === 'claude-code') {
      await this.disableResponsesBridge()
      // Unchanged Claude path: skills provisioning + Anthropic-shaped env + local-auth handling.
      const { envOverrides, executablePath } = await this.resolveActiveSpawnConfig()

      return { framework, executablePath, env: envOverrides }
    }

    const executablePath =
      framework.id === 'codex'
        ? await this.resolveCodexExecutable(settings.codex?.resolvedPath)
        : await this.resolveOpencodeExecutable(settings.opencodePath)
    const skillsRoot =
      framework.id === 'codex'
        ? codexStorageDir(this.storageRoot)
        : opencodeConfigDir(this.storageRoot)
    await this.materializeAgentSkills(settings, skillsRoot)
    const provider = this.resolveProvider(activeProvider, settings.activeModel)
    const needsResponsesBridge =
      framework.id === 'codex' && (provider.apiEndpoints?.includes('openai') ?? false)
    const enabledConnectorIds = this.enabledConnectorIds(settings.connectors)
    const responsesBridge = needsResponsesBridge
      ? await this.ensureResponsesBridge(provider, enabledConnectorIds)
      : await this.disableResponsesBridge()
    const modelConfig = framework.prepareModelConfig(provider, {
      storageRoot: this.storageRoot,
      executablePath,
      responsesBridge,
      // Connector conventions + tools, so opencode uses host.mcp instead of raw HTTP (it has no skill
      // docs like Claude). Enabled bundled connectors only.
      instructions: renderConnectorInstructions(enabledConnectorIds)
    })
    await this.writeAgentConfigFiles(modelConfig.configFiles)

    // opencode picks the model from its own provider config; drive the app's active model over the ACP
    // session model configOption (applied best-effort per session by the runtime).
    return {
      framework,
      executablePath,
      env: {
        ...(modelConfig.env ?? {}),
        ...(framework.id === 'codex' && settings.codex?.nativePath
          ? { CODEX_PATH: settings.codex.nativePath }
          : {})
      },
      args: modelConfig.args,
      sessionModel: modelConfig.sessionModel ?? provider.model,
      authentication: modelConfig.authentication,
      providerConfiguration: modelConfig.providerConfiguration
    }
  }

  private async ensureResponsesBridge(
    provider: ResolvedProvider,
    enabledConnectorIds: string[]
  ): Promise<ResponsesBridgeConnection> {
    // Resolve to the OpenAI base the bridge appends `/chat/completions` to: an official vendor's exact
    // versioned base, or a custom gateway root normalized to `<root>/v1`.
    const targetBaseUrl = openAiCompletionsBase(provider)
    if (!targetBaseUrl) throw new Error('The Chat Completions provider has no base URL.')

    const target = {
      baseUrl: targetBaseUrl,
      key: provider.key,
      model: provider.model,
      namespacedTools: [...CODEX_BRIDGE_NOTEBOOK_TOOLS, ...CODEX_BRIDGE_ARTIFACT_TOOLS],
      connectorInstructions: enabledConnectorIds.map((id) => {
        const metadata = CONNECTOR_CATALOG.find((connector) => connector.id === id)
        return {
          id,
          aliases: metadata
            ? [metadata.displayName, ...(metadata.aliases ?? []), ...metadata.sources]
            : [],
          content: renderSkillDoc(id)
        }
      })
    }
    if (!this.responsesBridge) {
      this.responsesBridge = new ResponsesBridge(target)
    } else {
      this.responsesBridge.setTarget(target)
    }

    return this.responsesBridge.start()
  }

  private async disableResponsesBridge(): Promise<undefined> {
    if (this.responsesBridge) await this.responsesBridge.close()
    this.responsesBridge = undefined
    return undefined
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

  private async resolveCodexExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) return storedPath

    const detected = await detectCodex(this.codexDetectDeps)
    if (!detected) {
      throw new Error('codex-acp executable not found. Install Codex in settings.')
    }

    return detected.adapterPath
  }

  // Writes a framework's generated config files (e.g. opencode.json) to disk ahead of spawn.
  private async writeAgentConfigFiles(
    files: { path: string; content: string; mode?: number }[] | undefined
  ): Promise<void> {
    for (const file of files ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content, { encoding: 'utf8', mode: file.mode })
      if (file.mode !== undefined) await chmod(file.path, file.mode)
    }
  }

  // The chat APIs a provider speaks: official providers come from the registry, custom gateways from
  // their stored/drafted endpoints, everything else defaults to Anthropic /v1/messages.
  private resolveProviderApiEndpoints(provider: StoredProvider): ChatApiEndpoint[] {
    if (provider.type === 'official' && provider.vendorId) {
      return resolveVendorApiEndpoints(provider.vendorId)
    }

    return provider.apiEndpoints && provider.apiEndpoints.length > 0
      ? [...provider.apiEndpoints]
      : ['anthropic']
  }

  // Maps a stored provider to its masked renderer view, flagging custom keys that no longer decrypt.
  private toProviderView(provider: StoredProvider, activeModel?: string): ProviderView {
    const hasKey = Boolean(provider.keyRef)
    // custom and official both require a decryptable key; claude-default carries none.
    const needsKey =
      provider.type !== 'claude-default' && hasKey && tryDecryptKey(provider.keyRef) === undefined

    return {
      id: provider.id,
      type: provider.type,
      name: provider.name,
      apiEndpoints: this.resolveProviderApiEndpoints(provider),
      baseUrl: provider.baseUrl,
      model: provider.model,
      supportsImageInput: this.providerSupportsImageInput(provider, activeModel),
      vendorId: provider.vendorId,
      region: provider.region,
      models: this.availableModels(provider),
      maskedKey: provider.keyMask,
      hasKey,
      needsKey,
      lastValidatedAt: provider.lastValidatedAt,
      lastValidationFailure: provider.lastValidationFailure
    }
  }

  private providerSupportsImageInput(provider: StoredProvider, activeModel?: string): boolean {
    // claude-default always supports images (uses the user's Claude login, which has vision models)
    if (provider.type === 'claude-default') return true

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

  // Credentials usable: claude-default always; custom/official need a key that still decrypts.
  private isProviderKeyUsable(provider: StoredProvider): boolean {
    if (provider.type === 'claude-default') return true

    return Boolean(provider.keyRef) && tryDecryptKey(provider.keyRef) !== undefined
  }

  // Models selectable for a provider: the vendor catalog for official providers, else the single
  // configured model (custom always has one; claude-default may carry an override).
  private availableModels(provider: StoredProvider): string[] {
    if (provider.type === 'official' && provider.vendorId) {
      // Live-fetched models (via "refresh from vendor") take precedence over the bundled catalog.
      if (provider.fetchedModels && provider.fetchedModels.length > 0) return provider.fetchedModels

      return getOfficialVendor(provider.vendorId)?.models ?? []
    }

    return provider.model ? [provider.model] : []
  }

  // Picks the model to activate: the requested one when the provider offers it, else the first
  // available (falling back to a provider's own stored model).
  private resolveActiveModel(
    provider: StoredProvider | undefined,
    requested?: string
  ): string | undefined {
    if (!provider) return undefined

    const available = this.availableModels(provider)

    if (requested && available.includes(requested)) return requested
    // Prefer the provider's chosen default (custom's only model, or an official vendor's picked one).
    if (provider.model && available.includes(provider.model)) return provider.model

    return available[0] ?? provider.model
  }

  // Decrypts a stored provider into the spawn/validation shape (plaintext key held only transiently).
  // Official vendors reuse the custom HTTP/bearer path: base URL comes from the registry and the model
  // defaults to the vendor's first catalog entry unless a specific one is passed as the override.
  private resolveProvider(provider: StoredProvider, modelOverride?: string): ResolvedProvider {
    const key = provider.keyRef ? tryDecryptKey(provider.keyRef) : undefined

    if (provider.type === 'official' && provider.vendorId) {
      return {
        type: 'custom',
        baseUrl: resolveVendorBaseUrl(provider.vendorId, provider.region),
        openaiBaseUrl: resolveVendorOpenAiBaseUrl(provider.vendorId, provider.region),
        model: modelOverride ?? defaultVendorModel(provider.vendorId),
        key,
        apiEndpoints: this.resolveProviderApiEndpoints(provider),
        supportsImageInput: this.providerSupportsImageInput(provider, modelOverride)
      }
    }

    return {
      type: provider.type,
      baseUrl: provider.baseUrl,
      model: modelOverride ?? provider.model,
      key,
      apiEndpoints: this.resolveProviderApiEndpoints(provider),
      supportsImageInput: this.providerSupportsImageInput(provider, modelOverride)
    }
  }

  // Resolves an unsaved draft into the validation shape, mapping an official draft to the custom path
  // with the vendor's registry base URL + default model.
  private resolveDraft(draft: ProviderDraft): ResolvedProvider {
    if (draft.type === 'official' && isOfficialVendorId(draft.vendorId)) {
      return {
        type: 'custom',
        baseUrl: resolveVendorBaseUrl(draft.vendorId, draft.region),
        openaiBaseUrl: resolveVendorOpenAiBaseUrl(draft.vendorId, draft.region),
        model: draft.model ?? defaultVendorModel(draft.vendorId),
        key: draft.key,
        // Official vendors declare their own endpoints; a custom draft carries the user's choice.
        apiEndpoints: resolveVendorApiEndpoints(draft.vendorId)
      }
    }

    return {
      type: draft.type,
      baseUrl: draft.baseUrl,
      model: draft.model,
      key: draft.key,
      apiEndpoints: draft.apiEndpoints ?? ['anthropic']
    }
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
      left.baseUrl === right.baseUrl &&
      left.openaiBaseUrl === right.openaiBaseUrl &&
      left.model === right.model &&
      left.key === right.key &&
      (left.apiEndpoints ?? []).join(',') === (right.apiEndpoints ?? []).join(',')
    )
  }

  // One-shot `claude -p "ok"` probe for claude-default validation, using the isolated/default env. A
  // hard timeout guarantees the wizard never hangs on a claude that never returns; a timeout is
  // reported distinctly so the UI can say "timed out" rather than "auth failed".
  private async runClaudeProbe(
    provider: ResolvedProvider,
    settings: StoredSettings
  ): Promise<ClaudeProbeResult> {
    const executablePath = settings.claude?.resolvedPath

    if (!executablePath) {
      return { ok: false, message: 'Claude executable is not configured.' }
    }

    const appConfigDir = getAppClaudeConfigDir(this.storageRoot)
    await provisionAppClaudeConfigDir(appConfigDir, {
      skills: await this.skillCatalog(),
      disabledSkillIds: settings.disabledSkillIds
    })

    const envOverrides = await applyLocalClaudeAuth(
      buildProviderEnv(provider, {
        storageRoot: this.storageRoot,
        claudeExecutablePath: executablePath
      }),
      { userClaudeDir: this.userClaudeDir, appConfigDir }
    )
    const env = {
      ...process.env,
      ...envOverrides
    }

    // The native-auth fallback requires the variable to be absent, including from the parent process.
    if (!('CLAUDE_CONFIG_DIR' in envOverrides)) delete env.CLAUDE_CONFIG_DIR

    try {
      await this.executeClaudeProbe(executablePath, env)

      return { ok: true }
    } catch (error) {
      return isTimeoutError(error)
        ? { ok: false, timedOut: true, message: 'Local claude did not respond in time.' }
        : {
            ok: false,
            message:
              'Local Claude could not authenticate. Run `claude` in a terminal and log in, then try again.'
          }
    }
  }

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

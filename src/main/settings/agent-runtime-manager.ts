import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  EnvironmentCheckResult,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  ValidateProviderResult
} from '../../shared/settings'
import { isProviderUsableByFramework } from '../../shared/settings'
import { isModelBridgeSupported } from '../../shared/provider-registry'
import { CLAUDE_EXECUTABLE_MISSING_MESSAGE } from '../../shared/run-error-classification'
import { buildAgentSpawnEnv } from '../acp/agent-process'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentFrameworkId
} from '../agent-framework'
import type { AgentConfigFile } from '../agent-framework/types'
import { syncConnectorSkillDocs } from '../connectors/provision'
import { ComputeHostRepository } from '../compute/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { hasCanonicalComputeSkillDoc, syncComputeSkillDoc } from '../compute/skill-doc'
import { writeAgentConfigFiles } from './agent-config-files'
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
import { detectNpmAvailable, runInstallWithFallback, type InstallTarget } from './claude-install'
import { OPENCODE_INSTALL_TARGET } from './opencode-install'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import {
  DEFAULT_REGISTRIES,
  installManagedClaude,
  isManagedClaudePath,
  managedClaudeDir,
  uninstallManagedClaude,
  type InstallManagedClaudeOptions,
  type ManagedInstallOutcome
} from './managed-claude'
import {
  installManagedOpencode,
  isManagedOpencodePath,
  managedOpencodeDir,
  uninstallManagedOpencode,
  type InstallManagedOpencodeOptions
} from './managed-opencode'
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
import { computePreflight } from './preflight'
import { isEncryptionAvailable } from './crypto'
import { augmentedPathEnv } from './shell-path'
import { buildProviderEnv, getAppClaudeConfigDir, type ResolvedProvider } from './provider-env'
import { resolveSystemProxyEnvironment, type SystemProxyEnvironment } from './system-proxy'
import type { ProviderAccountsModule } from './provider-accounts'
import type { SettingsRepository } from './repository'
import type { SkillCatalogModule } from './skill-catalog'
import type { ConnectorSettingsModule } from './connector-settings'
import type { StoredCodexInfo, StoredSettings } from './types'

const execFileAsync = promisify(execFile)
const CLAUDE_PROBE_TIMEOUT_MS = 20_000
const CODEX_INSTALL_TARGET: InstallTarget = {
  npmPackage: '@agentclientprotocol/codex-acp',
  // Codex exposes no supported shell installer; InstallCodexRequest cannot select this branch.
  scriptUnix: ''
}

const isManagedCodexPath = (adapterPath: string, storageRoot: string): boolean =>
  adapterPath === managedCodexAdapterEntry(storageRoot)

export type ExecuteClaudeProbe = (
  executablePath: string,
  env: NodeJS.ProcessEnv,
  runtimeArgs?: string[]
) => Promise<void>

const executeClaudeProbe: ExecuteClaudeProbe = async (executablePath, env, runtimeArgs = []) => {
  await execFileAsync(executablePath, [...runtimeArgs, '-p', 'ok'], {
    env,
    timeout: CLAUDE_PROBE_TIMEOUT_MS,
    // On Windows the detected claude is a `claude.cmd` shim, which execFile cannot launch without a
    // shell. Keep the probe on the same platform-specific path as the pre-extraction implementation.
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

export type ProviderPreflightAccess = Pick<
  ProviderAccountsModule,
  'isProviderKeyUsable' | 'resolveActiveModel' | 'resolveProviderApiEndpoints'
>

export type RuntimeUninstallResult = {
  activeBackendAffected: boolean
}

export type AgentRuntimeManagerOptions = {
  repository: SettingsRepository
  storageRoot: string
  userClaudeDir: string
  skills: SkillCatalogModule
  connectors: ConnectorSettingsModule
  allocateSettingsIdSequence: () => number
  detectDeps?: ClaudeDetectDeps
  opencodeDetectDeps?: OpencodeDetectDeps
  codexDetectDeps?: CodexDetectDeps
  allocateOpenCodeUsagePort?: () => Promise<number>
  executeClaudeProbe?: ExecuteClaudeProbe
  installManagedClaudeImpl?: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedOpencodeImpl?: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedCodexImpl?: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  resolveCodexProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
  syncComputeSkillDocument?: (skillsDir: string) => Promise<void>
}

// Owns host runtime discovery, installation, executable preparation, and runtime-specific filesystem
// provisioning. Durable records remain serialized by SettingsRepository; live ACP generations and
// reconnect decisions remain outside this module.
export class AgentRuntimeManager {
  private readonly repository: SettingsRepository
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private readonly skills: SkillCatalogModule
  private readonly connectors: ConnectorSettingsModule
  private readonly allocateSettingsIdSequence: () => number
  private readonly detectDeps: ClaudeDetectDeps
  private readonly opencodeDetectDeps: OpencodeDetectDeps
  private readonly codexDetectDeps: CodexDetectDeps
  private readonly allocateOpenCodeUsagePort: () => Promise<number>
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
  private readonly resolveProxyEnvironment: () => Promise<SystemProxyEnvironment | undefined>
  private readonly syncComputeSkillDocument: (skillsDir: string) => Promise<void>

  constructor(options: AgentRuntimeManagerOptions) {
    this.repository = options.repository
    this.storageRoot = options.storageRoot
    this.userClaudeDir = options.userClaudeDir
    this.skills = options.skills
    this.connectors = options.connectors
    this.allocateSettingsIdSequence = options.allocateSettingsIdSequence

    const baseDetectDeps = options.detectDeps ?? createDefaultDetectDeps()
    this.detectDeps = {
      ...baseDetectDeps,
      extraDirs: [...(baseDetectDeps.extraDirs ?? []), managedClaudeDir(this.storageRoot)]
    }

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

    this.allocateOpenCodeUsagePort = options.allocateOpenCodeUsagePort ?? allocateLoopbackPort
    this.executeClaudeProbe = options.executeClaudeProbe ?? executeClaudeProbe
    this.installManagedClaudeImpl = options.installManagedClaudeImpl ?? installManagedClaude
    this.installManagedOpencodeImpl = options.installManagedOpencodeImpl ?? installManagedOpencode
    this.installManagedCodexImpl = options.installManagedCodexImpl ?? installManagedCodex
    this.resolveProxyEnvironment =
      options.resolveCodexProxyEnvironment ?? resolveSystemProxyEnvironment
    this.syncComputeSkillDocument =
      options.syncComputeSkillDocument ??
      (async (skillsDir) => {
        if (!(await hasCanonicalComputeSkillDoc(skillsDir))) return
        const hosts = await new ComputeHostRepository(() =>
          getProjectDbClient(this.storageRoot)
        ).list()
        await syncComputeSkillDoc(skillsDir, hosts)
      })
  }

  async getPreflight(providers: ProviderPreflightAccess): Promise<Preflight> {
    const settings = await this.repository.getSettings()
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
    const activeEndpoints = activeProvider
      ? providers.resolveProviderApiEndpoints(activeProvider, activeProvider.model)
      : undefined
    const activeProviderCompatible = activeProvider
      ? isProviderUsableByFramework(
          { apiEndpoints: activeEndpoints, type: activeProvider.type },
          framework
        ) &&
        (framework.id !== 'codex' ||
          isModelBridgeSupported(
            activeProvider,
            providers.resolveActiveModel(activeProvider, settings.activeModel)
          ))
      : false
    const activeProviderKeyUsable =
      activeProvider && activeProvider.lastValidatedAt !== undefined
        ? await providers.isProviderKeyUsable(activeProvider)
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

  async checkEnvironment(): Promise<EnvironmentCheckResult> {
    const settings = await this.repository.getSettings()
    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
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
      encryptionAvailable: isEncryptionAvailable()
    })
  }

  async detectClaude(): Promise<ClaudeDetectResult> {
    const result = await detectClaude(this.detectDeps)

    if (result.found && result.path) {
      await this.repository.setClaudeInfo({ resolvedPath: result.path, version: result.version })
    } else {
      const cached = (await this.repository.getSettings()).claude
      if (cached?.resolvedPath && !(await this.pathExists(cached.resolvedPath))) {
        await this.repository.setClaudeInfo({})
      }
    }

    return result
  }

  async detectOpencode(): Promise<void> {
    const detected = await detectOpencode(this.opencodeDetectDeps)

    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)
    } else {
      const cached = (await this.repository.getSettings()).opencodePath
      if (cached && !(await this.pathExists(cached))) await this.repository.clearOpencodeInfo()
    }
  }

  async detectCodex(): Promise<void> {
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
  }

  async installClaude(
    request: InstallClaudeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-${Date.now()}-${this.allocateSettingsIdSequence()}`

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
    if (result.ok) await this.detectClaude()
    return result
  }

  async installOpencode(
    request: InstallOpencodeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-opencode-${Date.now()}-${this.allocateSettingsIdSequence()}`

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
    if (result.ok) await this.detectOpencode()
    return result
  }

  async installCodex(
    request: InstallCodexRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-codex-${Date.now()}-${this.allocateSettingsIdSequence()}`

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

  async uninstallClaude(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.claude?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'claude-code'

    if (!resolvedPath || !isManagedClaudePath(resolvedPath, this.storageRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedClaude(this.storageRoot)
    await this.detectClaude()
    await this.autoSwitchAwayFrom('claude-code')
    return { activeBackendAffected: wasActive }
  }

  async uninstallOpencode(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.opencodePath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'opencode'

    if (!resolvedPath || !isManagedOpencodePath(resolvedPath, this.storageRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedOpencode(this.storageRoot)
    await this.detectOpencode()
    await this.autoSwitchAwayFrom('opencode')
    return { activeBackendAffected: wasActive }
  }

  async uninstallCodex(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.codex?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'codex'

    if (!resolvedPath || !isManagedCodexPath(resolvedPath, this.storageRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedCodex(this.storageRoot)
    await this.repository.clearCodexInfo()
    await this.detectCodex()
    await this.autoSwitchAwayFrom('codex')
    return { activeBackendAffected: wasActive }
  }

  isManagedRuntimePath(frameworkId: AgentFrameworkId, path: string): boolean {
    if (frameworkId === 'claude-code') return isManagedClaudePath(path, this.storageRoot)
    if (frameworkId === 'opencode') return isManagedOpencodePath(path, this.storageRoot)
    return isManagedCodexPath(path, this.storageRoot)
  }

  async isNpmAvailable(): Promise<boolean> {
    const { available } = await detectNpmAvailable()
    return available
  }

  async reserveOpenCodeUsagePort(): Promise<number> {
    return this.allocateOpenCodeUsagePort()
  }

  async resolveCodexProxyEnvironment(): Promise<SystemProxyEnvironment | undefined> {
    return this.resolveProxyEnvironment()
  }

  async materializeAgentSkills(
    settings: StoredSettings,
    configRoot: string,
    forcedSkillIds: ReadonlySet<string>
  ): Promise<void> {
    await this.skills.materializeSkills(configRoot, settings.disabledSkillIds ?? [], forcedSkillIds)
    const connectors = await this.connectors.getConnectors()
    await syncConnectorSkillDocs(
      join(configRoot, 'skills'),
      this.connectors.enabledConnectorIds(connectors)
    )
    await this.syncComputeSkillDocument(join(configRoot, 'skills'))
  }

  async materializeAgentConfigFiles(files: AgentConfigFile[] | undefined): Promise<void> {
    await writeAgentConfigFiles(files)
  }

  async provisionClaudeRuntimeConfig(
    settings: StoredSettings,
    forcedSkillIds: ReadonlySet<string> = new Set(),
    modelConfig?: ClaudeRuntimeModelConfig | null
  ): Promise<string> {
    const configDir = getAppClaudeConfigDir(this.storageRoot)
    const disabledSkillIds = (settings.disabledSkillIds ?? []).filter(
      (id) => !forcedSkillIds.has(id)
    )
    await this.skills.provisionClaudeConfig(configDir, disabledSkillIds, modelConfig)
    const connectors = await this.connectors.getConnectors()
    await syncConnectorSkillDocs(
      join(configDir, 'skills'),
      this.connectors.enabledConnectorIds(connectors)
    )
    await this.syncComputeSkillDocument(join(configDir, 'skills'))
    return configDir
  }

  async resolveClaudeExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) return storedPath

    const detected = await detectClaude(this.detectDeps)
    if (detected.found && detected.path) return detected.path
    throw new Error(CLAUDE_EXECUTABLE_MISSING_MESSAGE)
  }

  async resolveOpencodeExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) return storedPath

    const detected = await detectOpencode(this.opencodeDetectDeps)
    if (!detected) {
      throw new Error(
        'opencode executable not found. Install opencode or set its path in settings.'
      )
    }
    return detected.resolvedPath
  }

  async resolveCodexExecutable(
    storedPath: string | undefined,
    nativePath: string | undefined
  ): Promise<string> {
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

  async probeCodexNativeVersion(nativePath: string | undefined): Promise<string | undefined> {
    if (!nativePath) return undefined
    const output = await this.codexDetectDeps.getCodexVersion(nativePath).catch(() => undefined)
    return output ? parseCodexVersion(output) : undefined
  }

  async runClaudeSubscriptionProbe(
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

  private async resolveClaudeRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cached = settings.claude
    if (cached?.resolvedPath) {
      const version = await this.detectDeps.getVersion(cached.resolvedPath)
      if (version) {
        if (version !== cached.version) {
          await this.repository.setClaudeInfo({ resolvedPath: cached.resolvedPath, version })
        }
        return { found: true, path: cached.resolvedPath, version }
      }
    }
    return this.detectClaude()
  }

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

    const detected = await detectOpencode(this.opencodeDetectDeps)
    if (detected) {
      await this.repository.setOpencodeInfo(detected.resolvedPath, detected.version)
      return { found: true, path: detected.resolvedPath, version: detected.version }
    }
    if (cachedPath && !(await this.pathExists(cachedPath)))
      await this.repository.clearOpencodeInfo()
    return { found: false }
  }

  private async resolveCodexRuntime(settings: StoredSettings): Promise<ClaudeDetectResult> {
    const cached = settings.codex
    const cachedVersions = await this.probeCodexRuntime(cached)
    if (cached?.resolvedPath && cachedVersions) {
      await this.repository.setCodexInfo({ ...cached, ...cachedVersions })
      let nativeCliFound = !!cached.nativePath
      let nativeCliPath = cached.nativePath
      let nativeCliVersion = cachedVersions.nativeVersion

      if (!cached.nativePath) {
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(this.codexDetectDeps)
        if (nativeCodex) {
          nativeCliPath = nativeCodex.path
          nativeCliVersion = nativeCodex.version
        }
      }

      return {
        found: true,
        path: cached.resolvedPath,
        version: cachedVersions.version,
        codexComponents: {
          adapterFound: true,
          adapterPath: cached.resolvedPath,
          adapterVersion: cachedVersions.version,
          nativeCliFound,
          nativeCliPath,
          nativeCliVersion
        }
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
      let nativeCliFound = !!detected.nativeCodexPath
      let nativeCliPath = detected.nativeCodexPath
      let nativeCliVersion = detected.nativeCodexVersion

      if (!detected.nativeCodexPath) {
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(this.codexDetectDeps)
        if (nativeCodex) {
          nativeCliPath = nativeCodex.path
          nativeCliVersion = nativeCodex.version
        }
      }

      return {
        found: true,
        path: detected.adapterPath,
        version: detected.adapterVersion,
        codexComponents: {
          adapterFound: true,
          adapterPath: detected.adapterPath,
          adapterVersion: detected.adapterVersion,
          nativeCliFound,
          nativeCliPath,
          nativeCliVersion
        }
      }
    }

    if (cached?.resolvedPath && !(await this.pathExists(cached.resolvedPath))) {
      await this.repository.clearCodexInfo()
    }

    const { detectCodexComponents } = await import('./codex-detect')
    const components = await detectCodexComponents(this.codexDetectDeps)
    let diagnostic: string | undefined
    if (components.nativeCliFound && !components.adapterFound) {
      diagnostic = `Native Codex ${components.nativeCliVersion} is installed at ${components.nativeCliPath}, but the Codex ACP adapter required by Open Science is missing.`
    } else if (!components.nativeCliFound && components.adapterFound) {
      diagnostic =
        components.adapterFailureReason === 'smoke-test-failed'
          ? `Codex ACP adapter ${components.adapterVersion} is installed at ${components.adapterPath}, but it failed to initialize (native Codex CLI may be missing or incompatible).`
          : `Codex ACP adapter is installed at ${components.adapterPath}, but version detection failed.`
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
    if (codex.resolvedPath !== controlledAdapterPath) return undefined

    const adapterOutput = await this.codexDetectDeps.getAdapterVersion(codex.resolvedPath)
    const version = adapterOutput ? parseCodexVersion(adapterOutput) : undefined
    if (!version || !codex.nativePath) return undefined
    const nativeOutput = await this.codexDetectDeps.getCodexVersion(codex.nativePath)
    const nativeVersion = nativeOutput ? parseCodexVersion(nativeOutput) : undefined
    return nativeVersion ? { version, nativeVersion } : undefined
  }

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

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}

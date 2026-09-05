import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  EnvironmentCheckResult,
  InstallClaudeRequest,
  InstallCodeBuddyRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  ValidateProviderResult
} from '../../shared/settings'
import {
  isProviderUsableByFramework,
  preferredEndpoint,
  requiresChatCompletionsBridge
} from '../../shared/settings'
import {
  buildUnsupportedCodexAcpVersionMessage,
  isSupportedCodexAcpVersion,
  MINIMUM_CODEX_ACP_VERSION
} from '../../shared/codex-runtime'
import { isModelBridgeSupported } from '../../shared/provider-registry'
import { CLAUDE_EXECUTABLE_MISSING_MESSAGE } from '../../shared/run-error-classification'
import { buildAgentSpawnEnv } from '../acp/agent-process'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentFrameworkId
} from '../agent-framework'
import type { AgentConfigFile } from '../agent-framework/types'
import {
  connectorSkillSourceDir,
  syncConnectorSkillDocs,
  syncMaterializedCustomServerSkillDocs
} from '../connectors/provision'
import { createLogger } from '../logger'
import type { SkillDirectoryLayout } from '../skills/materializer'
import { writeAgentConfigFiles } from './agent-config-files'
import { createDefaultDetectDeps, detectClaude, type ClaudeDetectDeps } from './claude-detect'
import {
  createDefaultDetectDeps as createOpencodeDetectDeps,
  detectOpencode,
  type OpencodeDetectDeps
} from './opencode-detect'
import {
  detectCodeBuddy,
  isSupportedCodeBuddyVersion,
  type CodeBuddyDetectDeps
} from './codebuddy-detect'
import {
  detectCodex,
  parseVersion as parseCodexVersion,
  runAcpInitializeSmoke,
  type CodexDetectDeps
} from './codex-detect'
import { detectNpmAvailable, runInstallWithFallback, type InstallTarget } from './claude-install'
import { OPENCODE_INSTALL_TARGET } from './opencode-install'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import { provisionAppClaudePrivateProfile } from './claude-config-provision'
import { provisionClaudeRuntime, type ClaudeRuntimeAssets } from './claude-runtime-provisioner'
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
  installManagedCodeBuddy,
  isManagedCodeBuddyPath,
  managedCodeBuddyDir,
  uninstallManagedCodeBuddy,
  type InstallManagedCodeBuddyOptions
} from './managed-codebuddy'
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
import { buildProviderEnv, type ResolvedProvider } from './provider-env'
import { resolveSystemProxyEnvironment, type SystemProxyEnvironment } from './system-proxy'
import type { ProviderAccountsModule } from './provider-accounts'
import type { SettingsRepository } from './repository'
import type { SkillCatalogModule } from './skill-catalog'
import type { ConnectorSettingsModule } from './connector-settings'
import type { StoredCodexInfo, StoredSettings } from './types'

const execFileAsync = promisify(execFile)
const log = createLogger('agent-runtime-manager')
const CLAUDE_PROBE_TIMEOUT_MS = 20_000
const RUNTIME_PROBE_REUSE_WINDOW_MS = 2_000
const CODEX_INSTALL_TARGET: InstallTarget = {
  npmPackage: '@agentclientprotocol/codex-acp',
  // Codex exposes no supported shell installer; InstallCodexRequest cannot select this branch.
  scriptUnix: ''
}

const isManagedCodexPath = (adapterPath: string, configRoot: string): boolean =>
  adapterPath === managedCodexAdapterEntry(configRoot)

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

type ConfiguredRuntimeProbe = {
  fingerprint: string
  claudeVersion: string | null
  opencodeVersion: string | null
  codebuddyVersion: string | null
  codex: ConfiguredCodexRuntimeProbe
}

type ConfiguredCommandProbe = { output: string | null; path: string }

type ConfiguredCodexRuntimeProbe = {
  adapter?: ConfiguredCommandProbe
  native?: ConfiguredCommandProbe
}

type ReusableRuntimeProbe = {
  capturedAt: number
  probe: ConfiguredRuntimeProbe
}

const runtimeProbeFingerprint = (input: {
  claudePath?: string
  opencodePath?: string
  codebuddyPath?: string
  codexAdapterPath?: string
  codexNativePath?: string
}): string =>
  JSON.stringify([
    input.claudePath ?? null,
    input.opencodePath ?? null,
    input.codebuddyPath ?? null,
    input.codexAdapterPath ?? null,
    input.codexNativePath ?? null
  ])

const storedRuntimeProbeFingerprint = (settings: StoredSettings): string =>
  runtimeProbeFingerprint({
    claudePath: settings.claude?.resolvedPath,
    opencodePath: settings.opencodePath,
    codebuddyPath: settings.codebuddyPath,
    codexAdapterPath: settings.codex?.resolvedPath,
    codexNativePath: settings.codex?.nativePath
  })

const codexVersionsFromProbe = (
  probe: ConfiguredCodexRuntimeProbe
): Pick<StoredCodexInfo, 'version' | 'nativeVersion'> | undefined => {
  const version = probe.adapter?.output ? parseCodexVersion(probe.adapter.output) : undefined
  const nativeVersion = probe.native?.output ? parseCodexVersion(probe.native.output) : undefined
  return version && nativeVersion && isSupportedCodexAcpVersion(version)
    ? { version, nativeVersion }
    : undefined
}

export type AgentRuntimeManagerOptions = {
  repository: SettingsRepository
  configRoot: string
  userClaudeDir: string
  skills: SkillCatalogModule
  connectors: ConnectorSettingsModule
  allocateSettingsIdSequence: () => number
  detectDeps?: ClaudeDetectDeps
  opencodeDetectDeps?: OpencodeDetectDeps
  codebuddyDetectDeps?: CodeBuddyDetectDeps
  codexDetectDeps?: CodexDetectDeps
  allocateOpenCodeUsagePort?: () => Promise<number>
  executeClaudeProbe?: ExecuteClaudeProbe
  installManagedClaudeImpl?: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedOpencodeImpl?: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedCodeBuddyImpl?: (
    options: InstallManagedCodeBuddyOptions
  ) => Promise<ManagedInstallOutcome>
  installManagedCodexImpl?: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  resolveCodexProxyEnvironment?: () => Promise<SystemProxyEnvironment | undefined>
}

// Owns host runtime discovery, installation, executable preparation, and runtime-specific filesystem
// provisioning. Durable records remain serialized by SettingsRepository; live ACP generations and
// reconnect decisions remain outside this module.
export class AgentRuntimeManager {
  private readonly repository: SettingsRepository
  private readonly configRoot: string
  private readonly userClaudeDir: string
  private readonly skills: SkillCatalogModule
  private readonly connectors: ConnectorSettingsModule
  private readonly allocateSettingsIdSequence: () => number
  private readonly detectDeps: ClaudeDetectDeps
  private readonly opencodeDetectDeps: OpencodeDetectDeps
  private readonly codebuddyDetectDeps: CodeBuddyDetectDeps
  private readonly codexDetectDeps: CodexDetectDeps
  private readonly allocateOpenCodeUsagePort: () => Promise<number>
  private readonly executeClaudeProbe: ExecuteClaudeProbe
  private activeInstallId: string | undefined
  private environmentCheckRuntimeProbe: ReusableRuntimeProbe | undefined
  private preflightRuntimeProbe: ReusableRuntimeProbe | undefined
  private readonly installManagedClaudeImpl: (
    options: InstallManagedClaudeOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedOpencodeImpl: (
    options: InstallManagedOpencodeOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedCodeBuddyImpl: (
    options: InstallManagedCodeBuddyOptions
  ) => Promise<ManagedInstallOutcome>
  private readonly installManagedCodexImpl: (
    options: InstallManagedCodexOptions
  ) => Promise<ManagedCodexInstallOutcome>
  private readonly resolveProxyEnvironment: () => Promise<SystemProxyEnvironment | undefined>

  constructor(options: AgentRuntimeManagerOptions) {
    this.repository = options.repository
    this.configRoot = options.configRoot
    this.userClaudeDir = options.userClaudeDir
    this.skills = options.skills
    this.connectors = options.connectors
    this.allocateSettingsIdSequence = options.allocateSettingsIdSequence

    const baseDetectDeps = options.detectDeps ?? createDefaultDetectDeps()
    this.detectDeps = {
      ...baseDetectDeps,
      extraDirs: [...(baseDetectDeps.extraDirs ?? []), managedClaudeDir(this.configRoot)]
    }

    const baseOpencodeDetectDeps = options.opencodeDetectDeps ?? createOpencodeDetectDeps()
    this.opencodeDetectDeps = {
      ...baseOpencodeDetectDeps,
      extraDirs: [...(baseOpencodeDetectDeps.extraDirs ?? []), managedOpencodeDir(this.configRoot)]
    }
    const baseCodeBuddyDetectDeps = options.codebuddyDetectDeps ?? createOpencodeDetectDeps()
    this.codebuddyDetectDeps = {
      ...baseCodeBuddyDetectDeps,
      extraDirs: [
        ...(baseCodeBuddyDetectDeps.extraDirs ?? []),
        managedCodeBuddyDir(this.configRoot)
      ]
    }

    const managedAdapterPath = managedCodexAdapterEntry(this.configRoot)
    const managedNativePath = managedCodexBinary(this.configRoot)
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
    this.installManagedCodeBuddyImpl =
      options.installManagedCodeBuddyImpl ?? installManagedCodeBuddy
    this.installManagedCodexImpl = options.installManagedCodexImpl ?? installManagedCodex
    this.resolveProxyEnvironment =
      options.resolveCodexProxyEnvironment ?? resolveSystemProxyEnvironment
  }

  async getPreflight(providers: ProviderPreflightAccess): Promise<Preflight> {
    const settings = await this.repository.getSettings()
    const reusableProbe = this.takeReusableRuntimeProbe('preflightRuntimeProbe', settings)
    const runtimeProbe = reusableProbe ?? (await this.probeConfiguredRuntimes(settings))
    // A fresh Preflight probe is the hand-off to the immediately following full environment check.
    // A consumed environment result is intentionally not re-published after the trailing refresh.
    if (!reusableProbe) this.storeReusableRuntimeProbe('environmentCheckRuntimeProbe', runtimeProbe)

    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const framework = getAgentFramework(agentFrameworkId)
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    const activeModel = activeProvider
      ? providers.resolveActiveModel(activeProvider, settings.activeModel)
      : undefined
    const configuredModelAvailable =
      settings.activeModel === undefined || activeModel === settings.activeModel
    const activeEndpoints = activeProvider
      ? providers.resolveProviderApiEndpoints(activeProvider, activeModel)
      : undefined
    const activeProviderCompatible =
      activeProvider && configuredModelAvailable
        ? isProviderUsableByFramework(
            { apiEndpoints: activeEndpoints, type: activeProvider.type },
            framework
          ) &&
          (framework.id !== 'codex' || isModelBridgeSupported(activeProvider, activeModel))
        : false
    const activeProviderKeyUsable =
      activeProvider && activeProvider.lastValidatedAt !== undefined
        ? await providers.isProviderKeyUsable(activeProvider)
        : false
    const activeValidationTarget = activeProvider
      ? {
          model: activeModel,
          endpoint: preferredEndpoint(
            activeEndpoints ?? [],
            activeProvider.type === 'xai-subscription'
              ? (['responses'] as const)
              : framework.id === 'codex'
                ? (['anthropic', 'openai', 'responses'] as const)
                : requiresChatCompletionsBridge({ apiEndpoints: activeEndpoints }, framework)
                  ? (activeEndpoints ?? [])
                  : framework.supportedApiTypes
          )
        }
      : undefined

    return computePreflight({
      settings,
      claudePathExists: runtimeProbe.claudeVersion !== null,
      opencodePathExists: runtimeProbe.opencodeVersion !== null,
      codebuddyPathExists: isSupportedCodeBuddyVersion(runtimeProbe.codebuddyVersion),
      codexPathExists: codexVersionsFromProbe(runtimeProbe.codex) !== undefined,
      agentFrameworkId,
      isProviderKeyUsable: (provider) =>
        provider.id === activeProvider?.id && activeProviderKeyUsable,
      activeProviderCompatible,
      activeValidationTarget
    })
  }

  async checkEnvironment(): Promise<EnvironmentCheckResult> {
    const settings = await this.repository.getSettings()
    const agentFrameworkId = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    const runtimeProbe = this.takeReusableRuntimeProbe('environmentCheckRuntimeProbe', settings)
    const [claudeRuntime, opencodeRuntime, codebuddyRuntime, codexRuntime] = await Promise.all([
      this.resolveClaudeRuntime(settings, runtimeProbe?.claudeVersion),
      this.resolveOpencodeRuntime(settings, runtimeProbe?.opencodeVersion),
      this.resolveCodeBuddyRuntime(settings, runtimeProbe?.codebuddyVersion),
      this.resolveCodexRuntime(settings, runtimeProbe?.codex)
    ])

    this.storeResolvedRuntimeProbe(
      settings,
      claudeRuntime,
      opencodeRuntime,
      codebuddyRuntime,
      codexRuntime
    )

    return runEnvironmentCheck({
      storageRoot: this.configRoot,
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
        },
        {
          id: 'codebuddy',
          label: getAgentFramework('codebuddy').displayName,
          runtime: codebuddyRuntime
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

  async detectCodeBuddy(): Promise<void> {
    const detected = await detectCodeBuddy(this.codebuddyDetectDeps)
    if (detected) {
      await this.repository.setCodeBuddyInfo(detected.resolvedPath, detected.version)
    } else {
      const cached = (await this.repository.getSettings()).codebuddyPath
      if (cached) await this.repository.clearCodeBuddyInfo()
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

    return this.runExclusiveInstall(installId, async () => {
      if (request.source === 'managed') {
        const registries =
          request.managedRegistry === 'npmmirror'
            ? [DEFAULT_REGISTRIES[1], DEFAULT_REGISTRIES[0]]
            : DEFAULT_REGISTRIES
        const outcome = await this.installManagedClaudeImpl({
          installId,
          onEvent,
          dataRoot: this.configRoot,
          registries,
          verifyBinary: this.detectDeps.getVersion
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
    })
  }

  async installOpencode(
    request: InstallOpencodeRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-opencode-${Date.now()}-${this.allocateSettingsIdSequence()}`

    return this.runExclusiveInstall(installId, async () => {
      if (request.source === 'managed') {
        const outcome = await this.installManagedOpencodeImpl({
          installId,
          onEvent,
          dataRoot: this.configRoot
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
    })
  }

  async installCodeBuddy(
    _request: InstallCodeBuddyRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-codebuddy-${Date.now()}-${this.allocateSettingsIdSequence()}`
    return this.runExclusiveInstall(installId, async () => {
      const outcome = await this.installManagedCodeBuddyImpl({
        installId,
        onEvent,
        dataRoot: this.configRoot
      })
      if (outcome.result.ok && outcome.resolvedPath) {
        await this.repository.setCodeBuddyInfo(outcome.resolvedPath, outcome.version)
      }
      return outcome.result
    })
  }

  async installCodex(
    request: InstallCodexRequest,
    onEvent: (event: ClaudeInstallEvent) => void
  ): Promise<ClaudeInstallResult> {
    const installId = `install-codex-${Date.now()}-${this.allocateSettingsIdSequence()}`

    return this.runExclusiveInstall(installId, async () => {
      if (request.source === 'managed') {
        const settings = await this.repository.getSettings()
        const configuredCodexPath = settings.codex?.nativePath
        const managedCodexPath =
          this.codexDetectDeps.managedCodexPath ?? managedCodexBinary(this.configRoot)
        const externalCodexPath =
          configuredCodexPath && configuredCodexPath !== managedCodexPath
            ? configuredCodexPath
            : undefined
        const existingCodexPath =
          externalCodexPath && (await this.codexDetectDeps.getCodexVersion(externalCodexPath))
            ? externalCodexPath
            : undefined
        const outcome = await this.installManagedCodexImpl({
          installId,
          onEvent,
          dataRoot: this.configRoot,
          ...(existingCodexPath ? { existingCodexPath } : {})
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
    })
  }

  private async runExclusiveInstall(
    installId: string,
    install: () => Promise<ClaudeInstallResult>
  ): Promise<ClaudeInstallResult> {
    if (this.activeInstallId !== undefined) {
      return { installId, ok: false, error: 'Another install is already in progress.' }
    }

    this.activeInstallId = installId
    try {
      return await install()
    } finally {
      if (this.activeInstallId === installId) this.activeInstallId = undefined
    }
  }

  async uninstallClaude(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.claude?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'claude-code'

    if (!resolvedPath || !isManagedClaudePath(resolvedPath, this.configRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedClaude(this.configRoot)
    await this.detectClaude()
    await this.autoSwitchAwayFrom('claude-code')
    return { activeBackendAffected: wasActive }
  }

  async uninstallOpencode(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.opencodePath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'opencode'

    if (!resolvedPath || !isManagedOpencodePath(resolvedPath, this.configRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedOpencode(this.configRoot)
    await this.detectOpencode()
    await this.autoSwitchAwayFrom('opencode')
    return { activeBackendAffected: wasActive }
  }

  async uninstallCodeBuddy(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.codebuddyPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'codebuddy'

    if (!resolvedPath || !isManagedCodeBuddyPath(resolvedPath, this.configRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedCodeBuddy(this.configRoot)
    await this.detectCodeBuddy()
    await this.autoSwitchAwayFrom('codebuddy')
    return { activeBackendAffected: wasActive }
  }

  async uninstallCodex(): Promise<RuntimeUninstallResult> {
    const settings = await this.repository.getSettings()
    const resolvedPath = settings.codex?.resolvedPath
    const wasActive = (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID) === 'codex'

    if (!resolvedPath || !isManagedCodexPath(resolvedPath, this.configRoot)) {
      return { activeBackendAffected: false }
    }

    await uninstallManagedCodex(this.configRoot)
    await this.repository.clearCodexInfo()
    await this.detectCodex()
    await this.autoSwitchAwayFrom('codex')
    return { activeBackendAffected: wasActive }
  }

  isManagedRuntimePath(frameworkId: AgentFrameworkId, path: string): boolean {
    if (frameworkId === 'claude-code') return isManagedClaudePath(path, this.configRoot)
    if (frameworkId === 'opencode') return isManagedOpencodePath(path, this.configRoot)
    if (frameworkId === 'codebuddy') return isManagedCodeBuddyPath(path, this.configRoot)
    return isManagedCodexPath(path, this.configRoot)
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
    forcedSkillIds: ReadonlySet<string>,
    options: Readonly<{ directoryLayout?: SkillDirectoryLayout }> = {}
  ): Promise<string[]> {
    return this.materializeSkillProjection(
      settings,
      configRoot,
      forcedSkillIds,
      this.connectors.enabledConnectorIds(settings.connectors),
      options
    )
  }

  private async materializeSkillProjection(
    settings: StoredSettings,
    configRoot: string,
    forcedSkillIds: ReadonlySet<string>,
    bundledConnectorIds: string[],
    options: Readonly<{ directoryLayout?: SkillDirectoryLayout }> = {}
  ): Promise<string[]> {
    await this.skills.materializeSkills(
      configRoot,
      settings.disabledSkillIds ?? [],
      forcedSkillIds,
      options
    )
    await syncConnectorSkillDocs(join(configRoot, 'skills'), bundledConnectorIds)
    const customSkillSync = await syncMaterializedCustomServerSkillDocs(
      connectorSkillSourceDir(this.configRoot),
      join(configRoot, 'skills'),
      this.connectors.materializedCustomSkillNames()
    )
    for (const failure of customSkillSync.failures) {
      log.warn('Failed to materialize custom Connector Skill doc', failure)
    }
    return [
      ...bundledConnectorIds.map((id) => `mcp-${id}`),
      ...customSkillSync.materializedSkillNames
    ]
  }

  async materializeAgentConfigFiles(files: AgentConfigFile[] | undefined): Promise<void> {
    await writeAgentConfigFiles(files)
  }

  async provisionClaudeRuntimeConfig(
    settings: StoredSettings,
    forcedSkillIds: ReadonlySet<string> = new Set(),
    modelConfig?: ClaudeRuntimeModelConfig | null,
    includeSkillAndConnectorContext = true
  ): Promise<ClaudeRuntimeAssets> {
    return provisionClaudeRuntime({
      storageRoot: this.configRoot,
      provisionPrivateProfile: (privateProfileDir) =>
        provisionAppClaudePrivateProfile(privateProfileDir, modelConfig),
      materializeProjection: async (projectionRoot) => {
        const claudeProjectConfigRoot = join(projectionRoot, '.claude')
        if (!includeSkillAndConnectorContext) {
          await mkdir(join(claudeProjectConfigRoot, 'skills'), { recursive: true })
          return
        }
        const connectors = await this.connectors.getConnectors()
        await this.materializeSkillProjection(
          settings,
          claudeProjectConfigRoot,
          forcedSkillIds,
          this.connectors.enabledConnectorIds(connectors),
          { directoryLayout: 'agent-facing' }
        )
      }
    })
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

  async resolveCodeBuddyExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) {
      const version = await this.codebuddyDetectDeps.getVersion(storedPath).catch(() => undefined)
      if (isSupportedCodeBuddyVersion(version)) return storedPath
    }
    const detected = await detectCodeBuddy(this.codebuddyDetectDeps)
    if (!detected) {
      throw new Error(
        'CodeBuddy executable not found. Install CodeBuddy or re-detect it in settings.'
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
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.configRoot)
    if (!(await this.pathExists(adapterPath))) {
      throw new Error('Open Science Codex ACP adapter not found. Install Codex in settings.')
    }

    const adapterOutput = await this.codexDetectDeps
      .getAdapterVersion(adapterPath)
      .catch(() => undefined)
    const adapterVersion = adapterOutput ? parseCodexVersion(adapterOutput) : undefined
    if (!adapterVersion) {
      throw new Error('Open Science could not determine the Codex ACP adapter version.')
    }
    if (!isSupportedCodexAcpVersion(adapterVersion)) {
      throw new Error(buildUnsupportedCodexAcpVersionMessage(adapterVersion))
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

    const runtimeConfig = await this.provisionClaudeRuntimeConfig(settings)
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.configRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })
    const env = buildAgentSpawnEnv(augmentedPathEnv(process.env), envOverrides, executablePath)

    try {
      if (provider.type === 'claude-shared') {
        await this.executeClaudeProbe(executablePath, env, [
          '--settings',
          runtimeConfig.settingsPath,
          '--add-dir',
          runtimeConfig.skillProjection.root
        ])
      } else {
        await this.executeClaudeProbe(executablePath, env, [
          '--add-dir',
          runtimeConfig.skillProjection.root
        ])
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

  private async resolveClaudeRuntime(
    settings: StoredSettings,
    probedVersion?: string | null
  ): Promise<ClaudeDetectResult> {
    const cached = settings.claude
    if (cached?.resolvedPath) {
      const version =
        probedVersion === undefined
          ? await this.detectDeps.getVersion(cached.resolvedPath)
          : (probedVersion ?? undefined)
      if (version) {
        if (version !== cached.version) {
          await this.repository.setClaudeInfo({ resolvedPath: cached.resolvedPath, version })
        }
        return { found: true, path: cached.resolvedPath, version }
      }
    }
    return this.detectClaude()
  }

  private async resolveOpencodeRuntime(
    settings: StoredSettings,
    probedVersion?: string | null
  ): Promise<ClaudeDetectResult> {
    const cachedPath = settings.opencodePath
    if (cachedPath) {
      const version =
        probedVersion === undefined
          ? await this.opencodeDetectDeps.getVersion(cachedPath)
          : (probedVersion ?? undefined)
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

  private async resolveCodeBuddyRuntime(
    settings: StoredSettings,
    probedVersion?: string | null
  ): Promise<ClaudeDetectResult> {
    const cachedPath = settings.codebuddyPath
    if (cachedPath) {
      const version =
        probedVersion === undefined
          ? await this.codebuddyDetectDeps.getVersion(cachedPath)
          : (probedVersion ?? undefined)
      if (isSupportedCodeBuddyVersion(version)) {
        if (version !== settings.codebuddyVersion) {
          await this.repository.setCodeBuddyInfo(cachedPath, version)
        }
        return { found: true, path: cachedPath, version }
      }
    }
    const detected = await detectCodeBuddy(this.codebuddyDetectDeps)
    if (detected) {
      await this.repository.setCodeBuddyInfo(detected.resolvedPath, detected.version)
      return { found: true, path: detected.resolvedPath, version: detected.version }
    }
    if (cachedPath) await this.repository.clearCodeBuddyInfo()
    return { found: false }
  }

  private async resolveCodexRuntime(
    settings: StoredSettings,
    probedRuntime?: ConfiguredCodexRuntimeProbe
  ): Promise<ClaudeDetectResult> {
    const cached = settings.codex
    const configuredProbe = probedRuntime ?? (await this.probeConfiguredCodexRuntime(cached))
    const cachedVersions = codexVersionsFromProbe(configuredProbe)
    const detectDeps = this.memoizedCodexDetectDeps(configuredProbe)
    if (cached?.resolvedPath && cachedVersions) {
      await this.repository.setCodexInfo({ ...cached, ...cachedVersions })
      let nativeCliFound = !!cached.nativePath
      let nativeCliPath = cached.nativePath
      let nativeCliVersion = cachedVersions.nativeVersion

      if (!cached.nativePath) {
        nativeCliFound = true
        const { detectNativeCodex } = await import('./codex-detect')
        const nativeCodex = await detectNativeCodex(detectDeps)
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

    const detected = await detectCodex(detectDeps)
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
        const nativeCodex = await detectNativeCodex(detectDeps)
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
    const components = await detectCodexComponents(detectDeps)
    let diagnostic: string | undefined
    if (components.nativeCliFound && !components.adapterFound) {
      diagnostic = `Native Codex ${components.nativeCliVersion} is installed at ${components.nativeCliPath}, but the Codex ACP adapter required by Open Science is missing.`
    } else if (!components.nativeCliFound && components.adapterFound) {
      diagnostic =
        components.adapterFailureReason === 'smoke-test-failed'
          ? `Codex ACP adapter ${components.adapterVersion} is installed at ${components.adapterPath}, but it failed to initialize (native Codex CLI may be missing or incompatible).`
          : components.adapterFailureReason === 'unsupported-version'
            ? `Codex ACP adapter ${components.adapterVersion} is installed at ${components.adapterPath}, but Open Science requires ${MINIMUM_CODEX_ACP_VERSION} or later.`
            : `Codex ACP adapter is installed at ${components.adapterPath}, but version detection failed.`
    } else if (components.nativeCliFound && components.adapterFound) {
      if (components.adapterFailureReason === 'smoke-test-failed') {
        diagnostic = `Both native Codex ${components.nativeCliVersion} and ACP adapter ${components.adapterVersion} are installed, but the adapter failed to initialize with the native CLI.`
      } else if (components.adapterFailureReason === 'unsupported-version') {
        diagnostic = `Native Codex ${components.nativeCliVersion} and ACP adapter ${components.adapterVersion} are installed, but Open Science requires ACP adapter ${MINIMUM_CODEX_ACP_VERSION} or later.`
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

  private async probeConfiguredCodexRuntime(
    codex: StoredCodexInfo | undefined
  ): Promise<ConfiguredCodexRuntimeProbe> {
    if (!codex?.resolvedPath) return {}
    const controlledAdapterPath =
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.configRoot)
    if (codex.resolvedPath !== controlledAdapterPath) return {}

    const [adapterOutput, nativeOutput] = await Promise.all([
      this.codexDetectDeps.getAdapterVersion(codex.resolvedPath),
      codex.nativePath ? this.codexDetectDeps.getCodexVersion(codex.nativePath) : undefined
    ])
    return {
      adapter: { path: codex.resolvedPath, output: adapterOutput ?? null },
      ...(codex.nativePath
        ? { native: { path: codex.nativePath, output: nativeOutput ?? null } }
        : {})
    }
  }

  private memoizedCodexDetectDeps(probe: ConfiguredCodexRuntimeProbe): CodexDetectDeps {
    const deps = this.codexDetectDeps
    const adapterVersions = new Map<string, Promise<string | undefined>>()
    const nativeVersions = new Map<string, Promise<string | undefined>>()
    const smokeResults = new Map<string, Promise<boolean>>()
    if (probe.adapter) {
      adapterVersions.set(probe.adapter.path, Promise.resolve(probe.adapter.output ?? undefined))
    }
    if (probe.native) {
      nativeVersions.set(probe.native.path, Promise.resolve(probe.native.output ?? undefined))
    }

    const memoizedVersion = (
      cache: Map<string, Promise<string | undefined>>,
      path: string,
      read: (path: string) => Promise<string | undefined>
    ): Promise<string | undefined> => {
      const existing = cache.get(path)
      if (existing) return existing
      const pending = read(path)
      cache.set(path, pending)
      return pending
    }

    return {
      ...deps,
      getAdapterVersion: (path) => memoizedVersion(adapterVersions, path, deps.getAdapterVersion),
      getCodexVersion: (path) => memoizedVersion(nativeVersions, path, deps.getCodexVersion),
      smokeInitialize: (path, options) => {
        const key = runtimeProbeFingerprint({
          codexAdapterPath: path,
          codexNativePath: options?.codexPath
        })
        const existing = smokeResults.get(key)
        if (existing) return existing
        const pending = deps.smokeInitialize(path, options)
        smokeResults.set(key, pending)
        return pending
      }
    }
  }

  private async probeConfiguredRuntimes(settings: StoredSettings): Promise<ConfiguredRuntimeProbe> {
    const [claudeVersion, opencodeVersion, codebuddyVersion, codex] = await Promise.all([
      settings.claude?.resolvedPath
        ? this.detectDeps.getVersion(settings.claude.resolvedPath)
        : undefined,
      settings.opencodePath ? this.opencodeDetectDeps.getVersion(settings.opencodePath) : undefined,
      settings.codebuddyPath
        ? this.codebuddyDetectDeps.getVersion(settings.codebuddyPath)
        : undefined,
      this.probeConfiguredCodexRuntime(settings.codex)
    ])
    return {
      fingerprint: storedRuntimeProbeFingerprint(settings),
      claudeVersion: claudeVersion ?? null,
      opencodeVersion: opencodeVersion ?? null,
      codebuddyVersion: codebuddyVersion ?? null,
      codex
    }
  }

  private takeReusableRuntimeProbe(
    slot: 'environmentCheckRuntimeProbe' | 'preflightRuntimeProbe',
    settings: StoredSettings
  ): ConfiguredRuntimeProbe | undefined {
    const reusable = this[slot]
    this[slot] = undefined
    if (!reusable) return undefined
    if (Date.now() - reusable.capturedAt > RUNTIME_PROBE_REUSE_WINDOW_MS) return undefined
    return reusable.probe.fingerprint === storedRuntimeProbeFingerprint(settings)
      ? reusable.probe
      : undefined
  }

  private storeReusableRuntimeProbe(
    slot: 'environmentCheckRuntimeProbe' | 'preflightRuntimeProbe',
    probe: ConfiguredRuntimeProbe
  ): void {
    this[slot] = { capturedAt: Date.now(), probe }
  }

  private storeResolvedRuntimeProbe(
    settings: StoredSettings,
    claudeRuntime: ClaudeDetectResult,
    opencodeRuntime: ClaudeDetectResult,
    codebuddyRuntime: ClaudeDetectResult,
    codexRuntime: ClaudeDetectResult
  ): void {
    const claudePath = claudeRuntime.found ? claudeRuntime.path : settings.claude?.resolvedPath
    const opencodePath = opencodeRuntime.found ? opencodeRuntime.path : settings.opencodePath
    const codebuddyPath = codebuddyRuntime.found ? codebuddyRuntime.path : settings.codebuddyPath
    const codexAdapterPath =
      codexRuntime.codexComponents?.adapterPath ??
      (codexRuntime.found ? codexRuntime.path : settings.codex?.resolvedPath)
    const codexNativePath =
      codexRuntime.codexComponents?.nativeCliPath ?? settings.codex?.nativePath
    const controlledAdapterPath =
      this.codexDetectDeps.managedAdapterPath ?? managedCodexAdapterEntry(this.configRoot)
    this.storeReusableRuntimeProbe('preflightRuntimeProbe', {
      fingerprint: runtimeProbeFingerprint({
        claudePath,
        opencodePath,
        codebuddyPath,
        codexAdapterPath,
        codexNativePath
      }),
      claudeVersion: claudeRuntime.found ? (claudeRuntime.version ?? null) : null,
      opencodeVersion: opencodeRuntime.found ? (opencodeRuntime.version ?? null) : null,
      codebuddyVersion: codebuddyRuntime.found ? (codebuddyRuntime.version ?? null) : null,
      codex: {
        ...(codexAdapterPath === controlledAdapterPath
          ? {
              adapter: {
                path: codexAdapterPath,
                output: codexRuntime.version ?? codexRuntime.codexComponents?.adapterVersion ?? null
              }
            }
          : {}),
        ...(codexNativePath
          ? {
              native: {
                path: codexNativePath,
                output: codexRuntime.codexComponents?.nativeCliVersion ?? null
              }
            }
          : {})
      }
    })
  }

  private async autoSwitchAwayFrom(uninstalled: AgentFrameworkId): Promise<void> {
    const settings = await this.repository.getSettings()
    const active = settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID
    if (active !== uninstalled) return

    const candidates: AgentFrameworkId[] = ['claude-code', 'opencode', 'codex', 'codebuddy']
    for (const candidate of candidates) {
      if (candidate === uninstalled) continue
      const path =
        candidate === 'claude-code'
          ? settings.claude?.resolvedPath
          : candidate === 'opencode'
            ? settings.opencodePath
            : candidate === 'codebuddy'
              ? settings.codebuddyPath
              : settings.codex?.resolvedPath
      if (!path) continue

      const version =
        candidate === 'claude-code'
          ? await this.detectDeps.getVersion(path)
          : candidate === 'opencode'
            ? await this.opencodeDetectDeps.getVersion(path)
            : candidate === 'codebuddy'
              ? await this.codebuddyDetectDeps.getVersion(path)
              : await this.codexDetectDeps.getAdapterVersion(path)
      const ready =
        candidate === 'codex'
          ? !!version &&
            isSupportedCodexAcpVersion(parseCodexVersion(version) ?? '') &&
            !!settings.codex?.nativePath &&
            !!(await this.codexDetectDeps.getCodexVersion(settings.codex.nativePath))
          : candidate === 'codebuddy'
            ? isSupportedCodeBuddyVersion(version)
            : !!version
      if (ready) {
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

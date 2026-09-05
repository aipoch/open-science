import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  PermissionProfileUnavailableError,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { augmentedPathEnv } from '../settings/shell-path'
import type { ModelReasoningEffort } from '../../shared/reasoning-effort'
import type { OfficialVendorId } from '../../shared/provider-registry'
import {
  CODEX_ACP_CONFIGURABLE_PROVIDER_ID,
  type AgentFramework,
  type AgentAuthentication,
  type AgentModelCatalogEntry,
  type AgentProviderConfiguration,
  type AgentModelConfig,
  type AgentSpawnInput,
  type ModelConfigContext,
  type ResolvedAgentBackend,
  type SessionSetup,
  type SessionSetupContext
} from './types'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import { CODEX_SUBSCRIPTION_PROVIDER_ID, isCodexSubscriptionProvider } from '../../shared/settings'
import { prepareCodexRuntimeHomeAuthentication } from '../settings/codex-auth'
import { codexStorageDir, codexSubscriptionStorageDir } from '../settings/codex-paths'
import { CODEX_VERSION } from '../settings/managed-codex'
import { clearSystemProxyEnvironment } from '../settings/system-proxy'
import { registerOwnedPosixProcessGroup } from '../process-tree'
import codexNativeModelInstructions from './codex-native-model-instructions.md?raw'

const CODEX_PROVIDER_ID = 'open-science'
// Catalog model used only for Codex's local metadata; the Responses bridge rewrites it to the selected
// upstream provider model, so it never appears in the provider UI and does not decide which model
// answers. It MUST be a classic tool-mode entry (tool_mode unset), not a `code_mode_only` model like
// the gpt-5.6-* family: code-mode models advertise no function tools and instead drive an
// OpenAI-hosted code-execution host that a custom Chat Completions gateway cannot provide, so Codex
// sends zero tools and the agent can only chat. gpt-5.4 advertises the `shell_command` function tool
// and accepts a 1M context override, while the bridge forwards those tools to Chat Completions.
// (apply_patch is still a freeform tool the bridge
// filters, so file edits route through shell rather than the dedicated patch tool.)
export const CODEX_BRIDGE_MODEL = 'gpt-5.4'
const CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95
const CODEX_NATIVE_MODEL_CATALOG_FILENAME_PREFIX = 'model-catalog-'
const CODEX_BUNDLED_MODEL_IDS_BY_VERSION = {
  '0.144.6': [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.2',
    'codex-auto-review'
  ]
} satisfies Record<typeof CODEX_VERSION, readonly string[]>
const CODEX_MODE_IDS = {
  ask: 'read-only',
  auto: 'agent',
  full: 'agent-full-access'
} as const satisfies Record<PermissionProfileId, string>

// Open Science owns delegation lifecycle, authority, permission, and evidence. Keep both the stable
// and preview Codex implementations off in every profile so native children cannot bypass that Host
// contract. This must live in CODEX_CONFIG (rather than only custom model metadata), because trusted
// bundled models intentionally do not receive an app-authored model catalog.
const CODEX_DISABLED_NATIVE_FEATURES = Object.freeze({
  memories: false,
  multi_agent: false,
  multi_agent_v2: false,
  // Disabling unified_exec alone falls back to shell_command. shell_tool disables both generations
  // so execution stays on the app-owned Notebook bash_execute MCP tool.
  shell_tool: false
})
const CODEX_DISABLED_NATIVE_MEMORY = Object.freeze({
  generate_memories: false,
  use_memories: false
})

const CODEX_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_CONFIG',
  'CODEX_HOME',
  'CODEX_PATH',
  'DEFAULT_AUTH_REQUEST',
  'HOME',
  'MODEL_PROVIDER',
  'NO_BROWSER',
  'USERPROFILE'
] as const

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: 'pipe' }
) => ChildProcessWithoutNullStreams

type CodexFrameworkDeps = {
  execPath?: string
  platform?: NodeJS.Platform
  sourceEnv?: NodeJS.ProcessEnv
  spawnProcess?: SpawnProcess
}

const isolatedCodexHomeEnv = (codexHome: string, platform: NodeJS.Platform): NodeJS.ProcessEnv => ({
  // Codex discovers user-installed Skills under $HOME/.agents/skills in addition to
  // $CODEX_HOME/skills. Point both roots at the app-owned profile so a session cannot inherit the
  // desktop user's Skills. USERPROFILE is the native home source on Windows; HOME is retained there
  // as well for child tools that use the Unix-compatible variable.
  HOME: codexHome,
  ...(platform === 'win32' ? { USERPROFILE: codexHome } : {}),
  CODEX_HOME: codexHome
})

const normalizeResponsesBaseUrl = (value: string | undefined): string | undefined => {
  const normalized = value
    ?.trim()
    .replace(/\/+$/, '')
    .replace(/\/responses$/i, '')
  if (!normalized) return undefined

  // Codex posts to `{base_url}/responses`, so a bare origin (e.g. the official
  // `https://api.openai.com`) would target `.../responses` and miss the `/v1` version segment.
  // Append `/v1` only when the input carries no path at all; gateways that already include `/v1`
  // or a custom path are left untouched.
  try {
    const { pathname } = new URL(normalized)
    if (pathname === '' || pathname === '/') return `${normalized}/v1`
  } catch {
    // Non-URL inputs pass through unchanged.
  }

  return normalized
}

const isOfficialOpenAiResponsesBase = (value: string | undefined): boolean => {
  if (!value) return false
  try {
    return new URL(value).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

// Just the model + reasoning-effort fields a Codex config can carry, with no provider plumbing.
// The bridge path layers the open-science custom provider on top of this; the codex-isolated path
// uses it on its own so codex-acp can drive the ChatGPT subscription with the user's selected
// model from session start (issue #277).
const buildCodexModelOptions = (input: {
  model?: string
  reasoningEffort?: ModelReasoningEffort
}): Record<string, unknown> => {
  return {
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { model_reasoning_effort: input.reasoningEffort } : {})
  }
}

const buildCodexConfig = (provider: {
  baseUrl?: string
  model?: string
  contextWindow?: number
  key?: string
  reasoningEffort?: ModelReasoningEffort
}): Record<string, unknown> => {
  const baseUrl = normalizeResponsesBaseUrl(provider.baseUrl)
  const contextWindow =
    provider.contextWindow && provider.contextWindow > 0 ? provider.contextWindow : undefined

  return {
    ...buildCodexModelOptions(provider),
    features: CODEX_DISABLED_NATIVE_FEATURES,
    memories: CODEX_DISABLED_NATIVE_MEMORY,
    ...(contextWindow
      ? {
          model_context_window: contextWindow,
          model_auto_compact_token_limit: Math.floor(
            (contextWindow * CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100
          )
        }
      : {}),
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'Open Science',
        wire_api: 'responses',
        ...(baseUrl ? { base_url: baseUrl } : {}),
        ...(provider.key ? { requires_openai_auth: true } : {})
      }
    }
    // Tool-search configuration is intentionally left at Codex defaults. The Chat bridge exposes its
    // app-owned tools through explicit namespaced aliases and does not depend on deferred tool_search.
  }
}

type CodexNativeModelCatalogInput = {
  model?: string
  vendorId?: OfficialVendorId
  baseUrl?: string
  openaiBaseUrl?: string
  nativeVersion?: string
  contextWindow?: number
  supportsImageInput?: boolean
  reasoningEffort?: ModelReasoningEffort
  reasoningEfforts?: readonly ModelReasoningEffort[]
}

const buildCodexNativeModelCatalogEntry = (provider: CodexNativeModelCatalogInput): unknown => {
  const model = provider.model?.trim()
  // Bundled capabilities are trustworthy only for an exact model/version pair on OpenAI's official
  // backend. A custom provider may represent the real api.openai.com endpoint, so vendor identity
  // alone is insufficient; custom gateways that merely reuse an OpenAI model slug stay conservative.
  const bundledModelIds =
    provider.nativeVersion &&
    Object.hasOwn(CODEX_BUNDLED_MODEL_IDS_BY_VERSION, provider.nativeVersion)
      ? CODEX_BUNDLED_MODEL_IDS_BY_VERSION[
          provider.nativeVersion as keyof typeof CODEX_BUNDLED_MODEL_IDS_BY_VERSION
        ]
      : undefined
  const hasTrustedBundledMetadata =
    (provider.vendorId === 'openai' ||
      isOfficialOpenAiResponsesBase(provider.openaiBaseUrl ?? provider.baseUrl)) &&
    bundledModelIds?.includes(model ?? '') === true
  if (!model || hasTrustedBundledMetadata) return undefined

  const contextWindow =
    provider.contextWindow && provider.contextWindow > 0 ? provider.contextWindow : 272_000
  const supportedReasoningEfforts = [...new Set(provider.reasoningEfforts ?? [])]
  const defaultReasoningEffort =
    provider.reasoningEffort && supportedReasoningEfforts.includes(provider.reasoningEffort)
      ? provider.reasoningEffort
      : null

  return {
    slug: model,
    display_name: model,
    description: null,
    default_reasoning_level: defaultReasoningEffort,
    supported_reasoning_levels: supportedReasoningEfforts.map((effort) => ({
      effort,
      description: `${effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1)} reasoning effort`
    })),
    shell_type: 'shell_command',
    // codex-acp obtains its session model options from app-server model/list. A hidden-only
    // static catalog produces an empty list and makes session/new fail before the first prompt.
    visibility: 'list',
    supported_in_api: true,
    priority: 99,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: codexNativeModelInstructions,
    // Skill discovery is an app/runtime capability, not an optional upstream Responses tool.
    // Keep Codex's native Skill guidance so materialized mcp-* connector skills remain usable.
    include_skills_usage_instructions: true,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    // Native Responses support does not imply support for OpenAI custom/freeform tools, hosted
    // search, or parallel calls. Advertise only the function-shaped shell tool until the provider
    // registry can express and verify those capabilities explicitly.
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    comp_hash: null,
    effective_context_window_percent: CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    experimental_supported_tools: [],
    input_modalities: provider.supportsImageInput ? ['text', 'image'] : ['text'],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null
  }
}

const buildCodexNativeModelCatalog = (
  provider: CodexNativeModelCatalogInput,
  catalog: readonly AgentModelCatalogEntry[] = []
): Record<string, unknown> | undefined => {
  const activeModel = provider.model?.trim()
  const candidates = new Map<string, CodexNativeModelCatalogInput>()
  for (const entry of catalog) {
    const model = entry.provider.model?.trim()
    if (!model) continue
    candidates.set(model, {
      ...entry.provider,
      nativeVersion: provider.nativeVersion,
      reasoningEffort: entry.reasoningEffort,
      reasoningEfforts: entry.reasoningEfforts
    })
  }
  if (activeModel) {
    const catalogEntry = candidates.get(activeModel)
    candidates.set(activeModel, {
      ...catalogEntry,
      ...provider,
      model: activeModel,
      reasoningEffort: provider.reasoningEffort ?? catalogEntry?.reasoningEffort,
      reasoningEfforts: provider.reasoningEfforts ?? catalogEntry?.reasoningEfforts
    })
  }

  // model_catalog_json replaces Codex's native catalog rather than extending it. Keep the native
  // catalog intact when the active official model already has trusted bundled metadata; an
  // unbundled sibling in the provider catalog should not replace the active model's metadata.
  const activeCatalogEntry = activeModel ? candidates.get(activeModel) : undefined
  if (activeCatalogEntry && buildCodexNativeModelCatalogEntry(activeCatalogEntry) === undefined) {
    return undefined
  }

  const models = [...candidates.values()]
    .map(buildCodexNativeModelCatalogEntry)
    .filter((entry) => entry !== undefined)
  return models.length > 0 ? { models } : undefined
}

const buildSpawnEnvironment = (
  input: AgentSpawnInput,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env = augmentedPathEnv(sourceEnv)

  for (const key of CODEX_ENV_KEYS) delete env[key]
  // A resolved proxy or DIRECT decision is authoritative. A resolver failure uses `inherit` so a
  // working proxy supplied by the process launcher remains available as the fallback.
  if (input.proxyEnvironmentMode === 'replace') {
    clearSystemProxyEnvironment(env)
  }

  return {
    ...env,
    ...input.env,
    ELECTRON_RUN_AS_NODE: '1'
  }
}

const mapCodexPermissionProfile = (
  profile: PermissionProfileId,
  modes: SessionModeState | null | undefined
): PermissionProfileApplication => {
  const availableModeIds = modes?.availableModes.map((mode) => mode.id) ?? []
  const modeId = CODEX_MODE_IDS[profile]
  const available = availableModeIds.includes(modeId)
  const conservativeModeId = CODEX_MODE_IDS.ask
  const conservativeModeAvailable = availableModeIds.includes(conservativeModeId)
  const fullAccessAvailable = availableModeIds.includes(CODEX_MODE_IDS.full)

  // Ask is the safety baseline: without read-only the selected posture cannot be enforced. Full is
  // likewise explicit privilege. Auto may still use the app's conservative review fallback.
  if (
    ((profile === 'ask' || profile === 'full') && !available) ||
    (profile === 'auto' && !available && !conservativeModeAvailable)
  ) {
    throw new PermissionProfileUnavailableError(profile)
  }

  const appliedModeId =
    profile === 'auto' && !available ? conservativeModeId : available ? modeId : undefined

  return {
    modeId: appliedModeId,
    state: {
      selectedProfile: profile,
      effectiveProfile: profile,
      currentModeId: appliedModeId ?? modes?.currentModeId,
      availableModeIds,
      ...(profile === 'auto'
        ? { autoReviewStrategy: available ? ('native' as const) : ('conservative' as const) }
        : {}),
      fullAccessAvailable,
      ...(!available
        ? { message: `The Codex runtime does not advertise its ${modeId} permission mode.` }
        : {})
    }
  }
}

export const createCodexFramework = ({
  execPath = process.execPath,
  platform = process.platform,
  sourceEnv = process.env,
  spawnProcess = spawn as SpawnProcess
}: CodexFrameworkDeps = {}): AgentFramework => ({
  id: 'codex',
  displayName: 'Codex',
  commandShellDialect: platform === 'win32' ? 'powershell' : 'posix',
  // codex-acp exposes `/compact` as a built-in command backed by `thread/compact/start`. Codex still
  // owns automatic compaction, so no host trigger threshold is declared here.
  contextCompaction: { kind: 'native-command', command: '/compact' },
  supportsSkills: true,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('codex'),
  acceptsStdioMcp: true,
  // codex-acp advertises a thought_level effort option and honors set_config_option on live sessions
  // (verified live: a session accepted effort 'high' over ACP). If a future adapter stops
  // advertising it, the runtime's no-applied-session guard falls back to a reconnect so the baked
  // model_reasoning_effort config takes over.
  supportsLiveEffortChange: true,
  supportedApiTypes: ['responses'],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    const isJavaScript = /\.[cm]?js$/i.test(input.executablePath)
    const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(input.executablePath)
    const command = isJavaScript
      ? execPath
      : needsShell
        ? `"${input.executablePath}"`
        : input.executablePath
    const args = isJavaScript ? [input.executablePath, ...input.args] : input.args

    const child = spawnProcess(command, args, {
      env: buildSpawnEnvironment(input, sourceEnv),
      stdio: 'pipe',
      // Keep a terminal/dev-runner SIGINT aimed at the Electron application's foreground process
      // group from killing Codex before the app's awaited ACP teardown can mark and reap it. Piped
      // stdio remains referenced (we never unref the child), and the resource owner still performs
      // explicit cross-platform tree teardown. Node's detached process-group behavior is POSIX-only;
      // creating an independent Windows console/process group here would change packaged startup.
      detached: platform !== 'win32',
      windowsHide: true,
      shell: needsShell
    })
    if (platform !== 'win32') registerOwnedPosixProcessGroup(child)
    return child
  },

  async prepareDelegatedSpawn(
    backend: ResolvedAgentBackend,
    runtimeHome: string
  ): Promise<AgentSpawnInput> {
    await prepareCodexRuntimeHomeAuthentication({
      sourceHome: backend.env.CODEX_HOME,
      runtimeHome,
      useSubscriptionAuthentication: backend.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID,
      subscriptionTransport: backend.codexSubscriptionTransport
    })
    return {
      executablePath: backend.executablePath,
      args: [...(backend.args ?? [])],
      env: {
        ...backend.env,
        HOME: runtimeHome,
        CODEX_HOME: runtimeHome,
        ...(platform === 'win32' ? { USERPROFILE: runtimeHome } : {})
      },
      proxyEnvironmentMode: backend.proxyEnvironmentMode
    }
  },

  prepareModelConfig(provider, ctx: ModelConfigContext): AgentModelConfig {
    const persistentSystemPrompt =
      ctx.systemPromptAppends?.filter(Boolean).join('\n\n') || undefined
    if (isCodexSubscriptionProvider(provider.type)) {
      // Every Open Science subscription session uses the same app-owned home. `codex-shared` is
      // accepted only as a legacy Provider discriminator; it must never select the user's global
      // Codex profile at runtime. Seed the model before session creation to avoid the slow late
      // session/set_config_option switch (issue #277).
      const modelOptions = buildCodexModelOptions({
        model: provider.model,
        reasoningEffort: ctx.reasoningEffort
      })
      const codexConfig = {
        ...modelOptions,
        features: CODEX_DISABLED_NATIVE_FEATURES,
        memories: CODEX_DISABLED_NATIVE_MEMORY,
        ...(persistentSystemPrompt ? { developer_instructions: persistentSystemPrompt } : {})
      }
      const codexConfigJson =
        Object.keys(codexConfig).length > 0 ? JSON.stringify(codexConfig) : undefined
      const codexHome = codexSubscriptionStorageDir(ctx.storageRoot)
      return {
        env: {
          ...isolatedCodexHomeEnv(codexHome, platform),
          ...(codexConfigJson ? { CODEX_CONFIG: codexConfigJson } : {})
        },
        ...(persistentSystemPrompt ? { persistentSystemPrompt } : {})
      }
    }

    const bridge = ctx.responsesBridge
    const useChatBridge =
      bridge !== undefined &&
      bridge.kind !== 'responses-compatibility' &&
      !(provider.apiEndpoints?.includes('responses') ?? false)
    const useNativeCompatibility =
      bridge?.kind === 'responses-compatibility' &&
      (provider.apiEndpoints?.includes('responses') ?? false)
    const useLocalResponsesEndpoint = useChatBridge || useNativeCompatibility
    const codexModel = useChatBridge ? CODEX_BRIDGE_MODEL : provider.model
    // A dual-endpoint vendor keeps its Anthropic route in
    // `baseUrl` and its OpenAI/Responses `/v1` root in `openaiBaseUrl`, so post to the latter; a
    // Responses-only provider (e.g. OpenAI) carries its base in `baseUrl`. The Chat bridge and the
    // protocol-preserving native compatibility endpoint both expose a local Responses URL.
    const responsesBaseUrl = useLocalResponsesEndpoint
      ? bridge.baseUrl
      : (provider.openaiBaseUrl ?? provider.baseUrl)
    const authentication: AgentAuthentication | undefined =
      provider.key && !useLocalResponsesEndpoint
        ? {
            methodId: 'api-key',
            _meta: { 'api-key': { apiKey: provider.key } }
          }
        : undefined

    const codexHome = codexStorageDir(ctx.storageRoot)
    const modelCatalog = useChatBridge
      ? undefined
      : buildCodexNativeModelCatalog(
          {
            ...provider,
            nativeVersion: ctx.nativeVersion,
            reasoningEffort: ctx.reasoningEffort,
            reasoningEfforts: ctx.reasoningEfforts
          },
          ctx.providerModelCatalog
        )
    const modelCatalogContent = modelCatalog
      ? `${JSON.stringify(modelCatalog, null, 2)}\n`
      : undefined
    // Multiple Codex sessions share this app-owned home. A content-addressed filename keeps each
    // process pinned to immutable metadata even when different native models start concurrently.
    const modelCatalogPath = modelCatalogContent
      ? join(
          codexHome,
          `${CODEX_NATIVE_MODEL_CATALOG_FILENAME_PREFIX}${createHash('sha256').update(modelCatalogContent).digest('hex')}.json`
        )
      : undefined
    const codexConfig = {
      ...buildCodexConfig({
        ...provider,
        model: codexModel,
        contextWindow: provider.contextWindow,
        baseUrl: responsesBaseUrl,
        key: useLocalResponsesEndpoint ? undefined : provider.key,
        reasoningEffort: ctx.reasoningEffort
      }),
      ...(modelCatalogPath ? { model_catalog_json: modelCatalogPath } : {}),
      ...(persistentSystemPrompt ? { developer_instructions: persistentSystemPrompt } : {})
    }
    return {
      env: {
        ...isolatedCodexHomeEnv(codexHome, platform),
        CODEX_CONFIG: JSON.stringify(codexConfig),
        MODEL_PROVIDER: CODEX_PROVIDER_ID,
        NO_BROWSER: '1'
      },
      configFiles: [
        {
          path: join(codexStorageDir(ctx.storageRoot), 'config.toml'),
          content: 'cli_auth_credentials_store = "ephemeral"\n',
          mode: 0o600
        },
        ...(modelCatalogPath && modelCatalogContent
          ? [
              {
                path: modelCatalogPath,
                content: modelCatalogContent,
                mode: 0o600,
                contentAddressed: true
              }
            ]
          : [])
      ],
      ...(authentication ? { authentication } : {}),
      ...(useLocalResponsesEndpoint
        ? {
            providerConfiguration: {
              providerId: CODEX_ACP_CONFIGURABLE_PROVIDER_ID,
              apiType: 'openai',
              baseUrl: bridge.baseUrl,
              headers: { authorization: `Bearer ${bridge.token}` }
            } satisfies AgentProviderConfiguration
          }
        : {}),
      ...(useChatBridge ? { sessionModel: CODEX_BRIDGE_MODEL } : {}),
      ...(persistentSystemPrompt ? { persistentSystemPrompt } : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // Production backends pass no stable appends here because developer_instructions owns them.
    // Keep the fallback for injected/legacy backends and ephemeral reviewer sessions.
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .filter(Boolean)
      .join('\n\n')
    return {
      ...(promptPrefix ? { promptPrefix } : {})
    }
  },

  mapPermissionProfile: mapCodexPermissionProfile
})

export const codexFramework = createCodexFramework()

export {
  buildCodexConfig,
  codexStorageDir,
  codexSubscriptionStorageDir,
  isOfficialOpenAiResponsesBase,
  mapCodexPermissionProfile,
  normalizeResponsesBaseUrl
}

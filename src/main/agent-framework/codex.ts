import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  PermissionProfileUnavailableError,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { augmentedPathEnv } from '../settings/shell-path'
import type {
  AgentFramework,
  AgentAuthentication,
  AgentProviderConfiguration,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'

const CODEX_PROVIDER_ID = 'open-science'
// Catalog model used only for Codex's local metadata; the Responses bridge rewrites it to the selected
// upstream provider model, so it never appears in the provider UI and does not decide which model
// answers. It MUST be a classic tool-mode entry (tool_mode unset), not a `code_mode_only` model like
// the gpt-5.6-* family: code-mode models advertise no function tools and instead drive an
// OpenAI-hosted code-execution host that a custom Chat Completions gateway cannot provide, so Codex
// sends zero tools and the agent can only chat. gpt-5.5 advertises the `shell_command` function tool,
// which the bridge forwards to Chat Completions. (apply_patch is still a freeform tool the bridge
// filters, so file edits route through shell rather than the dedicated patch tool.)
export const CODEX_BRIDGE_MODEL = 'gpt-5.5'
const CODEX_MODE_IDS = {
  ask: 'read-only',
  auto: 'agent',
  full: 'agent-full-access'
} as const satisfies Record<PermissionProfileId, string>

const CODEX_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_CONFIG',
  'CODEX_HOME',
  'CODEX_PATH',
  'DEFAULT_AUTH_REQUEST',
  'MODEL_PROVIDER',
  'NO_BROWSER'
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

export const codexStorageDir = (storageRoot: string): string => join(storageRoot, 'codex')

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

const buildCodexConfig = (provider: {
  baseUrl?: string
  model?: string
  key?: string
}): Record<string, unknown> => {
  const baseUrl = normalizeResponsesBaseUrl(provider.baseUrl)

  return {
    ...(provider.model ? { model: provider.model } : {}),
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'Open Science',
        wire_api: 'responses',
        ...(baseUrl ? { base_url: baseUrl } : {}),
        ...(provider.key ? { requires_openai_auth: true } : {})
      }
    }
    // Tool-search configuration is intentionally left at Codex defaults. The Chat bridge exposes the
    // app-owned notebook tools through explicit namespaced aliases and does not depend on deferred
    // tool_search behavior.
  }
}

const buildSpawnEnvironment = (
  input: AgentSpawnInput,
  sourceEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env = augmentedPathEnv(sourceEnv)

  for (const key of CODEX_ENV_KEYS) delete env[key]

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
  supportsSkills: true,
  acceptsStdioMcp: true,
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

    return spawnProcess(command, args, {
      env: buildSpawnEnvironment(input, sourceEnv),
      stdio: 'pipe',
      windowsHide: true,
      shell: needsShell
    })
  },

  prepareModelConfig(provider, ctx: ModelConfigContext): AgentModelConfig {
    const bridge = ctx.responsesBridge
    const useBridge =
      bridge !== undefined && !(provider.apiEndpoints?.includes('responses') ?? false)
    const codexModel = useBridge ? CODEX_BRIDGE_MODEL : provider.model
    const authentication: AgentAuthentication | undefined =
      provider.key && !useBridge
        ? {
            methodId: 'api-key',
            _meta: { 'api-key': { apiKey: provider.key } }
          }
        : undefined

    return {
      env: {
        CODEX_HOME: codexStorageDir(ctx.storageRoot),
        CODEX_CONFIG: JSON.stringify(
          buildCodexConfig({
            ...provider,
            model: codexModel,
            baseUrl: bridge?.baseUrl ?? provider.baseUrl,
            key: useBridge ? undefined : provider.key
          })
        ),
        MODEL_PROVIDER: CODEX_PROVIDER_ID,
        NO_BROWSER: '1'
      },
      configFiles: [
        {
          path: join(codexStorageDir(ctx.storageRoot), 'config.toml'),
          content: 'cli_auth_credentials_store = "ephemeral"\n',
          mode: 0o600
        }
      ],
      ...(authentication ? { authentication } : {}),
      ...(useBridge
        ? {
            providerConfiguration: {
              providerId: 'custom-gateway',
              apiType: 'openai',
              baseUrl: bridge.baseUrl,
              headers: { authorization: `Bearer ${bridge.token}` }
            } satisfies AgentProviderConfiguration
          }
        : {}),
      ...(useBridge ? { sessionModel: CODEX_BRIDGE_MODEL } : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    return {
      promptPrefix:
        ctx.systemPromptAppends.length > 0 ? ctx.systemPromptAppends.join('\n\n') : undefined
    }
  },

  mapPermissionProfile: mapCodexPermissionProfile
})

export const codexFramework = createCodexFramework()

export { buildCodexConfig, mapCodexPermissionProfile, normalizeResponsesBaseUrl }

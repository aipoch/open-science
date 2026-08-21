import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { preferredEndpoint } from '../../shared/settings'
import type { ModelReasoningEffort } from '../../shared/reasoning-effort'
import { anthropicMessagesBase, openAiCompletionsBase } from '../settings/base-url'
import { augmentedPathEnv } from '../settings/shell-path'
import type { ResolvedProvider } from '../settings/provider-env'
import { resolveChatReasoningTransport } from '../settings/reasoning-transport'
import type {
  AgentFramework,
  AgentModelCatalogEntry,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import { renderAppMcpToolReferences } from './app-mcp-names'

// opencode speaks ACP over `opencode acp` (stdio JSON-RPC). Only the shapes that differ from Claude
// are implemented here: model config (a generated opencode.json, not ANTHROPIC_* env), system-prompt
// delivery (generated native instructions), and skills (materialized into opencode's
// config dir, which its native skill tool discovers). Everything else reuses the generic runtime.
// See docs/internal/pluggable-agent-framework-feasibility.md.

// opencode is isolated the way Claude uses CLAUDE_CONFIG_DIR: it reads config from
// $XDG_CONFIG_HOME/opencode and auth/data from $XDG_DATA_HOME/opencode. Pointing both at app-owned
// dirs means the app fully owns opencode's config + auth (the app provider is the only credential)
// and the user's own ~/.config/opencode + auth.json are never read or written. Verified: with these
// set, the user's global providers/auth disappear and only the app-injected provider remains.
const opencodeConfigHome = (storageRoot: string): string => join(storageRoot, 'opencode', 'config')
const opencodeDataHome = (storageRoot: string): string => join(storageRoot, 'opencode', 'data')

// The root of opencode's app-owned XDG subtree (both config and data live under here): opencode.json,
// materialized skills, connector instructions, and auth.json. The agent's Read tool must never surface
// it, so the runtime adds this to its protected-read roots.
export const opencodeStorageDir = (storageRoot: string): string => join(storageRoot, 'opencode')

// An app-owned stand-in for opencode's notion of `$HOME`, passed via OPENCODE_TEST_HOME. It is a stable,
// empty-by-design directory so opencode's home `.opencode` config walk finds nothing to load.
const opencodeHomeDir = (storageRoot: string): string =>
  join(opencodeStorageDir(storageRoot), 'home')

// The opencode config directory ($XDG_CONFIG_HOME/opencode) where opencode.json and skills/ live.
// opencode discovers skills at <configDir>/skills/<name>/SKILL.md — the same layout Claude uses under
// its config dir — so the app materializes the enabled skill set here for opencode too.
export const opencodeConfigDir = (storageRoot: string): string =>
  join(opencodeConfigHome(storageRoot), 'opencode')

export const opencodeTransportProviderId = (providerId: string, model: string): string =>
  `open-science-${createHash('sha256')
    .update(JSON.stringify([providerId, model]))
    .digest('hex')
    .slice(0, 16)}`

// The opencode provider block used for each endpoint. Anthropic /v1/messages maps to opencode's
// built-in `anthropic` provider; OpenAI /v1/chat/completions maps to a custom provider backed by the
// `@ai-sdk/openai-compatible` package. opencode drives both, so the endpoint is chosen from the
// provider's apiType (preferring OpenAI when it offers both).
const OPENCODE_ENDPOINT_PROVIDER: Record<'anthropic' | 'openai', { id: string; npm?: string }> = {
  anthropic: { id: 'anthropic' },
  openai: { id: 'openai-compatible', npm: '@ai-sdk/openai-compatible' }
}

// The decrypted provider key is handed to opencode via this spawn-env var and referenced from the
// generated config as `{env:...}` (opencode substitutes env refs at config-load time). This keeps the
// plaintext key OFF disk — opencode.json only ever holds the reference, never the secret.
const OPENCODE_API_KEY_ENV = 'OPENCODE_APP_API_KEY'

// OpenCode rejects a model limit that declares context without output. Keep maxOutputTokens optional
// in the provider model, but reserve a conservative adapter-only output budget when it is absent so
// the generated config remains valid and OpenCode can calculate its native compaction threshold.
const OPENCODE_DEFAULT_OUTPUT_LIMIT = 32_000

const opencodeOutputLimit = (contextWindow: number, configured?: number): number =>
  Math.min(configured ?? OPENCODE_DEFAULT_OUTPUT_LIMIT, contextWindow)

const opencodeApiKeyEnv = (provider: ResolvedProvider): string =>
  provider.agentProviderId
    ? `${OPENCODE_API_KEY_ENV}_${provider.agentProviderId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`
    : OPENCODE_API_KEY_ENV

// The app's permission policy for opencode: every side-effecting/MCP tool must ASK the ACP client (the
// app's broker then enforces the selected profile); safe read-only tools and OpenCode's native skill
// loader run silently (parity with other Agent frameworks). The `*` catch-all covers unlisted tools
// (MCP artifact/notebook/connectors, etc.),
// and the sensitive built-ins are pinned to `ask` explicitly so a lower-precedence config that sets one
// of those keys to `allow` is overridden rather than winning. Enforced via the OPENCODE_CONFIG_CONTENT
// layer (see prepareModelConfig), which also disables project config entirely — the config-file block is
// only a baseline.
const OPENCODE_PERMISSION_RULES: Record<string, 'ask' | 'allow' | 'deny'> = {
  '*': 'ask',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  lsp: 'allow',
  edit: 'ask',
  bash: 'ask',
  // OpenCode's Task tool creates provider-owned subagent Sessions outside the app-owned delegated
  // work graph. Deny it at the highest-precedence config layer: asking is insufficient because an
  // approval would still create an invisible child that bypasses Attempt authority and lifecycle.
  task: 'deny',
  // Skill loading only reads definitions already provisioned into the isolated OpenCode config.
  // Permission for creating/editing/enabling those definitions remains app-owned elsewhere.
  skill: 'allow',
  webfetch: 'ask',
  websearch: 'ask',
  external_directory: 'ask'
}

// OpenCode also permits direct `@agent` invocation independently of Task permission. Disable every
// built-in subagent exposed by supported/current OpenCode releases; external agent discovery is
// already closed by the isolated home plus OPENCODE_DISABLE_PROJECT_CONFIG.
const OPENCODE_DISABLED_NATIVE_AGENTS = {
  general: { disable: true },
  explore: { disable: true },
  scout: { disable: true }
} as const

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// Resolves the app provider's opencode endpoint primitives (provider id, npm package, base URL, model).
// Shared by both the written config file and the OPENCODE_CONFIG_CONTENT layer so the authoritative
// provider/model they pin can never diverge.
const resolveOpencodeEndpoint = (
  provider: ResolvedProvider
): {
  apiKeyEnv: string
  bareModel: string | undefined
  providerId: string
  npm?: string
  baseURL?: string
} => {
  const bareModel = provider.model
  // opencode drives both endpoints; pick the one for this provider (openai wins when it offers both).
  const endpoint =
    preferredEndpoint(provider.apiEndpoints ?? ['anthropic'], ['anthropic', 'openai']) ??
    'anthropic'
  const { id: defaultProviderId, npm } = OPENCODE_ENDPOINT_PROVIDER[endpoint]
  const providerId = provider.agentProviderId ?? defaultProviderId
  // The @ai-sdk/openai-compatible client appends `/chat/completions` to baseURL, so hand it the
  // resolved OpenAI completions base — an official vendor's exact versioned base (GLM's /api/paas/v4,
  // DeepSeek/Kimi /v1), or a custom gateway root normalized to `<root>/v1`. Matches the validator and
  // bridge. The Anthropic AI SDK appends `/messages` (not `/v1/messages`), so its base must carry the
  // `/v1` segment that Claude Code and the validator append themselves.
  const baseURL =
    endpoint === 'openai'
      ? (openAiCompletionsBase(provider) ?? provider.baseUrl)
      : provider.baseUrl
        ? anthropicMessagesBase(provider.baseUrl)
        : undefined

  return { apiKeyEnv: opencodeApiKeyEnv(provider), bareModel, providerId, npm, baseURL }
}

// Current OpenCode accepts the provider-neutral ladder through `reasoningEffort` up to `max`.
// `ultra` is a Codex-specific top rung, so map it to OpenCode's highest transport value rather than
// dropping the user's explicit top-effort selection and falling back to the provider default.
// Provider-specific wire shapes (thinking switches and OpenRouter's reasoning object) are resolved
// separately and passed through model options by the openai-compatible AI SDK.
const opencodeReasoningOptions = (
  provider: ResolvedProvider,
  effort: ModelReasoningEffort
): Record<string, unknown> => {
  const transportEffort = effort === 'ultra' ? 'max' : effort
  const transport = resolveChatReasoningTransport(
    provider.vendorId,
    provider.model,
    transportEffort,
    provider.reasoningEffortTransport
  )

  return {
    ...(transport.reasoningEffort ? { reasoningEffort: transport.reasoningEffort } : {}),
    ...(transport.thinking ? { thinking: transport.thinking } : {}),
    ...(transport.reasoning ? { reasoning: transport.reasoning } : {})
  }
}

// The opencode per-model capability block. opencode strips image parts before calling the provider for
// any model whose config does not declare vision — custom and freshly-registered models default to
// text-only — so a base64 image sent over ACP silently never reaches the provider. A multimodal model
// must therefore advertise both the attachment capability and an image input modality. Empty (text-only)
// otherwise, so a non-vision model is never told it can accept images. Reasoning preferences are
// declared in the model's `options` block, which OpenCode passes through to the AI SDK provider.
const buildModelCapabilities = (
  provider: ResolvedProvider,
  reasoningEffort?: ModelReasoningEffort
): Record<string, unknown> => {
  return {
    ...(provider.supportsImageInput
      ? { attachment: true, modalities: { input: ['text', 'image'] } }
      : {}),
    ...(reasoningEffort ? { options: opencodeReasoningOptions(provider, reasoningEffort) } : {})
  }
}

const opencodeModelCatalog = (
  provider: ResolvedProvider,
  reasoningEffort: ModelReasoningEffort | undefined,
  catalog: readonly AgentModelCatalogEntry[] = []
): AgentModelCatalogEntry[] => {
  const active: AgentModelCatalogEntry = { provider, reasoningEffort }
  const providerId = resolveOpencodeEndpoint(provider).providerId
  const models = new Map<string, AgentModelCatalogEntry>()
  for (const entry of [...catalog, active]) {
    const endpoint = resolveOpencodeEndpoint(entry.provider)
    if (
      !endpoint.bareModel ||
      (!entry.provider.agentProviderId && endpoint.providerId !== providerId)
    ) {
      continue
    }
    models.set(`${endpoint.providerId}/${endpoint.bareModel}`, entry)
  }
  return [...models.values()]
}

const buildOpencodeModelConfig = (
  provider: ResolvedProvider,
  reasoningEffort: ModelReasoningEffort | undefined,
  baseModel: Record<string, unknown> = {}
): Record<string, unknown> => {
  const baseModelWithoutLimit = { ...baseModel }
  delete baseModelWithoutLimit.limit
  const modelCapabilities = buildModelCapabilities(provider, reasoningEffort)
  return {
    ...baseModelWithoutLimit,
    ...modelCapabilities,
    ...(modelCapabilities.options
      ? {
          options: {
            ...asRecord(baseModel.options),
            ...asRecord(modelCapabilities.options)
          }
        }
      : {}),
    ...(provider.contextWindow === undefined
      ? {}
      : {
          limit: {
            context: provider.contextWindow,
            ...(provider.maxInputTokens === undefined ? {} : { input: provider.maxInputTokens }),
            output: opencodeOutputLimit(provider.contextWindow, provider.maxOutputTokens)
          }
        })
  }
}

const buildOpencodeProviders = (
  provider: ResolvedProvider,
  reasoningEffort: ModelReasoningEffort | undefined,
  catalog: readonly AgentModelCatalogEntry[],
  baseProviders: Record<string, unknown> = {}
): Record<string, unknown> => {
  const providers: Record<string, unknown> = { ...baseProviders }
  for (const entry of opencodeModelCatalog(provider, reasoningEffort, catalog)) {
    const { apiKeyEnv, bareModel, providerId, npm, baseURL } = resolveOpencodeEndpoint(
      entry.provider
    )
    if (!bareModel) continue
    const baseProvider = asRecord(baseProviders[providerId])
    const currentProvider = asRecord(providers[providerId])
    const baseOptions = asRecord(baseProvider.options)
    const baseModels = asRecord(baseProvider.models)
    const currentModels = asRecord(currentProvider.models)
    providers[providerId] = {
      ...baseProvider,
      ...currentProvider,
      ...(npm ? { npm } : {}),
      options: {
        ...baseOptions,
        ...asRecord(currentProvider.options),
        ...(baseURL ? { baseURL } : {}),
        ...(entry.provider.key ? { apiKey: `{env:${apiKeyEnv}}` } : {})
      },
      models: {
        ...baseModels,
        ...currentModels,
        [bareModel]: buildOpencodeModelConfig(
          entry.provider,
          entry.reasoningEffort,
          asRecord(currentModels[bareModel] ?? baseModels[bareModel])
        )
      }
    }
  }
  const active = resolveOpencodeEndpoint(provider)
  if (!Object.hasOwn(providers, active.providerId)) {
    const baseProvider = asRecord(baseProviders[active.providerId])
    providers[active.providerId] = {
      ...baseProvider,
      ...(active.npm ? { npm: active.npm } : {}),
      options: {
        ...asRecord(baseProvider.options),
        ...(active.baseURL ? { baseURL: active.baseURL } : {}),
        ...(provider.key ? { apiKey: `{env:${active.apiKeyEnv}}` } : {})
      }
    }
  }
  return providers
}

// The app-authoritative config layer (model + provider block + permission policy) passed verbatim to
// opencode via OPENCODE_CONFIG_CONTENT, which opencode deep-merges ABOVE both the app-owned global config
// and any project config. Pinning the provider/model/baseURL here (not just permission) means a
// lower-precedence config — e.g. the user's own ~/.opencode — cannot repoint the active provider's
// baseURL or switch the model to an attacker-defined provider while inheriting the app's key ref, so the
// real key can only ever go to the app's own endpoint. The key stays an env reference, never plaintext.
const buildAppConfigContent = (
  provider: ResolvedProvider,
  reasoningEffort?: ModelReasoningEffort,
  catalog: readonly AgentModelCatalogEntry[] = []
): Record<string, unknown> => {
  const { bareModel, providerId } = resolveOpencodeEndpoint(provider)

  return {
    ...(bareModel ? { model: `${providerId}/${bareModel}` } : {}),
    permission: { ...OPENCODE_PERMISSION_RULES },
    agent: { ...OPENCODE_DISABLED_NATIVE_AGENTS },
    provider: buildOpencodeProviders(provider, reasoningEffort, catalog)
  }
}

// Builds opencode's config by MERGING the app's active provider/model onto the user's existing config
// so their own providers, mcp servers, and auth are preserved. The model is both selected (top-level
// `model`) and registered under the provider's `models` map — without the registration opencode does
// not recognize a non-catalog model id (e.g. a custom gateway's `deepseek-v4-pro`) and silently falls
// back to its own default. Verified against opencode 1.17.13.
const buildOpencodeConfig = (
  provider: ResolvedProvider,
  baseConfig: Record<string, unknown> = {},
  instructionPaths: string[] = [],
  reasoningEffort?: ModelReasoningEffort,
  catalog: readonly AgentModelCatalogEntry[] = []
): string => {
  const { bareModel, providerId } = resolveOpencodeEndpoint(provider)

  const baseProviders = asRecord(baseConfig.provider)
  const basePermission = asRecord(baseConfig.permission)
  // Preserve any instructions the base config already declared, then append ours (de-duplicated).
  const baseInstructions = Array.isArray(baseConfig.instructions)
    ? baseConfig.instructions.filter((entry): entry is string => typeof entry === 'string')
    : []
  const instructions = [...new Set([...baseInstructions, ...instructionPaths])]

  const merged: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    ...baseConfig,
    ...(bareModel ? { model: `${providerId}/${bareModel}` } : {}),
    ...(instructions.length > 0 ? { instructions } : {}),
    // Baseline permission policy written into the app-owned (global) config file. The authoritative
    // copy of these rules — plus the provider/model pin — is passed via the OPENCODE_CONFIG_CONTENT layer
    // in prepareModelConfig, which opencode merges at highest precedence AND which disables project
    // config loading, so a repo can no longer override this. See OPENCODE_PERMISSION_RULES for rationale.
    permission: {
      ...basePermission,
      ...OPENCODE_PERMISSION_RULES
    },
    agent: {
      ...asRecord(baseConfig.agent),
      ...OPENCODE_DISABLED_NATIVE_AGENTS
    },
    provider: buildOpencodeProviders(provider, reasoningEffort, catalog, baseProviders)
  }

  return JSON.stringify(merged, null, 2)
}

export { buildOpencodeConfig }

export const opencodeFramework: AgentFramework = {
  id: 'opencode',
  displayName: 'OpenCode',
  // OpenCode owns automatic compaction using its resolved model limits. Keep the native command for
  // manual compaction, but do not race it with a second host-owned percentage threshold.
  contextCompaction: { kind: 'native-command', command: '/compact' },
  // opencode discovers skills natively at <configDir>/skills/<name>/SKILL.md (same layout as Claude),
  // loaded on-demand via its skill tool; the app materializes the enabled set into the isolated config.
  supportsSkills: true,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('opencode'),
  // opencode accepts stdio MCP servers over ACP (verified live vs 1.17.13: it launches a stdio server
  // and sends it the MCP initialize handshake). Its mcpCapabilities advertise only http/sse because
  // ACP has no stdio flag — stdio is the baseline transport. So opencode uses the SAME stdio artifact/
  // notebook config as Claude; the http MCP host stays in the runtime but no framework needs it.
  acceptsStdioMcp: true,
  // opencode's ACP server advertises no thought_level option (verified live) — effort only rides the
  // generated config's per-model options, so a change must respawn to take effect.
  supportsLiveEffortChange: false,
  // opencode speaks both Anthropic /v1/messages and OpenAI /v1/chat/completions.
  supportedApiTypes: ['anthropic', 'openai'],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // `opencode acp` starts the ACP subprocess over stdio, matching the app's existing transport. On
    // Windows an npm-installed opencode is a `opencode.cmd`/`.bat` shim that Node cannot launch without
    // a shell (spawn EINVAL, same as Claude's cli.js shim), so those go through the shell with the
    // path quoted; a native `.exe`/Unix binary spawns directly.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(input.executablePath)

    return spawn(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      ['acp', ...input.args],
      {
        env: { ...augmentedPathEnv(process.env), ...input.env },
        stdio: 'pipe',
        windowsHide: true,
        shell: needsShell
      }
    )
  },

  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig {
    // Isolate opencode via app-owned XDG dirs (mirror of CLAUDE_CONFIG_DIR): opencode reads its config
    // from $XDG_CONFIG_HOME/opencode and auth/data from $XDG_DATA_HOME/opencode. We own the whole
    // config here, so the app provider/model is written clean (no merge with the user's global config).
    const configHome = opencodeConfigHome(ctx.storageRoot)
    const dataHome = opencodeDataHome(ctx.storageRoot)
    const opencodeDir = join(configHome, 'opencode')
    const configPath = join(opencodeDir, 'opencode.json')
    const configFiles = [{ path: configPath, content: '' }]

    // Stable app guidance belongs in OpenCode's native instructions layer, never ordinary user prompt
    // history. Keep connector conventions separate so their independent lifecycle remains explicit;
    // both absolute paths are backend-scoped and independent of the session cwd.
    const instructionPaths: string[] = []
    const persistentInstructions: string[] = []
    if (ctx.systemPromptAppends?.length) {
      const instructions = ctx.systemPromptAppends
        .map((append) => renderAppMcpToolReferences('opencode', append))
        .filter(Boolean)
        .join('\n\n')
      if (instructions) {
        const instructionsPath = join(opencodeDir, 'instructions', 'open-science.md')
        instructionPaths.push(instructionsPath)
        persistentInstructions.push(instructions)
        configFiles.push({ path: instructionsPath, content: instructions })
      }
    }
    if (ctx.instructions) {
      const instructionsPath = join(opencodeDir, 'instructions', 'connectors.md')
      instructionPaths.push(instructionsPath)
      persistentInstructions.push(ctx.instructions)
      configFiles.push({ path: instructionsPath, content: ctx.instructions })
    }

    configFiles[0].content = buildOpencodeConfig(
      provider,
      {},
      instructionPaths,
      ctx.reasoningEffort,
      ctx.providerModelCatalog
    )

    return {
      env: {
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        // Redirect opencode's Global.Path.home (= `OPENCODE_TEST_HOME ?? os.homedir()`) to an app-owned,
        // empty dir so the user's `~/.opencode` cannot inject config/providers/permissions — the last
        // non-repo override surface left after OPENCODE_DISABLE_PROJECT_CONFIG closes project config. This
        // changes ONLY opencode's notion of home; the child's real HOME is untouched, so shell/git tools
        // behave normally. The explicit skill flags below enforce the skill boundary independently.
        OPENCODE_TEST_HOME: opencodeHomeDir(ctx.storageRoot),
        // OpenCode discovers `skills/**/SKILL.md` under both `.agents` and `.claude`, walking from the
        // session cwd to the worktree root AND scanning those directories under its notion of home.
        // OPENCODE_DISABLE_PROJECT_CONFIG does not cover this separate discovery path. Disable external
        // discovery at the source so only the skills the app materialized into the isolated XDG config
        // are advertised. Keep the narrower Claude flag explicit as defense in depth for that source.
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
        // Refuse to load ANY project config: this stops the session cwd's opencode.json / opencode.jsonc
        // (walked up to the worktree root) and its .opencode/ directory from injecting config at all. A
        // repo therefore cannot flip permission["*"] to "allow", add an exact-id "allow" rule for an MCP
        // tool that would beat "*":"ask", or repoint the provider's baseURL to exfiltrate the app key —
        // the whole project-config surface is closed at the source, not patched rule-by-rule.
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        // Pin the app's authoritative provider/model/baseURL + permission policy as the high-priority
        // layer opencode merges above the global XDG config (and, since project config is disabled above,
        // this is the top layer). Pinning provider/model here — not just permission — is defense-in-depth
        // against the only remaining non-repo surface, the user's own ~/.opencode: it cannot repoint the
        // active provider's baseURL or swap the model to an attacker provider while inheriting the app's
        // `{env:...}` key ref. The key itself never rides this layer, only its env reference.
        OPENCODE_CONFIG_CONTENT: JSON.stringify(
          buildAppConfigContent(provider, ctx.reasoningEffort, ctx.providerModelCatalog)
        ),
        // Pass credentials only through referenced environment values. Generation-local transport
        // routes use distinct variables so late OpenCode background work cannot inherit a new route.
        ...Object.fromEntries(
          opencodeModelCatalog(provider, ctx.reasoningEffort, ctx.providerModelCatalog).flatMap(
            (entry) =>
              entry.provider.key
                ? [[opencodeApiKeyEnv(entry.provider), entry.provider.key] as const]
                : []
          )
        )
      },
      configFiles,
      ...(provider.agentProviderId && provider.model
        ? { sessionModel: `${provider.agentProviderId}/${provider.model}` }
        : {}),
      ...(persistentInstructions.length > 0
        ? { persistentSystemPrompt: persistentInstructions.join('\n\n') }
        : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // Production backends pass no stable appends here because they are already installed in native
    // instructions. Retain the append fallback for injected/legacy backends and ephemeral reviewers.
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .map((append) => renderAppMcpToolReferences('opencode', append))
      .filter(Boolean)
      .join('\n\n')
    return {
      ...(promptPrefix ? { promptPrefix } : {})
    }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    // opencode advertises `build`/`plan` modes, not Claude's `default`/`bypassPermissions`, so no mode
    // is set here — the app owns permission decisions instead. prepareModelConfig configures opencode
    // to delegate every edit/bash/webfetch prompt to the client (see buildOpencodeConfig), so the broker
    // enforces ask/auto/full app-side. That's why Full access is offered even without a native bypass.
    return resolvePermissionProfileApplication(profile, modes, { brokerEnforcesFullAccess: true })
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { preferredEndpoint } from '../../shared/settings'
import type { ReasoningEffort } from '../../shared/settings'
import { openAiCompletionsBase } from '../settings/base-url'
import { augmentedPathEnv } from '../settings/shell-path'
import type { ResolvedProvider } from '../settings/provider-env'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'

// opencode speaks ACP over `opencode acp` (stdio JSON-RPC). Only the shapes that differ from Claude
// are implemented here: model config (a generated opencode.json, not ANTHROPIC_* env), system-prompt
// delivery (a prompt prefix, since opencode has no preset), and skills (materialized into opencode's
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

// The app's permission policy for opencode: every side-effecting/MCP tool must ASK the ACP client (the
// app's broker then enforces the selected profile); only safe read-only tools run silently (parity with
// Claude's Ask mode). The `*` catch-all covers unlisted tools (MCP artifact/notebook/connectors, etc.),
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
  task: 'ask',
  skill: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  external_directory: 'ask'
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// Resolves the app provider's opencode endpoint primitives (provider id, npm package, base URL, model).
// Shared by both the written config file and the OPENCODE_CONFIG_CONTENT layer so the authoritative
// provider/model they pin can never diverge.
const resolveOpencodeEndpoint = (
  provider: ResolvedProvider
): { bareModel: string | undefined; providerId: string; npm?: string; baseURL?: string } => {
  const bareModel = provider.model
  // opencode drives both endpoints; pick the one for this provider (openai wins when it offers both).
  const endpoint =
    preferredEndpoint(provider.apiEndpoints ?? ['anthropic'], ['anthropic', 'openai']) ??
    'anthropic'
  const { id: providerId, npm } = OPENCODE_ENDPOINT_PROVIDER[endpoint]
  // The @ai-sdk/openai-compatible client appends `/chat/completions` to baseURL, so hand it the
  // resolved OpenAI completions base — an official vendor's exact versioned base (GLM's /api/paas/v4,
  // DeepSeek/Kimi /v1), or a custom gateway root normalized to `<root>/v1`. Matches the validator and
  // bridge. The anthropic endpoint keeps the provider's own baseUrl.
  const baseURL =
    endpoint === 'openai' ? (openAiCompletionsBase(provider) ?? provider.baseUrl) : provider.baseUrl

  return { bareModel, providerId, npm, baseURL }
}

// The opencode per-model capability block. opencode strips image parts before calling the provider for
// any model whose config does not declare vision — custom and freshly-registered models default to
// text-only — so a base64 image sent over ACP silently never reaches the provider. A multimodal model
// must therefore advertise both the attachment capability and an image input modality. Empty (text-only)
// otherwise, so a non-vision model is never told it can accept images. A reasoning-effort preference is
// declared via the model's `options.reasoningEffort`, opencode's per-model knob passed through to the
// AI SDK provider; providers that don't support it ignore the option.
const buildModelCapabilities = (
  provider: ResolvedProvider,
  reasoningEffort?: ReasoningEffort
): Record<string, unknown> => ({
  ...(provider.supportsImageInput
    ? { attachment: true, modalities: { input: ['text', 'image'] } }
    : {}),
  ...(reasoningEffort ? { options: { reasoningEffort: clampOpencodeEffort(reasoningEffort) } } : {})
})

// opencode's reasoningEffort follows the AI SDK levels, which top out at 'high'; the app's top level
// 'max' clamps down to it. 'default' is filtered upstream and never reaches here.
const clampOpencodeEffort = (effort: ReasoningEffort): 'low' | 'medium' | 'high' =>
  effort === 'low' || effort === 'medium' ? effort : 'high'

// The app-authoritative config layer (model + provider block + permission policy) passed verbatim to
// opencode via OPENCODE_CONFIG_CONTENT, which opencode deep-merges ABOVE both the app-owned global config
// and any project config. Pinning the provider/model/baseURL here (not just permission) means a
// lower-precedence config — e.g. the user's own ~/.opencode — cannot repoint the active provider's
// baseURL or switch the model to an attacker-defined provider while inheriting the app's key ref, so the
// real key can only ever go to the app's own endpoint. The key stays an env reference, never plaintext.
const buildAppConfigContent = (
  provider: ResolvedProvider,
  reasoningEffort?: ReasoningEffort
): Record<string, unknown> => {
  const { bareModel, providerId, npm, baseURL } = resolveOpencodeEndpoint(provider)

  return {
    ...(bareModel ? { model: `${providerId}/${bareModel}` } : {}),
    permission: { ...OPENCODE_PERMISSION_RULES },
    provider: {
      [providerId]: {
        ...(npm ? { npm } : {}),
        options: {
          ...(baseURL ? { baseURL } : {}),
          ...(provider.key ? { apiKey: `{env:${OPENCODE_API_KEY_ENV}}` } : {})
        },
        ...(bareModel
          ? { models: { [bareModel]: buildModelCapabilities(provider, reasoningEffort) } }
          : {})
      }
    }
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
  reasoningEffort?: ReasoningEffort
): string => {
  const { bareModel, providerId, npm, baseURL } = resolveOpencodeEndpoint(provider)

  const baseProviders = asRecord(baseConfig.provider)
  const baseProvider = asRecord(baseProviders[providerId])
  const baseOptions = asRecord(baseProvider.options)
  const baseModels = asRecord(baseProvider.models)
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
    provider: {
      ...baseProviders,
      [providerId]: {
        ...baseProvider,
        // A custom (openai-compatible) provider needs its npm package declared; anthropic is built-in.
        ...(npm ? { npm } : {}),
        options: {
          ...baseOptions,
          ...(baseURL ? { baseURL } : {}),
          // Reference the key via env interpolation; the real value is passed in the spawn env only,
          // so the decrypted key is never persisted to opencode.json (see prepareModelConfig).
          ...(provider.key ? { apiKey: `{env:${OPENCODE_API_KEY_ENV}}` } : {})
        },
        // Register the model so opencode treats a non-catalog id as a real, selectable model, declaring
        // its image capability when the active model is multimodal (else opencode strips image parts).
        ...(bareModel
          ? {
              models: {
                ...baseModels,
                [bareModel]: buildModelCapabilities(provider, reasoningEffort)
              }
            }
          : {})
      }
    }
  }

  return JSON.stringify(merged, null, 2)
}

export { buildOpencodeConfig }

export const opencodeFramework: AgentFramework = {
  id: 'opencode',
  displayName: 'OpenCode',
  // opencode discovers skills natively at <configDir>/skills/<name>/SKILL.md (same layout as Claude),
  // loaded on-demand via its skill tool; the app materializes the enabled set into the isolated config.
  supportsSkills: true,
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

    // Connector conventions + tools, wired via opencode's `instructions` config so the agent uses
    // host.mcp instead of raw HTTP. Absolute path keeps it independent of the session cwd.
    const instructionPaths: string[] = []
    if (ctx.instructions) {
      const instructionsPath = join(opencodeDir, 'instructions', 'connectors.md')
      instructionPaths.push(instructionsPath)
      configFiles.push({ path: instructionsPath, content: ctx.instructions })
    }

    configFiles[0].content = buildOpencodeConfig(
      provider,
      {},
      instructionPaths,
      ctx.reasoningEffort
    )

    return {
      env: {
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        // Redirect opencode's Global.Path.home (= `OPENCODE_TEST_HOME ?? os.homedir()`) to an app-owned,
        // empty dir so the user's `~/.opencode` cannot inject config/providers/permissions — the last
        // non-repo override surface left after OPENCODE_DISABLE_PROJECT_CONFIG closes project config. This
        // changes ONLY opencode's notion of home; the child's real HOME is untouched, so shell/git tools
        // behave normally. Tradeoff: opencode also won't read `~/.claude/CLAUDE.md` or home-level skills —
        // acceptable since the app owns the whole opencode config.
        OPENCODE_TEST_HOME: opencodeHomeDir(ctx.storageRoot),
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
          buildAppConfigContent(provider, ctx.reasoningEffort)
        ),
        // Pass the decrypted key ONLY via the environment; the config references it as `{env:...}`.
        ...(provider.key ? { [OPENCODE_API_KEY_ENV]: provider.key } : {})
      },
      configFiles
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // No claude_code preset here; deliver appends as a prompt prefix instead of session meta.
    return {
      promptPrefix:
        ctx.systemPromptAppends.length > 0 ? ctx.systemPromptAppends.join('\n\n') : undefined
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

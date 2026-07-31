import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { isCursorSubscriptionProvider } from '../../shared/settings'
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
import { renderAppMcpToolReferences } from './app-mcp-names'

// Cursor Agent speaks ACP over `agent acp` (stdio JSON-RPC). Auth uses the user's existing
// `agent login` via ACP `authenticate({ methodId: 'cursor_login' })`. Cursor advertises only
// http/sse MCP capabilities, so the runtime serves app tooling over the local HTTP MCP host
// (`acceptsStdioMcp: false`). See https://cursor.com/docs/cli/acp.

export const cursorStorageDir = (storageRoot: string): string => join(storageRoot, 'cursor')

// Cursor's native session modes map cleanly onto the app's three permission profiles.
const CURSOR_MODE_IDS = {
  ask: 'ask',
  auto: 'agent',
  full: 'agent'
} as const satisfies Record<PermissionProfileId, string>

export const cursorFramework: AgentFramework = {
  id: 'cursor',
  displayName: 'Cursor Agent',
  // Cursor manages its own context window; no host-driven /compact command is advertised.
  contextCompaction: { kind: 'framework-managed' },
  // Skills materialization is intentionally off for the first Cursor backend — Cursor has its own
  // skill discovery under the user profile, and app-owned skill roots are a later follow-up.
  supportsSkills: false,
  // Verified against Cursor Agent 2026.07.23: mcpCapabilities advertise only http/sse. Stdio MCP
  // configs are rejected at session/new. The runtime HTTP MCP host covers artifacts/notebook.
  acceptsStdioMcp: false,
  // Effort is baked into Cursor model variant ids; there is no live thought_level configOption.
  supportsLiveEffortChange: false,
  // Cursor is a closed routing gateway — it does not consume Anthropic/OpenAI endpoints from the app.
  // Compatibility is enforced via the cursor-subscription provider type instead.
  supportedApiTypes: [],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // `agent acp` starts the ACP subprocess over stdio. On Windows the install is an `agent.cmd`/
    // `.bat` shim that Node cannot launch without a shell (spawn EINVAL), so those go through the
    // shell with the path quoted; a native `.exe`/Unix binary spawns directly.
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
    // Cursor subscription auth lives in the CLI profile. The ACP authenticate step reuses it; no
    // API key is written to disk or the child environment. Non-subscription providers should never
    // reach this path (isProviderUsableByFramework rejects them).
    void ctx
    if (!isCursorSubscriptionProvider(provider.type)) {
      return {}
    }

    return {
      authentication: { methodId: 'cursor_login' },
      // Prefer an explicit app selection when present; otherwise Cursor keeps its account default.
      ...(provider.model ? { sessionModel: provider.model } : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // Cursor has no Claude-style session meta preset; deliver appends as a prompt prefix.
    return {
      promptPrefix:
        ctx.systemPromptAppends.length > 0
          ? ctx.systemPromptAppends
              .map((append) => renderAppMcpToolReferences('cursor', append))
              .join('\n\n')
          : undefined
    }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    // Prefer Cursor's native agent/ask modes when advertised. Full access still relies on the
    // broker auto-approving permission prompts (Cursor has no bypassPermissions mode).
    const application = resolvePermissionProfileApplication(profile, modes, {
      brokerEnforcesFullAccess: true
    })
    const preferredMode = CURSOR_MODE_IDS[profile]
    const modeIds = modes?.availableModes.map((mode) => mode.id) ?? []
    const modeId = modeIds.includes(preferredMode) ? preferredMode : application.modeId

    return {
      ...application,
      modeId,
      state: {
        ...application.state,
        currentModeId: modeId ?? application.state.currentModeId
      }
    }
  }
}

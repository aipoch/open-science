import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

// Resolves the packaged Claude ACP agent entry through Node's module resolver. This is a JS entry
// executed by Electron-as-Node, not the native claude binary, so it stays bundled with the app.
const resolveClaudeAgentAcpEntry = (): string =>
  nodeRequire.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')

// Converts Electron's asar virtual path to the real unpacked location for executable files.
const toUnpackedAsarPath = (filePath: string): string =>
  filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')

// Env vars carrying an Anthropic endpoint/credentials/model that an isolated provider must not inherit.
const ANTHROPIC_ENV_PREFIX = 'ANTHROPIC_'

// Builds the environment for the ACP agent child process. For an isolated (custom) provider —
// signalled by an isolated CLAUDE_CONFIG_DIR among the overrides — inherited ANTHROPIC_* variables are
// dropped before the provider's own overrides are applied. This keeps the parent's global endpoint or
// credentials (e.g. a shell `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or a proxy `ANTHROPIC_AUTH_TOKEN`)
// from leaking into a provider that is meant to be fully self-contained; only what the provider sets
// remains. claude-default (no isolated config dir) keeps the inherited env so it reuses the user's setup.
const buildAgentSpawnEnv = (
  sourceEnv: NodeJS.ProcessEnv,
  envOverrides: Record<string, string>,
  executablePath: string
): NodeJS.ProcessEnv => {
  const isolated = 'CLAUDE_CONFIG_DIR' in envOverrides
  const base: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (isolated && key.startsWith(ANTHROPIC_ENV_PREFIX)) continue
    base[key] = value
  }

  return {
    ...base,
    ...envOverrides,
    CLAUDE_CODE_EXECUTABLE: executablePath,
    ELECTRON_RUN_AS_NODE: '1'
  }
}

// Spawn configuration for the ACP agent. `executablePath` is the system-installed claude resolved by
// detection; `envOverrides` carries the active provider's credentials/model. The app no longer ships
// a bundled claude binary, so a missing executablePath is a hard, actionable error.
export type SpawnClaudeAgentAcpOptions = {
  envOverrides?: Record<string, string>
  executablePath?: string
  // For an isolated (custom) provider, the Claude Code settings scopes the session should load. When
  // set to ["user"], the user's global ~/.claude project/local settings (which may carry a proxy
  // ANTHROPIC_BASE_URL env block) are excluded so they can't override the injected provider endpoint.
  // Consumed by the runtime when building session `_meta`, not by the spawn itself.
  settingSources?: readonly string[]
}

// Starts the Claude ACP agent as a child process with pipe-based IO, injecting the active provider's
// environment and pointing CLAUDE_CODE_EXECUTABLE at the detected system claude.
const spawnClaudeAgentAcp = ({
  envOverrides = {},
  executablePath
}: SpawnClaudeAgentAcpOptions = {}): ChildProcessWithoutNullStreams => {
  if (!executablePath) {
    throw new Error(
      'Claude executable path is not configured. Complete Claude detection in settings first.'
    )
  }

  // Electron is the Node runtime available after packaging; this keeps dev and packaged paths aligned.
  return spawn(process.execPath, [resolveClaudeAgentAcpEntry()], {
    env: buildAgentSpawnEnv(process.env, envOverrides, executablePath),
    stdio: 'pipe',
    windowsHide: true
  })
}

export {
  buildAgentSpawnEnv,
  resolveClaudeAgentAcpEntry,
  spawnClaudeAgentAcp,
  toUnpackedAsarPath
}

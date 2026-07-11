import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { createLogger } from '../logger'
import { augmentedPathEnv } from '../settings/shell-path'
import { resolveClaudeExecutableForSpawn } from './claude-executable'

const nodeRequire = createRequire(import.meta.url)
const log = createLogger('agent')

// Resolves the packaged Claude ACP agent entry through Node's module resolver. This is a JS entry
// executed by Electron-as-Node, not the native claude binary, so it stays bundled with the app.
const resolveClaudeAgentAcpEntry = (): string =>
  nodeRequire.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')

// Converts Electron's asar virtual path to the real unpacked location for executable files.
const toUnpackedAsarPath = (filePath: string): string =>
  filePath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2')

// Env vars carrying an Anthropic endpoint/credentials/model that an isolated provider must not inherit.
const ANTHROPIC_ENV_PREFIX = 'ANTHROPIC_'

// Builds the environment for the ACP agent child process. Every provider now runs under an app-owned
// CLAUDE_CONFIG_DIR (present in envOverrides), so inherited ANTHROPIC_* variables are dropped before the
// provider's own overrides are applied. This keeps a stray shell `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`
// /`ANTHROPIC_AUTH_TOKEN` from leaking into the run; only what the provider sets (custom gateways) or the
// app dir's stored auth (local) is used.
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
  // PATH is augmented with common CLI locations so a Finder-launched (packaged) app — whose PATH omits
  // Homebrew/user bins — can still run claude and the tools it shells out to, instead of hanging.
  const entryPath = resolveClaudeAgentAcpEntry()
  // On Windows, a `claude.cmd` shim can't be spawned by the SDK without a shell (spawn EINVAL); resolve
  // it to the underlying cli.js so the SDK runs it via node. Native/Unix executables pass through.
  const resolvedExecutablePath = resolveClaudeExecutableForSpawn(executablePath)
  const env = buildAgentSpawnEnv(
    augmentedPathEnv(process.env),
    envOverrides,
    resolvedExecutablePath
  )

  // Opt-in deep diagnostics: launch the app with OPEN_SCIENCE_DEBUG_AGENT=1 to make the Claude Agent
  // SDK emit its internals to stderr (captured into the log). Off by default so verbose turn detail is
  // never written to disk without the user explicitly asking for it.
  const debugAgent = process.env.OPEN_SCIENCE_DEBUG_AGENT === '1'

  if (debugAgent) {
    env.DEBUG_CLAUDE_AGENT_SDK = '1'
  }

  log.info('spawning ACP agent', {
    executablePath: resolvedExecutablePath,
    rawExecutablePath: executablePath,
    entryPath,
    isolated: 'CLAUDE_CONFIG_DIR' in envOverrides,
    debug: debugAgent,
    // Endpoint/model are not secret and pinpoint routing bugs; the token is never logged.
    baseUrl: env.ANTHROPIC_BASE_URL,
    model: env.ANTHROPIC_MODEL,
    configDir: env.CLAUDE_CONFIG_DIR,
    // PATH is not secret; provider credentials are never logged.
    path: env.PATH
  })

  const child = spawn(process.execPath, [entryPath], {
    env,
    stdio: 'pipe',
    windowsHide: true
  })

  child.on('error', (error) => log.error('ACP agent process error', error))
  child.on('exit', (code, signal) => log.info('ACP agent process exited', { code, signal }))

  return child
}

export { buildAgentSpawnEnv, resolveClaudeAgentAcpEntry, spawnClaudeAgentAcp, toUnpackedAsarPath }

#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { randomUUID } from 'node:crypto'
import { closeSync, createWriteStream, openSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { findServiceState, readWebToken, resolveConfigRoot, STATE_FILE } from './config-root.mjs'
import { codexLoginCommand } from './codex-login.mjs'
import { connectToOpenScience, OpenScienceApiError } from './index.mjs'
import { locateApp } from './locate-app.mjs'

const DEFAULT_PORT = 44100
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 15_000
const UPDATE_REQUEST_TIMEOUT_MS = 60 * 60 * 1_000
const UPDATE_CLI_RPC_CAPABILITY = 'update-cli-v1'
const UPDATE_BLOCKED_EXIT_CODE = 5
const UPDATE_MANUAL_ACTION_EXIT_CODE = 6
const MAX_DOWNLOAD_SYMLINK_HOPS = 40

const usage = `Usage: open-science <command> [options]

Commands:
  start       Start the headless backend and localhost web UI
  stop        Gracefully stop the backend
  status      Show backend status
  url         Print the authenticated web URL
  update      Check, download, and apply an application update
  codex login [--force]
  project list
  project create <name> [--description <text>] [--agent-context <text> | --agent-context-file <path>]
  project update <id-or-name> [--name <name>] [--description <text>] [--agent-context <text> | --agent-context-file <path> | --clear-agent-context]
  project session-defaults show <id-or-name>
  project session-defaults update <id-or-name> [session options]
  run --project <id-or-name> (--prompt <text> | --prompt-file <path>) [--compute-host <provider-id>] [--wait]
  run status <run-id>
  run cancel <run-id>
  session status <session-id>
  session config show <session-id>
  session config update <session-id> --revision <number> [session options]
  settings agent-routing show
  settings agent-routing update [routing options]
  plan show <session-id>
  plan approve <session-id> --artifact-version <id> --revision <number>
  plan reject <session-id> --artifact-version <id> --revision <number>
  plan revise <session-id> --feedback <text>
  artifacts list <session-id>
  artifacts download <artifact-id> --output <path>
  rollback-to-0.7.3 --yes [--output <path>]

Options:
  --port <port>          Web service port (default: 44100)
  --app-path <path>      Installed Open Science executable
  --config-root <path>   Config directory override
  --data-root <path>     Current Data Root override (rollback only)
  --project <id-or-name> Project id or exact name
  --session <id>         Resume an existing session
  --cwd <path>           Working directory for a new or matching existing session
  --prompt <text>        Prompt text (or read stdin when omitted)
  --prompt-file <path>   Read the prompt from a UTF-8 file
  --agent-context <text> Persistent Project Agent Context
  --agent-context-file <path>  Read Project Agent Context from a UTF-8 file
  --clear-agent-context  Clear a Project's persistent Agent Context
  --approval-profile <profile>  ask, auto, or full (default: ask)
  --provider <provider-id>  Configured Main provider
  --model <model-id>       Main model
  --provider-default-model Use the provider-owned default model
  --reasoning-effort <effort>  default, low, medium, high, xhigh, or max
  --skill <id>           Force-load a skill for this run (repeatable)
  --compute-host <provider-id>  Select a Compute Host execution target (repeatable)
  --enable-compute-host <provider-id>  Enable a Compute Host without selecting it (repeatable)
  --clear-compute-hosts    Clear enabled and selected Compute Hosts
  --plan-first           Require an approved Plan before execution
  --auto-review          Enable automatic review for this Session
  --no-auto-review       Disable automatic review for this Session
  --memory               Enable Memory for this Session
  --no-memory            Disable Memory for this Session
  --specialist <id-or-name>  Bind a new Session to a Specialist
  --delegation <policy>  allow or deny new delegated children
  --framework <id>       claude-code, opencode, codex, or codebuddy
  --reviewer-inherit | --reviewer-provider <id> --reviewer-model <id> [--reviewer-effort <effort>]
  --subagent-inherit | --subagent-provider <id> --subagent-model <id> [--subagent-effort <effort>]
  --clear-provider | --clear-approval-profile | --clear-auto-review | --clear-memory
  --clear-delegation | --clear-specialist  Clear one Project Session default
  --wait                 Wait for the run to finish
  --return-on-attention  With --wait, return when the Plan needs approval
  --timeout-ms <ms>      Stop waiting after this many milliseconds
  --cancel-on-timeout    Cancel the server run when --timeout-ms expires
  --jsonl                With run --wait, stream one machine-readable event per line
  --output <path>        Artifact download destination
  --yes                  Confirm the offline rollback conversion
  --no-open              Do not open the browser after start
  --no-sandbox           Disable Chromium's process sandbox (security risk; start/update only)
  --force                Sign in again even when Codex credentials already exist
  --json                 Emit one machine-readable result
  -h, --help             Show this help`

// Flags that take a value, mapped to their camelCase option key (explicit so new hyphenated flags
// can't collide the way a generic slice/replace would).
const VALUE_OPTIONS = {
  '--port': 'port',
  '--app-path': 'appPath',
  '--config-root': 'configRoot',
  '--data-root': 'dataRoot',
  '--project': 'project',
  '--session': 'session',
  '--cwd': 'cwd',
  '--prompt': 'prompt',
  '--prompt-file': 'promptFile',
  '--approval-profile': 'approvalProfile',
  '--provider': 'provider',
  '--model': 'model',
  '--reasoning-effort': 'reasoningEffort',
  '--framework': 'framework',
  '--reviewer-provider': 'reviewerProvider',
  '--reviewer-model': 'reviewerModel',
  '--reviewer-effort': 'reviewerEffort',
  '--subagent-provider': 'subagentProvider',
  '--subagent-model': 'subagentModel',
  '--subagent-effort': 'subagentEffort',
  '--specialist': 'specialist',
  '--delegation': 'delegation',
  '--artifact-version': 'artifactVersion',
  '--revision': 'revision',
  '--feedback': 'feedback',
  '--timeout-ms': 'timeoutMs',
  '--name': 'name',
  '--description': 'description',
  '--agent-context': 'agentContext',
  '--agent-context-file': 'agentContextFile',
  '--output': 'output'
}

const TASK_COMMANDS = new Set(['project', 'run', 'session', 'settings', 'plan', 'artifacts'])
const GROUP_COMMANDS = new Set(['codex', 'project', 'session', 'settings', 'plan', 'artifacts'])

export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliUsageError'
    this.code = 'invalid_cli_usage'
    this.exitCode = 2
  }
}

const parsePortOption = (value) => {
  const normalized = value.trim()
  const port = Number(normalized)
  if (!/^\d+$/.test(normalized) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliUsageError(`Invalid port: ${value}`)
  }
  return port
}

export const parseCliArgs = (argv) => {
  const args = [...argv]
  const command = args.shift()
  const subcommand =
    GROUP_COMMANDS.has(command) ||
    (command === 'run' && (args[0] === 'status' || args[0] === 'cancel'))
      ? args.shift()
      : undefined
  const options = {
    open: true,
    json: false,
    ...(TASK_COMMANDS.has(command) ? { jsonl: false } : {}),
    ...(command === 'run' ? { wait: false } : {})
  }
  const positionals = []
  while (args.length > 0) {
    const arg = args.shift()
    if (arg === '--no-open') options.open = false
    else if (arg === '--no-sandbox') options.noSandbox = true
    else if (arg === '--json') options.json = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--force') options.force = true
    else if (arg === '--jsonl') options.jsonl = true
    else if (arg === '--wait') options.wait = true
    else if (arg === '--return-on-attention') options.returnOnAttention = true
    else if (arg === '--plan-first') options.planFirst = true
    else if (arg === '--provider-default-model') options.providerDefaultModel = true
    else if (arg === '--clear-compute-hosts') options.clearComputeHosts = true
    else if (arg === '--memory') {
      if (options.memoryEnabled === false) {
        throw new CliUsageError('Use only one of --memory or --no-memory.')
      }
      options.memoryEnabled = true
    } else if (arg === '--no-memory') {
      if (options.memoryEnabled === true) {
        throw new CliUsageError('Use only one of --memory or --no-memory.')
      }
      options.memoryEnabled = false
    } else if (arg === '--reviewer-inherit') options.reviewerInherit = true
    else if (arg === '--subagent-inherit') options.subagentInherit = true
    else if (arg === '--clear-provider') options.clearProvider = true
    else if (arg === '--clear-approval-profile') options.clearApprovalProfile = true
    else if (arg === '--clear-auto-review') options.clearAutoReview = true
    else if (arg === '--clear-memory') options.clearMemory = true
    else if (arg === '--clear-delegation') options.clearDelegation = true
    else if (arg === '--clear-specialist') options.clearSpecialist = true
    else if (arg === '--auto-review') {
      if (options.autoReviewEnabled === false) {
        throw new CliUsageError('Use only one of --auto-review or --no-auto-review.')
      }
      options.autoReviewEnabled = true
    } else if (arg === '--no-auto-review') {
      if (options.autoReviewEnabled === true) {
        throw new CliUsageError('Use only one of --auto-review or --no-auto-review.')
      }
      options.autoReviewEnabled = false
    } else if (arg === '--cancel-on-timeout') options.cancelOnTimeout = true
    else if (arg === '--clear-agent-context') options.clearAgentContext = true
    else if (arg === '--skill') {
      const value = args.shift()
      if (!value) throw new CliUsageError('--skill requires a value.')
      options.skills = [...(options.skills ?? []), value]
    } else if (arg === '--compute-host') {
      const value = args.shift()
      if (!value) throw new CliUsageError('--compute-host requires a value.')
      options.computeHosts = [...(options.computeHosts ?? []), value]
    } else if (arg === '--enable-compute-host') {
      const value = args.shift()
      if (!value) throw new CliUsageError('--enable-compute-host requires a value.')
      options.enabledComputeHosts = [...(options.enabledComputeHosts ?? []), value]
    } else if (arg === '-h' || arg === '--help') options.help = true
    else if (Object.hasOwn(VALUE_OPTIONS, arg)) {
      const value = args.shift()
      if (!value) throw new CliUsageError(`${arg} requires a value.`)
      options[VALUE_OPTIONS[arg]] = value
    } else if (arg.startsWith('-')) {
      throw new CliUsageError(`Unknown option: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }
  if (options.port !== undefined) {
    options.port = parsePortOption(options.port)
  }
  if (options.approvalProfile && !['ask', 'auto', 'full'].includes(options.approvalProfile)) {
    throw new CliUsageError(`Invalid approval profile: ${options.approvalProfile}`)
  }
  if (options.timeoutMs !== undefined) {
    const timeoutMs = Number(options.timeoutMs)
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CliUsageError(`Invalid timeout: ${options.timeoutMs}`)
    }
    options.timeoutMs = timeoutMs
  }
  if (options.revision !== undefined) {
    const revision = Number(options.revision)
    if (!Number.isInteger(revision) || revision < 0) {
      throw new CliUsageError(`Invalid revision: ${options.revision}`)
    }
    options.revision = revision
  }
  if (options.delegation && !['allow', 'deny'].includes(options.delegation)) {
    throw new CliUsageError(`Invalid delegation policy: ${options.delegation}`)
  }
  for (const [label, value] of [
    ['--reasoning-effort', options.reasoningEffort],
    ['--reviewer-effort', options.reviewerEffort],
    ['--subagent-effort', options.subagentEffort]
  ]) {
    if (
      value !== undefined &&
      !['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
    ) {
      throw new CliUsageError(`Invalid ${label}: ${value}`)
    }
  }
  if (
    options.framework !== undefined &&
    !['claude-code', 'opencode', 'codex', 'codebuddy'].includes(options.framework)
  ) {
    throw new CliUsageError(`Invalid framework: ${options.framework}`)
  }
  if (options.model !== undefined && options.providerDefaultModel) {
    throw new CliUsageError('Use only one of --model or --provider-default-model.')
  }
  if (
    options.provider !== undefined &&
    options.model === undefined &&
    !options.providerDefaultModel
  ) {
    throw new CliUsageError('--provider requires --model or --provider-default-model.')
  }
  if (
    options.clearComputeHosts &&
    (options.computeHosts !== undefined || options.enabledComputeHosts !== undefined)
  ) {
    throw new CliUsageError(
      'Use only one of Compute Host selection options or --clear-compute-hosts.'
    )
  }
  if (options.json && options.jsonl) {
    throw new CliUsageError('Use only one of --json or --jsonl.')
  }
  if (options.cwd !== undefined && !options.cwd.trim()) {
    throw new CliUsageError('--cwd requires a non-empty path.')
  }
  if (options.cwd && (command !== 'run' || subcommand)) {
    throw new CliUsageError('--cwd requires run.')
  }
  if (options.jsonl && (command !== 'run' || subcommand || !options.wait)) {
    throw new CliUsageError('--jsonl requires run --wait.')
  }
  if (options.timeoutMs !== undefined && (command !== 'run' || subcommand || !options.wait)) {
    throw new CliUsageError('--timeout-ms requires run --wait.')
  }
  if (options.returnOnAttention && (command !== 'run' || subcommand || !options.wait)) {
    throw new CliUsageError('--return-on-attention requires run --wait.')
  }
  if (options.cancelOnTimeout && options.timeoutMs === undefined) {
    throw new CliUsageError('--cancel-on-timeout requires --timeout-ms.')
  }
  if (options.noSandbox && command !== 'start' && command !== 'update') {
    throw new CliUsageError('--no-sandbox requires start or update.')
  }
  if (options.yes && command !== 'rollback-to-0.7.3') {
    throw new CliUsageError('--yes requires rollback-to-0.7.3.')
  }
  if (options.dataRoot && command !== 'rollback-to-0.7.3') {
    throw new CliUsageError('--data-root requires rollback-to-0.7.3.')
  }
  if (options.force && (command !== 'codex' || subcommand !== 'login')) {
    throw new CliUsageError('--force requires codex login.')
  }
  if (command === 'update' && positionals.length > 0) {
    throw new CliUsageError('update accepts no arguments.')
  }
  const isProjectCreate = command === 'project' && subcommand === 'create'
  const isProjectUpdate = command === 'project' && subcommand === 'update'
  const agentContextSources = [
    options.agentContext !== undefined,
    options.agentContextFile !== undefined,
    options.clearAgentContext === true
  ].filter(Boolean)
  if (agentContextSources.length > 1) {
    throw new CliUsageError('Use only one Agent Context source.')
  }
  if (agentContextSources.length > 0 && !isProjectCreate && !isProjectUpdate) {
    throw new CliUsageError('Agent Context options require project create or project update.')
  }
  if (options.clearAgentContext && !isProjectUpdate) {
    throw new CliUsageError('--clear-agent-context requires project update.')
  }
  if (options.name !== undefined && !isProjectUpdate) {
    throw new CliUsageError('--name requires project update.')
  }
  if (options.name !== undefined && !options.name.trim()) {
    throw new CliUsageError('--name requires a non-empty value.')
  }
  if (options.description !== undefined && !isProjectCreate && !isProjectUpdate) {
    throw new CliUsageError('--description requires project create or project update.')
  }
  if (options.agentContext !== undefined) {
    const context = options.agentContext.trim()
    if (!context) throw new CliUsageError('Agent Context must not be empty.')
    if (context.length > 16_000) {
      throw new CliUsageError('Agent Context must not exceed 16000 characters.')
    }
    options.agentContext = context
  }
  if (command === 'codex' && subcommand === 'login') {
    if (options.json || options.jsonl) {
      throw new CliUsageError('codex login does not support machine-readable output.')
    }
    if (positionals.length > 0) throw new CliUsageError('codex login accepts no arguments.')
  }
  const sessionConfigAction = command === 'session' && subcommand === 'config' && positionals[0]
  const projectDefaultsAction =
    command === 'project' && subcommand === 'session-defaults' && positionals[0]
  const agentRoutingAction =
    command === 'settings' && subcommand === 'agent-routing' && positionals[0]
  const isSessionConfigUpdate = sessionConfigAction === 'update'
  const isProjectDefaultsUpdate = projectDefaultsAction === 'update'
  const isAgentRoutingUpdate = agentRoutingAction === 'update'
  const isRun = command === 'run' && !subcommand
  if (isRun && options.session && options.enabledComputeHosts !== undefined) {
    throw new CliUsageError(
      '--enable-compute-host cannot update an existing Session; use session config update.'
    )
  }
  if (isRun && options.session && options.clearComputeHosts) {
    throw new CliUsageError(
      '--clear-compute-hosts cannot update an existing Session; use session config update.'
    )
  }
  const runOnlyOptions = [
    ['--plan-first', options.planFirst],
    ['--skill', options.skills !== undefined]
  ]
  for (const [label, present] of runOnlyOptions) {
    if (present && !isRun) {
      throw new CliUsageError(`${label} requires run.`)
    }
  }
  const sessionOptionPresent =
    options.provider !== undefined ||
    options.model !== undefined ||
    options.providerDefaultModel ||
    options.reasoningEffort !== undefined ||
    options.approvalProfile !== undefined ||
    options.autoReviewEnabled !== undefined ||
    options.memoryEnabled !== undefined ||
    options.delegation !== undefined ||
    options.computeHosts !== undefined ||
    options.enabledComputeHosts !== undefined ||
    options.clearComputeHosts
  if (sessionOptionPresent && !isRun && !isSessionConfigUpdate && !isProjectDefaultsUpdate) {
    throw new CliUsageError(
      'Session configuration options require run or a defaults/config update.'
    )
  }
  if (options.specialist !== undefined && !isRun && !isProjectDefaultsUpdate) {
    throw new CliUsageError('--specialist requires run or project session-defaults update.')
  }
  const projectClearPresent =
    options.clearProvider ||
    options.clearApprovalProfile ||
    options.clearAutoReview ||
    options.clearMemory ||
    options.clearDelegation ||
    options.clearSpecialist
  if (projectClearPresent && !isProjectDefaultsUpdate) {
    throw new CliUsageError(
      'Project default clear options require project session-defaults update.'
    )
  }
  const routingPresent =
    options.framework !== undefined ||
    options.reviewerProvider !== undefined ||
    options.reviewerModel !== undefined ||
    options.reviewerEffort !== undefined ||
    options.reviewerInherit ||
    options.subagentProvider !== undefined ||
    options.subagentModel !== undefined ||
    options.subagentEffort !== undefined ||
    options.subagentInherit
  if (routingPresent && !isAgentRoutingUpdate) {
    throw new CliUsageError('Agent routing options require settings agent-routing update.')
  }
  if (
    command !== 'plan' &&
    !isSessionConfigUpdate &&
    (options.artifactVersion !== undefined ||
      (options.revision !== undefined && !isSessionConfigUpdate) ||
      options.feedback !== undefined)
  ) {
    throw new CliUsageError('Plan response options require a plan command.')
  }
  return {
    command,
    ...(subcommand ? { subcommand } : {}),
    ...(positionals.length ? { positionals } : {}),
    options
  }
}

export const isProcessAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const authenticatedUrl = async (state, deps = DEFAULT_DEPS) => {
  const token = await deps.readWebToken(state.configRoot)
  return `http://127.0.0.1:${state.port}/?token=${encodeURIComponent(token)}`
}

const healthCheck = async (state, deps = DEFAULT_DEPS) => {
  if (!state || !deps.isAlive(state.pid)) return false
  try {
    const token = await deps.readWebToken(state.configRoot)
    const response = await deps.fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_500)
    })
    return response.ok
  } catch {
    return false
  }
}

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))

const waitForState = async (
  configRoot,
  deps = DEFAULT_DEPS,
  timeoutMs = START_TIMEOUT_MS,
  signal
) => {
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline && !signal?.aborted) {
    const state = await deps.findServiceState({ override: configRoot })
    if (signal?.aborted) return undefined
    if (await healthCheck(state, deps)) return state
    if (signal?.aborted) return undefined
    await deps.sleep(250)
  }
  return undefined
}

// Keep the health poll and child-process lifecycle coupled: a fatal Electron startup error must not
// look like a slow service startup and consume the full CLI timeout.
export const waitForStartup = async (
  configRoot,
  child,
  deps = DEFAULT_DEPS,
  timeoutMs = START_TIMEOUT_MS
) => {
  const abortController = new AbortController()
  let cleanup = () => {}
  const childFailure = new Promise((resolveFailure) => {
    const onExit = (code, signal) => {
      // An already-running desktop app receives --serve through Electron's second-instance relay.
      // The relay exits successfully before the primary app has necessarily written service state.
      if (code === 0 && signal === null) return
      abortController.abort()
      resolveFailure({ kind: 'exit', code, signal })
    }
    const onError = (error) => {
      abortController.abort()
      resolveFailure({ kind: 'error', error })
    }
    child.once('exit', onExit)
    child.once('error', onError)
    cleanup = () => {
      child.off('exit', onExit)
      child.off('error', onError)
    }
  })
  const healthy = waitForState(configRoot, deps, timeoutMs, abortController.signal).then((state) =>
    state ? { kind: 'ready', state } : { kind: 'timeout' }
  )
  try {
    return await Promise.race([healthy, childFailure])
  } finally {
    abortController.abort()
    cleanup()
  }
}

const openBrowser = (url) => {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

const removeStateFiles = async (configRoot) => {
  await rm(join(configRoot, STATE_FILE), { force: true })
}

// The real I/O the commands use, bundled so tests can substitute fakes. Declared after the helpers it
// references so its initializer sees them; commands take `deps = DEFAULT_DEPS`, so production callers
// pass nothing and get these.
const DEFAULT_DEPS = {
  findServiceState: (options) => findServiceState(options),
  readWebToken: (configRoot) => readWebToken(configRoot),
  isAlive: isProcessAlive,
  removeState: (configRoot) => removeStateFiles(configRoot),
  fetch: (input, init) => fetch(input, init),
  sleep,
  now: () => Date.now(),
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args)
}

// Waits for the daemon to exit after an authenticated graceful shutdown request. A PID proves only
// that some process is alive, not that it is still the daemon recorded in a potentially stale state
// file, so this function deliberately never signals it. Returns true iff the PID is no longer alive.
export const terminateDaemon = async (pid, opts) => {
  const { isAlive, sleep: sleepFn, now, gracefulTimeoutMs } = opts
  const deadline = now() + gracefulTimeoutMs
  while (now() < deadline && isAlive(pid)) await sleepFn(250)
  return !isAlive(pid)
}

// Waits for an attached web service (one riding on the desktop app) to stop responding after a graceful
// shutdown request. Returns true once it is no longer healthy. Never kills the pid — that process is the
// user's app, not a daemon this CLI owns, so if it refuses to stop we fail loudly rather than force it.
const waitForWebServiceStopped = async (state, deps, timeoutMs) => {
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    if (!(await healthCheck(state, deps))) return true
    await deps.sleep(250)
  }
  return false
}

const readLogTail = async (logPath) => {
  try {
    const text = await readFile(logPath, 'utf8')
    return text.split(/\r?\n/).slice(-30).join('\n')
  } catch {
    return ''
  }
}

export const openLaunchLog = (logPath) => openSync(logPath, 'w')

export const buildAppLaunchArgs = (appArgs, options, port) => [
  ...(options.noSandbox ? ['--no-sandbox'] : []),
  ...appArgs,
  // `--open-science-headless` instead of `--headless`: Chromium consumes `--headless` and renders
  // native menus (like the tray context menu) invisibly on Windows (electron/electron#48982).
  '--open-science-headless',
  `--serve=${port}`
]

const sandboxFailurePattern =
  /SUID sandbox helper binary.*not configured correctly|No usable sandbox|The setuid sandbox is not running/i

export const formatStartupFailure = (outcome, logTail, options) => {
  if (!options.noSandbox && sandboxFailurePattern.test(logTail)) {
    return [
      'Open Science could not start because Chromium sandboxing is unavailable on this host.',
      logTail,
      'This can occur when an AppImage mount cannot provide the SUID permissions required by Chromium; some Linux hosts also restrict unprivileged user namespaces.',
      'For an explicit rootless fallback, run "open-science start --no-sandbox" or retry an update with "open-science update --no-sandbox".',
      "Warning: --no-sandbox disables Chromium's process sandbox and reduces security. Prefer the Debian package or a host configuration that supports sandboxed startup."
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  if (outcome.kind === 'error') return `Could not start Open Science: ${outcome.error.message}`

  const exitStatus = outcome.signal
    ? ` after receiving ${outcome.signal}`
    : ` with exit code ${outcome.code ?? 'unknown'}`
  return `Open Science exited before becoming healthy${exitStatus}.${logTail ? `\n\n${logTail}` : ''}`
}

const startCommand = async (options, deps = DEFAULT_DEPS) => {
  const existing = await deps.findServiceState({ override: options.configRoot })
  if (await healthCheck(existing, deps)) {
    const url = await authenticatedUrl(existing, deps)
    deps.log(`Open Science is already running (PID ${existing.pid}).`)
    if (options.open) openBrowser(url)
    else deps.log('Run "open-science url" to print a browser login URL.')
    return { state: existing, started: false }
  }

  const app = await locateApp({ appPath: options.appPath })
  if (app.packaged && options.configRoot) {
    throw new Error('--config-root is only supported for development builds.')
  }
  const configRoot = resolveConfigRoot({
    packaged: app.packaged,
    override: options.configRoot,
    env: app.packaged ? {} : process.env
  })
  await mkdir(configRoot, { recursive: true })
  await deps.removeState(configRoot)

  const logPath = join(configRoot, 'cli-daemon.log')
  const logFd = openLaunchLog(logPath)
  const port = options.port ?? DEFAULT_PORT
  const childEnv = {
    ...process.env,
    ...(app.packaged ? {} : { OPEN_SCIENCE_STORAGE_ROOT: configRoot }),
    OPEN_SCIENCE_WEB_PORT: String(port)
  }
  // The installed launcher runs this CLI via the app's Electron in Node mode (ELECTRON_RUN_AS_NODE=1).
  // Drop it here so the daemon we spawn starts as the normal Electron app, not another Node process.
  delete childEnv.ELECTRON_RUN_AS_NODE
  if (options.noSandbox) {
    deps.warn("Warning: --no-sandbox disables Chromium's process sandbox and reduces security.")
  }
  const child = spawn(app.command, buildAppLaunchArgs(app.args, options, port), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: childEnv
  })
  const startupPromise = waitForStartup(configRoot, child, deps)
  child.unref()
  closeSync(logFd)

  const startup = await startupPromise
  if (startup.kind !== 'ready') {
    const logTail = await readLogTail(logPath)
    if (startup.kind !== 'timeout') {
      throw new Error(formatStartupFailure(startup, logTail, options))
    }
    throw new Error(
      `Open Science did not become healthy within ${START_TIMEOUT_MS / 1000}s.${logTail ? `\n\n${logTail}` : ''}`
    )
  }
  const state = startup.state
  const url = await authenticatedUrl(state, deps)
  deps.log(`Open Science started (PID ${state.pid}).`)
  if (options.open) openBrowser(url)
  else deps.log('Run "open-science url" to print a browser login URL.')
  return { state, started: true }
}

const findCurrentState = async (options, deps = DEFAULT_DEPS) => {
  const state = await deps.findServiceState({ override: options.configRoot })
  if (!state) return undefined
  if (!deps.isAlive(state.pid)) {
    await deps.removeState(state.configRoot)
    return undefined
  }
  return state
}

export const stopCommand = async (options, deps = DEFAULT_DEPS) => {
  const state = await findCurrentState(options, deps)
  if (!state) {
    deps.log('Open Science is not running.')
    return
  }
  const token = await deps.readWebToken(state.configRoot)
  let shutdownAccepted = false
  try {
    const response = await deps.fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    shutdownAccepted = true
    await response.arrayBuffer()
  } catch (error) {
    deps.warn(`Graceful shutdown failed: ${error.message}`)
  }

  if (!shutdownAccepted) {
    throw new Error(
      `Could not safely stop Open Science (PID ${state.pid}); the authenticated shutdown request was not accepted, so no process signal was sent.`
    )
  }

  // Attached: the web service rides on the running desktop app. A graceful request stops only the web
  // service; the app stays up, so observe service health instead of waiting for its pid to exit.
  if (state.attached) {
    const stopped = await waitForWebServiceStopped(state, deps, STOP_TIMEOUT_MS)
    if (!stopped) {
      throw new Error(
        `Could not stop the Open Science web service (PID ${state.pid}); the app is still serving.`
      )
    }
    await deps.removeState(state.configRoot)
    deps.log('Open Science web service stopped; the app is still running.')
    return
  }

  const stopped = await terminateDaemon(state.pid, {
    isAlive: deps.isAlive,
    sleep: deps.sleep,
    now: deps.now,
    gracefulTimeoutMs: STOP_TIMEOUT_MS
  })
  // Only claim success (and drop the state file) once the process is confirmed gone; otherwise leave
  // the state in place and fail loudly so the user isn't told it stopped when it didn't.
  if (!stopped) {
    throw new Error(
      `Could not stop Open Science (PID ${state.pid}); it is still running, so no process signal was sent.`
    )
  }
  await deps.removeState(state.configRoot)
  deps.log('Open Science stopped.')
}

export const statusCommand = async (options, deps = DEFAULT_DEPS) => {
  const state = await findCurrentState(options, deps)
  const running = await healthCheck(state, deps)
  if (options.json) {
    deps.log(JSON.stringify(running ? { running: true, ...state } : { running: false }, null, 2))
  } else if (running) {
    deps.log(`Open Science is running (PID ${state.pid}, port ${state.port}).`)
  } else {
    deps.log('Open Science is not running.')
  }
  if (!running) process.exitCode = 1
}

export const urlCommand = async (options, deps = DEFAULT_DEPS) => {
  const state = await findCurrentState(options, deps)
  if (!(await healthCheck(state, deps))) throw new Error('Open Science is not running.')
  deps.log(await authenticatedUrl(state, deps))
}

const resolveDownloadOutput = async (output) => {
  let candidate = output
  for (let hop = 0; ; hop += 1) {
    const linkTarget = await lstat(candidate).then(
      (metadata) => (metadata.isSymbolicLink() ? readlink(candidate) : undefined),
      (error) => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      }
    )
    if (linkTarget === undefined) return candidate
    if (hop === MAX_DOWNLOAD_SYMLINK_HOPS) break
    candidate = resolve(dirname(candidate), linkTarget)
  }
  throw new Error(`Too many symbolic links in artifact output: ${output}`)
}

const writeDownload = async (response, output) => {
  if (!response.body) throw new Error('Artifact download returned no data.')
  const destination = await resolveDownloadOutput(output)
  const existingMode = await stat(destination).then(
    ({ mode }) => mode & 0o777,
    (error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  )
  const temporaryOutput = `${destination}.${process.pid}-${randomUUID()}.tmp`
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryOutput, {
        flags: 'wx',
        ...(existingMode === undefined ? {} : { mode: existingMode })
      })
    )
    if (existingMode !== undefined) await chmod(temporaryOutput, existingMode)
    await rename(temporaryOutput, destination)
  } finally {
    await rm(temporaryOutput, { force: true }).catch(() => undefined)
  }
}

const TASK_DEPS = {
  connect: (options) => connectToOpenScience(options),
  readFile: (path) => readFile(path, 'utf8'),
  readBinaryFile: (path) => readFile(path),
  readStdin: () => readFile(0, 'utf8'),
  writeDownload,
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  stdinIsTTY: process.stdin.isTTY,
  setExitCode: (code) => {
    process.exitCode = code
  }
}

const outputValue = (value, options, deps) => {
  if (options.json || options.jsonl) deps.log(JSON.stringify(value))
  else if (Array.isArray(value)) {
    for (const item of value) {
      deps.log(`${item.id}\t${item.name ?? item.title ?? item.path ?? ''}`.trimEnd())
    }
  } else {
    deps.log(
      typeof value === 'string'
        ? value
        : [value.id, value.name ?? value.title ?? value.status ?? value.path]
            .filter(Boolean)
            .join('\t') || JSON.stringify(value)
    )
  }
}

export const rollbackCommand = async (options, dependencies = {}) => {
  const defaultRunRollback = async (rollbackOptions) => {
    const { runRollbackToV073 } = await import('./rollback-to-0.7.3.mjs')
    return runRollbackToV073(rollbackOptions)
  }
  const deps = {
    runRollback: defaultRunRollback,
    log: (...args) => console.log(...args),
    ...dependencies
  }
  if (!options.json) {
    deps.log('Validating and copying rollback data. Keep this terminal open until it completes...')
  }
  const manifest = await deps.runRollback({
    configRoot: options.configRoot,
    dataRoot: options.dataRoot,
    output: options.output,
    confirm: options.yes === true
  })
  if (options.json) {
    deps.log(JSON.stringify(manifest))
    return
  }
  deps.log(`Prepared an isolated Open Science ${manifest.targetVersion} rollback.`)
  deps.log(`Rollback Data Root: ${manifest.rollbackDataRoot}`)
  deps.log(`Preserved newer Config Root: ${manifest.preservedConfigRoot}`)
  deps.log(`Preserved newer Data Root: ${manifest.preservedDataRoot}`)
  deps.log(`Converted Sessions: ${manifest.sessionsConverted}`)
  deps.log(`You can now install and start Open Science ${manifest.targetVersion}.`)
}

const UPDATE_DOWNLOAD_PAGE = 'https://www.aipoch.com/open-science'
const UPDATE_BOOTSTRAPS = new WeakMap()

const updateResult = (status, outcome, extras = {}) => ({
  outcome,
  current: status.current,
  ...(status.latest ? { latest: status.latest } : {}),
  ...extras
})

const updateBootstrap = async (client) => {
  let bootstrap = UPDATE_BOOTSTRAPS.get(client)
  if (!bootstrap) {
    bootstrap = await client.health()
    UPDATE_BOOTSTRAPS.set(client, bootstrap)
  }
  return bootstrap
}

const supportsApplicationCommand = async (client, channel) => {
  const bootstrap = await updateBootstrap(client)
  return Array.isArray(bootstrap.rpcChannels) && bootstrap.rpcChannels.includes(channel)
}

const invokeApplicationCommand = async (client, channel, args = []) => {
  const bootstrap = await updateBootstrap(client)
  if (!Array.isArray(bootstrap.rpcChannels) || !bootstrap.rpcChannels.includes(channel)) {
    throw new OpenScienceApiError(`Open Science does not support ${channel}.`, {
      code: 'command_unavailable'
    })
  }
  if (!Number.isInteger(bootstrap.rpcProtocolVersion)) {
    throw new OpenScienceApiError('Open Science does not expose a compatible RPC protocol.', {
      code: 'command_unavailable'
    })
  }

  const response = await client.fetch(`${client.baseUrl}/rpc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-open-science-client': 'open-science-cli'
    },
    body: JSON.stringify({ protocolVersion: bootstrap.rpcProtocolVersion, args }),
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS)
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new OpenScienceApiError('Open Science RPC returned an invalid response.', {
      code: 'invalid_response',
      status: response.status
    })
  }
  if (
    !response.ok ||
    payload?.protocolVersion !== bootstrap.rpcProtocolVersion ||
    typeof payload?.ok !== 'boolean'
  ) {
    throw new OpenScienceApiError(
      payload?.error?.message ?? 'Open Science RPC returned an invalid response.',
      { code: payload?.error?.code ?? 'invalid_response', status: response.status }
    )
  }
  if (!payload.ok) {
    throw new OpenScienceApiError(payload.error?.message ?? 'Open Science command failed.', {
      code: payload.error?.code ?? 'command_failed',
      status: response.status
    })
  }
  return payload.result
}

const downloadWithProgress = async (client, options, deps) => {
  let settled = false
  const download = deps
    .invokeCommand(client, 'update:download', [{ nonInteractive: true }])
    .finally(() => {
      settled = true
    })
  // Observe rejection immediately while the polling loop is active; the final await below still
  // preserves it for the caller.
  void download.catch(() => undefined)

  let lastPercent
  while (!settled) {
    await deps.sleep(500)
    if (settled || options.json) continue
    const status = await deps.invokeCommand(client, 'update:get-status')
    if (status.state !== 'downloading' || !Number.isFinite(status.progress)) continue
    const percent = Math.max(0, Math.min(100, Math.round(status.progress)))
    if (percent === lastPercent) continue
    lastPercent = percent
    deps.log(`Downloading update: ${percent}%`)
  }
  return await download
}

export const updateCommand = async (options, dependencies = {}) => {
  const quietLog = options.json ? () => {} : (...args) => console.log(...args)
  const deps = {
    ensureService: (startOptions) => startCommand(startOptions, { ...DEFAULT_DEPS, log: quietLog }),
    stopService: (stopOptions) => stopCommand(stopOptions, { ...DEFAULT_DEPS, log: quietLog }),
    connect: (connectOptions) => connectToOpenScience(connectOptions),
    sleep,
    getBootstrap: updateBootstrap,
    supportsCommand: supportsApplicationCommand,
    invokeCommand: invokeApplicationCommand,
    log: (...args) => console.log(...args),
    setExitCode: (code) => {
      process.exitCode = code
    },
    ...dependencies
  }
  const serviceStart = await deps.ensureService({ ...options, open: false })
  const client = await deps.connect({ configRoot: options.configRoot })
  let result

  const supports = (channel) => deps.supportsCommand(client, channel)
  const bootstrap = await deps.getBootstrap(client)
  if (!bootstrap.rpcCapabilities?.includes(UPDATE_CLI_RPC_CAPABILITY)) {
    const status = { current: bootstrap.appVersion ?? 'unknown' }
    result = updateResult(status, 'manual-action-required', {
      nextAction: `Install the latest Open Science release from ${UPDATE_DOWNLOAD_PAGE}, then run this command again.`
    })
  } else if (!(await supports('update:check'))) {
    throw new Error(
      'The running Open Science version advertises update CLI support without update:check.'
    )
  } else {
    if (!options.json) deps.log('Checking for Open Science updates...')
    let status = await deps.invokeCommand(client, 'update:check')
    if (status.state === 'error') throw new Error(status.error ?? 'Update check failed.')

    if (status.state === 'up-to-date') {
      result = updateResult(status, 'up-to-date')
    } else if (status.state !== 'available' && status.state !== 'ready') {
      throw new Error(`Update check ended in an unexpected state: ${status.state}`)
    } else {
      if (status.state === 'available') {
        if (!(await supports('update:download'))) {
          result = updateResult(status, 'manual-action-required', {
            nextAction: `Install Open Science ${status.latest ?? 'from the latest release'} manually from ${UPDATE_DOWNLOAD_PAGE}.`
          })
        } else {
          if (!options.json) {
            deps.log(`Open Science ${status.latest ?? 'update'} is available. Downloading...`)
          }
          status = await downloadWithProgress(client, options, deps)
          if (status.state === 'error') throw new Error(status.error ?? 'Update download failed.')
          if (status.state !== 'ready') {
            result = updateResult(status, 'manual-action-required', {
              nextAction: `No compatible update artifact is available. Install it manually from ${UPDATE_DOWNLOAD_PAGE}.`
            })
          }
        }
      }

      if (!result && status.state === 'ready') {
        if (status.applyKind !== 'restart') {
          const installerPath = status.localPath
          result = updateResult(status, 'manual-action-required', {
            ...(installerPath ? { installerPath } : {}),
            nextAction: installerPath
              ? `Run the installer at ${installerPath}, then start Open Science again.`
              : `Install Open Science ${status.latest ?? 'from the latest release'} manually from ${UPDATE_DOWNLOAD_PAGE}.`
          })
        } else if (!(await supports('update:apply'))) {
          result = updateResult(status, 'manual-action-required', {
            nextAction: `Install Open Science ${status.latest ?? 'from the latest release'} manually from ${UPDATE_DOWNLOAD_PAGE}.`
          })
        } else {
          if (!options.json) deps.log('Applying the update without opening the desktop app...')
          status = await deps.invokeCommand(client, 'update:apply', [{ relaunch: false }])
          if (status.blockedBy?.length) {
            result = updateResult(status, 'blocked', { blockedBy: status.blockedBy })
          } else if (status.state === 'error') {
            throw new Error(status.error ?? 'Update apply failed.')
          } else if (status.state === 'applying') {
            result = updateResult(status, 'install-started')
          } else {
            throw new Error(`Update apply ended in an unexpected state: ${status.state}`)
          }
        }
      }
    }
  }

  if (result.outcome === 'manual-action-required' && result.installerPath) {
    const attachedToDesktopApp = serviceStart?.state?.attached === true
    const ownedConfigRoot = serviceStart?.state?.configRoot
    const ownsService =
      serviceStart?.started === true && !attachedToDesktopApp && typeof ownedConfigRoot === 'string'
    let requiresManualStop = !ownsService
    if (ownsService) {
      try {
        await deps.stopService({ ...options, configRoot: ownedConfigRoot })
      } catch {
        // Keep the verified installer handoff actionable even if graceful shutdown fails. The user
        // can retry the existing stop command without downloading the installer again.
        requiresManualStop = true
      }
    }
    if (attachedToDesktopApp) {
      result = {
        ...result,
        nextAction: `Quit the running Open Science app, then run the installer at ${result.installerPath} and start Open Science again.`
      }
    } else if (requiresManualStop) {
      result = {
        ...result,
        nextAction: `Run "open-science stop", then run the installer at ${result.installerPath} and start Open Science again.`
      }
    }
  }

  deps.log(options.json ? JSON.stringify(result) : formatUpdateResult(result))
  if (result.outcome === 'blocked') deps.setExitCode(UPDATE_BLOCKED_EXIT_CODE)
  if (result.outcome === 'manual-action-required') {
    deps.setExitCode(UPDATE_MANUAL_ACTION_EXIT_CODE)
  }
  return result
}

const formatUpdateResult = (result) => {
  if (result.outcome === 'up-to-date') {
    return `Open Science ${result.current} is up to date.`
  }
  if (result.outcome === 'install-started') {
    return `Installation of Open Science ${result.latest ?? 'update'} was handed off to the platform updater. The desktop app will not be opened; verify the installed version after the updater exits.`
  }
  if (result.outcome === 'blocked') {
    return `Update blocked by active research: ${result.blockedBy.join(', ')}.`
  }
  return [
    `Open Science ${result.latest ?? result.current} requires a manual install.`,
    result.installerPath ? `Installer: ${result.installerPath}` : undefined,
    result.nextAction
  ]
    .filter(Boolean)
    .join('\n')
}

const readPrompt = async (options, deps) => {
  const sources = [options.prompt !== undefined, options.promptFile !== undefined].filter(Boolean)
  if (sources.length > 1) throw new CliUsageError('Use only one of --prompt or --prompt-file.')
  if (options.prompt !== undefined) return options.prompt.trim()
  if (options.promptFile !== undefined) return (await deps.readFile(options.promptFile)).trim()
  if (deps.stdinIsTTY) {
    throw new CliUsageError('Provide --prompt, --prompt-file, or pipe a prompt on stdin.')
  }
  return (await deps.readStdin()).trim()
}

const validateAgentContext = (value) => {
  const context = value.trim()
  if (!context) throw new CliUsageError('Agent Context must not be empty.')
  if (context.length > 16_000) {
    throw new CliUsageError('Agent Context must not exceed 16000 characters.')
  }
  return context
}

const readAgentContext = async (options, deps) => {
  if (options.clearAgentContext) return ''
  if (options.agentContext !== undefined) return validateAgentContext(options.agentContext)
  if (options.agentContextFile === undefined) return undefined
  let decoded
  try {
    const bytes = await deps.readBinaryFile(options.agentContextFile)
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliUsageError(`Agent Context file not found: ${options.agentContextFile}`)
    }
    if (error instanceof TypeError) {
      throw new CliUsageError('Agent Context file must contain valid UTF-8 text.')
    }
    throw error
  }
  return validateAgentContext(decoded)
}

const resolveCliProject = async (client, selector) => {
  const projects = await client.listProjects()
  const byId = projects.find((project) => project.id === selector)
  if (byId) return byId
  const byName = projects.filter((project) => project.name === selector)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new CliUsageError(`Project name is ambiguous: ${selector}. Use a project ID.`)
  }
  throw new OpenScienceApiError(`Project not found: ${selector}`, { code: 'project_not_found' })
}

const resolveCliProjectId = async (client, selector) =>
  (await resolveCliProject(client, selector)).id

const emitRunEvent = (event, options, deps) => {
  if (options.jsonl) {
    deps.log(JSON.stringify(event))
  } else if (event.type === 'stream.resync-required') {
    deps.warn(
      'Run event history could not be fully replayed. Final Run state will still be read from Open Science.'
    )
  } else if (event.type === 'run.progress') {
    if (event.data?.heartbeat) {
      const seconds = Math.max(1, Math.round((event.data.elapsedMs ?? 0) / 1_000))
      const subject =
        event.data.phase === 'provider-accepted' ? 'the first provider output' : 'the provider'
      deps.log(`Still waiting for ${subject} (${seconds}s elapsed).`)
      return
    }
    const message = {
      accepted: 'Run accepted.',
      'session-ready': 'Session ready.',
      'prompt-dispatched': 'Prompt dispatched to the agent.',
      'provider-accepted': 'Provider accepted the prompt.',
      'first-visible-output': 'First provider output received.'
    }[event.data?.phase]
    if (message) deps.log(message)
  } else if (event.type === 'permission.requested') {
    deps.warn(
      'Run is waiting for approval. Approve the request in Open Science Desktop or the Web UI.'
    )
  } else if (
    event.type === 'run.event' &&
    event.data?.planProjection?.lifecycle === 'awaiting_approval'
  ) {
    deps.warn('Run is waiting for Plan approval.')
  } else if (
    event.type === 'run.event' &&
    event.data?.kind !== 'message' &&
    (event.data?.title || event.data?.text)
  ) {
    deps.log(event.data.title ?? event.data.text)
  }
}

const isEventForRun = (event, run) => {
  if (event?.runId) return event.runId === run.runId
  const sessionId = event?.sessionId ?? event?.data?.sessionId
  return !sessionId || sessionId === run.sessionId
}

const streamRunEvents = async (eventStream, runRef, options, deps, signal) => {
  try {
    for await (const event of eventStream) {
      if (!runRef.current) {
        runRef.pending.push(event)
        continue
      }
      if (!isEventForRun(event, runRef.current)) continue
      emitRunEvent(event, options, deps)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

const agentConfigurationPatch = (options) => {
  const present =
    options.provider !== undefined ||
    options.model !== undefined ||
    options.providerDefaultModel ||
    options.reasoningEffort !== undefined
  if (!present) return undefined
  return {
    ...(options.provider !== undefined ? { providerId: options.provider } : {}),
    ...(options.model !== undefined
      ? { model: options.model }
      : options.providerDefaultModel
        ? { model: null }
        : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {})
  }
}

const computeHostsPatch = (options, current = { enabled: [], selected: [] }) => {
  if (options.clearComputeHosts) return { enabled: [], selected: [] }
  if (options.computeHosts === undefined && options.enabledComputeHosts === undefined) {
    return undefined
  }
  const selected = options.computeHosts ?? current.selected
  const enabled = [...(options.enabledComputeHosts ?? current.enabled), ...selected].filter(
    (value, index, values) => values.indexOf(value) === index
  )
  return { enabled, selected }
}

const modelRouting = (options, prefix) => {
  const inherit = options[`${prefix}Inherit`]
  const providerId = options[`${prefix}Provider`]
  const model = options[`${prefix}Model`]
  const reasoningEffort = options[`${prefix}Effort`]
  if (inherit) {
    if (providerId !== undefined || model !== undefined || reasoningEffort !== undefined) {
      throw new CliUsageError(
        `--${prefix}-inherit cannot be combined with fixed ${prefix} routing options.`
      )
    }
    return { mode: 'inherit' }
  }
  if (providerId === undefined && model === undefined && reasoningEffort === undefined) {
    return undefined
  }
  if (!providerId || !model) {
    throw new CliUsageError(
      `--${prefix}-provider and --${prefix}-model are required for fixed routing.`
    )
  }
  return { mode: 'fixed', providerId, model, reasoningEffort: reasoningEffort ?? 'default' }
}

const assertNoClearConflict = (clear, present, label) => {
  if (clear && present) throw new CliUsageError(`Cannot set and clear ${label} together.`)
}

export const runTaskCommand = async (parsed, dependencies = {}) => {
  const deps = { ...TASK_DEPS, ...dependencies }
  const { command, subcommand, positionals = [], options } = parsed
  const client = await deps.connect({ configRoot: options.configRoot })

  if (command === 'project' && subcommand === 'list') {
    outputValue(await client.listProjects(), options, deps)
    return
  }
  if (command === 'project' && subcommand === 'create') {
    const name = positionals.join(' ').trim()
    if (!name) throw new CliUsageError('Project name is required.')
    const agentContext = await readAgentContext(options, deps)
    outputValue(
      await client.createProject({
        name,
        description: options.description,
        ...(agentContext === undefined ? {} : { agentContext })
      }),
      options,
      deps
    )
    return
  }
  if (command === 'project' && subcommand === 'update') {
    const selector = positionals.join(' ').trim()
    if (!selector) throw new CliUsageError('Project id or name is required.')
    const agentContext = await readAgentContext(options, deps)
    if (
      options.name === undefined &&
      options.description === undefined &&
      agentContext === undefined
    ) {
      throw new CliUsageError('Project update requires at least one field.')
    }
    const project = await resolveCliProject(client, selector)
    outputValue(
      await client.updateProject(project.id, {
        expectedUpdatedAt: project.updatedAt,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(agentContext === undefined ? {} : { agentContext })
      }),
      options,
      deps
    )
    return
  }
  if (command === 'project' && subcommand === 'session-defaults') {
    const action = positionals[0]
    const selector = positionals.slice(1).join(' ').trim()
    if (!selector) throw new CliUsageError('Project id or name is required.')
    const project = await resolveCliProject(client, selector)
    const current = await client.getProjectSessionDefaults(project.id)
    if (action === 'show') {
      outputValue(current, options, deps)
      return
    }
    if (action !== 'update') {
      throw new CliUsageError('Use project session-defaults show or update.')
    }
    const agent = agentConfigurationPatch(options)
    assertNoClearConflict(options.clearProvider, agent !== undefined, 'the provider default')
    assertNoClearConflict(
      options.clearApprovalProfile,
      options.approvalProfile !== undefined,
      'the approval profile default'
    )
    assertNoClearConflict(
      options.clearAutoReview,
      options.autoReviewEnabled !== undefined,
      'the auto-review default'
    )
    assertNoClearConflict(
      options.clearMemory,
      options.memoryEnabled !== undefined,
      'the Memory default'
    )
    assertNoClearConflict(
      options.clearDelegation,
      options.delegation !== undefined,
      'the delegation default'
    )
    assertNoClearConflict(
      options.clearSpecialist,
      options.specialist !== undefined,
      'the Specialist default'
    )
    const computeHosts = computeHostsPatch(options, current.configured.computeHosts)
    const patch = {
      ...(options.clearProvider
        ? { agentConfiguration: null }
        : agent
          ? { agentConfiguration: agent }
          : {}),
      ...(options.clearApprovalProfile
        ? { permissionProfile: null }
        : options.approvalProfile !== undefined
          ? { permissionProfile: options.approvalProfile }
          : {}),
      ...(options.clearAutoReview
        ? { autoReviewEnabled: null }
        : options.autoReviewEnabled !== undefined
          ? { autoReviewEnabled: options.autoReviewEnabled }
          : {}),
      ...(options.clearMemory
        ? { memoryEnabled: null }
        : options.memoryEnabled !== undefined
          ? { memoryEnabled: options.memoryEnabled }
          : {}),
      ...(options.clearDelegation
        ? { delegationPolicy: null }
        : options.delegation !== undefined
          ? { delegationPolicy: options.delegation }
          : {}),
      ...(options.clearSpecialist
        ? { specialistId: null }
        : options.specialist !== undefined
          ? { specialistId: options.specialist }
          : {}),
      ...(computeHosts !== undefined
        ? { computeHosts: options.clearComputeHosts ? null : computeHosts }
        : {})
    }
    if (Object.keys(patch).length === 0) {
      throw new CliUsageError('Project Session defaults update requires at least one field.')
    }
    outputValue(
      await client.updateProjectSessionDefaults(project.id, {
        expectedUpdatedAt: current.updatedAt,
        patch
      }),
      options,
      deps
    )
    return
  }
  if (command === 'session' && subcommand === 'status') {
    const sessionId = positionals[0]
    if (!sessionId) throw new CliUsageError('Session id is required.')
    outputValue(await client.getSession(sessionId), options, deps)
    return
  }
  if (command === 'session' && subcommand === 'config') {
    const action = positionals[0]
    const sessionId = positionals[1]
    if (!sessionId) throw new CliUsageError('Session id is required.')
    if (action === 'show') {
      outputValue(await client.getSessionConfiguration(sessionId), options, deps)
      return
    }
    if (action !== 'update') throw new CliUsageError('Use session config show or update.')
    if (options.revision === undefined) throw new CliUsageError('--revision is required.')
    const current = await client.getSessionConfiguration(sessionId)
    const computeHosts = computeHostsPatch(options, current.persisted.computeHosts)
    const patch = {
      ...(agentConfigurationPatch(options)
        ? { agentConfiguration: agentConfigurationPatch(options) }
        : {}),
      ...(options.approvalProfile !== undefined
        ? { permissionProfile: options.approvalProfile }
        : {}),
      ...(options.autoReviewEnabled !== undefined
        ? { autoReviewEnabled: options.autoReviewEnabled }
        : {}),
      ...(options.memoryEnabled !== undefined ? { memoryEnabled: options.memoryEnabled } : {}),
      ...(options.delegation !== undefined ? { delegationPolicy: options.delegation } : {}),
      ...(computeHosts !== undefined ? { computeHosts } : {})
    }
    if (Object.keys(patch).length === 0) {
      throw new CliUsageError('Session configuration update requires at least one field.')
    }
    outputValue(
      await client.updateSessionConfiguration(sessionId, {
        expectedRevision: options.revision,
        ...patch
      }),
      options,
      deps
    )
    return
  }
  if (command === 'settings' && subcommand === 'agent-routing') {
    const action = positionals[0]
    if (action === 'show') {
      outputValue(await client.getAgentRouting(), options, deps)
      return
    }
    if (action !== 'update') {
      throw new CliUsageError('Use settings agent-routing show or update.')
    }
    const reviewer = modelRouting(options, 'reviewer')
    const subagent = modelRouting(options, 'subagent')
    const request = {
      ...(options.framework !== undefined ? { framework: options.framework } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(subagent ? { subagent } : {})
    }
    if (Object.keys(request).length === 0) {
      throw new CliUsageError('Agent routing update requires at least one field.')
    }
    outputValue(await client.updateAgentRouting(request), options, deps)
    return
  }
  if (command === 'plan') {
    const sessionId = positionals[0]
    if (!sessionId) throw new CliUsageError('Session id is required.')
    if (subcommand === 'show') {
      outputValue(await client.getSessionPlan(sessionId), options, deps)
      return
    }
    if (subcommand === 'approve' || subcommand === 'reject') {
      if (!options.artifactVersion) {
        throw new CliUsageError('--artifact-version is required.')
      }
      if (options.revision === undefined) {
        throw new CliUsageError('--revision is required.')
      }
      outputValue(
        await client.respondSessionPlan(sessionId, {
          decision: subcommand === 'approve' ? 'approved' : 'rejected',
          artifactVersionId: options.artifactVersion,
          expectedRevision: options.revision
        }),
        options,
        deps
      )
      return
    }
    if (subcommand === 'revise') {
      if (!options.feedback?.trim()) throw new CliUsageError('--feedback is required.')
      outputValue(
        await client.respondSessionPlan(sessionId, { feedback: options.feedback.trim() }),
        options,
        deps
      )
      return
    }
  }
  if (command === 'artifacts' && subcommand === 'list') {
    const sessionId = positionals[0]
    if (!sessionId) throw new CliUsageError('Session id is required.')
    outputValue(await client.listArtifacts(sessionId), options, deps)
    return
  }
  if (command === 'artifacts' && subcommand === 'download') {
    const artifactId = positionals[0]
    if (!artifactId) throw new CliUsageError('Artifact id is required.')
    if (!options.output) throw new CliUsageError('--output is required.')
    const response = await client.downloadArtifact(artifactId)
    await deps.writeDownload(response, options.output)
    outputValue({ artifactId, output: resolve(options.output) }, options, deps)
    return
  }
  if (command === 'run' && subcommand === 'status') {
    const runId = positionals[0]
    if (!runId) throw new CliUsageError('Run id is required.')
    outputValue(await client.getRun(runId), options, deps)
    return
  }
  if (command === 'run' && subcommand === 'cancel') {
    const runId = positionals[0]
    if (!runId) throw new CliUsageError('Run id is required.')
    outputValue(await client.cancelRun(runId), options, deps)
    return
  }
  if (command === 'run') {
    if (!options.project) throw new CliUsageError('--project is required.')
    const projectId = await resolveCliProjectId(client, options.project)
    const prompt = await readPrompt(options, deps)
    if (!prompt) throw new CliUsageError('Prompt is required.')
    const runRef = { current: undefined, pending: [] }
    const abortController = new AbortController()
    const eventStream =
      options.wait && !options.json && typeof client.events === 'function'
        ? client.events({ signal: abortController.signal })
        : undefined
    await eventStream?.ready
    // The event stream only renders progress; waitForRun remains authoritative for the final Run
    // state, so a mid-run stream failure must not fail an otherwise-successful command.
    const eventTask = eventStream
      ? streamRunEvents(eventStream, runRef, options, deps, abortController.signal).catch(
          (error) => {
            if (abortController.signal.aborted) return
            const message = error instanceof Error ? error.message : String(error)
            deps.warn(
              `Run event stream stopped: ${message} Final Run state will still be read from Open Science.`
            )
          }
        )
      : undefined
    let result
    try {
      const started = await client.startRun({
        project: projectId,
        prompt,
        ...(options.cwd ? { cwd: resolve(options.cwd) } : {}),
        ...(options.session ? { sessionId: options.session } : {}),
        ...(options.approvalProfile ? { permissionProfile: options.approvalProfile } : {}),
        ...(options.skills?.length ? { skillIds: options.skills } : {}),
        ...(options.planFirst ? { turnIntent: 'plan-first' } : {}),
        ...(options.autoReviewEnabled !== undefined
          ? { autoReviewEnabled: options.autoReviewEnabled }
          : {}),
        ...(options.specialist ? { specialist: options.specialist } : {}),
        ...(options.delegation ? { delegationPolicy: options.delegation } : {}),
        ...(agentConfigurationPatch(options)
          ? { agentConfiguration: agentConfigurationPatch(options) }
          : {}),
        ...(options.memoryEnabled !== undefined ? { memoryEnabled: options.memoryEnabled } : {}),
        ...(options.clearComputeHosts
          ? { enabledComputeHostIds: [], computeHostIds: [] }
          : {
              ...(options.enabledComputeHosts !== undefined
                ? { enabledComputeHostIds: options.enabledComputeHosts }
                : {}),
              ...(options.computeHosts !== undefined
                ? { computeHostIds: options.computeHosts }
                : {})
            })
      })
      runRef.current = { runId: started.id, sessionId: started.sessionId }
      for (const event of runRef.pending.splice(0)) {
        if (isEventForRun(event, runRef.current)) emitRunEvent(event, options, deps)
      }
      try {
        const waitOptions = {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.returnOnAttention ? { returnOnAttention: true } : {})
        }
        result = options.wait
          ? Object.keys(waitOptions).length === 0
            ? await client.waitForRun(started.id)
            : await client.waitForRun(started.id, waitOptions)
          : started
      } catch (error) {
        if (options.cancelOnTimeout && error?.code === 'timeout') {
          try {
            await client.cancelRun(started.id)
          } catch (cancelError) {
            if (error instanceof Error) {
              if (error.cause === undefined) error.cause = cancelError
              const cancelMessage =
                cancelError instanceof Error ? cancelError.message : String(cancelError)
              error.message = `${error.message} Server run cancellation also failed: ${cancelMessage}`
            }
          }
        }
        throw error
      }
    } finally {
      abortController.abort()
      await eventTask
    }
    if (options.json || options.jsonl) outputValue(result, options, deps)
    else if (result.status === 'completed') deps.log(result.output || `Run completed: ${result.id}`)
    else if (result.status === 'failed') deps.log(`Run failed: ${result.error ?? result.id}`)
    else if (result.status === 'cancelled') deps.log(`Run cancelled: ${result.id}`)
    else if (result.attention?.kind === 'plan-approval') {
      const plan = result.attention.plan
      deps.log(
        `Run is waiting for Plan approval: open-science plan approve ${result.sessionId} --artifact-version ${plan.artifactVersionId} --revision ${plan.revision}`
      )
    } else deps.log(`Run started: ${result.id} (session ${result.sessionId})`)
    if (result.status === 'failed') deps.setExitCode(1)
    return
  }

  throw new CliUsageError(`Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`)
}

export const reportCliError = (error, argv = process.argv.slice(2), dependencies = {}) => {
  const deps = {
    error: (...args) => console.error(...args),
    setExitCode: (code) => {
      process.exitCode = code
    },
    ...dependencies
  }
  const code = error?.code ?? 'command_failed'
  const message = error instanceof Error ? error.message : String(error)
  const exitCode =
    error?.exitCode ??
    (code === 'daemon_unavailable'
      ? 3
      : ['project_not_found', 'session_not_found', 'run_not_found', 'artifact_not_found'].includes(
            code
          ) || code === 'specialist_not_found'
        ? 4
        : 1)
  if (argv.includes('--json') || argv.includes('--jsonl')) {
    deps.error(JSON.stringify({ error: { code, message }, exitCode }))
  } else {
    deps.error(message)
  }
  deps.setExitCode(exitCode)
  return exitCode
}

export const runCli = async (argv = process.argv.slice(2), dependencies = {}) => {
  const parsed = parseCliArgs(argv)
  const { command, options } = parsed
  if (options.help || !command || command === '-h' || command === '--help') {
    console.log(usage)
    return
  }
  if (command === 'start') await startCommand(options)
  else if (command === 'stop') await stopCommand(options)
  else if (command === 'status') await statusCommand(options)
  else if (command === 'url') await urlCommand(options)
  else if (command === 'update') await updateCommand(options, dependencies.update)
  else if (command === 'codex' && parsed.subcommand === 'login') await codexLoginCommand(options)
  else if (command === 'rollback-to-0.7.3') await rollbackCommand(options)
  else if (TASK_COMMANDS.has(command)) await runTaskCommand(parsed)
  else throw new CliUsageError(`Unknown command: ${command}\n\n${usage}`)
}

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  runCli().catch((error) => reportCliError(error))
}

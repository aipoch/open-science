#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { closeSync, openSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { findServiceState, readWebToken, resolveConfigRoot, STATE_FILE } from './config-root.mjs'
import { connectToOpenScience } from './index.mjs'
import { locateApp } from './locate-app.mjs'

const DEFAULT_PORT = 44100
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 15_000

const usage = `Usage: open-science <command> [options]

Commands:
  start       Start the headless backend and localhost web UI
  stop        Gracefully stop the backend
  status      Show backend status
  url         Print the authenticated web URL
  project list
  project create <name> [--description <text>]
  run --project <id-or-name> (--prompt <text> | --prompt-file <path>) [--wait]
  run status <run-id>
  session status <session-id>
  artifacts list <session-id>
  artifacts download <artifact-id> --output <path>

Options:
  --port <port>          Web service port (default: 44100)
  --app-path <path>      Installed Open Science executable
  --config-root <path>   Config directory override
  --project <id-or-name> Project id or exact name
  --session <id>         Resume an existing session
  --prompt <text>        Prompt text (or read stdin when omitted)
  --prompt-file <path>   Read the prompt from a UTF-8 file
  --approval-profile <profile>  ask, auto, or full (default: ask)
  --skill <id>           Force-load a skill for this run (repeatable)
  --wait                 Wait for the run to finish
  --jsonl                Stream machine-readable events, one per line
  --output <path>        Artifact download destination
  --no-open              Do not open the browser after start
  --json                 Emit one machine-readable result
  -h, --help             Show this help`

// Flags that take a value, mapped to their camelCase option key (explicit so new hyphenated flags
// can't collide the way a generic slice/replace would).
const VALUE_OPTIONS = {
  '--port': 'port',
  '--app-path': 'appPath',
  '--config-root': 'configRoot',
  '--project': 'project',
  '--session': 'session',
  '--prompt': 'prompt',
  '--prompt-file': 'promptFile',
  '--approval-profile': 'approvalProfile',
  '--description': 'description',
  '--output': 'output'
}

const TASK_COMMANDS = new Set(['project', 'run', 'session', 'artifacts'])
const GROUP_COMMANDS = new Set(['project', 'session', 'artifacts'])

export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliUsageError'
    this.code = 'invalid_cli_usage'
    this.exitCode = 2
  }
}

export const parseCliArgs = (argv) => {
  const args = [...argv]
  const command = args.shift()
  const subcommand =
    GROUP_COMMANDS.has(command) || (command === 'run' && args[0] === 'status')
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
    else if (arg === '--json') options.json = true
    else if (arg === '--jsonl') options.jsonl = true
    else if (arg === '--wait') options.wait = true
    else if (arg === '--skill') {
      const value = args.shift()
      if (!value) throw new CliUsageError('--skill requires a value.')
      options.skills = [...(options.skills ?? []), value]
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
    const port = Number.parseInt(options.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CliUsageError(`Invalid port: ${options.port}`)
    }
    options.port = port
  }
  if (options.approvalProfile && !['ask', 'auto', 'full'].includes(options.approvalProfile)) {
    throw new CliUsageError(`Invalid approval profile: ${options.approvalProfile}`)
  }
  if (options.json && options.jsonl) {
    throw new CliUsageError('Use only one of --json or --jsonl.')
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

const waitForState = async (configRoot, deps = DEFAULT_DEPS, timeoutMs = START_TIMEOUT_MS) => {
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    const state = await deps.findServiceState({ override: configRoot })
    if (await healthCheck(state, deps)) return state
    await deps.sleep(250)
  }
  return undefined
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

// Force-kills the daemon's entire process tree after graceful shutdown failed. The daemon is spawned
// detached, so on POSIX it leads its own process group: negating the PID signals the whole group
// (agent/Notebook children included), and SIGKILL is required because the graceful SIGTERM was ignored.
const forceKillTree = (pid) => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Group already gone or never formed: fall back to the lone leader.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already dead.
    }
  }
}

// The real I/O the commands use, bundled so tests can substitute fakes. Declared after the helpers it
// references so its initializer sees them; commands take `deps = DEFAULT_DEPS`, so production callers
// pass nothing and get these.
const DEFAULT_DEPS = {
  findServiceState: (options) => findServiceState(options),
  readWebToken: (configRoot) => readWebToken(configRoot),
  isAlive: isProcessAlive,
  forceKill: forceKillTree,
  removeState: (configRoot) => removeStateFiles(configRoot),
  fetch: (input, init) => fetch(input, init),
  sleep,
  now: () => Date.now(),
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args)
}

// Waits for the daemon to exit gracefully, then force-kills its process tree and verifies the process
// is actually gone. Returns true iff it stopped. The caller sends the graceful shutdown request first;
// all timing/kill primitives are injected so the escalation path is testable without real processes.
export const terminateDaemon = async (pid, opts) => {
  const {
    isAlive,
    forceKill,
    sleep: sleepFn,
    now,
    gracefulTimeoutMs,
    killTimeoutMs,
    onForceKill
  } = opts
  const deadline = now() + gracefulTimeoutMs
  while (now() < deadline && isAlive(pid)) await sleepFn(250)
  if (!isAlive(pid)) return true

  onForceKill?.()
  forceKill(pid)
  const killDeadline = now() + killTimeoutMs
  while (now() < killDeadline && isAlive(pid)) await sleepFn(250)
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

const startCommand = async (options, deps = DEFAULT_DEPS) => {
  const existing = await deps.findServiceState({ override: options.configRoot })
  if (await healthCheck(existing, deps)) {
    const url = await authenticatedUrl(existing, deps)
    deps.log(`Open Science is already running (PID ${existing.pid}).`)
    if (options.open) openBrowser(url)
    else deps.log('Run "open-science url" to print a browser login URL.')
    return
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
  const logFd = openSync(logPath, 'a')
  const port = options.port ?? DEFAULT_PORT
  // `--open-science-headless` instead of `--headless`: Chromium consumes `--headless` and renders
  // native menus (like the tray context menu) invisibly on Windows (electron/electron#48982).
  const childEnv = {
    ...process.env,
    ...(app.packaged ? {} : { OPEN_SCIENCE_STORAGE_ROOT: configRoot }),
    OPEN_SCIENCE_WEB_PORT: String(port)
  }
  // The installed launcher runs this CLI via the app's Electron in Node mode (ELECTRON_RUN_AS_NODE=1).
  // Drop it here so the daemon we spawn starts as the normal Electron app, not another Node process.
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(app.command, [...app.args, '--open-science-headless', `--serve=${port}`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: childEnv
  })
  child.unref()
  closeSync(logFd)

  const state = await waitForState(configRoot, deps)
  if (!state) {
    const logTail = await readLogTail(logPath)
    throw new Error(
      `Open Science did not become healthy within ${START_TIMEOUT_MS / 1000}s.${logTail ? `\n\n${logTail}` : ''}`
    )
  }
  const url = await authenticatedUrl(state, deps)
  deps.log(`Open Science started (PID ${state.pid}).`)
  if (options.open) openBrowser(url)
  else deps.log('Run "open-science url" to print a browser login URL.')
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
  try {
    const response = await deps.fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await response.arrayBuffer()
  } catch (error) {
    deps.warn(`Graceful shutdown failed: ${error.message}`)
  }

  // Attached: the web service rides on the running desktop app. A graceful request stops only the web
  // service; the app stays up. Never fall through to force-killing — that pid is the user's app.
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
    forceKill: deps.forceKill,
    sleep: deps.sleep,
    now: deps.now,
    gracefulTimeoutMs: STOP_TIMEOUT_MS,
    killTimeoutMs: 2_000,
    onForceKill: () => deps.warn('Graceful shutdown timed out; force-killing the process tree.')
  })
  // Only claim success (and drop the state file) once the process is confirmed gone; otherwise leave
  // the state in place and fail loudly so the user isn't told it stopped when it didn't.
  if (!stopped) {
    throw new Error(`Could not stop Open Science (PID ${state.pid}); it is still running.`)
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

const writeDownload = async (response, output) => {
  if (!response.body) throw new Error('Artifact download returned no data.')
  await pipeline(Readable.fromWeb(response.body), createWriteStream(output))
}

const TASK_DEPS = {
  connect: (options) => connectToOpenScience(options),
  readFile: (path) => readFile(path, 'utf8'),
  readStdin: () => readFile(0, 'utf8'),
  writeDownload,
  log: (...args) => console.log(...args),
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

const emitRunEvent = (event, options, deps) => {
  if (options.jsonl) {
    deps.log(JSON.stringify(event))
  } else if (
    event.type === 'run.event' &&
    event.data?.kind !== 'message' &&
    (event.data?.title || event.data?.text)
  ) {
    deps.log(event.data.title ?? event.data.text)
  }
}

const streamRunEvents = async (eventStream, sessionIdRef, options, deps, signal) => {
  try {
    for await (const event of eventStream) {
      const eventSessionId = event?.data?.sessionId
      if (!sessionIdRef.current) {
        sessionIdRef.pending.push(event)
        continue
      }
      if (eventSessionId && eventSessionId !== sessionIdRef.current) continue
      emitRunEvent(event, options, deps)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
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
    outputValue(
      await client.createProject({ name, description: options.description }),
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
  if (command === 'run') {
    if (!options.project) throw new CliUsageError('--project is required.')
    const prompt = await readPrompt(options, deps)
    if (!prompt) throw new CliUsageError('Prompt is required.')
    const sessionIdRef = { current: options.session, pending: [] }
    const abortController = new AbortController()
    const eventStream =
      options.wait && !options.json && typeof client.events === 'function'
        ? client.events({ signal: abortController.signal })
        : undefined
    await eventStream?.ready
    const eventTask = eventStream
      ? streamRunEvents(eventStream, sessionIdRef, options, deps, abortController.signal)
      : undefined
    let result
    try {
      const started = await client.startRun({
        project: options.project,
        prompt,
        ...(options.session ? { sessionId: options.session } : {}),
        ...(options.approvalProfile ? { permissionProfile: options.approvalProfile } : {}),
        ...(options.skills?.length ? { skillIds: options.skills } : {})
      })
      sessionIdRef.current = started.sessionId
      for (const event of sessionIdRef.pending.splice(0)) {
        const eventSessionId = event?.data?.sessionId
        if (!eventSessionId || eventSessionId === sessionIdRef.current) {
          emitRunEvent(event, options, deps)
        }
      }
      result = options.wait ? await client.waitForRun(started.id) : started
    } finally {
      abortController.abort()
      await eventTask
    }
    if (options.json || options.jsonl) outputValue(result, options, deps)
    else if (result.status === 'completed') deps.log(result.output || `Run completed: ${result.id}`)
    else if (result.status === 'failed') deps.log(`Run failed: ${result.error ?? result.id}`)
    else deps.log(`Run started: ${result.id} (session ${result.sessionId})`)
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
          )
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

export const runCli = async (argv = process.argv.slice(2)) => {
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
  else if (TASK_COMMANDS.has(command)) await runTaskCommand(parsed)
  else throw new CliUsageError(`Unknown command: ${command}\n\n${usage}`)
}

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  runCli().catch((error) => reportCliError(error))
}

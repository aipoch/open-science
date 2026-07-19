#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { findServiceState, readWebToken, resolveConfigRoot, STATE_FILE } from './config-root.mjs'
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

Options:
  --port <port>          Web service port (default: 44100)
  --app-path <path>      Installed Open Science executable
  --config-root <path>   Config directory override
  --no-open              Do not open the browser after start
  --json                 Machine-readable output for status
  -h, --help             Show this help`

// Flags that take a value, mapped to their camelCase option key (explicit so new hyphenated flags
// can't collide the way a generic slice/replace would).
const VALUE_OPTIONS = {
  '--port': 'port',
  '--app-path': 'appPath',
  '--config-root': 'configRoot'
}

export const parseCliArgs = (argv) => {
  const args = [...argv]
  const command = args.shift()
  const options = { open: true, json: false }
  while (args.length > 0) {
    const arg = args.shift()
    if (arg === '--no-open') options.open = false
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (Object.hasOwn(VALUE_OPTIONS, arg)) {
      const value = args.shift()
      if (!value) throw new Error(`${arg} requires a value.`)
      options[VALUE_OPTIONS[arg]] = value
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (options.port !== undefined) {
    const port = Number.parseInt(options.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${options.port}`)
    }
    options.port = port
  }
  return { command, options }
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
    deps.log(url)
    if (options.open) openBrowser(url)
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
  deps.log(url)
  if (options.open) openBrowser(url)
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
    deps.log(
      JSON.stringify(
        running
          ? { running: true, ...state, url: await authenticatedUrl(state, deps) }
          : { running: false },
        null,
        2
      )
    )
  } else if (running) {
    deps.log(`Open Science is running (PID ${state.pid}, port ${state.port}).`)
    deps.log(await authenticatedUrl(state, deps))
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

export const runCli = async (argv = process.argv.slice(2)) => {
  const { command, options } = parseCliArgs(argv)
  if (options.help || !command || command === '-h' || command === '--help') {
    console.log(usage)
    return
  }
  if (command === 'start') await startCommand(options)
  else if (command === 'stop') await stopCommand(options)
  else if (command === 'status') await statusCommand(options)
  else if (command === 'url') await urlCommand(options)
  else throw new Error(`Unknown command: ${command}\n\n${usage}`)
}

const isEntryPoint =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

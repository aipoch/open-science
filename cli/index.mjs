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

export const parseCliArgs = (argv) => {
  const args = [...argv]
  const command = args.shift()
  const options = { open: true, json: false }
  while (args.length > 0) {
    const arg = args.shift()
    if (arg === '--no-open') options.open = false
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--port' || arg === '--app-path' || arg === '--config-root') {
      const value = args.shift()
      if (!value) throw new Error(`${arg} requires a value.`)
      options[arg.slice(2).replace('-p', 'P').replace('-r', 'R')] = value
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

const authenticatedUrl = async (state) => {
  const token = await readWebToken(state.configRoot)
  return `http://127.0.0.1:${state.port}/?token=${encodeURIComponent(token)}`
}

const healthCheck = async (state) => {
  if (!state || !isProcessAlive(state.pid)) return false
  try {
    const token = await readWebToken(state.configRoot)
    const response = await fetch(`http://127.0.0.1:${state.port}/api/bootstrap`, {
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

const waitForState = async (configRoot, timeoutMs = START_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await findServiceState({ override: configRoot })
    if (await healthCheck(state)) return state
    await sleep(250)
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

const readLogTail = async (logPath) => {
  try {
    const text = await readFile(logPath, 'utf8')
    return text.split(/\r?\n/).slice(-30).join('\n')
  } catch {
    return ''
  }
}

const startCommand = async (options) => {
  const existing = await findServiceState({ override: options.configRoot })
  if (await healthCheck(existing)) {
    const url = await authenticatedUrl(existing)
    console.log(`Open Science is already running (PID ${existing.pid}).`)
    console.log(url)
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
  await removeStateFiles(configRoot)

  const logPath = join(configRoot, 'cli-daemon.log')
  const logFd = openSync(logPath, 'a')
  const port = options.port ?? DEFAULT_PORT
  // `--open-science-headless` instead of `--headless`: Chromium consumes `--headless` and renders
  // native menus (like the tray context menu) invisibly on Windows (electron/electron#48982).
  const child = spawn(app.command, [...app.args, '--open-science-headless', `--serve=${port}`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      ...(app.packaged ? {} : { OPEN_SCIENCE_STORAGE_ROOT: configRoot }),
      OPEN_SCIENCE_WEB_PORT: String(port)
    }
  })
  child.unref()
  closeSync(logFd)

  const state = await waitForState(configRoot)
  if (!state) {
    const logTail = await readLogTail(logPath)
    throw new Error(
      `Open Science did not become healthy within ${START_TIMEOUT_MS / 1000}s.${logTail ? `\n\n${logTail}` : ''}`
    )
  }
  const url = await authenticatedUrl(state)
  console.log(`Open Science started (PID ${state.pid}).`)
  console.log(url)
  if (options.open) openBrowser(url)
}

const findCurrentState = async (options) => {
  const state = await findServiceState({ override: options.configRoot })
  if (!state) return undefined
  if (!isProcessAlive(state.pid)) {
    await removeStateFiles(state.configRoot)
    return undefined
  }
  return state
}

const stopCommand = async (options) => {
  const state = await findCurrentState(options)
  if (!state) {
    console.log('Open Science is not running.')
    return
  }
  const token = await readWebToken(state.configRoot)
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await response.arrayBuffer()
  } catch (error) {
    console.warn(`Graceful shutdown failed: ${error.message}`)
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline && isProcessAlive(state.pid)) await sleep(250)
  if (isProcessAlive(state.pid)) {
    console.warn('Graceful shutdown timed out; terminating the process tree.')
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(state.pid, 'SIGTERM')
    }
  }
  await removeStateFiles(state.configRoot)
  console.log('Open Science stopped.')
}

const statusCommand = async (options) => {
  const state = await findCurrentState(options)
  const running = await healthCheck(state)
  if (options.json) {
    console.log(
      JSON.stringify(
        running
          ? { running: true, ...state, url: await authenticatedUrl(state) }
          : { running: false },
        null,
        2
      )
    )
  } else if (running) {
    console.log(`Open Science is running (PID ${state.pid}, port ${state.port}).`)
    console.log(await authenticatedUrl(state))
  } else {
    console.log('Open Science is not running.')
  }
  if (!running) process.exitCode = 1
}

const urlCommand = async (options) => {
  const state = await findCurrentState(options)
  if (!(await healthCheck(state))) throw new Error('Open Science is not running.')
  console.log(await authenticatedUrl(state))
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

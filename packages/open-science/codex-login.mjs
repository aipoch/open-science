/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

import { resolveConfigRoot } from './config-root.mjs'
import { locateApp } from './locate-app.mjs'

const CODEX_CONFIG_OVERRIDE = 'cli_auth_credentials_store="file"'
const CODEX_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_CONFIG',
  'CODEX_HOME',
  'CODEX_PATH',
  'DEFAULT_AUTH_REQUEST',
  'HOME',
  'MODEL_PROVIDER',
  'NO_BROWSER',
  'USERPROFILE'
]

export class CodexLoginError extends Error {
  constructor(message, code = 'codex_login_failed', exitCode = 1) {
    super(message)
    this.name = 'CodexLoginError'
    this.code = code
    this.exitCode = exitCode
  }
}

export const createCodexLoginEnvironment = (
  codexHome,
  sourceEnv = process.env,
  platform = process.platform
) => {
  const env = { ...sourceEnv }
  for (const key of CODEX_ENV_KEYS) delete env[key]
  env.CODEX_HOME = codexHome
  env.HOME = codexHome
  if (platform === 'win32') env.USERPROFILE = codexHome
  return env
}

export const resolveConfiguredCodexNativePath = async (configRoot, dependencies = {}) => {
  const deps = {
    readFile: (path) => readFile(path, 'utf8'),
    access: (path) => access(path),
    ...dependencies
  }
  let settings
  try {
    settings = JSON.parse(await deps.readFile(join(configRoot, 'settings.json')))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CodexLoginError(
        'Codex is not configured for this Open Science profile. Configure the Codex runtime first.',
        'codex_not_configured'
      )
    }
    throw new CodexLoginError(
      'Open Science could not read the configured Codex runtime.',
      'codex_configuration_invalid'
    )
  }

  const nativePath =
    typeof settings?.codex?.nativePath === 'string' ? settings.codex.nativePath.trim() : ''
  if (!nativePath || !isAbsolute(nativePath)) {
    throw new CodexLoginError(
      'The configured Codex runtime has no native CLI path. Repair the Codex installation first.',
      'codex_not_configured'
    )
  }

  const resolvedPath = normalize(nativePath)
  try {
    await deps.access(resolvedPath)
  } catch {
    throw new CodexLoginError(
      'The configured Codex CLI does not exist: ' + resolvedPath,
      'codex_not_found'
    )
  }
  return resolvedPath
}

export const runCodexProcess = (codexPath, args, options = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexPath)
    const child = spawn(needsShell ? '"' + codexPath + '"' : codexPath, args, {
      env: options.env,
      shell: needsShell,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    if (!options.inherit) {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
    }
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })

const DEFAULT_DEPS = {
  locateApp: (options) => locateApp(options),
  resolveConfigRoot: (options) => resolveConfigRoot(options),
  resolveNativePath: (configRoot) => resolveConfiguredCodexNativePath(configRoot),
  mkdir: (path) => mkdir(path, { recursive: true }),
  runCodex: runCodexProcess,
  log: (...args) => console.log(...args)
}

export const codexLoginCommand = async (options, dependencies = {}) => {
  const deps = { ...DEFAULT_DEPS, ...dependencies }
  const app = await deps.locateApp({ appPath: options.appPath })
  if (app.packaged && options.configRoot) {
    throw new CodexLoginError(
      '--config-root is only supported for development builds.',
      'invalid_cli_usage',
      2
    )
  }
  const configRoot = deps.resolveConfigRoot({
    packaged: app.packaged,
    override: options.configRoot,
    env: app.packaged ? {} : process.env
  })
  const codexPath = await deps.resolveNativePath(configRoot)
  const codexHome = join(configRoot, 'codex-subscription')
  await deps.mkdir(codexHome)
  const env = createCodexLoginEnvironment(codexHome)
  const baseArgs = ['-c', CODEX_CONFIG_OVERRIDE, 'login']

  if (!options.force) {
    const status = await deps.runCodex(codexPath, [...baseArgs, 'status'], {
      env,
      inherit: false
    })
    if (status.code === 0) {
      deps.log(
        'Codex is already signed in for Open Science. Use "open-science codex login --force" to sign in again.'
      )
      return
    }
    if (status.code !== 1 || status.signal) {
      throw new CodexLoginError('Open Science could not check the existing Codex sign-in.')
    }
  }

  deps.log('Starting Codex device-code sign-in. Keep this terminal open until it completes...')
  const login = await deps.runCodex(codexPath, [...baseArgs, '--device-auth'], {
    env,
    inherit: true
  })
  if (login.code !== 0 || login.signal) {
    const suffix = login.signal ? ' after receiving ' + login.signal : ''
    throw new CodexLoginError(
      'Codex device-code sign-in did not complete' + suffix + '.',
      'codex_login_failed',
      login.code ?? 1
    )
  }
  deps.log('Codex is signed in for Open Science.')
}

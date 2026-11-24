/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join, normalize, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { findStandaloneInstallation, repairStandaloneMcp } from './mcp-archive-repair.mjs'

import { connectToOpenScience } from './index.mjs'
import { locateApp } from './locate-app.mjs'

export const MCP_DEPENDENCY_NAME = '@modelcontextprotocol/sdk'
const MCP_ENTRY = `${MCP_DEPENDENCY_NAME}/server/mcp.js`
const npmExecFile = promisify(execFile)
const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const DESKTOP_REPAIR_TIMEOUT_MS = 120_000
const DESKTOP_REPAIR_POLL_MS = 250

const defaultResolve = () => createRequire(import.meta.url).resolve(MCP_ENTRY)

export const checkMcpDependency = async ({ resolve = defaultResolve } = {}) => {
  try {
    resolve()
    return { available: true, dependency: MCP_DEPENDENCY_NAME }
  } catch {
    return { available: false, dependency: MCP_DEPENDENCY_NAME }
  }
}

export const buildMcpDependencyDiagnostic = ({
  configRoot,
  platform = process.platform,
  arch = process.arch,
  installation = 'unknown'
}) => ({
  code: 'mcp_dependency_missing',
  message: 'The Open-Science MCP runtime dependency is missing from this installation.',
  owner: 'deployment',
  dependency: MCP_DEPENDENCY_NAME,
  installation,
  platform,
  arch,
  ...(configRoot ? { profile: configRoot } : {}),
  requiresUser: true,
  retryable: false,
  next: [
    {
      action: 'repair_mcp',
      executable: 'open-science',
      argv: ['repair', 'mcp', '--profile', configRoot ?? '<profile>', '--json']
    }
  ]
})

export const createMcpDependencyError = (context = {}) => {
  const details = buildMcpDependencyDiagnostic(context)
  const error = new Error(details.message)
  error.name = 'McpDependencyError'
  error.code = details.code
  error.details = details
  error.exitCode = 1
  return error
}

export const isMissingMcpDependency = (error) =>
  error?.code === 'ERR_MODULE_NOT_FOUND' &&
  String(error?.message ?? '').includes(MCP_DEPENDENCY_NAME)

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export const findNpmInstallation = async ({
  cliPath = fileURLToPath(import.meta.url),
  readManifest = readJson
} = {}) => {
  let directory = normalize(dirname(cliPath))
  while (true) {
    try {
      const manifest = await readManifest(join(directory, 'package.json'))
      const scope = dirname(directory)
      const nodeModules = dirname(scope)
      if (
        manifest.name === '@aipoch/open-science' &&
        basename(scope) === '@aipoch' &&
        basename(nodeModules) === 'node_modules'
      ) {
        return {
          kind: 'npm',
          packageRoot: directory,
          prefix: dirname(nodeModules),
          version: manifest.version
        }
      }
    } catch {
      // Continue walking until the package root or filesystem root.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export const findMcpInstallation = async ({
  cliPath = fileURLToPath(import.meta.url),
  platform = process.platform,
  arch = process.arch,
  findNpm = findNpmInstallation,
  locateDesktop = ({ env = process.env } = {}) => locateApp({ env }),
  env = process.env
} = {}) =>
  (async () => {
    const archive = await findStandaloneInstallation({ cliPath, platform, arch })
    if (archive) return archive
    const npm = await findNpm({ cliPath })
    if (npm) return npm
    try {
      const desktop = await locateDesktop({ env })
      if (!desktop?.packaged || typeof desktop.command !== 'string') return undefined
      return { kind: 'desktop', executable: desktop.command }
    } catch {
      return undefined
    }
  })()

const samePath = (left, right, platform = process.platform) => {
  const path = platform === 'win32' || /^[A-Za-z]:[\\/]/.test(left) ? win32 : posix
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
}

const repairFailure = ({
  profile,
  installation,
  platform,
  arch,
  code,
  message,
  retryable = false,
  targetVersion,
  executable,
  cause
}) => ({
  status: 'failed',
  installation,
  ...(executable ? { executable } : {}),
  ...(targetVersion ? { targetVersion } : {}),
  platform,
  arch,
  profile,
  error: {
    code,
    message,
    owner: 'deployment',
    requiresUser: true,
    retryable,
    ...(cause instanceof Error ? { detail: cause.message } : {})
  }
})

const nextMcpResponse = async (iterator, timeoutMs) => {
  let timer
  try {
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP handshake timed out.')), timeoutMs)
      })
    ])
    if (next.done) throw new Error('MCP closed before completing its handshake.')
    try {
      return JSON.parse(next.value)
    } catch {
      throw new Error('MCP emitted a non-JSON-RPC stdout line.')
    }
  } finally {
    clearTimeout(timer)
  }
}

export const verifyMcpConnection = async ({
  profile,
  cliPath = fileURLToPath(import.meta.url),
  entryPath = join(dirname(cliPath), 'cli.mjs'),
  spawnProcess = spawn,
  timeoutMs = 30_000,
  env = process.env
} = {}) => {
  const child = spawnProcess(process.execPath, [entryPath, 'mcp', '--profile', profile], {
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stderr?.resume()
  const output = createInterface({ input: child.stdout })
  const iterator = output[Symbol.asyncIterator]()
  const request = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }
  const notification = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  const close = async () => {
    output.close()
    child.stdin.end()
    if (!child.killed) child.kill()
  }
  try {
    request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'open-science-repair', version: '1.0.0' }
    })
    const initialized = await nextMcpResponse(iterator, timeoutMs)
    if (initialized?.id !== 1 || initialized.error || !initialized.result)
      throw new Error('MCP initialize failed.')
    notification('notifications/initialized', {})
    request(2, 'tools/list', {})
    const tools = await nextMcpResponse(iterator, timeoutMs)
    if (tools?.id !== 2 || tools.error || !Array.isArray(tools.result?.tools))
      throw new Error('MCP tools/list failed.')
    return { initialize: true, toolsList: true, toolCount: tools.result.tools.length }
  } finally {
    await close()
  }
}

const isRetryableApplyFailure = (error) =>
  !['invalid_request', 'method_not_found', 'unsupported_capability', 'command-failed'].includes(
    error?.code
  )

const waitForDesktopReplacement = async ({
  profile,
  targetVersion,
  platform,
  connect,
  sleep,
  timeoutMs
}) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const client = await connect({ configRoot: profile })
      if (!samePath(client.configRoot ?? profile, profile, platform))
        return { profileMismatch: true }
      const info = await client.callRpc('update:get-app-info')
      if (info?.version === targetVersion) return { client, info }
      lastError = new Error(`The desktop remained on version ${info?.version ?? 'unknown'}.`)
    } catch (error) {
      lastError = error
    }
    await sleep(Math.min(DESKTOP_REPAIR_POLL_MS, Math.max(1, deadline - Date.now())))
  }
  throw lastError ?? new Error('The updated desktop did not become ready.')
}

export const repairDesktopMcp = async ({
  profile,
  installation,
  cliPath = fileURLToPath(import.meta.url),
  platform = process.platform,
  arch = process.arch,
  connect = connectToOpenScience,
  verifyMcp = verifyMcpConnection,
  sleep = defaultSleep,
  timeoutMs = DESKTOP_REPAIR_TIMEOUT_MS
} = {}) => {
  const base = {
    profile,
    installation: 'desktop',
    platform,
    arch,
    executable: installation?.executable
  }
  let client
  try {
    client = await connect({ configRoot: profile })
  } catch (cause) {
    return repairFailure({
      ...base,
      code: 'mcp_repair_service_unavailable',
      message: 'The selected desktop Profile is not running.',
      retryable: true,
      cause
    })
  }
  if (!samePath(client.configRoot ?? profile, profile, platform))
    return repairFailure({
      ...base,
      code: 'mcp_repair_profile_mismatch',
      message: 'The desktop service is running with a different Profile; no update was started.'
    })

  let checked
  try {
    checked = await client.callRpc('update:check')
  } catch (cause) {
    return repairFailure({
      ...base,
      code: 'mcp_repair_update_unavailable',
      message:
        'The official desktop updater is unavailable; the existing installation was not changed.',
      cause
    })
  }
  if (!checked?.latest || checked.state === 'error')
    return repairFailure({
      ...base,
      code: 'mcp_repair_update_unavailable',
      message:
        'No verified official desktop update is available; the existing installation was not changed.'
    })

  let downloaded
  try {
    downloaded = await client.callRpc('update:download', [{ nonInteractive: true }])
  } catch (cause) {
    return repairFailure({
      ...base,
      targetVersion: checked.latest,
      code: 'mcp_repair_update_failed',
      message:
        'The official desktop update failed before activation; the existing installation was preserved.',
      cause
    })
  }
  const targetVersion = downloaded?.latest ?? checked.latest
  if (downloaded?.state !== 'ready')
    return repairFailure({
      ...base,
      targetVersion,
      code: 'mcp_repair_update_failed',
      message: 'The official desktop update was not verified and was not activated.'
    })

  let applyError
  try {
    const applied = await client.callRpc('update:apply', [{ relaunch: true }])
    if (applied?.state === 'error')
      applyError = Object.assign(new Error(applied.error ?? 'Desktop update failed.'), {
        code: 'command-failed'
      })
  } catch (cause) {
    applyError = cause
  }
  if (applyError && !isRetryableApplyFailure(applyError))
    return repairFailure({
      ...base,
      targetVersion,
      code: 'mcp_repair_update_failed',
      message:
        'The official desktop updater rejected the replacement; the existing installation was preserved.',
      cause: applyError
    })

  let replacement
  try {
    replacement = await waitForDesktopReplacement({
      profile,
      targetVersion,
      platform,
      connect,
      sleep,
      timeoutMs
    })
  } catch (cause) {
    return repairFailure({
      ...base,
      targetVersion,
      code: 'mcp_repair_update_failed',
      message:
        'The verified desktop replacement did not become active; the existing installation was preserved.',
      retryable: true,
      cause
    })
  }
  if (replacement.profileMismatch)
    return repairFailure({
      ...base,
      targetVersion,
      code: 'mcp_repair_profile_mismatch',
      message: 'The desktop replacement selected a different Profile; repair was not confirmed.'
    })

  let verification
  try {
    verification = await verifyMcp({ profile, cliPath })
  } catch (cause) {
    return repairFailure({
      ...base,
      targetVersion,
      code: 'mcp_repair_verification_failed',
      message:
        'The desktop replacement started, but MCP initialize/tools/list verification failed.',
      cause
    })
  }
  return {
    status: 'repaired',
    installation: 'desktop',
    executable: installation?.executable,
    version: targetVersion,
    platform,
    arch,
    profile,
    verification
  }
}

export const repairNpmMcp = async ({
  profile,
  cliPath = fileURLToPath(import.meta.url),
  platform = process.platform,
  arch = process.arch,
  checkDependency = checkMcpDependency,
  exec = npmExecFile,
  verifyMcp = verifyMcpConnection
} = {}) => {
  const installation = await findNpmInstallation({ cliPath })
  const context = { configRoot: profile, platform, arch, installation: 'npm' }
  const before = await checkDependency()
  if (before.available) {
    return {
      status: 'already_healthy',
      installation: installation?.kind ?? 'npm',
      version: installation?.version,
      platform,
      arch,
      profile
    }
  }
  if (!installation) {
    return {
      status: 'failed',
      profile,
      platform,
      arch,
      error: {
        code: 'mcp_repair_unsupported_installation',
        message: 'This installation is not an npm distribution. Use its official updater.',
        owner: 'deployment',
        requiresUser: true,
        retryable: false
      }
    }
  }
  try {
    await exec(
      platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--global', '@aipoch/open-science@latest', '--include=optional'],
      { cwd: installation.prefix, windowsHide: true }
    )
  } catch {
    return {
      status: 'failed',
      installation: installation.kind,
      version: installation.version,
      platform,
      arch,
      profile,
      error: {
        code: 'mcp_repair_failed',
        message: 'The official npm upgrade failed; the existing installation was not activated.',
        owner: 'deployment',
        requiresUser: true,
        retryable: false,
        next: [
          {
            action: 'repair_mcp',
            executable: 'open-science',
            argv: ['repair', 'mcp', '--profile', profile, '--json']
          }
        ]
      }
    }
  }
  const after = await checkDependency()
  if (!after.available) {
    return {
      status: 'failed',
      installation: installation.kind,
      version: installation.version,
      platform,
      arch,
      profile,
      error: buildMcpDependencyDiagnostic(context)
    }
  }
  let verification
  try {
    verification = await verifyMcp({ profile, cliPath })
  } catch (cause) {
    return {
      status: 'failed',
      installation: installation.kind,
      version: installation.version,
      platform,
      arch,
      profile,
      error: {
        code: 'mcp_repair_verification_failed',
        message:
          'The repaired npm installation did not pass MCP initialize/tools/list verification.',
        owner: 'deployment',
        requiresUser: true,
        retryable: false,
        detail: cause instanceof Error ? cause.message : undefined
      }
    }
  }
  return {
    status: 'repaired',
    installation: installation.kind,
    version: installation.version,
    platform,
    arch,
    profile,
    verification
  }
}

export const repairMcp = async (options = {}) => {
  const installation = await findMcpInstallation(options)
  if (installation?.kind === 'archive')
    return repairStandaloneMcp({
      ...options,
      installation,
      checkDependency: options.checkDependency ?? checkMcpDependency
    })
  if (installation?.kind === 'npm') return repairNpmMcp({ ...options, installation })
  if (installation?.kind === 'desktop') return repairDesktopMcp({ ...options, installation })
  return repairFailure({
    profile: options.profile,
    installation: 'unknown',
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    code: 'mcp_repair_unsupported_installation',
    message: 'This installation has no supported official MCP repair channel.'
  })
}

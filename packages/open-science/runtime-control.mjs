/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { candidateConfigRoots, readWebToken } from './config-root.mjs'

const exec = promisify(execFile)
const canonicalRoot = async (path) => {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('The local service did not provide an absolute Config Root.')
  const canonical = normalize(await realpath(path))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export async function verifyServiceConfigRoot(requested, actual) {
  if ((await canonicalRoot(requested)) !== (await canonicalRoot(actual)))
    throw new Error(
      'The local service belongs to a different Config Root. Use its original App or the correct --config-root to stop it.'
    )
}

const validStartupOptions = (value) =>
  value &&
  ['configRoot', 'dataRoot', 'profilePath'].every(
    (key) => typeof value[key] === 'string' && isAbsolute(value[key])
  ) &&
  Number.isInteger(value.port) &&
  value.port >= 0 &&
  value.port <= 65535 &&
  value.host === '127.0.0.1' &&
  ['os', 'file'].includes(value.credentialStore) &&
  (value.passwordStore === undefined ||
    (typeof value.passwordStore === 'string' &&
      value.passwordStore.length > 0 &&
      value.passwordStore.length <= 100))

async function verifyOwnerRoot(owner, record, configRoot) {
  if (!validStartupOptions(owner.startupOptions) || !isGeneration(owner.desktopGeneration))
    throw new Error(
      'This service cannot prove its Config Root. Stop it from its original App or use a service with verified ownership.'
    )
  if (
    !record.desktop ||
    owner.desktopGeneration !== record.desktop.generation ||
    (owner.lifetime && owner.desktopGeneration !== owner.lifetime.generation)
  )
    throw new Error('The local service desktop generation changed.')
  if (
    typeof record.desktop.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(record.desktop.version)
  )
    throw new Error('The recorded local service version is invalid.')
  await verifyServiceConfigRoot(configRoot, owner.startupOptions.configRoot)
}

// Ordinary Node can read Linux/Windows birth identities without loading any service-supplied JS.
// Darwin's native unique-id probe is unavailable to the lightweight CLI; remain conservative.
async function readProcessBirth(identity, timeoutMs) {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8')
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      return /^\d+$/.test(start ?? '') ? `linux-proc-starttime:${start}` : undefined
    }
    if (process.platform === 'win32') {
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${identity.pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToFileTimeUtc()`
        ],
        { timeout: Math.max(1, Math.min(2000, timeoutMs)), windowsHide: true }
      )
      const value = stdout.trim()
      return /^\d+$/.test(value) ? `windows-creation-time:${value}` : undefined
    }
  } catch {
    /* Missing/unreadable identity is not proof of process exit. */
  }
}

export async function waitForServiceStopped(service, options) {
  const { identity } = service
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pid !== service.pid ||
    identity.generation !== service.generation ||
    identity.serviceGeneration !== service.lifetime.generation
  )
    return { stopped: false, reason: 'identity-unverified' }
  const {
    isAlive,
    now,
    sleep,
    timeoutMs,
    readBirth = readProcessBirth,
    readOwner = (root) => readFile(join(root, 'runtime-owner.json'), 'utf8')
  } = options
  const deadline = now() + timeoutMs
  const observe = async (action) => {
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(new Error('Stop confirmation deadline expired.'), {
                  code: 'service-stop-timeout'
                })
              ),
            Math.max(0, deadline - now())
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  while (isAlive(identity.pid)) {
    const remaining = deadline - now()
    if (remaining <= 0) return { stopped: false, reason: 'timeout' }
    let birth
    try {
      birth = await observe(() => readBirth(identity, remaining))
    } catch (error) {
      return {
        stopped: false,
        reason: error.code === 'service-stop-timeout' ? 'timeout' : 'process-identity-unreadable'
      }
    }
    if (identity.birthToken && birth && birth !== identity.birthToken)
      return { stopped: false, reason: 'process-identity-changed' }
    try {
      const owner = JSON.parse(await observe(() => readOwner(identity.configRoot)))
      if (
        owner.generation !== identity.generation ||
        owner.pid !== identity.pid ||
        (identity.birthToken && owner.birthToken !== identity.birthToken)
      )
        return { stopped: false, reason: 'owner-generation-changed' }
    } catch (error) {
      // Graceful shutdown removes the owner record before process exit. Keep observing the PID.
      if (error.code !== 'ENOENT')
        return {
          stopped: false,
          reason: error.code === 'service-stop-timeout' ? 'timeout' : 'owner-unreadable'
        }
    }
    await sleep(Math.max(0, Math.min(250, deadline - now())))
  }
  return { stopped: true }
}

// Discovery records are hints. A live authenticated response from the same generation is authority.
export async function requestExistingRuntimeWeb(options, fetch = globalThis.fetch) {
  for (const configRoot of candidateConfigRoots({ override: options.configRoot })) {
    let record
    try {
      record = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
    } catch {
      continue
    }
    if (
      !record ||
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      !Number.isSafeInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      !['node', 'electron'].includes(record.host) ||
      typeof record.generation !== 'string'
    )
      continue
    try {
      const headers = {
        authorization: `Bearer ${await readWebToken(configRoot)}`,
        'x-open-science-runtime-generation': record.generation
      }
      const ownerResponse = await fetch(`http://127.0.0.1:${record.port}/owner`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: 'error'
      })
      if (!ownerResponse.ok) continue
      const owner = await ownerResponse.json()
      if (owner.generation !== record.generation || owner.pid !== record.pid) continue
      await verifyOwnerRoot(owner, record, configRoot)
      if (options.credentialStore === undefined) {
        const response = await fetch(
          `http://127.0.0.1:${record.port}/web/start?port=${options.port ?? 44100}`,
          {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(30_000),
            redirect: 'error'
          }
        )
        if (!response.ok) continue
        const result = await response.json()
        if (result.generation !== record.generation || result.pid !== record.pid) continue
      }
    } catch {
      continue
    }
    if (options.credentialStore !== undefined)
      throw new Error(
        'Open-Science is already running. Stop it before selecting a credential store.'
      )
    return configRoot
  }
}

// Mutations are accepted only by the authenticated owner generation; legacy capabilities remain
// explicit so a new client never claims that an older service implements App holds.
const isGeneration = (value) =>
  typeof value === 'string' &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)

const validLifetime = (lifetime, generation) =>
  lifetime &&
  lifetime.version === 1 &&
  isGeneration(lifetime.generation) &&
  (!generation || lifetime.generation === generation) &&
  typeof lifetime.explicit === 'boolean' &&
  typeof lifetime.stopping === 'boolean' &&
  Number.isSafeInteger(lifetime.apps) &&
  lifetime.apps >= 0 &&
  (lifetime.reason === undefined ||
    ['app-exit', 'disconnect', 'user-stop', 'restart', 'update'].includes(lifetime.reason))

export async function requestServiceLifetime(
  configRoot,
  operation = 'status',
  fetch = globalThis.fetch
) {
  let record
  try {
    record = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    !isGeneration(record.generation) ||
    (record.birthToken !== undefined &&
      (typeof record.birthToken !== 'string' || !record.birthToken.length)) ||
    (record.desktop !== undefined && !isGeneration(record.desktop?.generation))
  )
    throw new Error('The local service owner record is invalid.')
  const headers = {
    authorization: `Bearer ${await readWebToken(configRoot)}`,
    'x-open-science-runtime-generation': record.generation
  }
  const invoke = async (path, method) => {
    const response = await fetch(`http://127.0.0.1:${record.port}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: 'error'
    })
    if (!response.ok)
      throw new Error(`The local service refused ${operation} (HTTP ${response.status}).`)
    const result = await response.json()
    if (!result || result.generation !== record.generation || result.pid !== record.pid)
      throw new Error('The local service identity changed.')
    if (
      result.lifetime !== undefined &&
      !validLifetime(result.lifetime, record.desktop?.generation)
    )
      throw new Error('The local service lifetime response is invalid.')
    return result
  }
  const owner = await invoke('/owner', 'GET')
  if (owner.lifetime === undefined) {
    if (operation !== 'status') await verifyOwnerRoot(owner, record, configRoot)
    if (operation === 'start')
      throw new Error(
        'This older service cannot establish persistent running. Stop it from its App and start a compatible service.'
      )
    return undefined
  }
  await verifyOwnerRoot(owner, record, configRoot)
  const identity = {
    configRoot: await canonicalRoot(configRoot),
    pid: owner.pid,
    generation: owner.generation,
    serviceGeneration: owner.lifetime.generation,
    birthToken:
      typeof record.birthToken === 'string' && record.birthToken.length
        ? record.birthToken
        : undefined,
    version: record.desktop.version
  }
  if (operation === 'status') return { ...owner, identity }
  if (!['start', 'stop', 'force-stop'].includes(operation))
    throw new Error('Invalid service operation.')
  const result = await invoke(`/service/${operation}`, 'POST')
  if (!result.lifetime || result.lifetime.generation !== owner.lifetime.generation)
    throw new Error('The local service lifetime identity changed.')
  return { ...result, identity }
}

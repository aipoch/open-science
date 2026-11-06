/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { findBoundHandoff } from './mac-update-interruption-scenarios.mjs'

export function assertRuntimeOwner(ownerRecord, owner, bootstrap, expected) {
  if (
    owner.generation !== ownerRecord.generation ||
    owner.pid !== ownerRecord.pid ||
    owner.stopping
  )
    throw new Error('Target backend owner is stale or stopping')
  if (!Number.isInteger(owner.lifetime?.apps) || owner.lifetime.apps < 1 || owner.lifetime.stopping)
    throw new Error('Target desktop is not attached to its running backend')
  if (
    owner.startupOptions?.profilePath !== expected.profile ||
    owner.startupOptions?.configRoot !== expected.configRoot
  )
    throw new Error('Target backend did not preserve the initiating profile and configuration')
  if (
    bootstrap.configRoot !== expected.configRoot ||
    bootstrap.appVersion !== expected.targetVersion ||
    bootstrap.platform !== 'darwin'
  )
    throw new Error('Wrong target backend installation or version')
}

export function assertBackendDescendant(
  native,
  candidate,
  ownerPid,
  appBundle,
  previouslyVerified
) {
  const initial = native.getDarwinProcess(candidate.pid)
  if (
    !initial ||
    native.getDarwinProcessExecutable(initial.pid, initial.uniqueId) !== candidate.executable
  )
    throw new Error('Observed target process disappeared or changed identity')
  let row = native.getDarwinProcess(ownerPid)
  if (!row) throw new Error('Backend owner process is absent')
  const executable = native.getDarwinProcessExecutable(row.pid, row.uniqueId)
  if (!executable?.startsWith(appBundle + '/'))
    throw new Error('Backend belongs to another installation')
  const backendUniqueId = row.uniqueId
  if (
    previouslyVerified?.backendPid === ownerPid &&
    previouslyVerified.backendUniqueId === row.uniqueId &&
    previouslyVerified.backendExecutable === executable
  )
    return {
      ...previouslyVerified,
      targetUniqueId: initial.uniqueId,
      adoptedAfterVerifiedTargetInterruption: true
    }
  const visited = new Set()
  while (row && !visited.has(row.uniqueId)) {
    if (row.uniqueId === initial.uniqueId)
      return {
        targetUniqueId: initial.uniqueId,
        backendPid: ownerPid,
        backendUniqueId,
        backendExecutable: executable
      }
    visited.add(row.uniqueId)
    const parent = native.getDarwinProcess(row.ppid)
    if (!parent || parent.uniqueId !== row.parentUniqueId) break
    row = parent
  }
  throw new Error('Backend is not a verified descendant of the automatic target')
}

export function watchUpdateAdmissions(ctx) {
  let stopped = false
  let failure
  ctx.updateAdmissions = []
  const pending = (async () => {
    while (!stopped) {
      try {
        const bound = await findBoundHandoff(ctx)
        if (
          bound &&
          !ctx.updateAdmissions.some(
            (entry) => entry.record.operationId === bound.record.operationId
          )
        ) {
          await ctx.registerOwnedHandoff?.(bound)
          ctx.updateAdmissions.push(bound)
        }
      } catch (error) {
        // The product may atomically settle and clean a request between these read-only calls.
        if (error.code !== 'ENOENT') {
          failure = error
          return
        }
      }
      await new Promise((done) => setTimeout(done, 5))
    }
  })()
  return {
    stop: async () => {
      stopped = true
      await pending
      if (failure) throw failure
    }
  }
}

export function assertStartupSettled(admission, marker, ticket, expected) {
  if (
    !admission ||
    admission.record.installationRoot !== expected.appBundle ||
    admission.record.targetVersion !== expected.targetVersion ||
    admission.request.profilePath !== expected.profile ||
    admission.request.startupOptions.configRoot !== expected.configRoot
  )
    throw new Error('No observed, bound admission proves this target startup')
  for (const record of [marker, ticket]) {
    if (record && record.operationId !== admission.record.operationId)
      throw new Error('Another update operation replaced the observed admission')
    if (record) throw new Error('Target Desktop has not completed verified startup')
  }
  return {
    operationId: admission.record.operationId,
    requestSha256: admission.record.requestSha256
  }
}

async function completedStartup(ctx) {
  const directory = join(
    ctx.stateRoot ?? join(ctx.configRoot, 'installations'),
    createHash('sha256').update(ctx.appBundle).digest('hex')
  )
  const read = async (name) => {
    try {
      return JSON.parse(await readFile(join(directory, name), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }
  // The product writes the startup ticket before removing the native marker. Read in this
  // order to avoid mistaking an inconsistent observation across that transition for completion.
  const marker = await read('windows-update-in-progress.json')
  const ticket = await read('verified-startup.json')
  return assertStartupSettled(ctx.updateAdmissions?.at(-1), marker, ticket, ctx)
}

export async function observeAutomaticTarget(ctx, candidate) {
  const token = (await readFile(join(ctx.configRoot, 'web-token'), 'utf8')).trim()
  const service = JSON.parse(await readFile(join(ctx.configRoot, 'web-service.json'), 'utf8'))
  const ownerRecord = JSON.parse(await readFile(join(ctx.configRoot, 'runtime-owner.json'), 'utf8'))
  const getJson = async (port, path, init = {}) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid local service port')
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) throw new Error(`Target observation HTTP ${response.status}`)
    return response.json()
  }
  const [bootstrap, owner] = await Promise.all([
    getJson(service.port, '/api/bootstrap'),
    getJson(ownerRecord.port, '/owner', {
      headers: { 'x-open-science-runtime-generation': ownerRecord.generation }
    })
  ])
  assertRuntimeOwner(ownerRecord, owner, bootstrap, ctx)
  const native = createRequire(import.meta.url)('@aipoch/process-tree-native')
  const processBinding = assertBackendDescendant(
    native,
    candidate,
    owner.pid,
    ctx.appBundle,
    ctx.previouslyVerifiedBackend?.generation === owner.generation
      ? ctx.previouslyVerifiedBackend
      : undefined
  )
  const rpc = async (channel, args) => {
    const response = await getJson(service.port, `/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, args })
    })
    if (response.protocolVersion !== 1 || response.ok !== true)
      throw new Error(`Target read failed: ${channel}`)
    return response.result
  }
  const [projects, session] = await Promise.all([
    rpc('projects:list', []),
    rpc('sessions:load-one', [
      { projectId: ctx.fixture.project.id, sessionId: ctx.fixture.session.id }
    ])
  ])
  const startupCompletion = await completedStartup(ctx)
  const nativeWindow = JSON.parse(
    (await ctx.run(join(ctx.output, 'gui-probe'), [String(candidate.pid)])).stdout
  )
  if (nativeWindow.onScreenWindows < 1)
    throw new Error('Automatic target has no visible native window')
  // Main windows are created hidden and shown by ready-to-show. Data is read independently
  // through the authenticated real backend; no CDP flag is assumed to survive Squirrel launch.
  // Keep native window/screenshot evidence distinct from DOM-level assertions.
  return {
    version: bootstrap.appVersion,
    backendReady: true,
    rendererReady: true,
    nativeWindowVisible: true,
    configRoot: bootstrap.configRoot,
    profilePath: owner.startupOptions.profilePath,
    project: projects.find((p) => p.id === ctx.fixture.project.id),
    session,
    readinessEvidence: 'observed-update-verified-startup-completion-native-window-and-backend',
    startupCompletion,
    nativeWindow,
    processBinding,
    backend: { pid: owner.pid, generation: owner.generation }
  }
}

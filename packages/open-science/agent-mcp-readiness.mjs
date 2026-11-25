/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MCP_GROUPS, MCP_GROUP_IDS, mcpServerName } from './agent-mcp-groups.mjs'

export const MCP_GROUP_STATES = Object.freeze([
  'connected',
  'starting',
  'waiting_for_dependency',
  'missing',
  'unavailable',
  'profile_mismatch',
  'version_mismatch',
  'unconfirmed'
])

const HEARTBEAT_TTL_MS = 10_000
const REGISTRY_DIRECTORY = join('runtime', 'mcp-groups')

const logMcpDiagnostic = (message, error) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`[open-science:mcp] ${message}: ${detail}\n`)
}

const registryDirectory = (configRoot) => join(resolve(configRoot), REGISTRY_DIRECTORY)

const entryPath = (directory, group, processId) => join(directory, `${group}-${processId}.json`)

const writeJson = async (path, value) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(temporary, path)
}

const readEntries = async (configRoot) => {
  if (!configRoot) return []
  const directory = registryDirectory(configRoot)
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8'))
      if (MCP_GROUP_IDS.includes(value?.group) && value?.processId && value?.lastSeenAt) {
        entries.push(value)
      }
    } catch (error) {
      // A process may be replacing its heartbeat file. Ignore that observation and retry later.
      logMcpDiagnostic(`Ignoring MCP registry entry ${join(directory, name)}`, error)
    }
  }
  return entries
}

export const mcpCapabilityDigest = (names) =>
  createHash('sha256')
    .update([...names].sort().join('\n'))
    .digest('hex')

export const registerMcpGroup = async ({
  configRoot,
  group,
  version,
  capabilityNames = [],
  processId = randomUUID(),
  now = () => new Date().toISOString()
}) => {
  if (!configRoot || !MCP_GROUP_IDS.includes(group)) return undefined
  const directory = registryDirectory(configRoot)
  await mkdir(directory, { recursive: true })
  const path = entryPath(directory, group, processId)
  const profile = resolve(configRoot)
  const digest = mcpCapabilityDigest(capabilityNames)
  const startedAt = now()
  let closed = false
  let state = 'starting'
  let pending = Promise.resolve()
  const enqueue = (task) => {
    const current = pending.then(task)
    pending = current.catch(() => {})
    return current
  }
  const write = async () => {
    return enqueue(async () => {
      if (closed) return
      await writeJson(path, {
        group,
        serverName: mcpServerName(group),
        profile,
        version,
        capabilityDigest: digest,
        processId,
        pid: process.pid,
        state,
        startedAt,
        lastSeenAt: now()
      })
    })
  }
  await write()
  return {
    configRoot: profile,
    group,
    processId,
    capabilityDigest: digest,
    async setState(nextState) {
      if (!['starting', 'connected'].includes(nextState))
        throw new Error('Invalid MCP group state.')
      state = nextState
      await write()
    },
    async heartbeat() {
      await write()
    },
    async close() {
      closed = true
      await pending
      await rm(path, { force: true })
    }
  }
}

const fresh = (entry, now) => now - Date.parse(entry.lastSeenAt) <= HEARTBEAT_TTL_MS

const nextFor = (group, profile) => ({
  action: 'connect_mcp_group',
  group,
  serverName: mcpServerName(group),
  command: 'open-science',
  args: ['mcp', '--group', group, '--profile', profile]
})

const reconnectableStates = new Set([
  'missing',
  'unavailable',
  'profile_mismatch',
  'version_mismatch',
  'unconfirmed'
])

export const readMcpGroupStatus = async ({
  configRoot,
  version,
  capabilityDigests = {},
  serviceStatus = 'unchecked',
  readiness,
  now = Date.now()
}) => {
  const profile = configRoot ? resolve(configRoot) : undefined
  const entries = await readEntries(configRoot)
  const statuses = {}
  for (const group of MCP_GROUP_IDS) {
    const groupEntries = entries.filter((entry) => entry.group === group)
    const current = groupEntries
      .filter((entry) => fresh(entry, now))
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]
    let status = 'missing'
    let reason
    if (current) {
      if (profile && current.profile !== profile) {
        status = 'profile_mismatch'
        reason = 'registered_profile_differs'
      } else if (version && current.version !== version) {
        status = 'version_mismatch'
        reason = 'registered_version_differs'
      } else if (
        capabilityDigests[group] &&
        current.capabilityDigest !== capabilityDigests[group]
      ) {
        status = 'unconfirmed'
        reason = 'capability_digest_differs'
      } else {
        status = current.state === 'connected' ? 'connected' : 'starting'
      }
    } else if (groupEntries.length > 0) {
      status = 'unconfirmed'
      reason = 'heartbeat_expired'
    }
    if (serviceStatus === 'unavailable' && status === 'connected') {
      status = 'unavailable'
      reason = 'service_unavailable'
    }
    statuses[group] = {
      group,
      serverName: MCP_GROUPS[group].serverName,
      status,
      owner: 'deployment',
      ...(reason ? { reason } : {}),
      ...(current
        ? {
            profile: current.profile,
            version: current.version,
            capabilityDigest: current.capabilityDigest,
            processId: current.processId,
            pid: current.pid,
            lastSeenAt: current.lastSeenAt
          }
        : {}),
      ...(reconnectableStates.has(status) ? { next: [nextFor(group, profile ?? '<profile>')] } : {})
    }
  }
  for (const group of MCP_GROUP_IDS) {
    const definition = MCP_GROUPS[group]
    const dependency = definition.dependsOn.find((id) => statuses[id].status !== 'connected')
    if (dependency && ['connected', 'starting'].includes(statuses[group].status)) {
      statuses[group] = {
        ...statuses[group],
        status: 'waiting_for_dependency',
        dependency,
        next: [nextFor(dependency, profile ?? '<profile>')]
      }
    } else if (dependency && ['missing', 'unconfirmed'].includes(statuses[group].status)) {
      statuses[group] = {
        ...statuses[group],
        dependency,
        next: [nextFor(dependency, profile ?? '<profile>')]
      }
    }
  }
  const groupsReady = MCP_GROUP_IDS.every((group) => statuses[group].status === 'connected')
  const readinessReady =
    readiness?.agent === 'ready' &&
    readiness?.provider === 'ready' &&
    readiness?.notebook === 'ready'
  return {
    profile,
    service: { status: serviceStatus },
    groups: statuses,
    fullLoopReady: groupsReady && readinessReady,
    ...(readiness ? { readiness } : {}),
    entries: entries.map(
      ({
        group,
        serverName,
        profile: entryProfile,
        version: entryVersion,
        processId,
        pid,
        lastSeenAt,
        state
      }) => ({
        group,
        serverName,
        profile: entryProfile,
        version: entryVersion,
        processId,
        pid,
        lastSeenAt,
        state
      })
    )
  }
}

export const mcpGroupDependency = (status, group) => {
  const current = status?.groups?.[group]
  if (!current || current.status === 'connected') return undefined
  if (['profile_mismatch', 'version_mismatch', 'unavailable'].includes(current.status)) {
    return undefined
  }
  return (
    current.dependency ??
    MCP_GROUPS[group]?.dependsOn.find((id) => status.groups[id]?.status !== 'connected')
  )
}

export const mcpGroupDependencyError = (status, group) => {
  const current = status?.groups?.[group]
  const dependency = mcpGroupDependency(status, group)
  const ownFailure =
    current &&
    ['profile_mismatch', 'version_mismatch', 'unavailable', 'unconfirmed'].includes(current.status)
  if (!current || (!dependency && !ownFailure)) return undefined
  return {
    status: current.status,
    owner: current.owner ?? 'deployment',
    ...(current.reason ? { reason: current.reason } : {}),
    ...(dependency ? { dependency } : {}),
    group,
    next: current.next ?? [nextFor(dependency ?? group, status.profile ?? '<profile>')]
  }
}

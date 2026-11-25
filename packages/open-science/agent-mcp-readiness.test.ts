import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mcpGroupDependencyError,
  readMcpGroupStatus,
  registerMcpGroup
} from './agent-mcp-readiness.mjs'
import { defaultMcpServerConfig } from './agent-mcp-groups.mjs'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const register = (
  configRoot: string,
  group: 'core' | 'research' | 'literature',
  state?: 'starting' | 'connected'
): Promise<Awaited<ReturnType<typeof registerMcpGroup>>> =>
  registerMcpGroup({
    configRoot,
    group,
    version: '1.3.2',
    capabilityNames: [group],
    processId: `${group}-process`,
    now: () => '2026-11-23T00:00:00.000Z'
  }).then(async (entry) => {
    if (state === 'connected') await entry?.setState('connected')
    return entry
  })

it('reports missing and dependency-waiting MCP groups', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-'))
  cleanup.push(profile)
  const core = await register(profile, 'core', 'connected')
  const research = await register(profile, 'research', 'connected')

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(status.groups.core).toMatchObject({ status: 'connected', serverName: 'open-science-core' })
  expect(status.groups.research).toMatchObject({ status: 'connected' })
  expect(status.groups.literature).toMatchObject({
    status: 'missing',
    next: [{ group: 'literature', serverName: 'open-science-literature' }]
  })
  expect(mcpGroupDependencyError(status, 'literature')).toBeUndefined()

  await research?.close()
  await core?.close()
})

it('reports a downstream group waiting while its dependency starts', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-wait-'))
  cleanup.push(profile)
  const core = await register(profile, 'core')
  const research = await register(profile, 'research', 'connected')

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(status.groups.research).toMatchObject({
    status: 'waiting_for_dependency',
    dependency: 'core'
  })

  await research?.close()
  await core?.close()
})

it('marks an expired heartbeat unconfirmed without claiming the process is connected', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-expired-'))
  cleanup.push(profile)
  const core = await register(profile, 'core', 'connected')

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:11.000Z')
  })
  expect(status.groups.core).toMatchObject({ status: 'unconfirmed', reason: 'heartbeat_expired' })
  await core?.close()
})

it('builds all required local MCP server entries for both shell families', () => {
  expect(Object.keys(defaultMcpServerConfig())).toEqual([
    'open-science-core',
    'open-science-research',
    'open-science-literature'
  ])
  expect(defaultMcpServerConfig()['open-science-research']).toEqual({
    command: 'npx',
    args: ['--yes', '@aipoch/open-science@latest', 'mcp', '--group', 'research']
  })
  expect(defaultMcpServerConfig({ command: 'cmd.exe' })['open-science-literature']).toEqual({
    command: 'cmd.exe',
    args: [
      '/d',
      '/c',
      'npx',
      '--yes',
      '@aipoch/open-science@latest',
      'mcp',
      '--group',
      'literature'
    ]
  })
})

it('requires every group and readiness layer before declaring the full loop ready', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-full-'))
  cleanup.push(profile)
  const entries = await Promise.all(
    (['core', 'research', 'literature'] as const).map((group) =>
      registerMcpGroup({
        configRoot: profile,
        group,
        version: '1.3.2',
        capabilityNames: [group],
        processId: `${group}-full-process`,
        now: () => '2026-11-23T00:00:00.000Z'
      })
    )
  )
  await Promise.all(entries.map((entry) => entry?.setState('connected')))
  const ready = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    readiness: { agent: 'ready', provider: 'ready', notebook: 'ready' },
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(ready.fullLoopReady).toBe(true)
  const blocked = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    readiness: { agent: 'ready', provider: 'ready', notebook: 'unconfirmed' },
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(blocked.fullLoopReady).toBe(false)
  await Promise.all(entries.map((entry) => entry?.close()))
})

it('distinguishes version or capability drift from a connected group and recovers after re-registration', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-drift-'))
  cleanup.push(profile)
  const stale = await registerMcpGroup({
    configRoot: profile,
    group: 'core',
    version: '1.2.0',
    capabilityNames: ['old-capability'],
    processId: 'stale-core-process',
    now: () => '2026-11-23T00:00:00.000Z'
  })
  await stale?.setState('connected')
  const drift = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    capabilityDigests: { core: 'expected-current-digest' },
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(drift.groups.core).toMatchObject({
    status: 'version_mismatch',
    reason: 'registered_version_differs'
  })

  await stale?.close()
  const current = await register(profile, 'core', 'connected')
  const recovered = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(recovered.groups.core).toMatchObject({ status: 'connected', version: '1.3.2' })
  await current?.close()
})

it('reports an actionable reconnect for profile drift', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-profile-'))
  cleanup.push(profile)
  const entry = await register(profile, 'core', 'connected')
  const [name] = await readdir(join(profile, 'runtime', 'mcp-groups'))
  const path = join(profile, 'runtime', 'mcp-groups', name)
  const value = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...value, profile: '/stale/profile' }))

  const status = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:05.000Z')
  })
  expect(status.groups.core).toMatchObject({
    status: 'profile_mismatch',
    reason: 'registered_profile_differs',
    owner: 'deployment',
    next: [
      {
        action: 'connect_mcp_group',
        group: 'core',
        serverName: 'open-science-core',
        args: ['mcp', '--group', 'core', '--profile', profile]
      }
    ]
  })
  await entry?.close()
})

it('reports reconnect ownership for expired heartbeats and service loss', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-readiness-recovery-'))
  cleanup.push(profile)
  const entry = await registerMcpGroup({
    configRoot: profile,
    group: 'core',
    version: '1.3.2',
    capabilityNames: ['core'],
    processId: 'expired-core-process',
    now: () => '2026-11-23T00:00:00.000Z'
  })
  await entry?.setState('connected')

  const expired = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    now: Date.parse('2026-11-23T00:00:11.000Z')
  })
  expect(expired.groups.core).toMatchObject({
    status: 'unconfirmed',
    reason: 'heartbeat_expired',
    owner: 'deployment',
    next: [{ action: 'connect_mcp_group', group: 'core' }]
  })

  await entry?.heartbeat()
  const unavailable = await readMcpGroupStatus({
    configRoot: profile,
    version: '1.3.2',
    serviceStatus: 'unavailable',
    now: Date.parse('2026-11-23T00:00:00.000Z')
  })
  expect(unavailable.groups.core).toMatchObject({
    status: 'unavailable',
    reason: 'service_unavailable',
    owner: 'deployment',
    next: [{ action: 'connect_mcp_group', group: 'core' }]
  })
  await entry?.close()
})

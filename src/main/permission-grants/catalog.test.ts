import { describe, expect, it } from 'vitest'

import { projectPermissionGrantSnapshot } from './catalog'
import { DEFAULT_GLOBAL_PERMISSION_CAPABILITIES } from './defaults'

describe('permission grant renderer projection', () => {
  it('projects whether every default Global grant is present', () => {
    const records = DEFAULT_GLOBAL_PERMISSION_CAPABILITIES.map((capability, index) => ({
      id: `default-${index}`,
      revision: 1,
      capability,
      scope: { kind: 'global' as const }
    }))

    expect(projectPermissionGrantSnapshot(records).missingDefaultGlobalGrantCount).toBe(0)
    expect(projectPermissionGrantSnapshot(records.slice(1)).missingDefaultGlobalGrantCount).toBe(1)
  })

  it('uses owner names and never exposes an exact qualifier digest', () => {
    const digest = `sha256:v1:${'a'.repeat(64)}`
    const snapshot = projectPermissionGrantSnapshot(
      [
        {
          id: 'grant-1',
          revision: 1,
          capability: {
            kind: 'execution',
            key: 'exec:agent/shell',
            qualifier: { mode: 'exact', value: digest }
          },
          scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
        }
      ],
      {
        projects: new Map([['project-1', 'Research project']]),
        sessions: new Map([['session-1', 'Analyze samples']])
      }
    )

    expect(snapshot).toMatchObject({
      counts: { all: 1, global: 0, project: 0, session: 1 },
      grants: [
        {
          capabilityLabel: 'Shell',
          qualifierLabel: 'Specific input',
          scopeLabel: 'Session: Analyze samples'
        }
      ]
    })
    expect(JSON.stringify(snapshot)).not.toContain(digest)
  })

  it('labels a command group without exposing its qualifier digest', () => {
    const digest = `argv-prefix:sha256:v1:${'a'.repeat(64)}`
    const snapshot = projectPermissionGrantSnapshot([
      {
        id: 'grant-command-group',
        revision: 1,
        capability: {
          kind: 'execution',
          key: 'exec:agent/shell',
          qualifier: { mode: 'category', value: digest }
        },
        scope: { kind: 'global' }
      }
    ])

    expect(snapshot.grants[0]).toMatchObject({ qualifierLabel: 'Command group' })
    expect(JSON.stringify(snapshot)).not.toContain(digest)
  })

  it('discloses when a broader grant still covers a revocable row', () => {
    const capability = { kind: 'execution' as const, key: 'exec:local/python' }
    const snapshot = projectPermissionGrantSnapshot([
      { id: 'global', revision: 1, capability, scope: { kind: 'global' } },
      {
        id: 'project',
        revision: 1,
        capability,
        scope: { kind: 'project', projectId: 'project-1' }
      },
      {
        id: 'session',
        revision: 1,
        capability,
        scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
      }
    ])

    expect(snapshot.grants.find((grant) => grant.id === 'global')?.coveredBy).toBeUndefined()
    expect(snapshot.grants.find((grant) => grant.id === 'project')?.coveredBy).toBe('global')
    expect(snapshot.grants.find((grant) => grant.id === 'session')?.coveredBy).toBe('project')
  })

  it('projects Connector block/allow coverage without mutating the grant', () => {
    const records = [
      {
        id: 'blocked',
        revision: 1,
        capability: { kind: 'mcp_tool' as const, key: 'mcp:custom-1/write' },
        scope: { kind: 'global' as const }
      },
      {
        id: 'covered',
        revision: 1,
        capability: { kind: 'mcp_tool' as const, key: 'mcp:chemistry/search' },
        scope: { kind: 'global' as const }
      }
    ]
    const snapshot = projectPermissionGrantSnapshot(records, {
      connectorPolicy: {
        bundledConnectorIds: ['chemistry'],
        customMcpServers: [
          { id: 'custom-1', name: 'stable', displayName: 'Renamed', enabled: true }
        ],
        blockedToolIds: ['stable/write'],
        askToolIds: ['stable/write']
      }
    })

    expect(snapshot.grants.find((grant) => grant.id === 'blocked')).toMatchObject({
      connectorServerId: 'custom-1',
      connectorToolName: 'write',
      effectiveState: 'blocked_by_policy',
      policyHint: 'Blocked in Connectors; this permission is currently inactive'
    })
    expect(snapshot.grants.find((grant) => grant.id === 'covered')).toMatchObject({
      effectiveState: 'covered_by_policy',
      policyHint: 'Allowed by Connector policy even without this permission'
    })
  })

  it('does not project Connector policy onto app-owned MCP tools', () => {
    const snapshot = projectPermissionGrantSnapshot(
      [
        {
          id: 'notebook',
          revision: 1,
          capability: {
            kind: 'mcp_tool',
            key: 'mcp:open-science-notebook/notebook_execute'
          },
          scope: { kind: 'global' }
        }
      ],
      { connectorPolicy: { bundledConnectorIds: ['chemistry'] } }
    )

    expect(snapshot.grants[0]).not.toHaveProperty('connectorServerId')
    expect(snapshot.grants[0]).not.toHaveProperty('effectiveState')
    expect(snapshot.grants[0]).not.toHaveProperty('policyHint')
  })

  it('uses the stable customization identity for its display label', () => {
    const snapshot = projectPermissionGrantSnapshot([
      {
        id: 'customize',
        revision: 1,
        capability: { kind: 'customize_mutation', key: 'customize:agent_attach_connector' },
        scope: { kind: 'global' }
      }
    ])

    expect(snapshot.grants[0].capabilityLabel).toBe('Attach connector')
  })
})

import { describe, expect, it, vi } from 'vitest'

import type { PermissionGrantRecord } from '../../shared/permission-grants'
import { reconcilePermissionGrantOwners } from './reconciliation'

const record = (
  id: string,
  capability: PermissionGrantRecord['capability'],
  scope: PermissionGrantRecord['scope'] = { kind: 'global' }
): PermissionGrantRecord => ({ id, revision: 1, capability, scope })

describe('reconcilePermissionGrantOwners', () => {
  it('prunes only orphaned Session and dynamic soft-owner grants', async () => {
    const staleServerId = '11111111-1111-4111-8111-111111111111'
    const liveServerId = '22222222-2222-4222-8222-222222222222'
    const list = vi.fn().mockResolvedValue([
      record(
        'live-session',
        { kind: 'execution', key: 'exec:agent/shell' },
        { kind: 'session', projectId: 'project-1', sessionId: 'session-live' }
      ),
      record(
        'stale-session',
        { kind: 'execution', key: 'exec:agent/shell' },
        { kind: 'session', projectId: 'project-1', sessionId: 'session-stale' }
      ),
      record('live-custom', { kind: 'mcp_tool', key: `mcp:${liveServerId}/search` }),
      record('stale-custom', { kind: 'mcp_tool', key: `mcp:${staleServerId}/search` }),
      record('app-mcp', { kind: 'mcp_tool', key: 'mcp:open-science-notebook/notebook_execute' }),
      record('live-compute', { kind: 'execution', key: 'exec:compute/ssh:live/call_command' }),
      record('live-compute-slash', {
        kind: 'execution',
        key: 'exec:compute/ssh:cluster/team/submit_job'
      }),
      record('stale-compute', { kind: 'execution', key: 'exec:compute/ssh:stale/download' })
    ])
    const prune = vi.fn().mockResolvedValue([])

    await reconcilePermissionGrantOwners(
      { list, prune },
      {
        sessions: [{ projectId: 'project-1', sessionId: 'session-live' }],
        customServerIds: [liveServerId],
        computeProviderIds: ['ssh:live', 'ssh:cluster/team']
      }
    )

    expect(prune.mock.calls.map(([owner]) => owner)).toEqual([
      { kind: 'session', projectId: 'project-1', sessionId: 'session-stale' },
      { kind: 'mcp_server', serverId: staleServerId },
      { kind: 'compute_provider', providerId: 'ssh:stale' }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'

import type { PermissionGrantOwner, PermissionGrantRecord } from '../../shared/permission-grants'
import {
  reconcilePendingCustomServerDeletions,
  reconcilePermissionGrantOwners
} from './reconciliation'

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

  it('prunes journaled name-derived Connector IDs before completing their deletion', async () => {
    const calls: string[] = []
    const prune = vi.fn(async (owner: PermissionGrantOwner) => {
      if (owner.kind === 'mcp_server') calls.push(`prune:${owner.serverId}`)
    })
    const completeCustomServerDeletion = vi.fn(async (serverId: string) => {
      calls.push(`complete:${serverId}`)
    })
    const removeTagsForConnector = vi.fn(async (serverId: string) => {
      calls.push(`tags:${serverId}`)
    })

    await reconcilePendingCustomServerDeletions(
      { prune },
      {
        pendingCustomServerDeletionIds: ['rna-reviewer'],
        completeCustomServerDeletion,
        removeTagsForConnector
      }
    )

    expect(calls).toEqual(['prune:rna-reviewer', 'tags:rna-reviewer', 'complete:rna-reviewer'])
  })

  it('leaves a journaled Connector deletion pending when grant pruning fails', async () => {
    const completeCustomServerDeletion = vi.fn()

    await expect(
      reconcilePendingCustomServerDeletions(
        { prune: vi.fn().mockRejectedValue(new Error('grant cleanup failed')) },
        {
          pendingCustomServerDeletionIds: ['rna-reviewer'],
          removeTagsForConnector: vi.fn(),
          completeCustomServerDeletion
        }
      )
    ).rejects.toThrow('grant cleanup failed')

    expect(completeCustomServerDeletion).not.toHaveBeenCalled()
  })

  it('leaves a journaled Connector deletion pending when Tag cleanup fails', async () => {
    const completeCustomServerDeletion = vi.fn()

    await expect(
      reconcilePendingCustomServerDeletions(
        { prune: vi.fn().mockResolvedValue(undefined) },
        {
          pendingCustomServerDeletionIds: ['rna-reviewer'],
          completeCustomServerDeletion,
          removeTagsForConnector: vi.fn().mockRejectedValue(new Error('Tag cleanup failed'))
        }
      )
    ).rejects.toThrow('Tag cleanup failed')

    expect(completeCustomServerDeletion).not.toHaveBeenCalled()
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLinearConversationGraph,
  projectConversationMessage
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'

const durabilityEvents = vi.hoisted(() => [] as string[])

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              durabilityEvents.push(`sync:${String(args[0])}`)
              return target.sync()
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})

let storageRoot: string | undefined

afterEach(async () => {
  durabilityEvents.length = 0
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('Provenance Message snapshot durability', () => {
  it('flushes the staged file and published directory before marking the snapshot ready', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-message-snapshot-durability-'))
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'saved artifact',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Durability',
      cwd: '/workspace',
      status: 'idle',
      messages: graph.messages.map(projectConversationMessage),
      conversationGraph: graph,
      createdAt: 1,
      updatedAt: 1
    }
    const version = {
      originKind: 'agent_generated',
      rootFrameId: graph.rootFrameId,
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.branches[0]!.id,
      messageId: 'message-1'
    }
    const client = {
      artifactVersion: {
        findMany: async () => [version],
        updateMany: async () => ({ count: 1 })
      },
      artifactMessageSnapshot: {
        findUnique: async () => null,
        create: async () => {
          durabilityEvents.push('database:staging')
        }
      },
      $transaction: async (operation: (transaction: unknown) => Promise<unknown>) =>
        operation({
          artifactMessageSnapshot: {
            update: async () => {
              durabilityEvents.push('database:ready')
            }
          },
          artifactVersion: { updateMany: async () => ({ count: 1 }) }
        })
    } as unknown as PrismaClient
    const { ProvenanceMessageSnapshotRepository } = await import('./provenance-message-snapshot')
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'snapshot-1',
      now: () => new Date('2026-09-04T00:00:00.000Z')
    })

    await snapshots.captureFinalizedMessages(session)

    expect(durabilityEvents).toEqual([
      'database:staging',
      `sync:${join(storageRoot, 'artifacts/project-1/session-1/.provenance/.staging/messages/snapshot-1.json')}`,
      `sync:${join(storageRoot, 'artifacts/project-1/session-1/.provenance/message-snapshots')}`,
      `sync:${join(storageRoot, 'artifacts/project-1/session-1/.provenance/.staging/messages')}`,
      `sync:${join(storageRoot, 'artifacts/project-1/session-1/.provenance/.staging')}`,
      `sync:${join(storageRoot, 'artifacts/project-1/session-1/.provenance')}`,
      `sync:${join(storageRoot, 'artifacts/project-1/session-1')}`,
      `sync:${join(storageRoot, 'artifacts/project-1')}`,
      `sync:${join(storageRoot, 'artifacts')}`,
      `sync:${storageRoot}`,
      'database:ready'
    ])
  })
})

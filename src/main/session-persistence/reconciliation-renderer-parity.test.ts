import { describe, expect, it, vi } from 'vitest'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import type {
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession
} from '../../shared/session-persistence'
import { SessionPersistenceReconciliationOwner } from './reconciliation-owner'

// These are the reference cases formerly exercised by renderer reconcilePendingArtifacts.
// Compare Message references, including graph-only history, before retiring that renderer writer.
const message = (id: string, artifactIds?: string[]): PersistedChatMessage => ({
  id,
  role: 'agent',
  content: 'done',
  status: 'complete',
  eventIds: [],
  artifactIds,
  createdAt: 1,
  updatedAt: 1
})
const pending = (id: string, runId: string, name = 'chart.png'): PersistedArtifact => ({
  id,
  kind: 'managed-file' as const,
  path: `/data/artifacts/proj-1/session-1/.pending/${runId}/${name}`,
  name
})
const recovered = (
  id: string,
  messageId: string,
  runId: string,
  name = 'chart.png'
): ArtifactVersionFile => ({
  id,
  artifactId: `artifact-${id}`,
  versionId: id,
  versionNumber: 1,
  checksum: 'a'.repeat(64),
  createdAt: '2026-07-29T00:00:00.000Z',
  projectId: 'proj-1',
  sessionId: 'session-1',
  messageId,
  runId,
  name,
  path: `/data/artifacts/proj-1/session-1/${messageId}/${name}`,
  fileUrl: `file:///data/artifacts/proj-1/session-1/${messageId}/${name}`,
  size: 3,
  mtimeMs: 2
})
const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'proj-1',
  title: 'Restored',
  cwd: '/workspace/project',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const cases = [
  {
    name: 'crash-orphaned pending reference',
    source: session({
      messages: [message('message-1', ['pending-chart'])],
      artifacts: [pending('pending-chart', 'run-1')]
    }),
    recoveries: [
      { messageId: 'message-1', artifacts: [recovered('version-1', 'message-1', 'run-1')] }
    ],
    expected: { 'message-1': ['version-1'] }
  },
  {
    name: 'no pending references',
    source: session({ messages: [message('message-1')] }),
    recoveries: [],
    expected: { 'message-1': [] }
  },
  {
    name: 'already-published reference alongside new file',
    source: session({
      messages: [message('message-1', ['published-artifact', 'pending-artifact'])],
      artifacts: [
        {
          id: 'published-artifact',
          kind: 'managed-file',
          path: '/published.txt',
          name: 'published.txt'
        },
        pending('pending-artifact', 'run-1', 'new.txt')
      ]
    }),
    recoveries: [
      {
        messageId: 'message-1',
        artifacts: [recovered('version-1', 'message-1', 'run-1', 'new.txt')]
      }
    ],
    expected: { 'message-1': ['published-artifact', 'version-1'] }
  },
  {
    name: 'later Message recovery while the earlier file remains unresolved',
    source: session({
      messages: [message('message-1', ['pending-first']), message('message-2', ['pending-second'])],
      artifacts: [
        pending('pending-first', 'run-1', 'first.txt'),
        pending('pending-second', 'run-2', 'second.txt')
      ]
    }),
    recoveries: [
      {
        messageId: 'message-2',
        artifacts: [recovered('version-2', 'message-2', 'run-2', 'second.txt')]
      }
    ],
    expected: { 'message-1': ['pending-first'], 'message-2': ['version-2'] }
  },
  {
    name: 'empty native recovery preserves unresolved Version',
    source: session({
      messages: [message('message-1', ['version-1'])],
      artifacts: [
        {
          ...pending('version-1', 'run-1'),
          artifactId: 'artifact-1',
          versionId: 'version-1',
          path: '/data/artifacts/proj-1/.provenance/artifacts/artifact-1/versions/version-1/chart.png'
        }
      ]
    }),
    recoveries: [],
    expected: { 'message-1': ['version-1'] }
  },
  {
    name: 'native success preserves an unresolved compatibility reference',
    source: session({
      messages: [message('message-1', ['version-1', 'pending-report'])],
      artifacts: [
        { ...pending('version-1', 'run-1'), artifactId: 'artifact-1', versionId: 'version-1' },
        pending('pending-report', 'run-2', 'report.md')
      ]
    }),
    recoveries: [
      { messageId: 'message-1', artifacts: [recovered('version-1', 'message-1', 'run-1')] }
    ],
    expected: { 'message-1': ['version-1', 'pending-report'] }
  }
]

const reconcile = async (
  source: PersistedChatSession,
  recoveries: Array<{ messageId: string; artifacts: ArtifactVersionFile[] }>
): Promise<PersistedChatSession> => {
  const owner = new SessionPersistenceReconciliationOwner({
    repository: { saveSession: vi.fn(async (value) => value) },
    fileIndex: {
      syncSession: vi.fn(async () => []),
      reconcileActiveSessions: vi.fn(async () => {})
    },
    artifactStorage: {
      prepareProjectReconciliation: vi.fn(
        async () => ({}) as ArtifactProjectReconciliationSnapshot
      ),
      reconcileSession: vi.fn(async () => ({ recoveredMessageArtifacts: recoveries }))
    }
  })
  const result = await owner.reconcileLoadedSessions({
    result: { sessions: [source], manifest: { version: 1 } },
    allowDestructiveCleanup: false,
    phase: () => {},
    onPermissionFailure: () => {}
  })
  expect(result.status).toBe('ready')
  return result.result.sessions[0]
}

describe('Main reconciliation reference parity with renderer recovery fixtures', () => {
  it.each(cases)('$name', async ({ source, recoveries, expected }) => {
    const result = await reconcile(source, recoveries)
    for (const [id, ids] of Object.entries(expected)) {
      const actual = result.messages.find((item) => item.id === id)?.artifactIds ?? []
      if (source.artifacts?.some((item) => item.versionId) && ids.length > 1) {
        expect(actual).toEqual(expect.arrayContaining(ids))
        expect(actual).toHaveLength(ids.length)
      } else expect(actual).toEqual(ids)
      if (result.conversationGraph) {
        expect(
          result.conversationGraph.messages.find((item) => item.id === id)?.artifactIds ?? []
        ).toEqual(actual)
      }
    }
  })

  it('repairs references only on an inactive Branch without selecting it', async () => {
    const prompt = {
      ...message('original-prompt'),
      role: 'user' as const,
      content: 'Create a report'
    }
    const answer = message('inactive-answer', ['pending-report'])
    const original = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt, answer],
      createdAt: 1,
      updatedAt: 2
    })
    const graph = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(original, prompt.id, 'revised-branch', 3),
      [{ ...prompt, id: 'revised-prompt', content: 'Create a chart' }],
      4
    )
    const result = await reconcile(
      session({
        messages: [{ ...prompt, id: 'revised-prompt', content: 'Create a chart' }],
        conversationGraph: graph,
        artifacts: [pending('pending-report', 'run-1', 'report.md')]
      }),
      [
        {
          messageId: answer.id,
          artifacts: [recovered('version-1', answer.id, 'run-1', 'report.md')]
        }
      ]
    )
    expect(result.messages.map(({ id }) => id)).toEqual(['revised-prompt'])
    expect(
      result.conversationGraph?.messages.find(({ id }) => id === answer.id)?.artifactIds
    ).toEqual(['version-1'])
  })
})

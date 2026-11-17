import { expect, it } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { operationReplaySource } from './replay-source'
import { researchVideoGenerationBlock } from './session-source'
const request = { projectId: 'p', sessionId: 's', mode: 'operation-replay' as const }
it('keeps attachment-only input, distinguishes automatic messages and joins only attributable records', () => {
  const session = {
    id: 's',
    projectId: 'p',
    title: 'Study',
    revision: 1,
    messages: [
      {
        id: 'human',
        role: 'user',
        content: '',
        uploads: [{ id: 'u', name: 'data.csv', size: 12 }],
        createdAt: 1
      },
      {
        id: 'auto',
        role: 'user',
        content: 'Application context',
        attribution: { kind: 'system' },
        createdAt: 2
      },
      {
        id: 'answer',
        role: 'agent',
        content: 'Uncertain result.',
        artifactIds: ['file'],
        createdAt: 5
      }
    ],
    artifacts: [{ id: 'file', name: 'result.csv' }],
    activities: [
      {
        id: 'run',
        promptMessageId: 'human',
        title: 'Submit computation',
        status: 'completed',
        rawOutput: { job_id: 'job' },
        createdAt: 3
      }
    ],
    planHistoryProjections: [
      {
        artifactVersionId: 'plan',
        originatingPromptMessageId: 'human',
        lifecycle: 'completed',
        approval: 'approved',
        materializedAt: 2,
        document: { title: 'Study' }
      }
    ]
  } as unknown as PersistedChatSession
  const before = JSON.stringify(session)
  const source = operationReplaySource(session, request, {
    reviews: [
      {
        id: 'r',
        messageId: 'answer',
        status: 'completed',
        text: 'Review says uncertain.',
        recordedAt: 6
      },
      { id: 'other-review', messageId: 'other', status: 'completed', text: 'Hidden', recordedAt: 7 }
    ],
    jobs: [
      { id: 'job', status: 'failed', text: 'Exit code: 1', recordedAt: 4 },
      { id: 'jo', status: 'completed', text: 'Must not substring match job', recordedAt: 4 }
    ]
  })
  expect(source.replay!.events.map((e) => e.kind)).toEqual([
    'attachment',
    'plan',
    'application-event',
    'execution',
    'remote-job',
    'agent-message',
    'result',
    'review'
  ])
  expect(source.messages.find((m) => m.id === 'auto')!.role).toBe('system')
  expect(source.replay!.events.find((e) => e.kind === 'remote-job')!.status).toBe('failed')
  expect(source.replay!.omissions).toHaveLength(2)
  expect(JSON.stringify(source)).not.toContain('other-review')
  expect(JSON.stringify(session)).toBe(before)
})
it('does not expose a sibling branch or assign a globally ambiguous remote job to the selected branch', () => {
  const graph = {
    activityGroups: [],
    rootFrameId: 'frame',
    activeFrameId: 'frame',
    frames: [{ id: 'frame', activeBranchId: 'current' }],
    branches: [
      { id: 'current', agentFrameId: 'frame', headMessageId: 'a' },
      { id: 'other', agentFrameId: 'frame', headMessageId: 'b' }
    ],
    messages: [
      { id: 'a', role: 'user', content: 'Private sibling', agentFrameId: 'frame' },
      { id: 'b', role: 'agent', content: 'Selected', agentFrameId: 'frame' }
    ],
    activities: [
      {
        id: 'act-a',
        promptMessageId: 'a',
        agentFrameId: 'frame',
        messageBranchId: 'current',
        title: 'Sibling',
        rawOutput: { job_id: 'job' }
      },
      {
        id: 'act-b',
        promptMessageId: 'b',
        agentFrameId: 'frame',
        messageBranchId: 'other',
        title: 'Selected run',
        rawOutput: { job_id: 'job' }
      }
    ]
  }
  const session = {
    id: 's',
    projectId: 'p',
    title: 'Branches',
    messages: [],
    conversationGraph: graph
  } as unknown as PersistedChatSession
  const source = operationReplaySource(
    session,
    { ...request, branchId: 'other' },
    { reviews: [], jobs: [{ id: 'job', text: 'Ambiguous', status: 'completed', recordedAt: 1 }] }
  )
  expect(source.messages.map((m) => m.id)).toEqual(['b'])
  expect(source.replay!.events.some((e) => e.kind === 'remote-job')).toBe(false)
  expect(JSON.stringify(source)).not.toContain('Private sibling')
  expect(() => operationReplaySource(session, { ...request, branchId: 'missing' })).toThrow(
    'branch'
  )
  graph.messages[0].content = ''
  expect(researchVideoGenerationBlock(session, request)).toBe('empty')
  expect(researchVideoGenerationBlock(session, { ...request, branchId: 'other' })).toBeUndefined()
  expect(researchVideoGenerationBlock(session, { ...request, branchId: 'missing' })).toBe(
    'unavailable'
  )
})

it('projects only Notebook records with both branch and prompt provenance', () => {
  const session = {
    id: 's',
    projectId: 'p',
    title: 'Study',
    messages: [{ id: 'human', role: 'user', content: 'Study', createdAt: 1 }]
  } as unknown as PersistedChatSession
  const run = {
    id: 'run',
    messageId: 'human',
    status: 'failed',
    code: 'print(1)',
    output: 'Actual error',
    language: 'python',
    recordedAt: 2
  }
  const source = operationReplaySource(session, request, {
    reviews: [],
    jobs: [],
    runs: [
      run,
      { ...run, id: 'sibling', branchId: 'other' },
      { ...run, id: 'unlinked', messageId: undefined }
    ]
  })
  expect(source.replay!.events.filter((e) => e.execution)).toEqual([
    expect.objectContaining({
      id: 'notebook:run',
      status: 'failed',
      execution: { code: 'print(1)', output: 'Actual error', language: 'python' }
    })
  ])
})

it('inherits Notebook evidence before a fork without leaking sibling or later parent executions', () => {
  const session = {
    id: 's',
    projectId: 'p',
    title: 'Branched study',
    messages: [],
    conversationGraph: {
      rootFrameId: 'frame',
      activeFrameId: 'frame',
      activityGroups: [],
      activities: [],
      frames: [{ id: 'frame', activeBranchId: 'child' }],
      branches: [
        { id: 'parent', agentFrameId: 'frame', headMessageId: 'prompt', createdAt: 1 },
        {
          id: 'child',
          parentBranchId: 'parent',
          agentFrameId: 'frame',
          headMessageId: 'answer',
          createdAt: 5
        },
        {
          id: 'sibling',
          parentBranchId: 'parent',
          agentFrameId: 'frame',
          headMessageId: 'prompt',
          createdAt: 4
        }
      ],
      messages: [
        { id: 'prompt', role: 'user', content: 'Question', agentFrameId: 'frame', createdAt: 1 },
        {
          id: 'answer',
          parentMessageId: 'prompt',
          role: 'agent',
          content: 'Answer',
          agentFrameId: 'frame',
          createdAt: 8
        }
      ]
    }
  } as unknown as PersistedChatSession
  const run = {
    messageId: 'prompt',
    status: 'completed',
    code: 'x',
    output: '1',
    language: 'python',
    recordedAt: 3
  }
  const source = operationReplaySource(session, request, {
    reviews: [],
    jobs: [],
    runs: [
      { ...run, id: 'inherited', branchId: 'parent' },
      { ...run, id: 'later', branchId: 'parent', recordedAt: 7 },
      { ...run, id: 'sibling', branchId: 'sibling' },
      { ...run, id: 'unknown' },
      { ...run, id: 'current', branchId: 'child', recordedAt: 6 }
    ]
  })
  expect(source.replay!.events.filter((event) => event.execution).map((event) => event.id)).toEqual(
    ['notebook:inherited', 'notebook:current']
  )
  expect(source.replay!.omissions.join(' ')).toContain('provenance')
})

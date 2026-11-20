import { describe, expect, it } from 'vitest'
import {
  createLinearConversationGraph,
  synchronizeActiveConversationActivities
} from '../../shared/conversation-graph'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import { readSessionToolHistory, sessionToolHistorySchema } from './session-tool-history'

const fixture = (): {
  session: PersistedChatSession
  turn: Parameters<typeof readSessionToolHistory>[1]
} => {
  const messages = ['old', 'current'].map((id, i) => ({
    id,
    role: 'user' as const,
    content: 'Research question',
    status: 'complete' as const,
    eventIds: [],
    createdAt: i + 1,
    updatedAt: i + 1
  }))
  const tool = (id: string, extra: Partial<PersistedToolActivity> = {}): PersistedToolActivity => ({
    id,
    kind: 'tool',
    title: 'Execute Notebook',
    status: 'completed',
    promptMessageId: 'old',
    sortIndex: 0,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra
  })
  const graph = synchronizeActiveConversationActivities(
    createLinearConversationGraph({ sessionId: 'copy', messages, createdAt: 1, updatedAt: 2 }),
    [
      tool('first', { rawInput: 'input alone' }),
      tool('receipt', {
        rawOutput: {
          output: JSON.stringify({
            outputs: [
              { data: { 'text/plain': 'Marker from saved literature: 1,440 participants' } }
            ]
          })
        }
      }),
      tool('terminal', { terminalOutput: 'saved stderr' }),
      tool('zero', { rawOutput: 0 }),
      tool('large', { rawOutput: 'A'.repeat(8_000) }),
      tool('current-tool', { promptMessageId: 'current', rawOutput: 'current' })
    ],
    []
  )
  const branch = graph.branches[0]
  graph.messages.push({ ...graph.messages[0], id: 'other-prompt', introducedOnBranchId: 'other' })
  graph.branches.push({ ...branch, id: 'other', headMessageId: 'other-prompt' })
  graph.activities.push({
    ...graph.activities[0],
    id: 'hidden',
    promptMessageId: 'other-prompt',
    messageBranchId: 'other',
    rawOutput: 'not visible'
  })
  return {
    session: {
      id: 'copy',
      projectId: 'project',
      title: 'Copied research',
      cwd: '',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages,
      conversationGraph: graph
    },
    turn: { rootFrameId: graph.rootFrameId, messageBranchId: branch.id, promptMessageId: 'current' }
  }
}

describe('saved Session tool history', () => {
  it('counts the whole branch even if the first page has no result and filters narrow it', () => {
    const { session, turn } = fixture()
    const totals = { activities: 5, withRawOutput: 3, withSavedOutput: 4 }
    expect(readSessionToolHistory(session, turn, { limit: 1 })).toMatchObject({
      totals,
      matchingActivities: 5,
      nextOffset: 1,
      activities: [{ activityId: 'first', hasRawOutput: false, savedOutputField: null }]
    })
    expect(
      readSessionToolHistory(session, turn, { search: '1,440', onlyWithOutput: true })
    ).toMatchObject({
      totals,
      matchingActivities: 1,
      nextOffset: null,
      activities: [{ activityId: 'receipt', hasRawOutput: true, savedOutputField: 'rawOutput' }]
    })
    expect(readSessionToolHistory(session, turn, { search: 'input alone' })).toMatchObject({
      totals,
      matchingActivities: 0,
      activities: []
    })
  })

  it('reads nested saved output, identifies missing and alternative output, and bounds previews', () => {
    const { session, turn } = fixture()
    const read = (activityId: string): unknown =>
      readSessionToolHistory(session, turn, { activityId })
    expect(read('receipt')).toMatchObject({
      output: {
        format: 'json',
        text: expect.stringContaining('1,440 participants'),
        truncated: false
      }
    })
    expect(read('first')).toMatchObject({ output: null })
    expect(read('terminal')).toMatchObject({ activity: { savedOutputField: 'terminalOutput' } })
    expect(read('zero')).toMatchObject({ output: { text: '0', truncated: false } })
    expect(read('large')).toMatchObject({ output: { text: 'A'.repeat(4_000), truncated: true } })
    for (const activityId of ['hidden', 'current-tool', 'missing']) {
      expect(() => read(activityId)).toThrow('Activity not found')
    }
  })

  it('fails closed for mismatched branch or missing turn and rejects invalid requests', () => {
    const { session, turn } = fixture()
    expect(() =>
      readSessionToolHistory(session, { ...turn, messageBranchId: 'other' }, {})
    ).toThrow('branch is unavailable')
    expect(() =>
      readSessionToolHistory(session, { ...turn, promptMessageId: 'missing' }, {})
    ).toThrow('not yet in')
    for (const invalid of [
      { sessionId: 'other' },
      { activityId: 'first', limit: 1 },
      { limit: 21 },
      { offset: -1 }
    ]) {
      expect(sessionToolHistorySchema.safeParse(invalid).success).toBe(false)
    }
  })
})

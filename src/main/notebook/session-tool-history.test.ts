import { describe, expect, it } from 'vitest'
import {
  createLinearConversationGraph,
  synchronizeActiveConversationActivities
} from '../../shared/conversation-graph'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import { NOTEBOOK_RPC_TOOLS, serializeNotebookToolResult } from './mcp-server'
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
  it('uses the last matching prompt in transcript order for flat activities with unordered timestamps', () => {
    const { session, turn } = fixture()
    const messages = [
      { ...session.messages[0], createdAt: 30 },
      { ...session.messages[0], id: 'newer-prior-prompt', createdAt: 10 },
      { ...session.messages[1], createdAt: 20 }
    ]
    const graph = createLinearConversationGraph({
      sessionId: session.id,
      messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    })
    const base = session.conversationGraph!.activities[0]
    session.conversationGraph = graph
    session.messages = messages
    session.activities = [
      { ...base, id: 'before-all-prompts', promptMessageId: undefined, createdAt: 9 },
      { ...base, id: 'prior', promptMessageId: undefined, createdAt: 10 },
      { ...base, id: 'at-current-prompt', promptMessageId: undefined, createdAt: 20 },
      { ...base, id: 'after-all-prompts', promptMessageId: undefined, createdAt: 35 }
    ]
    expect(
      readSessionToolHistory(
        session,
        { ...turn, rootFrameId: graph.rootFrameId, messageBranchId: graph.branches[0].id },
        {}
      )
    ).toMatchObject({
      totals: { activities: 1 },
      activities: [{ activityId: 'prior' }]
    })
  })

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

  it('finds all saved fields and returns separately labelled previews without changing counts', () => {
    const { session, turn } = fixture()
    const receipt = session.conversationGraph!.activities.find(({ id }) => id === 'receipt')!
    receipt.rawOutput = { status: 'ok' }
    receipt.terminalOutput = 'unique terminal marker'
    receipt.toolContent = [
      { type: 'content', content: { type: 'text', text: 'unique body marker' } }
    ]
    for (const search of ['unique terminal marker', 'UNIQUE BODY MARKER', 'status']) {
      expect(readSessionToolHistory(session, turn, { search })).toMatchObject({
        totals: { activities: 5, withRawOutput: 3, withSavedOutput: 4 },
        matchingActivities: 1,
        activities: [{ activityId: 'receipt' }]
      })
    }
    expect(readSessionToolHistory(session, turn, { activityId: 'receipt' })).toMatchObject({
      output: { field: 'rawOutput', text: '{"status":"ok"}', truncated: false },
      additionalOutputs: [
        { field: 'terminalOutput', text: 'unique terminal marker', truncated: false },
        {
          field: 'toolContent',
          text: expect.stringContaining('unique body marker'),
          truncated: false
        }
      ]
    })
  })

  it('round-trips long IDs, including IDs resembling a returned lookup identifier', () => {
    const { session, turn } = fixture()
    const graph = session.conversationGraph!
    graph.activities[1].id = 'long-' + 'a'.repeat(512)
    const initial = readSessionToolHistory(session, turn, { offset: 1, limit: 1 }) as {
      activities: { activityId: string }[]
    }
    const id = initial.activities[0].activityId
    expect(id).not.toBe(graph.activities[1].id)
    graph.activities[2].id = id
    const detail = (activityId: string): unknown =>
      readSessionToolHistory(session, turn, sessionToolHistorySchema.parse({ activityId }))
    expect(detail(id)).toMatchObject({ output: { text: expect.stringContaining('1,440') } })
    const next = readSessionToolHistory(session, turn, { offset: 2, limit: 1 }) as typeof initial
    expect(next.activities[0].activityId).not.toBe(id)
    expect(detail(next.activities[0].activityId)).toMatchObject({
      output: { text: 'saved stderr' }
    })
  })

  it('keeps all labelled detail previews within the MCP budget even after JSON escaping', () => {
    const { session, turn } = fixture()
    const row = session.conversationGraph!.activities[1]
    row.id = 'r'.repeat(512)
    row.providerToolName = '\u0001'.repeat(160)
    row.rawOutput = '\u0001'.repeat(8_000)
    row.terminalOutput = '\u0002'.repeat(8_000)
    row.toolContent = [{ type: 'content', content: { type: 'text', text: '\u0003'.repeat(8_000) } }]
    const limit = NOTEBOOK_RPC_TOOLS.find(
      ({ name }) => name === 'session_tool_history'
    )!.resultLimitChars
    const detail = readSessionToolHistory(session, turn, { activityId: row.id })
    const serialized = serializeNotebookToolResult(detail, limit)
    expect(JSON.parse(serialized)).toEqual(detail)
    expect(JSON.parse(serialized)).toMatchObject({
      output: { field: 'rawOutput', truncated: true },
      additionalOutputs: [
        { field: 'terminalOutput', truncated: true },
        { field: 'toolContent', truncated: true }
      ]
    })
  })

  it('retains totals and advances by delivered rows even for oversized pages', () => {
    const { session, turn } = fixture()
    const graph = session.conversationGraph!
    const sample = graph.activities[1]
    graph.activities = Array.from({ length: 23 }, (_, i) => ({
      ...sample,
      id: String(i).padStart(2, '0') + 'i'.repeat(i < 2 ? 1_500 : 510),
      providerToolName: '\u0001'.repeat(160)
    }))
    const limit = NOTEBOOK_RPC_TOOLS.find(
      ({ name }) => name === 'session_tool_history'
    )!.resultLimitChars
    const delivered: string[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const page = JSON.parse(
        serializeNotebookToolResult(
          readSessionToolHistory(session, turn, { offset, limit: 20 }),
          limit
        )
      ) as { nextOffset: number | null; activities: { activityId: string }[] }
      expect(page).toMatchObject({
        totals: { activities: 23, withRawOutput: 23 },
        matchingActivities: 23
      })
      expect(page.activities.length).toBeGreaterThan(0)
      if (page.nextOffset !== null) expect(page.nextOffset).toBe(offset + page.activities.length)
      if (offset === 0) expect(page.activities.length).toBeLessThan(20)
      delivered.push(...page.activities.map(({ activityId }) => activityId))
      offset = page.nextOffset
    }
    expect(new Set(delivered).size).toBe(23)
    for (const activityId of delivered) {
      expect(
        readSessionToolHistory(session, turn, sessionToolHistorySchema.parse({ activityId }))
      ).toMatchObject({ output: { text: expect.stringContaining('1,440') } })
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

  it('matches the transcript for a shared legacy prompt, but honors an off-path Activity fork', () => {
    const { session, turn } = fixture()
    const graph = session.conversationGraph!
    const sibling = graph.branches[1]
    sibling.parentBranchId = turn.messageBranchId
    sibling.forkMessageId = 'old'
    const [forkActivity, sharedActivity] = graph.activities
    sharedActivity.messageBranchId = sibling.id
    expect(readSessionToolHistory(session, turn, { activityId: sharedActivity.id })).toMatchObject({
      activity: { activityId: sharedActivity.id },
      output: { text: expect.stringContaining('1,440 participants') }
    })
    sibling.forkActivityId = forkActivity.id
    expect(() => readSessionToolHistory(session, turn, { activityId: sharedActivity.id })).toThrow(
      'Activity not found'
    )
  })

  it('refuses an over-budget graph rather than returning empty or partial totals', () => {
    const { session, turn } = fixture()
    const graph = session.conversationGraph!
    graph.branches.push(
      ...Array.from({ length: 1_000 }, (_, i) => ({ ...graph.branches[0], id: `branch-${i}` }))
    )
    for (const query of [{ limit: 1 }, { activityId: 'receipt' }]) {
      expect(() => readSessionToolHistory(session, turn, query)).toThrow('history was not scanned')
    }
  })
})

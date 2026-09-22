import { describe, expect, it } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { buildRecoveryHandoff } from './recovery-handoff'

const fixture = (): PersistedChatSession => {
  const messages = [
    {
      id: 'old',
      role: 'user' as const,
      content: 'historical constraint '.repeat(4000),
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'now',
      role: 'user' as const,
      content: 'Continue with p < 0.01, retaining every sample.',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
  return {
    id: 's',
    projectId: 'p',
    title: 'Task',
    cwd: '.',
    status: 'idle',
    messages,
    createdAt: 1,
    updatedAt: 2,
    conversationGraph: createLinearConversationGraph({
      sessionId: 's',
      messages,
      createdAt: 1,
      updatedAt: 2
    })
  }
}
const budget = { contextWindowTokens: 32_000, fixedOverheadTokens: 8000, outputReserveTokens: 4000 }
describe('buildRecoveryHandoff', () => {
  it('preserves the complete current instruction and points to complete historical constraints', () => {
    const session = fixture()
    const result = buildRecoveryHandoff({ session, ...budget })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.text).toContain(session.messages[1].content)
    expect(result.historyText).not.toContain(session.messages[1].content)
    expect(result.text).toContain('Historical instructions remain applicable')
    expect(result.text).toContain('contentOffset')
    expect(result.text.length).toBeLessThan(5000)
    expect(result.pendingPromptMessageId).toBe('now')
  })
  it('blocks a current instruction that does not fit rather than truncating it', () => {
    expect(
      buildRecoveryHandoff({ session: fixture(), ...budget, currentInput: 'X'.repeat(100_000) })
    ).toMatchObject({ status: 'blocked' })
  })
  it('includes verified tool results and refuses to resume unknown side effects', () => {
    const session = fixture()
    const graph = session.conversationGraph!
    graph.activities.push({
      id: 'write',
      kind: 'tool',
      title: 'Write data',
      status: 'completed',
      sortIndex: 1,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2,
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.branches[0].id,
      promptMessageId: 'now',
      runtimeSegmentId: graph.runtimeSegments[0].id,
      rawOutput: { saved: 'table.csv', rows: 420 }
    })
    const result = buildRecoveryHandoff({ session, ...budget })
    expect(result.status === 'ready' && result.text).toContain('420')
    graph.activities[0].status = 'in_progress'
    expect(buildRecoveryHandoff({ session, ...budget })).toMatchObject({
      status: 'blocked',
      activityIds: ['write']
    })
  })
  it('accounts for fixed overhead and output reserve', () => {
    expect(
      buildRecoveryHandoff({ session: fixture(), ...budget, fixedOverheadTokens: 31_000 })
    ).toMatchObject({ status: 'blocked' })
  })
  it('keeps large completed histories recoverable without reloading their full text', () => {
    const session = fixture()
    session.messages = Array.from({ length: 1000 }, (_, index) => ({
      ...session.messages[0],
      id: `m-${index}`,
      role: index % 2 ? ('agent' as const) : ('user' as const),
      content: 'material '.repeat(10000),
      createdAt: index + 1,
      updatedAt: index + 1
    }))
    session.conversationGraph = createLinearConversationGraph({
      sessionId: session.id,
      messages: session.messages,
      createdAt: 1,
      updatedAt: 1000
    })
    const result = buildRecoveryHandoff({ session, ...budget })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.pendingPromptMessageId).toBeUndefined()
    expect(result.text).toContain('1000 messages')
    expect(result.text.length).toBeLessThan(15000)
  })
})

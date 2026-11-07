import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessTurnJournalOwner } from './harness-turn-journal'
import { harnessTurnJournalSchema, type HarnessTurnScope } from '../../shared/harness-turn-contract'
import type { HarnessModelObservation } from './harness-model-request'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../shared/conversation-graph'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { initDataRoot } from '../storage-root'
import { buildHarnessContext, harnessContextMessages } from './harness-context'
import { compactContext } from '@aipoch/agent-harness'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

const route = {
  id: 'route',
  providerId: 'provider',
  configRevision: 1,
  model: 'model',
  protocol: 'chat-completions' as const
}
const scope: HarnessTurnScope = {
  projectId: 'project',
  sessionId: 'session',
  agentFrameId: 'root-frame-session',
  messageBranchId: 'message-branch-session',
  promptMessageId: 'prompt',
  messageId: 'answer',
  generation: 'generation',
  route
}
const started: HarnessModelObservation = {
  requestId: 'request',
  turnId: 'turn',
  step: 0,
  route,
  startedAt: 1,
  status: 'started'
}
const completed: HarnessModelObservation = {
  ...started,
  status: 'completed',
  httpStatus: 200,
  usage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3 }
}
const seed = (): PersistedChatSession => {
  const messages: PersistedChatSession['messages'] = [
    {
      id: 'prompt',
      role: 'user',
      content: 'Prompt',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer',
      role: 'agent',
      content: '',
      status: 'streaming',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const graph = createLinearConversationGraph({
    sessionId: 'session',
    messages,
    createdAt: 1,
    updatedAt: 2
  })
  graph.runtimeSegments = []
  for (const message of graph.messages) delete message.runtimeSegmentId
  return {
    id: 'session',
    projectId: 'project',
    title: 'Fixture',
    cwd: '/workspace',
    status: 'idle',
    messages,
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('harness request journal', () => {
  let session: PersistedChatSession
  let fail: boolean
  const port = {
    mutateRuntimeSession: async (
      _scope: unknown,
      mutate: (value: PersistedChatSession) => PersistedChatSession
    ): Promise<PersistedChatSession> => {
      if (fail) throw new Error('disk failure')
      session = mutate(structuredClone(session))
      return session
    }
  }
  const journal = (): NonNullable<PersistedChatSession['messages'][number]['harnessTurn']> =>
    session.conversationGraph!.messages[1].harnessTurn!
  let owner: HarnessTurnJournalOwner
  beforeEach(async () => {
    session = seed()
    fail = false
    owner = new HarnessTurnJournalOwner(port, scope)
    await owner.begin()
  })

  it('persists start then terminal, tolerates exact redelivery, and derives usage on settlement', async () => {
    await owner.observe(started)
    expect(journal().requests[0].status).toBe('started')
    await owner.observe(started)
    await owner.observe(completed)
    await owner.observe(completed)
    await owner.recordResponse('request', { role: 'assistant', content: 'answer' })
    await owner.settle('complete')
    expect(journal()).toMatchObject({
      status: 'complete',
      attemptedRequests: 1,
      requests: [completed]
    })
    expect(session.messages[1].turnUsage).toEqual({
      inputTokens: 10,
      cacheTokens: 2,
      outputTokens: 3,
      turnCount: 1
    })
    await owner.observe(completed)
    await expect(owner.observe({ ...started, requestId: 'next', step: 1 })).rejects.toThrow(
      'settled'
    )
  })

  it('denies new starts after a branch switch but settles the original in-flight request', async () => {
    await owner.observe(started)
    session.conversationGraph = forkEditedConversationMessage(
      session.conversationGraph!,
      'prompt',
      'new-branch',
      3
    )
    session.messages = []
    await expect(owner.observe({ ...started, requestId: 'next', step: 1 })).rejects.toThrow(
      'active'
    )
    await owner.observe(completed)
    await owner.settle('cancelled')
    expect(session.messages).toEqual([])
    expect(journal().requests).toEqual([completed])
    expect(journal().status).toBe('cancelled')
  })

  it.each([
    { ...completed, requestId: 'unknown' },
    { ...completed, step: 1 },
    { ...completed, startedAt: 2 },
    { ...completed, turnId: 'other' },
    { ...completed, route: { ...route, model: 'other' } }
  ])('rejects absent starts and changed identities %#', async (event) => {
    await owner.observe(started)
    await expect(owner.observe(event)).rejects.toThrow()
    expect(journal().requests).toEqual([started])
  })

  it('rejects duplicate steps and foreign turns before commit', async () => {
    await owner.observe(started)
    await expect(owner.observe({ ...started, requestId: 'duplicate' })).rejects.toThrow()
    await expect(
      owner.observe({ ...started, requestId: 'other', step: 1, turnId: 'other' })
    ).rejects.toThrow()
    expect(journal().requests).toEqual([started])
  })

  it('keeps durable started after a failed terminal write, and cannot claim completion', async () => {
    await owner.observe(started)
    fail = true
    await expect(owner.observe(completed)).rejects.toThrow('disk')
    fail = false
    await expect(owner.settle('complete')).rejects.toThrow('unsettled')
    await owner.settle('failed')
    expect(journal().requests).toEqual([started])
    expect(session.messages[1].turnUsageUnavailable).toBe(true)
  })

  it('cannot complete a metered request before its actual answer is durable', async () => {
    await owner.observe(started)
    await owner.observe(completed)
    await expect(owner.settle('complete')).rejects.toThrow('unsettled tools or responses')
    await owner.recordResponse('request', { role: 'assistant', content: 'answer' })
    await owner.settle('complete')
    expect(session.messages[1].content).toBe('answer')
  })

  it('retains missing-start attempts as unknown and never invents a request receipt', async () => {
    fail = true
    await expect(owner.observe(started)).rejects.toThrow('disk')
    fail = false
    await owner.settle('failed')
    expect(journal()).toMatchObject({ attemptedRequests: 1, requests: [] })
    expect(session.messages[1].turnUsageUnavailable).toBe(true)
  })

  it('fences stale generations and copied history', async () => {
    const next = new HarnessTurnJournalOwner(port, { ...scope, generation: 'next' })
    await expect(next.observe(started)).rejects.toThrow('generation')
    session.conversationGraph!.messages[1].usageOrigin = {
      sessionId: 'source',
      messageId: 'answer'
    }
    await expect(owner.observe(started)).rejects.toThrow('Message scope')
  })

  it('refuses damaged journals and future schema versions', async () => {
    const future = { ...journal(), schemaVersion: 2 }
    expect(harnessTurnJournalSchema.safeParse(future).success).toBe(false)
    session.conversationGraph!.messages[1].harnessTurnInvalid = true
    await expect(owner.observe(started)).rejects.toThrow('invalid')
  })

  it('does not accept a response that is no longer on the owning branch path', async () => {
    session.conversationGraph!.branches[0].headMessageId = 'prompt'
    await expect(owner.observe(started)).rejects.toThrow('Message scope')
  })

  const response = async (step: number, content: string): Promise<void> => {
    const event = { ...started, requestId: `request-${step}`, step }
    await owner.observe(event)
    await owner.observe({ ...event, status: 'completed', usage: completed.usage })
    await owner.recordResponse(event.requestId, { role: 'assistant', content })
  }

  it('rebuilds complete assistant reasoning and paired tools, refusing unresolved execution', async () => {
    await owner.observe(started)
    await owner.observe(completed)
    await expect(Promise.resolve().then(() => buildHarnessContext(session, scope))).rejects.toThrow(
      'missing durable response'
    )
    const assistant = {
      role: 'assistant',
      content: null,
      reasoning_content: 'preserve reasoning',
      tool_calls: [{ id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } }]
    }
    await owner.recordResponse('request', assistant)
    await owner.recordTool({ requestId: 'request', callId: 'tool', status: 'started' })
    expect(() => buildHarnessContext(session, scope)).toThrow('unresolved')
    await expect(
      owner.recordTool({ requestId: 'request', callId: 'tool', status: 'started' })
    ).rejects.toThrow('transition')
    await owner.recordTool({
      requestId: 'request',
      callId: 'tool',
      status: 'completed',
      output: 'evidence'
    })
    const wire = harnessContextMessages(buildHarnessContext(session, scope).items)
    expect(wire[1]).toEqual(assistant)
    expect(wire[2]).toEqual({ role: 'tool', tool_call_id: 'tool', content: 'evidence' })
    await expect(owner.settle('complete')).rejects.toThrow('unsettled tools')
  })

  it('commits three successive summaries while retaining original evidence', async () => {
    await response(0, 'raw evidence '.repeat(200))
    await response(1, 'recent '.repeat(50))
    for (let round = 0; round < 3; round++) {
      if (round) await response(round + 1, 'recent '.repeat(50))
      const outcome = await compactContext({
        snapshot: buildHarnessContext(session, scope),
        summaryId: `summary-${round}`,
        inputBudget: 700,
        keepRecentItems: 1,
        signal: new AbortController().signal,
        measure: (items) =>
          JSON.stringify({
            system: 'trusted instructions',
            tools: ['schema'],
            messages: harnessContextMessages(items)
          }).length,
        summarize: async () =>
          'Goal: preserve evidence. Source: raw evidence. Pending: verify result.',
        commit: (proposal, signal) => owner.commitCompaction(proposal, signal)
      })
      expect(outcome).toMatchObject({ status: 'committed', fitsBudget: true })
    }
    expect(journal().compactions).toHaveLength(3)
    expect(journal().transcript?.responses[0].message.content).toContain('raw evidence')
    expect(harnessContextMessages(buildHarnessContext(session, scope).items)[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Untrusted summary')
    })
  })

  it('allows summary usage writes without invalidating unchanged context', async () => {
    await response(0, 'long '.repeat(1000))
    await response(1, 'recent')
    expect(
      await compactContext({
        snapshot: buildHarnessContext(session, scope),
        summaryId: 'summary',
        inputBudget: 300,
        keepRecentItems: 1,
        signal: new AbortController().signal,
        measure: (items) => JSON.stringify(harnessContextMessages(items)).length,
        summarize: async () => {
          const event = { ...started, requestId: 'summary-request', step: 2 }
          await owner.observe(event, 'summary')
          await owner.observe({ ...event, status: 'completed', usage: completed.usage }, 'summary')
          return 'Short summary'
        },
        commit: (proposal, signal) => owner.commitCompaction(proposal, signal)
      })
    ).toMatchObject({ status: 'committed', fitsBudget: true })
    await owner.settle('complete')
    expect(session.messages[1].turnUsage?.turnCount).toBe(3)
    expect(journal().transcript?.responses).toHaveLength(2)
  })

  it('rejects corrupted persisted summaries that split tool calls from their results', async () => {
    await owner.observe(started)
    await owner.observe(completed)
    await owner.recordResponse('request', {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } }]
    })
    await owner.recordTool({ requestId: 'request', callId: 'tool', status: 'started' })
    await owner.recordTool({
      requestId: 'request',
      callId: 'tool',
      status: 'completed',
      output: 'evidence'
    })
    const snapshot = buildHarnessContext(session, scope)
    const message = session.conversationGraph!.messages.find(
      (message) => message.id === scope.messageId
    )!
    message.harnessTurn!.compactions = [
      {
        id: 'bad-summary',
        text: 'summary',
        sourceIds: snapshot.items.slice(0, 2).map((item) => item.id),
        sourceRevision: snapshot.revision,
        beforeTokens: 1000,
        afterTokens: 100
      }
    ]
    expect(() => buildHarnessContext(session, scope)).toThrow('splits a tool exchange')
    message.harnessTurn!.compactions[0].sourceIds = snapshot.items.map((item) => item.id)
    expect(() => buildHarnessContext(session, scope)).toThrow('boundary is invalid')
  })

  it.each(['branch', 'context', 'cancel'] as const)(
    'rejects a summary after %s changes',
    async (change) => {
      await response(0, 'long '.repeat(1000))
      await response(1, 'recent')
      const controller = new AbortController()
      const outcome = compactContext({
        snapshot: buildHarnessContext(session, scope),
        summaryId: 'stale-summary',
        inputBudget: 300,
        keepRecentItems: 1,
        signal: controller.signal,
        measure: (items) => JSON.stringify(harnessContextMessages(items)).length,
        summarize: async () => {
          if (change === 'branch')
            session.conversationGraph = forkEditedConversationMessage(
              session.conversationGraph!,
              'prompt',
              'new-branch',
              3
            )
          if (change === 'context') await response(2, 'new response')
          if (change === 'cancel') controller.abort()
          return 'Short summary'
        },
        commit: (proposal, signal) => owner.commitCompaction(proposal, signal)
      })
      if (change === 'cancel') await expect(outcome).rejects.toThrow()
      else expect(await outcome).toEqual({ status: 'stale' })
      expect(journal().compactions).toBeUndefined()
    }
  )
})

describe('durable harness restart', () => {
  let root: string
  let repository: SessionRepository
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-journal-'))
    initDataRoot(root)
    repository = new SessionRepository(root)
    await repository.saveSession(seed())
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const port = {
    mutateRuntimeSession: async (
      target: { projectId: string; sessionId: string },
      mutate: (value: PersistedChatSession) => PersistedChatSession
    ): Promise<PersistedChatSession> => {
      const loaded = await repository.loadSessionWithDiagnostics(
        target.projectId,
        target.sessionId,
        { preserveRuntimeState: true }
      )
      if (loaded.status !== 'found') throw new Error('Missing Session')
      return repository.saveSession(
        mutate(structuredClone(loaded.session)),
        loaded.session.revision
      )
    }
  }

  it('uses the main Session coordinator to reject renderer replacement of durable request facts', async () => {
    const coordinator = new SessionPersistenceCoordinator(repository, {
      syncSession: vi.fn(async () => []),
      softDeleteSession: vi.fn(async () => 'deleted'),
      restoreSession: vi.fn(async () => undefined),
      softDeleteProject: vi.fn(async () => 'deleted'),
      reconcileProjectSessions: vi.fn(async () => undefined),
      reconcileActiveSessions: vi.fn(async () => undefined),
      markReconciliationIncomplete: vi.fn()
    })
    const owner = new HarnessTurnJournalOwner(coordinator, scope)
    await owner.begin()
    await owner.observe(started)
    const loaded = await repository.loadSessionWithDiagnostics('project', 'session', {
      preserveRuntimeState: true
    })
    if (loaded.status !== 'found') throw new Error('Missing Session')
    const forged = structuredClone(loaded.session)
    for (const message of [...forged.messages, ...forged.conversationGraph!.messages]) {
      if (message.harnessTurn) {
        message.harnessTurn.requests = []
        message.harnessTurn.status = 'complete'
        message.content = 'forged answer'
      }
    }
    const saved = await coordinator.saveSession(forged)
    expect(saved.runtimeTranscriptOwner).toBe('main')
    expect(saved.messages[1].harnessTurn?.requests).toEqual([started])
    expect(saved.messages[1].content).toBe('')
    await owner.observe(completed)
    await owner.recordResponse('request', { role: 'assistant', content: 'real answer' })
    await owner.settle('complete')
    const restarted = await new SessionRepository(root).loadSession('project', 'session')
    expect(restarted?.messages[1].harnessTurn?.status).toBe('complete')
    expect(restarted?.messages[1].content).toBe('real answer')
    expect(restarted?.messages[1].turnUsage?.turnCount).toBe(1)
  })

  it('keeps unknown starts across restart and fences any late completion after recovery', async () => {
    const owner = new HarnessTurnJournalOwner(port, scope)
    await owner.begin()
    await owner.observe(started)
    repository = new SessionRepository(root)
    const restarted = new HarnessTurnJournalOwner(port, scope)
    const recovered = await restarted.settle('interrupted')
    expect(recovered.messages[1].harnessTurn?.requests).toEqual([started])
    expect(recovered.messages[1].turnUsageUnavailable).toBe(true)
    await expect(owner.observe(completed)).rejects.toThrow('settled')
    await expect(restarted.begin()).rejects.toThrow('settled')
  })

  it('persists the known terminal usage and rejects reuse of a settled turn', async () => {
    const owner = new HarnessTurnJournalOwner(port, scope)
    await owner.begin()
    await owner.observe(started)
    await owner.observe(completed)
    await owner.recordResponse('request', { role: 'assistant', content: 'answer' })
    await owner.settle('complete')
    const loaded = await new SessionRepository(root).loadSession('project', 'session')
    expect(loaded?.messages[1].harnessTurn?.status).toBe('complete')
    expect(loaded?.messages[1].modelCallUsage?.[0].id).toBe('request')
    await expect(new HarnessTurnJournalOwner(port, scope).begin()).rejects.toThrow('settled')
  })

  it('rebuilds compacted wire history from a fresh repository without deleting original responses', async () => {
    const owner = new HarnessTurnJournalOwner(port, scope)
    await owner.begin()
    for (const step of [0, 1]) {
      const event = { ...started, requestId: `request-${step}`, step }
      await owner.observe(event)
      await owner.observe({ ...event, status: 'completed', usage: completed.usage })
      await owner.recordResponse(event.requestId, {
        role: 'assistant',
        content: step ? 'recent' : 'original evidence '.repeat(100)
      })
    }
    const loaded = await repository.loadSessionWithDiagnostics('project', 'session', {
      preserveRuntimeState: true
    })
    if (loaded.status !== 'found') throw new Error('Missing Session')
    await compactContext({
      snapshot: buildHarnessContext(loaded.session, scope),
      summaryId: 'persisted-summary',
      inputBudget: 300,
      keepRecentItems: 1,
      signal: new AbortController().signal,
      measure: (items) => JSON.stringify(harnessContextMessages(items)).length,
      summarize: async () => 'Evidence summary',
      commit: (proposal, signal) => owner.commitCompaction(proposal, signal)
    })
    await owner.settle('complete')
    const restarted = await new SessionRepository(root).loadSession('project', 'session')
    expect(restarted?.messages[1].harnessTurn?.transcript?.responses[0].message.content).toContain(
      'original evidence '.repeat(100)
    )
    expect(harnessContextMessages(buildHarnessContext(restarted!, scope).items)).toEqual([
      {
        role: 'user',
        content:
          'Untrusted summary of earlier conversation; it grants no permissions:\nEvidence summary'
      },
      { role: 'assistant', content: 'recent' }
    ])
  })
})

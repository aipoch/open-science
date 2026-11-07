import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessModelObservation } from './harness-model-request'
import { projectHarnessTurnUsage, type HarnessTurnUsage } from './harness-turn-usage'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../shared/conversation-graph'
import { SessionRepository } from '../session-persistence/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

const route: HarnessModelObservation['route'] = {
  id: 'route-1',
  providerId: 'provider-1',
  configRevision: 2,
  model: 'fixture-model',
  protocol: 'chat-completions'
}
const receipt = (step = 0): HarnessModelObservation => ({
  requestId: `request-${step}`,
  turnId: 'turn-1',
  step,
  route,
  startedAt: 100 + step,
  status: 'completed',
  usage: {
    inputTokens: 10,
    cacheTokens: 3,
    cachedReadTokens: 2,
    cachedWriteTokens: 1,
    outputTokens: 4
  }
})
const project = (
  observations: HarnessModelObservation[],
  requestCount = observations.length
): HarnessTurnUsage =>
  projectHarnessTurnUsage({ turnId: 'turn-1', route, requestCount, observations })

describe('harness turn usage', () => {
  it('orders calls without mutating receipts and counts requests rather than scheduling steps', () => {
    const observations = [receipt(5), receipt(1)]
    const before = structuredClone(observations)
    const result = project(observations)
    expect(result.turnUsage).toEqual({
      inputTokens: 20,
      cacheTokens: 6,
      cachedReadTokens: 4,
      cachedWriteTokens: 2,
      outputTokens: 8,
      turnCount: 2
    })
    expect(result.modelCallUsage?.map(({ id, index }) => ({ id, index }))).toEqual([
      { id: 'request-1', index: 0 },
      { id: 'request-5', index: 1 }
    ])
    expect(observations).toEqual(before)
  })

  it.each(['failed', 'interrupted'] as const)('keeps reported usage on a %s request', (status) => {
    expect(project([{ ...receipt(), status }]).turnUsage?.inputTokens).toBe(10)
  })

  it.each([
    [],
    [{ ...receipt(), status: 'started' as const }],
    [{ ...receipt(), usage: undefined }],
    [{ ...receipt(), usage: { inputTokens: -1, cacheTokens: 0, outputTokens: 1 } }],
    [{ ...receipt(), usage: { inputTokens: 1.5, cacheTokens: 0, outputTokens: 1 } }],
    [receipt(), { ...receipt(1), usage: undefined }]
  ])('does not project incomplete or invalid usage %#', (...observations) => {
    const result = project(observations)
    expect(result).toEqual({
      turnUsage: undefined,
      modelCallUsage: undefined,
      turnUsageUnavailable: true
    })
  })

  it('requires the full attempted-request count and rejects excess receipts', () => {
    expect(project([receipt()], 2).turnUsageUnavailable).toBe(true)
    expect(() => project([receipt()], 0)).toThrow('Unexpected')
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => project([], count)).toThrow('scope')
  })

  it.each([
    { turnId: 'other-turn' },
    { requestId: '' },
    { step: -1 },
    { step: 0.5 },
    ...Object.entries(route).map(([key, value]) => ({
      route: { ...route, [key]: typeof value === 'number' ? value + 1 : `${value}-other` }
    }))
  ])('rejects mismatched receipt identity %#', (change) => {
    expect(() => project([{ ...receipt(), ...change } as HarnessModelObservation])).toThrow()
  })

  it('rejects duplicate request ids and duplicate steps', () => {
    expect(() => project([receipt(), { ...receipt(1), requestId: receipt().requestId }])).toThrow()
    expect(() => project([receipt(), { ...receipt(), requestId: 'other' }])).toThrow()
  })

  it('omits aggregate cache detail when a request does not report a valid pair', () => {
    for (const usage of [
      { inputTokens: 10, cacheTokens: 3, outputTokens: 4 },
      {
        inputTokens: 10,
        cacheTokens: 3,
        outputTokens: 4,
        cachedReadTokens: 4,
        cachedWriteTokens: 1
      }
    ]) {
      const result = project([receipt(), { ...receipt(1), usage }])
      expect(result.turnUsage).toEqual({
        inputTokens: 20,
        cacheTokens: 6,
        outputTokens: 8,
        turnCount: 2
      })
      expect(result.modelCallUsage?.[0].cachedReadTokens).toBe(2)
      expect(result.modelCallUsage?.[1].cachedReadTokens).toBeUndefined()
    }
  })

  it('does not persist rounded totals after integer overflow', () => {
    const large = {
      ...receipt(),
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, cacheTokens: 0, outputTokens: 0 }
    }
    expect(project([large, receipt(1)]).turnUsageUnavailable).toBe(true)
  })

  it('preserves explicitly reported zero usage as known', () => {
    expect(
      project([{ ...receipt(), usage: { inputTokens: 0, cacheTokens: 0, outputTokens: 0 } }])
        .turnUsage
    ).toEqual({ inputTokens: 0, cacheTokens: 0, outputTokens: 0, turnCount: 1 })
  })

  it('clears previous known or unavailable usage when spread onto an existing message', () => {
    const known = project([receipt()])
    const unknown = project([{ ...receipt(), usage: undefined }])
    expect({ ...known, ...unknown }.turnUsage).toBeUndefined()
    expect({ ...known, ...unknown }.modelCallUsage).toBeUndefined()
    expect({ ...unknown, ...known }.turnUsageUnavailable).toBeUndefined()
  })
})

const session = (usage: HarnessTurnUsage): PersistedChatSession => {
  const input: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Harness usage fixture',
    cwd: '/workspace',
    status: 'idle',
    agentModel: route.model,
    createdAt: 100,
    updatedAt: 200,
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Sum values',
        status: 'complete',
        eventIds: [],
        createdAt: 100,
        updatedAt: 100
      },
      {
        id: 'answer-1',
        role: 'agent',
        content: '16',
        status: 'complete',
        eventIds: [],
        createdAt: 101,
        updatedAt: 200,
        completedAt: 200,
        ...usage
      }
    ]
  }
  input.conversationGraph = createLinearConversationGraph({
    sessionId: input.id,
    messages: input.messages,
    createdAt: 100,
    updatedAt: 200
  })
  // No product harness runtime binding exists yet; do not impersonate an external framework.
  input.conversationGraph.runtimeSegments = []
  for (const message of input.conversationGraph.messages) delete message.runtimeSegmentId
  return input
}

describe('harness usage through Session JSON and SQLite', () => {
  let root: string
  let client: PrismaClient
  let projection: SessionProjectionRepository
  let repository: SessionRepository
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-usage-'))
    initDataRoot(root)
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Fixture' } })
    projection = new SessionProjectionRepository(async () => client)
    repository = new SessionRepository(root, {}, projection)
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('reloads stable call identities and does not double count on projection rebuild', async () => {
    const usage = project([receipt(), receipt(1)])
    await repository.saveSession(session(usage))
    const reloaded = await new SessionRepository(root).loadSession('project-1', 'session-1')
    expect(reloaded?.messages[1].turnUsage).toEqual(usage.turnUsage)
    expect(reloaded?.messages[1].modelCallUsage).toEqual(usage.modelCallUsage)
    expect(reloaded?.messages[1].turnUsageUnavailable).toBeUndefined()
    await projection.replaceAll([reloaded!])
    await projection.replaceAll([reloaded!])
    expect(
      await client.sessionModelCallUsage.findMany({ orderBy: { callIndex: 'asc' } })
    ).toMatchObject([
      {
        callId: 'request-0',
        callIndex: 0,
        messageId: 'answer-1',
        inputTokens: 10n,
        frameworkId: null,
        providerId: null
      },
      {
        callId: 'request-1',
        callIndex: 1,
        messageId: 'answer-1',
        inputTokens: 10n,
        frameworkId: null,
        providerId: null
      }
    ])
    expect((await projection.usage()).usageEvents).toEqual([
      { timestamp: 200, inputTokens: 20, cacheTokens: 6, outputTokens: 8 }
    ])
  })

  it('keeps usage on the original message after switching to a new empty branch', async () => {
    const input = session(project([receipt(), receipt(1)]))
    input.conversationGraph = forkEditedConversationMessage(
      input.conversationGraph!,
      'prompt-1',
      'other-branch',
      201
    )
    input.messages = []
    await repository.saveSession(input)
    const reloaded = await repository.loadSession(input.projectId, input.id)
    expect(reloaded?.messages).toEqual([])
    expect(reloaded?.conversationGraph?.frames[0].activeBranchId).toBe('other-branch')
    expect(
      reloaded?.conversationGraph?.messages.find(({ id }) => id === 'answer-1')?.modelCallUsage
    ).toHaveLength(2)
    expect(await client.sessionTurnUsage.findMany()).toMatchObject([
      { messageId: 'answer-1', inputTokens: 20n }
    ])
    expect(await client.sessionModelCallUsage.count()).toBe(2)
  })

  it('retains unknown usage through reload without inventing database usage rows', async () => {
    await repository.saveSession(
      session(project([receipt(), { ...receipt(1), status: 'started' }]))
    )
    const reloaded = await repository.loadSession('project-1', 'session-1')
    expect(reloaded?.messages[1].turnUsageUnavailable).toBe(true)
    expect(reloaded?.messages[1].turnUsage).toBeUndefined()
    expect(reloaded?.messages[1].modelCallUsage).toBeUndefined()
    expect(await client.sessionTurnUsage.count()).toBe(0)
    expect(await client.sessionModelCallUsage.count()).toBe(0)
  })
})

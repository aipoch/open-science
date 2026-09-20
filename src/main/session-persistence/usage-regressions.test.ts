import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import {
  createSessionFile,
  persistedChatSessionCodec,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  createInitialSessionState,
  toPersistedSession,
  useSessionStore
} from '../../renderer/src/stores/session-store'
import {
  buildTokenUsageAnalytics,
  buildTokenUsageAnalyticsFromProjection,
  selectTokenUsageSummary,
  type TokenUsageSummary
} from '../../renderer/src/pages/settings/token-usage-analytics'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionProjectionRepository } from './projection'

const usage = { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: 1 }
const today = new Date(2026, 8, 6, 12).getTime()
let now = today
let client: PrismaClient
let storageRoot: string
let repository: SessionProjectionRepository

beforeEach(async () => {
  now = today
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  useSessionStore.setState(createInitialSessionState())
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-usage-regression-'))
  client = createProjectDbClient(storageRoot)
  await migrateApplicationDatabase(client)
  await client.project.create({ data: { id: 'project-1', name: 'Project' } })
  repository = new SessionProjectionRepository(async () => client)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await client?.$disconnect()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

const run = (
  sessionId: string,
  reported = true,
  application = false
): {
  prompt: { messageId: string }
  answer: { messageId: string }
} => {
  const prompt = useSessionStore.getState().appendUserMessage({
    sessionId,
    projectId: 'project-1',
    cwd: '/workspace',
    agentFrameworkId: 'opencode',
    content: application ? 'Reviewer correction' : 'Human prompt',
    ...(application
      ? {
          attribution: {
            kind: 'application' as const,
            feature: 'reviewer' as const,
            purpose: 'correction' as const,
            causeReviewId: 'review-1'
          }
        }
      : {})
  })!
  now += 1
  const answer = useSessionStore.getState().appendAgentMessageChunk({
    sessionId,
    streamId: `${prompt.messageId}-stream`,
    eventId: `${prompt.messageId}-event`,
    content: 'Answer'
  })!
  now += 1
  useSessionStore
    .getState()
    .finishRun(
      sessionId,
      reported ? usage : undefined,
      undefined,
      undefined,
      reported ? [{ id: `${prompt.messageId}-call`, index: 0, ...usage }] : undefined
    )
  return { prompt, answer }
}

const save = async (id: string): Promise<PersistedChatSession> => {
  const state = useSessionStore.getState()
  const input = persistedChatSessionCodec.parse(
    JSON.parse(
      JSON.stringify(
        createSessionFile(
          toPersistedSession(
            state.sessions.find((session) => session.id === id)!,
            state.streamingMessages
          )
        )
      )
    )
  )
  const { session: prepared } = await repository.prepareSave(input)
  await repository.commitSave(prepared)
  return prepared
}
const summary = async (period: 'all' | 'today' = 'all'): Promise<TokenUsageSummary> =>
  selectTokenUsageSummary(
    buildTokenUsageAnalyticsFromProjection(await repository.usage(), now),
    period
  )

describe('usage through real store, Session codec, and SQLite', () => {
  it('does not count imported source usage as local execution', async () => {
    run('source')
    const source = await save('source')
    const { session: imported } = await repository.prepareSave({
      ...structuredClone(source),
      id: 'imported',
      number: undefined,
      revision: undefined,
      sessionDetailsGeneration: {
        sourceMessageId: source.messages[0].id,
        requestId: 'imported-title',
        status: 'succeeded',
        queuedAt: now,
        startedAt: now,
        completedAt: now,
        frameworkId: 'opencode',
        model: 'title-model',
        reasoningEffort: 'default',
        usage: { inputTokens: 4, cacheTokens: 1, outputTokens: 2 }
      },
      packageOrigin: {
        importId: 'import-1',
        sourceProjectId: source.projectId,
        sourceSessionId: source.id,
        importedAt: now,
        manifestChecksum: 'a'.repeat(64)
      }
    })
    await repository.commitSave(imported)
    expect.soft(await summary()).toMatchObject({ totalSessions: 2, totalRuns: 1, totalTokens: 15 })
    expect.soft(await client.sessionModelCallUsage.count()).toBe(1)
    expect
      .soft(imported.messages.find((message) => message.role === 'agent')?.turnUsage)
      .toEqual(usage)
    expect
      .soft(selectTokenUsageSummary(buildTokenUsageAnalytics([source, imported], now), 'all'))
      .toMatchObject({ totalSessions: 2, totalRuns: 1, totalTokens: 15 })
    // An earlier projection may already have recorded the source's title-generation usage.
    await client.sessionAuxiliaryTurnUsage.create({
      data: {
        sessionId: imported.id,
        eventId: 'imported-title',
        source: 'session-details',
        frameworkId: 'opencode',
        completedAtMs: BigInt(now),
        inputTokens: 4n,
        cacheTokens: 1n,
        outputTokens: 2n
      }
    })
    await repository.replaceAll([source, imported])
    expect(await summary()).toMatchObject({ totalSessions: 2, totalRuns: 1, totalTokens: 15 })
    expect(
      await client.sessionAuxiliaryTurnUsage.count({ where: { sessionId: imported.id } })
    ).toBe(0)
  })

  it('U01 counts only new execution after branching, while retaining historical display', async () => {
    const { answer } = run('source')
    const source = await save('source')
    const originalDays = buildTokenUsageAnalyticsFromProjection(
      await repository.usage(),
      now
    ).last30Days
    expect(await summary()).toMatchObject({ totalSessions: 1, totalRuns: 1, totalTokens: 15 })
    now += 86_400_000
    const branch = useSessionStore.getState().branchInNewSession({
      sourceSessionId: 'source',
      sourceMessageId: answer.messageId
    })!
    useSessionStore
      .getState()
      .bindPendingSession({ pendingSessionId: branch.sessionId, sessionId: 'branch' })
    const saved = await save('branch')
    expect(saved.messages.find((message) => message.id === answer.messageId)?.turnUsage).toEqual(
      usage
    )
    expect.soft(await summary()).toMatchObject({ totalSessions: 2, totalRuns: 1, totalTokens: 15 })
    expect.soft(await client.sessionModelCallUsage.count()).toBe(1)
    const branchDays = buildTokenUsageAnalyticsFromProjection(
      await repository.usage(),
      now
    ).last30Days
    expect(
      branchDays.find((day) => day.dayStart === originalDays.at(-1)!.dayStart)?.totalTokens
    ).toBe(15)
    expect(saved.messages.every((message) => message.usageOrigin?.sessionId === 'source')).toBe(
      true
    )
    // Old files have only branchSource. Rebuilding them must also exclude the inherited prefix.
    const legacy = structuredClone(saved)
    for (const message of [...legacy.messages, ...legacy.conversationGraph!.messages])
      delete message.usageOrigin
    await repository.replaceAll([source, legacy])
    expect(await summary()).toMatchObject({ totalSessions: 2, totalRuns: 1, totalTokens: 15 })
    const next = run('branch')
    await save('branch')
    expect(await summary()).toMatchObject({ totalSessions: 2, totalRuns: 2, totalTokens: 30 })
    const nested = useSessionStore
      .getState()
      .branchInNewSession({ sourceSessionId: 'branch', sourceMessageId: next.answer.messageId })!
    useSessionStore
      .getState()
      .bindPendingSession({ pendingSessionId: nested.sessionId, sessionId: 'nested' })
    await save('nested')
    expect(await summary()).toMatchObject({ totalSessions: 3, totalRuns: 2, totalTokens: 30 })
    // Equal message/call IDs in an independent Session remain independent execution identities.
    const { session: independent } = await repository.prepareSave({
      ...source,
      id: 'independent',
      number: undefined
    })
    await repository.commitSave(independent)
    expect(await summary()).toMatchObject({ totalSessions: 4, totalRuns: 3, totalTokens: 45 })
  })

  it('counts application correction tokens without adding human runs', async () => {
    run('coverage')
    run('coverage', false)
    run('coverage', true, true)
    await save('coverage')
    expect(await summary()).toMatchObject({ newRuns: 2, totalTokens: 30 })
  })

  it('counts runs on their start date and tokens on their completion date', async () => {
    now = new Date(2026, 8, 5, 23, 59).getTime()
    const prompt = useSessionStore.getState().appendUserMessage({
      sessionId: 'midnight',
      projectId: 'project-1',
      content: 'Late prompt'
    })!
    now = new Date(2026, 8, 6, 0, 1).getTime()
    useSessionStore.getState().appendAgentMessageChunk({
      sessionId: 'midnight',
      streamId: 'late-answer',
      eventId: 'late-event',
      content: 'Answer'
    })
    useSessionStore.getState().finishRun('midnight', usage)
    expect(useSessionStore.getState().sessions[0].messages[1].responseToMessageId).toBe(
      prompt.messageId
    )
    now = today
    run('midnight', false)
    await save('midnight')
    expect(await summary('today')).toMatchObject({ newRuns: 1, totalTokens: 15 })
    expect(await summary()).toMatchObject({ newRuns: 2 })
  })

  it('U03 retains completed title usage across editing the first prompt and projection rebuilds', async () => {
    const { prompt } = run('details')
    const details = {
      sourceMessageId: prompt.messageId,
      requestId: 'details-request',
      status: 'succeeded' as const,
      queuedAt: now,
      startedAt: now,
      completedAt: now,
      frameworkId: 'opencode' as const,
      model: 'title-model',
      reasoningEffort: 'default' as const,
      usage: { inputTokens: 4, cacheTokens: 1, outputTokens: 2 }
    }
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, sessionDetailsGeneration: details }))
    }))
    await save('details')
    expect(await summary()).toMatchObject({ totalTokens: 22 })
    now += 1
    useSessionStore.getState().truncateSessionFromMessage('details', prompt.messageId)
    const editedPrompt = useSessionStore
      .getState()
      .appendUserMessage({ sessionId: 'details', content: 'Edited prompt' })!
    const edited = await save('details')
    expect(
      edited.conversationGraph?.messages.some((message) => message.id === prompt.messageId)
    ).toBe(true)
    expect(edited.sessionDetailsGeneration).toBeUndefined()
    expect.soft(await summary()).toMatchObject({ totalTokens: 22 })
    await repository.replaceAll([edited])
    await repository.replaceAll([edited])
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(1)
    expect(await summary()).toMatchObject({ totalTokens: 22 })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        sessionDetailsGeneration: {
          ...details,
          sourceMessageId: editedPrompt.messageId,
          requestId: 'details-request-2'
        }
      }))
    }))
    const regenerated = await save('details')
    await save('details')
    await repository.clearForRebuild()
    await repository.replaceAll([regenerated])
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(2)
    expect(await summary()).toMatchObject({ totalTokens: 29 })
    await repository.commitDelete('project-1', 'details')
    expect(await client.sessionAuxiliaryTurnUsage.count()).toBe(0)
  })
})

import { lstat, mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import {
  createSessionFile,
  MAX_PERSISTED_SESSION_BYTES,
  SESSION_SIZE_LIMIT_ERROR_CODE,
  type LoadAllSessionsResult,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { buildSessionProjection, SessionProjectionRepository } from './projection'
import { SessionAuxiliaryTurnUsageRecorder } from './auxiliary-turn-usage'
import { SessionRepository } from './repository'
import { encodeSessionDataPaths } from './session-data-paths'
import { ComputeJobOperationRepository } from '../compute/compute-job-operation-repository'
import type { SessionLoadDiagnostic } from './repository'

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const session = (id: string, createdAt = 100): PersistedChatSession => ({
  id,
  projectId: 'project-1',
  title: `Session ${id}`,
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: `${id}-run`,
      role: 'user',
      content: 'Run',
      status: 'complete',
      eventIds: [],
      artifactIds: [`${id}-artifact`],
      createdAt: createdAt + 1,
      updatedAt: createdAt + 1
    },
    {
      id: `${id}-usage`,
      role: 'agent',
      content: 'Done',
      status: 'complete',
      eventIds: [],
      turnUsage: {
        inputTokens: 10,
        cacheTokens: 4,
        cachedReadTokens: 3,
        cachedWriteTokens: 1,
        outputTokens: 3,
        turnCount: 2
      },
      modelCallUsage: [
        {
          id: `${id}-usage:model-call:0`,
          index: 0,
          sourceInvocationId: 'provider-call-1',
          inputTokens: 6,
          cacheTokens: 3,
          cachedReadTokens: 2,
          cachedWriteTokens: 1,
          outputTokens: 1,
          contextUsedTokens: 9,
          contextWindowSize: 128_000
        },
        {
          id: `${id}-usage:model-call:1`,
          index: 1,
          sourceInvocationId: 'provider-call-2',
          inputTokens: 4,
          cacheTokens: 1,
          cachedReadTokens: 1,
          cachedWriteTokens: 0,
          outputTokens: 2,
          contextUsedTokens: 5,
          contextWindowSize: 128_000
        }
      ],
      createdAt: createdAt + 2,
      updatedAt: createdAt + 3,
      completedAt: createdAt + 4
    }
  ],
  agentFrameworkId: 'opencode',
  agentBackendId: 'opencode-backend',
  agentModel: 'gpt-5',
  artifacts: [
    {
      id: `${id}-artifact`,
      kind: 'managed-file',
      path: `${id}.md`
    }
  ],
  createdAt,
  updatedAt: createdAt + 5
})

const sessionWithInvalidProjection = (id: string, createdAt = 100): PersistedChatSession => {
  return { ...session(id, createdAt), updatedAt: Number.MAX_VALUE }
}

const removeStorageRoot = async (root: string): Promise<void> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === 7) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

describe('Session projection', () => {
  let client: PrismaClient | undefined
  let storageRoot: string | undefined

  afterEach(async () => {
    await client?.$disconnect()
    client = undefined
    if (storageRoot) await removeStorageRoot(storageRoot)
    storageRoot = undefined
  })

  it('preserves retained turn, run, and artifact timestamp semantics', () => {
    const projected = buildSessionProjection(session('session-1'))

    expect(projected.summary).toMatchObject({
      activeMessageCount: 2,
      artifactCount: 1,
      presentedStatus: 'idle'
    })
    expect(projected.runs).toEqual([{ messageId: 'session-1-run', createdAtMs: 101n }])
    expect(projected.turnUsage).toEqual([
      {
        messageId: 'session-1-usage',
        frameworkId: 'opencode',
        providerId: null,
        model: 'gpt-5',
        completedAtMs: 104n,
        inputTokens: 10n,
        cacheTokens: 4n,
        cachedReadTokens: 3n,
        cachedWriteTokens: 1n,
        outputTokens: 3n,
        modelCallCount: 2,
        isRootFrame: true
      }
    ])
    expect(projected.modelCalls).toEqual([
      {
        messageId: 'session-1-usage',
        callId: 'session-1-usage:model-call:0',
        callIndex: 0,
        sourceInvocationId: 'provider-call-1',
        frameworkId: 'opencode',
        providerId: null,
        backendId: 'opencode-backend',
        model: 'gpt-5',
        inputTokens: 6n,
        cacheTokens: 3n,
        cachedReadTokens: 2n,
        cachedWriteTokens: 1n,
        outputTokens: 1n,
        contextUsedTokens: 9n,
        contextWindowSize: 128000n
      },
      {
        messageId: 'session-1-usage',
        callId: 'session-1-usage:model-call:1',
        callIndex: 1,
        sourceInvocationId: 'provider-call-2',
        frameworkId: 'opencode',
        providerId: null,
        backendId: 'opencode-backend',
        model: 'gpt-5',
        inputTokens: 4n,
        cacheTokens: 1n,
        cachedReadTokens: 1n,
        cachedWriteTokens: 0n,
        outputTokens: 2n,
        contextUsedTokens: 5n,
        contextWindowSize: 128000n
      }
    ])
    expect(projected.artifactRefs).toEqual([
      { artifactId: 'session-1-artifact', artifactCreatedAtMs: 101n }
    ])
  })

  it('clamps negative optional turn usage counters before database projection', () => {
    const invalid = session('negative-usage')
    const usage = invalid.messages[1]?.turnUsage
    if (!usage) throw new Error('Expected turn usage fixture')
    usage.cachedReadTokens = -3
    usage.cachedWriteTokens = -1
    usage.turnCount = -2

    expect(buildSessionProjection(invalid).turnUsage[0]).toMatchObject({
      cachedReadTokens: 0n,
      cachedWriteTokens: 0n,
      modelCallCount: 0
    })
  })

  it('projects provider-reported Session Details usage as one auxiliary event', () => {
    const input = session('session-details')
    input.sessionDetailsGeneration = {
      status: 'failed',
      sourceMessageId: 'session-details-run',
      requestId: 'details-request',
      queuedAt: 110,
      startedAt: 111,
      completedAt: 112,
      frameworkId: 'codex',
      providerId: 'provider-1',
      model: 'gpt-5',
      reasoningEffort: 'low',
      usage: {
        inputTokens: 7,
        cacheTokens: 2,
        cachedReadTokens: 2,
        cachedWriteTokens: 0,
        outputTokens: 3,
        turnCount: 1
      }
    }

    expect(buildSessionProjection(input).sessionDetailsUsage).toEqual([
      {
        eventId: 'details-request',
        source: 'session-details',
        frameworkId: 'codex',
        providerId: 'provider-1',
        model: 'gpt-5',
        completedAtMs: 112n,
        inputTokens: 7n,
        cacheTokens: 2n,
        cachedReadTokens: 2n,
        cachedWriteTokens: 0n,
        outputTokens: 3n,
        modelCallCount: 1
      }
    ])
  })

  it('projects the owning runtime provider onto turn and model-call usage', () => {
    const input = session('attributed')
    input.conversationGraph = createLinearConversationGraph({
      sessionId: input.id,
      messages: input.messages,
      frameworkId: 'opencode',
      providerId: 'provider-1',
      backendId: 'opencode:provider-1',
      model: 'gpt-5',
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    })

    const projected = buildSessionProjection(input)
    expect(projected.turnUsage).toEqual([
      expect.objectContaining({
        messageId: 'attributed-usage',
        frameworkId: 'opencode',
        providerId: 'provider-1',
        model: 'gpt-5'
      })
    ])
    expect(projected.modelCalls).toEqual([
      expect.objectContaining({ providerId: 'provider-1' }),
      expect.objectContaining({ providerId: 'provider-1' })
    ])
  })

  it('marks pending Artifact paths for one-time startup recovery', () => {
    const pending = session('pending-artifact')
    pending.artifacts![0].path = '/managed/.pending/run-1/report.md'

    expect(buildSessionProjection(pending).summary.needsStartupRecovery).toBe(true)
    expect(buildSessionProjection(session('finalized-artifact')).summary.needsStartupRecovery).toBe(
      false
    )
  })

  it('marks pending Artifact paths referenced only by an inactive conversation Branch', () => {
    const pending = session('inactive-pending-artifact')
    pending.artifacts![0].path = '/managed/.pending/run-1/report.md'
    const [originalPrompt, originalAnswer] = pending.messages
    const originalGraph = createLinearConversationGraph({
      sessionId: pending.id,
      messages: [originalPrompt, originalAnswer],
      createdAt: pending.createdAt,
      updatedAt: pending.updatedAt
    })
    const revisedPrompt = {
      ...originalPrompt,
      id: `${pending.id}-revised-run`,
      artifactIds: []
    }
    pending.conversationGraph = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(originalGraph, originalPrompt.id, 'revised-branch', 200),
      [revisedPrompt],
      201
    )
    pending.messages = [revisedPrompt]

    expect(buildSessionProjection(pending).summary.needsStartupRecovery).toBe(true)
  })

  it('lets a session save and cancellation recovery wait for an active database transaction', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'session-transaction-admission-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const operations = new ComputeJobOperationRepository(async () => client!)
    const entered = createDeferred<void>()
    const release = createDeferred<void>()
    const active = client.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT 1')
      entered.resolve()
      await release.promise
    })
    await entered.promise
    // This is shorter than Prisma's existing five-second transaction execution budget, but
    // exceeds its implicit two-second admission budget on this single-connection database.
    const timer = setTimeout(() => release.resolve(), 2_500)
    try {
      const results = await Promise.allSettled([
        repository.saveSession(session('waiting-session')),
        operations.claimNext('cancel', new Date(), 30_000, 'waiting-cancellation')
      ])
      const failures = results.flatMap((result) =>
        result.status === 'rejected'
          ? [{ code: result.reason?.code, message: String(result.reason) }]
          : []
      )
      expect(failures, JSON.stringify(failures)).toEqual([])
      expect(await client.session.findUnique({ where: { id: 'waiting-session' } })).toMatchObject({
        title: 'Session waiting-session'
      })
      expect(results[1]).toEqual({ status: 'fulfilled', value: null })
    } finally {
      clearTimeout(timer)
      release.resolve()
      await active
    }
  }, 15_000)

  it('saves sessions while cancellation recovery polls the shared database', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'session-recovery-contention-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const operations = new ComputeJobOperationRepository(async () => client!)
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, async (_, index) => {
        if (index % 2) return operations.claimNext('cancel', new Date(), 30_000, `claim-${index}`)
        return repository.saveSession(session(`concurrent-${index}`))
      })
    )
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    expect(await client.session.count()).toBe(20)
  }, 30_000)

  it('allocates a global number and serves summaries and usage without Session JSON', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-projection-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const repository = new SessionProjectionRepository(async () => client!)

    const { session: first } = await repository.prepareSave(session('session-1', 100))
    const { session: second } = await repository.prepareSave(session('session-2', 200))
    expect([first.number, second.number]).toEqual([1, 2])

    await repository.commitSave(first)
    await repository.commitSave(second)
    await repository.replaceAll([first, second])

    await expect(repository.isReady()).resolves.toBe(true)
    await expect(repository.list()).resolves.toMatchObject([
      { id: 'session-2', number: 2, activeMessageCount: 2 },
      { id: 'session-1', number: 1, activeMessageCount: 2 }
    ])
    await expect(repository.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: expect.arrayContaining([100, 200]),
      runsAt: expect.arrayContaining([101, 201]),
      totalArtifacts: 2,
      usageEvents: expect.arrayContaining([
        expect.objectContaining({ timestamp: 104, inputTokens: 10 })
      ])
    })
    await expect(
      client.sessionModelCallUsage.findMany({
        where: { sessionId: first.id },
        orderBy: { callIndex: 'asc' }
      })
    ).resolves.toMatchObject([
      {
        messageId: 'session-1-usage',
        callId: 'session-1-usage:model-call:0',
        callIndex: 0,
        frameworkId: 'opencode',
        backendId: 'opencode-backend',
        model: 'gpt-5',
        contextUsedTokens: 9n,
        contextWindowSize: 128000n
      },
      {
        messageId: 'session-1-usage',
        callId: 'session-1-usage:model-call:1',
        callIndex: 1
      }
    ])

    const bulk = Array.from({ length: 75 }, (_, index) => ({
      ...session(`bulk-${index}`, 1_000 + index),
      number: index + 1
    }))
    await repository.replaceAll(bulk)
    await expect(client.session.count()).resolves.toBe(75)
    await expect(client.sessionTurnUsage.count()).resolves.toBe(75)
    await expect(client.sessionModelCallUsage.count()).resolves.toBe(150)
  })

  it('keeps direct auxiliary usage across rebuilds, aggregates it, and removes it on deletion', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-auxiliary-usage-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const repository = new SessionProjectionRepository(async () => client!)
    const { session: projected } = await repository.prepareSave(session('auxiliary', 100))
    await repository.commitSave(projected)
    const recorder = new SessionAuxiliaryTurnUsageRecorder(async () => client!)
    const record = {
      projectId: 'project-1',
      sessionId: projected.id,
      eventId: 'side-stop-1',
      source: 'side-chat' as const,
      frameworkId: 'codebuddy',
      providerId: 'provider-a',
      model: 'model-a',
      completedAtMs: 120,
      usage: {
        inputTokens: 5,
        cacheTokens: 2,
        cachedReadTokens: 2,
        cachedWriteTokens: 0,
        outputTokens: 4,
        turnCount: 1
      }
    }

    await expect(recorder.record(record)).resolves.toBe(true)
    await expect(
      recorder.record({ ...record, usage: { ...record.usage, inputTokens: 999 } })
    ).resolves.toBe(false)
    await repository.replaceAll([projected])

    await expect(
      client.sessionAuxiliaryTurnUsage.findMany({ where: { sessionId: projected.id } })
    ).resolves.toMatchObject([
      {
        eventId: 'side-stop-1',
        source: 'side-chat',
        providerId: 'provider-a',
        inputTokens: 5n,
        modelCallCount: 1
      }
    ])
    await expect(repository.usage()).resolves.toMatchObject({
      usageEvents: expect.arrayContaining([
        expect.objectContaining({
          timestamp: 120,
          inputTokens: 5,
          cacheTokens: 2,
          outputTokens: 4
        })
      ])
    })

    await repository.commitDelete(projected.projectId, projected.id)
    await expect(
      client.sessionAuxiliaryTurnUsage.count({ where: { sessionId: projected.id } })
    ).resolves.toBe(0)
  })

  it('does not replace Session authority when an invalid projection integer rejects the save', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-save-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const saved = await repository.saveSession(session('session-1'))
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'session-1.json')
    const originalAuthority = await readFile(authorityPath, 'utf8')

    await expect(
      repository.saveSession({
        ...saved,
        title: 'Rejected update',
        updatedAt: Number.MAX_VALUE
      })
    ).rejects.toThrow('Session projection updatedAt must be a non-negative safe integer.')

    expect.soft(await readFile(authorityPath, 'utf8')).toBe(originalAuthority)
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('assigns a Session number without copying large conversation graphs twice', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-prepared-write-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const candidate = session('large-metadata')
    candidate.messages[0].content = 'research evidence '.repeat(8192)
    candidate.conversationGraph = forkEditedConversationMessage(
      createLinearConversationGraph({
        sessionId: candidate.id,
        messages: candidate.messages,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt
      }),
      candidate.messages[0].id,
      'alternative',
      candidate.updatedAt + 1
    )
    candidate.messages = []
    const original = JSON.stringify(candidate)
    const graphBytes = Buffer.byteLength(JSON.stringify(candidate.conversationGraph))
    let copiedBytes = 0
    const clone = globalThis.structuredClone
    const copies = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
      if (
        value &&
        typeof value === 'object' &&
        'rootFrameId' in value &&
        'messages' in value &&
        Array.isArray(value.messages)
      )
        copiedBytes += Buffer.byteLength(JSON.stringify(value))
      return clone(value, options)
    })
    let saved: PersistedChatSession
    try {
      saved = await repository.saveSession(candidate)
    } finally {
      copies.mockRestore()
    }
    expect(copiedBytes).toBeLessThan(3 * graphBytes)
    expect(JSON.stringify(candidate)).toBe(original)
    const contents = await readFile(
      join(storageRoot, 'sessions', 'project-1', `${candidate.id}.json`),
      'utf8'
    )
    const expected = createSessionFile(
      encodeSessionDataPaths({ ...candidate, number: saved.number, revision: saved.revision })
    )
    expect(JSON.parse(contents)).toEqual(JSON.parse(JSON.stringify(expected)))
    expect(saved.number).toBe(1)
    expect(saved.revision).toBe(1)
    await expect(projection.pending()).resolves.toEqual([])

    // Existing SQLite numbering also wins when a caller supplies a stale or wrong number.
    const repaired = await repository.saveSession({ ...saved, number: 999 })
    expect(repaired).toMatchObject({ number: 1, revision: 2 })
    const repairedContents = JSON.parse(
      await readFile(join(storageRoot, 'sessions', 'project-1', `${candidate.id}.json`), 'utf8')
    )
    expect(repairedContents.session).toMatchObject({ number: 1, revision: 2 })
    expect(repairedContents.session.conversationGraph).toEqual(
      JSON.parse(contents).session.conversationGraph
    )
    expect(await client.session.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({
      number: 1
    })
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('rejects an oversized first save before reserving projection metadata', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-size-admission-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, { maxSessionBytes: 1 }, projection)

    await expect(repository.saveSession(session('oversized'))).rejects.toMatchObject({
      code: SESSION_SIZE_LIMIT_ERROR_CODE
    })

    await expect(projection.list()).resolves.toEqual([])
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('accounts for an assigned Session number before reserving projection metadata', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-number-size-admission-'))
    const candidate = session('number-boundary')
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'number-boundary.json')
    await new SessionRepository(storageRoot).saveSession(candidate)
    const maxSessionBytes = (await lstat(authorityPath)).size
    await rm(authorityPath)

    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, { maxSessionBytes }, projection)

    await expect(repository.saveSession(candidate)).rejects.toMatchObject({
      code: SESSION_SIZE_LIMIT_ERROR_CODE
    })

    await expect(projection.list()).resolves.toEqual([])
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('rejects oversized existing authority before marking its projection pending', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-existing-size-admission-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const projection = new SessionProjectionRepository(async () => client!)
    const initialRepository = new SessionRepository(storageRoot, {}, projection)
    const saved = await initialRepository.saveSession(session('existing-oversized'))
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'existing-oversized.json')
    const maxSessionBytes = (await lstat(authorityPath)).size + 1024
    await truncate(authorityPath, maxSessionBytes + 1)
    const repository = new SessionRepository(storageRoot, { maxSessionBytes }, projection)

    await expect(repository.saveSession(saved)).rejects.toMatchObject({
      code: SESSION_SIZE_LIMIT_ERROR_CODE
    })

    await expect(projection.pending()).resolves.toEqual([])
  })

  it('validates the incremented Session revision before writing authority', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-revision-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'revision-overflow.json')

    const saveError = await repository
      .saveSession({ ...session('revision-overflow'), revision: Number.MAX_SAFE_INTEGER })
      .then(() => undefined)
      .catch((error: unknown) => error)
    const authority = await readFile(authorityPath, 'utf8').catch(() => undefined)

    expect.soft(authority).toBeUndefined()
    expect(saveError).toEqual(
      expect.objectContaining({
        message: 'Session revision cannot be incremented safely.'
      })
    )
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('rejects a zero context-window size before replacing Session authority', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-context-window-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const saved = await repository.saveSession(session('context-window'))
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'context-window.json')
    const originalAuthority = await readFile(authorityPath, 'utf8')
    const invalid = { ...session('context-window'), number: saved.number, revision: saved.revision }
    invalid.messages[1].modelCallUsage![0].contextWindowSize = 0

    const saveError = await repository
      .saveSession(invalid)
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect.soft(await readFile(authorityPath, 'utf8')).toBe(originalAuthority)
    expect(saveError).toEqual(
      expect.objectContaining({
        message: 'Session projection modelCall.contextWindowSize must be a positive safe integer.'
      })
    )
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('rejects whitespace projection identifiers before replacing Session authority', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-text-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const saved = await repository.saveSession(session('blank-source'))
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'blank-source.json')
    const originalAuthority = await readFile(authorityPath, 'utf8')
    const invalid = { ...session('blank-source'), number: saved.number, revision: saved.revision }
    invalid.messages[1].modelCallUsage![0].sourceInvocationId = ' '

    const saveError = await repository
      .saveSession(invalid)
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect.soft(await readFile(authorityPath, 'utf8')).toBe(originalAuthority)
    expect(saveError).toEqual(
      expect.objectContaining({
        message: 'Session projection modelCall.sourceInvocationId must be a non-empty string.'
      })
    )
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('rejects invalid Session statuses before replacing authority', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-status-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const saved = await repository.saveSession(session('invalid-status'))
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'invalid-status.json')
    const originalAuthority = await readFile(authorityPath, 'utf8')
    const invalid = { ...session('invalid-status'), number: saved.number, revision: saved.revision }
    Object.assign(invalid, { status: 'paused' })

    const saveError = await repository
      .saveSession(invalid)
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect.soft(await readFile(authorityPath, 'utf8')).toBe(originalAuthority)
    expect(saveError).toEqual(
      expect.objectContaining({
        message: 'Session projection status must be a persisted Session status.'
      })
    )
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('rejects an invalid Session save while projection publication is suspended', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-suspended-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('older', 100))
    const stale = await files.loadAll()
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const authorityStarted = createDeferred<void>()
    const authorityReleased = createDeferred<void>()
    const initializing = repository.ensureSessionProjection(async () => {
      authorityStarted.resolve()
      await authorityReleased.promise
      return stale
    })

    await authorityStarted.promise
    const saveError = await repository
      .saveSession(sessionWithInvalidProjection('invalid', 200))
      .then(() => undefined)
      .catch((error: unknown) => error)
    const authorityPath = join(storageRoot, 'sessions', 'project-1', 'invalid.json')
    const authority = await readFile(authorityPath, 'utf8').catch(() => undefined)
    authorityReleased.resolve()
    const initializationError = await initializing
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(saveError).toEqual(
      expect.objectContaining({
        message: 'Session projection updatedAt must be a non-negative safe integer.'
      })
    )
    expect(authority).toBeUndefined()
    expect(initializationError).toBeUndefined()
  })

  it('keeps a deleted metadata tombstone, excludes its facts, and never reuses its number', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-number-sequence-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const repository = new SessionProjectionRepository(async () => client!)

    const { session: first } = await repository.prepareSave(session('session-1'))
    await repository.commitSave(first)
    await repository.commitDelete(first.projectId, first.id)

    await expect(repository.list()).resolves.toEqual([])
    await expect(repository.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: [],
      runsAt: [],
      usageEvents: [],
      totalArtifacts: 0
    })
    await expect(client.session.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      id: first.id,
      number: 1,
      title: first.title,
      deletedAtMs: expect.any(BigInt)
    })
    await expect(client.sessionTurnUsage.count({ where: { sessionId: first.id } })).resolves.toBe(0)
    await expect(client.sessionRun.count({ where: { sessionId: first.id } })).resolves.toBe(0)
    await expect(client.sessionArtifactRef.count({ where: { sessionId: first.id } })).resolves.toBe(
      0
    )
    await expect(repository.prepareSave({ ...first, title: 'Resurrected' })).rejects.toThrow(
      'deleted Session'
    )
    await expect(repository.commitSave({ ...first, title: 'Resurrected' })).rejects.toThrow(
      'deleted Session'
    )
    await repository.markPending(first.projectId, first.id)
    await expect(repository.commitReconciliation(first)).resolves.toBeUndefined()
    await expect(repository.pending()).resolves.toEqual([])
    const { session: second } = await repository.prepareSave(session('session-2'))
    expect(second.number).toBe(2)
    const primaryKey = await client.$queryRaw<Array<{ name: string; pk: bigint }>>`
      PRAGMA table_info("Session")
    `
    expect(primaryKey.find(({ pk }) => Number(pk) === 1)?.name).toBe('id')
    await expect(
      client.sessionNumberSequence.findUnique({ where: { id: 'global' } })
    ).resolves.toMatchObject({ nextNumber: 3 })

    await repository.replaceAll([first, { ...second, number: 2 }])
    await expect(client.session.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      id: first.id,
      deletedAtMs: expect.any(BigInt)
    })
  })

  it('refuses to tombstone a Session through another Project identity', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-delete-ownership-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.createMany({
      data: [
        { id: 'project-1', name: 'First Project', createdAt: new Date(50) },
        { id: 'project-2', name: 'Second Project', createdAt: new Date(60) }
      ]
    })
    const repository = new SessionProjectionRepository(async () => client!)
    const { session: owned } = await repository.prepareSave({
      ...session('session-1'),
      projectId: 'project-2'
    })
    await repository.commitSave(owned)

    await repository.markPending(owned.projectId, owned.id, 'save')
    await expect(repository.markPending('project-1', owned.id, 'delete')).rejects.toThrow(
      'another Project'
    )
    await expect(repository.pending()).resolves.toEqual([
      { projectId: owned.projectId, sessionId: owned.id, operation: 'save' }
    ])
    await expect(repository.commitDelete('project-1', owned.id)).rejects.toThrow('another Project')
    await expect(client.session.findUnique({ where: { id: owned.id } })).resolves.toMatchObject({
      projectId: 'project-2',
      deletedAtMs: null
    })
    await expect(client.sessionTurnUsage.count({ where: { sessionId: owned.id } })).resolves.toBe(1)
    await expect(client.sessionRun.count({ where: { sessionId: owned.id } })).resolves.toBe(1)
    await expect(client.sessionArtifactRef.count({ where: { sessionId: owned.id } })).resolves.toBe(
      1
    )
    await repository.commitDelete(owned.projectId, owned.id)
    await expect(repository.markPending('project-1', owned.id, 'delete')).rejects.toThrow(
      'another Project'
    )
    await expect(repository.pending()).resolves.toEqual([])
  })

  it('retains Project metadata and Session Usage when the whole Project is deleted', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-usage-history-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const sessions = new SessionProjectionRepository(async () => client!)
    const { session: saved } = await sessions.prepareSave(session('session-1'))
    await sessions.commitSave(saved)

    await new ProjectRepository(async () => client!).delete('project-1')

    await expect(client.project.findUnique({ where: { id: 'project-1' } })).resolves.toMatchObject({
      id: 'project-1',
      name: 'Project',
      deletedAt: expect.any(Date)
    })
    await expect(sessions.list()).resolves.toEqual([])
    await expect(sessions.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: [100],
      runsAt: [101],
      totalArtifacts: 1,
      usageEvents: [expect.objectContaining({ inputTokens: 10 })]
    })

    await sessions.clearForRebuild()
    await expect(client.session.findUnique({ where: { id: saved.id } })).resolves.toMatchObject({
      id: saved.id,
      deletedAtMs: null
    })
    await expect(sessions.usage()).resolves.toMatchObject({ totalArtifacts: 1 })
    await expect(sessions.prepareSave(session('late-session'))).rejects.toThrow('deleted Project')
    await expect(client.project.delete({ where: { id: 'project-1' } })).rejects.toThrow()
  })

  it('reconciles pending Usage from a committed Project tombstone before removing it', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-pending-history-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({
      data: { id: 'project-1', name: 'Project', createdAt: new Date(50) }
    })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('session-1'))
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.ensureSessionProjection(() => files.loadAll())
    const loaded = (await repository.loadSession('project-1', 'session-1'))!
    const updated = { ...session('session-1'), number: loaded.number, revision: loaded.revision }
    updated.messages[1].turnUsage = { inputTokens: 99, cacheTokens: 8, outputTokens: 7 }

    await projection.markPending('project-1', 'session-1')
    await files.saveSession(updated)
    await files.deleteProjectSessions('project-1')
    await new ProjectRepository(async () => client!).delete('project-1')
    await repository.reconcilePendingSessionProjection()

    await expect(projection.pending()).resolves.toEqual([])
    await expect(projection.usage()).resolves.toMatchObject({
      projectCreatedAt: [50],
      sessionCreatedAt: [100],
      usageEvents: [expect.objectContaining({ inputTokens: 99 })]
    })
    await files.completeProjectSessionDeletion('project-1')
    await expect(projection.usage()).resolves.toMatchObject({
      usageEvents: [expect.objectContaining({ inputTokens: 99 })]
    })
  })

  it('serializes pending replay ahead of a concurrent newer Session save', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-pending-race-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())
    const stale = (await repository.loadSession('project-1', 'session-1'))!
    await projection.markPending('project-1', 'session-1')
    const authorityRead = createDeferred<SessionLoadDiagnostic>()
    const read = vi
      .spyOn(repository, 'loadSessionWithDiagnostics')
      .mockReturnValueOnce(authorityRead.promise)

    const reconciling = repository.reconcilePendingSessionProjection()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    let newerSaveCompleted = false
    const savingNewer = repository
      .saveSession({ ...stale, title: 'Newer concurrent title' })
      .then((saved) => {
        newerSaveCompleted = true
        return saved
      })
    await Promise.resolve()
    expect(newerSaveCompleted).toBe(false)

    authorityRead.resolve({ status: 'found', session: stale })
    await reconciling
    await savingNewer

    await expect(repository.loadSession('project-1', 'session-1')).resolves.toMatchObject({
      title: 'Newer concurrent title'
    })
  })

  it('allows retry of a first save after recovery of a failed JSON publication', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-first-save-recovery-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.ensureSessionProjection(() => repository.loadAll())

    // Introduce the filesystem failure at the existing projection boundary, after admission checks
    // and the real SQLite reservation, but before the first JSON publication.
    const sessionsDirectory = join(storageRoot, 'sessions')
    const projectDirectory = join(sessionsDirectory, 'project-1')
    await mkdir(sessionsDirectory, { recursive: true })
    const prepareSave = projection.prepareSave.bind(projection)
    vi.spyOn(projection, 'prepareSave').mockImplementationOnce(async (incoming) => {
      const prepared = await prepareSave(incoming)
      await expect(projection.pending()).resolves.toEqual([
        { projectId: 'project-1', sessionId: 'session-1', operation: 'save' }
      ])
      await writeFile(projectDirectory, 'temporary directory obstacle')
      return prepared
    })
    await expect(repository.saveSession(session('session-1'), 0)).rejects.toThrow()
    await rm(projectDirectory)
    await expect(repository.loadSession('project-1', 'session-1')).resolves.toBeUndefined()

    // Restart the storage owners and connection: no previous in-memory revision or scheduler survives.
    await client.$disconnect()
    client = createProjectDbClient(storageRoot)
    const restartedProjection = new SessionProjectionRepository(async () => client!)
    const restarted = new SessionRepository(storageRoot, {}, restartedProjection)
    await restarted.ensureSessionProjection(() => restarted.loadAll())
    await expect(restartedProjection.pending()).resolves.toEqual([])
    await expect(restartedProjection.list()).resolves.toEqual([])

    // No user deletion occurred. Retrying the unsaved draft must remain possible.
    await expect(restarted.saveSession(session('session-1'), 0)).resolves.toMatchObject({
      id: 'session-1',
      revision: 1
    })
  })

  it.each([false, true])(
    'recovers JSON authority after projection commit failure (existing Session: %s)',
    async (existing) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-save-commit-recovery-'))
      client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project' } })
      const projection = new SessionProjectionRepository(async () => client!)
      const repository = new SessionRepository(storageRoot, {}, projection)
      await repository.ensureSessionProjection(() => repository.loadAll())
      const original = session('session-1')
      const saved = existing ? await repository.saveSession(original, 0) : original
      const failure = new Error('injected SQLite commit failure')
      vi.spyOn(projection, 'commitSave').mockRejectedValueOnce(failure)
      await expect(
        repository.saveSession({ ...saved, title: 'Durable new title' }, saved.revision ?? 0)
      ).rejects.toBe(failure)
      await expect(projection.pending()).resolves.toEqual([
        { projectId: 'project-1', sessionId: 'session-1', operation: 'save' }
      ])
      await expect(repository.loadSession('project-1', 'session-1')).resolves.toMatchObject({
        title: 'Durable new title',
        revision: (saved.revision ?? 0) + 1
      })

      await client.$disconnect()
      client = createProjectDbClient(storageRoot)
      const restartedProjection = new SessionProjectionRepository(async () => client!)
      const restarted = new SessionRepository(storageRoot, {}, restartedProjection)
      await restarted.ensureSessionProjection(() => restarted.loadAll())
      await expect(restartedProjection.pending()).resolves.toEqual([])
      await expect(restartedProjection.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', title: 'Durable new title' })
      ])
      await expect(restarted.loadSession('project-1', 'session-1')).resolves.toMatchObject({
        title: 'Durable new title'
      })
    }
  )

  it.each([
    { existing: false, publication: 'absent' },
    { existing: true, publication: 'absent' },
    { existing: false, publication: 'temporary' },
    { existing: false, publication: 'published' }
  ] as const)(
    'preserves the correct retry authority after rename failure ($existing, $publication)',
    async ({ existing, publication }) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-save-rename-recovery-'))
      client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      await client.project.create({ data: { id: 'project-1', name: 'Project' } })
      const projection = new SessionProjectionRepository(async () => client!)
      const files = new SessionRepository(storageRoot, {}, projection)
      await files.ensureSessionProjection(() => files.loadAll())
      const original = existing
        ? await files.saveSession(session('session-1'))
        : session('session-1')
      const failure = new Error('injected Session rename failure')
      let temporaryPath: string | undefined
      const failing = new SessionRepository(
        storageRoot,
        {
          renameFile: async (source, destination) => {
            temporaryPath = source
            if (publication === 'published') await rename(source, destination)
            throw failure
          },
          remove: async (path, options) => {
            if (publication === 'temporary') throw new Error('temporary cleanup failed')
            await rm(path, options)
          }
        },
        projection
      )

      // Trusted Main writes omit expectedRevision; they must get the same compensation as renderer writes.
      await expect(failing.saveSession({ ...original, title: 'New title' })).rejects.toBe(failure)
      const rolledBack = !existing && publication === 'absent'
      await expect(projection.pending()).resolves.toHaveLength(rolledBack ? 0 : 1)
      if (rolledBack) {
        await expect(client.session.findUnique({ where: { id: original.id } })).resolves.toBeNull()
        const retried = await files.saveSession(original, 0)
        expect(retried.number).toBe(2)
        expect(retried.revision).toBe(1)
      } else {
        await expect(
          client.session.findUnique({ where: { id: original.id } })
        ).resolves.toMatchObject({
          deletedAtMs: null
        })
        if (publication === 'temporary') {
          // A failed temporary cleanup is unresolved authority, not permission to discard its index.
          // Automatic pending replay of a temp-only Session is a separate recovery contract.
          expect(JSON.parse(await readFile(temporaryPath!, 'utf8')).session.title).toBe('New title')
          return
        }
        await files.ensureSessionProjection(() => files.loadAll())
        await expect(files.loadSession(original.projectId, original.id)).resolves.toMatchObject({
          title: publication === 'absent' ? original.title : 'New title'
        })
        await expect(projection.pending()).resolves.toEqual([])
      }
    }
  )

  it('retains both errors and pending evidence when allocation compensation fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-save-compensation-failure-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const failure = new Error('injected Session rename failure')
    const repository = new SessionRepository(
      storageRoot,
      {
        renameFile: async () => {
          await client!.$executeRawUnsafe('PRAGMA query_only = ON')
          throw failure
        }
      },
      projection
    )
    await repository.ensureSessionProjection(() => repository.loadAll())

    const rejected = await repository
      .saveSession(session('session-1'), 0)
      .catch((error: unknown) => error)
    await client.$executeRawUnsafe('PRAGMA query_only = OFF')
    expect(rejected).toBeInstanceOf(AggregateError)
    expect(rejected).toMatchObject({ cause: failure, errors: [failure, expect.any(Error)] })
    await expect(projection.pending()).resolves.toEqual([
      { projectId: 'project-1', sessionId: 'session-1', operation: 'save' }
    ])
    await expect(client.session.findUnique({ where: { id: 'session-1' } })).resolves.toMatchObject({
      deletedAtMs: null
    })
    // The original draft can still retry before a catalog replay, without pretending the first save succeeded.
    const retrying = new SessionRepository(storageRoot, {}, projection)
    await expect(retrying.saveSession(session('session-1'), 0)).resolves.toMatchObject({
      revision: 1
    })
  })

  it('preserves auxiliary usage recorded before a failed first publication', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-save-auxiliary-usage-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const recorder = new SessionAuxiliaryTurnUsageRecorder(async () => client!)
    const failure = new Error('injected Session rename failure')
    const usageEvent = { timestamp: 120, inputTokens: 5, cacheTokens: 2, outputTokens: 4 }
    const repository = new SessionRepository(
      storageRoot,
      {
        renameFile: async () => {
          await recorder.record({
            projectId: 'project-1',
            sessionId: 'session-1',
            eventId: 'side-stop-1',
            source: 'side-chat',
            frameworkId: 'codebuddy',
            completedAtMs: usageEvent.timestamp,
            usage: usageEvent
          })
          await expect(projection.usage()).resolves.toMatchObject({ usageEvents: [usageEvent] })
          throw failure
        }
      },
      projection
    )
    await repository.ensureSessionProjection(() => repository.loadAll())
    const draft = { ...session('session-1'), messages: [] }

    const rejected = await repository.saveSession(draft, 0).catch((error: unknown) => error)
    // Durable usage must remain visible with its original owner even though no JSON was published.
    await expect(projection.usage()).resolves.toMatchObject({ usageEvents: [usageEvent] })
    expect(rejected).toMatchObject({ cause: failure, errors: [failure, expect.any(Error)] })
    await expect(projection.pending()).resolves.toHaveLength(1)
    await expect(client.session.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({
      number: 1,
      deletedAtMs: null
    })
    const retrying = new SessionRepository(storageRoot, {}, projection)
    await expect(retrying.saveSession(draft, 0)).resolves.toMatchObject({ number: 1, revision: 1 })
    await expect(projection.usage()).resolves.toMatchObject({ usageEvents: [usageEvent] })
    await expect(projection.pending()).resolves.toEqual([])
  })

  it('does not discard a committed deletion with a stale allocation receipt', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-save-receipt-delete-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const prepared = await projection.prepareSave(session('session-1'))
    await projection.commitDelete('project-1', 'session-1')
    await expect(projection.abortUnpublishedSave(prepared)).rejects.toThrow(
      'pending operation has changed'
    )
    await expect(projection.prepareSave(session('session-1'))).rejects.toThrow('deleted Session')
    await expect(client.session.findUnique({ where: { id: 'session-1' } })).resolves.toMatchObject({
      deletedAtMs: expect.anything()
    })
  })

  it('does not cascade-delete published facts through an old allocation receipt', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-save-receipt-facts-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const prepared = await projection.prepareSave(session('session-1'))
    await projection.commitSave(prepared.session)
    await projection.markPending('project-1', 'session-1')
    await expect(projection.abortUnpublishedSave(prepared)).rejects.toThrow(
      'allocation that has changed'
    )
    await expect(projection.list()).resolves.toHaveLength(1)
    await expect(projection.usage()).resolves.toMatchObject({
      usageEvents: [expect.objectContaining({ inputTokens: 10 })]
    })
    await expect(projection.pending()).resolves.toHaveLength(1)
  })

  it('resumes an individually deleted Session after a crash before JSON removal', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-delete-intent-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())

    // The durable delete intent is committed before deleteSession removes JSON. Simulate a crash in
    // that cross-store window, then verify startup resumes the delete instead of replaying a save.
    await projection.markPending('project-1', 'session-1', 'delete')
    await repository.reconcilePendingSessionProjection()

    await expect(repository.loadSession('project-1', 'session-1')).resolves.toBeUndefined()
    await expect(client.session.findUnique({ where: { id: 'session-1' } })).resolves.toMatchObject({
      id: 'session-1',
      deletedAtMs: expect.anything()
    })
    await expect(projection.usage()).resolves.toMatchObject({
      sessionCreatedAt: [],
      usageEvents: []
    })
  })

  it('backfills historical JSON numbers by creation time before normal autoincrement', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-backfill-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('newer', 200))
    await files.saveSession(session('older', 100))

    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const initialized = await repository.ensureSessionProjection(() => files.loadAll())

    expect(initialized.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'older', number: 1 }),
        expect.objectContaining({ id: 'newer', number: 2 })
      ])
    )
    await expect(repository.loadSession('project-1', 'older')).resolves.toMatchObject({ number: 1 })
    await expect(repository.loadSession('project-1', 'newer')).resolves.toMatchObject({ number: 2 })

    await expect(repository.saveSession(session('latest', 300))).resolves.toMatchObject({
      number: 3
    })
  })

  it('scans historical Session authority once while building the projection', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-single-scan-backfill-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const repository = new SessionRepository(
      storageRoot,
      {},
      new SessionProjectionRepository(async () => client!)
    )
    await repository.saveSession(session('session-1'))
    const scan = vi.spyOn(repository, 'loadAllWithDiagnostics')

    await repository.ensureSessionProjection(() => repository.loadAll())

    expect(scan).toHaveBeenCalledOnce()
  })

  it('scans Session authority once when startup recovery is required', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-single-scan-recovery-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const pending = session('pending-artifact')
    pending.artifacts![0].path = '/managed/.pending/run-1/report.md'
    const saved = await repository.saveSession(pending)
    await projection.replaceAll([saved])
    const scan = vi.spyOn(repository, 'loadAllWithDiagnostics')

    await repository.ensureSessionProjection(() => repository.loadAll())

    expect(scan).toHaveBeenCalledOnce()
  })

  it('reports oversized authority when the ready projection needs no startup recovery', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-ready-size-limit-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const saved = await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())
    await truncate(
      join(storageRoot, 'sessions', saved.projectId, `${saved.id}.json`),
      MAX_PERSISTED_SESSION_BYTES + 1
    )

    const loaded = await repository.ensureSessionProjection(async () => {
      const scan = await repository.loadAllWithDiagnostics()
      return {
        ...scan.result,
        diagnostics: { isComplete: scan.isComplete, warnings: scan.warnings ?? [] }
      }
    })

    expect(loaded.result?.diagnostics).toMatchObject({
      isComplete: false,
      warnings: [
        {
          kind: 'too-large',
          projectId: saved.projectId,
          fileName: `${saved.id}.json`,
          recovered: false
        }
      ]
    })
    expect(loaded.sessions).toEqual([])
  })

  it('removes a stale ready projection after oversized authority is moved out', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-size-recovery-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const saved = await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())
    const authorityPath = join(storageRoot, 'sessions', saved.projectId, `${saved.id}.json`)
    await truncate(authorityPath, MAX_PERSISTED_SESSION_BYTES + 1)

    const loadAuthority = async (): Promise<LoadAllSessionsResult> => {
      const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })
      return {
        ...scan.result,
        diagnostics: { isComplete: scan.isComplete, warnings: scan.warnings ?? [] }
      }
    }
    await expect(repository.ensureSessionProjection(loadAuthority)).resolves.toMatchObject({
      sessions: []
    })
    await rename(authorityPath, join(storageRoot, 'removed-session.json'))

    await expect(repository.ensureSessionProjection(loadAuthority)).resolves.toMatchObject({
      sessions: []
    })
    await expect(projection.list()).resolves.toEqual([])
  })

  it('reports an oversized recovery temp behind a ready projection', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-ready-temp-size-limit-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const maxSessionBytes = 64 * 1024
    const repository = new SessionRepository(storageRoot, { maxSessionBytes }, projection)
    const saved = await repository.saveSession(session('session-1'))
    await repository.ensureSessionProjection(() => repository.loadAll())
    const authorityPath = join(storageRoot, 'sessions', saved.projectId, `${saved.id}.json`)
    await writeFile(`${authorityPath}.1700000000000-1.tmp`, '', 'utf8')
    await truncate(`${authorityPath}.1700000000000-1.tmp`, maxSessionBytes + 1)

    const loaded = await repository.ensureSessionProjection(async () => {
      const scan = await repository.loadAllWithDiagnostics({ mode: 'read-only' })
      return {
        ...scan.result,
        diagnostics: { isComplete: scan.isComplete, warnings: scan.warnings ?? [] }
      }
    })

    expect(loaded.result?.diagnostics).toMatchObject({
      isComplete: false,
      warnings: [
        {
          kind: 'too-large',
          projectId: saved.projectId,
          fileName: `${saved.id}.json`,
          recovered: false
        }
      ]
    })
    expect(loaded.sessions).toEqual([])
  })

  it('does not reuse retained tombstone numbers during a projection-version rebuild', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-reversion-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const deleted = await repository.saveSession(session('deleted', 100))
    await repository.deleteSession(deleted.projectId, deleted.id)
    await client.sessionProjectionState.create({
      data: { id: 'session-projection', projectionVersion: 1, completedAt: new Date() }
    })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('live', 200))

    const rebuilt = await repository.ensureSessionProjection(() => files.loadAll())

    expect(rebuilt.sessions).toEqual([expect.objectContaining({ id: 'live', number: 2 })])
    await expect(client.session.findUnique({ where: { id: 'deleted' } })).resolves.toMatchObject({
      number: 1,
      deletedAtMs: expect.any(BigInt)
    })
    await expect(
      client.sessionNumberSequence.findUnique({ where: { id: 'global' } })
    ).resolves.toMatchObject({ nextNumber: 3 })
  })

  it('rejects an invalid backfill before clearing the existing projection', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-rebuild-validation-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const retained = await repository.saveSession(session('retained', 100))
    await projection.replaceAll([retained])
    await client.sessionProjectionState.update({
      where: { id: 'session-projection' },
      data: { projectionVersion: 1 }
    })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(sessionWithInvalidProjection('invalid', 200))

    await expect(repository.ensureSessionProjection(() => files.loadAll())).rejects.toThrow(
      'Session projection updatedAt must be a non-negative safe integer.'
    )
    await expect(client.session.findUnique({ where: { id: retained.id } })).resolves.toMatchObject({
      id: retained.id,
      deletedAtMs: null
    })
    await expect(
      client.sessionProjectionState.findUnique({ where: { id: 'session-projection' } })
    ).resolves.toMatchObject({ projectionVersion: 1 })
  })

  it('derives degraded summaries from read-only authority instead of stale SQLite rows', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-degraded-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const stale = await repository.saveSession(session('stale', 100))
    await projection.replaceAll([stale])

    const summaries = await repository.summarizeReadOnlyAuthority({
      sessions: [session('authority', 200)],
      manifest: { version: 1 },
      diagnostics: { isComplete: false, warnings: [] }
    })

    expect(summaries).toEqual([expect.objectContaining({ id: 'authority', number: 2 })])
    await expect(projection.list()).resolves.toEqual([
      expect.objectContaining({ id: 'stale', number: 1 })
    ])
  })

  it('publishes a fresh authority scan when a Session save overlaps initial backfill', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-backfill-race-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('older', 100))
    const stale = await files.loadAll()

    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    let markAuthorityStarted!: () => void
    const authorityStarted = new Promise<void>((resolve) => {
      markAuthorityStarted = resolve
    })
    let releaseAuthority!: () => void
    const authorityReleased = new Promise<void>((resolve) => {
      releaseAuthority = resolve
    })
    const loadAuthority = vi.fn(async () => {
      markAuthorityStarted()
      await authorityReleased
      return stale
    })

    const first = repository.ensureSessionProjection(loadAuthority)
    const second = repository.ensureSessionProjection(loadAuthority)
    await authorityStarted
    await repository.saveSession(session('concurrent', 200))
    releaseAuthority()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(loadAuthority).toHaveBeenCalledOnce()
    expect(firstResult.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'older', number: 1 }),
        expect.objectContaining({ id: 'concurrent', number: 2 })
      ])
    )
    expect(secondResult.sessions).toEqual(firstResult.sessions)
    await expect(projection.isReady()).resolves.toBe(true)
  })

  it('includes a Session save that finishes while projection publication waits for its barrier', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-backfill-barrier-race-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('older', 100))
    const stale = await files.loadAll()

    const saveStarted = createDeferred<void>()
    const saveReleased = createDeferred<void>()
    let blockNextRename = true
    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(
      storageRoot,
      {
        renameFile: async (source, destination) => {
          if (blockNextRename) {
            blockNextRename = false
            saveStarted.resolve()
            await saveReleased.promise
          }
          await rename(source, destination)
        }
      },
      projection
    )
    const authorityStarted = createDeferred<void>()
    const authorityReleased = createDeferred<void>()
    const initializing = repository.ensureSessionProjection(async () => {
      authorityStarted.resolve()
      await authorityReleased.promise
      return stale
    })

    await authorityStarted.promise
    const saving = repository.saveSession(session('concurrent', 200))
    await saveStarted.promise
    authorityReleased.resolve()
    await Promise.resolve()
    await Promise.resolve()
    saveReleased.resolve()
    await saving

    const initialized = await initializing
    expect(initialized.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'older', number: 1 }),
        expect.objectContaining({ id: 'concurrent', number: 2 })
      ])
    )
  })

  it('does not restore a missing Session deleted while projection publication is suspended', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-session-backfill-missing-delete-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const files = new SessionRepository(storageRoot)
    await files.saveSession(session('deleted', 100))
    const stale = await files.loadAll()
    await files.deleteSession('project-1', 'deleted')

    const projection = new SessionProjectionRepository(async () => client!)
    const repository = new SessionRepository(storageRoot, {}, projection)
    const authorityStarted = createDeferred<void>()
    const authorityReleased = createDeferred<void>()
    const initializing = repository.ensureSessionProjection(async () => {
      authorityStarted.resolve()
      await authorityReleased.promise
      return stale
    })

    await authorityStarted.promise
    await repository.deleteSession('project-1', 'deleted')
    authorityReleased.resolve()

    const initialized = await initializing
    expect(initialized.sessions).toEqual([])
    await expect(projection.usage()).resolves.toMatchObject({
      sessionCreatedAt: [],
      usageEvents: []
    })
  })
})

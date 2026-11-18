import { NotebookRuntimeService, type NotebookExecutionResult } from '../notebook/runtime-service'
import { createScheduleExecution } from './execution'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import type { PrismaClient } from '@prisma/client'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ScheduleRepository } from './repository'
import {
  ScheduleBusyError,
  ScheduleDispatcher,
  ScheduleObservationError,
  ScheduleRejectedError,
  type ScheduleExecution
} from './dispatcher'
import { NotebookBackgroundRunError } from '../../shared/notebook'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  SCHEDULE_PENDING_EDIT_MESSAGE,
  type ScheduleCreateRequest
} from '../../shared/session-schedules'

it('dispatches a scheduled wake with unattended permission policy and the existing admission fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-unattended-'))
  const db = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(db)
    const session = materializeSessionConversationGraph({
      id: 's',
      projectId: 'p',
      cwd: root,
      title: 'Research',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const frame = session.conversationGraph!.frames[0]
    const task = await new ScheduleRepository(async () => db).create({
      target: {
        projectId: 'p',
        sessionId: 's',
        agentFrameId: frame.id,
        messageBranchId: frame.activeBranchId
      },
      requestId: 'unattended',
      draft: {
        name: 'Research',
        action: { kind: 'send_session_message', message: 'Check new papers' },
        rule: { kind: 'once', at: Date.now() + 60000, timeZone: 'UTC' }
      }
    })
    const work = await db.scheduleOccurrence.create({
      data: {
        id: 'wake',
        scheduleId: task.id,
        scheduleRevision: task.revision,
        scheduledAt: new Date(),
        actionSnapshot: JSON.stringify(task.draft.action),
        phase: 'dispatching',
        promptMessageId: 'wake-message'
      },
      include: { schedule: true }
    })
    const sendApplicationPrompt = vi.fn(async (_request, _attribution, admission) => {
      await admission.beforeSessionWrite()
      return { stopReason: 'end_turn' as const }
    })
    const authorize = vi.fn(async () => {})
    const executor = createScheduleExecution({
      runSessions: { find: async () => session, prepare: vi.fn() },
      sessions: { loadSessionForContinuation: async () => session },
      notebook: {} as NotebookRuntimeService,
      runtime: {
        getState: () => ({ promptInFlightSessionIds: [] }) as never,
        hasLiveSession: () => true,
        resumeSession: vi.fn(),
        sendApplicationPrompt
      },
      archive: { assertSessionAvailable: vi.fn(), admitSessionWork: () => () => {} },
      resolveAgentTarget: vi.fn()
    })
    await executor.dispatch(work, authorize, async () => {})
    expect(sendApplicationPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's',
        permissionPrompts: 'none',
        text: 'Check new papers',
        provenanceContext: expect.objectContaining({ messageBranchId: frame.activeBranchId })
      }),
      expect.objectContaining({ feature: 'schedule', occurrenceId: 'wake' }),
      expect.objectContaining({ beforeSessionWrite: expect.any(Function) })
    )
    expect(authorize).toHaveBeenCalledOnce()
  } finally {
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'retries unreadable Session evidence without pausing or dispatching (independent: %s)',
  async (independent) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-evidence-read-'))
    const db = createProjectDbClient(root)
    const read = vi.fn().mockRejectedValue(new Error('Session evidence temporarily unreadable'))
    const loadSession = vi.fn()
    const sendApplicationPrompt = vi.fn()
    const executor = createScheduleExecution({
      runSessions: { find: read, prepare: vi.fn() },
      sessions: { loadSessionForContinuation: loadSession },
      notebook: {} as NotebookRuntimeService,
      runtime: {
        getState: vi.fn(),
        hasLiveSession: vi.fn(),
        resumeSession: vi.fn(),
        sendApplicationPrompt
      },
      archive: { assertSessionAvailable: vi.fn(), admitSessionWork: () => () => {} },
      resolveAgentTarget: vi.fn()
    })
    const owner = new ScheduleDispatcher(async () => db, executor)
    try {
      await migrateApplicationDatabase(db)
      const at = Date.now() + 60000
      const task = await new ScheduleRepository(async () => db).create({
        target: independent
          ? { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null }
          : { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'read-retry',
        draft: {
          name: 'Read retry',
          action: { kind: 'send_session_message', message: 'Check' },
          rule: { kind: 'once', at, timeZone: 'UTC' }
        }
      })
      // Authorized work must survive a failed read without inventing missing-message evidence.
      const work = await db.scheduleOccurrence.create({
        data: {
          id: 'read-work',
          scheduleId: task.id,
          scheduleRevision: task.revision,
          scheduledAt: new Date(at),
          actionSnapshot: JSON.stringify(task.draft.action),
          phase: 'dispatching',
          dispatchAuthorizedAt: new Date(),
          promptMessageId: 'prompt',
          runSessionId: independent ? 'run-session' : null
        }
      })
      await owner.tick(at)
      await vi.waitFor(async () =>
        expect(
          await db.scheduleOccurrence.findUniqueOrThrow({ where: { id: work.id } })
        ).toMatchObject({
          phase: 'dispatching',
          outcome: null,
          nextAttemptAt: new Date(at + 15000)
        })
      )
      expect(
        (await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })).pausedAt
      ).toBeNull()
      read.mockResolvedValue({
        conversationGraph: {
          messages: [
            {
              id: 'prompt',
              introducedOnBranchId: 'b',
              attribution: { feature: 'schedule', occurrenceId: work.id },
              turnOutcome: { kind: 'completed' }
            }
          ]
        }
      })
      await owner.tick(at + 15000)
      await vi.waitFor(async () =>
        expect(
          await db.scheduleOccurrence.findUniqueOrThrow({ where: { id: work.id } })
        ).toMatchObject({ phase: 'settled', outcome: 'succeeded' })
      )
      expect(sendApplicationPrompt).not.toHaveBeenCalled()
      expect(loadSession).not.toHaveBeenCalled()
    } finally {
      await owner.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('bounds background executions across scans and restart while allowing permission waits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-capacity-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const states = new Map<string, { kind: 'running' | 'succeeded'; waiting?: boolean }>()
  const dispatch = vi.fn(async (work, authorize) => {
    await authorize()
    const state = { kind: 'running' as const }
    states.set(work.id, state)
    return state
  })
  const execution: ScheduleExecution = {
    inspect: async (work) => states.get(work.id) ?? { kind: 'missing' },
    dispatch
  }
  const owner = new ScheduleDispatcher(async () => db, execution)
  const restarted = new ScheduleDispatcher(async () => db, execution)
  const at = Date.now() + 60000
  try {
    await migrateApplicationDatabase(db)
    for (let i = 0; i < 6; i++)
      await repo.create({
        target: { projectId: 'p', sessionId: 's' + i, agentFrameId: 'f', messageBranchId: 'b' },
        requestId: String(i),
        draft: {
          name: 'Capacity',
          rule: { kind: 'once', at: at + i, timeZone: 'UTC' },
          action: { kind: 'run_script', language: 'python', code: 'print(1)' }
        }
      })
    await owner.tick(at + 10)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'admitted' } })).toBe(4)
    )
    await owner.tick(at + 20)
    expect(dispatch).toHaveBeenCalledTimes(4)
    await owner.dispose()
    await restarted.tick(at + 16000)
    await vi.waitFor(async () =>
      expect(
        await db.scheduleOccurrence.count({
          where: { phase: 'dispatching', nextAttemptAt: { gt: new Date(at + 16000) } }
        })
      ).toBe(2)
    )
    expect(dispatch).toHaveBeenCalledTimes(4)
    const first = [...states.keys()][0]
    states.set(first, { kind: 'running', waiting: true })
    await restarted.tick(at + 32000)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'admitted' } })).toBe(5)
    )
    expect(dispatch).toHaveBeenCalledTimes(5)
    states.set(first, { kind: 'running' })
    await restarted.tick(at + 48000)
    expect(dispatch).toHaveBeenCalledTimes(5)
    for (const id of states.keys()) states.set(id, { kind: 'succeeded' })
    await restarted.tick(at + 64000)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(5)
    )
    await restarted.tick(at + 80000)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(6))
  } finally {
    await owner.dispose()
    await restarted.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'reconciles delayed permission waits before new admissions (restart: %s)',
  async (restart) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-wait-capacity-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const states = new Set<string>()
    const observation = Promise.withResolvers<void>()
    let delayed = false
    let inspected = 0
    const dispatch = vi.fn(async (work, authorize) => {
      await authorize()
      states.add(work.id)
      return { kind: 'running' as const }
    })
    const execution: ScheduleExecution = {
      dispatch,
      inspect: async (work) => {
        if (!states.has(work.id)) return { kind: 'missing' }
        if (delayed) {
          inspected++
          await observation.promise
        }
        return { kind: 'running', waiting: true }
      }
    }
    const owner = new ScheduleDispatcher(async () => db, execution)
    const recovered = new ScheduleDispatcher(async () => db, execution)
    const at = Date.now() + 60000
    let scan: Promise<void> | undefined
    try {
      await migrateApplicationDatabase(db)
      for (let i = 0; i < 5; i++)
        await repo.create({
          target: { projectId: 'p', sessionId: 's' + i, agentFrameId: 'f', messageBranchId: 'b' },
          requestId: String(i),
          draft: {
            name: 'Capacity',
            rule: { kind: 'once', at: at + i, timeZone: 'UTC' },
            action: { kind: 'send_session_message', message: 'Check' }
          }
        })
      await owner.tick(at + 10)
      await vi.waitFor(async () =>
        expect(await db.scheduleOccurrence.count({ where: { phase: 'admitted' } })).toBe(4)
      )
      await vi.waitFor(async () =>
        expect(
          (await db.scheduleOccurrence.findFirstOrThrow({ where: { phase: 'dispatching' } }))
            .attemptCount
        ).toBe(2)
      )
      if (restart) await owner.dispose()
      delayed = true
      scan = (restart ? recovered : owner).tick(at + 16000)
      await vi.waitFor(() => expect(inspected).toBe(4))
      expect(dispatch).toHaveBeenCalledTimes(4)
      observation.resolve()
      await scan
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(5))
      const newest = await db.scheduleOccurrence.findFirstOrThrow({
        orderBy: { scheduledAt: 'desc' }
      })
      expect(newest.attemptCount).toBe(2)
    } finally {
      observation.resolve()
      await scan
      await owner.dispose()
      await recovered.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('reuses the reserved conversation across a pre-admission retry and unlinks a deleted run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'independent-schedule-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const at = Date.now() + 60000
  const attempts: (string | null)[] = []
  const executor: ScheduleExecution = {
    inspect: async () => ({ kind: 'missing' }),
    dispatch: async (work, authorize, assertCurrent) => {
      await assertCurrent()
      attempts.push(work.runSessionId)
      if (attempts.length === 1) throw new ScheduleRejectedError('Busy', true)
      await authorize()
      return { kind: 'succeeded' }
    }
  }
  const first = new ScheduleDispatcher(async () => db, executor)
  const restarted = new ScheduleDispatcher(async () => db, executor)
  try {
    await migrateApplicationDatabase(db)
    const target = {
      projectId: 'project',
      sessionId: null,
      agentFrameId: null,
      messageBranchId: null
    }
    const schedule = await repo.create({
      target,
      requestId: 'request',
      draft: {
        name: 'Report',
        rule: { kind: 'once', at, timeZone: 'UTC' },
        action: { kind: 'send_session_message', message: 'Report' }
      }
    })
    await first.tick(at)
    await vi.waitFor(async () =>
      expect((await db.scheduleOccurrence.findFirstOrThrow()).attemptCount).toBe(2)
    )
    await first.dispose()
    await restarted.tick(at + 60_000)
    await vi.waitFor(async () =>
      expect((await db.scheduleOccurrence.findFirstOrThrow()).outcome).toBe('succeeded')
    )
    const occurrence = await db.scheduleOccurrence.findFirstOrThrow()
    expect(occurrence.runSessionId).toEqual(expect.any(String))
    expect(attempts).toEqual([occurrence.runSessionId, occurrence.runSessionId])
    await expect(
      repo.originForOccurrence(occurrence.id, target.projectId, 'unrelated')
    ).rejects.toThrow()
    await repo.deleteTarget(target.projectId, occurrence.runSessionId!)
    expect(
      await repo.history({ projectId: target.projectId, sessionId: null, scheduleId: schedule.id })
    ).toMatchObject([{ status: 'succeeded', runSessionId: null }])
    expect(await repo.list({ projectId: target.projectId })).toHaveLength(1)
  } finally {
    await first.dispose()
    await restarted.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('claims a due slot once, preserves self-rearm and fences an uncertain restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schedule-dispatch-'))
  const database = createProjectDbClient(directory)
  const repository = new ScheduleRepository(async () => database)
  const at = Date.now() + 60000
  const request: ScheduleCreateRequest = {
    target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
    requestId: 'create',
    draft: {
      name: 'Check run',
      action: { kind: 'send_session_message', message: 'Check results' },
      rule: { kind: 'once', at, timeZone: 'UTC' }
    }
  }
  let calls = 0
  const executor: ScheduleExecution = {
    inspect: async () => ({ kind: 'missing' }),
    dispatch: async (work, authorize) => {
      await authorize()
      calls++
      await repository.edit({
        projectId: 'p',
        sessionId: 's',
        scheduleId: work.scheduleId,
        expectedRevision: work.scheduleRevision,
        change: {
          kind: 'reschedule',
          at: at + 60000
        }
      })
      return { kind: 'succeeded' }
    }
  }
  const dispatcher = new ScheduleDispatcher(async () => database, executor)
  try {
    await migrateApplicationDatabase(database)
    const schedule = await repository.create(request)
    expect((await repository.create(request)).id).toBe(schedule.id)
    await dispatcher.tick(at)
    await vi.waitFor(async () =>
      expect(await database.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(1)
    )
    expect(
      await database.sessionSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    ).toMatchObject({
      revision: 2,
      admittedCount: 1,
      finishedAt: null,
      nextDueAt: new Date(at + 60000)
    })
    await database.scheduleOccurrence.create({
      data: {
        id: 'interrupted',
        scheduleId: schedule.id,
        scheduleRevision: 2,
        scheduledAt: new Date(at + 60000),
        actionSnapshot: JSON.stringify(request.draft.action),
        phase: 'dispatching',
        promptMessageId: 'second-prompt',
        dispatchAuthorizedAt: new Date(at + 60000)
      }
    })
    await dispatcher.tick(at + 60000)
    await vi.waitFor(async () =>
      expect(
        await database.scheduleOccurrence.findUnique({ where: { id: 'interrupted' } })
      ).toMatchObject({ outcome: 'interrupted', phase: 'settled' })
    )
    expect(calls).toBe(1)
    expect((await repository.list({ projectId: 'p' }))[0].pausedAt).not.toBeNull()
  } finally {
    await dispatcher.dispose()
    await database.$disconnect()
    await rm(directory, { recursive: true, force: true })
  }
})

it('submits a scheduled script to Notebook once and reconciles its receipt without starting an agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-script-'))
  const db = createProjectDbClient(root)
  const repository = new ScheduleRepository(async () => db)
  const execute = vi.fn(async (): Promise<NotebookExecutionResult> => ({
    status: 'completed',
    stdout: '42',
    stderr: '',
    traceback: '',
    outputs: [],
    cwdAfter: root
  }))
  const onDelivery = vi.fn(async () => undefined)
  const notebook = new NotebookRuntimeService({
    onBackgroundRunAdmitted: onDelivery,
    onBackgroundRunTerminal: onDelivery,
    configRoot: root,
    dataRoot: root,
    projectId: 'p',
    backgroundExecutionEnabled: true,
    executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
  })
  const sendApplicationPrompt = vi.fn()
  const loadSession = async (): Promise<PersistedChatSession> => ({
    id: 's',
    projectId: 'p',
    cwd: root,
    title: 'Test',
    status: 'idle' as const,
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  const executor = createScheduleExecution({
    runSessions: { find: loadSession, prepare: vi.fn() },
    notebook,
    sessions: { loadSessionForContinuation: loadSession },
    runtime: {
      getState: vi.fn(),
      hasLiveSession: vi.fn(),
      resumeSession: vi.fn(),
      sendApplicationPrompt
    },
    archive: { assertSessionAvailable: vi.fn(), admitSessionWork: () => () => {} },
    resolveAgentTarget: vi.fn()
  })
  const owner = new ScheduleDispatcher(async () => db, executor)
  try {
    await migrateApplicationDatabase(db)
    const at = Date.now() + 60000
    const target = {
      projectId: 'p',
      sessionId: 's',
      agentFrameId: 'root-frame-s',
      messageBranchId: 'b'
    }
    const row = await repository.create({
      target,
      requestId: 'script',
      draft: {
        name: 'Analyze',
        action: { kind: 'run_script', language: 'python', code: 'print(42)' },
        rule: { kind: 'once', at, timeZone: 'UTC' }
      }
    })
    const unavailable = new NotebookBackgroundRunError(
      {
        code: 'BACKGROUND_RUN_RESULT_UNAVAILABLE',
        stage: 'query',
        retryable: true,
        hint: 'Retry query.'
      },
      'Result temporarily unavailable'
    )
    const query = vi.spyOn(notebook, 'getBackgroundRun').mockRejectedValueOnce(unavailable)
    await owner.tick(at)
    await vi.waitFor(async () =>
      expect((await db.scheduleOccurrence.findFirstOrThrow()).nextAttemptAt).toEqual(
        new Date(at + 15000)
      )
    )
    expect(execute).not.toHaveBeenCalled()
    await owner.tick(at + 16000)
    await vi.waitFor(
      async () =>
        expect(
          (await repository.history({ ...target, scheduleId: row.id }))[0]?.scriptRunId
        ).toEqual(expect.any(String)),
      { timeout: 10000 }
    )
    const [run] = await repository.history({ ...target, scheduleId: row.id })
    await notebook.waitForBackgroundRun(run.scriptRunId!)
    const admitted = await db.scheduleOccurrence.findFirstOrThrow()
    query.mockRejectedValue(unavailable)
    await owner.tick(at + 32000)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.findFirstOrThrow()).toMatchObject({
        phase: 'admitted',
        nextAttemptAt: new Date(at + 47000),
        dispatchAuthorizedAt: admitted.dispatchAuthorizedAt,
        scriptRunId: run.scriptRunId,
        outcome: null
      })
    )
    expect((await repository.list({ projectId: 'p' }))[0].pausedAt).toBeNull()
    const reads = query.mock.calls.length
    await owner.tick(at + 33000)
    expect(query).toHaveBeenCalledTimes(reads)
    query.mockRestore()
    await owner.dispose()
    const restarted = new ScheduleDispatcher(async () => db, executor)
    await restarted.tick(at + 48000)
    await vi.waitFor(async () =>
      expect((await repository.history({ ...target, scheduleId: row.id }))[0].status).toBe(
        'succeeded'
      )
    )
    expect(execute).toHaveBeenCalledTimes(1)
    expect(sendApplicationPrompt).not.toHaveBeenCalled()
    expect(onDelivery).not.toHaveBeenCalled()
    await restarted.dispose()
  } finally {
    await owner.dispose()
    await notebook.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'paused at run limit',
  'renamed one-shot',
  'edited instruction',
  'rearmed one-shot'
] as const)('reconciles the latest definition when a running schedule was %s', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-settlement-'))
  const db = createProjectDbClient(root)
  const repository = new ScheduleRepository(async () => db)
  const limited = scenario === 'paused at run limit'
  const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (_work, authorize) => {
    await authorize()
    return { kind: 'running' }
  })
  const owner = new ScheduleDispatcher(async () => db, {
    dispatch,
    inspect: async (work) =>
      work.admittedAt
        ? { kind: limited ? 'succeeded' : 'failed', reason: 'failed' }
        : { kind: 'missing' }
  })
  try {
    await migrateApplicationDatabase(db)
    const at = Date.now() + 60000
    const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
    const job = await repository.create({
      target,
      requestId: 'job',
      draft: {
        name: 'Check',
        action: { kind: 'run_script', language: 'python', code: 'print(42)' },
        ...(limited ? { maxRuns: 1 } : {}),
        rule: limited
          ? { kind: 'interval', minutes: 1, anchor: at, timeZone: 'UTC' }
          : { kind: 'once', at, timeZone: 'UTC' }
      }
    })
    const scope = { projectId: 'p', sessionId: 's', scheduleId: job.id }
    await owner.tick(at)
    await vi.waitFor(async () =>
      expect((await repository.history(scope))[0]?.status).toBe('admitted')
    )
    let revision = job.revision
    if (limited) {
      const renamed = await repository.edit({
        ...scope,
        expectedRevision: revision,
        change: { kind: 'edit', draft: { ...job.draft, name: 'Final run' } }
      })
      revision = renamed.revision
      expect(renamed.draft.name).toBe('Final run')
      expect(renamed.finishedAt).toBeNull()
      await expect(
        repository.edit({
          ...scope,
          expectedRevision: revision,
          change: {
            kind: 'edit',
            draft: {
              ...renamed.draft,
              action: { kind: 'run_script', language: 'python', code: 'print(84)' }
            }
          }
        })
      ).rejects.toThrow('bound has already been reached')
    }
    const edited = await repository.edit({
      ...scope,
      expectedRevision: revision,
      change: limited
        ? { kind: 'pause' }
        : {
            kind: 'edit',
            draft: {
              ...job.draft,
              name: 'Edited',
              ...(scenario === 'edited instruction'
                ? { action: { kind: 'run_script', language: 'python', code: 'print(84)' } as const }
                : {}),
              ...(scenario === 'rearmed one-shot'
                ? { rule: { kind: 'once', at: at + 60000, timeZone: 'UTC' } }
                : {})
            }
          }
    })
    await owner.tick(at + 16000)
    await vi.waitFor(async () =>
      expect((await repository.history(scope))[0].status).toBe(limited ? 'succeeded' : 'failed')
    )
    if (limited) {
      await expect(
        repository.edit({
          ...scope,
          expectedRevision: edited.revision,
          change: { kind: 'resume' }
        })
      ).rejects.toThrow('bound has already been reached')
      // A previously persisted active definition at its cap must also stop at claim.
      await db.sessionSchedule.update({ where: { id: job.id }, data: { pausedAt: null } })
      await owner.tick(at + 60000)
      expect(
        (await db.sessionSchedule.findUniqueOrThrow({ where: { id: job.id } })).finishedAt
      ).not.toBeNull()
      expect(await db.scheduleOccurrence.count()).toBe(1)
    } else {
      const [latest] = await repository.list({ projectId: 'p' })
      if (scenario === 'renamed one-shot' || scenario === 'edited instruction')
        expect(latest).toMatchObject({
          pausedAt: null,
          pauseReason: null,
          finishedAt: expect.any(Number),
          nextDueAt: null,
          latestProblem: { status: 'failed', reason: 'failed' }
        })
      else expect(latest).toMatchObject({ pausedAt: null, finishedAt: null, nextDueAt: at + 60000 })
    }
    expect(dispatch).toHaveBeenCalledOnce()
  } finally {
    await owner.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('moves only the next recurring slot and preserves pause, revision and run bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-self-time-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  try {
    await migrateApplicationDatabase(db)
    const at = Date.now() + 60000
    const task = await repo.create({
      requestId: 'request',
      target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
      draft: {
        name: 'Report',
        action: { kind: 'send_session_message', message: 'Report' },
        rule: { kind: 'interval', anchor: at, minutes: 60, timeZone: 'UTC' },
        endAt: at + 86400000
      }
    })
    const scope = { projectId: 'p', sessionId: null, scheduleId: task.id }
    const updated = await repo.edit({
      ...scope,
      expectedRevision: task.revision,
      change: { kind: 'reschedule', at: at + 1000 }
    })
    expect(updated.nextDueAt).toBe(at + 1000)
    expect(updated.draft).toEqual(task.draft)
    await expect(
      repo.edit({
        ...scope,
        expectedRevision: updated.revision,
        change: { kind: 'reschedule', at: at + 86400001 }
      })
    ).rejects.toThrow()
    const paused = await repo.edit({
      ...scope,
      expectedRevision: updated.revision,
      change: { kind: 'pause' }
    })
    for (const revision of [updated.revision, paused.revision])
      await expect(
        repo.edit({ ...scope, expectedRevision: revision, change: { kind: 'reschedule', at } })
      ).rejects.toThrow()
    const resumed = await repo.edit({
      ...scope,
      expectedRevision: paused.revision,
      change: { kind: 'resume' }
    })
    expect(resumed.nextDueAt).toBe(updated.nextDueAt)
    expect(resumed.draft).toEqual(task.draft)
  } finally {
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { period: 60, anchor: 0, override: 15, restart: 130, claimed: 120, next: 180 },
  { period: 10080, anchor: 0, override: 2880, restart: 10140, claimed: 10080, next: 20160 },
  { period: 60, anchor: 180, override: 15, restart: 130, claimed: 15, next: 180 }
])('preserves the interval anchor during catch-up: %j', async (timing) => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-catch-up-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (_work, authorize) => {
    await authorize()
    return { kind: 'succeeded' }
  })
  const owner = new ScheduleDispatcher(async () => db, {
    inspect: async () => ({ kind: 'missing' }),
    dispatch
  })
  const at = Date.now() + 60000
  try {
    await migrateApplicationDatabase(db)
    const task = await repo.create({
      target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
      requestId: 'anchor',
      draft: {
        name: 'Override',
        action: { kind: 'run_script', language: 'python', code: 'print(1)' },
        rule: {
          kind: 'interval',
          anchor: at + timing.anchor * 60000,
          minutes: timing.period,
          timeZone: 'UTC'
        }
      }
    })
    await repo.edit({
      projectId: 'p',
      sessionId: 's',
      scheduleId: task.id,
      expectedRevision: task.revision,
      change: { kind: 'reschedule', at: at + timing.override * 60000 }
    })
    await owner.tick(at + timing.restart * 60000)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(1)
    )
    expect(await db.scheduleOccurrence.findFirstOrThrow()).toMatchObject({
      scheduledAt: new Date(at + timing.claimed * 60000),
      outcome: 'succeeded'
    })
    expect(
      (await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })).nextDueAt?.getTime()
    ).toBe(at + timing.next * 60000)
    expect(dispatch).toHaveBeenCalledOnce()
  } finally {
    await owner.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'isolates slow evidence and bounds shutdown (live prompt: %s)',
  async (livePrompt) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-slow-evidence-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const gate = Promise.withResolvers<void>()
    const provider = Promise.withResolvers<void>()
    let firstId: string | undefined
    let slow = false
    let reads = 0
    const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (work, authorize) => {
      await authorize()
      if (!firstId) {
        firstId = work.id
        if (livePrompt) await provider.promise
        return { kind: 'running' }
      }
      return { kind: 'succeeded' }
    })
    const owner = new ScheduleDispatcher(async () => db, {
      dispatch,
      inspect: async (work) => {
        if (work.id !== firstId) return { kind: 'missing' }
        if (slow) {
          reads++
          await gate.promise
        }
        return { kind: 'running' }
      }
    })
    const at = Date.now() + 60000
    let scan: Promise<void> | undefined
    try {
      await migrateApplicationDatabase(db)
      for (let i = 0; i < 2; i++)
        await repo.create({
          target: { projectId: 'p', sessionId: `s${i}`, agentFrameId: 'f', messageBranchId: 'b' },
          requestId: `${i}`,
          draft: {
            name: 'Slow evidence',
            action: { kind: 'send_session_message', message: 'Check' },
            rule: { kind: 'once', at: at + i * 20000, timeZone: 'UTC' }
          }
        })
      await owner.tick(at)
      await vi.waitFor(() => expect(firstId).toBeDefined())
      if (!livePrompt)
        await vi.waitFor(async () =>
          expect(await db.scheduleOccurrence.count({ where: { phase: 'admitted' } })).toBe(1)
        )
      slow = true
      await owner.tick(at + 20000)
      await vi.waitFor(async () =>
        expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(1)
      )
      expect(dispatch).toHaveBeenCalledTimes(2)
      scan = owner.tick(at + 36000)
      await vi.waitFor(() => expect(reads).toBe(1))
      expect(
        await Promise.race([
          scan.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100))
        ])
      ).toBe(true)
      const stopping = owner.dispose(10)
      expect(
        await Promise.race([
          stopping.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
        ])
      ).toBe(true)
      expect(reads).toBe(1)
      await scan
      const before = await db.scheduleOccurrence.findUniqueOrThrow({ where: { id: firstId } })
      expect(before.dispatchAuthorizedAt).not.toBeNull()
      expect(before.outcome).toBeNull()
      expect(reads).toBe(1)
      gate.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
      // A read that arrives after its budget cannot settle or release the authorized run.
      expect(await db.scheduleOccurrence.findUniqueOrThrow({ where: { id: firstId } })).toEqual(
        before
      )
      expect(dispatch).toHaveBeenCalledTimes(2)
    } finally {
      gate.resolve()
      provider.resolve()
      await scan
      await owner.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['rejected', 'committed', 'timeout'] as const)(
  'drains the authorization boundary on quit when admission is %s',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-quit-'))
    const db = createProjectDbClient(root)
    const repository = new ScheduleRepository(async () => db)
    const admission = Promise.withResolvers<void>()
    const provider = Promise.withResolvers<void>()
    const authorized = Promise.withResolvers<void>()
    let committed = false
    const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (_work, authorize) => {
      await authorize()
      authorized.resolve()
      await admission.promise
      if (scenario !== 'committed') throw new ScheduleRejectedError('Quit before admission', true)
      committed = true
      await provider.promise
      return { kind: 'running' }
    })
    const owner = new ScheduleDispatcher(async () => db, {
      dispatch,
      inspect: async () => ({ kind: committed ? 'running' : 'missing' })
    })
    try {
      await migrateApplicationDatabase(db)
      const at = Date.now() + 60000
      const task = await repository.create({
        target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'quit',
        draft: {
          name: 'Check',
          rule: { kind: 'once', at, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
      await owner.tick(at)
      await authorized.promise
      let stopped = false
      const stopping = owner.dispose(scenario === 'timeout' ? 40 : 1000).then(() => {
        stopped = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(stopped).toBe(false)
      if (scenario !== 'timeout') admission.resolve()
      await stopping
      const row = await db.scheduleOccurrence.findFirstOrThrow()
      expect(row.outcome).toBeNull()
      expect(
        (await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })).pausedAt
      ).toBeNull()
      if (scenario === 'rejected') {
        expect(row.dispatchAuthorizedAt).toBeNull()
        expect(row.attemptCount).toBe(2)
        const restartDispatch = vi.fn<ScheduleExecution['dispatch']>(async (_work, authorize) => {
          await authorize()
          return { kind: 'succeeded' }
        })
        const restart = new ScheduleDispatcher(async () => db, {
          inspect: async () => ({ kind: 'missing' }),
          dispatch: restartDispatch
        })
        await restart.tick(at + 16000)
        await vi.waitFor(async () =>
          expect((await db.scheduleOccurrence.findFirstOrThrow()).outcome).toBe('succeeded')
        )
        await restart.dispose()
        expect(restartDispatch).toHaveBeenCalledOnce()
      } else {
        expect(row.dispatchAuthorizedAt).not.toBeNull()
        expect(row.phase).toBe(scenario === 'committed' ? 'admitted' : 'dispatching')
      }
      expect(dispatch).toHaveBeenCalledOnce()
    } finally {
      admission.resolve()
      provider.resolve()
      await owner.dispose()
      await vi.waitFor(async () =>
        expect((await db.scheduleOccurrence.findFirstOrThrow()).phase).toBe(
          scenario === 'committed' ? 'admitted' : scenario === 'timeout' ? 'dispatching' : 'settled'
        )
      )
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('sleeps until the next due time and wakes immediately for a management change', async () => {
  vi.useFakeTimers()
  const due = Date.now() + 40000
  const findMany = vi.fn(async () => [])
  const db = {
    sessionSchedule: { findMany, findFirst: vi.fn(async () => ({ nextDueAt: new Date(due) })) },
    scheduleOccurrence: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) }
  } as unknown as Awaited<ReturnType<typeof createProjectDbClient>>
  const owner = new ScheduleDispatcher(async () => db, {
    inspect: async () => ({ kind: 'missing' }),
    dispatch: async () => ({ kind: 'missing' })
  })
  try {
    owner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(findMany).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(findMany).toHaveBeenCalledTimes(1)
    owner.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(findMany).toHaveBeenCalledTimes(2)
    // The next scan will consume the due slot; return a later cursor for subsequent arming.
    vi.mocked(db.sessionSchedule.findFirst).mockResolvedValue({
      nextDueAt: new Date(due + 60000)
    } as never)
    await vi.advanceTimersByTimeAsync(25000)
    expect(findMany).toHaveBeenCalledTimes(3)
    owner.suspend()
    owner.wake()
    await vi.advanceTimersByTimeAsync(60000)
    expect(findMany).toHaveBeenCalledTimes(3)
    owner.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(findMany).toHaveBeenCalledTimes(4)
  } finally {
    await owner.dispose()
    vi.useRealTimers()
  }
})

it.each(['project', 'session'])(
  'releases occupied capacity after deleting the owning %s',
  async (scope) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-delete-capacity-review-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const active = new Set<string>()
    const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (work, authorize) => {
      await authorize()
      active.add(work.id)
      return { kind: 'running' }
    })
    const owner = new ScheduleDispatcher(async () => db, {
      inspect: async (work) => (active.has(work.id) ? { kind: 'running' } : { kind: 'missing' }),
      dispatch
    })
    const at = Date.now() + 60000
    const draft = {
      name: 'Review',
      rule: { kind: 'once' as const, at, timeZone: 'UTC' },
      action: { kind: 'run_script' as const, language: 'python' as const, code: 'print(1)' }
    }
    try {
      await migrateApplicationDatabase(db)
      for (let i = 0; i < 4; i++)
        await repo.create({
          target: {
            projectId: 'deleted',
            sessionId: 's' + i,
            agentFrameId: 'f',
            messageBranchId: 'b'
          },
          draft,
          requestId: String(i)
        })
      await owner.tick(at)
      await vi.waitFor(async () =>
        expect(await db.scheduleOccurrence.count({ where: { phase: 'admitted' } })).toBe(4)
      )
      // Project quiescence ends the scripts, then final deletion cascades their receipts.
      active.clear()
      if (scope === 'project') await repo.deleteTarget('deleted')
      else for (let i = 0; i < 4; i++) await repo.deleteTarget('deleted', 's' + i)
      expect(await db.scheduleOccurrence.count()).toBe(0)
      const next = await repo.create({
        target: {
          projectId: 'remaining',
          sessionId: 'next',
          agentFrameId: 'f',
          messageBranchId: 'b'
        },
        draft,
        requestId: 'next'
      })
      await owner.tick(at + 10)
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(5))
      await vi.waitFor(async () =>
        expect(
          (
            await repo.history({ projectId: 'remaining', sessionId: 'next', scheduleId: next.id })
          )[0].status
        ).toBe('admitted')
      )
      expect((await repo.list({ projectId: 'remaining' }))[0].currentRun?.status).toBe('admitted')
    } finally {
      await owner.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('retains preparation reservations across scans until authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-preparation-capacity-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const prepared = Promise.withResolvers<void>()
  const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (_work, authorize) => {
    await prepared.promise
    await authorize()
    return { kind: 'succeeded' }
  })
  const owner = new ScheduleDispatcher(async () => db, {
    inspect: async () => ({ kind: 'missing' }),
    dispatch
  })
  const at = Date.now() + 60000
  try {
    await migrateApplicationDatabase(db)
    for (let i = 0; i < 5; i++)
      await repo.create({
        target: { projectId: 'p', sessionId: 's' + i, agentFrameId: 'f', messageBranchId: 'b' },
        requestId: String(i),
        draft: {
          name: 'Preparing',
          rule: { kind: 'once', at, timeZone: 'UTC' },
          action: { kind: 'run_script', language: 'python', code: 'print(1)' }
        }
      })
    await owner.tick(at)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(4))
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { attemptCount: 2 } })).toBe(1)
    )
    const pending = await repo.list({ projectId: 'p' })
    expect(
      pending.every((task) => task.nextDueAt === null && task.currentRun?.status === 'dispatching')
    ).toBe(true)
    await owner.tick(at + 16000)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { attemptCount: 3 } })).toBe(1)
    )
    expect(dispatch).toHaveBeenCalledTimes(4)
    prepared.resolve()
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(4)
    )
    await owner.tick(at + 32000)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(5))
  } finally {
    prepared.resolve()
    await owner.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['waiting', 'preparing'] as const)(
  'preserves a renamed one-shot while %s without reviving invalidated work',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-rename-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const preparing = Promise.withResolvers<void>()
    const continuePreparation = Promise.withResolvers<void>()
    let busy = true
    const completed = vi.fn()
    const executor: ScheduleExecution = {
      inspect: async () => ({ kind: 'missing' }),
      dispatch: async (_work, authorize) => {
        if (busy) {
          if (stage === 'waiting') throw new ScheduleBusyError('busy')
          preparing.resolve()
          await continuePreparation.promise
        }
        await authorize()
        completed()
        return { kind: 'succeeded' }
      }
    }
    const owner = new ScheduleDispatcher(async () => db, executor)
    const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
    const at = Date.now() + 60000
    try {
      await migrateApplicationDatabase(db)
      const task = await repo.create({
        target,
        requestId: 'once',
        draft: {
          name: 'Original',
          rule: { kind: 'once', at, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Execute once' }
        }
      })
      await owner.tick(at)
      if (stage === 'waiting')
        await vi.waitFor(async () =>
          expect((await db.scheduleOccurrence.findFirstOrThrow()).attemptCount).toBe(2)
        )
      else await preparing.promise
      const receipt = await db.scheduleOccurrence.findFirstOrThrow()
      // The form can still hold the pre-claim view: neither rejected edit may consume its slot.
      for (const draft of [
        {
          ...task.draft,
          action: { kind: 'send_session_message' as const, message: 'New instructions' }
        },
        { ...task.draft, rule: { kind: 'once' as const, at: at + 60000, timeZone: 'UTC' } }
      ]) {
        await expect(
          repo.edit({
            ...target,
            scheduleId: task.id,
            expectedRevision: task.revision,
            change: { kind: 'edit', draft }
          })
        ).rejects.toThrow(SCHEDULE_PENDING_EDIT_MESSAGE)
        expect(await db.scheduleOccurrence.findFirstOrThrow()).toEqual(receipt)
        expect((await repo.list({ projectId: target.projectId }))[0]).toMatchObject({
          revision: task.revision,
          draft: task.draft,
          finishedAt: null
        })
      }
      const rename = await repo.edit({
        ...target,
        scheduleId: task.id,
        expectedRevision: task.revision,
        change: { kind: 'edit', draft: { ...task.draft, name: 'Renamed' } }
      })
      expect((await db.scheduleOccurrence.findFirstOrThrow()).scheduleRevision).toBe(
        rename.revision
      )
      busy = false
      continuePreparation.resolve()
      await vi.waitFor(async () =>
        expect((await db.scheduleOccurrence.findFirstOrThrow()).attemptCount).toBe(2)
      )
      await owner.tick(at + 16000)
      await vi.waitFor(async () =>
        expect((await repo.history({ ...target, scheduleId: task.id }))[0]).toMatchObject({
          status: 'succeeded'
        })
      )
      expect(completed).toHaveBeenCalledTimes(1)

      // An explicit reschedule invalidates the old slot; renaming must not revive it.
      busy = true
      const second = await repo.create({ target, requestId: 'second', draft: task.draft })
      // Use a direct pending receipt to isolate the repository's revision carry-forward rule.
      await db.scheduleOccurrence.create({
        data: {
          id: 'invalidated',
          scheduleId: second.id,
          scheduleRevision: second.revision,
          scheduledAt: new Date(at),
          actionSnapshot: JSON.stringify(second.draft.action),
          phase: 'dispatching'
        }
      })
      const edited = await repo.edit({
        ...target,
        scheduleId: second.id,
        expectedRevision: second.revision,
        change: { kind: 'reschedule', at: at + 60000 }
      })
      await repo.edit({
        ...target,
        scheduleId: second.id,
        expectedRevision: edited.revision,
        change: { kind: 'edit', draft: { ...edited.draft, name: 'New title' } }
      })
      expect(
        (await db.scheduleOccurrence.findUniqueOrThrow({ where: { id: 'invalidated' } }))
          .scheduleRevision
      ).toBe(second.revision)
    } finally {
      continuePreparation.resolve()
      await owner.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('lists only the latest receipt per task with current runs first and owner scopes intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-latest-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  try {
    await migrateApplicationDatabase(db)
    const action = { kind: 'send_session_message' as const, message: 'Check' }
    await db.sessionSchedule.createMany({
      data: [
        { id: 'independent', projectId: 'p', sessionId: null },
        { id: 'bound', projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        { id: 'elsewhere', projectId: 'other', sessionId: null }
      ].map((owner) => ({
        ...owner,
        name: owner.id,
        actionJson: JSON.stringify(action),
        ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' })
      }))
    })
    await db.scheduleOccurrence.createMany({
      data: ['independent', 'bound', 'elsewhere'].flatMap((scheduleId) =>
        Array.from({ length: 30 }, (_, i) => ({
          id: `${scheduleId}-${i}`,
          scheduleId,
          scheduleRevision: 1,
          scheduledAt: new Date(1000 + i),
          settledAt: new Date(2000 + i),
          phase: 'settled',
          outcome: 'succeeded',
          actionSnapshot: JSON.stringify(action)
        }))
      )
    })
    // A late settlement wins over a later scheduled time.
    await db.scheduleOccurrence.update({
      where: { id: 'bound-0' },
      data: {
        settledAt: new Date(3000),
        outcome: 'failed',
        reason: 'dispatch_failed'
      }
    })
    await db.scheduleOccurrence.create({
      data: {
        id: 'current',
        scheduleId: 'independent',
        scheduleRevision: 1,
        scheduledAt: new Date(500),
        phase: 'admitted',
        admittedAt: new Date(500),
        promptMessageId: 'prompt',
        runSessionId: 'run-session',
        actionSnapshot: JSON.stringify(action)
      }
    })
    const query = vi.spyOn(db, '$queryRaw')
    const rows = await repo.list({ projectId: 'p' })
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === 'independent')?.currentRun).toMatchObject({
      status: 'admitted',
      scheduledAt: 500,
      promptMessageId: 'prompt',
      runSessionId: 'run-session'
    })
    expect(rows.find((row) => row.id === 'bound')?.latestProblem).toMatchObject({
      status: 'failed',
      scheduledAt: 1000,
      reason: 'dispatch_failed'
    })
    expect(await query.mock.results[0].value).toHaveLength(2)
    expect((await repo.list({ projectId: 'p' }, 'independent')).map((row) => row.id)).toEqual([
      'independent'
    ])
    expect((await repo.list({ projectId: 'p', sessionId: 's' })).map((row) => row.id)).toEqual([
      'bound'
    ])
    expect((await repo.list({ projectId: 'p' }, 'bound')).map((row) => row.id)).toEqual(['bound'])
    expect(await repo.list({ projectId: 'other' }, 'bound')).toEqual([])
  } finally {
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['succeeded', 'failed'] as const)(
  'does not replay a %s slot after clock rollback and resume',
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-rollback-review-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const dispatch = vi.fn(async () => ({ kind: outcome }))
    const owner = new ScheduleDispatcher(async () => db, {
      inspect: async () => ({ kind: 'missing' }),
      dispatch
    })
    const day = Date.parse('2026-11-14T00:00:00Z')
    try {
      await migrateApplicationDatabase(db)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(day + 8 * 3600000)
      const task = await repo.create({
        target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'daily',
        draft: {
          name: 'Daily',
          rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
      vi.setSystemTime(day + 9 * 3600000)
      await owner.tick(day + 9 * 3600000)
      await vi.waitFor(async () =>
        expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(1)
      )
      const receipt = await db.scheduleOccurrence.findFirstOrThrow({
        where: { scheduleId: task.id }
      })
      vi.setSystemTime(day + 9 * 3600000 + 60000)
      const current = (await repo.list({ projectId: 'p' }))[0]
      const paused = await repo.edit({
        projectId: 'p',
        sessionId: 's',
        scheduleId: task.id,
        expectedRevision: current.revision,
        change: { kind: 'pause' }
      })
      vi.setSystemTime(day + 8 * 3600000)
      // The wall clock is again before the already consumed 09:00 slot.
      const resumed = await repo.edit({
        projectId: 'p',
        sessionId: 's',
        scheduleId: task.id,
        expectedRevision: paused.revision,
        change: { kind: 'resume' }
      })
      expect(resumed.nextDueAt).toBe(day + 33 * 3600000)
      // An explicit override can still target a retained slot; claim must not replay it.
      await repo.edit({
        projectId: 'p',
        sessionId: 's',
        scheduleId: task.id,
        expectedRevision: resumed.revision,
        change: { kind: 'reschedule', at: day + 9 * 3600000 }
      })
      const healthy = await repo.create({
        target: { projectId: 'p', sessionId: 'other', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'healthy',
        draft: {
          name: 'Healthy',
          rule: { kind: 'once', at: day + 9 * 3600000 + 1000, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
      vi.setSystemTime(day + 9 * 3600000 + 2000)
      await owner.tick()
      vi.setSystemTime(day + 9 * 3600000 + 17000)
      await owner.tick()
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
      expect(await db.scheduleOccurrence.count({ where: { scheduleId: healthy.id } })).toBe(1)
      expect(await db.scheduleOccurrence.findMany({ where: { scheduleId: task.id } })).toEqual([
        receipt
      ])
      expect(
        (
          await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })
        ).nextDueAt?.getTime()
      ).toBe(day + 33 * 3600000)
    } finally {
      vi.useRealTimers()
      await owner.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('backs off a failed claim while other tasks run and retries it after the delay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-claim-retry-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const dispatch = vi.fn(async () => ({ kind: 'succeeded' as const }))
  const owner = new ScheduleDispatcher(async () => db, {
    inspect: async () => ({ kind: 'missing' }),
    dispatch
  })
  try {
    await migrateApplicationDatabase(db)
    const now = Date.now()
    for (let i = 0; i < 2; i++)
      await repo.create({
        target: { projectId: 'p', sessionId: `s${i}`, agentFrameId: 'f', messageBranchId: 'b' },
        requestId: `r${i}`,
        draft: {
          name: `Task ${i}`,
          rule: { kind: 'once', at: now + 60000 + i, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now + 60002)
    const tx = vi
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(new Error('Temporary claim failure'))
    const scans = vi.spyOn(db.sessionSchedule, 'findMany')
    owner.start()
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(1)
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(scans.mock.calls.length).toBeLessThan(5)
    const attempts = tx.mock.calls.length
    await owner.tick(now + 60003)
    expect(tx).toHaveBeenCalledTimes(attempts)
    vi.setSystemTime(Date.now() + 15001)
    await owner.tick()
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(2)
    )
    expect(dispatch).toHaveBeenCalledTimes(2)
  } finally {
    owner.suspend()
    vi.useRealTimers()
    await owner.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not replay pruned slots after clock rollback and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-retention-review-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const slots: number[] = []
  let settled = Promise.withResolvers<void>()
  let dispatched = false
  const owner = new ScheduleDispatcher(
    async () => db,
    {
      inspect: async () => ({ kind: 'missing' }),
      dispatch: async (work, authorize) => {
        await authorize()
        dispatched = true
        slots.push(work.scheduledAt.getTime())
        return { kind: 'succeeded' }
      }
    },
    () => {
      if (dispatched) {
        dispatched = false
        settled.resolve()
      }
    }
  )
  const tickAndWaitForSettlement = async (): Promise<void> => {
    settled = Promise.withResolvers<void>()
    await owner.tick()
    await settled.promise
  }
  const start = Date.parse('2026-11-14T08:00:00Z')
  try {
    await migrateApplicationDatabase(db)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const task = await repo.create({
      target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
      requestId: 'retention',
      draft: {
        name: 'Every minute',
        rule: { kind: 'interval', minutes: 1, anchor: start, timeZone: 'UTC' },
        action: { kind: 'send_session_message', message: 'Check' }
      }
    })
    for (let i = 1; i <= 31; i++) {
      vi.setSystemTime(start + i * 60000)
      await tickAndWaitForSettlement()
      expect(
        (await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })).admittedCount
      ).toBe(i)
      expect(await db.scheduleOccurrence.count({ where: { phase: { not: 'settled' } } })).toBe(0)
    }
    expect(await db.scheduleOccurrence.count()).toBe(30)
    expect(
      await db.scheduleOccurrence.count({ where: { scheduledAt: new Date(start + 60000) } })
    ).toBe(0)
    const current = (await repo.list({ projectId: 'p' }))[0]
    const paused = await repo.edit({
      projectId: 'p',
      sessionId: 's',
      scheduleId: task.id,
      expectedRevision: current.revision,
      change: { kind: 'pause' }
    })
    vi.setSystemTime(start)
    const resumed = await repo.edit({
      projectId: 'p',
      sessionId: 's',
      scheduleId: task.id,
      expectedRevision: paused.revision,
      change: { kind: 'resume' }
    })
    expect(resumed.nextDueAt).toBe(start + 32 * 60000)
    vi.setSystemTime(start + 60000)
    await owner.tick()
    expect(slots).toHaveLength(31)
    expect(await db.scheduleOccurrence.count()).toBe(30)
    vi.setSystemTime(start + 32 * 60000)
    await tickAndWaitForSettlement()
    expect(
      (await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })).admittedCount
    ).toBe(32)
    expect(slots).toHaveLength(32)
    expect(new Set(slots).size).toBe(32)
    expect(slots.at(-1)).toBe(start + 32 * 60000)
  } finally {
    await owner.dispose()
    vi.useRealTimers()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['offline', 'preparing'] as const)(
  'expires an unadmitted schedule after its deadline while %s',
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-deadline-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const start = Date.parse('2026-11-14T08:00:00Z')
    const endAt = start + 65000
    const dispatch = vi.fn<ScheduleExecution['dispatch']>(async (_work, authorize) => {
      vi.setSystemTime(endAt + 1)
      await authorize()
      return { kind: 'succeeded' }
    })
    const owner = new ScheduleDispatcher(async () => db, {
      inspect: async () => ({ kind: 'missing' }),
      dispatch
    })
    try {
      await migrateApplicationDatabase(db)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(start)
      const task = await repo.create({
        target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'hard-cutoff',
        draft: {
          name: 'Check',
          rule: { kind: 'interval', minutes: 1, anchor: start, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' },
          endAt
        }
      })
      if (scenario === 'preparing') {
        vi.setSystemTime(start + 60000)
        await owner.tick()
        await vi.waitFor(async () =>
          expect((await db.scheduleOccurrence.findFirst())?.nextAttemptAt).not.toBeNull()
        )
      }
      vi.setSystemTime(endAt + 60000)
      await owner.tick()
      await vi.waitFor(async () =>
        expect(
          await db.scheduleOccurrence.findFirst({ where: { scheduleId: task.id } })
        ).toMatchObject({
          phase: 'settled',
          outcome: 'skipped',
          reason: 'expired',
          dispatchAuthorizedAt: null
        })
      )
      expect(dispatch).toHaveBeenCalledTimes(scenario === 'preparing' ? 1 : 0)
    } finally {
      await owner.dispose()
      vi.useRealTimers()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('skips elapsed slots on resume, keeps end bounds and permits explicit one-shot catch-up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-resume-bounds-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const owner = new ScheduleDispatcher(async () => db, {
    inspect: async () => ({ kind: 'missing' }),
    dispatch: async () => ({ kind: 'failed' })
  })
  const start = Date.parse('2026-11-14T08:00:00Z')
  try {
    await migrateApplicationDatabase(db)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const task = await repo.create({
      target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
      requestId: 'resume-bounds',
      draft: {
        name: 'Check',
        rule: { kind: 'interval', minutes: 1, anchor: start, timeZone: 'UTC' },
        action: { kind: 'send_session_message', message: 'Check' },
        endAt: start + 185000
      }
    })
    const scope = { projectId: 'p', sessionId: 's', scheduleId: task.id }
    let paused = await repo.edit({
      ...scope,
      expectedRevision: task.revision,
      change: { kind: 'pause' }
    })
    vi.setSystemTime(start + 150000)
    const resumed = await repo.edit({
      ...scope,
      expectedRevision: paused.revision,
      change: { kind: 'resume' }
    })
    expect(resumed.nextDueAt).toBe(start + 180000)
    paused = await repo.edit({
      ...scope,
      expectedRevision: resumed.revision,
      change: { kind: 'pause' }
    })
    vi.setSystemTime(start + 181000)
    await expect(
      repo.edit({ ...scope, expectedRevision: paused.revision, change: { kind: 'resume' } })
    ).rejects.toThrow('no future execution time')
    expect((await repo.list({ projectId: 'p' }))[0].pausedAt).toBe(paused.pausedAt)

    vi.setSystemTime(start + 150000)
    await repo.edit({ ...scope, expectedRevision: paused.revision, change: { kind: 'resume' } })
    vi.setSystemTime(start + 180000)
    await owner.tick()
    await vi.waitFor(async () => expect((await repo.history(scope))[0]?.status).toBe('failed'))
    const exhausted = (await repo.list({ projectId: 'p' }))[0]
    expect(exhausted.nextDueAt).toBeNull()
    vi.setSystemTime(start + 150000)
    await expect(
      repo.edit({ ...scope, expectedRevision: exhausted.revision, change: { kind: 'resume' } })
    ).rejects.toThrow('no future execution time')

    const once = await repo.create({
      target: task.target,
      requestId: 'once',
      draft: {
        ...task.draft,
        endAt: undefined,
        rule: { kind: 'once', at: start + 240000, timeZone: 'UTC' }
      }
    })
    const onceScope = { ...scope, scheduleId: once.id }
    const oncePaused = await repo.edit({
      ...onceScope,
      expectedRevision: once.revision,
      change: { kind: 'pause' }
    })
    vi.setSystemTime(start + 300000)
    await expect(
      repo.edit({ ...onceScope, expectedRevision: oncePaused.revision, change: { kind: 'resume' } })
    ).rejects.toThrow('no future execution time')
    const caughtUp = await repo.edit({
      ...onceScope,
      expectedRevision: oncePaused.revision,
      change: { kind: 'resume', runOnceNow: true }
    })
    expect(caughtUp.nextDueAt).toBe(start + 300000)
    expect(caughtUp.draft.rule).toMatchObject({ kind: 'once', at: start + 300000 })
  } finally {
    await owner.dispose()
    vi.useRealTimers()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([4, 36])(
  'recovers capacity across pages with %i permission waits',
  async (waitingCount) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-recovery-capacity-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const dispatch = vi.fn(async () => ({ kind: 'succeeded' as const }))
    let unavailable = false
    const owner = new ScheduleDispatcher(async () => db, {
      inspect: async (work) => {
        if (!work.admittedAt) return { kind: 'missing' }
        if (unavailable) throw new ScheduleObservationError('Evidence unavailable')
        return { kind: 'running', waiting: true }
      },
      dispatch
    })
    let elapsed = 0
    const monotonicNow = performance.now.bind(performance)
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow() + elapsed)
    const at = Date.now() + 60000
    try {
      await migrateApplicationDatabase(db)
      for (let i = 0; i < waitingCount; i++) {
        const task = await repo.create({
          target: { projectId: 'p', sessionId: 's' + i, agentFrameId: 'f', messageBranchId: 'b' },
          requestId: 'waiting-' + i,
          draft: {
            name: 'Waiting',
            rule: { kind: 'once', at, timeZone: 'UTC' },
            action: { kind: 'send_session_message', message: 'Check' }
          }
        })
        // A normal committed admission snapshot restored after host restart.
        await db.$transaction(async (tx) => {
          await tx.sessionSchedule.update({
            where: { id: task.id },
            data: { nextDueAt: null, admittedCount: 1 }
          })
          await tx.scheduleOccurrence.create({
            data: {
              id: 'wait-' + i,
              scheduleId: task.id,
              scheduleRevision: task.revision,
              scheduledAt: new Date(at),
              actionSnapshot: JSON.stringify(task.draft.action),
              phase: 'admitted',
              promptMessageId: 'prompt-' + i,
              dispatchAuthorizedAt: new Date(at),
              admittedAt: new Date(at),
              nextAttemptAt: new Date(at)
            }
          })
        })
      }
      const healthy = await repo.create({
        target: { projectId: 'p', sessionId: 'healthy', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'healthy',
        draft: {
          name: 'Healthy',
          rule: { kind: 'once', at: at + 1, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
      for (let wave = 0; wave < 4; wave++) {
        const now = at + 10 + wave * 16000
        await owner.tick(now)
        // A large recovery sweep can take longer than the retry interval between pages.
        elapsed += 16000
        await owner.tick(now + 1)
        elapsed += 16000
        await vi.waitFor(async () => {
          const row = await db.scheduleOccurrence.findFirstOrThrow({
            where: { scheduleId: healthy.id }
          })
          expect(row.phase === 'settled' || (row.nextAttemptAt?.getTime() ?? 0) > now).toBe(true)
        })
      }
      expect(dispatch).toHaveBeenCalledTimes(1)
      const pending = await db.scheduleOccurrence.findFirstOrThrow({
        where: { scheduleId: healthy.id }
      })
      expect(pending.phase).toBe('settled')
      unavailable = true
      const later = await repo.create({
        target: healthy.target,
        requestId: 'later',
        draft: { ...healthy.draft, rule: { kind: 'once', at: at + 65000, timeZone: 'UTC' } }
      })
      await owner.tick(at + 66000)
      await owner.tick(at + 66001)
      await vi.waitFor(async () => {
        const row = await db.scheduleOccurrence.findFirstOrThrow({
          where: { scheduleId: later.id }
        })
        expect(row.nextAttemptAt?.getTime()).toBeGreaterThan(at + 66000)
      })
      expect(dispatch).toHaveBeenCalledTimes(1)
      unavailable = false
      await owner.tick(at + 82000)
      await owner.tick(at + 82001)
      // The due-order queue may retry the healthy task before the final recovery page.
      await owner.tick(at + 98000)
      await owner.tick(at + 98001)
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    } finally {
      await owner.dispose()
      clock.mockRestore()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['extend', 'remove'] as const)(
  'rearms an exhausted schedule when its end is explicitly changed: %s',
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-end-extension-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const owner = new ScheduleDispatcher(async () => db, {
      inspect: async () => ({ kind: 'missing' }),
      dispatch: async () => ({ kind: 'failed' })
    })
    const at = Date.now() + 60000
    try {
      await migrateApplicationDatabase(db)
      vi.useFakeTimers({ toFake: ['Date'] })
      const task = await repo.create({
        target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        requestId: 'end-extension',
        draft: {
          name: 'Check',
          rule: { kind: 'interval', minutes: 1, anchor: at, timeZone: 'UTC' },
          endAt: at + 5000,
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
      const scope = { projectId: 'p', sessionId: 's', scheduleId: task.id }
      vi.setSystemTime(at)
      await owner.tick()
      await vi.waitFor(async () => expect((await repo.history(scope))[0]?.status).toBe('failed'))
      const failed = (await repo.list({ projectId: 'p' }))[0]
      expect(failed.nextDueAt).toBeNull()
      expect(failed.pausedAt).not.toBeNull()
      await expect(
        repo.edit({
          ...scope,
          expectedRevision: failed.revision,
          change: { kind: 'edit', draft: { ...failed.draft, endAt: at + 30000 } }
        })
      ).rejects.toThrow('no future execution time')
      const extended = await repo.edit({
        ...scope,
        expectedRevision: failed.revision,
        change: {
          kind: 'edit',
          draft: { ...failed.draft, endAt: change === 'extend' ? at + 180000 : undefined }
        }
      })
      expect(extended.nextDueAt).toBe(at + 60000)
      expect(extended.pausedAt).toBe(failed.pausedAt)
      const resumed = await repo.edit({
        ...scope,
        expectedRevision: extended.revision,
        change: { kind: 'resume' }
      })
      expect(resumed.nextDueAt).toBe(at + 60000)
      expect(resumed.pausedAt).toBeNull()
    } finally {
      await owner.dispose()
      vi.useRealTimers()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('persists independent permissions, rejects MCP changes and never overrides a bound session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-permissions-'))
  const db = createProjectDbClient(root)
  const repository = new ScheduleRepository(async () => db)
  const target = { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null }
  const draft: ScheduleCreateRequest['draft'] = {
    name: 'Review',
    rule: { kind: 'daily', time: '09:00', timeZone: 'UTC' },
    action: { kind: 'send_session_message', message: 'Review' }
  }
  try {
    await migrateApplicationDatabase(db)
    const created = await repository.create({ target, draft, requestId: 'permissions' })
    expect(created.draft.permissionProfile).toBe('ask')
    const request = {
      projectId: 'p',
      sessionId: null,
      scheduleId: created.id,
      expectedRevision: created.revision,
      change: { kind: 'edit' as const, draft: { ...draft, permissionProfile: 'full' as const } }
    }
    await expect(repository.edit(request, () => {})).rejects.toThrow('task editor')
    const edited = await repository.edit(request)
    expect(edited.revision).toBe(created.revision + 1)
    expect(
      (await new ScheduleRepository(async () => db).list({ projectId: 'p' }))[0].draft
        .permissionProfile
    ).toBe('full')
    await expect(
      repository.create({
        target: { ...target, sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
        draft: edited.draft,
        requestId: 'bound'
      })
    ).rejects.toThrow('conversation permissions')
    await db.scheduleOccurrence.create({
      data: {
        id: 'pending-permission',
        scheduleId: edited.id,
        scheduleRevision: edited.revision,
        scheduledAt: new Date(),
        actionSnapshot: JSON.stringify(draft.action),
        phase: 'dispatching'
      }
    })
    await expect(
      repository.edit({
        ...request,
        expectedRevision: edited.revision,
        change: { kind: 'edit', draft: { ...draft, permissionProfile: 'ask' } }
      })
    ).rejects.toThrow(SCHEDULE_PENDING_EDIT_MESSAGE)
  } finally {
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('persists completion separately from cancellation and never overwrites closure on late settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-finish-reason-'))
  const db = createProjectDbClient(root)
  const repository = new ScheduleRepository(async () => db)
  const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
  const at = Date.now() + 60000
  let closeDuringRun: string | undefined
  const owner = new ScheduleDispatcher(async () => db, {
    inspect: async () => ({ kind: 'missing' }),
    dispatch: async (work, authorize) => {
      await authorize()
      if (work.scheduleId === closeDuringRun)
        await repository.edit({
          ...target,
          scheduleId: work.scheduleId,
          expectedRevision: work.scheduleRevision,
          change: { kind: 'close' }
        })
      return { kind: 'succeeded' }
    }
  })
  try {
    await migrateApplicationDatabase(db)
    const create = (requestId: string): ReturnType<ScheduleRepository['create']> =>
      repository.create({
        target,
        requestId,
        draft: {
          name: requestId,
          rule: { kind: 'once', at, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
    const completed = await create('completed')
    const cancelled = await create('cancelled')
    closeDuringRun = (await create('close-during-run')).id
    await expect(
      db.sessionSchedule.update({
        where: { id: completed.id },
        data: { finishReason: 'completed' }
      })
    ).rejects.toThrow()
    await repository.edit({
      ...target,
      scheduleId: cancelled.id,
      expectedRevision: cancelled.revision,
      change: { kind: 'close' }
    })
    await owner.tick(at)
    await vi.waitFor(async () =>
      expect(await db.scheduleOccurrence.count({ where: { phase: 'settled' } })).toBe(2)
    )
    await owner.dispose()
    await db.$disconnect()
    const reopened = createProjectDbClient(root)
    try {
      const reader = new ScheduleRepository(async () => reopened)
      const rows = await reader.list({ projectId: 'p' }, undefined, true)
      expect(rows.find((row) => row.id === completed.id)).toMatchObject({
        finishReason: 'completed',
        finishedAt: expect.any(Number)
      })
      expect(rows.find((row) => row.id === cancelled.id)).toMatchObject({
        finishReason: 'cancelled',
        finishedAt: expect.any(Number)
      })
      expect(rows.find((row) => row.id === closeDuringRun)).toMatchObject({
        finishReason: 'cancelled',
        finishedAt: expect.any(Number)
      })
      const result = await reader.edit({
        ...target,
        scheduleId: completed.id,
        expectedRevision: completed.revision,
        change: { kind: 'close' }
      })
      expect(result.finishReason).toBe('completed')
      await expect(
        reopened.sessionSchedule.update({
          where: { id: completed.id },
          data: { finishReason: 'unknown' }
        })
      ).rejects.toThrow()
    } finally {
      await reopened.$disconnect()
    }
  } finally {
    await owner.dispose()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'deletes pending work but excludes authorized execution (%s)',
  async (authorized) => {
    const root = await mkdtemp(join(tmpdir(), 'schedule-delete-'))
    const db = createProjectDbClient(root)
    const repo = new ScheduleRepository(async () => db)
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completed = vi.fn()
    const owner = new ScheduleDispatcher(async () => db, {
      inspect: async () => ({ kind: 'missing' }),
      dispatch: async (_work, authorize) => {
        if (authorized) await authorize()
        reached.resolve()
        await release.promise
        if (!authorized) await authorize()
        completed()
        return { kind: 'succeeded' }
      }
    })
    try {
      await migrateApplicationDatabase(db)
      const at = Date.now() + 60000
      const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
      const task = await repo.create({
        target,
        requestId: 'deletion',
        draft: {
          name: 'Delete me',
          rule: { kind: 'once', at, timeZone: 'UTC' },
          action: { kind: 'send_session_message', message: 'Check' }
        }
      })
      const request = {
        projectId: 'p',
        sessionId: 's',
        scheduleId: task.id,
        expectedRevision: task.revision
      }
      await repo.delete({ ...request, projectId: 'other' })
      expect(await db.sessionSchedule.findUnique({ where: { id: task.id } })).not.toBeNull()
      await expect(repo.delete({ ...request, expectedRevision: 999 })).rejects.toMatchObject({
        code: 'schedule-conflict'
      })
      await owner.tick(at)
      await reached.promise
      if (authorized) {
        await expect(repo.delete(request)).rejects.toMatchObject({ code: 'schedule-running' })
        release.resolve()
        await vi.waitFor(async () =>
          expect((await repo.history({ ...target, scheduleId: task.id }))[0]?.status).toBe(
            'succeeded'
          )
        )
      }
      if (authorized) {
        await expect(repo.delete(request)).rejects.toMatchObject({ code: 'schedule-conflict' })
        request.expectedRevision = (
          await db.sessionSchedule.findUniqueOrThrow({ where: { id: task.id } })
        ).revision
      }
      await repo.delete(request)
      release.resolve()
      await owner.dispose()
      await repo.delete(request)
      expect(await db.sessionSchedule.count()).toBe(0)
      expect(await db.scheduleOccurrence.count()).toBe(0)
      expect(await db.scheduleMutationReceipt.count({ where: { scheduleId: task.id } })).toBe(1)
      expect(completed).toHaveBeenCalledTimes(authorized ? 1 : 0)
    } finally {
      release.resolve()
      await owner.dispose()
      await db.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('pauses archived bindings and deletes Session-owned tasks without deleting independent tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-session-lifecycle-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  try {
    await migrateApplicationDatabase(db)
    const draft = {
      name: 'Check results',
      action: { kind: 'send_session_message' as const, message: 'Review the latest results' },
      rule: { kind: 'once' as const, at: Date.now() + 60000, timeZone: 'UTC' }
    }
    const bound = await repo.create({
      target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
      requestId: 'bound',
      draft
    })
    const independent = await repo.create({
      target: { projectId: 'p', sessionId: null, agentFrameId: null, messageBranchId: null },
      requestId: 'independent',
      draft
    })
    await db.scheduleOccurrence.createMany({
      data: [bound, independent].map((task) => ({
        id: task.id + '-run',
        scheduleId: task.id,
        scheduleRevision: task.revision,
        scheduledAt: new Date(),
        actionSnapshot: JSON.stringify(draft.action),
        phase: 'settled',
        outcome: 'succeeded',
        admittedAt: new Date(),
        settledAt: new Date(),
        runSessionId: task.id === independent.id ? 'output-session' : null
      }))
    })
    await repo.pauseTarget('p', 's')
    await repo.pauseTarget('p', 's')
    expect(await db.sessionSchedule.findUniqueOrThrow({ where: { id: bound.id } })).toMatchObject({
      pauseReason: 'archived',
      revision: bound.revision + 1
    })
    expect(await repo.sessionTargets()).toEqual([{ projectId: 'p', sessionId: 's' }])
    expect(await repo.sessionTargets(true)).toEqual(
      expect.arrayContaining([
        { projectId: 'p', sessionId: 's' },
        { projectId: 'p', sessionId: 'output-session' }
      ])
    )
    expect(await repo.deleteSessions(['s', 'output-session'])).toEqual(
      expect.arrayContaining([
        { projectId: 'p', sessionId: 's' },
        { projectId: 'p', sessionId: null }
      ])
    )
    expect(await db.sessionSchedule.findMany()).toMatchObject([{ id: independent.id }])
    expect(await db.scheduleOccurrence.findMany()).toMatchObject([
      { scheduleId: independent.id, runSessionId: null, outcome: 'succeeded' }
    ])
    expect(await repo.deleteSessions(['s', 'output-session'])).toEqual([])
  } finally {
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves creation idempotency after deletion and restart within the receipt window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-deletion-replay-'))
  const db = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(db)
    const repo = new ScheduleRepository(async () => db)
    const request: ScheduleCreateRequest = {
      target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
      requestId: 'stable-request',
      draft: {
        name: 'Check',
        action: { kind: 'send_session_message', message: 'Check results' },
        rule: { kind: 'once', at: Date.now() + 60000, timeZone: 'UTC' }
      }
    }
    const first = await repo.create(request)
    expect((await repo.create(request)).id).toBe(first.id)
    await repo.delete({ ...request.target, scheduleId: first.id, expectedRevision: first.revision })
    await db.$disconnect()
    const reopened = createProjectDbClient(root)
    try {
      const restarted = new ScheduleRepository(async () => reopened)
      await expect(restarted.create(request)).rejects.toMatchObject({
        code: 'schedule-request-conflict'
      })
      expect(await reopened.sessionSchedule.count()).toBe(0)
      const intentional = await restarted.create({ ...request, requestId: 'new-user-request' })
      expect(intentional.id).not.toBe(first.id)
      expect(await reopened.scheduleMutationReceipt.count()).toBe(2)
      await reopened.scheduleMutationReceipt.updateMany({ data: { expiresAt: new Date(0) } })
      await restarted.create({ ...request, requestId: 'later-request' })
      expect(await reopened.scheduleMutationReceipt.count()).toBe(1)
    } finally {
      await reopened.$disconnect()
    }
  } finally {
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('reads a coherent task summary while deletion is queued between its queries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-list-delete-'))
  const db = createProjectDbClient(root)
  const read = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let gated = false
  const reader = db.$extends({
    query: {
      sessionSchedule: {
        async findMany({ args, query }) {
          const rows = await query(args)
          if (!gated) {
            gated = true
            read.resolve()
            await resume.promise
          }
          return rows
        }
      }
    }
  }) as unknown as PrismaClient
  let listing: Promise<unknown> | undefined
  let removal: Promise<unknown> | undefined
  try {
    await migrateApplicationDatabase(db)
    await db.sessionSchedule.create({
      data: {
        id: 'snapshot',
        projectId: 'p',
        name: 'Snapshot',
        actionJson: JSON.stringify({ kind: 'send_session_message', message: 'Check' }),
        ruleJson: JSON.stringify({ kind: 'daily', time: '09:00', timeZone: 'UTC' })
      }
    })
    const repo = new ScheduleRepository(async () => reader)
    listing = repo.list({ projectId: 'p' }, undefined, true)
    await read.promise
    removal = db.sessionSchedule.delete({ where: { id: 'snapshot' } }).then(() => undefined)
    // Without a shared read transaction the delete completes before the projection query.
    // A shared transaction takes both snapshots before allowing the queued deletion.
    await Promise.race([removal, delay(100)])
    resume.resolve()
    await expect(listing).resolves.toMatchObject([
      { id: 'snapshot', draft: { action: { kind: 'send_session_message' } } }
    ])
    await removal
    expect(await repo.list({ projectId: 'p' }, undefined, true)).toEqual([])
  } finally {
    resume.resolve()
    await Promise.allSettled([listing, removal])
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

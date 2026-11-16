import { SCHEDULE_TURN_META, SCHEDULE_INVOCATION_META } from '../../shared/session-schedules'
import type { ArchiveCoordinator } from '../archive/coordinator'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ScheduleRepository } from './repository'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { ScheduleMcp } from './mcp'
import { ScheduleManagement } from './management'

it('rejects a stale write arriving during the next turn and binds self-management to its occurrence', async () => {
  const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
  const edit = vi.fn(async () => ({ id: 'job', revision: 7 }))
  const owner = new ScheduleMcp({ edit } as unknown as ScheduleManagement)
  const server = owner.server('p', (id) => id === 's', true)
  const client = new Client({ name: 'test', version: '1' })
  const [outgoing, incoming] = InMemoryTransport.createLinkedPair()
  await server.connect(incoming)
  await client.connect(outgoing)
  const first = owner.open({ target, promptMessageId: 'q', isCurrent: () => true })
  const call = (turnRef: string, scheduleId: string): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'close_schedule',
      arguments: { turnRef, scheduleId, expectedRevision: 99 }
    })
  try {
    const self = (turnRef: string, change: object): ReturnType<Client['callTool']> =>
      client.callTool({ name: 'manage_current_schedule', arguments: { turnRef, change } })
    expect((await self(first.ref, { kind: 'close' })).isError).toBe(true)
    expect(
      (
        await client.callTool({
          name: 'manage_current_schedule',
          arguments: { turnRef: first.ref, change: { kind: 'close' }, scheduleId: 'other' }
        })
      ).isError
    ).toBe(true)
    first.close()
    const second = owner.open({
      target,
      promptMessageId: 'wake',
      isCurrent: () => true,
      origin: { scheduleId: 'job', revision: 7, ownerSessionId: null }
    })
    expect((await call(first.ref, 'job')).isError).toBe(true)
    expect((await call(second.ref, 'other')).isError).toBe(true)
    expect((await call(second.ref, 'job')).isError).not.toBe(true)
    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]).toEqual([
      expect.objectContaining({ scheduleId: 'job', sessionId: null, expectedRevision: 7 }),
      expect.any(Function)
    ])
    expect(
      (await self(second.ref, { kind: 'reschedule', at: Date.now() + 60000, draft: {} })).isError
    ).toBe(true)
    const at = Date.now() + 60000
    expect((await self(second.ref, { kind: 'reschedule', at })).isError).not.toBe(true)
    expect(edit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scheduleId: 'job',
        sessionId: null,
        expectedRevision: 7,
        change: { kind: 'reschedule', at }
      }),
      expect.any(Function)
    )
    second.close()
    expect((await self(second.ref, { kind: 'close' })).isError).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})

it('advances its own successful mutation revision without adopting an external edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-mcp-cas-'))
  const db = createProjectDbClient(root)
  const repo = new ScheduleRepository(async () => db)
  const owner = new ScheduleMcp({ edit: repo.edit.bind(repo) } as ScheduleManagement)
  const server = owner.server('p', () => true, true)
  const client = new Client({ name: 'test', version: '1' })
  const [outgoing, incoming] = InMemoryTransport.createLinkedPair()
  try {
    await migrateApplicationDatabase(db)
    await server.connect(incoming)
    await client.connect(outgoing)
    const at = Date.now() + 60000
    const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
    const draft = {
      name: 'Review',
      rule: { kind: 'once' as const, at, timeZone: 'UTC' },
      action: { kind: 'send_session_message' as const, message: 'Review' }
    }
    const job = await repo.create({ target, draft, requestId: 'self' })
    await db.scheduleOccurrence.create({
      data: {
        id: 'pending',
        scheduleId: job.id,
        scheduleRevision: job.revision,
        scheduledAt: new Date(at),
        actionSnapshot: JSON.stringify(draft.action),
        phase: 'dispatching',
        dispatchAuthorizedAt: new Date()
      }
    })
    const turn = owner.open({
      target,
      promptMessageId: 'wake',
      isCurrent: () => true,
      origin: { scheduleId: job.id, revision: job.revision, ownerSessionId: 's' }
    })
    const call = (change: object): ReturnType<Client['callTool']> =>
      client.callTool({ name: 'manage_current_schedule', arguments: { turnRef: turn.ref, change } })
    const update = await client.callTool({
      name: 'update_schedule',
      arguments: {
        turnRef: turn.ref,
        scheduleId: job.id,
        expectedRevision: job.revision,
        name: draft.name,
        rule: draft.rule,
        message: 'Replace instructions'
      }
    })
    expect(update.isError).toBe(true)
    expect(JSON.stringify(update.content)).toContain('This task is waiting to run.')
    expect((await repo.list({ projectId: 'p' }))[0].revision).toBe(job.revision)
    expect((await call({ kind: 'reschedule', at: at + 60000 })).isError).not.toBe(true)
    const close = await call({ kind: 'close' })
    expect(close.isError).not.toBe(true)
    const edited = await repo.create({ target, draft, requestId: 'external-edit' })
    const second = owner.open({
      target,
      promptMessageId: 'wake2',
      isCurrent: () => true,
      origin: { scheduleId: edited.id, revision: edited.revision, ownerSessionId: 's' }
    })
    await repo.edit({
      projectId: 'p',
      sessionId: 's',
      scheduleId: edited.id,
      expectedRevision: edited.revision,
      change: { kind: 'reschedule', at: at + 120000 }
    })
    expect(
      (
        await client.callTool({
          name: 'manage_current_schedule',
          arguments: { turnRef: second.ref, change: { kind: 'close' } }
        })
      ).isError
    ).toBe(true)
  } finally {
    await client.close()
    await server.close()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('lists compact summaries and reads a full definition only inside the authenticated scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-mcp-list-'))
  const db = createProjectDbClient(root)
  const repository = new ScheduleRepository(async () => db)
  const owner = new ScheduleMcp({
    list: repository.list.bind(repository),
    summaries: (scope, id) => repository.list(scope, id, true)
  } as ScheduleManagement)
  const server = owner.server('p', () => true, true)
  const client = new Client({ name: 'test', version: '1' })
  const [outgoing, incoming] = InMemoryTransport.createLinkedPair()
  const target = { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' }
  try {
    await migrateApplicationDatabase(db)
    await server.connect(incoming)
    await client.connect(outgoing)
    const draft = {
      name: 'Private script',
      rule: { kind: 'once' as const, at: Date.now() + 60000, timeZone: 'UTC' },
      action: {
        kind: 'run_script' as const,
        language: 'python' as const,
        code: '# private executable instructions'.repeat(4000)
      }
    }
    const own = await repository.create({ target, draft, requestId: 'own' })
    const other = await repository.create({
      target: { ...target, sessionId: 'other' },
      draft,
      requestId: 'other'
    })
    const management = new ScheduleManagement(
      repository,
      { loadSessionForContinuation: vi.fn() },
      {} as ArchiveCoordinator,
      vi.fn()
    )
    expect(JSON.stringify(await management.summaries({ projectId: 'p' }))).not.toContain(
      draft.action.code
    )
    expect(
      (await management.get({ projectId: 'p', sessionId: 's', scheduleId: own.id }))?.draft
    ).toEqual(draft)
    expect(await management.get({ projectId: 'p', sessionId: null, scheduleId: own.id })).toBeNull()
    expect(
      await management.get({ projectId: 'elsewhere', sessionId: 's', scheduleId: own.id })
    ).toBeNull()
    const turn = owner.open({ target, promptMessageId: 'prompt', isCurrent: () => true })
    const readRows = vi.spyOn(db.sessionSchedule, 'findMany')
    const summary = await client.callTool({
      name: 'list_schedules',
      arguments: { turnRef: turn.ref }
    })
    expect(summary.isError).not.toBe(true)
    const databaseRows = await readRows.mock.results[0].value
    expect(databaseRows[0]).not.toHaveProperty('actionJson')
    expect(JSON.stringify(databaseRows).length).toBeLessThan(2000)
    expect(JSON.stringify(summary)).toContain(own.id)
    expect(JSON.stringify(summary)).not.toContain(draft.action.code)
    expect(JSON.stringify(summary)).not.toContain(other.id)
    const detail = await client.callTool({
      name: 'list_schedules',
      arguments: { turnRef: turn.ref, scheduleId: own.id }
    })
    expect(JSON.stringify(detail)).toContain(draft.action.code)
    const denied = await client.callTool({
      name: 'list_schedules',
      arguments: { turnRef: turn.ref, scheduleId: other.id }
    })
    expect(JSON.stringify(denied)).not.toContain(draft.action.code)
    turn.close()
    const scheduled = owner.open({
      target,
      promptMessageId: 'wake',
      isCurrent: () => true,
      origin: { scheduleId: own.id, revision: own.revision, ownerSessionId: 's' }
    })
    expect(
      (
        await client.callTool({
          name: 'list_schedules',
          arguments: { turnRef: scheduled.ref, scheduleId: other.id }
        })
      ).isError
    ).toBe(true)
    scheduled.close()
  } finally {
    await client.close()
    await server.close()
    await db.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('advertises conversation-safe drafts and rejects invalid limits before a write', async () => {
  const create = vi.fn<
    (
      request: import('../../shared/session-schedules').ScheduleCreateRequest,
      guard?: () => void,
      origin?: string
    ) => Promise<{ id: string; revision: number }>
  >(async () => ({ id: 'job', revision: 1 }))
  const owner = new ScheduleMcp({ create } as unknown as ScheduleManagement)
  const server = owner.server('p', () => true, true)
  const client = new Client({ name: 'test', version: '1' })
  const [outgoing, incoming] = InMemoryTransport.createLinkedPair()
  await server.connect(incoming)
  await client.connect(outgoing)
  const turn = owner.open({
    target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
    promptMessageId: 'q',
    isCurrent: () => true
  })
  try {
    const { tools } = await client.listTools()
    for (const name of ['create_schedule', 'update_schedule']) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema
      expect(JSON.stringify(schema)).not.toContain('permissionProfile')
      expect(JSON.stringify(schema)).toContain('Omit for once')
    }
    const draft = {
      name: 'Review',
      rule: { kind: 'once', at: Date.now() + 60000, timeZone: 'UTC' },
      message: 'Review progress'
    }
    const call = (draft: object): ReturnType<Client['callTool']> =>
      client.callTool({
        name: 'create_schedule',
        arguments: { turnRef: turn.ref, requestId: 'create-review', ...draft }
      })
    const missingName = await call({ rule: draft.rule, message: draft.message })
    expect(missingName.isError).toBe(true)
    expect(JSON.stringify(missingName.content)).toContain('name')
    expect((await call({ ...draft, permissionProfile: 'full' })).isError).toBe(true)
    expect((await call({ ...draft, maxRuns: 1 })).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
    expect((await call(draft)).isError).not.toBe(true)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: {
          name: draft.name,
          rule: draft.rule,
          action: { kind: 'send_session_message', message: draft.message }
        }
      }),
      expect.any(Function),
      'q'
    )
    const computerZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    for (const rule of [
      { kind: 'once', at: draft.rule.at },
      { kind: 'daily', time: '09:00' },
      { kind: 'weekly', time: '09:00', weekdays: [1] },
      { kind: 'interval', anchor: draft.rule.at, minutes: 5 }
    ]) {
      expect((await call({ ...draft, rule })).isError).not.toBe(true)
      expect(create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          draft: {
            name: draft.name,
            action: { kind: 'send_session_message', message: draft.message },
            rule: { ...rule, timeZone: computerZone }
          }
        }),
        expect.any(Function),
        'q'
      )
    }
    const metadataCall = (): ReturnType<Client['callTool']> =>
      client.callTool({
        name: 'create_schedule',
        arguments: draft,
        _meta: { [SCHEDULE_TURN_META]: turn.ref, [SCHEDULE_INVOCATION_META]: 'stable-invocation' }
      })
    expect((await metadataCall()).isError).not.toBe(true)
    const generated = create.mock.calls.at(-1)![0].requestId
    expect(generated).toMatch(/^host-[a-f0-9]{64}$/)
    expect((await metadataCall()).isError).not.toBe(true)
    expect(create.mock.calls.at(-1)![0].requestId).toBe(generated)
    expect((await client.callTool({ name: 'create_schedule', arguments: draft })).isError).toBe(
      true
    )
    expect(
      (
        await client.callTool({
          name: 'create_schedule',
          arguments: { ...draft, turnRef: turn.ref }
        })
      ).isError
    ).toBe(true)
    expect(
      (await call({ ...draft, script: { language: 'python', code: 'print(1)' } })).isError
    ).toBe(true)
    expect(
      (
        await call({
          name: draft.name,
          rule: draft.rule,
          script: { language: 'python', code: 'print(1)' }
        })
      ).isError
    ).not.toBe(true)
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          action: { kind: 'run_script', language: 'python', code: 'print(1)' }
        })
      }),
      expect.any(Function),
      'q'
    )
    expect((await call({ draft })).isError).toBe(true)
    create.mockClear()
    expect(
      (await call({ ...draft, rule: { ...draft.rule, timeZone: 'Invalid/Zone' } })).isError
    ).toBe(true)
    expect(
      (await call({ ...draft, rule: { kind: 'once', at: draft.rule.at }, maxRuns: 1 })).isError
    ).toBe(true)
    expect(create).not.toHaveBeenCalled()
    turn.close()
    owner.open({
      target: { projectId: 'p', sessionId: 's', agentFrameId: 'f', messageBranchId: 'b' },
      promptMessageId: 'next',
      isCurrent: () => true
    })
    expect((await metadataCall()).isError).toBe(true)
    expect(create).not.toHaveBeenCalled()
  } finally {
    await client.close()
    await server.close()
  }
})

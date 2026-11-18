import { ApplicationCommandError } from '../../shared/application-command-contract'
import type { ScheduleTurnOrigin } from '../../shared/session-schedules'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  Prisma,
  type PrismaClient,
  type SessionSchedule,
  type ScheduleOccurrence
} from '@prisma/client'
import { nextScheduleTime, scheduleEndExtended } from '../../shared/schedule-time'
import {
  SCHEDULE_PENDING_EDIT_MESSAGE,
  scheduleDraftSchema,
  scheduleSummarySchema,
  scheduleViewSchema,
  type ScheduleSummary,
  scheduleOwnerSchema,
  scheduleRunSchema,
  type ScheduleCreateRequest,
  type ScheduleHistoryRequest,
  type ScheduleRun,
  type ScheduleEditRequest,
  type ScheduleDeleteRequest,
  type ScheduleListRequest,
  type ScheduleView,
  type ScheduleDraft
} from '../../shared/session-schedules'

function view(row: SessionSchedule): ScheduleView
function view(
  row: Omit<SessionSchedule, 'actionJson'>,
  action: ScheduleSummary['draft']['action']
): ScheduleSummary
function view(
  row: Omit<SessionSchedule, 'actionJson'> & { actionJson?: string },
  action?: ScheduleSummary['draft']['action']
): ScheduleView | ScheduleSummary {
  const draft = {
    name: row.name,
    ...(row.permissionProfile ? { permissionProfile: row.permissionProfile } : {}),
    action: action ?? JSON.parse(row.actionJson!),
    rule: JSON.parse(row.ruleJson),
    endAt: row.endAt?.getTime(),
    maxRuns: row.maxRuns ?? undefined
  }
  return {
    originPromptId: row.originPromptId,
    id: row.id,
    revision: row.revision,
    target: scheduleOwnerSchema.parse({
      projectId: row.projectId,
      sessionId: row.sessionId,
      agentFrameId: row.agentFrameId,
      messageBranchId: row.messageBranchId
    }),
    draft: action
      ? scheduleSummarySchema.shape.draft.parse(draft)
      : scheduleDraftSchema.parse(draft),
    nextDueAt: row.nextDueAt?.getTime() ?? null,
    finishedAt: row.finishedAt?.getTime() ?? null,
    finishReason: scheduleViewSchema.shape.finishReason.parse(row.finishReason),
    pausedAt: row.pausedAt?.getTime() ?? null,
    pauseReason: row.pauseReason
  }
}

function nextDue(draft: ScheduleDraft, after: number): Date {
  const due = nextScheduleTime(draft.rule, after)
  if (due === null || (draft.endAt !== undefined && due > draft.endAt))
    throw new ApplicationCommandError(
      'schedule-no-future-run',
      'The schedule has no future execution time.'
    )
  return new Date(due)
}

function definition(
  draft: ScheduleDraft,
  sessionId: string | null
): Pick<
  SessionSchedule,
  'name' | 'actionJson' | 'ruleJson' | 'maxRuns' | 'endAt' | 'permissionProfile'
> {
  if (sessionId !== null && draft.permissionProfile !== undefined)
    throw new ApplicationCommandError(
      'schedule-invalid-change',
      'A bound schedule follows its conversation permissions.'
    )
  return {
    name: draft.name,
    permissionProfile: sessionId === null ? (draft.permissionProfile ?? 'ask') : null,
    actionJson: JSON.stringify(draft.action),
    ruleJson: JSON.stringify(draft.rule),
    maxRuns: draft.maxRuns ?? null,
    endAt: draft.endAt === undefined ? null : new Date(draft.endAt)
  }
}

export class ScheduleRepository {
  constructor(private readonly database: () => Promise<PrismaClient>) {}

  async originForOccurrence(
    id: string,
    projectId: string,
    sessionId: string
  ): Promise<ScheduleTurnOrigin> {
    const occurrence = await (
      await this.database()
    ).scheduleOccurrence.findFirstOrThrow({
      where: {
        id,
        schedule: { projectId },
        OR: [{ runSessionId: sessionId }, { schedule: { sessionId } }]
      },
      select: {
        scheduleId: true,
        scheduleRevision: true,
        schedule: { select: { sessionId: true } }
      }
    })
    return {
      scheduleId: occurrence.scheduleId,
      revision: occurrence.scheduleRevision,
      ownerSessionId: occurrence.schedule.sessionId
    }
  }

  async pauseTarget(projectId: string, sessionId?: string): Promise<void> {
    await (
      await this.database()
    ).sessionSchedule.updateMany({
      where: { projectId, sessionId, pausedAt: null, finishedAt: null },
      data: { pausedAt: new Date(), pauseReason: 'archived', revision: { increment: 1 } }
    })
  }
  async deleteTarget(projectId: string, sessionId?: string): Promise<void> {
    const db = await this.database()
    await db.$transaction(async (tx) => {
      if (sessionId)
        await tx.scheduleOccurrence.updateMany({
          where: { runSessionId: sessionId, schedule: { projectId } },
          data: { runSessionId: null }
        })
      await tx.sessionSchedule.deleteMany({ where: { projectId, sessionId } })
    })
  }

  async sessionTargets(
    includeAdmittedRuns = false
  ): Promise<{ projectId: string; sessionId: string }[]> {
    const db = await this.database()
    const rows = await db.sessionSchedule.findMany({
      where: { sessionId: { not: null } },
      select: { projectId: true, sessionId: true },
      distinct: ['projectId', 'sessionId']
    })
    const targets = rows.map((row) => ({ projectId: row.projectId, sessionId: row.sessionId! }))
    if (includeAdmittedRuns) {
      // Reserved pre-admission IDs may not have a Session yet; absence is not deletion evidence.
      const runs = await db.scheduleOccurrence.findMany({
        where: { runSessionId: { not: null }, admittedAt: { not: null } },
        select: { runSessionId: true, schedule: { select: { projectId: true } } },
        distinct: ['runSessionId']
      })
      targets.push(
        ...runs.map((run) => ({ projectId: run.schedule.projectId, sessionId: run.runSessionId! }))
      )
    }
    return [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()]
  }

  async deleteSessions(
    sessionIds: readonly string[]
  ): Promise<{ projectId: string; sessionId: string | null }[]> {
    if (!sessionIds.length) return []
    const db = await this.database()
    return db.$transaction(async (tx) => {
      const ids = [...sessionIds]
      const targets = await tx.sessionSchedule.findMany({
        where: {
          OR: [{ sessionId: { in: ids } }, { occurrences: { some: { runSessionId: { in: ids } } } }]
        },
        select: { projectId: true, sessionId: true },
        distinct: ['projectId', 'sessionId']
      })
      // A run Session is output owned by an independent task, not the task's lifetime owner.
      await tx.scheduleOccurrence.updateMany({
        where: { runSessionId: { in: ids } },
        data: { runSessionId: null }
      })
      await tx.sessionSchedule.deleteMany({ where: { sessionId: { in: ids } } })
      return targets
    })
  }

  async delete(request: ScheduleDeleteRequest): Promise<void> {
    const db = await this.database()
    await db.$transaction(async (tx) => {
      const where = {
        id: request.scheduleId,
        projectId: request.projectId,
        sessionId: request.sessionId
      }
      const row = await tx.sessionSchedule.findFirst({ where })
      if (!row) return
      if (row.revision !== request.expectedRevision)
        throw new ApplicationCommandError(
          'schedule-conflict',
          'The schedule changed before deletion.'
        )
      const running = await tx.scheduleOccurrence.count({
        where: {
          scheduleId: row.id,
          phase: { not: 'settled' },
          OR: [
            { dispatchAuthorizedAt: { not: null } },
            { admittedAt: { not: null } },
            { phase: 'admitted' }
          ]
        }
      })
      if (running)
        throw new ApplicationCommandError('schedule-running', 'The schedule is still executing.')
      // The same transaction excludes dispatch authorization and preserves session-owned output.
      // Keep the bounded creation receipt so a delayed retry cannot recreate a deleted task.
      await tx.sessionSchedule.delete({ where: { ...where, revision: request.expectedRevision } })
    })
  }

  async history({
    projectId,
    sessionId,
    scheduleId
  }: ScheduleHistoryRequest): Promise<ScheduleRun[]> {
    const rows = await (
      await this.database()
    ).scheduleOccurrence.findMany({
      where: { scheduleId, schedule: { projectId, sessionId } },
      select: {
        scheduledAt: true,
        phase: true,
        outcome: true,
        reason: true,
        admittedAt: true,
        promptMessageId: true,
        runSessionId: true,
        scriptRunId: true
      },
      orderBy: { scheduledAt: 'desc' },
      take: 30
    })
    return rows.map((row) =>
      scheduleRunSchema.parse({
        scheduledAt: row.scheduledAt.getTime(),
        status: row.outcome ?? row.phase,
        promptMessageId: row.admittedAt ? row.promptMessageId : null,
        reason: row.reason,
        runSessionId: row.admittedAt ? row.runSessionId : null,
        scriptRunId: row.scriptRunId
      })
    )
  }
  list(request: ScheduleListRequest, scheduleId?: string): Promise<ScheduleView[]>
  list(
    request: ScheduleListRequest,
    scheduleId: string | undefined,
    summary: true
  ): Promise<ScheduleSummary[]>
  async list(
    request: ScheduleListRequest,
    scheduleId?: string,
    summary = false
  ): Promise<(ScheduleView | ScheduleSummary)[]> {
    const db = await this.database()
    // Definition and latest run must come from one snapshot when edits/deletion race a refresh.
    const [rows, latestRows] = await db.$transaction([
      db.sessionSchedule.findMany({
        where: { ...request, id: scheduleId },
        orderBy: [{ nextDueAt: 'asc' }, { id: 'asc' }],
        omit: { actionJson: summary }
      }),
      // Prisma's per-parent take loads every receipt on SQLite; select the winner in SQL.
      db.$queryRaw<
        (Pick<
          ScheduleOccurrence,
          | 'scheduleId'
          | 'phase'
          | 'admittedAt'
          | 'runSessionId'
          | 'scheduledAt'
          | 'promptMessageId'
          | 'outcome'
          | 'reason'
          | 'scriptRunId'
        > & { id: string; actionKind: string; language: string | null })[]
      >(Prisma.sql`
      SELECT s.id, json_extract(s.actionJson, '$.kind') AS actionKind,
             json_extract(s.actionJson, '$.language') AS language, o.scheduleId, o.phase, o.admittedAt, o.runSessionId, o.scheduledAt,
             o.promptMessageId, o.outcome, o.reason, o.scriptRunId
      FROM SessionSchedule s
      LEFT JOIN ScheduleOccurrence o ON o.id = (
        SELECT id FROM ScheduleOccurrence
        WHERE scheduleId = s.id
        ORDER BY settledAt DESC NULLS FIRST, scheduledAt DESC
        LIMIT 1
      )
      WHERE s.projectId = ${request.projectId}
        ${
          request.sessionId === undefined
            ? Prisma.empty
            : Prisma.sql`AND s.sessionId = ${request.sessionId}`
        }
        ${scheduleId === undefined ? Prisma.empty : Prisma.sql`AND s.id = ${scheduleId}`}
    `)
    ])
    if (!rows.length) return []
    const latestBySchedule = new Map(latestRows.map((row) => [row.id, row]))
    return rows.map((row) => {
      const projection = latestBySchedule.get(row.id)
      const latest = projection?.scheduleId ? projection : undefined
      const projectedView = summary
        ? view(
            row,
            scheduleSummarySchema.shape.draft.shape.action.parse({
              kind: projection?.actionKind,
              language: projection?.language
            })
          )
        : view(row as SessionSchedule)
      const status = latest?.outcome
      return {
        ...projectedView,
        ...(latest && latest.phase !== 'settled'
          ? {
              currentRun: scheduleRunSchema.parse({
                scheduledAt: latest.scheduledAt.getTime(),
                status: latest.phase,
                reason: latest.reason,
                promptMessageId: latest.admittedAt ? latest.promptMessageId : null,
                runSessionId: latest.admittedAt ? latest.runSessionId : null,
                scriptRunId: latest.scriptRunId
              })
            }
          : {}),
        ...(latest && (status === 'failed' || status === 'interrupted' || status === 'skipped')
          ? {
              latestProblem: {
                status,
                reason: latest.reason,
                scheduledAt: latest.scheduledAt.getTime(),
                scriptRunId: latest.scriptRunId
              }
            }
          : {})
      }
    })
  }

  async create(
    { target, draft, requestId }: ScheduleCreateRequest,
    guard?: () => void,
    originPromptId?: string
  ): Promise<ScheduleView> {
    const db = await this.database()
    const key = JSON.stringify([target.projectId, target.sessionId, requestId])
    const hash = createHash('sha256').update(JSON.stringify({ target, draft })).digest('hex')
    return db.$transaction(async (tx) => {
      const now = Date.now()
      await tx.scheduleMutationReceipt.deleteMany({ where: { expiresAt: { lte: new Date(now) } } })
      const old = await tx.scheduleMutationReceipt.findUnique({ where: { requestKey: key } })
      guard?.()
      if (old) {
        if (old.inputHash !== hash)
          throw new ApplicationCommandError(
            'schedule-request-conflict',
            'The schedule request has conflicting content.'
          )
        const previous = await tx.sessionSchedule.findUnique({ where: { id: old.scheduleId } })
        if (!previous)
          throw new ApplicationCommandError(
            'schedule-request-conflict',
            'The task created by this request was deleted. Do not recreate it without a new user request.'
          )
        return view(previous)
      }
      const row = await tx.sessionSchedule.create({
        data: {
          id: randomUUID(),
          ...target,
          originPromptId,
          ...definition(draft, target.sessionId),
          nextDueAt: nextDue(draft, now)
        }
      })
      await tx.scheduleMutationReceipt.create({
        data: {
          requestKey: key,
          scheduleId: row.id,
          inputHash: hash,
          expiresAt: new Date(now + 86_400_000)
        }
      })
      return view(row)
    })
  }

  async edit(request: ScheduleEditRequest, guard?: () => void): Promise<ScheduleView> {
    const db = await this.database()
    const where = {
      id: request.scheduleId,
      projectId: request.projectId,
      sessionId: request.sessionId
    }
    return db.$transaction(async (tx) => {
      const row = await tx.sessionSchedule.findFirstOrThrow({ where })
      guard?.()
      const change = request.change
      if (change.kind === 'close' && row.finishedAt) return view(row)
      if (row.finishedAt || row.revision !== request.expectedRevision)
        throw new ApplicationCommandError(
          'schedule-conflict',
          'The schedule changed. Reopen it before editing.'
        )
      const revision = { increment: 1 }
      const now = new Date()
      const current = view(row)
      const filter = { ...where, revision: request.expectedRevision }
      if (change.kind === 'reschedule') {
        if (
          row.pausedAt ||
          change.at <= now.getTime() ||
          (row.endAt && change.at > row.endAt.getTime()) ||
          (row.maxRuns !== null && row.admittedCount >= row.maxRuns)
        )
          throw new ApplicationCommandError(
            row.pausedAt
              ? 'schedule-invalid-change'
              : change.at <= now.getTime()
                ? 'schedule-no-future-run'
                : row.maxRuns !== null && row.admittedCount >= row.maxRuns
                  ? 'schedule-limit-reached'
                  : 'schedule-outside-window',
            'The requested next run is outside the active schedule.'
          )
        return view(
          await tx.sessionSchedule.update({
            where: filter,
            data: {
              nextDueAt: new Date(change.at),
              revision,
              ...(current.draft.rule.kind === 'once'
                ? { ruleJson: JSON.stringify({ ...current.draft.rule, at: change.at }) }
                : {})
            }
          })
        )
      }
      if (change.kind === 'edit') {
        if (
          guard &&
          change.draft.permissionProfile !== undefined &&
          change.draft.permissionProfile !== current.draft.permissionProfile
        )
          throw new ApplicationCommandError(
            'schedule-invalid-change',
            'Schedule permissions can only be changed in the task editor.'
          )
        if (change.draft.action.kind !== current.draft.action.kind)
          throw new ApplicationCommandError(
            'schedule-invalid-change',
            'The schedule action kind cannot be changed.'
          )
        const sameTime = isDeepStrictEqual(change.draft.rule, current.draft.rule)
        const rearm = !row.nextDueAt && scheduleEndExtended(current.draft, change.draft)
        const due = sameTime && !rearm ? row.nextDueAt : nextDue(change.draft, now.getTime())
        if (due && change.draft.endAt !== undefined && due.getTime() > change.draft.endAt)
          throw new ApplicationCommandError(
            'schedule-outside-window',
            'The schedule ends before its next execution.'
          )
        const sameExecution =
          sameTime &&
          (change.draft.permissionProfile ?? row.permissionProfile) === row.permissionProfile &&
          isDeepStrictEqual(change.draft.action, current.draft.action) &&
          (change.draft.endAt ?? null) === (row.endAt?.getTime() ?? null) &&
          (change.draft.maxRuns ?? null) === row.maxRuns
        if (
          !sameExecution &&
          change.draft.maxRuns !== undefined &&
          change.draft.maxRuns <= row.admittedCount
        )
          throw new ApplicationCommandError(
            'schedule-limit-reached',
            'The execution bound has already been reached.'
          )
        if (
          !sameExecution &&
          (await tx.scheduleOccurrence.count({
            where: { scheduleId: row.id, phase: 'dispatching' }
          }))
        )
          throw new ApplicationCommandError('schedule-pending', SCHEDULE_PENDING_EDIT_MESSAGE)
        // Renaming must not consume a claimed slot or revive work invalidated by an earlier edit.
        if (sameExecution)
          await tx.scheduleOccurrence.updateMany({
            where: {
              scheduleId: row.id,
              scheduleRevision: row.revision,
              phase: 'dispatching',
              dispatchAuthorizedAt: null,
              admittedAt: null
            },
            data: { scheduleRevision: { increment: 1 } }
          })
        return view(
          await tx.sessionSchedule.update({
            where: filter,
            data: {
              ...definition(
                {
                  ...change.draft,
                  permissionProfile:
                    change.draft.permissionProfile ?? current.draft.permissionProfile
                },
                row.sessionId
              ),
              nextDueAt: due,
              revision
            }
          })
        )
      }
      if (change.kind === 'resume' && !row.pausedAt) return current
      if (change.kind === 'pause' && row.pausedAt) return current
      if (change.kind === 'resume' && row.maxRuns !== null && row.admittedCount >= row.maxRuns)
        throw new ApplicationCommandError(
          'schedule-limit-reached',
          'The execution bound has already been reached.'
        )
      const runOnceNow = change.kind === 'resume' && change.runOnceNow
      if (
        runOnceNow &&
        (current.draft.rule.kind !== 'once' || current.draft.rule.at > now.getTime())
      )
        throw new ApplicationCommandError(
          'schedule-invalid-change',
          'Only a past one-shot can be resumed immediately.'
        )
      let resumeAt = row.nextDueAt
      if (change.kind === 'resume' && !runOnceNow) {
        if (current.draft.rule.kind !== 'once' && !resumeAt)
          throw new ApplicationCommandError(
            'schedule-no-future-run',
            'The schedule has no future execution time.'
          )
        // Keep a future committed slot even after clock rollback or receipt pruning.
        if (!resumeAt || resumeAt <= now) resumeAt = nextDue(current.draft, now.getTime())
      }
      const data =
        change.kind === 'close'
          ? {
              finishedAt: now,
              finishReason: 'cancelled',
              nextDueAt: null,
              pausedAt: null,
              pauseReason: null
            }
          : change.kind === 'pause'
            ? { pausedAt: now, pauseReason: null }
            : {
                pausedAt: null,
                pauseReason: null,
                ...(runOnceNow
                  ? {
                      nextDueAt: now,
                      ruleJson: JSON.stringify({ ...current.draft.rule, at: now.getTime() })
                    }
                  : { nextDueAt: resumeAt })
              }
      return view(await tx.sessionSchedule.update({ where: filter, data: { ...data, revision } }))
    })
  }
}

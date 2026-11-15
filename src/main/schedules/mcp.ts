import { randomUUID, createHash } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  scheduleDraftSchema,
  scheduleToolDraft,
  SCHEDULE_TURN_META,
  SCHEDULE_INVOCATION_META,
  scheduleToolInputs,
  scheduleToolDescriptions,
  SCHEDULE_MCP_NAME,
  type ScheduleEditRequest,
  type ScheduleTarget,
  type ScheduleView
} from '../../shared/session-schedules'
import type { ScheduleManagement } from './management'
import type { ScheduleTurnOrigin } from '../../shared/session-schedules'

type Binding = {
  target: ScheduleTarget
  promptMessageId: string
  isCurrent: () => boolean
  origin?: ScheduleTurnOrigin
}
const result = (value: unknown): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }]
})
export class ScheduleMcp {
  private readonly turns = new Map<string, Binding & { timeZone: string }>()
  constructor(private readonly store: ScheduleManagement) {}
  open(binding: Binding): { ref: string; close: () => void } {
    const ref = 'schedule-turn-' + randomUUID()
    this.turns.set(ref, { ...binding, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    return { ref, close: () => this.turns.delete(ref) }
  }
  originForOccurrence(
    id: string,
    projectId: string,
    sessionId: string
  ): Promise<ScheduleTurnOrigin> {
    return this.store.originForOccurrence(id, projectId, sessionId)
  }
  server(
    projectId: string,
    owns: (sessionId: string) => boolean,
    scriptsAllowed: boolean
  ): McpServer {
    const server = new McpServer({ name: SCHEDULE_MCP_NAME, version: '1.0.0' })
    const verify = (ref: unknown): Binding & { timeZone: string } => {
      const binding = typeof ref === 'string' ? this.turns.get(ref) : undefined
      if (
        !binding ||
        binding.target.projectId !== projectId ||
        !owns(binding.target.sessionId) ||
        !binding.isCurrent()
      )
        throw new Error('The schedule tool call belongs to an expired turn.')
      return binding
    }
    const reference = (ref: string | undefined, meta?: Record<string, unknown>): string => {
      const supplied = meta?.[SCHEDULE_TURN_META]
      if (ref !== undefined && supplied !== undefined && ref !== supplied)
        throw new Error('Schedule turn identity mismatch.')
      const value = supplied ?? ref
      verify(value)
      return value as string
    }
    const edit = async (
      ref: string,
      binding: Binding,
      request: ScheduleEditRequest
    ): Promise<CallToolResult> => {
      const saved = await this.store.edit(request, () => verify(ref))
      // Advance only after our own CAS succeeds; never adopt an unrelated editor's revision.
      if (binding.origin) binding.origin = { ...binding.origin, revision: saved.revision }
      return result(saved)
    }
    const manage = async (
      ref: string,
      id: string,
      revision: number,
      change: { kind: 'close' } | { kind: 'edit'; draft: ScheduleView['draft'] }
    ): Promise<CallToolResult> => {
      const b = verify(ref)
      if (change.kind === 'edit' && change.draft.action.kind === 'run_script' && !scriptsAllowed)
        throw new Error('Notebook execution is unavailable in this conversation.')
      if (b.origin && b.origin.scheduleId !== id)
        throw new Error('A scheduled turn can only manage its own schedule.')
      return edit(ref, b, {
        projectId,
        sessionId: b.origin ? b.origin.ownerSessionId : b.target.sessionId,
        scheduleId: id,
        expectedRevision: b.origin?.revision ?? revision,
        change
      })
    }
    server.registerTool(
      'list_schedules',
      {
        description: scheduleToolDescriptions.list_schedules,
        inputSchema: scheduleToolInputs.list_schedules
      },
      async ({ turnRef: supplied, scheduleId }, extra) => {
        const turnRef = reference(supplied, extra._meta)
        const b = verify(turnRef)
        if (scheduleId && b.origin && b.origin.scheduleId !== scheduleId)
          throw new Error('A scheduled turn can only manage its own schedule.')
        const scope =
          b.origin?.ownerSessionId === null
            ? { projectId }
            : { projectId, sessionId: b.target.sessionId }
        const id = b.origin?.ownerSessionId === null ? b.origin.scheduleId : scheduleId
        const rows = scheduleId
          ? await this.store.list(scope, id)
          : await this.store.summaries(scope, id)
        verify(turnRef)
        return result(rows)
      }
    )
    server.registerTool(
      'create_schedule',
      {
        description: scheduleToolDescriptions.create_schedule,
        inputSchema: scheduleToolInputs.create_schedule
      },
      async ({ turnRef: supplied, requestId: requestedId, ...input }, extra) => {
        const turnRef = reference(supplied, extra._meta)
        const b = verify(turnRef)
        const invocation = extra._meta?.[SCHEDULE_INVOCATION_META]
        const requestId =
          requestedId ??
          (typeof invocation === 'string' && invocation.length > 0 && invocation.length <= 512
            ? 'host-' + createHash('sha256').update(invocation).digest('hex')
            : undefined)
        if (!requestId)
          throw new Error('Supply a stable requestId when host invocation identity is unavailable.')
        const draft = scheduleDraftSchema.parse({
          ...scheduleToolDraft(input),
          rule: { ...input.rule, timeZone: input.rule.timeZone ?? b.timeZone }
        })
        if (b.origin) throw new Error('A scheduled turn cannot create another schedule.')
        if (draft.action.kind === 'run_script' && !scriptsAllowed)
          throw new Error('Notebook execution is unavailable in this conversation.')
        return result(
          await this.store.create(
            {
              target: b.target,
              draft,
              requestId
            },
            () => verify(turnRef),
            b.promptMessageId
          )
        )
      }
    )
    server.registerTool(
      'update_schedule',
      {
        description: scheduleToolDescriptions.update_schedule,
        inputSchema: scheduleToolInputs.update_schedule
      },
      ({ turnRef, scheduleId, expectedRevision, ...input }, extra) =>
        manage(reference(turnRef, extra._meta), scheduleId, expectedRevision, {
          kind: 'edit',
          draft: scheduleDraftSchema.parse(scheduleToolDraft(input))
        })
    )
    server.registerTool(
      'close_schedule',
      {
        description: scheduleToolDescriptions.close_schedule,
        inputSchema: scheduleToolInputs.close_schedule
      },
      ({ turnRef, scheduleId, expectedRevision }, extra) =>
        manage(reference(turnRef, extra._meta), scheduleId, expectedRevision, { kind: 'close' })
    )
    server.registerTool(
      'manage_current_schedule',
      {
        description: scheduleToolDescriptions.manage_current_schedule,
        inputSchema: scheduleToolInputs.manage_current_schedule
      },
      async ({ turnRef: supplied, change }, extra) => {
        const turnRef = reference(supplied, extra._meta)
        const binding = verify(turnRef)
        const origin = binding.origin
        if (!origin) throw new Error('Only a scheduled turn can manage its own schedule.')
        return edit(turnRef, binding, {
          projectId,
          sessionId: origin.ownerSessionId,
          scheduleId: origin.scheduleId,
          expectedRevision: origin.revision,
          change
        })
      }
    )
    return server
  }
}

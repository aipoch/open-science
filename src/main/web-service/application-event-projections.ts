import type { AcpRuntimeEvent } from '../../shared/acp'
import { WEB_RPC_PROTOCOL_VERSION, isWebRpcEventChannel } from '../../shared/web-rpc-contract'
import type { TaskRunIdentity, TaskRunProgressEvent } from '../../shared/task-api'
import type { ApplicationEvent } from '../application-events'

type WebRendererEvent = {
  protocolVersion: typeof WEB_RPC_PROTOCOL_VERSION
  channel: string
  payload: unknown
}

type PublicTaskEvent = TaskRunIdentity &
  (
    | { type: 'run.event'; data: AcpRuntimeEvent }
    | {
        type: 'permission.requested'
        data: Extract<ApplicationEvent, { channel: 'acp:permission-request' }>['payload']
      }
    | { type: 'run.progress'; data: TaskRunProgressEvent }
  )

type ResolveActiveTaskRun = (
  sessionId: string,
  promptMessageId?: string
) => TaskRunIdentity | undefined

const projectWebRendererEvent = (event: ApplicationEvent): WebRendererEvent | undefined =>
  isWebRpcEventChannel(event.channel)
    ? {
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        channel: event.channel,
        payload: event.payload ?? null
      }
    : undefined

const projectPublicTaskEvents = (
  event: ApplicationEvent,
  resolveActiveRun: ResolveActiveTaskRun = () => undefined
): PublicTaskEvent[] => {
  if (event.channel === 'acp:event') {
    return event.payload.flatMap((item) => {
      const run = item.sessionId
        ? resolveActiveRun(item.sessionId, item.promptMessageId)
        : undefined
      return run ? [{ ...run, type: 'run.event' as const, data: item }] : []
    })
  }
  if (event.channel === 'acp:permission-request') {
    const run = resolveActiveRun(event.payload.sessionId)
    return run ? [{ ...run, type: 'permission.requested', data: event.payload }] : []
  }
  return []
}

const projectPublicTaskEvent = (
  event: ApplicationEvent,
  resolveActiveRun?: ResolveActiveTaskRun
): PublicTaskEvent | undefined => projectPublicTaskEvents(event, resolveActiveRun)[0]

const projectPublicTaskProgressEvent = (event: TaskRunProgressEvent): PublicTaskEvent => ({
  runId: event.runId,
  sessionId: event.sessionId,
  projectId: event.projectId,
  type: 'run.progress',
  data: event
})

const projectTaskRuntimeEvents = (event: ApplicationEvent): readonly AcpRuntimeEvent[] =>
  event.channel === 'acp:event' ? event.payload : []

const projectTaskRuntimeEvent = (event: ApplicationEvent): AcpRuntimeEvent | undefined =>
  projectTaskRuntimeEvents(event)[0]

export {
  projectPublicTaskEvent,
  projectPublicTaskEvents,
  projectPublicTaskProgressEvent,
  projectTaskRuntimeEvent,
  projectTaskRuntimeEvents,
  projectWebRendererEvent
}
export type { PublicTaskEvent, ResolveActiveTaskRun, WebRendererEvent }

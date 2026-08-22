import type { AcpRuntimeEvent } from '../../shared/acp'
import { WEB_RPC_PROTOCOL_VERSION, isWebRpcEventChannel } from '../../shared/web-rpc-contract'
import type { TaskRunProgressEvent } from '../../shared/task-api'
import type { ApplicationEvent } from '../application-events'

type WebRendererEvent = {
  protocolVersion: typeof WEB_RPC_PROTOCOL_VERSION
  channel: string
  payload: unknown
}

type PublicTaskEvent =
  | { type: 'run.event'; data: AcpRuntimeEvent }
  | {
      type: 'permission.requested'
      data: Extract<ApplicationEvent, { channel: 'acp:permission-request' }>['payload']
    }
  | { type: 'run.progress'; data: TaskRunProgressEvent }

const projectWebRendererEvent = (event: ApplicationEvent): WebRendererEvent | undefined =>
  isWebRpcEventChannel(event.channel)
    ? {
        protocolVersion: WEB_RPC_PROTOCOL_VERSION,
        channel: event.channel,
        payload: event.payload ?? null
      }
    : undefined

const projectPublicTaskEvents = (event: ApplicationEvent): PublicTaskEvent[] => {
  if (event.channel === 'acp:event') {
    return event.payload.map((item) => ({ type: 'run.event' as const, data: item }))
  }
  if (event.channel === 'acp:permission-request') {
    return [{ type: 'permission.requested', data: event.payload }]
  }
  return []
}

const projectPublicTaskEvent = (event: ApplicationEvent): PublicTaskEvent | undefined =>
  projectPublicTaskEvents(event)[0]

const projectPublicTaskProgressEvent = (event: TaskRunProgressEvent): PublicTaskEvent => ({
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
export type { PublicTaskEvent, WebRendererEvent }

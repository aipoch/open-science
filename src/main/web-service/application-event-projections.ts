import { WEB_RPC_PROTOCOL_VERSION, isWebRpcEventChannel } from '../../shared/web-rpc-contract'
import type { TaskRunProgressEvent } from '../../shared/task-api'
import type { ApplicationEvent } from '../application-events'

type WebRendererEvent = {
  protocolVersion: typeof WEB_RPC_PROTOCOL_VERSION
  channel: string
  payload: unknown
}

type PublicTaskEvent =
  | { type: 'run.event'; data: Extract<ApplicationEvent, { channel: 'acp:event' }>['payload'] }
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

const projectPublicTaskEvent = (event: ApplicationEvent): PublicTaskEvent | undefined => {
  if (event.channel === 'acp:event') return { type: 'run.event', data: event.payload }
  if (event.channel === 'acp:permission-request') {
    return { type: 'permission.requested', data: event.payload }
  }
  return undefined
}

const projectPublicTaskProgressEvent = (event: TaskRunProgressEvent): PublicTaskEvent => ({
  type: 'run.progress',
  data: event
})

const projectTaskRuntimeEvent = (
  event: ApplicationEvent
): Extract<ApplicationEvent, { channel: 'acp:event' }>['payload'] | undefined =>
  event.channel === 'acp:event' ? event.payload : undefined

export {
  projectPublicTaskEvent,
  projectPublicTaskProgressEvent,
  projectTaskRuntimeEvent,
  projectWebRendererEvent
}
export type { PublicTaskEvent, WebRendererEvent }

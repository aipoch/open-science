import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  isAppOwnedNotebookCodeReview,
  isAppOwnedNotebookRuntimeReview
} from '../../shared/acp-permission-contract'
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
        data:
          | Extract<ApplicationEvent, { channel: 'acp:permission-request' }>['payload']
          | {
              sessionId: string
              title: string
              reasonCode: 'notebook_code_review_required' | 'notebook_runtime_review_required'
            }
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

const isNotebookCodeReviewCard = (value: unknown): boolean =>
  isAppOwnedNotebookCodeReview(value) ||
  (value !== null &&
    typeof value === 'object' &&
    'appOwned' in value &&
    value.appOwned === true &&
    'notebookCodeReview' in value &&
    value.notebookCodeReview === true)

const isNotebookRuntimeReviewCard = (value: unknown): boolean =>
  isAppOwnedNotebookRuntimeReview(value) ||
  (value !== null &&
    typeof value === 'object' &&
    'appOwned' in value &&
    value.appOwned === true &&
    'notebookRuntimeReview' in value &&
    value.notebookRuntimeReview === true)

const projectPublicTaskEvents = (
  event: ApplicationEvent,
  resolveActiveRun: ResolveActiveTaskRun = () => undefined
): PublicTaskEvent[] => {
  if (event.channel === 'acp:event') {
    return event.payload.flatMap((item) => {
      if (
        isAppOwnedNotebookCodeReview(item) ||
        isAppOwnedNotebookRuntimeReview(item) ||
        (item.kind === 'permission' &&
          (isNotebookCodeReviewCard(item.raw) || isNotebookRuntimeReviewCard(item.raw)))
      ) {
        return []
      }
      const run = item.sessionId
        ? resolveActiveRun(item.sessionId, item.promptMessageId)
        : undefined
      return run ? [{ ...run, type: 'run.event' as const, data: item }] : []
    })
  }
  if (event.channel === 'acp:permission-request') {
    const { sessionId } = event.payload
    if (isAppOwnedNotebookRuntimeReview(event.payload)) {
      const { projectId, promptMessageId } = event.payload.rawInput.notebookRuntimeSelection
      if (typeof promptMessageId !== 'string' || !promptMessageId) return []
      const run = resolveActiveRun(sessionId, promptMessageId)
      return run && run.projectId === projectId
        ? [
            {
              ...run,
              type: 'permission.requested',
              data: {
                sessionId,
                title: 'Notebook runtime review is pending in this Session.',
                reasonCode: 'notebook_runtime_review_required'
              }
            }
          ]
        : []
    }
    if (isNotebookRuntimeReviewCard(event.payload)) return []
    const run = resolveActiveRun(sessionId)
    if (!run) return []
    const data = isNotebookCodeReviewCard(event.payload)
      ? {
          sessionId,
          title: 'Notebook code review is pending in this Session.',
          reasonCode: 'notebook_code_review_required' as const
        }
      : event.payload
    return [{ ...run, type: 'permission.requested', data }]
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

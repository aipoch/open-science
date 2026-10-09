import { z } from 'zod'
import {
  browserRecordingTargetSchema,
  recordedBrowserPayloadSchema,
  browserRecordingMomentSchema,
  browserRecordingControlRequestSchema,
  browserRecordingStatusSchema,
  browserRecordingInspectionSchema
} from '../../shared/browser-recording'
import type { CallerContext } from '../caller-context'
import { ManagedExecutionExternalError } from '../managed-execution-external-port'
import type { ReplayViewerHttpHost } from '../replay-viewer/http-host'
import type { ObservationViewers } from '../run-observation/viewers'
import type { RecordedObservationReader } from '../run-observation/recorded-reader'

export const BROWSER_RECORDING_EXTERNAL_METHODS = [
  'inspect',
  'start',
  'status',
  'pause',
  'resume',
  'stop',
  'read',
  'openRecorded',
  'selectMoment',
  'selection'
] as const
export type BrowserRecordingExternalMethod = (typeof BROWSER_RECORDING_EXTERNAL_METHODS)[number]
export type BrowserRecordingExternalPort = {
  call(
    method: BrowserRecordingExternalMethod,
    payload: unknown,
    caller?: CallerContext
  ): Promise<unknown>
}
const viewer = z.object({ viewerId: z.string().uuid() }).strict()
const target = z.object({ target: browserRecordingTargetSchema }).strict()
export function createBrowserRecordingExternalPort(dependencies: {
  assertOpen(): void
  host: Pick<ReplayViewerHttpHost, 'browserRecording' | 'openRecorded' | 'closeViewer'>
  viewers: Pick<ObservationViewers, 'selectBrowserMoment' | 'browserMomentSelection' | 'revoke'>
  reader: Pick<RecordedObservationReader, 'readBrowser'>
}): BrowserRecordingExternalPort {
  return {
    async call(method, payload, caller) {
      const authorize = (): void => {
        dependencies.assertOpen()
        if (!caller?.isAuthorizationCurrent())
          throw new ManagedExecutionExternalError(
            'unauthorized',
            'Current local authorization is required.'
          )
        if (caller.location !== 'local')
          throw new ManagedExecutionExternalError(
            'unsupported_location',
            'Project recording is local to this device.'
          )
      }
      authorize()
      let opened: Awaited<ReturnType<ReplayViewerHttpHost['openRecorded']>> | undefined
      try {
        let result: unknown
        switch (method) {
          case 'read':
            result = recordedBrowserPayloadSchema.parse(
              await dependencies.reader.readBrowser(target.parse(payload).target)
            )
            break
          case 'openRecorded':
            opened = await dependencies.host.openRecorded(target.parse(payload).target, caller!, {
              format: 'web-recording',
              ...(caller!.surface === 'electron' ? { desktopParent: 'file:' as const } : {})
            })
            result = opened
            break
          case 'selectMoment': {
            const request = viewer
              .extend({ offsetMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
              .strict()
              .parse(payload)
            result = browserRecordingMomentSchema.parse(
              await dependencies.viewers.selectBrowserMoment(request.viewerId, request.offsetMs, {
                caller: caller!
              })
            )
            break
          }
          case 'selection':
            result = browserRecordingMomentSchema.nullable().parse(
              await dependencies.viewers.browserMomentSelection(viewer.parse(payload).viewerId, {
                caller: caller!
              })
            )
            break
          case 'inspect':
            result = browserRecordingInspectionSchema.parse(
              await dependencies.host.browserRecording(
                method,
                viewer.parse(payload).viewerId,
                {},
                caller!
              )
            )
            break
          case 'status':
            result = browserRecordingStatusSchema.parse(
              await dependencies.host.browserRecording(
                method,
                viewer.parse(payload).viewerId,
                {},
                caller!
              )
            )
            break
          case 'start':
          case 'pause':
          case 'resume':
          case 'stop': {
            const request = viewer
              .extend({ request: browserRecordingControlRequestSchema })
              .strict()
              .parse(payload)
            if (method !== 'start' && !request.request.recordingId)
              throw new ManagedExecutionExternalError(
                'invalid_request',
                'Recording control requires a recording identity.'
              )
            result = browserRecordingStatusSchema.parse(
              await dependencies.host.browserRecording(
                method,
                request.viewerId,
                request.request,
                caller!
              )
            )
            break
          }
          default:
            throw new ManagedExecutionExternalError(
              'invalid_request',
              'Unknown project recording method.'
            )
        }
        authorize()
        return result
      } catch (error) {
        if (opened) {
          dependencies.host.closeViewer(opened.viewerId)
          await dependencies.viewers
            .revoke(opened.viewerId, { caller: caller! })
            .catch(() => undefined)
        }
        if (error instanceof ManagedExecutionExternalError) throw error
        throw new ManagedExecutionExternalError(
          error instanceof z.ZodError ? 'invalid_request' : 'unavailable',
          error instanceof z.ZodError
            ? 'Project recording request fields are invalid.'
            : 'The requested project recording is unavailable.'
        )
      }
    }
  }
}

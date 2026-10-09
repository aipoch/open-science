import { z } from 'zod'
import {
  runObservationCursorSchema,
  runObservationTargetSchema,
  type RunObservationTarget
} from '../shared/run-observation'
import {
  recordedObservationTargetSchema,
  recordedEvidenceFormatSchema,
  type RecordedEvidenceFormat,
  recordedObservationPayloadSchema,
  recordedProjectPayloadSchema,
  recordedFileRequestSchema,
  recordedFileSelectionSchema,
  type RecordedFileRequest,
  type RecordedObservationTarget
} from '../shared/run-observation-recorded'
import type { CallerContext } from './caller-context'
import { ManagedExecutionExternalError } from './managed-execution-external-port'
import type { ObservationViewers } from './run-observation/viewers'
import type { RunObservationRecordingStatus } from '../shared/run-observation-recording-status'
import {
  MAX_OBSERVATION_CAPTURE_CHUNK_BYTES,
  observationCapturesRequestSchema,
  observationCapturesSchema,
  observationCaptureContentSchema,
  observationViewerCaptureContentRequestSchema,
  observationMediaCaptureRequestSchema,
  observationViewerCaptureSchema,
  type ObservationCaptureContent,
  type ObservationCaptureContentRequest,
  type ObservationViewerCapture
} from '../shared/run-observation-capture'

export const RUN_OBSERVATION_EXTERNAL_METHODS = [
  'open',
  'openRecorded',
  'readRecorded',
  'readProjectRecording',
  'selectRecordedFile',
  'selectRecordingFile',
  'recordingFileSelection',
  'recording',
  'selectRecording',
  'recordingSelection',
  'recordingStatus',
  'captureOptions',
  'capture',
  'captures',
  'captureContent',
  'snapshot',
  'history',
  'changes',
  'select',
  'selection',
  'revoke'
] as const
export type RunObservationExternalMethod = (typeof RUN_OBSERVATION_EXTERNAL_METHODS)[number]
export type RunObservationExternalPort = {
  call(
    method: RunObservationExternalMethod,
    payload: unknown,
    caller?: CallerContext
  ): Promise<unknown>
}
const viewerReference = z.object({ viewerId: z.string().uuid() }).strict()
const openRequest = z
  .object({
    target: runObservationTargetSchema,
    allowInteraction: z.boolean().default(false),
    allowCancel: z.boolean().default(false),
    allowCapture: z.boolean().default(false),
    allowRecording: z.boolean().default(false)
  })
  .strict()

export function createRunObservationExternalPort(dependencies: {
  viewers: ObservationViewers
  assertOpen(): void
  captureOptions?(viewerId: string, caller: CallerContext): Promise<unknown>
  capture?(
    viewerId: string,
    request: unknown,
    caller: CallerContext
  ): Promise<ObservationViewerCapture>
  captures?(viewerId: string, caller: CallerContext): Promise<ObservationViewerCapture[]>
  captureContent?(
    viewerId: string,
    request: ObservationCaptureContentRequest,
    caller: CallerContext
  ): Promise<ObservationCaptureContent>
  recordingStatus?(
    target: RunObservationTarget,
    caller: CallerContext
  ): Promise<RunObservationRecordingStatus>
  openRecordedViewer?(
    target: RecordedObservationTarget,
    caller: CallerContext,
    format?: RecordedEvidenceFormat
  ): Promise<unknown>
  readRecorded?(target: RecordedObservationTarget, caller: CallerContext): Promise<unknown>
  readProjectRecording?(target: RecordedObservationTarget, caller: CallerContext): Promise<unknown>
  selectRecordedFile?(request: RecordedFileRequest, caller: CallerContext): Promise<unknown>
  openViewer(
    target: RunObservationTarget,
    caller: CallerContext,
    permissions: {
      allowInteraction: boolean
      allowCancel: boolean
      allowCapture: boolean
      allowRecording?: boolean
    }
  ): Promise<unknown>
}): RunObservationExternalPort {
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
            'Run observation is local to this device.'
          )
      }
      authorize()
      try {
        let result: unknown
        const auth = { caller: caller! }
        switch (method) {
          case 'readRecorded':
          case 'readProjectRecording': {
            const { target } = z
              .object({ target: recordedObservationTargetSchema })
              .strict()
              .parse(payload)
            const reader =
              method === 'readRecorded'
                ? dependencies.readRecorded
                : dependencies.readProjectRecording
            if (!reader) throw new Error('Recorded content is unavailable.')
            const value = await reader(target, caller!)
            const parsed = (
              method === 'readRecorded'
                ? recordedObservationPayloadSchema
                : recordedProjectPayloadSchema
            ).safeParse(value)
            if (
              !parsed.success ||
              Object.entries(target).some(
                ([key, value]) =>
                  parsed.data.receiving[key as keyof RecordedObservationTarget] !== value
              )
            )
              throw new Error('Recorded content does not match the requested scope.')
            result = parsed.data
            break
          }
          case 'selectRecordedFile': {
            const request = recordedFileRequestSchema.parse(payload)
            if (!dependencies.selectRecordedFile) throw new Error('Recorded files are unavailable.')
            const selected = await dependencies.selectRecordedFile(request, caller!)
            const parsed = recordedFileSelectionSchema.safeParse(selected)
            if (
              !parsed.success ||
              parsed.data.mediaKey !== request.mediaKey ||
              parsed.data.source !== request.format ||
              Object.entries(request.target).some(
                ([key, value]) =>
                  parsed.data.receiving[key as keyof RecordedObservationTarget] !== value
              )
            )
              throw new Error('Recorded file does not match the requested scope.')
            result = parsed.data
            break
          }
          case 'captures': {
            const { viewerId } = observationCapturesRequestSchema.parse(payload)
            if (!dependencies.captures) throw new Error('Captured images are unavailable.')
            const frames = await dependencies.captures(viewerId, caller!)
            authorize()
            const parsed = observationCapturesSchema.safeParse(frames)
            if (!parsed.success) throw new Error('Captured image metadata is unavailable.')
            result = parsed.data
            break
          }
          case 'captureContent': {
            const { viewerId, ...request } =
              observationViewerCaptureContentRequestSchema.parse(payload)
            if (!dependencies.captureContent)
              throw new Error('Captured image content is unavailable.')
            const content = await dependencies.captureContent(viewerId, request, caller!)
            authorize()
            const parsed = observationCaptureContentSchema.safeParse(content)
            if (!parsed.success) throw new Error('Captured image content is unavailable.')
            const value = parsed.data
            const byteLength = Buffer.byteLength(value.dataBase64, 'base64')
            if (
              value.captureId !== request.captureId ||
              value.offset !== (request.offset ?? 0) ||
              byteLength > (request.length ?? MAX_OBSERVATION_CAPTURE_CHUNK_BYTES)
            )
              throw new Error('Captured image content does not match the requested chunk.')
            result = value
            break
          }
          case 'captureOptions': {
            const { viewerId } = viewerReference.parse(payload)
            if (!dependencies.captureOptions) throw new Error('Capture is unavailable.')
            result = await dependencies.captureOptions(viewerId, caller!)
            break
          }
          case 'capture': {
            const request = z
              .object({
                viewerId: z.string().uuid(),
                request: observationMediaCaptureRequestSchema
              })
              .strict()
              .parse(payload)
            if (!dependencies.capture) throw new Error('Capture is unavailable.')
            const captured = await dependencies.capture(request.viewerId, request.request, caller!)
            authorize()
            const parsed = observationViewerCaptureSchema.safeParse(captured)
            if (!parsed.success) throw new Error('Captured image metadata is unavailable.')
            result = parsed.data
            break
          }
          case 'recordingStatus': {
            const { target } = z
              .object({ target: runObservationTargetSchema })
              .strict()
              .parse(payload)
            if (!dependencies.recordingStatus) throw new Error('Recording status is unavailable.')
            result = await dependencies.recordingStatus(target, caller!)
            break
          }
          case 'open': {
            const request = openRequest.parse(payload)
            result = await dependencies.openViewer(request.target, caller!, request)
            break
          }
          case 'openRecorded': {
            const { target, format } = z
              .object({
                target: recordedObservationTargetSchema,
                format: recordedEvidenceFormatSchema.optional()
              })
              .strict()
              .parse(payload)
            if (!dependencies.openRecordedViewer)
              throw new Error('Recorded viewers are unavailable.')
            result = await (format === undefined
              ? dependencies.openRecordedViewer(target, caller!)
              : dependencies.openRecordedViewer(target, caller!, format))
            break
          }
          case 'recording':
            result = await dependencies.viewers.recording(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'recordingSelection':
            result = await dependencies.viewers.recordingSelection(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'recordingFileSelection':
            result = await dependencies.viewers.recordingFileSelection(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'selectRecordingFile': {
            const request = viewerReference
              .extend({ mediaKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) })
              .parse(payload)
            result = await dependencies.viewers.selectRecordingFile(
              request.viewerId,
              request.mediaKey,
              auth
            )
            break
          }
          case 'selectRecording': {
            const request = viewerReference
              .extend({ stepKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) })
              .parse(payload)
            result = await dependencies.viewers.selectRecording(
              request.viewerId,
              request.stepKey,
              auth
            )
            break
          }
          case 'snapshot':
            result = await dependencies.viewers.snapshot(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'history':
            result = await dependencies.viewers.history(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'selection':
            result = await dependencies.viewers.selection(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'revoke':
            result = await dependencies.viewers.revoke(
              viewerReference.parse(payload).viewerId,
              auth
            )
            break
          case 'changes': {
            const request = viewerReference
              .extend({ cursor: runObservationCursorSchema })
              .parse(payload)
            result = await dependencies.viewers.changes(request.viewerId, request.cursor, auth)
            break
          }
          case 'select': {
            const request = viewerReference
              .extend({ cursor: runObservationCursorSchema, stepId: z.string().min(1).max(256) })
              .parse(payload)
            result = await dependencies.viewers.select(request.viewerId, request, auth)
            break
          }
          default:
            throw new ManagedExecutionExternalError(
              'invalid_request',
              'Unknown observation method.'
            )
        }
        authorize()
        return result ?? null
      } catch (error) {
        if (error instanceof ManagedExecutionExternalError) throw error
        if (error instanceof z.ZodError)
          throw new ManagedExecutionExternalError(
            'invalid_request',
            'The observation request does not match the documented fields.'
          )
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code === 'unauthorized' || code === 'unsupported-location')
          throw new ManagedExecutionExternalError(
            'unauthorized',
            'This viewer authorization is no longer available.'
          )
        throw new ManagedExecutionExternalError(
          'unavailable',
          'The requested observation is unavailable. Reopen its viewer.'
        )
      }
    }
  }
}

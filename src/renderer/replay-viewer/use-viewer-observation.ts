import { useEffect, useState } from 'react'
import { normalizeObservationHistory } from '../src/lib/replay/live-source'
import type { RecordedEvidencePayload } from '../../shared/run-observation-recorded'
import type { RunObservationHistory } from '../../shared/run-observation'
import {
  appendViewerChanges,
  ReplayViewerClient,
  ReplayViewerRequestError,
  type ReplayViewerContext
} from './client'

export type ViewerObservationState = {
  context?: ReplayViewerContext
  history?: RunObservationHistory
  recording?: RecordedEvidencePayload
  connection: 'connected' | 'reconnecting' | 'disconnected'
  error?: 'authorization' | 'unavailable'
}
const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
/** One serial pull loop per mount. Disconnects never resubmit execution or open project services. */
export function useViewerObservation(
  client: ReplayViewerClient,
  retry: number
): ViewerObservationState {
  const [state, setState] = useState<ViewerObservationState>({ connection: 'reconnecting' })
  useEffect(() => {
    const controller = new AbortController(),
      signal = controller.signal
    let context: ReplayViewerContext | undefined, history: RunObservationHistory | undefined
    const run = async (): Promise<void> => {
      let failures = 0
      while (!signal.aborted) {
        try {
          if (!context) {
            context = await client.context(signal)
            if (!signal.aborted) setState({ context, connection: 'reconnecting' })
          }
          if (context.mode === 'research') {
            if (!signal.aborted) setState({ context, connection: 'connected' })
            return
          }
          if (context.mode === 'recorded') {
            const recording = await client.recording(signal)
            const target = context.target
            if (
              (context.format === 'web-recording') !== 'indexChecksum' in recording ||
              (context.format === 'project-recording') !==
                ('recording' in recording && !('indexChecksum' in recording)) ||
              (['projectId', 'sessionId', 'artifactId', 'versionId'] as const).some(
                (key) => recording.receiving[key] !== target[key]
              )
            )
              throw new ReplayViewerRequestError('invalid-response')
            if (!signal.aborted) setState({ context, recording, connection: 'connected' })
            return
          }
          if (!history) {
            history = await client.history(signal)
          } else {
            const update = await client.changes(history.snapshots.at(-1)!, signal)
            if (update.kind === 'resync') {
              // Epoch changes replace the buffer; old observations are never passed off as new.
              const recovered = await client.history(signal)
              normalizeObservationHistory(recovered.snapshots.at(-1)!, recovered.snapshots)
              history = recovered
            } else history = appendViewerChanges(history, update)
          }
          const latest = history.snapshots.at(-1)!
          normalizeObservationHistory(latest, history.snapshots)
          const target = context.target
          if (
            target.projectId !== latest.identity.projectId ||
            target.sessionId !== latest.identity.sessionId ||
            (['operationId', 'executionInvocationId', 'runId'] as const).some(
              (key) => target[key] && target[key] !== latest.identity[key]
            )
          )
            throw new ReplayViewerRequestError('invalid-response')
          if (signal.aborted) return
          failures = 0
          setState({ context, history, connection: 'connected' })
          await delay(750, signal)
        } catch (error) {
          if (signal.aborted) return
          const authorization =
            error instanceof ReplayViewerRequestError && error.kind === 'authorization'
          if (authorization) {
            setState({ connection: 'disconnected', error: 'authorization' })
            return
          }
          failures++
          setState((previous) => ({
            ...previous,
            connection: failures < 3 ? 'reconnecting' : 'disconnected',
            error: 'unavailable'
          }))
          // Keep the last cursor for transient failures. A malformed/expired history must be
          // replaced from the same bound viewer before observation resumes.
          if (!(error instanceof ReplayViewerRequestError) || error.kind === 'invalid-response')
            history = undefined
          await delay(Math.min(8000, 1000 * 2 ** (failures - 1)), signal)
        }
      }
    }
    void run()
    return () => controller.abort()
  }, [client, retry])
  return state
}

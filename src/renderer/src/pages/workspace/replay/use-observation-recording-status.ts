import { useEffect, useState } from 'react'
import type { RunObservationTarget } from '../../../../../shared/run-observation'
import type { RunObservationRecordingStatus } from '../../../../../shared/run-observation-recording-status'

export const useObservationRecordingStatus = ({
  target,
  read,
  active,
  running,
  retry = 0
}: {
  target?: RunObservationTarget
  read?: () => Promise<RunObservationRecordingStatus>
  active: boolean
  running: boolean
  retry?: number
}): { status?: RunObservationRecordingStatus; failed: boolean } => {
  const key =
    target &&
    JSON.stringify([
      target.projectId,
      target.sessionId,
      target.operationId,
      target.executionInvocationId,
      target.runId
    ])
  const [result, setResult] = useState<{
    key: string
    status?: RunObservationRecordingStatus
    failed: boolean
  }>()
  useEffect(() => {
    if (!active || !target || !key || !read) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const status = await read()
        if (disposed) return
        if (
          (
            ['projectId', 'sessionId', 'operationId', 'executionInvocationId', 'runId'] as const
          ).some((field) => status.target[field] !== target[field]) ||
          (status.archive &&
            (status.archive.projectId !== target.projectId ||
              status.archive.sessionId !== target.sessionId))
        )
          throw new Error('Recording status belongs to a different execution.')
        setResult({ key, status, failed: false })
        if (
          status.state === 'saved' ||
          status.state === 'failed' ||
          (status.state === 'not-recorded' && !running)
        )
          return
      } catch {
        if (disposed) return
        // Do not keep a stale saved-Version action after its authority could no longer be checked.
        setResult({ key, failed: true })
      }
      if (!disposed)
        timer = setTimeout(() => {
          void poll()
        }, 3000)
    }
    void poll()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
    // The primitive key captures every target field; equivalent host objects do not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read, active, running, retry])
  return result && result.key === key ? result : { failed: false }
}

import { useCallback, useRef, useState } from 'react'

type StopSubmissionState = Readonly<{
  pending: boolean
  error?: string
}>

export type ConversationSubmissions = Readonly<{
  stopBySessionId: ReadonlyMap<string, StopSubmissionState>
  resumePendingSessionIds: ReadonlySet<string>
  submitStop: (sessionId: string | undefined, action: () => void | Promise<void>) => void
  submitResume: (sessionId: string | undefined, action: () => Promise<void>) => Promise<void>
}>

// Pending actions belong to the workspace, which survives the keyed conversation panel.
export const useConversationSubmissions = (): ConversationSubmissions => {
  const stopPendingIds = useRef(new Set<string>())
  const resumePendingIds = useRef(new Set<string>())
  const [stopBySessionId, setStopBySessionId] = useState(
    () => new Map<string, StopSubmissionState>()
  )
  const [resumePendingSessionIds, setResumePendingSessionIds] = useState(() => new Set<string>())

  const settleStop = useCallback((sessionId: string, error?: string): void => {
    stopPendingIds.current.delete(sessionId)
    setStopBySessionId((current) => {
      const next = new Map(current)
      if (error !== undefined) next.set(sessionId, { pending: false, error })
      else next.delete(sessionId)
      return next
    })
  }, [])

  const submitStop = useCallback(
    (sessionId: string | undefined, action: () => void | Promise<void>): void => {
      if (!sessionId || stopPendingIds.current.has(sessionId)) return
      stopPendingIds.current.add(sessionId)
      setStopBySessionId((current) => new Map(current).set(sessionId, { pending: true }))
      let outcome: void | Promise<void>
      try {
        outcome = action()
      } catch (error) {
        settleStop(sessionId, error instanceof Error ? error.message : String(error))
        return
      }
      if (!outcome || typeof (outcome as Promise<void>).then !== 'function') {
        settleStop(sessionId)
        return
      }
      void outcome.then(
        () => settleStop(sessionId),
        (error: unknown) =>
          settleStop(sessionId, error instanceof Error ? error.message : String(error))
      )
    },
    [settleStop]
  )

  const submitResume = useCallback(
    async (sessionId: string | undefined, action: () => Promise<void>): Promise<void> => {
      if (!sessionId || resumePendingIds.current.has(sessionId)) return
      resumePendingIds.current.add(sessionId)
      setResumePendingSessionIds((current) => new Set(current).add(sessionId))
      try {
        await action()
      } finally {
        resumePendingIds.current.delete(sessionId)
        setResumePendingSessionIds((current) => {
          const next = new Set(current)
          next.delete(sessionId)
          return next
        })
      }
    },
    []
  )

  return { stopBySessionId, resumePendingSessionIds, submitStop, submitResume }
}

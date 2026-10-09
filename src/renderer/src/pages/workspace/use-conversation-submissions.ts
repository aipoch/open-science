import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { projectActiveRootDelegatedFrames } from '../../../../shared/delegated-work-projection'

type StopSubmissionState = Readonly<{
  pending: boolean
  error?: string
}>

type StopOperation = {
  sessionId: string
  pending: boolean
  run?: ChatSession['activeRun']
  rootWork: boolean
  children: readonly { frameId: string; branchId: string; attemptId?: string }[]
  capturedWork: boolean
}

const rootIsBusy = (session: ChatSession | undefined): boolean =>
  Boolean(
    session &&
    (session.activeRun ||
      session.agentPromptInFlight ||
      session.status === 'running' ||
      session.fixLoopActive ||
      session.compacting)
  )

const runningChildren = (session: ChatSession | undefined): StopOperation['children'] =>
  projectActiveRootDelegatedFrames(session).flatMap((frame) => {
    const record = session?.runtimeContext?.delegatedWork?.records.find(
      ({ agentFrameId }) => agentFrameId === frame.id
    )
    const attempt = record?.attempts.at(-1)
    const running = record ? attempt?.status === 'running' : frame.status === 'running'
    const awaitingUser = session?.runtimeContext?.delegatedWork?.questionRequests?.some(
      (question) => question.sourceFrameId === frame.id && question.status === 'pending'
    )
    if (!running && !awaitingUser) return []
    return [
      {
        frameId: frame.id,
        branchId: frame.activeBranchId,
        attemptId: attempt?.id
      }
    ]
  })

export type ConversationSubmissions = Readonly<{
  stopBySessionId: ReadonlyMap<string, StopSubmissionState>
  resumePendingSessionIds: ReadonlySet<string>
  submitStop: (sessionId: string | undefined, action: () => void | Promise<void>) => void
  submitResume: (sessionId: string | undefined, action: () => Promise<void>) => Promise<void>
}>

// Pending actions belong to the workspace, which survives the keyed conversation panel.
export const useConversationSubmissions = (): ConversationSubmissions => {
  const stopOperations = useRef(new Map<string, StopOperation>())
  const stopSubscription = useRef<(() => void) | undefined>(undefined)
  const resumePendingIds = useRef(new Set<string>())
  const [stopBySessionId, setStopBySessionId] = useState(
    () => new Map<string, StopSubmissionState>()
  )
  const [resumePendingSessionIds, setResumePendingSessionIds] = useState(() => new Set<string>())

  const settleStop = useCallback((operation: StopOperation, error?: string): void => {
    const { sessionId } = operation
    if (stopOperations.current.get(sessionId) !== operation) return
    if (error !== undefined && operation.capturedWork) operation.pending = false
    else stopOperations.current.delete(sessionId)
    if (stopOperations.current.size === 0) {
      stopSubscription.current?.()
      stopSubscription.current = undefined
    }
    setStopBySessionId((current) => {
      const next = new Map(current)
      if (error !== undefined) next.set(sessionId, { pending: false, error })
      else next.delete(sessionId)
      return next
    })
  }, [])

  const reconcileStops = useCallback((): void => {
    const { sessions } = useSessionStore.getState()
    for (const operation of stopOperations.current.values()) {
      if (!operation.capturedWork) continue
      const session = sessions.find(({ id }) => id === operation.sessionId)
      const rootBusy = rootIsBusy(session)
      const newRun =
        (!operation.rootWork && rootBusy) ||
        (operation.run &&
          session?.activeRun &&
          (operation.run.promptMessageId !== session.activeRun.promptMessageId ||
            operation.run.startedAt !== session.activeRun.startedAt))
      const children = runningChildren(session)
      const childStillRunning = operation.children.some((captured) =>
        children.some(
          (child) =>
            child.frameId === captured.frameId &&
            child.branchId === captured.branchId &&
            child.attemptId === captured.attemptId
        )
      )
      if (newRun || (!rootBusy && !childStillRunning)) settleStop(operation)
    }
  }, [settleStop])

  const observeStops = useCallback((): void => {
    if (!stopSubscription.current && stopOperations.current.size > 0) {
      // Observe only while Stop owns work. Streaming updates never enter React state unless
      // that captured work settles, so the workspace does not render for every token.
      stopSubscription.current = useSessionStore.subscribe(reconcileStops)
    }
  }, [reconcileStops])

  useEffect(() => {
    observeStops()
    return () => {
      stopSubscription.current?.()
      stopSubscription.current = undefined
    }
  }, [observeStops])

  const submitStop = useCallback(
    (sessionId: string | undefined, action: () => void | Promise<void>): void => {
      if (!sessionId || stopOperations.current.get(sessionId)?.pending) return
      const session = useSessionStore.getState().sessions.find(({ id }) => id === sessionId)
      const children = runningChildren(session)
      const rootWork = rootIsBusy(session)
      const operation: StopOperation = {
        sessionId,
        pending: true,
        run: session?.activeRun,
        rootWork,
        children,
        capturedWork: rootWork || children.length > 0
      }
      stopOperations.current.set(sessionId, operation)
      setStopBySessionId((current) => new Map(current).set(sessionId, { pending: true }))
      observeStops()
      let outcome: void | Promise<void>
      try {
        outcome = action()
      } catch (error) {
        settleStop(operation, error instanceof Error ? error.message : String(error))
        return
      }
      if (!outcome || typeof (outcome as Promise<void>).then !== 'function') {
        if (!operation.capturedWork) settleStop(operation)
        else reconcileStops()
        return
      }
      void outcome.then(
        () => {
          // ACP cancellation acknowledgement is delivery evidence, not execution settlement.
          if (!operation.capturedWork) settleStop(operation)
          else reconcileStops()
        },
        (error: unknown) =>
          settleStop(operation, error instanceof Error ? error.message : String(error))
      )
    },
    [observeStops, reconcileStops, settleStop]
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

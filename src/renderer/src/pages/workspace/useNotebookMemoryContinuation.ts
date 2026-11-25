import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import { NotebookContinuationBranchError } from '@/lib/acp/workspace-runtime-command-owner'
import {
  dismissNotebookMemoryRejection,
  useNotebookMemoryNoticeStore
} from '@/stores/notebook-memory-notice-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import {
  NOTEBOOK_STATE_TARGET_RUN_LIMIT,
  type NotebookSessionReference
} from '../../../../shared/notebook'
import type { NotebookPendingDecision } from '../../../../shared/notebook-resources'
import type { ReplayRunIndex } from '../../../../shared/replay'

type Entrance = 'notice' | 'compute'
type Failure = 'pressured' | 'unavailable' | 'handoff' | NotebookContinuationBranchError
type Attempt =
  { status: 'checking' | 'handed-off' } | { status: 'failed'; entrance: Entrance; failure: Failure }

const useAttempts = create<Record<string, Attempt>>(() => ({}))

type FeedbackStatus = 'continuing' | 'started' | 'not-executed' | 'unconfirmed'
type Continuation = Pick<NotebookSessionReference, 'projectId' | 'sessionId' | 'workspaceCwd'> & {
  promptMessageId: string
  messageBranchId?: string
  status: FeedbackStatus
}

const useContinuations = create<Record<string, Continuation>>(() => ({}))
const continuationKey = (projectId: string, sessionId: string): string =>
  JSON.stringify([projectId, sessionId])
const activeBranchId = (session: ChatSession | undefined): string | undefined => {
  const graph = session?.conversationGraph
  return graph?.frames.find(({ id }) => id === graph.activeFrameId)?.activeBranchId
}

export const useNotebookMemoryContinuationStatus = (
  session: ChatSession | undefined
): FeedbackStatus | undefined => {
  const key = session && continuationKey(session.projectId, session.id)
  const continuation = useContinuations((state) => (key ? state[key] : undefined))
  const admissions =
    continuation &&
    session?.runtimeSessionAdmissions?.filter(
      (entry) =>
        entry.promptMessageId === continuation.promptMessageId &&
        (!continuation.messageBranchId || entry.messageBranchId === continuation.messageBranchId)
    )
  const admission = admissions ? admissions[0] : undefined
  const { executionId, rootFrameId, agentFrameId, messageBranchId, runtimeSegmentId } =
    admission ?? {}
  const superseded = Boolean(
    admissions && admissions.some((entry) => entry.executionId !== executionId)
  )
  const visible = (continuation?.messageBranchId ?? messageBranchId) === activeBranchId(session)
  const turnSettled = Boolean(
    continuation &&
    (session?.conversationGraph?.messages ?? session?.messages)?.find(
      ({ id }) => id === continuation.promptMessageId
    )?.turnOutcome
  )
  const notebook = continuation && window.api?.notebook
  useEffect(() => {
    if (!key || continuation?.status !== 'continuing' || !visible || !executionId || superseded)
      return
    if (!notebook?.runIndex || !notebook.state || !notebook.onChanged) return
    const { projectId, sessionId, workspaceCwd, promptMessageId } = continuation
    const reference = { projectId, sessionId, workspaceCwd }
    const matches = (row: ReplayRunIndex): boolean =>
      row.source === 'agent' &&
      row.promptMessageId === promptMessageId &&
      row.messageBranchId === messageBranchId &&
      row.rootFrameId === rootFrameId &&
      row.agentFrameId === agentFrameId &&
      row.runtimeSegmentId === runtimeSegmentId
    let current = true
    let loading = false
    let invalidated = false
    const readStatus = async (): Promise<FeedbackStatus | undefined> => {
      try {
        const rows = (await notebook.runIndex(reference)).filter(matches)
        let pending = false
        let unconfirmed = false
        for (
          let offset = 0;
          current && offset < rows.length;
          offset += NOTEBOOK_STATE_TARGET_RUN_LIMIT
        ) {
          const batch = rows.slice(offset, offset + NOTEBOOK_STATE_TARGET_RUN_LIMIT)
          const { runs } = await notebook.state({
            ...reference,
            runIds: batch.map(({ runId }) => runId),
            deferImages: true
          })
          const byId = new Map(runs.filter(matches).map((run) => [run.runId, run]))
          for (const row of batch) {
            const run = byId.get(row.runId)
            if (!run) {
              unconfirmed = true
              continue
            }
            if (
              run.status !== 'queued' &&
              (run.executionStarted === true ||
                (run.status === 'completed' &&
                  run.executionStarted === undefined &&
                  run.kernelDispatched !== false &&
                  run.kernelKind === 'bash' &&
                  run.exitCode === 0))
            )
              return 'started'
            if (run.status === 'queued' || run.status === 'running') pending = true
            else if (run.executionStarted !== false && run.kernelDispatched !== false)
              unconfirmed = true
          }
        }
        if (turnSettled && !pending) return unconfirmed ? 'unconfirmed' : 'not-executed'
      } catch (error) {
        console.warn('Notebook continuation evidence could not be read', error)
        if (turnSettled) return 'unconfirmed'
      }
      return undefined
    }
    const refresh = async (): Promise<void> => {
      invalidated = true
      if (loading) return
      loading = true
      while (current && invalidated) {
        invalidated = false
        const status = await readStatus()
        if (
          current &&
          status &&
          (status === 'started' || !invalidated) &&
          useContinuations.getState()[key] === continuation
        ) {
          useContinuations.setState({ [key]: { ...continuation, messageBranchId, status } })
          break
        }
      }
      loading = false
    }
    const unsubscribe = notebook.onChanged((event) => {
      if (
        event.projectId === projectId &&
        event.sessionId === sessionId &&
        !event.codeAppendOnly &&
        !event.codeWriteOnly
      )
        void refresh()
    })
    void refresh()
    return () => {
      current = false
      unsubscribe()
    }
  }, [
    key,
    continuation,
    visible,
    executionId,
    rootFrameId,
    agentFrameId,
    messageBranchId,
    runtimeSegmentId,
    turnSettled,
    superseded,
    notebook
  ])
  if (!visible || !continuation) return undefined
  if (
    superseded ||
    (continuation.status === 'continuing' &&
      turnSettled &&
      (!executionId || !notebook?.runIndex || !notebook.state || !notebook.onChanged))
  )
    return 'unconfirmed'
  return continuation.status
}

const keyFor = (decision: {
  projectId: string
  sessionId: string
  messageBranchId?: string
  refusalId?: string
}): string =>
  JSON.stringify([
    decision.projectId,
    decision.sessionId,
    decision.messageBranchId,
    decision.refusalId
  ])

const failureFor = (message: string): 'pressured' | 'unavailable' | 'handoff' =>
  message.includes('NOTEBOOK_MEMORY_PRESSURE:')
    ? 'pressured'
    : message.includes('NOTEBOOK_MEMORY_UNAVAILABLE:')
      ? 'unavailable'
      : 'handoff'

export const useNotebookMemoryContinuation = (
  decision: NotebookPendingDecision | undefined,
  entrance: Entrance,
  sendMessage: WorkspaceAgentRuntime['sendMessage'] | undefined
): {
  busy: boolean
  handedOff: boolean
  error?: string
  isChecking: () => boolean
  checkAndContinue: () => ReturnType<WorkspaceAgentRuntime['sendMessage']>
} => {
  const { t } = useTranslation()
  const key = decision && keyFor(decision)
  const attempt = useAttempts((state) => (key ? state[key] : undefined))
  const isChecking = (): boolean =>
    Boolean(key && useAttempts.getState()[key]?.status === 'checking')
  const checkAndContinue = async (): ReturnType<WorkspaceAgentRuntime['sendMessage']> => {
    if (
      !decision ||
      !key ||
      !sendMessage ||
      isChecking() ||
      useAttempts.getState()[key]?.status === 'handed-off'
    )
      return undefined
    useAttempts.setState({ [key]: { status: 'checking' } })
    let failure: Failure = 'handoff'
    try {
      const session = useSessionStore
        .getState()
        .sessions.find(
          ({ projectId, id }) => projectId === decision.projectId && id === decision.sessionId
        )
      const result = await sendMessage({
        projectId: decision.projectId,
        sessionId: decision.sessionId,
        cwd: session?.cwd,
        requireExistingSession: true,
        preserveSelection: true,
        notebookContinuation: {
          refusalId: decision.refusalId,
          messageBranchId: decision.messageBranchId,
          kind: 'memory'
        },
        onPreparationRejected: (message) => {
          failure = failureFor(message)
        },
        text: t(
          'Continue the blocked Notebook work. Keep completed results and ask before repeating completed steps.'
        )
      })
      if (result) {
        useAttempts.setState({ [key]: { status: 'handed-off' } })
        if (session && result.sessionId === session.id) {
          useContinuations.setState({
            [continuationKey(session.projectId, session.id)]: {
              projectId: session.projectId,
              sessionId: result.sessionId,
              workspaceCwd: session.cwd,
              promptMessageId: result.messageId,
              messageBranchId: decision.messageBranchId ?? activeBranchId(session),
              status: 'continuing'
            }
          })
        }
        const rejection = useNotebookMemoryNoticeStore.getState().rejection
        if (rejection && keyFor(rejection) === key) dismissNotebookMemoryRejection()
        return result
      }
    } catch (error) {
      failure =
        error instanceof NotebookContinuationBranchError
          ? error
          : failureFor(error instanceof Error ? error.message : String(error))
    }
    useAttempts.setState({ [key]: { status: 'failed', entrance, failure } })
    return undefined
  }
  const failure = attempt?.status === 'failed' && attempt.entrance === entrance && attempt.failure
  const error =
    failure === 'pressured'
      ? t('Memory is still too low. This Notebook did not run.')
      : failure === 'unavailable'
        ? t('Could not confirm memory status. This Notebook did not run.')
        : failure === 'handoff'
          ? t('Notebook continuation could not be started. The previous request remains stopped.')
          : failure instanceof NotebookContinuationBranchError
            ? failure.message
            : undefined
  return {
    busy: attempt?.status === 'checking',
    handedOff: attempt?.status === 'handed-off',
    error,
    isChecking,
    checkAndContinue
  }
}

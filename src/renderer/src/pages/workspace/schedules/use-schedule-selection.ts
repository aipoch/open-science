import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scheduleErrorText } from './schedule-reason'
import type { ScheduleSummary } from '../../../../../shared/session-schedules'
import {
  hydratePersistedSessionIfPresent,
  loadPersistedSession
} from '@/lib/session-persistence/session-persistence'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createNotebookPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useSearchMessageFocusStore } from '@/stores/search-message-focus-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

type Selection = {
  task: ScheduleSummary
  scriptRunId?: string
  scheduledAt?: number
  runSessionId?: string
  navigationRevision: number
}

export function useScheduleSelection(onNavigate?: () => void): {
  selection?: ScheduleSummary
  select: (
    task: ScheduleSummary,
    scriptRunId?: string,
    scheduledAt?: number,
    runSessionId?: string
  ) => void
  error: string
} {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<Selection>()
  const inFlight = useRef<Selection | undefined>(undefined)
  const [error, setError] = useState('')
  const reportError = useEffectEvent((error: unknown) => setError(scheduleErrorText(error, t)))
  const open = useEffectEvent(
    async (
      intent: Selection,
      runId: string | undefined,
      current: (revision?: number) => boolean,
      navigated: (revision: number) => void
    ) => {
      const task = intent.task
      const nav = useNavigationStore.getState()
      const { projectId } = task.target
      const sessionId = intent.runSessionId ?? task.target.sessionId
      let { agentFrameId, messageBranchId } = task.target
      if (!sessionId) return
      const findSession = (): ChatSession | undefined =>
        useSessionStore
          .getState()
          .sessions.find((s) => s.id === sessionId && s.projectId === projectId)
      let session = findSession()
      if (!session || session.contentLoaded === false) {
        const persisted = await loadPersistedSession({ projectId, sessionId })
        if (!current()) return
        if (persisted) {
          if (findSession()) session = hydratePersistedSessionIfPresent(persisted)
          else {
            useSessionStore.getState().upsertPersistedSession(persisted)
            session = findSession()
          }
        }
      }
      if (!session || session.archivedAt !== undefined) throw new Error(t('Conversation not found'))
      if (!nav.openSession(projectId, sessionId, 'user'))
        throw new Error(t('Conversation not found'))
      navigated(useNavigationStore.getState().explicitNavigationRevision)
      if (task.draft.action.kind === 'run_script') {
        if (!runId) {
          onNavigate?.()
          return
        }
        const revision = useNavigationStore.getState().explicitNavigationRevision
        const notebook = await window.api.notebook.getReference({
          projectId,
          sessionId,
          workspaceCwd: session.cwd
        })
        if (!current(revision)) return
        if (!notebook) throw new Error(t('Notebook not found'))
        usePreviewWorkbenchStore
          .getState()
          .upsertAndActivateItem(createNotebookPreviewItem(notebook, runId))
        onNavigate?.()
        return
      }
      const graph = session.conversationGraph
      if (task.target.sessionId === null && intent.runSessionId) {
        const prompt = graph?.messages.find(
          (message) =>
            message.attribution?.feature === 'schedule' &&
            message.attribution.scheduleId === task.id &&
            message.attribution.scheduledAt === intent.scheduledAt
        )
        if (!prompt) throw new Error(t('The source message is no longer available.'))
        messageBranchId = prompt.introducedOnBranchId
        agentFrameId =
          graph?.branches.find((branch) => branch.id === messageBranchId)?.agentFrameId ?? null
      }
      if (
        !messageBranchId ||
        !agentFrameId ||
        !graph?.branches.some((b) => b.id === messageBranchId && b.agentFrameId === agentFrameId)
      )
        throw new Error(t('The scheduled conversation branch is unavailable.'))
      if (
        graph.activeFrameId !== agentFrameId ||
        graph.frames.find((f) => f.id === agentFrameId)?.activeBranchId !== messageBranchId
      )
        useSessionStore.getState().activateMessageBranch(sessionId, messageBranchId)
      const shown = findSession()
      const shownGraph = shown?.conversationGraph
      if (
        !shown ||
        shownGraph?.frames.find((frame) => frame.id === agentFrameId)?.activeBranchId !==
          messageBranchId ||
        shownGraph.activeFrameId !== agentFrameId
      )
        throw new Error(t('The scheduled conversation branch is unavailable.'))
      const wake = shown.messages.findLast(
        (m) =>
          m.attribution?.feature === 'schedule' &&
          m.attribution.scheduleId === task.id &&
          (intent.scheduledAt === undefined || m.attribution.scheduledAt === intent.scheduledAt)
      )
      if (intent.scheduledAt !== undefined && !wake)
        throw new Error(t('The source message is no longer available.'))
      const messageId = wake?.id ?? task.originPromptId
      if (messageId && shown.messages.some((m) => m.id === messageId)) {
        useSearchMessageFocusStore.getState().request({
          projectId,
          sessionId,
          messageId,
          navigationRevision: useNavigationStore.getState().userNavigationRevision
        })
      } else if (messageId) throw new Error(t('The source message is no longer available.'))
      onNavigate?.()
    }
  )
  useEffect(() => {
    if (!selection) return
    const { task, navigationRevision } = selection
    const { projectId, sessionId } = task.target
    let active = true
    let ownedRevision = navigationRevision
    const current = (revision = ownedRevision): boolean =>
      active && useNavigationStore.getState().explicitNavigationRevision === revision
    const navigate = async (): Promise<void> => {
      try {
        let runId = selection.scriptRunId
        if (!runId && !selection.runSessionId && task.draft.action.kind === 'run_script') {
          const rows = await window.api.schedules.history({
            projectId,
            sessionId,
            scheduleId: task.id
          })
          if (!current()) return
          runId = rows.find((row) => row.scriptRunId)?.scriptRunId ?? undefined
          if (rows[0]?.status === 'failed') runId = undefined
        }
        if (current())
          await open(selection, runId, current, (revision) => {
            ownedRevision = revision
          })
      } catch (e) {
        if (current()) reportError(e)
      } finally {
        if (inFlight.current === selection) inFlight.current = undefined
      }
    }
    void navigate()
    return () => {
      active = false
    }
  }, [selection])
  function select(
    task: ScheduleSummary,
    scriptRunId?: string,
    scheduledAt?: number,
    runSessionId?: string
  ): void {
    const navigationRevision = useNavigationStore.getState().explicitNavigationRevision
    const pending = inFlight.current
    if (
      pending?.task.id === task.id &&
      pending.task.target.projectId === task.target.projectId &&
      pending.task.revision === task.revision &&
      pending.scriptRunId === scriptRunId &&
      pending.scheduledAt === scheduledAt &&
      pending.runSessionId === runSessionId &&
      pending.navigationRevision === navigationRevision
    )
      return
    setError('')
    const intent = { task, scriptRunId, scheduledAt, runSessionId, navigationRevision }
    inFlight.current = intent
    setSelection(intent)
  }
  return {
    selection: selection?.task,
    select,
    error
  }
}

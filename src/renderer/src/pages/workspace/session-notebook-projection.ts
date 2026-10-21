import type { TFunction } from 'i18next'

import type { NotebookRunHistorySummary, NotebookRunRecord } from '../../../../shared/notebook'
import type { ChatSession, ToolActivity } from '@/stores/session-store-contract'
import { resolveActiveConversationMessages } from '../../../../shared/conversation-graph'
import {
  getCorrelatedNotebookRun,
  getToolExecutionPhase,
  isNotebookExecutionActivity
} from './tool-execution-phase'
import {
  buildToolActivityDetails,
  getNotebookRunIdFromActivity,
  type ToolCodeSection
} from './workspace-tool-activity-details'

type NotebookFrameFilterValue = `frame:${string}`
type NotebookFrameFilterOption = Readonly<{
  value: NotebookFrameFilterValue
  label: string
  count?: number
}>

const createNotebookFrameFilterOptions = (
  runs: readonly NotebookRunRecord[],
  frameLabels: Readonly<Record<string, string>> = {},
  historySummaries: ReadonlyMap<string, NotebookRunHistorySummary> = new Map(),
  includeUnloaded = false,
  pendingFrameId?: string
): NotebookFrameFilterOption[] => {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (run.agentFrameId) counts.set(run.agentFrameId, (counts.get(run.agentFrameId) ?? 0) + 1)
  }
  return Object.entries(frameLabels).flatMap(([agentFrameId, label]) => {
    const recentCount = counts.get(agentFrameId)
    const historyCount = historySummaries.get(agentFrameId)?.runCount
    const count = historyCount ?? recentCount ?? (agentFrameId === pendingFrameId ? 0 : undefined)
    if (count === undefined && !includeUnloaded) return []
    return [
      {
        value: `frame:${agentFrameId}` as const,
        label,
        ...(count !== undefined ? { count } : {})
      }
    ]
  })
}

const projectNotebookRunsForFrame = (
  runs: readonly NotebookRunRecord[],
  filter: NotebookFrameFilterValue
): NotebookRunRecord[] => {
  const agentFrameId = filter.slice('frame:'.length)
  return runs.filter((run) => run.agentFrameId === agentFrameId)
}

const notebookFrameFilterForExport = (filter: NotebookFrameFilterValue): string =>
  filter.slice('frame:'.length)

// Pending Sessions keep their provisional Conversation Graph IDs when the provider later binds the
// final Session ID. Renderer-originated terminal runs use the final Session's canonical root ID, so
// fold that alias back into the graph root before building or applying the Agent filter.
const normalizeNotebookRootFrameRuns = (
  runs: readonly NotebookRunRecord[],
  session: ChatSession
): NotebookRunRecord[] => {
  const rootFrameId = session.conversationGraph?.rootFrameId
  const canonicalRootFrameId = `root-frame-${session.id}`
  if (!rootFrameId || rootFrameId === canonicalRootFrameId) return [...runs]

  return runs.map((run) =>
    run.agentFrameId === canonicalRootFrameId ? { ...run, agentFrameId: rootFrameId } : run
  )
}

// Takes `t` because the root frame's label is catalog copy while every delegate label is the user's
// own name for its Subagent, which interpolates unchanged.
const notebookFrameLabels = (session: ChatSession, t: TFunction): Record<string, string> => {
  const graph = session.conversationGraph
  if (!graph) return {}
  return Object.fromEntries(
    graph.frames.flatMap((frame) => {
      if (frame.id === graph.rootFrameId) return [[frame.id, t('Main Agent')]]
      if (frame.kind !== 'delegate' || !frame.delegateName) return []
      return [[frame.id, frame.delegateName]]
    })
  )
}

export {
  createNotebookFrameFilterOptions,
  notebookFrameFilterForExport,
  notebookFrameLabels,
  normalizeNotebookRootFrameRuns,
  projectNotebookRunsForFrame
}
export type { NotebookFrameFilterOption, NotebookFrameFilterValue }

// Preliminary code is presentation only; the exact current Branch and Turn own its lifetime.
const pendingNotebookCode = (
  session: ChatSession | undefined,
  runs: readonly NotebookRunRecord[]
): { activity: ToolActivity; frameId: string; code: ToolCodeSection }[] => {
  const graph = session?.conversationGraph
  const promptMessageId = session?.activeRun?.promptMessageId
  if (
    !session ||
    !graph ||
    !promptMessageId ||
    session.packageOrigin ||
    session.interrupted ||
    (session.status !== 'running' && session.status !== 'waiting-permission')
  )
    return []
  const frame = graph.frames.find((candidate) => candidate.id === graph.activeFrameId)
  if (
    !frame ||
    !resolveActiveConversationMessages(graph).some((message) => message.id === promptMessageId)
  )
    return []
  const runsById = new Map(runs.map((run) => [run.runId, run]))
  return (session.activities ?? []).flatMap((activity) => {
    if (!isNotebookExecutionActivity(activity) || activity.toolDisposition) return []
    const owners = graph.activities.filter((candidate) => candidate.id === activity.id)
    const owner = owners.length === 1 ? owners[0] : undefined
    if (
      !owner ||
      owner.agentFrameId !== frame.id ||
      owner.messageBranchId !== frame.activeBranchId ||
      owner.promptMessageId !== promptMessageId
    )
      return []
    const returnedRunId = getNotebookRunIdFromActivity(activity)
    if (
      getCorrelatedNotebookRun(activity, runsById) ||
      (returnedRunId && runsById.has(returnedRunId))
    )
      return []
    const scopedActivity = { ...activity, promptMessageId }
    const phase = getToolExecutionPhase(
      scopedActivity,
      session.runtimeContext?.permission,
      runsById
    )
    if (phase === 'cancelled' || phase === 'interrupted') return []
    const code = buildToolActivityDetails(activity)?.sections.find(
      (section): section is ToolCodeSection =>
        section.kind === 'code' && section.showLineNumbers === true
    )
    return code ? [{ activity: scopedActivity, frameId: frame.id, code }] : []
  })
}

export { pendingNotebookCode }

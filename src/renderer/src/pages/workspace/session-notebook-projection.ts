import type { TFunction } from 'i18next'

import type {
  NotebookAgentSummary,
  NotebookRunHistorySummary,
  NotebookRunRecord
} from '../../../../shared/notebook'
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

// Notebook reads already carry root provenance. Display-only conversation pages deliberately omit
// the graph, so reopening a Notebook must not require hydrating the transcript first.
const notebookRootFrameId = (
  session: Pick<ChatSession, 'id' | 'conversationGraph'>,
  runs: readonly NotebookRunRecord[]
): string => {
  const canonicalRootFrameId = `root-frame-${session.id}`
  return (
    session.conversationGraph?.rootFrameId ??
    runs.find((run) => run.rootFrameId && run.rootFrameId !== canonicalRootFrameId)?.rootFrameId ??
    canonicalRootFrameId
  )
}

// Root provenance can outlive Session rebinding. Project provisional and canonical root Runs onto
// the current presentation root before filtering, while retaining every child Frame identity.
const normalizeNotebookRootFrameRuns = (
  runs: readonly NotebookRunRecord[],
  session: Pick<ChatSession, 'id' | 'conversationGraph'>
): NotebookRunRecord[] => {
  const rootFrameId = notebookRootFrameId(session, runs)
  const canonicalRootFrameId = `root-frame-${session.id}`
  return runs.map((run) =>
    run.agentFrameId !== rootFrameId &&
    (run.agentFrameId === canonicalRootFrameId ||
      (run.agentFrameId !== undefined && run.agentFrameId === run.rootFrameId))
      ? { ...run, agentFrameId: rootFrameId }
      : run
  )
}

// Takes `t` because the root frame's label is catalog copy while every delegate label is the user's
// own name for its Subagent, which interpolates unchanged.
const notebookFrameLabels = (
  session: Pick<ChatSession, 'id' | 'conversationGraph'>,
  t: TFunction,
  runs: readonly NotebookRunRecord[] = [],
  agentSummaries: readonly NotebookAgentSummary[] = []
): Record<string, string> => {
  const graph = session.conversationGraph
  const rootFrameId = notebookRootFrameId(session, runs)
  const labels: Record<string, string> = { [rootFrameId]: t('Main Agent') }
  let ordinal = 0
  for (const agent of agentSummaries) {
    if (agent.isRoot) continue
    ordinal += 1
    const frame = graph?.frames.find((candidate) => candidate.id === agent.agentFrameId)
    if (frame && frame.kind !== 'delegate') continue
    labels[agent.agentFrameId] =
      frame?.delegateName ?? t('Subagent {{number}}', { number: ordinal })
  }
  for (const frame of graph?.frames ?? []) {
    if (frame.kind === 'delegate' && frame.delegateName) labels[frame.id] = frame.delegateName
  }
  return labels
}

const notebookAgentSummariesForSession = (
  session: Pick<ChatSession, 'id' | 'conversationGraph'>,
  runs: readonly NotebookRunRecord[],
  agents: readonly NotebookAgentSummary[]
): NotebookAgentSummary[] => {
  const rootFrameId = notebookRootFrameId(session, runs)
  return agents.map((agent) => (agent.isRoot ? { ...agent, agentFrameId: rootFrameId } : agent))
}

const notebookHistorySummaries = (
  agents: readonly NotebookAgentSummary[]
): ReadonlyMap<string, NotebookRunHistorySummary> =>
  new Map(
    agents.map((agent) => {
      const summary: NotebookRunHistorySummary = {
        agentFrameId: agent.agentFrameId,
        runCount: agent.runCount,
        kernelCounts: { python: 0, r: 0, repl: 0, bash: 0 }
      }
      for (const view of agent.views) {
        summary.kernelCounts[view.kernelKind] += view.runCount
        if (
          !summary.latestDataKernel &&
          (view.kernelKind === 'python' || view.kernelKind === 'r')
        ) {
          summary.latestDataKernel = view.kernelKind
        }
      }
      return [agent.agentFrameId, summary]
    })
  )

export {
  createNotebookFrameFilterOptions,
  notebookFrameFilterForExport,
  notebookFrameLabels,
  notebookAgentSummariesForSession,
  notebookHistorySummaries,
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

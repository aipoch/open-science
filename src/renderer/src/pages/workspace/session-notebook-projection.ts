import type { TFunction } from 'i18next'

import type { NotebookRunHistorySummary, NotebookRunRecord } from '../../../../shared/notebook'
import type { ChatSession } from '@/stores/session-store'

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
  includeUnloaded = false
): NotebookFrameFilterOption[] => {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (run.agentFrameId) counts.set(run.agentFrameId, (counts.get(run.agentFrameId) ?? 0) + 1)
  }
  return Object.entries(frameLabels).flatMap(([agentFrameId, label]) => {
    const recentCount = counts.get(agentFrameId)
    const historyCount = historySummaries.get(agentFrameId)?.runCount
    const count = historyCount ?? recentCount
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

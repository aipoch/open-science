import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ChatSession } from '@/stores/session-store'

type NotebookFrameFilterValue = `frame:${string}`
type NotebookFrameFilterOption = Readonly<{
  value: NotebookFrameFilterValue
  label: string
  count: number
}>

const createNotebookFrameFilterOptions = (
  runs: readonly NotebookRunRecord[],
  frameLabels: Readonly<Record<string, string>> = {}
): NotebookFrameFilterOption[] => {
  const counts = new Map<string, number>()
  for (const run of runs) {
    if (run.agentFrameId) counts.set(run.agentFrameId, (counts.get(run.agentFrameId) ?? 0) + 1)
  }
  return Object.entries(frameLabels).flatMap(([agentFrameId, label]) => {
    const count = counts.get(agentFrameId)
    return count
      ? [
          {
            value: `frame:${agentFrameId}` as const,
            label,
            count
          }
        ]
      : []
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

const filterNotebookRunsForSessionBranch = (
  runs: NotebookRunRecord[],
  session: ChatSession
): NotebookRunRecord[] => {
  const activeMessageIds = new Set(session.messages.map((message) => message.id))
  const rootFrameId = session.conversationGraph?.rootFrameId
  return runs.filter(
    (run) =>
      !run.promptMessageId ||
      (run.agentFrameId !== undefined && run.agentFrameId !== rootFrameId) ||
      activeMessageIds.has(run.promptMessageId)
  )
}

const notebookFrameLabels = (session: ChatSession): Record<string, string> => {
  const graph = session.conversationGraph
  if (!graph) return {}
  return Object.fromEntries(
    graph.frames.flatMap((frame) => {
      if (frame.id === graph.rootFrameId) return [[frame.id, 'Main Agent']]
      if (frame.kind !== 'delegate' || !frame.delegateName) return []
      return [[frame.id, frame.delegateName]]
    })
  )
}

export {
  createNotebookFrameFilterOptions,
  filterNotebookRunsForSessionBranch,
  notebookFrameFilterForExport,
  notebookFrameLabels,
  projectNotebookRunsForFrame
}
export type { NotebookFrameFilterOption, NotebookFrameFilterValue }

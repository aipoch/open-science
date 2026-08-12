import type { SessionPermissionRuntimeContext } from '../../../../shared/session-persistence'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ToolActivity } from '@/stores/session-store'

import { isNotebookExecuteToolName } from './notebook-tool-names'

type ToolExecutionPhase =
  | 'prepared'
  | 'awaiting-approval'
  | 'executing'
  | 'completed'
  | 'declined'
  | 'closed'
  | 'failed'
  | 'limit-reached'
  | 'cancelled'
  | 'interrupted'

const isNotebookExecutionActivity = (activity: ToolActivity): boolean =>
  isNotebookExecuteToolName(activity.providerToolName) || isNotebookExecuteToolName(activity.title)

const getCorrelatedNotebookRun = (
  activity: ToolActivity,
  notebookRunsById?: ReadonlyMap<string, NotebookRunRecord>
): NotebookRunRecord | undefined =>
  activity.executionInvocationId
    ? Array.from(notebookRunsById?.values() ?? []).find(
        (run) => run.executionInvocationId === activity.executionInvocationId
      )
    : undefined

const getToolExecutionPhase = (
  activity: ToolActivity,
  permission: SessionPermissionRuntimeContext | undefined,
  notebookRunsById?: ReadonlyMap<string, NotebookRunRecord>
): ToolExecutionPhase => {
  if (activity.toolDisposition === 'declined') return 'declined'
  const correlatedRun = isNotebookExecutionActivity(activity)
    ? getCorrelatedNotebookRun(activity, notebookRunsById)
    : undefined
  // Notebook owns execution truth. An outer ACP observer failure/closure cannot stop or relabel a
  // Run that the authenticated bridge has already admitted, including multi-hour executions.
  switch (correlatedRun?.status) {
    case 'queued':
    case 'running':
      return 'executing'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'timeout':
      return 'limit-reached'
    case 'cancelled':
      return 'cancelled'
    case 'interrupted':
      return 'interrupted'
  }

  if (activity.toolDisposition === 'permission-closed') {
    return isNotebookExecutionActivity(activity) ? 'prepared' : 'closed'
  }
  if (
    permission?.state === 'pending' &&
    permission.request.toolCallId === activity.id &&
    permission.originatingPromptMessageId === activity.promptMessageId
  ) {
    return 'awaiting-approval'
  }

  if (isNotebookExecutionActivity(activity)) {
    // ACP status describes the outer tool observer, not Notebook execution. Without an exact
    // app-owned Run join, even a terminal observer stays fail-closed at prepared (static code).
    return 'prepared'
  }
  if (activity.status === 'failed') return 'failed'
  if (activity.status === 'completed') return 'completed'
  return 'executing'
}

export { getCorrelatedNotebookRun, getToolExecutionPhase, isNotebookExecutionActivity }
export type { ToolExecutionPhase }

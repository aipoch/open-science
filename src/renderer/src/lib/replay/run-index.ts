import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { ReplayRunIndex, ReplaySourceIdentity } from '../../../../shared/replay'

// Conservative resident-size estimate without allocating a second full JSON string.
export const estimateReplayBytes = (value: unknown): number => {
  const pending = [value]
  const seen = new Set<object>()
  let bytes = 0
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string') bytes += current.length * 2
    else if (current === null || current === undefined) bytes += 4
    else if (typeof current !== 'object') bytes += 8
    else if (!seen.has(current)) {
      seen.add(current)
      bytes += 32
      for (const [key, entry] of Object.entries(current)) {
        bytes += key.length * 2
        pending.push(entry)
      }
    }
  }
  return bytes
}

export const replaySourceKey = (
  source: Pick<ReplaySourceIdentity, 'projectId' | 'sessionId' | 'fingerprint'>
): string => JSON.stringify([source.projectId, source.sessionId, source.fingerprint])

export const indexReplayRun = (run: ReplayRunIndex | NotebookRunRecord): ReplayRunIndex => ({
  runId: run.runId,
  cellId: run.cellId,
  source: run.source,
  kernelKind: run.kernelKind,
  status: run.status,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  executionInvocationId: run.executionInvocationId,
  rootFrameId: run.rootFrameId,
  agentFrameId: run.agentFrameId,
  messageBranchId: run.messageBranchId,
  runtimeSegmentId: run.runtimeSegmentId,
  promptMessageId: run.promptMessageId,
  truncated: run.truncated,
  ...('script' in run
    ? {
        scriptCharacters: run.script.length,
        detailBytes: estimateReplayBytes(run),
        environmentUnavailable: run.environmentCapture?.state === 'unavailable',
        hasOutput: Boolean(
          run.outputs.length ||
          run.text.stdout ||
          run.text.stderr ||
          run.text.traceback ||
          run.text.plain.length
        )
      }
    : {
        scriptCharacters: run.scriptCharacters,
        detailBytes: run.detailBytes,
        environmentUnavailable: run.environmentUnavailable,
        hasOutput: run.hasOutput
      })
})

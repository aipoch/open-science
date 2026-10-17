import type { ReplayDocument, ReplayScene } from '../../../../shared/replay'
import { projectReplayScene } from './scene'

/** An inspected cell keeps its own identity while visibility follows the actual research clock. */
export function projectReplayNotebookInspection(
  document: ReplayDocument,
  branchId: string,
  stepId: string,
  runId: string,
  positionMs: number,
  recordedTimeOrigin?: number
): ReplayScene | undefined {
  const branch = document.branches.find((item) => item.id === branchId)
  const original = branch?.steps.find((item) => item.id === stepId)
  const run = original?.runs.find((item) => item.runId === runId)
  if (
    !branch ||
    !original ||
    !run ||
    positionMs < original.startMs ||
    positionMs > branch.durationMs
  )
    return undefined
  const current = projectReplayScene(document, branchId, positionMs, recordedTimeOrigin)
  const recordedAt = recordedTimeOrigin === undefined ? undefined : recordedTimeOrigin + positionMs
  if (recordedAt !== undefined && run.startedAt > recordedAt) return undefined
  const showResults =
    recordedAt !== undefined
      ? run.endedAt !== undefined && run.endedAt <= recordedAt
      : original.id !== current.step?.id || current.showResults
  const activities = original.activities.filter(
    (item) => run.executionInvocationId && item.executionInvocationId === run.executionInvocationId
  )
  const resourceIds = document.resources
    .filter(
      (resource) => original.resourceIds.includes(resource.id) && resource.producerRunId === runId
    )
    .map((resource) => resource.id)
  const evidence = original.evidence.filter((reference) =>
    reference.kind === 'notebook-run'
      ? reference.id === runId
      : reference.kind === 'activity'
        ? activities.some((item) => item.id === reference.id)
        : (reference.kind === 'artifact-version' || reference.kind === 'upload-version') &&
          resourceIds.includes(reference.id)
  )
  if (!evidence.some((reference) => reference.kind === 'notebook-run' && reference.id === runId))
    evidence.unshift({
      kind: 'notebook-run',
      id: runId,
      projectId: document.source.projectId,
      sessionId: document.source.sessionId,
      branchId
    })
  const step = { ...original, activities, runs: [run], resourceIds, evidence }
  return {
    ...current,
    step,
    stepIndex: branch.steps.indexOf(original),
    phase: showResults ? 'result' : 'activity',
    showResults,
    messageCharacters: 0,
    visibleEvidence: evidence.flatMap((reference) =>
      !showResults && (reference.kind === 'artifact-version' || reference.kind === 'upload-version')
        ? []
        : [{ ...reference, part: showResults ? ('record' as const) : ('input' as const) }]
    ),
    visibleResourceIds: showResults ? resourceIds : []
  }
}

/** Inspect a particular conversation record without letting overlapping timestamps choose another. */
export function projectReplayStepInspection(
  document: ReplayDocument,
  branchId: string,
  stepId: string,
  positionMs: number,
  recordedTimeOrigin?: number,
  savedHistory = false
): ReplayScene | undefined {
  const branch = document.branches.find((item) => item.id === branchId)
  const step = branch?.steps.find((item) => item.id === stepId)
  if (
    !branch ||
    !step ||
    positionMs < 0 ||
    positionMs > branch.durationMs ||
    (!savedHistory && positionMs < step.startMs)
  )
    return undefined
  const inspected = projectReplayScene(
    { ...document, branches: [{ ...branch, steps: [step] }] },
    branchId,
    savedHistory ? Math.max(step.startMs, step.endMs) : positionMs,
    recordedTimeOrigin
  )
  return { ...inspected, positionMs, stepIndex: branch.steps.indexOf(step) }
}

import {
  REPLAY_SPEEDS,
  type ReplayClock,
  type ReplayDocument,
  type ReplayPosition,
  type ReplayPhase,
  type ReplayScene,
  type ReplaySpeed
} from '../../../../shared/replay'

// Shared with the renderer so visible evidence describes the bounded historical scene.
export const REPLAY_TRANSCRIPT_STEP_LIMIT = 12
export const REPLAY_ACTIVITY_LIMIT = 8
export const REPLAY_MATERIAL_RUN_LIMIT = 4
export const REPLAY_MATERIAL_RESOURCE_LIMIT = 6

const finite = (value: number): number => (Number.isFinite(value) ? value : 0)
const clamp = (value: number, maximum: number): number =>
  Math.max(0, Math.min(finite(value), Math.max(0, finite(maximum))))

export const projectReplayScene = (
  document: ReplayDocument,
  branchId: string,
  positionMs: number
): ReplayScene => {
  const branch = document.branches.find((candidate) => candidate.id === branchId)
  if (!branch) throw new Error('Replay branch is unavailable.')
  const position = clamp(positionMs, branch.durationMs)
  let low = 0
  let high = branch.steps.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (branch.steps[middle].startMs <= position) low = middle + 1
    else high = middle
  }
  const stepIndex = low - 1
  const step = branch.steps[stepIndex]
  const visibleSteps = branch.steps.slice(0, stepIndex + 1)
  const stepProgress = step ? clamp(position - step.startMs, step.durationMs) / step.durationMs : 0
  // Standalone files and reviews are recorded outcomes, with no input or execution to animate.
  // Expose their references immediately so seeking to a step also makes it discussable.
  const phase: ReplayPhase =
    step?.kind === 'message' || step?.kind === 'artifact' || step?.kind === 'review'
      ? 'result'
      : stepProgress < 0.2
        ? 'input'
        : stepProgress < 0.55
          ? 'activity'
          : 'result'
  const showResults = phase === 'result'
  const messageCharacters = step?.message
    ? Math.ceil(step.message.content.length * Math.min(1, (stepProgress + 0.08) / 0.7))
    : 0
  const materialReferenceIds = new Map<string, Set<string>>()
  const visibleMaterialReference = (
    item: NonNullable<typeof step>,
    reference: (typeof item.evidence)[number]
  ): boolean => {
    if (reference.kind === 'notebook-run')
      return item.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT).some((run) => run.runId === reference.id)
    if (reference.kind !== 'artifact-version' && reference.kind !== 'upload-version') return true
    let ids = materialReferenceIds.get(item.id)
    if (!ids) {
      const resourceIds = new Set(item.resourceIds.slice(0, REPLAY_MATERIAL_RESOURCE_LIMIT))
      ids = new Set(
        document.resources
          .filter((resource) => resourceIds.has(resource.id))
          .flatMap((resource) => [resource.id, ...(resource.versionId ? [resource.versionId] : [])])
      )
      materialReferenceIds.set(item.id, ids)
    }
    return ids.has(reference.id) || Boolean(reference.versionId && ids.has(reference.versionId))
  }
  const visibleEvidence = (step?.evidence ?? []).flatMap((reference) => {
    if (
      reference.kind === 'activity' &&
      !step?.activities.slice(0, REPLAY_ACTIVITY_LIMIT).some((item) => item.id === reference.id)
    )
      return []
    if (step && !visibleMaterialReference(step, reference)) return []
    if (reference.kind === 'review' && !showResults) return []
    if (
      (reference.kind === 'artifact-version' || reference.kind === 'upload-version') &&
      !showResults
    )
      return []
    return [
      {
        ...reference,
        part:
          !showResults && (reference.kind === 'activity' || reference.kind === 'notebook-run')
            ? ('input' as const)
            : ('record' as const)
      }
    ]
  })
  // Earlier transcript cards remain inspectable in this frame. Their completed records are
  // visible, while the active card still obeys its input/result boundary.
  for (const previous of visibleSteps.slice(-REPLAY_TRANSCRIPT_STEP_LIMIT)) {
    if (previous.id === step?.id) continue
    for (const reference of previous.evidence) {
      if (
        reference.kind !== 'message' &&
        reference.kind !== 'activity' &&
        reference.kind !== 'review'
      )
        continue
      if (
        reference.kind === 'activity' &&
        !previous.activities
          .slice(0, REPLAY_ACTIVITY_LIMIT)
          .some((item) => item.id === reference.id)
      )
        continue
      if (
        !visibleEvidence.some(
          (existing) => existing.kind === reference.kind && existing.id === reference.id
        )
      )
        visibleEvidence.push({ ...reference, part: 'record' })
    }
  }
  // The Stage keeps the latest recorded material beside later conversation. A question about
  // that frame must retain the run/version visible there, even when the active step is text.
  const materialStep = [...visibleSteps]
    .reverse()
    .find((item) => item.runs.length || item.resourceIds.length)
  if (materialStep && materialStep.id !== step?.id) {
    for (const reference of materialStep.evidence) {
      if (
        reference.kind !== 'notebook-run' &&
        reference.kind !== 'artifact-version' &&
        reference.kind !== 'upload-version'
      )
        continue
      if (!visibleMaterialReference(materialStep, reference)) continue
      if (
        !visibleEvidence.some(
          (existing) => existing.kind === reference.kind && existing.id === reference.id
        )
      )
        visibleEvidence.push({ ...reference, part: 'record' })
    }
  }
  return {
    branchId,
    positionMs: position,
    durationMs: branch.durationMs,
    stepIndex,
    step,
    stepProgress,
    phase,
    showResults,
    messageCharacters,
    visibleEvidence,
    visibleSteps,
    visibleResourceIds: [
      ...new Set(
        visibleSteps.flatMap((item) =>
          item.id === step?.id && !showResults ? [] : item.resourceIds
        )
      )
    ],
    ended: position >= branch.durationMs
  }
}

export const normalizeReplaySpeed = (value: number): ReplaySpeed =>
  REPLAY_SPEEDS.find((speed) => speed === value) ?? 2

export const seekReplayClock = (
  clock: ReplayClock,
  positionMs: number,
  durationMs: number
): ReplayClock => ({
  ...clock,
  positionMs: clamp(positionMs, durationMs),
  playing: false
})

// The caller supplies elapsed monotonic time. No global wall clock, timers or execution hooks.
export const advanceReplayClock = (
  clock: ReplayClock,
  elapsedMs: number,
  durationMs: number
): ReplayClock => {
  if (!clock.playing) return clock
  const positionMs = clamp(
    clock.positionMs + Math.max(0, finite(elapsedMs)) * normalizeReplaySpeed(clock.speed),
    durationMs
  )
  return { ...clock, positionMs, playing: positionMs < durationMs }
}

export const replayPositionAtScene = (scene: ReplayScene): ReplayPosition => ({
  branchId: scene.branchId,
  stepId: scene.step?.id,
  stepOffsetMs: scene.step ? scene.positionMs - scene.step.startMs : 0
})

// Missing steps do not silently seek to another record at a formerly matching numeric timestamp.
export const resolveReplayPosition = (
  document: ReplayDocument,
  position: ReplayPosition
): number | undefined => {
  const branch = document.branches.find((candidate) => candidate.id === position.branchId)
  if (!branch) return undefined
  if (!position.stepId) return 0
  const step = branch.steps.find((candidate) => candidate.id === position.stepId)
  return step ? step.startMs + clamp(position.stepOffsetMs, step.durationMs) : undefined
}

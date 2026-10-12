import type { ReviewWithChecks } from '../../../../shared/reviewer'
import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveMessageBranchPath
} from '../../../../shared/conversation-graph'
import {
  REPLAY_GENERATOR_VERSION,
  REPLAY_PRESENTATION_VERSION,
  type ReplayBranch,
  type ReplayDocument,
  type ReplayEvidenceReference,
  type ReplayIssue,
  type ReplayResource,
  type ReplayRunIndex,
  type ReplayStep
} from '../../../../shared/replay'
import type {
  PersistedChatSession,
  PersistedToolActivity
} from '../../../../shared/session-persistence'
import { createReplayTranscript } from './transcript'
import type { ReplaySourceData } from './source'
import { indexReplayRun } from './run-index'

const time = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined

const stableId = (kind: string, id: string): string => `${kind}:${encodeURIComponent(id)}`

const evidence = (
  session: PersistedChatSession,
  branch: ReplayBranch,
  kind: ReplayEvidenceReference['kind'],
  id: string
): ReplayEvidenceReference => ({
  kind,
  id,
  projectId: session.projectId,
  sessionId: session.id,
  branchId: branch.id,
  agentFrameId: branch.agentFrameId
})

const runIssues = (run: ReplayRunIndex): ReplayIssue[] => [
  ...(run.truncated ? [{ code: 'truncated-output' as const, sourceId: run.runId }] : []),
  ...(run.environmentUnavailable
    ? [{ code: 'missing-environment' as const, sourceId: run.runId }]
    : [])
]

const makeStep = (
  branch: ReplayBranch,
  input: Pick<ReplayStep, 'id' | 'kind' | 'evidence'> & Partial<ReplayStep>
): ReplayStep => ({
  branchId: branch.id,
  agentFrameId: branch.agentFrameId,
  activities: [],
  runs: [],
  resourceIds: [],
  issues: [],
  startMs: 0,
  endMs: 0,
  durationMs: 0,
  ...input,
  recordedAt: time(input.recordedAt),
  recordedEndAt: time(input.recordedEndAt)
})

// These are presentation durations, never measurements of the original research execution.
export const replayStepDuration = (step: ReplayStep): number => {
  const characters =
    (step.message?.content.length ?? 0) +
    step.runs.reduce((sum, run) => sum + (run.scriptCharacters ?? 0), 0) +
    step.activities.reduce((sum, activity) => sum + activity.title.length, 0)
  return Math.min(12000, Math.max(2500, 2000 + Math.ceil(characters / 80) * 500))
}

const setPresentationTimes = (branch: ReplayBranch): void => {
  let position = 0
  branch.steps = branch.steps.map((step) => {
    const durationMs = replayStepDuration(step)
    const next = {
      ...step,
      startMs: position,
      durationMs,
      endMs: position + durationMs,
      issues:
        step.recordedAt === undefined
          ? [...step.issues, { code: 'missing-time' as const, sourceId: step.id }]
          : step.issues
    }
    position += durationMs
    return next
  })
  branch.durationMs = position
}

const sessionForBranch = (
  session: PersistedChatSession,
  branch: ReplayBranch
): PersistedChatSession => {
  const graph = session.conversationGraph
  if (!graph) return session
  const selected = {
    ...graph,
    activeFrameId: branch.agentFrameId!,
    frames: graph.frames.map((frame) =>
      frame.id === branch.agentFrameId ? { ...frame, activeBranchId: branch.id } : frame
    )
  }
  return {
    ...session,
    conversationGraph: selected,
    messages: resolveMessageBranchPath(selected, branch.id).map(projectConversationMessage),
    ...resolveActiveConversationActivities(selected),
    activeRun: undefined,
    status: 'idle'
  }
}

const branchAncestry = (session: PersistedChatSession, branch: ReplayBranch): Set<string> => {
  const branches = new Map(session.conversationGraph?.branches.map((item) => [item.id, item]))
  const ids = new Set<string>()
  let id: string | undefined = branch.id
  while (id && !ids.has(id)) {
    ids.add(id)
    id = branches.get(id)?.parentBranchId
  }
  return ids
}

const belongsToBranch = (
  run: ReplayRunIndex,
  source: ReplaySourceData,
  branch: ReplayBranch,
  projected: PersistedChatSession
): boolean => {
  if (run.agentFrameId && branch.agentFrameId && run.agentFrameId !== branch.agentFrameId) {
    return false
  }
  const visibleActivities = projected.activities ?? []
  const allActivities =
    source.session.conversationGraph?.activities ?? source.session.activities ?? []
  if (run.executionInvocationId) {
    const matches = allActivities.filter(
      (activity) => activity.executionInvocationId === run.executionInvocationId
    )
    // An explicit fork cutoff in the authority must also hide the corresponding Notebook run.
    if (matches.length) {
      return matches.some((match) => visibleActivities.some((activity) => activity.id === match.id))
    }
  }
  const messages = new Set(projected.messages.map((message) => message.id))
  if (run.promptMessageId && !messages.has(run.promptMessageId)) return false
  if (run.messageBranchId && !branchAncestry(source.session, branch).has(run.messageBranchId)) {
    return false
  }
  if (run.messageBranchId && run.messageBranchId !== branch.id) {
    const graphBranches = new Map(
      source.session.conversationGraph?.branches.map((item) => [item.id, item])
    )
    let descendant = graphBranches.get(branch.id)
    while (descendant && descendant.id !== run.messageBranchId) {
      // Without a joining activity we cannot establish which side of an edited-answer cutoff
      // this run belongs to. Its originating branch still retains the evidence.
      if (descendant.forkActivityId) return false
      descendant = descendant.parentBranchId
        ? graphBranches.get(descendant.parentBranchId)
        : undefined
    }
  }
  if (run.promptMessageId && !run.messageBranchId && source.session.conversationGraph) {
    const graph = source.session.conversationGraph
    const possibleBranches = graph.branches.filter((candidate) =>
      resolveMessageBranchPath(graph, candidate.id).some(
        (message) => message.id === run.promptMessageId
      )
    )
    if (possibleBranches.length !== 1) return false
  }
  if (run.promptMessageId || run.messageBranchId) return true
  // A legacy linear session has only one possible path. Multi-branch unbound records get their
  // own clearly labelled material lane instead of leaking into a guessed history.
  return (source.session.conversationGraph?.branches.length ?? 1) === 1
}

const notebookStep = (
  session: PersistedChatSession,
  branch: ReplayBranch,
  run: ReplayRunIndex
): ReplayStep =>
  makeStep(branch, {
    id: stableId('notebook-run', run.runId),
    kind: 'notebook',
    evidence: [
      evidence(session, branch, 'notebook-run', run.runId),
      ...((session.conversationGraph?.messages ?? session.messages).some(
        (message) => message.id === run.promptMessageId
      )
        ? [evidence(session, branch, 'message', run.promptMessageId!)]
        : [])
    ],
    runs: [run],
    promptMessageId: run.promptMessageId,
    recordedAt: run.startedAt,
    recordedEndAt: run.endedAt,
    status: run.status,
    issues: runIssues(run)
  })

const addAfterAnchors = (
  steps: ReplayStep[],
  additions: Array<{ anchor: string | undefined; step: ReplayStep }>
): ReplayStep[] => {
  const anchored = new Map<string, ReplayStep[]>()
  const trailing: ReplayStep[] = []
  for (const { anchor, step } of additions) {
    if (anchor) anchored.set(anchor, [...(anchored.get(anchor) ?? []), step])
    else trailing.push(step)
  }
  return [...steps.flatMap((step) => [step, ...(anchored.get(step.id) ?? [])]), ...trailing]
}

const resourceStep = (
  session: PersistedChatSession,
  branch: ReplayBranch,
  resource: ReplayResource
): ReplayStep =>
  makeStep(branch, {
    id: stableId('resource', resource.id),
    kind: 'artifact',
    title: resource.name,
    resourceIds: [resource.id],
    recordedAt: resource.createdAt,
    evidence: [
      {
        ...evidence(
          session,
          branch,
          resource.source === 'upload' ? 'upload-version' : 'artifact-version',
          resource.versionId ?? resource.id
        ),
        artifactId: resource.artifactId,
        fileId: resource.fileId,
        versionId: resource.versionId
      }
    ],
    issues:
      resource.availability === 'unavailable'
        ? [{ code: 'artifact-unavailable', sourceId: resource.id }]
        : []
  })

export const buildReplayDocument = (source: ReplaySourceData): ReplayDocument => {
  const { session } = source
  const indexedRuns = source.runs.map(indexReplayRun)
  const graph = session.conversationGraph
  const branches: ReplayBranch[] = graph?.branches.length
    ? graph.branches.map((branch) => ({
        id: branch.id,
        agentFrameId: branch.agentFrameId,
        parentBranchId: branch.parentBranchId,
        label: graph.frames.find((frame) => frame.id === branch.agentFrameId)?.agentName,
        kind: 'conversation',
        steps: [],
        durationMs: 0
      }))
    : [{ id: `session:${session.id}`, kind: 'conversation', steps: [], durationMs: 0 }]
  const projectedSessions = new Map(
    branches.map((branch) => [branch.id, sessionForBranch(session, branch)])
  )
  const assignedReviews = new Set<string>()
  const reviews = [...(source.reviews ?? [])].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
  const reviewFits = (review: ReviewWithChecks, branch: ReplayBranch): boolean => {
    const scope = review.scope
    if (scope.agentFrameId && scope.agentFrameId !== branch.agentFrameId) return false
    if (scope.messageBranchId && scope.messageBranchId !== branch.id) return false
    const projected = projectedSessions.get(branch.id)!
    return (
      projected.messages.some((message) => message.id === review.turnMessageId) &&
      scope.blocks.every((block) =>
        block.kind === 'message'
          ? projected.messages.some((message) => message.id === block.sourceId)
          : projected.activities?.some((activity) => activity.id === block.sourceId)
      )
    )
  }
  // Resolve each review once. Shared legacy prompts cannot identify the audited fork.
  const reviewBranches = new Map(
    reviews.map((review) => {
      const candidates = branches.filter((branch) => reviewFits(review, branch))
      return [review.id, candidates.length === 1 ? candidates[0].id : undefined]
    })
  )
  const reviewStep = (review: ReviewWithChecks, branch: ReplayBranch): ReplayStep =>
    makeStep(branch, {
      id: stableId('review', review.id),
      kind: 'review',
      review,
      promptMessageId: review.turnMessageId,
      recordedAt: review.createdAt,
      evidence: [evidence(session, branch, 'review', review.id)]
    })
  const assignedRuns = new Set<string>()
  const assignedResources = new Set<string>()
  const resources = source.resources.map((resource) => {
    if (resource.messageId) return resource
    const artifact = session.artifacts?.find(
      (item) => resource.versionId && item.versionId === resource.versionId
    )
    const message = artifact
      ? (graph?.messages ?? session.messages).find((item) =>
          item.artifactIds?.includes(artifact.id)
        )
      : undefined
    return message ? { ...resource, messageId: message.id } : resource
  })

  const resourceOrder = (left: ReplayResource, right: ReplayResource): number => {
    if (left.createdAt !== undefined && right.createdAt !== undefined) {
      const difference = left.createdAt - right.createdAt
      if (difference) return difference
    }
    if (left.artifactId === right.artifactId) {
      const difference = (left.versionNumber ?? 0) - (right.versionNumber ?? 0)
      if (difference) return difference
    }
    return left.id.localeCompare(right.id)
  }

  for (const branch of branches) {
    const projected = projectedSessions.get(branch.id)!
    const branchRuns = indexedRuns.filter((run) => belongsToBranch(run, source, branch, projected))
    const mergedRuns = new Set<string>()
    const activityStep = (activities: PersistedToolActivity[], title?: string): ReplayStep => {
      const runs = branchRuns.filter(
        (run) =>
          !mergedRuns.has(run.runId) &&
          run.executionInvocationId &&
          activities.some(
            (activity) => activity.executionInvocationId === run.executionInvocationId
          )
      )
      runs.forEach((run) => mergedRuns.add(run.runId))
      const promptIds = new Set(
        activities.map(
          (activity) =>
            activity.promptMessageId ??
            graph?.activities.find((item) => item.id === activity.id)?.promptMessageId
        )
      )
      return makeStep(branch, {
        id: stableId('activity', activities[0].id),
        kind: runs.length ? 'notebook' : 'activity',
        title,
        activities,
        runs,
        evidence: [
          ...activities.map((activity) => evidence(session, branch, 'activity', activity.id)),
          ...runs.map((run) => evidence(session, branch, 'notebook-run', run.runId))
        ],
        promptMessageId: promptIds.size === 1 ? [...promptIds][0] : undefined,
        recordedAt: Math.min(...activities.map((activity) => activity.createdAt)),
        // Tool updatedAt is not a guaranteed completion timestamp. Do not label it elapsed time.
        recordedEndAt: runs.length ? Math.max(...runs.map((run) => run.endedAt ?? NaN)) : undefined,
        issues: runs.flatMap(runIssues)
      })
    }
    const timeline = createReplayTranscript(projected)
    branch.steps = timeline.flatMap((item): ReplayStep[] => {
      if (item.type === 'message') {
        const message = item.message
        return [
          makeStep(branch, {
            id: stableId('message', message.id),
            kind: 'message',
            message,
            evidence: [evidence(session, branch, 'message', message.id)],
            promptMessageId: message.role === 'user' ? message.id : message.responseToMessageId,
            recordedAt: message.createdAt,
            recordedEndAt: message.completedAt ?? message.failedAt,
            status: message.status
          })
        ]
      }
      if (item.type === 'activity-group') return [activityStep(item.activities, item.title)]
      if (
        item.type === 'activity' ||
        item.type === 'plan-activity' ||
        item.type === 'compaction-activity'
      ) {
        return [activityStep([item.activity], item.activity.title)]
      }
      // Turn-completion/configuration rows are derived transcript chrome, not additional evidence.
      // Delegate Frames have their own selectable branches and retain their full message history.
      return []
    })
    const unmatchedRuns = branchRuns.filter((run) => !mergedRuns.has(run.runId))
    branch.steps = addAfterAnchors(
      branch.steps,
      unmatchedRuns.map((run) => ({
        anchor: run.promptMessageId
          ? branch.steps.findLast((step) => step.promptMessageId === run.promptMessageId)?.id
          : undefined,
        step: notebookStep(session, branch, run)
      }))
    )
    branchRuns.forEach((run) => assignedRuns.add(run.runId))
    const additions: Array<{ anchor: string | undefined; step: ReplayStep }> = []
    for (const resource of [...resources].sort(resourceOrder)) {
      const messageAnchor = resource.messageId
        ? branch.steps.find(
            (step) =>
              step.message &&
              (step.message.id === resource.messageId ||
                resource.messageIds?.includes(step.message.id))
          )
        : undefined
      const runAnchor = resource.producerRunId
        ? branch.steps.find((step) => step.runs.some((run) => run.runId === resource.producerRunId))
        : undefined
      // Publication message is the stronger visibility boundary; a finished run may predate save.
      const anchor = messageAnchor ?? (!resource.messageId ? runAnchor : undefined)
      if (!anchor) continue
      additions.push({ anchor: anchor.id, step: resourceStep(session, branch, resource) })
      assignedResources.add(resource.id)
    }
    branch.steps = addAfterAnchors(branch.steps, additions)
    const branchReviews = reviews.filter((review) => reviewBranches.get(review.id) === branch.id)
    for (const review of branchReviews) assignedReviews.add(review.id)
    branch.steps = addAfterAnchors(
      branch.steps,
      branchReviews.map((review) => {
        const ids = new Set(review.scope.blocks.map((block) => block.sourceId))
        const anchor =
          branch.steps.findLast((step) => step.evidence.some((ref) => ids.has(ref.id))) ??
          branch.steps.findLast(
            (step) =>
              (step.promptMessageId === review.turnMessageId ||
                step.message?.id === review.turnMessageId) &&
              step.recordedAt !== undefined &&
              step.recordedAt <= review.createdAt
          )
        return { anchor: anchor?.id, step: reviewStep(review, branch) }
      })
    )
    setPresentationTimes(branch)
  }

  const unassignedRuns = indexedRuns.filter((run) => !assignedRuns.has(run.runId))
  const unassignedResources = resources.filter((resource) => !assignedResources.has(resource.id))
  const unassignedReviews = reviews.filter((review) => !assignedReviews.has(review.id))
  if (unassignedRuns.length || unassignedResources.length || unassignedReviews.length) {
    const branch: ReplayBranch = {
      id: `unattributed:${session.id}`,
      kind: 'unattributed',
      steps: [],
      durationMs: 0
    }
    branch.steps = [
      ...unassignedReviews.map((review) => reviewStep(review, branch)),
      ...unassignedRuns.map((run) => notebookStep(session, branch, run)),
      ...unassignedResources.map((resource) => resourceStep(session, branch, resource))
    ].map((step) => ({
      ...step,
      issues: [...step.issues, { code: 'unattributed-record', sourceId: step.id }]
    }))
    setPresentationTimes(branch)
    branches.push(branch)
  }
  const activeFrame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
  const preferred =
    branches.find((branch) => branch.id === activeFrame?.activeBranchId) ?? branches[0]
  const defaultBranch = preferred.steps.length
    ? preferred
    : (branches.find((branch) => branch.steps.length) ?? preferred)
  return {
    generatorVersion: REPLAY_GENERATOR_VERSION,
    presentationVersion: REPLAY_PRESENTATION_VERSION,
    source: {
      projectId: session.projectId,
      sessionId: session.id,
      title: session.title,
      workspaceCwd: session.cwd,
      packageOrigin: session.packageOrigin,
      fingerprint:
        session.packageOrigin?.manifestChecksum ??
        `${session.id}:${session.revision ?? 0}:${session.updatedAt}`
    },
    defaultBranchId: defaultBranch.id,
    branches,
    resources,
    issues: [...source.issues]
  }
}

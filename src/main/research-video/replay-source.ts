import {
  resolveActiveConversationActivities,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import {
  isHiddenControlMessage,
  isHumanUserMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { ResearchVideoPresentationRequest } from '../../shared/research-video-presentation'
import type {
  ResearchVideoSessionSource,
  ReplayEvidence,
  ReplayRecords
} from '@aipoch/research-film'

const bounded = (text: string): string =>
  text.length <= 12000
    ? text
    : text.slice(0, 12000) + '\n[Source excerpt; remaining content omitted.]'
const printable = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
const referencesJob = (value: unknown, id: string, depth = 0): boolean => {
  if (depth > 12) return false
  if (typeof value === 'string') {
    try {
      return referencesJob(JSON.parse(value), id, depth + 1)
    } catch {
      return false
    }
  }
  if (Array.isArray(value)) return value.some((item) => referencesJob(item, id, depth + 1))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) =>
    ['job_id', 'jobId'].includes(key) ? item === id : referencesJob(item, id, depth + 1)
  )
}

/** Only the selected frame/branch supplies actors, activities and causal source identities. */
export function operationReplaySource(
  session: PersistedChatSession,
  request: ResearchVideoPresentationRequest,
  records: ReplayRecords = { reviews: [], jobs: [] }
): ResearchVideoSessionSource {
  if (
    session.id !== request.sessionId ||
    session.projectId !== request.projectId ||
    session.archivedAt
  )
    throw new Error('Research session is unavailable.')
  const graph = session.conversationGraph
  const branchId =
    request.branchId ?? graph?.frames.find((f) => f.id === graph.rootFrameId)?.activeBranchId
  const branch = graph?.branches.find((b) => b.id === branchId)
  if ((graph && !branch) || (!graph && request.branchId))
    throw new Error('Research branch is unavailable.')
  const messages = (
    graph && branchId ? resolveMessageBranchPath(graph, branchId) : session.messages
  ).filter((m) => !isHiddenControlMessage(m) && ['user', 'agent', 'assistant'].includes(m.role))
  const messageIds = new Set(messages.map((m) => m.id))
  const activities =
    graph && branch
      ? resolveActiveConversationActivities({
          ...graph,
          activeFrameId: branch.agentFrameId,
          frames: graph.frames.map((f) =>
            f.id === branch.agentFrameId ? { ...f, activeBranchId: branch.id } : f
          )
        }).activities
      : (session.activities ?? []).filter(
          (a) => a.promptMessageId && messageIds.has(a.promptMessageId)
        )
  const events: ReplayEvidence[] = []
  const omissions: string[] = []
  // Parent runs are visible only before the fork; sibling runs never become inherited evidence.
  const branchCutoffs = new Map<string | undefined, number>()
  const branches = new Map(graph?.branches.map((item) => [item.id, item]))
  let ancestor = branch
  let cutoff = Infinity
  while (ancestor && !branchCutoffs.has(ancestor.id)) {
    branchCutoffs.set(ancestor.id, cutoff)
    const activityCutoff = ancestor.forkActivityId
      ? graph?.activities.find((item) => item.id === ancestor!.forkActivityId)?.createdAt
      : undefined
    cutoff = Math.min(cutoff, activityCutoff ?? ancestor.createdAt)
    ancestor = ancestor.parentBranchId ? branches.get(ancestor.parentBranchId) : undefined
  }
  if (!graph) branchCutoffs.set(undefined, Infinity)
  const runsByMessage = new Map<string, NonNullable<ReplayRecords['runs']>>()
  for (const run of records.runs ?? []) {
    if (!run.messageId || (graph && !run.branchId)) {
      if (
        !omissions.includes('Notebook runs without reliable conversation provenance are omitted.')
      )
        omissions.push('Notebook runs without reliable conversation provenance are omitted.')
      continue
    }
    const before = branchCutoffs.get(run.branchId)
    if (!messageIds.has(run.messageId) || before === undefined || !(run.recordedAt < before))
      continue
    const runs = runsByMessage.get(run.messageId) ?? []
    runs.push(run)
    runsByMessage.set(run.messageId, runs)
  }
  const add = (event: ReplayEvidence): void => {
    events.push({ ...event, text: bounded(event.text) })
  }
  const plans = [...(session.planHistoryProjections ?? [])]
  const plan = session.runtimeContext?.plan
  // Runtime context and history have distinct shapes. Neither proves the time of an approval click.
  const planRecords: Array<{
    id: string
    messageId?: string
    status: string
    text: string
    at?: number
  }> = plans.map((p) => ({
    id: p.artifactVersionId,
    messageId: p.originatingPromptMessageId,
    status: p.lifecycle,
    text: JSON.stringify({ approval: p.approval, document: p.document, steps: p.stepStates }),
    at: p.materializedAt
  }))
  if (plan && !planRecords.some((p) => p.id === plan.artifactVersionId))
    planRecords.push({
      id: plan.artifactVersionId,
      messageId: plan.originatingPromptMessageId,
      status: plan.approval,
      text: JSON.stringify({
        approval: plan.approval,
        document: plan.document,
        steps: plan.stepStatuses
      }),
      at: plan.materializedAt
    })
  if (planRecords.some((p) => !p.messageId || !messageIds.has(p.messageId)))
    omissions.push('Plans without a selected-branch prompt link are omitted.')
  const linkedJobs = new Map<string, string>()
  const allActivities = graph?.activities ?? session.activities ?? []
  for (const job of records.jobs) {
    // A session owner alone does not establish branch ownership. Require an exact returned ID.
    const links = allActivities.filter((a) => {
      return (
        (a.executionInvocationId && job.producerRunId === a.executionInvocationId) ||
        referencesJob(a.rawOutput, job.id)
      )
    })
    if (
      links.length === 1 &&
      links[0].promptMessageId &&
      activities.some((a) => a.id === links[0].id)
    )
      linkedJobs.set(job.id, links[0].promptMessageId)
  }
  if (records.jobs.some((j) => !linkedJobs.has(j.id)))
    omissions.push('Remote jobs without a unique selected-branch activity link are omitted.')
  if (records.reviews.some((r) => !messageIds.has(r.messageId)))
    omissions.push('Reviews outside this branch are omitted.')
  for (const message of messages) {
    const human = isHumanUserMessage(message)
    const kind = human
      ? 'human-input'
      : message.role === 'user'
        ? 'application-event'
        : 'agent-message'
    if (message.content.trim())
      add({
        id: `message:${message.id}`,
        messageId: message.id,
        kind,
        title: human
          ? 'User request'
          : kind === 'application-event'
            ? 'Application event'
            : 'Agent response',
        text: message.content,
        recordedAt: message.createdAt
      })
    for (const upload of message.uploads ?? [])
      add({
        id: `attachment:${message.id}:${upload.id}`,
        messageId: message.id,
        kind: 'attachment',
        title: upload.name,
        text: `${upload.name}\n${upload.mimeType ?? 'File'} · ${upload.size} bytes\nRecorded attachment; file contents are not reproduced.`,
        recordedAt: message.createdAt
      })
    for (const p of planRecords.filter((p) => p.messageId === message.id))
      add({
        id: `plan:${p.id}`,
        messageId: message.id,
        kind: 'plan',
        title: 'Plan snapshot',
        status: p.status,
        text: p.text,
        recordedAt: p.at
      })
    for (const a of activities.filter((a) => a.promptMessageId === message.id))
      add({
        id: `activity:${a.id}`,
        messageId: message.id,
        kind: 'execution',
        title: a.title,
        status: a.status,
        text:
          [
            a.providerToolName,
            a.rawInput === undefined ? '' : `Recorded input: ${printable(a.rawInput)}`,
            a.terminalOutput,
            printable(a.rawOutput),
            a.terminalExitCode === undefined ? '' : `Exit code: ${a.terminalExitCode}`
          ]
            .filter(Boolean)
            .join('\n') || 'No execution output is recorded.',
        recordedAt: a.createdAt
      })
    for (const run of runsByMessage.get(message.id) ?? []) {
      add({
        id: `notebook:${run.id}`,
        messageId: message.id,
        kind: 'execution',
        title: 'Notebook',
        status: run.status,
        text: `${run.language}\n${run.code}\nRecorded output:\n${run.output}`,
        execution: { code: bounded(run.code), output: bounded(run.output), language: run.language },
        recordedAt: run.recordedAt
      })
    }
    for (const j of records.jobs.filter((j) => linkedJobs.get(j.id) === message.id))
      add({
        id: `job:${j.id}`,
        messageId: message.id,
        kind: 'remote-job',
        title: 'Remote execution',
        status: j.status,
        text: j.text,
        recordedAt: j.recordedAt
      })
    for (const id of message.artifactIds ?? []) {
      const artifact = session.artifacts?.find((a) => a.id === id)
      if (artifact)
        add({
          id: `result:${message.id}:${id}`,
          messageId: message.id,
          kind: 'result',
          title: artifact.name ?? 'Result',
          text: `${artifact.name ?? 'Result'}\nRecorded output; its claims have not been independently verified.`,
          artifactId: id,
          recordedAt: message.createdAt
        })
    }
    for (const r of records.reviews.filter((r) => r.messageId === message.id))
      add({
        id: `review:${r.id}`,
        messageId: message.id,
        kind: 'review',
        title: 'Review snapshot',
        text: r.text,
        status: r.status,
        recordedAt: r.recordedAt
      })
  }
  if (events.length > 2000)
    throw new Error('This branch exceeds the replay evidence limit (2000 records).')
  const times = new Map(messages.map((message, i) => [message.id, message.createdAt ?? i]))
  events.sort(
    (a, b) =>
      (a.recordedAt ?? times.get(a.messageId) ?? 0) - (b.recordedAt ?? times.get(b.messageId) ?? 0)
  )
  return {
    sessionTitle: session.title,
    project: session.projectId,
    messages: messages.map((m, i) => ({
      i,
      id: m.id,
      role: isHumanUserMessage(m) ? 'user' : m.role === 'user' ? 'system' : m.role,
      md: m.content,
      artifactIds: m.artifactIds ?? []
    })),
    replay: { schemaVersion: 1, events, omissions },
    provenance: {
      projectId: session.projectId,
      sessionId: session.id,
      branchId,
      mode: 'operation-replay',
      sourceRevision: session.revision,
      sourceClaimsIndependentlyVerified: false
    }
  }
}

import type {
  BackgroundResultActivityItem,
  BackgroundResultDelivery,
  BackgroundResultExecutionType
} from '../../shared/background-result-delivery'
import type { JobSummary } from '../../shared/compute'
import type { NotebookRunRecord } from '../../shared/notebook'

const SUMMARY_LIMIT = 8_000
const WORKING_FILE_LIMIT = 100
const NOTEBOOK_SOURCE_BATCH_LIMIT = 20

type BackgroundResultPromptOutcome = Readonly<Record<string, unknown>>

type ResolvedBackgroundResultSource = Readonly<{
  delivery: BackgroundResultDelivery
  availability: 'terminal' | 'not-ready' | 'missing' | 'unavailable'
  activity: BackgroundResultActivityItem
  outcome?: BackgroundResultPromptOutcome
}>

type NotebookSourceGroup = Readonly<{
  projectId: string
  sessionId: string
  sources: readonly BackgroundResultDelivery[]
}>

type BackgroundResultSourceResolverDeps = Readonly<{
  loadNotebookRuns(group: NotebookSourceGroup): Promise<readonly NotebookRunRecord[]>
  loadComputeJobs(
    sources: readonly BackgroundResultDelivery[]
  ): Promise<ReadonlyMap<string, JobSummary>>
}>

const truncate = (value: string): string =>
  value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}…`

const activityBase = (delivery: BackgroundResultDelivery): BackgroundResultActivityItem => ({
  id: delivery.id,
  sourceKind: delivery.sourceKind,
  sourceId: delivery.sourceId,
  projectId: delivery.projectId,
  sessionId: delivery.sessionId,
  ...(delivery.agentFrameId ? { agentFrameId: delivery.agentFrameId } : {}),
  active: delivery.state === 'waiting-result',
  needsAttention: delivery.state === 'needs-attention',
  updatedAt: delivery.updatedAt
})

const notebookSummary = (run: NotebookRunRecord): string =>
  truncate(
    [
      run.exitCode === undefined ? undefined : `exitCode: ${String(run.exitCode)}`,
      run.text.stdout.trim() ? `stdout:\n${run.text.stdout.trim()}` : undefined,
      run.text.stderr.trim() ? `stderr:\n${run.text.stderr.trim()}` : undefined,
      run.text.traceback.trim() ? `traceback:\n${run.text.traceback.trim()}` : undefined
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n\n') || `Run ended with status ${run.status}.`
  )

const notebookErrorGuidance = (run: NotebookRunRecord): string | undefined => {
  if (run.status === 'completed') return undefined
  if (run.status === 'cancelled')
    return 'The Run was cancelled. Decide whether any follow-up is needed.'
  if (run.status === 'timeout')
    return 'The Run timed out. Inspect its output before deciding whether to run new work.'
  if (run.status === 'interrupted')
    return 'The Run was interrupted. Inspect its durable output and runtime state before continuing.'
  return 'The Run failed. Inspect its durable error and decide the next step; do not assume it should be rerun.'
}

const notebookPresentation = (
  run: NotebookRunRecord
): Readonly<{
  executionType: Exclude<BackgroundResultExecutionType, 'compute-job'>
  lane: string
}> => ({
  executionType: run.kernelKind === 'bash' ? 'shell' : run.kernelKind,
  lane:
    run.kernelKind === 'repl'
      ? 'project-control'
      : run.kernelKind === 'bash'
        ? run.shellConcurrency?.slot
          ? `${run.shellConcurrency.slot}/${run.shellConcurrency.limit}`
          : 'shell'
        : (run.environment ?? (run.kernelKind === 'r' ? 'R' : 'Python'))
})

const mapNotebookSource = (
  delivery: BackgroundResultDelivery,
  run: NotebookRunRecord | undefined
): ResolvedBackgroundResultSource => {
  const base = activityBase(delivery)
  if (!run) return { delivery, availability: 'missing', activity: base }
  const presentation = notebookPresentation(run)
  const active = run.status === 'queued' || run.status === 'running'
  const activity: BackgroundResultActivityItem = {
    ...base,
    ...presentation,
    status: active
      ? run.status
      : delivery.state === 'needs-attention'
        ? 'needs-attention'
        : delivery.state === 'waiting-result'
          ? run.status
          : 'pending-delivery',
    active,
    ...(!active ? { outcomeStatus: run.status } : {})
  }
  if (run.executionMode !== 'background' || active) {
    return { delivery, availability: 'not-ready', activity }
  }
  const workingFiles = run.workingFiles.slice(0, WORKING_FILE_LIMIT).map((file) => ({
    relativePath: file.relativePath,
    ...(file.size === undefined ? {} : { size: file.size }),
    ...(file.createdByRunId ? { createdByRunId: file.createdByRunId } : {})
  }))
  const provenance = {
    ...(run.messageBranchId ? { messageBranchId: run.messageBranchId } : {}),
    ...(run.runtimeSegmentId ? { runtimeSegmentId: run.runtimeSegmentId } : {}),
    ...(run.promptMessageId ? { promptMessageId: run.promptMessageId } : {}),
    ...(run.executionInvocationId ? { executionInvocationId: run.executionInvocationId } : {})
  }
  return {
    delivery,
    availability: 'terminal',
    activity,
    outcome: {
      sourceKind: 'local-run',
      runId: run.runId,
      executionType: presentation.executionType,
      terminalStatus: run.status,
      resultSummary: notebookSummary(run),
      ...(notebookErrorGuidance(run) ? { errorGuidance: notebookErrorGuidance(run) } : {}),
      sessionId: delivery.sessionId,
      ...(delivery.agentFrameId ? { agentFrameId: delivery.agentFrameId } : {}),
      ...(workingFiles.length > 0 ? { workingFiles } : {}),
      ...(Object.keys(provenance).length > 0 ? { provenance } : {})
    }
  }
}

const computeTerminalStatus = (job: JobSummary): string =>
  job.cancellation_status === 'cancelled' ? 'cancelled' : job.status

const computeSummary = (job: JobSummary): string =>
  truncate(
    [
      `Compute Job ${job.job_id} ended with status ${computeTerminalStatus(job)} on ${job.display_name}.`,
      job.exit_code === undefined ? undefined : `exitCode: ${String(job.exit_code)}`,
      job.stdout_tail?.trim() ? `stdout:\n${job.stdout_tail.trim()}` : undefined,
      job.stderr_tail?.trim() ? `stderr:\n${job.stderr_tail.trim()}` : undefined,
      job.featured_files?.length
        ? `featured files:\n${job.featured_files.join('\n')}`
        : 'featured files: none',
      job.harvest_error ? `harvest error: ${job.harvest_error}` : undefined,
      job.left_on_remote?.length
        ? `left on remote:\n${job.left_on_remote.map(({ uri, reason }) => `${uri} (${reason})`).join('\n')}`
        : undefined
    ]
      .filter((part): part is string => part !== undefined)
      .join('\n\n')
  )

const computeErrorGuidance = (job: JobSummary): string | undefined => {
  if (job.cancellation_status === 'cancelled')
    return 'The remote Compute Job was cancelled. Decide whether any follow-up is needed.'
  if (job.status === 'success' && !job.harvest_error) return undefined
  if (job.harvest_error)
    return 'Result harvesting was incomplete. Inspect featured files, files left on the remote Host, and the harvest error before continuing.'
  if (job.status === 'timeout')
    return 'The remote Compute Job timed out. Inspect its durable output before deciding whether to submit new work.'
  return 'The remote Compute Job failed. Inspect its durable output and remote work directory; do not assume it should be resubmitted.'
}

const mapComputeSource = (
  delivery: BackgroundResultDelivery,
  job: JobSummary | undefined
): ResolvedBackgroundResultSource => {
  const base = activityBase(delivery)
  if (!job) return { delivery, availability: 'missing', activity: base }
  const active = job.status === 'queued' || job.status === 'submitted' || job.status === 'running'
  const terminalStatus = computeTerminalStatus(job)
  const activity: BackgroundResultActivityItem = {
    ...base,
    executionType: 'compute-job',
    title: job.intent,
    lane: job.display_name,
    status: active
      ? job.status
      : delivery.state === 'needs-attention'
        ? 'needs-attention'
        : delivery.state === 'waiting-result'
          ? (terminalStatus as BackgroundResultActivityItem['status'])
          : 'pending-delivery',
    active,
    ...(!active
      ? { outcomeStatus: terminalStatus as BackgroundResultActivityItem['outcomeStatus'] }
      : {})
  }
  if (
    active ||
    (job.status !== 'error' && job.harvested_at === undefined && job.notified_at === undefined)
  ) {
    return { delivery, availability: 'not-ready', activity }
  }
  return {
    delivery,
    availability: 'terminal',
    activity,
    outcome: {
      sourceKind: 'compute-job',
      jobId: job.job_id,
      executionType: 'compute-job',
      terminalStatus,
      resultSummary: computeSummary(job),
      ...(computeErrorGuidance(job) ? { errorGuidance: computeErrorGuidance(job) } : {}),
      sessionId: delivery.sessionId,
      computeHost: { providerId: job.provider_id, displayName: job.display_name },
      ...(job.remote_workdir ? { remoteWorkdir: job.remote_workdir } : {}),
      featuredFiles: job.featured_files ?? [],
      leftOnRemote: job.left_on_remote ?? [],
      ...(job.harvest_error ? { harvestError: job.harvest_error } : {})
    }
  }
}

const unavailable = (delivery: BackgroundResultDelivery): ResolvedBackgroundResultSource => ({
  delivery,
  availability: 'unavailable',
  activity: activityBase(delivery)
})

const resolveBackgroundResultSources = async (
  deliveries: readonly BackgroundResultDelivery[],
  deps: BackgroundResultSourceResolverDeps
): Promise<ResolvedBackgroundResultSource[]> => {
  const resolved = new Map<string, ResolvedBackgroundResultSource>()
  const notebookGroups = new Map<string, BackgroundResultDelivery[]>()
  for (const delivery of deliveries.filter(({ sourceKind }) => sourceKind === 'local-run')) {
    const key = `${delivery.projectId}\0${delivery.sessionId}`
    const group = notebookGroups.get(key) ?? []
    group.push(delivery)
    notebookGroups.set(key, group)
  }
  const notebookBatches = [...notebookGroups.values()].flatMap((sources) =>
    Array.from({ length: Math.ceil(sources.length / NOTEBOOK_SOURCE_BATCH_LIMIT) }, (_, index) =>
      sources.slice(index * NOTEBOOK_SOURCE_BATCH_LIMIT, (index + 1) * NOTEBOOK_SOURCE_BATCH_LIMIT)
    )
  )
  await Promise.all(
    notebookBatches.map(async (sources) => {
      try {
        const runs = await deps.loadNotebookRuns({
          projectId: sources[0]!.projectId,
          sessionId: sources[0]!.sessionId,
          sources
        })
        for (const source of sources) {
          const run = runs.find(
            (candidate) =>
              candidate.runId === source.sourceId &&
              (!source.agentFrameId || candidate.agentFrameId === source.agentFrameId)
          )
          resolved.set(source.id, mapNotebookSource(source, run))
        }
      } catch {
        for (const source of sources) resolved.set(source.id, unavailable(source))
      }
    })
  )
  const compute = deliveries.filter(({ sourceKind }) => sourceKind === 'compute-job')
  if (compute.length > 0) {
    try {
      const jobs = await deps.loadComputeJobs(compute)
      for (const source of compute)
        resolved.set(source.id, mapComputeSource(source, jobs.get(source.sourceId)))
    } catch {
      for (const source of compute) resolved.set(source.id, unavailable(source))
    }
  }
  return deliveries.map((delivery) => resolved.get(delivery.id) ?? unavailable(delivery))
}

export { mapComputeSource, mapNotebookSource, resolveBackgroundResultSources }
export type {
  BackgroundResultPromptOutcome,
  BackgroundResultSourceResolverDeps,
  NotebookSourceGroup,
  ResolvedBackgroundResultSource
}

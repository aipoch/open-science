// Analysis turn trigger — pure renderer logic (design §11).
//
// Receives done-state job broadcasts (notified_at set, notification_consumed_at null) and
// auto-fires a sendPrompt for each affected session. Key behaviors:
//  - Batch: multiple done jobs for the same session in one microtask tick → one prompt.
//  - Queue: session in flight → register onTurnEnd callback, fire after the turn finishes.
//  - Idempotent: jobs with notification_consumed_at set are skipped; in-flight job ids are
//    tracked in a memory Set so duplicate broadcasts don't re-queue.
//  - markConsumed only on successful sendPrompt (failure → retry on next broadcast).
//  - Cross-session isolation: prompt goes to job.session_id.

import type { ComputeSessionOwner, JobSummary } from '../../../../shared/compute'

// Prompt text shown as the user message that kicks off the analysis turn. English per CLAUDE.md.
export const buildAnalysisPrompt = (jobs: JobSummary[]): string => {
  const lines: string[] = [
    `${jobs.length === 1 ? 'A remote job has' : `${jobs.length} remote jobs have`} finished. Please analyze the results.`,
    ''
  ]

  for (const job of jobs) {
    lines.push(`## Job: ${job.job_id}`)
    lines.push(`Status: ${job.status}`)

    if (job.featured_files && job.featured_files.length > 0) {
      lines.push(`Featured output files (workspace-relative paths):`)
      for (const f of job.featured_files) {
        lines.push(`  - ${f}`)
      }
    } else {
      lines.push(`No featured output files (harvest may have been incomplete).`)
    }

    if (job.left_on_remote_count && job.left_on_remote_count > 0) {
      lines.push(
        `Note: ${job.left_on_remote_count} file(s) left on the remote host (too large or marked residency:remote).`
      )
    }

    lines.push('')
    lines.push(
      `Please use \`attachJob("${job.job_id}").result()\` to retrieve the full result dictionary, ` +
        `examine the output files, and call \`write_artifact_file\` to publish any results worth preserving.`
    )

    if (job.status === 'failed' || job.status === 'timeout') {
      lines.push(
        `Note: the job exited with a non-zero status. Harvest completed but the remote workdir has been kept for inspection.`
      )
    }

    lines.push('')
  }

  return lines.join('\n').trim()
}

// Injected dependencies so the trigger is fully testable without React or Electron.
export type JobAnalysisTriggerDeps = {
  // Returns false when a bare runtime session id is ambiguous across projects.
  canAddressOwner: (owner: ComputeSessionOwner) => boolean
  // Returns true if the given session currently has a prompt in flight (ACP single-in-flight guard).
  isSessionInFlight: (owner: ComputeSessionOwner) => boolean
  // Sends a prompt to a session; resolves to a result object on success or undefined on failure.
  sendPrompt: (
    owner: ComputeSessionOwner,
    text: string
  ) => Promise<{ sessionId: string; messageId: string } | undefined>
  // Persists notificationConsumedAt for the given job ids (IPC to main process).
  markConsumed: (owner: ComputeSessionOwner, jobIds: string[]) => Promise<void>
  // Registers a one-shot callback for when the given session's turn finishes (idle transition).
  onTurnEnd: (owner: ComputeSessionOwner, callback: () => void) => void
  // Structured logger; receives a tag and a detail message for observability.
  log: (tag: string, message: string) => void
}

type PendingBatch = {
  owner: ComputeSessionOwner
  // jobs waiting to be sent once the session is free
  jobs: Map<string, JobSummary>
  // whether we've already registered an onTurnEnd callback for this session
  waitRegistered: boolean
}

type InFlightSet = Set<string> // job_id values currently being processed (in analysis turn or queued)

// Factory that creates a stateful trigger object. Call trigger.onJobDone(job) for each
// compute:job-updated broadcast where notified_at is set.
export type JobAnalysisTrigger = {
  // Process a new done-state job broadcast.
  onJobDone: (job: JobSummary) => void
  // Notify the trigger that a session's turn has ended (called by the turn-end listener).
  // Exposed separately so hook integration can wire this without coupling to onTurnEnd dep.
  _notifyTurnEnd: (owner: ComputeSessionOwner) => void
}

export const createJobAnalysisTrigger = (deps: JobAnalysisTriggerDeps): JobAnalysisTrigger => {
  // Per-session queue of jobs pending analysis.
  const pendingBySession = new Map<string, PendingBatch>()
  // job_ids currently in flight (sendPrompt sent, markConsumed not yet called).
  const inFlight: InFlightSet = new Set()
  // Track jobs waiting for turn completion (dispatch sent, not yet consumed).
  const awaitingTurnEnd = new Map<string, string[]>() // sessionId -> jobIds[]

  const ownerKey = (owner: ComputeSessionOwner): string =>
    JSON.stringify([owner.projectId, owner.sessionId])
  const ownerLabel = (owner: ComputeSessionOwner): string =>
    `project=${owner.projectId} session=${owner.sessionId}`
  const isDoneState = (job: JobSummary): boolean =>
    job.notified_at !== undefined && job.notified_at !== null

  const isAlreadyConsumed = (job: JobSummary): boolean =>
    job.notification_consumed_at !== undefined && job.notification_consumed_at !== null

  // Attempts to send the batched analysis prompt for a session immediately.
  const flushSession = async (key: string): Promise<void> => {
    const batch = pendingBySession.get(key)
    if (!batch || batch.jobs.size === 0) return
    const { owner } = batch

    const jobsToSend = Array.from(batch.jobs.values())
    const jobIds = jobsToSend.map((j) => j.job_id)

    // Mark in-flight so duplicate broadcasts are ignored.
    for (const id of jobIds) inFlight.add(id)

    // Clear the pending queue for this session.
    pendingBySession.delete(key)

    deps.log('analysis-turn:sending', `${ownerLabel(owner)} jobs=[${jobIds.join(',')}]`)

    const prompt = buildAnalysisPrompt(jobsToSend)

    let result: Awaited<ReturnType<typeof deps.sendPrompt>>

    try {
      result = await deps.sendPrompt(owner, prompt)
    } catch (err) {
      deps.log('analysis-turn:send-failed', `${ownerLabel(owner)} error=${String(err)}`)
      // Don't mark consumed — will retry on next broadcast.
      for (const id of jobIds) inFlight.delete(id)
      return
    }

    if (!result) {
      deps.log('analysis-turn:send-returned-undefined', ownerLabel(owner))
      for (const id of jobIds) inFlight.delete(id)
      return
    }

    deps.log('analysis-turn:sent', `${ownerLabel(owner)} jobs=[${jobIds.join(',')}]`)

    // Register these jobs as awaiting turn completion. Mark consumed only when turn ends idle.
    awaitingTurnEnd.set(key, jobIds)

    // Register onTurnEnd callback to mark consumed when turn truly completes (fix issue #3).
    if (!batch.waitRegistered) {
      batch.waitRegistered = true
      deps.onTurnEnd(owner, () => onTurnEndCallback(owner))
    }
  }

  // Called when a turn ends. Marks jobs consumed if the session is now idle.
  const onTurnEndCallback = async (owner: ComputeSessionOwner): Promise<void> => {
    const key = ownerKey(owner)
    const jobIds = awaitingTurnEnd.get(key)
    if (!jobIds || jobIds.length === 0) return

    // If session is still in-flight, another turn started — wait for the next onTurnEnd.
    if (deps.isSessionInFlight(owner)) {
      deps.log('analysis-turn:requeued-consumed', `${ownerLabel(owner)} still-in-flight`)
      deps.onTurnEnd(owner, () => onTurnEndCallback(owner))
      return
    }

    // Session is now idle — mark these jobs as consumed.
    awaitingTurnEnd.delete(key)

    try {
      await deps.markConsumed(owner, jobIds)
      deps.log('analysis-turn:consumed', `${ownerLabel(owner)} jobs=[${jobIds.join(',')}]`)
    } catch (err) {
      deps.log('analysis-turn:mark-consumed-failed', `${ownerLabel(owner)} error=${String(err)}`)
    } finally {
      // Clear in-flight markers now that we've attempted to mark consumed.
      for (const id of jobIds) inFlight.delete(id)
    }
  }

  const scheduleFlush = (owner: ComputeSessionOwner): void => {
    // Use a microtask to batch multiple synchronous onJobDone calls.
    const key = ownerKey(owner)
    void Promise.resolve().then(() => flushSession(key))
  }

  const notifyTurnEnd = (owner: ComputeSessionOwner): void => {
    const key = ownerKey(owner)
    const batch = pendingBySession.get(key)
    if (!batch || batch.jobs.size === 0) return

    // Reset waitRegistered so a new callback can be registered if needed.
    batch.waitRegistered = false

    if (deps.isSessionInFlight(owner)) {
      // Another turn started; re-register.
      if (!batch.waitRegistered) {
        batch.waitRegistered = true
        deps.onTurnEnd(owner, () => notifyTurnEnd(owner))
        deps.log('analysis-turn:requeued', `${ownerLabel(owner)} still-in-flight`)
      }
      return
    }

    scheduleFlush(owner)
  }

  const onJobDone = (job: JobSummary): void => {
    if (!isDoneState(job)) return
    if (isAlreadyConsumed(job)) return
    if (inFlight.has(job.job_id)) return

    const owner = { projectId: job.project_id, sessionId: job.session_id }
    const jobId = job.job_id
    if (!deps.canAddressOwner(owner)) {
      deps.log('analysis-turn:ambiguous-owner', ownerLabel(owner))
      return
    }
    const key = ownerKey(owner)

    let batch = pendingBySession.get(key)

    if (!batch) {
      batch = { owner, jobs: new Map(), waitRegistered: false }
      pendingBySession.set(key, batch)
    }

    if (batch.jobs.has(jobId)) return // already queued for this session

    batch.jobs.set(jobId, job)

    deps.log('analysis-turn:queued', `${ownerLabel(owner)} job=${jobId}`)

    if (deps.isSessionInFlight(owner)) {
      // Session has a turn running — wait for it to finish.
      if (!batch.waitRegistered) {
        batch.waitRegistered = true
        deps.onTurnEnd(owner, () => notifyTurnEnd(owner))
        deps.log('analysis-turn:waiting-for-turn-end', `${ownerLabel(owner)} job=${jobId}`)
      }
      return
    }

    // Session is idle — flush on next microtask (allows batching of same-tick arrivals).
    scheduleFlush(owner)
  }

  return { onJobDone, _notifyTurnEnd: notifyTurnEnd }
}

// Analysis turn trigger — pure renderer logic (design §11).
//
// Receives done-state job broadcasts (notified_at set, notification_consumed_at null) and
// auto-fires a sendPrompt for each affected session. Key behaviors:
//  - Batch: multiple done jobs for the same session in one microtask tick → one prompt.
//  - Queue: session in flight → register onTurnEnd callback, fire after the turn finishes.
//  - Durable lifecycle: pending jobs are claimed with a stable Message ID, then settled from the
//    actual analysis turn outcome. Recovered dispatches reconcile against persisted Session state.
//  - Idempotent: terminal jobs are skipped; in-flight job ids suppress duplicate broadcasts.
//  - Cross-session isolation: prompt goes to job.session_id.

import type {
  ComputeJobAnalysisState,
  ComputeJobAnalysisTransition,
  JobSummary
} from '../../../../shared/compute'

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
  // Returns true if the given session currently has a prompt in flight (ACP single-in-flight guard).
  isSessionInFlight: (sessionId: string) => boolean
  // Sends a prompt to a session; resolves to a result object on success or undefined on failure.
  sendPrompt: (
    sessionId: string,
    text: string,
    messageId: string
  ) => Promise<{ sessionId: string; messageId: string } | undefined>
  createMessageId: () => string
  transitionAnalysis: (request: ComputeJobAnalysisTransition) => Promise<void>
  getTurnState: (
    sessionId: string,
    messageId: string
  ) =>
    | 'missing'
    | 'running'
    | Exclude<ComputeJobAnalysisState, 'dispatched'>
    | Promise<'missing' | 'running' | Exclude<ComputeJobAnalysisState, 'dispatched'>>
  // Registers a one-shot callback for when the given session's turn reaches a terminal state.
  onTurnEnd: (
    sessionId: string,
    callback: (outcome: Exclude<ComputeJobAnalysisState, 'dispatched'>) => void
  ) => void
  // Structured logger; receives a tag and a detail message for observability.
  log: (tag: string, message: string) => void
}

type PendingBatch = {
  sessionId: string
  messageId?: string
  // The Message ID is chosen, but its durable dispatched transition may not have committed yet.
  claimPending?: boolean
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
  // Stop delayed claim retries when the owning readiness lifecycle ends.
  dispose: () => void
}

export const createJobAnalysisTrigger = (deps: JobAnalysisTriggerDeps): JobAnalysisTrigger => {
  const transitionRetryDelayMs = 1_000
  let disposed = false
  // Pending jobs are grouped by a durable dispatch Message ID when recovering, or by Session before
  // the first dispatch is claimed. This prevents a recovered batch from absorbing newer pending Jobs.
  const pendingBatches = new Map<string, PendingBatch>()
  // ACP permits only one turn per Session. Keep recovered and newly pending batches behind the same
  // Session-level lock even though they have different durable batch keys.
  const activeBatchBySession = new Map<string, PendingBatch>()
  // job_ids currently queued, dispatching, or awaiting a durable terminal transition.
  const inFlight: InFlightSet = new Set()
  // Track jobs waiting for turn completion (dispatch sent, not yet consumed).
  const awaitingTurnEnd = new Map<
    string,
    { batch: PendingBatch; sessionId: string; messageId: string; jobIds: string[] }
  >()
  const claimRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const settlementRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const scheduleClaimRetry = (key: string): void => {
    if (disposed || claimRetryTimers.has(key)) return
    const timer = setTimeout(() => {
      claimRetryTimers.delete(key)
      scheduleFlush(key)
    }, transitionRetryDelayMs)
    claimRetryTimers.set(key, timer)
  }

  const scheduleSettlementRetry = (key: string, retry: () => void): void => {
    if (disposed || settlementRetryTimers.has(key)) return
    const timer = setTimeout(() => {
      settlementRetryTimers.delete(key)
      if (!disposed) retry()
    }, transitionRetryDelayMs)
    settlementRetryTimers.set(key, timer)
  }

  const scheduleNextSessionBatch = (sessionId: string): void => {
    for (const [nextKey, nextBatch] of pendingBatches) {
      if (nextBatch.sessionId !== sessionId) continue
      scheduleFlush(nextKey)
      return
    }
  }

  const releaseSessionBatch = (batch: PendingBatch, sessionId: string): void => {
    if (activeBatchBySession.get(sessionId) !== batch) return
    activeBatchBySession.delete(sessionId)
    scheduleNextSessionBatch(sessionId)
  }

  const mergeQueuedJobs = (key: string, batch: PendingBatch): void => {
    const queued = pendingBatches.get(key)
    if (!queued || queued === batch) return
    for (const [jobId, job] of queued.jobs) batch.jobs.set(jobId, job)
  }

  const isDoneState = (job: JobSummary): boolean =>
    job.notified_at !== undefined && job.notified_at !== null

  const isAlreadyConsumed = (job: JobSummary): boolean =>
    job.notification_consumed_at !== undefined && job.notification_consumed_at !== null

  // Attempts to send the batched analysis prompt for a session immediately.
  const settle = async (
    key: string,
    batch: PendingBatch,
    sessionId: string,
    messageId: string,
    jobIds: string[],
    state: Exclude<ComputeJobAnalysisState, 'dispatched'>
  ): Promise<void> => {
    try {
      await deps.transitionAnalysis({ sessionId, jobIds, messageId, state })
      deps.log('analysis-turn:settled', `session=${sessionId} state=${state}`)
    } catch (err) {
      deps.log('analysis-turn:settle-failed', `session=${sessionId} error=${String(err)}`)
      scheduleSettlementRetry(key, () => {
        void settle(key, batch, sessionId, messageId, jobIds, state)
      })
      return
    }
    awaitingTurnEnd.delete(key)
    for (const id of jobIds) inFlight.delete(id)
    releaseSessionBatch(batch, sessionId)
  }

  const onTurnEndCallback = async (
    key: string,
    outcome: Exclude<ComputeJobAnalysisState, 'dispatched'>
  ): Promise<void> => {
    const awaiting = awaitingTurnEnd.get(key)
    if (!awaiting) return
    if (deps.isSessionInFlight(awaiting.sessionId)) {
      deps.onTurnEnd(awaiting.sessionId, (nextOutcome) => void onTurnEndCallback(key, nextOutcome))
      return
    }
    await settle(
      key,
      awaiting.batch,
      awaiting.sessionId,
      awaiting.messageId,
      awaiting.jobIds,
      outcome
    )
  }

  const waitForAnalysisTurn = (
    key: string,
    batch: PendingBatch,
    sessionId: string,
    messageId: string,
    jobIds: string[]
  ): void => {
    awaitingTurnEnd.set(key, { batch, sessionId, messageId, jobIds })
    deps.onTurnEnd(sessionId, (outcome) => void onTurnEndCallback(key, outcome))
  }

  const flushBatch = async (key: string): Promise<void> => {
    if (disposed) return
    const batch = pendingBatches.get(key)
    if (!batch || batch.jobs.size === 0) return

    const jobsToSend = Array.from(batch.jobs.values())
    const jobIds = jobsToSend.map((j) => j.job_id)
    const { sessionId } = batch

    const activeBatch = activeBatchBySession.get(sessionId)
    if (activeBatch && activeBatch !== batch) {
      deps.log('analysis-turn:serialized', `session=${sessionId}`)
      return
    }

    // The Session may have started a turn after onJobDone scheduled this microtask.
    if (deps.isSessionInFlight(sessionId)) {
      if (!batch.waitRegistered) {
        batch.waitRegistered = true
        deps.onTurnEnd(sessionId, () => notifyTurnEnd(key))
        deps.log('analysis-turn:waiting-for-turn-end', `session=${sessionId}`)
      }
      return
    }

    activeBatchBySession.set(sessionId, batch)

    // Mark in-flight so duplicate broadcasts are ignored.
    for (const id of jobIds) inFlight.add(id)

    // Clear the pending queue for this session.
    pendingBatches.delete(key)

    const messageId = batch.messageId ?? deps.createMessageId()
    if (batch.messageId && !batch.claimPending) {
      let recoveredState: Awaited<ReturnType<typeof deps.getTurnState>>
      try {
        recoveredState = await deps.getTurnState(sessionId, messageId)
      } catch (err) {
        deps.log('analysis-turn:reconcile-failed', `session=${sessionId} error=${String(err)}`)
        await settle(key, batch, sessionId, messageId, jobIds, 'failed')
        return
      }
      if (recoveredState !== 'missing' && recoveredState !== 'running') {
        await settle(key, batch, sessionId, messageId, jobIds, recoveredState)
        return
      }
      if (recoveredState === 'running') {
        waitForAnalysisTurn(key, batch, sessionId, messageId, jobIds)
        return
      }
    } else {
      try {
        await deps.transitionAnalysis({ sessionId, jobIds, messageId, state: 'dispatched' })
        batch.claimPending = false
      } catch (err) {
        deps.log('analysis-turn:claim-failed', `session=${sessionId} error=${String(err)}`)
        // The transition may have committed before its response was lost. Retain the same Message
        // ID and retry the idempotent durable claim before sending anything.
        batch.messageId = messageId
        batch.claimPending = true
        mergeQueuedJobs(key, batch)
        pendingBatches.set(key, batch)
        scheduleClaimRetry(key)
        return
      }
    }

    // Claiming is asynchronous. A user turn can start while the durable transition is being saved,
    // so keep the claimed batch queued until the Session is idle instead of failing the send.
    if (deps.isSessionInFlight(sessionId)) {
      batch.messageId = messageId
      batch.waitRegistered = true
      const dispatchedKey = `${sessionId}\u0000${messageId}`
      pendingBatches.set(dispatchedKey, batch)
      deps.onTurnEnd(sessionId, () => notifyTurnEnd(dispatchedKey))
      deps.log('analysis-turn:waiting-for-turn-end', `session=${sessionId}`)
      return
    }

    deps.log('analysis-turn:sending', `session=${sessionId} jobs=[${jobIds.join(',')}]`)

    const prompt = buildAnalysisPrompt(jobsToSend)

    let result: Awaited<ReturnType<typeof deps.sendPrompt>>

    try {
      result = await deps.sendPrompt(sessionId, prompt, messageId)
    } catch (err) {
      deps.log('analysis-turn:send-failed', `session=${sessionId} error=${String(err)}`)
      await settle(key, batch, sessionId, messageId, jobIds, 'failed')
      return
    }

    if (!result || result.messageId !== messageId) {
      deps.log('analysis-turn:send-returned-undefined', `session=${sessionId}`)
      await settle(key, batch, sessionId, messageId, jobIds, 'failed')
      return
    }

    deps.log('analysis-turn:sent', `session=${sessionId} jobs=[${jobIds.join(',')}]`)

    // Register these jobs as awaiting turn completion. Only a succeeded transition consumes them.
    waitForAnalysisTurn(key, batch, sessionId, messageId, jobIds)
  }

  const scheduleFlush = (key: string): void => {
    if (disposed) return
    // Use a microtask to batch multiple synchronous onJobDone calls.
    void Promise.resolve().then(() => flushBatch(key))
  }

  const notifyTurnEnd = (key: string): void => {
    if (disposed) return
    const batch = pendingBatches.get(key)
    if (!batch || batch.jobs.size === 0) return

    // Reset waitRegistered so a new callback can be registered if needed.
    batch.waitRegistered = false

    if (deps.isSessionInFlight(batch.sessionId)) {
      // Another turn started; re-register.
      if (!batch.waitRegistered) {
        batch.waitRegistered = true
        deps.onTurnEnd(batch.sessionId, () => notifyTurnEnd(key))
        deps.log('analysis-turn:requeued', `session=${batch.sessionId} still-in-flight`)
      }
      return
    }

    scheduleFlush(key)
  }

  const onJobDone = (job: JobSummary): void => {
    if (disposed) return
    if (!isDoneState(job)) return
    if (isAlreadyConsumed(job)) return
    if (job.analysis_state === 'succeeded') return
    if (job.analysis_state === 'failed' || job.analysis_state === 'cancelled') return
    if (inFlight.has(job.job_id)) return

    const { session_id: sessionId, job_id: jobId } = job
    const messageId = job.analysis_state === 'dispatched' ? job.analysis_message_id : undefined
    if (job.analysis_state === 'dispatched' && !messageId) {
      deps.log('analysis-turn:invalid-dispatch', `session=${sessionId} job=${jobId}`)
      return
    }
    const key = messageId ? `${sessionId}\u0000${messageId}` : `${sessionId}\u0000pending`

    let batch = pendingBatches.get(key)

    if (!batch) {
      batch = { sessionId, messageId, jobs: new Map(), waitRegistered: false }
      pendingBatches.set(key, batch)
    }

    if (batch.jobs.has(jobId)) return // already queued for this session

    batch.jobs.set(jobId, job)

    deps.log('analysis-turn:queued', `session=${sessionId} job=${jobId}`)

    if (deps.isSessionInFlight(sessionId)) {
      // Session has a turn running — wait for it to finish.
      if (!batch.waitRegistered) {
        batch.waitRegistered = true
        deps.onTurnEnd(sessionId, () => notifyTurnEnd(key))
        deps.log('analysis-turn:waiting-for-turn-end', `session=${sessionId} job=${jobId}`)
      }
      return
    }

    // Session is idle — flush on next microtask (allows batching of same-tick arrivals).
    scheduleFlush(key)
  }

  const dispose = (): void => {
    disposed = true
    for (const timer of claimRetryTimers.values()) clearTimeout(timer)
    claimRetryTimers.clear()
    for (const timer of settlementRetryTimers.values()) clearTimeout(timer)
    settlementRetryTimers.clear()
    pendingBatches.clear()
    awaitingTurnEnd.clear()
    activeBatchBySession.clear()
    inFlight.clear()
  }

  return { onJobDone, dispose }
}

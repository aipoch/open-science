import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { flushLogs, initLogger } from '@aipoch/diagnostics/node'
import {
  createComputeExecution,
  createScpRunner,
  createSshRunner,
  quoteRemotePath,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from '@aipoch/compute/node'
import type { JobSummary } from '../../shared/compute'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeService } from './compute-service'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { ComputeHostRepository } from './repository'
import { emitJobNotification } from './job-notifier'

// Explicitly opt in: these tests await actual controller record eviction.
// They do not change Slurm configuration, command results, or application command timeouts.
const alias = process.env.COMPUTE_TEST_SSH_ALIAS ?? ''
const enabled = process.env.RUN_COMPUTE_SLURM_RETENTION === '1' && alias !== ''
const partition = process.env.COMPUTE_SLURM_PARTITION ?? 'debug'
const evidenceRoot = resolve(process.env.COMPUTE_SLURM_EVIDENCE_DIR ?? '.scratch/slurm-reliability')
type RunResult = Awaited<ReturnType<ComputeConnectionLease['run']>>
type FixtureJob = { jobId: string; schedulerId: string; workdir: string }
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((done) => setTimeout(done, milliseconds))
const validResult = (result: RunResult): boolean =>
  !result.timedOut &&
  !result.truncated &&
  !result.stdoutTruncated &&
  !result.stderrTruncated &&
  result.exitCode !== null &&
  result.exitCode !== 255
const missingId = (result: RunResult): boolean =>
  validResult(result) &&
  result.exitCode === 1 &&
  !result.stdout.trim() &&
  /invalid job id specified/i.test(result.stderr)
const noQueueRecord = (result: RunResult): boolean =>
  validResult(result) && !result.stdout.trim() && (result.exitCode === 0 || missingId(result))
const noControllerRecord = (result: RunResult): boolean =>
  missingId(result) ||
  (validResult(result) &&
    result.exitCode === 0 &&
    /^\s*No jobs? in the system\s*$/i.test(result.stdout))
const terminalControllerRecord = (result: RunResult): boolean =>
  validResult(result) &&
  result.exitCode === 0 &&
  /JobState=(?:COMPLETED|CANCELLED|FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE)\b/.test(
    result.stdout
  )
const stoppedQueueRecord = (result: RunResult, schedulerId: string): boolean =>
  noQueueRecord(result) ||
  (validResult(result) &&
    result.exitCode === 0 &&
    result.stdout
      .trim()
      .split(/\r?\n/)
      .every((line) => {
        const [id, state] = line.split('|')
        return (
          id === schedulerId &&
          /^(?:COMPLETED|CANCELLED|FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE)\+?$/.test(
            state ?? ''
          )
        )
      }))

describe.skipIf(!enabled)('Slurm record retention on real SSH + scheduler', () => {
  const runId = randomUUID()
  const scope = { providerId: `ssh:${alias}`, projectId: 'slurm-retention-cert', sessionId: runId }
  const execution = createComputeExecution()
  const jobs: FixtureJob[] = []
  const preserveForAgent = new Set<string>()
  const actualScancelResults = new Map<string, RunResult>()
  const tracePath = join(evidenceRoot, `retention-${runId}.jsonl`)
  let db: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
  let hosts: ComputeHostRepository
  let broker: SshConfigComputeConnectionBroker
  let service: ComputeService
  let backgroundCancellation: Promise<boolean> | undefined
  const pollers: Array<ReturnType<typeof execution.createPoller>> = []
  let stopWaiting = false
  let evidenceWrites = Promise.resolve()
  const evidence = (kind: string, facts: Record<string, unknown>): Promise<void> => {
    const entry = JSON.stringify({ at: new Date().toISOString(), kind, ...facts }) + '\n'
    evidenceWrites = evidenceWrites.then(() => appendFile(tracePath, entry, 'utf8'))
    return evidenceWrites
  }
  const remote = async (command: string, purpose: string): Promise<RunResult> => {
    const connection = await broker.acquire(scope.providerId, { intent: 'job_poll' })
    const result = await connection.run(command, {
      timeoutMs: 30_000,
      loginShell: true,
      preserveRemoteCommandErrors: true,
      maxOutputBytes: 16 * 1024
    })
    await evidence('independent-server-query', { purpose, command, result })
    return result
  }
  const scheduler = async (
    job: FixtureJob
  ): Promise<{ queue: RunResult; controller: RunResult }> => {
    const queue = await remote(
      `squeue --noheader --states=all -j ${job.schedulerId} --format='%i|%T|%r'`,
      `independent queue record for ${job.jobId}`
    )
    const controller = await remote(
      `scontrol show job ${job.schedulerId} --oneliner`,
      `independent controller record for ${job.jobId}`
    )
    return { queue, controller }
  }
  const awaitServerState = async (job: FixtureJob, state: string): Promise<void> => {
    // Scheduler contention may delay a submitted test job before it reaches the expected state.
    // This is only the test's scheduling-observation budget, not a product timeout change.
    const deadline = Date.now() + 900_000
    while (!stopWaiting && Date.now() < deadline) {
      const observed = await scheduler(job)
      if (
        validResult(observed.controller) &&
        observed.controller.exitCode === 0 &&
        observed.controller.stdout.includes(`JobState=${state}`)
      )
        return
      await sleep(2_000)
    }
    throw new Error(`Did not independently observe ${job.schedulerId} in ${state}.`)
  }
  const awaitActualAbsence = async (
    fixtures: readonly FixtureJob[],
    purpose: string
  ): Promise<void> => {
    const pending = new Map(fixtures.map((job) => [job.jobId, job]))
    const deadline = Date.now() + 750_000
    while (!stopWaiting && Date.now() < deadline) {
      for (const [jobId, job] of pending) {
        const observed = await scheduler(job)
        if (noQueueRecord(observed.queue) && noControllerRecord(observed.controller)) {
          pending.delete(jobId)
          await evidence('actual-controller-eviction', { purpose, ...job, observed })
        }
      }
      if (pending.size === 0) return
      await sleep(10_000)
    }
    throw new Error(`Actual record eviction not observed: ${[...pending.keys()].join(', ')}`)
  }
  const submit = async (name: string, command: string): Promise<FixtureJob> => {
    const submitted = await service.submitJob(
      scope.providerId,
      `Slurm record retention acceptance: ${name}`,
      `#SBATCH --partition=${partition}\n#SBATCH --cpus-per-task=1\n#SBATCH --mem=128M\n${command}`,
      { timeoutSeconds: 300 },
      scope
    )
    await execution.waitForDispatch([submitted.job_id])
    const job = await db.repositories.jobs.get(submitted.job_id)
    if (!job?.remote_handle || !job.remote_workdir)
      throw new Error('Submission did not publish a Slurm handle.')
    const handle = JSON.parse(job.remote_handle) as { scheduler_job_id: string }
    const fixture = {
      jobId: job.job_id,
      schedulerId: handle.scheduler_job_id,
      workdir: job.remote_workdir
    }
    jobs.push(fixture)
    await evidence('application-submission', { name, fixture, job })
    console.log(`RETENTION_FIXTURE ${JSON.stringify({ name, ...fixture })}`)
    return fixture
  }

  beforeAll(async () => {
    await mkdir(evidenceRoot, { recursive: true })
    initLogger({
      logDir: evidenceRoot,
      fileName: `retention-${runId}-application.jsonl`,
      runId,
      mirrorToConsole: false
    })
    await evidence('run-start', {
      alias,
      runId,
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8'
      }).trim(),
      workingDiffSha256: createHash('sha256')
        .update(execFileSync('git', ['diff', '--binary'], { cwd: process.cwd() }))
        .digest('hex'),
      testSourceSha256: createHash('sha256')
        .update(
          await readFile(
            resolve('src/main/compute/slurm-record-retention.real-ssh.integration.test.ts')
          )
        )
        .digest('hex'),
      controlledTiming:
        'Only C3 delays delivery of the real successful scancel response until actual controller eviction. Scheduler command outputs and exit codes are never replaced.'
    })
    const operationFields =
      Prisma.dmmf.datamodel.models
        .find((model) => model.name === 'ComputeJobOperation')
        ?.fields.map((field) => field.name) ?? []
    await evidence('runtime-client-schema-preflight', { operationFields })
    expect(operationFields).toEqual(expect.arrayContaining(['errorCode', 'errorMessage']))
    const priorAgentFixture = await readFile(
      join(evidenceRoot, 'agent-unavailable.json'),
      'utf8'
    ).catch(() => undefined)
    if (priorAgentFixture)
      await evidence('previous-agent-fixture-preserved', { fixture: JSON.parse(priorAgentFixture) })
    db = await createMigratedComputeTestDatabase('os-slurm-retention-real-')
    await evidence('test-database-created', { storageRoot: db.storageRoot })
    const fulfill = db.repositories.operations.fulfill.bind(db.repositories.operations)
    db.repositories.operations.fulfill = async (...args) => {
      const [claim] = args
      const operationSnapshot = async (): Promise<Record<string, unknown>> => {
        try {
          return { operation: await db.repositories.operations.get(claim.jobId, 'cancel') }
        } catch (error) {
          return { snapshotError: String(error) }
        }
      }
      await evidence('cancellation-fulfill-start', {
        claim,
        ...(await operationSnapshot())
      })
      try {
        const result = await fulfill(...args)
        await evidence('cancellation-fulfill-end', {
          claim,
          result,
          ...(await operationSnapshot())
        })
        return result
      } catch (error) {
        const details =
          typeof error === 'object' && error !== null
            ? Object.fromEntries(
                ['name', 'code', 'message', 'stack', 'meta'].map((key) => [
                  key,
                  Reflect.get(error, key)
                ])
              )
            : { value: String(error) }
        await evidence('cancellation-fulfill-error', {
          claim,
          error: details
        })
        await evidence('cancellation-fulfill-error-state', {
          claim,
          ...(await operationSnapshot())
        })
        throw error
      }
    }
    hosts = new ComputeHostRepository(async () => db.client)
    await hosts.create({ sshAlias: alias, executionMode: 'slurm' })
    const runner = createSshRunner()
    const scpRunner = createScpRunner()
    broker = new SshConfigComputeConnectionBroker({
      getHost: (id) => hosts.get(id),
      runner,
      scpRunner
    })
    const acquire = broker.acquire.bind(broker)
    broker.acquire = async (providerId, request) => {
      const lease = await acquire(providerId, request)
      return {
        ...lease,
        run: async (command, options) => {
          const result = await lease.run(command, options)
          const cancelledId = command.match(/^scancel (\d+)$/)?.[1]
          if (cancelledId) actualScancelResults.set(cancelledId, result)
          await evidence('real-command-result', { intent: request.intent, command, result })
          return result
        }
      }
    }
    const approval = new ComputeApprovalBroker({
      broadcast: () => undefined,
      generateId: () => 'retention-approval',
      timeoutMs: 5000
    })
    const request = approval.requestWithContext.bind(approval)
    approval.requestWithContext = async (info, context) => {
      const response = request(info, context)
      setImmediate(() => approval.respond('retention-approval', 'once'))
      return response
    }
    service = new ComputeService({
      runner,
      scpRunner,
      connectionBroker: broker,
      repository: hosts,
      jobRepository: db.repositories.jobs,
      operationRepository: db.repositories.operations,
      approvalBroker: approval,
      storageRoot: db.storageRoot,
      execution
    })
    const environment = await remote(
      'id; sbatch --version; scontrol show config | grep -E "AccountingStorageType|MinJobAge"; sinfo -Nel',
      'record actual environment'
    )
    expect(environment.exitCode).toBe(0)
    expect(environment.stdout).toContain('MinJobAge')
    const accounting = await remote(
      'sacct --noheader --format=JobIDRaw,State,ExitCode',
      'independent accounting-disabled check'
    )
    expect(accounting.exitCode).not.toBe(0)
    expect(accounting.stderr).toMatch(/accounting storage is disabled/i)
  }, 60_000)

  afterAll(async () => {
    const deferred: FixtureJob[] = []
    stopWaiting = true
    if (backgroundCancellation)
      await backgroundCancellation.catch((error: unknown) =>
        evidence('background-cancellation-error', { error: String(error) })
      )
    for (const poller of pollers) await poller.stop()
    if (broker && db) {
      for (const fixture of jobs) {
        if (preserveForAgent.has(fixture.jobId)) {
          await evidence('remote-workdir-retained-for-agent', {
            fixture,
            cleanupOwner: 'test operator'
          })
          continue
        }
        try {
          let observed = await scheduler(fixture)
          const stopped = (): boolean =>
            (terminalControllerRecord(observed.controller) &&
              stoppedQueueRecord(observed.queue, fixture.schedulerId)) ||
            (noControllerRecord(observed.controller) && noQueueRecord(observed.queue))
          if (!stopped()) {
            await remote(`scancel ${fixture.schedulerId}`, 'cleanup own still-active test job')
            const deadline = Date.now() + 10_000
            while (!stopped() && Date.now() < deadline) {
              await sleep(300)
              observed = await scheduler(fixture)
            }
          }
          if (!stopped()) throw new Error('Remote termination is not independently confirmed.')
          if (
            !fixture.workdir.endsWith(`/jobs/${fixture.jobId}`) ||
            fixture.workdir.split('/').includes('..')
          )
            throw new Error('Unexpected test cleanup path.')
          const result = await remote(
            `rm -rf -- ${quoteRemotePath(fixture.workdir)}`,
            'cleanup exact stopped test workdir'
          )
          expect(validResult(result)).toBe(true)
          expect(result.exitCode).toBe(0)
        } catch (error) {
          deferred.push(fixture)
          await evidence('cleanup-deferred-active-job', {
            fixture,
            error: String(error),
            cleanupOwner: 'test operator; preserve remote files'
          })
        }
      }
    }
    if (db) {
      try {
        await evidence('application-state-before-dispose', {
          jobs: await Promise.all(
            jobs.map(async (fixture) => ({
              fixture,
              snapshot: await service.getJobResult(fixture.jobId),
              operation: await db.repositories.operations.get(fixture.jobId, 'cancel')
            }))
          )
        })
      } catch (error) {
        await evidence('application-state-snapshot-failed', { error: String(error) })
      }
      await db.client.$disconnect()
      const archivedDatabase = join(evidenceRoot, `retention-${runId}.db`)
      try {
        await copyFile(join(db.storageRoot, 'open-science.db'), archivedDatabase)
      } catch (error) {
        await evidence('test-database-archive-failed-retained', {
          storageRoot: db.storageRoot,
          error: String(error)
        })
        await flushLogs()
        throw error
      }
      await evidence('test-database-archived', { archivedDatabase })
      await db.dispose()
    }
    await evidence('run-end', { runId })
    await evidenceWrites
    await flushLogs()
    expect(deferred, 'Unconfirmed test jobs must be retained and explicitly cleaned up.').toEqual(
      []
    )
  }, 180_000)

  it('uses actual controller eviction for mixed polling, unavailable cancellation and delayed cancellation inference', async () => {
    const aged = await submit(
      'unavailable-final-result',
      'printf preserved-unavailable > retention-witness.txt\nprintf retention-unavailable'
    )
    const agedCancellation = await submit(
      'unavailable-cancellation-result',
      'printf preserved-cancellation > retention-witness.txt\nprintf retention-cancellation'
    )
    const inferred = await submit('inferred-cancellation', '#SBATCH --hold\nprintf must-not-run')
    await service.cancelJob(inferred.jobId, scope)
    let realScancel: RunResult | undefined
    const delayedBroker: ComputeConnectionBrokerAcquirer = {
      acquire: async (providerId, request) => {
        const lease = await broker.acquire(providerId, request)
        return {
          ...lease,
          run: async (command, options) => {
            const result = await lease.run(command, options)
            await evidence('production-query-with-controlled-client-timing', {
              command,
              options,
              result
            })
            if (
              command === `scancel ${inferred.schedulerId}` &&
              result.exitCode === 0 &&
              !realScancel
            ) {
              realScancel = result
              await evidence('controlled-scancel-response-delay-start', {
                fixture: inferred,
                result
              })
              await awaitServerState(inferred, 'CANCELLED')
              await awaitActualAbsence([inferred], 'C3 actual absence after successful scancel')
              await evidence('controlled-scancel-response-delay-end', { fixture: inferred, result })
            }
            return result
          }
        }
      }
    }
    const inferenceReaper = execution.createCancellationReaper(
      db.repositories.operations,
      db.repositories.jobs,
      delayedBroker
    )
    backgroundCancellation = inferenceReaper.runOnce()
    await Promise.race([
      (async () => {
        while (!realScancel && !stopWaiting) await sleep(100)
      })(),
      backgroundCancellation.then(() => {
        if (!realScancel) throw new Error('The real scancel command was not observed.')
      })
    ])
    await awaitServerState(aged, 'COMPLETED')
    await awaitServerState(agedCancellation, 'COMPLETED')
    await evidence('all-aging-fixtures-prepared', { aged, agedCancellation, inferred, realScancel })
    console.log(
      `RETENTION_AGING_READY ${JSON.stringify({ aged, agedCancellation, inferred, at: new Date().toISOString(), tracePath })}`
    )
    await awaitActualAbsence(
      [aged, agedCancellation],
      'ordinary unavailable and cancellation unavailable fixtures'
    )
    await backgroundCancellation
    expect(await service.getJobResult(inferred.jobId)).toMatchObject({
      status: 'cancelled',
      result_final: true
    })
    expect(await db.repositories.operations.get(inferred.jobId, 'cancel')).toMatchObject({
      outcome: 'fulfilled'
    })
    await flushLogs()
    expect(
      await readFile(join(evidenceRoot, `retention-${runId}-application.jsonl`), 'utf8')
    ).toContain(
      'Cancellation inferred: scancel succeeded and the job disappeared from both squeue and scontrol'
    )
    await evidence('C3-inferred-application-result', {
      fixture: inferred,
      snapshot: await service.getJobResult(inferred.jobId),
      operation: await db.repositories.operations.get(inferred.jobId, 'cancel')
    })
    // Active cancellation owns the second expired Job, so the ordinary mixed poll cannot
    // consume its unavailable result before the restarted cancellation reaper queries it.
    expect(await service.cancelJob(agedCancellation.jobId, scope)).toMatchObject({
      status: 'submitted',
      cancellation: { status: 'cancelling' }
    })

    const active = await submit(
      'mixed-batch-running-sibling',
      'printf running-sibling > retention-witness.txt\nsleep 180'
    )
    await awaitServerState(active, 'RUNNING')
    const notifications: JobSummary[] = []
    const notifyJob = (job: Parameters<typeof emitJobNotification>[0]): Promise<void> =>
      emitJobNotification(job, {
        jobRepository: db.repositories.jobs,
        hostRepository: hosts,
        storageRoot: db.storageRoot,
        broadcast: (summary) => {
          notifications.push(summary)
          void evidence('actual-application-notification', { summary })
        }
      })
    const poller = execution.createPoller({
      connectionBroker: broker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs,
      notifyJob
    })
    pollers.push(poller)
    await poller.tick()
    await poller.pause()
    const unavailable = await service.getJobResult(aged.jobId)
    const activeSnapshot = await service.getJobStatus(active.jobId)
    await evidence('mixed-poll-application-results', {
      unavailable,
      activeSnapshot,
      cancellationSibling: await service.getJobResult(agedCancellation.jobId)
    })
    expect(unavailable).toMatchObject({
      status: 'error',
      result_final: true,
      error: { code: 'job_status_unavailable' }
    })
    expect(activeSnapshot.status).toBe('running')
    expect(unavailable.error?.message).toContain('may still be running')
    const preserved = await remote(
      `cat ${quoteRemotePath(`${aged.workdir}/retention-witness.txt`)}`,
      'prove error left original output intact'
    )
    expect(preserved.stdout).toBe('preserved-unavailable')
    if (process.env.COMPUTE_SLURM_RETAIN_AGENT_JOB === '1') {
      const home = await remote('printf "%s" "$HOME"', 'resolve preserved agent inspection path')
      const absoluteWorkdir = aged.workdir.startsWith('~/')
        ? home.stdout + aged.workdir.slice(1)
        : aged.workdir
      preserveForAgent.add(aged.jobId)
      await writeFile(
        join(evidenceRoot, 'agent-unavailable.json'),
        JSON.stringify(
          {
            name: 'unavailable',
            snapshot: unavailable,
            userGoal:
              'Use available results from this original analysis and explain what can be concluded; decide the next step without duplicating the job.',
            expectedRemotePath: `${absoluteWorkdir}/retention-witness.txt`,
            schedulerJobId: aged.schedulerId
          },
          null,
          2
        ) + '\n'
      )
    }

    const restarted = createComputeExecution()
    const cancellationReaper = restarted.createCancellationReaper(
      db.repositories.operations,
      db.repositories.jobs,
      broker
    )
    expect(await cancellationReaper.runOnce()).toBe(true)
    const cancellationUnavailable = await service.getJobResult(agedCancellation.jobId)
    const actualScancel = actualScancelResults.get(agedCancellation.schedulerId)
    await evidence('expired-cancellation-application-result', {
      fixture: agedCancellation,
      actualScancel,
      snapshot: cancellationUnavailable,
      operation: await db.repositories.operations.get(agedCancellation.jobId, 'cancel')
    })
    if (!actualScancel || !validResult(actualScancel))
      throw new Error('No complete real scancel response was captured for the expired fixture.')
    const cancellationUnavailableObserved = actualScancel.exitCode !== 0 && missingId(actualScancel)
    if (actualScancel.exitCode === 0) {
      expect(cancellationUnavailable).toMatchObject({ status: 'cancelled', result_final: true })
      expect(cancellationUnavailable).not.toHaveProperty('error')
      expect(cancellationUnavailable).not.toHaveProperty('cancellation')
      expect(await db.repositories.operations.get(agedCancellation.jobId, 'cancel')).toMatchObject({
        outcome: 'fulfilled'
      })
      await evidence('environment-specific-expired-id-cancellation', {
        fixture: agedCancellation,
        explanation:
          'This Slurm build returns genuine exit 0 for an already-evicted ID. The application correctly applies its disappearance inference. The no-success-evidence cancellation failure branch was not observed in this environment.'
      })
    } else if (cancellationUnavailableObserved) {
      expect(cancellationUnavailable).toMatchObject({
        status: 'error',
        result_final: true,
        error: { code: 'job_status_unavailable' },
        cancellation: { status: 'failed', error: { code: 'cancel_confirmation_failed' } }
      })
      expect(await db.repositories.operations.get(agedCancellation.jobId, 'cancel')).toMatchObject({
        outcome: 'failed'
      })
    } else
      throw new Error(
        `Unexpected real scancel response for an expired ID: ${JSON.stringify(actualScancel)}`
      )
    const restartedPoller = restarted.createPoller({
      connectionBroker: broker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs,
      notifyJob
    })
    pollers.push(restartedPoller)
    await restartedPoller.tick()
    await restartedPoller.pause()
    await restartedPoller.tick()
    await restartedPoller.pause()
    expect(await service.getJobResult(aged.jobId)).toEqual(unavailable)
    for (const fixture of [aged, agedCancellation, inferred])
      expect(notifications.filter((summary) => summary.job_id === fixture.jobId)).toHaveLength(1)
    await writeFile(
      join(evidenceRoot, `retention-${runId}-summary.json`),
      JSON.stringify(
        {
          runId,
          tracePath,
          classification:
            'real scheduler with explicit controlled client response delay only for C3',
          cases: {
            mixedBatchAndUnavailable: 'passed',
            cancellationUnavailable: cancellationUnavailableObserved
              ? 'passed-with-real-invalid-id-response'
              : 'not-observed-real-scancel-returned-zero',
            expiredIdCancellationActualBehavior: 'passed-against-the-actual-scancel-response',
            inferredCancellation: 'passed',
            notificationDeduplicationAcrossFreshOwners: 'passed'
          },
          fixtures: jobs,
          preservedForAgent: [...preserveForAgent]
        },
        null,
        2
      ) + '\n'
    )
  }, 1_800_000)
})

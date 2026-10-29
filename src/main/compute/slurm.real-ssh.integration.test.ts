import { createComputeExecution, createScpRunner, createSshRunner } from '@aipoch/compute/node'
// RUN_COMPUTE_SLURM=1 COMPUTE_TEST_SSH_ALIAS=hpc-dev npx vitest run src/main/compute/slurm.real-ssh.integration.test.ts
import {
  JobPoller,
  computeRemoteWorkdir,
  parseSbatchJobId,
  quoteRemotePath,
  recoverSlurmJob,
  shellSingleQuote,
  SshRunner,
  type ComputeConnectionBrokerAcquirer
} from '@aipoch/compute/node'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ComputeJob } from '../../shared/compute'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeService } from './compute-service'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { harvestJob } from './harvest-engine'
import { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './workspace-path'
import { emitJobNotification } from './job-notifier'
import { AgentComputeService } from './agent-compute-service'
import { toJobSummary } from './ipc'
import { ComputeJobResultDeliveryAdapter } from '../background-result-delivery/compute-adapter'
import { BackgroundResultDeliveryRepository } from '../background-result-delivery/repository'

const alias = process.env['COMPUTE_TEST_SSH_ALIAS'] ?? ''
const run = process.env['RUN_COMPUTE_SLURM'] === '1' && alias !== ''
const partition = process.env['COMPUTE_SLURM_PARTITION'] ?? 'debug'
const configuredScratchRoot = process.env['COMPUTE_SLURM_SCRATCH_ROOT']?.trim()
const scratchRoot = configuredScratchRoot
  ? configuredScratchRoot.replace(/\/+$/, '') || '/'
  : undefined
const reliability = process.env['COMPUTE_SLURM_RELIABILITY'] === '1'
const evidenceDirectory = process.env['COMPUTE_SLURM_EVIDENCE_DIR']
const acceptanceRun = randomUUID()
const scope = { providerId: `ssh:${alias}`, projectId: 'slurm-cert', sessionId: 'slurm-cert' }
const terminal = (job: ComputeJob): boolean =>
  ['success', 'failed', 'timeout', 'error'].includes(job.status)

describe.skipIf(!run)('Slurm lifecycle on real SSH + scheduler', () => {
  let db: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
  let hosts: ComputeHostRepository
  let connectionBroker: SshConfigComputeConnectionBroker
  let service: ComputeService
  const execution = createComputeExecution()
  const jobs: string[] = []
  const retainedForAgent = new Set<string>()
  const envName = `os-cert-${randomUUID()}`
  const envPath = `~/.openscience/environments/${envName}.sh`
  const envRoot = scratchRoot
    ? `${scratchRoot}/${envName}`
    : `~/.openscience/environments/${envName}`
  const schedulerHeader = `#SBATCH --partition=${partition}\n#SBATCH --cpus-per-task=1\n#SBATCH --mem=128M\n`

  const record = async (kind: string, data: unknown): Promise<void> => {
    if (!evidenceDirectory) return
    await appendFile(
      join(evidenceDirectory, 'application-and-transport.jsonl'),
      `${JSON.stringify({ run: acceptanceRun, time: new Date().toISOString(), test: expect.getState().currentTestName, kind, data })}\n`
    )
  }

  const makePoller = (owner = execution): JobPoller =>
    owner.createPoller({
      connectionBroker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs
    })
  const remote = async (command: string): ReturnType<SshRunner['run']> => {
    const lease = await connectionBroker.acquire(scope.providerId, { intent: 'direct_command' })
    return lease.run(command, { timeoutMs: 30000, loginShell: true, maxOutputBytes: 8192 })
  }
  const wait = async (
    jobId: string,
    predicate = terminal,
    poller = makePoller()
  ): Promise<ComputeJob> => {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      await poller.tick()
      const job = await db.repositories.jobs.get(jobId)
      if (job && predicate(job)) return job
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(
      `Slurm wait timed out: ${JSON.stringify(await db.repositories.jobs.get(jobId))}`
    )
  }
  const collect = async (job: ComputeJob): Promise<ComputeJob> => {
    await harvestJob(job, {
      connectionBroker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs,
      storageRoot: db.storageRoot,
      broadcast: () => undefined
    })
    const collected = (await db.repositories.jobs.get(job.job_id))!
    expect(collected.harvested_at).toBeDefined()
    expect(collected.harvest_error).toBeUndefined()
    return collected
  }
  const readCollectedLog = (job: ComputeJob, stream: 'stdout' | 'stderr'): Promise<string> =>
    readFile(
      join(getJobHarvestDir(db.storageRoot, job.project_id, job.session_id, job.job_id), stream),
      'utf8'
    )
  const submit = async (
    command: string,
    options: Parameters<ComputeService['submitJob']>[3] = {}
  ): ReturnType<ComputeService['submitJob']> => {
    const result = await service.submitJob(
      scope.providerId,
      'Open-Science Slurm certification',
      schedulerHeader + command,
      { timeoutSeconds: 60, ...options },
      scope
    )
    jobs.push(result.job_id)
    return result
  }

  beforeAll(async () => {
    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true })
    db = await createMigratedComputeTestDatabase('os-slurm-real-')
    hosts = new ComputeHostRepository(async () => db.client)
    await hosts.create({
      sshAlias: alias,
      executionMode: 'slurm',
      sshOverrides: {
        user: process.env['COMPUTE_SLURM_USERNAME'],
        port: process.env['COMPUTE_SLURM_PORT']
          ? Number(process.env['COMPUTE_SLURM_PORT'])
          : undefined,
        identityFile: process.env['COMPUTE_SLURM_IDENTITY_FILE']
      }
    })
    if (scratchRoot) await hosts.updateScratchPinned(scope.providerId, scratchRoot)
    const transport = createSshRunner()
    const runner: SshRunner = {
      run: async (...args) => {
        const result = await transport.run(...args)
        // Only this suite's test commands/results are recorded, never SSH options or credentials.
        await record('ssh', { command: args[1], result })
        return result
      }
    }
    const scpRunner = createScpRunner()
    connectionBroker = new SshConfigComputeConnectionBroker({
      getHost: (id) => hosts.get(id),
      runner,
      scpRunner
    })
    const approval = new ComputeApprovalBroker({
      broadcast: () => undefined,
      generateId: () => 'real-slurm-approval',
      timeoutMs: 5000
    })
    const request = approval.requestWithContext.bind(approval)
    approval.requestWithContext = async (info, context) => {
      const pending = request(info, context)
      setImmediate(() => approval.respond('real-slurm-approval', 'once'))
      return pending
    }
    service = new ComputeService({
      runner,
      scpRunner,
      connectionBroker,
      repository: hosts,
      jobRepository: db.repositories.jobs,
      operationRepository: db.repositories.operations,
      approvalBroker: approval,
      storageRoot: db.storageRoot,
      execution
    })
    expect((await service.probe(scope.providerId)).detectedScheduler).toBe('slurm')
    const setup = await remote(
      `mkdir -p ~/.openscience/environments && python3 -m venv --without-pip ${quoteRemotePath(envRoot)} && printf '%s\\n' ${shellSingleQuote(`. ${quoteRemotePath(`${envRoot}/bin/activate`)}\nexport OS_COMPUTE_WITNESS=activated`)} > ${quoteRemotePath(envPath)}`
    )
    expect(setup.exitCode).toBe(0)
  })

  afterEach(async () => {
    for (const jobId of jobs) {
      const job = await db?.repositories.jobs.get(jobId)
      if (!job) continue
      await record('application', {
        jobId,
        status: await service.getJobStatus(jobId),
        result: await service.getJobResult(jobId),
        operation: await db.repositories.operations.get(jobId, 'cancel')
      })
    }
  })

  afterAll(async () => {
    await execution.waitForDispatch(jobs)
    const deferred: string[] = []
    try {
      if (!connectionBroker || !db) return
      for (const id of jobs) {
        if (retainedForAgent.has(id)) continue
        try {
          const job = await db.repositories.jobs.get(id)
          if (!job) continue
          const handle = job.remote_handle ? JSON.parse(job.remote_handle) : undefined
          let stopped =
            !handle && job.status === 'error' && job.error_code !== 'job_status_unavailable'
          if (handle?.driver !== 'slurm' && ['success', 'failed', 'timeout'].includes(job.status))
            stopped = true
          if (handle?.scheduler_job_id && /^\d+$/.test(handle.scheduler_job_id)) {
            await remote(`scancel ${handle.scheduler_job_id} 2>/dev/null || true`)
            const deadline = Date.now() + 10000
            while (Date.now() < deadline) {
              const control = await remote(
                `scontrol show job ${handle.scheduler_job_id} --oneliner`
              )
              const queue = await remote(
                `squeue --noheader --states=all -j ${handle.scheduler_job_id} --format='%T'`
              )
              const valid = (result: Awaited<ReturnType<SshRunner['run']>>): boolean =>
                !result.timedOut &&
                !result.truncated &&
                !result.stdoutTruncated &&
                !result.stderrTruncated &&
                result.exitCode !== null &&
                result.exitCode !== 255
              const complete =
                valid(control) &&
                control.exitCode === 0 &&
                /JobState=(?:COMPLETED|CANCELLED|FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE)\b/.test(
                  control.stdout
                )
              const absent =
                valid(control) &&
                ((control.exitCode === 1 && /invalid job id specified/i.test(control.stderr)) ||
                  (control.exitCode === 0 &&
                    /^\s*No jobs? in the system\s*$/i.test(control.stdout)))
              const queueValid =
                valid(queue) &&
                (queue.exitCode === 0 ||
                  (queue.exitCode === 1 &&
                    !queue.stdout.trim() &&
                    /invalid job id specified/i.test(queue.stderr)))
              const queueAbsent = queueValid && !queue.stdout.trim()
              const queueStopped =
                queueValid &&
                queue.stdout
                  .trim()
                  .split(/\r?\n/)
                  .every(
                    (state) =>
                      !state ||
                      /^(?:COMPLETED|CANCELLED|FAILED|TIMEOUT|OUT_OF_MEMORY|NODE_FAIL|PREEMPTED|BOOT_FAIL|DEADLINE)\+?$/.test(
                        state
                      )
                  )
              stopped = (complete && queueStopped) || (absent && queueAbsent)
              if (stopped) break
              await new Promise((resolve) => setTimeout(resolve, 300))
            }
          }
          if (!stopped) throw new Error('Remote termination is not independently confirmed.')
          if (job.remote_workdir) {
            if (
              !job.remote_workdir.endsWith(`/jobs/${id}`) ||
              job.remote_workdir.split('/').includes('..')
            )
              throw new Error('Unexpected test cleanup path.')
            const removed = await remote(`rm -rf -- ${quoteRemotePath(job.remote_workdir)}`)
            expect(removed.exitCode).toBe(0)
          }
        } catch (error) {
          deferred.push(id)
          await record('cleanup-deferred', {
            jobId: id,
            error: String(error),
            owner: 'test operator; preserve remote files'
          })
        }
      }
      if (deferred.length === 0) {
        const removed = await remote(
          `rm -f -- ${quoteRemotePath(envPath)} && rm -rf -- ${quoteRemotePath(envRoot)}`
        )
        expect(removed.exitCode).toBe(0)
      }
    } finally {
      await db?.dispose()
    }
    expect(deferred, 'Unconfirmed test jobs must be retained and explicitly cleaned up.').toEqual(
      []
    )
  }, 120000)

  it('stages input, activates environment on the compute node, recovers with fresh owners and harvests output', async () => {
    await writeFile(join(db.storageRoot, 'input.txt'), 'staged-data\n')
    const submitted = await submit(
      'python -c "import sys; assert sys.prefix != sys.base_prefix"\nsleep 2\nprintf "%s\\n" "$OS_COMPUTE_WITNESS:$SLURM_JOB_ID" > witness.txt\ncat input.txt >> witness.txt',
      {
        environment: envName,
        outputManifest: JSON.stringify(['witness.txt']),
        inputs: [{ src: 'input.txt', dst_filename: 'input.txt' }],
        workspaceCwd: db.storageRoot
      }
    )
    // Simulate a new runtime only after dispatch has published its durable handle.
    await execution.waitForDispatch([submitted.job_id])
    expect((await db.repositories.jobs.get(submitted.job_id))?.remote_handle).toBeTruthy()
    const completed = await wait(submitted.job_id, terminal, makePoller(createComputeExecution()))
    expect(completed.status).toBe('success')
    expect(completed.exit_code).toBe(0)
    expect(JSON.parse(completed.remote_handle!).driver).toBe('slurm')
    await harvestJob(completed, {
      connectionBroker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs,
      storageRoot: db.storageRoot,
      broadcast: () => undefined
    })
    expect((await db.repositories.jobs.get(completed.job_id))?.harvest_error).toBeUndefined()
    expect(
      await readFile(
        join(
          getJobHarvestDir(db.storageRoot, scope.projectId, scope.sessionId, completed.job_id),
          'featured',
          'witness.txt'
        ),
        'utf8'
      )
    ).toMatch(/^activated:\d+\nstaged-data\n$/)
    expect((await db.repositories.jobs.get(completed.job_id))?.notified_at).toBeTruthy()
  }, 180000)

  it('adopts a lost local handle without resubmitting after the host mode changes', async () => {
    const submitted = await submit('sleep 8\necho recovered')
    const launched = await wait(submitted.job_id, (job) => Boolean(job.remote_handle))
    await execution.waitForDispatch([submitted.job_id])
    const schedulerId = JSON.parse(launched.remote_handle!).scheduler_job_id
    expect(
      (await remote(`rm -f -- ${quoteRemotePath(`${submitted.remote_workdir}/scheduler_job_id`)}`))
        .exitCode
    ).toBe(0)
    await db.client.computeJob.update({
      where: { id: submitted.job_id },
      data: { remoteHandle: null }
    })
    await hosts.updateExecutionMode(scope.providerId, 'direct_ssh')
    try {
      const recovered = await wait(submitted.job_id, terminal, makePoller(createComputeExecution()))
      expect(recovered.status).toBe('success')
      expect(JSON.parse(recovered.remote_handle!).scheduler_job_id).toBe(schedulerId)
      const collected = await collect(recovered)
      expect(await readCollectedLog(collected, 'stdout')).toContain('recovered')
    } finally {
      await hosts.updateExecutionMode(scope.providerId, 'slurm')
    }
  }, 180000)

  it('does not adopt a same-name scheduler job from another workdir', async () => {
    const jobId = randomUUID()
    const expectedWorkdir = computeRemoteWorkdir(scratchRoot, jobId)
    const decoyWorkdir = `${scratchRoot ?? '~'}/.open-science/slurm-decoy-${jobId}`
    const launched = await remote(
      [
        `mkdir -p ${quoteRemotePath(expectedWorkdir)} ${quoteRemotePath(decoyWorkdir)}`,
        `touch ${quoteRemotePath(`${expectedWorkdir}/job.sbatch`)}`,
        `cd ${quoteRemotePath(decoyWorkdir)}`,
        `sbatch --parsable --hold --partition=${partition} --job-name=open-science-${jobId} --chdir="$PWD" --output=stdout --error=stderr --wrap=true`
      ].join('\n')
    )
    expect(launched.exitCode).toBe(0)
    const decoyId = parseSbatchJobId(launched.stdout)
    expect(decoyId).toBeDefined()
    try {
      const connection = await connectionBroker.acquire(scope.providerId, {
        intent: 'job_poll'
      })
      await expect(
        recoverSlurmJob(
          { job_id: jobId, remote_workdir: expectedWorkdir } as ComputeJob,
          connection
        )
      ).resolves.toBeUndefined()
    } finally {
      if (decoyId) await remote(`scancel ${decoyId} 2>/dev/null || true`)
      await remote(`rm -rf -- ${quoteRemotePath(expectedWorkdir)} ${quoteRemotePath(decoyWorkdir)}`)
    }
  }, 60000)

  it('reports a nonzero workload exit and actionable missing environment logs', async () => {
    const failed = await submit('echo science-failure >&2\nexit 7')
    const result = await wait(failed.job_id)
    expect(result.status).toBe('failed')
    expect(result.exit_code).toBe(7)
    const collected = await collect(result)
    expect(await readCollectedLog(collected, 'stderr')).toContain('science-failure')
    const missing = await submit('echo must-not-run', { environment: `${envName}-missing` })
    const missingFinished = await wait(missing.job_id)
    expect(missingFinished.status).toBe('failed')
    const missingResult = await collect(missingFinished)
    expect(await readCollectedLog(missingResult, 'stderr')).toContain('compute-env-setup')
    expect(await readCollectedLog(missingResult, 'stdout')).not.toContain('must-not-run')
  }, 180000)

  it('cancels via Slurm and confirms termination before settling cancellation', async () => {
    const submitted = await submit('sleep 90')
    await wait(submitted.job_id, (job) => job.status === 'running' || terminal(job))
    // Cancellation excludes jobs from ordinary polling, so the reaper must recover this handle.
    await db.client.computeJob.update({
      where: { id: submitted.job_id },
      data: { remoteHandle: null }
    })
    await service.cancelJob(submitted.job_id, scope)
    const reaper = execution.createCancellationReaper(
      db.repositories.operations,
      db.repositories.jobs,
      connectionBroker
    )
    const deadline = Date.now() + 60000
    let job = await db.repositories.jobs.get(submitted.job_id)
    while (job?.cancellation_status !== 'cancelled' && Date.now() < deadline) {
      await reaper.runOnce()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      job = await db.repositories.jobs.get(submitted.job_id)
    }
    expect(job?.cancellation_status).toBe('cancelled')
    expect(job && terminal(job)).toBe(true)
    const schedulerId = JSON.parse(job!.remote_handle!).scheduler_job_id
    const schedulerState = await remote(
      `squeue --noheader --states=all -j ${schedulerId} --format='%T'`
    )
    expect(schedulerState.stdout.trim()).not.toMatch(/^(RUNNING|PENDING|COMPLETING|CONFIGURING)$/m)
  }, 180000)

  it('enforces the workload timeout', async () => {
    const submitted = await submit('sleep 90', { timeoutSeconds: 3 })
    expect((await wait(submitted.job_id)).status).toBe('timeout')
  }, 180000)

  it('reports scheduler rejection with the reason rather than silently running directly', async () => {
    const submitted = await submit(
      '#SBATCH --partition=openscience-nonexistent-partition\necho must-not-run'
    )
    const rejected = await wait(submitted.job_id)
    expect(rejected.status).toBe('error')
    expect(rejected.stderr_tail).toMatch(/partition/i)
    expect(rejected.remote_handle).toBeUndefined()
    expect((await service.getJobResult(submitted.job_id)).error?.code).toBe('dispatch_failed')
  }, 180000)

  it('distinguishes an sbatch exit 255 rejection from an SSH transport failure', async () => {
    const submitted = await submit('#SBATCH --cpus=1\necho must-not-run')
    const rejected = await wait(submitted.job_id)
    expect(rejected.status).toBe('error')
    expect(rejected.stderr_tail).toMatch(/--cpus=1.*ambiguous/is)
    expect(rejected.remote_handle).toBeUndefined()
    expect((await service.getJobResult(submitted.job_id)).error?.code).toBe('dispatch_failed')
  }, 180000)

  it('preserves direct SSH execution with the same named environment', async () => {
    let entered!: () => void
    let release!: () => void
    const dispatchEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const dispatchGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const acquire = connectionBroker.acquire.bind(connectionBroker)
    connectionBroker.acquire = async (id, request) => {
      if (request.intent === 'job_dispatch') {
        entered()
        await dispatchGate
      }
      return acquire(id, request)
    }

    await hosts.updateExecutionMode(scope.providerId, 'direct_ssh')
    try {
      const submitted = await service.submitJob(
        scope.providerId,
        'Open-Science direct SSH environment regression',
        'python -c "import sys; assert sys.prefix != sys.base_prefix"\nprintf direct-ready',
        { environment: envName, timeoutSeconds: 30 },
        scope
      )
      jobs.push(submitted.job_id)
      try {
        await dispatchEntered
        // Poll during dispatch to prove this runtime shares the dispatch ownership scope.
        await makePoller().tick()
        expect(await db.repositories.jobs.get(submitted.job_id)).toMatchObject({
          status: 'submitted',
          error_code: undefined
        })
      } finally {
        release()
        await execution.waitForDispatch([submitted.job_id])
      }
      const completed = await wait(submitted.job_id)
      expect(completed.status).toBe('success')
      expect(completed.stdout_tail).toContain('direct-ready')
      expect(JSON.parse(completed.remote_handle!).pid).toBeGreaterThan(1)
    } finally {
      release()
      connectionBroker.acquire = acquire
      await hosts.updateExecutionMode(scope.providerId, 'slurm')
    }
  }, 180000)

  it('keeps a scheduler-held job submitted and cancels it before execution', async () => {
    const submitted = await submit('#SBATCH --hold\necho must-not-run')
    const held = await wait(submitted.job_id, (job) => Boolean(job.remote_handle))
    const schedulerId = JSON.parse(held.remote_handle!).scheduler_job_id
    const server = await remote(`scontrol show job ${schedulerId} --oneliner`)
    expect(server.stdout).toMatch(/JobState=PENDING\b/)
    expect(server.stdout).toMatch(/Reason=JobHeldUser\b/)
    await makePoller().tick()
    expect(held.status).toBe('submitted')
    expect((await service.getJobResult(submitted.job_id)).last_poll_error).toBeUndefined()
    await service.cancelJob(submitted.job_id, scope)
    const reaper = execution.createCancellationReaper(
      db.repositories.operations,
      db.repositories.jobs,
      connectionBroker
    )
    const deadline = Date.now() + 60000
    let latest = held
    while (latest.cancellation_status !== 'cancelled' && Date.now() < deadline) {
      await reaper.runOnce()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      latest = (await db.repositories.jobs.get(submitted.job_id))!
    }
    expect(latest.cancellation_status).toBe('cancelled')
    expect(latest.stdout_tail ?? '').not.toContain('must-not-run')
  }, 180000)

  it('recovers and terminates an active Slurm job before deleting its session workdir', async () => {
    const deletionScope = { ...scope, sessionId: 'slurm-deletion-cert' }
    const submitted = await service.submitJob(
      scope.providerId,
      'Slurm deletion regression',
      schedulerHeader + 'sleep 90',
      { timeoutSeconds: 120 },
      deletionScope
    )
    jobs.push(submitted.job_id)
    const launched = await wait(submitted.job_id, (job) => job.status === 'running')
    const schedulerId = JSON.parse(launched.remote_handle!).scheduler_job_id
    expect(
      (await remote(`rm -f -- ${quoteRemotePath(`${submitted.remote_workdir}/scheduler_job_id`)}`))
        .exitCode
    ).toBe(0)
    await db.client.computeJob.update({
      where: { id: submitted.job_id },
      data: { remoteHandle: null }
    })
    const owner = execution.createDeletionOwner({
      jobRepository: db.repositories.jobs,
      hostRepository: hosts,
      connectionBroker
    })
    await owner.prepareSessionJobDeletion(deletionScope.projectId, deletionScope.sessionId)
    const deadline = Date.now() + 60000
    while (true) {
      try {
        await owner.commitSessionJobDeletion(deletionScope.projectId, deletionScope.sessionId)
        break
      } catch (error) {
        if (Date.now() >= deadline || !String(error).includes('not yet confirmed')) throw error
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    expect(await db.repositories.jobs.get(submitted.job_id)).toBeNull()
    expect((await remote(`test ! -d ${quoteRemotePath(submitted.remote_workdir)}`)).exitCode).toBe(
      0
    )
    const observed = await remote(`squeue --noheader --states=all -j ${schedulerId} --format='%T'`)
    expect(observed.stdout.trim()).not.toMatch(/^(RUNNING|PENDING|COMPLETING|CONFIGURING)$/m)
  }, 180000)

  it.skipIf(!reliability)(
    'reliability: observes a completed controller batch before collecting either job',
    async () => {
      const submitted = [
        await submit('printf first-controller-batch'),
        await submit('printf last-controller-batch')
      ]
      await execution.waitForDispatch(submitted.map((job) => job.job_id))
      for (const item of submitted) {
        const job = (await db.repositories.jobs.get(item.job_id))!
        const id = JSON.parse(job.remote_handle!).scheduler_job_id
        const deadline = Date.now() + 120000
        let server = await remote(`scontrol show job ${id} --oneliner`)
        while (!server.stdout.includes('JobState=COMPLETED') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          server = await remote(`scontrol show job ${id} --oneliner`)
        }
        expect(server.stdout).toContain('JobState=COMPLETED')
      }
      await makePoller().tick()
      const finishedJobs: ComputeJob[] = []
      for (const item of submitted) {
        const finished = (await db.repositories.jobs.get(item.job_id))!
        expect(finished).toMatchObject({ status: 'success', exit_code: 0 })
        expect(finished.harvested_at).toBeUndefined()
        await record('controller-batch-before-collection', finished)
        finishedJobs.push(finished)
      }
      for (const [index, finished] of finishedJobs.entries()) {
        const collected = await collect(finished)
        const expected = index === 0 ? 'first-controller-batch' : 'last-controller-batch'
        // Tail snapshots are best effort; the collected log is the durable output witness.
        if (collected.stdout_tail !== undefined) expect(collected.stdout_tail).toBe(expected)
        const stdout = await readCollectedLog(collected, 'stdout')
        expect(stdout).toBe(expected)
        await record('controller-batch-collected-output', {
          jobId: finished.job_id,
          stdout,
          stdoutTail: collected.stdout_tail
        })
      }
    },
    180000
  )

  it.skipIf(!reliability)(
    'reliability: completes a short job before its first application poll',
    async () => {
      const submitted = await submit('printf short-before-first-poll')
      await execution.waitForDispatch([submitted.job_id])
      const unobserved = (await db.repositories.jobs.get(submitted.job_id))!
      const schedulerId = JSON.parse(unobserved.remote_handle!).scheduler_job_id
      const deadline = Date.now() + 120000
      let server = await remote(`scontrol show job ${schedulerId} --oneliner`)
      while (!server.stdout.includes('JobState=COMPLETED') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        server = await remote(`scontrol show job ${schedulerId} --oneliner`)
      }
      expect(server.stdout).toContain('JobState=COMPLETED')
      expect((await db.repositories.jobs.get(submitted.job_id))?.status).toBe('submitted')
      await makePoller().tick()
      expect(await service.getJobStatus(submitted.job_id)).toMatchObject({
        status: 'success',
        exit_code: 0
      })
    },
    180000
  )

  it.skipIf(!reliability)(
    'reliability: external cancellation projects cancelled without a local operation',
    async () => {
      const submitted = await submit('#SBATCH --hold\necho must-not-run')
      await execution.waitForDispatch([submitted.job_id])
      const job = (await db.repositories.jobs.get(submitted.job_id))!
      const schedulerId = JSON.parse(job.remote_handle!).scheduler_job_id
      expect((await remote(`scancel ${schedulerId}`)).exitCode).toBe(0)
      await wait(submitted.job_id)
      expect(await db.repositories.operations.get(submitted.job_id, 'cancel')).toBeNull()
      expect(await service.getJobResult(submitted.job_id)).toMatchObject({
        status: 'cancelled',
        result_final: true
      })
      expect((await remote(`scontrol show job ${schedulerId} --oneliner`)).stdout).toContain(
        'JobState=CANCELLED'
      )
    },
    180000
  )

  it.skipIf(!reliability)(
    'reliability: cancellation delivers before harvest and foreground observation wins later delivery',
    async () => {
      const submitted = await submit('#SBATCH --hold\necho must-not-run')
      await execution.waitForDispatch([submitted.job_id])
      const ledger = new BackgroundResultDeliveryRepository(async () => db.client)
      const delivery = new ComputeJobResultDeliveryAdapter({
        register: (source) => ledger.register(source),
        enqueue: (source) => ledger.enqueue(source),
        acknowledgeObserved: async (source) => {
          const { delivery: observed } = await ledger.acknowledgeObserved(source)
          return observed.state === 'dispatching' ? 'committed' : 'suppressed'
        },
        listWaiting: () => ledger.listWaiting('compute-job'),
        hasDeliveryPath: (kind, id) => ledger.hasDeliveryPath(kind, id)
      })
      const summary = async (): ReturnType<typeof toJobSummary> =>
        toJobSummary((await db.repositories.jobs.get(submitted.job_id))!, alias, db.storageRoot)
      await delivery.observeJob(await summary())
      const broadcasts: import('../../shared/compute').JobSummary[] = []
      const notify = async (): Promise<void> => {
        await emitJobNotification((await db.repositories.jobs.get(submitted.job_id))!, {
          jobRepository: db.repositories.jobs,
          hostRepository: hosts,
          storageRoot: db.storageRoot,
          broadcast: (value) => {
            broadcasts.push(value)
          }
        })
        await Promise.all(broadcasts.map((value) => delivery.observeNotification(value)))
      }
      await service.cancelJob(submitted.job_id, scope)
      const fresh = createComputeExecution().createCancellationReaper(
        db.repositories.operations,
        db.repositories.jobs,
        connectionBroker,
        { onConfirmed: notify }
      )
      expect(await fresh.runOnce()).toBe(true)
      expect(broadcasts).toHaveLength(1)
      expect((await db.repositories.jobs.get(submitted.job_id))?.harvested_at).toBeUndefined()
      expect(await ledger.find(`compute-job:${submitted.job_id}`)).toMatchObject({
        state: 'pending'
      })
      const agent = new AgentComputeService(
        service,
        {
          getEnabled: () => [scope.providerId],
          getSelected: () => [scope.providerId]
        },
        { onFinalJobObserved: async () => delivery.observeResult(await summary()) }
      )
      expect(await agent.getJobStatus(scope, scope.providerId, submitted.job_id)).toMatchObject({
        status: 'cancelled',
        result_final: true
      })
      expect(await ledger.find(`compute-job:${submitted.job_id}`)).toMatchObject({
        state: 'pending'
      })
      expect(await agent.getJobResult(scope, scope.providerId, submitted.job_id)).toMatchObject({
        status: 'cancelled',
        result_final: true,
        follow_up_delivery: 'suppressed'
      })
      await harvestJob((await db.repositories.jobs.get(submitted.job_id))!, {
        connectionBroker,
        hostRepository: hosts,
        jobRepository: db.repositories.jobs,
        storageRoot: db.storageRoot,
        broadcast: (value) => {
          void record('harvest-update', value)
        }
      })
      await notify()
      await delivery.recoverWaiting(async () => summary())
      expect(broadcasts).toHaveLength(1)
      expect(await ledger.find(`compute-job:${submitted.job_id}`)).toMatchObject({
        state: 'consumed'
      })
    },
    180000
  )

  it.skipIf(!reliability)(
    'reliability: known natural completion takes priority during cancellation twice',
    async () => {
      for (let repeat = 0; repeat < 2; repeat++) {
        const submitted = await submit('printf natural-completion')
        await execution.waitForDispatch([submitted.job_id])
        const job = (await db.repositories.jobs.get(submitted.job_id))!
        const schedulerId = JSON.parse(job.remote_handle!).scheduler_job_id
        const deadline = Date.now() + 120000
        let server = await remote(`scontrol show job ${schedulerId} --oneliner`)
        while (!server.stdout.includes('JobState=COMPLETED') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          server = await remote(`scontrol show job ${schedulerId} --oneliner`)
        }
        expect(server.stdout).toContain('JobState=COMPLETED')
        await service.cancelJob(submitted.job_id, scope)
        const reaper = createComputeExecution().createCancellationReaper(
          db.repositories.operations,
          db.repositories.jobs,
          connectionBroker
        )
        await reaper.runOnce()
        expect(await service.getJobStatus(submitted.job_id)).toMatchObject({
          status: 'success',
          exit_code: 0
        })
        expect(await db.repositories.operations.get(submitted.job_id, 'cancel')).toMatchObject({
          outcome: 'superseded'
        })
      }
    },
    300000
  )

  it.skipIf(!reliability)(
    'reliability: cancellation around workload completion preserves the observed outcome in both orders',
    async () => {
      for (const delay of [0, 2500]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const submitted = await submit('touch race-ready\nsleep 2\nprintf near-finish-output')
          await execution.waitForDispatch([submitted.job_id])
          const job = (await db.repositories.jobs.get(submitted.job_id))!
          const schedulerId = JSON.parse(job.remote_handle!).scheduler_job_id
          const marker = `${job.remote_workdir}/race-ready`
          const readyDeadline = Date.now() + 120000
          let ready = await remote(`test -f ${quoteRemotePath(marker)}`)
          while (ready.exitCode !== 0 && Date.now() < readyDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 300))
            ready = await remote(`test -f ${quoteRemotePath(marker)}`)
          }
          expect(ready.exitCode).toBe(0)
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          const before = await remote(`scontrol show job ${schedulerId} --oneliner`)
          expect(before.stdout).toContain(delay ? 'JobState=COMPLETED' : 'JobState=RUNNING')
          await record('near-completion-order', { schedulerId, delay, repeat, before })
          await service.cancelJob(submitted.job_id, scope)
          const reaper = createComputeExecution().createCancellationReaper(
            db.repositories.operations,
            db.repositories.jobs,
            connectionBroker
          )
          const deadline = Date.now() + 30000
          do {
            await reaper.runOnce()
            if (
              (await db.repositories.operations.get(submitted.job_id, 'cancel'))?.phase ===
              'settled'
            )
              break
            await new Promise((resolve) => setTimeout(resolve, 500))
          } while (Date.now() < deadline)
          const status = await service.getJobStatus(submitted.job_id)
          const after = await remote(`scontrol show job ${schedulerId} --oneliner`)
          await record('near-completion-outcome', { schedulerId, delay, repeat, status, after })
          if (delay) expect(status.status).toBe('success')
          expect(['success', 'cancelled']).toContain(status.status)
          expect(after.stdout).toContain(
            status.status === 'success' ? 'JobState=COMPLETED' : 'JobState=CANCELLED'
          )
        }
      }
    },
    300000
  )

  it.skipIf(!reliability)(
    'reliability: injected transport, timeout and empty-history faults preserve a real held job until recovery',
    async () => {
      const submitted = await submit('#SBATCH --hold\nprintf recovered-held-job')
      await execution.waitForDispatch([submitted.job_id])
      const job = await db.repositories.jobs.get(submitted.job_id)
      const schedulerId = JSON.parse(job!.remote_handle!).scheduler_job_id
      for (const fault of ['connection-closed', 'query-timeout', 'empty-history'] as const) {
        let injections = 0
        const injected: ComputeConnectionBrokerAcquirer = {
          acquire: async (id, request) => {
            const lease = await connectionBroker.acquire(id, request)
            return {
              ...lease,
              run: async (command, options) => {
                if (/^(?:squeue|scontrol|sacct) /.test(command)) {
                  injections++
                  const result = {
                    stdout: '',
                    stderr:
                      fault === 'connection-closed'
                        ? 'Injected test connection closed.'
                        : fault === 'empty-history' && command.startsWith('scontrol ')
                          ? 'slurm_load_jobs error: Invalid job id specified'
                          : '',
                    exitCode:
                      fault === 'connection-closed'
                        ? 255
                        : fault === 'query-timeout'
                          ? null
                          : command.startsWith('scontrol ')
                            ? 1
                            : 0,
                    timedOut: fault === 'query-timeout',
                    truncated: false
                  }
                  await record('fault-injection', { kind: fault, command, result })
                  return result
                }
                return lease.run(command, options)
              }
            }
          }
        }
        const poller = execution.createPoller({
          connectionBroker: injected,
          hostRepository: hosts,
          jobRepository: db.repositories.jobs
        })
        try {
          await poller.tick()
          await poller.pause()
          expect(injections).toBeGreaterThan(0)
          const snapshot = await service.getJobResult(submitted.job_id)
          expect(snapshot).toMatchObject({ status: 'submitted', result_final: false })
          expect(snapshot.error).toBeUndefined()
          const observed = await remote(`scontrol show job ${schedulerId} --oneliner`)
          expect(observed.exitCode).toBe(0)
          expect(observed.stdout).toContain('JobState=PENDING')
          expect(observed.stdout).toContain('Reason=JobHeldUser')
          await record('injected-fault-preserved-real-job', { fault, snapshot, observed })
        } finally {
          await poller.stop()
        }
        const recovered = makePoller()
        try {
          await recovered.tick()
          await recovered.pause()
          expect(await service.getJobStatus(submitted.job_id)).toMatchObject({
            status: 'submitted'
          })
          expect(
            (await db.repositories.jobs.get(submitted.job_id))?.last_poll_error
          ).toBeUndefined()
        } finally {
          await recovered.stop()
        }
      }
      const fulfill = db.repositories.operations.fulfill.bind(db.repositories.operations)
      db.repositories.operations.fulfill = async (...args) => {
        try {
          return await fulfill(...args)
        } catch (error) {
          const detail = {
            message: error instanceof Error ? error.message : String(error),
            code:
              typeof error === 'object' && error !== null && 'code' in error ? error.code : null,
            stack: error instanceof Error ? error.stack : undefined
          }
          await record('cancellation-fulfill-error', detail)
          console.error('CANCELLATION_FULFILL_ERROR', detail)
          throw error
        }
      }
      try {
        await service.cancelJob(submitted.job_id, scope)
        await execution
          .createCancellationReaper(
            db.repositories.operations,
            db.repositories.jobs,
            connectionBroker
          )
          .runOnce()
      } finally {
        db.repositories.operations.fulfill = fulfill
      }
      expect(await service.getJobResult(submitted.job_id)).toMatchObject({
        status: 'cancelled',
        result_final: true
      })
      const final = await remote(`scontrol show job ${schedulerId} --oneliner`)
      expect(final.exitCode).toBe(0)
      expect(final.stdout).toContain('JobState=CANCELLED')
      await record('injected-fault-recovery-cancelled-real-job', { schedulerId, final })
    },
    180000
  )

  it.skipIf(!reliability)(
    'reliability: injected cancellation refusal leaves a real job running for agent inspection',
    async () => {
      const submitted = await submit('printf usable-partial-output > partial.txt\nsleep 900', {
        timeoutSeconds: 1000
      })
      const running = await wait(submitted.job_id, (job) => job.status === 'running')
      const schedulerId = JSON.parse(running.remote_handle!).scheduler_job_id
      const injected: ComputeConnectionBrokerAcquirer = {
        acquire: async (id, request) => {
          const lease = await connectionBroker.acquire(id, request)
          return {
            ...lease,
            run: async (command, options) => {
              if (command.startsWith('scancel ')) {
                const result = {
                  stdout: '',
                  stderr: 'Injected test refusal: scancel permission denied.',
                  exitCode: 1,
                  timedOut: false,
                  truncated: false
                }
                await record('fault-injection', { kind: 'cancel-request-refusal', command, result })
                return result
              }
              return lease.run(command, options)
            }
          }
        }
      }
      await service.cancelJob(submitted.job_id, scope)
      const reaper = execution.createCancellationReaper(
        db.repositories.operations,
        db.repositories.jobs,
        injected
      )
      await reaper.runOnce()
      const snapshot = await service.getJobResult(submitted.job_id)
      expect(snapshot).toMatchObject({
        status: 'running',
        result_final: false,
        cancellation: { status: 'failed', error: { code: 'cancel_request_rejected' } }
      })
      expect((await remote(`scontrol show job ${schedulerId} --oneliner`)).stdout).toContain(
        'JobState=RUNNING'
      )
      await makePoller().tick()
      expect((await db.repositories.jobs.get(submitted.job_id))?.status).toBe('running')
      if (process.env['COMPUTE_SLURM_RETAIN_AGENT_JOB'] === '1' && evidenceDirectory) {
        retainedForAgent.add(submitted.job_id)
        await writeFile(
          join(evidenceDirectory, 'agent-cancel-rejected.json'),
          JSON.stringify(
            {
              name: 'cancel-rejected',
              snapshot,
              schedulerJobId: schedulerId,
              userGoal:
                'The user already requested cancellation. Stop the original job, inspect any usable partial output and explain the outcome.',
              expectedRemotePath: `${snapshot.remote_workdir}/partial.txt`,
              injection:
                'Only the cancellation request refusal was injected in the client test transport. The job and every scheduler observation are real.'
            },
            null,
            2
          )
        )
      }
    },
    180000
  )
})

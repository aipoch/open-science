// RUN_COMPUTE_SLURM=1 COMPUTE_TEST_SSH_ALIAS=hpc-dev npx vitest run src/main/compute/slurm.real-ssh.integration.test.ts
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ComputeJob } from '../../shared/compute'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeJobCancellationReaper } from './compute-job-cancellation-owner'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import { ComputeService } from './compute-service'
import { SshConfigComputeConnectionBroker } from './connection-broker'
import { harvestJob } from './harvest-engine'
import { JobPoller } from './job-poller'
import { ComputeJobDeletionOwner } from './job-deletion-owner'
import { ComputeHostRepository } from './repository'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import { SystemScpRunner } from './scp-runner'
import { SystemSshRunner } from './ssh-runner'
import { parseSbatchJobId, recoverSlurmJob } from './slurm-driver'
import { getJobHarvestDir } from './workspace-path'

const alias = process.env['COMPUTE_TEST_SSH_ALIAS'] ?? ''
const run = process.env['RUN_COMPUTE_SLURM'] === '1' && alias !== ''
const partition = process.env['COMPUTE_SLURM_PARTITION'] ?? 'debug'
const scope = { providerId: `ssh:${alias}`, projectId: 'slurm-cert', sessionId: 'slurm-cert' }
const terminal = (job: ComputeJob): boolean =>
  ['success', 'failed', 'timeout', 'error'].includes(job.status)

describe.skipIf(!run)('Slurm lifecycle on real SSH + scheduler', () => {
  let db: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
  let hosts: ComputeHostRepository
  let connectionBroker: SshConfigComputeConnectionBroker
  let service: ComputeService
  const jobs: string[] = []
  const envName = `os-cert-${randomUUID()}`
  const envPath = `~/.openscience/environments/${envName}.sh`
  const envRoot = `~/.openscience/environments/${envName}`
  const schedulerHeader = `#SBATCH --partition=${partition}\n#SBATCH --cpus-per-task=1\n#SBATCH --mem=128M\n`

  const makePoller = (): JobPoller =>
    new JobPoller({ connectionBroker, hostRepository: hosts, jobRepository: db.repositories.jobs })
  const remote = async (command: string): ReturnType<SystemSshRunner['run']> => {
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
  const submit = async (
    command: string,
    options: Parameters<ComputeService['submitJob']>[3] = {}
  ): ReturnType<ComputeService['submitJob']> => {
    const result = await service.submitJob(
      scope.providerId,
      'Open Science Slurm certification',
      schedulerHeader + command,
      { timeoutSeconds: 60, ...options },
      scope
    )
    jobs.push(result.job_id)
    return result
  }

  beforeAll(async () => {
    db = await createMigratedComputeTestDatabase('os-slurm-real-')
    hosts = new ComputeHostRepository(async () => db.client)
    await hosts.create({ sshAlias: alias, executionMode: 'slurm' })
    const runner = new SystemSshRunner()
    const scpRunner = new SystemScpRunner()
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
      storageRoot: db.storageRoot
    })
    expect((await service.probe(scope.providerId)).detectedScheduler).toBe('slurm')
    const setup = await remote(
      `mkdir -p ~/.openscience/environments && python3 -m venv --without-pip ${quoteRemotePath(envRoot)} && printf '%s\\n' ${shellSingleQuote(`. "$HOME/.openscience/environments/${envName}/bin/activate"\nexport OS_COMPUTE_WITNESS=activated`)} > ${quoteRemotePath(envPath)}`
    )
    expect(setup.exitCode).toBe(0)
  })

  afterAll(async () => {
    if (connectionBroker && db) {
      for (const id of jobs) {
        const job = await db.repositories.jobs.get(id)
        if (!job) continue
        const handle = job.remote_handle ? JSON.parse(job.remote_handle) : undefined
        if (handle?.scheduler_job_id && /^\d+$/.test(handle.scheduler_job_id))
          await remote(`scancel ${handle.scheduler_job_id} 2>/dev/null || true`)
        if (job.remote_workdir) await remote(`rm -rf -- ${quoteRemotePath(job.remote_workdir)}`)
      }
      await remote(`rm -f -- ${quoteRemotePath(envPath)} && rm -rf -- ${quoteRemotePath(envRoot)}`)
    }
    await db?.dispose()
  })

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
    const completed = await wait(submitted.job_id, terminal, makePoller())
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
      const recovered = await wait(submitted.job_id, terminal, makePoller())
      expect(recovered.status).toBe('success')
      expect(JSON.parse(recovered.remote_handle!).scheduler_job_id).toBe(schedulerId)
      expect(recovered.stdout_tail).toContain('recovered')
    } finally {
      await hosts.updateExecutionMode(scope.providerId, 'slurm')
    }
  }, 180000)

  it('does not adopt a same-name scheduler job from another workdir', async () => {
    const jobId = randomUUID()
    const expectedWorkdir = `~/.openscience/jobs/${jobId}`
    const decoyWorkdir = `~/.openscience/slurm-decoy-${jobId}`
    const launched = await remote(
      [
        `mkdir -p ${quoteRemotePath(expectedWorkdir)} ${quoteRemotePath(decoyWorkdir)}`,
        `touch ${quoteRemotePath(`${expectedWorkdir}/job.sbatch`)}`,
        `cd ${quoteRemotePath(decoyWorkdir)}`,
        `sbatch --parsable --hold --partition=${partition} --job-name=openscience-${jobId} --chdir="$PWD" --output=stdout --error=stderr --wrap=true`
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
    expect(result.stderr_tail).toContain('science-failure')
    const missing = await submit('echo must-not-run', { environment: `${envName}-missing` })
    const missingResult = await wait(missing.job_id)
    expect(missingResult.status).toBe('failed')
    expect(missingResult.stderr_tail).toContain('compute-env-setup')
    expect(missingResult.stdout_tail ?? '').not.toContain('must-not-run')
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
    const reaper = new ComputeJobCancellationReaper(
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
    expect((await service.getJobResult(submitted.job_id)).error_code).toBe('dispatch_failed')
  }, 180000)

  it('distinguishes an sbatch exit 255 rejection from an SSH transport failure', async () => {
    const submitted = await submit('#SBATCH --cpus=1\necho must-not-run')
    const rejected = await wait(submitted.job_id)
    expect(rejected.status).toBe('error')
    expect(rejected.stderr_tail).toMatch(/--cpus=1.*ambiguous/is)
    expect(rejected.remote_handle).toBeUndefined()
    expect((await service.getJobResult(submitted.job_id)).error_code).toBe('dispatch_failed')
  }, 180000)

  it('preserves direct SSH execution with the same named environment', async () => {
    await hosts.updateExecutionMode(scope.providerId, 'direct_ssh')
    try {
      const submitted = await service.submitJob(
        scope.providerId,
        'Open Science direct SSH environment regression',
        'python -c "import sys; assert sys.prefix != sys.base_prefix"\nprintf direct-ready',
        { environment: envName, timeoutSeconds: 30 },
        scope
      )
      jobs.push(submitted.job_id)
      const completed = await wait(submitted.job_id)
      expect(completed.status).toBe('success')
      expect(completed.stdout_tail).toContain('direct-ready')
      expect(JSON.parse(completed.remote_handle!).pid).toBeGreaterThan(1)
    } finally {
      await hosts.updateExecutionMode(scope.providerId, 'slurm')
    }
  }, 180000)

  it('keeps a scheduler-held job submitted and cancels it before execution', async () => {
    const submitted = await submit('#SBATCH --hold\necho must-not-run')
    const held = await wait(submitted.job_id, (job) =>
      Boolean(job.last_poll_error?.includes('slurm_pending'))
    )
    expect(held.status).toBe('submitted')
    expect((await service.getJobResult(submitted.job_id)).last_poll_error).toContain(
      'slurm_pending'
    )
    await service.cancelJob(submitted.job_id, scope)
    const reaper = new ComputeJobCancellationReaper(
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
    const owner = new ComputeJobDeletionOwner({
      jobRepository: db.repositories.jobs,
      lifecycle: new ComputeJobLifecycle(db.repositories.jobs),
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
})

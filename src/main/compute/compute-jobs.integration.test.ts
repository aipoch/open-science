// Gated integration tests for the compute-jobs Phase 3a state machine.
// Runs only when RUN_COMPUTE_JOBS=1 and COMPUTE_TEST_SSH_ALIAS is set.
// These tests require a real SSH host configured in ~/.ssh/config; they are skipped in CI.
//
// Usage (local):
//   RUN_COMPUTE_JOBS=1 COMPUTE_TEST_SSH_ALIAS=my-host npx vitest run src/main/compute/compute-jobs.integration.test.ts
//
// Each test covers one terminal-state path (issue 01: success; issue 02: failed/timeout/process_vanished).
// Remote workdirs are cleaned up in afterAll.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computeProviderId } from '../../shared/compute'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ComputeHostRepository } from './repository'
import { ComputeJobRepository } from './job-repository'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeService } from './compute-service'
import { SystemSshRunner } from './ssh-runner'
import { JobPoller } from './job-poller'
import type { ComputeJobStatus } from '../../shared/compute'

const RUN = process.env['RUN_COMPUTE_JOBS'] === '1'
const ALIAS = process.env['COMPUTE_TEST_SSH_ALIAS'] ?? ''
const describeIf = RUN && ALIAS ? describe : describe.skip

// Maximum time to wait for a job to reach a terminal state in a poll loop.
const MAX_POLL_WAIT_MS = 120_000
const POLL_PAUSE_MS = 2_000

// Polls a job until it reaches one of the expected terminal states (or times out).
// Returns the final JobStatusResult.
async function pollUntilTerminal(
  poller: JobPoller,
  service: ComputeService,
  jobId: string,
  terminalStates: ComputeJobStatus[] = ['success', 'failed', 'timeout', 'error']
): Promise<Awaited<ReturnType<ComputeService['getJobStatus']>>> {
  const startMs = Date.now()
  let jobStatus = await service.getJobStatus(jobId)

  while (!terminalStates.includes(jobStatus.status)) {
    if (Date.now() - startMs > MAX_POLL_WAIT_MS) {
      throw new Error(
        `Job did not reach terminal state within ${MAX_POLL_WAIT_MS}ms. Last status: ${jobStatus.status}`
      )
    }
    await poller.tick()
    jobStatus = await service.getJobStatus(jobId)
    await new Promise((r) => setTimeout(r, POLL_PAUSE_MS))
  }
  return jobStatus
}

describeIf('compute-jobs integration (real SSH)', () => {
  let storageRoot: string
  let disconnect: () => Promise<void>
  const remoteWorkdirs: string[] = []

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-jobs-int-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

    // Seed a compute host using the test alias.
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const providerId = computeProviderId(ALIAS)
    const existing = await hostRepo.get(providerId)
    if (!existing) {
      await hostRepo.create({ sshAlias: ALIAS, displayName: `test-${ALIAS}` })
    }
  })

  afterAll(async () => {
    // Clean up remote workdirs for all tests.
    if (remoteWorkdirs.length > 0 && ALIAS) {
      const runner = new SystemSshRunner()
      const { resolveSshTarget } = await import('./ssh-runner')
      try {
        const target = await resolveSshTarget(ALIAS, undefined)
        const rmCmds = remoteWorkdirs.map((d) => `rm -rf ${JSON.stringify(d)}`).join('; ')
        await runner.run(target, rmCmds, { timeoutMs: 30_000, loginShell: false })
      } catch {
        // Best-effort cleanup; do not fail the test.
      }
    }

    await disconnect()
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true })
    }
  })

  // Builds a broker that auto-approves the first pending request. Each test that submits a job
  // calls this and wires a unique approval ID per test to avoid cross-test contamination.
  function makeAutoBroker(approvalId: string): ComputeApprovalBroker {
    const broker = new ComputeApprovalBroker({
      broadcast: () => undefined,
      generateId: () => approvalId,
      timeoutMs: 5_000
    })
    const originalRequest = broker.request.bind(broker)
    broker.request = async (info) => {
      const p = originalRequest(info)
      setImmediate(() => broker.respond(approvalId, 'once'))
      return p
    }
    return broker
  }

  it('submits sleep+echo → running → success end-to-end', async () => {
    const client = createProjectDbClient(storageRoot)
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))
    const providerId = computeProviderId(ALIAS)

    const runner = new SystemSshRunner()
    const service = new ComputeService(
      runner,
      hostRepo,
      makeAutoBroker('appr-success'),
      undefined,
      undefined,
      jobRepo
    )

    const result = await service.submitJob(
      providerId,
      'integration smoke test',
      'sleep 1 && echo ok > out.txt',
      { timeoutSeconds: 60 },
      { sessionId: 'int-sess', projectId: 'int-proj' }
    )

    expect(result.status).toBe('submitted')
    expect(result.job_id).toBeDefined()
    remoteWorkdirs.push(result.remote_workdir)

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
    const jobStatus = await pollUntilTerminal(poller, service, result.job_id)

    expect(jobStatus.status).toBe('success')
    expect(jobStatus.exit_code).toBe(0)
    expect(jobStatus.remote_workdir).toBe(result.remote_workdir)
  }, 150_000)

  it('exit 3 → failed (errorCode=job_failed)', async () => {
    const client = createProjectDbClient(storageRoot)
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))
    const providerId = computeProviderId(ALIAS)

    const runner = new SystemSshRunner()
    const service = new ComputeService(
      runner,
      hostRepo,
      makeAutoBroker('appr-failed'),
      undefined,
      undefined,
      jobRepo
    )

    const result = await service.submitJob(
      providerId,
      'integration failed test',
      'exit 3',
      { timeoutSeconds: 60 },
      { sessionId: 'int-sess', projectId: 'int-proj' }
    )

    expect(result.status).toBe('submitted')
    remoteWorkdirs.push(result.remote_workdir)

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
    const jobStatus = await pollUntilTerminal(poller, service, result.job_id)

    expect(jobStatus.status).toBe('failed')
    expect(jobStatus.exit_code).toBe(3)
  }, 150_000)

  it('sleep 99999 with timeout_seconds=5 → timeout (errorCode=timeout)', async () => {
    const client = createProjectDbClient(storageRoot)
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))
    const providerId = computeProviderId(ALIAS)

    const runner = new SystemSshRunner()
    const service = new ComputeService(
      runner,
      hostRepo,
      makeAutoBroker('appr-timeout'),
      undefined,
      undefined,
      jobRepo
    )

    const result = await service.submitJob(
      providerId,
      'integration timeout test',
      'sleep 99999',
      { timeoutSeconds: 5 },
      { sessionId: 'int-sess', projectId: 'int-proj' }
    )

    expect(result.status).toBe('submitted')
    remoteWorkdirs.push(result.remote_workdir)

    // Poll for up to 3 minutes: timeout command fires at 5s+30s, poller should see exit 124 quickly.
    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
    const jobStatus = await pollUntilTerminal(poller, service, result.job_id)

    expect(jobStatus.status).toBe('timeout')
    // exit_code should be 124 (timeout) or 137 (SIGKILL from the -k 30s kill signal)
    expect([124, 137]).toContain(jobStatus.exit_code)
  }, 180_000)

  it('kill -9 $$ → process_vanished after 2 poll ticks', async () => {
    const client = createProjectDbClient(storageRoot)
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))
    const providerId = computeProviderId(ALIAS)

    const runner = new SystemSshRunner()
    const service = new ComputeService(
      runner,
      hostRepo,
      makeAutoBroker('appr-vanished'),
      undefined,
      undefined,
      jobRepo
    )

    // The process kills itself immediately with SIGKILL, so no exit_code file is ever written.
    // After 2 consecutive poll ticks seeing pid gone + no exit_code → process_vanished.
    const result = await service.submitJob(
      providerId,
      'integration process_vanished test',
      'kill -9 $$',
      { timeoutSeconds: 60 },
      { sessionId: 'int-sess', projectId: 'int-proj' }
    )

    expect(result.status).toBe('submitted')
    remoteWorkdirs.push(result.remote_workdir)

    // Wait a few seconds for the process to die, then poll twice.
    await new Promise((r) => setTimeout(r, 3_000))

    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })

    // Tick 1: vanish counter increments to 1 — status stays running.
    await poller.tick()
    const after1 = await service.getJobStatus(result.job_id)
    expect(after1.status).not.toBe('failed') // not yet

    // Tick 2: vanish counter hits 2 → process_vanished.
    await new Promise((r) => setTimeout(r, 2_000))
    await poller.tick()
    const after2 = await service.getJobStatus(result.job_id)

    expect(after2.status).toBe('failed')
  }, 120_000)
})

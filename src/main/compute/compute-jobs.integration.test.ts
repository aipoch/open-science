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

const RUN = process.env['RUN_COMPUTE_JOBS'] === '1'
const ALIAS = process.env['COMPUTE_TEST_SSH_ALIAS'] ?? ''
const describeIf = RUN && ALIAS ? describe : describe.skip

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

  it('submits echo ok → running → success end-to-end', async () => {
    const client = createProjectDbClient(storageRoot)
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))

    const providerId = computeProviderId(ALIAS)

    // Approval broker: auto-approve everything (test context).
    const broker = new ComputeApprovalBroker({
      broadcast: () => undefined,
      generateId: () => 'test-approval-id',
      timeoutMs: 1000
      // Auto-approve by resolving the pending request immediately.
    })
    // Immediately settle with 'once' so we don't need a renderer.
    const originalRequest = broker.request.bind(broker)
    broker.request = async (info) => {
      const p = originalRequest(info)
      // Respond to the pending request after a microtask.
      setImmediate(() => broker.respond('test-approval-id', 'once'))
      return p
    }

    const runner = new SystemSshRunner()
    const service = new ComputeService(runner, hostRepo, broker, undefined, undefined, jobRepo)

    const result = await service.submitJob(
      providerId,
      'integration smoke test',
      'sleep 1 && echo ok > out.txt',
      { timeoutSeconds: 60 },
      { sessionId: 'int-sess', projectId: 'int-proj' }
    )

    expect(result.status).toBe('submitted')
    expect(result.job_id).toBeDefined()
    remoteWorkdir = result.remote_workdir

    // Poll until success or timeout (max 60 ticks of 15s = 900s; in practice much faster).
    const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
    let jobStatus = await service.getJobStatus(result.job_id)

    const maxWaitMs = 120_000 // 2 minutes max
    const startMs = Date.now()

    while (!['success', 'failed', 'timeout', 'error'].includes(jobStatus.status)) {
      if (Date.now() - startMs > maxWaitMs) {
        throw new Error(
          `Job did not reach terminal state within ${maxWaitMs}ms. Last status: ${jobStatus.status}`
        )
      }
      await poller.tick()
      jobStatus = await service.getJobStatus(result.job_id)
      // Brief pause between polls.
      await new Promise((r) => setTimeout(r, 2_000))
    }

    expect(jobStatus.status).toBe('success')
    expect(jobStatus.exit_code).toBe(0)
    expect(jobStatus.remote_workdir).toBe(remoteWorkdir)
  }, 150_000) // 2.5 minute timeout for the whole test
})

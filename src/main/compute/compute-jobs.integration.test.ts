// Gated integration tests for Phase 3a compute-jobs (issues 01 + 03).
// Runs only when RUN_COMPUTE_JOBS=1 and COMPUTE_TEST_SSH_ALIAS is set.
// These tests require a real SSH host configured in ~/.ssh/config; they are skipped in CI.
//
// Usage (local):
//   RUN_COMPUTE_JOBS=1 COMPUTE_TEST_SSH_ALIAS=my-host npx vitest run src/main/compute/compute-jobs.integration.test.ts

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  let remoteWorkdir: string | undefined

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
    // Clean up remote workdir if we know it.
    if (remoteWorkdir && ALIAS) {
      const runner = new SystemSshRunner()
      const { resolveSshTarget } = await import('./ssh-runner')
      try {
        const target = await resolveSshTarget(ALIAS, undefined)
        await runner.run(target, `rm -rf ${JSON.stringify(remoteWorkdir)}`, {
          timeoutMs: 30_000,
          loginShell: false
        })
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

  it('stages a workspace file and job can read it via ./dst_filename', async () => {
    const client = createProjectDbClient(storageRoot)
    const hostRepo = new ComputeHostRepository(() => Promise.resolve(client))
    const jobRepo = new ComputeJobRepository(() => Promise.resolve(client))
    const providerId = computeProviderId(ALIAS)

    // Write a local file in a temp workspace dir.
    const workspaceDir = await mkdtemp(join(tmpdir(), 'os-int-workspace-'))
    const localFile = join(workspaceDir, 'hello.txt')
    await writeFile(localFile, 'staged-content\n')

    let stagedWorkdir: string | undefined

    try {
      const broker = new ComputeApprovalBroker({
        broadcast: () => undefined,
        generateId: () => 'test-approval-staging',
        timeoutMs: 1000
      })
      // Auto-approve both request and requestWithContext for CI-free tests.
      const originalReqCtx = broker.requestWithContext.bind(broker)
      broker.requestWithContext = async (info, ctx) => {
        const p = originalReqCtx(info, ctx)
        setImmediate(() => broker.respond('test-approval-staging', 'once'))
        return p
      }

      const runner = new SystemSshRunner()
      const service = new ComputeService(runner, hostRepo, broker, undefined, undefined, jobRepo)

      const result = await service.submitJob(
        providerId,
        'input staging integration test',
        // Read the staged file and verify content.
        'cat ./hello.txt | grep staged-content && echo PASS > verify.txt',
        {
          timeoutSeconds: 60,
          inputs: [{ src: 'hello.txt', dst_filename: 'hello.txt' }],
          workspaceCwd: workspaceDir
        },
        { sessionId: 'int-sess-staging', projectId: 'int-proj' }
      )

      expect(result.status).toBe('submitted')
      stagedWorkdir = result.remote_workdir

      // Poll until terminal state.
      const poller = new JobPoller({ runner, hostRepository: hostRepo, jobRepository: jobRepo })
      let jobStatus = await service.getJobStatus(result.job_id)
      const maxWaitMs = 120_000
      const startMs = Date.now()
      while (!['success', 'failed', 'timeout', 'error'].includes(jobStatus.status)) {
        if (Date.now() - startMs > maxWaitMs)
          throw new Error(`Staging job timed out: ${jobStatus.status}`)
        await poller.tick()
        jobStatus = await service.getJobStatus(result.job_id)
        await new Promise((r) => setTimeout(r, 2_000))
      }

      expect(jobStatus.status).toBe('success')
    } finally {
      // Best-effort remote cleanup.
      if (stagedWorkdir && ALIAS) {
        const runner = new SystemSshRunner()
        const { resolveSshTarget } = await import('./ssh-runner')
        try {
          const target = await resolveSshTarget(ALIAS, undefined)
          await runner.run(target, `rm -rf ${JSON.stringify(stagedWorkdir)}`, {
            timeoutMs: 30_000,
            loginShell: false
          })
        } catch {
          /* ignore */
        }
      }
      await rm(workspaceDir, { recursive: true, force: true })
    }
  }, 150_000)
})

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as computePackage from '@aipoch/compute/node'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AgentComputeService } from './agent-compute-service'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeService } from './compute-service'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { harvestJob } from './harvest-engine'
import { HostedTargetCatalog } from './hosted-target-catalog'
import { createHuggingFaceJobRuntime } from './hugging-face-job-runtime'
import { ComputeJobRepository } from './job-repository'
import { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './workspace-path'

import { resolveConfigRoot } from '../storage-root'
vi.mock('../storage-root', async (load) => ({
  ...(await load<typeof import('../storage-root')>()),
  resolveConfigRoot: vi.fn()
}))

vi.mock('@aipoch/compute/node', async (load) => ({
  ...(await load<typeof import('@aipoch/compute/node')>()),
  stageHuggingFaceInputs: vi.fn(),
  listHuggingFaceJobOutputs: vi.fn(),
  archiveHuggingFaceOutputs: vi.fn(),
  cleanupHuggingFaceBucketFiles: vi.fn()
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

// Set COMPUTE_TEST_HF_DOCKER=1 to execute the submitted argv in the locally cached image.
it(
  'recovers a submitted file job after losing the creation response and cleans up only after publication',
  () => exerciseSubmission('completed'),
  60_000
)
it(
  'retains quota-rejected inputs on restart until manual cleanup verifies the original bucket',
  () => exerciseSubmission('quota-rejected'),
  60_000
)

it('recovers a staged-only cancellation after cleanup fails and the app restarts', () =>
  exerciseSubmission('cancel-during-staging'))

async function exerciseSubmission(
  scenario: 'completed' | 'quota-rejected' | 'cancel-during-staging'
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hf-host-integration-'))
  vi.mocked(resolveConfigRoot).mockReturnValue(root)
  let client = createProjectDbClient(root)
  const getClient = async (): Promise<typeof client> => client
  const catalog = new HostedTargetCatalog(() => root)
  const hosts = new ComputeHostRepository(getClient, { hostedTargets: catalog })
  const jobs = new ComputeJobRepository(getClient)
  const operations = new ComputeJobOperationRepository(getClient)
  const deniedSsh = async (): Promise<never> => {
    throw Error('Unexpected SSH operation')
  }
  let approved = false
  const approval = new ComputeApprovalBroker({
    generateId: randomUUID,
    broadcast(request) {
      expect(request).toMatchObject({
        operation: 'submit_job',
        hosted: { namespace: 'lab', bucket: 'lab/private', flavor: 'cpu-basic' }
      })
      queueMicrotask(() => {
        approved = true
        approval.respond(request.id, 'once')
      })
    }
  })
  const compute = new ComputeService({
    repository: hosts,
    runner: { run: deniedSsh },
    jobRepository: jobs,
    operationRepository: operations,
    approvalBroker: approval,
    storageRoot: root
  })
  const sessions = new EnabledComputeHostsRegistry()
  const agent = new AgentComputeService(compute, sessions)
  const scope = { projectId: 'project-hf', sessionId: 'session-hf', producerRunId: 'run-hf' }
  const workspace = join(root, 'notebooks', scope.projectId, scope.sessionId)
  const inputs = join(root, 'inputs')
  const outputs = join(root, 'outputs')
  const input = Buffer.from([0, 128, 255, 32, 92])
  const sha256 = createHash('sha256').update(input).digest('hex')
  const command = 'cp /inputs/input.bin result.bin'
  let lookups = 0
  let creates = 0
  let archiveAttempts = 0
  let remote: Record<string, unknown> | undefined
  vi.stubEnv('HF_TOKEN', 'offline-test')
  vi.stubEnv('HF_ENDPOINT', 'https://huggingface.co')
  vi.stubGlobal('fetch', async (url: URL | string, init?: RequestInit) => {
    const { origin, pathname } = new URL(url)
    expect(origin).toBe('https://huggingface.co')
    if (pathname === '/api/whoami-v2') return Response.json({ name: 'lab', id: 'owner' })
    if (pathname === '/api/buckets/lab/private')
      return Response.json({ id: 'lab/private', private: true })
    if (pathname === '/api/jobs/hardware')
      return Response.json([{ name: 'cpu-basic', unitLabel: 'minute', unitCostMicroUSD: 123 }])
    if (pathname === '/api/jobs/lab' && init?.method === 'POST') {
      creates++
      expect(approved).toBe(true)
      const spec = JSON.parse(String(init.body))
      expect(spec).toMatchObject({
        attempts: 1,
        command: ['bash', '-c', 'cd /outputs || exit 1\n' + command],
        volumes: [
          {
            source: 'lab/private',
            mountPath: '/inputs',
            readOnly: true,
            path: 'open-science/' + spec.labels.open_science_run + '/inputs'
          },
          {
            source: 'lab/private',
            mountPath: '/outputs',
            readOnly: false,
            path: 'open-science/' + spec.labels.open_science_run + '/outputs'
          }
        ]
      })
      expect(await readFile(join(inputs, 'input.bin'))).toEqual(input)
      if (scenario === 'quota-rejected') return new Response(null, { status: 402 })
      if (process.env.COMPUTE_TEST_HF_DOCKER === '1') {
        await promisify(execFile)(
          'docker',
          [
            'run',
            '--rm',
            '--pull=never',
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--mount',
            `type=bind,src=${inputs},dst=/inputs,readonly`,
            '--mount',
            `type=bind,src=${outputs},dst=/outputs`,
            spec.dockerImage,
            ...spec.command
          ],
          { timeout: 30000 }
        )
      } else await copyFile(join(inputs, 'input.bin'), join(outputs, 'result.bin'))
      remote = { ...spec, id: 'remote-1', owner: { name: 'lab' }, status: { stage: 'COMPLETED' } }
      throw Error('lost reply after provider accepted job')
    }
    if (pathname === '/api/jobs/lab') {
      lookups++
      return Response.json(remote ? [remote] : [])
    }
    if (pathname === '/api/jobs/lab/remote-1' && remote) return Response.json(remote)
    if (pathname === '/api/jobs/lab/remote-1/logs')
      return new Response('data: {"data":"done"}\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      })
    throw Error('Unexpected HF request: ' + pathname)
  })
  vi.mocked(computePackage.stageHuggingFaceInputs).mockImplementation(
    async ({ bucket, runId, files }) => {
      expect(approved).toBe(true)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({ path: 'input.bin', sha256, bytes: input.length })
      await copyFile(files[0].localPath, join(inputs, files[0].path))
      return {
        inputs: { bucket, prefix: 'open-science/' + runId + '/inputs' },
        outputs: { bucket, prefix: 'open-science/' + runId + '/outputs' }
      }
    }
  )
  const resultFile = { path: 'result.bin', bytes: input.length }
  const scratchFile = { path: 'scratch.bin', bytes: 3 }
  const listOutputs = vi.mocked(computePackage.listHuggingFaceJobOutputs)
  listOutputs.mockResolvedValue([resultFile, scratchFile])
  vi.mocked(computePackage.archiveHuggingFaceOutputs).mockImplementation(
    async ({ stagingDirectory, files }) => {
      expect(files.map((f) => f.path)).toEqual(['result.bin'])
      expect(await readFile(join(outputs, 'result.bin'))).toEqual(input)
      if (++archiveAttempts === 1) throw new Error('interrupted download')
      expect(computePackage.cleanupHuggingFaceBucketFiles).not.toHaveBeenCalled()
      const localPath = join(stagingDirectory, 'result.bin')
      await copyFile(join(outputs, 'result.bin'), localPath)
      return [{ path: 'result.bin', localPath, bytes: input.length, sha256 }]
    }
  )
  vi.mocked(computePackage.cleanupHuggingFaceBucketFiles).mockImplementation(
    async ({ runId, expectedOutputs, discardedOutputs }) => {
      expect(discardedOutputs).toEqual([{ path: 'scratch.bin', bytes: 3, xetHash: 'd'.repeat(64) }])
      expect(expectedOutputs).toEqual([
        expect.objectContaining({ path: 'result.bin', sha256, bytes: input.length })
      ])
      expect((await jobs.get(runId))?.file_evidence?.checksum).toBeTruthy()
      const local = join(
        getJobHarvestDir(root, scope.projectId, scope.sessionId, runId),
        'featured',
        'result.bin'
      )
      expect(await readFile(local)).toEqual(input)
      await rm(outputs, { recursive: true })
    }
  )
  const makeRuntime = (): ReturnType<typeof createHuggingFaceJobRuntime> =>
    createHuggingFaceJobRuntime({
      jobRepository: jobs,
      operationRepository: operations,
      storageRoot: root,
      onJobUpdated: () => undefined,
      harvest: (job, hostedOutputs, signal) =>
        harvestJob(job, {
          jobRepository: jobs,
          hostRepository: hosts,
          storageRoot: root,
          connectionBroker: { acquire: deniedSsh },
          hostedOutputs,
          signal
        })
    })
  let runtime = makeRuntime()
  try {
    await migrateApplicationDatabase(client)
    await Promise.all([workspace, inputs, outputs].map((p) => mkdir(p, { recursive: true })))
    await writeFile(join(workspace, 'input.bin'), input)
    const target = await catalog.create({
      displayName: 'HF test',
      namespace: 'lab',
      bucket: 'lab/private',
      flavor: 'cpu-basic',
      image: 'ubuntu:24.04',
      timeoutSeconds: 60
    })
    sessions.set(scope.sessionId, [target.providerId])
    const { job_id } = await agent.submitJob(scope, target.providerId, 'verify', command, {
      workspaceCwd: workspace,
      inputs: [{ src: 'input.bin', dst_filename: 'input.bin' }],
      outputManifest: JSON.stringify(['result.bin'])
    })
    await writeFile(join(workspace, 'input.bin'), 'changed after approval')
    if (scenario === 'cancel-during-staging') {
      const stage = vi.mocked(computePackage.stageHuggingFaceInputs)
      const stageFiles = stage.getMockImplementation()!
      stage.mockImplementationOnce(async (request) => {
        const mounts = await stageFiles(request)
        await agent.cancelJob(scope, target.providerId, job_id)
        return mounts
      })
      const cleanup = vi.mocked(computePackage.cleanupHuggingFaceBucketFiles)
      cleanup
        .mockRejectedValueOnce(new Error('Temporary cleanup failure'))
        .mockResolvedValue(undefined)
      runtime.start()
      for (let n = 0; n < 5 && !cleanup.mock.calls.length; n++) await runtime.tick()
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(await jobs.get(job_id)).toMatchObject({
        cancellation_status: 'cancelled',
        remote_cleanup_disposition: 'pending'
      })
      await runtime.stop()
      await client.$disconnect()
      client = createProjectDbClient(root)
      runtime = makeRuntime()
      runtime.start()
      await runtime.tick()
      expect(cleanup).toHaveBeenCalledTimes(2)
      expect(cleanup).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bucket: 'lab/private',
          runId: job_id,
          expectedOutputs: [],
          expectedInputs: [{ path: 'input.bin', bytes: input.length, sha256 }]
        })
      )
      expect((await jobs.get(job_id))?.remote_cleanup_disposition).toBe('cleaned')
      expect(creates).toBe(0)
      expect(lookups).toBe(0)
      expect(listOutputs).not.toHaveBeenCalled()
      return
    }
    runtime.start()
    for (let n = 0; n < 4 && !creates; n++) await runtime.tick()
    expect(creates).toBe(1)
    await runtime.stop()
    await client.$disconnect()
    client = createProjectDbClient(root)
    runtime = makeRuntime()
    runtime.start()
    if (scenario === 'quota-rejected') {
      await runtime.tick()
      expect(await jobs.get(job_id)).toMatchObject({
        status: 'error',
        error_code: 'dispatch_failed',
        error_message: expect.stringContaining('402'),
        remote_cleanup_disposition: 'pending'
      })
      expect(creates).toBe(1)
      expect(lookups).toBe(0)
      expect(await readFile(join(inputs, 'input.bin'))).toEqual(input)
      expect(archiveAttempts).toBe(0)
      expect(computePackage.cleanupHuggingFaceBucketFiles).not.toHaveBeenCalled()
      await expect(jobs.deleteByOwner({ projectId: scope.projectId })).rejects.toThrow('cleanup')
      const pending = (await jobs.get(job_id))!
      const historicJournal = { ...JSON.parse(pending.remote_handle!), launchNotStarted: undefined }
      expect(
        jobs.getManualStagedCleanup({ ...pending, remote_handle: JSON.stringify(historicJournal) })
      ).toBeUndefined()
      const cleanup = vi.mocked(computePackage.cleanupHuggingFaceBucketFiles)
      cleanup.mockRejectedValueOnce(new Error('Unexpected input')).mockResolvedValue(undefined)
      await expect(runtime.manualCleanup(pending)).rejects.toThrow('Unexpected input')
      expect((await jobs.get(job_id))?.remote_cleanup_disposition).toBe('pending')
      await runtime.manualCleanup(pending)
      expect(cleanup).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bucket: 'lab/private',
          runId: job_id,
          expectedOutputs: [],
          expectedInputs: [{ path: 'input.bin', bytes: input.length, sha256 }]
        })
      )
      expect((await jobs.get(job_id))?.remote_cleanup_disposition).toBe('cleaned')
      expect(creates).toBe(1)
      expect(lookups).toBe(0)
      await jobs.deleteByOwner({ projectId: scope.projectId })
      return
    }
    for (let n = 0; n < 5 && !listOutputs.mock.calls.length; n++) await runtime.tick()
    const pending = await jobs.get(job_id)
    expect(pending?.harvest_error).toBe(
      'harvest pending: HF Bucket did not supply an object hash for an unplanned output.'
    )
    expect(pending?.harvested_at).toBeUndefined()
    expect(computePackage.cleanupHuggingFaceBucketFiles).not.toHaveBeenCalled()
    listOutputs.mockResolvedValue([resultFile, { ...scratchFile, xetHash: 'd'.repeat(64) }])
    vi.mocked(computePackage.cleanupHuggingFaceBucketFiles).mockRejectedValueOnce(
      new Error('Temporary cleanup failure')
    )
    for (let n = 0; n < 8; n++) {
      await runtime.tick()
      if ((await jobs.get(job_id))?.remote_cleanup_disposition === 'cleaned') break
    }
    const job = await jobs.get(job_id)
    expect(job).toMatchObject({
      status: 'success',
      remote_cleanup_disposition: 'cleaned',
      file_evidence: { activityId: job_id }
    })
    expect((await agent.getJobStatus(scope, target.providerId, job_id)).status).toBe('success')
    expect(creates).toBe(1)
    expect(archiveAttempts).toBe(2)
    expect(job?.last_poll_error).toBeUndefined()
    expect(computePackage.stageHuggingFaceInputs).toHaveBeenCalledTimes(1)
    expect(computePackage.cleanupHuggingFaceBucketFiles).toHaveBeenCalledTimes(2)
    await expect(stat(outputs)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await runtime.stop()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
}

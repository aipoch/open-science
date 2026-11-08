import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AgentComputeService } from './agent-compute-service'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeService } from './compute-service'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { harvestJob } from './harvest-engine'
import { ComputeJobRepository } from './job-repository'
import { createModalJobRuntime } from './modal-job-runtime'
import * as sdk from './modal-sdk'
import { ModalTargetCatalog } from './modal-target-catalog'
import { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './workspace-path'

vi.mock('./modal-sdk', async (load) => ({
  ...(await load<typeof import('./modal-sdk')>()),
  resolveModalApp: vi.fn(),
  inspectModalTarget: vi.fn(),
  createModalVolume: vi.fn(),
  stageModalInputs: vi.fn(),
  createModalSandbox: vi.fn(),
  inspectModalSandbox: vi.fn(),
  terminateModalSandbox: vi.fn(),
  listModalJobOutputs: vi.fn(),
  stageModalJobOutputs: vi.fn(),
  cleanupModalVolume: vi.fn()
}))

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const releaseLocks = configureTestRuntimeMetadata()

it('resumes the approved sandbox and publishes frozen-file output before deleting the owned volume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'modal-session-'))
  let client = createProjectDbClient(root)
  const getClient = async (): Promise<typeof client> => client
  const catalog = new ModalTargetCatalog(() => root)
  const hosts = new ComputeHostRepository(getClient, { modalTargets: catalog })
  const jobs = new ComputeJobRepository(getClient)
  const operations = new ComputeJobOperationRepository(getClient)
  const scope = {
    projectId: 'project-modal',
    sessionId: 'session-modal',
    producerRunId: 'run-modal'
  }
  const workspace = join(root, 'notebooks', scope.projectId, scope.sessionId)
  const source = join(workspace, 'source.bin')
  const input = randomBytes(65539)
  const result = Buffer.concat([input, Buffer.from('!')])
  const noSsh = async (): Promise<never> => {
    throw Error('Unexpected SSH call')
  }
  const approval = new ComputeApprovalBroker({
    generateId: randomUUID,
    broadcast: (request) => {
      expect(request).toMatchObject({
        operation: 'submit_job',
        modal: { environmentName: 'dev', appName: 'research', image: 'ubuntu:24.04' }
      })
      queueMicrotask(() => approval.respond(request.id, 'once'))
    }
  })
  const service = new ComputeService({
    runner: { run: noSsh },
    repository: hosts,
    jobRepository: jobs,
    operationRepository: operations,
    approvalBroker: approval,
    storageRoot: root
  })
  const sessions = new EnabledComputeHostsRegistry()
  const agent = new AgentComputeService(service, sessions)
  const newRuntime = (): ReturnType<typeof createModalJobRuntime> =>
    createModalJobRuntime({
      jobRepository: jobs,
      operationRepository: operations,
      storageRoot: root,
      onJobUpdated: () => undefined,
      harvest: (job, modalOutputs, signal) =>
        harvestJob(job, {
          jobRepository: jobs,
          hostRepository: hosts,
          storageRoot: root,
          connectionBroker: { acquire: noSsh },
          modalOutputs,
          signal
        })
    })
  let runtime = newRuntime()
  let staged: Buffer | undefined
  const identifier = { volumeId: 'vo-001', appId: 'ap-001' }
  vi.mocked(sdk.resolveModalApp).mockResolvedValue({ appId: identifier.appId })
  vi.mocked(sdk.inspectModalTarget).mockResolvedValue({ appId: identifier.appId })
  vi.mocked(sdk.createModalVolume).mockImplementation(async (binding) => {
    expect(binding.volumeName).toBe('compute-' + binding.nonce)
    return { volumeId: identifier.volumeId }
  })
  vi.mocked(sdk.stageModalInputs).mockImplementation(async (request) => {
    expect(request).toMatchObject({
      ...identifier,
      files: [{ path: 'input.bin', bytes: input.length, sha256: digest(input) }]
    })
    staged = await readFile(request.files[0].localPath)
    expect(staged).toEqual(input)
  })
  const command = 'cat input.bin > "$OUTPUT_DIR/result.bin" && printf ! >> "$OUTPUT_DIR/result.bin"'
  vi.mocked(sdk.createModalSandbox).mockImplementation(async (request) => {
    expect(request).toMatchObject({
      ...identifier,
      command,
      image: 'ubuntu:24.04',
      cpus: 1,
      memoryMiB: 1024
    })
    expect(staged).toEqual(input)
    return { sandboxId: 'sb-001' }
  })
  vi.mocked(sdk.inspectModalSandbox).mockImplementation(async (ref) => {
    expect(ref).toMatchObject({ ...identifier, sandboxId: 'sb-001' })
    return { status: 'succeeded', exitCode: 0, stdoutTail: 'ok', stderrTail: '' }
  })
  vi.mocked(sdk.listModalJobOutputs).mockResolvedValue([
    { path: 'result.bin', size_bytes: result.length }
  ])
  vi.mocked(sdk.stageModalJobOutputs).mockImplementation(async (request) => {
    expect(request.files).toEqual([{ path: 'result.bin', bytes: result.length }])
    const localPath = join(request.stagingDirectory, 'test-staged-result.bin')
    const data = Buffer.concat([staged!, Buffer.from('!')])
    await writeFile(localPath, data)
    return [{ path: 'result.bin', localPath, bytes: data.length, sha256: digest(data) }]
  })
  vi.mocked(sdk.cleanupModalVolume).mockImplementation(async (ref) => {
    expect(ref).toMatchObject(identifier)
    expect((await jobs.get(ref.runId))?.file_evidence).toMatchObject({
      activityId: ref.runId,
      checksum: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(
      await readFile(
        join(
          getJobHarvestDir(root, scope.projectId, scope.sessionId, ref.runId),
          'featured',
          'result.bin'
        )
      )
    ).toEqual(result)
  })
  try {
    await migrateApplicationDatabase(client)
    await mkdir(workspace, { recursive: true })
    await writeFile(source, input)
    const target = await catalog.create({
      displayName: 'Modal trial',
      environmentName: 'dev',
      appName: 'research',
      image: 'ubuntu:24.04',
      cpus: 1,
      memoryMiB: 1024
    })
    sessions.set(scope.sessionId, [target.providerId])
    const { job_id } = await agent.submitJob(scope, target.providerId, 'verify result', command, {
      workspaceCwd: workspace,
      inputs: [{ src: 'source.bin', dst_filename: 'input.bin' }],
      outputManifest: JSON.stringify(['result.bin'])
    })
    expect(sdk.createModalVolume).not.toHaveBeenCalled()
    await writeFile(source, 'changed after approval')
    runtime.start()
    for (let n = 0; n < 5 && !vi.mocked(sdk.createModalSandbox).mock.calls.length; n++)
      await runtime.tick()
    expect(sdk.createModalSandbox).toHaveBeenCalledTimes(1)
    await runtime.stop()
    await client.$disconnect()
    client = createProjectDbClient(root)
    runtime = newRuntime()
    vi.mocked(sdk.stageModalJobOutputs).mockRejectedValueOnce(
      new Error('Temporary volume read failure')
    )
    runtime.start()
    for (let n = 0; n < 5 && !vi.mocked(sdk.stageModalJobOutputs).mock.calls.length; n++)
      await runtime.tick()
    expect(sdk.stageModalJobOutputs).toHaveBeenCalledTimes(1)
    expect(sdk.cleanupModalVolume).not.toHaveBeenCalled()
    expect((await jobs.get(job_id))?.remote_cleanup_disposition).toBe('pending')
    await runtime.retry(job_id)
    for (let n = 0; n < 8; n++) {
      await runtime.tick()
      if ((await jobs.get(job_id))?.remote_cleanup_disposition === 'cleaned') break
    }
    expect(await jobs.get(job_id)).toMatchObject({
      status: 'success',
      remote_cleanup_disposition: 'cleaned',
      file_evidence: { activityId: job_id }
    })
    expect(await agent.getJobResult(scope, target.providerId, job_id)).toMatchObject({
      status: 'success',
      exit_code: 0,
      result_final: true
    })
    expect(sdk.createModalVolume).toHaveBeenCalledTimes(1)
    expect(sdk.createModalSandbox).toHaveBeenCalledTimes(1)
    expect(sdk.stageModalInputs).toHaveBeenCalledTimes(1)
    expect(sdk.cleanupModalVolume).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.stop()
    await client.$disconnect()
    await releaseLocks()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

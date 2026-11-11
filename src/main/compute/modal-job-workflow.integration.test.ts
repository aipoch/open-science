import { spawnSync } from 'node:child_process'
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
import { MODAL_CREATION_UNCONFIRMED } from './modal-job-journal'
import { ModalTargetCatalog } from './modal-target-catalog'
import { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './workspace-path'

vi.mock('./modal-sdk', async (load) => ({
  ...(await load<typeof import('./modal-sdk')>()),
  withModalExecution: vi.fn(async (fn) => fn(vi.fn())),
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
      timeoutSeconds: 120,
      workspaceCwd: workspace,
      inputs: [{ src: 'source.bin', dst_filename: 'input.bin' }],
      outputManifest: JSON.stringify(['result.bin'])
    })
    await catalog.update(target.providerId, {
      displayName: 'Changed after approval',
      environmentName: 'other',
      appName: 'other',
      image: 'other',
      cpus: 2,
      memoryMiB: 2048
    })
    expect(sdk.createModalVolume).not.toHaveBeenCalled()
    await writeFile(source, 'changed after approval')
    // Resume a job that spent three minutes queued and was dispatched thirty seconds ago.
    const submittedAt = new Date(Date.now() - 30_000)
    await client.computeJob.update({
      where: { id: job_id },
      data: { createdAt: new Date(submittedAt.getTime() - 180_000), submittedAt }
    })
    runtime.start()
    for (let n = 0; n < 5 && !vi.mocked(sdk.createModalSandbox).mock.calls.length; n++)
      await runtime.tick()
    expect(sdk.createModalSandbox).toHaveBeenCalledTimes(1)
    const { timeoutSeconds } = vi.mocked(sdk.createModalSandbox).mock.calls[0][0]
    expect(timeoutSeconds).toBeGreaterThan(0)
    expect(timeoutSeconds).toBeLessThanOrEqual(90)
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
    expect(await jobs.get(job_id)).toMatchObject({
      remote_cleanup_disposition: 'pending',
      harvest_error: 'harvest pending: Cloud output download failed.'
    })
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

it.each([
  ['cancellation', 'failed', 'job_cancelled'],
  ['timeout', 'timeout', 'timeout'],
  ['preflight rejection', 'error', 'dispatch_failed']
])('recovers the owned volume after pre-launch %s and database restart', exerciseVolumeCleanup)

async function exerciseVolumeCleanup(
  reason: string,
  status: string,
  errorCode: string
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'modal-cleanup-'))
  let client = createProjectDbClient(root)
  const jobs = new ComputeJobRepository(async () => client)
  const operations = new ComputeJobOperationRepository(async () => client)
  const harvest = vi.fn()
  const newRuntime = (): ReturnType<typeof createModalJobRuntime> =>
    createModalJobRuntime({
      jobRepository: jobs,
      operationRepository: operations,
      storageRoot: root,
      onJobUpdated: () => undefined,
      harvest
    })
  let runtime = newRuntime()
  const scope = {
    providerId: 'modal:' + randomUUID(),
    projectId: 'project',
    sessionId: 'session'
  }
  const target = {
    environmentName: 'dev',
    appName: 'research',
    appId: 'ap-cancel',
    image: 'ubuntu:24.04',
    cpus: 1,
    memoryMiB: 1024
  }
  const id = randomUUID()
  vi.clearAllMocks()
  vi.mocked(sdk.resolveModalApp).mockResolvedValue({ appId: target.appId })
  vi.mocked(sdk.createModalVolume).mockResolvedValue({ volumeId: 'vo-cancel' })
  const cleanup = vi.mocked(sdk.cleanupModalVolume)
  cleanup.mockResolvedValue(undefined).mockRejectedValueOnce(new Error('Temporary cleanup failure'))
  try {
    await migrateApplicationDatabase(client)
    await jobs.createApprovedModalJob(
      {
        ...scope,
        id,
        intent: 'cancel before launch',
        command: 'true',
        commandHash: digest(Buffer.from('true')),
        shape: 'bridge_runner',
        timeoutSeconds: 120,
        allowUnencryptedPersistence: true
      },
      target
    )
    runtime.start()
    await runtime.tick()
    expect(sdk.createModalVolume).toHaveBeenCalledTimes(1)
    if (reason === 'timeout') {
      await client.computeJob.update({
        where: { id },
        data: { submittedAt: new Date(Date.now() - 180_000) }
      })
    } else if (reason === 'cancellation') {
      await operations.request(id, 'cancel', scope, new Date())
    } else {
      vi.mocked(sdk.stageModalInputs).mockResolvedValueOnce(undefined)
      vi.mocked(sdk.createModalSandbox).mockRejectedValueOnce(new sdk.ModalCreateRejectedError())
    }
    await runtime.tick()
    expect(cleanup).toHaveBeenCalledTimes(reason === 'cancellation' ? 1 : 0)
    await runtime.stop()
    await client.$disconnect()
    client = createProjectDbClient(root)
    expect(await jobs.get(id)).toMatchObject({
      status,
      error_code: errorCode,
      ...(reason !== 'preflight rejection' && { harvested_at: expect.any(Number) }),
      remote_cleanup_disposition: 'pending'
    })
    if (reason === 'cancellation')
      expect(await operations.get(id, 'cancel')).toMatchObject({
        phase: 'settled',
        outcome: 'fulfilled'
      })
    runtime = newRuntime()
    runtime.start()
    await runtime.tick()
    if (reason !== 'cancellation') {
      expect(cleanup).not.toHaveBeenCalled()
      const job = (await jobs.get(id))!
      await expect(runtime.manualCleanup(job)).rejects.toThrow('Temporary cleanup failure')
      expect((await jobs.get(id))?.remote_cleanup_disposition).toBe('pending')
      await runtime.manualCleanup(job)
    }
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(cleanup.mock.calls.map(([ref]) => [ref.runId, ref.appId, ref.volumeId])).toEqual([
      [id, target.appId, 'vo-cancel'],
      [id, target.appId, 'vo-cancel']
    ])
    expect((await jobs.get(id))?.remote_cleanup_disposition).toBe('cleaned')
    expect(harvest).not.toHaveBeenCalled()
    expect(sdk.createModalSandbox).toHaveBeenCalledTimes(reason === 'preflight rejection' ? 1 : 0)
  } finally {
    await runtime.stop()
    await client.$disconnect()
    await releaseLocks()
    await rm(root, { recursive: true, force: true })
  }
}

it('classifies the same SDK error by whether sandbox creation was entered', ({ skip }) => {
  const python =
    process.env.OPEN_SCIENCE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const exerciseHelper = `
import io, json, runpy, sys
from unittest.mock import Mock, patch
class AuthError(Exception): pass
sdk = Mock()
sdk.App.lookup.return_value.app_id = 'ap-test'
sdk.Volume.from_id.return_value.read_file.return_value = [b'nonce']
sdk.Sandbox.create.side_effect = AuthError('private details')
config = Mock(DEFAULT_SERVER_URL='https://api.modal.com', config={'server_url':'https://api.modal.com'})
req = dict(environmentName='dev', appName='lab', appId='ap-test', volumeId='vo-owned',
           nonce='nonce', command='true', image='python', cpus=1, memoryMiB=512, timeoutSeconds=60)
helper = sys.argv[1]
sys.argv = [helper, 'launch']
with patch.dict(sys.modules, {'modal':sdk, 'modal.config':config}), patch('importlib.metadata.version', return_value='1.6.3'):
    for image_error in [AuthError('private details'), None]:
        sdk.Image.from_registry.side_effect = image_error
        with patch('sys.stdin', io.StringIO(json.dumps({'request':req}))):
            runpy.run_path(helper, run_name='__main__')
        assert sdk.Sandbox.create.call_count == (0 if image_error else 1)
`
  const result = spawnSync(
    python,
    ['-I', '-c', exerciseHelper, join(process.cwd(), 'resources', 'compute-modal.py')],
    {
      encoding: 'utf8',
      timeout: 10_000
    }
  )
  if (
    !process.env.OPEN_SCIENCE_TEST_PYTHON &&
    (result.error as NodeJS.ErrnoException)?.code === 'ENOENT'
  ) {
    skip('The Modal helper requires Python.')
  }
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
  ).toEqual([{ error: 'sandbox-not-started' }, { error: 'AuthError' }])
})

it.each([
  ['volume', 'local rejection'],
  ['sandbox', 'local rejection'],
  ['volume', 'queued expiry'],
  ['sandbox', 'queued expiry']
])('admits %s creation before recording intent: %s', async (resource, outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'modal-create-admission-'))
  const client = createProjectDbClient(root)
  const jobs = new ComputeJobRepository(async () => client)
  const runtime = createModalJobRuntime({
    jobRepository: jobs,
    storageRoot: root,
    onJobUpdated: () => undefined,
    harvest: vi.fn()
  })
  const scope = { providerId: 'modal:' + randomUUID(), projectId: 'project', sessionId: 'session' }
  const target = {
    environmentName: 'dev',
    appName: 'research',
    appId: 'ap-local',
    image: 'ubuntu:24.04',
    cpus: 1,
    memoryMiB: 512
  }
  const id = randomUUID()
  vi.clearAllMocks()
  vi.mocked(sdk.resolveModalApp).mockResolvedValue({ appId: target.appId })
  vi.mocked(sdk.createModalVolume).mockResolvedValue({ volumeId: 'vo-local' })
  vi.mocked(sdk.stageModalInputs).mockResolvedValue(undefined)
  let clock: ReturnType<typeof vi.spyOn> | undefined
  try {
    await migrateApplicationDatabase(client)
    await jobs.createApprovedModalJob(
      {
        ...scope,
        id,
        intent: 'local admission regression',
        command: 'true',
        commandHash: digest(Buffer.from('true')),
        shape: 'bridge_runner',
        timeoutSeconds: 120,
        allowUnencryptedPersistence: true
      },
      target
    )
    if (resource === 'sandbox') {
      runtime.start()
      await runtime.tick()
    }
    const before = (await jobs.get(id))!
    const create = resource === 'volume' ? sdk.createModalVolume : sdk.createModalSandbox
    vi.mocked(create).mockClear()
    vi.mocked(sdk.withModalExecution).mockImplementationOnce(async (execute) => {
      if (outcome === 'local rejection') throw new Error('RUNTIME_DISABLED')
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180000)
      return execute(vi.fn())
    })
    if (resource === 'volume') runtime.start()
    await runtime.tick()
    expect(create).not.toHaveBeenCalled()
    const after = (await jobs.get(id))!
    if (outcome === 'local rejection') {
      expect(after.remote_handle).toBe(before.remote_handle)
      expect(after.status).toBe('submitted')
      expect(after.last_poll_error).not.toBe(MODAL_CREATION_UNCONFIRMED)
    } else expect(after.status).toBe('timeout')
  } finally {
    clock?.mockRestore()
    await runtime.stop()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

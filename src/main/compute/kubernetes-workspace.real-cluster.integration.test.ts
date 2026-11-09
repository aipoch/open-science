// Opt-in: RUN_COMPUTE_KUBERNETES=1, COMPUTE_TEST_K8S_CONTEXT and COMPUTE_TEST_K8S_NAMESPACE.
// File roundtrip additionally requires COMPUTE_TEST_K8S_IMAGE, Jobs, Pods, exec, logs and a storage class.
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createKubernetesBackendAdapter,
  type KubernetesWorkspace,
  type ComputeConnectionLease
} from '@aipoch/compute/node'
import { it, expect } from 'vitest'
import type { ComputeJob } from '../../shared/compute'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AgentComputeService } from './agent-compute-service'
import { ComputeService } from './compute-service'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeHostRepository } from './repository'
import { KubernetesTargetCatalog } from './kubernetes-target-catalog'
import { createKubernetesJobRuntime } from './kubernetes-job-runtime'
import { createComputeJobRuntime } from './job-runtime'
import { createSshConfigCompatibilityBroker } from './authentication-runtime'
import { harvestJob } from './harvest-engine'
import { getJobHarvestDir } from './workspace-path'
import { ComputeJobRepository } from './job-repository'
import { resolveKubernetesJobTarget } from './kubernetes-kubeconfig'

it.runIf(process.env.RUN_COMPUTE_KUBERNETES === '1')(
  'recovers the same live PVC after losing the API response and reopening SQLite',
  async () => {
    const context = process.env.COMPUTE_TEST_K8S_CONTEXT,
      namespace = process.env.COMPUTE_TEST_K8S_NAMESPACE
    if (!context || !namespace) throw Error('Explicit test context and namespace are required.')
    const target = await resolveKubernetesJobTarget(context, namespace, 'unused-for-pvc-test')
    const jobId = randomUUID()
    const owner = { jobId, providerId: 'workspace-trial', projectId: 'p', sessionId: 's' }
    const root = await mkdtemp(join(tmpdir(), 'workspace-journal-live-'))
    let client = createProjectDbClient(root)
    const adapter = createKubernetesBackendAdapter(target)
    let created: KubernetesWorkspace | undefined
    try {
      await migrateApplicationDatabase(client)
      const repo = new ComputeJobRepository(
        async () => client,
        undefined,
        async () => interrupted
      )
      await repo.createApprovedKubernetesJob(
        {
          ...owner,
          id: jobId,
          command: 'true',
          commandHash: 'hash',
          intent: 'trial',
          allowUnencryptedPersistence: true
        },
        target,
        8
      )
      const interrupted = {
        ...target,
        fetch: async (input: string, init?: RequestInit) => {
          const reply = await target.fetch!(input, init)
          if (init?.method === 'POST' && reply.ok) {
            const { metadata } = await reply.json()
            created = {
              jobId,
              providerId: owner.providerId,
              namespace,
              name: metadata.name,
              uid: metadata.uid
            }
            throw Error('response lost after creation')
          }
          return reply
        }
      }
      await expect(repo.prepareKubernetesWorkspace(owner)).rejects.toThrow('response lost')
      expect(created).toBeDefined()
      await client.$disconnect()
      client = createProjectDbClient(root)
      const reopened = new ComputeJobRepository(async () => client)
      const recovered = await reopened.prepareKubernetesWorkspace(owner)
      expect(recovered).toEqual(created)
      await expect(reopened.releasePublishedKubernetesWorkspace(owner)).rejects.toThrow(
        'fully published'
      )
      await expect(
        adapter.releaseWorkspace({ ...recovered, uid: randomUUID() })
      ).rejects.toMatchObject({ status: 409 })
    } finally {
      try {
        if (created) {
          const signal = AbortSignal.timeout(30_000)
          while ((await adapter.releaseWorkspace(created, signal)) !== 'confirmed')
            await delay(200, undefined, { signal })
        }
      } finally {
        await client.$disconnect()
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  60_000
)

type LiveResource = { uid: string; read(): Promise<Response> }
type InterruptedArchive = { podUid: string; claim: LiveResource; job: LiveResource }

async function currentUid(resource: LiveResource): Promise<string> {
  const response = await resource.read()
  expect(response.ok).toBe(true)
  return (await response.json()).metadata.uid
}

async function interruptArchive(
  jobs: ComputeJobRepository,
  job: ComputeJob,
  lease: ComputeConnectionLease,
  signal: AbortSignal
): Promise<InterruptedArchive> {
  const { binding, target } = await jobs.getKubernetesReservation(
    {
      jobId: job.job_id,
      providerId: job.provider_id,
      projectId: job.project_id,
      sessionId: job.session_id
    },
    signal
  )
  const { namespace } = target
  const core = '/api/v1/namespaces/' + namespace
  const api = (path: string, init?: RequestInit): Promise<Response> =>
    target.fetch!(target.endpoint + path, { signal: AbortSignal.timeout(30_000), ...init })
  const receipt = binding.receipt!
  const handle = JSON.parse(job.remote_handle!)
  expect(handle.namespace).toBe(namespace)
  const hostname = await lease.run('hostname', { timeoutMs: 10_000 })
  expect(hostname.exitCode).toBe(0)
  const name = hostname.stdout.trim()
  expect(name).toMatch(/^compute-transfer-[a-z0-9-]+$/)
  const podPath = core + '/pods/' + name
  const response = await api(podPath)
  expect(response.ok).toBe(true)
  const pod = await response.json()
  expect(pod.metadata).toMatchObject({
    name,
    namespace,
    uid: expect.any(String),
    ownerReferences: [{ kind: 'PersistentVolumeClaim', name: receipt.name, uid: receipt.uid }]
  })
  expect(pod.spec.volumes).toContainEqual({
    name: 'files',
    persistentVolumeClaim: { claimName: receipt.name, readOnly: true }
  })
  expect(pod.spec.containers).toMatchObject([
    { name: 'transfer', volumeMounts: [{ name: 'files', mountPath: '/workspace', readOnly: true }] }
  ])
  const deleted = await api(podPath, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: pod.metadata.uid },
      gracePeriodSeconds: 0
    })
  })
  expect(deleted.ok).toBe(true)
  const deadline = AbortSignal.timeout(30_000)
  for (;;) {
    const current = await api(podPath)
    if (current.status === 404) break
    expect(current.ok).toBe(true)
    expect((await current.json()).metadata.uid).toBe(pod.metadata.uid)
    await delay(100, undefined, { signal: deadline })
  }
  return {
    podUid: pod.metadata.uid,
    claim: { uid: receipt.uid, read: () => api(core + '/persistentvolumeclaims/' + receipt.name) },
    job: {
      uid: handle.uid,
      read: () => api('/apis/batch/v1/namespaces/' + namespace + '/jobs/' + handle.name)
    }
  }
}

// This exercises the agent submit entry, approved target snapshot and post-restart collector.
it.runIf(process.env.RUN_COMPUTE_KUBERNETES === '1' && !!process.env.COMPUTE_TEST_K8S_IMAGE)(
  'retains the approved Job and PVC after a live archive interruption, then publishes before cleanup',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kubernetes-file-roundtrip-'))
    let client = createProjectDbClient(root)
    const getClient = async (): Promise<typeof client> => client
    const savedTargets = new KubernetesTargetCatalog(() => root)
    const hosts = new ComputeHostRepository(getClient, { kubernetesTargets: savedTargets })
    const jobs = new ComputeJobRepository(getClient)
    const operations = new ComputeJobOperationRepository(getClient)
    const approval = new ComputeApprovalBroker({
      generateId: randomUUID,
      broadcast: (request) => {
        expect(request.operation).toBe('submit_job')
        queueMicrotask(() => approval.respond(request.id, 'once'))
      }
    })
    const ssh = async (): Promise<never> => {
      throw new Error('Unexpected SSH operation')
    }
    const compute = new ComputeService({
      runner: { run: ssh },
      repository: hosts,
      approvalBroker: approval,
      jobRepository: jobs,
      operationRepository: operations,
      storageRoot: root
    })
    const sessions = new EnabledComputeHostsRegistry()
    const agent = new AgentComputeService(compute, sessions)
    const scope = {
      projectId: 'project-trial',
      sessionId: 'session-trial',
      producerRunId: 'run-trial'
    }
    const directory = join(root, 'notebooks', scope.projectId, scope.sessionId)
    const input = join(directory, 'input.bin')
    let interrupted: InterruptedArchive | undefined
    let faultError: unknown
    let publicationClaimUid: string | undefined
    const runtime = createKubernetesJobRuntime({
      jobRepository: jobs,
      operationRepository: operations,
      storageRoot: root,
      onJobUpdated: () => undefined,
      harvest: async (job, lease, signal) => {
        const partial = join(root, 'partial.bin')
        expect((await lease.download('/workspace/result.bin', partial, 10)).exceeded).toBe(true)
        await expect(lease.download('/workspace/escape', partial, 8192)).rejects.toThrow()
        await harvestJob(job, {
          connectionBroker: { acquire: ssh },
          hostRepository: hosts,
          jobRepository: jobs,
          storageRoot: root,
          workspaceConnection: {
            ...lease,
            download: async (path, destination, budget) => {
              if (!interrupted && path === '/workspace/result.bin') {
                try {
                  interrupted = await interruptArchive(jobs, job, lease, signal)
                } catch (error) {
                  faultError = error
                  throw error
                }
              }
              return lease.download(path, destination, budget)
            }
          },
          signal
        })
      }
    })
    let recoveredRuntime: ReturnType<typeof createComputeJobRuntime> | undefined
    try {
      await migrateApplicationDatabase(client)
      const target = await savedTargets.create({
        displayName: 'File acceptance',
        context: process.env.COMPUTE_TEST_K8S_CONTEXT!,
        namespace: process.env.COMPUTE_TEST_K8S_NAMESPACE!,
        image: process.env.COMPUTE_TEST_K8S_IMAGE!,
        transferImage: process.env.COMPUTE_TEST_K8S_IMAGE!,
        sizeMiB: 16
      })
      sessions.set(scope.sessionId, [target.providerId])
      await mkdir(directory, { recursive: true })
      const bytes = randomBytes(262_147)
      await writeFile(input, bytes)
      const { job_id } = await agent.submitJob(
        scope,
        target.providerId,
        'Verify binary output',
        'cp input.bin result.bin && sha256sum result.bin && ln -s /etc/passwd escape',
        {
          workspaceCwd: directory,
          inputs: [{ src: 'input.bin', dst_filename: 'input.bin' }],
          outputManifest: JSON.stringify(['result.bin']),
          timeoutSeconds: 60
        }
      )
      await writeFile(input, 'changed after approval')
      await client.$disconnect()
      client = createProjectDbClient(root)
      runtime.start()
      const deadline = AbortSignal.timeout(130_000)
      while (!interrupted) {
        await runtime.tick()
        if (faultError) throw faultError
        if (!interrupted) await delay(400, undefined, { signal: deadline })
      }
      await runtime.stop()
      const pending = await jobs.get(job_id)
      const { claim, job: remoteJob } = interrupted
      for (const resource of [claim, remoteJob])
        expect(await currentUid(resource)).toBe(resource.uid)
      process.stdout.write(
        `Kubernetes archive interruption: job=${job_id} podUID=${interrupted.podUid} jobUID=${remoteJob.uid} pvcUID=${claim.uid} harvestedAt=${pending?.harvested_at ?? 'unset'} error=${pending?.harvest_error ?? 'unset'}\n`
      )
      expect(pending).toMatchObject({
        status: 'success',
        remote_cleanup_disposition: 'pending',
        harvest_error: expect.stringMatching(/^harvest pending:/)
      })
      expect(pending?.harvested_at).toBeUndefined()
      expect(pending?.file_evidence?.checksum).toBeUndefined()
      const result = join(
        getJobHarvestDir(root, scope.projectId, scope.sessionId, job_id),
        'featured',
        'result.bin'
      )
      await expect(readFile(result)).rejects.toMatchObject({ code: 'ENOENT' })
      const evidencePath = join(
        root,
        'execution-file-evidence',
        scope.projectId,
        scope.sessionId,
        'activity-' + job_id,
        'evidence.json'
      )
      await expect(readFile(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await client.$disconnect()
      client = createProjectDbClient(root)
      recoveredRuntime = createComputeJobRuntime(
        {
          computeService: compute,
          jobRepository: jobs,
          operationRepository: operations,
          hostRepository: hosts,
          storageRoot: root,
          connectionBroker: createSshConfigCompatibilityBroker(hosts, { run: ssh })
        },
        {
          broadcast: () => undefined,
          harvest: async (job, deps) => {
            await harvestJob(job, deps)
            const published = await jobs.get(job.job_id)
            if (
              published?.harvested_at &&
              !published.harvest_error &&
              published.file_evidence?.checksum
            )
              publicationClaimUid = await currentUid(claim)
          }
        }
      )
      await recoveredRuntime.start()
      await compute.retryJobHarvest({
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        providerId: target.providerId,
        jobId: job_id
      })
      for (;;) {
        const row = await client.computeJob.findUniqueOrThrow({ where: { id: job_id } })
        if (row.kubernetesWorkspace === null) break
        await delay(400, undefined, { signal: deadline })
      }
      expect(publicationClaimUid).toBe(claim.uid)
      for (const resource of [claim, remoteJob]) expect((await resource.read()).status).toBe(404)
      const job = await jobs.get(job_id)
      expect(job?.status).toBe('success')
      expect(job?.stdout_tail).toContain(createHash('sha256').update(bytes).digest('hex'))
      expect(job?.file_evidence).toMatchObject({ activityId: job_id, generationCount: 2 })
      expect(job?.remote_cleanup_disposition).toBe('cleaned')
      expect(
        createHash('sha256')
          .update(await readFile(evidencePath))
          .digest('hex')
      ).toBe(job?.file_evidence?.checksum)
      const archived = await readFile(result)
      const digest = createHash('sha256').update(archived).digest('hex')
      expect(archived).toEqual(bytes)
      expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'))
      process.stdout.write(
        `Kubernetes archive recovered: job=${job_id} pvcUID=${publicationClaimUid} bytes=${archived.length} sha256=${digest} job/PVC=404 cleanup=cleaned\n`
      )
      expect((await agent.getJobStatus(scope, target.providerId, job_id)).status).toBe('success')
    } finally {
      await recoveredRuntime?.stop()
      await runtime.stop()
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000
)

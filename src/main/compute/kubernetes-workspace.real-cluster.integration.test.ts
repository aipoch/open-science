// Opt-in: RUN_COMPUTE_KUBERNETES=1, COMPUTE_TEST_K8S_CONTEXT and COMPUTE_TEST_K8S_NAMESPACE.
// File roundtrip additionally requires COMPUTE_TEST_K8S_IMAGE, Jobs, Pods, exec, logs and a storage class.
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createKubernetesBackendAdapter, type KubernetesWorkspace } from '@aipoch/compute/node'
import { it, expect } from 'vitest'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AgentComputeService } from './agent-compute-service'
import { ComputeService } from './compute-service'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeHostRepository } from './repository'
import { KubernetesTargetCatalog } from './kubernetes-target-catalog'
import { createKubernetesJobRuntime } from './kubernetes-job-runtime'
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

// This exercises the agent submit entry, approved target snapshot and post-restart collector.
it.runIf(process.env.RUN_COMPUTE_KUBERNETES === '1' && !!process.env.COMPUTE_TEST_K8S_IMAGE)(
  'submits frozen files, resumes the approved job, and publishes matching output through the host',
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
          workspaceConnection: lease,
          signal
        })
      }
    })
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
      for (;;) {
        await runtime.tick()
        const row = await client.computeJob.findUniqueOrThrow({ where: { id: job_id } })
        if (row.harvestError) throw new Error('Kubernetes harvest failed: ' + row.harvestError)
        if (row.kubernetesWorkspace === null) break
        await delay(400, undefined, { signal: deadline })
      }
      const job = await jobs.get(job_id)
      expect(job?.status).toBe('success')
      expect(job?.stdout_tail).toContain(createHash('sha256').update(bytes).digest('hex'))
      expect(job?.file_evidence).toMatchObject({ activityId: job_id, generationCount: 2 })
      expect(
        await readFile(
          join(
            getJobHarvestDir(root, scope.projectId, scope.sessionId, job_id),
            'featured',
            'result.bin'
          )
        )
      ).toEqual(bytes)
      expect((await agent.getJobStatus(scope, target.providerId, job_id)).status).toBe('success')
    } finally {
      await runtime.stop()
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000
)

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { afterAll, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import type { ComputeApprovalRequest } from '../../shared/compute'
import { ComputeApprovalBroker } from '../compute/compute-approval-broker'
import { ComputeJobOperationRepository } from '../compute/compute-job-operation-repository'
import { ComputeService } from '../compute/compute-service'
import { AgentComputeService } from '../compute/agent-compute-service'
import { EnabledComputeHostsRegistry } from '../compute/enabled-hosts-registry'
import { ComputeJobRepository } from '../compute/job-repository'
import { ComputeHostRepository } from '../compute/repository'
import { RayTargetCatalog } from '../compute/ray-target-catalog'
import { rayTokens } from '../compute/ray-token'
import { createRayJobRuntime } from '../compute/ray-job-runtime'
import { harvestJob } from '../compute/harvest-engine'
import { getJobHarvestDir } from '../compute/workspace-path'
import { createNodeSecureStorageCipher } from '../credential-identity/node-cipher'
import { configureSecureStorageCipher } from '../secure-storage'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookIdleReclamation, NOTEBOOK_SESSION_IDLE_MS } from '../notebook/idle-reclamation'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import * as windowsNotebookRuntime from '../notebook/windows-notebook-runtime'
import { composeApplicationRuntime } from '../application-runtime'
import { initDataRoot } from '../storage-root'

// Only unrelated project surfaces are stubbed. Both production composition functions, the archive
// admission gate, Notebook runtime/process owner, Compute owners, SQLite and result files are real.
vi.mock('../desktop-surface-declarations', () => ({}))
vi.mock('../projects/ipc', () => ({ createProjectHandlers: () => ({}) }))
vi.mock('../projects/deletion-coordinator', () => ({ ProjectDeletionCoordinator: class {} }))
vi.mock('../session-persistence/ipc', () => ({ createDefaultReviewRepository: () => ({}) }))
vi.mock('../project-files/ipc', () => ({ createProjectFilesHandlers: () => ({}) }))
vi.mock('../managed-file-versions/ipc', () => ({
  createManagedFileVersionHandlers: () => ({}),
  createManagedFileVersionCommandOwner: (handlers: unknown) => handlers
}))
vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers: () => undefined }))

import { composeProjectLifecycle } from './project-lifecycle'
import { composeNotebookRuntime } from './notebook-runtime'

const releaseLocks = configureTestRuntimeMetadata()
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const key = randomBytes(32)
const cipher = createNodeSecureStorageCipher(
  { backend: 'mac-keychain', appName: 'Idle test', exists: true },
  tmpdir(),
  {
    readPassword: () => Buffer.from(key),
    unprotect: () => {
      throw new Error('Unexpected DPAPI call')
    }
  }
)
configureSecureStorageCipher(cipher)
afterAll(() => {
  cipher.dispose()
  key.fill(0)
})

// A controllable Ray Dashboard replaces the remote scheduler/driver only. It holds a job RUNNING
// until complete(), allowing local reclamation and a failed status query before real harvesting.
async function dashboard(sharedRoot: string): Promise<{
  endpoint: string
  creates(): number
  complete(): void
  failQueries(value: boolean): void
  close(): Promise<void>
}> {
  const packages = new Map<string, Buffer>()
  const jobs = new Map<string, Record<string, unknown>>()
  let creates = 0
  let complete = false
  let unavailable = false
  const server = createServer(async (req, res) => {
    try {
      const url = req.url!
      let data: unknown
      if (url === '/api/version') {
        data = {
          version: '4',
          ray_version: '2.52.0',
          ray_commit: 'fixture',
          session_name: 'idle-test'
        }
      } else if (url.startsWith('/api/packages/gcs/')) {
        const key = 'gcs://' + url.slice('/api/packages/gcs/'.length)
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          packages.set(key, Buffer.concat(chunks))
        } else if (!packages.has(key)) {
          res.writeHead(404).end()
          return
        }
      } else if (url === '/api/jobs/' && req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const spec = JSON.parse(Buffer.concat(chunks).toString())
        creates++
        const zip = await JSZip.loadAsync(packages.get(spec.runtime_env.working_dir)!)
        const input = await zip.file('input.bin')!.async('nodebuffer')
        await writeFile(join(sharedRoot, spec.submission_id, 'result.bin'), input.reverse())
        jobs.set(spec.submission_id, { ...spec, type: 'SUBMISSION' })
        data = { submission_id: spec.submission_id }
      } else if (url.endsWith('/logs')) data = { logs: 'done\n' }
      else if (url.startsWith('/api/jobs/')) {
        if (unavailable) {
          res.writeHead(503).end('temporarily unavailable')
          return
        }
        const job = jobs.get(url.slice('/api/jobs/'.length))
        if (!job) {
          res.writeHead(404).end()
          return
        }
        data = {
          ...job,
          status: complete ? 'SUCCEEDED' : 'RUNNING',
          driver_exit_code: complete ? 0 : null
        }
      } else {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
    } catch (error) {
      res.writeHead(500).end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    creates: () => creates,
    complete: () => {
      complete = true
    },
    failQueries: (value) => {
      unavailable = value
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

async function notebookComposition(
  root: string,
  jobs: ComputeJobRepository
): Promise<{
  notebook: NotebookRuntimeService
  archive: ReturnType<typeof composeProjectLifecycle>['archiveCoordinator']
  dispose(): Promise<void>
}> {
  initDataRoot(root)
  const notebookActivityRef = { current: undefined } as Parameters<
    typeof composeProjectLifecycle
  >[0]['notebookActivityRef']
  let notebook: NotebookRuntimeService
  const project = {
    id: 'ray-project',
    name: 'Project',
    description: '',
    createdAt: 1,
    updatedAt: 1,
    isExample: false
  }
  const runtime = await composeApplicationRuntime(async (modules) => {
    const lifecycle = composeProjectLifecycle({
      applicationEvents: {},
      notificationInbox: { setSessionAvailability: () => undefined },
      sessionPersistenceCoordinator: {
        setSessionDeletionHandlers: () => undefined,
        sessionProjectId: async () => project.id,
        assertSessionAvailable: async () => undefined,
        updateArchive: async (_request: unknown, busy: () => Promise<boolean>) => {
          if (await busy()) throw new Error('Session is busy')
        }
      },
      projectRepository: { get: async () => project },
      runtimeRef: {},
      sideChatOwnerRef: {},
      notebookActivityRef,
      getActiveDelegatedSessions: () => [],
      getActiveSideChatSessions: () => [],
      computeJobActivityRef: { current: jobs },
      reviewerProjectRuntime: { isProjectBusy: () => false },
      configRoot: root,
      getNotebookService: () => notebook
    } as unknown as Parameters<typeof composeProjectLifecycle>[0])
    const composed = await composeNotebookRuntime({
      modules,
      archiveCoordinator: lifecycle.archiveCoordinator,
      notebookActivityRef,
      notebookPolicyLifecycle: {},
      artifactReproducibilityAttemptOwnerRef: {},
      applicationEvents: { publish: () => undefined },
      notebookRepository: new NotebookRunRepository(root),
      settingsService: { registeredHelperCatalog: () => undefined },
      grantedRootsRepository: { list: async () => [] },
      backgroundResultDelivery: {
        enqueue: async () => undefined,
        register: async () => undefined,
        acknowledgeObserved: async () => undefined
      },
      backendTeardownOwnedByCoordinator: { current: true },
      composition: { phase: () => undefined }
      // No OS sandbox or model provider is needed for this local process-lifetime test.
    } as unknown as Parameters<typeof composeNotebookRuntime>[0])
    notebook = composed.notebookService
    return { notebook, archive: lifecycle.archiveCoordinator }
  })
  return {
    ...runtime.interfaces,
    dispose: async () => {
      await notebook.dispose()
      await runtime.dispose()
    }
  }
}

it.each([
  ['submitted', 'expiry'],
  ['running', 'expiry'],
  ['running', 'capacity']
] as const)(
  'reclaims a real interpreter with a %s Compute job by %s, cold starts and harvests after recovery',
  async (stage, policy) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-compute-idle-'))
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    vi.stubEnv('OPEN_SCIENCE_REPL_BACKGROUND_EXECUTION', '1')
    const client = createProjectDbClient(root)
    const jobs = new ComputeJobRepository(async () => client)
    const catalog = new RayTargetCatalog(() => root)
    const hosts = new ComputeHostRepository(async () => client, { rayTargets: catalog })
    const operations = new ComputeJobOperationRepository(async () => client)
    const sharedRoot = join(root, 'share')
    const workspace = join(root, 'workspace')
    const scope = { projectId: 'ray-project', sessionId: 'ray-session' }
    let composition: Awaited<ReturnType<typeof notebookComposition>> | undefined
    let remote: Awaited<ReturnType<typeof dashboard>> | undefined
    let ray: ReturnType<typeof createRayJobRuntime> | undefined
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const check = vi.spyOn(NotebookIdleReclamation.prototype, 'check')
    // As in kernel-executor.test.ts, use the test host Node for real REPL children on Windows.
    // These cases exercise process ownership/reclamation, without preparing the protected runtime
    // or running PowerShell; retain the real executor and process-tree cleanup.
    const runtimeResolver = vi
      .spyOn(windowsNotebookRuntime, 'resolveWindowsNotebookRuntime')
      .mockReturnValue({
        root: dirname(process.execPath),
        node: process.execPath,
        powershell: 'C:\\runtime\\pwsh.exe'
      })
    try {
      await migrateApplicationDatabase(client)
      await mkdir(workspace)
      await mkdir(sharedRoot)
      remote = await dashboard(sharedRoot)
      await rayTokens.set(remote.endpoint, randomUUID())
      const target = await catalog.create({
        displayName: 'Idle test',
        endpoint: remote.endpoint,
        sharedRoot,
        remoteRoot: '/ray-output',
        cpus: 1,
        gpus: 0
      })
      composition = await notebookComposition(root, jobs)
      const { notebook, archive } = composition
      const sweep = async (): Promise<void> => {
        const before = check.mock.calls.length
        notebook.noteSessionActivity('unrelated-session')
        await vi.waitFor(() => expect(check.mock.calls.length).toBeGreaterThan(before))
        await check.mock.results.at(-1)!.value
      }
      const execute = (
        sessionId: string,
        code: string
      ): ReturnType<NotebookRuntimeService['executeControl']> =>
        notebook.executeControl({
          projectId: scope.projectId,
          sessionId,
          workspaceCwd: workspace,
          code
        })
      const first = await execute(
        scope.sessionId,
        `var saved = 42; require('node:fs').writeFileSync(${JSON.stringify(join(workspace, 'saved.txt'))}, String(saved)); console.log(process.pid)`
      )
      expect(first.status, JSON.stringify(first)).toBe('completed')
      if (process.platform === 'win32') expect(runtimeResolver).toHaveBeenCalled()
      const pid = Number(first.stdout.trim())
      expect(pid).toBeGreaterThan(0)
      const ordinary = await execute('ordinary', 'console.log(process.pid)')
      expect(ordinary.status).toBe('completed')
      const input = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 256))
      await writeFile(join(workspace, 'source.bin'), input)
      const approval = new ComputeApprovalBroker({
        generateId: randomUUID,
        broadcast: (request: ComputeApprovalRequest) =>
          queueMicrotask(() => approval.respond(request.id, 'once'))
      })
      const noSsh = async (): Promise<never> => {
        throw new Error('Unexpected SSH')
      }
      const service = new ComputeService({
        repository: hosts,
        jobRepository: jobs,
        operationRepository: operations,
        approvalBroker: approval,
        runner: { run: noSsh },
        storageRoot: root,
        admitSessionWork: (project, session) => archive.admitSessionWork(project, session)
      })
      const enabled = new EnabledComputeHostsRegistry()
      enabled.set(scope.sessionId, [target.providerId])
      const agent = new AgentComputeService(service, enabled)
      const submitted = await agent.submitJob(
        scope,
        target.providerId,
        'reverse bytes',
        'python reverse.py',
        {
          workspaceCwd: workspace,
          inputs: [{ src: 'source.bin', dst_filename: 'input.bin' }],
          outputManifest: JSON.stringify(['result.bin']),
          timeoutSeconds: 7200
        }
      )
      const jobId = submitted.job_id
      ray = createRayJobRuntime({
        jobRepository: jobs,
        operationRepository: operations,
        storageRoot: root,
        onJobUpdated: () => undefined,
        harvest: (job, rayOutputs, signal) =>
          harvestJob(job, {
            jobRepository: jobs,
            hostRepository: hosts,
            storageRoot: root,
            connectionBroker: { acquire: noSsh },
            rayOutputs,
            signal
          })
      })
      if (stage === 'running') {
        ray.start()
        await vi.waitFor(async () => {
          await ray!.retry(jobId)
          expect((await jobs.get(jobId))?.status).toBe('running')
        })
      }
      expect((await jobs.get(jobId))?.status).toBe(stage)
      await expect(archive.isSessionBusy(scope.projectId, scope.sessionId)).resolves.toBe(true)
      await expect(
        archive.updateSessionArchive({ ...scope, archived: true, expectedRevision: 0 })
      ).rejects.toThrow('busy')
      await expect(
        archive.reserveSessionExport(scope.projectId, scope.sessionId, async () => undefined)
      ).rejects.toThrow('idle')
      if (policy === 'expiry') {
        await sweep()
        now += NOTEBOOK_SESSION_IDLE_MS - 1
        await sweep()
        expect(notebook.getProjectActivity(scope).kernels).toHaveLength(2)
        now++
        await sweep()
        // Before this fix only the ordinary session reaches terminated here.
        const kernels = notebook.getProjectActivity(scope).kernels
        expect(kernels.some((kernel) => kernel.sessionId === 'ordinary')).toBe(false)
        expect(kernels).toHaveLength(0)
        expect(() => process.kill(Number(ordinary.stdout.trim()), 0)).toThrow()
      } else {
        now++
        expect((await execute('capacity-2', 'console.log(2)')).status).toBe('completed')
        now++
        expect((await execute('capacity-3', 'console.log(3)')).status).toBe('completed')
        await sweep()
        const kernels = notebook.getProjectActivity(scope).kernels
        expect(kernels).toHaveLength(3)
        expect(kernels.some((kernel) => kernel.sessionId === scope.sessionId)).toBe(false)
        expect(() => process.kill(Number(ordinary.stdout.trim()), 0)).not.toThrow()
      }
      expect(() => process.kill(pid, 0)).toThrow()
      expect((await jobs.get(jobId))?.status).toBe(stage)

      ray.start()
      await vi.waitFor(async () => {
        await ray!.retry(jobId)
        expect((await jobs.get(jobId))?.status).toBe('running')
      })
      remote.failQueries(true)
      await ray.retry(jobId)
      expect(await jobs.get(jobId)).toMatchObject({
        status: 'running',
        last_poll_error: expect.any(String)
      })
      const resumed = await execute(
        scope.sessionId,
        `console.log(process.pid, typeof saved, require('node:fs').readFileSync(${JSON.stringify(join(workspace, 'saved.txt'))}, 'utf8'))`
      )
      expect(resumed.status).toBe('completed')
      expect(resumed.stdout).toContain('undefined 42')
      expect(Number(resumed.stdout.split(' ')[0])).not.toBe(pid)
      expect(
        (await notebook.runIndex({ ...scope, workspaceCwd: workspace })).length
      ).toBeGreaterThanOrEqual(2)

      if (stage === 'running' && policy === 'expiry') {
        const livePid = Number(resumed.stdout.split(' ')[0])
        for (const mode of ['foreground', 'background'] as const) {
          const started = join(workspace, `${mode}-started`)
          const finish = join(workspace, `${mode}-finish`)
          const code = `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started'); while (!require('node:fs').existsSync(${JSON.stringify(finish)})) await new Promise(resolve => setTimeout(resolve, 10)); console.log(process.pid)`
          const foreground = mode === 'foreground' ? execute(scope.sessionId, code) : undefined
          const background =
            mode === 'background'
              ? await notebook.executeControlBackground({
                  ...scope,
                  workspaceCwd: workspace,
                  background: true,
                  code
                })
              : undefined
          try {
            await vi.waitFor(() => access(started))
            now += NOTEBOOK_SESSION_IDLE_MS
            await sweep()
            await expect(
              archive.isSessionLocallyBusy(scope.projectId, scope.sessionId)
            ).resolves.toBe(true)
            expect(() => process.kill(livePid, 0)).not.toThrow()
          } finally {
            await writeFile(finish, 'finish')
            await foreground
            if (background) await notebook.waitForBackgroundRun(background.runId)
          }
          if (foreground) expect((await foreground).stdout.trim()).toBe(String(livePid))
          if (background) {
            await notebook.waitForBackgroundRun(background.runId)
            expect(
              (
                await notebook.getBackgroundRun({
                  ...scope,
                  workspaceCwd: workspace,
                  runId: background.runId
                })
              ).run.status
            ).toBe('completed')
          }
          expect((await execute(scope.sessionId, 'console.log(process.pid)')).stdout.trim()).toBe(
            String(livePid)
          )
        }

        // Hold the final activity check after it read idle, then admit real work. The policy must
        // discard the stale result, and the same interpreter must finish the new request.
        await sweep()
        const continueCheck = Promise.withResolvers<void>()
        const localActivity = archive.isSessionLocallyBusy.bind(archive)
        let calls = 0
        const activity = vi
          .spyOn(archive, 'isSessionLocallyBusy')
          .mockImplementation(async (project, session) => {
            const busy = await localActivity(project, session)
            if (++calls === 2) {
              await continueCheck.promise
            }
            return busy
          })
        now += NOTEBOOK_SESSION_IDLE_MS
        const sweeping = sweep()
        try {
          await vi.waitFor(() => expect(calls).toBe(2))
          const arriving = execute(scope.sessionId, 'console.log(process.pid)')
          continueCheck.resolve()
          await sweeping
          expect((await arriving).stdout.trim()).toBe(String(livePid))
        } finally {
          continueCheck.resolve()
          await sweeping
          activity.mockRestore()
        }
        await sweep()
        now += NOTEBOOK_SESSION_IDLE_MS
        await sweep()
        expect(() => process.kill(livePid, 0)).toThrow()
        expect((await execute(scope.sessionId, 'console.log(42)')).stdout.trim()).toBe('42')
        expect((await jobs.get(jobId))?.status).toBe('running')
      }
      remote.failQueries(false)
      remote.complete()
      await vi.waitFor(async () => {
        await ray!.retry(jobId)
        expect(await jobs.get(jobId)).toMatchObject({
          status: 'success',
          harvested_at: expect.any(Number),
          file_evidence: { activityId: jobId }
        })
      })
      expect(await agent.getJobResult(scope, target.providerId, jobId)).toMatchObject({
        status: 'success',
        result_final: true,
        exit_code: 0
      })
      const published = await readFile(
        join(
          getJobHarvestDir(root, scope.projectId, scope.sessionId, jobId),
          'featured',
          'result.bin'
        )
      )
      expect(hash(published)).toBe(hash(Buffer.from(input).reverse()))
      expect(remote.creates()).toBe(1)
      expect(
        await client.computeJob.count({
          where: { projectId: scope.projectId, sessionId: scope.sessionId }
        })
      ).toBe(1)
      expect((await execute(scope.sessionId, 'console.log(6 * 7)')).stdout.trim()).toBe('42')
    } finally {
      clock.mockRestore()
      await ray?.stop()
      await composition?.dispose()
      await client.$disconnect()
      await remote?.close()
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      await releaseLocks()
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)

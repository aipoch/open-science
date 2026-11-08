import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, it, vi } from 'vitest'
import type { ComputeApprovalRequest } from '../../shared/compute'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AgentComputeService } from './agent-compute-service'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { ComputeService } from './compute-service'
import { EnabledComputeHostsRegistry } from './enabled-hosts-registry'
import { harvestJob } from './harvest-engine'
import { ComputeJobRepository } from './job-repository'
import { readRayJournal } from './ray-job-journal'
import { createRayJobRuntime } from './ray-job-runtime'
import { rayTokens } from './ray-token'
import { createNodeSecureStorageCipher } from '../credential-identity/node-cipher'
import { configureSecureStorageCipher } from '../secure-storage'
import { RayTargetCatalog } from './ray-target-catalog'
import { ComputeHostRepository } from './repository'
import { getJobHarvestDir } from './workspace-path'

const releaseLocks = configureTestRuntimeMetadata()
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

// The regular suite replaces only the Dashboard. Both modes use the real ZIP, SQLite,
// permission broker, runtime, filesystem publication and project evidence machinery.
async function dashboard(
  sharedRoot: string,
  token: string
): Promise<{ endpoint: string; creates(): number; close(): Promise<void> }> {
  const packages = new Map<string, Buffer>()
  const jobs = new Map<string, Record<string, unknown>>()
  let creates = 0
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer ' + token) {
        res.writeHead(401)
        res.end()
        return
      }
      const url = req.url!
      let status = 200
      let data: unknown
      if (url === '/api/version') {
        data = {
          version: '4',
          ray_version: '2.52.0',
          ray_commit: 'fixture',
          session_name: 'local-ray'
        }
      } else if (url.startsWith('/api/packages/gcs/')) {
        const key = 'gcs://' + url.slice('/api/packages/gcs/'.length)
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          packages.set(key, Buffer.concat(chunks))
        } else if (!packages.has(key)) status = 404
      } else if (url === '/api/jobs/' && req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const spec = JSON.parse(Buffer.concat(chunks).toString())
        creates++
        const bytes = await JSZip.loadAsync(packages.get(spec.runtime_env.working_dir)!)
        const frozen = await bytes.file('input.bin')!.async('nodebuffer')
        await writeFile(join(sharedRoot, spec.submission_id, 'result.bin'), frozen.reverse())
        jobs.set(spec.submission_id, {
          ...spec,
          type: 'SUBMISSION',
          status: 'SUCCEEDED',
          driver_exit_code: 0
        })
        data = { submission_id: spec.submission_id }
      } else if (url.endsWith('/logs')) {
        data = { logs: 'done\n' }
      } else if (req.method === 'GET' && url.startsWith('/api/jobs/')) {
        data = jobs.get(url.slice('/api/jobs/'.length))
        if (!data) status = 404
      } else status = 404
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    endpoint: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    creates: () => creates,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

it('recovers an approved Ray job from SQLite and publishes the output and Project evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ray-workflow-'))
  const live = process.env.RUN_REAL_RAY_JOBS === '1'
  const tokenFile = live && process.env.RAY_TEST_TOKEN_PATH
  const testToken = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : 'ray-' + randomUUID()
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
  const key = randomBytes(32)
  const cipher = createNodeSecureStorageCipher(
    { backend: 'mac-keychain', appName: 'Ray test', exists: true },
    root,
    {
      readPassword: () => Buffer.from(key),
      unprotect: () => {
        throw new Error('Unexpected DPAPI call')
      }
    }
  )
  configureSecureStorageCipher(cipher)
  const sharedRoot = live ? process.env.RAY_TEST_SHARED_ROOT! : join(root, 'share')
  const remoteRoot = '/ray-output'
  const input = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 256))
  const expected = Buffer.from(input).reverse()
  const scope = {
    projectId: 'ray-project',
    sessionId: 'ray-session',
    producerRunId: 'ray-producer'
  }
  const workspace = join(root, 'notebooks', scope.projectId, scope.sessionId)
  let client = createProjectDbClient(root)
  const getClient = async (): Promise<typeof client> => client
  const catalog = new RayTargetCatalog(() => root)
  const hosts = new ComputeHostRepository(getClient, { rayTargets: catalog })
  const jobs = new ComputeJobRepository(getClient)
  const operations = new ComputeJobOperationRepository(getClient)
  const noSsh = async (): Promise<never> => {
    throw Error('Ray job attempted SSH')
  }
  let approve = false
  const broadcast = vi.fn((request: ComputeApprovalRequest) => {
    queueMicrotask(() => approval.respond(request.id, approve ? 'once' : 'deny'))
  })
  const approval = new ComputeApprovalBroker({ generateId: randomUUID, broadcast })
  const service = new ComputeService({
    repository: hosts,
    jobRepository: jobs,
    operationRepository: operations,
    approvalBroker: approval,
    runner: { run: noSsh },
    storageRoot: root
  })
  const sessions = new EnabledComputeHostsRegistry()
  const agent = new AgentComputeService(service, sessions)
  const makeRuntime = (): ReturnType<typeof createRayJobRuntime> =>
    createRayJobRuntime({
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
  let runtime: ReturnType<typeof makeRuntime> | undefined
  let fake: Awaited<ReturnType<typeof dashboard>> | undefined
  try {
    await migrateApplicationDatabase(client)
    await mkdir(workspace, { recursive: true })
    if (!live) {
      await mkdir(sharedRoot)
      fake = await dashboard(sharedRoot, testToken)
    }
    const endpoint = live ? process.env.RAY_TEST_ENDPOINT! : fake!.endpoint
    expect(new URL(endpoint).hostname).toBe('127.0.0.1')
    if (!live || tokenFile) await rayTokens.set(endpoint, testToken)
    const target = await catalog.create({
      displayName: 'Ray acceptance',
      endpoint,
      sharedRoot,
      remoteRoot,
      cpus: 1,
      gpus: 0
    })
    const file = join(workspace, 'source.bin')
    await writeFile(file, input)
    const command = `python -c 'import os; from pathlib import Path; (Path(os.environ["RAY_JOB_OUTPUT_DIR"]) / "result.bin").write_bytes(Path("input.bin").read_bytes()[::-1])'`
    const submit = (): ReturnType<AgentComputeService['submitJob']> =>
      agent.submitJob(scope, target.providerId, 'reverse input bytes', command, {
        workspaceCwd: workspace,
        inputs: [{ src: 'source.bin', dst_filename: 'input.bin' }],
        outputManifest: JSON.stringify(['result.bin'])
      })
    await expect(submit()).rejects.toThrow()
    expect(broadcast).not.toHaveBeenCalled()
    sessions.set(scope.sessionId, [target.providerId])
    await expect(submit()).rejects.toThrow(/denied/i)
    expect(await jobs.findByOwner(scope)).toHaveLength(0)
    approve = true
    const replacement = Buffer.alloc(input.length, 0xff)
    broadcast.mockImplementationOnce((request) => {
      expect(approval.getPending(request.id)).toMatchObject({
        ray: {
          inputFiles: [
            {
              source: 'source.bin',
              destination: 'input.bin',
              sizeBytes: input.length,
              sha256: sha256(input)
            }
          ]
        }
      })
      // Change the bytes while the exact request is pending; its path and size stay the same.
      writeFileSync(file, replacement)
      approval.respond(request.id, 'once')
    })
    const submitted = await submit()
    expect(broadcast).toHaveBeenCalledTimes(2)
    for (const [request] of broadcast.mock.calls) {
      expect(JSON.stringify(request).includes(testToken)).toBe(false)
      expect(request).toMatchObject({
        operation: 'submit_job',
        provider_id: target.providerId,
        command_full: command,
        ray: { endpoint, cpus: 1, gpus: 0, remoteRoot }
      })
    }
    const jobId = submitted.job_id
    expect(await jobs.get(jobId)).toMatchObject({ status: 'submitted', execution_mode: 'ray_jobs' })
    if (fake) expect(fake.creates()).toBe(0)
    expect(await readFile(file)).toEqual(replacement)
    await client.$disconnect()
    client = createProjectDbClient(root)
    // Exercise both sides of the durable launch fence against the loopback Dashboard.
    const interrupted = new Set<number>()
    if (fake) {
      const server = fake
      const get = rayTokens.get.bind(rayTokens)
      vi.spyOn(rayTokens, 'get').mockImplementation(async (address) => {
        const row = await jobs.get(jobId)
        const posts = server.creates()
        if (row && readRayJournal(row).launch && !interrupted.has(posts)) {
          interrupted.add(posts)
          throw new Error('Test credential temporarily locked.')
        }
        return get(address)
      })
    }
    runtime = makeRuntime()
    runtime.start()
    await vi.waitFor(
      async () => {
        if (fake) await runtime!.retry(jobId)
        else await runtime!.tick()
        const row = await jobs.get(jobId)
        expect(
          row,
          JSON.stringify({
            status: row?.status,
            error: row?.error_message,
            poll: row?.last_poll_error,
            harvest: row?.harvest_error
          })
        ).toMatchObject({
          status: 'success',
          file_evidence: { activityId: jobId, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) }
        })
      },
      { timeout: live ? 90000 : 15000, interval: live ? 500 : 100 }
    )
    const row = await jobs.get(jobId)
    const result = await agent.getJobResult(scope, target.providerId, jobId)
    expect(result).toMatchObject({ status: 'success', result_final: true, exit_code: 0 })
    const published = await readFile(
      join(
        getJobHarvestDir(root, scope.projectId, scope.sessionId, jobId),
        'featured',
        'result.bin'
      )
    )
    expect(sha256(published)).toBe(sha256(expected))
    expect(JSON.stringify(row).includes(testToken)).toBe(false)
    const evidence = row!.file_evidence!
    expect(evidence.parentActivityId).toBe(scope.producerRunId)
    expect(evidence.storageKey).toBe(
      `execution-file-evidence/${scope.projectId}/${scope.sessionId}/activity-${jobId}/evidence.json`
    )
    const record = await readFile(join(root, evidence.storageKey!))
    expect(sha256(record)).toBe(evidence.checksum)
    expect(record.toString()).toContain(sha256(input))
    expect(record.toString()).toContain(sha256(expected))
    if (fake) {
      expect(interrupted).toEqual(new Set([0, 1]))
      expect(fake.creates()).toBe(1)
    }
    if (live) {
      // Keep the host offline until the remote driver enforces its own deadline.
      const timeoutJob = await agent.submitJob(
        scope,
        target.providerId,
        'exercise driver deadline',
        `python -c 'print("x" * (320 * 1024), flush=True)' && sleep 60`,
        { timeoutSeconds: 8 }
      )
      const detailsUrl = new URL('/api/jobs/' + timeoutJob.job_id, endpoint)
      const providerRead = {
        redirect: 'error' as const,
        headers: tokenFile ? { authorization: 'Bearer ' + testToken } : undefined
      }
      await vi.waitFor(
        async () => {
          await runtime!.tick()
          const response = await fetch(detailsUrl, providerRead)
          expect(response.status).toBe(200)
        },
        { timeout: 8000, interval: 50 }
      )
      await runtime.pause()
      let providerExitCode: number | undefined
      await vi.waitFor(
        async () => {
          const response = await fetch(detailsUrl, providerRead)
          const details = await response.json()
          expect(details.status).toBe('FAILED')
          expect([-9, 137]).toContain(details.driver_exit_code)
          providerExitCode = details.driver_exit_code
        },
        { timeout: 30000, interval: 500 }
      )
      const logs = await fetch(new URL(detailsUrl.pathname + '/logs', endpoint), providerRead)
      expect(logs.status).toBe(200)
      const logBytes = Buffer.byteLength((await logs.json()).logs)
      expect(logBytes).toBeGreaterThan(300 * 1024)
      const timeoutRow = await jobs.get(timeoutJob.job_id)
      const journal = readRayJournal(timeoutRow!)
      const receipt = await readFile(
        join(sharedRoot, timeoutJob.job_id, '.open-science-timeout'),
        'utf8'
      )
      expect(receipt).toBe(journal.nonce)
      runtime.resume()
      await vi.waitFor(
        async () => {
          await runtime!.tick()
          expect(await jobs.get(timeoutJob.job_id)).toMatchObject({
            status: 'timeout',
            error_code: 'timeout',
            exit_code: providerExitCode
          })
        },
        { timeout: 10000, interval: 300 }
      )
      process.stdout.write(
        `Real Ray job ${jobId}: output ${sha256(published)}, evidence ${evidence.checksum}; deadline job ${timeoutJob.job_id}: driver_exit_code=${providerExitCode}, logBytes=${logBytes}, timeout receipt verified\n`
      )
    }
  } finally {
    await runtime?.stop()
    vi.restoreAllMocks()
    await client.$disconnect()
    await fake?.close()
    cipher.dispose()
    key.fill(0)
    vi.unstubAllEnvs()
    await releaseLocks()
    await rm(root, { recursive: true, force: true })
  }
}, 120000)

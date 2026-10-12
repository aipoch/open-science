// RUN_COMPUTE_JOBS=1 COMPUTE_TEST_SSH_ALIAS=my-host npx vitest run --project process src/main/compute/compute-jobs.integration.test.ts
import {
  createComputeExecution,
  createSshRunner,
  createScpRunner,
  resolveSshTarget,
  quoteRemotePath,
  shellSingleQuote,
  type JobPoller
} from '@aipoch/compute/node'
import { computeProviderId, type ComputeJobStatus } from '@aipoch/compute'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeService } from './compute-service'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import { SshConfigComputeConnectionBroker, type ComputeConnectionBroker } from './connection-broker'
import { ComputeHostRepository } from './repository'

const RUN = process.env.RUN_COMPUTE_JOBS === '1'
const ALIAS = process.env.COMPUTE_TEST_SSH_ALIAS ?? ''
const describeIf = RUN && ALIAS ? describe : describe.skip
const MAX_POLL_WAIT_MS = 120_000
const POLL_PAUSE_MS = 2_000

async function pollUntilTerminal(
  poller: JobPoller,
  service: ComputeService,
  jobId: string
): ReturnType<ComputeService['getJobStatus']> {
  const startMs = Date.now()
  let status = await service.getJobStatus(jobId)
  const terminal: ComputeJobStatus[] = ['success', 'failed', 'timeout', 'error']
  while (!terminal.includes(status.status)) {
    if (Date.now() - startMs > MAX_POLL_WAIT_MS)
      throw new Error(
        `Job did not reach terminal state within ${MAX_POLL_WAIT_MS}ms: ${status.status}`
      )
    await poller.tick()
    status = await service.getJobStatus(jobId)
    if (!terminal.includes(status.status)) await new Promise((r) => setTimeout(r, POLL_PAUSE_MS))
  }
  return status
}

configureTestRuntimeMetadata()

describeIf('compute-jobs integration (real SSH)', () => {
  let db: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
  let hosts: ComputeHostRepository
  let broker: SshConfigComputeConnectionBroker
  // One live host/database owns one scope, including submission handoffs and polling.
  const execution = createComputeExecution()
  const providerId = computeProviderId(ALIAS)
  const workdirs: string[] = []
  const jobIds: string[] = []
  const runner = createSshRunner()

  beforeAll(async () => {
    db = await createMigratedComputeTestDatabase('open-science-jobs-int-')
    hosts = new ComputeHostRepository(async () => db.client)
    await hosts.create({ sshAlias: ALIAS, displayName: `test-${ALIAS}` })
    broker = new SshConfigComputeConnectionBroker({
      getHost: (id) => hosts.get(id),
      runner,
      scpRunner: createScpRunner(),
      resolveTarget: (alias, overrides) => resolveSshTarget(alias, overrides)
    })
  })

  async function run(command: string): ReturnType<typeof runner.run> {
    const connection = await broker.acquire(providerId, { intent: 'job_cleanup' })
    return connection.run(command, { timeoutMs: 30_000, loginShell: false })
  }

  afterAll(async () => {
    if (!db) return
    await execution.waitForDispatch(jobIds)
    try {
      for (const workdir of workdirs) {
        // The unique workdir is ours; cleanup must also run after a failed assertion.
        const cleanup = `import os, signal
root = os.path.realpath(os.path.expanduser(${JSON.stringify(workdir)}))
try: leader = int(open(root + '/job.pid').read())
except (OSError, ValueError): leader = -1
for name in os.listdir('/proc'):
    if not name.isdigit(): continue
    try:
        if os.getsid(int(name)) == leader and os.readlink('/proc/' + name + '/cwd') == root:
            os.kill(int(name), signal.SIGKILL)
    except OSError: pass`
        expect((await run(`python3 -c ${shellSingleQuote(cleanup)}`)).exitCode).toBe(0)
        expect((await run(`rm -rf -- ${quoteRemotePath(workdir)}`)).exitCode).toBe(0)
      }
    } finally {
      await db.dispose()
    }
  })

  function fixture(
    approvalId: string,
    connectionBroker: ComputeConnectionBroker = broker
  ): {
    service: ComputeService
    poller: JobPoller
    submit: (
      command: string,
      timeoutSeconds?: number,
      inputs?: { src: string; dst_filename: string }[],
      workspaceCwd?: string
    ) => ReturnType<ComputeService['submitJob']>
  } {
    const approval = new ComputeApprovalBroker({
      broadcast: () => undefined,
      generateId: () => approvalId,
      timeoutMs: 5_000
    })
    const request = approval.request.bind(approval)
    approval.request = async (info) => {
      const pending = request(info)
      setImmediate(() => approval.respond(approvalId, 'once'))
      return pending
    }
    const requestWithContext = approval.requestWithContext.bind(approval)
    approval.requestWithContext = async (info, context) => {
      const pending = requestWithContext(info, context)
      setImmediate(() => approval.respond(approvalId, 'once'))
      return pending
    }
    const service = new ComputeService({
      runner,
      repository: hosts,
      approvalBroker: approval,
      jobRepository: db.repositories.jobs,
      connectionBroker,
      execution,
      storageRoot: db.storageRoot
    })
    const poller = execution.createPoller({
      connectionBroker,
      hostRepository: hosts,
      jobRepository: db.repositories.jobs
    })
    async function submit(
      command: string,
      timeoutSeconds = 60,
      inputs?: { src: string; dst_filename: string }[],
      workspaceCwd?: string
    ): ReturnType<ComputeService['submitJob']> {
      const result = await service.submitJob(
        providerId,
        approvalId,
        command,
        { timeoutSeconds, inputs, workspaceCwd },
        { sessionId: 'int-sess', projectId: 'int-proj' }
      )
      expect(result.status).toBe('submitted')
      expect(result.job_id).toBeDefined()
      workdirs.push(result.remote_workdir)
      jobIds.push(result.job_id)
      return result
    }
    return { service, poller, submit }
  }

  it('submits sleep+echo → running → success end-to-end', async () => {
    let entered!: () => void
    let release!: () => void
    const dispatchEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const dispatchGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gated: ComputeConnectionBroker = {
      beginHostDeletion: (id) => broker.beginHostDeletion(id),
      abortHostDeletion: (id) => broker.abortHostDeletion(id),
      completeHostDeletion: (id) => broker.completeHostDeletion(id),
      acquire: async (id, request) => {
        if (request.intent === 'job_dispatch') {
          entered()
          await dispatchGate
        }
        return broker.acquire(id, request)
      }
    }
    const { submit, service, poller } = fixture('appr-success', gated)
    const result = await submit('sleep 1 && echo ok > out.txt')
    try {
      await dispatchEntered
      // Deterministically poll while dispatch owns its lease; no sleep hides the handoff race.
      await poller.tick()
      expect(await db.repositories.jobs.get(result.job_id)).toMatchObject({
        status: 'submitted',
        error_code: undefined
      })
    } finally {
      release()
      await execution.waitForDispatch([result.job_id])
    }
    expect(await db.repositories.jobs.get(result.job_id)).toMatchObject({ status: 'running' })
    const status = await pollUntilTerminal(poller, service, result.job_id)
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    expect(status.remote_workdir).toBe(result.remote_workdir)
  }, 150_000)

  it('exit 3 → failed (errorCode=job_failed)', async () => {
    const { submit, service, poller } = fixture('appr-failed')
    const result = await submit('exit 3')
    const status = await pollUntilTerminal(poller, service, result.job_id)
    expect(status.status).toBe('failed')
    expect(status.exit_code).toBe(3)
    expect(await db.repositories.jobs.get(result.job_id)).toMatchObject({
      error_code: 'job_failed'
    })
  }, 150_000)

  it('sleep 99999 with timeout_seconds=5 → timeout (errorCode=timeout)', async () => {
    const { submit, service, poller } = fixture('appr-timeout')
    const result = await submit('sleep 99999', 5)
    const status = await pollUntilTerminal(poller, service, result.job_id)
    expect(status.status).toBe('timeout')
    expect([124, 137]).toContain(status.exit_code)
    expect(await db.repositories.jobs.get(result.job_id)).toMatchObject({ error_code: 'timeout' })
  }, 180_000)

  it('missing process without exit_code → process_vanished after 2 poll ticks', async () => {
    const { submit, service, poller } = fixture('appr-vanished')
    const result = await submit('sleep 99999')
    await execution.waitForDispatch([result.job_id])
    expect((await service.getJobStatus(result.job_id)).status).toBe('running')
    // Stop the launcher first so it cannot write exit_code while killing timeout's separate group.
    const killSession = `import os, signal, time
root = os.path.realpath(os.path.expanduser(${JSON.stringify(result.remote_workdir)}))
leader = int(open(root + '/job.pid').read())
assert os.readlink('/proc/' + str(leader) + '/cwd') == root
os.kill(leader, signal.SIGSTOP)
os.kill(leader, signal.SIGKILL)
def live():
    found = []
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            if os.getsid(int(name)) == leader and os.readlink('/proc/' + name + '/cwd') == root: found.append(int(name))
        except OSError: pass
    return found
deadline = time.monotonic() + 5
while live():
    assert time.monotonic() < deadline, 'test session did not exit'
    for pid in live():
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    time.sleep(0.01)
assert not os.path.exists(root + '/exit_code')
print('session-gone-without-exit-code')`
    const killed = await run(`python3 -c ${shellSingleQuote(killSession)}`)
    expect(killed.exitCode).toBe(0)
    expect(killed.stdout.trim()).toBe('session-gone-without-exit-code')
    await poller.tick()
    expect(await db.repositories.jobs.get(result.job_id)).toMatchObject({
      status: 'running',
      error_code: undefined,
      exit_code: undefined
    })
    await poller.tick()
    expect(await db.repositories.jobs.get(result.job_id)).toMatchObject({
      status: 'failed',
      error_code: 'process_vanished',
      exit_code: undefined
    })
    expect(
      (await run(`test ! -e ${quoteRemotePath(`${result.remote_workdir}/exit_code`)}`)).exitCode
    ).toBe(0)
  }, 120_000)

  it('stages a workspace file and job can read it via ./dst_filename', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'os-int-workspace-'))
    try {
      await writeFile(join(workspace, 'hello.txt'), 'staged-content\n')
      const { submit, service, poller } = fixture('appr-staging')
      const result = await submit(
        'cmp hello.txt <(printf "staged-content\\n") && printf PASS > verify.txt',
        60,
        [{ src: 'hello.txt', dst_filename: 'hello.txt' }],
        workspace
      )
      const job = (await db.repositories.jobs.get(result.job_id))!
      const [input] = JSON.parse(job.input_manifest!)
      expect(input.localPath).toMatch(/^\$DATA\/execution-file-evidence\//)
      expect(input.generationId).toBeTruthy()
      const status = await pollUntilTerminal(poller, service, result.job_id)
      expect(status.status).toBe('success')
      expect(status.exit_code).toBe(0)
      const remote = await run(`cat ${quoteRemotePath(`${result.remote_workdir}/hello.txt`)}`)
      expect(remote.exitCode).toBe(0)
      expect(remote.stdout).toBe('staged-content\n')
      const connection = await broker.acquire(providerId, { intent: 'job_harvest' })
      const downloaded = join(workspace, 'downloaded.txt')
      const download = await connection.download(
        `${result.remote_workdir}/verify.txt`,
        downloaded,
        1024
      )
      expect(download).toMatchObject({ exitCode: 0, bytesWritten: 4, exceeded: false })
      expect(await readFile(downloaded, 'utf8')).toBe('PASS')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }, 150_000)
})

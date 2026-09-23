// RUN_COMPUTE_CANCELLATION=1 COMPUTE_TEST_SSH_ALIAS=hpc-dev npx vitest run src/main/compute/cancellation.real-ssh.integration.test.ts
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import {
  ComputeJobCancellationOwner,
  ComputeJobCancellationReaper
} from './compute-job-cancellation-owner'
import {
  SshConfigComputeConnectionBroker,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import { dispatchJob, buildLauncherScript, toBase64 } from './job-dispatcher'
import { JobPoller } from './job-poller'
import { probeRemoteLaunch } from './remote-launch-recovery'
import { ComputeHostRepository } from './repository'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import { SystemSshRunner } from './ssh-runner'

const alias = process.env.COMPUTE_TEST_SSH_ALIAS ?? 'local-cancellation'
const remoteEnabled =
  process.env.RUN_COMPUTE_CANCELLATION === '1' && !!process.env.COMPUTE_TEST_SSH_ALIAS
const localEnabled =
  process.platform === 'linux' &&
  spawnSync('/bin/sh', ['-c', 'command -v bash timeout setsid python3']).status === 0
const enabled = remoteEnabled || localEnabled
// Linux CI exercises the same detached process protocol without SSH credentials. The opt-in
// hpc-dev path additionally exercises the production SSH transport and connection broker.
const localRun: ComputeConnectionLease['run'] = (command, options) =>
  new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', command],
      { timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          timedOut: error?.killed ?? false,
          truncated: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        })
      }
    )
  })

it.skipIf(!enabled).each(['running', 'orphaned'] as const)(
  'cancels a %s real session and its TERM-resistant workload before confirming',
  async (state) => {
    const db = await createMigratedComputeTestDatabase('compute-cancel-real-')
    const jobId = randomUUID()
    const workdir = `/tmp/open-science-cancel-${jobId}/.open-science/jobs/${jobId}`
    const scope = { projectId: 'project-1', sessionId: 'session-1', providerId: `ssh:${alias}` }
    const hosts = new ComputeHostRepository(async () => db.client)
    await hosts.create({ sshAlias: alias, executionMode: 'direct_ssh' })
    const transport: ComputeConnectionBrokerAcquirer = remoteEnabled
      ? new SshConfigComputeConnectionBroker({
          getHost: (id) => hosts.get(id),
          runner: new SystemSshRunner()
        })
      : { acquire: async () => ({ run: localRun }) as ComputeConnectionLease }
    // This regression covers hosts using the legacy session backend. New supervisor ownership
    // (including root exit and owner loss) is exercised by remote-job-tree.real-ssh.integration.
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: async (...args) => {
        const lease = await transport.acquire(...args)
        return {
          ...lease,
          run: (command, options) =>
            lease.run(
              command.replace(
                toBase64(buildLauncherScript(120)),
                toBase64(buildLauncherScript(120).replace('if python3', 'if false && python3'))
              ),
              options
            )
        }
      }
    }
    const connection = await broker.acquire(scope.providerId, { intent: 'job_cleanup' })
    const run = (command: string): ReturnType<ComputeConnectionLease['run']> =>
      connection.run(command, { timeoutMs: 10000, loginShell: false, maxOutputBytes: 8192 })
    const inspect = `import os, json
root = ${JSON.stringify(workdir)}
try:
    leader = int(open(root + '/job.pid').read())
except (OSError, ValueError):
    leader = -1
found = []
for name in os.listdir('/proc'):
    if not name.isdigit(): continue
    try:
        if os.getsid(int(name)) == leader and os.readlink('/proc/' + name + '/cwd'): found.append(int(name))
    except OSError: pass
print(json.dumps(found))`
    try {
      await db.repositories.jobs.create({
        id: jobId,
        ...scope,
        shape: 'direct_ssh',
        intent: 'isolated cancellation regression',
        command:
          "echo $$ > workload.pid\ntrap '' TERM\n(cd /tmp; sleep 120) &\necho $! > child.pid\nwait\n",
        commandHash: 'test',
        remoteWorkdir: workdir,
        initialStatus: 'submitted',
        timeoutSeconds: 120,
        allowUnencryptedPersistence: true
      })
      await dispatchJob(jobId, {
        connectionBroker: broker,
        hostRepository: hosts,
        jobRepository: db.repositories.jobs
      })
      expect(await db.repositories.jobs.get(jobId)).toMatchObject({ status: 'running' })
      const ready = await run(
        `for i in 1 2 3 4 5; do [ -s ${quoteRemotePath(`${workdir}/child.pid`)} ] && exit 0; sleep 1; done; exit 1`
      )
      expect(ready.exitCode).toBe(0)
      const before = await run(`python3 -c ${shellSingleQuote(inspect)}`)
      expect(JSON.parse(before.stdout).length).toBeGreaterThanOrEqual(3)
      const handle = JSON.parse((await db.repositories.jobs.get(jobId))!.remote_handle!)
      // An unrelated session sharing the same cwd must remain alive.
      expect(
        (
          await run(
            `cd ${quoteRemotePath(workdir)}; nohup setsid sleep 120 >/dev/null 2>&1 & echo $! > unrelated.pid`
          )
        ).exitCode
      ).toBe(0)
      if (state === 'orphaned') {
        expect((await run(`kill -KILL -- -${handle.pid}`)).exitCode).toBe(0)
      }
      expect(await probeRemoteLaunch(connection, workdir)).toMatchObject({ kind: 'running' })
      const poller = new JobPoller({
        connectionBroker: broker,
        hostRepository: hosts,
        jobRepository: db.repositories.jobs
      })
      await poller.tick()
      await poller.tick()
      expect(await db.repositories.jobs.get(jobId)).toMatchObject({ status: 'running' })
      await new ComputeJobCancellationOwner(
        db.repositories.operations,
        db.repositories.jobs
      ).request(jobId, scope)
      const reaper = new ComputeJobCancellationReaper(
        db.repositories.operations,
        db.repositories.jobs,
        broker
      )
      await reaper.runOnce()
      expect(await db.repositories.jobs.get(jobId)).toMatchObject({
        cancellation_status: 'cancelled'
      })
      const remaining = await run(`python3 -c ${shellSingleQuote(inspect)}`)
      expect(JSON.parse(remaining.stdout)).toEqual([])
      expect(
        (await run(`kill -0 $(cat ${quoteRemotePath(`${workdir}/unrelated.pid`)})`)).exitCode
      ).toBe(0)
    } finally {
      // Only test processes with this unique canonical cwd are eligible for fixture cleanup.
      const cleanup = inspect
        .replace(
          'if os.getsid(int(name)) == leader and os.readlink',
          "if (os.getsid(int(name)) == leader or os.readlink('/proc/' + name + '/cwd') == root) and os.readlink"
        )
        .replace(
          'print(json.dumps(found))',
          'for pid in found:\n    try: os.kill(pid, 9)\n    except ProcessLookupError: pass'
        )
      await run(`python3 -c ${shellSingleQuote(cleanup)}`)
      await run(`rm -rf -- ${quoteRemotePath(`/tmp/open-science-cancel-${jobId}`)}`)
      await db.dispose()
    }
  },
  60000
)

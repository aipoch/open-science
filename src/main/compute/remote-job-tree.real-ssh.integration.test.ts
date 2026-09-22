import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { buildLauncherScript } from './job-dispatcher'
import { resolveSshTarget, SystemSshRunner } from './ssh-runner'
import {
  probeRemoteJobProcessOwnership,
  terminateRemoteJobProcessIfOwned
} from './remote-job-process'
import type { ComputeConnectionLease } from './connection-broker'
import { directLaunchScopeLines } from './remote-execution-scope'
import { probeRemoteLaunch } from './remote-launch-recovery'
import { remoteJobSupervisorSource } from './remote-job-supervisor'

it
  .skipIf(!process.env.COMPUTE_TEST_SSH_ALIAS)
  .each([
    'legacy',
    'legacy-orphan',
    'supervisor',
    'supervisor-orphan',
    'supervisor-timeout',
    'supervisor-cancel-grace',
    'supervisor-timeout-grace',
    'supervisor-adopted-grace',
    'supervisor-lost',
    'supervisor-completed'
  ] as const)(
  'stops the actual %s launcher including workload groups',
  async (mode) => {
    const target = await resolveSshTarget(process.env.COMPUTE_TEST_SSH_ALIAS!, undefined)
    const runner = new SystemSshRunner()
    const run: ComputeConnectionLease['run'] = (command, options) =>
      runner.run(target, command, options)
    const connection = { run } as ComputeConnectionLease
    const id = `cancel-tree-${randomUUID()}`
    const directory = `"$HOME/.openscience/jobs/${id}"`
    const legacy = mode.startsWith('legacy')
    const graceful = mode.endsWith('-grace')
    const automaticTimeout = mode === 'supervisor-timeout' || mode === 'supervisor-timeout-grace'
    const gracefulProgram = Buffer.from(
      [
        'import os, signal, sys, time',
        ...(mode === 'supervisor-adopted-grace'
          ? [
              'if os.fork() != 0:',
              '    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))',
              '    while True: time.sleep(1)'
            ]
          : []),
        'def stop(*_):',
        '    with open("term-count", "a") as stream: stream.write("TERM\\n")',
        `    time.sleep(${automaticTimeout ? 5 : 1})`,
        '    with open("checkpoint", "w") as stream: stream.write("saved")',
        '    sys.exit(0)',
        'signal.signal(signal.SIGTERM, stop)',
        'with open("worker.pid", "w") as stream: stream.write(str(os.getpid()))',
        'while True: time.sleep(1)'
      ].join('\n')
    ).toString('base64')
    // Disable the capability branch to reproduce already-dispatched pre-supervisor jobs.
    const launcher = Buffer.from(
      buildLauncherScript(automaticTimeout ? 2 : 120).replace(
        legacy ? 'if python3' : 'NOT_PRESENT',
        'if false && python3'
      )
    ).toString('base64')
    const workload = Buffer.from(
      mode === 'supervisor-completed'
        ? 'echo finished\n'
        : graceful
          ? `exec python3 -c "$(printf '%s' '${gracefulProgram}' | base64 -d)"\n`
          : legacy
            ? 'sleep 120\n'
            : `setsid bash -c 'trap "" TERM; cd /tmp; sleep 120' &\necho $! > worker.pid\n${mode === 'supervisor-orphan' ? 'exit 0' : 'wait'}\n`
    ).toString('base64')
    const supervisor = Buffer.from(remoteJobSupervisorSource).toString('base64')
    const launch = await run(
      `mkdir -p ${directory}\ncd ${directory} || exit 1\nprintf '%s' '${launcher}' | base64 -d > launcher.sh\nprintf '%s' '${workload}' | base64 -d > command.sh\nprintf '%s' '${supervisor}' | base64 -d > supervisor.py\nprintf '%s|' "$PWD"\n${directLaunchScopeLines().join('\n')}`,
      { timeoutMs: 15000 }
    )
    expect(launch.exitCode).toBe(0)
    const [cwd, rawPid] = launch.stdout.trim().split('|')
    const pid = Number(rawPid)
    expect(cwd.endsWith(`/jobs/${id}`)).toBe(true)
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true)
    const census = `ps -eo sid=,pid=,pgid=,stat=,comm= | awk '$1 == ${pid} && $4 !~ /^Z/ {print}'`
    let worker = 0
    try {
      if (mode === 'supervisor-completed') {
        await expect.poll(() => probeRemoteJobProcessOwnership(pid, cwd, connection)).toBe('absent')
        expect((await run(`cat ${directory}/exit_code`, { timeoutMs: 10000 })).stdout.trim()).toBe(
          '0'
        )
        return
      }
      if (legacy) {
        await expect
          .poll(
            async () => (await run(census, { timeoutMs: 10000 })).stdout.trim().split('\n').length
          )
          .toBeGreaterThanOrEqual(3)
        if (mode === 'legacy-orphan') {
          await run(`kill -KILL ${pid}`, { timeoutMs: 10000 })
          expect((await run(census, { timeoutMs: 10000 })).stdout).toContain('timeout')
        }
      } else {
        await expect
          .poll(
            async () =>
              (await run(`test -s ${directory}/worker.pid`, { timeoutMs: 10000 })).exitCode
          )
          .toBe(0)
        worker = Number(
          (await run(`cat ${directory}/worker.pid`, { timeoutMs: 10000 })).stdout.trim()
        )
        expect(Number.isSafeInteger(worker) && worker > 1).toBe(true)
        if (mode === 'supervisor') {
          expect(await probeRemoteLaunch(connection, cwd)).toMatchObject({
            kind: 'running',
            handle: { scope_version: 1 }
          })
          await run(`cd ${directory} && mv execution.scope execution.scope.saved`, {
            timeoutMs: 10000
          })
          expect(await probeRemoteJobProcessOwnership(pid, cwd, connection, true)).toBe('unknown')
          expect(await terminateRemoteJobProcessIfOwned(pid, cwd, connection, true)).toBe(false)
          expect(await probeRemoteLaunch(connection, cwd)).toEqual({ kind: 'ambiguous' })
          await run(`cd ${directory} && mv execution.scope.saved execution.scope`, {
            timeoutMs: 10000
          })
          for (const invalid of [
            'supervisor-v1 wrong-boot 1 1',
            `supervisor-v1 $(cat /proc/sys/kernel/random/boot_id) ${pid} 1`
          ]) {
            await run(
              `cd ${directory} && cp execution.scope execution.scope.saved && printf "%s\\n" "${invalid}" > execution.scope`,
              { timeoutMs: 10000 }
            )
            expect(await terminateRemoteJobProcessIfOwned(pid, cwd, connection)).toBe(false)
            expect(
              (await run(`ps -o stat= -p ${worker}`, { timeoutMs: 10000 })).stdout.trim()
            ).not.toBe('')
            await run(`cd ${directory} && mv execution.scope.saved execution.scope`, {
              timeoutMs: 10000
            })
          }
        }
        if (mode === 'supervisor-lost') {
          await run(`kill -KILL ${pid}`, { timeoutMs: 10000 })
          expect(await probeRemoteJobProcessOwnership(pid, cwd, connection)).toBe('unknown')
          expect(await terminateRemoteJobProcessIfOwned(pid, cwd, connection)).toBe(false)
          expect(
            (await run(`ps -o stat= -p ${worker}`, { timeoutMs: 10000 })).stdout.trim()
          ).not.toBe('')
          return
        }
        if (automaticTimeout) {
          await expect
            .poll(() => probeRemoteJobProcessOwnership(pid, cwd, connection), { timeout: 45000 })
            .toBe('absent')
          expect(
            (await run(`cat ${directory}/exit_code`, { timeoutMs: 10000 })).stdout.trim()
          ).toBe('124')
        }
      }
      expect(await terminateRemoteJobProcessIfOwned(pid, cwd, connection)).toBe(true)
      if (graceful) {
        const saved = await run(`cd ${directory} && cat checkpoint && printf '|'; cat term-count`, {
          timeoutMs: 10000
        })
        expect(saved.stdout.trim()).toBe('saved|TERM')
      }
      expect((await run(census, { timeoutMs: 10000 })).stdout.trim()).toBe('')
      if (worker)
        expect(
          (await run(`ps -o stat= -p ${worker}`, { timeoutMs: 10000 })).stdout
            .trim()
            .replace(/^Z.*$/, '')
        ).toBe('')
    } finally {
      // Exact freshly-created test session/group only; never a command-name search across user jobs.
      if (!legacy && mode !== 'supervisor-lost')
        await run(`[ "$(readlink /proc/${pid}/cwd)" != '${cwd}' ] || kill -TERM ${pid}; sleep 4`, {
          timeoutMs: 10000
        })
      await run(
        `for g in $(ps -eo sid=,pgid= | awk '$1 == ${pid} {print $2}' | sort -u); do [ "$g" -gt 1 ] && kill -KILL -- -"$g" 2>/dev/null; done`,
        { timeoutMs: 10000 }
      )
      if (worker)
        await run(
          `[ "$(ps -o sid= -p ${worker} | tr -d ' ')" != '${worker}' ] || kill -KILL -- -${worker}`,
          { timeoutMs: 10000 }
        )
      const cleaned = await run(
        `cd ${directory} && rm -f -- command.sh launcher.sh supervisor.py stdout stderr exit_code exit_code.tmp job.pid job.pid.tmp worker.pid checkpoint term-count execution.scope execution.scope.saved execution.stopped execution.cancel && rmdir ${directory}`,
        { timeoutMs: 10000 }
      )
      expect(cleaned.exitCode).toBe(0)
    }
  },
  60000
)

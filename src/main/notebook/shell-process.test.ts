import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as processTree from '../process-tree'
import * as powerShellParser from './powershell-search-parser'
import * as windowsRuntime from './windows-notebook-runtime'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NotebookShellProcessAdapter,
  buildShellEnv,
  normalizePowerShellStderr,
  resolveShellInvocation,
  resolveShellProcessInvocation,
  runShellCommand,
  terminateShellOnTimeout,
  type NotebookShellProcessRequest
} from './shell-process'
import { NOTEBOOK_TEXT_LIMIT_BYTES } from './content-limits'
import type { NotebookProcessSandbox } from './process-sandbox'
import { normalizeFilesystemLayout } from '../../../packages/notebook-network-sandbox/runtime/src/platform/filesystem-layout.js'
import { terminateProcessTree } from '../process-tree'
import { notebookWorkloadCacheEnv } from './notebook-workload-cache-paths'
import { createManagedShellExecutionCapability } from './managed-shell-execution'
import { shellNpmPaths } from './shell-npm-environment'
import { windowsSupervisedLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import { ViolationLog } from '../../../packages/notebook-network-sandbox/runtime/src/gateway/violation-log'

let portableRuntimeRoot: string

beforeEach(async () => {
  portableRuntimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-portable-runtime-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(portableRuntimeRoot, { recursive: true, force: true })
})

const previewAvailable = (): boolean => true

it.skipIf(process.platform === 'win32')(
  'reports actual bounded managed output before exit and isolates observer failures',
  async () => {
    const chunks: Array<{ runId: string; stream: string; text: string }> = []
    const early = Promise.withResolvers<void>()
    const capability = createManagedShellExecutionCapability({
      projectId: 'project',
      sessionId: 'session',
      executionInvocationId: 'live-output',
      cwd: portableRuntimeRoot,
      environment: { HOME: portableRuntimeRoot, PATH: '/usr/bin:/bin' },
      filesystem: { readOnlyRoots: [], readWriteRoots: [portableRuntimeRoot] },
      onOutput: (chunk) => {
        chunks.push(chunk)
        if (chunk.stream === 'stdout') {
          early.resolve()
          throw new Error('observer failed')
        }
      }
    })
    let settled = false
    const execution = runShellCommand({
      projectId: 'project',
      sessionId: 'session',
      runId: 'live-run',
      executionInvocationId: 'live-output',
      managedExecution: capability,
      command: "printf 'early\\n'; sleep 0.1; printf 'late\\n' >&2",
      cwd: portableRuntimeRoot,
      handoffDir: portableRuntimeRoot,
      runtimeRoot: portableRuntimeRoot,
      processSandbox: {
        wrap: async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (text) => text,
          cleanup: async () => ({
            processesTerminated: true,
            networkClosed: true,
            temporaryResourcesRemoved: true
          })
        })
      },
      timeoutMs: 5000
    }).finally(() => {
      settled = true
    })
    await Promise.race([
      early.promise,
      execution.then((result) => {
        throw new Error('The process ended before live output: ' + JSON.stringify(result))
      })
    ])
    expect(settled).toBe(false)
    expect(await execution).toMatchObject({ stdout: 'early\n', stderr: 'late\n', exitCode: 0 })
    expect(chunks).toEqual([
      { runId: 'live-run', stream: 'stdout', text: 'early\n' },
      { runId: 'live-run', stream: 'stderr', text: 'late\n' }
    ])
  }
)

describe('bounded Shell adapter lifecycle', () => {
  const request = (
    overrides: Partial<NotebookShellProcessRequest> = {}
  ): NotebookShellProcessRequest => ({
    command: 'echo fixture',
    cwd: portableRuntimeRoot,
    handoffDir: portableRuntimeRoot,
    runtimeRoot: portableRuntimeRoot,
    projectId: 'project',
    sessionId: 'session',
    laneKey: 'lane',
    runId: 'run',
    timeoutMs: 10_000,
    ...overrides
  })

  const managedCapability = (): ReturnType<typeof createManagedShellExecutionCapability> =>
    createManagedShellExecutionCapability({
      projectId: 'project',
      sessionId: 'session',
      executionInvocationId: 'managed',
      cwd: portableRuntimeRoot,
      environment: { HOME: portableRuntimeRoot, PATH: '/usr/bin:/bin' },
      filesystem: { readOnlyRoots: [], readWriteRoots: [portableRuntimeRoot] }
    })

  it.skipIf(process.platform === 'win32')(
    'drains persistent and per-invocation bounded processes together',
    async () => {
      const gate = Promise.withResolvers<void>()
      const cleanup = vi.fn(async () => {
        await gate.promise
        return { processesTerminated: true, networkClosed: true, temporaryResourcesRemoved: true }
      })
      const children: ChildProcess[] = []
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        {
          wrap: async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (text) => text,
            cleanup
          })
        },
        {
          claim: (child) => {
            children.push(child)
            return () => undefined
          }
        }
      )
      await adapter.execute(request({ command: 'export FIXTURE_PERSISTENT=live' }))
      const running = adapter.execute(
        request({
          runId: 'bounded-run',
          executionInvocationId: 'managed',
          managedExecution: managedCapability(),
          command: 'echo ready; while :; do sleep 1; done'
        })
      )
      let stopped = false
      try {
        await vi.waitFor(() => expect(children).toHaveLength(2))
        const shutdown = adapter
          .shutdown({ projectId: 'project', sessionId: 'session' })
          .then((result) => {
            stopped = true
            return result
          })
        await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2))
        expect(stopped).toBe(false)
        for (const child of children)
          expect(() => process.kill(child.pid!, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' })
          )
        gate.resolve()
        expect(await shutdown).toEqual({ reaped: true })
        expect(await running).toMatchObject({ cancelled: true })
      } finally {
        gate.resolve()
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        await running
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains failed managed cleanup and fences ordinary commands until verified',
    async () => {
      let verified = false
      const cleanups: string[] = []
      const adapter = new NotebookShellProcessAdapter(process.platform, {
        wrap: async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (text) => text,
          cleanup: async () => {
            cleanups.push(invocation.executionReference ?? '')
            const complete = invocation.executionReference !== 'managed-run' || verified
            return {
              processesTerminated: true,
              networkClosed: complete,
              temporaryResourcesRemoved: complete
            }
          }
        })
      })
      try {
        await adapter.execute(
          request({ command: 'export FIXTURE_PERSISTENT=live', executionReference: 'ordinary-run' })
        )
        const result = await adapter.execute(
          request({
            runId: 'managed-run',
            executionReference: 'managed-run',
            executionInvocationId: 'managed',
            managedExecution: managedCapability()
          })
        )
        expect(result.errorCode).toBe('shell-cleanup-incomplete')
        expect((await adapter.execute(request())).errorCode).toBe('shell-cleanup-incomplete')
        expect(await adapter.shutdown()).toEqual({ reaped: false })
        expect(cleanups).toContain('ordinary-run')
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
      } finally {
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not let a managed invocation bypass failed persistent cleanup',
    async () => {
      let verified = false
      const wrap = vi.fn(async (invocation: Parameters<NotebookProcessSandbox['wrap']>[0]) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        annotateStderr: (text: string) => text,
        cleanup: async () => ({
          processesTerminated: true,
          networkClosed: verified,
          temporaryResourcesRemoved: verified
        })
      }))
      const adapter = new NotebookShellProcessAdapter(process.platform, { wrap })
      try {
        expect((await adapter.execute(request({ command: 'exit 0' }))).errorCode).toBe(
          'shell-cleanup-incomplete'
        )
        expect(
          (
            await adapter.execute(
              request({ managedExecution: managedCapability(), executionInvocationId: 'managed' })
            )
          ).errorCode
        ).toBe('shell-cleanup-incomplete')
        expect(wrap).toHaveBeenCalledOnce()
      } finally {
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'scopes shutdown and waits for the original process cleanup',
    async () => {
      let allowCleanup!: () => void
      const gate = new Promise<void>((resolve) => {
        allowCleanup = resolve
      })
      const cleanup = vi.fn(async () => {
        await gate
        return { processesTerminated: true, networkClosed: true, temporaryResourcesRemoved: true }
      })
      const children = new Map<string, ChildProcess>()
      const released = vi.fn()
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        {
          wrap: async (invocation) => ({
            executable: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup
          })
        },
        {
          claim: (child, identity) => {
            children.set(identity.runId, child)
            return () => released(identity.runId)
          }
        },
        'bounded'
      )
      const completions = [
        request(),
        request({ runId: 'other-project', projectId: 'other' }),
        request({ runId: 'other-session', sessionId: 'other' }),
        request({ runId: 'other-lane', laneKey: 'other' })
      ].map((input) => adapter.execute(input))
      let shutdownSettled = false
      try {
        await vi.waitFor(() => expect(children.size).toBe(4), { timeout: 5_000 })
        const shutdown = adapter
          .shutdown({ projectId: 'project', sessionId: 'session', laneKey: 'lane' })
          .then((result) => {
            shutdownSettled = true
            return result
          })
        await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce(), { timeout: 5_000 })
        expect(shutdownSettled).toBe(false)
        expect(() => process.kill(children.get('run')!.pid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
        for (const id of ['other-project', 'other-session', 'other-lane'])
          expect(() => process.kill(children.get(id)!.pid!, 0)).not.toThrow()
        expect(released).not.toHaveBeenCalled()
        allowCleanup()
        await expect(shutdown).resolves.toEqual({ reaped: true })
        await expect(completions[0]).resolves.toMatchObject({ cancelled: true })
        expect(released).toHaveBeenCalledExactlyOnceWith('run')
      } finally {
        allowCleanup()
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        await Promise.all(completions)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains failed cleanup, blocks the lane and deduplicates shutdown retries',
    async () => {
      let verified = false
      const cleanup = vi.fn(async () => {
        if (cleanup.mock.calls.length === 2) throw new Error('temporary cleanup failure')
        return {
          processesTerminated: true,
          networkClosed: verified,
          temporaryResourcesRemoved: verified
        }
      })
      const wrap = vi.fn<NotebookProcessSandbox['wrap']>(async (invocation) => ({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: invocation.env,
        annotateStderr: (stderr) => stderr,
        cleanup
      }))
      const release = vi.fn()
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        { wrap },
        { claim: () => release },
        'bounded'
      )
      try {
        expect(await adapter.execute(request())).toMatchObject({
          errorCode: 'shell-cleanup-incomplete',
          ownedTreeReaped: false
        })
        expect(release).not.toHaveBeenCalled()
        expect(await adapter.execute(request({ runId: 'blocked-run' }))).toMatchObject({
          errorCode: 'shell-cleanup-incomplete',
          recovery: { execution: 'not-started' }
        })
        expect(wrap).toHaveBeenCalledOnce()
        expect(await Promise.all([adapter.shutdown(), adapter.shutdown()])).toEqual([
          { reaped: false },
          { reaped: false }
        ])
        expect(cleanup).toHaveBeenCalledTimes(2)
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        expect(release).toHaveBeenCalledOnce()
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        expect(cleanup).toHaveBeenCalledTimes(3)
      } finally {
        verified = true
        await adapter.shutdown()
      }
    }
  )

  it.each(['incomplete', 'throw'] as const)(
    'retains preparation cleanup after %s and retries without spawning',
    async (failure) => {
      let verified = false
      const retryCleanup = vi.fn(async () => {
        if (!verified && failure === 'throw') throw new Error('cleanup unavailable')
        return verified
      })
      const wrap = vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.'),
            { retryCleanup }
          )
        )
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        { wrap },
        undefined,
        'bounded'
      )
      expect(await adapter.execute(request())).toMatchObject({
        errorCode: 'shell-cleanup-incomplete'
      })
      expect(await adapter.shutdown()).toEqual({ reaped: false })
      verified = true
      expect(await adapter.shutdown()).toEqual({ reaped: true })
      expect(wrap).toHaveBeenCalledOnce()
      expect(retryCleanup).toHaveBeenCalledTimes(2)
      expect(await adapter.shutdown()).toEqual({ reaped: true })
      expect(retryCleanup).toHaveBeenCalledTimes(2)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains failed-claim cleanup without creating a replacement process',
    async () => {
      let verified = false
      const cleanup = vi.fn(async () => ({
        processesTerminated: true,
        networkClosed: verified,
        temporaryResourcesRemoved: verified
      }))
      const wrap = vi.fn<NotebookProcessSandbox['wrap']>(async (invocation) => ({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        env: invocation.env,
        annotateStderr: (stderr) => stderr,
        cleanup
      }))
      let child: ChildProcess | undefined
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        { wrap },
        {
          claim: (owned) => {
            child = owned
            throw new Error('receipt unavailable')
          }
        },
        'bounded'
      )
      try {
        expect(await adapter.execute(request())).toMatchObject({
          errorCode: 'shell-cleanup-incomplete'
        })
        expect(() => process.kill(child!.pid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        expect(wrap).toHaveBeenCalledOnce()
        expect(cleanup).toHaveBeenCalledTimes(2)
      } finally {
        verified = true
        await adapter.shutdown()
      }
    }
  )

  it.each(['shutdown', 'caller'] as const)(
    'cancels in-flight preparation through %s and retains cleanup',
    async (source) => {
      let finishPreparation!: () => void
      const gate = new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
      let verified = false,
        seenSignal: AbortSignal | undefined
      const cleanup = vi.fn(async () => ({
        processesTerminated: true,
        networkClosed: verified,
        temporaryResourcesRemoved: verified
      }))
      const wrap = vi.fn<NotebookProcessSandbox['wrap']>(async (invocation) => {
        seenSignal = invocation.signal
        await gate
        return {
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr) => stderr,
          cleanup
        }
      })
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        { wrap },
        undefined,
        'bounded'
      )
      const controller = new AbortController()
      const completion = adapter.execute(request({ signal: controller.signal }))
      try {
        await vi.waitFor(() => expect(wrap).toHaveBeenCalledOnce())
        if (source === 'caller') {
          controller.abort()
          expect(seenSignal?.aborted).toBe(true)
        }
        const shutdown = adapter.shutdown()
        expect(seenSignal?.aborted).toBe(true)
        finishPreparation()
        await expect(completion).resolves.toMatchObject({
          cancelled: true,
          errorCode: 'shell-cleanup-incomplete',
          recovery: { execution: 'not-started' }
        })
        await expect(shutdown).resolves.toEqual({ reaped: false })
        expect(cleanup).toHaveBeenCalledTimes(2)
        expect(cleanup).toHaveBeenLastCalledWith('cancel', {
          processesTerminated: true,
          processState: 'never-started'
        })
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
      } finally {
        finishPreparation()
        verified = true
        await adapter.shutdown()
        await completion
      }
    }
  )

  it('honors an already-aborted caller without preparing or retaining an execution', async () => {
    const wrap = vi.fn(),
      controller = new AbortController()
    controller.abort()
    const adapter = new NotebookShellProcessAdapter(
      process.platform,
      { wrap },
      undefined,
      'bounded'
    )
    await expect(adapter.execute(request({ signal: controller.signal }))).resolves.toMatchObject({
      cancelled: true
    })
    expect(wrap).not.toHaveBeenCalled()
    expect(await adapter.shutdown()).toEqual({ reaped: true })
  })

  it.each(['beginSpawn', 'beginLaunch'] as const)(
    'cleans an active sandbox after %s throws and retains failed cleanup',
    async (stage) => {
      let verified = false
      const endExecution = vi.fn(),
        notStarted = vi.fn(),
        started = vi.fn(),
        claim = vi.fn()
      const cleanup = vi.fn(async () => ({
        processesTerminated: true,
        networkClosed: verified,
        temporaryResourcesRemoved: verified
      }))
      const beginSpawn = vi.fn(() => {
        if (stage === 'beginSpawn') throw new Error('admission unavailable')
        return { started, notStarted }
      })
      const beginLaunch = vi.fn(() => {
        throw new Error('launch intent write failed')
      })
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        {
          wrap: async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            beginExecution: () => endExecution,
            beginSpawn,
            annotateStderr: (stderr) => stderr,
            cleanup
          })
        },
        { claim, beginLaunch },
        'bounded'
      )
      try {
        expect(await adapter.execute(request())).toMatchObject({
          errorCode: 'shell-cleanup-incomplete',
          recovery: { execution: 'not-started' }
        })
        expect(endExecution).toHaveBeenCalledOnce()
        expect(notStarted).toHaveBeenCalledTimes(stage === 'beginLaunch' ? 1 : 0)
        expect(beginLaunch).toHaveBeenCalledTimes(stage === 'beginLaunch' ? 1 : 0)
        expect(started).not.toHaveBeenCalled()
        expect(claim).not.toHaveBeenCalled()
        expect(cleanup).toHaveBeenLastCalledWith('spawn-failed', {
          processesTerminated: true,
          processState: 'never-started'
        })
        expect(await adapter.shutdown()).toEqual({ reaped: false })
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        expect(endExecution).toHaveBeenCalledOnce()
        expect(beginSpawn).toHaveBeenCalledOnce()
      } finally {
        verified = true
        await adapter.shutdown()
      }
    }
  )

  it.skipIf(process.platform === 'win32').each(['before-spawn', 'after-claim'] as const)(
    'retains a throwing launch abort at %s while releasing the other original resources',
    async (stage) => {
      let verified = false
      const abort = vi.fn(() => {
        if (!verified) throw new Error('receipt unlink failed')
      })
      const endExecution = vi.fn(),
        notStarted = vi.fn(),
        started = vi.fn()
      const cleanup = vi.fn(async () => ({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }))
      const claim = vi.fn(() => {
        throw new Error('claim failed')
      })
      const beginLaunch = vi.fn(() => ({ claim, abort }))
      const adapter = new NotebookShellProcessAdapter(
        process.platform,
        {
          wrap: async (invocation) => ({
            executable: process.execPath,
            args: stage === 'before-spawn' ? ['\0'] : ['-e', 'setInterval(()=>{},1000)'],
            env: invocation.env,
            beginExecution: () => endExecution,
            beginSpawn: () => ({ started, notStarted }),
            annotateStderr: (stderr) => stderr,
            cleanup
          })
        },
        { claim, beginLaunch },
        'bounded'
      )
      try {
        expect(await adapter.execute(request())).toMatchObject({
          errorCode: 'shell-cleanup-incomplete'
        })
        expect(endExecution).toHaveBeenCalledOnce()
        expect(cleanup).toHaveBeenCalledOnce()
        expect(notStarted).toHaveBeenCalledTimes(stage === 'before-spawn' ? 1 : 0)
        expect(started).toHaveBeenCalledTimes(stage === 'after-claim' ? 1 : 0)
        expect(await adapter.shutdown()).toEqual({ reaped: false })
        verified = true
        expect(await adapter.shutdown()).toEqual({ reaped: true })
        expect(abort).toHaveBeenCalledTimes(3)
        expect(cleanup).toHaveBeenCalledOnce()
        expect(beginLaunch).toHaveBeenCalledOnce()
      } finally {
        verified = true
        await adapter.shutdown()
      }
    }
  )
})

describe('notebook shell process behavior', () => {
  it.skipIf(process.platform === 'win32' && !process.env.OPEN_SCIENCE_TEST_BASH)(
    'retains a random temporary path across consecutive Bash cells',
    async () => {
      const shell = process.env.OPEN_SCIENCE_TEST_BASH ?? '/bin/bash'
      // Git Bash is only a local Windows test interpreter. Use the production Job Object
      // supervisor so normal shell exit still has authoritative process-tree cleanup proof.
      const sandbox: NotebookProcessSandbox | undefined =
        process.platform === 'win32'
          ? {
              wrap: async (invocation) => {
                const launch = windowsSupervisedLaunch({
                  executable: invocation.executable,
                  args: [...invocation.args],
                  command: '',
                  cwd: portableRuntimeRoot,
                  env: invocation.env,
                  gatewayPort: 1,
                  gatewayCredentials: { username: 'unused', password: 'unused' },
                  hostPath: join(
                    process.cwd(),
                    'packages/notebook-network-sandbox/vendor/windows',
                    process.arch,
                    'notebook-appcontainer-host.exe'
                  )
                })
                return {
                  executable: launch.argv[0],
                  args: launch.argv.slice(1),
                  env: launch.env,
                  confirmProcessTreeTermination: launch.confirmProcessTreeTermination,
                  annotateStderr: (stderr) => stderr,
                  cleanup: async (_reason, outcome) => ({
                    processesTerminated: outcome.processesTerminated,
                    networkClosed: true,
                    temporaryResourcesRemoved: true
                  })
                }
              }
            }
          : undefined
      const adapter = new NotebookShellProcessAdapter(process.platform, sandbox)
      try {
        const request = {
          cwd: portableRuntimeRoot,
          handoffDir: portableRuntimeRoot,
          runtimeRoot: join(portableRuntimeRoot, 'runtime'),
          projectId: 'cross-cell-project',
          sessionId: 'cross-cell-session',
          runtimeBinding: { kind: 'native-posix' as const, shell }
        }
        const first = await adapter.execute({
          ...request,
          command: 'cross_cell_tmp="/tmp/cell-$RANDOM-$RANDOM"; printf "%s" "$cross_cell_tmp"'
        })
        expect(first, JSON.stringify(first)).toMatchObject({ exitCode: 0 })
        expect(first.stdout).toMatch(/^\/tmp\/cell-\d+-\d+$/)
        const second = await adapter.execute({
          ...request,
          command: 'printf "%s" "${cross_cell_tmp-UNSET}"'
        })
        expect(second.exitCode).toBe(0)
        expect(second.stdout).toBe(first.stdout)
        expect(
          await adapter.execute({
            ...request,
            command:
              'export CELL_EXPORT=kept; greet() { printf hello; }; mkdir child; cd child; set -u'
          })
        ).toMatchObject({ exitCode: 0 })
        const state = await adapter.execute({
          ...request,
          command:
            'printf "%s:%s:" "$cross_cell_tmp" "$CELL_EXPORT"; greet; printf ":%s:" "${PWD##*/}"; case "$-" in *u*) printf nounset;; esac'
        })
        expect(state).toMatchObject({
          exitCode: 0,
          stdout: `${first.stdout}:kept:hello:child:nounset`
        })
      } finally {
        expect(await adapter.shutdown()).toEqual({ reaped: true })
      }
    }
  )

  it.each(
    (['7.6', '5.1'] as const).flatMap((version) =>
      [false, true].map((aliased) => ({ version, aliased }))
    )
  )(
    'requires the bundled Node read grant only for PowerShell $version (aliased storage: $aliased)',
    async ({ version, aliased }) => {
      const alias = join(portableRuntimeRoot, 'alias')
      if (aliased)
        await symlink(portableRuntimeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const runtimeRoot = join(aliased ? alias : portableRuntimeRoot, 'managed')
      const root = join(portableRuntimeRoot, 'bundled')
      const nodeRoot = join(root, 'node')
      const hostTools = join(portableRuntimeRoot, 'host-tools')
      await mkdir(hostTools)
      const resolver = vi.spyOn(windowsRuntime, 'resolveWindowsNotebookRuntime').mockReturnValue({
        root,
        node: join(nodeRoot, 'node.exe'),
        powershell: join(root, 'powershell', 'pwsh.exe')
      })
      const parser = vi
        .spyOn(powerShellParser, 'parsePowerShellSearchCommands')
        .mockResolvedValue([])
      const admission = vi
        .spyOn(processTree, 'assertProcessTreeSupport')
        .mockImplementation(() => {})
      const wrap = vi
        .fn<NotebookProcessSandbox['wrap']>()
        .mockRejectedValue(new Error('stop-before-spawn'))
      try {
        const result = await runShellCommand({
          command: 'node --version',
          cwd: portableRuntimeRoot,
          handoffDir: portableRuntimeRoot,
          runtimeRoot,
          environment: {
            PATH: hostTools,
            ...(version === '7.6'
              ? { NPM_CONFIG_PREFIX: join(portableRuntimeRoot, '.notebook-tools', 'npm') }
              : {})
          },
          sessionId: 'fixture-session',
          projectId: 'fixture-project',
          platform: 'win32',
          runtimeBinding: { kind: 'powershell', version },
          processSandbox: { wrap }
        })
        expect(result.stderr).toBe('stop-before-spawn')
        expect(wrap).toHaveBeenCalledOnce()
        const { filesystem, env } = wrap.mock.calls[0][0]
        if (version === '7.6') {
          expect(env.NPM_CONFIG_PREFIX).toBe(
            realpathSync.native(shellNpmPaths(runtimeRoot, 'win32').prefix)
          )
          expect(filesystem.readWriteRoots).toContain(env.NPM_CONFIG_PREFIX)
        }
        if (version === '7.6') expect(filesystem.readOnlyRoots).toContain(nodeRoot)
        else expect(filesystem.readOnlyRoots).not.toContain(nodeRoot)
        expect(filesystem.readOnlyRoots).not.toContain(hostTools)
        expect(filesystem.optionalReadOnlyRoots).toContain(hostTools)
      } finally {
        resolver.mockRestore()
        parser.mockRestore()
        admission.mockRestore()
      }
    }
  )

  it('returns application recovery facts when earlier cleanup blocks native preparation', async () => {
    const result = await runShellCommand({
      command: 'printf never-started',
      cwd: process.cwd(),
      handoffDir: process.cwd(),
      runtimeRoot: portableRuntimeRoot,
      sessionId: 'session',
      projectId: 'project',
      processSandbox: {
        wrap: vi
          .fn()
          .mockRejectedValue(
            new Error('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.')
          )
      }
    })
    expect(result).toMatchObject({
      stdout: '',
      exitCode: null,
      errorCode: 'shell-cleanup-incomplete',
      recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
    })
  })
  it('keeps a persistent lane blocked until incomplete cleanup is verified', async () => {
    const wrap = vi
      .fn()
      .mockRejectedValue(
        new Error('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.')
      )
    const adapter = new NotebookShellProcessAdapter(process.platform, { wrap })
    const request = {
      command: 'echo never-started',
      cwd: process.cwd(),
      handoffDir: process.cwd(),
      runtimeRoot: portableRuntimeRoot,
      sessionId: 'session',
      projectId: 'project'
    }
    const first = await adapter.execute(request)
    expect(first).toMatchObject({
      exitCode: null,
      errorCode: 'shell-cleanup-incomplete',
      recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
    })
    expect(await adapter.execute(request)).toMatchObject({ errorCode: 'shell-cleanup-incomplete' })
    expect(wrap).toHaveBeenCalledTimes(1)
    expect(await adapter.shutdown()).toEqual({ reaped: false })
    expect(await adapter.execute(request)).toMatchObject({ errorCode: 'shell-cleanup-incomplete' })
  })

  it.each(['incomplete', 'throw'])(
    'retries preparation cleanup on shutdown after %s proof',
    async (failure) => {
      let verified = false
      const retryCleanup = vi.fn(async () => {
        if (!verified && failure === 'throw') throw new Error('cleanup still unavailable')
        return verified
      })
      const wrap = vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error('SHELL_CLEANUP_INCOMPLETE: Previous shell cleanup could not be reconciled.'),
            { retryCleanup }
          )
        )
      const adapter = new NotebookShellProcessAdapter(process.platform, { wrap })
      const request = {
        command: 'echo never-started',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session',
        projectId: 'project'
      }
      const result = await adapter.execute(request)
      expect(result).toMatchObject({
        errorCode: 'shell-cleanup-incomplete',
        ownedTreeReaped: false
      })
      wrap.mockRejectedValueOnce(new Error('unrelated preparation failure must never run'))
      expect(await adapter.execute(request)).toMatchObject({
        errorCode: 'shell-cleanup-incomplete'
      })
      expect(wrap).toHaveBeenCalledOnce()
      expect(await adapter.shutdown()).toEqual({ reaped: false })
      verified = true
      expect(await adapter.shutdown()).toEqual({ reaped: true })
      expect(retryCleanup).toHaveBeenCalledTimes(3)
      expect(wrap).toHaveBeenCalledOnce()
      expect(await adapter.shutdown()).toEqual({ reaped: true })
      expect(retryCleanup).toHaveBeenCalledTimes(3)
    }
  )

  it('rejects unavailable process ownership before sandbox preparation', async () => {
    const admission = vi.spyOn(processTree, 'assertProcessTreeSupport').mockImplementation(() => {
      throw new processTree.ProcessTreeUnavailableError(new Error('native module missing'))
    })
    const wrap = vi.fn()
    try {
      const result = await runShellCommand({
        command: 'printf should-not-run',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session',
        projectId: 'project',
        processSandbox: { wrap }
      })
      expect(result).toMatchObject({
        stdout: '',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
      expect(result.stderr).toContain('native module missing')
      expect(result.recovery).toEqual({ execution: 'not-started', retryAfter: 'runtime-ready' })
      expect(wrap).not.toHaveBeenCalled()
    } finally {
      admission.mockRestore()
    }
  })
  describe('invocation', () => {
    it('uses a POSIX sh command on Unix platforms', () => {
      expect(resolveShellInvocation('echo hi', 'linux')).toEqual({
        executable: '/bin/sh',
        args: ['-c', 'echo hi']
      })
    })

    it('uses an absolute non-interactive PowerShell command on Windows without relying on PATH', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const invocation = resolveShellInvocation('cp "source.png" "destination.png"', {
        kind: 'powershell',
        version: '5.1'
      })

      expect(invocation.executable).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      )
      expect(invocation.args.slice(0, -1)).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand'
      ])

      const script = Buffer.from(invocation.args.at(-1) ?? '', 'base64').toString('utf16le')
      expect(script).toContain('[Console]::OutputEncoding = $openScienceUtf8')
      expect(script).toContain('$OutputEncoding = $openScienceUtf8')
      expect(script).toContain('$env:PSModulePath = $env:OPEN_SCIENCE_PSMODULEPATH')
      expect(script).toContain(
        'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop'
      )
      expect(script).toContain(
        'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop'
      )
      expect(script).toContain(
        "[System.Environment]::SetEnvironmentVariable('OPEN_SCIENCE_PSMODULEPATH', $null, [System.EnvironmentVariableTarget]::Process)"
      )
      expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
      expect(script).toContain("$ErrorActionPreference = 'Stop'")
      expect(script).toContain('catch {')
      expect(script).toContain('[Console]::Error.WriteLine($_.ToString())')
      const encodedCommand = script.match(/\$openScienceCommandBase64 = '([A-Za-z0-9+/=]+)'/)?.[1]
      expect(Buffer.from(encodedCommand ?? '', 'base64').toString('utf8')).toBe(
        'cp "source.png" "destination.png"'
      )
      expect(script).toContain('[ScriptBlock]::Create($openScienceCommandText)')
      expect(script).toContain('& $openScienceCommand')
      expect(script).toContain('$openScienceSucceeded = $?')
      expect(script).toContain('exit $openScienceNativeExitCode')
      expect(script).toMatch(/if \(\$openScienceSucceeded\) \{ exit 0 \}/)
      expect(script.indexOf('exit $openScienceNativeExitCode')).toBeLessThan(
        script.indexOf('if ($openScienceSucceeded) { exit 0 }')
      )
      expect(script).toMatch(/exit 1\s*$/)
    })

    it('isolates PowerShell command syntax from the exit-code wrapper', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const command = "Write-Output 'first'\n# keep this comment\nWrite-Output 'continued' `"
      const invocation = resolveShellInvocation(command, { kind: 'powershell', version: '5.1' })
      const script = Buffer.from(invocation.args.at(-1) ?? '', 'base64').toString('utf16le')
      const encodedCommand = script.match(/\$openScienceCommandBase64 = '([A-Za-z0-9+/=]+)'/)?.[1]

      expect(script).not.toContain(command)
      expect(encodedCommand).toBeDefined()
      expect(Buffer.from(encodedCommand ?? '', 'base64').toString('utf8')).toBe(command)
      expect(script).toContain('[ScriptBlock]::Create($openScienceCommandText)')
      expect(script).toContain('& $openScienceCommand')
    })

    it('uses the shell captured by a native POSIX binding instead of re-reading the host platform', () => {
      expect(
        resolveShellInvocation('echo hi', {
          kind: 'native-posix',
          shell: '/opt/local/bin/zsh'
        })
      ).toEqual({ executable: '/opt/local/bin/zsh', args: ['-c', 'echo hi'] })
    })

    it('keeps host write protection separate from the selected Shell runtime', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const nativeBinding = { kind: 'native-posix' as const, shell: '/bin/sh' }
      const wslBinding = {
        kind: 'wsl2-bash' as const,
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'researcher'
      }

      expect(
        resolveShellProcessInvocation('echo hi', nativeBinding, '/managed/runtime', 'darwin', false)
      ).toMatchObject({
        executable: '/usr/bin/sandbox-exec',
        args: expect.arrayContaining(['/bin/sh', '-c', 'echo hi'])
      })
      expect(
        resolveShellProcessInvocation('echo hi', nativeBinding, '/managed/runtime', 'linux', false)
      ).toEqual({ executable: '/bin/sh', args: ['-c', 'echo hi'] })
      expect(
        resolveShellProcessInvocation(
          'Write-Output hi',
          { kind: 'powershell', version: '5.1' },
          'C:\\managed\\runtime',
          'win32',
          false
        ).executable
      ).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/)
      expect(
        resolveShellProcessInvocation('echo hi', wslBinding, 'C:\\managed\\runtime', 'win32', true)
      ).toEqual({ executable: '/bin/bash', args: ['-c', 'echo hi'] })
    })

    it('uses Bash and the exact selected profile for a WSL2 sandbox target', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => {
          throw new Error(`prepared:${JSON.stringify(invocation.target)}:${invocation.executable}`)
        })
      }

      const result = await runShellCommand({
        command: 'echo hi',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        inputRoot: 'C:\\inputs',
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        },
        processSandbox,
        previewAvailable
      })

      expect(result).toEqual({
        stdout: '',
        stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
      expect(processSandbox.wrap).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            kind: 'wsl2',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          executable: '/bin/bash',
          pathEnvironment: {
            OPEN_SCIENCE_HANDOFF_DIR: 'C:\\handoff',
            ...notebookWorkloadCacheEnv(portableRuntimeRoot),
            NPM_CONFIG_PREFIX: shellNpmPaths(portableRuntimeRoot, 'linux').prefix,
            NPM_CONFIG_CACHE: shellNpmPaths(portableRuntimeRoot, 'linux').cache,
            OPEN_SCIENCE_INPUT_DIR: 'C:\\inputs'
          },
          filesystem: expect.objectContaining({
            readOnlyRoots: expect.arrayContaining(['C:\\inputs']),
            readWriteRoots: expect.arrayContaining([
              shellNpmPaths(portableRuntimeRoot, 'linux').prefix
            ])
          })
        })
      )
    })

    it('does not prepare a selected WSL2 runtime while the main Preview gate is closed', async () => {
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn()
      }

      const result = await runShellCommand({
        command: 'echo should-not-run',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        },
        processSandbox,
        previewAvailable: () => false
      })

      expect(result).toEqual({
        stdout: '',
        stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
      expect(processSandbox.wrap).not.toHaveBeenCalled()
    })

    it('surfaces the stable fail-closed diagnostic when guest-to-host transport is unsupported', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async () => {
          throw new Error(
            'WSL2_NETWORK_TRANSPORT_UNSUPPORTED: WSL2 Bash Preview network access requires mirrored networking.'
          )
        })
      }

      await expect(
        runShellCommand({
          command: 'echo should-not-run',
          cwd: 'C:\\workspace',
          handoffDir: 'C:\\handoff',
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          processSandbox,
          previewAvailable
        })
      ).resolves.toEqual({
        stdout: '',
        stderr:
          'WSL2_NETWORK_TRANSPORT_UNSUPPORTED: WSL2 Bash Preview network access requires mirrored networking.',
        exitCode: null,
        errorCode: 'shell-network-transport-unsupported',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
    })

    it('prioritizes incomplete WSL preparation cleanup over an aborted signal', async () => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const controller = new AbortController()
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async () => {
          controller.abort()
          throw new Error(
            'SHELL_CLEANUP_INCOMPLETE: WSL2 shell preparation cleanup could not be verified.'
          )
        })
      }

      await expect(
        runShellCommand({
          command: 'echo should-not-run',
          cwd: 'C:\\workspace',
          handoffDir: 'C:\\handoff',
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          signal: controller.signal,
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          processSandbox,
          previewAvailable
        })
      ).resolves.toMatchObject({
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete',
        recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
      })
    })

    it('fails a selected WSL2 runtime closed with a stable unavailable code instead of native fallback', async () => {
      const result = await runShellCommand({
        command: 'Write-Output should-not-run',
        cwd: 'C:\\workspace',
        handoffDir: 'C:\\handoff',
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'win32',
        runtimeBinding: {
          kind: 'wsl2-bash',
          profileId: 'profile-1',
          distro: 'Ubuntu-22.04',
          user: 'researcher'
        }
      })

      expect(result).toEqual({
        stdout: '',
        stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
    })
  })

  describe('platform support', () => {
    const completedProgressClixml =
      '#< CLIXML\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
      '<Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
      '</Objs>\n'

    it('drops progress-only PowerShell CLIXML stderr records', () => {
      expect(normalizePowerShellStderr(completedProgressClixml, 'win32')).toBe('')
    })

    it('preserves real stderr around benign PowerShell CLIXML progress records', () => {
      expect(
        normalizePowerShellStderr(
          `real warning\n${completedProgressClixml}\nstill important\n`,
          'win32'
        )
      ).toBe('real warning\nstill important\n')
    })

    it('preserves non-progress PowerShell CLIXML records', () => {
      const errorClixml =
        '#< CLIXML\n' +
        '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
        '<Obj S="Error" RefId="0"><MS><S N="Message">boom</S></MS></Obj>' +
        '</Objs>\n'

      expect(normalizePowerShellStderr(errorClixml, 'win32')).toBe(errorClixml)
    })

    it('normalizes CLIXML only for the PowerShell binding on a Windows host', async () => {
      // This test exercises stderr projection, not the Windows-only AST parser executable.
      const parser = vi
        .spyOn(powerShellParser, 'parsePowerShellSearchCommands')
        .mockResolvedValue([{ name: 'emit', arguments: ['stderr'] }])
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-binding-stderr-'))
      const execute = async (
        runtimeBinding:
          | { kind: 'powershell'; version: '5.1' }
          | {
              kind: 'wsl2-bash'
              profileId: string
              distro: string
              user: string
            }
      ): Promise<string> => {
        const processSandbox: NotebookProcessSandbox = {
          wrap: vi.fn(async (invocation) => ({
            executable: process.execPath,
            args: ['-e', `process.stderr.write(${JSON.stringify(completedProgressClixml)})`],
            env: invocation.env,
            annotateStderr: (stderr: string) => stderr,
            cleanup: vi.fn(async () => ({
              processesTerminated: true,
              networkClosed: true,
              temporaryResourcesRemoved: true
            }))
          }))
        }
        const result = await runShellCommand({
          command: 'emit stderr',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding,
          processSandbox,
          previewAvailable,
          terminateTree: async () => ({ reaped: true })
        })
        return result.stderr
      }

      try {
        await expect(
          execute({
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          })
        ).resolves.toBe(completedProgressClixml)
        await expect(execute({ kind: 'powershell', version: '5.1' })).resolves.toBe('')
      } finally {
        parser.mockRestore()
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    })

    it('annotates redirected JSON filesystem errors while preserving Shell stdout', async () => {
      const parser = vi
        .spyOn(powerShellParser, 'parsePowerShellSearchCommands')
        .mockResolvedValue([])
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      const path = String.raw`C:\Users\fixture\.config\sample-tool\access-token.txt`
      const stdout = `Access is denied.\n${JSON.stringify(
        {
          ok: false,
          message: `EPERM: operation not permitted, open '${path}'`
        },
        null,
        2
      )}\n`
      const log = new ViolationLog()
      try {
        const result = await runShellCommand({
          command: 'sample-command 2>&1',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding: { kind: 'powershell', version: '5.1' },
          processSandbox: {
            wrap: async (invocation) => ({
              executable: process.execPath,
              args: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
              env: invocation.env,
              confirmProcessTreeTermination: async () => true,
              annotateStderr: (stderr, output) => log.attach('command', stderr, undefined, output),
              cleanup: async () => ({
                processesTerminated: true,
                networkClosed: true,
                temporaryResourcesRemoved: true
              })
            })
          },
          terminateTree: async () => ({ reaped: true })
        })
        expect(result.stdout).toBe(stdout)
        expect(result.stderr).toContain(`OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${path} `)
        expect(result.stderr).not.toContain('"ok"')
      } finally {
        parser.mockRestore()
      }
    })

    it('keeps Windows shell runtime variables while excluding host secrets', () => {
      const runtimeRoot = 'D:\\OpenScience\\runtime'
      const env = buildShellEnv(
        '/notebook/handoff',
        'win32',
        {
          PATH: 'C:\\Windows\\System32',
          ProgramFiles: 'C:\\Program Files',
          SystemRoot: 'C:\\Windows',
          WINDIR: 'C:\\Windows',
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          USERPROFILE: 'C:\\Users\\Ada',
          PSModulePath: 'C:\\host\\third-party-modules',
          OPEN_SCIENCE_PSMODULEPATH: 'C:\\host\\controlled-modules',
          OPEN_SCIENCE_TEST_SECRET: 'must-not-leak'
        },
        runtimeRoot,
        undefined,
        { kind: 'powershell', version: '5.1' }
      )
      const cacheRoot = join(runtimeRoot, 'cache', 'notebook')

      expect(env).toMatchObject({
        PATH: 'C:\\Windows\\System32',
        ProgramFiles: 'C:\\Program Files',
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        PSModulePath:
          'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        OPEN_SCIENCE_PSMODULEPATH:
          'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
        OPEN_SCIENCE_HANDOFF_DIR: '/notebook/handoff',
        OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
        PIP_CACHE_DIR: join(cacheRoot, 'pip'),
        HF_HUB_CACHE: join(cacheRoot, 'huggingface', 'hub'),
        TORCH_HOME: join(cacheRoot, 'torch')
      })
      expect(env.USERPROFILE).toBeUndefined()
      expect(env.OPEN_SCIENCE_TEST_SECRET).toBeUndefined()
    })

    it('waits for process-tree termination before settling a timed-out shell command', async () => {
      const child = {} as ChildProcess
      let finishTermination: ((result: { reaped: boolean }) => void) | undefined
      const terminateTree = vi.fn(
        () =>
          new Promise<{ reaped: boolean }>((resolve) => {
            finishTermination = resolve
          })
      )

      let settled = false
      const termination = terminateShellOnTimeout(child, 'win32', terminateTree).then((result) => {
        settled = true
        return result
      })

      expect(termination).toBeInstanceOf(Promise)
      expect(terminateTree).toHaveBeenCalledWith(child)
      await Promise.resolve()
      expect(settled).toBe(false)

      finishTermination?.({ reaped: true })
      return expect(termination).resolves.toEqual({ reaped: true })
    })

    it('waits for bounded POSIX process-tree reaping before reporting termination', async () => {
      const child = Object.assign(new EventEmitter(), { pid: 4321 }) as unknown as ChildProcess
      let finishTermination: ((result: { reaped: boolean }) => void) | undefined
      const terminateTree = vi.fn(
        () =>
          new Promise<{ reaped: boolean }>((resolve) => {
            finishTermination = resolve
          })
      )
      let completed = false

      const termination = terminateShellOnTimeout(child, 'linux', terminateTree).then((result) => {
        completed = true
        return result
      })

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(terminateTree).toHaveBeenCalledWith(child)
      expect(completed).toBe(false)
      finishTermination?.({ reaped: true })
      await expect(termination).resolves.toEqual({ reaped: true })
    })

    it('reports an incomplete bounded POSIX teardown without claiming success', async () => {
      const child = { pid: 4321 } as unknown as ChildProcess
      const terminateTree = vi.fn(async () => ({ reaped: false }))

      await expect(terminateShellOnTimeout(child, 'darwin', terminateTree)).resolves.toEqual({
        reaped: false
      })
    })
  })

  it('awaits exactly one structured cleanup when spawn throws synchronously', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-sync-spawn-cleanup-'))
    let releaseCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const cleanup = vi.fn(async () => {
      await cleanupGate
      return {
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }
    })
    const endExecution = vi.fn()
    const beginExecution = vi.fn(() => endExecution)
    const spawnStarted = vi.fn()
    const spawnNotStarted = vi.fn()
    const beginSpawn = vi.fn(() => ({ started: spawnStarted, notStarted: spawnNotStarted }))
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: ['\0'],
        env: invocation.env,
        beginExecution,
        beginSpawn,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    let completed = false

    const completion = runShellCommand({
      command: 'echo unreachable',
      cwd: process.cwd(),
      handoffDir: process.cwd(),
      runtimeRoot,
      sessionId: 'session-1',
      projectId: 'project-1',
      platform: process.platform,
      processSandbox
    }).then((result) => {
      completed = true
      return result
    })

    await vi.waitFor(
      () =>
        expect(cleanup).toHaveBeenCalledWith('spawn-failed', {
          processesTerminated: true,
          processState: 'never-started'
        }),
      { timeout: 5_000 }
    )
    expect(completed).toBe(false)
    expect(beginExecution).toHaveBeenCalledOnce()
    expect(endExecution).toHaveBeenCalledOnce()
    expect(beginSpawn).toHaveBeenCalledOnce()
    expect(spawnNotStarted).toHaveBeenCalledOnce()
    expect(spawnStarted).not.toHaveBeenCalled()
    releaseCleanup?.()

    const result = await completion
    expect(result).toMatchObject({ exitCode: null })
    expect(result.stderr).toContain('null bytes')
    expect(result.errorCode).toBeUndefined()
    const [sandboxInvocation] = vi.mocked(processSandbox.wrap).mock.calls[0]
    expect(sandboxInvocation.filesystem.deniedWriteRoots).toEqual([])
    expect(cleanup).toHaveBeenCalledOnce()
    expect(endExecution).toHaveBeenCalledOnce()
    await rm(runtimeRoot, { recursive: true, force: true })
  })

  it.each(['native-posix', 'wsl2-bash'] as const)(
    'does not create cleanup debt when %s is cancelled before spawn',
    async (kind) => {
      vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
      const controller = new AbortController()
      const beginSpawn = vi.fn()
      const cleanup = vi.fn(async () => ({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }))
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => {
          controller.abort()
          return {
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            env: invocation.env,
            beginSpawn,
            annotateStderr: (stderr: string) => stderr,
            cleanup
          }
        })
      }

      await expect(
        runShellCommand({
          command: 'echo never-spawned',
          cwd: 'C:\\workspace',
          handoffDir: 'C:\\handoff',
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: kind === 'wsl2-bash' ? 'win32' : process.platform,
          signal: controller.signal,
          runtimeBinding:
            kind === 'native-posix'
              ? { kind, shell: '/bin/sh' }
              : {
                  kind: 'wsl2-bash',
                  profileId: 'profile-1',
                  distro: 'Ubuntu-22.04',
                  user: 'researcher'
                },
          processSandbox,
          previewAvailable
        })
      ).resolves.toMatchObject({ cancelled: true, exitCode: null })
      expect(beginSpawn).not.toHaveBeenCalled()
      expect(cleanup).toHaveBeenCalledWith('cancel', {
        processesTerminated: true,
        processState: 'never-started'
      })
    }
  )

  it('returns a stable failure instead of trusting an exit when sandbox cleanup is incomplete', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-incomplete-cleanup-'))
    const cleanup = vi.fn(async () => ({
      processesTerminated: false,
      networkClosed: true,
      temporaryResourcesRemoved: false
    }))
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("finished")'],
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        confirmProcessState: async () => 'started-and-reaped' as const,
        cleanup
      }))
    }

    try {
      await expect(
        runShellCommand({
          command: 'echo finished',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: process.platform,
          processSandbox,
          terminateTree: async () => ({ reaped: true })
        })
      ).resolves.toEqual({
        stdout: 'finished',
        stderr:
          'SHELL_CLEANUP_INCOMPLETE: Shell execution cleanup did not complete; the result is not trusted.',
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete',
        recovery: { execution: 'may-have-run', retryAfter: 'cleanup-verified' }
      })
      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('exit', {
        processesTerminated: true,
        processState: 'started-and-reaped'
      })
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  it('retries an incomplete WSL cleanup once before reporting the shell result', async () => {
    vi.stubEnv('OPEN_SCIENCE_ENABLE_WSL2_BASH', '1')
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'os-shell-wsl-cleanup-retry-'))
    const cleanup = vi
      .fn()
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: false,
        temporaryResourcesRemoved: false
      })
      .mockResolvedValueOnce({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("finished")'],
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        confirmProcessState: async () => 'started-and-reaped' as const,
        cleanup
      }))
    }

    try {
      await expect(
        runShellCommand({
          command: 'echo finished',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          processSandbox,
          previewAvailable,
          terminateTree: async () => ({ reaped: true })
        })
      ).resolves.toEqual({ stdout: 'finished', stderr: '', exitCode: 0 })
      expect(cleanup).toHaveBeenCalledTimes(2)
      expect(cleanup).toHaveBeenNthCalledWith(1, 'exit', {
        processesTerminated: true,
        processState: 'started-and-reaped'
      })
      expect(cleanup).toHaveBeenNthCalledWith(2, 'exit', {
        processesTerminated: true,
        processState: 'started-and-reaped'
      })
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true })
    }
  })

  it.each([true, false])(
    'retains WSL launch evidence until guest cleanup is proven after an identity race: %s',
    async (reaped) => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), 'open-science-wsl-identity-'))
      const registry = new ShellProcessOwnershipRegistry(runtimeRoot, {
        processStartIdentity: () => undefined
      })
      const launch = registry.beginLaunch({
        runId: 'short-wsl-command',
        projectId: 'project-1',
        sessionId: 'session-1',
        platform: 'win32'
      })
      const cleanup = vi.fn(async () => {
        expect(registry.hasReceipts()).toBe(true)
        return {
          processesTerminated: reaped,
          networkClosed: true,
          temporaryResourcesRemoved: reaped
        }
      })
      try {
        const result = await runShellCommand({
          command: 'printf finished',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'win32',
          runtimeBinding: {
            kind: 'wsl2-bash',
            profileId: 'profile-1',
            distro: 'Ubuntu',
            user: 'researcher'
          },
          previewAvailable: () => true,
          prepareProcessOwnership: () => launch,
          terminateTree: async () => ({ reaped: false }),
          processSandbox: {
            wrap: async () => ({
              executable: process.execPath,
              args: ['-e', 'process.stdout.write("finished")'],
              env: process.env,
              annotateStderr: (stderr) => stderr,
              cleanup
            })
          }
        })
        expect(result.stdout).toBe('finished')
        expect(result.exitCode).toBe(reaped ? 0 : null)
        expect(result.errorCode).toBe(reaped ? undefined : 'shell-cleanup-incomplete')
        expect(registry.hasReceipts()).toBe(!reaped)
        expect(cleanup).toHaveBeenCalled()
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true })
      }
    }
  )

  describe.runIf(process.platform !== 'win32')('process results', () => {
    let runtimeRoot: string
    beforeEach(async () => {
      runtimeRoot = await mkdtemp(join(tmpdir(), 'open-science-shell-process-'))
    })
    afterEach(async () => {
      await rm(runtimeRoot, { recursive: true, force: true })
    })

    it('settles a missing executable without an unhandled asynchronous spawn error', async () => {
      const registry = new ShellProcessOwnershipRegistry(runtimeRoot)
      const cleanup = vi.fn()
      const result = await runShellCommand({
        command: 'unused',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        prepareProcessOwnership: () =>
          registry.beginLaunch({
            runId: 'missing-executable',
            projectId: 'project-1',
            sessionId: 'session-1'
          }),
        processSandbox: {
          wrap: async (invocation) => ({
            executable: join(runtimeRoot, 'missing-executable'),
            args: [],
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup
          })
        }
      })
      expect(result.stderr).toContain('valid process identity')
      expect(registry.hasReceipts()).toBe(false)
      expect(cleanup).toHaveBeenCalledOnce()
    })

    it.each(['reaped', 'unreaped', 'rejected'] as const)(
      'preserves launch evidence until failed-claim cleanup is confirmed: %s',
      async (outcome) => {
        const registry = new ShellProcessOwnershipRegistry(runtimeRoot, {
          processStartIdentity: () => undefined
        })
        const launch = registry.beginLaunch({
          runId: 'failed-claim',
          projectId: 'project-1',
          sessionId: 'session-1'
        })
        const abort = vi.fn(launch.abort)
        const cleanup = vi.fn()
        const endExecution = vi.fn()
        const terminate = processTree.terminateProcessTree
        const spy = vi
          .spyOn(processTree, 'terminateProcessTree')
          .mockImplementation(async (child) => {
            expect(abort).not.toHaveBeenCalled()
            expect(registry.hasReceipts()).toBe(true)
            // Reap the real fixture even when simulating an unconfirmed termination result.
            await terminate(child)
            if (outcome === 'rejected') throw new Error('termination unavailable')
            return { reaped: outcome === 'reaped' }
          })
        try {
          const result = await runShellCommand({
            command: 'sleep 30',
            cwd: process.cwd(),
            handoffDir: process.cwd(),
            runtimeRoot,
            sessionId: 'session-1',
            projectId: 'project-1',
            prepareProcessOwnership: () => ({ claim: launch.claim, abort }),
            processSandbox: {
              wrap: async (invocation) => ({
                executable: invocation.executable,
                args: invocation.args,
                env: invocation.env,
                annotateStderr: (stderr) => stderr,
                beginExecution: () => endExecution,
                cleanup
              })
            }
          })
          expect(result.stderr).toContain('identity could not be confirmed')
          expect(abort).toHaveBeenCalledTimes(outcome === 'reaped' ? 1 : 0)
          expect(registry.hasReceipts()).toBe(outcome !== 'reaped')
          expect(cleanup).toHaveBeenCalledTimes(outcome === 'reaped' ? 1 : 0)
          expect(endExecution).toHaveBeenCalledOnce()
          expect(result).toHaveProperty(
            outcome === 'reaped' ? 'exitCode' : 'ownedTreeReaped',
            outcome === 'reaped' ? null : false
          )
        } finally {
          spy.mockRestore()
          launch.abort()
        }
      }
    )

    const execute = (
      command: string,
      timeoutMs = 5_000,
      signal?: AbortSignal
    ): ReturnType<typeof runShellCommand> =>
      runShellCommand({
        command,
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        timeoutMs,
        signal
      })

    it('exposes the authoritative native input root over an inherited override', async () => {
      const inputRoot = join(process.cwd(), '.open-science-test-inputs')
      const result = await runShellCommand({
        command: 'printf "$OPEN_SCIENCE_INPUT_DIR"',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        inputRoot,
        environment: {
          ...process.env,
          OPEN_SCIENCE_INPUT_DIR: '/untrusted/inherited-inputs'
        },
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux'
      })

      expect(result).toMatchObject({ stdout: inputRoot, exitCode: 0 })
    })

    it('does not retain an inherited input directory when no input root is available', async () => {
      const result = await runShellCommand({
        command: 'printf "${OPEN_SCIENCE_INPUT_DIR-unset}"',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        environment: {
          ...process.env,
          OPEN_SCIENCE_INPUT_DIR: '/stale/inherited-inputs'
        },
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux'
      })

      expect(result).toMatchObject({ stdout: 'unset', exitCode: 0 })
    })

    it('preserves stdout, stderr, and a non-zero exit code as one ordinary result', async () => {
      await expect(execute("printf 'visible'; printf 'warning' >&2; exit 7")).resolves.toEqual({
        stdout: 'visible',
        stderr: 'warning',
        exitCode: 7
      })
    })

    it('reaps a setsid helper that outlives the shell leader', async () => {
      const helperScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
      const parentScript = [
        "const {spawn}=require('node:child_process')",
        `const helper=spawn(process.execPath,['-e',${JSON.stringify(helperScript)}],{stdio:'ignore',detached:true})`,
        'helper.unref()',
        'process.stdout.write(String(helper.pid))'
      ].join(';')
      let helperPid: number | undefined

      try {
        const result = await execute(
          `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`
        )
        helperPid = Number(result.stdout)
        expect(result.exitCode).toBe(0)
        await vi.waitFor(() => expect(() => process.kill(helperPid as number, 0)).toThrow())
      } finally {
        if (helperPid) {
          try {
            process.kill(helperPid, 'SIGKILL')
          } catch {
            // Expected once the tracked setsid helper has been reaped.
          }
        }
      }
    }, 15_000)

    it('wraps Notebook Bash with the shared process sandbox', async () => {
      const inputRoot = join(process.cwd(), '.open-science-test-inputs')
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const endExecution = vi.fn()
      const beginExecution = vi.fn(() => endExecution)
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => {
          normalizeFilesystemLayout(invocation.filesystem)
          return {
            executable: invocation.executable,
            args: invocation.args,
            env: { OPEN_SCIENCE_SANDBOX_TEST: 'wrapped' },
            beginExecution,
            // Keep this wrapper contract independent of POSIX exit-tree inspection timing.
            // Real tree teardown and incomplete outcomes have separate coverage below.
            confirmProcessTreeTermination: async () => true,
            annotateStderr: (stderr: string) => stderr,
            cleanup
          }
        })
      }

      const result = await runShellCommand({
        command: 'printf "$OPEN_SCIENCE_SANDBOX_TEST"',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot,
        inputRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        processSandbox
      })

      expect(result.stderr).not.toContain('Sandbox filesystem path must be absolute')
      expect(result).toMatchObject({ stdout: 'wrapped', exitCode: 0 })

      expect(processSandbox.wrap).toHaveBeenCalledOnce()
      const [sandboxInvocation] = vi.mocked(processSandbox.wrap).mock.calls[0]
      expect(sandboxInvocation.env.OPEN_SCIENCE_INPUT_DIR).toBe(inputRoot)
      expect(sandboxInvocation.pathEnvironment?.OPEN_SCIENCE_INPUT_DIR).toBe(inputRoot)
      expect(sandboxInvocation.filesystem.readOnlyRoots).toContain(runtimeRoot)
      expect(sandboxInvocation.filesystem.readOnlyRoots).toContain(inputRoot)
      expect(sandboxInvocation.filesystem.readWriteRoots).toContain(
        join(runtimeRoot, 'cache', 'notebook')
      )
      expect(sandboxInvocation.filesystem.deniedWriteRoots).toContain(inputRoot)
      expect(sandboxInvocation.filesystem.deniedWriteRoots).not.toContain(runtimeRoot)
      expect(beginExecution).toHaveBeenCalledOnce()
      expect(endExecution).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('exit', {
        processesTerminated: true,
        processState: 'started-and-reaped'
      })
    })

    it('waits for exit-tree inspection and reports an incomplete outcome exactly', async () => {
      let releaseInspection: (() => void) | undefined
      const inspectionGate = new Promise<void>((resolve) => {
        releaseInspection = resolve
      })
      const terminateTree = vi.fn(async () => {
        await inspectionGate
        return { reaped: false }
      })
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      let completed = false

      const completion = runShellCommand({
        command: 'exit 0',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        processSandbox,
        terminateTree
      }).then((result) => {
        completed = true
        return result
      })

      await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      expect(cleanup).not.toHaveBeenCalled()
      releaseInspection?.()
      await expect(completion).resolves.toMatchObject({
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete'
      })
      expect(cleanup).toHaveBeenCalledWith('exit', {
        processesTerminated: false,
        confirmTermination: expect.any(Function),
        processState: 'termination-unknown'
      })
    })

    it.each([
      {
        name: 'timeout',
        command: 'sleep 5',
        timeoutMs: 25,
        reason: 'timeout' as const,
        cancel: false
      },
      {
        name: 'cancel',
        command: 'sleep 5',
        timeoutMs: 5_000,
        reason: 'cancel' as const,
        cancel: true
      }
    ])(
      'awaits one structured cleanup after $name',
      async ({ command, timeoutMs, reason, cancel }) => {
        const signal = cancel ? AbortSignal.timeout(25) : undefined
        const cleanup = vi.fn().mockResolvedValue({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
        const processSandbox: NotebookProcessSandbox = {
          wrap: vi.fn(async (invocation) => ({
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr: string) => stderr,
            cleanup
          }))
        }

        await runShellCommand({
          command,
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'linux',
          timeoutMs,
          signal,
          processSandbox
        })

        expect(cleanup).toHaveBeenCalledOnce()
        expect(cleanup).toHaveBeenCalledWith(reason, {
          processesTerminated: true,
          processState: 'started-and-reaped'
        })
      }
    )

    it.each([
      { name: 'successful reaping', reaped: true },
      { name: 'bounded reaping failure', reaped: false }
    ])('waits for $name before timeout cleanup completes', async ({ reaped }) => {
      let releaseReaping: (() => void) | undefined
      const reapingGate = new Promise<void>((resolve) => {
        releaseReaping = resolve
      })
      const terminateTree = vi.fn(async (child: ChildProcess) => {
        const actual = await terminateProcessTree(child)
        expect(actual).toEqual({ reaped: true })
        await reapingGate
        return { reaped }
      })
      const cleanup = vi.fn(async (_reason, processOutcome: { processesTerminated: boolean }) => ({
        processesTerminated: processOutcome.processesTerminated,
        networkClosed: true,
        temporaryResourcesRemoved: true
      }))
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }
      let completed = false

      const completion = runShellCommand({
        command: 'sleep 5',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        timeoutMs: 25,
        processSandbox,
        terminateTree
      }).then((result) => {
        completed = true
        return result
      })

      await vi.waitFor(() => expect(terminateTree).toHaveBeenCalledOnce())
      expect(completed).toBe(false)
      expect(cleanup).not.toHaveBeenCalled()
      releaseReaping?.()
      await expect(completion).resolves.toMatchObject({ exitCode: null })
      expect(cleanup).toHaveBeenCalledWith('timeout', {
        processesTerminated: reaped,
        processState: reaped ? 'started-and-reaped' : 'termination-unknown',
        ...(!reaped ? { confirmTermination: expect.any(Function) } : {})
      })
    })

    it('awaits one structured cleanup when process spawning fails', async () => {
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: join(process.cwd(), 'missing-sandbox-executable'),
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }

      await expect(
        runShellCommand({
          command: 'echo unreachable',
          cwd: process.cwd(),
          handoffDir: process.cwd(),
          runtimeRoot: portableRuntimeRoot,
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'linux',
          processSandbox
        })
      ).resolves.toMatchObject({ exitCode: null })

      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('spawn-failed', {
        processesTerminated: true,
        processState: 'never-started'
      })
    })

    it('reports bounded spawn-failure teardown failure without assuming termination', async () => {
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: false,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const processSandbox: NotebookProcessSandbox = {
        wrap: vi.fn(async (invocation) => ({
          executable: join(process.cwd(), 'missing-sandbox-executable'),
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr: string) => stderr,
          cleanup
        }))
      }

      await runShellCommand({
        command: 'echo unreachable',
        cwd: process.cwd(),
        handoffDir: process.cwd(),
        runtimeRoot: portableRuntimeRoot,
        sessionId: 'session-1',
        projectId: 'project-1',
        platform: 'linux',
        processSandbox,
        terminateTree: vi.fn(async () => ({ reaped: false }))
      })

      expect(cleanup).toHaveBeenCalledWith('spawn-failed', {
        processesTerminated: true,
        processState: 'never-started'
      })
    })

    it('reserves stderr capacity after stdout reaches its capture limit', async () => {
      const script = `process.stdout.write('x'.repeat(${NOTEBOOK_TEXT_LIMIT_BYTES + 1024})); process.stderr.write('diagnostic survives'); process.exitCode = 7`
      const result = await execute(
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
      )

      expect(result.exitCode).toBe(7)
      expect(result.stderr).toContain('diagnostic survives')
      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
      ).toBeLessThanOrEqual(NOTEBOOK_TEXT_LIMIT_BYTES)
      expect(result.truncated).toBe(true)
    })

    it('classifies a timeout with a null exit code and appends its diagnostic after stderr', async () => {
      await expect(execute("printf 'before timeout' >&2; sleep 5", 50)).resolves.toEqual({
        stdout: '',
        stderr: 'before timeout\nShell command timed out after 50ms and was killed.',
        exitCode: null
      })
    })

    it('does not spawn work for an already-aborted shell request', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(execute('echo should-not-run', 5_000, controller.signal)).resolves.toEqual({
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      })
    })

    it('does not settle cancellation until the complete POSIX process group is gone', async () => {
      const root = await mkdtemp(join(tmpdir(), 'shell-cancel-tree-'))
      const marker = randomUUID()
      const pidPath = join(root, `.shell-cancel-${marker}.pid`)
      const controller = new AbortController()
      const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
      try {
        const execution = runShellCommand({
          command: `${quote(process.execPath)} -e ${quote('setTimeout(() => {}, 30_000)')} & child=$!; printf '%s' "$child" > ${quote(pidPath)}; wait "$child"`,
          cwd: root,
          handoffDir: root,
          runtimeRoot: join(root, 'runtime'),
          sessionId: 'session-1',
          projectId: 'project-1',
          platform: 'linux',
          timeoutMs: 30_000,
          signal: controller.signal
        })
        let descendantPid: number | undefined
        await vi.waitFor(
          async () => {
            descendantPid = Number((await readFile(pidPath, 'utf8')).trim())
            expect(descendantPid).toBeGreaterThan(0)
          },
          { timeout: 5_000 }
        )

        controller.abort()
        await expect(execution).resolves.toMatchObject({ cancelled: true, exitCode: null })
        expect(() => process.kill(descendantPid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})

it.skipIf(process.platform === 'win32')(
  'injects private research bindings only at spawn and redacts live split output',
  async () => {
    const chunks: string[] = []
    const secret = 'fixture-private-value'
    const capability = createManagedShellExecutionCapability({
      projectId: 'project',
      sessionId: 'session',
      executionInvocationId: 'private-output',
      cwd: portableRuntimeRoot,
      environment: { HOME: portableRuntimeRoot, PATH: '/usr/bin:/bin' },
      privateEnvironment: { RESEARCH_API_KEY: secret },
      secretValues: [secret],
      confinement: { mode: 'research', allowedNetworkHosts: [] },
      filesystem: { readOnlyRoots: [], readWriteRoots: [portableRuntimeRoot] },
      onOutput: ({ text }) => chunks.push(text)
    })
    const wrap = vi.fn(async (invocation) => ({
      executable: invocation.executable,
      args: invocation.args,
      env: invocation.env,
      annotateStderr: (text: string) => text,
      cleanup: async () => ({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
    }))
    const result = await runShellCommand({
      projectId: 'project',
      sessionId: 'session',
      runId: 'private-run',
      executionInvocationId: 'private-output',
      managedExecution: capability,
      command: `printf '%s' "\${RESEARCH_API_KEY%value}"; sleep 0.05; printf 'value\\n'; printf '%s\\n' "$RESEARCH_API_KEY" >&2`,
      cwd: portableRuntimeRoot,
      handoffDir: portableRuntimeRoot,
      runtimeRoot: portableRuntimeRoot,
      processSandbox: { wrap },
      timeoutMs: 5000
    })
    expect(wrap.mock.calls[0]![0]).toMatchObject({
      env: { RESEARCH_API_KEY: secret },
      confinement: { mode: 'research', allowedNetworkHosts: [] }
    })
    expect(result).toMatchObject({ stdout: '[redacted]\n', stderr: '[redacted]\n', exitCode: 0 })
    expect(chunks.join('')).not.toContain(secret)
    expect(chunks.join('')).not.toContain('fixture-private-')
    wrap.mockRejectedValueOnce(new Error(`Preparation failed for ${secret}`))
    const failed = await runShellCommand({
      projectId: 'project',
      sessionId: 'session',
      executionInvocationId: 'private-output',
      managedExecution: capability,
      command: 'true',
      cwd: portableRuntimeRoot,
      handoffDir: portableRuntimeRoot,
      runtimeRoot: portableRuntimeRoot,
      processSandbox: { wrap },
      timeoutMs: 5000
    })
    expect(failed.stderr).toBe('Preparation failed for [redacted]')
  }
)

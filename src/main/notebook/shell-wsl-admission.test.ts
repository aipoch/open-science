import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import * as preview from '../wsl/wsl2-preview-gate'
import {
  createNotebookExecutionAdmission,
  type NotebookExecutionAdmission
} from './execution-admission'
import { MemoryPolicyService } from './memory-policy'
import * as wslMemory from './memory-policy-wsl'
import type { NotebookProcessSandbox } from './process-sandbox'
import { NotebookShellProcessAdapter } from './shell-process'
import type { NotebookShellProcessRequest, NotebookShellResult } from './shell-process-contract'

type ControlledCleanup = (
  reason: unknown,
  outcome: { processesTerminated: boolean }
) => Promise<{
  processesTerminated: boolean
  networkClosed: boolean
  temporaryResourcesRemoved: boolean
}>
type Harness = {
  root: string
  adapter: NotebookShellProcessAdapter
  cleanup: Mock<ControlledCleanup>
  factory: MockInstance<typeof wslMemory.createWslExecutionMemoryPolicy>
  policies: Map<string, MemoryPolicyService>
  rejected: Mock
  admission(force?: boolean): NotebookExecutionAdmission
  request: NotebookShellProcessRequest
  setAvailable(value: number): void
}

// Real local Bash executes the production read/eval frames and original POSIX
// cleanup. Guest/host policy facts are controlled; this is not a WSL OS test.
describe.skipIf(process.platform === 'win32')('WSL Shell owner memory admission', () => {
  const cleanups: Array<() => Promise<unknown>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    vi.restoreAllMocks()
  })

  const harness = async (missingFirstProbe = false): Promise<Harness> => {
    const root = await mkdtemp(join(tmpdir(), 'shell-wsl-admission-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    vi.spyOn(preview, 'wsl2BashPreviewStatus').mockReturnValue({
      available: true,
      reason: 'available'
    })
    let now = 0
    let availableBytes = 800
    let launches = 0
    const children = new Map<string, ChildProcess>()
    const cleanup = vi.fn(async (_reason, outcome: { processesTerminated: boolean }) => ({
      processesTerminated: outcome.processesTerminated,
      networkClosed: true,
      temporaryResourcesRemoved: true
    }))
    const policies = new Map<string, MemoryPolicyService>()
    const factory = vi
      .spyOn(wslMemory, 'createWslExecutionMemoryPolicy')
      .mockImplementation(async (probe) => {
        const policy = new MemoryPolicyService({
          now: () => now,
          wallNow: () => now,
          adapter: {
            platform: 'linux',
            defaultExecutionScope: probe.executionScope,
            sample: async () => ({
              platform: 'linux',
              source: 'controlled-guest-facts',
              executionScope: probe.executionScope,
              facts: { totalBytes: 1000, availableBytes, overcommitMode: 0 }
            })
          }
        })
        policies.set(probe.executionScope, policy)
        return policy
      })
    const sandbox: NotebookProcessSandbox = {
      wrap: async (invocation) => {
        const generation = ++launches
        return {
          executable: '/bin/bash',
          args: [...invocation.args],
          env: invocation.env,
          // Fixture commands use Bash builtins only. Confirm the exact original
          // handle exited; no Windows/WSL process-tree evidence is claimed.
          confirmProcessState: async () => {
            const child = children.get(invocation.sessionId)
            return child && (child.exitCode !== null || child.signalCode !== null)
              ? 'started-and-reaped'
              : 'termination-unknown'
          },
          ...(missingFirstProbe && generation === 1
            ? {}
            : {
                memoryProbe: {
                  executionScope: `wsl:controlled:${generation}`,
                  proofPath: '/unused-controlled-proof',
                  token: 'unused-controlled-token',
                  openReader: vi.fn()
                }
              }),
          annotateStderr: (stderr) => stderr,
          cleanup
        }
      }
    }
    const adapter = new NotebookShellProcessAdapter(process.platform, sandbox, {
      claim: (child, metadata) => {
        children.set(metadata.sessionId, child)
        return () => undefined
      }
    })
    cleanups.push(() => adapter.shutdown())
    const host = new MemoryPolicyService({
      now: () => now,
      wallNow: () => now,
      adapter: {
        platform: 'win32',
        sample: async () => ({
          platform: 'win32',
          executionScope: 'windows:host',
          source: 'controlled-host-facts',
          facts: {
            totalBytes: 1000,
            availableBytes: 800,
            commitLimitBytes: 1000,
            committedBytes: 100
          }
        })
      }
    })
    cleanups.push(async () => host.dispose())
    const rejected = vi.fn()
    const admission = (force = false): NotebookExecutionAdmission =>
      createNotebookExecutionAdmission({
        policy: async () => host,
        executionScope: 'windows:host',
        force,
        onRejected: rejected
      })
    const request = {
      command: '',
      projectId: 'controlled-project',
      runId: 'controlled-run',
      sessionId: 'first-session',
      cwd: root,
      handoffDir: root,
      runtimeRoot: join(root, 'runtime'),
      environment: { ...process.env },
      runtimeBinding: {
        kind: 'wsl2-bash' as const,
        profileId: 'controlled-profile',
        distro: 'controlled-distro',
        user: 'controlled-user'
      }
    }
    return {
      root,
      adapter,
      cleanup,
      factory,
      policies,
      rejected,
      admission,
      request,
      setAvailable: (value: number) => {
        availableBytes = value
        now += 3000
      }
    }
  }

  it('preserves a reused interpreter on guest refusal and releases only the selected session', async () => {
    const h = await harness()
    const execute = (
      command: string,
      force = false,
      sessionId = h.request.sessionId
    ): Promise<NotebookShellResult> =>
      h.adapter.execute({
        ...h.request,
        sessionId,
        command,
        executionAdmission: h.admission(force)
      })
    expect(await execute('kept=original; printf "%s" "$kept"')).toMatchObject({
      exitCode: 0,
      stdout: 'original'
    })
    expect(
      await execute('other=survives; printf "%s" "$other"', false, 'second-session')
    ).toMatchObject({ exitCode: 0, stdout: 'survives' })
    h.setAvailable(20)
    const refused = await execute('kept=must-not-run; printf bypass')
    expect(refused).toMatchObject({
      exitCode: 1,
      stdout: '',
      kernelDispatched: false,
      executionStarted: false
    })
    expect(refused.stderr).toContain('NOTEBOOK_MEMORY_PRESSURE')
    expect(h.rejected).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pressured',
        executionScope: 'wsl:controlled:1',
        source: 'controlled-guest-facts'
      })
    )
    expect(h.factory).toHaveBeenCalledTimes(2)
    h.setAvailable(800)
    expect(await execute('printf "%s" "$kept"', true)).toMatchObject({
      exitCode: 0,
      stdout: 'original'
    })
    expect(h.factory).toHaveBeenCalledTimes(2)
    expect(await h.adapter.shutdown({ sessionId: 'first-session' })).toEqual({ reaped: true })
    expect(h.adapter.resources().map((resource) => resource.sessionId)).toEqual(['second-session'])
    expect(await execute('printf "%s" "$other"', true, 'second-session')).toMatchObject({
      exitCode: 0,
      stdout: 'survives'
    })
    expect(await h.adapter.shutdown()).toEqual({ reaped: true })
    expect(h.adapter.resources()).toEqual([])
    expect(h.cleanup).toHaveBeenCalledTimes(2)
    for (const [, outcome] of h.cleanup.mock.calls) expect(outcome.processesTerminated).toBe(true)
  })

  it('joins cleanup before returning missing-capability refusal and allows a fresh explicit attempt', async () => {
    const h = await harness(true)
    const first = await h.adapter.execute({
      ...h.request,
      command: 'printf must-not-run',
      executionAdmission: h.admission()
    })
    expect(first).toMatchObject({
      exitCode: 1,
      stdout: '',
      kernelDispatched: false,
      executionStarted: false
    })
    expect(first.stderr).toContain('NOTEBOOK_MEMORY_UNAVAILABLE')
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.factory).not.toHaveBeenCalled()
    expect(
      await h.adapter.execute({
        ...h.request,
        command: 'printf fresh-attempt',
        executionAdmission: h.admission(true)
      })
    ).toMatchObject({ exitCode: 0, stdout: 'fresh-attempt' })
    expect(h.factory).toHaveBeenCalledTimes(1)
    expect(await h.adapter.shutdown()).toEqual({ reaped: true })
    expect(h.cleanup).toHaveBeenCalledTimes(2)
  })

  it('retains failed cleanup after a missing capability and fences reuse until original-owner recovery', async () => {
    const h = await harness(true)
    let verified = false
    h.cleanup.mockImplementation(async (_reason, outcome) => ({
      processesTerminated: verified && outcome.processesTerminated,
      networkClosed: true,
      temporaryResourcesRemoved: verified
    }))
    const execute = (): Promise<NotebookShellResult> =>
      h.adapter.execute({
        ...h.request,
        command: 'printf fresh-attempt',
        executionAdmission: h.admission(true)
      })
    const first = await execute()
    expect(first).toMatchObject({
      stdout: '',
      exitCode: null,
      ownedTreeReaped: false,
      errorCode: 'shell-cleanup-incomplete',
      recovery: { retryAfter: 'cleanup-verified' }
    })
    expect(h.adapter.resources()).toHaveLength(1)
    expect(h.adapter.resources()[0].phase).toBe('cleanup-pending')
    expect(h.factory).not.toHaveBeenCalled()
    expect(await execute()).toMatchObject({
      errorCode: 'shell-cleanup-incomplete',
      ownedTreeReaped: false
    })
    expect(h.factory).not.toHaveBeenCalled()
    verified = true
    expect(await h.adapter.shutdown()).toEqual({ reaped: true })
    expect(h.adapter.resources()).toEqual([])
    expect(await execute()).toMatchObject({ exitCode: 0, stdout: 'fresh-attempt' })
    expect(h.factory).toHaveBeenCalledOnce()
    expect(await h.adapter.shutdown()).toEqual({ reaped: true })
  })

  it('replaces the guest policy on context reset without chaining disposed execution authority', async () => {
    const h = await harness()
    expect(
      await h.adapter.execute({
        ...h.request,
        command: 'before_reset=old; printf initialized',
        executionAdmission: h.admission()
      })
    ).toMatchObject({ exitCode: 0, stdout: 'initialized' })
    const oldPolicy = h.policies.get('wsl:controlled:1')!
    const nextHandoff = join(h.root, 'next-handoff')
    await mkdir(nextHandoff)
    const reset = await h.adapter.execute({
      ...h.request,
      handoffDir: nextHandoff,
      command: 'printf "%s" "${before_reset-UNSET}"',
      executionAdmission: h.admission()
    })
    expect(reset, JSON.stringify(reset)).toMatchObject({ exitCode: 0, stdout: 'UNSET' })
    expect(h.factory).toHaveBeenCalledTimes(2)
    expect(oldPolicy.currentState().reason.code).toBe('disposed')
    expect(h.adapter.memoryPolicy('wsl:controlled:1')).toBeUndefined()
    expect(h.adapter.memoryPolicy('wsl:controlled:2')).toBe(h.policies.get('wsl:controlled:2'))
    expect(await h.adapter.shutdown()).toEqual({ reaped: true })
    expect(h.cleanup).toHaveBeenCalledTimes(2)
  })
})

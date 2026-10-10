import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotebookRuntimeService } from './runtime-service'
import { getNotebookRunJsonPath, NotebookRunRepository } from './repository'
import {
  createManagedShellExecutionCapability,
  type ManagedShellExecutionCapability
} from './managed-shell-execution'
import type { NotebookSandboxInvocation, NotebookProcessSandbox } from './process-sandbox'
import type { ExecuteShellRequest } from '../../shared/notebook'

describe.skipIf(process.platform === 'win32')(
  'managed Shell in the shared Notebook runtime',
  () => {
    let root: string
    let workspace: string
    let managedCwd: string
    let inputRoot: string
    let service: NotebookRuntimeService
    let repository: NotebookRunRepository
    let invocations: NotebookSandboxInvocation[]
    let cleanupVerified: boolean
    const identity = {
      projectId: 'project',
      sessionId: 'session',
      executionInvocationId: 'managed-call'
    }
    const request = (command = 'pwd'): ExecuteShellRequest => ({
      ...identity,
      workspaceCwd: workspace,
      command
    })
    const capability = (
      overrides: Partial<Parameters<typeof createManagedShellExecutionCapability>[0]> = {}
    ): ManagedShellExecutionCapability =>
      createManagedShellExecutionCapability({
        ...identity,
        cwd: managedCwd,
        environment: { HOME: managedCwd, PATH: '/usr/bin:/bin', FIXTURE_VALUE: 'bounded' },
        filesystem: { readOnlyRoots: [inputRoot], readWriteRoots: [managedCwd] },
        ...overrides
      })

    beforeEach(async () => {
      root = realpathSync(await mkdtemp(join(tmpdir(), 'os-managed-shell-')))
      workspace = join(root, 'ordinary')
      managedCwd = join(root, 'managed')
      inputRoot = join(root, 'input')
      await Promise.all([workspace, managedCwd, inputRoot].map((path) => mkdir(path)))
      invocations = []
      cleanupVerified = true
      const sandbox: NotebookProcessSandbox = {
        wrap: async (invocation) => {
          invocations.push(invocation)
          return {
            executable: invocation.executable,
            args: invocation.args,
            env: invocation.env,
            annotateStderr: (stderr) => stderr,
            cleanup: async () => ({
              processesTerminated: true,
              networkClosed: invocation.cwd !== managedCwd || cleanupVerified,
              temporaryResourcesRemoved: invocation.cwd !== managedCwd || cleanupVerified
            })
          }
        }
      }
      repository = new NotebookRunRepository(root)
      service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: identity.projectId,
        repository,
        processSandbox: sandbox,
        shellConcurrencyLimit: 1,
        shellBackgroundExecutionEnabled: true,
        executorFactory: () => ({ execute: vi.fn(), shutdown: async () => ({ reaped: true }) })
      })
      await service.recoverInterruptedOperations()
    })

    afterEach(async () => {
      vi.unstubAllEnvs()
      expect(await service.shutdownAll()).toMatchObject({ reaped: true })
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    })

    it('keeps ordinary persistent state while using exact managed env, cwd and write grants', async () => {
      vi.stubEnv('FIXTURE_HOST_SECRET', 'must-not-inherit')
      await service.executeShell({
        ...request('export ORDINARY_FIXTURE=persistent'),
        executionInvocationId: 'ordinary-1'
      })
      const bounded = await service.executeManagedShell(
        request(
          'printf "%s:%s:%s\\n" "$FIXTURE_VALUE" "${ORDINARY_FIXTURE-unset}" "${FIXTURE_HOST_SECRET-unset}"; pwd; echo result > result.txt'
        ),
        capability()
      )
      expect(bounded.exitCode).toBe(0)
      expect(bounded.stdout).toContain('bounded:unset:unset')
      expect(bounded.stdout).toContain(managedCwd)
      expect(await readFile(join(managedCwd, 'result.txt'), 'utf8')).toBe('result\n')
      const managed = invocations.find((value) => value.cwd === managedCwd)!
      expect(managed.filesystem.readWriteRoots).toEqual([managedCwd])
      expect(managed.filesystem.readOnlyRoots).toContain(inputRoot)
      expect(managed.filesystem.deniedWriteRoots).toContain(inputRoot)
      expect(managed.env).not.toHaveProperty('NPM_CONFIG_PREFIX')
      expect(managed.filesystem.readWriteRoots).not.toContain(workspace)
      const ordinary = await service.executeShell({
        ...request('printf "%s\\n" "$ORDINARY_FIXTURE"; pwd'),
        executionInvocationId: 'ordinary-2'
      })
      expect(ordinary.stdout).toContain('persistent')
      expect(ordinary.stdout).toContain(
        join(root, 'notebooks', identity.projectId, identity.sessionId, 'data')
      )
      const runs = await repository.readSessionRuns(identity.projectId, identity.sessionId)
      expect(runs).toHaveLength(3)
      expect(
        runs.find((run) => run.submissionIdentity === identity.executionInvocationId)?.cwdBefore
      ).toBe(managedCwd)
    })

    it('admits the documented quoted managed runtime without granting ordinary environment authority', async () => {
      const script = join(inputRoot, 'managed entry.mjs')
      await writeFile(script, 'console.log("managed runtime executed")\n')
      const command = '"$OPEN_SCIENCE_NODE" "$OPEN_SCIENCE_INPUT_DIR/managed entry.mjs"'
      const result = await service.executeManagedShell(
        request(command),
        capability({
          environment: {
            HOME: managedCwd,
            PATH: '/usr/bin:/bin',
            OPEN_SCIENCE_NODE: process.execPath,
            OPEN_SCIENCE_INPUT_DIR: inputRoot,
            OPEN_SCIENCE_OUTPUT_DIR: managedCwd
          }
        })
      )
      expect(result).toMatchObject({ exitCode: 0, stdout: 'managed runtime executed\n' })
      expect(invocations).toHaveLength(1)
      expect(invocations[0].filesystem.readOnlyRoots).toContain(inputRoot)
      expect(invocations[0].filesystem.deniedWriteRoots).toContain(inputRoot)

      vi.stubEnv('OPEN_SCIENCE_NODE', process.execPath)
      vi.stubEnv('OPEN_SCIENCE_INPUT_DIR', inputRoot)
      const ordinary = await service.executeShell({
        ...request(command),
        executionInvocationId: 'ordinary-untrusted-runtime'
      })
      expect(ordinary).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining('the command name cannot be resolved')
      })
      expect(invocations).toHaveLength(1)
    })

    it.each([
      'OPEN_SCIENCE_NODE=find; "$OPEN_SCIENCE_NODE" /',
      'OPEN_SCIENCE_NODE=/bin/ls sh -c \'"$OPEN_SCIENCE_NODE" /\'',
      'env OPEN_SCIENCE_NODE=/bin/ls sh -c \'"$OPEN_SCIENCE_NODE" /\'',
      'env -i sh -c \'"$OPEN_SCIENCE_NODE" /\'',
      'find "$OPEN_SCIENCE_INPUT_DIR"',
      '"$UNTRUSTED_EXECUTABLE" /',
      '"$PRIVATE_EXECUTABLE" /'
    ])('retains fail-closed managed search admission for %s', async (command) => {
      const result = await service.executeManagedShell(
        request(command),
        capability({
          environment: {
            HOME: managedCwd,
            PATH: '/usr/bin:/bin',
            OPEN_SCIENCE_NODE: process.execPath,
            OPEN_SCIENCE_INPUT_DIR: inputRoot,
            OPEN_SCIENCE_OUTPUT_DIR: managedCwd,
            UNTRUSTED_EXECUTABLE: 'find'
          },
          privateEnvironment: { PRIVATE_EXECUTABLE: 'find' }
        })
      )
      expect(result).toMatchObject({
        exitCode: null,
        stderr: expect.stringContaining('Shell search scope denied:')
      })
      expect(invocations).toHaveLength(0)
    })

    it('replays durable requests and rejects changed authority or a forged capability before launch', async () => {
      const input = request('echo once >> count.txt')
      const policy = capability()
      await service.executeManagedShell(input, policy)
      await service.executeManagedShell(input, capability())
      expect(await readFile(join(managedCwd, 'count.txt'), 'utf8')).toBe('once\n')
      expect(invocations).toHaveLength(1)
      await expect(
        service.executeManagedShell(input, capability({ fingerprint: 'changed-material' }))
      ).rejects.toThrow('NOTEBOOK_RUN_SUBMISSION_CONFLICT')
      await expect(
        service.executeManagedShell(input, {} as ManagedShellExecutionCapability)
      ).rejects.toThrow('does not belong')
      await expect(
        service.executeManagedShell({ ...input, sessionId: 'different' }, policy)
      ).rejects.toThrow('does not belong')
      expect(invocations).toHaveLength(1)
      expect(await repository.readSessionRuns(identity.projectId, identity.sessionId)).toHaveLength(
        1
      )
    })

    it.skipIf(process.platform !== 'darwin')(
      'prepares local resources after admission and terminalizes allocation failures',
      async () => {
        let observedRunId: string | undefined
        const prepareSocket = vi.fn(async ({ runId }: { runId: string }) => {
          observedRunId = runId
          const runs = await repository.readSessionRuns(identity.projectId, identity.sessionId)
          expect(runs.some((run) => run.runId === runId && run.status === 'running')).toBe(true)
          throw new Error('fixture resource allocation failed')
        })
        const policy = capability({ localService: { logicalPort: 9876, prepareSocket } })
        const result = await service.executeManagedShell(request(), policy)
        expect(result.stderr).toContain('fixture resource allocation failed')
        expect(invocations).toHaveLength(0)
        const [run] = await repository.readSessionRuns(identity.projectId, identity.sessionId)
        expect(run.runId).toBe(observedRunId)
        expect(run.status).toBe('failed')
        expect(run.shellErrorCode).toBe('shell-runtime-unavailable')
        expect(run.endedAt).toBeDefined()
        expect(run.frozenShellContext?.environment).not.toHaveProperty(
          'OPEN_SCIENCE_SERVICE_SOCKET'
        )
        await service.executeManagedShell(request(), policy)
        expect(prepareSocket).toHaveBeenCalledOnce()
      }
    )

    it('cancels a managed background Run through its environment lifetime without closing ordinary Shell', async () => {
      await service.executeShell({
        ...request('export ORDINARY_FIXTURE=retained'),
        executionInvocationId: 'ordinary'
      })
      const lifetime = new AbortController()
      const receipt = await service.executeManagedShellBackground(
        request('echo ready; while :; do sleep 1; done'),
        capability({ signal: lifetime.signal })
      )
      await vi.waitFor(() =>
        expect(invocations.some((value) => value.executionReference === receipt.runId)).toBe(true)
      )
      lifetime.abort()
      await vi.waitFor(
        async () => {
          const run = (
            await repository.readSessionRuns(identity.projectId, identity.sessionId)
          ).find((value) => value.runId === receipt.runId)
          expect(run?.status).toBe('cancelled')
        },
        { timeout: 10_000 }
      )
      const ordinary = await service.executeShell({
        ...request('echo "$ORDINARY_FIXTURE"'),
        executionInvocationId: 'ordinary-again'
      })
      expect(ordinary.stdout).toContain('retained')
    })

    it('returns cancellation for a queued managed invocation and its retry without dispatching it', async () => {
      const blockerLifetime = new AbortController()
      const queuedLifetime = new AbortController()
      const blocker = service.executeManagedShell(
        request('echo blocker; while :; do sleep 1; done'),
        capability({ signal: blockerLifetime.signal })
      )
      const queuedIdentity = { ...identity, executionInvocationId: 'queued-managed-call' }
      const queuedRequest = { ...request('echo must-not-run'), ...queuedIdentity }
      const queuedPolicy = capability({ ...queuedIdentity, signal: queuedLifetime.signal })
      try {
        await vi.waitFor(() => expect(invocations).toHaveLength(1))
        const queued = service.executeManagedShell(queuedRequest, queuedPolicy)
        await vi.waitFor(async () => {
          const runs = await repository.readSessionRuns(identity.projectId, identity.sessionId)
          expect(
            runs.find((run) => run.submissionIdentity === queuedIdentity.executionInvocationId)
          ).toMatchObject({ status: 'queued' })
        })
        queuedLifetime.abort()
        await expect(queued).resolves.toMatchObject({ cancelled: true, exitCode: null })
        await expect(
          service.executeManagedShell(queuedRequest, capability(queuedIdentity))
        ).resolves.toMatchObject({
          cancelled: true,
          exitCode: null
        })
        expect(invocations).toHaveLength(1)
        expect(await service.confirmManagedShellCleanup(queuedIdentity)).toMatchObject({
          scope: queuedIdentity,
          state: 'verified',
          reaped: true
        })
      } finally {
        queuedLifetime.abort()
        blockerLifetime.abort()
        await expect(blocker).resolves.toMatchObject({ cancelled: true, exitCode: null })
      }
    })

    it('cancels only the exact admitted managed Run from Replay and preserves ordinary Shell', async () => {
      await service.executeShell({
        ...request('export RETAINED=replay-safe'),
        executionInvocationId: 'ordinary'
      })
      const lifetime = new AbortController()
      const execution = service.executeManagedShell(
        request('echo observing; while :; do sleep 1; done'),
        capability({ signal: lifetime.signal })
      )
      try {
        let runId = ''
        await vi.waitFor(async () => {
          const runs = await repository.readSessionRuns(identity.projectId, identity.sessionId)
          const run = runs.find((row) => row.submissionIdentity === identity.executionInvocationId)
          expect(run?.status).toBe('running')
          runId = run!.runId
        })
        await expect(
          service.cancelManagedShellRun({ ...identity, runId: 'foreign-run' })
        ).rejects.toThrow('unavailable')
        await expect(
          service.cancelManagedShellRun({ ...identity, sessionId: 'foreign-session', runId })
        ).rejects.toThrow('unavailable')
        await service.cancelManagedShellRun({ ...identity, runId })
        await expect(execution).resolves.toMatchObject({ cancelled: true })
        const runs = await repository.readSessionRuns(identity.projectId, identity.sessionId)
        expect(runs.find((row) => row.runId === runId)?.status).toBe('cancelled')
        const ordinary = await service.executeShell({
          ...request('printf "$RETAINED"'),
          executionInvocationId: 'ordinary-check'
        })
        expect(ordinary.stdout).toContain('replay-safe')
      } finally {
        lifetime.abort()
        await execution
      }
    })

    it('returns exact Run cleanup proof and retries its original owner without closing persistent Shell', async () => {
      await service.executeShell({
        ...request('export RETAINED=original'),
        executionInvocationId: 'persistent'
      })
      cleanupVerified = false
      try {
        const result = await service.executeManagedShell(request('echo managed'), capability())
        expect(result.errorCode).toBe('shell-cleanup-incomplete')
        expect(await service.confirmManagedShellCleanup(identity)).toMatchObject({
          state: 'cleanup-pending',
          reaped: false
        })
        expect(await service.confirmManagedShellCleanup(identity, { retry: true })).toMatchObject({
          state: 'cleanup-pending',
          reaped: false
        })
        cleanupVerified = true
        const proof = await service.confirmManagedShellCleanup(identity, { retry: true })
        expect(proof).toMatchObject({
          scope: identity,
          state: 'verified',
          reaped: true,
          proof: 'process-owner'
        })
        expect(proof.runId).toBe(
          (await repository.readSessionRuns(identity.projectId, identity.sessionId)).find(
            (run) => run.submissionIdentity === identity.executionInvocationId
          )?.runId
        )
        expect(await service.confirmManagedShellCleanup(identity)).toEqual(proof)
        expect(
          (
            await service.executeShell({
              ...request('echo "$RETAINED"'),
              executionInvocationId: 'persistent-after'
            })
          ).stdout
        ).toContain('original')
        await expect(service.executeManagedShell(request(), capability())).rejects.toThrow(
          'retired'
        )
      } finally {
        cleanupVerified = true
      }
    })

    it('refuses proof during live work and verifies only after the original process settles', async () => {
      const lifetime = new AbortController()
      const receipt = await service.executeManagedShellBackground(
        request('while :; do sleep 1; done'),
        capability({ signal: lifetime.signal })
      )
      await vi.waitFor(() =>
        expect(invocations.some((value) => value.executionReference === receipt.runId)).toBe(true)
      )
      expect(await service.confirmManagedShellCleanup(identity, { retry: true })).toMatchObject({
        state: 'running',
        reaped: false
      })
      lifetime.abort()
      await vi.waitFor(
        async () =>
          expect(await service.confirmManagedShellCleanup(identity, { retry: true })).toMatchObject(
            { runId: receipt.runId, state: 'verified', reaped: true }
          ),
        { timeout: 10_000 }
      )
    })

    it('retires an intent that never reached Notebook, preventing late admission', async () => {
      expect(await service.confirmManagedShellCleanup(identity)).toEqual({
        scope: identity,
        state: 'verified',
        reaped: true,
        proof: 'never-dispatched'
      })
      await expect(service.executeManagedShell(request(), capability())).rejects.toThrow('retired')
      await expect(service.executeShell(request())).rejects.toThrow('retired')
      expect(invocations).toHaveLength(0)
    })

    it('never treats a current ordinary persistent Run as startup cleanup proof', async () => {
      await service.executeShell(request('export RETAINED=ordinary'))
      expect(await service.confirmManagedShellCleanup(identity)).toMatchObject({
        state: 'unknown',
        reaped: false
      })
      expect(
        (
          await service.executeShell({
            ...request('echo "$RETAINED"'),
            executionInvocationId: 'later'
          })
        ).stdout
      ).toContain('ordinary')
    })

    it('requires successful startup recovery before proving a previous generation stopped', async () => {
      await service.executeManagedShell(request(), capability())
      const [run] = await repository.readSessionRuns(identity.projectId, identity.sessionId)
      expect(await service.shutdownAll()).toMatchObject({ reaped: true })
      await service.dispose()
      service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: identity.projectId,
        repository: new NotebookRunRepository(root)
      })
      expect(await service.confirmManagedShellCleanup(identity)).toMatchObject({
        state: 'unknown',
        reaped: false
      })
      await service.recoverInterruptedOperations()
      expect(await service.confirmManagedShellCleanup(identity)).toMatchObject({
        runId: run.runId,
        state: 'verified',
        reaped: true,
        proof: 'startup-recovery'
      })
    })

    it('fails closed on unreadable history instead of certifying a missing submission', async () => {
      await service.state(request())
      const path = getNotebookRunJsonPath(root, identity.projectId, identity.sessionId)
      const contents = await readFile(path)
      try {
        await writeFile(path, '{broken')
        expect(await service.confirmManagedShellCleanup(identity)).toMatchObject({
          state: 'unknown',
          reaped: false
        })
      } finally {
        await writeFile(path, contents)
      }
    })
  }
)

;(await import('../../../test/runtime-metadata')).configureTestRuntimeMetadata()

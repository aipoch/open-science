import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { terminateProcessTree } from '../process-tree'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookShellProcessAdapter } from './shell-process'
import { releaseNotebookResources } from './owned-resources'

describe('Notebook original resource ownership', () => {
  it.skipIf(process.platform === 'win32')(
    'cancels an active run through its pinned tree handle',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'notebook-owned-active-'))
      const executor = new NotebookKernelExecutor({
        replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js')
      })
      const run = executor.execute({
        cwd,
        notebookSessionRoot: cwd,
        dataRoot: cwd,
        runtimeRoot: join(cwd, 'runtime'),
        kind: 'repl',
        code: 'await new Promise(() => {})'
      })
      try {
        await vi.waitFor(() => expect(executor.resources()[0]?.phase).toBe('running'))
        const [active] = executor.resources()
        await expect(active.release()).resolves.toMatchObject({ reaped: true })
        await expect(run).resolves.toMatchObject({ status: 'cancelled' })
        expect(executor.resources()).toEqual([])
      } finally {
        await executor.shutdown()
        await run
        await rm(cwd, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps failed Shell cleanup visible while releasing other original sessions',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'notebook-owned-shell-'))
      let cleanupAvailable = false
      const shell = new NotebookShellProcessAdapter(process.platform, {
        wrap: async (invocation) => ({
          ...invocation,
          annotateStderr: (stderr) => stderr,
          cleanup: async (_reason, outcome) => ({
            processesTerminated: outcome.processesTerminated,
            networkClosed: invocation.sessionId === 'other' || cleanupAvailable,
            temporaryResourcesRemoved: true
          })
        })
      })
      const request = {
        cwd,
        handoffDir: cwd,
        runtimeRoot: join(cwd, 'runtime'),
        projectId: 'project',
        runtimeBinding: { kind: 'native-posix' as const, shell: '/bin/bash' },
        command: 'retained_value=hello; printf ready'
      }
      try {
        await expect(shell.execute({ ...request, sessionId: 'failed' })).resolves.toMatchObject({
          exitCode: 0,
          stdout: 'ready'
        })
        await expect(shell.execute({ ...request, sessionId: 'other' })).resolves.toMatchObject({
          exitCode: 0
        })
        const resources = shell.resources()
        const outcomes = await releaseNotebookResources(resources)
        expect(outcomes.map(({ resource, result }) => [resource.sessionId, result.reaped])).toEqual(
          [
            ['failed', false],
            ['other', true]
          ]
        )
        const [failed] = shell.resources()
        expect(failed).toMatchObject({
          identity: resources[0].identity,
          projectId: 'project',
          sessionId: 'failed',
          group: 'shell',
          phase: 'cleanup-pending',
          startedAt: expect.any(Number)
        })
        cleanupAvailable = true
        await expect(failed.release()).resolves.toMatchObject({ reaped: true })
        expect(shell.resources()).toEqual([])
      } finally {
        cleanupAvailable = true
        await shell.shutdown()
        await rm(cwd, { recursive: true, force: true })
      }
    }
  )

  it.each(['handle', 'shutdown'] as const)(
    'exposes and cancels the original startup through %s before a kernel is installed',
    async (releaseThrough) => {
      const cwd = await mkdtemp(join(tmpdir(), 'notebook-owned-start-'))
      const entered = Promise.withResolvers<void>()
      const continuePreparation = Promise.withResolvers<void>()
      const executor = new NotebookKernelExecutor({
        processSandbox: {
          // This fake cancels before spawn; it does not need the protected Windows runtime.
          resolveWindowsRuntime: async () => null,
          wrap: async (invocation) => {
            entered.resolve()
            await continuePreparation.promise
            return {
              ...invocation,
              annotateStderr: (stderr) => stderr,
              cleanup: async (_reason, outcome) => ({
                processesTerminated: outcome.processesTerminated,
                networkClosed: true,
                temporaryResourcesRemoved: true
              })
            }
          }
        }
      })
      const execution = executor.execute({
        cwd,
        notebookSessionRoot: cwd,
        runtimeRoot: join(cwd, 'runtime'),
        dataRoot: cwd,
        kind: 'repl',
        code: 'console.log("must not run")',
        projectId: 'project',
        sessionId: 'session'
      })
      try {
        // Fail with the actual early result when runtime preparation prevents reaching the seam.
        expect(await Promise.race([entered.promise.then(() => 'preparing'), execution])).toBe(
          'preparing'
        )
        const [starting] = executor.resources()
        expect(starting).toMatchObject({ group: 'kernel', phase: 'starting', kind: 'repl' })
        const released = releaseThrough === 'handle' ? starting.release() : executor.shutdown()
        continuePreparation.resolve()
        await expect(released).resolves.toMatchObject({ reaped: true })
        await expect(execution).resolves.toMatchObject({ status: 'cancelled' })
        expect(executor.resources()).toEqual([])
      } finally {
        continuePreparation.resolve()
        await execution
        await executor.shutdown()
        await rm(cwd, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'retains an unconfirmed tree and retries the original handle without stopping its successor',
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'notebook-owned-tree-'))
      let proofAvailable = false
      const executor = new NotebookKernelExecutor({
        replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
        terminateTree: async (child) => {
          await terminateProcessTree(child)
          return { reaped: proofAvailable }
        }
      })
      const request = {
        cwd,
        notebookSessionRoot: join(cwd, 'nb'),
        inputRoot: join(cwd, 'inputs'),
        dataRoot: join(cwd, 'nb', 'data'),
        runtimeRoot: join(cwd, 'runtime'),
        kind: 'repl' as const,
        projectId: 'project',
        sessionId: 'session',
        kernelEpochId: 'original-epoch'
      }
      try {
        await expect(executor.execute({ ...request, code: 'return 42' })).resolves.toMatchObject({
          status: 'completed'
        })
        const [original] = executor.resources()
        expect(original).toMatchObject({
          group: 'kernel',
          kind: 'repl',
          processKey: 'repl',
          phase: 'idle',
          kernelEpochId: 'original-epoch',
          startedAt: expect.any(Number)
        })
        await expect(original.release()).resolves.toMatchObject({ reaped: false })
        expect(executor.resources()).toEqual([
          expect.objectContaining({ identity: original.identity, phase: 'cleanup-pending' })
        ])
        proofAvailable = true
        await expect(original.release()).resolves.toMatchObject({
          reaped: true,
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true
        })
        expect(executor.resources()).toEqual([])
        await executor.execute({
          ...request,
          kernelEpochId: 'successor',
          code: 'globalThis.value = 73'
        })
        await expect(original.release()).resolves.toMatchObject({ reaped: true })
        await expect(
          executor.execute({ ...request, code: 'console.log(value)' })
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining('73')
        })
      } finally {
        proofAvailable = true
        await executor.shutdown()
        await rm(cwd, { recursive: true, force: true })
      }
    }
  )
})

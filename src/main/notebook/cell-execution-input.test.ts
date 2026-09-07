import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookRunRepository } from './repository'
import {
  NotebookRuntimeService,
  type NotebookExecutionRequest,
  type NotebookExecutionResult
} from './runtime-service'
import { NotebookSessionAggregate } from './session-aggregate'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let root: string
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('cell execution input', () => {
  it.each(['queue', 'persistence', 'environment preparation', 'executor'] as const)(
    'protects submitted code while blocked at %s',
    async (blockedAt) => {
      root = await mkdtemp(join(tmpdir(), 'notebook-cell-input-'))
      const request = { sessionId: 'session-1', workspaceCwd: root }
      const repository = new NotebookRunRepository(root)
      const entered = deferred()
      const release = deferred()
      const hold = async (): Promise<void> => {
        entered.resolve()
        await release.promise
      }
      const executions: NotebookExecutionRequest[] = []
      if (blockedAt === 'persistence') {
        const appendRun = repository.appendRun.bind(repository)
        vi.spyOn(repository, 'appendRun').mockImplementation(async (...args) => {
          await hold()
          return appendRun(...args)
        })
      }
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository,
        environmentStateTracker: {
          prepareRun: vi.fn(async () => {
            if (blockedAt === 'environment preparation') await hold()
            return { fingerprint: 'stable', inventoryRefreshed: false, warnings: [] }
          }),
          captureCompletedRun: vi.fn().mockRejectedValue(new Error('capture unavailable')),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn(),
          refreshAfterPackageMutation: vi.fn()
        },
        executorFactory: () => ({
          execute: async (input): Promise<NotebookExecutionResult> => {
            executions.push(input)
            if (blockedAt === 'executor' || (blockedAt === 'queue' && executions.length === 1)) {
              await hold()
            }
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: input.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      const begin = await service.beginCodeCell(request)
      const cellRequest = { ...request, cellId: begin.cellId }
      const originalCode = 'print("original complete code")'
      await service.appendCodeCell({ ...cellRequest, writeId: begin.writeId, delta: originalCode })
      await service.finishCodeCell({ ...cellRequest, writeId: begin.writeId })

      const first =
        blockedAt === 'queue' ? service.execute({ ...request, code: 'print("A")' }) : undefined
      if (first) await entered.promise
      // Queued cells have no public queued status. Observe the existing queue entry without
      // replacing its behavior; all writes, runs, and result assertions use the runtime API.
      const enqueue = vi.spyOn(NotebookSessionAggregate.prototype, 'enqueueExecution')
      const submitted = { ...cellRequest, timeoutMs: 1234 }
      const running = service.runCell(submitted)
      let rewriteError: unknown
      try {
        if (first) {
          await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce())
          const cancellation = new AbortController()
          const duplicate = service.runCell(cellRequest, cancellation.signal)
          await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2))
          cancellation.abort()
          await expect(duplicate).rejects.toBe(cancellation.signal.reason)
          // Cancelling one submission must not release the other submission's write restriction.
        } else await entered.promise
        try {
          const rewrite = await service.beginCodeCell(cellRequest)
          await service.appendCodeCell({
            ...cellRequest,
            writeId: rewrite.writeId,
            delta: 'print("partial new code'
          })
          // Deliberately do not finish this stream before execution resumes.
        } catch (error) {
          rewriteError = error
        }
        submitted.timeoutMs = 9999
      } finally {
        release.resolve()
      }
      const [run] = await Promise.all([running, first])
      const dispatched = executions.at(-1)!
      expect.soft(dispatched.code).toBe(originalCode)
      expect.soft(dispatched.language).toBe('python')
      expect.soft(run.script).toBe(dispatched.code)
      expect.soft(dispatched.timeoutMs).toBe(1234)
      const state = await service.state(request)
      expect.soft(state.activeWrite).toBeUndefined()
      expect.soft(state.cells.find((cell) => cell.id === begin.cellId)).toMatchObject({
        code: originalCode,
        status: 'completed'
      })
      expect(rewriteError).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/queued or running/) })
      )
      // The restriction lasts only for this execution; the same cell becomes editable again.
      const rewrite = await service.beginCodeCell(cellRequest)
      await service.finishCodeCell({ ...cellRequest, writeId: rewrite.writeId })
    }
  )
})

import { expect, it, vi } from 'vitest'
import {
  NotebookSessionLifecycleOwner,
  type NotebookSessionLifecycleOptions
} from './session-lifecycle'
import { NotebookSessionRegistry } from './session-registry'
import { createRootNotebookLane } from './lane-identity'
import type { NotebookSessionAggregate } from './session-aggregate'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(): { owner: NotebookSessionLifecycleOwner; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn(async () => undefined)
  const owner = new NotebookSessionLifecycleOwner({
    defaultProjectId: 'project',
    sessions: new NotebookSessionRegistry(),
    shellExecution: { fenceShellRuns: () => () => undefined, cancelShellRuns: cancel }
  } as unknown as NotebookSessionLifecycleOptions)
  return { owner, cancel }
}

const request = { projectId: 'project', sessionId: 'session', workspaceCwd: '/managed/provider' }

it('aborts and drains active work, blocks new work through the binding commit, then releases only relocation', async () => {
  const { owner } = fixture()
  const stopped = deferred()
  const commit = deferred()
  const running = owner.runProjectOperation(
    request,
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            stopped.resolve()
            resolve()
          },
          { once: true }
        )
      })
  )
  const relocating = owner.withProjectFolderRelocation('project', async () => {
    await commit.promise
    return 'new binding'
  })
  await stopped.promise
  await running
  await expect(owner.runProjectOperation(request, async () => undefined)).rejects.toThrow(
    'relocated'
  )
  await expect(
    owner.runProjectOperation({ ...request, projectId: 'other' }, async () => 'other')
  ).resolves.toBe('other')
  commit.resolve()
  await expect(relocating).resolves.toBe('new binding')
  await expect(owner.runProjectOperation(request, async () => 'allowed')).resolves.toBe('allowed')
})

it('never releases a true deletion fence during relocation cleanup', async () => {
  const { owner } = fixture()
  await owner.withProjectFolderRelocation('project', async () => {
    owner.beginProjectDeletion('project')
  })
  await expect(owner.runProjectOperation(request, async () => undefined)).rejects.toThrow(
    'being deleted'
  )
  owner.releaseProjectDeletion('project')
  await expect(owner.runProjectOperation(request, async () => 'allowed')).resolves.toBe('allowed')
})

it('retains the relocation fence after unconfirmed termination and allows a successful recovery retry', async () => {
  const { owner, cancel } = fixture()
  cancel.mockRejectedValueOnce(new Error('Child process did not stop'))
  const commit = vi.fn(async () => undefined)
  await expect(owner.withProjectFolderRelocation('project', commit)).rejects.toThrow('did not stop')
  expect(commit).not.toHaveBeenCalled()
  await expect(owner.runProjectOperation(request, async () => undefined)).rejects.toThrow(
    'relocated'
  )
  await owner.recoverProjectFolderRelocation('project')
  expect(commit).not.toHaveBeenCalled()
  await expect(owner.runProjectOperation(request, async () => 'allowed')).resolves.toBe('allowed')
})

it('serializes concurrent relocations and releases after a failed binding commit once termination was confirmed', async () => {
  const { owner } = fixture()
  const first = deferred()
  const order: number[] = []
  const a = owner.withProjectFolderRelocation('project', async () => {
    order.push(1)
    await first.promise
  })
  const b = owner.withProjectFolderRelocation('project', async () => {
    order.push(2)
    throw new Error('Binding changed elsewhere')
  })
  const rejected = b.catch((error: Error) => error.message)
  await vi.waitFor(() => expect(order).toEqual([1]))
  first.resolve()
  await a
  expect(await rejected).toBe('Binding changed elsewhere')
  expect(order).toEqual([1, 2])
  await expect(owner.runProjectOperation(request, async () => 'allowed')).resolves.toBe('allowed')
})

it.each(['recover', 'shutdownAll', 'dispose'] as const)(
  'keeps the unreaped executor in the registry and retries it through %s',
  async (operation) => {
    const sessions = new NotebookSessionRegistry<NotebookSessionAggregate>()
    const lane = createRootNotebookLane('project', 'session', 'frame')
    const shutdownExecutor = vi
      .fn(async () => ({ reaped: true }))
      .mockResolvedValueOnce({ reaped: false })
    const session = {
      sessionId: 'session',
      projectId: 'project',
      lane,
      shutdownExecutor,
      releaseMcpRpcConnection: vi.fn()
    } as unknown as NotebookSessionAggregate
    await sessions.getOrCreate(lane, async () => session)
    const owner = new NotebookSessionLifecycleOwner({
      defaultProjectId: 'project',
      sessions,
      shellExecution: {
        fenceShellRuns: () => () => undefined,
        cancelShellRuns: async () => undefined
      },
      runtimeBindings: {
        withSessionTeardown: async (_key: string, run: () => Promise<unknown>) => run(),
        waitForWrites: async () => undefined,
        withGlobalTeardown: async (run: () => Promise<unknown>) => run()
      },
      waitForRevocationDrains: async () => undefined
    } as unknown as NotebookSessionLifecycleOptions)
    const commit = vi.fn(async () => undefined)
    await expect(owner.withProjectFolderRelocation('project', commit)).rejects.toThrow(
      'cleanup failed'
    )
    expect(sessions.get(lane)).toBe(session)
    expect(session.releaseMcpRpcConnection).not.toHaveBeenCalled()
    expect(shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    await expect(owner.runProjectOperation(request, async () => undefined)).rejects.toThrow(
      'relocated'
    )
    if (operation === 'recover') {
      await owner.recoverProjectFolderRelocation('project')
      await expect(owner.runProjectOperation(request, async () => 'allowed')).resolves.toBe(
        'allowed'
      )
    } else await expect(owner[operation]()).resolves.toEqual({ reaped: true })
    expect(shutdownExecutor).toHaveBeenCalledTimes(2)
    expect(sessions.get(lane)).toBeUndefined()
    expect(session.releaseMcpRpcConnection).toHaveBeenCalledOnce()
  }
)

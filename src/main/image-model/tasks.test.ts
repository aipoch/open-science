import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as durableFiles from '@aipoch/durable-files'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageTaskOwner } from './tasks'
import { ImageModelError } from './contract'
import {
  readStoredImageTask,
  readStoredImageTasks,
  withImageTaskSnapshot,
  writeStoredImageTask
} from './stored-tasks'
import * as storedTasks from './stored-tasks'
import {
  ImageTaskIntegrityError,
  type ImageTaskStart,
  type ImageTaskResult
} from '../../shared/image-task'

const request = (): ImageTaskStart => {
  const id = crypto.randomUUID()
  return {
    id,
    projectId: 'project',
    sessionId: 'session',
    frameId: 'frame',
    branchId: 'branch',
    prompt: '',
    edit: {
      version: 1,
      source: {
        projectId: 'project',
        sourceSessionId: 'session',
        sourceKind: 'artifact-version',
        sourceFileId: 'file',
        sourceVersionId: 'version',
        name: 'image.png',
        mimeType: 'image/png'
      },
      model: { serviceId: '11111111-1111-4111-8111-111111111111', modelId: 'h3' },
      options: {},
      naturalSize: { width: 128, height: 128 },
      regions: [
        {
          id: 'region',
          number: 1,
          instruction: 'Make it yellow',
          geometry: { kind: 'point', point: { x: 0.5, y: 0.5 } }
        }
      ]
    }
  }
}
const output: ImageTaskResult = {
  artifactId: 'file',
  versionId: 'result',
  versionNumber: 2,
  name: 'image.png',
  size: 10,
  checksum: 'a'.repeat(64)
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(
  execute: (signal: AbortSignal) => Promise<ImageTaskResult>,
  recover?: () => Promise<ImageTaskResult | undefined>
): Promise<{
  owner: ImageTaskOwner
  root: string
  verifyResults: ReturnType<
    typeof vi.fn<(tasks: readonly import('../../shared/image-task').ImageTask[]) => Promise<void>>
  >
  prepare: ReturnType<
    typeof vi.fn<() => Promise<(signal: AbortSignal) => Promise<ImageTaskResult>>>
  >
}> {
  const root = await mkdtemp(join(tmpdir(), 'image-tasks-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let tail = Promise.resolve()
  const prepare = vi.fn(
    async () =>
      async (
        signal: AbortSignal,
        onStarted?: (model: { provider: string; model: string }) => Promise<void>
      ) => {
        await onStarted?.({ provider: 'Test image service', model: 'test-image-model' })
        return execute(signal)
      }
  )
  const verifyResults = vi.fn<
    (tasks: readonly import('../../shared/image-task').ImageTask[]) => Promise<void>
  >(async () => {})
  const owner = new ImageTaskOwner({
    verifyResults,
    root: () => root,
    retainWrite: () => () => {},
    prepare,
    recover,
    authorize: async () => {},
    reportError: vi.fn(),
    mutate: (_scope, work) => {
      const next = tail.then(work)
      tail = next.then(
        () => {},
        () => {}
      )
      return next
    }
  })
  cleanup.push(() => owner.close())
  return { owner, root, prepare, verifyResults }
}
it('freezes region-only input and deduplicates admission', async () => {
  let finish!: (value: ImageTaskResult) => void
  const execute = vi.fn(
    () =>
      new Promise<ImageTaskResult>((resolve) => {
        finish = resolve
      })
  )
  const { owner, prepare } = await fixture(execute)
  const input = request()
  const [a, b] = await Promise.all([owner.start(input), owner.start(input)])
  expect(a.id).toBe(b.id)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(owner.isBusy('project', 'session')).toBe(true)
  input.edit.regions[0].instruction = 'Changed draft'
  await expect(owner.start(input)).rejects.toThrow('reused')
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
  const listed = await owner.list({ projectId: 'project', sessionId: 'session' })
  expect(listed[0].edit.regions[0].instruction).toBe('Make it yellow')
  finish(output)
  await vi.waitFor(async () =>
    expect((await owner.list({ projectId: 'project', sessionId: 'session' }))[0].state).toBe(
      'succeeded'
    )
  )
})
it('cancels only its own request and retains uncertain upstream outcomes without retrying', async () => {
  const execute = vi.fn(
    (signal: AbortSignal) =>
      new Promise<ImageTaskResult>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new ImageModelError('OUTCOME_UNKNOWN', 'Uncertain provider result.')),
          { once: true }
        )
      })
  )
  const { owner } = await fixture(execute)
  const first = request(),
    second = request()
  await owner.start(first)
  await owner.start(second)
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
  await owner.cancel({ projectId: first.projectId, sessionId: first.sessionId, id: first.id })
  await vi.waitFor(async () => {
    const tasks = await owner.list({ projectId: 'project', sessionId: 'session' })
    expect(tasks.find(({ id }) => id === first.id)?.state).toBe('outcome-unknown')
    expect(tasks.find(({ id }) => id === second.id)?.state).toBe('running')
  })
  await owner.start(first)
  expect(execute).toHaveBeenCalledTimes(2)
  owner.cancelSessions(['session'])
  await vi.waitFor(() => expect(owner.isBusy('project')).toBe(false))
})
it.each([false, true])(
  'recovers interrupted work without a new provider call (published: %s)',
  async (published) => {
    const execute = vi.fn(async () => output)
    const { owner, root } = await fixture(execute, async () => (published ? output : undefined))
    const input = request()
    await writeStoredImageTask(root, { ...input, state: 'running', createdAt: 1, updatedAt: 1 })
    const [task] = await owner.list({ projectId: input.projectId, sessionId: input.sessionId })
    expect(task.state).toBe(published ? 'succeeded' : 'outcome-unknown')
    await owner.start(input)
    expect(execute).not.toHaveBeenCalled()
  }
)

it('waits for admissions during shutdown and never executes their provider request', async () => {
  const execute = vi.fn(async () => output)
  const { owner, prepare, root } = await fixture(execute)
  let release!: () => void
  prepare.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return execute
  })
  const input = request()
  const starting = owner.start(input)
  const rejected = expect(starting).rejects.toThrow('shutting down')
  await vi.waitFor(() => expect(prepare).toHaveBeenCalled())
  expect(owner.isBusy(input.projectId, input.sessionId)).toBe(true)
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  release()
  await rejected
  await closing
  expect(owner.isBusy(input.projectId)).toBe(false)
  expect(execute).not.toHaveBeenCalled()
  expect(await readStoredImageTasks(root, input)).toEqual([])
})

it('finds an old unconfirmed task by exact source and owner without executing it', async () => {
  const execute = vi.fn(async () => output)
  const recover = vi.fn(async () => undefined)
  const { owner, root } = await fixture(execute, recover)
  const input = request()
  const old = { ...input, state: 'outcome-unknown', createdAt: 1, updatedAt: 1 } as const
  await writeStoredImageTask(root, old)
  const folder = join(root, 'artifacts/project/session/.image-tasks')
  await Promise.all(
    Array.from({ length: 256 }, (_, index) => {
      const id = crypto.randomUUID()
      return writeFile(
        join(folder, `${id}.json`),
        JSON.stringify({
          ...old,
          id,
          branchId: 'another',
          createdAt: index + 3,
          state: 'cancelled'
        })
      )
    })
  )
  const scope = { projectId: input.projectId, sessionId: input.sessionId }
  const recent = await owner.list(scope)
  expect(recent.some(({ id }) => id === input.id)).toBe(false)
  const recovery = {
    frameId: input.frameId,
    branchId: input.branchId,
    sourceVersionId: input.edit.source.sourceVersionId
  }
  const read = vi.spyOn(durableFiles, 'readFileWithinLimit')
  try {
    await expect(owner.list({ ...scope, recovery })).resolves.toEqual([old])
    expect(read).toHaveBeenCalledExactlyOnceWith(join(folder, `${old.id}.json`), 512 * 1024)
    await expect(
      owner.list({ ...scope, recovery: { ...recovery, frameId: 'other-frame' } })
    ).resolves.toEqual([])
    expect(read).toHaveBeenCalledOnce()
  } finally {
    read.mockRestore()
  }
  await expect(
    owner.list({ ...scope, recovery: { ...recovery, branchId: 'another' } })
  ).resolves.toEqual(recent)
  const newest = {
    ...input,
    id: crypto.randomUUID(),
    state: 'succeeded',
    createdAt: 2,
    updatedAt: 2,
    result: output
  } as const
  await writeStoredImageTask(root, newest)
  const otherSource = {
    ...newest,
    id: crypto.randomUUID(),
    createdAt: 3,
    edit: {
      ...newest.edit,
      source: { ...newest.edit.source, sourceVersionId: 'another-version' }
    }
  }
  await writeStoredImageTask(root, otherSource)
  const options = { limit: 1, recovery, onInvalid: vi.fn() }
  await expect(readStoredImageTasks(root, scope, options)).resolves.toEqual([otherSource, newest])
  await expect(readStoredImageTasks(root, scope, options)).resolves.toEqual([otherSource, newest])
  expect(options.onInvalid).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it.each([
  ['QUOTA_EXCEEDED', 'failed'],
  ['CANCELLED', 'cancelled'],
  ['OUTCOME_UNKNOWN', 'outcome-unknown']
] as const)('persists %s without internal diagnostics', async (code, state) => {
  const { owner, root } = await fixture(async () => {
    throw new ImageModelError(code, 'Internal diagnostic')
  })
  const input = request()
  await owner.start(input)
  await vi.waitFor(async () =>
    expect(
      (await owner.get({ id: input.id, projectId: input.projectId, sessionId: input.sessionId }))
        ?.state
    ).toBe(state)
  )
  const stored = await readStoredImageTask(root, input)
  expect(stored?.error).toEqual({ code })
})

it('isolates a damaged history record for browsing while keeping export validation strict', async () => {
  const { root, owner } = await fixture(async () => output)
  const input = request()
  await writeStoredImageTask(root, {
    ...input,
    result: output,
    state: 'succeeded',
    createdAt: 1,
    updatedAt: 1
  })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    join(root, 'artifacts/project/session/.image-tasks', `${crypto.randomUUID()}.json`),
    '{broken'
  )
  expect(await owner.list({ projectId: input.projectId, sessionId: input.sessionId })).toHaveLength(
    1
  )
  await expect(readStoredImageTasks(root, input)).rejects.toThrow()
})

it('invalidates an export snapshot when an existing image task file changes in place', async () => {
  const { root } = await fixture(async () => output)
  const task = {
    ...request(),
    prompt: 'alpha',
    state: 'cancelled' as const,
    createdAt: 1,
    updatedAt: 1
  }
  await writeStoredImageTask(root, task)
  await withImageTaskSnapshot(async () => {
    expect(await readStoredImageTasks(root, task)).toMatchObject([{ prompt: 'alpha' }])
    const path = join(root, 'artifacts/project/session/.image-tasks', `${task.id}.json`)
    await writeFile(path, JSON.stringify({ ...task, prompt: 'bravo' }))
    expect(await readStoredImageTasks(root, task)).toMatchObject([{ prompt: 'bravo' }])
  })
})

it('marks an interrupted waiting request cancelled instead of suggesting a submitted provider request', async () => {
  const { root, owner } = await fixture(async () => output)
  const input = request()
  await writeStoredImageTask(root, { ...input, state: 'queued', createdAt: 1, updatedAt: 1 })
  expect(
    await owner.get({ projectId: input.projectId, sessionId: input.sessionId, id: input.id })
  ).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } })
})

it('restores a provider rejection after a crash without blocking the task list or calling the provider', async () => {
  const execute = vi.fn(async () => output)
  const { owner, root, prepare } = await fixture(execute, async () => {
    throw new ImageModelError('QUOTA_EXCEEDED', 'Stored rejection', 429)
  })
  const input = request()
  await writeStoredImageTask(root, { ...input, state: 'running', createdAt: 1, updatedAt: 1 })
  const tasks = await owner.list({ projectId: input.projectId, sessionId: input.sessionId })
  expect(tasks[0]).toMatchObject({
    state: 'failed',
    error: { code: 'QUOTA_EXCEEDED', httpStatus: 429 }
  })
  expect(await readStoredImageTask(root, input)).toMatchObject({ state: 'failed' })
  expect(prepare).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it('waits for admission before resolving a lost start response by identity', async () => {
  const f = await fixture(async () => output)
  let release!: () => void
  f.prepare.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return async () => output
  })
  const input = request()
  const started = f.owner.start(input)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  let observed = false
  const lookup = f.owner
    .get({ projectId: input.projectId, sessionId: input.sessionId, id: input.id })
    .then((task) => {
      observed = true
      return task
    })
  await Promise.resolve()
  expect(observed).toBe(false)
  release()
  await started
  expect((await lookup)?.id).toBe(input.id)
  expect(f.prepare).toHaveBeenCalledTimes(1)
})

it.each(['task', 'sessions', 'project'] as const)(
  'cancels pending admission by %s without calling the provider',
  async (target) => {
    const execute = vi.fn(async () => output)
    const f = await fixture(execute)
    let release!: () => void
    f.prepare.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return execute
    })
    const input = request()
    const started = f.owner.start(input)
    const duplicate = f.owner.start(input)
    const duplicateRejected = expect(duplicate).rejects.toMatchObject({ code: 'CANCELLED' })
    const rejected = expect(started).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    if (target === 'sessions') f.owner.cancelSessions([input.sessionId])
    else if (target === 'project') f.owner.cancelProject(input.projectId)
    else
      await f.owner.cancel({ projectId: input.projectId, sessionId: input.sessionId, id: input.id })
    release()
    await rejected
    await duplicateRejected
    expect(execute).not.toHaveBeenCalled()
  }
)

it('honors cancellation while the queued record is being written', async () => {
  const execute = vi.fn(async () => output)
  const { owner } = await fixture(execute)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const write = vi
    .spyOn(storedTasks, 'writeStoredImageTask')
    .mockImplementationOnce(async (root, task) => {
      entered.resolve()
      await resume.promise
      await writeStoredImageTask(root, task)
    })
  const input = request()
  const started = owner.start(input)
  const identity = { projectId: input.projectId, sessionId: input.sessionId, id: input.id }
  try {
    await entered.promise
    await owner.cancel(identity)
  } finally {
    resume.resolve()
    await started
    write.mockRestore()
  }
  await vi.waitFor(async () =>
    expect(await owner.get(identity)).toMatchObject({ state: 'cancelled' })
  )
  expect(execute).not.toHaveBeenCalled()
})

it('pages beyond the live history window with stable cursors and branch isolation', async () => {
  const { root, owner } = await fixture(async () => output)
  const input = request()
  const records = Array.from({ length: 270 }, (_, i) => ({
    ...input,
    id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
    state: 'succeeded' as const,
    result: { ...output, versionId: `v${i}` },
    createdAt: 1,
    updatedAt: 1
  }))
  await Promise.all(records.map((record) => writeStoredImageTask(root, record)))
  await writeStoredImageTask(root, { ...records[0], id: crypto.randomUUID(), branchId: 'other' })
  const scope = { projectId: input.projectId, sessionId: input.sessionId }
  const ids: string[] = []
  let before: { createdAt: number; id: string } | undefined
  do {
    const page = await owner.list({
      ...scope,
      history: { branchId: 'branch', before }
    })
    expect(page.length).toBeLessThanOrEqual(32)
    ids.push(...page.map((task) => task.id))
    if (page.length < 32) break
    before = { id: page.at(-1)!.id, createdAt: page.at(-1)!.createdAt }
  } while (ids.length < 300)
  expect(ids).toEqual(records.map((task) => task.id).reverse())
  const added = { ...records[0], id: crypto.randomUUID(), createdAt: 2, updatedAt: 2 }
  await writeStoredImageTask(root, added)
  const page = await owner.list({ ...scope, history: { branchId: 'branch' } })
  expect(page[0]?.id).toBe(added.id)
})

it('isolates invalid result references without mutating stored success or hiding infrastructure errors', async () => {
  const { root, owner, verifyResults } = await fixture(async () => output)
  const input = request()
  const badId = crypto.randomUUID()
  for (const id of [input.id, badId])
    await writeStoredImageTask(root, {
      ...input,
      id,
      state: 'succeeded',
      result: output,
      createdAt: 1,
      updatedAt: 1
    })
  verifyResults.mockRejectedValue(new ImageTaskIntegrityError([badId]))
  const scope = { projectId: input.projectId, sessionId: input.sessionId }
  const page = await owner.list(scope)
  expect(page.find((task) => task.id === input.id)?.state).toBe('succeeded')
  expect(page.find((task) => task.id === badId)).toMatchObject({
    state: 'failed',
    result: undefined,
    error: { code: 'SOURCE_UNAVAILABLE' }
  })
  expect((await readStoredImageTask(root, { ...scope, id: badId }))?.state).toBe('succeeded')
  await expect(owner.list(scope, true)).rejects.toThrow('integrity')
  verifyResults.mockRejectedValue(new Error('database unavailable'))
  await expect(owner.list(scope)).rejects.toThrow('database unavailable')
})

it('keeps healthy history visible when a single interrupted result cannot be recovered', async () => {
  const input = request()
  const recoveryError = new ImageTaskIntegrityError([input.id])
  const recover = vi.fn<() => Promise<ImageTaskResult | undefined>>()
  recover.mockRejectedValue(recoveryError)
  const { root, owner, prepare } = await fixture(async () => output, recover)
  const scope = { projectId: input.projectId, sessionId: input.sessionId }
  await writeStoredImageTask(root, { ...input, state: 'running', createdAt: 1, updatedAt: 1 })
  const healthyId = crypto.randomUUID()
  await writeStoredImageTask(root, {
    ...input,
    id: healthyId,
    state: 'succeeded',
    result: output,
    createdAt: 2,
    updatedAt: 2
  })

  const page = await owner.list({ ...scope, history: { branchId: input.branchId } })
  expect(page).toMatchObject([
    { id: healthyId, state: 'succeeded' },
    { id: input.id, state: 'failed', error: { code: 'SOURCE_UNAVAILABLE' } }
  ])
  expect((await readStoredImageTask(root, input))?.state).toBe('running')
  await expect(owner.list(scope, true)).rejects.toThrow(input.id)
  recover.mockRejectedValueOnce(new Error('database unavailable'))
  await expect(owner.list(scope)).rejects.toThrow('database unavailable')
  recover.mockResolvedValueOnce(output)
  await expect(owner.get({ ...scope, id: input.id })).resolves.toMatchObject({
    state: 'succeeded',
    result: output
  })
  expect(prepare).not.toHaveBeenCalled()
})

import { createHash } from 'node:crypto'
import { readStoredImageTask, readStoredImageTasks, writeStoredImageTask } from './stored-tasks'
import {
  imageTaskStartSchema,
  imageTaskListSchema,
  ImageTaskIntegrityError,
  type ImageTaskList,
  imageTaskIdentitySchema,
  imageTaskIsActive,
  matchesImageTaskSource,
  type ImageTask,
  type ImageTaskExecutionModel,
  type ImageTaskStart,
  type ImageTaskScope,
  type ImageTaskIdentity,
  type ImageTaskResult
} from '../../shared/image-task'
import { ImageModelError } from './contract'

const digest = ({
  id,
  projectId,
  sessionId,
  frameId,
  branchId,
  prompt,
  edit
}: ImageTaskStart): string =>
  createHash('sha256')
    .update(JSON.stringify({ id, projectId, sessionId, frameId, branchId, prompt, edit }))
    .digest('hex')

const unavailableResult = (task: ImageTask): ImageTask => ({
  ...task,
  state: 'failed',
  result: undefined,
  error: { code: 'SOURCE_UNAVAILABLE' }
})

// One owner per Host. Network work never holds the Session mutation lock.
export class ImageTaskOwner {
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void>; task: ImageTask }
  >()
  private readonly admissions = new Map<Promise<void>, ImageTaskStart>()
  private readonly cancelledAdmissions = new Set<string>()
  private closed = false
  constructor(
    private readonly options: {
      root(): string
      retainWrite(): () => void
      mutate<T>(scope: ImageTaskScope, work: () => Promise<T>): Promise<T>
      authorize(request: ImageTaskScope, start?: ImageTaskStart): Promise<void>
      prepare(
        request: ImageTaskStart
      ): Promise<
        (
          signal: AbortSignal,
          onStarted: (model: ImageTaskExecutionModel) => Promise<void>
        ) => Promise<ImageTaskResult>
      >
      verifyResults(tasks: readonly ImageTask[]): Promise<void>
      recover?(task: ImageTask): Promise<ImageTaskResult | undefined>
      reportError(error: unknown): void
    }
  ) {}

  private key(scope: ImageTaskIdentity): string {
    return JSON.stringify([scope.projectId, scope.sessionId, scope.id])
  }
  private read(scope: ImageTaskIdentity): Promise<ImageTask | undefined> {
    return readStoredImageTask(this.options.root(), scope)
  }
  private write(task: ImageTask): Promise<void> {
    return writeStoredImageTask(this.options.root(), task)
  }
  async get(raw: ImageTaskIdentity): Promise<ImageTask | undefined> {
    const task = await this.readTask(raw)
    if (task) await this.options.verifyResults([task])
    return task
  }
  private async readTask(raw: ImageTaskIdentity): Promise<ImageTask | undefined> {
    const scope = imageTaskIdentitySchema.parse(raw)
    // A lost start response can race admission; absence is conclusive only after it settles.
    await Promise.all(
      [...this.admissions]
        .filter(
          ([, request]) =>
            request.projectId === scope.projectId &&
            request.sessionId === scope.sessionId &&
            'id' in request &&
            request.id === scope.id
        )
        .map(([pending]) => pending)
    )
    const live = this.active.get(this.key(scope))
    if (live && imageTaskIsActive(live.task)) return structuredClone(live.task)
    if (live) await live.done
    await this.options.authorize(scope)
    const task = await this.read(scope)
    if (
      !task ||
      (!imageTaskIsActive(task) && task.state !== 'outcome-unknown') ||
      this.active.has(this.key(task))
    )
      return task
    return this.options.mutate(scope, async () => {
      const latest = await this.read(scope)
      if (
        !latest ||
        this.active.has(this.key(scope)) ||
        (!imageTaskIsActive(latest) && latest.state !== 'outcome-unknown')
      )
        return latest
      let result: ImageTaskResult | undefined
      try {
        result = await this.options.recover?.(latest)
      } catch (error) {
        if (!(error instanceof ImageModelError)) throw error
        latest.state =
          error.code === 'OUTCOME_UNKNOWN'
            ? 'outcome-unknown'
            : error.code === 'CANCELLED'
              ? 'cancelled'
              : 'failed'
        latest.error = error.detail
        latest.updatedAt = Date.now()
        await this.write(latest)
        return latest
      }
      if (result)
        Object.assign(latest, {
          result,
          state: 'succeeded',
          error: undefined,
          updatedAt: Date.now()
        })
      else if (latest.state === 'outcome-unknown') return latest
      else
        Object.assign(latest, {
          state: latest.state === 'queued' ? 'cancelled' : 'outcome-unknown',
          updatedAt: Date.now(),
          error: { code: latest.state === 'queued' ? 'CANCELLED' : 'OUTCOME_UNKNOWN' }
        })
      await this.write(latest)
      return latest
    })
  }
  async list(raw: ImageTaskList, complete = false): Promise<ImageTask[]> {
    const request = imageTaskListSchema.parse(raw)
    const scope = { projectId: request.projectId, sessionId: request.sessionId }
    await this.options.authorize(scope)
    const tasks = await readStoredImageTasks(
      this.options.root(),
      scope,
      complete
        ? undefined
        : {
            limit: request.history ? 32 : 256,
            history: request.history,
            recovery: request.recovery,
            onInvalid: this.options.reportError
          }
    )
    const results = await Promise.all(
      tasks.map(async (task) => {
        if (!imageTaskIsActive(task) && task.state !== 'outcome-unknown') return task
        // The editor displays this task and checks its result explicitly through Refresh.
        if (
          request.recovery &&
          task.state === 'outcome-unknown' &&
          matchesImageTaskSource(task, request.recovery)
        )
          return task
        try {
          return (await this.readTask({ ...scope, id: task.id })) ?? task
        } catch (error) {
          if (
            complete ||
            !(error instanceof ImageTaskIntegrityError) ||
            !error.taskIds.includes(task.id)
          )
            throw error
          this.options.reportError(error)
          return unavailableResult(task)
        }
      })
    )
    try {
      await this.options.verifyResults(results)
      return results
    } catch (error) {
      // A broken result must not hide healthy history. Infrastructure errors still propagate.
      if (complete || !(error instanceof ImageTaskIntegrityError)) throw error
      this.options.reportError(error)
      const invalid = new Set(error.taskIds)
      return results.map((task) => (invalid.has(task.id) ? unavailableResult(task) : task))
    }
  }
  async start(raw: ImageTaskStart): Promise<ImageTask> {
    const request = imageTaskStartSchema.parse(raw)
    if (this.closed) throw new Error('Image tasks are shutting down.')
    let settled!: () => void
    const admission = new Promise<void>((resolve) => {
      settled = resolve
    })
    this.admissions.set(admission, request)
    try {
      const task = await this.admit(request)
      await this.options.verifyResults([task])
      return task
    } finally {
      this.admissions.delete(admission)
      if (![...this.admissions.values()].some((pending) => this.key(pending) === this.key(request)))
        this.cancelledAdmissions.delete(this.key(request))
      settled()
    }
  }
  private async admit(request: ImageTaskStart): Promise<ImageTask> {
    await this.options.authorize(request, request)
    return this.options.mutate(request, async () => {
      if (this.closed) throw new Error('Image tasks are shutting down.')
      const existing = await this.read(request)
      if (existing) {
        if (digest(existing) !== digest(request))
          throw new Error('Image task id was reused with different instructions.')
        return existing
      }
      const releaseWrite = this.options.retainWrite()
      let admitted = false
      try {
        await this.options.authorize(request, request)
        const execute = await this.options.prepare(request)
        if (this.cancelledAdmissions.has(this.key(request)))
          throw new ImageModelError('CANCELLED', 'Image request cancelled before submission.')
        if (this.closed) throw new Error('Image tasks are shutting down.')
        const task: ImageTask = {
          ...request,
          state: 'queued',
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        await this.write(task)
        const controller = new AbortController()
        if (this.closed || this.cancelledAdmissions.has(this.key(task))) controller.abort()
        const key = this.key(task)
        // Schedule after admission releases the mutation lock, also deduplicating immediate re-entry.
        const done = Promise.resolve()
          .then(async () => {
            try {
              controller.signal.throwIfAborted()
              task.result = await execute(controller.signal, async (model) => {
                await this.options.mutate(task, async () => {
                  controller.signal.throwIfAborted()
                  await this.options.authorize(task)
                  task.executionModel = model
                  task.state = 'running'
                  task.updatedAt = Date.now()
                  await this.write(task)
                })
              })
              task.state = 'succeeded'
            } catch (error) {
              task.state =
                error instanceof ImageModelError
                  ? error.code === 'OUTCOME_UNKNOWN'
                    ? 'outcome-unknown'
                    : error.code === 'CANCELLED'
                      ? 'cancelled'
                      : 'failed'
                  : controller.signal.aborted
                    ? 'cancelled'
                    : 'failed'
              task.error =
                error instanceof ImageModelError
                  ? error.detail
                  : { code: task.state === 'cancelled' ? 'CANCELLED' : 'PROVIDER_ERROR' }
              this.options.reportError(error)
            }
            task.updatedAt = Date.now()
            await this.options.mutate(task, async () => {
              // Deletion wins: a late response must never recreate a deleted Session.
              await this.options.authorize(task)
              await this.write(task)
            })
          })
          .catch(this.options.reportError)
          .finally(() => {
            this.active.delete(key)
            releaseWrite()
          })
        this.active.set(key, { controller, done, task })
        admitted = true
        return structuredClone(task)
      } finally {
        if (!admitted) releaseWrite()
      }
    })
  }
  async cancel(raw: ImageTaskIdentity): Promise<void> {
    const scope = imageTaskIdentitySchema.parse(raw)
    await this.options.authorize(scope)
    const key = this.key(scope)
    this.cancelMatching((task) => this.key(task) === key)
  }
  private cancelMatching(matches: (task: ImageTaskIdentity) => boolean): void {
    for (const request of this.admissions.values())
      if (matches(request)) this.cancelledAdmissions.add(this.key(request))
    for (const { controller, task } of this.active.values()) if (matches(task)) controller.abort()
  }
  isBusy(projectId: string, sessionId?: string): boolean {
    return [...this.admissions.values(), ...[...this.active.values()].map(({ task }) => task)].some(
      (scope) => scope.projectId === projectId && (!sessionId || scope.sessionId === sessionId)
    )
  }
  cancelSessions(sessionIds: readonly string[]): void {
    this.cancelMatching(({ sessionId }) => sessionIds.includes(sessionId))
  }
  cancelProject(projectId: string): void {
    this.cancelMatching((task) => task.projectId === projectId)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const { controller } of this.active.values()) controller.abort()
    // Admissions may still be preparing inputs or durably writing the queued task.
    await Promise.all(this.admissions.keys())
    for (const { controller } of this.active.values()) controller.abort()
    await Promise.all([...this.active.values()].map(({ done }) => done))
  }
}

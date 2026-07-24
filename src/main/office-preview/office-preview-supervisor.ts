import type {
  OfficePreviewAdmissionError,
  OfficePreviewAttachResult,
  OfficePreviewOpenRequest,
  OfficePreviewOpenResult,
  OfficePreviewResourceSnapshot,
  OfficePreviewRuntimeResource,
  OfficePreviewRuntimeStart,
  OfficePreviewRuntimeState
} from '../../shared/office-preview'
import {
  getOfficePreviewTimeoutMs,
  OFFICE_PREVIEW_MAX_FILE_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS
} from '../../shared/office-preview'

type OfficePreviewFrameProcess = {
  frameProcessId: number
  parentProcessId: number
}

type OfficePreviewSupervisorDependencies = {
  inspectResource: (request: OfficePreviewOpenRequest) => Promise<OfficePreviewResourceSnapshot>
  acquireResource: (
    ownerId: number,
    request: OfficePreviewOpenRequest,
    snapshot: OfficePreviewResourceSnapshot,
    maxBytes: number
  ) => Promise<OfficePreviewRuntimeResource>
  releaseResource: (ownerId: number, resourceId: string) => void | Promise<void>
  createSessionId: () => string
  createRuntimeUrl: (sessionId: string) => string
  resolveFrameProcess: (
    parentOwnerId: number,
    runtimeUrl: string
  ) => OfficePreviewFrameProcess | undefined
  getProcessMemoryUsageBytes?: (processId: number) => number | Promise<number>
  publishState?: (parentOwnerId: number, state: OfficePreviewRuntimeState) => void
}

type OfficePreviewSession = {
  parentOwnerId: number
  requestId: string
  runtimeUrl: string
  start: OfficePreviewRuntimeStart
  ready: boolean
  frameProcessId?: number
  parentProcessId?: number
  timeout?: ReturnType<typeof setTimeout>
  memoryPoll?: ReturnType<typeof setInterval>
  memoryPollInFlight?: boolean
}

class OfficePreviewOpenSupersededError extends Error {
  constructor() {
    super('Office preview open request was superseded')
    this.name = 'OfficePreviewOpenSupersededError'
  }
}

// Keep the supervisor dependency structural so resource adapters can preserve typed admission data.
const isFileTooLargeAdmissionError = (error: unknown): error is OfficePreviewAdmissionError =>
  error instanceof Error &&
  (error as Partial<OfficePreviewAdmissionError>).code === 'FILE_TOO_LARGE' &&
  typeof (error as Partial<OfficePreviewAdmissionError>).size === 'number' &&
  typeof (error as Partial<OfficePreviewAdmissionError>).limit === 'number'

class OfficePreviewSupervisor {
  private readonly sessions = new Map<string, OfficePreviewSession>()
  private readonly activeSessionByParent = new Map<number, string>()
  private readonly openGenerationByParent = new Map<number, number>()
  private nextOpenGeneration = 0

  constructor(private readonly dependencies: OfficePreviewSupervisorDependencies) {}

  async open(
    parentOwnerId: number,
    request: OfficePreviewOpenRequest
  ): Promise<OfficePreviewOpenResult> {
    // A process-wide monotonic token prevents stale opens from matching after owner teardown/reload.
    const generation = ++this.nextOpenGeneration
    this.openGenerationByParent.set(parentOwnerId, generation)
    const assertCurrentGeneration = (): void => {
      if (this.openGenerationByParent.get(parentOwnerId) !== generation) {
        throw new OfficePreviewOpenSupersededError()
      }
    }
    const activeSessionId = this.activeSessionByParent.get(parentOwnerId)
    if (activeSessionId) await this.close(parentOwnerId, activeSessionId)
    assertCurrentGeneration()

    // Reject from authoritative metadata before creating a file capability or frame URL.
    const snapshot = await this.dependencies.inspectResource(request)
    assertCurrentGeneration()
    if (snapshot.size > OFFICE_PREVIEW_MAX_FILE_BYTES) {
      return {
        kind: 'unavailable',
        reason: 'FILE_TOO_LARGE',
        size: snapshot.size,
        limit: OFFICE_PREVIEW_MAX_FILE_BYTES
      }
    }

    const sessionId = this.dependencies.createSessionId()
    let resource: OfficePreviewRuntimeResource | undefined
    try {
      resource = await this.dependencies.acquireResource(
        parentOwnerId,
        request,
        snapshot,
        OFFICE_PREVIEW_MAX_FILE_BYTES
      )
      assertCurrentGeneration()
      const runtimeUrl = this.dependencies.createRuntimeUrl(sessionId)
      const start: OfficePreviewRuntimeStart = {
        sessionId,
        resource,
        extension: request.extension,
        name: request.name,
        attempt: request.attempt
      }
      const session: OfficePreviewSession = {
        parentOwnerId,
        requestId: request.requestId,
        runtimeUrl,
        start,
        ready: false
      }
      this.sessions.set(sessionId, session)
      this.activeSessionByParent.set(parentOwnerId, sessionId)
      this.publishState(parentOwnerId, request.requestId, {
        sessionId,
        phase: 'starting',
        title: 'Starting Office preview'
      })
      this.armReadinessTimeout(sessionId, session)

      return {
        kind: 'started',
        sessionId,
        runtimeUrl,
        size: snapshot.size,
        limit: OFFICE_PREVIEW_MAX_FILE_BYTES
      }
    } catch (error) {
      if (resource) await this.dependencies.releaseResource(parentOwnerId, resource.id)
      if (isFileTooLargeAdmissionError(error)) {
        return {
          kind: 'unavailable',
          reason: error.code,
          size: error.size,
          limit: error.limit
        }
      }
      throw error
    }
  }

  async attachFrame(
    parentOwnerId: number,
    sessionId: string
  ): Promise<OfficePreviewAttachResult | undefined> {
    const session = this.sessions.get(sessionId)
    if (!session || session.parentOwnerId !== parentOwnerId) return undefined

    // Fail closed unless Chromium assigned the runtime frame to a different renderer process.
    let process: OfficePreviewFrameProcess | undefined
    try {
      process = this.dependencies.resolveFrameProcess(parentOwnerId, session.runtimeUrl)
    } catch {
      process = undefined
    }
    if (
      !process ||
      process.frameProcessId <= 0 ||
      process.parentProcessId <= 0 ||
      process.frameProcessId === process.parentProcessId ||
      (session.frameProcessId !== undefined && session.frameProcessId !== process.frameProcessId)
    ) {
      this.publishState(parentOwnerId, session.requestId, {
        sessionId,
        phase: 'error',
        error: 'PREVIEW_PROCESS_NOT_ISOLATED'
      })
      await this.close(parentOwnerId, sessionId)
      return { kind: 'unavailable', reason: 'PREVIEW_PROCESS_NOT_ISOLATED' }
    }

    session.frameProcessId = process.frameProcessId
    session.parentProcessId = process.parentProcessId
    // Reloading an already-ready OOPIF creates a new runtime document that must become ready again.
    this.armReadinessTimeout(sessionId, session)
    if (!session.memoryPoll && this.dependencies.getProcessMemoryUsageBytes) {
      session.memoryPoll = setInterval(() => {
        void this.checkMemoryUsage(sessionId)
      }, OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)
    }
    return { kind: 'attached', start: session.start }
  }

  reportState(parentOwnerId: number, sessionId: string, state: OfficePreviewRuntimeState): void {
    const session = this.sessions.get(sessionId)
    if (
      !session ||
      session.parentOwnerId !== parentOwnerId ||
      session.frameProcessId === undefined ||
      state.sessionId !== sessionId
    ) {
      return
    }

    if (state.phase === 'ready') {
      session.ready = true
      if (session.timeout) clearTimeout(session.timeout)
      session.timeout = undefined
    }
    this.publishState(parentOwnerId, session.requestId, state)
    if (state.phase === 'error') void this.close(parentOwnerId, sessionId)
  }

  async close(parentOwnerId: number, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.parentOwnerId !== parentOwnerId) return

    // Remove ownership first so concurrent timeout, crash, and React cleanup calls are idempotent.
    this.sessions.delete(sessionId)
    if (this.activeSessionByParent.get(parentOwnerId) === sessionId) {
      this.activeSessionByParent.delete(parentOwnerId)
    }
    if (session.timeout) clearTimeout(session.timeout)
    if (session.memoryPoll) clearInterval(session.memoryPoll)
    await this.dependencies.releaseResource(parentOwnerId, session.start.resource.id)
  }

  async closeOwner(parentOwnerId: number): Promise<void> {
    this.openGenerationByParent.delete(parentOwnerId)
    const sessionId = this.activeSessionByParent.get(parentOwnerId)
    if (sessionId) await this.close(parentOwnerId, sessionId)
  }

  private armReadinessTimeout(sessionId: string, session: OfficePreviewSession): void {
    if (session.timeout) clearTimeout(session.timeout)
    session.ready = false
    session.timeout = setTimeout(
      () => {
        const active = this.sessions.get(sessionId)
        if (!active || active.ready) return
        this.publishState(active.parentOwnerId, active.requestId, {
          sessionId,
          phase: 'error',
          error: 'PREVIEW_TIMEOUT'
        })
        void this.close(active.parentOwnerId, sessionId)
      },
      getOfficePreviewTimeoutMs(session.start.resource.size, session.start.attempt)
    )
  }

  private async checkMemoryUsage(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (
      !session ||
      session.frameProcessId === undefined ||
      !this.dependencies.getProcessMemoryUsageBytes ||
      session.memoryPollInFlight
    ) {
      return
    }

    session.memoryPollInFlight = true
    try {
      // Re-resolve the frame on every poll so a crashed or replaced OOPIF cannot retain the session.
      const process = this.dependencies.resolveFrameProcess(
        session.parentOwnerId,
        session.runtimeUrl
      )
      if (
        !process ||
        process.frameProcessId !== session.frameProcessId ||
        process.parentProcessId !== session.parentProcessId ||
        process.frameProcessId === process.parentProcessId
      ) {
        this.publishState(session.parentOwnerId, session.requestId, {
          sessionId,
          phase: 'error',
          error: 'PREVIEW_PROCESS_CRASHED'
        })
        await this.close(session.parentOwnerId, sessionId)
        return
      }

      const usage = await this.dependencies.getProcessMemoryUsageBytes(session.frameProcessId)
      if (usage < OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES) return
      this.publishState(session.parentOwnerId, session.requestId, {
        sessionId,
        phase: 'error',
        error: 'RESOURCE_LIMIT_EXCEEDED'
      })
      await this.close(session.parentOwnerId, sessionId)
    } catch {
      // Process metrics are advisory; a transient metrics failure must not terminate a valid preview.
    } finally {
      const active = this.sessions.get(sessionId)
      if (active) active.memoryPollInFlight = false
    }
  }

  private publishState(
    parentOwnerId: number,
    requestId: string,
    state: OfficePreviewRuntimeState
  ): void {
    this.dependencies.publishState?.(parentOwnerId, { ...state, requestId })
  }
}

export { OfficePreviewOpenSupersededError, OfficePreviewSupervisor }
export type { OfficePreviewFrameProcess, OfficePreviewSupervisorDependencies }

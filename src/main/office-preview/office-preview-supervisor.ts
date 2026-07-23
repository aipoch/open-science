import type {
  OfficePreviewAdmissionError,
  OfficePreviewBounds,
  OfficePreviewHorizontalLayout,
  OfficePreviewOpenRequest,
  OfficePreviewOpenResult,
  OfficePreviewResourceSnapshot,
  OfficePreviewRuntimeResource,
  OfficePreviewRuntimeStart,
  OfficePreviewRuntimeState
} from '../../shared/office-preview'
import { isOfficePreviewBounds, OFFICE_PREVIEW_MAX_FILE_BYTES } from '../../shared/office-preview'
import {
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS
} from '../../shared/office-preview'
import { getOfficePreviewTimeoutMs } from '../../shared/office-preview'

type OfficePreviewChildView = {
  ownerId: number
  start: (message: OfficePreviewRuntimeStart) => Promise<void>
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
  setVisible: (visible: boolean) => void
  close: () => void
  getMemoryUsageBytes?: () => number | Promise<number>
}

type CreateOfficePreviewViewOptions = {
  parentOwnerId: number
  sessionId: string
  onState: (state: OfficePreviewRuntimeState) => void
  onGone: () => Promise<void>
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
  createView: (options: CreateOfficePreviewViewOptions) => OfficePreviewChildView
  createSessionId: () => string
  publishState?: (parentOwnerId: number, state: OfficePreviewRuntimeState) => void
}

type OfficePreviewSession = {
  parentOwnerId: number
  requestId: string
  ready: boolean
  requestedVisible: boolean
  resource: OfficePreviewRuntimeResource
  timeout?: ReturnType<typeof setTimeout>
  memoryPoll?: ReturnType<typeof setInterval>
  memoryPollInFlight?: boolean
  lastAppliedBounds?: OfficePreviewNativeBounds
  lastAppliedVisible: boolean
  lastBoundsSequence: number
  latestOwnerViewport?: OfficePreviewViewport
  layoutReference?: OfficePreviewLayoutReference
  view: OfficePreviewChildView
}

type OfficePreviewNativeBounds = {
  x: number
  y: number
  width: number
  height: number
}

type OfficePreviewViewport = {
  width: number
  height: number
}

type OfficePreviewLayoutReference = {
  bounds: OfficePreviewNativeBounds
  viewport: OfficePreviewViewport
  horizontalLayout?: OfficePreviewHorizontalLayout
}

const normalizeOfficePreviewViewport = (
  viewport: OfficePreviewViewport
): OfficePreviewViewport | undefined => {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return undefined
  }

  return {
    width: Math.max(1, Math.round(viewport.width)),
    height: Math.max(1, Math.round(viewport.height))
  }
}

const areOfficePreviewViewportsEqual = (
  left: OfficePreviewViewport,
  right: OfficePreviewViewport
): boolean => left.width === right.width && left.height === right.height

// Projects the last renderer layout into a newer native viewport without accumulating resize drift.
const projectOfficePreviewBounds = (
  reference: OfficePreviewLayoutReference,
  viewport: OfficePreviewViewport
): OfficePreviewNativeBounds => {
  const rightInset = reference.viewport.width - (reference.bounds.x + reference.bounds.width)
  const bottomInset = reference.viewport.height - (reference.bounds.y + reference.bounds.height)
  let x: number
  let right: number

  if (reference.horizontalLayout && reference.horizontalLayout.splitGroupWidth > 0) {
    const layout = reference.horizontalLayout
    const splitGroupRightInset =
      reference.viewport.width - (layout.splitGroupX + layout.splitGroupWidth)
    const targetSplitGroupWidth = Math.max(
      0,
      viewport.width - splitGroupRightInset - layout.splitGroupX
    )
    const panelLeftRatio = (layout.panelX - layout.splitGroupX) / layout.splitGroupWidth
    const panelRightRatio =
      (layout.panelX + layout.panelWidth - layout.splitGroupX) / layout.splitGroupWidth
    const hostLeftInset = reference.bounds.x - layout.panelX
    const hostRightInset =
      layout.panelX + layout.panelWidth - (reference.bounds.x + reference.bounds.width)

    x = Math.round(layout.splitGroupX + targetSplitGroupWidth * panelLeftRatio + hostLeftInset)
    right = Math.round(
      layout.splitGroupX + targetSplitGroupWidth * panelRightRatio - hostRightInset
    )
  } else {
    const horizontalScale = viewport.width / reference.viewport.width
    x = Math.round(reference.bounds.x * horizontalScale)
    right = Math.round(viewport.width - rightInset)
  }

  const bottom = Math.round(viewport.height - bottomInset)
  return {
    x,
    y: reference.bounds.y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - reference.bounds.y)
  }
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

    // Reject from authoritative metadata before allocating any preview execution environment.
    const resource = await this.dependencies.inspectResource(request)
    assertCurrentGeneration()
    if (resource.size > OFFICE_PREVIEW_MAX_FILE_BYTES) {
      return {
        kind: 'unavailable',
        reason: 'FILE_TOO_LARGE',
        size: resource.size,
        limit: OFFICE_PREVIEW_MAX_FILE_BYTES
      }
    }

    const sessionId = this.dependencies.createSessionId()
    const view = this.dependencies.createView({
      parentOwnerId,
      sessionId,
      onState: (state) => {
        const session = this.sessions.get(sessionId)
        if (!session || state.sessionId !== sessionId) return

        if (state.phase === 'ready') {
          session.ready = true
          if (session.timeout) clearTimeout(session.timeout)
          session.timeout = undefined
          session.view.setVisible(session.requestedVisible)
          session.lastAppliedVisible = session.requestedVisible
        }
        this.publishState(parentOwnerId, request.requestId, state)
        if (state.phase === 'error') void this.close(parentOwnerId, sessionId)
      },
      onGone: async () => {
        if (!this.sessions.has(sessionId)) return

        this.publishState(parentOwnerId, request.requestId, {
          sessionId,
          phase: 'error',
          error: 'PREVIEW_PROCESS_CRASHED'
        })
        await this.close(parentOwnerId, sessionId)
      }
    })
    view.setVisible(false)

    let acquired: OfficePreviewRuntimeResource | undefined
    let sessionRegistered = false
    try {
      acquired = await this.dependencies.acquireResource(
        view.ownerId,
        request,
        resource,
        OFFICE_PREVIEW_MAX_FILE_BYTES
      )
      assertCurrentGeneration()
      const session: OfficePreviewSession = {
        parentOwnerId,
        requestId: request.requestId,
        ready: false,
        requestedVisible: true,
        lastAppliedVisible: false,
        lastBoundsSequence: 0,
        resource: acquired,
        view
      }
      this.sessions.set(sessionId, session)
      sessionRegistered = true
      this.activeSessionByParent.set(parentOwnerId, sessionId)
      this.publishState(parentOwnerId, request.requestId, {
        sessionId,
        phase: 'starting',
        title: 'Starting Office preview'
      })
      session.timeout = setTimeout(
        () => {
          const active = this.sessions.get(sessionId)
          if (!active || active.ready) return

          this.publishState(parentOwnerId, request.requestId, {
            sessionId,
            phase: 'error',
            error: 'PREVIEW_TIMEOUT'
          })
          void this.close(parentOwnerId, sessionId)
        },
        getOfficePreviewTimeoutMs(resource.size, request.attempt)
      )
      if (view.getMemoryUsageBytes) {
        session.memoryPoll = setInterval(() => {
          void this.checkMemoryUsage(sessionId)
        }, OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)
      }
      await view.start({
        sessionId,
        resource: acquired,
        extension: request.extension,
        name: request.name,
        attempt: request.attempt
      })
      assertCurrentGeneration()
    } catch (error) {
      const session = this.sessions.get(sessionId)
      if (session) {
        await this.close(parentOwnerId, sessionId)
      } else if (!sessionRegistered) {
        view.close()
        if (acquired) await this.dependencies.releaseResource(view.ownerId, acquired.id)
      }
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

    return {
      kind: 'started',
      sessionId,
      size: resource.size,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    }
  }

  async close(parentOwnerId: number, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.parentOwnerId !== parentOwnerId) return

    // Delete first so concurrent teardown paths cannot dispose the same process or capability twice.
    this.sessions.delete(sessionId)
    if (this.activeSessionByParent.get(parentOwnerId) === sessionId) {
      this.activeSessionByParent.delete(parentOwnerId)
    }
    if (session.timeout) clearTimeout(session.timeout)
    if (session.memoryPoll) clearInterval(session.memoryPoll)
    try {
      try {
        session.view.setVisible(false)
      } catch {
        // A crashed renderer can destroy the native view before supervisor cleanup runs.
      }
      try {
        session.view.close()
      } catch {
        // Capability release remains mandatory even when the native view is already gone.
      }
    } finally {
      await this.dependencies.releaseResource(session.view.ownerId, session.resource.id)
    }
  }

  async closeOwner(parentOwnerId: number): Promise<void> {
    this.openGenerationByParent.set(parentOwnerId, ++this.nextOpenGeneration)
    const ownedSessionIds = [...this.sessions.entries()]
      .filter(([, session]) => session.parentOwnerId === parentOwnerId)
      .map(([sessionId]) => sessionId)
    await Promise.all(ownedSessionIds.map((sessionId) => this.close(parentOwnerId, sessionId)))
  }

  private async checkMemoryUsage(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.view.getMemoryUsageBytes || session.memoryPollInFlight) return

    session.memoryPollInFlight = true
    try {
      const memoryUsage = await session.view.getMemoryUsageBytes()
      if (
        this.sessions.get(sessionId) !== session ||
        memoryUsage < OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES
      ) {
        return
      }

      this.publishState(session.parentOwnerId, session.requestId, {
        sessionId,
        phase: 'error',
        error: 'RESOURCE_LIMIT_EXCEEDED'
      })
      await this.close(session.parentOwnerId, sessionId)
    } catch {
      // Process exits are reported through the child-view lifecycle listeners.
    } finally {
      session.memoryPollInFlight = false
    }
  }

  setBounds(parentOwnerId: number, sessionId: string, bounds: OfficePreviewBounds): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.parentOwnerId !== parentOwnerId) return
    if (!isOfficePreviewBounds(bounds) || bounds.sequence <= session.lastBoundsSequence) return

    const normalized: OfficePreviewNativeBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    session.lastBoundsSequence = bounds.sequence
    const layoutReference: OfficePreviewLayoutReference = {
      bounds: normalized,
      viewport: {
        width: Math.max(1, Math.round(bounds.viewportWidth)),
        height: Math.max(1, Math.round(bounds.viewportHeight))
      },
      ...(bounds.horizontalLayout
        ? {
            horizontalLayout: {
              splitGroupX: Math.round(bounds.horizontalLayout.splitGroupX),
              splitGroupWidth: Math.max(0, Math.round(bounds.horizontalLayout.splitGroupWidth)),
              panelX: Math.round(bounds.horizontalLayout.panelX),
              panelWidth: Math.max(0, Math.round(bounds.horizontalLayout.panelWidth))
            }
          }
        : {})
    }
    session.layoutReference = layoutReference
    const requestedVisible = bounds.visible && normalized.width > 0 && normalized.height > 0
    const targetViewport = session.latestOwnerViewport
    this.applyBounds(
      sessionId,
      session,
      targetViewport && !areOfficePreviewViewportsEqual(targetViewport, layoutReference.viewport)
        ? projectOfficePreviewBounds(layoutReference, targetViewport)
        : normalized,
      requestedVisible
    )
  }

  // Keeps the native surface moving while the host renderer is delayed by an OS live-resize loop.
  resizeOwner(parentOwnerId: number, viewport: OfficePreviewViewport): void {
    const sessionId = this.activeSessionByParent.get(parentOwnerId)
    const normalizedViewport = normalizeOfficePreviewViewport(viewport)
    if (!sessionId || !normalizedViewport) return

    const session = this.sessions.get(sessionId)
    if (!session) return

    session.latestOwnerViewport = normalizedViewport
    const reference = session.layoutReference
    if (!reference) return

    this.applyBounds(
      sessionId,
      session,
      projectOfficePreviewBounds(reference, normalizedViewport),
      session.requestedVisible
    )
  }

  private applyBounds(
    sessionId: string,
    session: OfficePreviewSession,
    bounds: OfficePreviewNativeBounds,
    visible: boolean
  ): void {
    try {
      const previous = session.lastAppliedBounds
      if (
        !previous ||
        previous.x !== bounds.x ||
        previous.y !== bounds.y ||
        previous.width !== bounds.width ||
        previous.height !== bounds.height
      ) {
        session.view.setBounds(bounds)
        session.lastAppliedBounds = bounds
      }

      session.requestedVisible = visible
      if (session.lastAppliedVisible === visible) return

      // Frame-based Office renderers remain drawable before ready so their first paint cannot stall.
      session.view.setVisible(visible)
      session.lastAppliedVisible = visible
    } catch {
      this.publishState(session.parentOwnerId, session.requestId, {
        sessionId,
        phase: 'error',
        error: 'RENDER_FAILED'
      })
      void this.close(session.parentOwnerId, sessionId)
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
export type {
  CreateOfficePreviewViewOptions,
  OfficePreviewChildView,
  OfficePreviewViewport,
  OfficePreviewSupervisorDependencies
}

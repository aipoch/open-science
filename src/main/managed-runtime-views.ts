import type { RuntimeViewAccess, RuntimeViewDescriptor } from '../shared/runtime-view'
import type { ManagedServiceRegistration } from './notebook/managed-execution-service'
import { OwnedRuntimeViewService } from './runtime-view/owned-service'
import { RuntimeViewOwner } from './runtime-view/owner'

type RunScope = { projectId: string; sessionId: string; runId: string }
type Registration = {
  source: ManagedServiceRegistration
  lifetime: AbortController
  service?: Promise<OwnedRuntimeViewService>
  closed: boolean
  onAbort(): void
}
const keyOf = (scope: RunScope): string =>
  JSON.stringify([scope.projectId, scope.sessionId, scope.runId])

/** Composition bridge only: the existing environment/Notebook still owns the process and socket. */
export class ManagedRuntimeViews {
  private readonly registrations = new Map<string, Registration>()
  private readonly viewers = new Map<string, { key: string; access: RuntimeViewAccess }>()
  // Keep the generation binding even after startup failure or Run termination. An existing
  // observation must not silently reconnect to a replacement process with the same Run key.
  private readonly bindings = new Map<string, { key: string; registration: Registration }>()
  private readonly pending = new Map<
    string,
    {
      result: Promise<RuntimeViewAccess>
      lifetime: AbortController
    }
  >()
  private closed = false

  constructor(private readonly views = new RuntimeViewOwner()) {}

  register(source: ManagedServiceRegistration): () => void {
    if (this.closed || this.registrations.has(keyOf(source.scope)))
      throw new Error('The project service registration is unavailable or already owned.')
    source.signal.throwIfAborted()
    const lifetime = new AbortController()
    const key = keyOf(source.scope)
    const registration: Registration = {
      source: {
        ...source,
        scope: { ...source.scope },
        declaration: structuredClone(source.declaration),
        proof: { ...source.proof }
      },
      lifetime,
      closed: false,
      onAbort: () => unregister()
    }
    const unregister = (): void => {
      if (registration.closed) return
      registration.closed = true
      lifetime.abort(new Error('The owning execution has ended.'))
      source.signal.removeEventListener('abort', registration.onAbort)
      if (this.registrations.get(key) === registration) this.registrations.delete(key)
      for (const [viewerId, view] of this.viewers) {
        if (view.key === key) {
          this.views.revoke(view.access.view.viewId, view.access.view.scope)
          this.viewers.delete(viewerId)
        }
      }
      void registration.service?.then(
        (service) => service.close(),
        () => undefined
      )
    }
    this.registrations.set(key, registration)
    source.signal.addEventListener('abort', registration.onAbort, { once: true })
    if (source.signal.aborted) unregister()
    return unregister
  }

  describe(scope: RunScope): RuntimeViewDescriptor[] {
    return this.views.list(scope)
  }

  async open(
    scope: RunScope,
    viewerId: string,
    parents: readonly string[],
    cookiePolicy: 'strict' | 'partitioned' = 'strict',
    assertAuthorized: () => void = () => undefined
  ): Promise<RuntimeViewAccess> {
    assertAuthorized()
    if (!viewerId || viewerId.length > 200 || this.closed)
      throw new Error('The viewer is unavailable.')
    const key = keyOf(scope)
    const binding = this.bindings.get(viewerId)
    if (binding) {
      if (binding.key !== key) throw new Error('The viewer belongs to another execution.')
      if (binding.registration.closed || this.registrations.get(key) !== binding.registration)
        throw new Error('The project service generation is no longer current.')
    }
    const previous = this.viewers.get(viewerId)
    if (previous) {
      if (previous.key !== key) throw new Error('The viewer belongs to another execution.')
      return this.views.issueAccess(previous.access.view.viewId, previous.access.view.scope)
    }
    const pending = this.pending.get(viewerId)
    if (pending) {
      const access = await pending.result
      if (keyOf(access.view.scope) !== key)
        throw new Error('The viewer belongs to another execution.')
      return access
    }
    const registration = this.registrations.get(key)
    if (!registration || registration.closed) throw new Error('The project service is not active.')
    this.bindings.set(viewerId, { key, registration })
    const assertCurrent = (): void => {
      registration.lifetime.signal.throwIfAborted()
      if (this.closed || this.registrations.get(key) !== registration)
        throw new Error('The project service generation is no longer current.')
    }
    const viewerLifetime = new AbortController()
    const assertViewer = (): void => {
      assertCurrent()
      viewerLifetime.signal.throwIfAborted()
      assertAuthorized()
    }
    const opening = (async (): Promise<RuntimeViewAccess> => {
      const source = registration.source
      registration.service ??= OwnedRuntimeViewService.open({
        scope: source.scope,
        socketPath: source.socketPath,
        expectedProof: source.proof.value,
        proofPath: source.proof.path,
        upstreamOrigin: `http://127.0.0.1:${source.logicalPort}`,
        signal: registration.lifetime.signal,
        assertCurrent
      }).catch((error) => {
        // A viewer can arrive before the already-admitted process binds its socket. Retry only
        // the same registered generation; opening a view never starts or repeats execution.
        registration.service = undefined
        throw error
      })
      const service = await registration.service
      assertViewer()
      const access = await this.views.open({
        ...source.declaration,
        scope: source.scope,
        service,
        allowedParentOrigins: parents,
        cookiePolicy,
        assertAuthorized: assertViewer
      })
      try {
        assertViewer()
      } catch (error) {
        this.views.revoke(access.view.viewId, access.view.scope)
        throw error
      }
      this.viewers.set(viewerId, { key, access })
      return access
    })()
    const pendingView = { result: opening, lifetime: viewerLifetime }
    this.pending.set(viewerId, pendingView)
    try {
      return await opening
    } finally {
      if (this.pending.get(viewerId) === pendingView) this.pending.delete(viewerId)
    }
  }

  closeViewer(viewerId: string): void {
    this.pending.get(viewerId)?.lifetime.abort(new Error('The viewer was closed.'))
    this.pending.delete(viewerId)
    this.bindings.delete(viewerId)
    const view = this.viewers.get(viewerId)
    if (!view) return
    this.views.revoke(view.access.view.viewId, view.access.view.scope)
    this.viewers.delete(viewerId)
  }

  close(): void {
    this.closed = true
    for (const registration of [...this.registrations.values()]) registration.onAbort()
    for (const pending of this.pending.values()) pending.lifetime.abort()
    this.pending.clear()
    this.bindings.clear()
    this.viewers.clear()
    this.views.close()
  }
}

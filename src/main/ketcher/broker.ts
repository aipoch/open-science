import type {
  KetcherCommandOp,
  KetcherCommandPayload,
  KetcherOpenTile,
  KetcherReply
} from '../../shared/ketcher'

type KetcherBrokerDeps = {
  // Sends one payload to the renderer(s) that host sketcher tiles (main -> renderer push).
  send: (channel: string, payload: unknown) => void
  // Injectable so tests are deterministic; defaults to crypto.randomUUID in the factory below.
  generateId: () => string
  // How long a dispatched command waits for the tile's reply before it is rejected.
  timeoutMs?: number
  // How long open_sketcher waits for a freshly-opened tile to announce it mounted.
  mountTimeoutMs?: number
  // Injectable timers for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

type PendingCommand = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type MountWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Bridges the main-process Ketcher tool host to live renderer tiles, modelled on ApprovalBroker: it
// tracks which artifacts have a mounted tile, holds a dispatched command open until the tile replies
// (rejecting on timeout so a tool call never hangs the kernel), and lets open_sketcher wait for a tile
// to mount before it returns.
export class KetcherBroker {
  private readonly pending = new Map<string, PendingCommand>()
  private readonly mounted = new Set<string>()
  private readonly mountWaiters = new Map<string, MountWaiter[]>()
  private readonly timeoutMs: number
  private readonly mountTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: KetcherBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 30_000
    this.mountTimeoutMs = deps.mountTimeoutMs ?? 15_000
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  }

  // Records a tile as mounted and releases any open_sketcher call waiting for it.
  mount(artifactId: string): void {
    this.mounted.add(artifactId)

    const waiters = this.mountWaiters.get(artifactId)
    if (!waiters) return

    this.mountWaiters.delete(artifactId)
    for (const waiter of waiters) {
      this.clearTimer(waiter.timer)
      waiter.resolve()
    }
  }

  // Forgets a tile that unmounted so later commands fail fast with "tile not mounted".
  unmount(artifactId: string): void {
    this.mounted.delete(artifactId)
  }

  isMounted(artifactId: string): boolean {
    return this.mounted.has(artifactId)
  }

  // Asks the renderer to open (or refocus) an editable tile for a freshly written artifact.
  openTile(payload: KetcherOpenTile): void {
    this.deps.send('ketcher:open', payload)
  }

  // Resolves once a tile for the artifact is mounted (immediately if it already is), or rejects on timeout.
  waitForMount(artifactId: string): Promise<void> {
    if (this.mounted.has(artifactId)) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.removeMountWaiter(artifactId, waiter)
        reject(new Error(`Ketcher tile did not mount: ${artifactId}`))
      }, this.mountTimeoutMs)
      const waiter: MountWaiter = { resolve, reject, timer }
      const waiters = this.mountWaiters.get(artifactId) ?? []
      waiters.push(waiter)
      this.mountWaiters.set(artifactId, waiters)
    })
  }

  // Sends one imperative command to the mounted tile and resolves with its reply (or rejects on timeout).
  dispatch(
    artifactId: string,
    op: KetcherCommandOp,
    payload: KetcherCommandPayload
  ): Promise<unknown> {
    if (!this.mounted.has(artifactId)) {
      return Promise.reject(
        new Error(`Ketcher tile not mounted for artifact ${artifactId}. Open a sketcher first.`)
      )
    }

    const requestId = this.deps.generateId()

    return new Promise<unknown>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestId)
        reject(new Error(`Ketcher command timed out: ${op} on ${artifactId}`))
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      this.deps.send('ketcher:command', { requestId, artifactId, op, payload })
    })
  }

  // Called from the IPC handler when a tile answers a command. Unknown ids are ignored (already settled).
  reply(reply: KetcherReply): void {
    const entry = this.pending.get(reply.requestId)
    if (!entry) return

    this.clearTimer(entry.timer)
    this.pending.delete(reply.requestId)

    if (reply.error) entry.reject(new Error(reply.error))
    else entry.resolve(reply.result)
  }

  private removeMountWaiter(artifactId: string, waiter: MountWaiter): void {
    const waiters = this.mountWaiters.get(artifactId)
    if (!waiters) return

    const next = waiters.filter((candidate) => candidate !== waiter)
    if (next.length === 0) this.mountWaiters.delete(artifactId)
    else this.mountWaiters.set(artifactId, next)
  }
}

import type { RuntimeWriterLease } from '../../../../shared/runtime-writer'

// Only the elected renderer projects raw runtime events into durable Session state. Other windows
// receive session:updated snapshots. Explicit user commands continue to use their ordinary APIs.
export class RuntimeWriterClient {
  private lease?: RuntimeWriterLease
  private deadline = 0
  private checkedAt = -Infinity
  private pending?: Promise<boolean>
  constructor(
    private readonly claim: () => Promise<RuntimeWriterLease>,
    private readonly now = () => performance.now()
  ) {}
  get token(): string | undefined {
    return this.now() < this.deadline ? this.lease?.token : undefined
  }
  async ensure(): Promise<boolean> {
    if (this.pending) return this.pending
    if (this.now() - this.checkedAt < 4_000) return Boolean(this.token)
    this.pending = (async () => {
      const started = this.now()
      try {
        const lease = await this.claim()
        this.lease = lease
        // Count request transit against the lease; never extend host authority by network latency.
        this.deadline = started + Math.max(0, lease.validForMs - 1_000)
        this.checkedAt = this.now()
      } catch {
        this.lease = undefined
        this.deadline = 0
      }
      return Boolean(this.token)
    })().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
}
let activate: (() => Promise<void>) | undefined
let activatedToken: string | undefined
let activation: Promise<void> | undefined
export const setRuntimeWriterActivation = (callback: () => Promise<void>): void => {
  activate = callback
}
let client: RuntimeWriterClient | undefined
const getClient = (): RuntimeWriterClient | undefined => {
  if (typeof window === 'undefined' || !window.api?.lifecycle?.claimRuntimeWriter) return undefined
  return (client ??= new RuntimeWriterClient(() => window.api.lifecycle.claimRuntimeWriter()))
}
export const ensureRuntimeWriter = async (): Promise<boolean> => {
  const c = getClient()
  if (!c) return true
  if (!(await c.ensure())) return false
  if (c.token !== activatedToken && !activation) {
    const token = c.token
    activation = (async () => {
      await activate?.()
      activatedToken = token
    })().finally(() => {
      activation = undefined
    })
  }
  try {
    if (activation) await activation
  } catch {
    // Stay read-only if refreshing durable authority failed; the next claim can retry.
    return false
  }
  return c.token !== undefined && c.token === activatedToken
}
export const isRuntimeWriter = (): boolean => {
  const c = getClient()
  return c ? Boolean(c.token && c.token === activatedToken) : true
}
export const runtimeWriterSaveOptions = (): { runtimeWriterToken: string } | undefined => {
  const token = isRuntimeWriter() ? getClient()?.token : undefined
  return token ? { runtimeWriterToken: token } : undefined
}

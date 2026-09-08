import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'

import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

const FILE_NAME = 'wsl-setup-sessions.json'
const TOKEN_TTL_MS = 30 * 60_000

type StoredDocument = Readonly<{ version: 1; sessionIds: readonly string[] }>

const isValidSessionId = (sessionId: unknown): sessionId is string =>
  typeof sessionId === 'string' &&
  sessionId.length > 0 &&
  sessionId.length <= 512 &&
  !/[\0\r\n]/u.test(sessionId)

const decode = (contents: string): StoredDocument => {
  const value = JSON.parse(contents) as Partial<StoredDocument>
  if (
    value.version !== 1 ||
    !Array.isArray(value.sessionIds) ||
    value.sessionIds.some((sessionId) => !isValidSessionId(sessionId))
  ) {
    throw new Error('Invalid WSL setup Session document.')
  }
  return Object.freeze({ version: 1, sessionIds: Object.freeze([...new Set(value.sessionIds)]) })
}

type PendingToken = Readonly<{ digest: Buffer; expiresAt: number; preparedSessionId?: string }>

/** Owns the local-only, durable authority boundary for conversational WSL setup. */
class WslSetupSessionOwner {
  private readonly path: string
  private readonly pending = new Map<string, PendingToken>()
  private loaded?: Promise<Set<string>>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    configRoot: string,
    private readonly options: Readonly<{ now?: () => number; platform?: NodeJS.Platform }> = {}
  ) {
    this.path = join(configRoot, FILE_NAME)
  }

  mintLocalToken(): string {
    if ((this.options.platform ?? process.platform) !== 'win32') {
      throw new Error('WSL setup Sessions are only available on Windows.')
    }
    this.pruneExpired()
    const id = randomBytes(12).toString('hex')
    const secret = randomBytes(32).toString('base64url')
    this.pending.set(id, {
      digest: this.digest(secret),
      expiresAt: this.now() + TOKEN_TTL_MS
    })
    return `${id}.${secret}`
  }

  authorizeToken(token: unknown): boolean {
    const match = this.matchingPendingToken(token)
    return Boolean(match && !match.pending.preparedSessionId)
  }

  async bind(token: string, sessionId: string): Promise<void> {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid WSL setup Session id.')
    if (!this.authorizeToken(token)) throw new Error('WSL_SETUP_SESSION_TOKEN_INVALID')
    const id = token.slice(0, token.indexOf('.'))
    await this.enqueue(async () => {
      const match = this.matchingPendingToken(token)
      if (!match || match.pending.preparedSessionId) {
        throw new Error('WSL_SETUP_SESSION_TOKEN_INVALID')
      }
      const prepared = Object.freeze({ ...match.pending, preparedSessionId: sessionId })
      this.pending.set(id, prepared)
      try {
        const sessions = new Set(await this.sessions())
        sessions.add(sessionId)
        await this.persist(sessions)
        this.loaded = Promise.resolve(sessions)
      } catch (error) {
        if (match.pending.expiresAt > this.now()) this.pending.set(id, match.pending)
        else this.pending.delete(id)
        throw error
      }
    })
  }

  commitBinding(token: string, sessionId: string): void {
    const match = this.matchingPendingToken(token)
    if (!match || match.pending.preparedSessionId !== sessionId) return
    this.pending.delete(match.id)
  }

  async rollbackBinding(token: string, sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const match = this.matchingPendingToken(token)
      if (!match || match.pending.preparedSessionId !== sessionId) return
      const sessions = new Set(await this.sessions())
      sessions.delete(sessionId)
      await this.persist(sessions)
      this.loaded = Promise.resolve(sessions)
      if (match.pending.expiresAt > this.now()) {
        this.pending.set(match.id, {
          digest: match.pending.digest,
          expiresAt: match.pending.expiresAt
        })
      } else {
        this.pending.delete(match.id)
      }
    })
  }

  async isBound(sessionId: string): Promise<boolean> {
    if ((this.options.platform ?? process.platform) !== 'win32') return false
    return (await this.sessions()).has(sessionId)
  }

  async forget(sessionId: string): Promise<void> {
    await this.enqueue(async () => {
      const sessions = new Set(await this.sessions())
      if (!sessions.delete(sessionId)) return
      await this.persist(sessions)
      this.loaded = Promise.resolve(sessions)
    })
  }

  async reconcileBoundSessions(existingSessionIds: ReadonlySet<string>): Promise<void> {
    await this.enqueue(async () => {
      const sessions = new Set(await this.sessions())
      const retained = new Set(
        [...sessions].filter((sessionId) => existingSessionIds.has(sessionId))
      )
      if (retained.size === sessions.size) return
      await this.persist(retained)
      this.loaded = Promise.resolve(retained)
    })
  }

  private sessions(): Promise<Set<string>> {
    this.loaded ??= readDurableJsonFile(this.path, decode, {}, { maxBytes: 64 * 1024 }).then(
      (result) => new Set(result.status === 'found' ? result.value.sessionIds : [])
    )
    return this.loaded
  }

  private persist(sessionIds: Set<string>): Promise<void> {
    return writeDurableJsonFile(
      this.path,
      `${JSON.stringify({ version: 1, sessionIds: [...sessionIds].sort() }, null, 2)}\n`
    )
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.catch(() => undefined)
    return result
  }

  private digest(secret: string): Buffer {
    return createHash('sha256').update(secret).digest()
  }

  private matchingPendingToken(
    token: unknown
  ): Readonly<{ id: string; pending: PendingToken }> | undefined {
    if ((this.options.platform ?? process.platform) !== 'win32' || typeof token !== 'string') {
      return undefined
    }
    this.pruneExpired()
    const separator = token.indexOf('.')
    if (separator < 1) return undefined
    const id = token.slice(0, separator)
    const secret = token.slice(separator + 1)
    const pending = this.pending.get(id)
    if (!pending || (pending.expiresAt <= this.now() && !pending.preparedSessionId))
      return undefined
    const actual = this.digest(secret)
    return actual.length === pending.digest.length && timingSafeEqual(actual, pending.digest)
      ? { id, pending }
      : undefined
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [id, token] of this.pending) {
      if (token.expiresAt <= now && !token.preparedSessionId) this.pending.delete(id)
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

export { WslSetupSessionOwner }
export { TOKEN_TTL_MS as WSL_SETUP_SESSION_TOKEN_TTL_MS }

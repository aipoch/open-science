import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export type PairTokenMode = 'lan' | 'pinggy'
export type PairOffer = { token: string; password?: string; expiresAt: number }

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

export class PairTokenManager {
  private current?: {
    hash: Buffer
    passwordHash?: Buffer
    expiresAt: number
    failures: number
    mode: PairTokenMode
  }

  constructor(private readonly now: () => number = Date.now) {}

  issue(mode: PairTokenMode, ttlMs: number): PairOffer {
    const token = randomBytes(32).toString('base64url')
    const password =
      mode === 'pinggy' ? randomInt(0, 1_000_000).toString().padStart(6, '0') : undefined
    const expiresAt = this.now() + ttlMs
    this.current = {
      hash: digest(token),
      passwordHash: password ? digest(password) : undefined,
      expiresAt,
      failures: 0,
      mode
    }
    return { token, password, expiresAt }
  }

  matches(token: string, mode: PairTokenMode): boolean {
    const current = this.current
    if (!current || current.mode !== mode || current.expiresAt <= this.now() || token.length > 256)
      return false
    return timingSafeEqual(digest(token), current.hash)
  }

  verifyPassword(token: string, password: string): 'valid' | 'invalid' | 'expired' {
    if (!this.matches(token, 'pinggy')) return 'expired'
    const current = this.current!
    if (/^\d{6}$/.test(password) && timingSafeEqual(digest(password), current.passwordHash!))
      return 'valid'
    current.failures += 1
    if (current.failures >= 5) {
      this.current = undefined
      return 'expired'
    }
    return 'invalid'
  }

  consume(token: string, mode: PairTokenMode): boolean {
    if (!this.matches(token, mode)) return false
    this.current = undefined
    return true
  }

  clear(): void {
    this.current = undefined
  }
}

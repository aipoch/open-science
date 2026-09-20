import { randomUUID } from 'node:crypto'
import {
  RUNTIME_WRITER_LEASE_MS,
  RUNTIME_WRITER_LOST,
  type RuntimeWriterLease
} from '../../shared/runtime-writer'
import { ApplicationCommandError } from '../../shared/application-command-contract'

// A stale client cannot commit after a successor is elected. In-flight writes pin ownership until
// their durable commit finishes, so expiration never permits two writers inside a repository call.
export class RuntimeWriterOwner {
  private owner?: { clientId: string; token: string; expiresAt: number }
  private writes = 0
  constructor(
    private readonly now = Date.now,
    private readonly createToken = randomUUID,
    private readonly isLocalWriterAlive: (clientId: string) => boolean | undefined = () => undefined
  ) {}
  claim(clientId: string): RuntimeWriterLease {
    const alive = this.owner && this.isLocalWriterAlive(this.owner.clientId)
    if (
      !this.owner ||
      ((alive === false || (alive !== true && this.owner.expiresAt <= this.now())) &&
        this.writes === 0)
    ) {
      this.owner = {
        clientId,
        token: this.createToken(),
        expiresAt: this.now() + RUNTIME_WRITER_LEASE_MS
      }
    }
    if (this.owner.clientId !== clientId) return { validForMs: 4_000 }
    this.owner.expiresAt = this.now() + RUNTIME_WRITER_LEASE_MS
    return { token: this.owner.token, validForMs: RUNTIME_WRITER_LEASE_MS }
  }
  async commit<T>(clientId: string, token: string, run: () => Promise<T>): Promise<T> {
    if (
      !this.owner ||
      this.owner.clientId !== clientId ||
      this.owner.token !== token ||
      (this.isLocalWriterAlive(clientId) !== true && this.owner.expiresAt <= this.now())
    ) {
      throw new ApplicationCommandError(RUNTIME_WRITER_LOST, 'Runtime projection writer changed.')
    }
    this.writes++
    try {
      return await run()
    } finally {
      this.writes--
    }
  }
}

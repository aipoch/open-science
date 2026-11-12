import { readdir, readFile, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createJournalAgentStore } from '@aipoch/agent-harness'
import { harnessOwnerSchema } from './config'
import { HarnessToolReceipts } from './tool-receipts'

const services = [
  'notebook',
  'artifact',
  'skill-import',
  'plan',
  'host-message',
  'literature',
  'library',
  'skills'
] as const
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Runs after authoritative deletion; bindings remain the retry ledger until every store is clean. */
export class HarnessStorageCleanup {
  private readonly startupCutoff = Date.now()
  private initialCatalogObserved = false
  private tail: Promise<void> = Promise.resolve()

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work)
    this.tail = next.catch(() => undefined)
    return next
  }
  private readonly pending = new Set<string>()

  constructor(
    private readonly options: {
      sessionDirectory: string
      receiptDirectory(): string
      isLive(projectId: string, sessionId: string): boolean
      tryClaimIdentities(sessionIds: readonly string[]): (() => void) | undefined
    }
  ) {}

  private async bindings(): Promise<
    { providerId: string; projectId: string; sessionId: string }[]
  > {
    const names = await readdir(this.options.sessionDirectory).catch((error) => {
      if (missing(error)) return []
      throw error
    })
    const result: { providerId: string; projectId: string; sessionId: string }[] = []
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const value = await readFile(join(this.options.sessionDirectory, name), 'utf8').catch(
        (error) => {
          if (missing(error)) return undefined
          throw error
        }
      )
      if (value === undefined) continue
      const binding = JSON.parse(value)
      // Legacy bindings have only cwd; absence is not proof of who owns their history.
      if (binding.owner === undefined) continue
      const owner = harnessOwnerSchema.parse(binding.owner)
      if (!owner.sessionId) throw new Error('Missing built-in Agent storage owner')
      result.push({ providerId: name.slice(0, -5), ...owner, sessionId: owner.sessionId })
    }
    return result
  }

  async commit(sessionIds: readonly string[]): Promise<void> {
    for (const id of sessionIds) this.pending.add(id)
    await this.serialize(() => this.drain())
  }

  async reconcile(existingSessionIds: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      if (!this.initialCatalogObserved) {
        const existing = new Set(existingSessionIds)
        for (const binding of await this.bindings()) {
          if (
            !existing.has(binding.sessionId) &&
            !this.options.isLive(binding.projectId, binding.sessionId)
          )
            this.pending.add(binding.sessionId)
        }
        // Later catalog reads can overlap provisional Session creation; only retry captured deletions.
        this.initialCatalogObserved = true
      }
      await this.drain()
    })
  }

  async planReconciliation(
    existingSessionIds: readonly string[]
  ): Promise<Array<{ projectId: string; sessionId: string; apply(): Promise<void> }>> {
    const existing = new Set(existingSessionIds)
    const candidates = new Map<
      string,
      {
        projectId: string
        sessionId: string
        bindings: Awaited<ReturnType<HarnessStorageCleanup['bindings']>>
        proofs: Array<() => Promise<void>>
      }
    >()
    for (const binding of await this.bindings()) {
      if (
        existing.has(binding.sessionId) ||
        this.options.isLive(binding.projectId, binding.sessionId)
      )
        continue
      const path = join(this.options.sessionDirectory, `${binding.providerId}.json`)
      const before = await lstat(path)
      // A provisional binding created after startup is not evidence of committed deletion.
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.mtimeMs >= this.startupCutoff ||
        before.ctimeMs >= this.startupCutoff
      )
        continue
      const recorded = JSON.parse(await readFile(path, 'utf8'))
      const owner = harnessOwnerSchema.parse(recorded.owner)
      const verified = await lstat(path)
      if (
        owner.projectId !== binding.projectId ||
        owner.sessionId !== binding.sessionId ||
        verified.mtimeMs !== before.mtimeMs ||
        verified.ctimeMs !== before.ctimeMs ||
        verified.ino !== before.ino
      )
        continue
      const key = JSON.stringify([binding.projectId, binding.sessionId])
      const candidate = candidates.get(key) ?? { ...binding, bindings: [], proofs: [] }
      candidate.bindings.push(binding)
      candidate.proofs.push(async () => {
        const current = await lstat(path)
        if (
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs
        )
          throw new Error('Built-in Agent cleanup ownership changed')
      })
      candidates.set(key, candidate)
    }
    return [...candidates.values()].map(({ projectId, sessionId, bindings, proofs }) => ({
      projectId,
      sessionId,
      apply: () =>
        this.serialize(async () => {
          const release = this.options.tryClaimIdentities([
            sessionId,
            ...bindings.map((binding) => binding.providerId)
          ])
          if (!release) throw new Error('Built-in Agent cleanup is waiting for Session admission')
          try {
            const current = (await this.bindings()).filter(
              (binding) => binding.projectId === projectId && binding.sessionId === sessionId
            )
            const providers = new Set(bindings.map((binding) => binding.providerId))
            if (
              current.length !== providers.size ||
              current.some((binding) => !providers.has(binding.providerId))
            )
              throw new Error('Built-in Agent cleanup provider ownership changed')
            for (const proof of proofs) await proof()
            this.pending.add(sessionId)
            await this.drain(bindings, [sessionId])
          } finally {
            release()
          }
        })
    }))
  }

  private async drain(
    knownBindings?: Awaited<ReturnType<HarnessStorageCleanup['bindings']>>,
    sessionIds: Iterable<string> = this.pending
  ): Promise<void> {
    const bindings = knownBindings ?? (await this.bindings())
    const store = createJournalAgentStore({
      directory: join(this.options.sessionDirectory, 'checkpoints'),
      lockTimeoutMs: 100
    })
    const receipts = new HarnessToolReceipts(this.options.receiptDirectory())
    for (const sessionId of sessionIds) {
      const owned = bindings.filter((binding) => binding.sessionId === sessionId)
      if (owned.some((binding) => this.options.isLive(binding.projectId, sessionId)))
        throw new Error('Cannot delete built-in Agent storage while its Session is live')
      for (const { projectId } of owned) {
        for (const service of services)
          await receipts.deleteScope(JSON.stringify([projectId, sessionId, service]))
      }
      for (const { providerId } of owned) await store.delete(providerId)
      for (const { providerId } of owned)
        await rm(join(this.options.sessionDirectory, `${providerId}.json`), { force: true })
      this.pending.delete(sessionId)
    }
  }
}

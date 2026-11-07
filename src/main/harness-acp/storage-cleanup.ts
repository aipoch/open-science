import { readdir, readFile, rm } from 'node:fs/promises'
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

  private async drain(): Promise<void> {
    const bindings = await this.bindings()
    const store = createJournalAgentStore({
      directory: join(this.options.sessionDirectory, 'checkpoints'),
      lockTimeoutMs: 100
    })
    const receipts = new HarnessToolReceipts(this.options.receiptDirectory())
    for (const sessionId of this.pending) {
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

import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'

// One owner-level mutex per writable Skill root. Repository instances and package adapters are
// composed independently, so an instance-local queue cannot serialize their shared filesystem.
export class SkillMutationOwner {
  private tail: Promise<void> = Promise.resolve()
  private readonly context = new AsyncLocalStorage<SkillMutationOwner>()

  isHeldByCurrentContext(): boolean {
    return this.context.getStore() === this
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Guards are allowed to inspect the catalog through the same repository while already holding
    // the owner lock. Treat that call chain as re-entrant instead of waiting on itself.
    if (this.context.getStore() === this) return operation()

    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolveWaiter) => {
      release = resolveWaiter
    })
    await previous
    try {
      return await this.context.run(this, operation)
    } finally {
      release()
    }
  }

  async acquire(): Promise<() => void> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>((resolveWaiter) => {
      release = resolveWaiter
    })
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  runWithHeldLockContext<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.run(this, operation)
  }
}

const owners = new Map<string, SkillMutationOwner>()

export const skillMutationOwnerFor = (storageRoot: string): SkillMutationOwner => {
  const key = resolve(storageRoot)
  const existing = owners.get(key)
  if (existing) return existing
  const owner = new SkillMutationOwner()
  owners.set(key, owner)
  return owner
}

import type { UseCase } from '../../../../shared/use-cases'

// Keep speculative work bounded even when navigation replaces the gallery owner.
let prefetching = false

// This small renderer cache avoids a loading flash; the native owner handles bounded disk storage.
export class UseCaseIntroductionLoader {
  private readonly cache = new Map<string, { content: string | null; savedAt: number }>()
  private readonly requests = new Map<string, Promise<string | null>>()
  private readonly listeners = new Map<string, Set<(content: string | null) => void>>()
  private hoverTimer?: ReturnType<typeof setTimeout>

  private key(item: UseCase): string {
    return item.introductionUrl ?? item.slug
  }

  peek(item: UseCase): string | null | undefined {
    const cached = this.cache.get(this.key(item))
    if (!cached || Date.now() - cached.savedAt >= 24 * 60 * 60 * 1000) return undefined
    return cached.content
  }

  subscribe(item: UseCase, listener: (content: string | null) => void): () => void {
    const key = this.key(item)
    const listeners = this.listeners.get(key) ?? new Set()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
    }
  }

  // Native refresh has already checked the remote bodies. Re-read only warm entries and
  // leave old content visible on failure; notify open details only when the text changes.
  async refreshCached(items: UseCase[]): Promise<void> {
    const available = new Set(items.map((item) => this.key(item)))
    const warm = items.filter(
      (item) => this.cache.has(this.key(item)) || this.requests.has(this.key(item))
    )
    for (const key of this.cache.keys()) if (!available.has(key)) this.cache.delete(key)
    await Promise.all(
      warm.map(async (item) => {
        await this.requests.get(this.key(item))?.catch(() => undefined)
        await this.request(item).catch(() => undefined)
      })
    )
  }

  load(item: UseCase): Promise<string | null> {
    this.cancelPrefetch()
    const cached = this.peek(item)
    if (cached !== undefined) return Promise.resolve(cached)
    return this.request(item)
  }

  private request(item: UseCase): Promise<string | null> {
    const key = this.key(item)
    const pending = this.requests.get(key)
    if (pending) return pending
    const request = window.api.sessions
      .useCaseIntroduction(item.slug)
      .then((content) => {
        const previous = this.cache.get(key)?.content
        this.cache.delete(key)
        this.cache.set(key, { content, savedAt: Date.now() })
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
        if (previous !== content) this.listeners.get(key)?.forEach((listener) => listener(content))
        return content
      })
      .finally(() => this.requests.delete(key))
    this.requests.set(key, request)
    return request
  }

  cancelPrefetch(): void {
    clearTimeout(this.hoverTimer)
    this.hoverTimer = undefined
  }

  schedulePrefetch(item: UseCase): void {
    this.cancelPrefetch()
    if (!item.introductionUrl || prefetching || this.peek(item) !== undefined) return
    // A brief pass over a card does no work. Only one speculative request runs at a time;
    // explicit clicks can still load another case immediately rather than queue behind it.
    this.hoverTimer = setTimeout(() => {
      prefetching = true
      void this.load(item)
        .catch(() => undefined)
        .finally(() => {
          prefetching = false
        })
    }, 250)
  }
}

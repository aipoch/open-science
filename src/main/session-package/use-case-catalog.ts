import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseUseCases, USE_CASE_MANIFEST_URL, type UseCase } from '../../shared/use-cases'

const INTRODUCTION_MAX_BYTES = 1024 * 1024
const INTRODUCTION_CACHE_LIMIT = 32
const INTRODUCTION_CACHE_AGE = 24 * 60 * 60 * 1000

// Renderer remounts share the automatic refresh; explicit reloads replace the cached catalog.
export class UseCaseCatalog {
  private readonly path: string
  private items: UseCase[] = []
  private hasCatalog = false
  private catalogNeedsPersistence = false
  private readonly loaded: Promise<void>
  private refreshed?: Promise<UseCase[]>
  private refreshing?: Promise<UseCase[]>
  private refreshingForced = false
  private readonly introductions = new Map<string, { content: string; savedAt: number }>()
  private readonly introductionRequests = new Map<string, Promise<string>>()
  private introductionRefreshOrder: string[] = []

  constructor(configRoot: string) {
    this.path = join(configRoot, 'cache', 'use-cases', 'manifest.json')
    this.loaded = readFile(this.path, 'utf8')
      .then((raw) => {
        this.items = parseUseCases(JSON.parse(raw))
        this.hasCatalog = true
      })
      .catch(() => {})
  }

  async cached(): Promise<UseCase[]> {
    await this.loaded
    return this.items
  }

  refresh(force = false): Promise<UseCase[]> {
    // An automatic fetch does not check warm bodies. A manual click must still get that pass.
    if (force && this.refreshing && !this.refreshingForced) {
      return this.refreshing.catch(() => undefined).then(() => this.refresh(true))
    }
    if (!this.refreshing && (force || !this.refreshed)) {
      this.refreshingForced = force
      this.refreshing = this.fetchOnce(force).finally(() => {
        this.refreshing = undefined
        this.refreshingForced = false
      })
      this.refreshed = this.refreshing
    }
    // Cached catalogs, including a valid empty catalog, remain usable offline. Without a
    // successful read, propagate failure so the UI does not claim the market is empty.
    return force
      ? this.refreshing!
      : this.refreshed!.catch((error: unknown) => {
          if (this.hasCatalog) return this.items
          throw error
        })
  }

  async introduction(slug: string): Promise<string | null> {
    await this.loaded
    const item = this.items.find((entry) => entry.slug === slug)
    if (!item) throw new Error('Use case is unavailable.')
    if (!item.introductionUrl) return null
    const url = item.introductionUrl
    const pending = this.introductionRequests.get(url)
    // Hover prefetch and an explicit click share the same disk read and network request.
    const request =
      pending ?? this.loadIntroduction(url).finally(() => this.introductionRequests.delete(url))
    if (!pending) this.introductionRequests.set(url, request)
    return request.catch((error: unknown) => {
      // Saved content stays readable offline; failures never renew its successful check time.
      const saved = this.introductions.get(url)
      if (saved) return saved.content
      throw error
    })
  }

  private rememberIntroduction(url: string, content: string, savedAt: number): void {
    this.introductions.delete(url)
    this.introductions.set(url, { content, savedAt })
    while (this.introductions.size > INTRODUCTION_CACHE_LIMIT) {
      this.introductions.delete(this.introductions.keys().next().value!)
    }
  }

  private async loadIntroduction(
    url: string,
    force = false,
    signal?: AbortSignal
  ): Promise<string> {
    const cached = this.introductions.get(url)
    if (!force && cached && Date.now() - cached.savedAt < INTRODUCTION_CACHE_AGE)
      return cached.content
    const folder = join(dirname(this.path), 'introductions')
    const path = join(folder, `${createHash('sha256').update(url).digest('hex')}.md`)
    let persistedContent: string | undefined
    try {
      const file = await stat(path)
      if (file.size <= INTRODUCTION_MAX_BYTES) {
        persistedContent = await readFile(path, 'utf8')
        if (!cached || file.mtimeMs > cached.savedAt) {
          this.rememberIntroduction(url, persistedContent, file.mtimeMs)
        }
        if (!force && Date.now() - file.mtimeMs < INTRODUCTION_CACHE_AGE) {
          return persistedContent
        }
      }
    } catch {
      // Missing or unreadable cache files fall through to the published source.
    }
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(15000),
      ...(force ? { cache: 'no-store' as const } : {}),
      redirect: 'error'
    })
    if (!response.ok || !response.body) throw new Error('Could not load introduction.')
    // Bound the streamed body as well as the request; optional content must not exhaust memory.
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > INTRODUCTION_MAX_BYTES) throw new Error('Introduction is too large.')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const bytes = Buffer.concat(chunks)
    const content = bytes.toString('utf8')
    this.rememberIntroduction(url, content, Date.now())
    try {
      if (persistedContent === content) {
        // Unchanged content only renews its check time; do not replace the file.
        const checkedAt = new Date()
        await utimes(path, checkedAt, checkedAt)
      } else {
        await mkdir(folder, { recursive: true })
        await writeFile(`${path}.tmp`, bytes, { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      }
      await this.trimIntroductions(folder)
    } catch {
      // Caching is optional: a full or read-only disk must not hide a fetched introduction.
    }
    return content
  }

  private async trimIntroductions(folder: string): Promise<void> {
    // Each owned file is bounded to 1 MB; retain only the 32 most recently fetched versions.
    const entries = await Promise.all(
      (await readdir(folder))
        .filter((name) => /^[a-f0-9]{64}\.md$/.test(name))
        .map(async (name) => {
          const path = join(folder, name)
          const file = await stat(path).catch(() => undefined)
          return { path, savedAt: file?.mtimeMs ?? 0 }
        })
    )
    entries.sort((left, right) => right.savedAt - left.savedAt)
    await Promise.all(
      entries.slice(INTRODUCTION_CACHE_LIMIT).map(({ path }) => rm(path, { force: true }))
    )
  }

  // Revalidate previously viewed bodies, including disk caches from another launch. Three
  // workers share one deadline; unfinished work gets priority on the next manual refresh.
  private async refreshCachedIntroductions(previous: UseCase[]): Promise<void> {
    const folder = join(dirname(this.path), 'introductions')
    const files = new Set(await readdir(folder).catch(() => [] as string[]))
    const isCached = (url: string): boolean =>
      this.introductions.has(url) ||
      this.introductionRequests.has(url) ||
      files.has(`${createHash('sha256').update(url).digest('hex')}.md`)
    const previousUrls = new Map(previous.map((item) => [item.slug, item.introductionUrl]))
    const candidates = new Set(
      this.items.flatMap((item) => {
        const oldUrl = previousUrls.get(item.slug)
        return item.introductionUrl &&
          (isCached(item.introductionUrl) || (oldUrl && isCached(oldUrl)))
          ? [item.introductionUrl]
          : []
      })
    )
    const urls = [
      ...new Set([
        ...this.introductionRefreshOrder.filter((url) => candidates.has(url)),
        ...candidates
      ])
    ]
    const started: string[] = []
    const interrupted = new Set<string>()
    const signal = AbortSignal.timeout(15000)
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const url = urls.shift()
        if (!url) return
        started.push(url)
        // Let older reads finish first so they cannot overwrite a refreshed response.
        await this.introductionRequests.get(url)?.catch(() => undefined)
        if (signal.aborted) {
          interrupted.add(url)
          return
        }
        const request = this.loadIntroduction(url, true, signal).finally(() =>
          this.introductionRequests.delete(url)
        )
        this.introductionRequests.set(url, request)
        await request.catch(() => {
          if (signal.aborted) interrupted.add(url)
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker))
    // Unstarted URLs go first so repeatedly slow sources cannot monopolize each pass.
    // Retain assignment order, not completion order: filesystem/network timing must not
    // repeatedly move the same interrupted entry behind previously checked content.
    this.introductionRefreshOrder = [
      ...urls,
      ...started.filter((url) => interrupted.has(url)),
      ...started.filter((url) => !interrupted.has(url))
    ]
  }

  private async fetchOnce(force: boolean): Promise<UseCase[]> {
    await this.loaded
    const response = await fetch(USE_CASE_MANIFEST_URL, {
      signal: AbortSignal.timeout(15000),
      ...(force ? { cache: 'no-store' as const } : {})
    })
    if (!response.ok) throw new Error('Could not refresh use case catalog.')
    const manifest: unknown = await response.json()
    const next = parseUseCases(manifest)
    const previous = this.items
    // Publish validated data independently of optional disk storage so a full or read-only
    // cache cannot hide a successful refresh. Retain pending persistence across unchanged replies.
    if (!this.hasCatalog || JSON.stringify(next) !== JSON.stringify(previous)) {
      this.items = next
      this.hasCatalog = true
      this.catalogNeedsPersistence = true
    }
    if (this.catalogNeedsPersistence) {
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(`${this.path}.tmp`, JSON.stringify(manifest), { mode: 0o600 })
        await rename(`${this.path}.tmp`, this.path)
        this.catalogNeedsPersistence = false
      } catch {
        // Preserve the last complete disk cache and retry persistence on the next refresh.
      }
    }
    if (force) await this.refreshCachedIntroductions(previous)
    return this.items
  }
}

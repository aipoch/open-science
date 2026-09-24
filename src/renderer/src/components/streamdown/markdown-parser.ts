import type { Root } from 'mdast'
import type { Plugin } from 'unified'
import type { MarkdownParseRequest, MarkdownParseResponse } from './markdown-parser.worker'

// The budget is half a 60 Hz frame. Route based on observed parser cost, not message length.
export const MARKDOWN_PARSE_BUDGET_MS = 8
const MAX_RETAINED_BYTES = 8 * 1024 * 1024
const MAX_QUEUED_CHARACTERS = 4 * 1024 * 1024
const MAX_CACHE_ENTRIES = 32
const MIN_SYNC_CACHE_CHARACTERS = 16 * 1024
const SYNC_CACHE_IDLE_MS = 60_000
const PARSE_TIMEOUT_MS = 5000
const costs = new Map<string, number>()
const trees = new Map<
  string,
  { tree: Root; bytes: number; owners: Set<ParseOwner>; sync: boolean; parseCost?: number }
>()
let costCharacters = 0
let retainedBytes = 0
let syncCacheTimer: ReturnType<typeof setTimeout> | undefined

export const getMarkdownParseCost = (source: string): number => costs.get(source) ?? 0

const rememberParseCost = (source: string, elapsed: number): void => {
  if (source.length > MAX_QUEUED_CHARACTERS) return
  if (costs.delete(source)) costCharacters -= source.length
  costs.set(source, elapsed)
  costCharacters += source.length
  while (costs.size > MAX_CACHE_ENTRIES || costCharacters > MAX_QUEUED_CHARACTERS) {
    const oldest = costs.keys().next().value!
    costs.delete(oldest)
    costCharacters -= oldest.length
  }
}

const releaseIdleSyncTrees = (): void => {
  syncCacheTimer = undefined
  for (const [source, cached] of trees) {
    if (cached.sync && cached.owners.size === 0) releaseTree(source)
  }
}

const keepSyncTreesBriefly = (): void => {
  clearTimeout(syncCacheTimer)
  syncCacheTimer = setTimeout(releaseIdleSyncTrees, SYNC_CACHE_IDLE_MS)
}

// Streamdown runs remark transforms after parsing, so its returned tree must never be the cache copy.
// The caller is exclusively AgentMarkdown's fixed GFM/CJK/math parser. Streamdown caches processors
// by plugin name, so neither plugin may close over a component owner or a particular source tree.
const installParseReuse: Plugin<[boolean]> = function installParseReuse(cacheSyncTree) {
  const parse = this.parser!
  this.parser = (source, file) => {
    const cached = trees.get(source)
    if (cached) {
      trees.delete(source)
      trees.set(source, cached)
      if (cached.sync) keepSyncTreesBriefly()
      if (cached.parseCost !== undefined) rememberParseCost(source, cached.parseCost)
      return structuredClone(cached.tree)
    }
    const start = performance.now()
    const tree = parse(source, file)
    const elapsed = performance.now() - start
    rememberParseCost(source, elapsed)
    if (
      cacheSyncTree &&
      elapsed >= MARKDOWN_PARSE_BUDGET_MS &&
      source.length >= MIN_SYNC_CACHE_CHARACTERS &&
      source.length <= MAX_QUEUED_CHARACTERS
    ) {
      try {
        const bytes = 2 * (source.length + JSON.stringify(tree).length)
        if (bytes <= MAX_RETAINED_BYTES) {
          // Keep an untouched copy before runSync mutates the tree returned to Streamdown.
          const original = structuredClone(tree) as Root
          while (trees.size >= MAX_CACHE_ENTRIES || retainedBytes + bytes > MAX_RETAINED_BYTES) {
            releaseTree(trees.keys().next().value!)
          }
          trees.set(source, {
            tree: original,
            bytes,
            owners: new Set(),
            sync: true,
            parseCost: elapsed
          })
          retainedBytes += bytes
          keepSyncTreesBriefly()
        }
      } catch {
        // Caching is optional; a non-cloneable parser tree still renders normally.
      }
    }
    return tree
  }
}

export const reuseMarkdownParse: Plugin = function reuseMarkdownParse() {
  installParseReuse.call(this, false)
}

export const reuseCacheableMarkdownParse: Plugin = function reuseCacheableMarkdownParse() {
  installParseReuse.call(this, true)
}

const releaseTree = (source: string, owner?: ParseOwner): void => {
  const cached = trees.get(source)
  if (cached && owner) {
    cached.owners.delete(owner)
    if (cached.owners.size > 0) return
  }
  if (cached) retainedBytes -= cached.bytes
  trees.delete(source)
}

// One renderer Worker, one running parse, and only the latest pending snapshot per block.
// The owner generation prevents results from a replaced branch or disposed block being reused.
type ParseOwner = { generation: number; source: string; fail: () => void }
type Job = MarkdownParseRequest & {
  owner: ParseOwner
  generation: number
  accept: (source: string) => void
}
let worker: Worker | undefined
let workerReady = false
export const isMarkdownParserReady = (): boolean => workerReady
let running: Job | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let nextId = 0
const pending = new Map<ParseOwner, Job>()
const active = new Set<ParseOwner>()

const stopWorker = (): void => {
  clearTimeout(timer)
  timer = undefined
  worker?.terminate()
  worker = undefined
  workerReady = false
  running = undefined
}
const failWorker = (): void => {
  const owners = [...active]
  stopWorker()
  pending.clear()
  active.clear()
  for (const owner of owners) owner.fail()
}
const dispatch = (): void => {
  if (running || pending.size === 0) return
  const job = pending.values().next().value!
  pending.delete(job.owner)
  running = job
  try {
    if (!worker) {
      worker = new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onerror = failWorker
      worker.onmessageerror = failWorker
      worker.onmessage = ({ data }: MessageEvent<MarkdownParseResponse>): void => {
        const done = running
        if (!done || done.id !== data.id) return
        if ('tree' in data) workerReady = true
        clearTimeout(timer)
        running = undefined
        if (done.owner.generation === done.generation && active.has(done.owner)) {
          if ('error' in data || data.bytes > MAX_RETAINED_BYTES) {
            pending.delete(done.owner)
            active.delete(done.owner)
            done.owner.fail()
          } else {
            releaseTree(done.owner.source, done.owner)
            let cached = trees.get(done.source)
            if (!cached) {
              while (
                trees.size >= MAX_CACHE_ENTRIES ||
                retainedBytes + data.bytes > MAX_RETAINED_BYTES
              ) {
                releaseTree(trees.keys().next().value!)
              }
              cached = { tree: data.tree, bytes: data.bytes, owners: new Set(), sync: false }
              trees.set(done.source, cached)
              retainedBytes += data.bytes
            }
            cached.owners.add(done.owner)
            done.owner.source = done.source
            done.accept(done.source)
          }
        }
        dispatch()
        if (active.size === 0) stopWorker()
      }
    }
    timer = setTimeout(failWorker, PARSE_TIMEOUT_MS)
    worker.postMessage({ id: job.id, source: job.source } satisfies MarkdownParseRequest)
  } catch {
    failWorker()
  }
}

export const createMarkdownParseOwner = (): {
  request: (source: string, accept: (source: string) => void, fail: () => void) => void
  cancel: () => void
  dispose: () => void
} => {
  const owner: ParseOwner = { generation: 0, source: '', fail: () => undefined }
  const cancel = (): void => {
    owner.generation++
    pending.delete(owner)
    active.delete(owner)
    if (active.size === 0) stopWorker()
  }
  return {
    request(source, accept, fail) {
      owner.fail = fail
      const queuedCharacters = [...pending.values()].reduce(
        (total, job) => total + (job.owner === owner ? 0 : job.source.length),
        source.length
      )
      if (queuedCharacters > MAX_QUEUED_CHARACTERS) {
        cancel()
        fail()
        return
      }
      active.add(owner)
      pending.set(owner, { id: ++nextId, source, owner, generation: owner.generation, accept })
      dispatch()
    },
    cancel,
    dispose() {
      cancel()
      releaseTree(owner.source, owner)
      if (active.size === 0) {
        costs.clear()
        costCharacters = 0
      }
    }
  }
}

// Prepare one shared parser while output is still small. Starting a cold Worker during sustained
// Electron streaming can miss its deadline; until the warmup replies, rendering stays synchronous.
let presentationCount = 0
let presentationOwner: ReturnType<typeof createMarkdownParseOwner> | undefined
export const retainMarkdownParser = (): (() => void) => {
  if (typeof Worker === 'undefined') return () => undefined
  if (presentationCount++ === 0) {
    presentationOwner = createMarkdownParseOwner()
    presentationOwner.request(
      '',
      () => undefined,
      () => undefined
    )
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--presentationCount === 0) {
      presentationOwner?.dispose()
      presentationOwner = undefined
    }
  }
}

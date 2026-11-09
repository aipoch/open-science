import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { checkState, immutableCheckpoint, seal } from './session-state'
import type { AgentCheckpoint, AgentStore } from './session-types'

export type JournalAgentStoreOptions = {
  directory: string
  lockTimeoutMs?: number
  /** Also requires journal bytes to reach the previous snapshot size. Defaults to 64 commits. */
  snapshotMinRevisions?: number
  /** Retained snapshot + journal bytes, not heap size. Defaults to 128 MiB; zero disables cache. */
  maxCacheBytes?: number
  /** Successful payload writes, not physical disk blocks. Observer errors cannot affect commits. */
  onWrite?: (event: { kind: 'journal' | 'snapshot'; bytes: number }) => void
}
const arrays = ['messages', 'compactions', 'requests', 'pending', 'inbox'] as const
type ArrayKey = (typeof arrays)[number]
type Delta = {
  kind: 'delta'
  sessionId: string
  revision: number
  arrays: Partial<Record<ArrayKey, { at: number; items: unknown[] } | null>>
  run: AgentCheckpoint['run'] | null
}
type RecordValue = { kind: 'snapshot'; state: AgentCheckpoint } | Delta
type Cache = {
  signature: string
  snapshotHash: string
  journalHash: ReturnType<typeof createHash>
  state: AgentCheckpoint
  snapshotRevision: number
  snapshotBytes: number
  journalBytes: number
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const encode = (record: RecordValue): string => {
  const body = JSON.stringify(record)
  return `{"version":1,"hash":"${digest(body)}","record":${body}}\n`
}
const decode = (text: string): RecordValue => {
  try {
    const value = JSON.parse(text)
    if (value.version !== 1 || value.hash !== digest(JSON.stringify(value.record)))
      throw new Error()
    if (!['snapshot', 'delta'].includes(value.record?.kind)) throw new Error()
    return value.record as RecordValue
  } catch {
    throw new Error('Invalid agent journal record')
  }
}
const equal = (left: unknown, right: unknown): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right)
const deltaFor = (before: AgentCheckpoint, next: AgentCheckpoint): Delta => {
  const changes: Delta['arrays'] = {}
  for (const key of arrays) {
    if (key === 'inbox' && before.inbox !== undefined && next.inbox === undefined) {
      changes.inbox = null
      continue
    }
    const previous = before[key] ?? []
    const current = next[key] ?? []
    let at = 0
    while (at < Math.min(previous.length, current.length) && equal(previous[at], current[at])) at++
    if (
      at !== previous.length ||
      at !== current.length ||
      (key === 'inbox' && before.inbox === undefined && next.inbox !== undefined)
    )
      changes[key] = { at, items: current.slice(at) }
  }
  return {
    kind: 'delta',
    sessionId: next.sessionId,
    revision: next.revision,
    arrays: changes,
    run: next.run ?? null
  }
}
const applyDelta = (before: AgentCheckpoint, delta: Delta): AgentCheckpoint => {
  if (
    delta.sessionId !== before.sessionId ||
    delta.revision !== before.revision + 1 ||
    !delta.arrays ||
    typeof delta.arrays !== 'object' ||
    Array.isArray(delta.arrays) ||
    !Object.hasOwn(delta, 'run')
  )
    throw new Error('Invalid agent journal revision')
  const next: AgentCheckpoint = { ...before, revision: delta.revision }
  for (const [key, change] of Object.entries(delta.arrays)) {
    if (!arrays.includes(key as ArrayKey)) throw new Error('Invalid agent journal field')
    if (key === 'inbox' && change === null) {
      delete next.inbox
      continue
    }
    const previous = before[key as ArrayKey] ?? []
    if (
      !change ||
      !Number.isSafeInteger(change.at) ||
      change.at < 0 ||
      change.at > previous.length ||
      !Array.isArray(change.items)
    )
      throw new Error('Invalid agent journal patch')
    Object.assign(next, { [key]: [...previous.slice(0, change.at), ...change.items] })
  }
  if (delta.run === null) delete next.run
  else next.run = delta.run
  checkState(next, before.sessionId)
  return seal(next)
}

/** Optional local CAS journal. A stale lock or damaged tail requires explicit host recovery. */
export function createJournalAgentStore(options: JournalAgentStoreOptions): AgentStore & {
  /** Permanently fences this identity. The host must stop its workers before deleting. */
  delete(sessionId: string): Promise<void>
} {
  options = { ...options }
  const timeout = options.lockTimeoutMs ?? 30_000
  const minimum = options.snapshotMinRevisions ?? 64
  const maxCacheBytes = options.maxCacheBytes ?? 128 * 1024 * 1024
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    !Number.isSafeInteger(maxCacheBytes) ||
    maxCacheBytes < 0
  )
    throw new Error('Invalid journal-store options')
  const cache = new Map<string, Cache>()
  // Disk footprint conservatively prices retained evidence without serializing history again.
  const weight = (entry: Cache): number => entry.snapshotBytes + entry.journalBytes
  const remember = (id: string, value: Cache): Cache => {
    cache.delete(id)
    if (weight(value) > maxCacheBytes || maxCacheBytes === 0) return value
    cache.set(id, value)
    let retainedBytes = [...cache.values()].reduce((sum, entry) => sum + weight(entry), 0)
    while (cache.size > 16 || retainedBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value!
      retainedBytes -= weight(cache.get(oldest)!)
      cache.delete(oldest)
    }
    return value
  }
  const paths = (id: string): { journal: string; snapshot: string; lock: string } => {
    if (!id.trim()) throw new Error('Missing session identity')
    const base = join(options.directory, digest(id))
    return {
      journal: `${base}.jsonl`,
      snapshot: `${base}.snapshot.json`,
      lock: `${base}.journal.lock`
    }
  }
  const notify = (kind: 'journal' | 'snapshot', text: string): void => {
    try {
      void Promise.resolve(options.onWrite?.({ kind, bytes: Buffer.byteLength(text) })).catch(
        () => undefined
      )
    } catch {
      /* Telemetry is not a commit participant. */
    }
  }
  const syncDirectory = async (): Promise<void> => {
    // Windows does not support directory fsync through Node. File fsync + atomic rename still apply.
    if (process.platform === 'win32') return
    const directory = await open(options.directory, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  const locked = async <T>(file: string, work: () => Promise<T>): Promise<T> => {
    await mkdir(options.directory, { recursive: true })
    const started = Date.now()
    let handle: Awaited<ReturnType<typeof open>> | undefined
    while (!handle) {
      try {
        handle = await open(file, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() - started >= timeout)
          throw new Error('Journal-store lock timeout; verify the previous owner before recovery')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      return await work()
    } finally {
      try {
        await handle.close()
      } finally {
        await unlink(file)
      }
    }
  }
  // Equal-size rewrites can retain identical timestamps, even with bigint stat on Linux.
  const fingerprint = (snapshotHash: string, journalHash: ReturnType<typeof createHash>): string =>
    `${snapshotHash}/${journalHash.copy().digest('hex')}`
  const optionalRead = async (file: string): Promise<string | undefined> => {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const fileHash = async (file: string): Promise<string> => {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(file, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '-'
      throw error
    }
    try {
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(256 * 1024)
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) return hash.digest('hex')
        hash.update(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
  }
  const restore = async (id: string): Promise<Cache | undefined> => {
    const files = paths(id)
    if ((await optionalRead(`${files.journal}.deleted`)) !== undefined) {
      cache.delete(id)
      return undefined
    }
    const held = cache.get(id)
    if (held) {
      // Verify all bytes without materializing full-history strings on every warm read.
      const [snapshotHash, journalHash] = await Promise.all([
        fileHash(files.snapshot),
        fileHash(files.journal)
      ])
      if (held.signature === `${snapshotHash}/${journalHash}`) return remember(id, held)
      cache.delete(id)
    }
    const snapshot = await optionalRead(files.snapshot)
    const snapshotHash = snapshot === undefined ? '-' : digest(snapshot)
    let state: AgentCheckpoint | undefined
    let snapshotRevision = 0
    let snapshotBytes = 0
    if (snapshot !== undefined) {
      const record = decode(snapshot)
      if (record.kind !== 'snapshot') throw new Error('Invalid agent journal snapshot')
      checkState(record.state, id)
      state = seal(record.state)
      snapshotRevision = state.revision
      snapshotBytes = Buffer.byteLength(snapshot)
    }
    let previous: number | undefined
    const journal = await scanJournal(files.journal, (line) => {
      const record = decode(line)
      const revision = record.kind === 'snapshot' ? record.state.revision : record.revision
      const sessionId = record.kind === 'snapshot' ? record.state.sessionId : record.sessionId
      if (
        sessionId !== id ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        (previous !== undefined && revision !== previous + 1)
      )
        throw new Error('Invalid agent journal sequence')
      if (record.kind === 'snapshot') {
        if (previous !== undefined) throw new Error('Unexpected agent journal baseline')
        checkState(record.state, id)
        if (!state) {
          state = seal(record.state)
          snapshotRevision = revision
          snapshotBytes = Buffer.byteLength(line + '\n')
        } else if (revision > state.revision) throw new Error('Agent journal snapshot gap')
      } else if (!state) throw new Error('Missing agent journal baseline')
      else if (revision > state.revision) state = applyDelta(state, record)
      previous = revision
    })
    if (!journal) {
      if (snapshot === undefined) return undefined
      throw new Error('Incomplete agent journal; explicit recovery required')
    }
    if (!state || (previous !== undefined && previous < snapshotRevision))
      throw new Error('Missing agent journal history')
    const restored: Cache = {
      signature: fingerprint(snapshotHash, journal.hash),
      snapshotHash,
      journalHash: journal.hash,
      state,
      snapshotRevision,
      snapshotBytes,
      journalBytes: journal.bytes
    }
    return remember(id, restored)
  }
  const replace = async (file: string, text: string): Promise<void> => {
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, 'wx', 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file)
      await syncDirectory()
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  return {
    async delete(id) {
      const files = paths(id)
      await locked(files.lock, async () => {
        // Commit the fence first: interrupted deletion and stale CAS writers cannot resurrect data.
        await replace(`${files.journal}.deleted`, '')
        cache.delete(id)
        for (const file of [files.journal, files.snapshot]) {
          await unlink(file).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        await syncDirectory()
      })
    },
    async load(id) {
      return locked(paths(id).lock, async () => (await restore(id))?.state)
    },
    async commit(id, expected, value) {
      // Capture before the first await so host mutation cannot change a queued write.
      const next = immutableCheckpoint(value, id)
      if (next.revision !== (expected === null ? 0 : expected + 1))
        throw new Error('Invalid checkpoint revision')
      if (
        Object.keys(next).some(
          (key) => !['version', 'sessionId', 'revision', ...arrays, 'run'].includes(key)
        )
      )
        throw new Error('Unsupported journal checkpoint field')
      const files = paths(id)
      return locked(files.lock, async () => {
        try {
          if ((await optionalRead(`${files.journal}.deleted`)) !== undefined) return false
          const before = await restore(id)
          if ((before?.state.revision ?? null) !== expected) return false
          const text = encode(
            before ? deltaFor(before.state, next) : { kind: 'snapshot', state: next }
          )
          const handle = await open(files.journal, before ? 'a' : 'wx', 0o600)
          try {
            await handle.writeFile(text)
            await handle.sync()
          } finally {
            await handle.close()
          }
          if (!before) await syncDirectory()
          notify('journal', text)
          const current: Cache = {
            signature: '',
            snapshotHash: before?.snapshotHash ?? '-',
            journalHash: (before?.journalHash.copy() ?? createHash('sha256')).update(text),
            state: next,
            snapshotRevision: before?.snapshotRevision ?? next.revision,
            snapshotBytes: before?.snapshotBytes ?? Buffer.byteLength(text),
            journalBytes: (before?.journalBytes ?? 0) + Buffer.byteLength(text)
          }
          if (
            next.revision - current.snapshotRevision >= minimum &&
            current.journalBytes >= current.snapshotBytes
          ) {
            const snapshot = encode({ kind: 'snapshot', state: next })
            await replace(files.snapshot, snapshot)
            notify('snapshot', snapshot)
            await replace(files.journal, '')
            current.snapshotRevision = next.revision
            current.snapshotBytes = Buffer.byteLength(snapshot)
            current.journalBytes = 0
            current.snapshotHash = digest(snapshot)
            current.journalHash = createHash('sha256')
          }
          // The bytes just written are known; verify disk contents on the next restore, not twice per commit.
          current.signature = fingerprint(current.snapshotHash, current.journalHash)
          remember(id, current)
          return true
        } catch (error) {
          cache.delete(id)
          throw error
        }
      })
    }
  }
}

/** Keep only one unfinished record; never retain the complete JSONL text alongside its state. */
async function scanJournal(
  file: string,
  consume: (line: string) => void
): Promise<{ hash: ReturnType<typeof createHash>; bytes: number } | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const hash = createHash('sha256')
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let bytes = 0
    let parts: string[] = []
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      bytes += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
      const text = decoder.write(buffer.subarray(0, bytesRead))
      let start = 0
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
        parts.push(text.slice(start, end))
        consume(parts.join(''))
        parts = []
        start = end + 1
      }
      if (start < text.length) parts.push(text.slice(start))
    }
    if (decoder.end() || parts.length)
      throw new Error('Incomplete agent journal; explicit recovery required')
    return { hash, bytes }
  } finally {
    await handle.close()
  }
}

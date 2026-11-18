import { constants, type Stats } from 'node:fs'
import { appendFile, lstat, mkdir, open, readdir, truncate } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  defaultFileDurability,
  DurableJsonRecoveryBarrierError,
  readFileWithinLimit,
  writeDurableJsonFile,
  type DurableJsonFileDependencies
} from '@aipoch/durable-files'
import {
  freezeParsedJournalValue,
  journalValueByteLength,
  normalizeJournalValue,
  parseJournalValue,
  SessionJournalCorruptionError,
  type JournalValue
} from './journal-codec'
import {
  applySessionRecord,
  diffSessionRecords,
  validateSessionRecords,
  type SessionBusinessRecord,
  type SessionRecordChanges
} from './session-record-codec'

export { SessionJournalCorruptionError } from './journal-codec'
export type { JournalValue } from './journal-codec'
export type {
  SessionRecordChanges,
  SessionRecordCollection,
  SessionBusinessRecord,
  SessionTextEvent
} from './session-record-codec'

export class SessionJournalVersionError extends DurableJsonRecoveryBarrierError {
  constructor() {
    super('Session storage format is newer than this application understands.')
    this.name = 'SessionJournalVersionError'
  }
}
export class SessionJournalSizeError extends Error {
  constructor(readonly maxBytes: number) {
    super('Session exceeds its logical or single-record byte limit.')
    this.name = 'SessionJournalSizeError'
  }
}
export class SessionJournalRevisionError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super('Session revision changed.')
    this.name = 'SessionJournalRevisionError'
  }
}
export type SessionJournalDependencies = Partial<DurableJsonFileDependencies> & {
  appendFile?(path: string, contents: string): Promise<void>
  truncate?(path: string, length: number): Promise<void>
  readChunks?(path: string): AsyncIterable<Buffer>
}
export type SessionJournalOptions = {
  maxBytes: number
  maxCacheBytes?: number
  maxCacheEntries?: number
  dependencies?: SessionJournalDependencies
}
export type SessionJournalRead = {
  readonly document: JournalValue
  readonly revision: number
  readonly format: 'legacy' | 'journal'
  readonly storageBytes: number
}
export type SessionJournalWriteRequest = { document: unknown; expectedRevision: number }
export type SessionJournalPreparedWrite = { readonly document: JournalValue }
export type SessionJournalHistoryInspection = {
  maxBytes: number
  maxRecords: number
  maxLogicalBytes?: number
  signal?: AbortSignal
  visit(value: unknown): void
}
export type SessionJournalHistoryRead = {
  paths: string[]
  bytes: number
  records: number
  logicalBytes: number
  assertUnchanged(): Promise<void>
}
type State = SessionJournalRead & { fingerprint: string; validBytes: number }
type Prepared = {
  path: string
  previous: State
  records: readonly SessionBusinessRecord[]
}
type HistoryObserver = { visit(value: JournalValue): void; record(): void }
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const fail = (message: string): never => {
  throw new SessionJournalCorruptionError(message)
}
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
const revisionOf = (value: JournalValue, format: 'legacy' | 'journal' = 'journal'): number => {
  if (!object(value)) return fail('Session document must be an object.')
  const revision = object(value.session) ? value.session.revision : value.revision
  // Match the released JSON decoder's normalization only for legacy reads. New journal
  // records must still reject invalid revisions instead of silently accepting corruption.
  if (revision === undefined || (format === 'legacy' && !nonnegative(revision))) return 0
  return nonnegative(revision) ? revision : fail('Invalid Session revision.')
}
const logicalPath = (path: string): string => {
  if (path.endsWith('.jsonl')) path = path.slice(0, -1)
  if (!path.endsWith('.json') || basename(path) === '.json')
    return fail('Invalid Session file path.')
  return path
}
export const sessionJournalPath = (path: string): string => `${logicalPath(path)}l`
export const sessionLegacyBackupPath = (path: string): string =>
  `${logicalPath(path).slice(0, -5)}.legacy-json.backup`

// Existing JSON keeps its atomic snapshot writer. New Sessions use JSONL: one initial snapshot,
// then one complete business update per existing save batch. Newline terminates that save;
// no receipt, digest, periodic snapshot or separate manifest is involved.
export class SessionJournalStore {
  private readonly cache = new Map<string, State>()
  private readonly reads = new WeakMap<SessionJournalRead, { path: string; state: State }>()
  private readonly prepared = new WeakMap<SessionJournalPreparedWrite, Prepared>()
  private readonly lanes = new Map<string, Promise<unknown>>()
  private readonly dependencies: SessionJournalDependencies
  private readonly maxCacheBytes: number
  private readonly maxCacheEntries: number
  private cacheBytes = 0

  constructor(private readonly options: SessionJournalOptions) {
    this.maxCacheBytes = options.maxCacheBytes ?? 32 * 1024 * 1024
    this.maxCacheEntries = options.maxCacheEntries ?? 16
    if (
      !nonnegative(options.maxBytes) ||
      options.maxBytes === 0 ||
      !nonnegative(this.maxCacheBytes) ||
      !nonnegative(this.maxCacheEntries)
    )
      throw new Error('Invalid Session storage limits.')
    this.dependencies = options.dependencies ?? {}
  }
  invalidate(path?: string): void {
    if (path === undefined) {
      this.cache.clear()
      this.cacheBytes = 0
      return
    }
    const key = logicalPath(path)
    const previous = this.cache.get(key)
    if (previous) this.cacheBytes -= journalValueByteLength(previous.document)
    this.cache.delete(key)
  }
  async read(path: string): Promise<SessionJournalRead | undefined> {
    const key = logicalPath(path)
    return this.lane(key, async () => {
      const state = await this.readState(key)
      if (!state) return undefined
      const result = this.result(state)
      this.reads.set(result, { path: key, state })
      return result
    })
  }
  authorityFingerprint(read: SessionJournalRead): string {
    const source = this.reads.get(read)
    if (!source) return fail("Journal authority proof requires this Session owner's read.")
    return JSON.stringify([source.path, source.state.fingerprint])
  }
  prepareWrite(
    path: string,
    document: unknown,
    previous: SessionJournalRead,
    changes?: SessionRecordChanges
  ): SessionJournalPreparedWrite {
    const key = logicalPath(path)
    const source = this.reads.get(previous)
    if (!source || source.path !== key)
      return fail("Prepared journal write requires this Session owner's authority read.")
    if (source.state.format === 'legacy')
      return fail('Legacy JSON must use the repository snapshot writer.')
    const records = diffSessionRecords(source.state.document, document, changes)
    const result = Object.freeze({
      document: this.applyRecords(source.state.document, records)
    })
    this.assertNextRevision(result.document, source.state.revision)
    this.prepared.set(result, { path: key, previous: source.state, records })
    return result
  }
  writePrepared(
    path: string,
    prepared: SessionJournalPreparedWrite,
    request: Omit<SessionJournalWriteRequest, 'document'>
  ): Promise<SessionJournalRead> {
    const key = logicalPath(path)
    const source = this.prepared.get(prepared)
    if (!source || source.path !== key)
      return Promise.reject(
        new SessionJournalCorruptionError('Prepared write belongs to another owner or Session.')
      )
    return this.commit(
      key,
      { document: prepared.document, expectedRevision: request.expectedRevision },
      source
    )
  }
  write(path: string, request: SessionJournalWriteRequest): Promise<SessionJournalRead> {
    return this.commit(logicalPath(path), request)
  }
  private commit(
    path: string,
    request: SessionJournalWriteRequest,
    prepared?: Prepared
  ): Promise<SessionJournalRead> {
    return this.lane(path, async () => {
      if (!nonnegative(request.expectedRevision)) return fail('Invalid expected Session revision.')
      const state = await this.readState(path)
      if ((state?.revision ?? 0) !== request.expectedRevision)
        throw new SessionJournalRevisionError(request.expectedRevision, state?.revision ?? 0)
      if (state?.format === 'legacy')
        return fail('Legacy JSON must use the repository snapshot writer.')
      if (
        prepared &&
        (prepared.previous.revision !== request.expectedRevision ||
          prepared.previous.fingerprint !== state?.fingerprint)
      )
        return fail('Prepared journal authority changed before publication.')
      const records =
        prepared?.records ?? (state ? diffSessionRecords(state.document, request.document) : [])
      const document = prepared
        ? (request.document as JournalValue)
        : state
          ? this.applyRecords(state.document, records)
          : normalizeJournalValue(request.document)
      this.assertNextRevision(document, request.expectedRevision)
      this.assertSize(document)
      if (!state) return this.publish(path, document)
      const contents =
        JSON.stringify({ type: 'session_update', revision: revisionOf(document), records }) + '\n'
      this.assertLineSize(Buffer.byteLength(contents))
      const target = sessionJournalPath(path)
      if ((await this.fingerprint(path)) !== state.fingerprint)
        return fail('Session authority changed before append.')
      this.invalidate(path)
      if (state.validBytes !== state.storageBytes) {
        await (this.dependencies.truncate ?? truncate)(target, state.validBytes)
        await this.syncFile(target)
      }
      await (this.dependencies.appendFile ?? ((file, text) => appendFile(file, text, 'utf8')))(
        target,
        contents
      )
      await this.syncFile(target)
      const fingerprint = await this.fingerprint(path)
      const before = state.fingerprint.split(':')
      const after = fingerprint.split(':')
      if (
        before[0] !== after[0] ||
        before[1] !== after[1] ||
        before[2] !== after[2] ||
        Number(after[3]) !== state.validBytes + Buffer.byteLength(contents)
      )
        return fail('Session authority changed during append.')
      const committed: State = {
        document,
        revision: revisionOf(document),
        format: 'journal',
        storageBytes: state.validBytes + Buffer.byteLength(contents),
        validBytes: state.validBytes + Buffer.byteLength(contents),
        fingerprint
      }
      await this.retain(path, committed)
      return this.result(committed)
    })
  }
  private async publish(path: string, document: JournalValue): Promise<SessionJournalRead> {
    await this.assertDirectory(path)
    await mkdir(dirname(path), { recursive: true })
    const target = sessionJournalPath(path)
    const contents = JSON.stringify({ type: 'session_snapshot', document }) + '\n'
    this.assertLineSize(Buffer.byteLength(contents))
    if ((await this.fingerprint(path)) !== 'missing')
      return fail('Session authority changed before initial publication.')
    this.invalidate(path)
    await writeDurableJsonFile(target, contents, this.dependencies)
    const fingerprint = await this.fingerprint(path)
    if ((await this.boundedRead(target, this.options.maxBytes + 128 * 1024)) !== contents)
      return fail('Session changed during initial publication.')
    const state: State = {
      document,
      revision: revisionOf(document),
      format: 'journal',
      storageBytes: Buffer.byteLength(contents),
      validBytes: Buffer.byteLength(contents),
      fingerprint
    }
    await this.retain(path, state)
    return this.result(state)
  }
  async inspectStorage(path: string): Promise<{ paths: string[]; bytes: number }> {
    return this.lane(logicalPath(path), () => this.inspectOwned(logicalPath(path)))
  }
  private async inspectOwned(path: string): Promise<{ paths: string[]; bytes: number }> {
    await this.assertDirectory(path)
    let names: string[]
    try {
      names = await readdir(dirname(path))
    } catch (error) {
      if (missing(error)) return { paths: [], bytes: 0 }
      throw error
    }
    const paths: string[] = []
    let bytes = 0
    const primary = basename(sessionJournalPath(path))
    const owned = new Set([basename(path), primary, basename(sessionLegacyBackupPath(path))])
    for (const name of names.sort()) {
      if (!owned.has(name) && !(name.startsWith(`${primary}.`) && name.endsWith('.tmp'))) continue
      const file = join(dirname(path), name)
      const stat = await this.fileStat(file)
      if (stat) {
        paths.push(file)
        bytes += stat.size
      }
    }
    return { paths, bytes }
  }
  async visitRetainedHistory(
    path: string,
    inspection: SessionJournalHistoryInspection
  ): Promise<SessionJournalHistoryRead> {
    const key = logicalPath(path)
    return this.lane(key, async () => {
      const check = (): void => inspection.signal?.throwIfAborted()
      check()
      const maxLogical = inspection.maxLogicalBytes ?? inspection.maxBytes
      if (
        !nonnegative(inspection.maxBytes) ||
        !nonnegative(inspection.maxRecords) ||
        !nonnegative(maxLogical)
      )
        throw new Error('Invalid Session history inspection budget.')
      const storage = await this.inspectOwned(key)
      if (storage.bytes > inspection.maxBytes || storage.paths.length > inspection.maxRecords)
        return fail('Session history exceeds its inspection budget.')
      if (!storage.paths.includes(key) && !storage.paths.includes(sessionJournalPath(key)))
        return fail('Session history has no primary authority.')
      if (storage.paths.some((file) => file.endsWith('.tmp')))
        return fail('Session history contains an unpublished temporary file.')
      const proofs = new Map<string, string>()
      for (const file of storage.paths) proofs.set(file, await this.fileFingerprint(file))
      let records = storage.paths.length
      let logicalBytes = 0
      const observer: HistoryObserver = {
        record: () => {
          check()
          if (++records > inspection.maxRecords) fail('Session history exceeds its record budget.')
        },
        visit: (value) => {
          check()
          logicalBytes += journalValueByteLength(value)
          if (logicalBytes > maxLogical)
            fail('Session history exceeds its logical inspection budget.')
          inspection.visit(value)
        }
      }
      for (const file of storage.paths) {
        check()
        if (file === sessionJournalPath(key)) await this.readLog(file, observer)
        else observer.visit(this.decodeLegacy(await this.boundedRead(file, this.options.maxBytes)))
      }
      const assertUnchanged = async (): Promise<void> => {
        check()
        const after = await this.inspectOwned(key)
        if (
          after.bytes !== storage.bytes ||
          after.paths.length !== storage.paths.length ||
          after.paths.some((file, index) => file !== storage.paths[index])
        )
          return fail('Session history changed during inspection.')
        for (const file of after.paths)
          if ((await this.fileFingerprint(file)) !== proofs.get(file))
            return fail('Session history changed during inspection.')
        check()
      }
      await assertUnchanged()
      return { ...storage, records, logicalBytes, assertUnchanged }
    })
  }
  private decodeLegacy(contents: string): JournalValue {
    const document = parseJournalValue(contents)
    if (object(document) && typeof document.version === 'number' && document.version > 2)
      throw new SessionJournalVersionError()
    revisionOf(document, 'legacy')
    this.assertSize(document)
    return document
  }
  private async readState(path: string): Promise<State | undefined> {
    await this.assertDirectory(path)
    const fingerprint = await this.fingerprint(path)
    const cached = this.cache.get(path)
    if (cached && cached.fingerprint === fingerprint) return cached
    this.invalidate(path)
    if (fingerprint === 'missing') {
      if ((await this.inspectOwned(path)).paths.length)
        return fail('Session primary is missing while history files remain.')
      return undefined
    }
    let state: State
    if (fingerprint.startsWith('journal:')) {
      const read = await this.readLog(sessionJournalPath(path))
      state = { ...read, format: 'journal', fingerprint }
    } else {
      const contents = await this.boundedRead(path, this.options.maxBytes)
      const document = this.decodeLegacy(contents)
      state = {
        document,
        revision: revisionOf(document, 'legacy'),
        format: 'legacy',
        storageBytes: Buffer.byteLength(contents),
        validBytes: Buffer.byteLength(contents),
        fingerprint
      }
    }
    if ((await this.fingerprint(path)) !== fingerprint)
      return fail('Session changed while reading.')
    await this.retain(path, state)
    return state
  }
  private async readLog(
    path: string,
    observer?: HistoryObserver
  ): Promise<Pick<State, 'document' | 'revision' | 'storageBytes' | 'validBytes'>> {
    const expectedBytes = (await this.fileStat(path))?.size
    let document: JournalValue | undefined
    let validBytes = 0
    let storageBytes = 0
    for await (const line of this.lines(path)) {
      storageBytes += line.bytes
      if (!line.complete) {
        if (observer) return fail('Session history contains an incomplete record.')
        continue
      }
      observer?.record()
      let value: unknown
      try {
        value = JSON.parse(line.text)
      } catch {
        return fail('Session journal contains an invalid complete record.')
      }
      if (!object(value)) return fail('Invalid Session journal record.')
      if (document === undefined) {
        if (!exact(value, ['type', 'document']) || value.type !== 'session_snapshot')
          return fail('Session journal must start with its initial snapshot.')
        document = freezeParsedJournalValue(value.document)
        if (object(document) && typeof document.version === 'number' && document.version > 2)
          throw new SessionJournalVersionError()
        revisionOf(document)
        this.assertSize(document)
      } else {
        if (
          !exact(value, ['type', 'revision', 'records']) ||
          value.type !== 'session_update' ||
          value.revision !== revisionOf(document) + 1
        )
          return fail('Session journal record has invalid schema or revision.')
        const records = validateSessionRecords(value.records, { parsed: true })
        document = this.applyRecords(document, records)
        if (revisionOf(document) !== value.revision)
          return fail('Session journal revision does not match its update.')
        observer?.visit(records as unknown as JournalValue)
      }
      observer?.visit(document)
      validBytes += line.bytes
    }
    if (storageBytes !== expectedBytes)
      return fail('Session journal changed or was not read completely.')
    if (document === undefined) return fail('Session journal has no complete initial snapshot.')
    return { document, revision: revisionOf(document), validBytes, storageBytes }
  }
  private async *chunks(path: string): AsyncGenerator<Buffer> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const buffer = Buffer.alloc(64 * 1024)
    try {
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        yield buffer.subarray(0, bytesRead)
      }
    } finally {
      await file.close()
    }
  }
  private async *lines(
    path: string
  ): AsyncGenerator<{ text: string; bytes: number; complete: boolean }> {
    await this.fileStat(path)
    let parts: Buffer[] = []
    let length = 0
    for await (const buffer of this.dependencies.readChunks?.(path) ?? this.chunks(path)) {
      let start = 0
      for (let index = buffer.indexOf(10, start); index !== -1; index = buffer.indexOf(10, start)) {
        const part = buffer.subarray(start, index + 1)
        length += part.length
        this.assertLineSize(length)
        // Decode complete lines directly from the current buffer. Only unfinished fragments
        // need a copy because chunks() reuses its read buffer on the next iteration.
        const text = parts.length
          ? Buffer.concat([...parts, part], length).toString('utf8')
          : part.toString('utf8')
        yield { text, bytes: length, complete: true }
        parts = []
        length = 0
        start = index + 1
      }
      if (start < buffer.length) {
        parts.push(Buffer.from(buffer.subarray(start)))
        length += buffer.length - start
        this.assertLineSize(length)
      }
    }
    if (length) yield { text: '', bytes: length, complete: false }
  }
  private applyRecords(
    document: JournalValue,
    records: readonly SessionBusinessRecord[]
  ): JournalValue {
    const result = records.reduce(applySessionRecord, document)
    this.assertSize(result)
    return result
  }
  private assertNextRevision(document: JournalValue, previous: number): void {
    if (revisionOf(document) !== previous + 1)
      return fail('Session update must advance its revision once.')
  }
  private assertSize(document: JournalValue): void {
    if (journalValueByteLength(document) > this.options.maxBytes)
      throw new SessionJournalSizeError(this.options.maxBytes)
  }
  private assertLineSize(bytes: number): void {
    if (bytes > this.options.maxBytes + 128 * 1024)
      throw new SessionJournalSizeError(this.options.maxBytes)
  }
  private result(state: State): SessionJournalRead {
    return Object.freeze({
      document: state.document,
      revision: state.revision,
      format: state.format,
      storageBytes: state.storageBytes
    })
  }
  private async retain(path: string, state: State): Promise<void> {
    this.invalidate(path)
    if ((await this.fingerprint(path)) !== state.fingerprint)
      return fail('Session authority changed before caching.')
    const bytes = journalValueByteLength(state.document)
    if (bytes > this.maxCacheBytes || !this.maxCacheEntries) return
    this.cache.set(path, state)
    this.cacheBytes += bytes
    while (this.cacheBytes > this.maxCacheBytes || this.cache.size > this.maxCacheEntries)
      this.invalidate(this.cache.keys().next().value!)
  }
  private lane<Result>(path: string, action: () => Promise<Result>): Promise<Result> {
    const prior = this.lanes.get(path) ?? Promise.resolve()
    const next = prior.then(action, action)
    this.lanes.set(path, next)
    void next
      .finally(() => {
        if (this.lanes.get(path) === next) this.lanes.delete(path)
      })
      .catch(() => undefined)
    return next
  }
  private async assertDirectory(path: string): Promise<void> {
    try {
      const stat = await lstat(dirname(path))
      if (!stat.isDirectory() || stat.isSymbolicLink())
        return fail('Session directory must be a regular directory.')
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  private async fileStat(path: string): Promise<Stats | undefined> {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink())
        return fail('Session authority must be a regular file.')
      return stat
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }
  private async fileFingerprint(path: string): Promise<string> {
    const stat = await this.fileStat(path)
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'missing'
  }
  private async fingerprint(path: string): Promise<string> {
    const journal = await this.fileFingerprint(sessionJournalPath(path))
    if (journal !== 'missing') return `journal:${journal}`
    const legacy = await this.fileFingerprint(path)
    return legacy === 'missing' ? legacy : `legacy:${legacy}`
  }
  private async boundedRead(path: string, limit: number): Promise<string> {
    await this.fileStat(path)
    return (this.dependencies.readFileWithinLimit ?? readFileWithinLimit)(path, limit)
  }
  private syncFile(path: string): Promise<void> {
    return (this.dependencies.syncFile ?? ((file) => defaultFileDurability.syncFile(file)))(path)
  }
}

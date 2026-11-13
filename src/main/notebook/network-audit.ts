import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger, redactRuntimeDiagnosticText } from '@aipoch/diagnostics/node'
import type {
  NotebookNetworkAuditData,
  NotebookNetworkAuditPage,
  NotebookNetworkAuditQuery,
  NotebookNetworkAuditRecord
} from '../../shared/notebook-network-audit'

const DAY = 86_400_000
const INTERVAL = 3 * DAY
const FILE = /^notebook-\d{4}-\d{2}-\d{2}\.log$/
const INTEGRITY_FILE = 'integrity.json'
const INTEGRITY_WARNING = 'Network log recording failed. Some records may be missing.'
const MAX_LINE = 16 * 1024
const SCAN_LIMIT = 8 * 1024 * 1024
const log = createLogger('notebook:network-audit')
type Cursor = { file: string; offset: number }

const text = (value: unknown, limit = 512): string | undefined =>
  typeof value === 'string'
    ? // Strip control characters from untrusted diagnostic fields.
      // eslint-disable-next-line no-control-regex
      redactRuntimeDiagnosticText(value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit))
    : undefined

// Explicit projections keep credentials, URLs, code and untrusted extra fields out of the journal.
export function projectNetworkAuditData(value: NotebookNetworkAuditData): NotebookNetworkAuditData {
  return {
    eventId: text(value.eventId) ?? randomUUID(),
    requestId: text(value.requestId) ?? '',
    mode: value.mode === 'strict' ? 'strict' : 'relaxed',
    projectId: text(value.projectId) ?? '',
    projectName: text(value.projectName),
    sessionId: text(value.sessionId) ?? '',
    sessionNumber: Number.isSafeInteger(value.sessionNumber) ? value.sessionNumber : undefined,
    notebookRunId: text(value.notebookRunId),
    executionId: text(value.executionId),
    runtime: text(value.runtime) ?? '',
    host: text(value.host) ?? '',
    port: value.port,
    protocol: value.protocol,
    address: text(value.address),
    decision: ['allowed', 'blocked'].includes(value.decision ?? '') ? value.decision : undefined,
    outcome: ['connected', 'completed', 'failed', 'cancelled', 'timeout'].includes(
      value.outcome ?? ''
    )
      ? value.outcome
      : undefined,
    reason: text(value.reason),
    statusCode:
      Number.isInteger(value.statusCode) && value.statusCode! >= 100 && value.statusCode! <= 599
        ? value.statusCode
        : undefined,
    durationMs:
      Number.isFinite(value.durationMs) && value.durationMs! >= 0 ? value.durationMs : undefined
  }
}

async function directory(root: string, create = false): Promise<string> {
  // Validate both descendants before opening files. Do not follow journal-directory symlinks.
  let current = root
  for (const segment of ['logs', 'network']) {
    current = join(current, segment)
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
    if (!(await lstat(current)).isDirectory())
      throw new Error('Network audit directory is not regular')
  }
  return current
}

function parse(line: string): NotebookNetworkAuditRecord | undefined {
  try {
    const r = JSON.parse(line) as NotebookNetworkAuditRecord
    const d = r.data
    if (
      r.scope !== 'notebook:network' ||
      !Number.isFinite(Date.parse(r.t)) ||
      !d ||
      !['strict', 'relaxed'].includes(d.mode) ||
      typeof d.host !== 'string' ||
      typeof d.sessionId !== 'string' ||
      typeof d.projectId !== 'string' ||
      typeof d.requestId !== 'string' ||
      !['http', 'https'].includes(d.protocol) ||
      !Number.isInteger(d.port) ||
      d.port < 1 ||
      d.port > 65535
    )
      return undefined
    return {
      t: new Date(Date.parse(r.t)).toISOString(),
      level: r.level === 'warn' ? 'warn' : 'info',
      scope: 'notebook:network',
      msg: 'network access',
      data: projectNetworkAuditData(d)
    }
  } catch {
    return undefined
  }
}

// Read backwards in bounded blocks. Cursor offsets exclude later appends to the active file.
async function* lines(
  path: string,
  end?: number
): AsyncGenerator<{ line: string; offset: number; bytes: number }> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Network audit source is not regular')
    let position = Math.min(end ?? stat.size, stat.size)
    let carry = Buffer.alloc(0)
    while (position > 0) {
      const start = Math.max(0, position - 64 * 1024)
      const buffer = Buffer.alloc(position - start)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
      if (bytesRead !== buffer.length) throw new Error('Network audit source changed')
      const merged = Buffer.concat([buffer, carry])
      let stop = merged.length
      if (merged[stop - 1] === 10) stop--
      for (let i = stop - 1; i >= 0; i--) {
        if (merged[i] !== 10) continue
        if (stop - i > MAX_LINE) throw new Error('Network audit record exceeds size limit')
        yield {
          line: merged.subarray(i + 1, stop).toString('utf8'),
          offset: start + i + 1,
          bytes: stop - i
        }
        stop = i
      }
      carry = merged.subarray(0, stop)
      if (carry.length > MAX_LINE) throw new Error('Network audit record exceeds size limit')
      position = start
    }
    if (carry.length) yield { line: carry.toString('utf8'), offset: 0, bytes: carry.length }
  } finally {
    await file.close()
  }
}

function validate(query: NotebookNetworkAuditQuery): void {
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new Error('Invalid network log query')
  if (query.mode !== undefined && !['relaxed', 'strict'].includes(query.mode))
    throw new Error('Invalid mode')
  if (query.decision !== undefined && !['allowed', 'blocked'].includes(query.decision))
    throw new Error('Invalid decision')
  if (
    query.outcome !== undefined &&
    !['connected', 'completed', 'failed', 'cancelled', 'timeout'].includes(query.outcome)
  )
    throw new Error('Invalid outcome')
  for (const key of ['projectId', 'sessionId', 'notebookRunId', 'address', 'cursor'] as const)
    if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key]!.length > 1024))
      throw new Error('Invalid filter')
  for (const key of ['from', 'to'] as const)
    if (query[key] !== undefined && (!Number.isFinite(query[key]) || query[key]! < 0))
      throw new Error('Invalid time')
  if (query.from !== undefined && query.to !== undefined && query.from > query.to)
    throw new Error('Invalid time range')
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200)
  )
    throw new Error('Invalid page size')
}

export async function readNetworkAudit(
  root: string,
  query: NotebookNetworkAuditQuery
): Promise<Omit<NotebookNetworkAuditPage, 'retentionDays'>> {
  validate(query)
  let cursor: Cursor | undefined
  if (query.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
    } catch {
      throw new Error('Invalid cursor')
    }
    if (
      !cursor ||
      !FILE.test(cursor.file) ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error('Invalid cursor')
  }
  const records: NotebookNetworkAuditRecord[] = []
  const warnings: string[] = []
  let scanned = 0
  try {
    const dir = await directory(root)
    try {
      const integrity = JSON.parse(await readFile(join(dir, INTEGRITY_FILE), 'utf8'))
      if (integrity?.missingRecords === true) warnings.push(INTEGRITY_WARNING)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push('Network log integrity metadata could not be read.')
    }
    const files = (await readdir(dir))
      .filter((name) => FILE.test(name))
      .sort()
      .reverse()
    if (cursor && !files.includes(cursor.file))
      warnings.push('Log files changed or expired. Refresh to load current records.')
    for (const name of files) {
      if (cursor && name > cursor.file) continue
      try {
        for await (const item of lines(
          join(dir, name),
          name === cursor?.file ? cursor.offset : undefined
        )) {
          scanned += item.bytes
          const record = parse(item.line)
          if (!record) {
            if (!warnings.includes('Some log records are incomplete or invalid.'))
              warnings.push('Some log records are incomplete or invalid.')
          } else {
            const d = record.data,
              time = Date.parse(record.t)
            if (
              (!query.mode || d.mode === query.mode) &&
              (!query.projectId || d.projectId === query.projectId) &&
              (!query.sessionId || d.sessionId === query.sessionId) &&
              (!query.notebookRunId || d.notebookRunId === query.notebookRunId) &&
              (!query.decision || d.decision === query.decision) &&
              (!query.outcome || d.outcome === query.outcome) &&
              (!query.address ||
                `${d.host} ${d.address ?? ''} ${d.port}`
                  .toLowerCase()
                  .includes(query.address.toLowerCase())) &&
              (query.from === undefined || time >= query.from) &&
              (query.to === undefined || time <= query.to)
            )
              records.push(record)
          }
          if (records.length >= (query.limit ?? 100) || scanned >= SCAN_LIMIT)
            return {
              records,
              warnings,
              cursor: Buffer.from(JSON.stringify({ file: name, offset: item.offset })).toString(
                'base64url'
              )
            }
        }
      } catch {
        warnings.push(`Could not read ${name}.`)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      warnings.push('Could not read network logs.')
  }
  return { records, warnings }
}

export class NotebookNetworkAudit {
  readonly ready: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private retentionDays = 90
  private lastCleanup = 0
  private settingsLoaded = false
  private failure = false
  private integrityFailure = false
  private cleanupFailure = false
  private timer?: ReturnType<typeof setInterval>
  constructor(
    private readonly root: string,
    private readonly options: { now?: () => number; schedule?: boolean } = {}
  ) {
    this.ready = this.initialize().catch(() => {
      this.failure = true
    })
    if (options.schedule !== false) {
      this.timer = setInterval(
        () => {
          void this.cleanup()
        },
        60 * 60 * 1000
      )
      this.timer.unref()
    }
  }
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  private async initialize(): Promise<void> {
    const dir = await directory(this.root, true)
    try {
      const path = join(dir, 'retention.json')
      if (!(await lstat(path)).isFile()) throw new Error('Invalid retention settings')
      const state = JSON.parse(await readFile(path, 'utf8'))
      if (
        !Number.isInteger(state.retentionDays) ||
        state.retentionDays < 1 ||
        state.retentionDays > 3650
      )
        throw new Error('Invalid retention settings')
      this.retentionDays = state.retentionDays
      if (Number.isFinite(state.lastCleanup) && state.lastCleanup >= 0)
        this.lastCleanup = state.lastCleanup
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.settingsLoaded = true
    await this.prune()
  }
  private async save(): Promise<void> {
    const dir = await directory(this.root, true)
    const temp = join(dir, `retention-${randomUUID()}.tmp`)
    try {
      await writeFile(
        temp,
        JSON.stringify({ retentionDays: this.retentionDays, lastCleanup: this.lastCleanup }),
        { flag: 'wx', mode: 0o600 }
      )
      await rename(temp, join(dir, 'retention.json'))
    } finally {
      await rm(temp, { force: true })
    }
  }
  private async persistIntegrity(): Promise<void> {
    if (!this.integrityFailure) return
    const dir = await directory(this.root, true)
    const temp = join(dir, `integrity-${randomUUID()}.tmp`)
    try {
      await writeFile(
        temp,
        JSON.stringify({ missingRecords: true, recordedAt: new Date(this.now()).toISOString() }),
        { flag: 'wx', mode: 0o600 }
      )
      await rename(temp, join(dir, INTEGRITY_FILE))
    } finally {
      await rm(temp, { force: true })
    }
  }
  record(data: NotebookNetworkAuditData): void {
    if (this.pending >= 10000) {
      this.failure = true
      this.integrityFailure = true
      log.warn('network audit queue overflow')
      return
    }
    const timestamp = this.now()
    const record: NotebookNetworkAuditRecord = {
      t: new Date(timestamp).toISOString(),
      level: data.decision === 'blocked' || data.outcome === 'failed' ? 'warn' : 'info',
      scope: 'notebook:network',
      msg: 'network access',
      data: projectNetworkAuditData(data)
    }
    this.pending++
    this.queue = this.queue
      .then(async () => {
        await this.ready
        const dir = await directory(this.root, true)
        const file = await open(
          join(dir, `notebook-${record.t.slice(0, 10)}.log`),
          constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
          0o600
        )
        try {
          const stat = await file.stat()
          if (!stat.isFile()) throw new Error('Invalid audit file')
          if (stat.size) {
            const tail = Buffer.alloc(1)
            await file.read(tail, 0, 1, stat.size - 1)
            if (tail[0] !== 10) {
              await file.writeFile('\n')
              this.failure = true
              this.integrityFailure = true
            }
          }
          await file.writeFile(JSON.stringify(record) + '\n')
          await this.persistIntegrity().catch(() => undefined)
        } finally {
          await file.close()
        }
      })
      .catch(() => {
        this.failure = true
        this.integrityFailure = true
        void this.persistIntegrity().catch(() => undefined)
        log.warn('network audit write failed')
      })
      .finally(() => {
        this.pending--
      })
  }
  async flush(): Promise<void> {
    await this.ready
    await this.queue
  }
  async query(query: NotebookNetworkAuditQuery): Promise<NotebookNetworkAuditPage> {
    await this.flush()
    await this.persistIntegrity().catch(() => undefined)
    const page = await readNetworkAudit(this.root, query)
    if (this.failure && !page.warnings.includes(INTEGRITY_WARNING))
      page.warnings.push(INTEGRITY_WARNING)
    if (this.cleanupFailure)
      page.warnings.push('Network log cleanup failed. Older records may remain.')
    return { ...page, retentionDays: this.retentionDays }
  }
  async setRetention(days: number): Promise<number> {
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new Error('Retention must be between 1 and 3650 days')
    const task = this.queue.then(async () => {
      await this.ready
      const previous = this.retentionDays
      this.retentionDays = days
      try {
        await this.save()
        this.settingsLoaded = true
      } catch (error) {
        this.retentionDays = previous
        throw error
      }
    })
    this.queue = task.catch(() => undefined)
    await task
    return this.retentionDays
  }
  async cleanup(): Promise<void> {
    const task = this.queue.then(async () => {
      await this.ready
      await this.prune()
    })
    this.queue = task.catch(() => {
      this.cleanupFailure = true
      log.warn('network audit cleanup failed')
    })
    await this.queue
  }
  private async prune(): Promise<void> {
    if (!this.settingsLoaded) throw new Error('Retention policy is unavailable')
    const now = this.now()
    if (now - this.lastCleanup < INTERVAL && now >= this.lastCleanup) return
    const dir = await directory(this.root, true),
      cutoff = now - this.retentionDays * DAY
    const active = `notebook-${new Date(now).toISOString().slice(0, 10)}.log`
    let hadFailure = false
    for (const name of (await readdir(dir)).filter((name) => FILE.test(name) && name !== active)) {
      try {
        let expired = true,
          count = 0
        for await (const item of lines(join(dir, name))) {
          const record = parse(item.line)
          if (!record || Date.parse(record.t) >= cutoff) {
            expired = false
            break
          }
          count++
        }
        if (expired && count > 0) await rm(join(dir, name))
      } catch {
        hadFailure = true
        log.warn(`network audit cleanup skipped ${name}`)
      }
    }
    const before = this.lastCleanup
    this.lastCleanup = now
    try {
      await this.save()
      this.cleanupFailure = hadFailure
    } catch (error) {
      this.lastCleanup = before
      throw error
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer)
    await this.flush()
  }
}

const stores = new Map<string, NotebookNetworkAudit>()
export function notebookNetworkAudit(root: string): NotebookNetworkAudit {
  let store = stores.get(root)
  if (!store) {
    store = new NotebookNetworkAudit(root)
    stores.set(root, store)
  }
  return store
}

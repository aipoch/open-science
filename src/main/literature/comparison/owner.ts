import { ComparisonCsvReader } from './export'
import { randomUUID } from 'node:crypto'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import { ApplicationCommandError } from '../../../shared/application-command-contract'
import {
  COMPARISON_HISTORY_LIMIT,
  comparisonCellSchema,
  comparisonTaskReference,
  isUnattemptedComparisonCell,
  isPendingComparisonCell,
  comparisonRequestSchema,
  comparisonTableSchema,
  type ComparisonLaunchRequest,
  type ComparisonRequest,
  type ComparisonResult,
  type ComparisonTable,
  type ComparisonCell
} from '../../../shared/literature-comparison'
import {
  withDataRootWrite,
  runDataRootStartupRecovery,
  outsideDataRootWriteContext,
  isMigrationPending
} from '../../storage/migration-state'
import {
  ComparisonGlobalError,
  type ComparisonExtractor,
  type ComparisonExtraction
} from './extractor'

const envelope = z
  .object({ version: z.literal(1), tables: z.array(comparisonTableSchema).max(30) })
  .strict()
const MAX_BYTES = 24_000_000
const MAX_MATRIX_SNAPSHOTS = 4
const MAX_EXPORT_SNAPSHOTS = 8
// Keep model work bounded while allowing independent cells/tables to make progress together.
// The queue below remains the single writer for in-memory state and durable checkpoints.
const MAX_COMPARISON_CONCURRENCY = 4
const now = (): string => new Date().toISOString()
const matrixCell = (cell: ComparisonCell): ComparisonCell => ({
  ...cell,
  ...(cell.history.length >= COMPARISON_HISTORY_LIMIT && { historyLimitReached: true }),
  history: cell.history.slice(-1).map((attempt) => ({ ...attempt, evidence: [] }))
})
type Options = {
  sourceRevision?: () => number
  path: () => string
  /** Maximum number of admitted extractions in one worker batch. */
  comparisonConcurrency?: number
  extractor: Pick<ComparisonExtractor, 'member'> & Partial<Pick<ComparisonExtractor, 'checkSource'>>
  capture(): Promise<Pick<ComparisonExtractor, 'extract'>>
  onError?(error: unknown): void
}
/** Process-owned worker; renderer leases never own or cancel a comparison job. */
export class LiteratureComparisons {
  private tables: ComparisonTable[] = []
  private readonly matrixSnapshots = new Map<string, ComparisonTable>()
  private readonly exportSnapshots = new Map<
    string,
    {
      tableId: string
      table: ComparisonTable
      readers: Partial<Record<'matrix' | 'evidence', ComparisonCsvReader>>
      expiresAt: number
      expiry: ReturnType<typeof setTimeout>
    }
  >()
  private releaseExportSnapshot(token: string): void {
    const snapshot = this.exportSnapshots.get(token)
    if (snapshot) clearTimeout(snapshot.expiry)
    this.exportSnapshots.delete(token)
  }
  private bounded(result: ComparisonResult): ComparisonResult {
    if (Buffer.byteLength(JSON.stringify(result)) > 8_000_000)
      throw new Error('comparison-response-limit')
    return result
  }
  private project(table: ComparisonTable, offset = 0, limit = 10): ComparisonResult {
    if (offset > table.cells.length || (offset > 0 && offset === table.cells.length))
      throw new Error('comparison-invalid-offset')
    const cells = table.cells.slice(offset, offset + limit).map(matrixCell)
    while (true) {
      const ids = new Set(cells.map((cell) => cell.id))
      const result: ComparisonResult = {
        tables: [
          structuredClone({
            ...table,
            members: table.members.map((member) => ({ ...member, abstract: '' })),
            cells,
            taskSources: table.taskSources?.filter((source) => ids.has(source.cellId))
          })
        ],
        ...(offset + cells.length < table.cells.length ? { nextOffset: offset + cells.length } : {})
      }
      // Escaped control characters can cost six wire bytes per source character.
      if (Buffer.byteLength(JSON.stringify(result)) <= 8_000_000) return result
      if (cells.length <= 1) return this.bounded(result)
      cells.splice(Math.floor(cells.length / 2))
    }
  }

  private serial: Promise<unknown> = Promise.resolve()
  private worker: Promise<void> | undefined
  private readonly inFlightAdmissions = new Map<string, Set<string>>()
  private lastSourceScan?: { revision: number; at: number }
  private needsSourceScan(revision: number | undefined): boolean {
    return (
      revision === undefined ||
      this.lastSourceScan?.revision !== revision ||
      Date.now() - this.lastSourceScan.at >= 60_000
    )
  }
  private readonly serializedHistories = new WeakMap<ComparisonCell['history'], string>()
  private readonly serializedTables = new WeakMap<
    ComparisonTable,
    { revision: number; json: string }
  >()
  private loadError = false
  private started = false
  private closed = false
  private readonly lifetime = new AbortController()
  constructor(private readonly options: Options) {}
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation)
    this.serial = result.catch(() => undefined)
    return result
  }
  async start(): Promise<void> {
    if (this.started || this.closed) return
    await runDataRootStartupRecovery(() => this.queue(() => withDataRootWrite(() => this.load())))
    this.started = true
  }
  private async load(): Promise<void> {
    if (this.closed) return
    try {
      const saved = await readDurableJsonFile(
        this.options.path(),
        (text) => envelope.parse(JSON.parse(text)),
        {},
        { maxBytes: MAX_BYTES }
      )
      if (this.loadError && saved.status !== 'found') throw new Error('comparison-backup-missing')
      this.loadError = false
      if (saved.status === 'found') this.tables = saved.value.tables
      let changed = false
      for (const table of this.tables)
        if (
          table.state === 'running' ||
          (['paused', 'interrupted'].includes(table.state) &&
            table.cells.some((cell) => cell.status === 'running')) ||
          (!table.remainingCellIds.length && ['paused', 'interrupted'].includes(table.state))
        ) {
          table.state = !table.remainingCellIds.length
            ? 'completed'
            : table.state === 'paused'
              ? 'paused'
              : 'interrupted'
          table.revision++
          for (const cell of table.cells) if (cell.status === 'running') cell.status = 'pending'
          changed = true
        }
      if (changed) await this.save()
    } catch (error) {
      // A damaged optional feature must not stop application startup or replace its bytes.
      this.loadError = true
      this.tables = []
      this.options.onError?.(error)
    }
  }
  private async save(signal?: AbortSignal): Promise<void> {
    if (this.loadError)
      throw new ApplicationCommandError(
        'comparison-storage-unavailable',
        'comparison-storage-unavailable'
      )
    // Keep the v1 envelope atomic. Unchanged tables already passed schema validation.
    const parts = this.tables.map((table) => {
      const cached = this.serializedTables.get(table)
      if (cached?.revision === table.revision) return cached.json
      // History is append-only and replaced on append. Reuse validated evidence bytes on edits.
      const { cells, ...metadata } = comparisonTableSchema.parse({
        ...table,
        cells: table.cells.map((cell) => ({ ...cell, history: [] }))
      })
      const records = cells.map((cell, index) => {
        const history = table.cells[index].history
        let encoded = this.serializedHistories.get(history)
        if (encoded === undefined) {
          encoded = JSON.stringify(comparisonCellSchema.shape.history.parse(history))
          this.serializedHistories.set(history, encoded)
        }
        return (
          JSON.stringify({ ...cell, history: undefined }).slice(0, -1) +
          ',"history":' +
          encoded +
          '}'
        )
      })
      const json = JSON.stringify(metadata).slice(0, -1) + ',"cells":[' + records.join(',') + ']}'
      this.serializedTables.set(table, { revision: table.revision, json })
      return json
    })
    const content = '{"version":1,"tables":[' + parts.join(',') + ']}'
    if (Buffer.byteLength(content) > MAX_BYTES)
      throw new ApplicationCommandError('comparison-storage-limit', 'comparison-storage-limit')
    await withDataRootWrite(() => writeDurableJsonFile(this.options.path(), content), signal)
  }
  private async mutate<T>(
    changed: ComparisonTable | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const before = this.tables.map((table) => (table === changed ? structuredClone(table) : table))
    try {
      const result = await operation()
      await this.save()
      return result
    } catch (error) {
      this.tables = before
      throw error
    }
  }
  private mutateCell<T>(
    table: ComparisonTable,
    cellId: string,
    operation: (updated: ComparisonTable, cell: ComparisonCell) => Promise<T>
  ): Promise<T> {
    const index = table.cells.findIndex((cell) => cell.id === cellId)
    if (index < 0) throw new Error('comparison-cell-not-found')
    const original = table.cells[index]
    const cell = { ...original }
    const updated = { ...table, cells: [...table.cells] }
    updated.cells[index] = cell
    return this.mutate(undefined, async () => {
      this.tables[this.tables.indexOf(table)] = updated
      updated.revision++
      return operation(updated, cell)
    })
  }
  private syncCells(table: ComparisonTable): void {
    const fields = new Set(table.fields.map((field) => field.id))
    table.cells = table.cells.filter((cell) => fields.has(cell.fieldId))
    const existing = new Map<string, Set<string>>()
    for (const cell of table.cells) {
      const row = existing.get(cell.itemId) ?? new Set<string>()
      row.add(cell.fieldId)
      existing.set(cell.itemId, row)
    }
    for (const itemId of table.itemIds)
      for (const field of table.fields) {
        if (!existing.get(itemId)?.has(field.id))
          table.cells.push({
            id: randomUUID(),
            itemId,
            fieldId: field.id,
            status: 'pending',
            history: []
          })
      }
  }
  async run(input: ComparisonRequest): Promise<ComparisonResult> {
    const request = comparisonRequestSchema.parse(input)
    if (this.closed || !this.started) throw new Error('comparison-owner-unavailable')
    if (this.loadError && request.action === 'list' && request.retryStorage) {
      await this.queue(async () => {
        if (this.loadError) await withDataRootWrite(() => this.load())
      })
    }
    if (this.loadError)
      throw new ApplicationCommandError(
        'comparison-storage-unavailable',
        'comparison-storage-unavailable'
      )
    if (
      request.action === 'run' ||
      request.action === 'resume' ||
      request.action === 'retry' ||
      request.action === 'rerun-field'
    )
      return this.launch(request)
    if (request.action === 'check-sources') {
      const check = this.options.extractor.checkSource
      if (!check) throw new Error('comparison-source-check-unavailable')
      const snapshot = await this.queue(async () => {
        const table = this.tables.find((entry) => entry.id === request.tableId)
        if (!table || this.closed) throw new Error('comparison-owner-unavailable')
        const ids = new Set(request.itemIds ?? table.itemIds)
        const members = table.members.filter((member) => ids.has(member.itemId))
        if (members.length !== ids.size) throw new Error('comparison-member-not-found')
        // Readability checks use the policy and field names. Launch rechecks authority.
        return structuredClone({
          ...table,
          members,
          itemIds: members.map((m) => m.itemId),
          cells: [],
          taskSources: [],
          remainingCellIds: []
        })
      })
      const sourceChecks: NonNullable<ComparisonResult['sourceChecks']> = []
      for (let offset = 0; offset < snapshot.itemIds.length; offset += 4) {
        if (this.closed) throw new Error('comparison-owner-unavailable')
        sourceChecks.push(
          ...(await Promise.all(
            snapshot.itemIds
              .slice(offset, offset + 4)
              .map((id) => check.call(this.options.extractor, snapshot, id))
          ))
        )
      }
      return this.bounded({ tables: [], sourceChecks })
    }
    const result = await this.queue(async () => {
      if (this.closed) throw new Error('comparison-owner-unavailable')
      if (this.loadError)
        throw new ApplicationCommandError(
          'comparison-storage-unavailable',
          'comparison-storage-unavailable'
        )
      if (request.action === 'list') {
        const revision = this.options.sourceRevision?.()
        if (this.needsSourceScan(revision)) {
          await this.refreshSources()
          if (revision !== undefined) this.lastSourceScan = { revision, at: Date.now() }
        }
        return this.bounded({
          tables: [],
          summaries: this.tables.map((table) => ({
            id: table.id,
            name: table.name,
            state: table.state,
            issue: table.issue,
            revision: table.revision,
            memberCount: table.members.length,
            total: table.cells.length,
            pending: table.cells.filter((cell) => cell.status === 'pending').length,
            running: table.cells.filter((cell) => cell.status === 'running').length,
            succeeded: table.cells.filter((cell) => cell.status === 'succeeded').length,
            failed: table.cells.filter((cell) => cell.status === 'failed').length,
            unavailable: table.cells.filter((cell) => cell.status === 'unavailable').length,
            reference: comparisonTaskReference(table),
            pendingItemIds: [
              ...new Set(table.cells.filter(isPendingComparisonCell).map((cell) => cell.itemId))
            ]
          }))
        })
      }
      if (request.action === 'create')
        return this.mutate(undefined, async () => {
          if (this.tables.length >= 30)
            throw new ApplicationCommandError('comparison-table-limit', 'comparison-table-limit')
          if (new Set(request.fields.map((f) => f.id)).size !== request.fields.length)
            throw new Error('duplicate-field')
          const itemIds = [...new Set(request.itemIds)]
          const members = await Promise.all(itemIds.map((id) => this.options.extractor.member(id)))
          const table: ComparisonTable = {
            id: randomUUID(),
            name: request.name,
            language: request.language,
            sourcePolicy: request.sourcePolicy,
            revision: 1,
            fields: request.fields.map((f) => ({ ...f, version: 1 })),
            itemIds,
            members,
            cells: [],
            remainingCellIds: [],
            state: 'idle'
          }
          this.syncCells(table)
          this.tables.push(table)
          return this.project(table)
        })
      const table = this.tables.find((t) => t.id === request.tableId)
      if (!table) throw new Error('comparison-not-found')
      if (request.action === 'delete') {
        // Pausing does not cancel an admitted cell: let its checkpoint finish first.
        if (table.state === 'running' || this.inFlightAdmissions.has(table.id))
          throw new Error('comparison-busy')
        await this.mutate(undefined, async () => {
          this.tables = this.tables.filter((entry) => entry.id !== table.id)
        })
        for (const [token, snapshot] of this.matrixSnapshots)
          if (snapshot.id === table.id) this.matrixSnapshots.delete(token)
        this.extractors.delete(table.id)
        for (const [token, snapshot] of this.exportSnapshots)
          if (snapshot.tableId === table.id) this.releaseExportSnapshot(token)
        return { tables: [] }
      }
      if (request.action === 'read') {
        if (request.readToken) {
          const snapshot = this.matrixSnapshots.get(request.readToken)
          if (snapshot?.id !== table.id)
            throw new ApplicationCommandError('comparison-read-expired', 'comparison-read-expired')
          const page = this.project(snapshot, request.offset, 100)
          if (page.nextOffset === undefined) this.matrixSnapshots.delete(request.readToken)
          return { ...page, readToken: request.readToken }
        }
        if (!request.offset && this.needsSourceScan(this.options.sourceRevision?.()))
          await this.refreshSources(table.id)
        const current = this.tables.find((entry) => entry.id === table.id)!
        const page = this.project(current, request.offset, 100)
        if (request.offset || page.nextOffset === undefined) return page
        // Continuations read the same projection even as the worker checkpoints new results.
        const token = randomUUID()
        if (this.matrixSnapshots.size >= MAX_MATRIX_SNAPSHOTS)
          this.matrixSnapshots.delete(this.matrixSnapshots.keys().next().value!)
        this.matrixSnapshots.set(
          token,
          structuredClone({
            ...current,
            members: current.members.map((member) => ({ ...member, abstract: '' })),
            cells: current.cells.map(matrixCell)
          })
        )
        return { ...page, readToken: token }
      }
      if (request.action === 'read-cell') {
        const cell = table.cells.find((cell) => cell.id === request.cellId)
        if (!cell) throw new Error('comparison-cell-not-found')
        const offset = request.offset ?? 0
        if (offset > cell.history.length || (offset > 0 && offset === cell.history.length))
          throw new Error('comparison-invalid-offset')
        const history = cell.history.slice(offset, offset + 2)
        return this.bounded({
          tables: [],
          cell: structuredClone({ ...cell, history }),
          ...(offset + history.length < cell.history.length
            ? { nextOffset: offset + history.length }
            : {})
        })
      }
      if (request.action === 'export') {
        const offset = request.offset ?? 0
        for (const [token, snapshot] of this.exportSnapshots)
          if (snapshot.expiresAt <= Date.now()) this.releaseExportSnapshot(token)
        let token = request.exportToken
        if (offset === 0 && !token) {
          // Reject new work at capacity rather than invalidating an active download.
          if (this.exportSnapshots.size >= MAX_EXPORT_SNAPSHOTS)
            throw new Error('comparison-export-limit')
          await this.refreshSources(table.id)
          const captured = structuredClone(this.tables.find((current) => current.id === table.id)!)
          token = randomUUID()
          const snapshotToken = token
          const expiry = setTimeout(() => this.releaseExportSnapshot(snapshotToken), 300_000)
          expiry.unref()
          this.exportSnapshots.set(token, {
            tableId: table.id,
            table: captured,
            readers: {},
            expiresAt: Date.now() + 300_000,
            expiry
          })
        }
        const snapshot = token ? this.exportSnapshots.get(token) : undefined
        if (!snapshot || snapshot.tableId !== table.id) throw new Error('comparison-export-expired')
        const reader = (snapshot.readers[request.kind] ??= new ComparisonCsvReader(
          snapshot.table,
          request.kind
        ))
        const page = reader.read(offset)
        if (request.releaseOnComplete && page.nextOffset === undefined && token)
          this.releaseExportSnapshot(token)
        return { tables: [], exportToken: token, ...page }
      }
      if (request.action === 'update' && request.expectedRevision !== table.revision)
        throw new ApplicationCommandError('comparison-config-changed', 'comparison-config-changed')
      if (request.action === 'edit-cell')
        return this.mutateCell(table, request.cellId, async (table, cell) => {
          const field = table.fields.find((f) => f.id === cell.fieldId)!
          const member = await this.options.extractor.member(cell.itemId)
          if (
            field.version !== request.expectedFieldVersion ||
            member.sourceKey !== request.expectedSourceKey
          )
            throw new Error('comparison-review-changed')
          const latest = cell.history.at(-1)
          if (
            request.expectedAttemptId &&
            (latest?.id !== request.expectedAttemptId ||
              latest.fieldVersion !== field.version ||
              latest.sourceKey !== member.sourceKey)
          )
            throw new Error('comparison-review-changed')
          if (request.confirmed && latest?.value === request.value && !request.expectedAttemptId)
            throw new Error('comparison-review-attempt-required')
          const revision = cell.manual?.revision ?? 0
          if ((request.expectedManualRevision ?? 0) !== revision)
            throw new ApplicationCommandError(
              'comparison-manual-conflict',
              'comparison-manual-conflict'
            )
          cell.manual = {
            revision: revision + 1,
            attemptId: request.expectedAttemptId,
            value: request.value,
            confirmed: request.confirmed,
            fieldVersion: field.version,
            sourceKey: member.sourceKey,
            updatedAt: now()
          }
          // The edited cell may be outside the first page. Its receipt carries no history.
          return this.bounded({
            ...this.project(table),
            cell: structuredClone({ ...cell, history: [] })
          })
        })
      return this.mutate(table, async () => {
        if (request.action === 'update') {
          if (new Set(request.fields.map((f) => f.id)).size !== request.fields.length)
            throw new Error('duplicate-field')
          if (
            table.fields.some(
              (f) =>
                !request.fields.some((next) => next.id === f.id) &&
                table.cells.some((c) => c.fieldId === f.id && (c.history.length || c.manual))
            )
          )
            throw new Error('comparison-field-has-history')
          const previous = table.fields
          const policyChanged = table.sourcePolicy !== request.sourcePolicy
          const semanticChanged =
            policyChanged ||
            previous.length !== request.fields.length ||
            previous.some((old, index) => {
              const next = request.fields[index]
              return old.id !== next.id || old.name !== next.name || old.rule !== next.rule
            })
          // Preserve only definitions we actually know before replacing the current fields.
          for (const cell of table.cells) {
            const field = previous.find((f) => f.id === cell.fieldId)
            for (const attempt of cell.history)
              if (field && attempt.fieldVersion === field.version) {
                attempt.fieldSnapshot ??= { ...field }
                attempt.sourcePolicy ??= table.sourcePolicy
              }
          }
          table.fields = request.fields.map((f) => {
            const old = previous.find((p) => p.id === f.id)
            return {
              ...f,
              version: old
                ? old.version + Number(policyChanged || old.name !== f.name || old.rule !== f.rule)
                : 1
            }
          })
          table.name = request.name
          table.sourcePolicy = request.sourcePolicy
          this.syncCells(table)
          for (const cell of table.cells)
            if (
              previous.find((f) => f.id === cell.fieldId)?.version !==
              table.fields.find((f) => f.id === cell.fieldId)?.version
            ) {
              if (
                policyChanged ||
                cell.status !== 'unavailable' ||
                cell.history.at(-1)?.issue === 'full-text-insufficient'
              )
                cell.status = 'pending'
              if (cell.manual) cell.manual.confirmed = false
            }
          if (semanticChanged) {
            // An old completion may retain history, but no superseded task owns these cells.
            for (const cell of table.cells) if (cell.status === 'running') cell.status = 'pending'
            table.state = 'idle'
            table.taskId = randomUUID()
            table.remainingCellIds = []
          }
        } else if (request.action === 'set-sample') {
          if (request.itemIds.some((id) => !table.itemIds.includes(id)))
            throw new Error('comparison-member-not-found')
          table.sampleItemIds = [...new Set(request.itemIds)]
        } else if (request.action === 'add-members') {
          const added = [...new Set(request.itemIds)].filter((id) => !table.itemIds.includes(id))
          if (table.itemIds.length + added.length > 100) throw new Error('comparison-member-limit')
          table.members.push(
            ...(await Promise.all(added.map((id) => this.options.extractor.member(id))))
          )
          table.itemIds.push(...added)
          this.syncCells(table)
        } else if (request.action === 'pause') {
          if (table.state === 'running') table.state = 'paused'
        }
        table.revision++
        return this.project(table)
      })
    })
    this.kick()
    return result
  }
  private async launch(request: ComparisonLaunchRequest): Promise<ComparisonResult> {
    const table = await this.queue(async () => {
      const current = this.tables.find((entry) => entry.id === request.tableId)
      if (!current || this.closed) throw new Error('comparison-owner-unavailable')
      return structuredClone(current)
    })
    const revision = table.revision
    if (request.action === 'resume') {
      if (!['paused', 'interrupted'].includes(table.state)) throw new Error('comparison-not-paused')
      await this.refreshAdmission(table, request)
      const changed =
        table.taskSources?.filter((source) => {
          const cell = table.cells.find((cell) => cell.id === source.cellId)
          return (
            cell &&
            table.remainingCellIds.includes(cell.id) &&
            (source.sourceKey !== table.members.find((m) => m.itemId === cell.itemId)?.sourceKey ||
              source.fieldVersion !== table.fields.find((f) => f.id === cell.fieldId)?.version)
          )
        }) ?? []
      if (changed.length && !request.useCurrentSources)
        throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
      for (const source of changed) {
        const cell = table.cells.find((cell) => cell.id === source.cellId)!
        // The old in-flight result can be kept as history but cannot consume this new work.
        if (cell.status === 'running') table.taskId = randomUUID()
        source.sourceKey = table.members.find((m) => m.itemId === cell.itemId)!.sourceKey
        source.fieldVersion = table.fields.find((f) => f.id === cell.fieldId)!.version
        cell.status = 'pending'
      }
      const remaining = new Set(table.remainingCellIds)
      const readable = await this.readableTargets(
        table,
        table.cells.filter((cell) => remaining.has(cell.id))
      )
      table.remainingCellIds = readable.map((cell) => cell.id)
      const admitted = new Set(table.remainingCellIds)
      table.taskSources = table.taskSources?.filter(
        (source) => !remaining.has(source.cellId) || admitted.has(source.cellId)
      )
      table.state = readable.length ? 'running' : 'completed'
      delete table.issue
    } else {
      if (
        table.state === 'running' ||
        table.remainingCellIds.length ||
        table.cells.some((c) => c.status === 'running')
      )
        throw new Error('comparison-busy')
      await this.refreshAdmission(table, request)
      if ('itemIds' in request && request.itemIds?.some((id) => !table.itemIds.includes(id)))
        throw new Error('comparison-member-not-found')
      let targets: ComparisonCell[]
      if (request.action === 'retry') {
        const ids = new Set(request.cellIds)
        targets = table.cells.filter(
          (c) =>
            ids.has(c.id) &&
            (['failed', 'unavailable'].includes(c.status) ||
              (c.status === 'pending' &&
                c.history.at(-1)?.status === 'failed' &&
                c.history.at(-1)?.fieldVersion ===
                  table.fields.find((f) => f.id === c.fieldId)?.version))
        )
        if (targets.length !== ids.size) throw new Error('invalid-retry-targets')
      } else if (request.action === 'rerun-field') {
        if (!table.fields.some((f) => f.id === request.fieldId))
          throw new Error('comparison-field-not-found')
        targets = table.cells.filter(
          (c) =>
            c.fieldId === request.fieldId &&
            (!request.itemIds || request.itemIds.includes(c.itemId))
        )
      } else
        targets = table.cells.filter(
          (c) =>
            (request.unattemptedOnly
              ? isUnattemptedComparisonCell(c)
              : isPendingComparisonCell(c)) &&
            (!request.itemIds || request.itemIds.includes(c.itemId))
        )
      const eligible = targets.filter((cell) => cell.history.length < COMPARISON_HISTORY_LIMIT)
      const skipped = eligible.length !== targets.length
      targets = await this.readableTargets(table, eligible)
      for (const cell of targets) cell.status = 'pending'
      table.taskId = randomUUID()
      table.taskSources = targets.map((c) => ({
        cellId: c.id,
        sourceKey: table.members.find((m) => m.itemId === c.itemId)!.sourceKey,
        fieldVersion: table.fields.find((f) => f.id === c.fieldId)!.version
      }))
      table.remainingCellIds = targets.map((c) => c.id)
      table.state = targets.length ? 'running' : 'completed'
      if (skipped) table.issue = 'comparison-history-limit'
      else delete table.issue
    }
    const extractor =
      table.state === 'running'
        ? await this.options.capture().catch((cause: unknown) => {
            throw new ApplicationCommandError(
              'comparison-model-unavailable',
              'comparison-model-unavailable',
              undefined,
              { cause }
            )
          })
        : undefined
    return this.queue(async () => {
      const index = this.tables.findIndex((entry) => entry.id === table.id)
      if (this.closed) throw new Error('comparison-owner-unavailable')
      if (this.tables[index]?.revision !== revision)
        throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
      const result = await this.mutate(undefined, async () => {
        table.revision++
        this.tables[index] = table
        return this.project(table)
      })
      if (extractor) this.extractors.set(table.id, extractor)
      this.kick()
      return result
    })
  }
  private async refreshAdmission(
    table: ComparisonTable,
    request: ComparisonLaunchRequest
  ): Promise<void> {
    if (request.expectedRevision !== undefined && request.expectedRevision !== table.revision)
      throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
    const selectedCells =
      request.action === 'retry'
        ? new Set(request.cellIds)
        : request.action === 'resume'
          ? new Set(table.remainingCellIds)
          : undefined
    const itemIds = selectedCells
      ? new Set(table.cells.filter((cell) => selectedCells.has(cell.id)).map((cell) => cell.itemId))
      : 'itemIds' in request && request.itemIds
        ? new Set(request.itemIds)
        : undefined
    const changed = await this.refreshTable(table, request.expectedSources, undefined, itemIds)
    // A source update can add formerly reviewed cells to the pending scope.
    if (changed && request.action !== 'resume' && request.expectedRevision !== undefined)
      throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
  }
  /** Check each report once at admission; unavailable sources never enter the model queue. */
  private async readableTargets(
    table: ComparisonTable,
    targets: ComparisonCell[]
  ): Promise<ComparisonCell[]> {
    const check = this.options.extractor.checkSource
    const itemIds = [
      ...new Set(
        targets.filter((cell) => check || cell.status === 'unavailable').map((cell) => cell.itemId)
      )
    ]
    const unavailable = new Set<string>()
    for (let offset = 0; offset < itemIds.length; offset += 4) {
      const checks = await Promise.all(
        itemIds.slice(offset, offset + 4).map((itemId) =>
          check
            ? check.call(this.options.extractor, table, itemId)
            : this.options.extractor.member(itemId).then(
                (member) => ({ itemId, sourceKey: member.sourceKey, status: 'available' as const }),
                () => ({ itemId, sourceKey: '', status: 'missing' as const })
              )
        )
      )
      for (const source of checks) {
        const member = table.members.find((member) => member.itemId === source.itemId)!
        if (source.sourceKey && source.sourceKey !== member.sourceKey)
          throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
        if (source.status !== 'available') unavailable.add(source.itemId)
      }
    }
    for (const cell of targets)
      if (unavailable.has(cell.itemId)) {
        cell.status = 'unavailable'
        if (cell.manual) cell.manual.confirmed = false
      }
    return targets.filter((cell) => !unavailable.has(cell.itemId))
  }
  private async refreshTable(
    table: ComparisonTable,
    expectedSources?: ComparisonLaunchRequest['expectedSources'],
    beforeChange?: () => void,
    itemIds?: ReadonlySet<string>
  ): Promise<boolean> {
    const expected = new Map(expectedSources?.map(({ itemId, sourceKey }) => [itemId, sourceKey]))
    let changed = false
    for (let i = 0; i < table.members.length; i++) {
      const member = table.members[i]
      if (itemIds && !itemIds.has(member.itemId)) {
        expected.delete(member.itemId)
        continue
      }
      let sourceKey = ''
      try {
        const current = await this.options.extractor.member(member.itemId)
        sourceKey = current.sourceKey
        if (current.sourceKey !== member.sourceKey) {
          if (!changed) beforeChange?.()
          table.members[i] = current
          changed = true
          for (const cell of table.cells.filter((c) => c.itemId === member.itemId)) {
            // Live freshness must not take ownership away from an in-flight task.
            if (!['running', 'failed', 'unavailable'].includes(cell.status)) cell.status = 'pending'
            if (cell.manual) cell.manual.confirmed = false
          }
        }
      } catch {
        for (const cell of table.cells.filter((c) => c.itemId === member.itemId)) {
          if (!['running', 'unavailable'].includes(cell.status)) {
            if (!changed) beforeChange?.()
            cell.status = 'unavailable'
            changed = true
          }
          if (cell.manual?.confirmed) {
            if (!changed) beforeChange?.()
            cell.manual.confirmed = false
            changed = true
          }
        }
      }
      const expectedKey = expected.get(member.itemId)
      if (expectedKey !== undefined && expectedKey !== sourceKey)
        throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
      expected.delete(member.itemId)
    }
    if (expected.size)
      throw new ApplicationCommandError('comparison-task-changed', 'comparison-task-changed')
    if (changed) table.revision++
    return changed
  }
  private async refreshSources(tableId?: string): Promise<void> {
    const previous = new Map<string, ComparisonTable>()
    try {
      for (const table of this.tables) {
        if (!tableId || table.id === tableId) {
          await this.refreshTable(table, undefined, () =>
            previous.set(table.id, structuredClone(table))
          )
        }
      }
      if (previous.size) await this.save()
    } catch (error) {
      this.tables = this.tables.map((table) => previous.get(table.id) ?? table)
      throw error
    }
  }
  private kick(): void {
    if (
      this.worker ||
      this.closed ||
      isMigrationPending() ||
      !this.tables.some((t) => t.state === 'running')
    )
      return
    outsideDataRootWriteContext(() => {
      this.worker = this.work()
        .catch(async (error) => {
          if (this.closed || this.lifetime.signal.aborted) return
          this.options.onError?.(error)
          await this.queue(async () => {
            if (this.closed || this.lifetime.signal.aborted) return
            for (const table of this.tables)
              if (
                table.state === 'running' ||
                (table.state === 'paused' && table.cells.some((cell) => cell.status === 'running'))
              ) {
                table.state = 'paused'
                table.issue =
                  error instanceof ApplicationCommandError &&
                  error.code === 'comparison-storage-limit'
                    ? error.code
                    : 'checkpoint-failed'
                table.revision++
                for (const cell of table.cells)
                  if (cell.status === 'running') cell.status = 'pending'
              }
            try {
              await this.save(this.lifetime.signal)
            } catch (saveError) {
              if (!this.lifetime.signal.aborted) this.options.onError?.(saveError)
            }
          })
        })
        .finally(() => {
          this.worker = undefined
          this.kick()
        })
    })
  }
  private async work(): Promise<void> {
    while (!this.closed && !isMigrationPending()) {
      try {
        const configuredConcurrency =
          this.options.comparisonConcurrency ?? MAX_COMPARISON_CONCURRENCY
        const concurrency = Math.min(
          MAX_COMPARISON_CONCURRENCY,
          Math.max(
            1,
            Number.isFinite(configuredConcurrency) ? Math.trunc(configuredConcurrency) : 1
          )
        )
        const batch = Array.from({ length: concurrency }, () =>
          withDataRootWrite(() => {
            if (this.closed || this.lifetime.signal.aborted) return Promise.resolve(true)
            return this.workCell()
          }, this.lifetime.signal)
        )
        // Drain every admitted cell before entering the shared failure handler. A rejected
        // checkpoint must not leave sibling extractions running outside the worker's lifecycle.
        const settled = await Promise.allSettled(batch)
        const rejected = settled.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (rejected) throw rejected.reason
        const results = settled
          .filter(
            (result): result is PromiseFulfilledResult<boolean> => result.status === 'fulfilled'
          )
          .map((result) => result.value)
        // Every `true` result means that worker found no more admitted cells. Once the
        // batch has drained, another batch can only make progress if at least one worker
        // actually processed a cell.
        if (results.every(Boolean)) return
      } catch (error) {
        // A migration can close admission between the loop check and lease acquisition.
        if (this.closed || this.lifetime.signal.aborted || isMigrationPending()) return
        throw error
      }
    }
  }
  private async workCell(): Promise<boolean> {
    const selected = await this.queue(async () => {
      if (this.closed || this.lifetime.signal.aborted) return undefined
      const table = this.tables.find((t) => t.state === 'running')
      if (!table) return undefined
      const remaining = new Set(table.remainingCellIds)
      const cell = table.cells.find((c) => c.status === 'pending' && remaining.has(c.id))
      if (cell && cell.history.length >= COMPARISON_HISTORY_LIMIT) {
        await this.mutate(table, async () => {
          cell.status = 'failed'
          table.remainingCellIds = table.remainingCellIds.filter((id) => id !== cell.id)
          table.issue = 'comparison-history-limit'
          table.revision++
        })
        return null
      }
      if (!cell) {
        // A concurrent batch can have admitted every remaining cell already. Leave the
        // table running until those checkpoints drain; the next batch will finalize it.
        if (table.cells.some((c) => c.status === 'running' && remaining.has(c.id))) return undefined
        await this.mutate(table, async () => {
          table.state = 'completed'
          table.revision++
          table.remainingCellIds = []
        })
        return null
      }
      // The queued ID is already durable. A crash before the result checkpoint
      // requeues this cell whether its on-disk status is pending or running.
      cell.status = 'running'
      table.revision++
      const member = table.members.find((m) => m.itemId === cell.itemId)!
      const expected = table.taskSources?.find((t) => t.cellId === cell.id)
      const snapshot = {
        id: table.id,
        taskId: table.taskId,
        language: table.language,
        sourcePolicy: table.sourcePolicy,
        members: [{ ...member, sourceKey: expected?.sourceKey ?? member.sourceKey }]
      }
      const admissionId = randomUUID()
      const admissions = this.inFlightAdmissions.get(table.id) ?? new Set<string>()
      admissions.add(admissionId)
      this.inFlightAdmissions.set(table.id, admissions)
      return {
        extractor: this.extractors.get(table.id),
        table: snapshot,
        cell: { id: cell.id, itemId: cell.itemId },
        field: structuredClone(table.fields.find((f) => f.id === cell.fieldId)!),
        admissionId
      }
    })
    if (selected === undefined) return true
    if (!selected) return false
    const { table, cell, field, extractor, admissionId } = selected
    let extraction: ComparisonExtraction
    let global = false
    try {
      // Capture exactly once per admitted operation; retry/resume deliberately capture anew.
      this.lifetime.signal.throwIfAborted()
      if (!extractor) throw new ComparisonGlobalError('model-unavailable')
      extraction = await extractor.extract(table, field, cell.itemId, this.lifetime.signal)
    } catch (error) {
      global = error instanceof ComparisonGlobalError
      const issue =
        error instanceof Error &&
        [
          'source-unavailable',
          'source-changed',
          'abstract-unavailable',
          'full-text-unavailable',
          'full-text-insufficient',
          'input-too-large',
          'invalid-evidence',
          'unsupported-value'
        ].includes(error.message)
          ? error.message
          : global
            ? 'model-unavailable'
            : 'extraction-failed'
      extraction = {
        status: 'failed',
        value: null,
        evidence: [],
        sourceKey: table.members.find((m) => m.itemId === cell.itemId)?.sourceKey ?? '',
        issue
      }
    }
    try {
      await this.queue(async () => {
        const saved = this.tables.find((entry) => entry.id === table.id)!
        if (!saved.cells.some((entry) => entry.id === cell.id)) return
        return this.mutateCell(saved, cell.id, async (current, target) => {
          if (extraction.status === 'succeeded' && !this.closed) {
            // The source may change after extraction or while its checkpoint waits in the queue.
            // Keep the admitted identity; a live refresh must never rebind this result.
            let issue: string | undefined
            try {
              const member = await this.options.extractor.member(cell.itemId)
              const admitted = table.members.find((m) => m.itemId === cell.itemId)!.sourceKey
              if (member.sourceKey !== admitted || extraction.sourceKey !== admitted)
                issue = 'source-changed'
            } catch {
              issue = 'source-unavailable'
            }
            if (issue)
              extraction = {
                status: 'failed',
                sourceKey: table.members.find((m) => m.itemId === cell.itemId)!.sourceKey,
                value: null,
                evidence: [],
                issue
              }
          }
          if (this.closed) {
            target.status = 'pending'
            current.state = 'interrupted'
            return
          }
          target.history = [
            ...target.history,
            {
              ...extraction,
              id: randomUUID(),
              at: now(),
              fieldVersion: field.version,
              fieldSnapshot: { ...field },
              sourcePolicy: table.sourcePolicy,
              ...(extraction.status === 'succeeded' && extraction.value === null
                ? { issue: 'insufficient-evidence' }
                : {})
            }
          ]
          if (current.taskId !== table.taskId) return
          const freshField = current.fields.find((f) => f.id === field.id)
          if (freshField?.version === field.version)
            target.status =
              extraction.status === 'succeeded'
                ? 'succeeded'
                : extraction.issue?.includes('unavailable') ||
                    extraction.issue === 'full-text-insufficient' ||
                    extraction.issue === 'source-changed'
                  ? 'unavailable'
                  : 'failed'
          if (!global)
            current.remainingCellIds = current.remainingCellIds.filter((id) => id !== cell.id)
          if (global) {
            target.status = 'pending'
            current.state = 'paused'
            current.issue = 'model-unavailable'
          }
          if (!current.remainingCellIds.length) current.state = 'completed'
        })
      })
    } finally {
      const admissions = this.inFlightAdmissions.get(table.id)
      admissions?.delete(admissionId)
      if (admissions?.size === 0) this.inFlightAdmissions.delete(table.id)
    }
    return false
  }
  private readonly extractors = new Map<string, Awaited<ReturnType<Options['capture']>>>()
  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await this.worker
    await this.serial
    this.matrixSnapshots.clear()
    this.extractors.clear()
    for (const token of this.exportSnapshots.keys()) this.releaseExportSnapshot(token)
  }
}

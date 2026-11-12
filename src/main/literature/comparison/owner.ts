import { randomUUID } from 'node:crypto'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import { ApplicationCommandError } from '../../../shared/application-command-contract'
import {
  comparisonCellView,
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
const MAX_EXPORT_SNAPSHOTS = 8
const now = (): string => new Date().toISOString()
type Options = {
  sourceRevision?: () => number
  path: () => string
  extractor: Pick<ComparisonExtractor, 'member'> & Partial<Pick<ComparisonExtractor, 'checkSource'>>
  capture(): Promise<{
    extract(
      table: ComparisonTable,
      field: ComparisonTable['fields'][number],
      itemId: string,
      signal: AbortSignal
    ): Promise<ComparisonExtraction>
  }>
  onError?(error: unknown): void
}
/** Process-owned worker; renderer leases never own or cancel a comparison job. */
export class LiteratureComparisons {
  private tables: ComparisonTable[] = []
  private readonly exportSnapshots = new Map<
    string,
    {
      tableId: string
      table: ComparisonTable
      csv: Partial<Record<'matrix' | 'evidence', string>>
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
    const cells = table.cells.slice(offset, offset + limit).map((cell) => ({
      ...cell,
      history: cell.history.slice(-1).map((attempt) => ({ ...attempt, evidence: [] }))
    }))
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
  private inFlightTableId?: string
  private lastSourceScan?: { revision: number; at: number }
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
    await runDataRootStartupRecovery(() =>
      this.queue(() =>
        withDataRootWrite(async () => {
          if (this.closed) return
          try {
            const saved = await readDurableJsonFile(
              this.options.path(),
              (text) => envelope.parse(JSON.parse(text)),
              {},
              { maxBytes: MAX_BYTES }
            )
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
                for (const cell of table.cells)
                  if (cell.status === 'running') cell.status = 'pending'
                changed = true
              }
            if (changed) await this.save()
          } catch (error) {
            // A damaged optional feature must not stop application startup or replace its bytes.
            this.loadError = true
            this.tables = []
            this.options.onError?.(error)
          }
        })
      )
    )
    this.started = true
  }
  private async save(signal?: AbortSignal): Promise<void> {
    if (this.loadError) throw new Error('comparison-storage-unavailable')
    // Keep the v1 envelope atomic. Unchanged tables already passed schema validation.
    const parts = this.tables.map((table) => {
      const cached = this.serializedTables.get(table)
      if (cached?.revision === table.revision) return cached.json
      const json = JSON.stringify(comparisonTableSchema.parse(table))
      this.serializedTables.set(table, { revision: table.revision, json })
      return json
    })
    const content = '{"version":1,"tables":[' + parts.join(',') + ']}'
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('comparison-storage-limit')
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
  private syncCells(table: ComparisonTable): void {
    table.cells = table.cells.filter((c) => table.fields.some((f) => f.id === c.fieldId))
    for (const itemId of table.itemIds)
      for (const field of table.fields) {
        if (!table.cells.some((c) => c.itemId === itemId && c.fieldId === field.id))
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
    if (this.loadError) throw new Error('comparison-storage-unavailable')
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
      if (this.loadError) throw new Error('comparison-storage-unavailable')
      if (request.action === 'list') {
        const revision = this.options.sourceRevision?.()
        if (
          revision === undefined ||
          revision !== this.lastSourceScan?.revision ||
          Date.now() - this.lastSourceScan.at >= 60_000
        ) {
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
          if (this.tables.length >= 30) throw new Error('comparison-table-limit')
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
        if (table.state === 'running' || this.inFlightTableId === table.id)
          throw new Error('comparison-busy')
        await this.mutate(undefined, async () => {
          this.tables = this.tables.filter((entry) => entry.id !== table.id)
        })
        this.extractors.delete(table.id)
        for (const [token, snapshot] of this.exportSnapshots)
          if (snapshot.tableId === table.id) this.releaseExportSnapshot(token)
        return { tables: [] }
      }
      if (request.action === 'read') {
        // Continuation pages carry the current revision; the renderer restarts on changes.
        if (!request.offset) await this.refreshSources(table.id)
        return this.project(
          this.tables.find((t) => t.id === table.id)!,
          request.offset,
          100
        )
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
          const csv = this.export(captured, request.kind)
          token = randomUUID()
          const snapshotToken = token
          const expiry = setTimeout(() => this.releaseExportSnapshot(snapshotToken), 300_000)
          expiry.unref()
          this.exportSnapshots.set(token, {
            tableId: table.id,
            table: captured,
            csv: { [request.kind]: csv },
            expiresAt: Date.now() + 300_000,
            expiry
          })
        }
        const snapshot = token ? this.exportSnapshots.get(token) : undefined
        if (!snapshot || snapshot.tableId !== table.id) throw new Error('comparison-export-expired')
        const content = (snapshot.csv[request.kind] ??= this.export(snapshot.table, request.kind))
        if (offset >= content.length) throw new Error('comparison-invalid-offset')
        const csv = content.slice(offset, offset + 100_000)
        if (request.releaseOnComplete && offset + csv.length === content.length && token)
          this.releaseExportSnapshot(token)
        return this.bounded({
          tables: [],
          csv,
          exportToken: token,
          ...(offset + csv.length < content.length ? { nextOffset: offset + csv.length } : {})
        })
      }
      if (request.action === 'update' && request.expectedRevision !== table.revision)
        throw new ApplicationCommandError('comparison-config-changed', 'comparison-config-changed')
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
        } else if (request.action === 'add-members') {
          const added = [...new Set(request.itemIds)].filter((id) => !table.itemIds.includes(id))
          if (table.itemIds.length + added.length > 100) throw new Error('comparison-member-limit')
          table.members.push(
            ...(await Promise.all(added.map((id) => this.options.extractor.member(id))))
          )
          table.itemIds.push(...added)
          this.syncCells(table)
        } else if (request.action === 'edit-cell') {
          const cell = table.cells.find((c) => c.id === request.cellId)
          if (!cell) throw new Error('comparison-cell-not-found')
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
          cell.manual = {
            attemptId: request.expectedAttemptId,
            value: request.value,
            confirmed: request.confirmed,
            fieldVersion: field.version,
            sourceKey: member.sourceKey,
            updatedAt: now()
          }
          table.revision++
          // The edited cell may be outside the first page. Its receipt carries no history.
          return this.bounded({
            ...this.project(table),
            cell: structuredClone({ ...cell, history: [] })
          })
        } else if (request.action === 'pause') {
          if (table.state === 'running') table.state = 'paused'
        } else if (request.action === 'resume') {
          if (!['paused', 'interrupted'].includes(table.state))
            throw new Error('comparison-not-paused')
          await this.refreshAdmission(table, request)
          const changed =
            table.taskSources?.filter((source) => {
              const cell = table.cells.find((cell) => cell.id === source.cellId)
              return (
                cell &&
                table.remainingCellIds.includes(cell.id) &&
                (source.sourceKey !==
                  table.members.find((m) => m.itemId === cell.itemId)?.sourceKey ||
                  source.fieldVersion !== table.fields.find((f) => f.id === cell.fieldId)?.version)
              )
            }) ?? []
          if (changed.length && !request.useCurrentSources)
            throw new Error('comparison-task-changed')
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
          if (readable.length) this.extractors.set(table.id, await this.options.capture())
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
          if (targets.some((c) => c.history.length >= 30))
            throw new Error('comparison-history-limit')
          targets = await this.readableTargets(table, targets)
          for (const cell of targets) cell.status = 'pending'
          if (targets.length) this.extractors.set(table.id, await this.options.capture())
          table.taskId = randomUUID()
          table.taskSources = targets.map((c) => ({
            cellId: c.id,
            sourceKey: table.members.find((m) => m.itemId === c.itemId)!.sourceKey,
            fieldVersion: table.fields.find((f) => f.id === c.fieldId)!.version
          }))
          table.remainingCellIds = targets.map((c) => c.id)
          table.state = targets.length ? 'running' : 'completed'
          delete table.issue
        }
        table.revision++
        return this.project(table)
      })
    })
    this.kick()
    return result
  }
  private async refreshAdmission(
    table: ComparisonTable,
    request: ComparisonLaunchRequest
  ): Promise<void> {
    if (request.expectedRevision !== undefined && request.expectedRevision !== table.revision)
      throw new Error('comparison-task-changed')
    const changed = await this.refreshTable(table, request.expectedSources)
    // A source update can add formerly reviewed cells to the pending scope.
    if (changed && request.action !== 'resume' && request.expectedRevision !== undefined)
      throw new Error('comparison-task-changed')
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
          throw new Error('comparison-task-changed')
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
    beforeChange?: () => void
  ): Promise<boolean> {
    const expected = new Map(expectedSources?.map(({ itemId, sourceKey }) => [itemId, sourceKey]))
    let changed = false
    for (let i = 0; i < table.members.length; i++) {
      const member = table.members[i]
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
        throw new Error('comparison-task-changed')
      expected.delete(member.itemId)
    }
    if (expected.size) throw new Error('comparison-task-changed')
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
                table.issue = 'checkpoint-failed'
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
        const done = await withDataRootWrite(async () => {
          if (this.closed || this.lifetime.signal.aborted) return true
          try {
            return await this.workCell()
          } finally {
            this.inFlightTableId = undefined
          }
        }, this.lifetime.signal)
        if (done) return
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
      const cell = table.cells.find((c) => table.remainingCellIds.includes(c.id))
      if (cell && cell.history.length >= 30) {
        await this.mutate(table, async () => {
          cell.status = 'failed'
          table.remainingCellIds = table.remainingCellIds.filter((id) => id !== cell.id)
          table.issue = 'comparison-history-limit'
          table.revision++
        })
        return null
      }
      if (!cell) {
        await this.mutate(table, async () => {
          table.state = 'completed'
          table.revision++
          table.remainingCellIds = []
        })
        return null
      }
      await this.mutate(table, async () => {
        cell.status = 'running'
        table.revision++
      })
      const snapshot = structuredClone(table)
      const expected = table.taskSources?.find((t) => t.cellId === cell.id)
      if (expected)
        snapshot.members.find((m) => m.itemId === cell.itemId)!.sourceKey = expected.sourceKey
      this.inFlightTableId = table.id
      return {
        extractor: this.extractors.get(table.id),
        table: snapshot,
        cell: structuredClone(cell),
        field: structuredClone(table.fields.find((f) => f.id === cell.fieldId)!)
      }
    })
    if (selected === undefined) return true
    if (!selected) return false
    const { table, cell, field, extractor } = selected
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
    await this.queue(() => {
      const current = this.tables.find((t) => t.id === table.id)!
      return this.mutate(current, async () => {
        const target = current.cells.find((c) => c.id === cell.id)
        if (!target) return
        current.revision++
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
        target.history.push({
          ...extraction,
          id: randomUUID(),
          at: now(),
          fieldVersion: field.version,
          fieldSnapshot: { ...field },
          sourcePolicy: table.sourcePolicy,
          ...(extraction.status === 'succeeded' && extraction.value === null
            ? { issue: 'insufficient-evidence' }
            : {})
        })
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
    return false
  }
  private readonly extractors = new Map<string, Awaited<ReturnType<Options['capture']>>>()
  private export(table: ComparisonTable, kind: 'matrix' | 'evidence'): string {
    const csv = (value: unknown): string =>
      '"' +
      String(value ?? '')
        .replaceAll('"', '""')
        .replace(/^(\s*)([=+@\-\t\r])/, "'$1$2") +
      '"'
    const current = (cell: ComparisonCell): boolean => {
      const field = table.fields.find((f) => f.id === cell.fieldId)
      const member = table.members.find((m) => m.itemId === cell.itemId)
      return !!field && comparisonCellView(cell, field, member?.sourceKey).confirmed
    }
    const rows: unknown[][] =
      kind === 'matrix'
        ? [
            [
              'itemId',
              'title',
              // Identity is independent of user labels and cannot collide with metadata columns.
              // JSON encoding also preserves unusual IDs without URI encoding failures.
              ...table.fields.flatMap((field) =>
                ['value', 'machine value', 'manual value', 'status', 'reviewed'].map(
                  (role) => `field:${JSON.stringify([field.id, role])} ${field.name}`
                )
              )
            ]
          ]
        : [
            [
              'itemId',
              'cellId',
              'cellStatus',
              'fieldId',
              'field',
              'rule',
              'sourcePolicy',
              'fieldVersion',
              'attempt',
              'status',
              'value',
              'coverage',
              'sourceKey',
              'model',
              'issue',
              'pageStart',
              'pageEnd',
              'quote',
              'manual',
              'manualFieldVersion',
              'manualSourceKey',
              'confirmedCurrent'
            ]
          ]
    if (kind === 'matrix')
      for (const member of table.members)
        rows.push([
          member.itemId,
          member.title,
          ...table.fields.flatMap((f) => {
            const c = table.cells.find((c) => c.itemId === member.itemId && c.fieldId === f.id)!
            const latest = c.history
              .filter((h) => h.fieldVersion === f.version && h.sourceKey === member.sourceKey)
              .at(-1)
            const machine = c.history.at(-1)
            const view = comparisonCellView(c, f, member.sourceKey)
            return [
              c.manual?.value ?? latest?.value ?? '',
              machine?.value ?? '',
              c.manual?.value ?? '',
              c.status +
                (view.stale ? ': outdated' : '') +
                (view.needsReview ? ': manual-needs-review' : '') +
                (machine?.issue ? ': ' + machine.issue : ''),
              view.confirmed
            ]
          })
        ])
    else
      for (const cell of table.cells) {
        const field = table.fields.find((f) => f.id === cell.fieldId)
        for (const attempt of cell.history.length ? cell.history : [undefined]) {
          // Older attempts without a snapshot cannot inherit a newer definition.
          const knownCurrent = !attempt || attempt.fieldVersion === field?.version
          const historicalField = attempt?.fieldSnapshot ?? (knownCurrent ? field : undefined)
          const sourcePolicy =
            attempt?.sourcePolicy ?? (knownCurrent ? table.sourcePolicy : undefined)
          for (const evidence of attempt?.evidence.length ? attempt.evidence : [undefined])
            rows.push([
              cell.itemId,
              cell.id,
              cell.status,
              cell.fieldId,
              historicalField?.name,
              historicalField?.rule,
              sourcePolicy,
              attempt?.fieldVersion,
              attempt?.id,
              attempt?.status,
              attempt?.value,
              attempt?.coverage,
              attempt?.sourceKey,
              attempt?.model,
              attempt?.issue,
              evidence?.pageStart,
              evidence?.pageEnd,
              evidence?.quote,
              cell.manual?.value,
              cell.manual?.fieldVersion,
              cell.manual?.sourceKey,
              current(cell)
            ])
        }
      }
    const content = '\uFEFF' + rows.map((row) => row.map(csv).join(',')).join('\r\n')
    if (content.length > 20_000_000) throw new Error('comparison-export-limit')
    return content
  }
  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    await this.worker
    await this.serial
    this.extractors.clear()
    for (const token of this.exportSnapshots.keys()) this.releaseExportSnapshot(token)
  }
}

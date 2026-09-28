import { createHash, randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { Prisma, type PrismaClient } from '@prisma/client'
import { createLogger } from '../logger'
import { searchTitleRank } from '../../shared/search-text'
import { isCurrentInFlight } from '../../shared/in-flight-promise'
import {
  JOURNAL_IMPORT_MAX_BYTES,
  JOURNAL_IMPORT_MAX_ROWS,
  journalDatasetSchema,
  journalIdentitySchema,
  journalImportRowSchema,
  journalRequestSchema,
  journalChoices,
  journalIdentityFromItem,
  journalBindingIdentity,
  journalColumnKey,
  selectJournalDatasets,
  journalAttributeFilterSchema,
  normalizeJournalExternalIdNamespace,
  normalizeJournalExternalIdValue,
  type JournalMatchReason,
  type JournalMatchStatus,
  type JournalAlignment,
  journalNumber,
  missingJournalValue,
  normalizeIssn,
  normalizeJournalName,
  type JournalDataset,
  type JournalAttributeFilter,
  type JournalIdentity,
  type JournalImportRow,
  type JournalPreviewRow,
  type JournalRequest,
  type JournalResult
} from '../../shared/journal-attributes'

const log = createLogger('journal-attributes')

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>
type Journal = JournalIdentity & { id: string }
type ReferenceIdentity = {
  id: string
  title: string
  metadataRevision: number
  identity: JournalIdentity
  fingerprint: string
  bindingJournalId: string | null
  bindingFingerprint: string | null
  bindingRevision: string | null
}
const matchReference = (item: ReferenceIdentity, index: Index): ReturnType<typeof matchJournal> =>
  item.bindingJournalId &&
  item.fingerprint === item.bindingFingerprint &&
  index.journals.has(item.bindingJournalId)
    ? { id: item.bindingJournalId, reason: 'manual', candidates: [item.bindingJournalId] }
    : matchJournal(item.identity, index)
const identityKey = (identity: JournalIdentity): string =>
  JSON.stringify([
    identity.name.trim(),
    identity.aliases.map((alias) => alias.trim()).sort(),
    [...identity.issns].sort(),
    (identity.externalIds ?? [])
      .map(({ namespace, value }) => [
        normalizeJournalExternalIdNamespace(namespace),
        normalizeJournalExternalIdValue(value)
      ])
      .sort(([left], [right]) => left.localeCompare(right))
  ])
type DatasetRow = {
  id: string
  name: string | null
  source: string
  year: number
  revision: number
  fieldsJson: string
  importedAt: Date | string | number
  count: bigint
}
type Snapshot = { client: PrismaClient; index: Index; datasets: JournalDataset[] }
type Entry = { journalId: string; valuesJson: string; sourceRow: number }
type Stage = {
  client: PrismaClient
  request: Extract<JournalRequest, { action: 'begin' }>
  rows: JournalImportRow[]
  numbers: Set<number>
  preparing?: boolean
  discarded?: boolean
  committing?: Promise<JournalResult>
  completed?: boolean
  preview?: { version: number; result: JournalResult; problems: JournalPreviewRow[] }
  bytes: number
  touched: number
  reviewed?: string
}
type Index = {
  journals: Map<string, Journal>
  issns: Map<string, Set<string>>
  names: Map<string, Set<string>>
  externalIds: Map<string, Set<string>>
}
const STAGE_TTL = 30 * 60_000
const STAGING_BUDGET = JOURNAL_IMPORT_MAX_BYTES * 3

const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
  if (!key) return
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}
const indexJournal = (index: Index, journal: Journal): void => {
  index.journals.set(journal.id, journal)
  journal.issns.forEach((issn) => {
    const key = normalizeIssn(issn)
    if (key) add(index.issns, key, journal.id)
  })
  ;[journal.name, ...journal.aliases].forEach((name) =>
    add(index.names, missingJournalValue(name) ? '' : normalizeJournalName(name), journal.id)
  )
  for (const externalId of journal.externalIds ?? [])
    add(
      index.externalIds,
      `${normalizeJournalExternalIdNamespace(externalId.namespace)}:${normalizeJournalExternalIdValue(externalId.value)}`,
      journal.id
    )
}
const buildIndex = async (journals: Journal[]): Promise<Index> => {
  const index: Index = {
    journals: new Map(),
    issns: new Map(),
    names: new Map(),
    externalIds: new Map()
  }
  for (let offset = 0; offset < journals.length; offset++) {
    indexJournal(index, journals[offset])
    if (offset % 500 === 499) await setImmediate()
  }
  return index
}

export function matchJournal(
  identity: JournalIdentity,
  index: Index
): { id?: string; ambiguous?: boolean; reason: JournalMatchReason; candidates: string[] } {
  const externalIds = (identity.externalIds ?? [])
    .filter(({ namespace, value }) => namespace && value)
    .map(
      ({ namespace, value }) =>
        `${normalizeJournalExternalIdNamespace(namespace)}:${normalizeJournalExternalIdValue(value)}`
    )
  const externalMatches = new Set(
    externalIds.flatMap((key) => [...(index.externalIds.get(key) ?? [])])
  )
  if (externalMatches.size > 1)
    return { ambiguous: true, reason: 'multiple-candidates', candidates: [...externalMatches] }
  if (externalMatches.size === 1) {
    const [id] = externalMatches
    const issnMatches = new Set(
      identity.issns.flatMap((value) => {
        const normalized = normalizeIssn(value)
        return normalized ? [...(index.issns.get(normalized) ?? [])] : []
      })
    )
    if (issnMatches.size && (!issnMatches.has(id) || issnMatches.size > 1))
      return {
        ambiguous: true,
        reason: 'identifier-conflict',
        candidates: [...new Set([id, ...issnMatches])]
      }
    return { id, reason: 'external-id', candidates: [id] }
  }
  const issns = identity.issns.flatMap((value) => normalizeIssn(value) ?? [])
  const byId = new Set(issns.flatMap((issn) => [...(index.issns.get(issn) ?? [])]))
  if (byId.size > 1)
    return { ambiguous: true, reason: 'multiple-candidates', candidates: [...byId] }
  if (byId.size === 1) return { id: [...byId][0], reason: 'issn', candidates: [...byId] }
  const names = new Set(
    [identity.name, ...identity.aliases].flatMap((name) => [
      ...(index.names.get(missingJournalValue(name) ? '' : normalizeJournalName(name)) ?? [])
    ])
  )
  if (names.size > 1)
    return { ambiguous: true, reason: 'multiple-candidates', candidates: [...names] }
  const candidate = names.size ? index.journals.get([...names][0]) : undefined
  if (!candidate)
    return {
      reason:
        !issns.length &&
        ![identity.name, ...identity.aliases].some(
          (name) => !missingJournalValue(name) && normalizeJournalName(name)
        )
          ? 'missing-identity'
          : 'not-found',
      candidates: []
    }
  // No external ID matched above, so a shared namespace now means conflicting values.
  const externalConflict = candidate.externalIds?.some(({ namespace }) =>
    identity.externalIds?.some(
      (externalId) =>
        normalizeJournalExternalIdNamespace(externalId.namespace) ===
        normalizeJournalExternalIdNamespace(namespace)
    )
  )
  if (externalConflict || (issns.length && candidate.issns.some((value) => normalizeIssn(value))))
    return { ambiguous: true, reason: 'identifier-conflict', candidates: [candidate.id] }
  return { id: candidate.id, reason: 'name', candidates: [candidate.id] }
}

const readJournals = async (client: Reader): Promise<Journal[]> => {
  const rows = await client.$queryRaw<
    { id: string; name: string; aliasesJson: string; issnsJson: string; externalIdsJson: string }[]
  >`SELECT * FROM "Journal"`
  const journals: Journal[] = []
  for (const row of rows) {
    journals.push({
      id: row.id,
      ...journalIdentitySchema.parse({
        name: row.name,
        aliases: JSON.parse(row.aliasesJson),
        issns: JSON.parse(row.issnsJson),
        externalIds: JSON.parse(row.externalIdsJson)
      })
    })
    if (journals.length % 500 === 0) await setImmediate()
  }
  return journals
}
const readDatasets = async (client: Reader): Promise<JournalDataset[]> => {
  const rows = await client.$queryRaw<
    DatasetRow[]
  >`SELECT d.*, COUNT(e."journalId") AS count FROM "JournalDataset" d LEFT JOIN "JournalDatasetEntry" e ON e."datasetId" = d.id GROUP BY d.id ORDER BY d.year DESC, d.source`
  return rows.map(({ fieldsJson, ...row }) =>
    journalDatasetSchema.parse({
      ...row,
      fields: JSON.parse(fieldsJson),
      count: Number(row.count),
      importedAt: new Date(row.importedAt).getTime()
    })
  )
}

/** Single in-process import owner; staged rows expire and never enter a durable job queue. */
export class JournalAttributes {
  private readonly scans = new Map<
    string,
    {
      client: PrismaClient
      version: number
      after: string
      processed: number
      touched: number
      busy: boolean
      expiry?: ReturnType<typeof setTimeout>
      groups: Record<JournalMatchStatus, string[]>
    }
  >()
  private readonly stages = new Map<string, Stage>()
  private catalog?: { client: PrismaClient; version: number; promise: Promise<JournalDataset[]> }
  private cached?: Snapshot
  private loading?: { client: PrismaClient; version: number; promise: Promise<Snapshot> }
  private choiceValues?: { client: PrismaClient; version: number; key: string; values: string[] }
  private readonly exportSession = randomUUID()
  private version = 0
  private expiryTimer?: ReturnType<typeof setInterval>
  private disposed = false
  private auditVersion = 0
  private auditExpiry?: ReturnType<typeof setTimeout>
  private auditCache?: {
    client: PrismaClient
    token: string
    groups: Record<JournalMatchStatus, string[]>
  }
  private auditLoading?: {
    client: PrismaClient
    promise: Promise<NonNullable<JournalAttributes['auditCache']>>
  }
  private readonly filterCache = new Map<
    string,
    { client: PrismaClient; version: number; auditVersion: number; itemIds: string[] }
  >()

  referencesChanged(): void {
    for (const scan of this.scans.values()) clearTimeout(scan.expiry)
    this.scans.clear()
    this.auditVersion++
    this.auditCache = undefined
    this.auditLoading = undefined
    this.filterCache.clear()
    clearTimeout(this.auditExpiry)
    this.auditExpiry = undefined
  }

  // Keep only the last management query, bounded by the import memory budget.
  private entryPage?: {
    client: PrismaClient
    version: number
    key: string
    ids: string[]
  }

  private invalidate(): void {
    this.referencesChanged()
    this.version++
    this.cached = undefined
    this.catalog = undefined
    this.loading = undefined
    this.choiceValues = undefined
    this.entryPage = undefined
    for (const stage of this.stages.values()) stage.preview = undefined
  }
  constructor(
    private readonly getClient: () => Promise<PrismaClient>,
    private readonly changed: () => void = () => {}
  ) {}

  // Metadata reads do not need to build the full journal identity index. Share one
  // catalog read across list, paged exports and management queries until a write.
  private datasets(client: PrismaClient): Promise<JournalDataset[]> {
    const version = this.version
    if (this.catalog?.client === client && this.catalog.version === version)
      return this.catalog.promise
    const promise = readDatasets(client)
      .then((datasets) => {
        if (this.disposed || version !== this.version)
          throw new Error('Journal data changed. Reload the dataset.')
        return datasets
      })
      .catch((error: unknown) => {
        if (isCurrentInFlight(this.catalog?.promise, promise)) this.catalog = undefined
        throw error
      })
    this.catalog = { client, version, promise }
    return promise
  }

  private snapshot(client: PrismaClient): Promise<Snapshot> {
    if (this.cached?.client === client) return Promise.resolve(this.cached)
    const version = this.version
    if (this.loading?.client === client && this.loading.version === version)
      return this.loading.promise
    const promise = (async () => {
      const snapshot = {
        client,
        index: await buildIndex(await readJournals(client)),
        datasets: await this.datasets(client)
      }
      if (this.disposed) throw new Error('Journal service is closed.')
      if (version !== this.version) throw new Error('Journal data changed. Reload the dataset.')
      this.cached = snapshot
      return snapshot
    })().finally(() => {
      if (isCurrentInFlight(this.loading?.promise, promise)) this.loading = undefined
    })
    this.loading = { client, version, promise }
    return promise
  }

  private async referenceIdentities(
    client: Reader,
    where: Prisma.Sql,
    limit: number,
    lifecycle: 'active' | 'deleted' | 'all' = 'active'
  ): Promise<ReferenceIdentity[]> {
    const rows = await client.$queryRaw<
      {
        id: string
        title: string
        containerTitle: string
        typeFieldsJson: string
        issn: unknown
        eissn: unknown
        abbreviation: unknown
        identifiers: string
        metadataRevision: number
        bindingJournalId: string | null
        bindingFingerprint: string | null
        bindingRevision: string | null
      }[]
    >(Prisma.sql`
      SELECT i.id, substr(i.title, 1, 500) AS title, i."containerTitle", i."typeFieldsJson", i."metadataRevision",
      b."journalId" AS "bindingJournalId", b."identityFingerprint" AS "bindingFingerprint", b.revision AS "bindingRevision",
      json_extract(i."typeFieldsJson", '$.issn') AS issn, json_extract(i."typeFieldsJson", '$.eissn') AS eissn,
      json_extract(i."typeFieldsJson", '$.journalAbbreviation') AS abbreviation,
      (SELECT json_group_array(json_object('scheme', v.scheme, 'value', v."rawValue")) FROM "LiteratureIdentifier" v WHERE v."itemId" = i.id) AS identifiers
      FROM "LiteratureItem" i LEFT JOIN "JournalItemBinding" b ON b."itemId" = i.id WHERE i."itemType" = 'journalArticle' AND ${lifecycle === 'all' ? Prisma.sql`1 = 1` : lifecycle === 'deleted' ? Prisma.sql`i."deletedAt" IS NOT NULL` : Prisma.sql`i."deletedAt" IS NULL AND i."mergedIntoItemId" IS NULL`} AND ${where}
      ORDER BY i.id LIMIT ${limit}`)
    return rows.map((row) => {
      const item = {
        itemType: 'journalArticle',
        containerTitle: row.containerTitle,
        typeFields: {
          ...JSON.parse(row.typeFieldsJson),
          issn: row.issn,
          eissn: row.eissn,
          journalAbbreviation: row.abbreviation
        },
        identifiers: JSON.parse(row.identifiers) as { scheme: string; value: string }[]
      }
      return {
        id: row.id,
        title: row.title.slice(0, 500),
        metadataRevision: row.metadataRevision,
        identity: journalIdentityFromItem(item),
        fingerprint: createHash('sha256').update(journalBindingIdentity(item)).digest('hex'),
        bindingJournalId: row.bindingJournalId,
        bindingFingerprint: row.bindingFingerprint,
        bindingRevision: row.bindingRevision
      }
    })
  }

  /** Resolve dynamic journal filters with the same identity rules used by alignment. */
  async filterItemIds(
    client: PrismaClient,
    rawFilters: readonly JournalAttributeFilter[],
    lifecycle: 'active' | 'deleted' = 'active'
  ): Promise<string[]> {
    const filters = rawFilters.map((filter) => journalAttributeFilterSchema.parse(filter))
    const key = JSON.stringify([lifecycle, filters])
    const cached = this.filterCache.get(key)
    if (
      cached?.client === client &&
      cached.version === this.version &&
      cached.auditVersion === this.auditVersion
    )
      return cached.itemIds
    const snapshot = await this.snapshot(client)
    const version = this.version
    const auditVersion = this.auditVersion
    const definitions = new Map(snapshot.datasets.map((dataset) => [dataset.id, dataset]))
    for (const filter of filters) {
      const field = definitions
        .get(filter.datasetId)
        ?.fields.find(({ id }) => id === filter.fieldId)
      if (!field) {
        const result: string[] = []
        this.filterCache.set(key, {
          client,
          version: this.version,
          auditVersion: this.auditVersion,
          itemIds: result
        })
        return result
      }
    }
    const datasetIds = [...new Set(filters.map(({ datasetId }) => datasetId))]
    const itemIds: string[] = []
    let after = ''
    while (true) {
      const rows = await this.referenceIdentities(
        client,
        Prisma.sql`i.id > ${after}`,
        500,
        lifecycle
      )
      if (!rows.length) break
      const matchedRows = rows.map((row) => ({ row, match: matchReference(row, snapshot.index) }))
      const journalIds = [
        ...new Set(matchedRows.flatMap(({ match }) => (match.id ? [match.id] : [])))
      ]
      const entries = journalIds.length
        ? await client.$queryRaw<{ datasetId: string; journalId: string; valuesJson: string }[]>(
            Prisma.sql`SELECT "datasetId", "journalId", "valuesJson" FROM "JournalDatasetEntry" WHERE "datasetId" IN (${Prisma.join(datasetIds)}) AND "journalId" IN (${Prisma.join(journalIds)})`
          )
        : []
      const valuesByEntry = new Map(
        entries.map((entry) => [
          `${entry.datasetId}:${entry.journalId}`,
          journalImportRowSchema.shape.values.parse(JSON.parse(entry.valuesJson))
        ])
      )
      for (const { row, match } of matchedRows) {
        const journalId = match.id
        if (!journalId) continue
        const matches = filters.every((filter) => {
          const dataset = definitions.get(filter.datasetId)!
          const field = dataset.fields.find(({ id }) => id === filter.fieldId)!
          const raw = valuesByEntry.get(`${filter.datasetId}:${journalId}`)?.[field.id] ?? ''
          if (filter.operator === 'missing') return missingJournalValue(raw)
          if (missingJournalValue(raw)) return false
          const expected = filter.value ?? ''
          if (filter.operator === 'contains')
            return field.kind === 'multiSelect'
              ? journalChoices(raw).some((choice) =>
                  choice.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
                )
              : raw.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
          if (filter.operator === 'equals' && field.kind !== 'number')
            return field.kind === 'multiSelect'
              ? journalChoices(raw).some(
                  (choice) => choice.toLocaleLowerCase() === expected.toLocaleLowerCase()
                )
              : raw.toLocaleLowerCase() === expected.toLocaleLowerCase()
          const left = journalNumber(raw)?.value
          const right = Number(expected)
          if (left === undefined || !Number.isFinite(right)) return false
          if (filter.operator === 'equals') return left === right
          return filter.operator === 'gt'
            ? left > right
            : filter.operator === 'gte'
              ? left >= right
              : filter.operator === 'lt'
                ? left < right
                : left <= right
        })
        if (matches) itemIds.push(row.id)
      }
      if (this.disposed || this.version !== version || this.auditVersion !== auditVersion)
        throw new Error('Journal data changed. Reload the filter.')
      after = rows.at(-1)!.id
      if (rows.length < 500) break
      await setImmediate()
    }
    const result = [...new Set(itemIds)]
    this.filterCache.set(key, {
      client,
      version,
      auditVersion,
      itemIds: result
    })
    while (this.filterCache.size > 4) this.filterCache.delete(this.filterCache.keys().next().value!)
    return result
  }

  private async alignment(
    client: PrismaClient,
    request: Extract<JournalRequest, { action: 'audit' }>
  ): Promise<JournalResult> {
    let cache = this.auditCache
    if (!request.token) {
      if (this.auditLoading?.client !== client) {
        this.referencesChanged()
        const version = this.auditVersion
        const promise = (async () => {
          const snapshot = await this.snapshot(client)
          const groups: Record<JournalMatchStatus, string[]> = {
            matched: [],
            missing: [],
            ambiguous: []
          }
          let after = ''
          while (true) {
            const rows = await this.referenceIdentities(client, Prisma.sql`i.id > ${after}`, 500)
            for (const row of rows) {
              const match = matchReference(row, snapshot.index)
              groups[match.ambiguous ? 'ambiguous' : match.id ? 'matched' : 'missing'].push(row.id)
            }
            if (this.disposed || version !== this.auditVersion)
              throw new Error('Journal alignment changed. Check the library again.')
            if (rows.length < 500) break
            after = rows[rows.length - 1].id
            await setImmediate()
          }
          return (this.auditCache = { client, token: randomUUID(), groups })
        })().finally(() => {
          if (isCurrentInFlight(this.auditLoading?.promise, promise)) this.auditLoading = undefined
        })
        this.auditLoading = { client, promise }
      }
      cache = await this.auditLoading.promise
    }
    if (!cache || cache.client !== client || (request.token && cache.token !== request.token))
      throw new Error('Journal alignment expired. Check the library again.')
    clearTimeout(this.auditExpiry)
    this.auditExpiry = setTimeout(() => this.referencesChanged(), 5 * 60_000)
    this.auditExpiry.unref?.()
    const version = this.auditVersion
    const snapshot = await this.snapshot(client)
    const limit = request.limit ?? 50
    const ids = cache.groups[request.status].slice(request.offset, request.offset + limit)
    const items = ids.length
      ? await this.referenceIdentities(client, Prisma.sql`i.id IN (${Prisma.join(ids)})`, limit)
      : []
    if (this.disposed || version !== this.auditVersion)
      throw new Error('Journal alignment changed. Check the library again.')
    const rows: JournalAlignment['rows'] = items.map((item) => {
      const match = matchReference(item, snapshot.index)
      return {
        itemId: item.id,
        metadataRevision: item.metadataRevision,
        bindingRevision: item.bindingRevision,
        title: item.title,
        identity: item.identity,
        status: match.ambiguous ? 'ambiguous' : match.id ? 'matched' : 'missing',
        reason: match.reason,
        candidates: match.candidates.slice(0, 5).map((id) => snapshot.index.journals.get(id)!),
        candidateTotal: match.candidates.length
      }
    })
    return {
      alignment: {
        token: cache.token,
        counts: {
          matched: cache.groups.matched.length,
          missing: cache.groups.missing.length,
          ambiguous: cache.groups.ambiguous.length
        },
        total: cache.groups[request.status].length,
        rows
      }
    }
  }

  private async scan(client: PrismaClient, token?: string): Promise<JournalResult> {
    for (const [key, scan] of this.scans)
      if (!scan.busy && Date.now() - scan.touched > 5 * 60_000) this.scans.delete(key)
    if (!token) {
      if (this.scans.size >= 4) throw new Error('Too many journal checks. Close a check first.')
      token = randomUUID()
      this.scans.set(token, {
        client,
        version: this.auditVersion,
        after: '',
        processed: 0,
        touched: Date.now(),
        busy: false,
        groups: { matched: [], missing: [], ambiguous: [] }
      })
    }
    const scan = this.scans.get(token)
    if (!scan || scan.client !== client || scan.busy)
      throw new Error('Journal alignment expired. Check the library again.')
    clearTimeout(scan.expiry)
    scan.busy = true
    try {
      const snapshot = await this.snapshot(client)
      const rows = await this.referenceIdentities(client, Prisma.sql`i.id > ${scan.after}`, 500)
      if (this.disposed || this.scans.get(token) !== scan || scan.version !== this.auditVersion)
        throw new Error('Journal alignment changed. Check the library again.')
      for (const row of rows) {
        const match = matchReference(row, snapshot.index)
        scan.groups[match.ambiguous ? 'ambiguous' : match.id ? 'matched' : 'missing'].push(row.id)
      }
      scan.processed += rows.length
      scan.after = rows.at(-1)?.id ?? scan.after
      scan.touched = Date.now()
      scan.expiry = setTimeout(() => this.scans.delete(token!), 5 * 60_000)
      scan.expiry.unref?.()
      const done = rows.length < 500
      if (done) {
        clearTimeout(scan.expiry)
        this.scans.delete(token)
        this.auditCache = { client, token, groups: scan.groups }
        clearTimeout(this.auditExpiry)
        this.auditExpiry = setTimeout(() => this.referencesChanged(), 5 * 60_000)
        this.auditExpiry.unref?.()
      }
      return { scan: { token, processed: scan.processed, done } }
    } catch (error) {
      this.scans.delete(token)
      throw error
    } finally {
      scan.busy = false
    }
  }

  private async removal(
    client: Reader,
    datasetId: string
  ): Promise<NonNullable<JournalResult['removal']>> {
    const hash = createHash('sha256').update(datasetId)
    let after = '',
      journals = 0,
      bindings = 0
    while (true) {
      const rows = await client.$queryRaw<{ id: string }[]>`SELECT j.id FROM "Journal" j
        WHERE j.id > ${after} AND EXISTS (SELECT 1 FROM "JournalDatasetEntry" e WHERE e."journalId" = j.id AND e."datasetId" = ${datasetId})
        AND NOT EXISTS (SELECT 1 FROM "JournalDatasetEntry" e WHERE e."journalId" = j.id AND e."datasetId" != ${datasetId}) ORDER BY j.id LIMIT 500`
      for (const row of rows) hash.update(JSON.stringify(row)).update('\n')
      journals += rows.length
      if (rows.length) {
        let afterItem = ''
        while (true) {
          const confirmed = await client.$queryRaw<{ itemId: string; revision: string }[]>(
            Prisma.sql`SELECT "itemId", revision FROM "JournalItemBinding" WHERE "journalId" IN (${Prisma.join(rows.map(({ id }) => id))}) AND "itemId" > ${afterItem} ORDER BY "itemId" LIMIT 500`
          )
          bindings += confirmed.length
          for (const binding of confirmed) hash.update(JSON.stringify(binding)).update('\n')
          if (confirmed.length < 500) break
          afterItem = confirmed[confirmed.length - 1].itemId
          await setImmediate()
        }
      }
      if (rows.length < 500) break
      after = rows[rows.length - 1].id
      await setImmediate()
    }
    return { journals, bindings, digest: hash.digest('hex') }
  }

  private pruneStages(): void {
    for (const [token, stage] of this.stages) {
      if (
        !stage.preparing &&
        (!stage.committing || stage.completed) &&
        Date.now() - stage.touched >= STAGE_TTL
      )
        this.stages.delete(token)
    }
    if (!this.stages.size && this.expiryTimer) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = undefined
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.expiryTimer)
    this.expiryTimer = undefined
    // Stop at the next batch boundary and wait for rollback before the database owner closes.
    await Promise.allSettled([...this.stages.values()].flatMap((stage) => stage.committing ?? []))
    this.stages.clear()
    this.invalidate()
  }

  private stage(token: string, client: PrismaClient): Stage {
    const stage = this.stages.get(token)
    if (
      !stage ||
      stage.client !== client ||
      (!stage.preparing &&
        (!stage.committing || stage.completed) &&
        Date.now() - stage.touched >= STAGE_TTL)
    ) {
      this.stages.delete(token)
      throw new Error('Journal import expired. Select the file again.')
    }
    stage.touched = Date.now()
    return stage
  }

  private async prepare(
    client: Reader,
    stage: Stage
  ): Promise<{
    rows: (JournalPreviewRow & { journalId?: string })[]
    journals: Map<string, Journal>
    digest: string
    dataset?: JournalDataset
  }> {
    const datasets = await readDatasets(client)
    const { datasetId, expectedRevision, definition } = stage.request
    const dataset = datasets.find(({ id }) => id === datasetId)
    if (datasetId && (!dataset || dataset.revision !== expectedRevision))
      throw new Error('Journal data changed. Review the import again.')
    if (
      datasets.some(
        (entry) =>
          entry.id !== datasetId &&
          entry.source === definition.source &&
          entry.year === definition.year
      )
    )
      throw new Error('This source and year already exist. Select the dataset to update.')
    if (dataset && (dataset.source !== definition.source || dataset.year !== definition.year))
      throw new Error('The dataset source and year cannot change during an update.')
    const index = await buildIndex(await readJournals(client))
    const stored = dataset
      ? await client.$queryRaw<
          Entry[]
        >`SELECT * FROM "JournalDatasetEntry" WHERE "datasetId" = ${dataset.id}`
      : []
    const previous = new Map(
      stored.map((entry) => [
        entry.journalId,
        journalImportRowSchema.shape.values.parse(JSON.parse(entry.valuesJson))
      ])
    )
    const journals = new Map<string, Journal>()
    const seen = new Map<string, JournalPreviewRow & { journalId?: string }>()
    const fields = new Map(definition.fields.map((field) => [field.id, field]))
    if (!fields.size || fields.size !== definition.fields.length)
      throw new Error('Select distinct journal attributes.')
    if (new Set([...(dataset?.fields ?? []), ...definition.fields].map(({ id }) => id)).size > 64)
      throw new Error('A journal dataset supports at most 64 attributes.')
    for (const field of definition.fields) {
      const existing = dataset?.fields.find(({ id }) => id === field.id)
      if (existing && existing.kind !== field.kind)
        throw new Error('An existing attribute type cannot change during import.')
      if (existing && field.columnKey !== existing.columnKey)
        throw new Error('An existing attribute identity cannot change during import.')
      if (
        !existing &&
        field.columnKey &&
        !datasets.some(
          (previous) =>
            previous.source === definition.source &&
            previous.year < definition.year &&
            previous.fields.some(
              (old) =>
                old.id === field.id &&
                old.kind === field.kind &&
                journalColumnKey(previous.id, old) === field.columnKey
            )
        )
      )
        throw new Error('Check the previous year attribute mapping.')
    }
    const prepareRow = (input: JournalImportRow): JournalPreviewRow & { journalId?: string } => {
      const warnings: JournalPreviewRow['warnings'] = []
      const issns = [...new Set(input.issns.flatMap((value) => normalizeIssn(value) ?? []))]
      const match = matchJournal(input, index)
      if (input.issns.some((value) => !missingJournalValue(value) && !normalizeIssn(value)))
        warnings.push('invalid-issn')
      if (
        (!normalizeJournalName(input.name) || missingJournalValue(input.name)) &&
        !issns.length &&
        !(input.externalIds?.length && (match.id || match.ambiguous))
      )
        warnings.push('missing-identity')
      if (
        Object.keys(input.values).some((key) => !fields.has(key)) ||
        definition.fields.some((field) => {
          const value = input.values[field.id] ?? ''
          return (
            !missingJournalValue(value) &&
            (field.kind === 'number'
              ? !journalNumber(value)
              : field.kind === 'singleSelect'
                ? value.length > 200
                : field.kind === 'multiSelect'
                  ? journalChoices(value).some((choice) => choice.length > 200)
                  : false)
          )
        })
      )
        warnings.push('invalid-value')
      if (match.ambiguous) warnings.push('identity-conflict')
      const row: JournalPreviewRow & { journalId?: string } = {
        ...input,
        warnings,
        status: warnings.some(
          (warning) => warning === 'invalid-value' || warning === 'missing-identity'
        )
          ? 'invalid'
          : match.ambiguous
            ? 'ambiguous'
            : match.id
              ? 'matched'
              : 'new',
        journalId: match.id,
        previous: match.id ? previous.get(match.id) : undefined
      }
      if (row.status === 'invalid' || row.status === 'ambiguous') return row
      const journal: Journal = match.id
        ? index.journals.get(match.id)!
        : {
            id: `new-${input.row}`,
            name:
              missingJournalValue(input.name) || !normalizeJournalName(input.name)
                ? issns[0]
                : input.name,
            aliases: input.aliases,
            issns,
            externalIds: input.externalIds
          }
      row.journalId = journal.id
      const duplicate = seen.get(journal.id)
      if (duplicate) {
        row.status = duplicate.status = 'duplicate'
        row.warnings.push('duplicate-row')
        if (!duplicate.warnings.includes('duplicate-row')) duplicate.warnings.push('duplicate-row')
      } else seen.set(journal.id, row)
      // Additional aliases are provenance supplied by the same reviewed identity, not fuzzy guesses.
      const updated = {
        ...journal,
        issns: [
          ...new Set([...journal.issns.flatMap((value) => normalizeIssn(value) ?? []), ...issns])
        ],
        aliases: [
          ...new Set(
            [...journal.aliases, ...input.aliases, input.name].filter(
              (name) =>
                !missingJournalValue(name) && normalizeJournalName(name) && name !== journal.name
            )
          )
        ],
        externalIds: [...(journal.externalIds ?? []), ...(input.externalIds ?? [])].filter(
          (entry, position, values) =>
            values.findIndex(
              (other) =>
                normalizeJournalExternalIdNamespace(other.namespace) ===
                  normalizeJournalExternalIdNamespace(entry.namespace) &&
                normalizeJournalExternalIdValue(other.value) ===
                  normalizeJournalExternalIdValue(entry.value)
            ) === position
        )
      }
      if (
        updated.issns.length > 10 ||
        updated.aliases.length > 20 ||
        updated.externalIds.length > 32
      ) {
        row.status = 'invalid'
        row.warnings.push('identity-limit')
        return row
      }
      // Existing identities remain immutable during matching. A skipped row must not
      // teach another row an alias or identifier that will never actually be saved.
      if (!match.id) indexJournal(index, journal)
      journals.set(journal.id, updated)
      return row
    }
    const rows: (JournalPreviewRow & { journalId?: string })[] = []
    for (const input of stage.rows) {
      if (this.disposed) throw new Error('Journal service is closed.')
      if (stage.discarded) throw new Error('Journal import expired. Select the file again.')
      rows.push(prepareRow(input))
      if (rows.length % 500 === 0) await setImmediate()
    }
    // Hash bounded pieces instead of materializing a second copy of the entire import.
    const hash = createHash('sha256').update(
      JSON.stringify({ definition, revision: dataset?.revision })
    )
    for (let offset = 0; offset < rows.length; offset++) {
      hash.update(JSON.stringify(rows[offset])).update('\n')
      if (offset % 500 === 499) await setImmediate()
    }
    let hashed = 0
    for (const journal of journals) {
      hash.update(JSON.stringify(journal)).update('\n')
      if (++hashed % 500 === 0) await setImmediate()
    }
    const digest = hash.digest('hex')
    return { rows, journals, digest, dataset }
  }

  async run(rawRequest: JournalRequest): Promise<JournalResult> {
    if (this.disposed) throw new Error('Journal service is closed.')
    const request = journalRequestSchema.parse(rawRequest)
    const client = await this.getClient()
    if (this.disposed) throw new Error('Journal service is closed.')
    if (request.action === 'list') return { datasets: await this.datasets(client) }
    if (request.action === 'export') {
      const snapshot = `${this.exportSession}:${this.version}`
      if (request.snapshot && request.snapshot !== snapshot)
        throw new Error('Journal data changed. Reload the dataset.')
      const dataset = (await this.datasets(client)).find(({ id }) => id === request.datasetId)
      if (!dataset || dataset.revision !== request.expectedRevision)
        throw new Error('Journal data changed. Reload the dataset.')
      const batch = await client.$queryRaw<
        {
          id: string
          name: string
          aliasesJson: string
          issnsJson: string
          externalIdsJson: string
          valuesJson: string
        }[]
      >`SELECT j.id, j.name, j."aliasesJson", j."issnsJson", j."externalIdsJson", e."valuesJson"
        FROM "JournalDatasetEntry" e JOIN "Journal" j ON j.id = e."journalId"
        WHERE e."datasetId" = ${dataset.id} AND j.id > ${request.after ?? ''}
        ORDER BY j.id LIMIT 100`
      const rows: JournalImportRow[] = []
      let bytes = 0
      let next: string | undefined
      for (const entry of batch) {
        const row = journalImportRowSchema.parse({
          row: rows.length + 1,
          name: entry.name,
          aliases: JSON.parse(entry.aliasesJson),
          issns: JSON.parse(entry.issnsJson),
          externalIds: JSON.parse(entry.externalIdsJson),
          values: JSON.parse(entry.valuesJson)
        })
        const size = Buffer.byteLength(JSON.stringify(row))
        if (rows.length && bytes + size > 512 * 1024) break
        rows.push(row)
        bytes += size
        next = entry.id
      }
      if (snapshot !== `${this.exportSession}:${this.version}`)
        throw new Error('Journal data changed. Reload the dataset.')
      return { exportPage: { dataset, snapshot, rows, next } }
    }
    if (request.action === 'audit-step') return this.scan(client, request.token)
    if (request.action === 'audit-cancel') {
      clearTimeout(this.scans.get(request.token)?.expiry)
      this.scans.delete(request.token)
      if (this.auditCache?.token === request.token) this.auditCache = undefined
      return {}
    }
    if (request.action === 'remove-preview')
      return client.$transaction(
        async (tx) => {
          const allDatasets = await readDatasets(tx)
          const dataset = allDatasets.find(({ id }) => id === request.datasetId)
          if (!dataset || dataset.revision !== request.expectedRevision)
            throw new Error('Journal data changed. Reload the dataset.')
          return { removal: await this.removal(tx, dataset.id) }
        },
        { timeout: 120_000, maxWait: 30_000 }
      )
    if (request.action === 'begin') {
      this.pruneStages()
      const completed = [...this.stages].filter(([, stage]) => stage.completed)
      for (const [token] of completed.slice(0, Math.max(0, completed.length - 20)))
        this.stages.delete(token)
      if ([...this.stages.values()].filter((stage) => !stage.completed).length >= 4)
        throw new Error('Too many journal imports are open. Close an import first.')
      const token = randomUUID()
      this.stages.set(token, {
        client,
        request,
        rows: [],
        numbers: new Set(),
        bytes: 0,
        touched: Date.now()
      })
      if (!this.expiryTimer) {
        this.expiryTimer = setInterval(() => this.pruneStages(), 60_000)
        this.expiryTimer.unref()
      }
      return { token }
    }
    if (request.action === 'discard') {
      const stage = this.stages.get(request.token)
      if (!stage?.committing || stage.completed) {
        if (stage) stage.discarded = true
        this.stages.delete(request.token)
      }
      this.pruneStages()
      return {}
    }
    if (request.action === 'append') {
      const stage = this.stage(request.token, client)
      if (stage.preparing || stage.committing) throw new Error('Journal import is busy. Try again.')
      if (request.offset !== stage.rows.length)
        throw new Error('Journal import chunk is out of order.')
      const bytes = Buffer.byteLength(JSON.stringify(request.rows))
      if (
        [...this.stages.values()].reduce((sum, draft) => sum + draft.bytes, bytes) >
          STAGING_BUDGET ||
        stage.rows.length + request.rows.length > JOURNAL_IMPORT_MAX_ROWS
      )
        throw new Error('Journal import is too large.')
      const numbers = new Set<number>()
      for (const row of request.rows) {
        if (stage.numbers.has(row.row) || numbers.has(row.row))
          throw new Error('Journal import contains repeated row numbers.')
        numbers.add(row.row)
      }
      numbers.forEach((number) => stage.numbers.add(number))
      stage.rows.push(...request.rows)
      stage.preview = undefined
      stage.bytes += bytes
      stage.reviewed = undefined
      return { total: stage.rows.length }
    }
    if (request.action === 'preview') {
      const stage = this.stage(request.token, client)
      if (stage.preparing || stage.committing) throw new Error('Journal import is busy. Try again.')
      if (!stage.preview || stage.preview.version !== this.version) {
        stage.preparing = true
        const version = this.version
        try {
          const plan = await client.$transaction((tx) => this.prepare(tx, stage), {
            timeout: 30_000
          })
          if (version !== this.version)
            throw new Error('Journal data changed. Review the import again.')
          const rows = plan.rows.map(
            ({ row, name, aliases, issns, values, status, warnings, previous }) => ({
              row,
              name,
              aliases,
              issns,
              values,
              status,
              warnings,
              previous
            })
          )
          const problems = rows.filter((row) => row.status !== 'matched' && row.status !== 'new')
          const ready = rows.length - problems.length
          stage.preview = {
            version,
            problems,
            result: {
              rows,
              digest: plan.digest,
              total: rows.length,
              ready,
              problems: rows.length - ready
            }
          }
          stage.reviewed = plan.digest
        } finally {
          stage.preparing = false
        }
      }
      const result = stage.preview.result
      const rows = request.problemsOnly ? stage.preview.problems : result.rows!
      return { ...result, rows: rows.slice(request.offset, request.offset + (request.limit ?? 50)) }
    }
    if (request.action === 'commit') {
      const stage = this.stage(request.token, client)
      if (!stage.reviewed || stage.reviewed !== request.digest)
        throw new Error('Review the journal import before saving.')
      if (stage.committing) return stage.committing
      if (stage.preparing) throw new Error('Journal import is busy. Try again.')
      stage.committing = client
        .$transaction(
          async (tx) => {
            const plan = await this.prepare(tx, stage)
            if (this.disposed) throw new Error('Journal service is closed.')
            if (plan.digest !== request.digest)
              throw new Error('Journal data changed. Review the import again.')
            const rows = plan.rows.filter((row) => row.status === 'matched' || row.status === 'new')
            if (!rows.length || (!request.skipProblems && rows.length !== plan.rows.length))
              throw new Error('Resolve or skip the journal import problems before saving.')
            const datasetId = plan.dataset?.id ?? randomUUID()
            const fields = [...(plan.dataset?.fields ?? [])]
            for (const field of stage.request.definition.fields) {
              const position = fields.findIndex(({ id }) => id === field.id)
              if (position < 0) fields.push(field)
              // Existing presentation is edited only by the fields command. Importing
              // values must not reset a saved label, color palette or visibility.
            }
            if (fields.length > 64)
              throw new Error('A journal dataset supports at most 64 attributes.')
            await tx.$executeRaw`INSERT INTO "JournalDataset" (id, name, source, year, revision, "fieldsJson", "importedAt") VALUES (${datasetId}, ${stage.request.definition.name ?? null}, ${stage.request.definition.source}, ${stage.request.definition.year}, 1, ${JSON.stringify(fields)}, ${new Date()}) ON CONFLICT(id) DO UPDATE SET revision = revision + 1, "fieldsJson" = excluded."fieldsJson", "importedAt" = excluded."importedAt"`
            for (let offset = 0; offset < rows.length; offset += 100) {
              if (this.disposed) throw new Error('Journal service is closed.')
              const chunk = rows.slice(offset, offset + 100).map((row) => {
                const journal = plan.journals.get(row.journalId!)!
                return {
                  row,
                  journal: {
                    ...journal,
                    id: journal.id.startsWith('new-') ? randomUUID() : journal.id
                  }
                }
              })
              await tx.$executeRaw(
                Prisma.sql`INSERT INTO "Journal" (id, name, "normalizedName", "aliasesJson", "issnsJson", "externalIdsJson") VALUES ${Prisma.join(chunk.map(({ journal }) => Prisma.sql`(${journal.id}, ${journal.name}, ${normalizeJournalName(journal.name)}, ${JSON.stringify(journal.aliases)}, ${JSON.stringify(journal.issns)}, ${JSON.stringify(journal.externalIds ?? [])})`))} ON CONFLICT(id) DO UPDATE SET "aliasesJson" = excluded."aliasesJson", "issnsJson" = excluded."issnsJson", "externalIdsJson" = excluded."externalIdsJson"`
              )
              await tx.$executeRaw(
                Prisma.sql`INSERT INTO "JournalDatasetEntry" ("datasetId", "journalId", "valuesJson", "sourceRow") VALUES ${Prisma.join(
                  chunk.map(({ row, journal }) => {
                    const values = { ...row.previous }
                    for (const [key, value] of Object.entries(row.values))
                      if (
                        !missingJournalValue(value) &&
                        (stage.request.policy === 'replace' ||
                          missingJournalValue(values[key] ?? ''))
                      )
                        values[key] = value.trim()
                    return Prisma.sql`(${datasetId}, ${journal.id}, ${JSON.stringify(values)}, ${row.row})`
                  })
                )} ON CONFLICT("datasetId", "journalId") DO UPDATE SET "valuesJson" = excluded."valuesJson", "sourceRow" = excluded."sourceRow"`
              )
            }
            return { imported: rows.length, datasets: await readDatasets(tx) }
          },
          { timeout: 120_000, maxWait: 30_000 }
        )
        .then(
          (result) => {
            stage.completed = true
            stage.touched = Date.now()
            stage.bytes = 0
            stage.rows = []
            stage.numbers.clear()
            this.invalidate()
            try {
              if (!this.disposed) this.changed()
            } catch (error) {
              log.warn('Journal changes committed; notification failed', error)
            }
            return result
          },
          (error: unknown) => {
            stage.committing = undefined
            throw error
          }
        )
      return stage.committing
    }
    if (request.action === 'entry') {
      const datasets = await client.$transaction(
        async (tx) => {
          const allDatasets = await readDatasets(tx)
          const dataset = allDatasets.find(({ id }) => id === request.datasetId)
          if (!dataset || dataset.revision !== request.expectedRevision)
            throw new Error('Journal data changed. Reload the dataset.')
          const fields = new Map(dataset.fields.map((field) => [field.id, field]))
          const nextValues = journalImportRowSchema.shape.values.parse(request.values)
          if (Object.keys(nextValues).some((key) => !fields.has(key)))
            throw new Error('Journal attribute is not part of this dataset.')
          const existing = await tx.$queryRaw<{ valuesJson: string }[]>`
            SELECT "valuesJson" FROM "JournalDatasetEntry"
            WHERE "datasetId" = ${dataset.id} AND "journalId" = ${request.journalId}
          `
          if (!existing.length) throw new Error('Journal entry not found. Reload the dataset.')
          const values = {
            ...journalImportRowSchema.shape.values.parse(JSON.parse(existing[0].valuesJson)),
            ...nextValues
          }
          for (const [key, value] of Object.entries(values)) {
            const field = fields.get(key)!
            if (
              !missingJournalValue(value) &&
              (field.kind === 'number'
                ? !journalNumber(value)
                : field.kind === 'singleSelect'
                  ? value.length > 200
                  : field.kind === 'multiSelect'
                    ? journalChoices(value).some((choice) => choice.length > 200)
                    : false)
            )
              throw new Error('Invalid journal attribute value.')
          }
          await tx.$executeRaw`
            UPDATE "JournalDatasetEntry"
            SET "valuesJson" = ${JSON.stringify(values)}
            WHERE "datasetId" = ${dataset.id} AND "journalId" = ${request.journalId}
          `
          await tx.$executeRaw`
            UPDATE "JournalDataset" SET revision = revision + 1 WHERE id = ${dataset.id}
          `
          return readDatasets(tx)
        },
        { timeout: 120_000, maxWait: 30_000 }
      )
      this.invalidate()
      try {
        this.changed()
      } catch (error) {
        log.warn('Journal changes committed; notification failed', error)
      }
      return { datasets }
    }
    if (request.action === 'remove' || request.action === 'fields' || request.action === 'rename') {
      const datasets = await client.$transaction(
        async (tx) => {
          const allDatasets = await readDatasets(tx)
          const dataset = allDatasets.find(({ id }) => id === request.datasetId)
          if (!dataset || dataset.revision !== request.expectedRevision)
            throw new Error('Journal data changed. Reload the dataset.')
          if (request.action === 'remove') {
            if (
              request.expectedRemovalDigest &&
              (await this.removal(tx, dataset.id)).digest !== request.expectedRemovalDigest
            )
              throw new Error('Journal confirmations changed. Review the deletion again.')
            await tx.$executeRaw`DELETE FROM "JournalDataset" WHERE id = ${dataset.id}`
            await tx.$executeRaw`DELETE FROM "Journal" WHERE NOT EXISTS (SELECT 1 FROM "JournalDatasetEntry" WHERE "journalId" = "Journal".id)`
          } else if (request.action === 'rename') {
            const source = request.source ?? dataset.source
            const year = request.year ?? dataset.year
            if (
              allDatasets.some(
                (other) => other.id !== dataset.id && other.source === source && other.year === year
              )
            )
              throw new Error('A dataset with this source and year already exists.')
            // Fields inherited across years share a column identity. Splitting their source
            // must not expose two different sources under the same literature table column.
            const otherKeys = new Set(
              allDatasets
                .filter((other) => other.id !== dataset.id)
                .flatMap((other) => other.fields.map((field) => journalColumnKey(other.id, field)))
            )
            const fields =
              source === dataset.source
                ? dataset.fields
                : dataset.fields.map((field) =>
                    otherKeys.has(journalColumnKey(dataset.id, field))
                      ? { ...field, columnKey: `${randomUUID()}:${field.id}` }
                      : field
                  )
            await tx.$executeRaw`UPDATE "JournalDataset" SET name = ${request.name}, source = ${source}, year = ${year}, "fieldsJson" = ${JSON.stringify(fields)}, revision = revision + 1 WHERE id = ${dataset.id}`
          } else {
            if (
              request.fields.length !== dataset.fields.length ||
              new Set(request.fields.map(({ id }) => id)).size !== dataset.fields.length ||
              request.fields.some(
                (field) =>
                  !dataset.fields.some(
                    (old) => old.id === field.id && old.columnKey === field.columnKey
                  )
              )
            )
              throw new Error('Journal attribute identities cannot be changed.')
            const changedTypes = request.fields.filter(
              (field) => dataset.fields.find((old) => old.id === field.id)?.kind !== field.kind
            )
            if (changedTypes.length) {
              let after = ''
              while (true) {
                const rows = await tx.$queryRaw<{ journalId: string; valuesJson: string }[]>`
                  SELECT "journalId", "valuesJson" FROM "JournalDatasetEntry"
                  WHERE "datasetId" = ${dataset.id} AND "journalId" > ${after}
                  ORDER BY "journalId" LIMIT 500`
                if (!rows.length) break
                for (const row of rows) {
                  const values = JSON.parse(row.valuesJson) as Record<string, string>
                  for (const field of changedTypes) {
                    const value = values[field.id] ?? ''
                    if (
                      !missingJournalValue(value) &&
                      (field.kind === 'number'
                        ? !journalNumber(value)
                        : field.kind === 'singleSelect'
                          ? value.length > 200
                          : field.kind === 'multiSelect'
                            ? journalChoices(value).some((choice) => choice.length > 200)
                            : false)
                    )
                      throw new Error(
                        'Some values do not match the selected type. Choose another type or update the values first.'
                      )
                  }
                }
                after = rows.at(-1)!.journalId
                await setImmediate()
              }
            }
            await tx.$executeRaw`UPDATE "JournalDataset" SET "fieldsJson" = ${JSON.stringify(request.fields)}, revision = revision + 1 WHERE id = ${dataset.id}`
          }
          return readDatasets(tx)
        },
        { timeout: 120_000, maxWait: 30_000 }
      )
      this.invalidate()
      try {
        this.changed()
      } catch (error) {
        log.warn('Journal changes committed; notification failed', error)
      }
      return { datasets }
    }
    if (request.action === 'choices') {
      const version = this.version
      const dataset = (await this.datasets(client)).find(({ id }) => id === request.datasetId)
      if (!dataset || dataset.revision !== request.expectedRevision)
        throw new Error('Journal data changed. Reload the dataset.')
      const field = dataset.fields.find(({ id }) => id === request.fieldId)
      if (!field || !['singleSelect', 'multiSelect'].includes(field.kind))
        throw new Error('Select a categorical journal attribute.')
      const key = JSON.stringify([dataset.id, field.id])
      let values =
        this.choiceValues?.client === client &&
        this.choiceValues.version === version &&
        this.choiceValues.key === key
          ? this.choiceValues.values
          : undefined
      if (!values) {
        const choices = new Set(Object.keys(field.colors))
        let after = ''
        while (true) {
          const rows = await client.$queryRaw<{ journalId: string; value: string }[]>`
            SELECT e."journalId", v.value FROM "JournalDatasetEntry" e
            JOIN json_each(e."valuesJson") v ON v.key = ${field.id}
            WHERE e."datasetId" = ${dataset.id} AND e."journalId" > ${after}
            ORDER BY e."journalId" LIMIT 500`
          for (const row of rows) {
            if (typeof row.value !== 'string') throw new Error('Invalid journal attribute value.')
            if (missingJournalValue(row.value)) continue
            for (const value of field.kind === 'multiSelect'
              ? journalChoices(row.value)
              : [row.value])
              choices.add(value)
          }
          if (rows.length < 500) break
          after = rows[rows.length - 1].journalId
          await setImmediate()
          if (this.disposed || version !== this.version)
            throw new Error('Journal data changed. Reload the dataset.')
        }
        values = [...choices].sort(new Intl.Collator(undefined, { numeric: true }).compare)
        if (this.disposed || version !== this.version)
          throw new Error('Journal data changed. Reload the dataset.')
        this.choiceValues = { client, version, key, values }
      }
      const query = normalizeJournalName(request.query)
      const filtered = query
        ? values.filter((value) => normalizeJournalName(value).includes(query))
        : values
      return {
        choices: filtered.slice(request.offset, request.offset + 50),
        total: filtered.length
      }
    }
    if (request.action === 'entries') {
      const version = this.version
      const key = JSON.stringify([
        request.datasetId,
        request.query,
        request.sortField,
        request.descending
      ])
      let ids =
        this.entryPage?.client === client &&
        this.entryPage.version === this.version &&
        this.entryPage.key === key
          ? this.entryPage.ids
          : undefined
      if (!ids) {
        const field = (await this.datasets(client))
          .find(({ id }) => id === request.datasetId)
          ?.fields.find(({ id }) => id === request.sortField)
        const query = normalizeJournalName(request.query)
        const candidates: { id: string; value: string | number | null }[] = []
        let after = ''
        while (true) {
          const batch = await client.$queryRaw<
            {
              id: string
              name: string
              aliasesJson: string
              issnsJson: string
              externalIdsJson: string
              valuesJson: string
            }[]
          >`SELECT j.id, j.name, j."aliasesJson", j."issnsJson", j."externalIdsJson", e."valuesJson" FROM "JournalDatasetEntry" e JOIN "Journal" j ON e."journalId" = j.id WHERE e."datasetId" = ${request.datasetId} AND e."journalId" > ${after} ORDER BY e."journalId" LIMIT 500`
          for (const row of batch) {
            const values =
              query || field
                ? journalImportRowSchema.shape.values.parse(JSON.parse(row.valuesJson))
                : {}
            if (query) {
              const identity = journalIdentitySchema.parse({
                name: row.name,
                aliases: JSON.parse(row.aliasesJson),
                issns: JSON.parse(row.issnsJson),
                externalIds: JSON.parse(row.externalIdsJson)
              })
              if (
                !normalizeJournalName(
                  [
                    identity.name,
                    ...identity.aliases,
                    ...identity.issns,
                    ...(identity.externalIds ?? []).map(
                      ({ namespace, value }) => `${namespace}:${value}`
                    ),
                    ...Object.values(values)
                  ].join(' ')
                ).includes(query)
              )
                continue
            }
            const value = field ? (values[field.id] ?? '') : row.name
            candidates.push({
              id: row.id,
              value: missingJournalValue(value)
                ? null
                : field?.kind === 'number'
                  ? (journalNumber(value)?.value ?? null)
                  : value
            })
          }
          if (batch.length < 500) break
          after = batch[batch.length - 1].id
          await setImmediate()
          if (this.disposed || version !== this.version)
            throw new Error('Journal data changed. Reload the dataset.')
        }
        const collator = new Intl.Collator(undefined, { numeric: true })
        candidates.sort((a, b) => {
          if (a.value === null || b.value === null) {
            if (a.value === b.value) return a.id.localeCompare(b.id)
            return a.value === null ? 1 : -1
          }
          const order =
            typeof a.value === 'number' && typeof b.value === 'number'
              ? a.value - b.value
              : collator.compare(String(a.value), String(b.value))
          return order * (request.descending ? -1 : 1) || a.id.localeCompare(b.id)
        })
        ids = candidates.map(({ id }) => id)
        if (version !== this.version) throw new Error('Journal data changed. Reload the dataset.')
        this.entryPage = { client, version, key, ids }
      }
      const pageIds = ids.slice(request.offset, request.offset + (request.limit ?? 50))
      const rows = pageIds.length
        ? await client.$queryRaw<
            {
              id: string
              name: string
              aliasesJson: string
              issnsJson: string
              externalIdsJson: string
              valuesJson: string
              sourceRow: number
            }[]
          >(
            Prisma.sql`SELECT j.id, j.name, j."aliasesJson", j."issnsJson", j."externalIdsJson", e."valuesJson", e."sourceRow" FROM "Journal" j JOIN "JournalDatasetEntry" e ON e."journalId" = j.id WHERE e."datasetId" = ${request.datasetId} AND j.id IN (${Prisma.join(pageIds)})`
          )
        : []
      if (this.disposed || version !== this.version)
        throw new Error('Journal data changed. Reload the dataset.')
      const byId = new Map(
        rows.map((row) => [
          row.id,
          {
            id: row.id,
            ...journalImportRowSchema.parse({
              name: row.name,
              aliases: JSON.parse(row.aliasesJson),
              issns: JSON.parse(row.issnsJson),
              externalIds: JSON.parse(row.externalIdsJson),
              values: JSON.parse(row.valuesJson),
              row: row.sourceRow
            })
          }
        ])
      )
      return { entries: pageIds.flatMap((id) => byId.get(id) ?? []), total: ids.length }
    }
    if (request.action === 'bind') {
      const version = this.auditVersion
      const reviewed = this.auditCache
      const assertCurrent = (): void => {
        if (
          this.disposed ||
          version !== this.auditVersion ||
          reviewed?.client !== client ||
          reviewed.token !== request.token
        )
          throw new Error('Journal alignment changed. Check the library again.')
      }
      assertCurrent()
      if (!Object.values(reviewed!.groups).some((ids) => ids.includes(request.itemId)))
        throw new Error('Reference was not included in this journal check.')
      await client.$transaction(async (transaction) => {
        const [item] = await this.referenceIdentities(
          transaction,
          Prisma.sql`i.id = ${request.itemId}`,
          1
        )
        assertCurrent()
        if (
          !item ||
          item.metadataRevision !== request.expectedMetadataRevision ||
          item.bindingRevision !== request.expectedBindingRevision
        )
          throw new Error('Reference or journal binding changed. Check the library again.')
        if (request.journalId) {
          const target = await transaction.$queryRaw<
            { id: string }[]
          >`SELECT id FROM "Journal" WHERE id = ${request.journalId}`
          if (!target.length) throw new Error('Journal is no longer available.')
          await transaction.$executeRaw`INSERT INTO "JournalItemBinding" ("itemId", "journalId", "identityFingerprint", revision)
            VALUES (${item.id}, ${request.journalId}, ${item.fingerprint}, ${randomUUID()})
            ON CONFLICT("itemId") DO UPDATE SET "journalId" = excluded."journalId", "identityFingerprint" = excluded."identityFingerprint", revision = excluded.revision`
        } else {
          await transaction.$executeRaw`DELETE FROM "JournalItemBinding" WHERE "itemId" = ${item.id}`
        }
        assertCurrent()
      })
      this.referencesChanged()
      try {
        this.changed()
      } catch (error) {
        log.warn('Journal confirmation committed; notification failed', error)
      }
      return {}
    }
    if (request.action === 'audit') return this.alignment(client, request)
    if (request.action === 'candidates') {
      const snapshot = await this.snapshot(client)
      const version = this.version
      const query = normalizeJournalName(request.query)
      if (!query) return { candidates: [] }
      const ranked: { journal: Journal; rank: number }[] = []
      let visited = 0
      for (const journal of snapshot.index.journals.values()) {
        const rank = Math.max(
          ...[journal.name, ...journal.aliases].map((name) =>
            searchTitleRank(normalizeJournalName(name), query)
          )
        )
        if (rank) {
          ranked.push({ journal, rank })
          ranked.sort(
            (a, b) =>
              b.rank - a.rank ||
              a.journal.name.localeCompare(b.journal.name) ||
              a.journal.id.localeCompare(b.journal.id)
          )
          if (ranked.length > 20) ranked.pop()
        }
        if (++visited % 500 === 0) {
          await setImmediate()
          if (this.disposed || version !== this.version)
            throw new Error('Journal data changed. Reload the dataset.')
        }
      }
      return { candidates: ranked.map(({ journal }) => journal) }
    }
    const version = this.version
    const snapshot = await this.snapshot(client)
    const itemIds = [...new Set(request.identities.flatMap(({ itemId }) => itemId ?? []))]
    const references = itemIds.length
      ? await this.referenceIdentities(
          client,
          Prisma.sql`i.id IN (${Prisma.join(itemIds)})`,
          200,
          'all'
        )
      : []
    const byItem = new Map(references.map((item) => [item.id, item]))
    const identities = request.identities.map((identity) => {
      const item = identity.itemId ? byItem.get(identity.itemId) : undefined
      // A snapshot with older metadata must not borrow the current record's confirmation.
      return item && identityKey(item.identity) === identityKey(identity)
        ? matchReference(item, snapshot.index)
        : matchJournal(identity, snapshot.index)
    })
    const ids = [...new Set(identities.flatMap(({ id }) => id ?? []))]
    const latest = selectJournalDatasets(snapshot.datasets, request.sourceYears)
    const entries =
      ids.length && latest.length
        ? await client.$queryRaw<(Entry & { datasetId: string })[]>(
            Prisma.sql`SELECT * FROM "JournalDatasetEntry" WHERE "journalId" IN (${Prisma.join(ids)}) AND "datasetId" IN (${Prisma.join(latest.map(({ id }) => id))})`
          )
        : []
    if (this.disposed || version !== this.version)
      throw new Error('Journal data changed. Reload the dataset.')
    const valuesByEntry = new Map(
      entries.map((entry) => [
        `${entry.datasetId}:${entry.journalId}`,
        journalImportRowSchema.shape.values.parse(JSON.parse(entry.valuesJson))
      ])
    )
    return {
      matches: identities.map((match, index) => {
        const matchedJournal = match.id ? snapshot.index.journals.get(match.id) : undefined
        const fallbackIdentity = { ...request.identities[index] }
        delete fallbackIdentity.itemId
        const identity = matchedJournal
          ? {
              name: matchedJournal.name,
              aliases: matchedJournal.aliases,
              issns: matchedJournal.issns,
              ...(matchedJournal.externalIds?.length
                ? { externalIds: matchedJournal.externalIds }
                : {})
            }
          : fallbackIdentity
        return {
          status: match.ambiguous ? 'ambiguous' : match.id ? 'matched' : 'missing',
          identity,
          attributes: latest.flatMap((dataset) => {
            const values = valuesByEntry.get(`${dataset.id}:${match.id}`) ?? {}
            return dataset.fields
              .filter((field) => field.visible && !missingJournalValue(values[field.id] ?? ''))
              .map((field) => ({
                key: journalColumnKey(dataset.id, field),
                label: field.label,
                kind: field.kind,
                value: values[field.id],
                colors: field.colors,
                source: dataset.source,
                year: dataset.year
              }))
          })
        }
      })
    }
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  JournalAttributes as Catalog,
  type JournalStore,
  type JournalReferences,
  type JournalRecord,
  type JournalEntry,
  type JournalDatasetRow,
  type JournalDatabase
} from '@aipoch/journal-catalog'
import {
  normalizeJournalName,
  journalBindingIdentity,
  journalIdentityFromItem,
  type JournalDataset
} from '@aipoch/journal-catalog/contracts'
import { createLogger } from '@aipoch/diagnostics/node'
const log = createLogger('journal-attributes')
function adaptReferences(client: Prisma.TransactionClient): JournalReferences {
  return {
    async read(filter, limit, lifecycle) {
      const where = filter.ids
        ? filter.ids.length
          ? Prisma.sql`i.id IN (${Prisma.join([...filter.ids])})`
          : Prisma.sql`0 = 1`
        : Prisma.sql`i.id > ${filter.after ?? ''}`
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
    },
    bindings: (ids, after) =>
      client.$queryRaw<{ itemId: string; revision: string }[]>(
        Prisma.sql`SELECT "itemId", revision FROM "JournalItemBinding" WHERE "journalId" IN (${Prisma.join(ids)}) AND "itemId" > ${after} ORDER BY "itemId" LIMIT 500`
      ),
    async bind(item, journalId) {
      if (journalId) {
        await client.$executeRaw`INSERT INTO "JournalItemBinding" ("itemId", "journalId", "identityFingerprint", revision) VALUES (${item.id}, ${journalId}, ${item.fingerprint}, ${randomUUID()}) ON CONFLICT("itemId") DO UPDATE SET "journalId" = excluded."journalId", "identityFingerprint" = excluded."identityFingerprint", revision = excluded.revision`
      } else {
        await client.$executeRaw`DELETE FROM "JournalItemBinding" WHERE "itemId" = ${item.id}`
      }
    }
  }
}
// Persistence representation belongs to the application; the package sees domain values only.
type IdentityRow = {
  id: string
  name: string
  aliasesJson: string
  issnsJson: string
  externalIdsJson: string
}
function identity(row: IdentityRow): JournalRecord {
  return {
    id: row.id,
    name: row.name,
    aliases: JSON.parse(row.aliasesJson),
    issns: JSON.parse(row.issnsJson),
    externalIds: JSON.parse(row.externalIdsJson)
  }
}
function adaptStore(client: Prisma.TransactionClient): JournalStore {
  return {
    references: adaptReferences(client),
    async listJournals() {
      return (await client.$queryRaw<IdentityRow[]>`SELECT * FROM "Journal"`).map(identity)
    },
    async listDatasets() {
      const rows = await client.$queryRaw<
        {
          id: string
          name: string | null
          source: string
          year: number
          revision: number
          fieldsJson: string
          importedAt: Date | string | number
          count: bigint
        }[]
      >`SELECT d.*, COUNT(e."journalId") AS count FROM "JournalDataset" d LEFT JOIN "JournalDatasetEntry" e ON e."datasetId" = d.id GROUP BY d.id ORDER BY d.year DESC, d.source`
      return rows.map(({ fieldsJson, importedAt, count, ...row }): JournalDataset => ({
        ...row,
        fields: JSON.parse(fieldsJson),
        importedAt: new Date(importedAt).getTime(),
        count: Number(count)
      }))
    },
    async readEntries({ datasetIds, journalIds, after, limit }) {
      if (!datasetIds.length || journalIds?.length === 0) return []
      const rows = await client.$queryRaw<
        (Omit<JournalEntry, 'values'> & { valuesJson: string })[]
      >(Prisma.sql`
        SELECT * FROM "JournalDatasetEntry" WHERE "datasetId" IN (${Prisma.join([...datasetIds])})
        ${journalIds ? Prisma.sql`AND "journalId" IN (${Prisma.join([...journalIds])})` : Prisma.empty}
        ${after !== undefined ? Prisma.sql`AND "journalId" > ${after}` : Prisma.empty}
        ORDER BY "journalId", "datasetId" ${limit !== undefined ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}`)
      return rows.map(({ valuesJson, ...row }) => ({ ...row, values: JSON.parse(valuesJson) }))
    },
    async readDatasetRows(datasetId, { journalIds, after, limit }) {
      if (journalIds?.length === 0) return []
      const rows = await client.$queryRaw<
        (IdentityRow & { valuesJson: string; sourceRow: number })[]
      >(Prisma.sql`
        SELECT j.*, e."valuesJson", e."sourceRow" FROM "JournalDatasetEntry" e JOIN "Journal" j ON j.id = e."journalId"
        WHERE e."datasetId" = ${datasetId}
        ${journalIds ? Prisma.sql`AND j.id IN (${Prisma.join([...journalIds])})` : Prisma.empty}
        ${after !== undefined ? Prisma.sql`AND j.id > ${after}` : Prisma.empty}
        ORDER BY j.id ${limit !== undefined ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}`)
      return rows.map((row): JournalDatasetRow => ({
        ...identity(row),
        values: JSON.parse(row.valuesJson),
        row: row.sourceRow
      }))
    },
    async listExclusiveJournalIds(datasetId, after, limit) {
      const rows = await client.$queryRaw<{ id: string }[]>`SELECT j.id FROM "Journal" j
        WHERE j.id > ${after} AND EXISTS (SELECT 1 FROM "JournalDatasetEntry" e WHERE e."journalId" = j.id AND e."datasetId" = ${datasetId})
        AND NOT EXISTS (SELECT 1 FROM "JournalDatasetEntry" e WHERE e."journalId" = j.id AND e."datasetId" != ${datasetId}) ORDER BY j.id LIMIT ${limit}`
      return rows.map(({ id }) => id)
    },
    async hasJournal(id) {
      return (
        (await client.$queryRaw<{ id: string }[]>`SELECT id FROM "Journal" WHERE id = ${id}`)
          .length > 0
      )
    },
    async saveDatasetImport(dataset) {
      await client.$executeRaw`INSERT INTO "JournalDataset" (id, name, source, year, revision, "fieldsJson", "importedAt")
        VALUES (${dataset.id}, ${dataset.name ?? null}, ${dataset.source}, ${dataset.year}, 1, ${JSON.stringify(dataset.fields)}, ${new Date(dataset.importedAt)})
        ON CONFLICT(id) DO UPDATE SET revision = revision + 1, "fieldsJson" = excluded."fieldsJson", "importedAt" = excluded."importedAt"`
    },
    async saveJournals(journals) {
      if (!journals.length) return
      await client.$executeRaw(Prisma.sql`INSERT INTO "Journal" (id, name, "normalizedName", "aliasesJson", "issnsJson", "externalIdsJson") VALUES
        ${Prisma.join(journals.map((journal) => Prisma.sql`(${journal.id}, ${journal.name}, ${normalizeJournalName(journal.name)}, ${JSON.stringify(journal.aliases)}, ${JSON.stringify(journal.issns)}, ${JSON.stringify(journal.externalIds ?? [])})`))}
        ON CONFLICT(id) DO UPDATE SET "aliasesJson" = excluded."aliasesJson", "issnsJson" = excluded."issnsJson", "externalIdsJson" = excluded."externalIdsJson"`)
    },
    async saveEntries(entries) {
      if (!entries.length) return
      await client.$executeRaw(Prisma.sql`INSERT INTO "JournalDatasetEntry" ("datasetId", "journalId", "valuesJson", "sourceRow") VALUES
        ${Prisma.join(entries.map((entry) => Prisma.sql`(${entry.datasetId}, ${entry.journalId}, ${JSON.stringify(entry.values)}, ${entry.sourceRow})`))}
        ON CONFLICT("datasetId", "journalId") DO UPDATE SET "valuesJson" = excluded."valuesJson", "sourceRow" = excluded."sourceRow"`)
    },
    async updateDataset(id, patch) {
      const assignments = [Prisma.sql`revision = revision + 1`]
      if (patch.name !== undefined) assignments.push(Prisma.sql`name = ${patch.name}`)
      if (patch.source !== undefined) assignments.push(Prisma.sql`source = ${patch.source}`)
      if (patch.year !== undefined) assignments.push(Prisma.sql`year = ${patch.year}`)
      if (patch.fields !== undefined)
        assignments.push(Prisma.sql`"fieldsJson" = ${JSON.stringify(patch.fields)}`)
      await client.$executeRaw(
        Prisma.sql`UPDATE "JournalDataset" SET ${Prisma.join(assignments)} WHERE id = ${id}`
      )
    },
    async removeDataset(id) {
      await client.$executeRaw`DELETE FROM "JournalDataset" WHERE id = ${id}`
      await client.$executeRaw`DELETE FROM "Journal" WHERE NOT EXISTS (SELECT 1 FROM "JournalDatasetEntry" WHERE "journalId" = "Journal".id)`
    }
  }
}
const databases = new WeakMap<PrismaClient, JournalDatabase>()
function adaptDatabase(client: PrismaClient): JournalDatabase {
  let database = databases.get(client)
  if (!database) {
    database = {
      ...adaptStore(client),
      transaction: (operation, options) =>
        client.$transaction((tx) => operation(adaptStore(tx)), options)
    }
    databases.set(client, database)
  }
  return database
}
export class JournalAttributes extends Catalog {
  constructor(getClient: () => Promise<PrismaClient>, changed: () => void = () => {}) {
    super(async () => adaptDatabase(await getClient()), changed, {
      warn: (message, error) => log.warn(message, error)
    })
  }
  override filterItemIds(
    client: PrismaClient | JournalDatabase,
    ...args: Parameters<Catalog['filterItemIds']> extends [unknown, ...infer Rest] ? Rest : never
  ): Promise<string[]> {
    return super.filterItemIds('transaction' in client ? client : adaptDatabase(client), ...args)
  }
}

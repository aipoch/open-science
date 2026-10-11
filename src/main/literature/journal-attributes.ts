import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  JournalAttributes as Catalog,
  type JournalIntegration,
  type JournalReader,
  type JournalDatabase
} from '@aipoch/journal-catalog'
import { journalBindingIdentity, journalIdentityFromItem } from '@aipoch/journal-catalog/contracts'
import { createLogger } from '@aipoch/diagnostics/node'
const log = createLogger('journal-attributes')
const nativeReaders = new WeakMap<JournalReader, Prisma.TransactionClient>()
function nativeReader(reader: JournalReader): Prisma.TransactionClient {
  const native = nativeReaders.get(reader)
  if (!native) throw new Error('Journal reader does not belong to this database adapter')
  return native
}
function adaptReader(client: Prisma.TransactionClient): JournalReader {
  const reader: JournalReader = {
    query: ({ text, values }) => client.$queryRawUnsafe(text, ...values),
    execute: ({ text, values }) => client.$executeRawUnsafe(text, ...values)
  }
  nativeReaders.set(reader, client)
  return reader
}
const references: JournalIntegration['references'] = {
  async read(reader, filter, limit, lifecycle) {
    const client = nativeReader(reader)
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
  bindings: (reader, ids, after) =>
    nativeReader(reader).$queryRaw<{ itemId: string; revision: string }[]>(
      Prisma.sql`SELECT "itemId", revision FROM "JournalItemBinding" WHERE "journalId" IN (${Prisma.join(ids)}) AND "itemId" > ${after} ORDER BY "itemId" LIMIT 500`
    ),
  async bind(reader, item, journalId) {
    const transaction = nativeReader(reader)
    if (journalId) {
      await transaction.$executeRaw`INSERT INTO "JournalItemBinding" ("itemId", "journalId", "identityFingerprint", revision) VALUES (${item.id}, ${journalId}, ${item.fingerprint}, ${randomUUID()}) ON CONFLICT("itemId") DO UPDATE SET "journalId" = excluded."journalId", "identityFingerprint" = excluded."identityFingerprint", revision = excluded.revision`
    } else {
      await transaction.$executeRaw`DELETE FROM "JournalItemBinding" WHERE "itemId" = ${item.id}`
    }
  }
}
const databases = new WeakMap<PrismaClient, JournalDatabase>()
function adaptDatabase(client: PrismaClient): JournalDatabase {
  let database = databases.get(client)
  if (!database) {
    database = {
      ...adaptReader(client),
      transaction: (operation, options) =>
        client.$transaction((tx) => operation(adaptReader(tx)), options)
    }
    nativeReaders.set(database, client)
    databases.set(client, database)
  }
  return database
}
export class JournalAttributes extends Catalog {
  constructor(getClient: () => Promise<PrismaClient>, changed: () => void = () => {}) {
    super(async () => adaptDatabase(await getClient()), changed, {
      references,
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

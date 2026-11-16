import { ApplicationCommandError } from '../../shared/application-command-contract'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Prisma, PrismaClient } from '@prisma/client'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import {
  assertProjectRecordPath,
  getProjectRecordRoot,
  listProjectRecordIds,
  getProjectRecordRoute,
  readProjectRecordManifest
} from '../storage/data-location-identity'

type Client = Prisma.TransactionClient
type Row = Record<string, unknown>
// A closed set of research metadata, never provider history, credentials or global settings.
const scopes = {
  ArtifactLineage: '"projectId" = ?',
  ArtifactVersion: '"artifactId" IN (SELECT "id" FROM "ArtifactLineage" WHERE "projectId" = ?)',
  ArtifactVersionInput:
    '"artifactVersionId" IN (SELECT v."id" FROM "ArtifactVersion" v JOIN "ArtifactLineage" a ON a."id" = v."artifactId" WHERE a."projectId" = ?)',
  ArtifactLiteratureManifest:
    '"artifactVersionId" IN (SELECT v."id" FROM "ArtifactVersion" v JOIN "ArtifactLineage" a ON a."id" = v."artifactId" WHERE a."projectId" = ?)',
  ArtifactMessageSnapshot: '"projectId" = ?',
  FileOriginSession: '"projectId" = ?',
  UploadFile: '"projectId" = ?',
  UploadVersion: '"uploadFileId" IN (SELECT "id" FROM "UploadFile" WHERE "projectId" = ?)',
  ContentBlob: '"storageKey" LIKE ?',
  PdfDocument: '"id" IN (SELECT "pdfDocumentId" FROM "ContentBlob" WHERE "storageKey" LIKE ?)',
  Review: '"projectId" = ?',
  Finding: '"reviewId" IN (SELECT "id" FROM "Review" WHERE "projectId" = ?)',
  ReviewScopeSnapshot: '"projectId" = ?',
  ReviewFindingDisposition:
    '"sourceFindingId" IN (SELECT f."id" FROM "Finding" f JOIN "Review" r ON r."id" = f."reviewId" WHERE r."projectId" = ?)'
} as const
const models = new Set(Object.keys(scopes).map((name) => name[0].toLowerCase() + name.slice(1)))
models.add('managedFileVersionWriteOperation')
const mutations = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany'
])
const encode = (value: unknown): unknown => {
  if (typeof value === 'bigint') return { $integer: String(value) }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]))
  return value
}
const decode = (value: unknown): unknown => {
  if (value && typeof value === 'object' && '$integer' in value)
    return BigInt(String(value.$integer))
  if (value && typeof value === 'object' && '$date' in value) return new Date(String(value.$date))
  return value
}

const suppressed = new Set<string>()
const clients = new WeakMap<PrismaClient, PrismaClient>()
const checkpointKey = (storageRoot: string, projectId: string): string =>
  JSON.stringify([storageRoot, projectId])
export const suspendProjectRecordIndexCheckpoints = (
  storageRoot: string,
  projectId: string
): void => {
  suppressed.add(checkpointKey(storageRoot, projectId))
}
export const resumeProjectRecordIndexCheckpoints = (
  storageRoot: string,
  projectId: string
): void => {
  suppressed.delete(checkpointKey(storageRoot, projectId))
}

const fingerprint = (root: string, text: string): string =>
  `${root}:${createHash('sha256').update(text).digest('hex')}`
const snapshot = async (
  client: Client,
  storageRoot: string,
  projectIds: ReadonlySet<string>
): Promise<Map<string, string>> => {
  const published = new Map<string, string>()
  for (const projectId of projectIds) {
    const root = getProjectRecordRoot(storageRoot, projectId)
    if (!root) continue
    if (
      suppressed.has(checkpointKey(storageRoot, projectId)) ||
      (getProjectRecordRoute(storageRoot, projectId) as { detached?: boolean } | undefined)
        ?.detached
    )
      continue
    if (await client.projectDeletionIntent.findUnique({ where: { projectId } })) continue
    const tables: Record<string, Row[]> = {}
    for (const [table, where] of Object.entries(scopes)) {
      tables[table] = await client.$queryRawUnsafe<Row[]>(
        `SELECT * FROM "${table}" WHERE ${where}`,
        ['ContentBlob', 'PdfDocument'].includes(table) ? `artifacts/${projectId}/%` : projectId
      )
    }
    // Preserve the identity and facts of referenced sources even if their owning project is not
    // reopened. This does not claim that external source bytes are still present.
    const append = async (table: string, field: string, values: unknown[]): Promise<boolean> => {
      const primary = table === 'ArtifactLiteratureManifest' ? 'artifactVersionId' : 'id'
      const existing = new Set(tables[table].map((row) => row[primary]))
      const missing = [...new Set(values)].filter((value) => value != null)
      if (!missing.length) return false
      const rows = await client.$queryRawUnsafe<Row[]>(
        `SELECT * FROM "${table}" WHERE "${field}" IN (${missing.map(() => '?').join(',')})`,
        ...missing
      )
      const added = rows.filter((row) => !existing.has(row[primary]))
      tables[table].push(...added)
      return added.length > 0
    }
    for (;;) {
      const before = tables.ArtifactVersion.length + tables.ArtifactVersionInput.length
      await append(
        'ArtifactVersion',
        'id',
        tables.ArtifactVersionInput.map((row) => row.sourceArtifactVersionId)
      )
      await append(
        'ArtifactLineage',
        'id',
        tables.ArtifactVersion.map((row) => row.artifactId)
      )
      await append(
        'ArtifactVersion',
        'artifactId',
        tables.ArtifactLineage.map((row) => row.id)
      )
      await append(
        'ArtifactVersionInput',
        'artifactVersionId',
        tables.ArtifactVersion.map((row) => row.id)
      )
      if (before === tables.ArtifactVersion.length + tables.ArtifactVersionInput.length) break
    }
    await append(
      'UploadVersion',
      'id',
      tables.ArtifactVersionInput.map((row) => row.sourceUploadVersionId)
    )
    await append(
      'UploadFile',
      'id',
      tables.UploadVersion.map((row) => row.uploadFileId)
    )
    await append(
      'UploadVersion',
      'uploadFileId',
      tables.UploadFile.map((row) => row.id)
    )
    await append(
      'ArtifactMessageSnapshot',
      'id',
      tables.ArtifactVersion.map((row) => row.messageSnapshotId)
    )
    await append(
      'ArtifactLiteratureManifest',
      'artifactVersionId',
      tables.ArtifactVersion.map((row) => row.id)
    )
    await append(
      'ContentBlob',
      'id',
      [...tables.ArtifactVersion, ...tables.UploadVersion].map((row) => row.contentBlobId)
    )
    await append(
      'PdfDocument',
      'id',
      tables.ContentBlob.map((row) => row.pdfDocumentId)
    )
    for (const row of [
      ...tables.ArtifactLineage,
      ...tables.UploadFile,
      ...tables.ArtifactMessageSnapshot,
      ...tables.ArtifactVersionInput.map((row) => ({
        projectId: row.sourceProjectId,
        sessionId: row.sourceSessionId
      }))
    ]) {
      if (
        !tables.FileOriginSession.some(
          (origin) => origin.projectId === row.projectId && origin.sessionId === row.sessionId
        )
      ) {
        tables.FileOriginSession.push(
          ...(await client.$queryRawUnsafe<Row[]>(
            'SELECT * FROM "FileOriginSession" WHERE "projectId" = ? AND "sessionId" = ?',
            row.projectId,
            row.sessionId
          ))
        )
      }
    }
    // v1 readers reject unknown columns even when null. Preserve that file contract until
    // explicit layout enablement, including referenced lineages collected from other projects.
    if (readProjectRecordManifest(dirname(root))?.version === 1) {
      for (const row of tables.ArtifactLineage) delete row.outputDeliveryJson
    }
    const text = JSON.stringify(encode({ version: 1, projectId, tables })) + '\n'
    await writeDurableJsonFile(
      assertProjectRecordPath(root, join(root, 'artifact-index.json')),
      text
    )
    published.set(projectId, fingerprint(root, text))
  }
  return published
}

// Restore metadata only. Missing/corrupt immutable bytes remain unavailable through the ordinary
// checksum-verified readers; rebuilding never invents content or generation evidence.
export const restoreProjectRecordIndexes = async (
  client: PrismaClient,
  storageRoot: string,
  projectId: string
): Promise<void> => {
  client = clients.get(client) ?? client
  await client.$transaction((tx) =>
    restoreProjectRecordIndexesWithinTransaction(tx, storageRoot, projectId)
  )
}

export const restoreProjectRecordIndexesWithinTransaction = async (
  tx: Prisma.TransactionClient,
  storageRoot: string,
  projectId: string
): Promise<void> => {
  const root = getProjectRecordRoot(storageRoot, projectId)
  if (!root) return
  let document: { version: number; projectId: string; tables: Record<string, Row[]> }
  try {
    document = JSON.parse(
      await readFile(assertProjectRecordPath(root, join(root, 'artifact-index.json')), 'utf8')
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (document.version !== 1 || document.projectId !== projectId || !document.tables)
    throw new Error('Invalid project Artifact index.')
  const ownLineages = new Set(
    document.tables.ArtifactLineage?.filter((row) => row.projectId === projectId).map(
      (row) => row.id
    )
  )
  const ownVersions = new Set(
    document.tables.ArtifactVersion?.filter((row) => ownLineages.has(row.artifactId)).map(
      (row) => row.id
    )
  )
  const ownUploads = new Set(
    document.tables.UploadFile?.filter((row) => row.projectId === projectId).map((row) => row.id)
  )
  const ownReviews = new Set(
    document.tables.Review?.filter((row) => row.projectId === projectId).map((row) => row.id)
  )
  const ownFindings = new Set(
    document.tables.Finding?.filter((row) => ownReviews.has(row.reviewId)).map((row) => row.id)
  )
  const owns = (table: string, row: Row): boolean => {
    if ('projectId' in row) return row.projectId === projectId
    if (table === 'ArtifactVersion') return ownLineages.has(row.artifactId)
    if (table === 'ArtifactVersionInput' || table === 'ArtifactLiteratureManifest')
      return ownVersions.has(row.artifactVersionId)
    if (table === 'UploadVersion') return ownUploads.has(row.uploadFileId)
    if (table === 'Finding') return ownReviews.has(row.reviewId)
    if (table === 'ReviewFindingDisposition') return ownFindings.has(row.sourceFindingId)
    if (table === 'ContentBlob')
      return (
        typeof row.storageKey === 'string' && row.storageKey.startsWith(`artifacts/${projectId}/`)
      )
    return false // shared PDF identities and foreign source facts are insert-only
  }
  await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON')
  for (const table of Object.keys(scopes)) {
    const rows = document.tables[table]
    if (!Array.isArray(rows)) throw new Error('Incomplete project Artifact index.')
    const columns = await tx.$queryRawUnsafe<Array<{ name: string; pk: number }>>(
      `PRAGMA table_info("${table}")`
    )
    const names = new Set(columns.map((c) => c.name))
    const primary = columns
      .filter((c) => c.pk)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => c.name)
    for (const row of rows) {
      const keys = Object.keys(row)
      if (!keys.length || keys.some((key) => !names.has(key)))
        throw new Error('Invalid project Artifact index columns.')
      const quoted = keys.map((key) => `"${key}"`)
      const updates = keys
        .filter((key) => !primary.includes(key))
        .map((key) => `"${key}"=excluded."${key}"`)
        .join(',')
      const owned = owns(table, row)
      if (!owned) {
        const existing = await tx.$queryRawUnsafe<Row[]>(
          `SELECT * FROM "${table}" WHERE ${primary.map((key) => `"${key}" = ?`).join(' AND ')}`,
          ...primary.map((key) => decode(row[key]))
        )
        const immutable: Record<string, string[]> = {
          ArtifactLineage: ['projectId', 'sessionId', 'normalizedFilename'],
          UploadFile: ['projectId', 'sessionId'],
          ArtifactVersion: [
            'artifactId',
            'versionNumber',
            'checksum',
            'sizeBytes',
            'contentStorageKey',
            'evidenceChecksum',
            'executionSnapshotChecksum'
          ],
          UploadVersion: [
            'uploadFileId',
            'versionNumber',
            'checksum',
            'sizeBytes',
            'contentStorageKey'
          ],
          ArtifactVersionInput: [
            'artifactVersionId',
            'sourceProjectId',
            'sourceSessionId',
            'checksum',
            'sizeBytes',
            'storageKey'
          ],
          ContentBlob: ['checksum', 'sizeBytes', 'storageKey'],
          PdfDocument: ['checksum'],
          ArtifactLiteratureManifest: ['artifactVersionId', 'checksum'],
          ArtifactMessageSnapshot: ['projectId', 'sessionId', 'storageKey']
        }
        for (const key of immutable[table] ?? primary) {
          if (
            existing[0] &&
            JSON.stringify(encode(existing[0][key])) !== JSON.stringify(encode(decode(row[key])))
          )
            throw new Error(`Conflicting immutable project source metadata: ${table}.${key}`)
        }
      }
      const conflict = owned ? `DO UPDATE SET ${updates}` : 'DO NOTHING'
      await tx.$executeRawUnsafe(
        `INSERT INTO "${table}" (${quoted.join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT (${primary.map((key) => `"${key}"`).join(',')}) ${conflict}`,
        ...keys.map((key) => decode(row[key]))
      )
    }
  }
  // A crash can leave a newer index transaction than the last acknowledged checkpoint. Remove
  // those extra project-owned projections so the disk record remains the authority on restart.
  for (const table of [
    'ArtifactVersionInput',
    'ArtifactLiteratureManifest',
    'ArtifactVersion',
    'ArtifactLineage',
    'ArtifactMessageSnapshot',
    'Finding',
    'ReviewFindingDisposition',
    'ReviewScopeSnapshot',
    'Review'
  ] as const) {
    const key = table === 'ArtifactLiteratureManifest' ? 'artifactVersionId' : 'id'
    const ids = document.tables[table].map((row) => decode(row[key]))
    const keep = ids.length ? ` AND "${key}" NOT IN (${ids.map(() => '?').join(',')})` : ''
    await tx.$executeRawUnsafe(
      `DELETE FROM "${table}" WHERE (${scopes[table]})${keep}`,
      projectId,
      ...ids
    )
  }
}

type Operation = { model: string; method: string; args: unknown[] }
const operation = Symbol('project-record-operation')
const ownerSelects: Record<string, object> = {
  artifactLineage: { projectId: true },
  artifactMessageSnapshot: { projectId: true },
  fileOriginSession: { projectId: true },
  uploadFile: { projectId: true },
  review: { projectId: true },
  reviewScopeSnapshot: { projectId: true },
  managedFileVersionWriteOperation: { projectId: true },
  artifactVersion: { artifact: { select: { projectId: true } } },
  artifactVersionInput: {
    artifactVersion: { select: { artifact: { select: { projectId: true } } } }
  },
  artifactLiteratureManifest: {
    artifactVersion: { select: { artifact: { select: { projectId: true } } } }
  },
  uploadVersion: { uploadFile: { select: { projectId: true } } },
  finding: { review: { select: { projectId: true } } },
  reviewFindingDisposition: {
    sourceFinding: { select: { review: { select: { projectId: true } } } }
  },
  contentBlob: { storageKey: true }
}
const collectOwners = (value: unknown, owners: Set<string>): void => {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectOwners(item, owners)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'projectId' && typeof item === 'string') owners.add(item)
    else if (key === 'storageKey' && typeof item === 'string') {
      const parts = item.split('/')
      if (parts[0] === 'artifacts' && parts[1]) owners.add(parts[1])
    } else if (item && typeof item === 'object') collectOwners(item, owners)
  }
}

// The per-client gate reconciles changed on-disk checkpoints before serving any operation. A
// failed DB commit leaves its published checkpoint unacknowledged in this map, so the next read
// reconstructs it. Checkpoints only serialize the projects actually changed by a transaction.
export const withProjectRecordIndexes = (
  client: PrismaClient,
  storageRoot: string
): PrismaClient => {
  const synchronized = new Map<string, string>()
  const failures = new Map<string, unknown>()
  let reconciling: Promise<void> | undefined
  const ensureIndexes = async (): Promise<void> => {
    if (reconciling) return reconciling
    reconciling = (async () => {
      for (const id of listProjectRecordIds(storageRoot)) {
        try {
          const route = getProjectRecordRoute(storageRoot, id)
          if (route?.detached || suppressed.has(checkpointKey(storageRoot, id))) {
            failures.delete(id)
            continue
          }
          let root: string | undefined
          try {
            root = getProjectRecordRoot(storageRoot, id)
          } catch (error) {
            throw new ApplicationCommandError(
              (error as NodeJS.ErrnoException).code === 'ENOENT' &&
                (error as NodeJS.ErrnoException).path === route?.folder
                ? 'project-folder-not-found'
                : 'project-folder-unavailable',
              `Project Artifact records are unavailable: ${id}`,
              undefined,
              { cause: error }
            )
          }
          if (!root) continue
          let text: string
          try {
            text = await readFile(
              assertProjectRecordPath(root, join(root, 'artifact-index.json')),
              'utf8'
            )
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              failures.delete(id)
              continue
            }
            throw error
          }
          const signature = fingerprint(root, text)
          if (synchronized.get(id) !== signature) {
            await client.$transaction(async (tx) => {
              if (await tx.projectDeletionIntent.findUnique({ where: { projectId: id } })) return
              await restoreProjectRecordIndexesWithinTransaction(tx, storageRoot, id)
            })
            synchronized.set(id, signature)
          }
          failures.delete(id)
        } catch (error) {
          failures.set(id, error)
        }
      }
    })()
    try {
      await reconciling
    } finally {
      reconciling = undefined
    }
  }
  const run = (context: Client, op: Operation): Promise<unknown> =>
    (
      context as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
    )[op.model][op.method](...op.args)
  const isWrite = (op: Operation): boolean => models.has(op.model) && mutations.has(op.method)
  const assertReady = (op: Operation, owners: ReadonlySet<string>): void => {
    if (!models.has(op.model)) return
    if (owners.size === 0 && failures.size) {
      const first = failures.values().next().value
      if (first instanceof ApplicationCommandError) throw first
      throw new Error('Project Artifact records are unavailable.', {
        cause: failures.values().next().value
      })
    }
    for (const id of owners)
      if (failures.has(id)) {
        if (failures.get(id) instanceof ApplicationCommandError) throw failures.get(id)
        throw new Error(`Project Artifact records are unavailable: ${id}`, {
          cause: failures.get(id)
        })
      }
  }
  const invoke = async (tx: Client, op: Operation, touched: Set<string>): Promise<unknown> => {
    const args = (op.args[0] ?? {}) as { where?: object; data?: unknown; create?: unknown }
    const select = ownerSelects[op.model]
    const delegate = (
      tx as unknown as Record<
        string,
        {
          findMany: (args: object) => Promise<unknown>
          findUnique: (args: object) => Promise<unknown>
        }
      >
    )[op.model]
    const matchOwners = (): Promise<unknown> =>
      ['update', 'delete', 'upsert', 'findUnique', 'findUniqueOrThrow'].includes(op.method)
        ? delegate.findUnique({ where: args.where, select })
        : delegate.findMany({ where: args.where, select })
    const matchedOwners = new Set<string>()
    if (select && args.where) collectOwners(await matchOwners(), matchedOwners)
    if (isWrite(op)) for (const id of matchedOwners) touched.add(id)
    const requested = new Set<string>(matchedOwners)
    collectOwners(op.args, requested)
    for (const id of touched) requested.add(id)
    assertReady(op, requested)
    const result = await run(tx, op)
    if (isWrite(op) && select) {
      // Selected results can omit ownership. Re-read only the affected identities after insertion.
      const records = Array.isArray(result) ? result : [result]
      const ids = records.flatMap((row) =>
        row && typeof row === 'object' && 'id' in row ? [row.id] : []
      )
      if (ids.length)
        collectOwners(await delegate.findMany({ where: { id: { in: ids } }, select }), touched)
      if (args.where && !['delete', 'deleteMany'].includes(op.method))
        collectOwners(await matchOwners(), touched)
      if (['create', 'createMany', 'upsert'].includes(op.method)) {
        const data = args.data ?? args.create
        const dataRows = Array.isArray(data) ? data : [data]
        if (op.model === 'contentBlob') collectOwners(data, touched)
        else
          for (const row of dataRows)
            if (
              row &&
              typeof row === 'object' &&
              'projectId' in row &&
              typeof row.projectId === 'string'
            )
              touched.add(row.projectId)
        const parentFields: Record<string, string> = {
          artifactVersion: 'artifactId',
          artifactVersionInput: 'artifactVersionId',
          artifactLiteratureManifest: 'artifactVersionId',
          uploadVersion: 'uploadFileId',
          finding: 'reviewId',
          reviewFindingDisposition: 'sourceFindingId'
        }
        const field = parentFields[op.model]
        const rows = Array.isArray(data) ? data : [data]
        const parents = rows.flatMap((row) =>
          row && typeof row === 'object' && field in row ? [(row as Row)[field]] : []
        )
        if (field && parents.length)
          collectOwners(
            await delegate.findMany({ where: { [field]: { in: parents } }, select }),
            touched
          )
      }
    }
    for (const id of touched) requested.add(id)
    assertReady(op, requested)
    return result
  }
  const transaction = async (input: unknown, options?: unknown): Promise<unknown> => {
    await ensureIndexes()
    let published = new Map<string, string>()
    const result = await client.$transaction(
      async (tx) => {
        const touched = new Set<string>()
        let value: unknown
        if (Array.isArray(input)) {
          value = []
          for (const item of input) {
            const op = item[operation] as Operation | undefined
            if (!op)
              throw new Error(
                'Project record transactions require operations from the same client.'
              )
            ;(value as unknown[]).push(await invoke(tx, op, touched))
          }
        } else {
          value = await (input as (tx: Client) => Promise<unknown>)(
            new Proxy(tx, {
              get(target, name) {
                const delegate = Reflect.get(target, name)
                if (typeof name !== 'string' || !delegate || typeof delegate !== 'object')
                  return typeof delegate === 'function' ? delegate.bind(target) : delegate
                return new Proxy(delegate, {
                  get(model, method) {
                    const fn = Reflect.get(model, method)
                    return typeof fn === 'function'
                      ? (...args: unknown[]) =>
                          invoke(tx, { model: name, method: String(method), args }, touched)
                      : fn
                  }
                })
              }
            })
          )
        }
        const checkpointProjects = [...touched].filter(
          (id) =>
            getProjectRecordRoute(storageRoot, id) &&
            !getProjectRecordRoute(storageRoot, id)?.detached &&
            !suppressed.has(checkpointKey(storageRoot, id))
        )
        // A single SQLite commit cannot atomically publish two independent portable authorities.
        // Reject before publishing either checkpoint rather than resurrecting part of a rolled-back
        // multi-project transaction after a later checkpoint fails.
        if (checkpointProjects.length > 1)
          throw new Error('A research record transaction must belong to one Project.')
        published = await snapshot(tx, storageRoot, touched)
        return value
      },
      options as {
        maxWait?: number
        timeout?: number
        isolationLevel?: Prisma.TransactionIsolationLevel
      }
    )
    for (const [id, signature] of published) synchronized.set(id, signature)
    return result
  }
  const wrapped = new Proxy(client, {
    get(target, name) {
      if (name === '$transaction') return transaction
      const delegate = Reflect.get(target, name)
      if (
        typeof name === 'string' &&
        ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'].includes(name)
      )
        return async (...args: unknown[]) => {
          await ensureIndexes()
          return delegate.apply(target, args)
        }
      if (
        typeof name !== 'string' ||
        name.startsWith('$') ||
        !delegate ||
        typeof delegate !== 'object'
      )
        return typeof delegate === 'function' ? delegate.bind(target) : delegate
      return new Proxy(delegate, {
        get(model, method) {
          const fn = Reflect.get(model, method)
          if (typeof fn !== 'function') return fn
          return (...args: unknown[]) => {
            const op: Operation = { model: name, method: String(method), args }
            let promise: Promise<unknown> | undefined
            const execute = (): Promise<unknown> =>
              (promise ??= isWrite(op)
                ? transaction([lazy]).then((items) => (items as unknown[])[0])
                : ensureIndexes().then(async () => {
                    const owners = new Set<string>()
                    collectOwners(op.args, owners)
                    const args = op.args[0] as { where?: object } | undefined
                    const select = ownerSelects[op.model]
                    if (select && args?.where && owners.size === 0) {
                      const model = (
                        target as unknown as Record<
                          string,
                          { findMany: (args: object) => Promise<unknown> }
                        >
                      )[op.model]
                      // Read operations use filters (not composite unique selectors) except findUnique.
                      const value = op.method.startsWith('findUnique')
                        ? await run(target, {
                            model: op.model,
                            method: 'findUnique',
                            args: [{ where: args.where, select }]
                          })
                        : await model.findMany({ where: args.where, select })
                      collectOwners(value, owners)
                    }
                    assertReady(op, owners)
                    return run(target, op)
                  }))
            const lazy = {
              [operation]: op,
              [Symbol.toStringTag]: 'PrismaPromise',
              then: (...a: Parameters<Promise<unknown>['then']>) => execute().then(...a),
              catch: (...a: Parameters<Promise<unknown>['catch']>) => execute().catch(...a),
              finally: (...a: Parameters<Promise<unknown>['finally']>) => execute().finally(...a)
            }
            return lazy
          }
        }
      })
    }
  }) as PrismaClient
  clients.set(wrapped, client)
  return wrapped
}

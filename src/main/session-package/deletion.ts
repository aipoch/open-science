import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  sessionPackageRequestSchema,
  type SessionPackageReceipt
} from '../../shared/session-package'
import { SessionRepository } from '../session-persistence/repository'
import { writeDurableJsonFile } from '../storage/durable-json-file'
import { defaultFileDurability as durability } from '../storage/file-durability'
import { createLogger, diagnosticErrorFields } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { assertPackageSourcePath, readPackageJson } from './archive'
import { packageNativeTables } from './native-snapshot'

const uuid = z.string().uuid()
const importedIdentity = z
  .string()
  .refine((value) => uuid.safeParse(value.replace(/^import-/, '')).success)
const scope = z.enum(['artifacts', 'uploads', 'notebooks', 'execution-file-evidence'])
const journalSchema = sessionPackageRequestSchema
  .extend({
    schemaVersion: z.literal(1),
    importId: uuid,
    identities: z.array(importedIdentity).max(100000),
    directories: z.array(z.object({ scope, sessionId: importedIdentity }).strict()).max(10000),
    retainOnly: z.boolean().optional(),
    retentionReason: z.string().max(2000).optional()
  })
  .strict()
type Journal = z.infer<typeof journalSchema>
type Row = Record<string, unknown>
type Removal = { table: string; key: readonly string[]; values: unknown[][] }
type Options = { configRoot: string; storageRoot: string; getClient: () => Promise<PrismaClient> }
const marker = '.session-package-owner'
const nativeTables = new Set<string>(packageNativeTables)
const derivedTables = new Set(['ManagedFile', 'ManagedFileSessionSync', 'TagAssignment'])

const exists = async (path: string): Promise<boolean> =>
  lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })

// This owner runs only during pre-hydration startup. It deliberately does not try to fence all
// live Notebook, Session and provenance writers or introduce a per-file reference-count model.
export class SessionPackageDeletion {
  constructor(private readonly options: Options) {}

  async prepare(
    session: PersistedChatSession,
    receipt: SessionPackageReceipt,
    originSessionIds: string[]
  ): Promise<void> {
    if (
      !session.packageOrigin ||
      receipt.importId !== session.packageOrigin.importId ||
      receipt.manifestChecksum !== session.packageOrigin.manifestChecksum ||
      receipt.projectId !== session.projectId ||
      receipt.sessionId !== session.id
    )
      throw new Error('Session package deletion ownership mismatch.')
    const identities = [
      ...new Set(Object.values(receipt.identities).filter((id) => id !== session.projectId))
    ]
    const directories = new Map<string, Journal['directories'][number]>()
    const add = (kind: string, projectId: string, sessionId: string): void => {
      if (projectId !== session.projectId || !identities.includes(sessionId))
        throw new Error('Session package directory is outside its import scope.')
      directories.set(`${kind}/${sessionId}`, { scope: scope.parse(kind), sessionId })
    }
    add('artifacts', session.projectId, session.id)
    for (const file of receipt.files) {
      const [kind, projectId, sessionId] = file.localStorageKey.split('/')
      add(kind, projectId, sessionId)
    }
    // Retained upstream origins may have no included file bytes, but have their own read-only
    // Artifact marker. Recovery verifies every durable claim before deleting anything.
    for (const id of originSessionIds) add('artifacts', session.projectId, id)
    const journal = journalSchema.parse({
      schemaVersion: 1,
      importId: receipt.importId,
      projectId: session.projectId,
      sessionId: session.id,
      identities,
      directories: [...directories.values()]
    })
    await this.writeIntent(journal)
  }

  async prepareRetained(session: PersistedChatSession): Promise<void> {
    // The live Session proves only the import identity, not the missing receipt's file ownership.
    await this.writeIntent(
      journalSchema.parse({
        schemaVersion: 1,
        importId: session.packageOrigin?.importId,
        projectId: session.projectId,
        sessionId: session.id,
        identities: [],
        directories: [],
        retainOnly: true,
        retentionReason:
          'Import ownership could not be verified. Conversation deleted; package evidence must be retained.'
      })
    )
  }

  private async writeIntent(journal: Journal): Promise<void> {
    const root = join(this.options.configRoot, 'session-package-cleanup')
    await mkdir(root, { recursive: true, mode: 0o700 })
    await assertPackageSourcePath(this.options.configRoot, 'session-package-cleanup')
    await writeDurableJsonFile(join(root, `${journal.importId}.json`), JSON.stringify(journal))
    await durability.syncDirectory(this.options.configRoot)
  }

  async recover(signal: AbortSignal): Promise<void> {
    const counts = {
      inspected: 0,
      recovered: 0,
      retained: 0,
      failed: 0,
      unverifiedOwnership: 0,
      sessionPresentOrUnreadable: 0,
      externalReferencesOrUnknown: 0
    }
    const diagnostic = startDiagnosticOperation(createLogger('session-package'), {
      operation: 'session-package.deletion-recovery'
    })
    try {
      const root = join(this.options.configRoot, 'session-package-cleanup')
      let entries: string[]
      try {
        if (!(await exists(root))) return
        await assertPackageSourcePath(this.options.configRoot, 'session-package-cleanup')
        entries = await readdir(root)
      } catch (error) {
        diagnostic.fail(error, counts)
        createLogger('session-package').warn(
          'Imported package cleanup journal is unavailable; evidence retained',
          diagnosticErrorFields(error)
        )
        return
      }
      for (const name of entries) {
        signal.throwIfAborted()
        if (!name.endsWith('.json')) continue
        counts.inspected += 1
        try {
          await assertPackageSourcePath(root, name)
          const journal = journalSchema.parse(await readPackageJson(join(root, name)))
          if (name !== `${journal.importId}.json`)
            throw new Error('Cleanup journal identity mismatch.')
          // Never infer ownership later from absent rows or paths for an unverifiable package.
          if (journal.retainOnly) {
            counts.retained += 1
            counts.unverifiedOwnership += 1
            continue
          }
          if (
            !journal.identities.includes(journal.sessionId) ||
            journal.directories.some(
              (directory) => !journal.identities.includes(directory.sessionId)
            )
          )
            throw new Error('Cleanup journal scope mismatch.')
          const session = await new SessionRepository(
            this.options.configRoot
          ).loadSessionWithDiagnostics(journal.projectId, journal.sessionId, { mode: 'read-only' })
          // A failed/interrupted deletion must never turn into deletion of a still-live Session.
          if (session.status !== 'missing') {
            counts.sessionPresentOrUnreadable += 1
            await this.retain(
              journal,
              session.status === 'found'
                ? 'The Session still exists.'
                : 'The Session could not be read safely.'
            )
            counts.retained += 1
            continue
          }
          const client = await this.options.getClient()
          const origin = await client.fileOriginSession.findUnique({
            where: {
              projectId_sessionId: { projectId: journal.projectId, sessionId: journal.sessionId }
            }
          })
          if (origin) {
            for (const directory of journal.directories)
              await this.assertOwned(
                `${directory.scope}/${journal.projectId}/${directory.sessionId}`,
                journal.importId
              )
            const removals = await this.unreferencedRows(client, journal, signal)
            if (!removals) {
              await this.retain(
                journal,
                'External references exist or could not be ruled out within the metadata check limits. The entire imported package is retained.'
              )
              counts.retained += 1
              counts.externalReferencesOrUnknown += 1
              continue
            }
            await client.$transaction(
              async (tx) => {
                await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON')
                for (const { table, key, values } of removals) {
                  // Stay below SQLite's portable bind-parameter and expression-depth limits.
                  const batchSize = Math.min(200, Math.floor(900 / key.length))
                  for (let start = 0; start < values.length; start += batchSize) {
                    signal.throwIfAborted()
                    const batch = values.slice(start, start + batchSize)
                    const predicate = key.map((column) => `"${column}" = ?`).join(' AND ')
                    await tx.$executeRawUnsafe(
                      `DELETE FROM "${table}" WHERE ${batch.map(() => `(${predicate})`).join(' OR ')}`,
                      ...batch.flat()
                    )
                  }
                }
              },
              { timeout: 30000 }
            )
          }
          // The import always creates its primary origin. Its absence witnesses the committed
          // removal transaction (also after a lost acknowledgement), so file cleanup is retryable.
          await this.removeFiles(journal)
          await rm(join(root, name))
          await durability.syncDirectory(root)
          counts.recovered += 1
        } catch (error) {
          counts.retained += 1
          counts.failed += 1
          // Keep each intent and continue to healthy items. Startup must not lose research or become
          // unavailable because one package cannot prove ownership or finish removing its files.
          createLogger('session-package').warn(
            'Imported package cleanup retained for retry',
            diagnosticErrorFields(error)
          )
        }
      }
    } catch (error) {
      if (signal.aborted) diagnostic.cancel(counts)
      else diagnostic.fail(error, counts)
      throw error
    } finally {
      if (signal.aborted) diagnostic.cancel(counts)
      else diagnostic.complete(counts)
    }
  }

  private async retain(journal: Journal, reason: string): Promise<void> {
    if (journal.retentionReason === reason) return
    await writeDurableJsonFile(
      join(this.options.configRoot, 'session-package-cleanup', `${journal.importId}.json`),
      JSON.stringify({ ...journal, retentionReason: reason })
    )
    createLogger('session-package').info('Imported package evidence retained', {
      importId: journal.importId,
      reason
    })
  }

  private async unreferencedRows(
    client: PrismaClient,
    journal: Journal,
    signal: AbortSignal
  ): Promise<Removal[] | undefined> {
    const identities = new Set(journal.identities)
    const ids = new Set(journal.identities.map((id) => id.replace(/^import-/, '')))
    const references = (value: unknown): boolean => {
      const text = (typeof value === 'string' ? value : JSON.stringify(value)).replace(
        /\\u([a-f0-9]{4})/gi,
        (_match, code: string) => String.fromCharCode(parseInt(code, 16))
      )
      for (const [id] of text.matchAll(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi))
        if (ids.has(id.toLowerCase())) return true
      return false
    }
    let remainingBytes = 64 * 1024 ** 2
    let remainingRows = 100000
    // A quarantine or backup can retain a reference not present in the live catalog. Inspect only
    // directory entries, without opening or repairing those alternate authorities during GC.
    for (const rootName of ['sessions', 'deleted-sessions']) {
      const root = join(this.options.configRoot, rootName)
      if (!(await exists(root))) continue
      await assertPackageSourcePath(this.options.configRoot, rootName)
      for (const entry of await readdir(root, { withFileTypes: true })) {
        signal.throwIfAborted()
        const project = entry.name
        await assertPackageSourcePath(root, project)
        // This is navigation state, not a Project directory or research authority.
        if (rootName === 'sessions' && project === 'manifest.json' && entry.isFile()) continue
        if (!entry.isDirectory()) return undefined
        const names = await readdir(join(root, project))
        if (
          rootName === 'deleted-sessions'
            ? names.length > 0
            : names.some((name) => !name.endsWith('.json'))
        )
          return undefined
        for (const name of names) {
          const path = join(root, project, name)
          const info = await lstat(path)
          if (!info.isFile()) return undefined
          remainingBytes -= info.size
          remainingRows--
          if (remainingBytes < 0 || remainingRows < 0) return undefined
        }
      }
    }
    const sessions = await new SessionRepository(this.options.configRoot).loadAllWithDiagnostics({
      mode: 'read-only'
    })
    if (!sessions.isComplete || sessions.result.sessions.some(references)) return undefined
    const ownedScopes = new Set(journal.directories.map((entry) => entry.sessionId))
    // ponytail: external Notebook/Task histories and message sidecars are not a complete indexed
    // reference boundary. Retain whole packages in their presence; add precise indexing only when
    // this conservative retention becomes a measured storage problem. Never scan research bodies.
    const taskJournals = (await readdir(this.options.configRoot)).filter((name) =>
      name.startsWith('task-runs.json')
    )
    if (taskJournals.length) {
      if (taskJournals.length !== 1 || taskJournals[0] !== 'task-runs.json') return undefined
      await assertPackageSourcePath(this.options.configRoot, 'task-runs.json')
      if ((await lstat(join(this.options.configRoot, 'task-runs.json'))).size > 4096)
        return undefined
      // Accept only the known empty document; never repair an unreadable journal into emptiness.
      const empty = z.object({ version: z.literal(1), runs: z.tuple([]) }).strict()
      if (
        !empty.safeParse(await readPackageJson(join(this.options.configRoot, 'task-runs.json')))
          .success
      )
        return undefined
    }
    for (const rootName of ['notebooks', 'execution-file-evidence']) {
      const notebooks = join(this.options.storageRoot, rootName)
      if (!(await exists(notebooks))) continue
      await assertPackageSourcePath(this.options.storageRoot, rootName)
      for (const project of await readdir(notebooks, { withFileTypes: true })) {
        await assertPackageSourcePath(this.options.storageRoot, `${rootName}/${project.name}`)
        // Working-file evidence keeps Project deletion receipts beside Project directories.
        if (
          rootName === 'execution-file-evidence' &&
          project.isFile() &&
          /^\.project-ownership-.+\.json$/.test(project.name)
        )
          continue
        if (!project.isDirectory()) return undefined
        for (const sessionId of await readdir(join(notebooks, project.name)))
          if (project.name !== journal.projectId || !ownedScopes.has(sessionId)) return undefined
      }
    }
    const removals: Removal[] = []
    for (const model of Prisma.dmmf.datamodel.models) {
      signal.throwIfAborted()
      const table = model.dbName ?? model.name
      const key =
        model.primaryKey?.fields ??
        model.fields.filter((field) => field.isId).map((field) => field.name)
      const columns = model.fields
        .filter(
          (field) =>
            field.kind === 'scalar' &&
            (field.type === 'String' || key.includes(field.name) || field.name === 'deletedAtMs')
        )
        .map((field) => field.name)
      if (!columns.length) continue
      // Query identifiers are exclusively generated schema identifiers. Limits are checked in
      // SQLite before text is materialized in JS; no binary credentials or file bodies are read.
      const [size] = await client.$queryRawUnsafe<{ rows: bigint; bytes: bigint }[]>(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(${columns.map((column) => `COALESCE(length(CAST("${column}" AS BLOB)), 0)`).join(' + ')}), 0) AS bytes FROM "${table}"`
      )
      remainingRows -= Number(size.rows)
      remainingBytes -= Number(size.bytes)
      if (remainingRows < 0 || remainingBytes < 0) return undefined
      const rows = await client.$queryRawUnsafe<Row[]>(
        `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}"`
      )
      const values: unknown[][] = []
      for (const row of rows) {
        const scoped = row.projectId === journal.projectId && ownedScopes.has(String(row.sessionId))
        const owned =
          (nativeTables.has(model.name) && (scoped || identities.has(String(row.id)))) ||
          (derivedTables.has(model.name) && (scoped || identities.has(String(row.resourceId))))
        if (owned) {
          if (!key.length) return undefined
          values.push(key.map((column) => row[column]))
        } else if (
          model.name === 'Session' &&
          row.id === journal.sessionId &&
          row.projectId === journal.projectId &&
          row.deletedAtMs != null
        ) {
          // Keep the existing query tombstone and monotonic Session number.
        } else if (
          model.name === 'ComputeJob' ||
          model.name === 'ArtifactMessageSnapshot' ||
          Object.values(row).some((value) => typeof value === 'string' && references(value))
        ) {
          return undefined
        }
      }
      if (values.length) removals.push({ table, key, values })
    }
    return removals
  }

  private async assertOwned(key: string, importId: string): Promise<void> {
    await assertPackageSourcePath(this.options.storageRoot, `${key}/${marker}`)
    if ((await readFile(join(this.options.storageRoot, key, marker), 'utf8')) !== importId)
      throw new Error('Imported directory ownership could not be confirmed.')
  }

  private async removeFiles(journal: Journal): Promise<void> {
    const root = join(this.options.storageRoot, 'session-package-trash')
    const trash = join(root, journal.importId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await assertPackageSourcePath(this.options.storageRoot, 'session-package-trash')
    if (!(await exists(trash))) {
      await mkdir(trash, { mode: 0o700 })
      await writeFile(join(trash, marker), journal.importId, { flag: 'wx', mode: 0o600 })
      await durability.syncFile(join(trash, marker))
      await durability.syncDirectory(trash)
      await durability.syncDirectory(root)
    }
    // A crash between unlinking the final marker and removing the empty trash directory leaves
    // no research bytes. The durable intent and absent original scopes permit finishing that tail.
    if ((await exists(trash)) && !(await exists(join(trash, marker)))) {
      await assertPackageSourcePath(
        this.options.storageRoot,
        `session-package-trash/${journal.importId}`
      )
      if (
        (await readdir(trash)).length ||
        (
          await Promise.all(
            journal.directories.map((directory) =>
              exists(
                join(
                  this.options.storageRoot,
                  directory.scope,
                  journal.projectId,
                  directory.sessionId
                )
              )
            )
          )
        ).some(Boolean)
      )
        throw new Error('Imported cleanup directory ownership could not be confirmed.')
      await rm(trash, { recursive: true })
      await durability.syncDirectory(root)
      return
    }
    await this.assertOwned(`session-package-trash/${journal.importId}`, journal.importId)
    for (const directory of journal.directories) {
      const key = `${directory.scope}/${journal.projectId}/${directory.sessionId}`
      const source = join(this.options.storageRoot, key)
      const destination = join(trash, `${directory.scope}-${directory.sessionId}`)
      if (await exists(source)) {
        await this.assertOwned(key, journal.importId)
        if (await exists(destination)) throw new Error('Imported cleanup destination is occupied.')
        await rename(source, destination)
        await durability.syncDirectory(
          join(this.options.storageRoot, directory.scope, journal.projectId)
        )
        await durability.syncDirectory(trash)
      }
      // Only a claimed import scope can be renamed into this private destination. Partial rm may
      // remove its internal marker first; the outer claim and durable intent retain ownership.
      await rm(destination, { recursive: true, force: true })
      await durability.syncDirectory(trash)
    }
    // Keep the outer claim until all recursive removals finish, so a failed deletion is retryable.
    await rm(join(trash, marker))
    await rm(trash, { recursive: true })
    await durability.syncDirectory(root)
  }
}

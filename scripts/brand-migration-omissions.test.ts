import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_SCHEMA_TABLE_DDLS } from '../src/main/database/generated/runtime-schema'
import { runMigration, inventory } from '../resources/brand-migration/transaction.mjs'
import { auditAliases } from '../resources/brand-migration/retirement.mjs'
import { remapPath } from '../resources/brand-migration/paths.mjs'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

type Fixture = {
  home: string
  config: string
  old: string
  next: string
  options: { home: string; appData: string; mode: 'dev' }
}
async function fixture(accented = false): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'brand-omissions-')))
  roots.push(root)
  const home = accented ? join(root, 'caf\u00e9') : root
  const config = join(home, '.open-science-project')
  const old = join(home, 'OpenScience-DEV')
  const next = join(home, 'Open-Science-DEV')
  await mkdir(config, { recursive: true })
  await mkdir(join(old, 'uploads'), { recursive: true })
  await writeFile(join(old, 'uploads', 'paper.txt'), 'research\n')
  await writeFile(join(config, 'settings.json'), JSON.stringify({ version: 2, dataRoot: old }))
  return { home, config, old, next, options: { home, appData: join(home, 'appData'), mode: 'dev' } }
}

// Use current generated table definitions, including CHECK constraints, rather than invented states.
function database(config: string, ...tables: string[]): DatabaseSync {
  const db = new DatabaseSync(join(config, 'open-science.db'))
  for (const table of tables) {
    const ddl = RUNTIME_SCHEMA_TABLE_DDLS.find((sql) =>
      sql.startsWith(`CREATE TABLE IF NOT EXISTS "${table}" (`)
    )
    if (!ddl) throw new Error(`Missing current table: ${table}`)
    db.exec(ddl)
  }
  return db
}
function grant(db: DatabaseSync, path: string): void {
  db.prepare('INSERT INTO GrantedLocalRoot (id,path,name,access,updatedAt) VALUES (?,?,?,?,?)').run(
    'root-id',
    path,
    'Research',
    'rw',
    new Date().toISOString()
  )
}
function writeOperation(db: DatabaseSync, state: string): void {
  db.prepare(
    `INSERT INTO ManagedFileVersionWriteOperation
    (operationId,source,projectId,sourceFileId,basedOnVersionId,expectedHeadVersionId,state,
     storageTag,storedFilename,contentStorageKey,checksum,sizeBytes,textFormatJson,resultVersionId,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    'operation-id',
    'upload',
    'project-id',
    'file-id',
    'version-1',
    'version-1',
    state,
    'tag',
    'paper.txt',
    'uploads/paper.txt',
    'a'.repeat(64),
    9,
    '{}',
    state === 'published' ? 'version-2' : null,
    new Date().toISOString()
  )
}
const notebook = (root: string): Record<string, unknown> => ({
  version: 1,
  projectId: 'p',
  sessionId: 's',
  workspaceCwd: root,
  notebookSessionRoot: root,
  dataRoot: root,
  kernel: { runtimeRoot: '$DATA/runtime', lastKnownStatus: 'idle' },
  runs: [],
  updatedAt: 1
})

describe('brand migration omission regressions', () => {
  it('rechecks an unbundled database on resume while keeping rollback available', async () => {
    const f = await fixture()
    database(f.config, 'ManagedFileVersionWriteOperation').close()
    await expect(
      runMigration(
        { ...f.options, execute: true },
        {
          onProgress(event: { phase: string }) {
            if (event.phase === 'copied') throw new Error('interrupted copy')
          }
        }
      )
    ).rejects.toThrow('interrupted copy')
    const db = database(f.config)
    writeOperation(db, 'staging')
    db.close()
    await expect(runMigration({ ...f.options, resume: true })).rejects.toThrow(
      'Unfinished ManagedFileVersionWriteOperation'
    )
    expect((await runMigration({ ...f.options, rollback: true })).status).toBe('rolled-back')
    expect(await readFile(join(f.old, 'uploads/paper.txt'), 'utf8')).toBe('research\n')
    const restored = database(f.config)
    expect(
      restored.prepare('SELECT operationId,state FROM ManagedFileVersionWriteOperation').get()
    ).toEqual({ operationId: 'operation-id', state: 'staging' })
    restored.close()
  })
  it.each(['published', 'conflict', 'failed'])(
    'accepts the real file-write terminal state %s and restores its record on rollback',
    async (state) => {
      const f = await fixture()
      const db = database(f.config, 'ManagedFileVersionWriteOperation', 'GrantedLocalRoot')
      writeOperation(db, state)
      grant(db, f.old)
      const record = db.prepare('SELECT * FROM ManagedFileVersionWriteOperation').get()
      db.close()
      expect((await runMigration({ ...f.options, execute: true })).status).toBe('committed')
      const after = database(f.config)
      expect(after.prepare('SELECT * FROM ManagedFileVersionWriteOperation').get()).toEqual(record)
      expect(after.prepare('SELECT id,path FROM GrantedLocalRoot').get()).toEqual({
        id: 'root-id',
        path: f.next
      })
      after.close()
      expect((await runMigration({ ...f.options, rollback: true })).status).toBe('rolled-back')
      const restored = database(f.config)
      expect(restored.prepare('SELECT * FROM ManagedFileVersionWriteOperation').get()).toEqual(
        record
      )
      expect(restored.prepare('SELECT path FROM GrantedLocalRoot').get()).toEqual({ path: f.old })
      restored.close()
    }
  )

  it.each(['staging', 'file_ready'])(
    'blocks pending %s even when the stationary database has no changed paths',
    async (state) => {
      const f = await fixture()
      const db = database(f.config, 'ManagedFileVersionWriteOperation')
      writeOperation(db, state)
      db.close()
      const before = await readFile(join(f.config, 'open-science.db'))
      await expect(runMigration({ ...f.options, execute: true })).rejects.toThrow(
        'Unfinished ManagedFileVersionWriteOperation'
      )
      expect(await readFile(join(f.config, 'open-science.db'))).toEqual(before)
      expect((await lstat(f.old)).isSymbolicLink()).toBe(false)
      await expect(lstat(f.next)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['notebook', 'tasks', 'runtime'])(
    'preflights unchanged stationary %s documents',
    async (kind) => {
      const f = await fixture()
      const file = join(
        f.config,
        kind === 'notebook'
          ? 'notebooks/p/s/run.json'
          : kind === 'tasks'
            ? 'task-runs.json'
            : 'runtime/operation-journal.json'
      )
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        JSON.stringify(
          kind === 'runtime'
            ? [{ id: 'pending' }]
            : { ...notebook('$DATA'), runs: [{ status: 'running' }] }
        )
      )
      await expect(runMigration({ ...f.options, execute: true })).rejects.toThrow(
        /Unfinished|Pending/
      )
      expect((await lstat(f.old)).isSymbolicLink()).toBe(false)
    }
  )

  it.each(['path', 'file-url'])(
    'migrates a native Unicode-equivalent SQLite %s and audits reintroduced references',
    async (kind, ctx) => {
      const f = await fixture(true)
      const alternate = f.old.normalize('NFD')
      const actual = await stat(f.old),
        alternateStat = await stat(alternate).catch(() => undefined)
      if (!alternateStat || actual.ino !== alternateStat.ino || actual.dev !== alternateStat.dev)
        return ctx.skip()
      const oldFile = join(alternate, 'uploads/paper.txt')
      const newFile = join(f.next, 'uploads/paper.txt')
      const asValue = (path: string): string =>
        kind === 'file-url' ? pathToFileURL(path).href : path
      const db = database(f.config, 'GrantedLocalRoot')
      grant(db, asValue(oldFile))
      db.close()
      const journal = await runMigration({ ...f.options, execute: true })
      const after = database(f.config)
      expect(after.prepare('SELECT id,path FROM GrantedLocalRoot').get()).toEqual({
        id: 'root-id',
        path: asValue(newFile)
      })
      after.prepare('UPDATE GrantedLocalRoot SET path=?').run(asValue(oldFile))
      after.close()
      expect((await auditAliases(journal, inventory)).blockers).toContainEqual(
        expect.objectContaining({ reason: 'GrantedLocalRoot.path' })
      )
      await expect(runMigration({ ...f.options, retireAliases: true })).rejects.toThrow(
        'Alias retirement blocked'
      )
      const repaired = database(f.config)
      repaired.prepare('UPDATE GrantedLocalRoot SET path=?').run(asValue(newFile))
      repaired.close()
      await runMigration({ ...f.options, retireAliases: true })
      expect(await readFile(newFile, 'utf8')).toBe('research\n')
      await expect(stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('does not equate unverifiable Unicode spellings or similar root prefixes', async () => {
    const f = await fixture(true)
    const maps = [{ from: f.old, to: f.next }]
    const similar = `${f.old.normalize('NFD')}-other/paper.txt`
    expect(remapPath(similar, maps)).toBe(similar)
    const missing = join(f.home, 'absent', 'caf\u00e9', 'OpenScience')
    expect(remapPath(missing.normalize('NFD'), [{ from: missing, to: `${missing}-new` }])).toBe(
      missing.normalize('NFD')
    )
  })

  it('blocks retirement of a Unicode-equivalent executable prefix', async (ctx) => {
    const f = await fixture(true)
    if (
      (await stat(f.old.normalize('NFD')).catch(() => undefined))?.ino !== (await stat(f.old)).ino
    )
      return ctx.skip()
    const journal = await runMigration({ ...f.options, execute: true })
    const file = join(f.next, 'launcher.sh')
    await writeFile(file, `#!${f.old.normalize('NFD')}/bin/python\n`)
    expect((await auditAliases(journal, inventory)).blockers).toContainEqual({
      path: file,
      reason: 'remaining-path-reference'
    })
  })

  it.each(['python', 'r'])(
    'keeps %s runtime identity and blocks alias retirement until explicit rebinding',
    async (language) => {
      const f = await fixture()
      const interpreter = join(f.old, 'custom-env', 'bin', language)
      const newInterpreter = join(f.next, 'custom-env', 'bin', language)
      await mkdir(dirname(interpreter), { recursive: true })
      await writeFile(interpreter, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const relative = 'notebooks/p/s/run.json'
      const binding = {
        language,
        source: 'external',
        provenance: 'user-own',
        runtimeId: interpreter,
        interpreterPath: interpreter,
        label: 'Research runtime',
        status: 'active'
      }
      const document = { ...notebook('$DATA'), runtimeBindings: { [language]: binding } }
      await mkdir(dirname(join(f.old, relative)), { recursive: true })
      await writeFile(join(f.old, relative), JSON.stringify(document))
      const journal = await runMigration({ ...f.options, execute: true })
      const file = join(f.next, relative)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(document)
      expect((await auditAliases(journal, inventory)).blockers).toContainEqual({
        path: file,
        reason: 'notebook-runtime-binding-needs-rebind'
      })
      await expect(runMigration({ ...f.options, retireAliases: true })).rejects.toThrow(
        'Alias retirement blocked'
      )
      expect(await readFile(interpreter, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
      // Simulate the runtime owner's explicit rebinding; migration must never invent this authorization.
      await writeFile(
        file,
        JSON.stringify({
          ...document,
          runtimeBindings: {
            [language]: { ...binding, runtimeId: newInterpreter, interpreterPath: newInterpreter }
          }
        })
      )
      await runMigration({ ...f.options, retireAliases: true })
      expect(await readFile(newInterpreter, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    }
  )

  it('migrates frame Notebook references and preserves history through rollback', async () => {
    const f = await fixture()
    const relative = 'notebooks/p/s/frames/child/run.json'
    const document = {
      ...notebook(f.old),
      runs: [
        {
          id: 'run-id',
          status: 'completed',
          code: f.old,
          cwdBefore: f.old,
          cwdAfter: f.old,
          workingFiles: [],
          artifacts: []
        }
      ]
    }
    await mkdir(dirname(join(f.old, relative)), { recursive: true })
    await writeFile(join(f.old, relative), JSON.stringify(document))
    const journal = await runMigration({ ...f.options, execute: true })
    expect(JSON.parse(await readFile(join(f.next, relative), 'utf8'))).toMatchObject({
      dataRoot: f.next,
      runs: [{ id: 'run-id', code: f.old, cwdBefore: f.next, cwdAfter: f.next }]
    })
    expect((await auditAliases(journal, inventory)).blockers).toEqual([])
    await runMigration({ ...f.options, rollback: true })
    expect(JSON.parse(await readFile(join(f.old, relative), 'utf8'))).toEqual(document)
  })

  it('blocks an unfinished frame Notebook even when its paths already use $DATA', async () => {
    const f = await fixture()
    const file = join(f.old, 'notebooks/p/s/frames/child/run.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({ ...notebook('$DATA'), runs: [{ id: 'run-id', status: 'running' }] })
    )
    await expect(runMigration({ ...f.options, execute: true })).rejects.toThrow(
      'Unfinished Notebook run'
    )
  })
})

import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { remapPath } from './paths.mjs'

const list = (v) => (Array.isArray(v) ? v : [])
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const active = (v) =>
  ['queued', 'running', 'admitted', 'pending', 'in_progress', 'dispatching'].includes(v)

// These are schema-aware adapters, not a recursive replacement of arbitrary user JSON.
export function transformDocument(value, kind, mappings, platform, scanning = false) {
  const v = structuredClone(value)
  const path = (o, key) => {
    if (object(o) && typeof o[key] === 'string') o[key] = remapPath(o[key], mappings, platform)
  }
  const artifact = (a) => {
    const old = a.path
    path(a, 'path')
    if (a.path !== old && a.fileUrl)
      a.fileUrl = pathToFileURL(a.path, { windows: platform === 'win32' }).href
  }
  if (kind === 'settings') {
    path(v, 'dataRoot')
    path(v.claude, 'resolvedPath')
    path(v.codex, 'resolvedPath')
    path(v.codex, 'nativePath')
    path(v, 'opencodePath')
    path(v, 'codebuddyPath')
    for (const lang of ['python', 'r']) {
      const interpreters = v.notebookManualInterpreters?.[lang]
      if (Array.isArray(interpreters))
        v.notebookManualInterpreters[lang] = interpreters.map((p) =>
          remapPath(p, mappings, platform)
        )
      const enabled = v.notebookRuntimeEnablement?.[lang]?.enabled
      // A move must never turn a disabled runtime back on or carry installation authorization to a new ID.
      if (object(enabled))
        for (const [key, flag] of Object.entries(enabled)) {
          const next = remapPath(key, mappings, platform)
          if (next !== key && flag === false) enabled[next] = false
        }
    }
    list(v.grantedLocalRoots).forEach((r) => path(r, 'path'))
  } else if (kind === 'session') {
    path(v, 'cwd')
    list(v.artifacts).forEach(artifact)
    for (const message of [...list(v.messages), ...list(v.conversationGraph?.messages)]) {
      list(message.uploads).forEach((u) => path(u, 'path'))
      list(message.parts)
        .filter((p) => p.type === 'artifact')
        .forEach(artifact)
    }
  } else if (kind === 'notebook') {
    if (!scanning && list(v.runs).some((r) => active(r.status)))
      throw new Error('Unfinished Notebook run blocks migration')
    for (const key of ['workspaceCwd', 'notebookSessionRoot', 'dataRoot']) path(v, key)
    path(v.kernel, 'runtimeRoot')
    path(v.kernel, 'pythonPath')
    for (const run of list(v.runs)) {
      path(run, 'cwdBefore')
      path(run, 'cwdAfter')
      list(run.workingFiles).forEach((f) => path(f, 'path'))
      list(run.artifacts).forEach(artifact)
    }
  } else if (kind === 'tasks') {
    if (!scanning && list(v.runs).some((r) => active(r.status)))
      throw new Error('Unfinished task run blocks migration')
    for (const run of list(v.runs)) {
      path(run, 'cwd')
      list(run.artifacts).forEach(artifact)
    }
  } else if (kind === 'runtime-operations') {
    if (!Array.isArray(v) || v.length)
      throw new Error('Pending or corrupt runtime journal blocks migration')
  }
  return v
}

export function documentKind(relative) {
  const p = relative.replaceAll('\\', '/')
  if (p === 'settings.json') return 'settings'
  if (/^sessions\/[^/]+\/[^/]+\.json$/.test(p)) return 'session'
  if (/^notebooks\/[^/]+\/[^/]+\/run\.json$/.test(p)) return 'notebook'
  if (p === 'task-runs.json') return 'tasks'
  if (p === 'runtime/operation-journal.json') return 'runtime-operations'
}

export async function rewriteDocuments(root, manifest, mappings, platform) {
  const changed = []
  for (const entry of manifest) {
    if (entry.type !== 'file') continue
    const kind = documentKind(entry.path)
    if (!kind) continue
    const file = join(root, entry.path)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Reference document must be a single-link regular file: ${file}`)
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const next = transformDocument(parsed, kind, mappings, platform)
    if (JSON.stringify(next) !== JSON.stringify(parsed)) {
      await writeFile(file, JSON.stringify(next, null, 2) + '\n')
      changed.push(entry.path)
    }
  }
  return changed
}

// Work on an offline staged database. The original complete DB/WAL bundle is preserved as backup.
// Keep every record ID, relative content key, checksum, user text and immutable snapshot unchanged.
export function rewriteDatabase(
  file,
  mappings,
  platform,
  onProgress = () => {},
  protection,
  readOnly = false
) {
  const db = new DatabaseSync(file, { readOnly })
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name)
  )
  const report = { tables: tables.size, changed: [], transitions: [], protectedValidated: [] }
  const columns = (table) =>
    new Set(
      db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((r) => r.name)
    )
  const update = (table, key, column, adapt) => {
    if (!tables.has(table) || !columns(table).has(column)) return
    for (const row of db
      .prepare(`SELECT "${key}" AS identity, "${column}" AS value FROM "${table}"`)
      .all()) {
      if (row.value === null) continue
      const next = adapt(row.value, row.identity)
      if (next === row.value) continue
      if (!readOnly)
        db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE "${key}"=?`).run(next, row.identity)
      report.changed.push({ table, column, id: row.identity })
    }
  }
  try {
    if (
      db
        .prepare('PRAGMA integrity_check')
        .all()
        .some((r) => r.integrity_check !== 'ok')
    )
      throw new Error('Database integrity check failed')
    if (!readOnly) db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
    for (const [table, column] of [
      ['ManagedFileVersionWriteOperation', 'state'],
      ['ComputeJobOperation', 'phase']
    ]) {
      if (!readOnly && tables.has(table) && columns(table).has(column)) {
        const values = db.prepare(`SELECT "${column}" AS state FROM "${table}"`).all()
        if (
          values.some(
            (r) =>
              !['committed', 'completed', 'settled', 'failed', 'aborted', 'cancelled'].includes(
                r.state
              )
          )
        )
          throw new Error(`Unfinished ${table} blocks migration`)
      }
    }
    update('GrantedLocalRoot', 'id', 'path', (v) => remapPath(v, mappings, platform))
    update('ProjectPreviewState', 'projectId', 'items', (raw) => {
      const items = JSON.parse(raw)
      for (const item of list(items))
        if (item.type === 'file' || item.kind === 'file' || typeof item.path === 'string')
          item.path = remapPath(item.path, mappings, platform)
      return JSON.stringify(items) === JSON.stringify(JSON.parse(raw)) ? raw : JSON.stringify(items)
    })
    update('ComputeHost', 'id', 'sshOverrides', (raw) => {
      const value = JSON.parse(raw)
      if (!object(value) || !value.identityFile) return raw
      const next = remapPath(value.identityFile, mappings, platform)
      return next === value.identityFile ? raw : JSON.stringify({ ...value, identityFile: next })
    })
    update('ComputeJob', 'id', 'inputManifest', (raw, id) => {
      let value = JSON.parse(raw)
      const encrypted =
        Array.isArray(value) &&
        value.length === 2 &&
        value[0] === 'open-science:protected-json:v1' &&
        typeof value[1] === 'string'
      if (encrypted) {
        if (!protection) {
          report.transitions.push(
            'Encrypted ComputeJob inputManifest requires application reconciliation'
          )
          return raw
        }
        value = JSON.parse(protection.decrypt(raw))
      }
      if (!Array.isArray(value)) throw new Error('Invalid ComputeJob inputManifest')
      let changed = false
      for (const item of value)
        if (item.kind === 'upload') {
          const next = remapPath(item.localPath, mappings, platform)
          if (next !== item.localPath) {
            item.localPath = next
            changed = true
          }
        }
      const next = changed
        ? encrypted
          ? protection.encrypt(JSON.stringify(value))
          : JSON.stringify(value)
        : raw
      if (encrypted && protection)
        report.protectedValidated.push({
          id,
          sha256: createHash('sha256').update(next).digest('hex')
        })
      return next
    })
    // Session IDs, fingerprints and projection associations are not path fields.
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Database foreign-key check failed')
    onProgress({ phase: 'database-before-commit' })
    if (!readOnly) db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
    return report
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw e
  } finally {
    db.close()
  }
}

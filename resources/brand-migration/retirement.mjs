import { createHash } from 'node:crypto'
import { documentKind, transformDocument } from './references.mjs'
import { createReadStream } from 'node:fs'
import { readFile, readlink, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { inside, inspect, remapPath } from './paths.mjs'

async function mentions(file, needles) {
  const longest = Math.max(...needles.map((n) => n.length))
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.concat([tail, chunk])
    if (needles.some((n) => buffer.includes(n))) return true
    tail = buffer.subarray(Math.max(0, buffer.length - longest))
  }
  return false
}

// Retirement is a separate, fail-closed operation after environment rebuilding and third-party
// reconciliation. It never edits user programs, ciphertext, binary prefixes or historical evidence.
export async function auditAliases(journal, inventory) {
  if (journal.status !== 'committed')
    throw new Error('Alias retirement requires a committed migration')
  const maps = journal.mappings.filter((m) => m.state === 'move' || m.aliasRequired)
  const variants = maps.flatMap((m) => [m.from, ...(m.fromAliases ?? [])])
  const blockers = []
  const roots = [
    ...new Set([...journal.participants.map((p) => p.to), ...journal.mappings.map((m) => m.to)])
  ]
  for (const root of roots) {
    const p = { to: root }
    const entries = await inventory(p.to)
    const needles = variants
      .flatMap((from) => [
        from,
        from.replaceAll('\\', '/'),
        pathToFileURL(from, { windows: journal.platform === 'win32' }).href,
        JSON.stringify(from).slice(1, -1)
      ])
      .flatMap((s) => [Buffer.from(s), Buffer.from(s, 'utf16le')])
    if (!needles.length) continue
    for (const e of entries) {
      const file = join(p.to, e.path)
      if (e.type === 'symlink') {
        const target = await readlink(file)
        if (variants.some((from) => inside(from, resolve(dirname(file), target), journal.platform)))
          blockers.push({ path: file, reason: 'symlink-target' })
      } else if (e.type === 'file' && /^open-science\.db(?:-wal|-shm)?$/.test(e.path)) {
        // Inspect live columns below, not deleted pages, immutable evidence or user prose.
        continue
      } else if (
        e.type === 'file' &&
        ['session', 'notebook', 'tasks'].includes(documentKind(e.path))
      ) {
        const value = JSON.parse(await readFile(file, 'utf8'))
        if (
          JSON.stringify(transformDocument(value, documentKind(e.path), maps, journal.platform)) !==
          JSON.stringify(value)
        )
          blockers.push({ path: file, reason: 'unmigrated-document-reference' })
      } else if (e.type === 'file' && documentKind(e.path) === 'settings') {
        const settings = JSON.parse(await readFile(file, 'utf8'))
        // These maps are runtime identity policy, not executable paths. Installation grants are
        // intentionally not inherited; disabled new IDs were copied during reference migration.
        delete settings.notebookRuntimeEnablement
        if (needles.some((n) => Buffer.from(JSON.stringify(settings)).includes(n)))
          blockers.push({ path: file, reason: 'remaining-settings-reference' })
      } else if (e.type === 'file' && (await mentions(file, needles))) {
        blockers.push({ path: file, reason: 'remaining-path-reference' })
      }
    }
    const dbPath = join(p.to, 'open-science.db')
    if (await inspect(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const tables = new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name)
        )
        for (const [table, column] of [
          ['GrantedLocalRoot', 'path'],
          ['ProjectPreviewState', 'items'],
          ['ComputeHost', 'sshOverrides'],
          ['ComputeJob', 'inputManifest']
        ]) {
          if (!tables.has(table)) continue
          for (const row of db.prepare(`SELECT "${column}" AS value FROM "${table}"`).all()) {
            if (!row.value) continue
            const value = table === 'GrantedLocalRoot' ? row.value : JSON.parse(row.value)
            const encrypted =
              table === 'ComputeJob' &&
              Array.isArray(value) &&
              value[0] === 'open-science:protected-json:v1'
            if (encrypted) {
              const sha256 = createHash('sha256').update(row.value).digest('hex')
              if (!journal.database?.protectedValidated?.some((r) => r.sha256 === sha256))
                blockers.push({
                  path: dbPath,
                  reason: 'encrypted-reference-needs-application-reconciliation'
                })
              continue
            }
            const paths =
              table === 'GrantedLocalRoot'
                ? [value]
                : table === 'ComputeHost'
                  ? [value.identityFile]
                  : table === 'ProjectPreviewState'
                    ? value.map((v) => v.path)
                    : value.filter((v) => v.kind === 'upload').map((v) => v.localPath)
            if (paths.some((v) => remapPath(v, maps, journal.platform) !== v))
              blockers.push({ path: dbPath, reason: `${table}.${column}` })
          }
        }
      } finally {
        db.close()
      }
    }
  }
  return { blockers, aliases: maps.map((m) => ({ from: m.from, to: m.to })) }
}
export async function removeAuditedAliases(journal, inventory) {
  const audit = await auditAliases(journal, inventory)
  if (audit.blockers.length)
    throw new Error(`Alias retirement blocked: ${JSON.stringify(audit.blockers)}`)
  // Validate every alias before removing any. Unknown links or replacement directories are conflicts.
  for (const m of audit.aliases) {
    const s = await inspect(m.from)
    if (s && (!s.isSymbolicLink() || resolve(await readlink(m.from)) !== resolve(m.to)))
      throw new Error(`Alias ownership conflict: ${m.from}`)
  }
  for (const m of [...audit.aliases].sort((a, b) => b.from.length - a.from.length))
    if (await inspect(m.from)) await rm(m.from)
  return audit
}

// Only installed runtime / launcher locations can need a prefix alias in an adopted new tree.
// User documents are not scanned or rewritten for this decision.
export async function needsRuntimeAlias(map) {
  const variants = [map.from, ...(map.fromAliases ?? [])]
  const needles = variants
    .flatMap((from) => [from, from.replaceAll('\\', '/'), pathToFileURL(from).href])
    .flatMap((s) => [Buffer.from(s), Buffer.from(s, 'utf16le')])
  async function visit(path) {
    const stat = await inspect(path)
    if (!stat) return false
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path))
      return variants.some((from) => inside(from, target))
    }
    if (stat.isFile()) return mentions(path, needles)
    if (!stat.isDirectory()) throw new Error(`Unsupported runtime node: ${path}`)
    for (const name of await readdir(path)) if (await visit(join(path, name))) return true
    return false
  }
  const roots = ['tools', 'sandbox', 'working-cache'].includes(map.kind)
    ? [map.to]
    : ['runtime', 'bin'].map((name) => join(map.to, name))
  for (const root of roots) if (await visit(root)) return true
  return false
}

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { documentKind, transformDocument } from './references.mjs'
import { createReadStream } from 'node:fs'
import { readFile, readlink, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve, win32 } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { inside, inspect, remapPath } from './paths.mjs'

// Scan executable/opaque state conservatively, but verify any alternate-case root against
// the filesystem just as structured-reference migration does. Similar prefixes are not roots.
function referenceNeedles(variants, platform) {
  return variants.flatMap((from) => [
    { from, text: from, decode: (s) => s },
    { from, text: from.replaceAll('\\', '/'), decode: (s) => s },
    {
      from,
      text: pathToFileURL(from, { windows: platform === 'win32' }).href,
      decode: (s) => fileURLToPath(s, { windows: platform === 'win32' })
    },
    { from, text: JSON.stringify(from).slice(1, -1), decode: (s) => JSON.parse(`"${s}"`) }
  ])
}
function containsReference(buffer, needles, platform, complete = true) {
  for (const text of [
    buffer.toString('utf8'),
    buffer.toString('utf16le'),
    buffer.subarray(1).toString('utf16le')
  ]) {
    const folded = text.toLowerCase()
    for (const needle of needles) {
      let offset = -1
      while ((offset = folded.indexOf(needle.text.toLowerCase(), offset + 1)) !== -1) {
        const end = offset + needle.text.length
        if (end === text.length && !complete) continue
        if (end < text.length && /[\p{L}\p{N}._-]/u.test(text[end])) continue
        const candidate = needle.decode(text.slice(offset, end))
        if (inside(needle.from, candidate, platform)) return true
      }
    }
  }
  return false
}
async function mentions(file, needles, platform) {
  const longest = Math.max(...needles.map((n) => Buffer.byteLength(n.text) * 2)) + 4
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.concat([tail, chunk])
    if (containsReference(buffer, needles, platform, false)) return true
    // An even byte offset preserves UTF-16 alignment across stream chunks.
    const start = Math.max(0, buffer.length - longest)
    tail = buffer.subarray(start - (start % 2))
  }
  return containsReference(tail, needles, platform)
}

// Retirement is a separate, fail-closed operation after environment rebuilding and third-party
// reconciliation. It never edits user programs, ciphertext, binary prefixes or historical evidence.
function windowsEnvironmentPaths() {
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
@('User', 'Machine') | ForEach-Object {
  $value = [Environment]::GetEnvironmentVariable('Path', $_)
  @{ scope = $_; value = [Environment]::ExpandEnvironmentVariables([string]$value) }
} | ConvertTo-Json -Compress`
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  )
  return JSON.parse(raw)
}

export async function auditAliases(
  journal,
  inventory,
  readEnvironmentPaths = windowsEnvironmentPaths
) {
  if (journal.status !== 'committed')
    throw new Error('Alias retirement requires a committed migration')
  const maps = journal.mappings.filter((m) => m.state === 'move' || m.aliasRequired)
  const variants = maps.flatMap((m) => [m.from, ...(m.fromAliases ?? [])])
  const blockers = []
  if (journal.platform === 'win32' && variants.length) {
    for (const { scope, value } of readEnvironmentPaths()) {
      for (const entry of value
        .split(';')
        .map((p) => p.trim().replace(/^"|"$/g, ''))
        .filter(Boolean)) {
        if (/%[^%]+%/.test(entry))
          throw new Error(
            `Unresolved environment variable in ${scope} PATH; resolve it before alias retirement`
          )
        if (win32.isAbsolute(entry) && variants.some((from) => inside(from, entry, 'win32')))
          blockers.push({ path: entry, reason: `${scope}-PATH-reference` })
      }
    }
  }
  const roots = [
    ...new Set(
      [
        journal.configRoot,
        ...journal.participants.map((p) => p.to),
        ...journal.mappings.map((m) => m.to)
      ].filter(Boolean)
    )
  ]
  for (const root of roots) {
    if (!(await inspect(root))) continue
    const p = { to: root }
    const entries = await inventory(p.to)
    const needles = referenceNeedles(variants, journal.platform)
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
        if (containsReference(Buffer.from(JSON.stringify(settings)), needles, journal.platform))
          blockers.push({ path: file, reason: 'remaining-settings-reference' })
      } else if (e.type === 'file' && (await mentions(file, needles, journal.platform))) {
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
  const needles = referenceNeedles(variants, process.platform)
  async function visit(path) {
    const stat = await inspect(path)
    if (!stat) return false
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), await readlink(path))
      return variants.some((from) => inside(from, target))
    }
    if (stat.isFile()) return mentions(path, needles, process.platform)
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

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  statfs,
  symlink
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { metadataDigest } from './metadata.mjs'
import {
  changedReferenceFiles,
  bundleInventory,
  copyBundle,
  publishBundle,
  verifyBundleRollback,
  rollbackBundle
} from './reference-bundle.mjs'
import { validateJournal } from './journal.mjs'
import { auditAliases, removeAuditedAliases, needsRuntimeAlias } from './retirement.mjs'
import { discover, inside, inspect, readJson, assertPlainAncestors } from './paths.mjs'
import {
  documentKind,
  rewriteDatabase,
  rewriteDocuments,
  transformDocument
} from './references.mjs'

export async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
export async function syncTree(root, entries) {
  for (const entry of entries)
    if (entry.type === 'file') {
      const handle = await open(join(root, entry.path), process.platform === 'win32' ? 'r+' : 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  for (const entry of [...entries].reverse())
    if (entry.type === 'directory') await syncDirectory(join(root, entry.path))
}
const missing = (error) => error.code === 'ENOENT'
async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// Never follow nested symlinks. Their targets, directory layout, mode, timestamp and every file's
// bytes are inventoried; special nodes are refused because they cannot be safely snapshotted.
export async function inventory(root) {
  const entries = []
  const hardlinks = new Map()
  async function visit(path) {
    const full = join(root, path)
    const s = await lstat(full)
    const base = {
      path,
      mode: s.mode & 0o7777,
      uid: s.uid,
      gid: s.gid,
      mtimeMs: Math.trunc(s.mtimeMs)
    }
    if (s.isSymbolicLink()) entries.push({ ...base, type: 'symlink', target: await readlink(full) })
    else if (s.isDirectory()) {
      entries.push({ ...base, type: 'directory' })
      for (const name of (await readdir(full)).sort()) await visit(join(path, name))
    } else if (s.isFile()) {
      const key = `${s.dev}:${s.ino}`
      const first = hardlinks.get(key) ?? path
      hardlinks.set(key, first)
      entries.push({
        ...base,
        type: 'file',
        hardlink: first,
        size: s.size,
        sha256: await digest(full)
      })
    } else throw new Error(`Unsupported special file blocks migration: ${full}`)
  }
  await visit('')
  entries[0].metadata = metadataDigest(root)
  return entries
}
const signature = (entries) =>
  JSON.stringify(
    entries.map(({ mtimeMs, ...entry }) => ({
      ...entry,
      ...(entry.type === 'file' ? { mtimeMs } : {})
    }))
  )
export async function verify(root, expected, participant) {
  const actual = participant?.files
    ? await bundleInventory(root, participant.files, inventory)
    : await inventory(root)
  if (signature(actual) !== signature(expected))
    throw new Error(`Integrity mismatch or new writes at ${root}`)
}
export async function durableJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
  // Directory fsync makes the rename durable on POSIX. Windows does not open directories this way.
  if (process.platform !== 'win32') {
    const dir = await open(dirname(file), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}

// An abandoned lock is never silently stolen. The explicit recovery command verifies its PID is
// dead; a separate recovery directory serializes competing recovery attempts.
async function lock(
  stateDir,
  recover,
  ownerPid = process.pid,
  ownerKind = 'offline',
  profile = {}
) {
  await assertPlainAncestors(stateDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, 'lock')
  const token = randomUUID()
  async function acquire() {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(
        JSON.stringify({ pid: ownerPid, workerPid: process.pid, token, ownerKind: 'transaction' })
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  try {
    await acquire()
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    if (!recover)
      throw new Error(
        `Migration lock exists; stop the owner or use --recover-lock after a crash: ${path}`
      )
    const recovery = join(stateDir, 'lock-recovery')
    await mkdir(recovery)
    try {
      const owner = await readJson(path)
      if (alive(owner.pid) || (owner.workerPid && alive(owner.workerPid)))
        throw new Error(`Migration lock owner is active: ${owner.pid}`)
      await rm(path)
      await acquire()
    } finally {
      await rm(recovery, { recursive: true })
    }
  }
  const release = async () => {
    const owner = await readJson(path)
    if (owner.token !== token) throw new Error('Migration lock identity changed')
    await rm(path)
  }
  const handoff = async (userData) => {
    if (ownerKind !== 'application') return
    await durableJson(path, {
      pid: ownerPid,
      token,
      ownerKind: 'application',
      ...profile,
      userData
    })
  }
  return { release, handoff, lease: { path, token } }
}

export function assertNoProcesses(roots, ignoredPids = []) {
  const ignore = new Set([process.pid, process.ppid, ...ignoredPids])
  let rows
  if (process.platform === 'win32') {
    const raw = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,Name,CommandLine | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    rows = [JSON.parse(raw)]
      .flat()
      .map((r) => [r.ProcessId, r.CommandLine ?? '', r.ExecutablePath ?? r.Name ?? ''])
  } else {
    const executables = new Map(
      execFileSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
        .split('\n')
        .flatMap((line) => {
          const match = line.trim().match(/^(\d+)\s+(.*)$/)
          return match ? [[Number(match[1]), match[2]]] : []
        })
    )
    rows = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/)
        return match
          ? [Number(match[1]), match[2], executables.get(Number(match[1])) ?? '']
          : [0, '', '']
      })
  }
  for (const [pid, command, executable] of rows) {
    if (ignore.has(pid)) continue
    const normalized =
      process.platform === 'win32' ? command.toLowerCase().replaceAll('\\', '/') : command
    const usingRoot = roots.some((root) =>
      normalized.includes(
        process.platform === 'win32' ? root.toLowerCase().replaceAll('\\', '/') : root
      )
    )
    // A repository name in another program's arguments is not an app process.
    const appExecutable =
      /(?:^|[/\\])Open[ -]?Science(?:-DEV| \(DEV\))?(?:\.app[/\\]|(?:\.exe)?$)/i.test(executable)
    if (usingRoot || appExecutable)
      throw new Error(
        `Application or child process is using migration paths (PID ${pid}); close it first`
      )
  }
}

async function inspectDocuments(root, entries, plan) {
  for (const entry of entries) {
    if (
      entry.type === 'symlink' &&
      (documentKind(entry.path) || /^open-science\.db(?:-wal|-shm)?$/.test(entry.path))
    )
      throw new Error(`Reference or database symlink blocks migration: ${entry.path}`)
    if (entry.type !== 'file') continue
    const name = entry.path.replaceAll('\\', '/')
    if (
      /\.pending$|\.recovering$|\.migration-in-progress$|(?:^|\/)\.open-science-migration\.json$|(?:^|\/)\.open-science-path-pending$/.test(
        name
      )
    )
      throw new Error(`Pending recovery blocks migration: ${name}`)
    const kind = documentKind(entry.path)
    if (kind && (await lstat(join(root, entry.path))).nlink !== 1)
      throw new Error(`Reference document has multiple hardlinks: ${entry.path}`)
    if (kind)
      transformDocument(await readJson(join(root, entry.path)), kind, plan.mappings, plan.platform)
  }
}
export async function copyTree(from, to) {
  // Native copying preserves ACLs, extended attributes and hardlinks in addition to portable metadata.
  // No shell interpolation; all paths are separate argv. Source roots have already passed symlink checks.
  if (process.platform === 'darwin')
    execFileSync('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', from, to])
  else if (process.platform === 'linux') {
    if ((await lstat(from)).isDirectory()) {
      await mkdir(to)
      execFileSync('cp', ['-a', '--', `${from}/.`, to])
    } else execFileSync('cp', ['-a', '--', from, to])
  } else {
    const directory = (await lstat(from)).isDirectory()
    const result = (() => {
      try {
        execFileSync(
          'robocopy.exe',
          [
            ...(directory
              ? [from, to, '/E']
              : [dirname(from), dirname(to), relative(dirname(from), from)]),
            '/COPY:DATS',
            '/DCOPY:DAT',
            '/SL',
            '/SJ',
            '/R:0',
            '/W:0',
            '/NFL',
            '/NDL',
            '/NJH',
            '/NJS'
          ],
          { windowsHide: true }
        )
        return 0
      } catch (e) {
        return e.status ?? 16
      }
    })()
    if (result >= 8) throw new Error(`Copy failed (robocopy ${result})`)
  }
}

export async function planMigration(options) {
  const plan = await discover(options)
  await assertPlainAncestors(plan.stateDir)
  const journalPath = join(plan.stateDir, 'journal.json')
  if (await inspect(journalPath)) {
    const journal = await readJson(journalPath)
    await validateJournal(journal, plan, journalPath)
    return { ...plan, journal, status: journal.status, blockers: [] }
  }
  const mappings = []
  const blockers = []
  for (const map of plan.mappings) {
    await assertPlainAncestors(map.from)
    await assertPlainAncestors(map.to)
    const old = await inspect(map.from)
    const next = await inspect(map.to)
    if (old && next) blockers.push(`Path conflict: both ${map.from} and ${map.to} exist`)
    if (map.from !== map.to && (inside(map.from, map.to) || inside(map.to, map.from)))
      blockers.push(`Overlapping migration roots: ${map.from}`)
    mappings.push({
      ...map,
      state: old ? (next ? 'conflict' : 'move') : next ? 'use-new' : 'initialize'
    })
  }
  if (mappings.filter((m) => m.kind === 'data' && ['move', 'use-new'].includes(m.state)).length > 1)
    blockers.push('Multiple default data roots require explicit reconciliation')
  for (const parent of mappings)
    for (const child of mappings) {
      if (parent === child) continue
      if (inside(parent.from, child.from) && !inside(parent.to, child.to))
        blockers.push(`Unsupported nested mapping: ${child.from}`)
      if (parent.to === child.to && parent.from !== child.from)
        blockers.push(`Duplicate migration target: ${child.to}`)
    }
  return { ...plan, mappings, status: 'planned', blockers }
}

async function buildJournal(plan) {
  const activeMaps = plan.mappings.filter((m) => m.state === 'move' || m.state === 'use-new')
  if (!activeMaps.length) return undefined
  for (const map of activeMaps)
    if (map.state === 'use-new' && (await needsRuntimeAlias(map))) map.aliasRequired = true
  const id = randomUUID()
  const candidates = activeMaps.map((m) => ({
    from: m.state === 'move' ? m.from : m.to,
    to: m.to,
    stationary: m.state === 'use-new'
  }))
  if (await inspect(plan.configRoot))
    candidates.push({ from: plan.configRoot, to: plan.configRoot, stationary: true })
  const roots = candidates.filter(
    (r, i) =>
      !candidates.some(
        (other, j) =>
          i !== j &&
          (!other.stationary || (r.stationary && other.from === r.from)) &&
          inside(other.from, r.from) &&
          (other.from !== r.from || j < i)
      )
  )
  const participants = []
  const volumeBytes = new Map()
  for (const r of roots) {
    await assertPlainAncestors(r.from)
    await assertPlainAncestors(r.to)
    if (inside(r.from, plan.stateDir) || inside(r.to, plan.stateDir))
      throw new Error('State directory must be outside migrated roots')
    const files = r.stationary
      ? await changedReferenceFiles(r.from, activeMaps, plan.platform)
      : undefined
    if (files && !files.length) continue
    await access(dirname(r.from), constants.W_OK | constants.X_OK)
    await mkdir(dirname(r.to), { recursive: true })
    await access(dirname(r.to), constants.W_OK | constants.X_OK)
    const original = files
      ? await bundleInventory(r.from, files, inventory)
      : await inventory(r.from)
    await inspectDocuments(r.from, original, plan)
    const bytes = original.reduce((sum, e) => sum + (e.size ?? 0), 0)
    const disk = await statfs(dirname(r.to))
    const volume = (await lstat(dirname(r.to))).dev
    const required = (volumeBytes.get(volume) ?? 0) + bytes * 1.1 + 1024 * 1024
    volumeBytes.set(volume, required)
    if (disk.bavail * disk.bsize < required) throw new Error(`Insufficient disk space at ${r.to}`)
    participants.push({
      from: r.from,
      to: r.to,
      ...(files ? { files } : {}),
      stage: `${r.to}.brand-stage-${id}`,
      backup: `${r.from}.brand-backup-${id}`,
      original,
      published: undefined
    })
  }
  return {
    version: 1,
    id,
    home: plan.home,
    configRoot: plan.configRoot,
    platform: plan.platform,
    mappings: activeMaps,
    userData:
      plan.mappings.find((m) => m.kind === 'profile' && ['move', 'use-new'].includes(m.state))
        ?.to ?? plan.userData,
    defaultDataRoot: activeMaps.find((m) => m.kind === 'data')?.to,
    status: 'preparing',
    participants,
    transitions: [
      'Runtime prefixes, encrypted references and third-party state use owned aliases until audited retirement.'
    ],
    createdAt: new Date().toISOString()
  }
}

async function ensureAliases(journal) {
  for (const m of journal.mappings) {
    if (m.state !== 'move' && !m.aliasRequired) continue
    const entry = await inspect(m.from)
    if (entry) {
      if (!entry.isSymbolicLink() || resolve(await readlink(m.from)) !== resolve(m.to))
        throw new Error(`Alias conflict: ${m.from}`)
    } else {
      if (journal.aliasesRetiredAt) continue
      await symlink(m.to, m.from, process.platform === 'win32' ? 'junction' : 'dir')
      await syncDirectory(dirname(m.from))
    }
  }
}

async function publish(journal, save, progress) {
  journal.status = 'publishing'
  await save()
  for (const p of journal.participants) {
    if (p.files) {
      await publishBundle(p, save, progress, inventory, syncDirectory)
      await verify(p.to, p.published, p)
      await progress({ phase: 'root-published', path: p.to })
      continue
    }
    // A saved publishing intent makes either side of each rename recoverable after process death.
    if (!(await inspect(p.backup))) {
      await verify(p.from, p.original)
      await rename(p.from, p.backup)
      await syncDirectory(dirname(p.from))
      await progress({ phase: 'source-backed-up', path: p.from })
    }
    if (await inspect(p.stage)) {
      if (await inspect(p.to)) throw new Error(`Publication conflict: ${p.to}`)
      await rename(p.stage, p.to)
      await syncDirectory(dirname(p.to))
    }
    await verify(p.to, p.published)
    await save()
    await progress({ phase: 'root-published', path: p.to })
  }
  for (const p of journal.participants) await verify(p.backup, p.original, p)
  await ensureAliases(journal)
  journal.status = 'committed'
  journal.committedAt = new Date().toISOString()
  await save()
}

async function prepare(journal, save, progress, copy) {
  for (const p of journal.participants) {
    if (await inspect(p.stage)) await rm(p.stage, { recursive: true })
    await verify(p.from, p.original, p)
    if (p.files) await copyBundle(p, copy, verify, syncDirectory)
    else {
      await copy(p.from, p.stage)
      await verify(p.stage, p.original)
    }
    await progress({ phase: 'copied', path: p.stage })
    // Rename only explicitly mapped nested roots, not similarly named descendants.
    for (const m of journal.mappings.filter(
      (m) => !p.files && m.state === 'move' && m.from !== p.from && inside(p.from, m.from)
    )) {
      const old = join(p.stage, relative(p.from, m.from))
      const next = join(p.stage, relative(p.to, m.to))
      if (await inspect(next)) throw new Error(`Nested target conflict: ${m.to}`)
      await rename(old, next)
      await symlink(m.to, old, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const entries = await inventory(p.stage)
    await rewriteDocuments(p.stage, entries, journal.mappings, journal.platform)
    // Nested data roots have their own notebook/run.json paths relative to that root.
    for (const m of journal.mappings.filter((m) => m.to !== p.to && inside(p.to, m.to))) {
      const nested = join(p.stage, relative(p.to, m.to))
      if (await inspect(nested))
        await rewriteDocuments(nested, await inventory(nested), journal.mappings, journal.platform)
    }
    const db = join(p.stage, relative(p.to, journal.configRoot), 'open-science.db')
    if (inside(p.to, journal.configRoot) && (await inspect(db))) {
      for (const sidecar of [db, `${db}-wal`, `${db}-shm`]) {
        const stat = await inspect(sidecar)
        if (stat && (!stat.isFile() || stat.nlink !== 1))
          throw new Error(`Database must be a single-link regular file: ${sidecar}`)
      }
      const report = rewriteDatabase(db, journal.mappings, journal.platform, (event) =>
        progress(event)
      )
      journal.database = report
      journal.transitions.push(...report.transitions)
    }
    p.published = p.files
      ? await bundleInventory(p.stage, p.files, inventory)
      : await inventory(p.stage)
    await syncTree(p.stage, p.published)
    await progress({ phase: 'references-prepared', path: p.stage })
    await save()
  }
  // Detect source writes during a long cross-filesystem copy before touching any original root.
  for (const p of journal.participants) await verify(p.from, p.original, p)
  journal.status = 'prepared'
  await save()
}

async function rollback(journal, save, progress) {
  // Park nested aliases with their generation. Removing only external aliases leaves each
  // participant's complete committed manifest verifiable across every interrupted rollback step.
  const expected = (p) => p.published
  for (const p of journal.participants) {
    if (p.files) {
      await verifyBundleRollback(p, journal.status, inventory)
      continue
    }
    const backup = await inspect(p.backup)
    const parked = `${p.stage}.rolled-back`
    if (backup) {
      await verify(p.backup, p.original)
      if (await inspect(parked)) await verify(parked, expected(p))
      if (await inspect(p.to)) {
        const entries = await inventory(p.to)
        if (
          signature(entries) !== signature(p.published) &&
          !(journal.status === 'rolling-back' && signature(entries) === signature(expected(p)))
        )
          throw new Error(`Integrity mismatch or new writes at ${p.to}`)
      }
    } else if (journal.status === 'rolling-back' && (await inspect(parked))) {
      await verify(parked, expected(p))
      await verify(p.from, p.original)
    } else {
      if (!['preparing', 'prepared', 'publishing', 'rolling-back'].includes(journal.status))
        throw new Error(`Original backup is missing: ${p.backup}`)
      // A not-yet-published root is recoverable only while its exact original remains.
      await verify(p.from, p.original)
      if (p.from !== p.to && (await inspect(p.to)))
        throw new Error(`Unexpected target without backup: ${p.to}`)
    }
  }
  journal.status = 'rolling-back'
  await save()
  for (const m of journal.mappings) {
    const s = await inspect(m.from)
    if (
      s?.isSymbolicLink() &&
      !journal.participants.some((p) => !p.files && inside(p.to, m.from)) &&
      resolve(await readlink(m.from)) === resolve(m.to)
    ) {
      await rm(m.from)
      await syncDirectory(dirname(m.from))
    }
  }
  await progress({ phase: 'rollback-aliases-removed' })
  for (const p of [...journal.participants].reverse()) {
    if (p.files) {
      await rollbackBundle(p, save, progress, syncDirectory)
      continue
    }
    if (await inspect(p.backup)) {
      if (await inspect(p.to)) {
        if (await inspect(`${p.stage}.rolled-back`))
          throw new Error(`Rollback parking conflict: ${p.to}`)
        await rename(p.to, `${p.stage}.rolled-back`)
        await syncDirectory(dirname(p.to))
      }
      await progress({ phase: 'rollback-root-parked', path: p.to })
      if (await inspect(p.from)) throw new Error(`Rollback source conflict: ${p.from}`)
      await rename(p.backup, p.from)
      await syncDirectory(dirname(p.from))
      p.restored = true
      await save()
      await progress({ phase: 'rollback-root-restored', path: p.from })
    }
  }
  journal.status = 'rolled-back'
  await save()
}

export async function runMigration(options, deps = {}) {
  const progress = deps.onProgress ?? (() => {})
  const plan = await planMigration(options)
  if (options.auditAliases) return auditAliases(plan.journal, inventory)
  if (!options.execute && !options.rollback && !options.resume && !options.retireAliases)
    return plan
  if (options.startupOwner && plan.journal?.status === 'committed') {
    const owner = await readJson(join(plan.stateDir, 'lock')).catch((e) => {
      if (!missing(e)) throw e
    })
    if (owner?.ownerKind === 'application' && alive(owner.pid)) {
      if (
        !options.allowMultiInstance &&
        owner.relayEligible &&
        owner.userData === (options.userData ?? plan.journal.userData ?? plan.userData)
      )
        return { ...plan.journal, relayOnly: true }
      throw new Error('Application lease belongs to another writer or profile')
    }
  }
  const {
    release: unlock,
    handoff,
    lease
  } = await lock(
    plan.stateDir,
    options.recoverLock,
    options.startupOwner,
    options.startupOwner ? 'application' : 'offline',
    { userData: plan.userData, relayEligible: !options.allowMultiInstance }
  )
  let retainLease = false
  const finish = async (value) => {
    value = { ...value, userData: options.userData ?? value.userData ?? plan.userData }
    if (options.startupOwner) {
      await handoff(value.userData)
      retainLease = true
      return { ...value, lease }
    }
    return value
  }
  try {
    let current = await planMigration(options)
    if (current.blockers.length) throw new Error(current.blockers.join('\n'))
    const journalFile = join(plan.stateDir, 'journal.json')
    let journal = current.journal
    if (journal?.status === 'rolled-back' && options.rollback) return journal
    if (journal?.protectedMigration?.status === 'publishing') {
      ;(deps.assertNoProcesses ?? assertNoProcesses)([current.configRoot], options.ignorePids)
      const { finishProtectedPublication } = await import('./online.mjs')
      await finishProtectedPublication(journal, () => durableJson(journalFile, journal), progress)
    }
    if (journal?.launcherRollback && journal.status !== 'rolled-back' && !options.rollback)
      throw new Error('Interrupted CLI rollback; resume with --rollback')
    if (options.rollback && journal && (await inspect(join(plan.stateDir, 'launcher.json')))) {
      ;(deps.assertNoProcesses ?? assertNoProcesses)(
        [current.configRoot, ...journal.participants.map((p) => p.to)],
        options.ignorePids
      )
      const { prepareLauncherRollback } = await import('./launcher-recovery.mjs')
      await prepareLauncherRollback(
        journal,
        plan.stateDir,
        () => durableJson(journalFile, journal),
        deps.rollbackWindowsPath
      )
    }
    if (options.retireAliases) {
      ;(deps.assertNoProcesses ?? assertNoProcesses)(
        journal.participants.flatMap((p) => [p.from, p.to])
      )
      const audit = await removeAuditedAliases(journal, inventory)
      journal.aliasesRetiredAt = new Date().toISOString()
      await durableJson(journalFile, journal)
      return audit
    }
    if (journal?.status === 'committed' && !options.rollback) {
      for (const p of journal.participants)
        if (!(await inspect(p.to))) throw new Error(`Committed root is unavailable: ${p.to}`)
      for (const m of journal.mappings.filter((m) => m.state === 'use-new')) {
        if (!m.aliasRequired && (await inspect(m.from)))
          throw new Error(`Legacy data appeared beside adopted root: ${m.from}`)
        if (!(await inspect(m.to))) throw new Error(`Adopted root is unavailable: ${m.to}`)
      }
      await ensureAliases(journal)
      // A normalized fresh-install receipt must not hide data later written by a downgraded app.
      if (!journal.mappings.length)
        for (const m of current.mappings) {
          if (await inspect(m.from))
            throw new Error(
              `Legacy data appeared after initialization: ${m.from}; reconcile before startup`
            )
        }
      return await finish(journal)
    }
    if (journal?.status === 'rolled-back') {
      if (!options.restartAfterRollback || !options.execute)
        throw new Error('Migration was rolled back; use --execute --restart-after-rollback')
      ;(deps.assertNoProcesses ?? assertNoProcesses)(
        [current.configRoot, ...journal.participants.map((p) => p.from)],
        options.ignorePids
      )
      // Preserve the old recovery receipt and both generations under the same startup state root.
      const archive = join(plan.stateDir, `journal-${journal.id}.rolled-back.json`)
      if (await inspect(archive)) throw new Error(`Receipt archive conflict: ${archive}`)
      const launcher = join(plan.stateDir, 'launcher.json')
      if (await inspect(launcher)) {
        const archivedLauncher = join(plan.stateDir, `launcher-${journal.id}.rolled-back.json`)
        if (await inspect(archivedLauncher)) throw new Error('Launcher receipt archive conflict')
        await rename(launcher, archivedLauncher)
      }
      await rename(journalFile, archive)
      await syncDirectory(plan.stateDir)
      current = await planMigration(options)
      if (current.blockers.length) throw new Error(current.blockers.join('\n'))
      journal = undefined
    }
    const busyRoots = [
      current.configRoot,
      ...(journal?.participants ?? current.mappings).flatMap((p) => [p.from, p.to])
    ]
    ;(deps.assertNoProcesses ?? assertNoProcesses)(busyRoots, options.ignorePids)
    if (!journal) {
      if (options.rollback || options.resume) throw new Error('No migration journal exists')
      journal = await buildJournal(current)
      if (!journal) {
        journal = {
          version: 1,
          home: plan.home,
          configRoot: plan.configRoot,
          status: 'committed',
          userData: plan.userData,
          mappings: [],
          participants: []
        }
        await durableJson(journalFile, journal)
        return await finish(journal)
      }
      await durableJson(journalFile, journal)
    }
    const save = () => durableJson(journalFile, journal)
    if (options.rollback) {
      await rollback(journal, save, progress)
      return journal
    }
    if (journal.status === 'rolling-back')
      throw new Error('Interrupted rollback; resume with --rollback')
    if (journal.status === 'preparing')
      await prepare(journal, save, progress, deps.copyTree ?? copyTree)
    await publish(journal, save, progress)
    return await finish(journal)
  } finally {
    if (!retainLease) await unlock()
  }
}

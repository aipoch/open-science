import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import {
  access,
  link,
  readFile,
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
import { execFileSync, spawnSync } from 'node:child_process'
import { assertNoLinuxOpenFiles } from './linux-occupancy.mjs'
import { acquireKernelGuard } from './lock-guard.mjs'
import { restartPreparing } from './preparing-restart.mjs'
import { reportProgress, withMigrationProgress } from './progress.mjs'
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
import { discover, inside, inspect, readJson, assertPlainAncestors, remapPath } from './paths.mjs'
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
export async function inventory(root, phase = 'scanning') {
  await reportProgress({ phase, path: root, completed: 0 }, true)
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
    await reportProgress({ phase, path: root, completed: entries.length })
  }
  await visit('')
  await reportProgress({ phase: 'metadata', path: root })
  entries[0].metadata = metadataDigest(root)
  await reportProgress(
    { phase, path: root, completed: entries.length, total: entries.length },
    true
  )
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
    ? await bundleInventory(root, participant.files, (path) => inventory(path, 'verifying'))
    : await inventory(root, 'verifying')
  if (signature(actual) !== signature(expected)) {
    const before = new Map(expected.map((entry) => [entry.path, entry]))
    const after = new Map(actual.map((entry) => [entry.path, entry]))
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (path) =>
        !before.has(path) ||
        !after.has(path) ||
        signature([before.get(path)]) !== signature([after.get(path)])
    )
    throw new Error(
      `Integrity mismatch or new writes at ${root}; changed: ${changed
        .slice(0, 8)
        .map((p) => p || '<root metadata>')
        .join(', ')}. ` +
        'Keep the journal and both trees. For an unpublished preparing transaction with only appended logs, inspect --restart-preparing; other changes require reconciliation.'
    )
  }
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

// Logical leases survive application startup. The kernel guard protects lease recovery and
// releases automatically if the recovering process dies, including before any metadata write.
async function lock(
  stateDir,
  recover,
  ownerPid = process.pid,
  ownerKind = 'offline',
  profile = {},
  incomplete = [],
  progress = () => {},
  requireGuard = true
) {
  await assertPlainAncestors(stateDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const guardPath = join(stateDir, 'lock-guard')
  const guardStat = await inspect(guardPath)
  if (guardStat && (!guardStat.isFile() || guardStat.nlink !== 1))
    throw new Error('Unsafe kernel lock file')
  let guard
  const ensureGuard = async () => {
    guard ??= await acquireKernelGuard(guardPath)
  }
  if (requireGuard) await ensureGuard()
  const path = join(stateDir, 'lock')
  const token = randomUUID()
  async function acquire() {
    const prepared = join(stateDir, `lock-owner-${token}`)
    await durableJson(prepared, {
      pid: ownerPid,
      workerPid: process.pid,
      token,
      ownerKind: 'transaction'
    })
    try {
      await link(prepared, path)
      await syncDirectory(stateDir)
    } finally {
      await rm(prepared)
      await syncDirectory(stateDir)
    }
  }
  async function recoverNode(node, directory = false) {
    const stat = await inspect(node)
    if (!stat) return
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (!directory && ![1, 2].includes(stat.nlink))
    )
      throw new Error(`Unsafe migration lock: ${node}`)
    const entries = directory ? (await readdir(node)).sort() : []
    if (entries.some((name) => name !== 'owner.json'))
      throw new Error(`Unknown recovery lock contents: ${node}`)
    const metadata = directory ? join(node, 'owner.json') : node
    const metaStat = await inspect(metadata)
    if (metaStat && (!metaStat.isFile() || (directory && metaStat.nlink !== 1)))
      throw new Error(`Unsafe lock metadata: ${metadata}`)
    const bytes = metaStat ? await readFile(metadata) : Buffer.alloc(0)
    let owner
    try {
      owner = JSON.parse(bytes.toString('utf8'))
    } catch {
      /* explicit fingerprint recovery below */
    }
    const known =
      Number.isSafeInteger(owner?.pid) &&
      owner.pid > 0 &&
      typeof owner.token === 'string' &&
      owner.token.length > 0 &&
      (owner.workerPid === undefined ||
        (Number.isSafeInteger(owner.workerPid) && owner.workerPid > 0))
    if (known && (alive(owner.pid) || (owner.workerPid && alive(owner.workerPid))))
      throw new Error(`Migration lock owner is active: ${owner.pid}`)
    if (!directory && stat.nlink === 2) {
      const paired =
        known && /^[a-f0-9-]{36}$/.test(owner.token)
          ? await inspect(join(stateDir, `lock-owner-${owner.token}`))
          : undefined
      if (
        !paired?.isFile() ||
        paired.dev !== stat.dev ||
        paired.ino !== stat.ino ||
        paired.nlink !== 2
      )
        throw new Error(`Unowned lock hardlink: ${node}`)
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([stat.dev, stat.ino, stat.mtimeMs, entries]))
      .update(bytes)
      .digest('hex')
    if (!known && !incomplete.includes(fingerprint))
      throw new Error(
        `Incomplete lock metadata: ${node}; stop all old migrators and writers, then retry --recover-lock --recover-incomplete-lock ${fingerprint}. The inspected lock will be preserved in quarantine.`
      )
    assertNoOpenFiles([node])
    guard.assertHeld()
    const current = await lstat(node)
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs)
      throw new Error('Migration lock identity changed during recovery')
    await rename(node, `${node}.abandoned-${randomUUID()}`)
    await syncDirectory(stateDir)
    await progress({ phase: directory ? 'recovery-lock-quarantined' : 'lock-quarantined' })
  }
  try {
    if (await inspect(join(stateDir, 'lock-recovery'))) {
      if (!recover)
        throw new Error('Recovery lock exists; use --recover-lock after stopping its owner')
      await ensureGuard()
      await recoverNode(join(stateDir, 'lock-recovery'), true)
    }
    try {
      await acquire()
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!recover)
        throw new Error(
          `Migration lock exists; stop the owner or use --recover-lock after a crash: ${path}`
        )
      await ensureGuard()
      await recoverNode(path)
      await acquire()
    }
  } catch (error) {
    await guard?.release()
    throw error
  }
  const release = async () => {
    try {
      const owner = await readJson(path)
      if (owner.token !== token) throw new Error('Migration lock identity changed')
      await rm(path)
      await syncDirectory(stateDir)
    } finally {
      await guard?.release()
    }
  }
  const handoff = async (userData) => {
    if (ownerKind !== 'application') return
    guard?.assertHeld()
    await durableJson(path, {
      pid: ownerPid,
      token,
      ownerKind: 'application',
      ...profile,
      userData
    })
    await guard?.release()
  }
  return {
    release,
    handoff,
    ensureGuard,
    assertHeld: () => guard?.assertHeld(),
    lease: { path, token }
  }
}

// lsof enumerates cwd, regular descriptors and mapped executable/library files, including
// paths outside argv and roots renamed into backups. A failed or incomplete probe is not empty.
export function assertNoOpenFiles(roots, probe = spawnSync) {
  if (process.platform === 'linux') return assertNoLinuxOpenFiles(roots, { probe })
  if (process.platform === 'win32')
    throw new Error(
      'Reliable Windows directory/handle inspection is unavailable; migration is blocked. Use a verified native occupancy provider before migrating on Windows.'
    )
  const canonicalRoots = roots
    .map((root) => {
      try {
        return realpathSync(root)
      } catch (error) {
        if (error.code === 'ENOENT') return root
        throw error
      }
    })
    .map((root) => ({ root, folded: root.toLowerCase() }))
  const result = probe(
    process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
    ['-nP', '-F0pcfn'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 }
  )
  if (
    result.error ||
    result.status !== 0 ||
    result.stderr?.trim() ||
    !result.stdout?.endsWith('\n')
  )
    throw new Error(
      `Cannot verify migration file occupancy: ${result.error?.message ?? result.stderr?.trim() ?? 'incomplete lsof output'}`
    )
  let pid = 0
  let descriptor = ''
  let processes = 0
  for (const raw of result.stdout.split('\0')) {
    const field = raw.replace(/^\n/, '')
    if (!field || field === '\n') continue
    const value = field.slice(1)
    if (field[0] === 'p') {
      pid = Number(value)
      descriptor = ''
      processes++
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid occupancy process record')
    } else if (field[0] === 'f') {
      descriptor = value
      if (descriptor === 'NOFD') throw new Error(`Cannot inspect open files of PID ${pid}`)
    } else if (field[0] === 'n') {
      if (!pid || !descriptor) throw new Error('Incomplete occupancy descriptor record')
      if (pid === process.pid) continue
      const path = value.replace(/ \(deleted\)$/, '')
      if (
        path.startsWith('/') &&
        canonicalRoots.some(
          ({ root, folded }) => path.toLowerCase().startsWith(folded) && inside(root, path)
        )
      )
        throw new Error(
          `Migration paths are occupied (PID ${pid}, ${descriptor}); close the writer or leave its cwd first`
        )
    }
  }
  if (!processes) throw new Error('Empty occupancy process inventory')
}

export function assertNoProcesses(roots, ignoredPids = []) {
  const ignore = new Set([process.pid, ...ignoredPids])
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
  assertNoOpenFiles(roots)
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
  return planRoots(plan)
}

async function planRoots(plan) {
  const mappings = []
  const blockers = []
  for (const map of plan.mappings) {
    await assertPlainAncestors(map.from)
    await assertPlainAncestors(map.to)
    const old = await inspect(map.from)
    const next = await inspect(map.to)
    const targetHandling =
      old && next
        ? !(await readdir(map.to)).length
          ? 'empty'
          : map.kind === 'logs'
            ? 'logs'
            : undefined
        : undefined
    if (old && next && !targetHandling)
      blockers.push(`Path conflict: both ${map.from} and ${map.to} exist`)
    if (map.from !== map.to && (inside(map.from, map.to) || inside(map.to, map.from)))
      blockers.push(`Overlapping migration roots: ${map.from}`)
    mappings.push({
      ...map,
      ...(targetHandling ? { targetHandling } : {}),
      state: old ? (next && !targetHandling ? 'conflict' : 'move') : next ? 'use-new' : 'initialize'
    })
  }
  if (mappings.filter((m) => m.kind === 'data' && ['move', 'use-new'].includes(m.state)).length > 1)
    blockers.push('Multiple default data roots require explicit reconciliation')
  for (const parent of mappings)
    for (const child of mappings) {
      if (parent === child) continue
      if (inside(parent.from, child.from) && !inside(parent.to, child.to))
        blockers.push(`Unsupported nested mapping: ${child.from}`)
      if (child.targetHandling && inside(parent.from, child.from))
        blockers.push(`Nested target requires explicit reconciliation: ${child.to}`)
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
    stationary: m.state === 'use-new',
    targetHandling: m.targetHandling
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
    let previousTarget
    if (r.targetHandling) {
      const targetOriginal = await inventory(r.to)
      if (r.targetHandling === 'empty' && targetOriginal.length !== 1)
        throw new Error(`Integrity mismatch or new writes at ${r.to}`)
      const backup = `${r.to}.brand-existing-${id}`
      if (await inspect(backup)) throw new Error(`Existing-target backup conflict: ${backup}`)
      previousTarget = { kind: r.targetHandling, backup, original: targetOriginal }
    }
    participants.push({
      from: r.from,
      to: r.to,
      ...(files ? { files } : {}),
      stage: `${r.to}.brand-stage-${id}`,
      backup: `${r.from}.brand-backup-${id}`,
      ...(previousTarget ? { previousTarget } : {}),
      original,
      published: undefined
    })
  }
  return {
    version: 2,
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

async function publish(journal, save, progress, checkWriters) {
  checkWriters()
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
    if (p.previousTarget) {
      const target = p.previousTarget
      if (!(await inspect(target.backup))) {
        if ((await inspect(p.backup)) || !(await inspect(p.stage)))
          throw new Error(`Existing-target backup is missing: ${target.backup}`)
        await verify(p.to, target.original)
        await rename(p.to, target.backup)
        await syncDirectory(dirname(p.to))
        await progress({ phase: 'target-backed-up', path: p.to })
      }
      await verify(target.backup, target.original)
    }
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
  checkWriters()
  for (const p of journal.participants) {
    await verify(p.to, p.published, p)
    await verify(p.backup, p.original, p)
    if (p.previousTarget) await verify(p.previousTarget.backup, p.previousTarget.original)
  }
  await ensureAliases(journal)
  await progress({ phase: 'before-commit' })
  for (const p of journal.participants) {
    await verify(p.to, p.published, p)
    await verify(p.backup, p.original, p)
    if (p.previousTarget) await verify(p.previousTarget.backup, p.previousTarget.original)
  }
  checkWriters()
  journal.status = 'committed'
  journal.committedAt = new Date().toISOString()
  await save()
}

async function prepare(journal, save, progress, copy) {
  // A later participant's drift must not destroy an earlier participant's recovery evidence.
  // Repeat each local check below as well, because copying can take time after this preflight.
  for (const p of journal.participants) {
    await verify(p.from, p.original, p)
    if (p.previousTarget) await verify(p.to, p.previousTarget.original)
  }
  for (const p of journal.participants) {
    // Do not destroy a prior staged snapshot when the originals no longer verify.
    await verify(p.from, p.original, p)
    if (p.previousTarget) await verify(p.to, p.previousTarget.original)
    if (await inspect(p.stage)) await rm(p.stage, { recursive: true })
    await progress({ phase: 'copying', path: p.from })
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
    await progress({ phase: 'references', path: p.to })
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
    await progress({ phase: 'syncing', path: p.to })
    await syncTree(p.stage, p.published)
    await progress({ phase: 'references-prepared', path: p.stage })
    await save()
  }
  // Detect source writes during a long cross-filesystem copy before touching any original root.
  for (const p of journal.participants) {
    await verify(p.from, p.original, p)
    if (p.previousTarget) await verify(p.to, p.previousTarget.original)
  }
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
    let originalTargetInPlace = false
    if (p.previousTarget) {
      const target = p.previousTarget
      if (await inspect(target.backup)) {
        await verify(target.backup, target.original)
        // Until the source was backed up, or after it was restored, the destination must be free.
        if (!backup && (await inspect(p.to)))
          throw new Error(`Unexpected target beside existing-target backup: ${p.to}`)
      } else {
        if (backup || journal.status === 'committed')
          throw new Error(`Existing-target backup is missing: ${target.backup}`)
        await verify(p.to, target.original)
        originalTargetInPlace = true
      }
    }
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
      if (
        !['preparing', 'prepared', 'publishing'].includes(journal.status) &&
        !(
          journal.status === 'rolling-back' &&
          (p.rollbackOriginalInPlace ||
            p.restoreIntent ||
            (!p.rollbackSnapshot && (!p.published || (await inspect(p.stage)))))
        )
      )
        throw new Error(`Original backup is missing: ${p.backup}`)
      // A not-yet-published root is recoverable only while its exact original remains.
      await verify(p.from, p.original)
      if (p.from !== p.to && !originalTargetInPlace && (await inspect(p.to)))
        throw new Error(`Unexpected target without backup: ${p.to}`)
      p.rollbackOriginalInPlace = true
    }
    p.rollbackSnapshot = true
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
      p.restoreIntent = true
      await save()
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
    if (p.previousTarget && (await inspect(p.previousTarget.backup))) {
      if (await inspect(p.to)) throw new Error(`Rollback target conflict: ${p.to}`)
      p.previousTarget.restoreIntent = true
      await save()
      await rename(p.previousTarget.backup, p.to)
      await syncDirectory(dirname(p.to))
      p.previousTarget.restored = true
      await save()
      await progress({ phase: 'rollback-target-restored', path: p.to })
    }
  }
  journal.status = 'rolled-back'
  await save()
}

// A receipt records roots that existed at that transaction, not all future legacy roots.
async function assertCoveredRoots(plan, journal) {
  for (const m of plan.mappings) {
    if (!(await inspect(m.from))) continue
    const covered = journal.mappings.some(
      (prior) => [prior.from, ...(prior.fromAliases ?? [])].includes(m.from) && prior.to === m.to
    )
    if (!covered && remapPath(m.from, journal.mappings, plan.platform) !== m.to)
      throw new Error(
        `Legacy uncovered root appeared: ${m.from} -> ${m.to}; startup blocked. ` +
          'Keep this journal. If rollback verification succeeds, use --rollback, then --execute --restart-after-rollback to include the new root; see docs/brand-path-migration.md.'
      )
  }
}

function requiresKernelGuard(plan, options) {
  if (
    options.rollback ||
    options.retireAliases ||
    options.resume ||
    options.restartAfterRollback ||
    options.restartPreparing
  )
    return true
  if (plan.journal)
    return (
      plan.journal.status !== 'committed' ||
      plan.journal.mappings.length > 0 ||
      plan.journal.participants.length > 0
    )
  return plan.mappings.some((m) => m.state !== 'initialize')
}

export async function runMigration(options, deps = {}) {
  return withMigrationProgress(deps.onProgress ?? (() => {}), async () => {
    await reportProgress({ phase: 'checking' })
    const result = await migrate(options, deps)
    await reportProgress({ phase: 'completed' })
    return result
  })
}

async function migrate(options, deps) {
  const progress = reportProgress
  if (
    options.restartPreparing &&
    (options.startupOwner ||
      options.execute ||
      options.resume ||
      options.rollback ||
      options.retireAliases ||
      options.auditAliases ||
      options.dryRun)
  )
    throw new Error('--restart-preparing is a standalone offline write action')
  const plan = await planMigration(options)
  if (plan.journal?.status === 'committed' && !options.rollback)
    await assertCoveredRoots(plan, plan.journal)
  if (options.auditAliases) return auditAliases(plan.journal, inventory)
  if (
    !options.execute &&
    !options.rollback &&
    !options.resume &&
    !options.retireAliases &&
    !options.restartPreparing
  )
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
    lease,
    assertHeld,
    ensureGuard: requireKernelGuard
  } = await lock(
    plan.stateDir,
    options.recoverLock,
    options.startupOwner,
    options.startupOwner ? 'application' : 'offline',
    { userData: plan.userData, relayEligible: !options.allowMultiInstance },
    options.recoverIncompleteLock,
    progress,
    // Pure initialization and its empty committed receipt move no user files. Atomic lease
    // creation suffices; any abandoned-lock recovery still acquires the kernel guard above.
    requiresKernelGuard(plan, options)
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
    await progress({ phase: 'lease-acquired' })
    let current = await planMigration(options)
    if (requiresKernelGuard(current, options)) await requireKernelGuard()
    if (current.blockers.length) throw new Error(current.blockers.join('\n'))
    const journalFile = join(plan.stateDir, 'journal.json')
    let journal = current.journal
    if (journal?.version === 1) {
      // Upgrade under the lease before any online adapter can write new recovery fields.
      if (journal.id !== undefined && !/^[a-f0-9-]{36}$/.test(journal.id))
        throw new Error('Invalid version-1 receipt identity')
      const id = journal.id ?? randomUUID()
      const archive = join(plan.stateDir, `journal-${id}.version-1.json`)
      const archived = await inspect(archive)
      if (archived) {
        if (!archived.isFile() || archived.nlink !== 1)
          throw new Error(`Unsafe version-1 receipt archive: ${archive}`)
        if (JSON.stringify(await readJson(archive)) !== JSON.stringify(journal))
          throw new Error(`Version-1 receipt archive conflict: ${archive}`)
      } else await durableJson(archive, journal)
      journal = { ...journal, version: 2, id, platform: journal.platform ?? plan.platform }
      await durableJson(journalFile, journal)
    }
    if (journal?.status === 'restarting' && !options.resume && !options.restartPreparing)
      throw new Error(
        'Interrupted snapshot restart; use --resume or --restart-preparing after stopping all writers'
      )
    if ((options.restartPreparing && !journal?.restartOf) || journal?.status === 'restarting') {
      if (!journal) throw new Error('No preparing migration journal exists')
      const checkWriters = () => {
        assertHeld()
        ;(deps.assertNoProcesses ?? assertNoProcesses)([
          current.configRoot,
          ...journal.participants.flatMap((p) =>
            [p.from, p.to, p.stage, p.backup, p.previousTarget?.backup].filter(Boolean)
          )
        ])
      }
      journal = await restartPreparing(journal, current, {
        inventory,
        verify,
        write: durableJson,
        progress,
        checkWriters,
        build: async () => {
          const next = await planRoots(await discover(options))
          if (next.blockers.length) throw new Error(next.blockers.join('\n'))
          return buildJournal(next)
        }
      })
      current = await planMigration(options)
    }
    if (
      options.restartPreparing &&
      !['preparing', 'prepared', 'publishing', 'committed'].includes(journal?.status)
    )
      throw new Error('Snapshot restart is unavailable in this phase; use --resume or --rollback')
    if (journal?.status === 'rolled-back' && options.rollback) return journal
    if (journal?.protectedMigration?.status === 'publishing') {
      ;(deps.assertNoProcesses ?? assertNoProcesses)(
        [current.configRoot],
        [...(options.ignorePids ?? []), ...(options.startupOwner ? [options.startupOwner] : [])]
      )
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
      await assertCoveredRoots(current, journal)
      await ensureAliases(journal)
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
      ...(journal?.participants ?? current.mappings).flatMap((p) =>
        [
          p.from,
          p.to,
          p.stage,
          p.backup,
          p.stage && `${p.stage}.rolled-back`,
          p.previousTarget?.backup
        ].filter(Boolean)
      )
    ]
    if (journal || current.mappings.some((m) => m.state !== 'initialize'))
      (deps.assertNoProcesses ?? assertNoProcesses)(busyRoots, [
        ...(options.ignorePids ?? []),
        ...(options.startupOwner ? [options.startupOwner] : [])
      ])
    if (!journal) {
      if (options.rollback || options.resume) throw new Error('No migration journal exists')
      journal = await buildJournal(current)
      if (!journal) {
        journal = {
          version: 2,
          id: randomUUID(),
          platform: plan.platform,
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
    const save = () => {
      assertHeld()
      journal.version = Math.max(journal.version, 2)
      journal.id ??= randomUUID()
      journal.platform ??= plan.platform
      return durableJson(journalFile, journal)
    }
    if (options.rollback) {
      await rollback(journal, save, progress)
      return journal
    }
    if (journal.status === 'rolling-back')
      throw new Error('Interrupted rollback; resume with --rollback')
    if (journal.status === 'preparing')
      await prepare(journal, save, progress, deps.copyTree ?? copyTree)
    const checkWriters = () => {
      assertHeld()
      ;(deps.assertNoProcesses ?? ((roots) => assertNoOpenFiles(roots)))(
        [
          current.configRoot,
          ...journal.participants.flatMap((p) =>
            [
              p.from,
              p.to,
              p.stage,
              p.backup,
              `${p.stage}.rolled-back`,
              p.previousTarget?.backup
            ].filter(Boolean)
          )
        ],
        [...(options.ignorePids ?? []), ...(options.startupOwner ? [options.startupOwner] : [])]
      )
    }
    await publish(
      journal,
      save,
      async (event) => {
        await progress(event)
        checkWriters()
      },
      checkWriters
    )
    return await finish(journal)
  } finally {
    if (!retainLease) await unlock()
  }
}

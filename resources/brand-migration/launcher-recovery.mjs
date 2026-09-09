import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inspect, readJson } from './paths.mjs'
import { bundleInventory, copyBundle } from './reference-bundle.mjs'
import { inventory, copyTree, verify, durableJson, syncDirectory } from './transaction.mjs'

const names = ['open-science.cmd', '.open-science-path-receipt', '.open-science-path-pending']
const owner = 'Open Science Windows PATH entry. Managed by the app.'
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const parseReceipt = (raw) => (raw === null ? undefined : JSON.parse(raw))
const defaultRun = (command, args) =>
  spawnSync(command, args, { windowsHide: true, stdio: 'ignore' }).status === 0

// Undo only the launcher's own known mutation before the main transaction restores the old profile.
// A verified scratch reconstruction proves every other profile byte/ACL still matches phase one.
export async function prepareLauncherRollback(journal, stateDir, save, run = defaultRun) {
  const file = join(stateDir, 'launcher.json')
  const receiptStat = await inspect(file)
  if (!receiptStat) return
  if (!receiptStat.isFile() || receiptStat.nlink !== 1)
    throw new Error('Unsafe launcher recovery receipt')
  const state = await readJson(file)
  const profile = journal.participants.find(
    (p) =>
      p.to === state.to &&
      (p.from === state.from || p.files?.includes(join('bin', 'open-science.cmd')))
  )
  if (
    state.id !== journal.id ||
    !profile ||
    typeof state.originalShim !== 'string' ||
    typeof state.plannedShim !== 'string'
  )
    throw new Error('Launcher recovery identity mismatch')
  if (journal.launcherRollback?.status === 'accepted') return
  const original = parseReceipt(state.originalReceipt)
  if (
    original &&
    (original.owner !== owner ||
      original.binDir !== join(state.from, 'bin') ||
      original.afterPath !==
        [...(original.beforePath ?? '').split(';').filter(Boolean), original.binDir].join(';'))
  )
    throw new Error('Invalid original owned PATH snapshot')
  const nextBin = join(state.to, 'bin')
  let currentReceipt
  for (const name of names) {
    const path = join(state.to, 'bin', name)
    const stat = await inspect(path)
    if (!stat) continue
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Unsafe launcher recovery member: ${path}`)
    const raw = await readFile(path, 'utf8')
    if (name === 'open-science.cmd') {
      if (raw !== state.originalShim && raw !== state.plannedShim)
        throw new Error('Launcher has new user edits')
    } else {
      const value = JSON.parse(raw)
      const old = original && JSON.stringify(value) === JSON.stringify(original)
      const next =
        value.version === 1 &&
        value.owner === owner &&
        value.binDir === nextBin &&
        (value.beforePath === null || typeof value.beforePath === 'string') &&
        (!original || value.beforePath === original.beforePath) &&
        value.afterPath ===
          [...(value.beforePath ?? '').split(';').filter(Boolean), nextBin].join(';')
      if (!old && !next) throw new Error('PATH receipt has new user edits')
      currentReceipt = value
    }
  }
  const scratch = `${profile.to}.brand-launcher-rollback-stage-${journal.id}`
  const accepted = profile.files
    ? await bundleInventory(profile.to, profile.files, inventory)
    : await inventory(profile.to)
  if (await inspect(scratch)) {
    if (journal.launcherRollback?.scratch !== scratch)
      throw new Error('Launcher rollback staging conflict')
    await rm(scratch, { recursive: true })
  }
  journal.launcherRollback = { status: 'checking', scratch, profile: profile.to }
  await save()
  if (profile.files)
    await copyBundle(
      { ...profile, from: profile.to, stage: scratch, original: accepted },
      copyTree,
      verify,
      syncDirectory
    )
  else await copyTree(profile.to, scratch)
  await verify(scratch, accepted, profile)
  for (const name of names) {
    const restored = join(scratch, 'bin', name)
    if (await inspect(restored)) await rm(restored)
    const backup = join(profile.backup, 'bin', name)
    if (await inspect(backup)) await copyTree(backup, restored)
  }
  await verify(scratch, profile.published, profile)
  journal.launcherRollback = { status: 'prepared', scratch, profile: profile.to, accepted }
  await save()
  // CAS accepts each journaled crash point, preserves the exact original PATH bytes, and refuses
  // unrelated registry edits. No shell interpolation: the PowerShell program is one argv value.
  if (original || currentReceipt) {
    const before = original ? original.beforePath : currentReceipt.beforePath
    const restore = original ? original.afterPath : before
    const nextPath = [...(before ?? '').split(';').filter(Boolean), nextBin].join(';')
    const literal = (value) => (value === null ? '$null' : quote(value))
    const script = [
      "$ErrorActionPreference='Stop'",
      "$current=[Environment]::GetEnvironmentVariable('Path','User')",
      `if ($current -cne ${literal(restore)} -and $current -cne ${quote(nextPath)} -and $current -cne ${literal(before)}) { throw 'User PATH changed; reconcile it before rollback' }`,
      `[Environment]::SetEnvironmentVariable('Path',${literal(restore)},'User')`
    ].join('\n')
    if (!run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]))
      throw new Error('CLI PATH rollback stopped; no filesystem roots were restored')
  }
  // Exact current bytes were proved above, not broadly exempted from integrity verification.
  profile.published = accepted
  journal.launcherRollback.status = 'accepted'
  journal.status = 'rolling-back'
  await save()
  state.status = 'rolled-back'
  await durableJson(file, state)
}

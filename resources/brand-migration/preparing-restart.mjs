import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPlainAncestors, inspect, readJson } from './paths.mjs'

const shape = (journal) =>
  JSON.stringify({
    mappings: journal.mappings.map(({ from, to, state }) => ({ from, to, state })),
    participants: journal.participants.map(({ from, to, files }) => ({ from, to, files }))
  })
const stable = ({ mtimeMs, ...entry }) => ({
  ...entry,
  ...(entry.type === 'file' ? { mtimeMs } : {})
})

// An explicit restart accepts appended bytes in existing application log files only. Rotation,
// deletion, metadata changes and any change in user data/configuration still need reconciliation.
async function verifyLogAppends(root, expected, inventory) {
  const actual = await inventory(root, 'verifying')
  if (actual.length !== expected.length) throw new Error(`Log entries changed at ${root}`)
  for (let i = 0; i < expected.length; i++) {
    const before = expected[i]
    const after = actual[i]
    if (JSON.stringify(stable(before)) === JSON.stringify(stable(after))) continue
    const { size, sha256, ...original } = before
    delete original.mtimeMs
    const { size: nextSize, mtimeMs: nextTime, ...next } = after
    delete next.sha256
    if (
      before.type !== 'file' ||
      !before.path.endsWith('.log') ||
      nextSize < size ||
      JSON.stringify(original) !== JSON.stringify(next)
    )
      throw new Error(`Non-append log change at ${join(root, before.path)}`)
    const handle = await open(join(root, before.path), 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== nextSize || Math.trunc(stat.mtimeMs) !== nextTime)
        throw new Error(`Log changed during restart at ${join(root, before.path)}`)
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      for (let offset = 0; offset < size;) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset
        )
        if (!bytesRead)
          throw new Error(`Log truncated during restart at ${join(root, before.path)}`)
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      if (hash.digest('hex') !== sha256)
        throw new Error(`Non-append log change at ${join(root, before.path)}`)
    } finally {
      await handle.close()
    }
  }
}

async function assertUnpublished(journal, plan) {
  if (
    !['preparing', 'restarting'].includes(journal.status) ||
    journal.protectedMigration ||
    journal.launcherRollback
  )
    throw new Error(
      'Snapshot restart requires a wholly unpublished preparing transaction; use its recovery procedure'
    )
  if (await inspect(join(plan.stateDir, 'launcher.json')))
    throw new Error('Launcher state prevents a preparing snapshot restart')
  for (const p of journal.participants) {
    if (
      p.publishIntents?.length ||
      p.restoreIntents?.length ||
      p.rollbackSnapshot ||
      p.restoreIntent ||
      p.restored
    )
      throw new Error('Publication or restoration intent prevents a preparing snapshot restart')
    for (const root of [p.from, p.to, p.stage]) await assertPlainAncestors(root)
    if (!(await inspect(p.from))?.isDirectory()) throw new Error(`Original root missing: ${p.from}`)
    for (const root of [p.backup, `${p.stage}.rolled-back`, p.previousTarget?.backup].filter(
      Boolean
    ))
      if (await inspect(root))
        throw new Error(`Publication evidence prevents snapshot restart: ${root}`)
    if (p.from !== p.to && !p.previousTarget && (await inspect(p.to)))
      throw new Error(`Unexpected destination prevents snapshot restart: ${p.to}`)
  }
}

export async function restartPreparing(journal, plan, deps) {
  const { inventory, verify, build, write, progress, checkWriters } = deps
  await assertUnpublished(journal, plan)
  checkWriters()
  const verifyOriginals = async () => {
    for (const p of journal.participants) {
      const logs =
        !p.files &&
        plan.mappings.some((m) => m.kind === 'logs' && m.from === p.from && m.to === p.to)
      if (logs) await verifyLogAppends(p.from, p.original, inventory)
      else await verify(p.from, p.original, p)
      if (p.previousTarget) {
        if (logs && p.previousTarget.kind === 'logs')
          await verifyLogAppends(p.to, p.previousTarget.original, inventory)
        else await verify(p.to, p.previousTarget.original)
      }
    }
  }
  const archive = join(plan.stateDir, `journal-${journal.id}.superseded.json`)
  let next
  if (journal.status === 'restarting') {
    const archived = await inspect(archive)
    if (!archived?.isFile() || archived.nlink !== 1)
      throw new Error(`Missing or unsafe restart archive: ${archive}`)
    const prior = await readJson(archive)
    const { restart, ...base } = journal
    if (
      JSON.stringify(prior) !==
      JSON.stringify({ ...base, version: restart.previousVersion, status: 'preparing' })
    )
      throw new Error(`Restart archive does not match its intent: ${archive}`)
    next = restart.next
  } else {
    // Capture all roots before deciding to supersede anything. Ordinary data/reference bundles
    // must still match exactly, including the actual SQLite bytes and every previous target.
    await verifyOriginals()
    next = await build()
    if (!next || shape(next) !== shape(journal))
      throw new Error(
        'Migration roots or reference participants changed; snapshot restart cannot accept a different plan'
      )
    next = { ...next, version: 3, restartOf: journal.id }
    // No old staging tree is removed or repurposed. A fresh transaction ID gives every new
    // stage/backup a different name, while the archived receipt locates all earlier evidence.
    const archived = await inspect(archive)
    if (archived) {
      if (
        !archived.isFile() ||
        archived.nlink !== 1 ||
        JSON.stringify(await readJson(archive)) !== JSON.stringify(journal)
      )
        throw new Error(`Restart archive conflict: ${archive}`)
    } else await write(archive, journal)
    await progress({ phase: 'restart-archived', path: archive })
  }
  // Revalidate the complete accepted snapshot before persisting/installing the intent. Later
  // drift cannot be accepted merely because an earlier restart command was authorized.
  const verifyAccepted = async () => {
    await assertUnpublished(journal, plan)
    await verifyOriginals()
    for (const p of next.participants) {
      await verify(p.from, p.original, p)
      if (p.previousTarget) await verify(p.to, p.previousTarget.original)
      for (const root of [p.stage, p.backup, p.previousTarget?.backup].filter(Boolean))
        if (await inspect(root)) throw new Error(`New restart generation already exists: ${root}`)
    }
    checkWriters()
  }
  await verifyAccepted()
  const file = join(plan.stateDir, 'journal.json')
  if (journal.status !== 'restarting') {
    await write(file, {
      ...journal,
      version: 3,
      status: 'restarting',
      restart: { previousVersion: journal.version, next }
    })
    await progress({ phase: 'restart-intent', path: file })
  }
  await verifyAccepted()
  await write(file, next)
  await progress({ phase: 'restart-installed', path: file })
  return next
}

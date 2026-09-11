import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { inspect, readJson } from './paths.mjs'
import { rewriteDatabase } from './references.mjs'
import { bundleInventory, copyBundle, publishBundle } from './reference-bundle.mjs'
import {
  inventory,
  durableJson,
  verify,
  copyTree,
  syncTree,
  syncDirectory
} from './transaction.mjs'

export async function finishProtectedPublication(journal, save, progress = () => {}) {
  const p = journal.protectedMigration
  await publishBundle(p, save, progress, inventory, syncDirectory)
  await verify(p.to, p.published, p)
  await verify(p.backup, p.original, p)
  await progress({ phase: 'protected-published' })
  // The intent contains complete before/after manifests and only encrypted staged bytes. Offline
  // resume/rollback can finish this publication without requiring access to the OS credential key.
  const participant = journal.participants.find((p) => p.to === journal.configRoot)
  participant.published = participant.files
    ? await bundleInventory(participant.to, participant.files, inventory)
    : await inventory(participant.to)
  journal.database = p.database
  p.status = 'committed'
  journal.protectedPathsReconciledAt = new Date().toISOString()
  await save()
}

// Stage and encrypt under the application lease, before any application DB client opens.
export async function reconcileProtectedPaths(stateDir, protection, deps = {}) {
  const file = join(stateDir, 'journal.json')
  const journal = await readJson(file)
  if (journal.status !== 'committed')
    throw new Error('Protected path reconciliation requires a committed filesystem migration')
  if (!journal.database?.transitions?.length) return
  const owner = await readJson(join(stateDir, 'lock'))
  if (owner.ownerKind !== 'application' || owner.pid !== process.pid)
    throw new Error('Protected path reconciliation requires the application lease')
  const participant = journal.participants.find((p) => p.to === journal.configRoot)
  if (!participant || !(await inspect(join(participant.backup, 'open-science.db'))))
    throw new Error('Original database backup is required before protected path migration')
  const save = () => durableJson(file, journal)
  const progress = deps.onProgress ?? (() => {})
  let p = journal.protectedMigration
  if (p?.status === 'publishing') return finishProtectedPublication(journal, save, progress)
  if (!p) {
    const files = ['open-science.db', 'open-science.db-wal', 'open-science.db-shm']
    p = journal.protectedMigration = {
      from: journal.configRoot,
      to: journal.configRoot,
      files,
      stage: `${journal.configRoot}.brand-protected-stage-${journal.id}`,
      backup: `${journal.configRoot}.brand-protected-backup-${journal.id}`,
      original: await bundleInventory(journal.configRoot, files, inventory),
      status: 'preparing'
    }
    await save()
  }
  await verify(p.from, p.original, p)
  if (await inspect(p.stage)) await rm(p.stage, { recursive: true })
  await copyBundle(p, copyTree, verify, syncDirectory)
  // Failed decrypt/encrypt rolls back the staged DB; original live DB and both backups stay intact.
  p.database = rewriteDatabase(
    join(p.stage, 'open-science.db'),
    journal.mappings,
    journal.platform,
    () => {},
    protection
  )
  p.published = await bundleInventory(p.stage, p.files, inventory)
  await syncTree(p.stage, p.published)
  await verify(p.from, p.original, p)
  p.status = 'publishing'
  await save()
  await finishProtectedPublication(journal, save, progress)
}

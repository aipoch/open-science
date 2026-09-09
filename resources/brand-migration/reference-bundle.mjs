import { mkdir, readFile, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { documentKind, transformDocument, rewriteDatabase } from './references.mjs'
import { inspect } from './paths.mjs'

const databaseFile = /^open-science\.db(?:-wal|-shm)?$/
// Read names and supported documents only. An adopted normalized tree needs neither an all-file
// hash nor metadata tools, a second copy, or a replacement root inode.
export async function changedReferenceFiles(root, mappings, platform) {
  const files = []
  async function visit(relative = '') {
    for (const name of await readdir(join(root, relative))) {
      const path = join(relative, name)
      const stat = await inspect(join(root, path))
      if (stat.isDirectory()) {
        if (/^(sessions|notebooks)([/\\]|$)/.test(path)) await visit(path)
      } else if (documentKind(path)) {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error(`Unsafe reference document: ${path}`)
        const value = JSON.parse(await readFile(join(root, path), 'utf8'))
        const next = transformDocument(value, documentKind(path), mappings, platform, true)
        if (JSON.stringify(value) !== JSON.stringify(next)) {
          transformDocument(value, documentKind(path), mappings, platform)
          files.push(path)
        }
      }
    }
  }
  await visit()
  const database = join(root, 'open-science.db')
  if (await inspect(database)) {
    for (const name of ['open-science.db', 'open-science.db-wal', 'open-science.db-shm']) {
      const s = await inspect(join(root, name))
      if (s && (!s.isFile() || s.nlink !== 1)) throw new Error(`Unsafe database: ${name}`)
    }
    const report = rewriteDatabase(database, mappings, platform, () => {}, undefined, true)
    if (report.changed.length || report.transitions.length)
      files.push('open-science.db', 'open-science.db-wal', 'open-science.db-shm')
  }
  if (
    mappings.some((m) => m.kind === 'profile' && m.to === root && m.aliasRequired) &&
    (await inspect(join(root, 'bin', 'open-science.cmd')))
  )
    files.push(
      join('bin', 'open-science.cmd'),
      join('bin', '.open-science-path-receipt'),
      join('bin', '.open-science-path-pending')
    )
  return [...new Set(files)].sort()
}

export async function bundleInventory(root, files, inventory) {
  const entries = [{ path: '', type: 'directory' }]
  for (const path of files) {
    const stat = await inspect(join(root, path))
    if (!stat) continue
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Unsafe reference bundle member: ${path}`)
    const [entry] = await inventory(join(root, path))
    entries.push({ ...entry, path, hardlink: path })
  }
  return entries
}

export async function copyBundle(p, copy, verify, syncDirectory) {
  await durableMkdir(p.stage, syncDirectory)
  for (const entry of p.original.slice(1)) {
    await durableMkdir(dirname(join(p.stage, entry.path)), syncDirectory)
    await copy(join(p.from, entry.path), join(p.stage, entry.path))
    await syncDirectory(dirname(join(p.stage, entry.path)))
  }
  await verify(p.stage, p.original, p)
}

const entryAt = (manifest, path) => manifest?.find((e) => e.path === path)
async function verifyMember(root, path, expected, inventory) {
  const current = await bundleInventory(root, [path], inventory)
  if (JSON.stringify(current[1]) !== JSON.stringify(expected))
    throw new Error(`Integrity mismatch or missing backup: ${join(root, path)}`)
}

export async function publishBundle(p, save, progress, inventory, syncDirectory) {
  await durableMkdir(p.backup, syncDirectory)
  for (const path of p.files) {
    const before = entryAt(p.original, path)
    const after = entryAt(p.published, path)
    const source = join(p.from, path)
    const backup = join(p.backup, path)
    const staged = join(p.stage, path)
    if (before && !(await inspect(backup))) {
      await verifyMember(p.from, path, before, inventory)
      await durableMkdir(dirname(backup), syncDirectory)
      await rename(source, backup)
      await syncDirectory(dirname(source))
      await syncDirectory(dirname(backup))
      await progress({ phase: 'reference-backed-up', path: source })
    }
    if (await inspect(staged)) {
      if (await inspect(source)) throw new Error(`Reference publication conflict: ${source}`)
      await rename(staged, source)
      await syncDirectory(dirname(staged))
      await syncDirectory(dirname(source))
    }
    await verifyMember(p.to, path, after, inventory)
    await save()
    await progress({ phase: 'reference-published', path: source })
  }
}

export async function verifyBundleRollback(p, status, inventory) {
  for (const path of p.files) {
    const before = entryAt(p.original, path)
    const after = entryAt(p.published, path)
    const backup = await inspect(join(p.backup, path))
    const parked = `${p.stage}.rolled-back`
    if (backup) {
      await verifyMember(p.backup, path, before, inventory)
      if (await inspect(join(parked, path))) await verifyMember(parked, path, after, inventory)
      if (await inspect(join(p.to, path))) await verifyMember(p.to, path, after, inventory)
    } else if (before) {
      const restoring = status === 'rolling-back' && p.restoreIntents?.includes(path)
      if (!restoring && !['preparing', 'prepared', 'publishing'].includes(status))
        throw new Error(`Original backup is missing: ${join(p.backup, path)}`)
      await verifyMember(p.from, path, before, inventory)
      if (restoring && after) await verifyMember(parked, path, after, inventory)
    } else if (await inspect(join(p.to, path))) {
      await verifyMember(p.to, path, after, inventory)
    } else if (after && status === 'committed') {
      throw new Error(`Published reference is missing: ${join(p.to, path)}`)
    } else if (await inspect(join(parked, path))) {
      await verifyMember(parked, path, after, inventory)
    }
  }
}

export async function rollbackBundle(p, save, progress, syncDirectory) {
  const parked = `${p.stage}.rolled-back`
  for (const path of [...p.files].reverse()) {
    const backup = join(p.backup, path)
    const target = join(p.to, path)
    const before = entryAt(p.original, path)
    const after = entryAt(p.published, path)
    const hasBackup = await inspect(backup)
    if (!hasBackup && (before || !after || !(await inspect(target)))) continue
    p.restoreIntents = [...new Set([...(p.restoreIntents ?? []), path])]
    await save()
    if (await inspect(target)) {
      await durableMkdir(dirname(join(parked, path)), syncDirectory)
      if (await inspect(join(parked, path))) throw new Error(`Rollback parking conflict: ${target}`)
      await rename(target, join(parked, path))
      await syncDirectory(dirname(target))
      await syncDirectory(dirname(join(parked, path)))
    }
    await progress({ phase: 'rollback-root-parked', path: target })
    if (hasBackup) {
      await rename(backup, target)
      await syncDirectory(dirname(backup))
      await syncDirectory(dirname(target))
    }
    await progress({ phase: 'rollback-root-restored', path: target })
  }
}

export const isReferenceFile = (path) =>
  Boolean(
    documentKind(path) ||
    databaseFile.test(path) ||
    /^bin[/\\](?:open-science\.cmd|\.open-science-path-(?:receipt|pending))$/.test(path)
  )

// Persist every new ancestor before moving an original into it. A directory's own fsync alone
// does not persist its name in its parent on power loss.
export async function durableMkdir(path, syncDirectory) {
  if (await inspect(path)) return
  await durableMkdir(dirname(path), syncDirectory)
  await mkdir(path, { mode: 0o700 })
  await syncDirectory(dirname(path))
  await syncDirectory(path)
}

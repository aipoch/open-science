import { readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'

import { logicalEnvNameFromDirectory } from '../notebook/runtime-paths'

export type UsageCategoryKey = 'artifacts' | 'uploads' | 'runtime' | 'notebooks' | 'workspaces'
export type UsageChild = { name: string; bytes: number }
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
export type StorageUsage = { categories: UsageCategory[]; totalBytes: number }

const CATEGORY_KEYS: UsageCategoryKey[] = [
  'artifacts',
  'uploads',
  'runtime',
  'notebooks',
  'workspaces'
]

// Recursively sums UNIQUE file sizes under `dir`, deduping hard links by (dev, ino) through `seen`
// (like `du`): a file whose inode was already counted contributes 0. This is essential for the runtime
// dir — conda envs are hard-linked from the shared pkgs cache, so without dedup the same bytes get
// counted in both `conda` and each env, roughly doubling the reported total. Callers that want
// independent buckets pass their own fresh `seen`; the runtime breakdown shares ONE `seen` across
// conda+envs so the shared inodes are attributed to conda (counted first) and not re-counted per env.
// Missing dirs contribute 0; symlinks are skipped (not followed) to avoid cycles and double-counting.
const dirSize = async (dir: string, seen: Set<string>): Promise<number> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(path, seen)
    } else if (entry.isFile()) {
      total += await fileSize(path, seen)
    }
  }
  return total
}

// Size of one file, or 0 if its inode was already counted via `seen` (hard-link dedup).
const fileSize = async (path: string, seen: Set<string>): Promise<number> => {
  const info = await stat(path).catch(() => undefined)
  if (!info) return 0
  const key = `${info.dev}:${info.ino}`
  if (seen.has(key)) return 0
  seen.add(key)
  return info.size
}

// Breaks the runtime dir into meaningful buckets for the Storage panel: `conda` (the shared package
// cache + micromamba root) and one child per conda env under envs/ — with default-python/default-r
// surfaced as `python`/`r` and named envs shown by their name. Sorted descending by bytes; each
// subtree is recursed once. This is why the panel shows conda | python | r rather than one opaque lump.
const RUNTIME_INFRA_DIRS = ['pkgs', 'micromamba']
const ENV_LABELS: Record<string, string> = { 'default-python': 'python', 'default-r': 'r' }
// Transient relocation staging (exported @EXPLICIT locks, consumed by the startup restore). Counted
// toward the runtime total for accuracy, but not surfaced as its own row — it's app plumbing, not
// user data, and is usually 0 B after restore.
const RUNTIME_HIDDEN_DIRS = ['envs.lock']

const runtimeUsage = async (dir: string): Promise<{ bytes: number; children: UsageChild[] }> => {
  const children: UsageChild[] = []
  let looseBytes = 0
  // ONE dedup set across conda + every env: conda is scanned first, so the shared package inodes are
  // attributed to conda and the envs (hard-linked from it) report only their own unique bytes — the
  // sum then matches `du` of the runtime dir instead of double-counting the cache.
  const seen = new Set<string>()

  // conda infrastructure: shared package cache (pkgs) + any downloaded micromamba root.
  let condaBytes = 0
  for (const infra of RUNTIME_INFRA_DIRS) condaBytes += await dirSize(join(dir, infra), seen)
  if (condaBytes > 0) children.push({ name: 'conda', bytes: condaBytes })

  // one child per environment under envs/ (default-python/-r -> python/r, others by name).
  let envEntries
  try {
    envEntries = await readdir(join(dir, 'envs'), { withFileTypes: true })
  } catch {
    envEntries = []
  }
  const envBytes = new Map<string, number>()
  for (const entry of envEntries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const logicalName = logicalEnvNameFromDirectory(entry.name)
    const label = ENV_LABELS[logicalName] ?? logicalName
    const bytes = await dirSize(join(dir, 'envs', entry.name), seen)
    envBytes.set(label, (envBytes.get(label) ?? 0) + bytes)
  }
  for (const [name, bytes] of envBytes) children.push({ name, bytes })

  // loose top-level files (e.g. .env-ready) and any other top-level dirs, so the total stays exact.
  let topEntries
  try {
    topEntries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, children: [] }
  }
  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) continue
    if (entry.isFile()) {
      looseBytes += await fileSize(join(dir, entry.name), seen)
    } else if (
      entry.isDirectory() &&
      entry.name !== 'envs' &&
      !RUNTIME_INFRA_DIRS.includes(entry.name)
    ) {
      const bytes = await dirSize(join(dir, entry.name), seen)
      // Hidden plumbing (e.g. envs.lock) counts toward the total but is not shown as its own row.
      if (RUNTIME_HIDDEN_DIRS.includes(entry.name)) looseBytes += bytes
      else children.push({ name: entry.name, bytes })
    }
  }

  children.sort((a, b) => b.bytes - a.bytes)
  const bytes = looseBytes + children.reduce((sum, child) => sum + child.bytes, 0)
  return { bytes, children }
}

export const computeStorageUsage = async (dataRoot: string): Promise<StorageUsage> => {
  const categories: UsageCategory[] = []
  for (const key of CATEGORY_KEYS) {
    const dir = join(dataRoot, key)
    if (key === 'runtime') {
      const { bytes, children } = await runtimeUsage(dir)
      categories.push({ key, bytes, children })
    } else {
      // Independent bucket: its own dedup set (no hard links cross data-category boundaries).
      categories.push({ key, bytes: await dirSize(dir, new Set()) })
    }
  }
  const totalBytes = categories.reduce((sum, c) => sum + c.bytes, 0)
  return { categories, totalBytes }
}

export const availableBytes = async (targetPath: string): Promise<number> => {
  const stats = await statfs(targetPath)
  return stats.bavail * stats.bsize
}

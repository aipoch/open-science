import type { Dirent } from 'node:fs'
import { readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'

import {
  STORAGE_USAGE_CATEGORY_KEYS,
  type StorageUsage,
  type UsageChild
} from '../../shared/storage'
import { logicalEnvNameFromDirectory } from '../notebook/runtime-paths'

const isMissingPathError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

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
  } catch (error) {
    if (isMissingPathError(error)) return 0
    throw error
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
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return 0
    throw error
  }
  const key = `${info.dev}:${info.ino}`
  if (seen.has(key)) return 0
  seen.add(key)
  return info.size
}

// Session workspaces are intentionally retained after Session/Project deletion. Report each
// top-level directory so Settings can make those opaque UUID folders reachable without inventing
// a Project/Session association that no longer exists. Empty directories remain visible; symlinks
// are skipped rather than followed or offered as workspace roots.
const workspaceUsage = async (dir: string): Promise<{ bytes: number; children: UsageChild[] }> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return { bytes: 0, children: [] }
    throw error
  }

  const seen = new Set<string>()
  const children: UsageChild[] = []
  let looseBytes = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      children.push({ name: entry.name, bytes: await dirSize(path, seen) })
    } else if (entry.isFile()) {
      looseBytes += await fileSize(path, seen)
    }
  }
  children.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
  return {
    bytes: looseBytes + children.reduce((sum, child) => sum + child.bytes, 0),
    children
  }
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
  let envEntries: Dirent[]
  try {
    envEntries = await readdir(join(dir, 'envs'), { withFileTypes: true })
  } catch (error) {
    if (!isMissingPathError(error)) throw error
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
  } catch (error) {
    if (isMissingPathError(error)) return { bytes: 0, children: [] }
    throw error
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
  const categories: StorageUsage['categories'] = []
  for (const key of STORAGE_USAGE_CATEGORY_KEYS) {
    const dir = join(dataRoot, key)
    if (key === 'runtime') {
      const { bytes, children } = await runtimeUsage(dir)
      categories.push({ key, bytes, children })
    } else if (key === 'workspaces') {
      const { bytes, children } = await workspaceUsage(dir)
      categories.push(children.length > 0 ? { key, bytes, children } : { key, bytes })
    } else if (key === 'execution-file-evidence') {
      const seen = new Set<string>()
      const bytes =
        (await dirSize(dir, seen)) + (await dirSize(join(dataRoot, 'notebook-file-evidence'), seen))
      categories.push({ key, bytes })
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

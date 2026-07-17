import { readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'

export type UsageCategoryKey = 'artifacts' | 'uploads' | 'runtime' | 'notebooks'
export type UsageChild = { name: string; bytes: number }
export type UsageCategory = { key: UsageCategoryKey; bytes: number; children?: UsageChild[] }
export type StorageUsage = { categories: UsageCategory[]; totalBytes: number }

const CATEGORY_KEYS: UsageCategoryKey[] = ['artifacts', 'uploads', 'runtime', 'notebooks']

// Recursively sums file sizes under `dir`. Missing dirs contribute 0; symlinks are
// skipped (not followed) to avoid cycles and double-counting.
const dirSize = async (dir: string): Promise<number> => {
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
      total += await dirSize(path)
    } else if (entry.isFile()) {
      total += (await stat(path).catch(() => undefined))?.size ?? 0
    }
  }
  return total
}

// Sizes each top-level subdirectory of `dir` (sorted descending by bytes) plus any loose
// top-level files, deriving the total from those instead of a separate full dirSize(dir) walk
// so each subtree is only recursed once.
const runtimeUsage = async (dir: string): Promise<{ bytes: number; children: UsageChild[] }> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, children: [] }
  }
  const children: UsageChild[] = []
  let looseBytes = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      children.push({ name: entry.name, bytes: await dirSize(path) })
    } else if (entry.isFile()) {
      looseBytes += (await stat(path).catch(() => undefined))?.size ?? 0
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
      categories.push({ key, bytes: await dirSize(dir) })
    }
  }
  const totalBytes = categories.reduce((sum, c) => sum + c.bytes, 0)
  return { categories, totalBytes }
}

export const availableBytes = async (targetPath: string): Promise<number> => {
  const stats = await statfs(targetPath)
  return stats.bavail * stats.bsize
}

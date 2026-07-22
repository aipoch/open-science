import { type Dirent, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { WINDOWS_MAX_USABLE_PATH } from './micromamba-cache'

const COMPLETE_MARKER = join('info', 'repodata_record.json')
const CONDA_SUBDIR = /^(?:noarch|win-64|osx-(?:64|arm64)|linux-(?:64|aarch64|ppc64le|s390x))$/i
const isPackageDistLeaf = (value: string): boolean =>
  /^[A-Za-z0-9_.+-]+-[A-Za-z0-9_.+!]+-[A-Za-z0-9_.+]+$/.test(value)

const entries = (path: string): Dirent[] => {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

const directories = (path: string): Dirent[] => {
  return entries(path).filter((entry) => entry.isDirectory())
}

const removeIfIncomplete = (dir: string): boolean => {
  if (existsSync(join(dir, COMPLETE_MARKER))) return false
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  return true
}

const PACKAGE_TOP_LEVEL_DIRS = new Set([
  'bin',
  'conda-meta',
  'etc',
  'include',
  'info',
  'lib',
  'library',
  'scripts',
  'share'
])

const looksLikeExtractedPackage = (dir: string): boolean =>
  entries(dir).some(
    (entry) => !entry.isDirectory() || PACKAGE_TOP_LEVEL_DIRS.has(entry.name.toLowerCase())
  )

const removeIncompleteUrlLeaves = (urlRoot: string): boolean => {
  const walk = (dir: string): { foundBoundary: boolean; removed: boolean } => {
    let foundBoundary = false
    let removed = false
    for (const entry of directories(dir)) {
      const child = join(dir, entry.name)
      const isCandidate = CONDA_SUBDIR.test(basename(dir)) && isPackageDistLeaf(entry.name)
      if (!isCandidate) {
        const nested = walk(child)
        foundBoundary = nested.foundBoundary || foundBoundary
        removed = nested.removed || removed
        continue
      }

      if (looksLikeExtractedPackage(child)) {
        foundBoundary = true
        removed = removeIfIncomplete(child) || removed
        continue
      }

      // An empty or unfamiliar candidate may be an interrupted package, but a channel path can also
      // contain subdir/dist-shaped segments. Prefer a deeper package boundary when one exists;
      // otherwise the empty candidate itself is the interrupted package leaf.
      const nested = walk(child)
      foundBoundary = true
      removed = nested.foundBoundary
        ? nested.removed || removed
        : removeIfIncomplete(child) || removed
    }
    return { foundBoundary, removed }
  }
  return walk(urlRoot).removed
}

export const removeIncompleteExtractedPackages = (cacheDirs: string[]): boolean => {
  let removed = false
  for (const cacheDir of new Set(cacheDirs.map((dir) => resolve(dir)))) {
    for (const entry of directories(cacheDir)) {
      if (entry.name === 'cache') continue
      const dir = join(cacheDir, entry.name)
      if (/^https?$/i.test(entry.name)) {
        removed = removeIncompleteUrlLeaves(dir) || removed
      } else {
        removed = removeIfIncomplete(dir) || removed
      }
    }
  }
  return removed
}

export type MaxPathRecoveryDeps = {
  platform?: NodeJS.Platform
  canonicalize?: (path: string) => string
  remove?: (path: string) => void
}

const archiveLeaf = (value: string): string | undefined => {
  const leaf = basename(value).replace(/\.(?:conda|tar\.bz2)$/i, '')
  return /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(leaf) ? leaf : undefined
}

const markerMatchesPackageLeaf = (candidate: string, leaf: string): boolean => {
  try {
    const record = JSON.parse(readFileSync(join(candidate, COMPLETE_MARKER), 'utf8')) as Record<
      string,
      unknown
    >
    const fromUrl = typeof record.url === 'string' ? archiveLeaf(record.url) : undefined
    const fromFields =
      typeof record.name === 'string' &&
      typeof record.version === 'string' &&
      typeof record.build === 'string'
        ? `${record.name}-${record.version}-${record.build}`
        : undefined
    return fromUrl === leaf || fromFields === leaf
  } catch {
    return false
  }
}

const containedBy = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

const quotedPaths = (message: string): string[] =>
  [...message.matchAll(/['"]([^'"\r\n]+)['"]/g)].map((match) => match[1])

type CanonicalRoot = { lexical: string; physical: string }

const packageLeafFromEvidence = (
  evidencePath: string,
  roots: CanonicalRoot[],
  expectedLeaf?: string
): { evidence: string; candidate: string; root: CanonicalRoot; leaf: string } | undefined => {
  const evidence = resolve(evidencePath)
  for (const root of roots) {
    if (!containedBy(root.lexical, evidence)) continue
    const parts = relative(root.lexical, evidence).split(sep)
    if (!/^https?$/i.test(parts[0])) continue
    for (let subdirIndex = parts.length - 2; subdirIndex >= 2; subdirIndex -= 1) {
      if (!CONDA_SUBDIR.test(parts[subdirIndex])) continue
      const leaf = archiveLeaf(parts[subdirIndex + 1])
      if (!leaf || (expectedLeaf ? leaf !== expectedLeaf : !isPackageDistLeaf(leaf))) continue
      const candidate = join(root.lexical, ...parts.slice(0, subdirIndex + 2))
      // Proactive cleanup has no diagnostic package name, so bind the candidate to its parsed
      // repodata marker. Reactive recovery already has an exact archive leaf from micromamba and
      // must also handle extraction failures that occurred before the marker was written.
      if (!expectedLeaf && !markerMatchesPackageLeaf(candidate, leaf)) continue
      return { evidence, candidate, root, leaf }
    }
  }
  return undefined
}

export const recoverWindowsMaxPathPackage = (
  error: unknown,
  allowedCacheRoots: string[],
  deps: MaxPathRecoveryDeps = {}
): boolean => {
  if ((deps.platform ?? process.platform) !== 'win32') return false
  const message = error instanceof Error ? error.message : String(error)
  const hasMissingContext =
    /invalid package cache/i.test(message) && /(?:is missing|package cache error)/i.test(message)
  const hasRemoveContext =
    /error when extracting package/i.test(message) &&
    /remove_all[^]*(?:not empty|directory)/i.test(message)
  if (!hasMissingContext && !hasRemoveContext) return false

  const archiveMatch = message.match(/(?:for|cache for)\s+['"]([^'"]+\.(?:conda|tar\.bz2))['"]/i)
  const expectedLeaf = archiveMatch ? archiveLeaf(archiveMatch[1]) : undefined
  const paths = quotedPaths(message).filter((value) => value !== archiveMatch?.[1])
  const canonicalize = deps.canonicalize ?? ((path: string) => realpathSync.native(path))
  const roots = allowedCacheRoots.flatMap((root): CanonicalRoot[] => {
    const lexical = resolve(root)
    try {
      return [{ lexical, physical: canonicalize(lexical) }]
    } catch {
      return []
    }
  })

  for (const evidencePath of paths) {
    const parsed = packageLeafFromEvidence(evidencePath, roots, expectedLeaf)
    if (!parsed) continue

    let physical: string
    try {
      physical = canonicalize(parsed.candidate)
    } catch {
      continue
    }
    if (!containedBy(parsed.root.physical, physical)) continue
    if (parsed.evidence.length <= WINDOWS_MAX_USABLE_PATH) continue

    const remove =
      deps.remove ??
      ((path: string): void =>
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
    remove(physical)
    return true
  }
  return false
}

export type OverBudgetCleanupDeps = Pick<
  MaxPathRecoveryDeps,
  'platform' | 'canonicalize' | 'remove'
>

const containsOverBudgetPath = (dir: string): boolean => {
  for (const entry of entries(dir)) {
    const child = join(dir, entry.name)
    if (child.length > WINDOWS_MAX_USABLE_PATH) return true
    if (entry.isDirectory() && containsOverBudgetPath(child)) return true
  }
  return false
}

// One-time migration cleanup for caches created before the short-cache fix. It examines only the
// URL-derived cache tree and removes only a package leaf that contains a path Windows cannot address
// under the conservative MAX_PATH budget. Flat tarballs and neighboring packages are preserved.
export const removeOverBudgetUrlPackages = (
  cacheDir: string,
  deps: OverBudgetCleanupDeps = {}
): boolean => {
  if ((deps.platform ?? process.platform) !== 'win32') return false
  const lexicalRoot = resolve(cacheDir)
  const canonicalize = deps.canonicalize ?? ((path: string) => realpathSync.native(path))
  let physicalRoot: string
  try {
    physicalRoot = canonicalize(lexicalRoot)
  } catch {
    return false
  }
  const roots: CanonicalRoot[] = [{ lexical: lexicalRoot, physical: physicalRoot }]
  const remove =
    deps.remove ??
    ((path: string): void =>
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  let removed = false

  const walk = (dir: string): void => {
    for (const entry of directories(dir)) {
      const child = join(dir, entry.name)
      const isCandidate = CONDA_SUBDIR.test(basename(dir)) && isPackageDistLeaf(entry.name)
      if (!isCandidate) {
        walk(child)
        continue
      }
      const parsed = packageLeafFromEvidence(child, roots)
      if (!parsed || parsed.candidate !== child || !containsOverBudgetPath(child)) {
        walk(child)
        continue
      }
      let physical: string
      try {
        physical = canonicalize(child)
      } catch {
        continue
      }
      if (!containedBy(physicalRoot, physical)) continue
      remove(physical)
      removed = true
    }
  }
  for (const protocol of ['http', 'https']) walk(join(lexicalRoot, protocol))
  return removed
}

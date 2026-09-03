import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeExplicitLock } from './micromamba'
import {
  envPrefix,
  logicalEnvNameFromDirectory,
  pythonBin,
  rBin,
  runtimeRoot
} from './runtime-paths'

// <root>/envs.lock — per-env @EXPLICIT locks captured for offline reconstruction after a data-root
// relocation. The provisioner's startup restore consumes and then removes this directory.
export const envsLockDir = (root: string): string => join(root, 'envs.lock')

export type ExportRuntimeLocksDeps = {
  // Resolved micromamba binary, or undefined to skip (nothing to preserve without it).
  mm: string | undefined
  // Runs a micromamba argv and returns stdout (for `list --explicit --md5`).
  capture: (argv: string[]) => Promise<string>
  // Injectable for deterministic write-failure coverage.
  writeLock?: (path: string, contents: string) => void
  platform?: NodeJS.Platform
}

// Exports every conda env under <fromDataRoot>/runtime/envs to an @EXPLICIT lock at
// <toDataRoot>/runtime/envs.lock/<name>.lock, so the runtime can be rebuilt OFFLINE at the new root
// from the (separately-copied) pkgs cache instead of copying the non-relocatable env prefixes. This
// preserves conda-installed content exactly; pip/CRAN-only extras aren't conda-tracked and are not
// captured here. The bundle is all-or-nothing for materialized environments: every lock is captured
// and validated before a private staging directory is published, so a failed capture or write can
// never leave a partial envs.lock directory that migration could mistake for complete. Returns the
// names actually exported; empty when micromamba is absent or no env has an interpreter yet.
export const exportRuntimeLocks = async (
  fromDataRoot: string,
  toDataRoot: string,
  deps: ExportRuntimeLocksDeps
): Promise<string[]> => {
  if (!deps.mm) return []

  const fromRuntime = runtimeRoot(fromDataRoot)
  const envsDir = join(fromRuntime, 'envs')
  let entries: Array<{ name: string; prefix: string; canonical: boolean }>
  try {
    entries = readdirSync(envsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const name = logicalEnvNameFromDirectory(entry.name)
        return {
          name,
          prefix: join(envsDir, entry.name),
          canonical: join(envsDir, entry.name) === envPrefix(fromRuntime, name, deps.platform)
        }
      })
  } catch {
    return []
  }
  if (entries.length === 0) return []

  // If a short Windows default and its legacy directory both exist, export only the active short
  // prefix. A legacy-only install is still exported so the new layout can rebuild it without losing
  // user-added conda packages.
  entries.sort((a, b) => Number(b.canonical) - Number(a.canonical))
  const seen = new Set<string>()

  const locks: Array<{ name: string; contents: string }> = []
  for (const { name, prefix } of entries) {
    if (seen.has(name)) continue
    seen.add(name)
    // Skip mid-creation leftovers with no interpreter — nothing to reconstruct.
    if (!existsSync(pythonBin(prefix, deps.platform)) && !existsSync(rBin(prefix, deps.platform)))
      continue
    const raw = await deps.capture([
      deps.mm,
      '--no-rc',
      'list',
      '--prefix',
      prefix,
      '--explicit',
      '--md5'
    ])
    const lock = normalizeExplicitLock(raw)
    if (!/^https?:\/\//m.test(lock)) {
      throw new Error(`Could not preserve ${name}: the exported lock contains no package URLs.`)
    }
    locks.push({ name, contents: lock })
  }
  if (locks.length === 0) return []

  const outDir = envsLockDir(runtimeRoot(toDataRoot))
  const stagingDir = `${outDir}.tmp-${randomUUID()}`
  const writeLock = deps.writeLock ?? ((path, contents) => writeFileSync(path, contents, 'utf8'))
  try {
    mkdirSync(stagingDir, { recursive: true })
    for (const lock of locks) writeLock(join(stagingDir, `${lock.name}.lock`), lock.contents)
    renameSync(stagingDir, outDir)
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
  return locks.map(({ name }) => name)
}

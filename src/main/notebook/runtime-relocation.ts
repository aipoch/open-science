import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
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
  platform?: NodeJS.Platform
}

// Exports every conda env under <fromDataRoot>/runtime/envs to an @EXPLICIT lock at
// <toDataRoot>/runtime/envs.lock/<name>.lock, so the runtime can be rebuilt OFFLINE at the new root
// from the (separately-copied) pkgs cache instead of copying the non-relocatable env prefixes. This
// preserves conda-installed content exactly; pip/CRAN-only extras aren't conda-tracked and are not
// captured here. Best-effort per env: an export failure skips that env (it falls back to default
// provisioning). Returns the names actually exported; empty when micromamba is absent or no env has
// an interpreter yet.
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

  const outDir = envsLockDir(runtimeRoot(toDataRoot))
  const exported: string[] = []
  for (const { name, prefix } of entries) {
    if (seen.has(name)) continue
    seen.add(name)
    // Skip mid-creation leftovers with no interpreter — nothing to reconstruct.
    if (!existsSync(pythonBin(prefix)) && !existsSync(rBin(prefix))) continue
    try {
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
      // A lock with no package URLs can't recreate anything; skip it.
      if (!/^https?:\/\//m.test(lock)) continue
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, `${name}.lock`), lock, 'utf8')
      exported.push(name)
    } catch {
      // best-effort: this env falls back to default provisioning at the new root.
    }
  }
  return exported
}

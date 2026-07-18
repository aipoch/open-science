import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'

// Default environment version; bump when the default package set changes so a newer app triggers an
// additive upgrade of an older user's environments (spec §6.3).
//
// This number also keys the CDN offline bundle path (runtime-bundle/<version>/<subdir>/), which
// stage-runtime-bundle.yml publishes and build.yml injects. When you change the default env spec:
//   1. edit DEFAULT_PYTHON_SPEC / DEFAULT_R_SPEC in provisioner.ts (and the mirrored PY_PKGS / R_PKGS
//      in scripts/stage-default-envs.mjs — a guard test enforces they stay equal);
//   2. re-run the stage-runtime-bundle workflow to (re)publish the bundle for this version. The bundle
//      is uploaded with no-cache, so re-staging the SAME version overwrites it and the next build
//      picks up the new content (no stale-CDN problem). Bump this constant only when you need an
//      already-installed app to re-provision its default envs (additive upgrade, spec §6.3) — not
//      merely to refresh the bundle.
export const DEFAULT_ENV_VERSION = 1

export const DEFAULT_PY_ENV = 'default-python'
export const DEFAULT_R_ENV = 'default-r'

// Local copy of repository.ts's safe-segment rule (not imported, to avoid a cycle): env names
// become a directory name under runtime/envs/, so they must be a safe path segment.
const SAFE_ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Resolves an `environment` request arg to a concrete env name (design D1/D8-shared).
// - Omitted/blank -> the default env for the language.
// - Bare spec-compat alias ("python"/"r") -> the matching default env.
// - Otherwise validated as a safe path segment (rejects empty, traversal, and leading dot/dash).
export const resolveEnvName = (language: NotebookLanguage, environment?: string): string => {
  const trimmed = environment?.trim()
  const fallback = language === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  if (!trimmed) return fallback
  if (trimmed === 'python') return DEFAULT_PY_ENV
  if (trimmed === 'r') return DEFAULT_R_ENV
  if (!SAFE_ENV_NAME_PATTERN.test(trimmed) || trimmed.includes('..')) {
    throw new Error(
      `Invalid environment name "${trimmed}": use letters, digits, dot, underscore, or dash, ` +
        'starting with a letter or digit.'
    )
  }
  return trimmed
}

// Names the user may NOT create/remove: the bare spec aliases ('python'/'r', which resolveEnvName
// maps to the defaults) and the app-baseline default envs themselves.
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  'python',
  'r',
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV
])

// Validates a user-supplied environment name for manage_environments create/remove BEFORE it is
// used to compose runtime/envs/<name> (design D8). Unlike resolveEnvName it never aliases — a
// managed op must name a real, non-reserved env. Throws on missing/empty, path traversal or an
// unsafe segment, or a reserved/default name. This is the single choke point that stops a hostile
// name (e.g. "../../…") from escaping the runtime root into a recursive create/delete.
export const assertSafeEnvName = (name: string | undefined): string => {
  const trimmed = name?.trim()
  if (!trimmed) throw new Error('An environment name is required.')
  if (!SAFE_ENV_NAME_PATTERN.test(trimmed) || trimmed.includes('..')) {
    throw new Error(
      `Invalid environment name "${trimmed}": use letters, digits, dot, underscore, or dash, ` +
        'starting with a letter or digit.'
    )
  }
  if (RESERVED_ENV_NAMES.has(trimmed)) {
    throw new Error(
      `"${trimmed}" is a reserved environment name (managed by the app); choose another name.`
    )
  }
  return trimmed
}

// <storageRoot>/runtime — the shared runtime root holding envs, the pkgs cache and the ready marker.
export const runtimeRoot = (storageRoot: string): string => join(storageRoot, 'runtime')

// <root>/envs/<name> — a single conda env prefix under the runtime root.
export const envPrefix = (root: string, name: string): string => join(root, 'envs', name)

// <root>/pkgs — the shared micromamba package cache (offline seed target; $MAMBA_ROOT_PREFIX/pkgs).
export const pkgsCache = (root: string): string => join(root, 'pkgs')

// conda env layout differs by OS: Unix puts interpreters under <prefix>/bin, Windows puts python.exe
// at the prefix root and console tools under <prefix>\Scripts. These helpers branch on the CURRENT
// platform (read at call time), so darwin/linux are unchanged and Windows resolves the real files.
const isWindows = (): boolean => process.platform === 'win32'

// The Python interpreter inside an env prefix (Unix: <prefix>/bin/python; Windows: <prefix>\python.exe).
export const pythonBin = (prefix: string): string =>
  isWindows() ? join(prefix, 'python.exe') : join(prefix, 'bin', 'python')

// The pip CLI inside an env prefix (Unix: <prefix>/bin/pip; Windows: <prefix>\Scripts\pip.exe).
export const pipBin = (prefix: string): string =>
  isWindows() ? join(prefix, 'Scripts', 'pip.exe') : join(prefix, 'bin', 'pip')

// The R interpreter inside an env prefix. Windows conda-forge r-base installs R under
// <prefix>\Lib\R\bin; the .exe suffix and that layout are the Windows convention (verify on a real
// Windows build — the runtime is macOS-baselined today).
export const rBin = (prefix: string): string =>
  isWindows() ? join(prefix, 'Lib', 'R', 'bin', 'R.exe') : join(prefix, 'bin', 'R')

// The Rscript CLI inside an env prefix (see rBin for the Windows-layout caveat).
export const rScriptBin = (prefix: string): string =>
  isWindows() ? join(prefix, 'Lib', 'R', 'bin', 'Rscript.exe') : join(prefix, 'bin', 'Rscript')

// The env's own R package library (Unix: <prefix>/lib/R/library; Windows: <prefix>\Lib\R\library).
export const rLibraryDir = (prefix: string): string =>
  isWindows() ? join(prefix, 'Lib', 'R', 'library') : join(prefix, 'lib', 'R', 'library')

// <root>/.env-ready — the JSON readiness marker written after a successful provision.
export const readyMarkerPath = (root: string): string => join(root, '.env-ready')

// Readiness marker persisted as camelCase JSON (contract §2).
export type EnvReadyMarker = { defaultEnvVersion: number; preparedAt: string }

// Reads .env-ready; returns undefined when missing or corrupt (never throws).
export const readReadyMarker = (root: string): EnvReadyMarker | undefined => {
  try {
    const parsed = JSON.parse(
      readFileSync(readyMarkerPath(root), 'utf8')
    ) as Partial<EnvReadyMarker>
    if (typeof parsed.defaultEnvVersion !== 'number' || typeof parsed.preparedAt !== 'string') {
      return undefined
    }
    return { defaultEnvVersion: parsed.defaultEnvVersion, preparedAt: parsed.preparedAt }
  } catch {
    return undefined
  }
}

// Writes .env-ready as pretty camelCase JSON, creating the runtime root if needed.
export const writeReadyMarker = (root: string, version: number, preparedAt: string): void => {
  const path = readyMarkerPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const marker: EnvReadyMarker = { defaultEnvVersion: version, preparedAt }
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

// True when a regular file exists at the path (mirrors Rust is_file()).
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Python gate: marker present, version >= expected, and default-python interpreter on disk. This is
// the first-run / app-usable gate that onboarding and the upgrade gate read (spec §4).
export const pythonReady = (root: string, expectedVersion: number): boolean => {
  const marker = readReadyMarker(root)
  if (!marker || marker.defaultEnvVersion < expectedVersion) return false
  return isFile(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
}

// R gate: default-r interpreter on disk. Lazy — never consults the version marker (spec D13/§4).
export const rReady = (root: string): boolean => isFile(rBin(envPrefix(root, DEFAULT_R_ENV)))

// True when a rebuild must clear stale state first: not python-ready for the expected version AND
// something is already on disk (marker present, or either default env prefix exists). Empty root
// (first run) → false → plain provision. (Faithful port of globalenv.rs::needs_rebuild; the
// additive-vs-rebuild decision itself lives in the provisioner's startup gate, Task 6.)
export const needsRepair = (root: string, expectedVersion: number): boolean => {
  if (pythonReady(root, expectedVersion)) return false
  if (readReadyMarker(root) !== undefined) return true
  return existsSync(envPrefix(root, DEFAULT_PY_ENV)) || existsSync(envPrefix(root, DEFAULT_R_ENV))
}

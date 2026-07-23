import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { delimiter, dirname, join, win32 } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'

// Default environment version; bump when the default package set changes so a newer app triggers an
// additive upgrade of an older user's environments (spec §6.3).
//
// This number also keys the immutable CDN bundle path (runtime-bundle/<version>/<subdir>/), which
// stage-runtime-bundle.yml publishes and packaged apps fetch on demand. When the default env spec or
// its solved transitive dependency set changes:
//   1. edit DEFAULT_PYTHON_SPEC / DEFAULT_R_SPEC in provisioner.ts and the mirrored floorPackages in
//      scripts/stage-default-envs.mjs (a guard test enforces their package names stay equal);
//   2. bump this constant;
//   3. run stage-runtime-bundle with the matching explicit version before releasing the app. A
//      deliberate republish replaces that version, and build.yml verifies the matching platform
//      manifest is live before packaging an installer.
export const DEFAULT_ENV_VERSION = 1

export const DEFAULT_RUNTIME_CDN_BASE = 'https://statics.aipoch.com/open-science'

// The runtime bundle publisher and consumer must agree on the conda platform segment. Keep this
// mapping here rather than letting each caller infer a CDN key independently.
export const runtimeSubdir = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string => {
  if (platform === 'darwin' && arch === 'arm64') return 'osx-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'osx-64'
  if (platform === 'linux' && arch === 'x64') return 'linux-64'
  if (platform === 'win32' && arch === 'x64') return 'win-64'
  // Only the four subdirs above are staged/published by stage-runtime-bundle.yml. linux-aarch64 (and
  // win32/arm64) are NOT — so reject them here with a clear "unsupported" error at resolution time,
  // rather than mapping to a subdir whose CDN fetch would 404 and look like a transient outage.
  throw new Error(`Unsupported notebook runtime platform: ${platform}/${arch}`)
}

export const resolveRuntimeCdnBase = (override?: string): string => {
  const value = override ?? process.env.OPEN_SCIENCE_ENV_CDN_BASE ?? DEFAULT_RUNTIME_CDN_BASE
  return value.replace(/\/+$/, '')
}

export const DEFAULT_PY_ENV = 'default-python'
export const DEFAULT_R_ENV = 'default-r'

const WINDOWS_DEFAULT_ENV_DIRECTORIES: Readonly<Record<string, string>> = {
  [DEFAULT_PY_ENV]: '.p',
  [DEFAULT_R_ENV]: '.r'
}

const windowsDefaultEnvNamesByDirectory = new Map(
  Object.entries(WINDOWS_DEFAULT_ENV_DIRECTORIES).map(([name, directory]) => [directory, name])
)

// Logical environment names are part of notebook state and the tool interface. On Windows the two
// app-managed defaults use short, reserved physical directory names so their descriptive logical
// names do not consume the environment's MAX_PATH budget. User-created names cannot start with a
// dot, so these directories cannot collide with a named environment.
export const envDirectoryName = (
  name: string,
  platform: NodeJS.Platform = process.platform
): string => (platform === 'win32' ? (WINDOWS_DEFAULT_ENV_DIRECTORIES[name] ?? name) : name)

export const logicalEnvNameFromDirectory = (directory: string): string =>
  windowsDefaultEnvNamesByDirectory.get(directory.toLowerCase()) ?? directory

export const runtimePackDir = (
  root: string,
  envVersion: number,
  subdir: string,
  id: string
): string => join(root, 'packs', String(envVersion), subdir, id)

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

// A conda environment prefix under the runtime root. Callers use logical names; this is the sole seam
// that maps them to physical directories. The platform argument keeps the Windows mapping directly
// testable on non-Windows hosts.
export const envPrefix = (
  root: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string => {
  const physical = join(root, 'envs', envDirectoryName(name, platform))
  if (platform !== 'win32' || (name !== DEFAULT_PY_ENV && name !== DEFAULT_R_ENV)) return physical

  const legacy = join(root, 'envs', name)
  const marker = name === DEFAULT_PY_ENV ? readReadyMarker(root) : readRReadyMarker(root)
  const committedDirectory = marker?.prefixDirectory?.toLowerCase()
  const shortDirectory = envDirectoryName(name, 'win32')
  // Marker provenance distinguishes a committed short prefix from a partial short directory left
  // beside a committed legacy environment. Markers written before provenance was introduced belong
  // to the legacy layout, because no released build could have committed the reserved short names.
  if (existsSync(physical) && committedDirectory === shortDirectory) return physical

  // Preserve a committed Python environment so an app update never drops pip/conda additions merely
  // to shorten its path. A failed create has no marker and therefore retries at the short prefix. This
  // function reads live filesystem state; callers must not cache its result across provisioning steps.
  if (
    name === DEFAULT_PY_ENV &&
    marker !== undefined &&
    (committedDirectory === undefined || committedDirectory === name) &&
    existsSync(join(legacy, 'python.exe'))
  )
    return legacy
  // Legacy R predates its dedicated marker. Keep any materialized prefix and let the existing
  // activated verify/upgrade-or-rebuild path decide whether it is healthy.
  if (
    name === DEFAULT_R_ENV &&
    (committedDirectory === undefined || committedDirectory === name) &&
    existsSync(join(legacy, 'Lib', 'R', 'bin', 'R.exe'))
  )
    return legacy
  // With no committed legacy environment, an existing partial short prefix remains authoritative so
  // repair resumes in the new layout instead of creating a second prefix.
  return physical
}

// The pre-shortening prefix is used only for best-effort migration cleanup/export. Never provision a
// new default into this location.
export const legacyDefaultEnvPrefix = (
  root: string,
  name: typeof DEFAULT_PY_ENV | typeof DEFAULT_R_ENV
): string => join(root, 'envs', name)

// Relative reserve from the data root through the deepest default prefix, including the separator
// before a package-relative path. The picker and provisioner share envPrefix(), so this helper keeps
// preflight arithmetic aligned with the physical Windows layout.
export const windowsDefaultEnvPrefixReserve = (): number =>
  Math.max(
    win32.join('runtime', 'envs', envDirectoryName(DEFAULT_PY_ENV, 'win32')).length,
    win32.join('runtime', 'envs', envDirectoryName(DEFAULT_R_ENV, 'win32')).length
  ) + 1

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

// Conda activation prepends more than <prefix>\bin on Windows. Native R links BLAS/LAPACK and other
// runtime DLLs from Library\bin, so starting R.exe with the host PATH alone fails with 0xC0000135.
// Keep the order aligned with conda's Windows activator; POSIX retains the existing <prefix>/bin
// behavior. Platform is injectable so the exact Windows contract is testable on non-Windows hosts.
export const condaActivatedPath = (
  prefix: string,
  inheritedPath = '',
  platform: NodeJS.Platform = process.platform
): string => {
  const entries =
    platform === 'win32'
      ? [
          win32.normalize(prefix),
          win32.join(prefix, 'Library', 'mingw-w64', 'bin'),
          win32.join(prefix, 'Library', 'usr', 'bin'),
          win32.join(prefix, 'Library', 'bin'),
          win32.join(prefix, 'Scripts'),
          win32.join(prefix, 'bin')
        ]
      : [join(prefix, 'bin')]
  if (inheritedPath) entries.push(inheritedPath)
  return entries.join(platform === 'win32' ? ';' : delimiter)
}

// <root>/.env-ready — the JSON readiness marker written after a successful provision.
export const readyMarkerPath = (root: string): string => join(root, '.env-ready')
export const rReadyMarkerPath = (root: string): string => join(root, '.r-env-ready')

// Readiness marker persisted as camelCase JSON (contract §2). prefixDirectory is optional for backward
// compatibility; on Windows, an absent value denotes a marker from the legacy default directory.
export type EnvReadyMarker = {
  defaultEnvVersion: number
  preparedAt: string
  prefixDirectory?: string
}

// Reads .env-ready; returns undefined when missing or corrupt (never throws).
export const readReadyMarker = (root: string): EnvReadyMarker | undefined => {
  try {
    const parsed = JSON.parse(
      readFileSync(readyMarkerPath(root), 'utf8')
    ) as Partial<EnvReadyMarker>
    if (typeof parsed.defaultEnvVersion !== 'number' || typeof parsed.preparedAt !== 'string') {
      return undefined
    }
    return {
      defaultEnvVersion: parsed.defaultEnvVersion,
      preparedAt: parsed.preparedAt,
      ...(typeof parsed.prefixDirectory === 'string'
        ? { prefixDirectory: parsed.prefixDirectory }
        : {})
    }
  } catch {
    return undefined
  }
}

// Atomically writes a ready marker (temp file + rename) so a crash mid-write can never leave a torn
// marker that reads as neither present-and-valid nor absent — the restore path treats a marker write as
// a commit point, so it must be all-or-nothing. Throws on failure (the caller decides whether that means
// "keep the existing env" rather than rebuilding).
const writeMarkerAtomic = (path: string, marker: EnvReadyMarker): void => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

// Writes .env-ready as pretty camelCase JSON, creating the runtime root if needed.
export const writeReadyMarker = (
  root: string,
  version: number,
  preparedAt: string,
  prefixDirectory?: string
): void => {
  writeMarkerAtomic(readyMarkerPath(root), {
    defaultEnvVersion: version,
    preparedAt,
    ...(prefixDirectory === undefined ? {} : { prefixDirectory })
  })
}

export const readRReadyMarker = (root: string): EnvReadyMarker | undefined => {
  try {
    const parsed = JSON.parse(
      readFileSync(rReadyMarkerPath(root), 'utf8')
    ) as Partial<EnvReadyMarker>
    if (typeof parsed.defaultEnvVersion !== 'number' || typeof parsed.preparedAt !== 'string') {
      return undefined
    }
    return {
      defaultEnvVersion: parsed.defaultEnvVersion,
      preparedAt: parsed.preparedAt,
      ...(typeof parsed.prefixDirectory === 'string'
        ? { prefixDirectory: parsed.prefixDirectory }
        : {})
    }
  } catch {
    return undefined
  }
}

export const writeRReadyMarker = (
  root: string,
  version: number,
  preparedAt: string,
  prefixDirectory?: string
): void => {
  writeMarkerAtomic(rReadyMarkerPath(root), {
    defaultEnvVersion: version,
    preparedAt,
    ...(prefixDirectory === undefined ? {} : { prefixDirectory })
  })
}

// True when a regular file exists at the path (mirrors Rust is_file()).
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// Registry of runtimes flagged "repair-required" by crash recovery: an env whose package install was
// interrupted (killed mid-conda/pip) may be half-applied, so it must NOT be silently trusted. Keyed by
// runtimeId (envId = the interpreter's real path or a managed env prefix), it is consulted when a
// binding resolves so the runtime surfaces as unavailable/repair-required, and cleared once a fresh
// install of that runtime completes (re-installing IS the repair). A single JSON file under the runtime
// root covers managed AND external runtimes without writing into a user's own environment.
export const repairRegistryPath = (root: string): string => join(root, '.repair-required.json')

export const readRepairRequired = (root: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(repairRegistryPath(root), 'utf8'))
    const ids = (parsed as { runtimeIds?: unknown })?.runtimeIds
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export const isRepairRequired = (root: string, runtimeId: string): boolean =>
  readRepairRequired(root).includes(runtimeId)

const writeRepairRequired = (root: string, ids: string[]): void => {
  mkdirSync(dirname(repairRegistryPath(root)), { recursive: true })
  writeFileSync(
    repairRegistryPath(root),
    `${JSON.stringify({ runtimeIds: [...new Set(ids)] }, null, 2)}\n`,
    'utf8'
  )
}

export const addRepairRequired = (root: string, runtimeId: string): void => {
  const ids = readRepairRequired(root)
  if (!ids.includes(runtimeId)) writeRepairRequired(root, [...ids, runtimeId])
}

export const clearRepairRequired = (root: string, runtimeId: string): void => {
  const ids = readRepairRequired(root)
  if (ids.includes(runtimeId))
    writeRepairRequired(
      root,
      ids.filter((id) => id !== runtimeId)
    )
}

// Python gate: marker present, version >= expected, and default-python interpreter on disk. This is
// the first-run / app-usable gate that onboarding and the upgrade gate read (spec §4).
export const pythonReady = (root: string, expectedVersion: number): boolean => {
  const marker = readReadyMarker(root)
  if (!marker || marker.defaultEnvVersion < expectedVersion) return false
  return isFile(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
}

// R gate: current-version marker plus the default-r interpreter. It remains lazy because no marker
// exists until R is explicitly provisioned, but unlike a bin-only check it cannot strand an old R
// baseline after DEFAULT_ENV_VERSION changes.
export const rMaterialized = (root: string): boolean => isFile(rBin(envPrefix(root, DEFAULT_R_ENV)))

export const rReady = (root: string, expectedVersion: number = DEFAULT_ENV_VERSION): boolean => {
  const marker = readRReadyMarker(root)
  return Boolean(marker && marker.defaultEnvVersion >= expectedVersion && rMaterialized(root))
}

// True when a rebuild must clear stale state first: not python-ready for the expected version AND
// something is already on disk (marker present, or either default env prefix exists). Empty root
// (first run) → false → plain provision. (Faithful port of globalenv.rs::needs_rebuild; the
// additive-vs-rebuild decision itself lives in the provisioner's startup gate, Task 6.)
export const needsRepair = (root: string, expectedVersion: number): boolean => {
  if (pythonReady(root, expectedVersion)) return false
  if (readReadyMarker(root) !== undefined) return true
  return existsSync(envPrefix(root, DEFAULT_PY_ENV)) || existsSync(envPrefix(root, DEFAULT_R_ENV))
}

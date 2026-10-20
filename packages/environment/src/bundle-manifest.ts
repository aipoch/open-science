import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'

// Client side of the split language-pack download protocol
// (docs/internal/2026-07-18-split-language-pack-download-protocol.md), extended for CURATED
// MULTI-VERSION packs. The CDN publishes, per (envVersion, subdir), a shared manifest.json plus one
// self-contained pack per curated interpreter version (Python 3.11/3.12/3.13, R 4.3/4.4) — so the app
// fetches ONLY the language+version the user chose and verifies it against the manifest, instead of a
// single combined bundle. This module is pure/injectable so it unit-tests without network or
// filesystem coupling.

// Short language selector used to compose pack ids + CDN keys.
export type PackLanguage = 'python' | 'r'

// The manifest schema version this build understands. Bump when the manifest shape changes.
export const SUPPORTED_SCHEMA = 1

// Conservative values used only for old manifests that predate per-pack path metadata. New staged
// win-64 manifests carry exact values derived from package contents.
export const DEFAULT_MAX_CACHE_RELATIVE_PATH = 225
export const DEFAULT_MAX_ENV_RELATIVE_PATH = 138
export const PACK_PATH_BUDGET_FILE = 'path-budget.json'

// A pack id is `<language>-<version>` (e.g. "python-3.11", "r-4.3"). It keys both the manifest.packs
// map and (with the file extension) the on-CDN pack object. Single source of truth for the format so
// staging, manifest parsing and the fetch helper cannot drift.
export const packId = (language: PackLanguage, version: string): string => `${language}-${version}`

// One self-contained pack archive file for a pack id. The archive contains the pack's @EXPLICIT lock
// and the exact package tarballs that lock references.
export const packArchiveFile = (language: PackLanguage, version: string): string =>
  `${packId(language, version)}.tar.zst`

// One curated pack's entry in the manifest. `sha256`/`size` are the integrity + progress fields for
// the self-contained pack archive `file`. `language`/`version` let the client filter the curated
// matrix without parsing the key.
export type PackEntry = {
  language: PackLanguage
  version: string
  file: string
  sha256: string
  size: number
  maxCacheRelativePath?: number
  maxEnvRelativePath?: number
}

export type PackPathBudget = {
  maxCacheRelativePath: number
  maxEnvRelativePath: number
}

// manifest.json, one per (envVersion, subdir). `schema` guards the shape, `envVersion` must equal the
// runtime's DEFAULT_ENV_VERSION, and the CDN path segment (not the body) carries the conda subdir.
// `packs` is keyed by packId (`<language>-<version>`).
export type BundleManifest = {
  schema: number
  envVersion: number
  subdir: string
  packs: Record<string, PackEntry>
}

// A sha256 (or the lock's per-tarball md5) is 64 hex chars; reject anything else so a truncated or
// garbled digest can't pass verification.
const SHA256_HEX = /^[0-9a-f]{64}$/i

const LANGUAGES: ReadonlySet<string> = new Set<PackLanguage>(['python', 'r'])

// Validates a single pack entry in place; throws with a field-scoped message so a malformed manifest
// fails loudly (fail-closed) rather than silently provisioning from a corrupt descriptor. Also
// asserts the map key equals `<language>-<version>` so the id can never disagree with its entry.
const assertPackEntry = (id: string, entry: unknown): PackEntry => {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`manifest pack "${id}" must be an object`)
  }
  const e = entry as Record<string, unknown>
  if (typeof e.language !== 'string' || !LANGUAGES.has(e.language)) {
    throw new Error(`manifest pack "${id}" has an invalid "language"`)
  }
  if (typeof e.version !== 'string' || e.version.length === 0) {
    throw new Error(`manifest pack "${id}" is missing a "version"`)
  }
  if (typeof e.sha256 !== 'string' || !SHA256_HEX.test(e.sha256)) {
    throw new Error(`manifest pack "${id}" has a malformed "sha256"`)
  }
  if (typeof e.size !== 'number' || !Number.isFinite(e.size) || e.size < 0) {
    throw new Error(`manifest pack "${id}" has a malformed "size"`)
  }
  for (const field of ['maxCacheRelativePath', 'maxEnvRelativePath'] as const) {
    if (
      e[field] !== undefined &&
      (typeof e[field] !== 'number' || !Number.isSafeInteger(e[field]) || e[field] <= 0)
    ) {
      throw new Error(`manifest pack "${id}" has an invalid "${field}"`)
    }
  }
  const hasCacheBudget = e.maxCacheRelativePath !== undefined
  const hasEnvBudget = e.maxEnvRelativePath !== undefined
  if (hasCacheBudget !== hasEnvBudget) {
    throw new Error(`manifest pack "${id}" path budget fields must be provided together`)
  }
  const language = e.language as PackLanguage
  if (packId(language, e.version) !== id) {
    throw new Error(
      `manifest pack "${id}" key does not match its language/version (${language}-${e.version})`
    )
  }
  if (e.file !== packArchiveFile(language, e.version)) {
    throw new Error(`manifest pack "${id}" must use its canonical archive filename`)
  }
  const maxCacheRelativePath =
    typeof e.maxCacheRelativePath === 'number' ? e.maxCacheRelativePath : undefined
  const maxEnvRelativePath =
    typeof e.maxEnvRelativePath === 'number' ? e.maxEnvRelativePath : undefined
  return {
    language,
    version: e.version,
    file: e.file,
    sha256: e.sha256,
    size: e.size,
    ...(maxCacheRelativePath === undefined ? {} : { maxCacheRelativePath }),
    ...(maxEnvRelativePath === undefined ? {} : { maxEnvRelativePath })
  }
}

// Converts a manifest entry into a usable budget. Both fields are required together; for old
// manifests, only the currently managed default packs receive a conservative known fallback.
export const pathBudgetForPack = (entry: PackEntry): PackPathBudget | undefined => {
  if ((entry.maxCacheRelativePath === undefined) !== (entry.maxEnvRelativePath === undefined)) {
    return undefined
  }
  if (entry.maxCacheRelativePath !== undefined && entry.maxEnvRelativePath !== undefined) {
    return {
      maxCacheRelativePath: entry.maxCacheRelativePath,
      maxEnvRelativePath: entry.maxEnvRelativePath
    }
  }
  if (
    (entry.language === 'python' && entry.version === '3.12') ||
    (entry.language === 'r' && entry.version === '4.4')
  ) {
    return {
      maxCacheRelativePath: DEFAULT_MAX_CACHE_RELATIVE_PATH,
      maxEnvRelativePath: DEFAULT_MAX_ENV_RELATIVE_PATH
    }
  }
  return undefined
}

// Parses + strictly validates manifest.json text. Throws on any missing/ill-typed field so the caller
// can reject the source without ever solving the managed default online. An empty packs map is
// rejected — a manifest that names no packs is useless.
export const parseManifest = (json: string): BundleManifest => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('manifest must be a JSON object')
  }
  const m = raw as Record<string, unknown>
  if (typeof m.schema !== 'number' || !Number.isInteger(m.schema)) {
    throw new Error('manifest is missing an integer "schema"')
  }
  if (typeof m.envVersion !== 'number' || !Number.isInteger(m.envVersion)) {
    throw new Error('manifest is missing an integer "envVersion"')
  }
  if (typeof m.subdir !== 'string' || m.subdir.length === 0 || /[^a-z0-9-]/.test(m.subdir)) {
    throw new Error('manifest is missing a valid "subdir"')
  }
  if (typeof m.packs !== 'object' || m.packs === null) {
    throw new Error('manifest is missing a "packs" object')
  }
  const rawPacks = m.packs as Record<string, unknown>
  const ids = Object.keys(rawPacks)
  if (ids.length === 0) {
    throw new Error('manifest "packs" is empty')
  }
  const packs: Record<string, PackEntry> = {}
  for (const id of ids) {
    packs[id] = assertPackEntry(id, rawPacks[id])
  }
  return { schema: m.schema, envVersion: m.envVersion, subdir: m.subdir, packs }
}

// The curated versions published for one language, ascending (numeric-aware). Powers a "choose your
// interpreter version" picker without the client hardcoding the matrix.
export const listVersions = (manifest: BundleManifest, language: PackLanguage): string[] =>
  Object.values(manifest.packs)
    .filter((p) => p.language === language)
    .map((p) => p.version)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

// Resolves the single pack entry for the (language, version) the user chose — the "fetch only the
// chosen pack" choke point. Returns undefined when that version was not published.
export const resolvePack = (
  manifest: BundleManifest,
  language: PackLanguage,
  version: string
): PackEntry | undefined => manifest.packs[packId(language, version)]

// Injectable dependencies for verifyPackChecksum so tests can supply a fake hasher; production uses
// the streaming sha256File default.
export type VerifyDeps = {
  sha256?: (path: string) => Promise<string>
}

// Streams a file through sha256 and returns the lowercase hex digest (the pack file's sha256 is the
// manifest's primary integrity check).
export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })

// Verifies a downloaded pack against its manifest entry (fail-closed). Checks byte length first when
// `size` is given (a cheap pre-check that catches a truncated download without hashing), then streams
// the whole file through sha256 and compares. Throws on any mismatch so the caller drops the partial
// pack and reports an actionable provisioning error.
//
// Defense-in-depth (INTENTIONAL — do not "optimize" into a size-only check): the resilient download
// core already verifies sha256 inline while streaming, but this independent post-download re-hash is a
// required, separate integrity gate per the plan. It catches corruption that inline hashing cannot —
// a bad disk sector or another process mutating the file between the core's rename and extraction —
// on a runtime the app will execute. The extra full-file read is a deliberate correctness/perf
// tradeoff for a large, long-lived, executed artifact, not redundant work.
export const verifyPackChecksum = async (
  filePath: string,
  expected: { sha256: string; size?: number },
  deps: VerifyDeps = {}
): Promise<void> => {
  if (typeof expected.size === 'number') {
    const actualSize = statSync(filePath).size
    if (actualSize !== expected.size) {
      throw new Error(`size mismatch for ${filePath}: expected ${expected.size}, got ${actualSize}`)
    }
  }
  const sha256Of = deps.sha256 ?? sha256File
  const actual = await sha256Of(filePath)
  if (actual.toLowerCase() !== expected.sha256.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${filePath}: expected ${expected.sha256}, got ${actual}`)
  }
}

// CDN key for the shared manifest: runtime-bundle/<envVersion>/<subdir>/manifest.json.
export const manifestUrl = (cdnBase: string, version: number, subdir: string): string =>
  `${cdnBase}/runtime-bundle/${version}/${subdir}/manifest.json`

// CDN key for one pack object: runtime-bundle/<envVersion>/<subdir>/<file>, where `file` is the
// manifest entry's `file` (e.g. "python-3.11.tar.zst").
export const packUrl = (cdnBase: string, version: number, subdir: string, file: string): string =>
  `${cdnBase}/runtime-bundle/${version}/${subdir}/${file}`

#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Builds the packaged CURATED MULTI-VERSION language packs for offline first-run. Instead of a single
// combined bundle it stages one minimal pack per curated interpreter version:
//   resources/default-envs/<packId>.tar.zst      (self-contained pack archive)
//   resources/default-envs/manifest.json         (schema + envVersion + per-pack sha256/size)
//
// Each pack is the MINIMAL kernel-protocol floor for its version — NOT the full scientific stack (that
// installs on demand later): Python -> [python=<v>, matplotlib-base, nomkl]; R -> [r-base=<v>,
// r-jsonlite] (mirrors BASE_PYTHON_PACKAGES / BASE_R_PACKAGES in provisioner.ts). The lock is built
// from a micromamba `create --dry-run --json` solve's actions.LINK (the COMPLETE resolved env) — NOT
// actions.FETCH, which is only the subset the runner still needs to download (empty on a warm cache).
// Solving with an explicit --platform lets a single host stage ANY subdir (e.g. osx-64 on an Apple
// runner) — the dry-run never links/executes foreign-arch binaries.
//
// Requires micromamba on PATH or MICROMAMBA_BIN; if absent it prints guidance and exits 0 (non-fatal),
// so non-packaging builds still succeed. CDN upload is done by stage-runtime-bundle.yml.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createPackArchive } from './pack-archive.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUT = join(SCRIPT_DIR, '..', 'resources', 'default-envs')
const PKGS = join(OUT, 'pkgs')
const CHANNEL = 'conda-forge'
const MANIFEST_SCHEMA = 1

// Curated interpreter versions we publish a pack for. Single source of truth — edit here to add/drop a
// version (then re-run the stage-runtime-bundle workflow to publish the new matrix).
export const VERSIONS = {
  python: ['3.11', '3.12', '3.13'],
  r: ['4.3', '4.4']
}

// The minimal kernel-protocol floor for a (language, version), version-pinned. Python: matplotlib
// backs figure capture, nomkl avoids Intel MKL. R: r-jsonlite implements the loop's JSON framing.
// Package NAMES mirror BASE_PYTHON_PACKAGES / BASE_R_PACKAGES in provisioner.ts (a guard test enforces
// the names stay equal); only the version pin is added here.
export const floorPackages = (language, version) =>
  language === 'python'
    ? [`python=${version}`, 'matplotlib-base', 'nomkl']
    : [`r-base=${version}`, 'r-jsonlite']

// packId = `<language>-<version>` (mirrors bundle-manifest.ts::packId). Keys the lock filename,
// the CDN object and the manifest.packs map.
export const packId = (language, version) => `${language}-${version}`

// The self-contained archive file staged/published for one pack.
export const packArchiveFile = (language, version) => `${packId(language, version)}.tar.zst`

const nativeSubdir = () => {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'osx-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'osx-64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-64'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-aarch64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-64'
  throw new Error(`unsupported staging platform ${process.platform}/${process.arch}`)
}

// The full staging matrix: one descriptor per curated (language, version).
export const packMatrix = () =>
  Object.entries(VERSIONS).flatMap(([language, versions]) =>
    versions.map((version) => ({
      id: packId(language, version),
      language,
      version,
      packages: floorPackages(language, version)
    }))
  )

// argv for a dry-run solve of one pack against a target subdir. Empty platform = the host's native
// subdir. Exported so a test can assert it carries --platform + the version-pinned floor.
export const solveArgv = (prefix, packages, platform) => [
  'create',
  '--dry-run',
  '--json',
  '--prefix',
  prefix,
  '-y',
  '-c',
  CHANNEL,
  ...(platform ? ['--platform', platform] : []),
  ...packages
]

// Builds an @EXPLICIT lock from a solved `create --dry-run --json` result. Uses actions.LINK — the
// COMPLETE resolved environment — rather than actions.FETCH (only the not-yet-cached subset, empty on
// a warm cache). Every LINK entry must carry a url + md5, else the lock would be incomplete/unverifiable
// so we throw. Throws on an empty LINK (a solve that resolved no packages).
export const buildLockFromSolve = (solved) => {
  const link = (solved && solved.actions && solved.actions.LINK) || []
  if (link.length === 0) {
    throw new Error('solve produced no LINK actions (empty resolved environment)')
  }
  const lines = link.map((pkg) => {
    const url = pkg && pkg.url
    const md5 = pkg && pkg.md5
    if (!url || !md5) {
      throw new Error(
        `LINK entry missing url/md5: ${JSON.stringify({ name: pkg && pkg.name, url, md5 })}`
      )
    }
    return `${url}#${md5}`
  })
  return '@EXPLICIT\n' + lines.join('\n') + '\n'
}

// The tarball filenames referenced by an @EXPLICIT lock (basename of each package URL).
export const packageFilesFromLock = (lockText) =>
  lockText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((l) => {
      const url = l.split('#')[0]
      return url.slice(url.lastIndexOf('/') + 1)
    })

// The { url, file, md5 } entries referenced by an @EXPLICIT lock — url is the full download URL (md5
// stripped), file its basename, md5 the trailing digest. Used to fetch + verify tarballs from the lock.
export const packageEntriesFromLock = (lockText) =>
  lockText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((l) => {
      const [url, md5] = l.split('#')
      return { url, file: url.slice(url.lastIndexOf('/') + 1), md5: md5 ?? '' }
    })

// Derives the two Windows path budgets from the exact URL-mirror layout and every file in each
// package. Relative values include their leading separator so callers can add them directly to an
// absolute cache/env prefix length.
export const derivePackPathBudget = (lockText, packageContents) => {
  let maxCacheRelativePath = 0
  let maxEnvRelativePath = 0
  for (const { url, file } of packageEntriesFromLock(lockText)) {
    const contents = packageContents[file]
    if (!contents) throw new Error(`missing package contents for ${file}`)
    const parsed = new URL(url)
    const urlSegments = parsed.pathname.split('/').filter(Boolean)
    const packageName = file.replace(/\.conda$|\.tar\.bz2$/i, '')
    const cachePrefix = ['https', parsed.host, ...urlSegments.slice(0, -1), packageName]
      .join('\\')
      .replace(/^/, '\\')
    for (const internal of contents) {
      const normalized = String(internal).replaceAll('/', '\\').replace(/^\\+/, '')
      maxCacheRelativePath = Math.max(maxCacheRelativePath, `${cachePrefix}\\${normalized}`.length)
      maxEnvRelativePath = Math.max(maxEnvRelativePath, `\\${normalized}`.length)
    }
  }
  if (maxCacheRelativePath === 0 || maxEnvRelativePath === 0) {
    throw new Error('cannot derive path budget from an empty package set')
  }
  return { maxCacheRelativePath, maxEnvRelativePath }
}

const listFiles = (root) => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full.slice(root.length + 1).replaceAll('\\', '/'))
    }
  }
  walk(root)
  return files
}

// micromamba's package extractor understands both .conda and .tar.bz2. Staging runs this only once
// per package in the release workflow; the resulting list is discarded after budget derivation.
const inspectPackage = (mm, archive) => {
  const destination = mkdtempSync(join(tmpdir(), 'os-pack-inspect-'))
  try {
    execFileSync(mm, ['package', 'extract', archive, destination], {
      stdio: 'ignore',
      maxBuffer: 16 * 1024 * 1024
    })
    return listFiles(destination)
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

const md5FileSync = (path) => createHash('md5').update(readFileSync(path)).digest('hex')

// Asserts every tarball a lock references exists in pkgsDir with a matching md5 (the per-pack
// completeness gate). Throws on a missing file or checksum mismatch so an incomplete/corrupt pack is
// never considered staged. `exists`/`md5` are injectable so tests need no real files.
export const verifyBundleComplete = (lockText, pkgsDir, deps = {}) => {
  const exists = deps.exists ?? ((p) => existsSync(p))
  const md5Of = deps.md5 ?? md5FileSync
  for (const { file, md5 } of packageEntriesFromLock(lockText)) {
    const dest = join(pkgsDir, file)
    if (!exists(dest)) {
      throw new Error(`incomplete pack: missing tarball ${file} in ${pkgsDir}`)
    }
    if (md5) {
      const actual = md5Of(dest)
      if (actual !== md5) {
        throw new Error(`corrupt pack: md5 mismatch for ${file}: expected ${md5}, got ${actual}`)
      }
    }
  }
}

// Reads DEFAULT_ENV_VERSION straight from runtime-paths.ts (no import of the built app) so the manifest
// always matches what the app fetches at runtime — same technique build.yml/stage-runtime-bundle.yml use.
export const readDefaultEnvVersion = () => {
  const src = readFileSync(
    join(SCRIPT_DIR, '..', 'src', 'main', 'notebook', 'runtime-paths.ts'),
    'utf8'
  )
  const m = src.match(/DEFAULT_ENV_VERSION\s*=\s*(\d+)/)
  if (!m) throw new Error('could not read DEFAULT_ENV_VERSION from runtime-paths.ts')
  return Number(m[1])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Downloads a URL to destPath (public conda-forge archives; content-addressed, so deterministic).
// conda.anaconda.org rate-limits bulk unauthenticated downloads, so parallel platform jobs routinely
// see HTTP 429. Retry transient 429/5xx (and network errors) with capped exponential backoff, honoring
// Retry-After, so a transient throttle doesn't fail the whole staging run.
const download = async (url, destPath, attempts = 6) => {
  for (let attempt = 1; ; attempt += 1) {
    let res
    try {
      res = await fetch(url)
    } catch (err) {
      if (attempt >= attempts) throw err
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)))
      continue
    }
    if (res.ok) {
      writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
      return
    }
    const retriable = res.status === 429 || res.status >= 500
    if (!retriable || attempt >= attempts) {
      throw new Error(`download failed ${res.status}: ${url}`)
    }
    const retryAfter = Number(res.headers.get('retry-after'))
    const backoffMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1000 * 2 ** (attempt - 1))
    await sleep(backoffMs)
  }
}

// Solves one curated pack for the target subdir, writes its @EXPLICIT lock, downloads every referenced
// tarball into the shared pkgs cache (FATAL on any download failure — no partial pack ships), packs
// the lock + referenced tarballs into a self-contained .tar.zst, and returns the manifest entry
// (sha256 + size over the archive).
const stagePack = async (mm, stagingRoot, pack, platform) => {
  const { id, language, version, packages } = pack
  console.log(`[stage-default-envs] solving ${id} (${platform || 'native'}): ${packages.join(' ')}`)
  const raw = execFileSync(mm, solveArgv(join(stagingRoot, id), packages, platform), {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  })
  const lock = buildLockFromSolve(JSON.parse(raw))
  const packDir = join(stagingRoot, id)
  mkdirSync(packDir, { recursive: true })
  writeFileSync(join(packDir, `${id}.lock`), lock)
  for (const { url, file } of packageEntriesFromLock(lock)) {
    const dest = join(PKGS, file)
    if (!existsSync(dest)) {
      await download(url, dest)
    }
    copyFileSync(dest, join(packDir, file))
  }
  // Louder than the workflow's old "non-empty" check: fail the whole staging if any referenced tarball
  // is missing or md5-mismatched, so a broken pack can never be published.
  verifyBundleComplete(lock, PKGS)
  const packageContents = Object.fromEntries(
    packageEntriesFromLock(lock).map(({ file }) => [file, inspectPackage(mm, join(packDir, file))])
  )
  const pathBudget = derivePackPathBudget(lock, packageContents)
  const archivePath = join(OUT, packArchiveFile(language, version))
  await createPackArchive(packDir, archivePath)
  rmSync(packDir, { recursive: true, force: true })
  const bytes = readFileSync(archivePath)
  return {
    language,
    version,
    file: packArchiveFile(language, version),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    ...pathBudget
  }
}

const main = async () => {
  const mm = process.env.MICROMAMBA_BIN ?? ''
  if (!mm || !existsSync(mm)) {
    console.log(
      '[stage-default-envs] MICROMAMBA_BIN not set/found — skipping default-env staging. ' +
        'Install micromamba and set MICROMAMBA_BIN to its path to produce resources/default-envs.'
    )
    return
  }
  // Target conda subdir to solve for (e.g. osx-64 on an arm64 runner). Empty = the host's native subdir.
  const platform = process.env.OS_STAGE_PLATFORM || nativeSubdir()
  // A rerun must not carry obsolete tarballs/locks from an older matrix into the new bundle.
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(PKGS, { recursive: true })
  const stagingRoot = mkdtempSync(join(tmpdir(), 'os-stage-'))
  const manifest = {
    schema: MANIFEST_SCHEMA,
    envVersion: readDefaultEnvVersion(),
    subdir: platform,
    packs: {}
  }
  for (const pack of packMatrix()) {
    manifest.packs[pack.id] = await stagePack(mm, stagingRoot, pack, platform)
  }
  rmSync(PKGS, { recursive: true, force: true })
  rmSync(stagingRoot, { recursive: true, force: true })
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(
    `[stage-default-envs] staged ${Object.keys(manifest.packs).length} packs + manifest into ` +
      'resources/default-envs'
  )
}

// CLI entry: only runs when the file is executed directly, not when imported by the test (mirrors
// scripts/generate-version-manifest.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[stage-default-envs] failed:', err)
    process.exit(1)
  })
}

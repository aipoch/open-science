import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EnvSpec, FetchedBundle, ProvisionProgress } from './provisioner'
import { pkgsCache } from './runtime-paths'

// Tarball filenames referenced by an @EXPLICIT lock (basename of each package URL, md5 stripped).
const lockTarballNames = (lockText: string): string[] =>
  lockText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .map((line) => {
      const url = line.split('#')[0]
      return url.slice(url.lastIndexOf('/') + 1)
    })

// A ProvisionerDeps.fetchBundle-shaped function (kept local to avoid a value import cycle with
// provisioner.ts; the types are import-only).
type FetchBundleFn = (
  spec: EnvSpec,
  version: number,
  onProgress: (p: ProvisionProgress) => void
) => Promise<FetchedBundle | undefined>

// Injected paths so resolution unit-tests without a real packaged layout.
export type BundleDirDeps = {
  resourcesPath?: string
  override?: string
}

// Resolves the packaged default-env bundle directory (per-env @EXPLICIT locks + a pkgs/ tarball cache
// produced by scripts/stage-default-envs.mjs). Mirrors resolveLoopScript: env override →
// app.asar.unpacked (resources/** ships unpacked) → resourcesPath → dev source tree. Returns undefined
// when no bundle exists on disk, so the caller falls back to the CDN/online create path.
export const resolveBundleDir = (deps: BundleDirDeps = {}): string | undefined => {
  const override = deps.override ?? process.env.OPEN_SCIENCE_ENV_BUNDLE_DIR
  if (override) return existsSync(override) ? override : undefined

  const resourcesPath = deps.resourcesPath ?? process.resourcesPath
  const candidates = [
    resourcesPath && join(resourcesPath, 'app.asar.unpacked', 'resources', 'default-envs'),
    resourcesPath && join(resourcesPath, 'resources', 'default-envs'),
    join(__dirname, '../../resources/default-envs'),
    join(__dirname, '../../../resources/default-envs')
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => existsSync(candidate))
}

// Builds a fetchBundle from a packaged bundle dir: when <dir>/<spec>.lock exists AND every tarball it
// references is present in <dir>/pkgs, seeds those tarballs into the root pkgs cache and returns the
// lock so materialize runs an OFFLINE create. Returns undefined (→ chain to CDN/online) when the
// bundle is absent, incomplete, or references no packages — so a missing package degrades to an
// online install instead of a doomed `create --file --offline` that errors mid-transaction.
export const createLocalBundleAdapter =
  (root: string, bundleDir: string | undefined): FetchBundleFn =>
  async (spec, _version, onProgress) => {
    if (!bundleDir) return undefined
    const lockPath = join(bundleDir, `${spec.name}.lock`)
    if (!existsSync(lockPath)) return undefined

    const src = join(bundleDir, 'pkgs')
    let files: string[]
    try {
      files = readdirSync(src)
    } catch {
      return undefined
    }
    if (files.length === 0) return undefined

    // Completeness gate: only commit to --offline when the cache actually holds every package the
    // lock names. A lock with no packages, or any missing tarball, falls back to online create.
    const referenced = lockTarballNames(readFileSync(lockPath, 'utf8'))
    if (referenced.length === 0) return undefined
    const present = new Set(files)
    const missing = referenced.filter((name) => !present.has(name))
    if (missing.length > 0) {
      console.warn(
        `[bundle-local] ${spec.name}: offline bundle missing ${missing.length}/${referenced.length} ` +
          `package(s) (e.g. ${missing[0]}); falling back to online create`
      )
      return undefined
    }

    const cache = pkgsCache(root)
    mkdirSync(cache, { recursive: true })
    let done = 0
    for (const file of files) {
      const dest = join(cache, file)
      if (!existsSync(dest)) cpSync(join(src, file), dest)
      done += 1
      onProgress({
        phase: `fetch-${spec.language}`,
        message: `Seeding ${done}/${files.length} packages…`,
        progress: 0.1 + 0.3 * (done / files.length)
      })
    }
    return { lockPath }
  }

// Runs fetchBundle adapters in order, returning the first defined bundle. Order encodes precedence:
// local offline bundle first, then the CDN fetch, then (all undefined) the caller's online fallback.
export const chainFetchBundle =
  (adapters: FetchBundleFn[]): FetchBundleFn =>
  async (spec, version, onProgress) => {
    for (const adapter of adapters) {
      const bundle = await adapter(spec, version, onProgress)
      if (bundle) return bundle
    }
    return undefined
  }

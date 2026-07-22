import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  packId,
  PACK_PATH_BUDGET_FILE,
  parseManifest,
  pathBudgetForPack,
  resolvePack,
  SUPPORTED_SCHEMA,
  verifyPackChecksum
} from './bundle-manifest'
import type { EnvSpec, FetchedBundle, ProvisionProgress } from './provisioner'
import { extractPackArchiveWithDeps } from './pack-archive'
import { validateAndSeedPack } from './pack-content'
import { runtimePackDir, runtimeSubdir } from './runtime-paths'

// A ProvisionerDeps.fetchBundle-shaped function (kept local to avoid a value import cycle with
// provisioner.ts; the types are import-only).
type FetchBundleFn = (
  spec: EnvSpec,
  version: number,
  onProgress: (p: ProvisionProgress) => void,
  signal?: AbortSignal
) => Promise<FetchedBundle | undefined>

// Injected paths so resolution unit-tests without a real packaged layout.
export type BundleDirDeps = {
  resourcesPath?: string
  override?: string
  subdir?: string
}

// Resolves the packaged default-env bundle directory (per-pack manifest + self-contained
// `<language>-<version>.tar.zst` archives, produced by scripts/stage-default-envs.mjs). Mirrors
// resolveLoopScript: env override →
// app.asar.unpacked (resources/** ships unpacked) → resourcesPath → dev source tree. Returns undefined
// when no bundle exists on disk, so the caller can try the CDN adapter.
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

// Builds a fetchBundle from a packaged bundle dir: when the manifest names a pack archive and that
// archive is present, it is verified, extracted into
// <root>/packs/<envVersion>/<subdir>/<packId>, and its referenced tarballs are seeded into the root
// pkgs cache. Returns undefined when the manifest/archive is missing or incomplete so the caller can
// try the next source and ultimately fail closed.
export const createLocalBundleAdapter =
  (
    root: string,
    bundleDir: string | undefined,
    deps: Pick<BundleDirDeps, 'subdir'> = {}
  ): FetchBundleFn =>
  async (spec, version, onProgress) => {
    if (!bundleDir) return undefined
    const manifestPath = join(bundleDir, 'manifest.json')
    const packName = packId(spec.language, spec.version)

    // New-format staged bundle: manifest + self-contained pack archive.
    if (existsSync(manifestPath)) {
      try {
        const manifest = parseManifest(readFileSync(manifestPath, 'utf8'))
        if (
          manifest.schema !== SUPPORTED_SCHEMA ||
          manifest.envVersion !== version ||
          manifest.subdir !== (deps.subdir ?? runtimeSubdir())
        )
          return undefined
        const entry = resolvePack(manifest, spec.language, spec.version)
        if (!entry) return undefined

        const archivePath = join(bundleDir, entry.file)
        if (!existsSync(archivePath)) return undefined
        await verifyPackChecksum(archivePath, { sha256: entry.sha256, size: entry.size }, {})

        const packDir = runtimePackDir(root, version, manifest.subdir, packName)
        const lockPath = join(packDir, `${packName}.lock`)
        rmSync(packDir, { recursive: true, force: true })
        mkdirSync(packDir, { recursive: true })
        await extractPackArchiveWithDeps(archivePath, packDir)
        if (!existsSync(lockPath)) {
          rmSync(packDir, { recursive: true, force: true })
          return undefined
        }

        const entries = await validateAndSeedPack(root, packDir, lockPath, (done, total) => {
          onProgress({
            phase: `fetch-${spec.language}`,
            message: `Verifying ${done}/${total} packages…`,
            progress: 0.1 + 0.3 * (done / total)
          })
        })
        if (entries.length === 0) return undefined
        const pathBudget = pathBudgetForPack(entry)
        if (manifest.subdir === 'win-64' && !pathBudget) {
          rmSync(packDir, { recursive: true, force: true })
          return undefined
        }
        if (pathBudget) {
          writeFileSync(join(packDir, PACK_PATH_BUDGET_FILE), `${JSON.stringify(pathBudget)}\n`)
        }
        return { lockPath, pathBudget }
      } catch {
        // A malformed or stale local bundle is not authoritative. Let the next adapter (CDN) try
        // the same pack instead of turning a local residue into the final provisioning error.
        rmSync(runtimePackDir(root, version, deps.subdir ?? runtimeSubdir(), packName), {
          recursive: true,
          force: true
        })
        return undefined
      }
    }

    return undefined
  }

// Runs fetchBundle adapters in order, returning the first defined bundle. Order encodes precedence:
// local offline bundle first, then the CDN fetch. All undefined means no verified source is available.
export const chainFetchBundle =
  (adapters: FetchBundleFn[]): FetchBundleFn =>
  async (spec, version, onProgress, signal) => {
    for (const adapter of adapters) {
      const bundle = await adapter(spec, version, onProgress, signal)
      if (bundle) return bundle
    }
    return undefined
  }

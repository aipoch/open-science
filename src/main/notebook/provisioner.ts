import { type Dirent, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import { operationJournalPath, RuntimeOperationJournal } from './operation-journal'
import type {
  EnvironmentInfo,
  ProvisionProgress,
  ProvisionStatus,
  RuntimeBundleSource
} from '../../shared/notebook-env'
import { chainFetchBundle, createLocalBundleAdapter, resolveBundleDir } from './bundle-local'
import { createFetchBundleAdapter } from './language-pack-fetch'
import { withExclusiveCacheLock, withSharedCacheLock } from './pkgs-cache-lock'
import {
  caBundleEnv,
  createFromLockArgv,
  createFromPackagesArgv,
  installFromLockArgv,
  resolveMicromamba,
  type MicromambaDeps
} from './micromamba'
import { runMicromamba, verifyExecutable } from './provisioner-runtime'
import { envsLockDir } from './runtime-relocation'
import {
  DEFAULT_ENV_VERSION,
  resolveRuntimeCdnBase,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  needsRepair,
  pkgsCache,
  pythonBin,
  pythonReady,
  rBin,
  rMaterialized,
  rReady,
  rReadyMarkerPath,
  readReadyMarker,
  readyMarkerPath,
  writeReadyMarker,
  writeRReadyMarker
} from './runtime-paths'

// ProvisionProgress/ProvisionStatus are canonically defined in shared/notebook-env.ts (consumed by
// both main and renderer); re-export here so IPC-adjacent code can import them from the provisioner.
export type { ProvisionProgress, ProvisionStatus }

// A resolved bundle on disk: the local @EXPLICIT lock whose tarballs are already in the pkgs cache.
export type FetchedBundle = { lockPath: string }

// One default environment specification (A-internal). `version` is the curated interpreter version
// (e.g. "3.12" / "4.4") — it identifies the staged offline pack via packId(language, version) (see
// bundle-manifest.ts / stage-default-envs.mjs), so the local bundle adapter looks up the matching
// `<language>-<version>.tar.zst` pack rather than a name-based lock.
export type EnvSpec = {
  name: string
  language: NotebookLanguage
  version: string
  packages: string[]
}

// The managed default interpreter version per language, from the curated set (scripts/stage-default-
// envs.mjs VERSIONS). A specific other version is chosen as an external interpreter (BYO); managed
// stays a small tested set.
export const DEFAULT_MANAGED_VERSION: Record<NotebookLanguage, string> = {
  python: '3.12',
  r: '4.4'
}

// Default managed env package sets. These are now the MINIMAL kernel-protocol floor (interpreter +
// matplotlib-base/nomkl for Python; r-jsonlite for R) — NOT a full scientific stack. The heavier
// convenience packages (numpy/pandas/scipy/…) install on demand via manage_packages, matching the
// curated language packs (which are likewise minimal). No Jupyter: code runs through the exec-loop
// (python_loop.py / r_loop.R). matplotlib-base backs Python figure capture; r-jsonlite implements the
// R loop's line-based JSON protocol.
export const DEFAULT_PYTHON_SPEC: EnvSpec = {
  name: DEFAULT_PY_ENV,
  language: 'python',
  version: DEFAULT_MANAGED_VERSION.python,
  packages: [`python=${DEFAULT_MANAGED_VERSION.python}`, 'matplotlib-base', 'nomkl']
}
export const DEFAULT_R_SPEC: EnvSpec = {
  name: DEFAULT_R_ENV,
  language: 'r',
  version: DEFAULT_MANAGED_VERSION.r,
  packages: [`r-base=${DEFAULT_MANAGED_VERSION.r}`, 'r-jsonlite']
}

// Named-env base floor (design D2/OQ2): the minimal exec-loop-protocol requirement, distinct from the
// richer DEFAULT_*_SPEC used for the two default envs. matplotlib backs figure capture; r-jsonlite
// implements the R loop's line-based JSON framing. Deliberately lean — convenience packages (numpy,
// pandas, …) are left to a follow-up manage_packages call.
export const BASE_PYTHON_PACKAGES: string[] = ['python=3.12', 'matplotlib-base', 'nomkl']
export const BASE_R_PACKAGES: string[] = ['r-base', 'r-jsonlite']

// Injected dependencies so the orchestration unit-tests without network or real subprocesses
// (mirrors globalenv.rs::provision_with).
export type ProvisionerDeps = {
  root: string
  mm: string
  channel: string
  // Downloads the (spec, version) bundle into the pkgs cache and returns its local lock path, or
  // undefined when no bundle is published (the caller must fail closed rather than silently solving
  // online for the default envs).
  fetchBundle: (
    spec: EnvSpec,
    version: number,
    onProgress: (p: ProvisionProgress) => void,
    signal?: AbortSignal
  ) => Promise<FetchedBundle | undefined>
  // Runs a micromamba argv; rejects on non-zero exit. An aborted signal kills the child. onChild
  // receives the spawned child's PID so the caller can journal it for crash-recovery supervision.
  runArgv: (argv: string[], signal?: AbortSignal, onChild?: (pid: number) => void) => Promise<void>
  // Verifies `<bin> --version`; rejects otherwise.
  verify: (bin: string) => Promise<void>
  // Clock injection for the ready-marker timestamp.
  now?: () => string
  bundleSource?: RuntimeBundleSource
}

const defaultNow = (): string => Date.now().toString()

// The provisioning contract consumed via IPC by Workstream D (contract §4).
export interface RuntimeProvisioner {
  status(): ProvisionStatus
  provisionPython(onProgress: (p: ProvisionProgress) => void): Promise<void>
  provisionR(onProgress: (p: ProvisionProgress) => void): Promise<void>
  upgradeIfNeeded(onProgress: (p: ProvisionProgress) => void): Promise<void>
  repair(lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void): Promise<void>
  // Aborts an in-flight provision/upgrade/repair (download + micromamba child). No-op when idle.
  cancel(): void
  // Rebuilds envs captured by a data-root relocation (see runtime-relocation.ts) offline from their
  // @EXPLICIT locks + the copied pkgs cache. No-op when no relocation bundle is present.
  restoreRelocatedEnvs(onProgress: (p: ProvisionProgress) => void): Promise<void>
}

export class DefaultRuntimeProvisioner implements RuntimeProvisioner {
  private provisioning = false

  constructor(private readonly deps: ProvisionerDeps) {}

  // Set for the duration of a provision/upgrade/repair so cancel() can abort the in-flight download
  // (fetch signal) and micromamba create (execFile signal). Cleared in each op's finally.
  private abort?: AbortController

  // Aborts an in-flight provision: the download's fetch and the micromamba child both observe the
  // signal and stop. A partial env prefix is cleaned before the next create (clearNonCondaPrefix), so
  // a cancelled setup leaves nothing that blocks a later retry. No-op when nothing is provisioning.
  cancel(): void {
    this.abort?.abort(new Error('Runtime setup cancelled.'))
  }

  status(): ProvisionStatus {
    const marker = readReadyMarker(this.deps.root)
    return {
      pythonReady: pythonReady(this.deps.root, DEFAULT_ENV_VERSION),
      rReady: rReady(this.deps.root),
      version: marker?.defaultEnvVersion ?? 0,
      provisioning: this.provisioning,
      bundleSource: this.deps.bundleSource
    }
  }

  async provisionPython(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    this.provisioning = true
    this.abort = new AbortController()
    try {
      await this.materialize(DEFAULT_PYTHON_SPEC, onProgress)
      // Python is the app gate: stamp the ready marker only after create+verify succeed.
      writeReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      onProgress({ phase: 'done', message: 'Python environment ready', progress: 1 })
    } finally {
      this.provisioning = false
      this.abort = undefined
    }
  }

  async provisionR(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    this.provisioning = true
    this.abort = new AbortController()
    try {
      // R is lazy, but once present it has its own version marker. A legacy/stale R prefix is upgraded
      // from the current explicit pack instead of being accepted merely because R.exe exists.
      if (rMaterialized(this.deps.root) && !rReady(this.deps.root)) {
        await this.upgradeOrRebuildR(onProgress)
      } else {
        await this.materialize(DEFAULT_R_SPEC, onProgress)
      }
      writeRReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      onProgress({ phase: 'done', message: 'R environment ready', progress: 1 })
    } finally {
      this.provisioning = false
      this.abort = undefined
    }
  }

  async upgradeIfNeeded(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const marker = readReadyMarker(this.deps.root)
    if (!marker || marker.defaultEnvVersion >= DEFAULT_ENV_VERSION) return
    this.provisioning = true
    try {
      // Apply the exact published baseline to the existing env. `install --file --offline` preserves
      // extra user packages while avoiding a repodata solve for the platform-maintained floor.
      onProgress({ phase: 'upgrade', message: 'Updating default packages…', progress: 0.1 })
      await this.upgradeFromBundle(DEFAULT_PYTHON_SPEC, onProgress)
      // R is upgraded additively only if already materialized (lazy; spec §6.5).
      if (rMaterialized(this.deps.root)) {
        onProgress({ phase: 'upgrade-r', message: 'Updating R packages…', progress: 0.6 })
        await this.upgradeOrRebuildR(onProgress)
        writeRReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      }
      writeReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      onProgress({ phase: 'done', message: 'Default environments updated', progress: 1 })
    } finally {
      this.provisioning = false
    }
  }

  async repair(lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const spec = lang === 'r' ? DEFAULT_R_SPEC : DEFAULT_PYTHON_SPEC
    // Manual repair / corruption path (spec §6.3): delete the env prefix then re-provision fresh. For
    // python also clear the marker so a partially-deleted state cannot read as ready.
    rmSync(envPrefix(this.deps.root, spec.name), { recursive: true, force: true })
    if (lang === 'python') {
      rmSync(readyMarkerPath(this.deps.root), { force: true })
      await this.provisionPython(onProgress)
    } else {
      rmSync(rReadyMarkerPath(this.deps.root), { force: true })
      await this.provisionR(onProgress)
    }
  }

  // Rebuilds envs captured by a data-root relocation (runtime-relocation.exportRuntimeLocks) offline
  // from their @EXPLICIT locks + the copied pkgs cache. Per-env best-effort: a lock is consumed
  // (deleted) only after its env recreates and verifies, so a failure is retried next launch and
  // never blocks the other envs or the normal readiness gate. Writes the ready marker once
  // default-python is restored so the startup gate then reads 'ready' instead of re-provisioning.
  async restoreRelocatedEnvs(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const dir = envsLockDir(this.deps.root)
    let files: string[]
    try {
      files = readdirSync(dir).filter((file) => file.endsWith('.lock'))
    } catch {
      return
    }
    if (files.length === 0) return

    // Restore serially in priority order: default-python first (it's the app-usable gate), then
    // default-r, then named envs — so the notebook becomes usable for Python as early as possible
    // rather than waiting behind an R (or other) env in arbitrary readdir order.
    const restorePriority = (file: string): number =>
      file === `${DEFAULT_PY_ENV}.lock` ? 0 : file === `${DEFAULT_R_ENV}.lock` ? 1 : 2
    files.sort((a, b) => restorePriority(a) - restorePriority(b) || a.localeCompare(b))

    this.provisioning = true
    try {
      let restoredPython = false
      let restoredR = false
      for (const file of files) {
        const name = file.slice(0, -'.lock'.length)
        const prefix = envPrefix(this.deps.root, name)
        // A prior restore may have materialized the interpreter before being interrupted. Verify it
        // before consuming the lock; a broken partial prefix is removed and rebuilt below.
        const existingBin = existsSync(pythonBin(prefix))
          ? pythonBin(prefix)
          : existsSync(rBin(prefix))
            ? rBin(prefix)
            : undefined
        if (existingBin) {
          try {
            await this.deps.verify(existingBin)
            if (name === DEFAULT_PY_ENV) restoredPython = true
            if (name === DEFAULT_R_ENV) restoredR = true
            rmSync(join(dir, file), { force: true })
            continue
          } catch {
            rmSync(prefix, { recursive: true, force: true })
          }
        }
        onProgress({ phase: 'restore', message: `Restoring ${name}…`, progress: 0.5 })
        try {
          await this.deps.runArgv(
            createFromLockArgv(this.deps.mm, this.deps.root, prefix, join(dir, file))
          )
          const bin = existsSync(pythonBin(prefix)) ? pythonBin(prefix) : rBin(prefix)
          await this.deps.verify(bin)
          if (name === DEFAULT_PY_ENV) restoredPython = true
          if (name === DEFAULT_R_ENV) restoredR = true
          rmSync(join(dir, file), { force: true })
        } catch {
          // Leave the lock in place: retried next launch; the readiness gate re-provisions defaults
          // in the meantime so the app stays usable.
        }
      }
      if (restoredPython) {
        writeReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      }
      if (restoredR) {
        writeRReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      }
      onProgress({ phase: 'done', message: 'Runtime restored', progress: 1 })
    } finally {
      this.provisioning = false
    }
  }

  // Named-env create (design D2). Reuses the same online-create path as `materialize` (no bundle
  // fetch — named envs are always solved live) but does NOT stamp/require the .env-ready marker: a
  // named env is "ready" iff its interpreter bin exists (D7). Packages = base floor + user packages,
  // deduped so an explicit re-listing of a base package doesn't duplicate an install arg.
  async createNamedEnvironment(
    name: string,
    language: NotebookLanguage,
    packages: string[] = []
  ): Promise<EnvironmentInfo> {
    const base = language === 'python' ? BASE_PYTHON_PACKAGES : BASE_R_PACKAGES
    const pkgs = [...new Set([...base, ...packages])]
    const prefix = envPrefix(this.deps.root, name)
    // Clear a half-built prefix from an interrupted prior create so micromamba doesn't abort on it.
    this.clearNonCondaPrefix(prefix)
    await this.deps.runArgv(
      createFromPackagesArgv(this.deps.mm, this.deps.root, prefix, [this.deps.channel], pkgs)
    )
    const bin = language === 'python' ? pythonBin(prefix) : rBin(prefix)
    await this.deps.verify(bin)
    return {
      name,
      language,
      ready: existsSync(bin),
      isDefault: name === DEFAULT_PY_ENV || name === DEFAULT_R_ENV
    }
  }

  // Scans <root>/envs/ and classifies each subdirectory by interpreter-bin presence. Dirs with
  // neither a python nor an R bin (e.g. a mid-creation leftover) are skipped — language can't be
  // determined for them. Tolerant of a missing envs dir (fresh root, no env ever created) -> [].
  listEnvironments(): EnvironmentInfo[] {
    const envsDir = join(this.deps.root, 'envs')
    let entries: Dirent[]
    try {
      entries = readdirSync(envsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const infos: EnvironmentInfo[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const prefix = envPrefix(this.deps.root, entry.name)
      const isPython = existsSync(pythonBin(prefix))
      const isR = !isPython && existsSync(rBin(prefix))
      if (!isPython && !isR) continue
      infos.push({
        name: entry.name,
        language: isPython ? 'python' : 'r',
        ready: true,
        isDefault: entry.name === DEFAULT_PY_ENV || entry.name === DEFAULT_R_ENV,
        sizeBytes: dirSizeBytes(prefix)
      })
    }
    return infos
  }

  // rm -rf the env prefix; refuses the two default envs (app baseline, D2). "refuse if live" is
  // enforced by the service layer, not here. Returns the refreshed list for a one-shot UI update.
  removeEnvironment(name: string): EnvironmentInfo[] {
    if (name === DEFAULT_PY_ENV || name === DEFAULT_R_ENV) {
      throw new Error(`Refusing to remove the default environment "${name}"`)
    }
    rmSync(envPrefix(this.deps.root, name), { recursive: true, force: true })
    return this.listEnvironments()
  }

  // Keeps a healthy legacy R prefix additive, but replaces an invalid partial prefix from the lock.
  private async upgradeOrRebuildR(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const prefix = envPrefix(this.deps.root, DEFAULT_R_ENV)
    try {
      await this.deps.verify(rBin(prefix))
    } catch {
      // A failed create can leave R.exe before the prefix is runnable. Do not apply an additive
      // upgrade onto unknown partial state; clear it and recreate exactly from the published lock.
      rmSync(prefix, { recursive: true, force: true })
      await this.materialize(DEFAULT_R_SPEC, onProgress)
      return
    }
    await this.upgradeFromBundle(DEFAULT_R_SPEC, onProgress)
  }

  private async upgradeFromBundle(
    spec: EnvSpec,
    onProgress: (p: ProvisionProgress) => void
  ): Promise<void> {
    const bundle = await this.deps.fetchBundle(
      spec,
      DEFAULT_ENV_VERSION,
      onProgress,
      this.abort?.signal
    )
    if (!bundle) {
      throw new Error(
        `No verified runtime pack is available to upgrade ${spec.name} ` +
          `(${spec.language} ${spec.version}). Connect to the runtime CDN or provide an offline bundle ` +
          'in OPEN_SCIENCE_ENV_BUNDLE_DIR.'
      )
    }
    const prefix = envPrefix(this.deps.root, spec.name)
    const bin = spec.language === 'python' ? pythonBin(prefix) : rBin(prefix)
    await this.deps.runArgv(
      installFromLockArgv(this.deps.mm, this.deps.root, prefix, bundle.lockPath),
      this.abort?.signal
    )
    await this.deps.verify(bin)
  }

  // micromamba `create -p <prefix>` aborts with "Non-conda folder exists at prefix" when the prefix
  // dir already exists without conda metadata — e.g. a prior create that was interrupted (crash,
  // killed retry, or a partial extraction) after making the dir but before conda-meta was written.
  // This routinely wedges a Retry on Windows (default-r left half-built). Clear such a leftover so
  // the create starts clean; a real conda env (has conda-meta) is left untouched so we never nuke a
  // working environment.
  private clearNonCondaPrefix(prefix: string): void {
    if (!existsSync(prefix)) return
    if (existsSync(join(prefix, 'conda-meta'))) return
    rmSync(prefix, { recursive: true, force: true })
  }

  private async materialize(
    spec: EnvSpec,
    onProgress: (p: ProvisionProgress) => void
  ): Promise<void> {
    const prefix = envPrefix(this.deps.root, spec.name)
    const bin = spec.language === 'python' ? pythonBin(prefix) : rBin(prefix)
    // Idempotent: if the interpreter is already on disk the env is materialized, so skip fetch+create.
    // This makes a duplicate/concurrent provision (e.g. the UI R-tab and an on-demand agent run both
    // asking for default-r) a no-op instead of a `create -p <existing prefix>` error. repair() deletes
    // the prefix first, so it still rebuilds.
    if (existsSync(bin)) {
      try {
        await this.deps.verify(bin)
        onProgress({ phase: `${spec.language}-ready`, message: `${spec.name} ready`, progress: 1 })
        return
      } catch {
        // A prior failed create can leave an interpreter file before the environment is runnable.
        // Remove that partial prefix so Retry performs a complete verified rebuild.
        rmSync(prefix, { recursive: true, force: true })
      }
    }

    onProgress({
      phase: `fetch-${spec.language}`,
      message: `Preparing ${spec.name} packages…`,
      progress: 0.1
    })
    const bundle = await this.deps.fetchBundle(
      spec,
      DEFAULT_ENV_VERSION,
      onProgress,
      this.abort?.signal
    )
    if (!bundle) {
      throw new Error(
        `No verified runtime pack is available for ${spec.name} (${spec.language} ${spec.version}). ` +
          'Connect to the runtime CDN or provide an offline bundle in OPEN_SCIENCE_ENV_BUNDLE_DIR.'
      )
    }
    onProgress({
      phase: `create-${spec.language}`,
      message: `Creating ${spec.name} environment…`,
      progress: 0.5
    })
    // Journal the create so a process death mid-materialize is reconciled at next startup (the env
    // prefix is verified and, if incomplete, removed so it rebuilds). Best-effort — journal I/O never
    // fails the materialize. Cleared in the finally once verify succeeds/fails and the prefix is settled.
    const journal = new RuntimeOperationJournal(operationJournalPath(this.deps.root))
    const operationId = randomUUID()
    await journal
      .begin({
        operationId,
        kind: 'materialize',
        runtimeId: spec.name,
        phase: `create-${spec.language}`,
        startedAt: Date.now(),
        targetPath: prefix
      })
      .catch(() => undefined)
    const onChild = (childPid: number): void =>
      // Record the micromamba child so startup recovery can kill a survivor before reconciling.
      void journal
        .update(operationId, { childPid, childStartedAt: Date.now() })
        .catch(() => undefined)
    const runCreate = (lockPath: string): Promise<void> =>
      // Take the shared pkgs cache lock so a concurrent corrupt-cache repair can't delete a package
      // mid-create. The env prefix cleanup + create run inside it.
      withSharedCacheLock(this.deps.root, () => {
        // Clear a half-built prefix from an interrupted prior attempt so micromamba doesn't abort on it.
        this.clearNonCondaPrefix(prefix)
        return this.deps.runArgv(
          createFromLockArgv(this.deps.mm, this.deps.root, prefix, lockPath),
          this.abort?.signal,
          onChild
        )
      })
    try {
      try {
        await runCreate(bundle.lockPath)
      } catch (error) {
        // A corrupt pkgs cache (e.g. a prior interrupted extract left an incomplete package dir) makes
        // create abort with "incorrect downloads" / "extracted directory cache". Do NOT wipe the whole
        // shared cache — that would delete other envs' (and the other language's) tarballs needed for
        // offline rebuild. Instead take the cache EXCLUSIVE and remove only INCOMPLETE extracted package
        // dirs (missing info/index.json), preserving every tarball and complete package; then re-seed
        // and retry the create ONCE. If nothing was incomplete, this isn't a corrupt-cache fault we can
        // repair, so surface the original error rather than churn. A user cancel is never retried.
        if (this.abort?.signal.aborted || !isCorruptPkgsCacheError(error)) throw error
        const repaired = await withExclusiveCacheLock(this.deps.root, () =>
          Promise.resolve(removeIncompleteExtractedPackages(pkgsCache(this.deps.root)))
        )
        if (!repaired) throw error
        onProgress({
          phase: `create-${spec.language}`,
          message: `Repairing ${spec.name} package cache…`,
          progress: 0.5
        })
        const reseeded = await this.deps.fetchBundle(
          spec,
          DEFAULT_ENV_VERSION,
          onProgress,
          this.abort?.signal
        )
        if (!reseeded) throw error
        await runCreate(reseeded.lockPath)
      }

      onProgress({
        phase: `verify-${spec.language}`,
        message: `Verifying ${spec.name} interpreter…`,
        progress: 0.9
      })
      await this.deps.verify(bin)
      onProgress({ phase: `${spec.language}-ready`, message: `${spec.name} ready`, progress: 0.95 })
    } finally {
      await journal.complete(operationId).catch(() => undefined)
    }
  }
}

// micromamba's cache-corruption signatures: a partially-extracted package dir it can't clean before
// re-extracting (remove_all fails), or a checksum/content mismatch in the pkgs cache. Recoverable by
// wiping the cache and re-seeding, so materialize retries once on these.
// Signatures micromamba emits when the pkgs cache holds a partial/corrupt extraction it can't use or
// clean. Deliberately specific — a bare "not empty" (which many unrelated fs errors contain) must NOT
// trigger a cache repair, so it is anchored to micromamba's own "remove_all …" extraction phrasing.
const isCorruptPkgsCacheError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /incorrect downloads/i.test(message) ||
    /invalid package cache/i.test(message) ||
    /extracted directory cache/i.test(message) ||
    /error when extracting package/i.test(message) ||
    /remove_all[^]*not empty/i.test(message)
  )
}

// Removes only INCOMPLETE extracted package directories from the shared pkgs cache — a complete conda
// package extraction always has info/index.json, so a dir lacking it is a partial/interrupted extract.
// Tarball files (*.conda / *.tar.bz2) and the url download cache are left untouched, so every env's
// offline-rebuild material survives; the removed dirs are simply re-extracted from those tarballs.
// Returns true if it removed anything (so the caller only retries when there was something to repair).
const removeIncompleteExtractedPackages = (cacheDir: string): boolean => {
  let entries: Dirent[]
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return false
  }
  let removed = false
  for (const entry of entries) {
    if (!entry.isDirectory()) continue // keep tarballs and index files
    // The url-keyed download cache ("cache", or an http* host dir) holds downloaded tarballs — never
    // remove it, or other envs lose their offline material.
    if (entry.name === 'cache' || /^https?/i.test(entry.name)) continue
    const dir = join(cacheDir, entry.name)
    if (existsSync(join(dir, 'info', 'index.json'))) continue // a complete extraction — keep it
    rmSync(dir, { recursive: true, force: true })
    removed = true
  }
  return removed
}

// Best-effort recursive directory size (OQ5: surface disk usage in `list`). Tolerates any error
// (permission, race with a concurrent remove, etc.) by returning undefined rather than throwing.
const dirSizeBytes = (path: string): number | undefined => {
  try {
    let total = 0
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile()) total += statSync(full).size
      }
    }
    walk(path)
    return total
  } catch {
    return undefined
  }
}

// The startup decision for the readiness gate (Task 8 dispatches on this). Pure and testable.
export type StartupAction = 'ready' | 'upgrade' | 'repair' | 'fresh'

// Decides what the app-startup gate must do. 'upgrade' is chosen before 'repair' so a healthy but
// outdated env is upgraded additively (spec §6.3) rather than nuked; 'repair' covers a corrupt env
// (marker without bin, or a residual env dir). Empty root → 'fresh'.
export const planStartupAction = (root: string, expectedVersion: number): StartupAction => {
  if (pythonReady(root, expectedVersion)) return 'ready'
  const marker = readReadyMarker(root)
  const pyBinPresent = existsSync(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
  if (marker && pyBinPresent) return 'upgrade'
  if (needsRepair(root, expectedVersion)) return 'repair'
  return 'fresh'
}

// Options for the production provisioner: `root` is `<storageRoot>/runtime` — already resolved for
// dev vs prod by the caller (contract: never re-derived here from process.env/app internals) — the
// conda `channel`, optional CDN override, and micromamba resolution overrides. The official CDN base
// is resolved centrally when no override is supplied.
export type ProductionProvisionerOptions = {
  root: string
  channel: string
  micromamba?: MicromambaDeps
  // PEM CA bundle path (enterprise TLS proxy) exported into micromamba's env so an ONLINE provision /
  // named-env create verifies HTTPS against it. Offline bundle creates need no network, so this only
  // matters on the online paths.
  caBundle?: string
  cdnBase?: string
}

// Wires the real micromamba binary, CDN fetch, subprocess runner and interpreter verification into a
// DefaultRuntimeProvisioner. Not unit-tested for real I/O (network/subprocess-bound); the orchestration
// it drives is already covered via injected deps in provisioner.test.ts / provisioner.upgrade.test.ts.
export const createProductionProvisioner = (
  opts: ProductionProvisionerOptions
): RuntimeProvisioner => {
  // `root` is `<storageRoot>/runtime`; derive the real home dir from it (storageRoot's parent) as a
  // robust fallback for resolveMicromamba's storage-root branch, instead of leaving it to fall back to
  // resolveMicromamba's own process.env.HOME lookup — which can be unset for a packaged Electron app
  // launched outside a shell. This is dev/prod-agnostic (pure path arithmetic on the caller-resolved
  // root, no directory-name guessing). Caller-supplied opts.micromamba.home still wins when provided.
  const derivedHome = dirname(dirname(opts.root))
  const mm = resolveMicromamba({ home: derivedHome, ...opts.micromamba })
  if (!mm) {
    throw new Error(
      'micromamba binary not found (set OPEN_SCIENCE_MICROMAMBA_BIN or ship it as a resource)'
    )
  }
  // A packaged/dropped-in local bundle takes precedence. Shipped apps then fetch exactly one verified
  // language pack from the official CDN (or OPEN_SCIENCE_ENV_CDN_BASE) and always create from its lock.
  const bundleDir = resolveBundleDir({ resourcesPath: opts.micromamba?.resourcesPath })
  const cdnBase = resolveRuntimeCdnBase(opts.cdnBase)
  const bundleSource: RuntimeBundleSource = {
    kind:
      opts.cdnBase !== undefined || process.env.OPEN_SCIENCE_ENV_CDN_BASE !== undefined
        ? 'override'
        : 'official',
    baseUrl: cdnBase
  }
  // CA-bundle vars injected into every provisioning subprocess (no-op when unset), so an online
  // create/verify behind an enterprise TLS proxy trusts the custom CA.
  const caEnv = caBundleEnv(opts.caBundle)
  return new DefaultRuntimeProvisioner({
    root: opts.root,
    mm,
    channel: opts.channel,
    bundleSource,
    fetchBundle: chainFetchBundle([
      createLocalBundleAdapter(opts.root, bundleDir),
      createFetchBundleAdapter(opts.root, cdnBase)
    ]),
    runArgv: (argv, signal, onChild) => runMicromamba(argv, caEnv, signal, onChild),
    verify: (bin) => verifyExecutable(bin, caEnv)
  })
}

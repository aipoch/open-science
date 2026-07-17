import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import type { EnvironmentInfo, ProvisionProgress, ProvisionStatus } from '../../shared/notebook-env'
import { fetchBundle, type BundleFetchDeps } from './bundle-fetch'
import { chainFetchBundle, createLocalBundleAdapter, resolveBundleDir } from './bundle-local'
import {
  caBundleEnv,
  createFromLockArgv,
  createFromPackagesArgv,
  installArgv,
  resolveMicromamba,
  type MicromambaDeps
} from './micromamba'
import { md5File, runMicromamba, verifyExecutable } from './provisioner-runtime'
import { envsLockDir } from './runtime-relocation'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  needsRepair,
  pythonBin,
  pythonReady,
  rBin,
  rReady,
  readReadyMarker,
  readyMarkerPath,
  writeReadyMarker
} from './runtime-paths'

// ProvisionProgress/ProvisionStatus are canonically defined in shared/notebook-env.ts (consumed by
// both main and renderer); re-export here so IPC-adjacent code can import them from the provisioner.
export type { ProvisionProgress, ProvisionStatus }

// A resolved bundle on disk: the local @EXPLICIT lock whose tarballs are already in the pkgs cache.
export type FetchedBundle = { lockPath: string }

// One default environment specification (A-internal).
export type EnvSpec = { name: string; language: NotebookLanguage; packages: string[] }

// Default package sets (spec §4). No Jupyter kernel packages: code runs through the exec-loop
// (python_loop.py / r_loop.R), not a Jupyter kernel. matplotlib backs Python figure capture;
// r-jsonlite implements the R side of the loop's line-based JSON protocol.
export const DEFAULT_PYTHON_SPEC: EnvSpec = {
  name: DEFAULT_PY_ENV,
  language: 'python',
  packages: ['python=3.12', 'numpy', 'pandas', 'scipy', 'matplotlib', 'plotly', 'openpyxl']
}
export const DEFAULT_R_SPEC: EnvSpec = {
  name: DEFAULT_R_ENV,
  language: 'r',
  packages: ['r-base', 'r-jsonlite', 'r-ggplot2', 'r-dplyr', 'r-openxlsx']
}

// Named-env base floor (design D2/OQ2): the minimal exec-loop-protocol requirement, distinct from the
// richer DEFAULT_*_SPEC used for the two default envs. matplotlib backs figure capture; r-jsonlite
// implements the R loop's line-based JSON framing. Deliberately lean — convenience packages (numpy,
// pandas, …) are left to a follow-up manage_packages call.
export const BASE_PYTHON_PACKAGES: string[] = ['python=3.12', 'matplotlib']
export const BASE_R_PACKAGES: string[] = ['r-base', 'r-jsonlite']

// Injected dependencies so the orchestration unit-tests without network or real subprocesses
// (mirrors globalenv.rs::provision_with).
export type ProvisionerDeps = {
  root: string
  mm: string
  channel: string
  // Downloads the (spec, version) bundle into the pkgs cache and returns its local lock path, or
  // undefined when no bundle is published (dev/online-fallback path).
  fetchBundle: (
    spec: EnvSpec,
    version: number,
    onProgress: (p: ProvisionProgress) => void
  ) => Promise<FetchedBundle | undefined>
  // Runs a micromamba argv; rejects on non-zero exit.
  runArgv: (argv: string[]) => Promise<void>
  // Verifies `<bin> --version`; rejects otherwise.
  verify: (bin: string) => Promise<void>
  // Clock injection for the ready-marker timestamp.
  now?: () => string
}

const defaultNow = (): string => Date.now().toString()

// The provisioning contract consumed via IPC by Workstream D (contract §4).
export interface RuntimeProvisioner {
  status(): ProvisionStatus
  provisionPython(onProgress: (p: ProvisionProgress) => void): Promise<void>
  provisionR(onProgress: (p: ProvisionProgress) => void): Promise<void>
  upgradeIfNeeded(onProgress: (p: ProvisionProgress) => void): Promise<void>
  repair(lang: NotebookLanguage, onProgress: (p: ProvisionProgress) => void): Promise<void>
  // Rebuilds envs captured by a data-root relocation (see runtime-relocation.ts) offline from their
  // @EXPLICIT locks + the copied pkgs cache. No-op when no relocation bundle is present.
  restoreRelocatedEnvs(onProgress: (p: ProvisionProgress) => void): Promise<void>
}

export class DefaultRuntimeProvisioner implements RuntimeProvisioner {
  private provisioning = false

  constructor(private readonly deps: ProvisionerDeps) {}

  status(): ProvisionStatus {
    const marker = readReadyMarker(this.deps.root)
    return {
      pythonReady: pythonReady(this.deps.root, DEFAULT_ENV_VERSION),
      rReady: rReady(this.deps.root),
      version: marker?.defaultEnvVersion ?? 0,
      provisioning: this.provisioning
    }
  }

  async provisionPython(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    this.provisioning = true
    try {
      await this.materialize(DEFAULT_PYTHON_SPEC, onProgress)
      // Python is the app gate: stamp the ready marker only after create+verify succeed.
      writeReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
      onProgress({ phase: 'done', message: 'Python environment ready', progress: 1 })
    } finally {
      this.provisioning = false
    }
  }

  async provisionR(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    this.provisioning = true
    try {
      // R is lazy and version-gated only after it exists; never touches the python marker.
      await this.materialize(DEFAULT_R_SPEC, onProgress)
      onProgress({ phase: 'done', message: 'R environment ready', progress: 1 })
    } finally {
      this.provisioning = false
    }
  }

  async upgradeIfNeeded(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const marker = readReadyMarker(this.deps.root)
    if (!marker || marker.defaultEnvVersion >= DEFAULT_ENV_VERSION) return
    this.provisioning = true
    try {
      // Additive upgrade (spec §6.3): install the current default set into the EXISTING env so
      // user-installed packages survive. Never delete/rebuild here.
      onProgress({ phase: 'upgrade', message: 'Updating default packages…', progress: 0.1 })
      const pyPrefix = envPrefix(this.deps.root, DEFAULT_PYTHON_SPEC.name)
      await this.deps.runArgv(
        installArgv(
          this.deps.mm,
          this.deps.root,
          pyPrefix,
          [this.deps.channel],
          DEFAULT_PYTHON_SPEC.packages
        )
      )
      // R is upgraded additively only if already materialized (lazy; spec §6.5).
      if (rReady(this.deps.root)) {
        onProgress({ phase: 'upgrade-r', message: 'Updating R packages…', progress: 0.6 })
        const rPrefix = envPrefix(this.deps.root, DEFAULT_R_SPEC.name)
        await this.deps.runArgv(
          installArgv(
            this.deps.mm,
            this.deps.root,
            rPrefix,
            [this.deps.channel],
            DEFAULT_R_SPEC.packages
          )
        )
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
      for (const file of files) {
        const name = file.slice(0, -'.lock'.length)
        const prefix = envPrefix(this.deps.root, name)
        // Already materialized (e.g. a partial prior run): just drop the consumed lock.
        if (existsSync(pythonBin(prefix)) || existsSync(rBin(prefix))) {
          rmSync(join(dir, file), { force: true })
          continue
        }
        onProgress({ phase: 'restore', message: `Restoring ${name}…`, progress: 0.5 })
        try {
          await this.deps.runArgv(
            createFromLockArgv(this.deps.mm, this.deps.root, prefix, join(dir, file))
          )
          const bin = existsSync(pythonBin(prefix)) ? pythonBin(prefix) : rBin(prefix)
          await this.deps.verify(bin)
          if (name === DEFAULT_PY_ENV) restoredPython = true
          rmSync(join(dir, file), { force: true })
        } catch {
          // Leave the lock in place: retried next launch; the readiness gate re-provisions defaults
          // in the meantime so the app stays usable.
        }
      }
      if (restoredPython) {
        writeReadyMarker(this.deps.root, DEFAULT_ENV_VERSION, (this.deps.now ?? defaultNow)())
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

  // fetch bundle → create (offline from lock, or online fallback) → verify. Emits progress.
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
      onProgress({ phase: `${spec.language}-ready`, message: `${spec.name} ready`, progress: 1 })
      return
    }

    onProgress({
      phase: `fetch-${spec.language}`,
      message: `Preparing ${spec.name} packages…`,
      progress: 0.1
    })
    const bundle = await this.deps.fetchBundle(spec, DEFAULT_ENV_VERSION, onProgress)
    onProgress({
      phase: `create-${spec.language}`,
      message: `Creating ${spec.name} environment…`,
      progress: 0.5
    })
    const argv = bundle
      ? createFromLockArgv(this.deps.mm, this.deps.root, prefix, bundle.lockPath)
      : createFromPackagesArgv(
          this.deps.mm,
          this.deps.root,
          prefix,
          [this.deps.channel],
          spec.packages
        )
    await this.deps.runArgv(argv)

    onProgress({
      phase: `verify-${spec.language}`,
      message: `Verifying ${spec.name} interpreter…`,
      progress: 0.9
    })
    await this.deps.verify(bin)
    onProgress({ phase: `${spec.language}-ready`, message: `${spec.name} ready`, progress: 0.95 })
  }
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
// conda `channel` and CDN `cdnBase` (both from the mirror/app-config resolver, never hardcoded), and
// micromamba resolution overrides.
export type ProductionProvisionerOptions = {
  root: string
  channel: string
  cdnBase: string
  micromamba?: MicromambaDeps
  // PEM CA bundle path (enterprise TLS proxy) exported into micromamba's env so an ONLINE provision /
  // named-env create verifies HTTPS against it. Offline bundle creates need no network, so this only
  // matters on the online paths.
  caBundle?: string
}

// The real (network) BundleFetchDeps.download: fetches a URL and writes it to destPath.
const fetchDownload = async (url: string, destPath: string): Promise<void> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  mkdirSync(dirname(destPath), { recursive: true })
  writeFileSync(destPath, buffer)
}

// Adapts A6's fetchBundle(root, spec, deps, onProgress) to ProvisionerDeps.fetchBundle(spec, version,
// onProgress): closes over root/cdnBase, forwards the actual per-call version (rather than freezing it
// at construction time), and injects the given download plus A5's md5File. Exported standalone (not
// inlined in createProductionProvisioner) so the forwarding logic is unit-testable with an injected
// fake `download` — no real network required.
export const createFetchBundleAdapter =
  (root: string, cdnBase: string, download: BundleFetchDeps['download']) =>
  (
    spec: EnvSpec,
    version: number,
    onProgress: (p: ProvisionProgress) => void
  ): Promise<FetchedBundle | undefined> => {
    const deps: BundleFetchDeps = { cdnBase, version, download, md5: md5File }
    return fetchBundle(root, spec, deps, onProgress)
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
  // Prefer the packaged offline bundle (locks + seeded tarballs) so first-run and post-relocation
  // rebuilds create the defaults with no network; fall back to the CDN fetch, then online create.
  const bundleDir = resolveBundleDir({ resourcesPath: opts.micromamba?.resourcesPath })
  // CA-bundle vars injected into every provisioning subprocess (no-op when unset), so an online
  // create/verify behind an enterprise TLS proxy trusts the custom CA.
  const caEnv = caBundleEnv(opts.caBundle)
  return new DefaultRuntimeProvisioner({
    root: opts.root,
    mm,
    channel: opts.channel,
    fetchBundle: chainFetchBundle([
      createLocalBundleAdapter(opts.root, bundleDir),
      createFetchBundleAdapter(opts.root, opts.cdnBase, fetchDownload)
    ]),
    runArgv: (argv) => runMicromamba(argv, caEnv),
    verify: (bin) => verifyExecutable(bin, caEnv)
  })
}

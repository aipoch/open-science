import { type Dirent, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import {
  bootTokenProvesReboot,
  listOperationChildren,
  operationJournalPath,
  readBootToken,
  readOperationChild,
  recordOperationChildSync,
  recordSpawnIntentSync,
  removeOperationChildSync,
  RuntimeOperationJournal,
  type OperationChildState,
  type RuntimeOperationKind,
  type RuntimeOperationRecord
} from './operation-journal'
import type {
  EnvironmentInfo,
  ProvisionProgress,
  ProvisionStatus,
  RuntimeBundleSource
} from '../../shared/notebook-env'
import { chainFetchBundle, createLocalBundleAdapter, resolveBundleDir } from './bundle-local'
import { createFetchBundleAdapter } from './language-pack-fetch'
import { DEFAULT_MAX_ENV_RELATIVE_PATH, type PackPathBudget } from './bundle-manifest'
import { withExclusiveCacheLocks, withSharedCacheLocks } from './pkgs-cache-lock'
import {
  recoverWindowsMaxPathPackage,
  removeOverBudgetUrlPackages,
  removeIncompleteExtractedPackages
} from './micromamba-cache-recovery'
import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  micromambaCacheLockKey,
  WINDOWS_MAX_USABLE_PATH,
  selectMicromambaCache,
  type MicromambaCache
} from './micromamba-cache'
import {
  caBundleEnv,
  createFromLockArgv,
  createFromPackagesArgv,
  installFromLockArgv,
  micromambaSpawnEnv,
  resolveMicromamba,
  type MicromambaDeps
} from './micromamba'
import { defaultOperationChildLiveness, readProcessStartToken } from './operation-recovery'
import { isChildUnconfirmedError, runMicromamba, verifyExecutable } from './provisioner-runtime'
import { envsLockDir } from './runtime-relocation'
import {
  DEFAULT_ENV_VERSION,
  resolveRuntimeCdnBase,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  legacyDefaultEnvPrefix,
  logicalEnvNameFromDirectory,
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
export type FetchedBundle = { lockPath: string; pathBudget?: PackPathBudget }

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
  runArgv: (
    argv: string[],
    signal?: AbortSignal,
    onChild?: (pid: number) => void,
    // Called synchronously right before each spawn so the caller can (re)record the per-spawn intent.
    onBeforeSpawn?: () => void,
    cache?: MicromambaCache,
    maxCacheRelativePath?: number
  ) => Promise<void>
  // Verifies `<bin> --version`; rejects otherwise.
  verify: (bin: string, prefix: string) => Promise<void>
  // Clock injection for the ready-marker timestamp.
  now?: () => string
  bundleSource?: RuntimeBundleSource
  cache?: MicromambaCache
  platform?: NodeJS.Platform
  // True when `prefix` is one crash-recovery could NOT confirm free of a live orphan writer (see
  // runtime-service.blockedPrefixes). Every prefix-WRITING op here (materialize / named create /
  // repair / upgrade / relocation restore) consults this and refuses rather than racing the possible
  // survivor — so the startup gate's restore/upgrade/repair is guarded too, not just the UI handlers.
  // Injected by main/ipc.ts from the notebook service; unset in unit tests (nothing is blocked).
  isPrefixBlocked?: (prefix: string) => boolean
  // Clears the in-memory recovery block for a prefix (service.blockedPrefixes). Called by an EXPLICIT
  // user recovery (repair with force) so a quarantined runtime can be reset — the manual recovery entry
  // the auto-path can't provide for an unprobeable/uncertain block.
  clearPrefixBlock?: (prefix: string) => void
  // Clears the in-memory recovery block for a runtime ID (service.blockedRuntimeIds). An interrupted
  // install blocks the bound runtimeId (not a prefix), so a prefix-only Reset would rebuild the env yet
  // leave bound sessions rejected until restart. clearQuarantine passes the runtimeIds of the retained
  // install records for the reset prefix. Injected from main/ipc.ts; unset in unit tests.
  clearRuntimeBlock?: (runtimeId: string) => void
  // Releases just THIS prefix from the GLOBAL corrupt-journal write barrier (service.recoveryCorrupt).
  // Called by a force Reset after it moves a corrupt journal aside. Per-prefix (not a global clear): a
  // corrupt journal can't tell us which env had in-flight work, so resetting Python must NOT unblock R,
  // named, and external targets — they stay blocked until their own Reset or a restart. Injected from
  // ipc.ts; unset in unit tests.
  clearCorruptBlock?: (prefix: string) => void
  // Records, IN THIS PROCESS, that a prefix write here failed with a child we could not confirm stopped
  // (a worker MAY still be writing it). Blocks the prefix immediately (service.blockedPrefixes) so an
  // in-session retry can't begin() a SECOND concurrent op onto the same prefix while the first's orphan
  // may still be live — the journal record alone only guards the NEXT boot. Injected from ipc.ts.
  blockPrefix?: (prefix: string) => void
  // True when a write in THIS process (a provisioner prefix write OR a package install — both funnel into
  // service.blockPrefixRecovery) left `prefix` with a child that could not be confirmed stopped. A force
  // Reset consults this in clearQuarantine and REFUSES rather than delete + rebuild the prefix out from
  // under that possibly-live orphan. Covers the install path, whose live-unconfirmed state the provisioner
  // never sees in its own set. Injected from ipc.ts; unset in unit tests (nothing live-unconfirmed).
  isPrefixLiveUnconfirmed?: (prefix: string) => boolean
  // Force-Reset worker guard: given a recorded child, returns true ONLY when it is provably stopped
  // (pid gone/not-ours via ESRCH/EPERM, or a start-token MISMATCH proving pid reuse) — safe to delete +
  // rebuild — and false whenever a live pid can't be strictly proven not-ours (Reset then refuses). It
  // never signals the pid. childStartedAt is NOT consulted for liveness (a wall-clock value can't soundly
  // prove a live pid dead); only the monotonic start token can. Defaults to the real probe; injected in
  // tests so they never touch real processes.
  confirmChildStopped?: (record: {
    childPid: number
    childStartedAt?: number
    childStartToken?: string
  }) => Promise<boolean>
  // Current machine-boot token (see readBootToken), used by force-Reset to decide whether an unprobeable
  // no-PID orphan is provably gone (the box rebooted since the record was written). Injected in tests to
  // simulate "same boot" vs "rebooted" deterministically; defaults to the real reader.
  readBootToken?: () => string | undefined
  // Serializes a prefix-mutating section with the notebook service's per-env install lock, so a default
  // env materialize/repair/upgrade never runs concurrently with a package install into the SAME env
  // prefix. Without one shared lock the provisioner's serialize() and the service's envLock are
  // independent, so a force-repair `rm -rf` could race an installer mid-write. Keyed by the env NAME
  // (matching the service's envLock key). Injected from main/ipc.ts; unset in unit tests (runs
  // unlocked). Passes fn's result through.
  withPrefixLock?: <T>(envName: string, fn: () => Promise<T>) => Promise<T>
  // Scheduler for the create-phase progress ticker. Defaults to a self-unref'ing setInterval; tests
  // inject a manual one to drive ticks synchronously instead of waiting real wall-clock time. Returns
  // a cancel fn that stops further ticks.
  scheduleTick?: (onTick: () => void, ms: number) => () => void
}

// Default create-phase ticker scheduler: a setInterval that never keeps the process alive on its own.
const defaultScheduleTick = (onTick: () => void, ms: number): (() => void) => {
  const timer = setInterval(onTick, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

const defaultNow = (): string => Date.now().toString()

// Force-Reset worker guard: given a recorded child, decide whether it is safely stopped so Reset may
// delete + rebuild the prefix. Uses the SAME two-state liveness as recovery (never 'alive'), so it never
// signals a process: it returns true ONLY when the child is provably gone or provably reused ('dead'),
// and false when the pid is live and can't be strictly proven not-ours ('unknown') — Reset then refuses
// rather than delete a prefix a survivor may hold. Injectable via ProvisionerDeps.confirmChildStopped.
const defaultConfirmChildStopped = async (record: {
  childPid: number
  childStartedAt?: number
  childStartToken?: string
}): Promise<boolean> => {
  // 'dead' = provably gone or provably reused → nothing of ours is writing, safe to Reset. 'unknown' =
  // the pid is live and we can't strictly prove it isn't our worker; we do NOT signal it (no strict
  // "safe to kill" guarantee) and refuse the Reset so we never delete a prefix a survivor may hold. The
  // env self-heals once the worker exits and a later boot sees the pid gone.
  return (await defaultOperationChildLiveness(record as RuntimeOperationRecord)) === 'dead'
}

// Wraps an onProgress sink so every event it forwards is tagged with the env's language (unless the
// event already set one). provisionPython/provisionR/repair wrap here so all downstream emissions —
// materialize, the create ticker, verify/ready/done — carry the language, letting the Settings UI show
// python and R provisioning independently even though the two runs are serialized in the provisioner.
const withLanguage =
  (onProgress: (p: ProvisionProgress) => void, language: NotebookLanguage) =>
  (p: ProvisionProgress): void =>
    onProgress(p.language ? p : { ...p, language })

// `micromamba create` (extract + link) is the LONGEST provisioning phase but emits no progress we can
// read (runMicromamba buffers stdout), so the bar used to sit at a flat 0.5 for the whole phase and
// look stalled. While the create runs we ease the reported progress from CREATE_FLOOR toward — but
// never reaching — CREATE_CEIL, so the bar keeps advancing; the real verify/ready/done events (>= 0.9)
// then overtake it. The floor sits just above the fetch/verify band (…→0.4) so the sequence is
// monotonic on the common (no corrupt-cache) path.
const CREATE_FLOOR = 0.45
const CREATE_CEIL = 0.88
const CREATE_TICK_MS = 700
// Fraction of the remaining distance to CREATE_CEIL covered per tick — a gentle deceleration curve.
const CREATE_TICK_GAIN = 0.12

// The provisioning contract consumed via IPC by Workstream D (contract §4).
export interface RuntimeProvisioner {
  status(): ProvisionStatus
  provisionPython(onProgress: (p: ProvisionProgress) => void): Promise<void>
  provisionR(onProgress: (p: ProvisionProgress) => void): Promise<void>
  upgradeIfNeeded(onProgress: (p: ProvisionProgress) => void): Promise<void>
  // `force` = explicit user recovery: clears a recovery quarantine (block + retained journal record +
  // sidecar) before rebuilding, so a stuck/uncertain runtime can be reset. Auto/startup repair omits it
  // and stays gated by the block.
  repair(
    lang: NotebookLanguage,
    onProgress: (p: ProvisionProgress) => void,
    opts?: { force?: boolean }
  ): Promise<void>
  // Aborts an in-flight (or skips a queued) provision. Per-language: cancelling one language never
  // aborts another's run. `undefined` aborts whatever is in flight. No-op when idle.
  cancel(language?: NotebookLanguage): void
  // Rebuilds envs captured by a data-root relocation (see runtime-relocation.ts) offline from their
  // @EXPLICIT locks + the copied pkgs cache. No-op when no relocation bundle is present.
  restoreRelocatedEnvs(onProgress: (p: ProvisionProgress) => void): Promise<void>
}

export class DefaultRuntimeProvisioner implements RuntimeProvisioner {
  private provisioning = false
  private legacyCacheCleanupComplete = false
  // Prefixes whose write in THIS process failed with a child we could not confirm stopped (a worker MAY
  // still be live). A force Reset must NOT delete+rebuild such a prefix — its orphan can't be probed
  // (its PID never landed) and could still be writing. Per-process (not persisted), so it is empty after
  // a restart: post-restart the spawning process is provably gone, and a force Reset then proceeds (the
  // documented escape hatch for an otherwise-stuck µs-window orphan). See clearQuarantine.
  private readonly liveUnconfirmedPrefixes = new Set<string>()

  constructor(private readonly deps: ProvisionerDeps) {}

  private get cache(): MicromambaCache {
    return this.deps.cache ?? selectMicromambaCache(this.deps.root)
  }

  private cacheRoots(cache: MicromambaCache): string[] {
    return [...new Set([pkgsCache(this.deps.root), cache.path])]
  }

  private cacheLockKeys(cache: MicromambaCache): string[] {
    return [
      cache.lockKey,
      micromambaCacheLockKey(pkgsCache(this.deps.root), { platform: this.deps.platform })
    ]
  }

  private cacheForBundle(
    spec: EnvSpec,
    bundle: FetchedBundle
  ): { cache: MicromambaCache; budget: PackPathBudget } {
    const platform = this.deps.platform ?? process.platform
    const budget =
      bundle.pathBudget ??
      (platform === 'win32'
        ? {
            maxCacheRelativePath: DEFAULT_MAX_CACHE_RELATIVE_PATH,
            maxEnvRelativePath: DEFAULT_MAX_ENV_RELATIVE_PATH
          }
        : undefined)
    if (!budget)
      return { cache: this.cache, budget: { maxCacheRelativePath: 0, maxEnvRelativePath: 0 } }
    if (platform !== 'win32') return { cache: this.cache, budget }

    const cache =
      this.deps.cache ?? selectMicromambaCache(this.deps.root, budget.maxCacheRelativePath)
    const prefix = envPrefix(this.deps.root, spec.name)
    if (
      cache.path.length + budget.maxCacheRelativePath > WINDOWS_MAX_USABLE_PATH ||
      prefix.length + budget.maxEnvRelativePath > WINDOWS_MAX_USABLE_PATH
    ) {
      throw new Error(
        `Managed ${spec.language} ${spec.version} pack exceeds the Windows path budget for ` +
          `${spec.name}; choose a shorter data-root path.`
      )
    }
    return { cache, budget }
  }

  private async runWithMaxPathRecovery(
    run: () => Promise<void>,
    onRecovery?: () => void,
    cache: MicromambaCache = this.cache
  ): Promise<void> {
    try {
      await run()
    } catch (original) {
      if (this.abort?.signal.aborted) throw original
      const recovered = await withExclusiveCacheLocks(this.cacheLockKeys(cache), () =>
        Promise.resolve(
          recoverWindowsMaxPathPackage(original, this.cacheRoots(cache), {
            platform: this.deps.platform
          })
        )
      )
      if (!recovered) throw original
      onRecovery?.()
      try {
        await run()
      } catch (retry) {
        throw new MaxPathRetryError(original, retry)
      }
    }
  }

  private async cleanLegacyWindowsUrlCache(
    cache: MicromambaCache,
    onProgress: (p: ProvisionProgress) => void
  ): Promise<void> {
    if (this.legacyCacheCleanupComplete || (this.deps.platform ?? process.platform) !== 'win32')
      return
    const removed = await withExclusiveCacheLocks(this.cacheLockKeys(cache), () =>
      Promise.resolve(
        removeOverBudgetUrlPackages(pkgsCache(this.deps.root), {
          platform: this.deps.platform
        })
      )
    )
    this.legacyCacheCleanupComplete = true
    if (removed) {
      onProgress({
        phase: 'upgrade',
        message: 'Removed a legacy package blocked by the Windows path limit.',
        progress: 0.05
      })
    }
  }

  // Set for the duration of a provision/upgrade/repair so cancel() can abort the in-flight download
  // (fetch signal) and micromamba create (execFile signal). Cleared in each op's finally. Runs are
  // serialized (env-ipc.serializeProvisioner), so at most one op is ever in flight -> one controller.
  private abort?: AbortController
  // The language whose provision is currently in flight (python/r), so cancel(lang) can tell "abort the
  // RUNNING one" from "a different, still-queued one".
  private runningLanguage?: NotebookLanguage
  // Languages whose provision was cancelled WHILE QUEUED (behind another language's in-flight run):
  // provisionPython/provisionR throw at entry when their language is present, so the queued run is
  // skipped instead of starting after the one the user was actually waiting on.
  private readonly cancelRequested = new Set<NotebookLanguage>()
  // Languages whose repair is CURRENTLY EXECUTING (past the cancel-check in runLanguage). Once a Reset
  // crosses the destructive boundary (clearing the quarantine + rm -rf prefix) it must run to completion
  // — aborting mid-repair leaves a deleted-but-not-rebuilt env with the evidence already cleared. A
  // per-language cancel (from the UI's Cancel button) is ignored while the language is in this set; a
  // global/quit cancel (abort without a language) still fires (app quit must take precedence).
  private readonly uninterruptible = new Set<NotebookLanguage>()

  // Low-level per-language cancel PRIMITIVE. If `language` is the RUNNING one, abort its download/child;
  // otherwise arm a one-shot skip so that language's NEXT run is skipped at entry; `undefined` aborts
  // whatever is in flight. It cannot tell "queued" from "idle" (it doesn't see the run queue), so the
  // "No-op when idle" contract is enforced one layer up in env-ipc.serializeProvisioner, which only
  // forwards cancel for a language that actually has a pending run. Callers that bypass the serialized
  // wrapper get the primitive's arm-skip behavior.
  cancel(language?: NotebookLanguage): void {
    // A per-language cancel is ignored while that language's repair is past the destructive boundary
    // (uninterruptible). A global cancel (app quit) always fires regardless.
    if (language !== undefined && this.uninterruptible.has(language)) return
    if (language === undefined || language === this.runningLanguage) {
      this.abort?.abort(new Error('Runtime setup cancelled.'))
      return
    }
    this.cancelRequested.add(language)
  }

  // Throws if this language's provision was cancelled while queued; otherwise marks it running with a
  // fresh abort controller. Returns the controller's cleanup for the caller's finally.
  private beginLanguageRun(language: NotebookLanguage): void {
    if (this.cancelRequested.delete(language)) {
      throw new Error('Runtime setup cancelled.')
    }
    this.runningLanguage = language
    this.abort = new AbortController()
  }

  private endLanguageRun(language: NotebookLanguage): void {
    this.runningLanguage = undefined
    this.abort = undefined
    this.cancelRequested.delete(language)
  }

  // Emits eased create-phase progress on a timer for the duration of a create (see CREATE_* above), so
  // the bar advances through micromamba's long opaque extract instead of freezing. Returns a stop fn
  // that clears the timer (idempotent; safe to call more than once). The timer is unref'd so it never
  // keeps the process alive on its own.
  private startCreateTicker(spec: EnvSpec, onProgress: (p: ProvisionProgress) => void): () => void {
    let progress = CREATE_FLOOR
    const schedule = this.deps.scheduleTick ?? defaultScheduleTick
    return schedule(() => {
      progress += (CREATE_CEIL - progress) * CREATE_TICK_GAIN
      onProgress({
        phase: `create-${spec.language}`,
        message: `Creating ${spec.name} environment…`,
        progress
      })
    }, CREATE_TICK_MS)
  }

  // Journals a prefix-writing micromamba op (create / named create / relocation restore / upgrade) so a
  // crash mid-write leaves a recoverable record: the next startup reconciles the prefix only once the
  // recorded child is PROVABLY gone, and otherwise (liveness unconfirmed) BLOCKS the prefix so create/
  // remove/repair/restore refuse to race the orphan (the whole point of the self-guard). It never signals
  // the orphan — an unprobeable one clears only on a proven reboot. `run` performs the actual runArgv
  // and MUST forward the provided onChild so the child PID is journaled. Journal begin() is FAIL-CLOSED:
  // if we can't durably record the write-intent, the write is refused (a crash would leave no record for
  // recovery to block on). The complete() below stays best-effort — a stale record is reconciled later.
  private async withJournaledPrefixWrite(
    kind: RuntimeOperationKind,
    runtimeId: string,
    prefix: string,
    phase: string,
    // `run` performs the actual spawn(s). It MUST pass `onBeforeSpawn` and `onChild` to runArgv so the
    // per-spawn intent is re-armed and the PID recorded around EACH spawn (an op may spawn more than
    // once: create + cache-repair retry).
    run: (onBeforeSpawn: () => void, onChild: (pid: number) => void) => Promise<void>
  ): Promise<void> {
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(this.deps.root))
    const operationId = randomUUID()
    // Fail CLOSED: if we can't record the write-intent, we can't crash-safely perform the write (a
    // crash would leave nothing for recovery to block), so refuse rather than doing an un-recoverable
    // prefix write. (complete() below stays best-effort — a stale record is harmless; the next startup
    // reconciles it.)
    await journal.begin({
      operationId,
      kind,
      runtimeId,
      phase,
      startedAt: Date.now(),
      targetPath: prefix
    })
    // Re-arm the spawn intent immediately before EACH spawn (fail-closed: throwing aborts the spawn).
    // Writing it per-spawn — not once per op — means a second spawn (create retry) whose PID isn't
    // recorded yet leaves a fresh "spawning" sidecar (block), not a stale earlier PID (reconcile).
    const onBeforeSpawn = (): void => recordSpawnIntentSync(this.deps.root, operationId)
    const onChild = (childPid: number): void => {
      const childStartedAt = Date.now()
      // Capture the kernel-native identity token NOW, while the child is provably alive, so recovery can
      // later FALSIFY reuse (a changed token proves the pid is no longer ours). undefined off Linux — a
      // tokenless live pid is then always 'unknown' (childStartedAt is retained only for diagnostics, not
      // liveness: a wall-clock value can't soundly prove a live pid dead).
      const childStartToken = readProcessStartToken(childPid)
      // Convert the intent to the real PID SYNCHRONOUSLY (durable before this returns). Throws on
      // failure so runArgv can kill the just-spawned child and fail closed rather than leave it
      // unrecorded. The async journal update is the normal (non-crash) read path.
      recordOperationChildSync(this.deps.root, operationId, {
        childPid,
        childStartedAt,
        childStartToken
      })
      void journal
        .update(operationId, { childPid, childStartedAt, childStartToken })
        .catch(() => undefined)
    }
    let retainForRecovery = false
    try {
      await run(onBeforeSpawn, onChild)
    } catch (error) {
      // A recording failure whose child could NOT be confirmed stopped: a worker may still be writing
      // the prefix, so KEEP the sidecar + journal record (recovery blocks) instead of clearing them.
      if (isChildUnconfirmedError(error)) {
        retainForRecovery = true
        // Block the prefix IN THIS PROCESS now — not just via the retained journal entry, which only
        // gates the next boot. Otherwise an in-session Retry would pass assertPrefixWritable and begin()
        // a SECOND op (begin() does not reject a same-runtime record), spawning a worker that races the
        // first's possibly-live orphan on the same prefix. Also mark it live-unconfirmed so a force Reset
        // this session refuses to delete it out from under that orphan (clearQuarantine).
        this.liveUnconfirmedPrefixes.add(prefix)
        this.deps.blockPrefix?.(prefix)
      }
      throw error
    } finally {
      if (!retainForRecovery) {
        removeOperationChildSync(this.deps.root, operationId)
        await journal.complete(operationId).catch(() => undefined)
      }
    }
  }

  // Refuses to write a prefix crash-recovery flagged possibly-live (see ProvisionerDeps.isPrefixBlocked).
  // Called at every prefix-write site so an unknown-liveness orphan blocks the write this session —
  // covering the startup gate's restore/upgrade/repair, not just the UI provision/repair handlers.
  private assertPrefixWritable(prefix: string): void {
    if (this.deps.isPrefixBlocked?.(prefix)) {
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: a previous operation on "${prefix}" was interrupted and its worker ` +
          'process could not be confirmed stopped, so writing this environment now could corrupt it. ' +
          // Honest: a probeable worker clears itself once it exits (re-checked each restart); an
          // unprobeable/uncertain block will NOT clear on its own, so point the user at Reset.
          'On restart it clears automatically once its worker is confirmed stopped; if it persists, ' +
          'use Reset in Settings → Runtimes to recover this environment.'
      )
    }
  }

  // Reset guard for ONE spawn-lifecycle sidecar state. Throws RUNTIME_RECOVERY_BLOCKED if the state might
  // still have a live writer we cannot account for; returns normally when it is provably safe to clear.
  // Shared by the normal (per-record) and corrupt-journal (per-sidecar) Reset paths so both apply the
  // identical, sound policy: probe a known pid, and for an unprobeable no-PID orphan demand a proven reboot.
  private assertChildStateClearable(
    prefix: string,
    state: OperationChildState | 'corrupt',
    confirmStopped: (record: {
      childPid: number
      childStartedAt?: number
      childStartToken?: string
    }) => Promise<boolean>
  ): Promise<void> {
    if (state !== 'corrupt' && 'childPid' in state) {
      // A verifiable pid: probe it. confirmStopped returns true only for a provably-gone/reused child.
      return confirmStopped(state).then((stopped) => {
        if (!stopped)
          throw new Error(
            `RUNTIME_RECOVERY_BLOCKED: a worker process for "${prefix}" is still running and could ` +
              'not be stopped, so the environment was not reset (resetting under a live worker could ' +
              'corrupt it). Quit any running notebook work and try again, or restart the app.'
          )
      })
    }
    // No verifiable pid: either a {spawning} intent whose PID never landed, or a corrupt sidecar. A child
    // MAY be live and is unprobeable — we can't signal it, and an APP restart does NOT prove a reparented
    // micromamba/pip exited. Only a MACHINE reboot does. The boot_id captured in the {spawning} sidecar
    // (journal-independent, so this holds even when the journal is corrupt) must prove the box rebooted;
    // a corrupt sidecar has no readable token → always refuse. Never rm a prefix a live orphan may hold.
    const recordedBoot = state !== 'corrupt' && 'spawning' in state ? state.bootToken : undefined
    const readBoot = this.deps.readBootToken ?? readBootToken
    if (!bootTokenProvesReboot(recordedBoot, readBoot())) {
      // Platform-specific guidance: Linux can prove reboot via boot_id; macOS/Windows cannot, so we tell
      // the user the manual escape hatch (deleting the recovery metadata) rather than an impossible reboot.
      const isLinux = process.platform === 'linux'
      const guidance = isLinux
        ? 'Restart your computer, then try Reset again (a reboot proves the process is gone).'
        : 'The process cannot be verified as stopped on this platform. If you are certain no install is ' +
          'running, quit the app, manually delete the recovery metadata files in ' +
          `"${this.deps.root}/operation-*.json", then relaunch and try Reset again.`
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: an install/build process for "${prefix}" was interrupted before its ` +
          'process id could be recorded, so it cannot be signalled or verified stopped. An app restart ' +
          `does not guarantee that process exited. ${guidance}`
      )
    }
    return Promise.resolve()
  }

  // Clears a recovery QUARANTINE for a prefix (an explicit user Reset): drops the in-memory block and
  // clears every retained journal record + PID sidecar that targets this prefix, so the subsequent
  // rebuild is not refused and the quarantine does not re-arm on the next startup. The user has decided
  // to force recovery; this is the manual entry the auto-path can't provide for an uncertain block.
  private async clearQuarantine(prefix: string): Promise<void> {
    // A worker THIS process spawned but could not confirm stopped (its PID never landed, so it is
    // unprobeable) may still be writing this prefix. Deleting + rebuilding now could corrupt it out from
    // under that live orphan, and there is no pid to kill first — so refuse the Reset this session. Two
    // sources: this provisioner's OWN prefix writes (local set) and a package install into the same prefix
    // (the service's set, via the injected dep — the provisioner never sees install failures directly).
    // Both are per-process in-memory sets, cleared on restart. After an app restart they are empty, so the
    // records/sidecar loop below governs instead — and it demands a proven MACHINE reboot for a no-PID
    // orphan (an app restart alone does NOT prove a reparented worker exited). Checked FIRST, before
    // readState(): it catches the in-memory orphan recorded THIS session even when the journal is corrupt
    // (the two can co-occur — an unreadable journal says nothing about the orphan we hold in memory).
    if (this.liveUnconfirmedPrefixes.has(prefix) || this.deps.isPrefixLiveUnconfirmed?.(prefix)) {
      throw new Error(
        `RUNTIME_RECOVERY_BLOCKED: a worker process for "${prefix}" was started but could not be ` +
          'confirmed stopped, and its process id was never recorded so it cannot be signalled. ' +
          'Resetting now could corrupt the environment if that worker is still running. An app restart ' +
          'does not prove a reparented install/build process exited — restart your computer, then try ' +
          'Reset again (a reboot proves the process is gone).'
      )
    }
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(this.deps.root))
    const confirmStopped = this.deps.confirmChildStopped ?? defaultConfirmChildStopped
    const state = await journal.readState()
    if (state === 'corrupt') {
      // The journal is unreadable, so we can't map records to this prefix — but the child-state SIDECARS
      // are separate files and survive a corrupt journal. A corrupt journal says NOTHING about whether an
      // orphan is live, so we must NOT blindly rm the prefix (the old bug). Instead scan every sidecar and
      // apply the SAME guard as the normal path: a probeable pid must be confirmed stopped; an unprobeable
      // no-PID orphan needs a proven reboot (its boot_id lives in the sidecar, not the journal). We can't
      // tell which sidecar targets THIS prefix, so any possibly-live writer anywhere refuses the Reset —
      // the safe, conservative choice. assertChildStateClearable throws RUNTIME_RECOVERY_BLOCKED if unsafe.
      for (const { state: childState } of listOperationChildren(this.deps.root))
        await this.assertChildStateClearable(prefix, childState, confirmStopped)
      // All clear (or nothing spawned). MOVE the corrupt journal aside (preserved as evidence) BEFORE the
      // caller's rm, so the rebuild's begin() reads a clean/absent journal; it throws if it can't move the
      // file → we do NOT proceed to delete the prefix. Then drop this prefix's sidecars so a later
      // unrelated Reset isn't blocked by a now-stale entry.
      await journal.quarantineCorrupt()
      for (const { operationId } of listOperationChildren(this.deps.root))
        removeOperationChildSync(this.deps.root, operationId)
      this.deps.clearPrefixBlock?.(prefix)
      // Release only THIS prefix from the global corrupt barrier — a corrupt journal can't tell us which
      // env had in-flight work, so resetting one must not unblock the others. They stay blocked until
      // their own Reset or a restart (which re-reads the now-quarantined journal as absent and clears).
      this.deps.clearCorruptBlock?.(prefix)
      return
    }
    const records = state.records.filter((record) => record.targetPath === prefix)
    // A KNOWN worker may still be alive (e.g. Reset without a restart). Reset then deletes + rebuilds the
    // prefix, so we must NOT drop the block and delete evidence out from under a live writer. For each
    // record, resolve its spawn-lifecycle state and apply the shared guard (assertChildStateClearable): a
    // probeable pid must be confirmed provably stopped; an unprobeable no-PID orphan (a spawn whose PID
    // never landed) needs a proven machine reboot. Otherwise the Reset is refused (keep the quarantine).
    for (const record of records) {
      const sidecar = readOperationChild(this.deps.root, record.operationId)
      // Resolve the state to guard on. A VALID sidecar is authoritative. When the sidecar is ABSENT we
      // fall back to a legacy journal-recorded PID (older records had no sidecar); with neither, the op
      // never reached the spawn stage → nothing to guard. A {spawning}/corrupt sidecar is passed through
      // as-is (no verifiable pid) — never fall back to the journal's PID from an EARLIER spawn.
      const childState: OperationChildState | 'corrupt' | undefined =
        sidecar === undefined
          ? record.childPid !== undefined
            ? {
                childPid: record.childPid,
                childStartedAt: record.childStartedAt ?? 0,
                childStartToken: record.childStartToken
              }
            : undefined
          : sidecar
      if (childState === undefined) continue // op never spawned → safe to clear
      await this.assertChildStateClearable(prefix, childState, confirmStopped)
    }
    // The worker is confirmed gone (or was never recorded): drop the blocks and clear the retained
    // journal records + sidecars for this prefix, so the rebuild isn't refused and the quarantine does
    // not re-arm next startup. An interrupted install also blocks its runtimeId — clear that too, or a
    // bound session would still be rejected by blockedRuntimeIds after the env rebuilds.
    this.deps.clearPrefixBlock?.(prefix)
    // Also release this prefix from the global corrupt-journal barrier. A FIRST corrupt Reset already
    // moved the journal aside, so a LATER env's Reset reaches this (non-corrupt) branch and would never
    // otherwise call clearCorruptBlock — leaving that env stuck under recoveryCorrupt until a restart.
    // Idempotent (just allowlists the prefix); a no-op when the journal was never corrupt.
    this.deps.clearCorruptBlock?.(prefix)
    for (const record of records) {
      if (record.kind === 'install' && record.runtimeId)
        this.deps.clearRuntimeBlock?.(record.runtimeId)
      removeOperationChildSync(this.deps.root, record.operationId)
      await journal.complete(record.operationId).catch(() => undefined)
    }
  }

  status(): ProvisionStatus {
    const marker = readReadyMarker(this.deps.root)
    return {
      pythonReady: pythonReady(this.deps.root, DEFAULT_ENV_VERSION),
      rReady: rReady(this.deps.root),
      version: marker?.defaultEnvVersion ?? 0,
      provisioning: this.provisioning,
      bundleSource: this.deps.bundleSource,
      // Surface a recovery quarantine so the UI can offer Reset even when the interpreter/marker still
      // read as ready (recovery blocks the prefix in memory without touching the marker).
      pythonRecoveryBlocked: this.deps.isPrefixBlocked?.(envPrefix(this.deps.root, DEFAULT_PY_ENV)),
      rRecoveryBlocked: this.deps.isPrefixBlocked?.(envPrefix(this.deps.root, DEFAULT_R_ENV))
    }
  }

  // Runs a prefix-mutating section under the injected per-env lock (the service's install lock) so a
  // default-env create/repair/upgrade never runs concurrently with a package install into the SAME env
  // prefix. No-op wrapper when unwired (unit tests). MUST NOT be called nested for the same env name —
  // the lock is exclusive — so the lock lives at the top-level entries and the do*/materialize helpers
  // it calls stay lock-free.
  private withEnvPrefixLock<T>(envName: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.withPrefixLock ? this.deps.withPrefixLock(envName, fn) : fn()
  }

  private cleanupLegacyDefaultPrefix(name: string): void {
    if ((this.deps.platform ?? process.platform) !== 'win32') return
    if (name !== DEFAULT_PY_ENV && name !== DEFAULT_R_ENV) return
    const legacy = legacyDefaultEnvPrefix(this.deps.root, name)
    if (envPrefix(this.deps.root, name, 'win32') === legacy) return
    if (this.deps.isPrefixBlocked?.(legacy)) return
    try {
      rmSync(legacy, { recursive: true, force: true })
    } catch {
      // The short prefix is already verified and authoritative. A locked legacy directory is inert
      // residue and can be retried by a later startup or removed by storage cleanup.
    }
  }

  private markerPrefixDirectory(
    name: typeof DEFAULT_PY_ENV | typeof DEFAULT_R_ENV
  ): string | undefined {
    const platform = this.deps.platform ?? process.platform
    return platform === 'win32' ? basename(envPrefix(this.deps.root, name, platform)) : undefined
  }

  // Wraps a language run so a QUEUED cancel is consumed (beginLanguageRun throws) BEFORE the run does
  // any work, and the provisioning flag + abort controller cover the whole run. repair uses this too, so
  // a cancel that arrived while the Reset was queued aborts BEFORE the destructive rm — never leaving a
  // deleted-but-not-rebuilt env. The wrapped body must NOT call beginLanguageRun itself (single owner).
  private async runLanguage(language: NotebookLanguage, run: () => Promise<void>): Promise<void> {
    this.beginLanguageRun(language)
    this.provisioning = true
    try {
      await run()
    } finally {
      this.provisioning = false
      this.endLanguageRun(language)
    }
  }

  async provisionPython(rawProgress: (p: ProvisionProgress) => void): Promise<void> {
    return this.withEnvPrefixLock(DEFAULT_PY_ENV, () =>
      this.runLanguage('python', () => this.doProvisionPython(rawProgress))
    )
  }

  // The provision work only — the language run (cancel check, provisioning flag) is owned by the caller
  // (runLanguage), so repair can wrap its rm + this rebuild in ONE run without a double beginLanguageRun.
  private async doProvisionPython(rawProgress: (p: ProvisionProgress) => void): Promise<void> {
    const onProgress = withLanguage(rawProgress, 'python')
    await this.materialize(DEFAULT_PYTHON_SPEC, onProgress)
    // Python is the app gate: stamp the ready marker only after create+verify succeed.
    writeReadyMarker(
      this.deps.root,
      DEFAULT_ENV_VERSION,
      (this.deps.now ?? defaultNow)(),
      this.markerPrefixDirectory(DEFAULT_PY_ENV)
    )
    this.cleanupLegacyDefaultPrefix(DEFAULT_PY_ENV)
    onProgress({ phase: 'done', message: 'Python environment ready', progress: 1 })
  }

  async provisionR(rawProgress: (p: ProvisionProgress) => void): Promise<void> {
    return this.withEnvPrefixLock(DEFAULT_R_ENV, () =>
      this.runLanguage('r', () => this.doProvisionR(rawProgress))
    )
  }

  private async doProvisionR(rawProgress: (p: ProvisionProgress) => void): Promise<void> {
    const onProgress = withLanguage(rawProgress, 'r')
    // R is lazy, but once present it has its own version marker. A legacy/stale R prefix is upgraded
    // from the current explicit pack instead of being accepted merely because R.exe exists.
    if (rMaterialized(this.deps.root) && !rReady(this.deps.root)) {
      await this.upgradeOrRebuildR(onProgress)
    } else {
      await this.materialize(DEFAULT_R_SPEC, onProgress)
    }
    writeRReadyMarker(
      this.deps.root,
      DEFAULT_ENV_VERSION,
      (this.deps.now ?? defaultNow)(),
      this.markerPrefixDirectory(DEFAULT_R_ENV)
    )
    this.cleanupLegacyDefaultPrefix(DEFAULT_R_ENV)
    onProgress({ phase: 'done', message: 'R environment ready', progress: 1 })
  }

  async upgradeIfNeeded(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const marker = readReadyMarker(this.deps.root)
    if (!marker || marker.defaultEnvVersion >= DEFAULT_ENV_VERSION) return
    this.provisioning = true
    try {
      // Refuse to write the python prefix if recovery flagged it possibly-live — an additive
      // `install --file` still writes into it, so it must not race a survivor either.
      this.assertPrefixWritable(envPrefix(this.deps.root, DEFAULT_PY_ENV))
      // Apply the exact published baseline to the existing env. `install --file --offline` preserves
      // extra user packages while avoiding a repodata solve for the platform-maintained floor.
      onProgress({ phase: 'upgrade', message: 'Updating default packages…', progress: 0.1 })
      // Hold the env lock around each additive `install --file` so it can't overlap a package install
      // into the same env. Per-env (python then R), matching the service's install-lock key.
      await this.withEnvPrefixLock(DEFAULT_PY_ENV, () =>
        this.upgradeFromBundle(DEFAULT_PYTHON_SPEC, onProgress)
      )
      // R is upgraded additively only if already materialized (lazy; spec §6.5) AND not recovery-blocked
      // — a blocked R prefix skips its upgrade rather than failing the (already-applied) python upgrade.
      if (
        rMaterialized(this.deps.root) &&
        !this.deps.isPrefixBlocked?.(envPrefix(this.deps.root, DEFAULT_R_ENV))
      ) {
        onProgress({ phase: 'upgrade-r', message: 'Updating R packages…', progress: 0.6 })
        await this.withEnvPrefixLock(DEFAULT_R_ENV, () => this.upgradeOrRebuildR(onProgress))
        writeRReadyMarker(
          this.deps.root,
          DEFAULT_ENV_VERSION,
          (this.deps.now ?? defaultNow)(),
          this.markerPrefixDirectory(DEFAULT_R_ENV)
        )
      }
      writeReadyMarker(
        this.deps.root,
        DEFAULT_ENV_VERSION,
        (this.deps.now ?? defaultNow)(),
        this.markerPrefixDirectory(DEFAULT_PY_ENV)
      )
      onProgress({ phase: 'done', message: 'Default environments updated', progress: 1 })
    } finally {
      this.provisioning = false
    }
  }

  async repair(
    lang: NotebookLanguage,
    rawProgress: (p: ProvisionProgress) => void,
    opts?: { force?: boolean }
  ): Promise<void> {
    const onProgress = withLanguage(rawProgress, lang)
    const spec = lang === 'r' ? DEFAULT_R_SPEC : DEFAULT_PYTHON_SPEC
    const prefix = envPrefix(this.deps.root, spec.name)
    // Hold the env lock across the WHOLE destructive cycle (quarantine clear / block check → rm →
    // rebuild), so a package install into this env can't slip in between the rm and the rebuild and
    // write into a half-deleted prefix. The rebuild calls the LOCK-FREE do* variants (not the public
    // provision*), which would otherwise re-acquire this same exclusive lock and deadlock.
    return this.withEnvPrefixLock(spec.name, () =>
      // runLanguage consumes a QUEUED cancel (beginLanguageRun throws) BEFORE the rm below, so
      // cancelling a queued Reset never leaves a deleted-but-not-rebuilt env.
      this.runLanguage(lang, async () => {
        // Mark this repair UNINTERRUPTIBLE before any destructive step: once we clear the quarantine
        // and rm the prefix there is no safe stopping point — a per-language Cancel arriving mid-repair
        // would abort the rebuild and leave a missing/half-built env with the block already cleared.
        // (Global/quit cancel still works to handle app shutdown.)
        this.uninterruptible.add(lang)
        try {
          if (opts?.force) {
            // EXPLICIT user recovery: clear the quarantine (in-memory block + retained journal record +
            // sidecar) so the rebuild below — and its inner materialize — aren't refused by the block
            // guard. The user has accepted any interrupted worker is gone. This is the manual recovery.
            await this.clearQuarantine(prefix)
          } else {
            // Refuse before deleting: a repair rm -rf + rebuild is the most destructive prefix write,
            // so it must never run over a prefix an unknown-liveness orphan may still hold (the startup
            // planner picks 'repair' on a partial prefix, the concrete path the barrier alone missed).
            this.assertPrefixWritable(prefix)
          }
          // Manual repair / corruption path (spec §6.3): delete the env prefix then re-provision fresh.
          // For python also clear the marker so a partially-deleted state cannot read as ready.
          rmSync(envPrefix(this.deps.root, spec.name), { recursive: true, force: true })
          if (lang === 'python') {
            rmSync(readyMarkerPath(this.deps.root), { force: true })
            await this.doProvisionPython(onProgress)
          } else {
            rmSync(rReadyMarkerPath(this.deps.root), { force: true })
            await this.doProvisionR(onProgress)
          }
        } finally {
          this.uninterruptible.delete(lang)
        }
      })
    )
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
      // Commit a DEFAULT env's ready marker BEFORE consuming (deleting) its lock, so a crash between the
      // two never leaves a valid prefix with neither marker nor lock — which the startup planner would
      // 'repair' (delete + rebuild), losing the relocated user packages. A crash after the marker but
      // before the lock delete is safe: the next startup reads 'ready' and re-consumes the leftover lock
      // idempotently.
      const stampDefaultMarkerBeforeLock = (envName: string): void => {
        const now = (this.deps.now ?? defaultNow)()
        if (envName === DEFAULT_PY_ENV)
          writeReadyMarker(
            this.deps.root,
            DEFAULT_ENV_VERSION,
            now,
            this.markerPrefixDirectory(DEFAULT_PY_ENV)
          )
        else if (envName === DEFAULT_R_ENV)
          writeRReadyMarker(
            this.deps.root,
            DEFAULT_ENV_VERSION,
            now,
            this.markerPrefixDirectory(DEFAULT_R_ENV)
          )
      }
      for (const file of files) {
        const name = file.slice(0, -'.lock'.length)
        // Serialize each env's restore with a package install into the SAME env (managePackages holds
        // the same key): restore rm -rf's + rebuilds the prefix, and the startup gate runs async with
        // IPC already registered, so without one shared lock a restore could race an installer mid-write.
        await this.withEnvPrefixLock(name, async () => {
          const prefix = envPrefix(this.deps.root, name)
          // Skip (leave the lock for a later launch) if recovery flagged this prefix possibly-live: the
          // restore path rm -rf's a broken partial and recreates, which must not race an orphan writer.
          // Other envs still restore; a later restart re-checks the pid and unblocks.
          if (this.deps.isPrefixBlocked?.(prefix)) return
          // A prior restore may have materialized the interpreter before being interrupted. Verify it
          // before consuming the lock; a broken partial prefix is removed and rebuilt below.
          const existingBin = existsSync(pythonBin(prefix))
            ? pythonBin(prefix)
            : existsSync(rBin(prefix))
              ? rBin(prefix)
              : undefined
          if (existingBin) {
            let verified = false
            try {
              await this.deps.verify(existingBin, prefix)
              verified = true
            } catch {
              // Broken partial — fall through to rebuild. The delete happens INSIDE the journal wrapper
              // below (never before begin), so a fail-closed begin() can't leave the prefix deleted.
            }
            if (verified) {
              // The env is VALID. Commit the marker (default env) then consume its lock. If either write
              // fails (permissions / disk / path), KEEP the working prefix AND its lock — never rebuild a
              // valid relocated env over a marker/fs hiccup; retry next launch.
              try {
                stampDefaultMarkerBeforeLock(name) // marker BEFORE lock delete (no data-loss window)
                rmSync(join(dir, file), { force: true })
                this.cleanupLegacyDefaultPrefix(name)
              } catch {
                // Marker/lock write failed — leave the working env and its lock intact for a later launch.
              }
              return
            }
          }
          onProgress({ phase: 'restore', message: `Restoring ${name}…`, progress: 0.5 })
          try {
            // Journal the rebuild (child PID + prefix) so a crash mid-restore is recovered like a
            // materialize. The prefix cleanup + create both run INSIDE the wrapper (after begin
            // succeeds), so nothing is deleted un-recoverably if begin fails closed. Shared pkgs cache
            // lock + MAX_PATH recovery: this rebuild-from-lock extracts into the shared cache, so a
            // concurrent corrupt-cache repair (cache-exclusive) can't delete an incomplete extraction,
            // and a Windows path-limit failure is retried once after a short cache recovery.
            await this.withJournaledPrefixWrite(
              'materialize',
              name,
              prefix,
              'restore',
              (onBeforeSpawn, onChild) =>
                this.runWithMaxPathRecovery(
                  () =>
                    withSharedCacheLocks(this.cacheLockKeys(this.cache), () => {
                      // Reaching here means the prefix is broken (verify failed) or a partial (e.g.
                      // conda-meta with no interpreter, which would wedge `create -p` forever) — clear it
                      // so the offline recreate starts clean. No abort signal: restore has no per-language
                      // cancel path, and this.abort may belong to a concurrent default provision.
                      rmSync(prefix, { recursive: true, force: true })
                      return this.deps.runArgv(
                        createFromLockArgv(this.deps.mm, this.deps.root, prefix, join(dir, file)),
                        undefined,
                        onChild,
                        onBeforeSpawn,
                        this.cache,
                        DEFAULT_MAX_CACHE_RELATIVE_PATH
                      )
                    }),
                  undefined,
                  this.cache
                )
            )
            const bin = existsSync(pythonBin(prefix)) ? pythonBin(prefix) : rBin(prefix)
            await this.deps.verify(bin, prefix)
            stampDefaultMarkerBeforeLock(name) // marker BEFORE lock delete (no data-loss window)
            rmSync(join(dir, file), { force: true })
            this.cleanupLegacyDefaultPrefix(name)
          } catch {
            // Leave the lock in place: retried next launch; the readiness gate re-provisions defaults
            // in the meantime so the app stays usable.
          }
        })
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
    if (
      (this.deps.platform ?? process.platform) === 'win32' &&
      prefix.length + DEFAULT_MAX_ENV_RELATIVE_PATH > WINDOWS_MAX_USABLE_PATH
    ) {
      throw new Error(
        `Named environment "${name}" exceeds the conservative Windows environment path budget; ` +
          'choose a shorter name or data-root path.'
      )
    }
    const bin = language === 'python' ? pythonBin(prefix) : rBin(prefix)
    // Refuse if recovery flagged this named prefix possibly-live (an orphan create/install may still
    // be writing it) — the service also gates this, but self-guarding covers every caller.
    this.assertPrefixWritable(prefix)
    // Journal the create (child PID + prefix) so a crash mid-create is recovered like any other prefix
    // write: a survivor is killed and, if unconfirmed, the prefix is blocked so a later create/remove
    // can't race it. Take the shared pkgs cache lock (+ MAX_PATH recovery) for the whole prefix cleanup
    // + create: this create extracts into the SHARED cache, so a concurrent corrupt-cache repair (which
    // takes the cache EXCLUSIVE and deletes incomplete extractions) must not run mid-create and delete a
    // package dir we are still producing, and a Windows path-limit failure is retried once after a short
    // cache recovery.
    await this.withJournaledPrefixWrite(
      'materialize',
      name,
      prefix,
      `create-${language}`,
      (onBeforeSpawn, onChild) =>
        this.runWithMaxPathRecovery(() =>
          withSharedCacheLocks(this.cacheLockKeys(this.cache), async () => {
            // Clear a half-built prefix from an interrupted prior create (incl. conda-meta-but-no-
            // interpreter) so micromamba doesn't abort on it.
            this.clearIncompletePrefix(prefix, bin)
            // NO abort signal: this.abort belongs to the currently-running default provision (python/r),
            // and a named create runs on the RAW provisioner concurrently with the serialized default one
            // (ipc.ts wires them separately). Passing this.abort here would let a cancel of the default env
            // abort this unrelated named-env child. Named create has no per-language cancel path of its own.
            await this.deps.runArgv(
              createFromPackagesArgv(
                this.deps.mm,
                this.deps.root,
                prefix,
                [this.deps.channel],
                pkgs
              ),
              undefined,
              onChild,
              onBeforeSpawn,
              this.cache,
              DEFAULT_MAX_CACHE_RELATIVE_PATH
            )
          })
        )
    )
    await this.deps.verify(bin, prefix)
    return {
      name,
      language,
      ready: existsSync(bin),
      isDefault: name === DEFAULT_PY_ENV || name === DEFAULT_R_ENV
    }
  }

  // Scans the physical env directory and maps reserved Windows default directories back to their
  // logical names. Dirs with neither interpreter are skipped. Tolerant of a missing envs dir.
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
      const platform = this.deps.platform ?? process.platform
      const name = logicalEnvNameFromDirectory(entry.name)
      const prefix = join(envsDir, entry.name)
      if (prefix !== envPrefix(this.deps.root, name, platform)) continue
      const isPython = existsSync(pythonBin(prefix))
      const isR = !isPython && existsSync(rBin(prefix))
      if (!isPython && !isR) continue
      infos.push({
        name,
        language: isPython ? 'python' : 'r',
        ready: true,
        isDefault: name === DEFAULT_PY_ENV || name === DEFAULT_R_ENV,
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
    // Refuse before the rmSync-and-rebuild branch below can delete a possibly-live prefix.
    this.assertPrefixWritable(prefix)
    try {
      await this.deps.verify(rBin(prefix), prefix)
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
    // Journal the upgrade (child PID + prefix) so a crash mid-install is recovered: the prefix is
    // reconciled only once the survivor is provably gone, else it is blocked. Shared pkgs cache lock (+
    // MAX_PATH recovery):
    // this install extracts into the shared cache, so a concurrent corrupt-cache repair (cache-exclusive)
    // must not delete an incomplete extraction mid-upgrade, and a Windows path-limit failure is retried
    // once after a short cache recovery.
    const selected = this.cacheForBundle(spec, bundle)
    await this.cleanLegacyWindowsUrlCache(selected.cache, onProgress)
    await this.withJournaledPrefixWrite(
      'upgrade',
      spec.name,
      prefix,
      `upgrade-${spec.language}`,
      (onBeforeSpawn, onChild) =>
        this.runWithMaxPathRecovery(
          () =>
            withSharedCacheLocks(this.cacheLockKeys(selected.cache), () =>
              this.deps.runArgv(
                installFromLockArgv(this.deps.mm, this.deps.root, prefix, bundle.lockPath),
                this.abort?.signal,
                onChild,
                onBeforeSpawn,
                selected.cache,
                selected.budget.maxCacheRelativePath || DEFAULT_MAX_CACHE_RELATIVE_PATH
              )
            ),
          undefined,
          selected.cache
        )
    )
    await this.deps.verify(bin, prefix)
  }

  // Clears a HALF-BUILT prefix before a create so micromamba starts clean. A prefix is incomplete —
  // and must be removed — unless it has BOTH conda-meta AND its interpreter binary. Two failure modes
  // this fixes:
  //   • Non-conda leftover (dir exists, no conda-meta): a create died before conda-meta was written;
  //     `create -p` aborts with "Non-conda folder exists at prefix".
  //   • conda-meta present but interpreter MISSING: a cancelled/crashed create (observed on Windows for
  //     default-r) leaves conda-meta with no Rscript.exe. The old check returned early on conda-meta, so
  //     every Retry re-ran `create -p` on that half-built prefix and failed permanently. Treat it as
  //     incomplete and rebuild. Safe to delete here: the block-guard (assertPrefixWritable) has already
  //     refused a prefix a live orphan might still be writing, so nothing else is producing this dir.
  // A complete env returns via the idempotent verify path before reaching a create, so a real
  // environment is never nuked here.
  private clearIncompletePrefix(prefix: string, bin: string): void {
    if (!existsSync(prefix)) return
    const complete = existsSync(join(prefix, 'conda-meta')) && existsSync(bin)
    if (complete) return
    rmSync(prefix, { recursive: true, force: true })
  }

  private async materialize(
    spec: EnvSpec,
    onProgress: (p: ProvisionProgress) => void
  ): Promise<void> {
    const prefix = envPrefix(this.deps.root, spec.name)
    // Refuse to touch a prefix recovery flagged possibly-live, even for the idempotent verify path
    // below: an orphan may be mid-write, so treating a half-built interpreter as "ready" is unsafe.
    this.assertPrefixWritable(prefix)
    const bin = spec.language === 'python' ? pythonBin(prefix) : rBin(prefix)
    // Idempotent: if the interpreter is already on disk the env is materialized, so skip fetch+create.
    // This makes a duplicate/concurrent provision (e.g. the UI R-tab and an on-demand agent run both
    // asking for default-r) a no-op instead of a `create -p <existing prefix>` error. repair() deletes
    // the prefix first, so it still rebuilds.
    if (existsSync(bin)) {
      try {
        await this.deps.verify(bin, prefix)
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
      progress: CREATE_FLOOR
    })
    // Select the cache scoped to this bundle (Windows budget) and clear any legacy over-budget URL
    // packages before the create, so a Windows path-limit blocker doesn't fail the first attempt.
    const selected = this.cacheForBundle(spec, bundle)
    await this.cleanLegacyWindowsUrlCache(selected.cache, onProgress)
    // Journal the create (child PID + prefix) so a process death mid-materialize is reconciled at next
    // startup: the recorded child is killed if it survived and, if liveness is unconfirmed, the prefix
    // is blocked. verify() is read-only and stays outside the journaled window.
    await this.withJournaledPrefixWrite(
      'materialize',
      spec.name,
      prefix,
      `create-${spec.language}`,
      async (onBeforeSpawn, onChild) => {
        const runCreate = (
          lockPath: string,
          cache: MicromambaCache = selected.cache,
          budget = selected.budget
        ): Promise<void> => {
          // Advance the bar while micromamba extracts (it reports nothing itself). Stopped in the
          // finally so a create failure/retry doesn't leave the timer running past this attempt.
          const stopTicks = this.startCreateTicker(spec, onProgress)
          // Take the shared pkgs cache lock so a concurrent corrupt-cache repair can't delete a package
          // mid-create. The env prefix cleanup + create run inside it. onBeforeSpawn re-arms the intent
          // for THIS attempt — the retry below is a second spawn and must not trust the first's PID.
          return withSharedCacheLocks(this.cacheLockKeys(cache), () => {
            // Clear a half-built prefix from an interrupted prior attempt (incl. conda-meta-but-no-
            // interpreter) so micromamba doesn't abort on it.
            this.clearIncompletePrefix(prefix, bin)
            return this.deps.runArgv(
              createFromLockArgv(this.deps.mm, this.deps.root, prefix, lockPath),
              this.abort?.signal,
              onChild,
              onBeforeSpawn,
              cache,
              budget.maxCacheRelativePath || DEFAULT_MAX_CACHE_RELATIVE_PATH
            )
          }).finally(stopTicks)
        }
        try {
          await this.runWithMaxPathRecovery(
            () => runCreate(bundle.lockPath),
            () => {
              onProgress({
                phase: `create-${spec.language}`,
                message: `Retrying ${spec.name} with the short Windows package cache…`,
                progress: CREATE_FLOOR
              })
            },
            selected.cache
          )
        } catch (error) {
          // A corrupt pkgs cache (e.g. a prior interrupted extract left an incomplete package dir) makes
          // create abort with "incorrect downloads" / "extracted directory cache". Do NOT wipe the whole
          // shared cache — that would delete other envs' (and the other language's) tarballs needed for
          // offline rebuild. Instead take the cache EXCLUSIVE and remove only INCOMPLETE extracted
          // package dirs (missing info/index.json), preserving every tarball and complete package; then
          // re-seed and retry the create ONCE. If nothing was incomplete, this isn't a corrupt-cache
          // fault we can repair, so surface the original error rather than churn. A cancel is never
          // retried.
          if (
            this.abort?.signal.aborted ||
            error instanceof MaxPathRetryError ||
            !isCorruptPkgsCacheError(error)
          )
            throw error
          const repaired = await withExclusiveCacheLocks(this.cacheLockKeys(selected.cache), () =>
            Promise.resolve(removeIncompleteExtractedPackages(this.cacheRoots(selected.cache)))
          )
          if (!repaired) throw error
          onProgress({
            phase: `create-${spec.language}`,
            message: `Repairing ${spec.name} package cache…`,
            progress: CREATE_FLOOR
          })
          const reseeded = await this.deps.fetchBundle(
            spec,
            DEFAULT_ENV_VERSION,
            onProgress,
            this.abort?.signal
          )
          if (!reseeded) throw error
          const retrySelected = this.cacheForBundle(spec, reseeded)
          await runCreate(reseeded.lockPath, retrySelected.cache, retrySelected.budget)
        }
      }
    )

    onProgress({
      phase: `verify-${spec.language}`,
      message: `Verifying ${spec.name} interpreter…`,
      progress: 0.9
    })
    await this.deps.verify(bin, prefix)
    onProgress({ phase: `${spec.language}-ready`, message: `${spec.name} ready`, progress: 0.97 })
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
// package extraction always has info/repodata_record.json, so a dir lacking it is a partial/interrupted extract.
// Tarball files (*.conda / *.tar.bz2) and the url download cache are left untouched, so every env's
// offline-rebuild material survives; the removed dirs are simply re-extracted from those tarballs.
// Returns true if it removed anything (so the caller only retries when there was something to repair).
class MaxPathRetryError extends Error {
  constructor(original: unknown, retry: unknown) {
    const originalMessage = original instanceof Error ? original.message : String(original)
    const retryMessage = retry instanceof Error ? retry.message : String(retry)
    super(
      'The short Windows package cache recovery was attempted, but micromamba still failed. ' +
        'Retry Repair; if it fails again, choose a shorter data location.\n' +
        `Original failure:\n${originalMessage}\nRetry failure:\n${retryMessage}`,
      { cause: retry }
    )
    this.name = 'MaxPathRetryError'
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
  // Forwarded to ProvisionerDeps.isPrefixBlocked: lets the notebook service veto a prefix write the
  // startup gate/UI would otherwise perform over a possibly-live orphan (see runtime-service).
  isPrefixBlocked?: (prefix: string) => boolean
  // Forwarded to ProvisionerDeps.clearPrefixBlock: an explicit user Reset clears the service's block.
  clearPrefixBlock?: (prefix: string) => void
  // Forwarded to ProvisionerDeps.clearRuntimeBlock: Reset also clears an interrupted install's runtime-ID
  // block so bound sessions aren't rejected after the env rebuilds.
  clearRuntimeBlock?: (runtimeId: string) => void
  // Forwarded to ProvisionerDeps.clearCorruptBlock: a force Reset releases just the reset prefix from the
  // global corrupt-journal barrier after moving the corrupt journal aside (other envs stay blocked).
  clearCorruptBlock?: (prefix: string) => void
  // Forwarded to ProvisionerDeps.blockPrefix: on an unconfirmed-child prefix-write failure, block the
  // prefix in-process so an in-session retry can't race the possibly-live orphan.
  blockPrefix?: (prefix: string) => void
  // Forwarded to ProvisionerDeps.isPrefixLiveUnconfirmed: lets a force Reset refuse a prefix left
  // live-unconfirmed by an interrupted install (or prefix write) this session.
  isPrefixLiveUnconfirmed?: (prefix: string) => boolean
  // Forwarded to ProvisionerDeps.withPrefixLock: shares the service's per-env install lock so a default
  // env create/repair/upgrade never runs concurrently with an install into the same env prefix.
  withPrefixLock?: <T>(envName: string, fn: () => Promise<T>) => Promise<T>
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
    runArgv: (argv, signal, onChild, onBeforeSpawn, runCache, maxCacheRelativePath) =>
      runMicromamba(
        argv,
        micromambaSpawnEnv(
          opts.root,
          opts.caBundle,
          {
            selectCache: () =>
              runCache ??
              selectMicromambaCache(
                opts.root,
                maxCacheRelativePath ?? DEFAULT_MAX_CACHE_RELATIVE_PATH
              )
          },
          maxCacheRelativePath ?? DEFAULT_MAX_CACHE_RELATIVE_PATH
        ),
        signal,
        onChild,
        onBeforeSpawn
      ),
    verify: (bin, prefix) => verifyExecutable(bin, { prefix, env: caEnv }),
    isPrefixBlocked: opts.isPrefixBlocked,
    clearPrefixBlock: opts.clearPrefixBlock,
    clearRuntimeBlock: opts.clearRuntimeBlock,
    clearCorruptBlock: opts.clearCorruptBlock,
    blockPrefix: opts.blockPrefix,
    isPrefixLiveUnconfirmed: opts.isPrefixLiveUnconfirmed,
    withPrefixLock: opts.withPrefixLock
  })
}

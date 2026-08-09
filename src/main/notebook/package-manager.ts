import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PROD_SESSION_DIR_NAME } from '../session-persistence/repository'
import type {
  NotebookEnvironmentPackageChange,
  NotebookLanguage,
  NotebookPackageInstaller,
  NotebookPackageInstallerAttempt
} from '../../shared/notebook'
import {
  caBundleEnv,
  installArgv,
  micromambaSpawnEnv,
  resolveMicromamba,
  type MicromambaSpawnEnvDeps
} from './micromamba'
import type { MicromambaRunner } from './windows-micromamba-runner'
import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  micromambaCacheLockKey,
  selectMicromambaCache,
  type MicromambaCache
} from './micromamba-cache'
import { recoverWindowsMaxPathPackage } from './micromamba-cache-recovery'
import { withExclusiveCacheLocks, withSharedCacheLocks } from './pkgs-cache-lock'
import { CHILD_UNCONFIRMED, killAndConfirmExit } from './provisioner-runtime'
import {
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pipBin,
  pythonBin,
  rBin,
  rLibraryDir,
  rScriptBin,
  resolveEnvName,
  runtimeRoot
} from './runtime-paths'

export type InstallRequest = {
  language: NotebookLanguage
  packages: string[]
  usePip?: boolean
  channels?: string[]
  environment?: string
  // Which action to run against the env; defaults to 'install' (fully backward compatible).
  operation?: 'install' | 'uninstall'
  // Injected by the MCP bridge from the connection context (mcp-server injects sessionId into every
  // notebook tool call). Lets managePackages consult THIS session's runtime binding so an install into
  // a bound external env is gated on that env's per-env install authorization. Absent -> managed path.
  sessionId?: string
  // workspaceCwd/projectName travel on every notebook RPC call too (the local RPC requires
  // workspaceCwd; mcp-server injects both). managePackages uses them to ensureSession() — loading and
  // rehydrating persisted runtime bindings — BEFORE resolving the binding, so the FIRST install after
  // an app restart (session not yet in memory) still sees the persisted binding instead of silently
  // targeting the default env.
  workspaceCwd?: string
  projectName?: string
}
// method records which installer actually ran: conda (micromamba), pip, or cran (R install.packages
// fallback) — useful to verify the path taken, especially when conda falls back.
export type InstallResult = {
  ok: boolean
  needsRestart: boolean
  log: string
  method?: 'conda' | 'pip' | 'cran'
  attempts?: NotebookPackageInstallerAttempt[]
  fallbackUsed?: boolean
  // Verified changes for the explicitly requested packages only. Transitive dependency changes stay
  // in the immutable operation manifest so the agent-facing result remains compact.
  packageChanges?: NotebookEnvironmentPackageChange[]
  // Absolute env prefix the packages were installed into (<dataRoot>/runtime/envs/<env>), so the
  // UI/agent can see the concrete, env-scoped install location. Set on every real install outcome.
  prefix?: string
  // A protected interpreter package changed despite the approved plan. The caller must quarantine
  // this runtime and require Repair before another kernel can execute from it.
  repairRequired?: boolean
  error?: string
}

// One spawned install command's outcome; injected so tests never launch micromamba/pip/R.
export type SpawnResult = { code: number; stdout: string; stderr: string }
export type InstallSpawn = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  // Invoked with the spawned installer's PID so the caller can journal it for crash-recovery
  // supervision (a killed installer survivor is reaped before reconciling). Test spawns ignore it.
  onChild?: (pid: number) => void,
  // Invoked synchronously right before EACH spawn so the caller can (re)record the per-spawn intent. An
  // R install spawns twice (conda then CRAN on fallback), so each must re-arm rather than trust the
  // first spawn's PID. Throwing fails closed (nothing is spawned).
  onBeforeSpawn?: () => void
) => Promise<SpawnResult>

// condaChannel/pypiIndex/cranMirror are resolved PackageMirror values (see shared/mirror.ts);
// integration passes the effectiveMirror() output, this module stays mirror-shape agnostic.
export type InstallDeps = {
  spawn: InstallSpawn
  micromamba?: string
  // Production injects the one process-wide prepared runner. The explicit string remains the
  // narrow test/override seam and wins when supplied.
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  storageRoot?: string
  condaChannel?: string
  pypiIndex?: string
  cranMirror?: string
  // PEM CA bundle path (enterprise TLS proxy); exported into every install subprocess's env so
  // conda/pip/R HTTPS verification trusts it.
  caBundle?: string
  micromambaEnv?: MicromambaSpawnEnvDeps
  // Injected for tests to check a named env's interpreter without touching real disk.
  pathExists?: (path: string) => boolean
  // Reads one installed conda package identity from <prefix>/conda-meta. The managed R install path
  // uses this to pin r-base's version+build and compare the complete identity after the transaction.
  readCondaPackageIdentity?: (
    prefix: string,
    packageName: string
  ) => CondaPackageIdentity | undefined
  // Set for an EXTERNAL (BYO) runtime: install with THIS interpreter's own pip (`<command> [args] -m
  // pip install …`) instead of the app-managed prefix. The bundled micromamba never touches a foreign
  // environment. Absent -> managed install into the app prefix (today's behavior).
  interpreter?: { command: string; args?: string[] }
  // Invoked with each spawned installer's PID so the caller (managePackages) can journal it for
  // crash-recovery supervision of a surviving installer after a hard quit.
  onChild?: (pid: number) => void
  // Invoked synchronously right before EACH spawn so the caller can (re)record the per-spawn intent.
  onBeforeSpawn?: () => void
}

const DEFAULT_CONDA_CHANNEL = 'conda-forge'
// bioconda carries bioinformatics tools + the bioconductor-* R packages; it's designed to sit BELOW
// conda-forge in strict priority, so we always append it after the primary channel for installs.
const BIOCONDA_CHANNEL = 'bioconda'
const DEFAULT_CRAN_MIRROR = 'https://cloud.r-project.org'

// The bioconda channel matching the primary: if the primary is a conda-forge mirror URL, point
// bioconda at the SAME mirror host (…/conda-forge/ → …/bioconda/) so a firewalled user isn't pushed
// back onto public bioconda; otherwise use the plain "bioconda" channel name.
const biocondaChannelFor = (primary: string): string =>
  /^https?:\/\//.test(primary) && primary.includes('conda-forge')
    ? primary.replace(/conda-forge/g, 'bioconda')
    : BIOCONDA_CHANNEL

// Conda install channels: the agent's explicit list wins; otherwise the primary channel (mirror
// override or conda-forge) followed by its matching bioconda, deduped, so bioconductor-*/bio tools
// resolve from the same host.
const condaInstallChannels = (primary: string, requested: string[] | undefined): string[] =>
  requested && requested.length > 0
    ? requested
    : [...new Set([primary, biocondaChannelFor(primary)])]

// The env's OWN R package library. R install/remove pin lib= here so a conda R env's fronted user
// library (e.g. ~/Library/R/x.y/library, which .libPaths() may front) can never receive or lose
// packages: the op is provably confined to the env. Platform-aware via rLibraryDir (Unix lib/ vs Win Lib\).
const envRLibrary = (prefix: string): string => rLibraryDir(prefix)

// R conda naming, shared by R install and R uninstall so both target the exact same conda names.
// conda-forge uses r-<pkg>; Bioconductor packages live on bioconda as bioconductor-<pkg>. Leave an
// already-namespaced name (r-*/bioconductor-*) untouched so a Bioconductor package can be targeted
// directly; otherwise assume a CRAN package and add the r- prefix.
const rCondaNames = (packages: string[]): string[] =>
  packages.map((pkg) =>
    pkg.startsWith('r-') || pkg.startsWith('bioconductor-') ? pkg : `r-${pkg}`
  )

// Extracts the canonical name portion of a conda MatchSpec. R package requests may carry an exact
// version/build in named environments; protection decisions must not compare the whole spec string or
// `r-base=4.4.3` would bypass the kernel-package uninstall guard.
const condaMatchSpecName = (spec: string): string | undefined => {
  const unqualified = spec.trim().split('::').at(-1) ?? ''
  return /^[A-Za-z0-9_.-]+/u.exec(unqualified)?.[0]?.toLowerCase()
}

type CondaFailureClassification = Pick<NotebookPackageInstallerAttempt, 'mutationRisk' | 'reason'>

const parseStructuredCondaResult = (result: SpawnResult): Record<string, unknown> | undefined => {
  for (const candidate of [result.stdout, result.stderr]) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Human-readable output remains diagnostic only and can never authorize a fallback.
    }
  }
  return undefined
}

export type CondaPackageIdentity = {
  name: string
  version: string
  build?: string
  buildNumber?: number
  channel?: string
  subdir?: string
  url?: string
  md5?: string
  sha256?: string
}

const readCondaPackageIdentity = (
  prefix: string,
  packageName: string
): CondaPackageIdentity | undefined => {
  let files: string[]
  try {
    files = readdirSync(join(prefix, 'conda-meta')).filter((file) => file.endsWith('.json'))
  } catch {
    return undefined
  }

  const identities: CondaPackageIdentity[] = []
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(prefix, 'conda-meta', file), 'utf8')) as Record<
        string,
        unknown
      >
      if (record.name === packageName && typeof record.version === 'string') {
        identities.push({
          name: packageName,
          version: record.version,
          ...(typeof record.build === 'string' ? { build: record.build } : {}),
          ...(typeof record.build_number === 'number' ? { buildNumber: record.build_number } : {}),
          ...(typeof record.channel === 'string' ? { channel: record.channel } : {}),
          ...(typeof record.subdir === 'string' ? { subdir: record.subdir } : {}),
          ...(typeof record.url === 'string' ? { url: record.url } : {}),
          ...(typeof record.md5 === 'string' ? { md5: record.md5 } : {}),
          ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {})
        })
      }
    } catch {
      // A malformed record makes the package identity ambiguous; the caller fails closed below.
    }
  }
  return identities.length === 1 ? identities[0] : undefined
}

const condaPackageIdentityKey = (identity: CondaPackageIdentity): string => JSON.stringify(identity)

const condaPackageIdentityLabel = (identity: CondaPackageIdentity): string =>
  [identity.version, identity.build].filter(Boolean).join(' build ')

const hasVerifiableCondaBuild = (
  identity: CondaPackageIdentity | undefined
): identity is CondaPackageIdentity & { build: string; buildNumber: number } =>
  Boolean(identity?.build) && Number.isInteger(identity?.buildNumber)

type CondaPlanPackageAction = {
  action: 'LINK' | 'UNLINK'
  name: string
  version?: string
}

const condaPlanPackageActions = (value: unknown): CondaPlanPackageAction[] => {
  const actions: CondaPlanPackageAction[] = []
  const visit = (nested: unknown): void => {
    if (Array.isArray(nested)) {
      nested.forEach(visit)
      return
    }
    if (typeof nested !== 'object' || nested === null) return
    for (const [key, child] of Object.entries(nested as Record<string, unknown>)) {
      const normalized = key.toUpperCase()
      if ((normalized === 'LINK' || normalized === 'UNLINK') && Array.isArray(child)) {
        for (const record of child) {
          if (typeof record !== 'object' || record === null) continue
          const packageRecord = record as Record<string, unknown>
          if (typeof packageRecord.name !== 'string') continue
          actions.push({
            action: normalized,
            name: packageRecord.name,
            ...(typeof packageRecord.version === 'string' ? { version: packageRecord.version } : {})
          })
        }
        continue
      }
      visit(child)
    }
  }
  visit(value)
  return actions
}

const protectedRBasePlanError = (
  result: SpawnResult,
  installedVersion: string
): string | undefined => {
  const structured = parseStructuredCondaResult(result)
  if (!structured) {
    return 'micromamba returned no structured dry-run plan, so the protected R transaction was not executed.'
  }
  const rBaseActions = condaPlanPackageActions(structured).filter(
    (action) => action.name.toLowerCase() === 'r-base'
  )
  if (rBaseActions.length === 0) return undefined
  const plan = rBaseActions
    .map((action) => `${action.action} r-base${action.version ? ` ${action.version}` : ''}`)
    .join(', ')
  return (
    `micromamba proposed changing protected r-base ${installedVersion} (${plan}); ` +
    'the Conda transaction was not executed.'
  )
}

type ProtectedCondaExecution = {
  conda?: SpawnResult
  approvedPlan?: SpawnResult
  failure?: InstallResult
}

// Extends the R transaction invariant to a Conda request that entered through the Python surface but
// targets a shared named prefix. An absent identity means this is a Python-only prefix and keeps the
// normal single-spawn path; a present identity requires a structured dry-run and a post-spawn full
// identity check before the caller may accept or fall back from the result.
const executeCondaWithRBaseProtection = async (options: {
  command: string
  preflightArgs: string[]
  realArgs: string[]
  packages: string[]
  prefix: string
  installedRBaseIdentity?: CondaPackageIdentity
  readIdentity: () => CondaPackageIdentity | undefined
  runCondaPreflight: InstallSpawn
  runConda: (
    command: string,
    args: string[],
    stopAfterSpawn?: (result: SpawnResult) => boolean | Promise<boolean>
  ) => Promise<SpawnResult>
}): Promise<ProtectedCondaExecution> => {
  const installed = options.installedRBaseIdentity
  if (!installed) {
    return { conda: await options.runConda(options.command, options.realArgs) }
  }

  const preflight = await options.runCondaPreflight(options.command, options.preflightArgs)
  // The caller owns solver-failure classification and any language-specific fallback. A failed
  // preflight never wrote the prefix, so return it as the Conda result without an approved plan.
  if (preflight.code !== 0) return { conda: preflight }

  const planError = protectedRBasePlanError(preflight, installed.version)
  if (planError) {
    return {
      failure: {
        ok: false,
        needsRestart: false,
        log: [mergeLog(preflight), planError].filter(Boolean).join('\n'),
        method: 'conda',
        attempts: [
          {
            groupOrdinal: 0,
            installer: 'conda',
            packages: [...options.packages],
            status: 'failed',
            mutationRisk: 'none',
            reason: 'validation'
          }
        ],
        fallbackUsed: false,
        prefix: options.prefix,
        error: planError
      }
    }
  }

  let finalRBaseIdentity: CondaPackageIdentity | undefined
  const conda = await options.runConda(options.command, options.realArgs, () => {
    finalRBaseIdentity = options.readIdentity()
    return (
      !hasVerifiableCondaBuild(finalRBaseIdentity) ||
      condaPackageIdentityKey(finalRBaseIdentity) !== condaPackageIdentityKey(installed)
    )
  })
  if (
    !hasVerifiableCondaBuild(finalRBaseIdentity) ||
    condaPackageIdentityKey(finalRBaseIdentity) !== condaPackageIdentityKey(installed)
  ) {
    return {
      failure: {
        ok: false,
        needsRestart: false,
        log: [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n'),
        method: 'conda',
        attempts: [installerAttempt(0, 'conda', options.packages, conda)],
        fallbackUsed: false,
        prefix: options.prefix,
        repairRequired: true,
        error:
          `Protected r-base changed unexpectedly from ${condaPackageIdentityLabel(installed)} to ` +
          `${finalRBaseIdentity ? condaPackageIdentityLabel(finalRBaseIdentity) : 'an unknown identity'}. ` +
          'Stop using this runtime and run Repair.'
      }
    }
  }
  return { conda, approvedPlan: preflight }
}

const stringValues = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(stringValues)
    : typeof value === 'string'
      ? [value]
      : typeof value === 'object' && value !== null
        ? Object.values(value).flatMap(stringValues)
        : []

const hasCondaTransactionActions = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasCondaTransactionActions)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    if (/^(?:link|unlink|fetch|prefix_actions|transaction)$/iu.test(key)) {
      return Array.isArray(nested) ? nested.length > 0 : Boolean(nested)
    }
    return hasCondaTransactionActions(nested)
  })
}

// Fallback authorization is derived exclusively from micromamba's JSON response. stderr is retained
// in the user-facing log, but a localized/proxied diagnostic string cannot start a second installer.
const classifyCondaFailure = (result: SpawnResult): CondaFailureClassification => {
  const structured = parseStructuredCondaResult(result)
  if (!structured) {
    return {
      reason: 'unknown',
      mutationRisk: 'unknown'
    }
  }
  if (hasCondaTransactionActions(structured)) {
    return {
      reason: 'unknown',
      mutationRisk: 'possible'
    }
  }
  const diagnostics = stringValues(structured).join('\n')
  const reason =
    /nothing provides|package(?:s)?[^\n]*not found|does not exist|not installed/iu.test(diagnostics)
      ? ('package-not-found' as const)
      : /solver|unsatisfiable|conflict/iu.test(diagnostics)
        ? ('solver-failed' as const)
        : /permission|access denied/iu.test(diagnostics)
          ? ('permission' as const)
          : /network|timeout|tls|ssl|http/iu.test(diagnostics)
            ? ('network' as const)
            : ('unknown' as const)
  return {
    reason,
    mutationRisk: 'none'
  }
}

const installerAttempt = (
  groupOrdinal: number,
  installer: NotebookPackageInstaller,
  packages: string[],
  result: SpawnResult,
  failure?: CondaFailureClassification
): NotebookPackageInstallerAttempt => ({
  groupOrdinal,
  installer,
  packages: [...packages],
  status: result.code === 0 ? 'succeeded' : 'failed',
  mutationRisk: result.code === 0 ? 'confirmed' : (failure?.mutationRisk ?? 'possible'),
  ...(result.code !== 0 && failure?.reason ? { reason: failure.reason } : {})
})

const condaFallbackIsAuthorized = (classification: CondaFailureClassification): boolean =>
  classification.mutationRisk === 'none' &&
  (classification.reason === 'package-not-found' || classification.reason === 'solver-failed')

// Real spawn wrapper collecting stdout/stderr and the exit code; replaced by an injected spawn in tests.
// Exported so its fail-closed spawn-intent / kill-on-record-failure branches are directly testable.
export const defaultSpawn: InstallSpawn = (command, args, env, onChild, onBeforeSpawn) =>
  new Promise((resolve, reject) => {
    try {
      onBeforeSpawn?.() // re-arm the per-spawn intent; fail closed if it can't be recorded
    } catch (error) {
      resolve({
        code: 1,
        stdout: '',
        stderr: `Failed to record the spawn intent; not spawning: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
      return
    }
    const child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    if (child.pid !== undefined) {
      try {
        onChild?.(child.pid)
      } catch (error) {
        // Recording the PID failed. FAIL CLOSED: kill it and only settle once it is CONFIRMED gone.
        // If it can't be confirmed, REJECT with the CHILD_UNCONFIRMED marker so the caller retains the
        // recovery evidence (a worker may still be writing) instead of clearing it.
        void killAndConfirmExit(child).then((confirmed) => {
          if (confirmed) {
            resolve({
              code: 1,
              stdout: '',
              stderr: `Failed to record the installer worker; aborted: ${
                error instanceof Error ? error.message : String(error)
              }`
            })
          } else {
            reject(
              new Error(
                `${CHILD_UNCONFIRMED}: recording failed and the installer could not be confirmed stopped.`
              )
            )
          }
        })
        return
      }
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${String(error)}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

// Flattens one command's output into a single log string for the agent to read as install facts.
const mergeLog = (result: SpawnResult): string =>
  [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n')

const condaFailureMessage = (action: 'install' | 'remove', result: SpawnResult): string =>
  /Retry failure after MAX_PATH recovery/i.test(mergeLog(result))
    ? `conda ${action} failed after short Windows package cache recovery. Retry Repair; ` +
      'if it fails again, choose a shorter data location.'
    : `conda ${action} failed.`

// The default (managed) envs are ADDITIVE-ONLY (foundation "default-environment restrictions"): a spec may be a bare
// package name or a bare name pinned to an exact `==version`, and nothing else. This regex rejects
// version RANGES (>=, <, ~=, !=, commas), git/VCS/URL/local specs (contain +, :, /, @), EXTRAS
// (`pkg[extra]`), wildcards, whitespace, and anything that begins with `-` (so unsafe pip flags such as
// `--force-reinstall` are refused too, since they arrive as package tokens).
const DEFAULT_ADDITIVE_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(==[A-Za-z0-9][A-Za-z0-9.+!_-]*)?$/
// The first requested spec that is not additive-only, or undefined when every spec is allowed.
const firstNonAdditiveSpec = (packages: string[]): string | undefined =>
  packages.find((pkg) => !DEFAULT_ADDITIVE_SPEC.test(pkg.trim()))

const resolveInstallMicromamba = (
  deps: Partial<InstallDeps>
): string | undefined | Promise<string> => {
  if (deps.micromamba !== undefined) return deps.micromamba
  return deps.micromambaRunner ? deps.micromambaRunner.resolve() : resolveMicromamba()
}

// Installs packages into the global default environments from the trusted main process (spec §3.1/§8).
// The kernel never installs; this is the only install entry point. Python picks up a newly-installed
// package on its next import (sys.path rescan), so needsRestart stays false there. R is different: a
// live R session that already attached a package or a dependency won't see the new install, and
// compiled packages hold DLL/.so handles — so an R install/uninstall returns needsRestart:true and the
// caller surfaces a restart prompt. The kernel is never auto-restarted (that would drop session state).
export async function installPackages(
  req: InstallRequest,
  deps: Partial<InstallDeps> = {}
): Promise<InstallResult> {
  // Every install subprocess inherits the parent env plus the CA-bundle vars (no-op when unset), so a
  // custom corporate CA is trusted by conda/pip/R. Wrapping here keeps every run() call site 2-arg.
  const baseSpawn = deps.spawn ?? defaultSpawn
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...caBundleEnv(deps.caBundle) }
  const run: InstallSpawn = (command, args) =>
    baseSpawn(command, args, spawnEnv, deps.onChild, deps.onBeforeSpawn)

  if (req.packages.length === 0) {
    return { ok: false, needsRestart: false, log: '', error: 'No packages requested.' }
  }

  // Universal anti-injection guard (ALL envs, install and uninstall). `req.packages` is agent-supplied
  // and gets appended verbatim to pip / micromamba / R argv, so a token that starts with `-` could
  // smuggle an OPTION (`--index-url http://evil`, `--target /escape`, `-c http://evil`, `-e git+…`)
  // that bypasses the pinned mirror/CA and the overlay containment. No legitimate package specifier
  // begins with `-` (names, `name==1.2`, `pkg[extra]`, `git+https://…`, wheel URLs all pass), so reject
  // any such token. The default-env additive gate below is stricter still.
  const flagLike = req.packages.find((pkg) => pkg.trim().startsWith('-'))
  if (flagLike) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      error:
        `"${flagLike}" is not a valid package specifier — options/flags cannot be passed as ` +
        `packages. Use the channels / usePip parameters for install options.`
    }
  }

  let envName: string
  try {
    envName = resolveEnvName(req.language, req.environment)
  } catch (error) {
    return { ok: false, needsRestart: false, log: '', error: (error as Error).message }
  }

  const storageRoot =
    deps.storageRoot ??
    process.env.OPEN_SCIENCE_STORAGE_ROOT ??
    join(homedir(), PROD_SESSION_DIR_NAME)
  const root = runtimeRoot(storageRoot)
  const channels = condaInstallChannels(deps.condaChannel ?? DEFAULT_CONDA_CHANNEL, req.channels)
  const prefix = envPrefix(root, envName)
  // micromamba install/remove extract into and mutate the SHARED pkgs cache (<root>/runtime/pkgs), so
  // they must hold the shared cache lock — otherwise a concurrent corrupt-cache repair (which takes the
  // cache EXCLUSIVE and removes incomplete extractions) could delete a package dir mid-install. pip and
  // CRAN write only into the env prefix, so they use `run` directly, unlocked. Keyed by `root` — the
  // same key materialize/create/upgrade use — so every cache writer serializes against repair.
  let condaContext: { cache: MicromambaCache; env: NodeJS.ProcessEnv } | undefined
  const resolveCondaContext = (): { cache: MicromambaCache; env: NodeJS.ProcessEnv } => {
    if (condaContext) return condaContext
    const cache = deps.micromambaEnv?.selectCache
      ? deps.micromambaEnv.selectCache(root, DEFAULT_MAX_CACHE_RELATIVE_PATH)
      : selectMicromambaCache(root, DEFAULT_MAX_CACHE_RELATIVE_PATH, deps.micromambaEnv)
    const env = micromambaSpawnEnv(
      root,
      deps.caBundle,
      { ...deps.micromambaEnv, selectCache: () => cache },
      DEFAULT_MAX_CACHE_RELATIVE_PATH
    )
    condaContext = { cache, env }
    return condaContext
  }
  const condaCacheKeys = (cache: MicromambaCache): string[] => [
    cache.lockKey,
    micromambaCacheLockKey(join(root, 'pkgs'), {
      platform: deps.micromambaEnv?.platform,
      canonicalize: deps.micromambaEnv?.canonicalize
    })
  ]
  // A dry-run may refresh repodata in the shared package cache, so it takes the same in-process cache
  // locks as a real transaction. It deliberately does NOT reuse the install journal hooks: the solver
  // cannot write the target prefix, and recording it as an `install` would make a crash after a harmless
  // probe quarantine an untouched runtime at the next startup.
  const runCondaPreflight: InstallSpawn = async (command, args) => {
    const context = resolveCondaContext()
    return withSharedCacheLocks(condaCacheKeys(context.cache), () =>
      baseSpawn(command, args, context.env)
    )
  }
  const runConda = async (
    command: string,
    args: string[],
    stopAfterSpawn?: (result: SpawnResult) => boolean | Promise<boolean>
  ): Promise<SpawnResult> => {
    const context = resolveCondaContext()
    const cacheKeys = condaCacheKeys(context.cache)
    const result = await withSharedCacheLocks(cacheKeys, () =>
      // Thread onBeforeSpawn so the {spawning} intent sidecar is written BEFORE conda spawns, exactly as
      // the pip path does. Without it, a crash in the spawn→onChild window leaves no sidecar, and recovery
      // would misread that as "never spawned" and reconcile/retry under a possibly-live installer.
      baseSpawn(command, args, context.env, deps.onChild, deps.onBeforeSpawn)
    )
    if (await stopAfterSpawn?.(result)) return result
    if (result.code === 0) return result
    const evidence = `${result.stdout}\n${result.stderr}`
    let recovered = false
    let cleanupError: unknown
    try {
      recovered = await withExclusiveCacheLocks(cacheKeys, () =>
        Promise.resolve(
          recoverWindowsMaxPathPackage(
            new Error(evidence),
            [join(root, 'pkgs'), context.cache.path],
            {
              platform: deps.micromambaEnv?.platform
            }
          )
        )
      )
    } catch (error) {
      cleanupError = error
    }
    if (cleanupError) {
      return {
        ...result,
        stderr:
          `${result.stderr}\nCache cleanup failure:\n` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      }
    }
    if (!recovered) return result
    const retry = await withSharedCacheLocks(cacheKeys, () =>
      // The MAX_PATH retry is a fresh spawn — re-arm the intent sidecar for it too, or the same
      // spawn→onChild crash window on the retry would be unrecoverable (no sidecar → misread as no child).
      baseSpawn(command, args, context.env, deps.onChild, deps.onBeforeSpawn)
    )
    if (await stopAfterSpawn?.(retry)) {
      return {
        ...retry,
        stdout:
          `Original failure before MAX_PATH recovery (stdout):\n${result.stdout}\n` +
          `Retry result after MAX_PATH recovery (stdout):\n${retry.stdout}`,
        stderr:
          `Original failure before MAX_PATH recovery (stderr):\n${result.stderr}\n` +
          `Retry result after MAX_PATH recovery (stderr):\n${retry.stderr}`
      }
    }
    if (retry.code === 0) return retry
    return {
      ...retry,
      stdout:
        `Original failure before MAX_PATH recovery (stdout):\n${result.stdout}\n` +
        `Retry failure after MAX_PATH recovery (stdout):\n${retry.stdout}`,
      stderr:
        `Original failure before MAX_PATH recovery (stderr):\n${result.stderr}\n` +
        `Retry failure after MAX_PATH recovery (stderr):\n${retry.stderr}`
    }
  }

  // External (BYO) runtime: install with the selected interpreter's OWN pip — never the bundled
  // micromamba against a foreign env, and never the app-managed prefix. Handled FIRST (above the
  // named-env existence check, which is about managed prefixes and would wrongly reject an external
  // interpreter) and only for installs — external uninstall is disabled and would fall through to the
  // managed uninstall path, so it is refused here as defense-in-depth even though the caller also gates
  // it upstream.
  if (deps.interpreter) {
    if (req.operation === 'uninstall') {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error: 'Uninstalling from an external environment is not supported.'
      }
    }
    const { command, args = [] } = deps.interpreter
    const pipArgs = [
      ...args,
      '-m',
      'pip',
      'install',
      ...(deps.pypiIndex ? ['-i', deps.pypiIndex] : []),
      ...req.packages
    ]
    const result = await run(command, pipArgs)
    return {
      ok: result.code === 0,
      needsRestart: false,
      log: mergeLog(result),
      method: 'pip',
      attempts: [installerAttempt(0, 'pip', req.packages, result)],
      fallbackUsed: false,
      error: result.code === 0 ? undefined : 'pip install failed.'
    }
  }

  // Only named (non-default) envs are gated on existence — default envs' readiness is handled
  // upstream by the provisioner, and installs into them must proceed exactly as before.
  const isDefaultEnv = envName === DEFAULT_PY_ENV || envName === DEFAULT_R_ENV
  if (!isDefaultEnv) {
    const pathExists = deps.pathExists ?? existsSync
    const exists =
      req.language === 'python'
        ? pathExists(pythonBin(prefix))
        : pathExists(rBin(prefix)) || pathExists(rScriptBin(prefix))
    if (!exists) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `Environment "${envName}" does not exist. Create it first with ` +
          `manage_environments(action:"create", language:"${req.language}", name:"${envName}").`
      }
    }
  }

  // Managed default-env policy gate (foundation "default-environment restrictions"). deps.interpreter (external/BYO) has
  // already returned above, so reaching here with isDefaultEnv means the app-managed default env: it is
  // additive-only, so uninstall is refused and only bare-name / name==version installs are allowed —
  // the platform-maintained baseline must stay intact. Named/managed-create envs are unrestricted.
  if (isDefaultEnv) {
    if (req.operation === 'uninstall') {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `The default "${envName}" environment is additive-only, so uninstalling is not allowed. ` +
          `Create a dedicated environment with manage_environments(action:"create", language:"${req.language}") ` +
          `if you need to remove or downgrade packages.`
      }
    }
    const bad = firstNonAdditiveSpec(req.packages)
    if (bad) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        error:
          `The default "${envName}" environment is additive-only: only a bare package name or an ` +
          `exact "name==version" pin is accepted. "${bad}" (a version range, git/URL spec, extras, ` +
          `or flag) is not — create a dedicated environment with manage_environments(action:"create") ` +
          `to install it.`
      }
    }
  }

  if (req.operation === 'uninstall') {
    return uninstallPackages(req, deps, run, runCondaPreflight, runConda, root, prefix)
  }

  if (req.language === 'python') {
    if (req.usePip) {
      const pip = pipBin(prefix)
      const args = ['install', ...(deps.pypiIndex ? ['-i', deps.pypiIndex] : []), ...req.packages]
      const result = await run(pip, args)
      return {
        ok: result.code === 0,
        needsRestart: false,
        log: mergeLog(result),
        method: 'pip',
        attempts: [installerAttempt(0, 'pip', req.packages, result)],
        fallbackUsed: false,
        prefix,
        error: result.code === 0 ? undefined : 'pip install failed.'
      }
    }

    const resolvedMicromamba = resolveInstallMicromamba(deps)
    const mm =
      typeof resolvedMicromamba === 'string' || resolvedMicromamba === undefined
        ? resolvedMicromamba
        : await resolvedMicromamba
    if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }
    const readIdentity = deps.readCondaPackageIdentity ?? readCondaPackageIdentity
    // A Python binding may legitimately target default-r when that prefix also exposes Python. Only
    // default-python is known not to need r-base protection; every other Python Conda prefix must be
    // inspected so the request language cannot bypass the shared interpreter invariant.
    const installedRBaseIdentity =
      envName === DEFAULT_PY_ENV ? undefined : readIdentity(prefix, 'r-base')
    if (installedRBaseIdentity && !hasVerifiableCondaBuild(installedRBaseIdentity)) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        method: 'conda',
        attempts: [],
        fallbackUsed: false,
        prefix,
        error:
          `Cannot verify the installed r-base version and build in ${prefix}; repair this shared ` +
          'runtime before installing packages.'
      }
    }
    const protectedRBaseIdentity = hasVerifiableCondaBuild(installedRBaseIdentity)
      ? installedRBaseIdentity
      : undefined
    const solverPackages = protectedRBaseIdentity
      ? [
          `r-base=${protectedRBaseIdentity.version}=${protectedRBaseIdentity.build}`,
          ...req.packages
        ]
      : req.packages
    const argv = installArgv(mm, root, prefix, channels, solverPackages, isDefaultEnv)
    const execution = await executeCondaWithRBaseProtection({
      command: argv[0],
      preflightArgs: [...argv.slice(1, 3), '--dry-run', '--json', ...argv.slice(3)],
      realArgs: [...argv.slice(1, 3), '--json', ...argv.slice(3)],
      packages: req.packages,
      prefix,
      installedRBaseIdentity: protectedRBaseIdentity,
      readIdentity: () => readIdentity(prefix, 'r-base'),
      runCondaPreflight,
      runConda
    })
    if (execution.failure) return execution.failure
    const result = execution.conda as SpawnResult
    const preflight = execution.approvedPlan
    if (result.code === 0) {
      return {
        ok: true,
        needsRestart: false,
        log: [preflight ? mergeLog(preflight) : '', mergeLog(result)].filter(Boolean).join('\n'),
        method: 'conda',
        attempts: [installerAttempt(0, 'conda', req.packages, result)],
        fallbackUsed: false,
        prefix
      }
    }
    const classification = classifyCondaFailure(result)
    const condaAttempt = installerAttempt(0, 'conda', req.packages, result, classification)
    if (condaFallbackIsAuthorized(classification)) {
      const fallback = await run(pipBin(prefix), [
        'install',
        ...(deps.pypiIndex ? ['-i', deps.pypiIndex] : []),
        ...req.packages
      ])
      const ok = fallback.code === 0
      return {
        ok,
        needsRestart: false,
        log: [preflight ? mergeLog(preflight) : '', mergeLog(result), mergeLog(fallback)]
          .filter(Boolean)
          .join('\n'),
        method: 'pip',
        attempts: [condaAttempt, installerAttempt(1, 'pip', req.packages, fallback)],
        fallbackUsed: true,
        prefix,
        error: ok ? undefined : 'conda and pip install both failed.'
      }
    }
    return {
      ok: false,
      needsRestart: false,
      log: [preflight ? mergeLog(preflight) : '', mergeLog(result)].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [condaAttempt],
      fallbackUsed: false,
      prefix,
      error: condaFailureMessage('install', result)
    }
  }

  // language === 'r': prefer conda, fall back to CRAN install.packages into the env R library.
  // Conda naming is shared with R uninstall via rCondaNames (r-<pkg> / bioconductor-<pkg>).
  const resolvedMicromamba = resolveInstallMicromamba(deps)
  const mm =
    typeof resolvedMicromamba === 'string' || resolvedMicromamba === undefined
      ? resolvedMicromamba
      : await resolvedMicromamba
  if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }

  const condaPkgs = rCondaNames(req.packages)
  const installedRBaseIdentity = (deps.readCondaPackageIdentity ?? readCondaPackageIdentity)(
    prefix,
    'r-base'
  )
  if (!hasVerifiableCondaBuild(installedRBaseIdentity)) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      method: 'conda',
      attempts: [],
      fallbackUsed: false,
      prefix,
      error:
        `Cannot verify the installed r-base version and build in ${prefix}; repair this R runtime ` +
        'before installing packages. Open Science will not run an incompletely pinned R package transaction.'
    }
  }
  const installedRBaseVersion = installedRBaseIdentity.version

  const cranFallback = async (
    conda: SpawnResult,
    condaAttempt: NotebookPackageInstallerAttempt,
    approvedPlan?: SpawnResult
  ): Promise<InstallResult> => {
    const condaLog = mergeLog(conda)
    const cran = deps.cranMirror ?? DEFAULT_CRAN_MIRROR
    const vector = req.packages.map((pkg) => JSON.stringify(pkg)).join(', ')
    // Pin install.packages to the env's own R library with an explicit lib=, rather than letting it
    // write into .libPaths()[1] (which a conda R env can front with the user's global R library).
    const rLib = envRLibrary(prefix)
    const script =
      `dir.create(${JSON.stringify(rLib)}, recursive=TRUE, showWarnings=FALSE); ` +
      `install.packages(c(${vector}), lib=${JSON.stringify(rLib)}, repos=${JSON.stringify(cran)})`
    const fallback = await run(rScriptBin(prefix), ['-e', script])
    const ok = fallback.code === 0
    return {
      ok,
      needsRestart: ok,
      log: [approvedPlan ? mergeLog(approvedPlan) : '', condaLog, mergeLog(fallback)]
        .filter(Boolean)
        .join('\n'),
      method: 'cran',
      attempts: [condaAttempt, installerAttempt(1, 'r-install-packages', req.packages, fallback)],
      fallbackUsed: true,
      prefix: rLib,
      error:
        ok || !/Retry failure after MAX_PATH recovery/i.test(condaLog)
          ? ok
            ? undefined
            : 'conda and CRAN install both failed.'
          : 'conda failed after short Windows package cache recovery, and CRAN install also failed. ' +
            'Retry Repair; if it fails again, choose a shorter data location.'
    }
  }

  // r-base is part of the kernel, not a package dependency the solver may rewrite. Pin the exact
  // installed version and inspect a JSON dry-run before any prefix-writing spawn is journaled or run.
  const rBasePin = `r-base=${installedRBaseVersion}=${installedRBaseIdentity.build}`
  const solverPkgs = [rBasePin, ...condaPkgs]
  const argv = installArgv(mm, root, prefix, channels, solverPkgs, isDefaultEnv)
  const preflight = await runCondaPreflight(argv[0], [
    ...argv.slice(1, 3),
    '--dry-run',
    '--json',
    ...argv.slice(3)
  ])
  if (preflight.code !== 0) {
    const classification = classifyCondaFailure(preflight)
    const condaAttempt = installerAttempt(0, 'conda', condaPkgs, preflight, classification)
    if (condaFallbackIsAuthorized(classification)) {
      return cranFallback(preflight, condaAttempt)
    }
    return {
      ok: false,
      needsRestart: false,
      log: mergeLog(preflight),
      method: 'conda',
      attempts: [condaAttempt],
      fallbackUsed: false,
      prefix,
      error: condaFailureMessage('install', preflight)
    }
  }

  const planError = protectedRBasePlanError(preflight, installedRBaseVersion)
  if (planError) {
    const rejectedPlan: SpawnResult = {
      code: 1,
      stdout: preflight.stdout,
      stderr: [preflight.stderr, planError].filter(Boolean).join('\n')
    }
    return {
      ok: false,
      needsRestart: false,
      log: mergeLog(rejectedPlan),
      method: 'conda',
      attempts: [
        {
          groupOrdinal: 0,
          installer: 'conda',
          packages: [...condaPkgs],
          status: 'failed',
          mutationRisk: 'none',
          reason: 'validation'
        }
      ],
      fallbackUsed: false,
      prefix,
      error: planError
    }
  }

  let finalRBaseIdentity: CondaPackageIdentity | undefined
  const stopAfterRBaseChange = (): boolean => {
    finalRBaseIdentity = (deps.readCondaPackageIdentity ?? readCondaPackageIdentity)(
      prefix,
      'r-base'
    )
    return (
      !hasVerifiableCondaBuild(finalRBaseIdentity) ||
      condaPackageIdentityKey(finalRBaseIdentity) !==
        condaPackageIdentityKey(installedRBaseIdentity)
    )
  }
  const conda = await runConda(
    argv[0],
    [...argv.slice(1, 3), '--json', ...argv.slice(3)],
    stopAfterRBaseChange
  )
  // A failed solver process can still leave a partially-applied UNLINK/LINK transaction. Verify the
  // protected interpreter after EVERY real spawn, not only after exit code 0, before considering a
  // fallback or returning an ordinary installer failure.
  if (
    !hasVerifiableCondaBuild(finalRBaseIdentity) ||
    condaPackageIdentityKey(finalRBaseIdentity) !== condaPackageIdentityKey(installedRBaseIdentity)
  ) {
    return {
      ok: false,
      needsRestart: false,
      log: [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [installerAttempt(0, 'conda', condaPkgs, conda)],
      fallbackUsed: false,
      prefix,
      repairRequired: true,
      error:
        `Protected r-base changed unexpectedly from ${condaPackageIdentityLabel(installedRBaseIdentity)} to ` +
        `${finalRBaseIdentity ? condaPackageIdentityLabel(finalRBaseIdentity) : 'an unknown identity'}. ` +
        'Stop using this runtime and run Repair.'
    }
  }
  if (conda.code === 0) {
    return {
      ok: true,
      needsRestart: true,
      log: [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [installerAttempt(0, 'conda', condaPkgs, conda)],
      fallbackUsed: false,
      prefix
    }
  }

  const condaLog = [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n')
  const classification = classifyCondaFailure(conda)
  const condaAttempt = installerAttempt(0, 'conda', condaPkgs, conda, classification)
  if (!condaFallbackIsAuthorized(classification)) {
    return {
      ok: false,
      needsRestart: false,
      log: condaLog,
      method: 'conda',
      attempts: [condaAttempt],
      fallbackUsed: false,
      prefix,
      error: condaFailureMessage('install', conda)
    }
  }
  return cranFallback(conda, condaAttempt, preflight)
}

// micromamba remove --root-prefix <root> --prefix <prefix> -y <pkgs...>. Env-scoped removal mirroring
// installArgv's shape (micromamba.ts is out of scope, so the argv is built inline here).
const removeArgv = (mm: string, root: string, prefix: string, pkgs: string[]): string[] => [
  mm,
  '--no-rc',
  'remove',
  '--json',
  '--root-prefix',
  root,
  '--prefix',
  prefix,
  '-y',
  ...pkgs
]

// Removes packages from the SAME per-env prefix installs target, so removal never reaches
// system/global packages. Shares the env-name/prefix resolution and non-existent-env rejection with
// the install path (done by the caller before dispatch). Python removal keeps needsRestart false (a
// dropped module stays importable in memory until restart, the caller's choice); R removal returns
// true, mirroring R install — a live R session holds the removed package's namespace/DLL.
async function uninstallPackages(
  req: InstallRequest,
  deps: Partial<InstallDeps>,
  run: InstallSpawn,
  runCondaPreflight: InstallSpawn,
  // Cache-locked spawner for micromamba remove (mutates the shared pkgs cache); pip uninstall stays on
  // `run` (env-prefix only). See the runConda note in installPackages.
  runConda: (
    command: string,
    args: string[],
    stopAfterSpawn?: (result: SpawnResult) => boolean | Promise<boolean>
  ) => Promise<SpawnResult>,
  root: string,
  prefix: string
): Promise<InstallResult> {
  if (req.language === 'python') {
    if (req.usePip) {
      const pip = pipBin(prefix)
      const result = await run(pip, ['uninstall', '-y', ...req.packages])
      return {
        ok: result.code === 0,
        needsRestart: false,
        log: mergeLog(result),
        method: 'pip',
        attempts: [installerAttempt(0, 'pip', req.packages, result)],
        fallbackUsed: false,
        prefix,
        error: result.code === 0 ? undefined : 'pip uninstall failed.'
      }
    }

    const resolvedMicromamba = resolveInstallMicromamba(deps)
    const mm =
      typeof resolvedMicromamba === 'string' || resolvedMicromamba === undefined
        ? resolvedMicromamba
        : await resolvedMicromamba
    if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }
    if (req.packages.some((pkg) => condaMatchSpecName(pkg) === 'r-base')) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        method: 'conda',
        attempts: [],
        fallbackUsed: false,
        prefix,
        error: 'r-base is part of the protected R kernel and cannot be uninstalled.'
      }
    }
    const readIdentity = deps.readCondaPackageIdentity ?? readCondaPackageIdentity
    const installedRBaseIdentity = readIdentity(prefix, 'r-base')
    if (installedRBaseIdentity && !hasVerifiableCondaBuild(installedRBaseIdentity)) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        method: 'conda',
        attempts: [],
        fallbackUsed: false,
        prefix,
        error:
          `Cannot verify the installed r-base version and build in ${prefix}; repair this shared ` +
          'runtime before removing packages.'
      }
    }
    const protectedRBaseIdentity = hasVerifiableCondaBuild(installedRBaseIdentity)
      ? installedRBaseIdentity
      : undefined
    const argv = removeArgv(mm, root, prefix, req.packages)
    const execution = await executeCondaWithRBaseProtection({
      command: argv[0],
      preflightArgs: [...argv.slice(1, 3), '--dry-run', '--json', ...argv.slice(3)],
      realArgs: argv.slice(1),
      packages: req.packages,
      prefix,
      installedRBaseIdentity: protectedRBaseIdentity,
      readIdentity: () => readIdentity(prefix, 'r-base'),
      runCondaPreflight,
      runConda
    })
    if (execution.failure) return execution.failure
    const result = execution.conda as SpawnResult
    const preflight = execution.approvedPlan
    return {
      ok: result.code === 0,
      needsRestart: false,
      log: [preflight ? mergeLog(preflight) : '', mergeLog(result)].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [
        installerAttempt(
          0,
          'conda',
          req.packages,
          result,
          result.code === 0 ? undefined : classifyCondaFailure(result)
        )
      ],
      fallbackUsed: false,
      prefix,
      error: result.code === 0 ? undefined : condaFailureMessage('remove', result)
    }
  }

  // language === 'r': mirror the R install path — attempt a conda/micromamba removal first (a package
  // installed via conda/bioconda must be removed via conda, or the env's conda metadata is left
  // inconsistent), and fall back to remove.packages() only when micromamba reports the package isn't
  // conda-managed (a CRAN-only install.packages() result). Both paths are env-scoped and return
  // needsRestart:true, since a live R session holds a removed package's namespace/DLL.
  const resolvedMicromamba = resolveInstallMicromamba(deps)
  const mm =
    typeof resolvedMicromamba === 'string' || resolvedMicromamba === undefined
      ? resolvedMicromamba
      : await resolvedMicromamba
  if (!mm) return { ok: false, needsRestart: false, log: '', error: 'micromamba not found.' }

  const condaPkgs = rCondaNames(req.packages)
  if (condaPkgs.some((pkg) => condaMatchSpecName(pkg) === 'r-base')) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      method: 'conda',
      attempts: [],
      fallbackUsed: false,
      prefix,
      error: 'r-base is part of the protected R kernel and cannot be uninstalled.'
    }
  }
  const installedRBaseIdentity = (deps.readCondaPackageIdentity ?? readCondaPackageIdentity)(
    prefix,
    'r-base'
  )
  if (!hasVerifiableCondaBuild(installedRBaseIdentity)) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      method: 'conda',
      attempts: [],
      fallbackUsed: false,
      prefix,
      error:
        `Cannot verify the installed r-base version and build in ${prefix}; repair this R runtime ` +
        'before removing packages.'
    }
  }
  const cranRemoveFallback = async (
    condaResult: SpawnResult,
    condaAttempt: NotebookPackageInstallerAttempt,
    approvedPlan?: SpawnResult
  ): Promise<InstallResult> => {
    const condaLog = [approvedPlan ? mergeLog(approvedPlan) : '', mergeLog(condaResult)]
      .filter(Boolean)
      .join('\n')
    const vector = req.packages.map((pkg) => JSON.stringify(pkg)).join(', ')
    const rLib = envRLibrary(prefix)
    const script = `remove.packages(c(${vector}), lib=${JSON.stringify(rLib)})`
    const fallback = await run(rScriptBin(prefix), ['-e', script])
    const ok = fallback.code === 0
    return {
      ok,
      needsRestart: ok,
      log: `${condaLog}\n${mergeLog(fallback)}`,
      method: 'cran',
      attempts: [condaAttempt, installerAttempt(1, 'r-install-packages', req.packages, fallback)],
      fallbackUsed: true,
      prefix: rLib,
      error: ok ? undefined : 'R remove.packages failed.'
    }
  }
  const argv = removeArgv(mm, root, prefix, condaPkgs)
  const preflight = await runCondaPreflight(argv[0], [
    ...argv.slice(1, 3),
    '--dry-run',
    ...argv.slice(3)
  ])
  if (preflight.code !== 0) {
    const classification = classifyCondaFailure(preflight)
    const condaAttempt = installerAttempt(0, 'conda', condaPkgs, preflight, classification)
    if (classification.reason === 'package-not-found' && classification.mutationRisk === 'none') {
      return cranRemoveFallback(preflight, condaAttempt)
    }
    return {
      ok: false,
      needsRestart: false,
      log: mergeLog(preflight),
      method: 'conda',
      attempts: [condaAttempt],
      fallbackUsed: false,
      prefix,
      error: condaFailureMessage('remove', preflight)
    }
  }
  const planError = protectedRBasePlanError(preflight, installedRBaseIdentity.version)
  if (planError) {
    return {
      ok: false,
      needsRestart: false,
      log: [mergeLog(preflight), planError].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [
        {
          groupOrdinal: 0,
          installer: 'conda',
          packages: [...condaPkgs],
          status: 'failed',
          mutationRisk: 'none',
          reason: 'validation'
        }
      ],
      fallbackUsed: false,
      prefix,
      error: planError
    }
  }
  let finalRBaseIdentity: CondaPackageIdentity | undefined
  const stopAfterRBaseChange = (): boolean => {
    finalRBaseIdentity = (deps.readCondaPackageIdentity ?? readCondaPackageIdentity)(
      prefix,
      'r-base'
    )
    return (
      !hasVerifiableCondaBuild(finalRBaseIdentity) ||
      condaPackageIdentityKey(finalRBaseIdentity) !==
        condaPackageIdentityKey(installedRBaseIdentity)
    )
  }
  const conda = await runConda(argv[0], argv.slice(1), stopAfterRBaseChange)
  if (
    !hasVerifiableCondaBuild(finalRBaseIdentity) ||
    condaPackageIdentityKey(finalRBaseIdentity) !== condaPackageIdentityKey(installedRBaseIdentity)
  ) {
    return {
      ok: false,
      needsRestart: false,
      log: [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [installerAttempt(0, 'conda', condaPkgs, conda)],
      fallbackUsed: false,
      prefix,
      repairRequired: true,
      error:
        `Protected r-base changed unexpectedly from ${condaPackageIdentityLabel(installedRBaseIdentity)} to ` +
        `${finalRBaseIdentity ? condaPackageIdentityLabel(finalRBaseIdentity) : 'an unknown identity'}. ` +
        'Stop using this runtime and run Repair.'
    }
  }
  if (conda.code === 0) {
    return {
      ok: true,
      needsRestart: true,
      log: [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n'),
      method: 'conda',
      attempts: [installerAttempt(0, 'conda', condaPkgs, conda)],
      fallbackUsed: false,
      prefix
    }
  }

  // A conda remove that failed for any reason OTHER than the package not being in the env is a real
  // error (e.g. a broken env); surface it rather than masking it with a CRAN attempt.
  const condaLog = [mergeLog(preflight), mergeLog(conda)].filter(Boolean).join('\n')
  const classification = classifyCondaFailure(conda)
  const condaAttempt = installerAttempt(0, 'conda', condaPkgs, conda, classification)
  if (classification.reason !== 'package-not-found' || classification.mutationRisk !== 'none') {
    return {
      ok: false,
      needsRestart: false,
      log: condaLog,
      method: 'conda',
      attempts: [condaAttempt],
      fallbackUsed: false,
      prefix,
      error: condaFailureMessage('remove', conda)
    }
  }

  // Not conda-managed → CRAN removal. The successful dry-run is retained in the audit log.
  return cranRemoveFallback(conda, condaAttempt, preflight)
}

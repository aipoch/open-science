import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { finished } from 'node:stream/promises'

import { PROD_SESSION_DIR_NAME } from '../session-persistence/paths'
import type { OptionalProjectIdScope } from '../../shared/project-scope'
import type { RuntimeTargetReceipt } from '../../shared/notebook-runtime'
import type {
  NotebookEnvironmentPackageChange,
  NotebookLanguage,
  NotebookPackageSource,
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
  archiveAuthorizationsFromCondaResult,
  type MicromambaArchiveAuthorization
} from './micromamba-archive-store'
import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  micromambaCacheLockKey,
  selectMicromambaCache,
  type MicromambaCache
} from './micromamba-cache'
import {
  maintainPackageCacheBestEffort,
  packageCacheCleanArgv
} from './micromamba-cache-maintenance'
import { recoverWindowsMaxPathPackage } from './micromamba-cache-recovery'
import { notebookWorkloadCacheEnv } from './notebook-workload-cache-paths'
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
import { toErrorMessage } from '../error-message'

export type InstallRequest = OptionalProjectIdScope & {
  language: NotebookLanguage
  packages: string[]
  usePip?: boolean
  installer?: 'biocmanager' | 'github'
  channels?: string[]
  environment?: string
  // Which action to run against the env; defaults to 'install' (fully backward compatible).
  operation?: 'install' | 'uninstall'
  // Injected by the MCP bridge from the connection context (mcp-server injects sessionId into every
  // notebook tool call). Lets managePackages consult THIS session's runtime binding so an install into
  // a bound external env is gated on that env's per-env install authorization. Absent -> managed path.
  sessionId?: string
  // workspaceCwd/projectId travel on every notebook RPC call too (the local RPC requires
  // workspaceCwd; mcp-server injects both). managePackages uses them to ensureSession() — loading and
  // rehydrating persisted runtime bindings — BEFORE resolving the binding, so the FIRST install after
  // an app restart (session not yet in memory) still sees the persisted binding instead of silently
  // targeting the default env.
  workspaceCwd?: string
}
// method records which installer actually ran: conda (micromamba), pip, or cran (R install.packages
// fallback) — useful to verify the path taken, especially when conda falls back.
export type InstallResult = {
  ok: boolean
  needsRestart: boolean
  log: string
  // Stable user-facing target name resolved from the session binding. Unlike prefix, this is safe to
  // retain in the compact tool result and lets the transcript identify the environment later.
  environmentName?: string
  // Present when the bounded installer stdout/stderr collectors discarded older bytes. The count is
  // aggregated across every command whose retained output contributes to `log`.
  logTruncation?: { droppedBytes: number }
  method?: 'conda' | 'pip' | 'cran' | 'biocmanager' | 'github'
  source?: NotebookPackageSource
  attempts?: NotebookPackageInstallerAttempt[]
  fallbackUsed?: boolean
  // Verified requested and related changes from the before/after target-runtime inventory.
  packageChanges?: NotebookEnvironmentPackageChange[]
  // Absolute env prefix the packages were installed into (<dataRoot>/runtime/envs/<env>), so the
  // UI/agent can see the concrete, env-scoped install location. Set on every real install outcome.
  prefix?: string
  // A protected interpreter package changed despite the approved plan. The caller must quarantine
  // this runtime and require Repair before another kernel can execute from it.
  repairRequired?: boolean
  target?: RuntimeTargetReceipt
  error?: string
}

type CondaStructuredResult = {
  transaction: boolean
  actions: {
    LINK: Array<{ name: 'r-base'; version?: string }>
    UNLINK: Array<{ name: 'r-base'; version?: string }>
  }
  archives: MicromambaArchiveAuthorization[]
  archiveEvidenceComplete?: boolean
  diagnostics: string[]
}

// One spawned install command's outcome; injected so tests never launch micromamba/pip/R.
export type SpawnResult = {
  code: number
  stdout: string
  stderr: string
  stdoutDroppedBytes?: number
  stderrDroppedBytes?: number
  // When a bounded stream truncated micromamba --json output, a short-lived parser subprocess
  // reduces the complete temporary capture to only the facts needed for fail-closed decisions.
  structuredCondaResult?: CondaStructuredResult
  // Bounded recovery-only evidence reduced from the complete capture. It is never merged into the
  // user-facing log or persisted activity result.
  maxPathRecoveryEvidence?: string
}
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
  onBeforeSpawn?: () => void,
  // A sandbox wrapper replaces the original argv with its launcher argv. Preserve whether the
  // underlying installer requested structured conda JSON so recovery evidence remains complete.
  captureCondaJson?: boolean,
  cwd?: string
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
  // Invoked after cache maintenance has either completed or failed with its child confirmed stopped.
  // The journal owner uses it to clear the maintenance child's evidence before any solver/install spawn.
  onCacheMaintenanceSettled?: () => Promise<void> | void
  // Receives digest-bearing archive identities directly from a successful micromamba transaction.
  // The caller may use these in-memory authorizations to publish notebook-writable cache bytes.
  onCondaArchiveAuthorizations?: (
    authorizations: readonly MicromambaArchiveAuthorization[],
    workingRoot: string,
    evidenceComplete?: boolean
  ) => void
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
  if (result.structuredCondaResult) return result.structuredCondaResult
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

const condaArchiveAuthorizations = (result: SpawnResult): MicromambaArchiveAuthorization[] => {
  const structured = parseStructuredCondaResult(result)
  return structured ? archiveAuthorizationsFromCondaResult(structured) : []
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
        ...installLogTruncation(preflight),
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
        ...installLogTruncation(preflight, conda),
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

export const INSTALLER_STREAM_LOG_LIMIT_BYTES = 512 * 1024
export const CONDA_JSON_CAPTURE_LIMIT_BYTES = 32 * 1024 * 1024

// Fixed-capacity byte ring retaining the newest installer output. Byte accounting happens before
// UTF-8 decoding so the reported discard count is exact even when a process splits a code point
// across chunks.
class InstallerLogTailBuffer {
  private readonly buffer: Buffer
  private start = 0
  private length = 0
  private droppedBytes = 0

  constructor(private readonly capacity: number) {
    this.buffer = Buffer.allocUnsafe(capacity)
  }

  push(value: unknown): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    if (chunk.length === 0) return

    if (chunk.length >= this.capacity) {
      this.addDroppedBytes(this.length + chunk.length - this.capacity)
      chunk.copy(this.buffer, 0, chunk.length - this.capacity)
      this.start = 0
      this.length = this.capacity
      return
    }

    const overflow = Math.max(0, this.length + chunk.length - this.capacity)
    if (overflow > 0) {
      this.start = (this.start + overflow) % this.capacity
      this.length -= overflow
      this.addDroppedBytes(overflow)
    }

    const writeStart = (this.start + this.length) % this.capacity
    const firstLength = Math.min(chunk.length, this.capacity - writeStart)
    chunk.copy(this.buffer, writeStart, 0, firstLength)
    if (firstLength < chunk.length) chunk.copy(this.buffer, 0, firstLength)
    this.length += chunk.length
  }

  snapshot(): { text: string; droppedBytes: number } {
    if (this.length === 0) return { text: '', droppedBytes: this.droppedBytes }
    const firstLength = Math.min(this.length, this.capacity - this.start)
    const bytes = Buffer.allocUnsafe(this.length)
    this.buffer.copy(bytes, 0, this.start, this.start + firstLength)
    if (firstLength < this.length)
      this.buffer.copy(bytes, firstLength, 0, this.length - firstLength)
    return { text: bytes.toString('utf8'), droppedBytes: this.droppedBytes }
  }

  private addDroppedBytes(count: number): void {
    this.droppedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.droppedBytes + count)
  }
}

type CondaJsonCapture = {
  directory: string
  stdoutPath: string
  stderrPath: string
  stdoutLimiter: Transform
  stderrLimiter: Transform
  stdoutStream: ReturnType<typeof createWriteStream>
  stderrStream: ReturnType<typeof createWriteStream>
  state: { truncated: boolean }
}

type CondaJsonCaptureSummary = Pick<
  SpawnResult,
  'structuredCondaResult' | 'maxPathRecoveryEvidence'
>

const CONDA_JSON_SUMMARIZER_SOURCE = String.raw`
const { readFileSync } = require('node:fs')

const strings = (value) =>
  Array.isArray(value)
    ? value.flatMap(strings)
    : typeof value === 'string'
      ? [value]
      : typeof value === 'object' && value !== null
        ? Object.values(value).flatMap(strings)
        : []

const summarize = (value) => {
  let transaction = false
  const actions = { LINK: [], UNLINK: [] }
  const archives = []
  let archiveEvidenceComplete = true
  const visit = (nested) => {
    if (Array.isArray(nested)) {
      nested.forEach(visit)
      return
    }
    if (typeof nested !== 'object' || nested === null) return
    const file = typeof nested.fn === 'string'
      ? nested.fn
      : typeof nested.url === 'string'
        ? (() => {
            try {
              return new URL(nested.url).pathname.split('/').pop()
            } catch {
              return undefined
            }
          })()
        : undefined
    const sha256 = typeof nested.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(nested.sha256)
      ? nested.sha256.toLowerCase()
      : undefined
    const md5 = typeof nested.md5 === 'string' && /^[0-9a-f]{32}$/i.test(nested.md5)
      ? nested.md5.toLowerCase()
      : undefined
    if (typeof file === 'string' && /\.(?:conda|tar\.bz2)$/i.test(file) && (sha256 || md5)) {
      if (archives.length < 1024) {
        archives.push({
          file,
          algorithm: sha256 ? 'sha256' : 'md5',
          digest: sha256 || md5
        })
      } else {
        archiveEvidenceComplete = false
      }
    }
    for (const [key, child] of Object.entries(nested)) {
      const normalized = key.toUpperCase()
      if (/^(?:LINK|UNLINK|FETCH|PREFIX_ACTIONS|TRANSACTION)$/.test(normalized)) {
        transaction ||= Array.isArray(child) ? child.length > 0 : Boolean(child)
      }
      if ((normalized === 'LINK' || normalized === 'UNLINK') && Array.isArray(child)) {
        for (const record of child) {
          if (
            actions[normalized].length < 16 &&
            typeof record === 'object' &&
            record !== null &&
            typeof record.name === 'string' &&
            record.name.toLowerCase() === 'r-base'
          ) {
            actions[normalized].push({
              name: 'r-base',
              ...(typeof record.version === 'string' ? { version: record.version } : {})
            })
          }
        }
      }
      visit(child)
    }
  }
  visit(value)
  const diagnostics = strings(value).join('\n')
  const canonicalDiagnostic =
    /nothing provides|package(?:s)?[^\n]*not found|does not exist|not installed/iu.test(diagnostics)
      ? 'package not found'
      : /solver|unsatisfiable|conflict/iu.test(diagnostics)
        ? 'solver failed'
        : /permission|access denied/iu.test(diagnostics)
          ? 'permission denied'
          : /network|timeout|tls|ssl|http/iu.test(diagnostics)
            ? 'network timeout'
            : undefined
  return {
    transaction,
    actions,
    archives,
    archiveEvidenceComplete,
    diagnostics: canonicalDiagnostic ? [canonicalDiagnostic] : []
  }
}

const maxPathEvidence = (texts) => {
  const diagnosticText = texts.join('\n')
  const hasMissingContext =
    /invalid package cache/i.test(diagnosticText) &&
    /(?:is missing|package cache error)/i.test(diagnosticText)
  const hasRemoveContext =
    /error when extracting package/i.test(diagnosticText) &&
    /remove_all[^]*(?:not empty|directory)/i.test(diagnosticText)
  if (!hasMissingContext && !hasRemoveContext) return undefined
  const archiveMatch = diagnosticText.match(
    /(?:for|cache for)\s+[\x27\x22]([^\x27\x22]+\.(?:conda|tar\.bz2))[\x27\x22]/i
  )
  const archive = archiveMatch?.[1]
  const paths = [
    ...diagnosticText.matchAll(/[\x27\x22]([^\x27\x22\r\n]+)[\x27\x22]/g)
  ]
    .map((match) => match[1])
    .filter((value) => value !== archive && value.length > 240)
  if (paths.length === 0) return undefined
  const parts = []
  if (hasMissingContext) {
    parts.push('Invalid package cache; file is missing; Package cache error.')
  }
  if (hasRemoveContext) {
    parts.push('Error when extracting package; remove_all: not empty.')
  }
  const quote = String.fromCharCode(39)
  if (archive) parts.push('for ' + quote + archive.slice(0, 4096) + quote)
  let remaining = 60_000 - parts.join('\n').length
  for (const path of paths) {
    const quoted = quote + path.slice(0, 32_768) + quote
    if (quoted.length > remaining) break
    parts.push(quoted)
    remaining -= quoted.length + 1
  }
  return parts.join('\n')
}

const texts = process.argv.slice(1).map((path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
})
let structuredCondaResult
const decodedDiagnosticTexts = []
for (const text of texts) {
  try {
    const value = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      decodedDiagnosticTexts.push(strings(value).join('\n'))
      structuredCondaResult ??= summarize(value)
    }
  } catch {
    // Try the other captured stream.
  }
}
const maxPathRecoveryEvidence = maxPathEvidence([...decodedDiagnosticTexts, ...texts])
process.stdout.write(
  JSON.stringify({
    ...(structuredCondaResult ? { structuredCondaResult } : {}),
    ...(maxPathRecoveryEvidence ? { maxPathRecoveryEvidence } : {})
  })
)
process.exitCode = 0
`

const createCondaJsonCaptureLimiter = (state: { truncated: boolean }): Transform => {
  let writtenBytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const retainedBytes = Math.min(
        chunk.length,
        Math.max(0, CONDA_JSON_CAPTURE_LIMIT_BYTES - writtenBytes)
      )
      writtenBytes += retainedBytes
      if (retainedBytes < chunk.length) state.truncated = true
      callback(null, retainedBytes > 0 ? chunk.subarray(0, retainedBytes) : undefined)
    }
  })
}

const createCondaJsonCapture = (): CondaJsonCapture => {
  const directory = mkdtempSync(join(tmpdir(), 'open-science-conda-json-'))
  const stdoutPath = join(directory, 'stdout.json')
  const stderrPath = join(directory, 'stderr.json')
  const state = { truncated: false }
  const stdoutLimiter = createCondaJsonCaptureLimiter(state)
  const stderrLimiter = createCondaJsonCaptureLimiter(state)
  const stdoutStream = createWriteStream(stdoutPath, { mode: 0o600 })
  const stderrStream = createWriteStream(stderrPath, { mode: 0o600 })
  // Keep late disk errors from becoming unhandled events; finished() below observes the failure and
  // makes the structured decision fail closed. Drain the limiter after a disk error so capture
  // failure cannot stall the installer child.
  stdoutStream.on('error', () => {
    stdoutLimiter.unpipe(stdoutStream)
    stdoutLimiter.resume()
  })
  stderrStream.on('error', () => {
    stderrLimiter.unpipe(stderrStream)
    stderrLimiter.resume()
  })
  stdoutLimiter.on('error', (error) => {
    state.truncated = true
    stdoutStream.destroy(error)
  })
  stderrLimiter.on('error', (error) => {
    state.truncated = true
    stderrStream.destroy(error)
  })
  stdoutLimiter.pipe(stdoutStream)
  stderrLimiter.pipe(stderrStream)
  return {
    directory,
    stdoutPath,
    stderrPath,
    stdoutLimiter,
    stderrLimiter,
    stdoutStream,
    stderrStream,
    state
  }
}

const isCondaStructuredResult = (value: unknown): value is CondaStructuredResult => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<CondaStructuredResult>
  if (
    typeof candidate.transaction !== 'boolean' ||
    !candidate.actions ||
    !Array.isArray(candidate.actions.LINK) ||
    !Array.isArray(candidate.actions.UNLINK) ||
    !Array.isArray(candidate.archives) ||
    !candidate.archives.every(
      (archive) =>
        typeof archive === 'object' &&
        archive !== null &&
        typeof archive.file === 'string' &&
        (archive.algorithm === 'md5' || archive.algorithm === 'sha256') &&
        typeof archive.digest === 'string'
    ) ||
    !Array.isArray(candidate.diagnostics) ||
    !candidate.diagnostics.every((diagnostic) => typeof diagnostic === 'string') ||
    (candidate.archiveEvidenceComplete !== undefined &&
      typeof candidate.archiveEvidenceComplete !== 'boolean')
  ) {
    return false
  }
  return [...candidate.actions.LINK, ...candidate.actions.UNLINK].every(
    (action) =>
      typeof action === 'object' &&
      action !== null &&
      action.name === 'r-base' &&
      (action.version === undefined || typeof action.version === 'string')
  )
}

const isCondaJsonCaptureSummary = (value: unknown): value is CondaJsonCaptureSummary => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as CondaJsonCaptureSummary
  return (
    (candidate.structuredCondaResult === undefined ||
      isCondaStructuredResult(candidate.structuredCondaResult)) &&
    (candidate.maxPathRecoveryEvidence === undefined ||
      (typeof candidate.maxPathRecoveryEvidence === 'string' &&
        candidate.maxPathRecoveryEvidence.length <= 60_000))
  )
}

const summarizeCondaJsonCapture = (
  capture: CondaJsonCapture
): Promise<CondaJsonCaptureSummary | undefined> =>
  new Promise((resolve) => {
    const stdout = new InstallerLogTailBuffer(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    const parser = nodeSpawn(
      process.execPath,
      ['-e', CONDA_JSON_SUMMARIZER_SOURCE, capture.stdoutPath, capture.stderrPath],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    )
    parser.stdout?.on('data', (chunk) => stdout.push(chunk))
    let settled = false
    const settle = (result?: CondaJsonCaptureSummary): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      parser.kill()
      settle()
    }, 30_000)
    timeout.unref()
    parser.on('error', () => settle())
    parser.on('close', (code) => {
      if (code !== 0) {
        settle()
        return
      }
      try {
        const snapshot = stdout.snapshot()
        if (snapshot.droppedBytes > 0) {
          settle()
          return
        }
        const parsed = JSON.parse(snapshot.text) as unknown
        settle(isCondaJsonCaptureSummary(parsed) ? parsed : undefined)
      } catch {
        settle()
      }
    })
  })

const finalizeCondaJsonCapture = async (
  capture: CondaJsonCapture | undefined,
  summarize: boolean
): Promise<CondaJsonCaptureSummary | undefined> => {
  if (!capture) return undefined
  try {
    await Promise.all([finished(capture.stdoutStream), finished(capture.stderrStream)])
    return summarize && !capture.state.truncated
      ? await summarizeCondaJsonCapture(capture)
      : undefined
  } catch {
    return undefined
  } finally {
    try {
      rmSync(capture.directory, { recursive: true, force: true })
    } catch {
      // The installer result must still settle; the OS temp directory remains best-effort cleanup.
    }
  }
}

const discardCondaJsonCapture = async (capture: CondaJsonCapture | undefined): Promise<void> => {
  if (!capture) return
  capture.stdoutLimiter.end()
  capture.stderrLimiter.end()
  await finalizeCondaJsonCapture(capture, false)
}

// Real spawn wrapper collecting stdout/stderr and the exit code; replaced by an injected spawn in tests.
// Exported so its fail-closed spawn-intent / kill-on-record-failure branches are directly testable.
export const defaultSpawn: InstallSpawn = (
  command,
  args,
  env,
  onChild,
  onBeforeSpawn,
  captureCondaJson,
  cwd
) => {
  let condaJsonCapture: CondaJsonCapture | undefined
  try {
    if (captureCondaJson ?? args.includes('--json')) condaJsonCapture = createCondaJsonCapture()
  } catch (error) {
    return Promise.resolve({
      code: 1,
      stdout: '',
      stderr: `Failed to create the temporary micromamba JSON capture; not spawning: ${toErrorMessage(
        error
      )}`
    })
  }
  return new Promise((resolve, reject) => {
    try {
      onBeforeSpawn?.() // re-arm the per-spawn intent; fail closed if it can't be recorded
    } catch (error) {
      void discardCondaJsonCapture(condaJsonCapture)
      resolve({
        code: 1,
        stdout: '',
        stderr: `Failed to record the spawn intent; not spawning: ${toErrorMessage(error)}`
      })
      return
    }
    let child: ReturnType<typeof nodeSpawn>
    try {
      child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd })
    } catch (error) {
      void discardCondaJsonCapture(condaJsonCapture)
      resolve({
        code: 1,
        stdout: '',
        stderr: toErrorMessage(error)
      })
      return
    }
    if (child.pid !== undefined) {
      try {
        onChild?.(child.pid)
      } catch (error) {
        // Recording the PID failed. FAIL CLOSED: kill it and only settle once it is CONFIRMED gone.
        // If it can't be confirmed, REJECT with the CHILD_UNCONFIRMED marker so the caller retains the
        // recovery evidence (a worker may still be writing) instead of clearing it.
        void killAndConfirmExit(child).then((confirmed) => {
          void discardCondaJsonCapture(condaJsonCapture)
          if (confirmed) {
            resolve({
              code: 1,
              stdout: '',
              stderr: `Failed to record the installer worker; aborted: ${toErrorMessage(error)}`
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
    const stdout = new InstallerLogTailBuffer(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    const stderr = new InstallerLogTailBuffer(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    child.stdout?.on('data', (chunk) => {
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr.push(chunk)
    })
    if (condaJsonCapture) {
      if (child.stdout) child.stdout.pipe(condaJsonCapture.stdoutLimiter)
      else condaJsonCapture.stdoutLimiter.end()
      if (child.stderr) child.stderr.pipe(condaJsonCapture.stderrLimiter)
      else condaJsonCapture.stderrLimiter.end()
    }
    let settled = false
    const result = async (code: number): Promise<SpawnResult> => {
      const stdoutSnapshot = stdout.snapshot()
      const stderrSnapshot = stderr.snapshot()
      const condaJsonSummary = await finalizeCondaJsonCapture(
        condaJsonCapture,
        stdoutSnapshot.droppedBytes > 0 || stderrSnapshot.droppedBytes > 0
      )
      return {
        code,
        stdout: stdoutSnapshot.text,
        stderr: stderrSnapshot.text,
        ...(stdoutSnapshot.droppedBytes > 0
          ? { stdoutDroppedBytes: stdoutSnapshot.droppedBytes }
          : {}),
        ...(stderrSnapshot.droppedBytes > 0
          ? { stderrDroppedBytes: stderrSnapshot.droppedBytes }
          : {}),
        ...(condaJsonSummary ?? {})
      }
    }
    const settle = (code: number): void => {
      if (settled) return
      settled = true
      void result(code).then(resolve)
    }
    child.on('error', (error) => {
      stderr.push(String(error))
      if (condaJsonCapture) {
        child.stdout?.unpipe(condaJsonCapture.stdoutLimiter)
        child.stderr?.unpipe(condaJsonCapture.stderrLimiter)
        condaJsonCapture.stdoutLimiter.end()
        condaJsonCapture.stderrLimiter.end()
      }
      settle(1)
    })
    child.on('close', (code) => settle(code ?? 1))
  })
}

// Flattens one command's output into a single log string for the agent to read as install facts.
const mergeLog = (result: SpawnResult): string =>
  [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n')

const spawnLogTruncation = (
  ...results: Array<SpawnResult | undefined>
): Pick<SpawnResult, 'stdoutDroppedBytes' | 'stderrDroppedBytes'> => {
  const sum = (field: 'stdoutDroppedBytes' | 'stderrDroppedBytes'): number =>
    results.reduce(
      (total, result) => Math.min(Number.MAX_SAFE_INTEGER, total + (result?.[field] ?? 0)),
      0
    )
  const stdoutDroppedBytes = sum('stdoutDroppedBytes')
  const stderrDroppedBytes = sum('stderrDroppedBytes')
  return {
    ...(stdoutDroppedBytes > 0 ? { stdoutDroppedBytes } : {}),
    ...(stderrDroppedBytes > 0 ? { stderrDroppedBytes } : {})
  }
}

const installLogTruncation = (
  ...results: Array<SpawnResult | undefined>
): Pick<InstallResult, 'logTruncation'> => {
  const droppedBytes = results.reduce(
    (total, result) =>
      Math.min(
        Number.MAX_SAFE_INTEGER,
        total + (result?.stdoutDroppedBytes ?? 0) + (result?.stderrDroppedBytes ?? 0)
      ),
    0
  )
  return droppedBytes > 0 ? { logTruncation: { droppedBytes } } : {}
}

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

const R_PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9.]*$/u
const GITHUB_REPOSITORY_SPEC = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[A-Za-z0-9._/-]+)?$/u
const githubSource = (spec: string): Extract<NotebookPackageSource, { type: 'github' }> => {
  const separator = spec.lastIndexOf('@')
  return {
    type: 'github',
    repository: separator > 0 ? spec.slice(0, separator) : spec,
    ...(separator > 0 ? { ref: spec.slice(separator + 1) } : {})
  }
}

const bioconductorVersionFromLog = (result: SpawnResult): string | undefined =>
  /^OPEN_SCIENCE_BIOC_VERSION\t(.+)$/mu.exec(`${result.stdout}\n${result.stderr}`)?.[1]?.trim()

const resolveInstallMicromamba = (
  deps: Partial<InstallDeps>
): string | undefined | Promise<string> => {
  if (deps.micromamba !== undefined) return deps.micromamba
  return deps.micromambaRunner ? deps.micromambaRunner.resolve() : resolveMicromamba()
}

// Installs packages into the global default environments through the trusted manage_packages path
// (spec §3.1/§8). Production injects the Notebook process boundary as `deps.spawn`; the kernel never
// installs. Python picks up a newly-installed
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

  if (
    req.installer &&
    (req.language !== 'r' || req.operation === 'uninstall' || req.usePip === true)
  ) {
    return {
      ok: false,
      needsRestart: false,
      log: '',
      error: `${req.installer} is supported only for R package installation.`
    }
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
  Object.assign(spawnEnv, notebookWorkloadCacheEnv(root))
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
    const env = {
      ...micromambaSpawnEnv(
        root,
        deps.caBundle,
        { ...deps.micromambaEnv, selectCache: () => cache },
        DEFAULT_MAX_CACHE_RELATIVE_PATH
      ),
      ...notebookWorkloadCacheEnv(root)
    }
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
  // A single install request may run a dry-run and a real transaction. Maintain the persistent cache
  // once, before whichever conda subprocess comes first, so old versions are reclaimed without adding
  // duplicate scans. Cleanup reuses the package operation's spawn hooks. It does not write the target
  // prefix, but a crash may leave its cache-deleting child alive; recording that child lets the existing
  // recovery barrier prevent a later cache mutation from racing it without another journal kind.
  let condaCacheMaintenance: Promise<void> | undefined
  const maintainCondaCache = (command: string): Promise<void> => {
    if (condaCacheMaintenance) return condaCacheMaintenance
    const context = resolveCondaContext()
    const argv = packageCacheCleanArgv(command)
    condaCacheMaintenance = maintainPackageCacheBestEffort(
      condaCacheKeys(context.cache),
      async () => {
        const result = await baseSpawn(
          argv[0],
          argv.slice(1),
          {
            ...context.env,
            MAMBA_ROOT_PREFIX: root,
            CONDA_PKGS_DIRS: context.cache.path
          },
          deps.onChild,
          deps.onBeforeSpawn
        )
        if (result.code !== 0) {
          throw Object.assign(new Error('micromamba package cache maintenance failed'), {
            code: 'MICROMAMBA_CACHE_CLEAN_EXIT'
          })
        }
      },
      deps.onCacheMaintenanceSettled
    )
    return condaCacheMaintenance
  }
  // A dry-run may refresh repodata in the shared package cache, so it takes the same in-process cache
  // locks as a real transaction. The solver itself deliberately does NOT reuse the install journal hooks:
  // it cannot write the target prefix. Cache maintenance above does reuse them because its deleting child
  // must remain supervised until it exits.
  const runCondaPreflight: InstallSpawn = async (command, args) => {
    const context = resolveCondaContext()
    await maintainCondaCache(command)
    return withSharedCacheLocks(condaCacheKeys(context.cache), () =>
      baseSpawn(command, args, context.env)
    )
  }
  const reportCondaArchives = (result: SpawnResult, workingRoot: string): void => {
    const structured = parseStructuredCondaResult(result)
    const authorizations = condaArchiveAuthorizations(result)
    const summarizedCompleteness = result.structuredCondaResult?.archiveEvidenceComplete
    const retainedOutputComplete =
      (result.stdoutDroppedBytes ?? 0) === 0 && (result.stderrDroppedBytes ?? 0) === 0
    const evidenceComplete =
      summarizedCompleteness ?? (retainedOutputComplete && structured !== undefined)
    if (authorizations.length > 0 || !evidenceComplete) {
      deps.onCondaArchiveAuthorizations?.(authorizations, workingRoot, evidenceComplete)
    }
  }
  const runConda = async (
    command: string,
    args: string[],
    stopAfterSpawn?: (result: SpawnResult) => boolean | Promise<boolean>
  ): Promise<SpawnResult> => {
    const context = resolveCondaContext()
    const cacheKeys = condaCacheKeys(context.cache)
    await maintainCondaCache(command)
    const result = await withSharedCacheLocks(cacheKeys, () =>
      // Thread onBeforeSpawn so the {spawning} intent sidecar is written BEFORE conda spawns, exactly as
      // the pip path does. Without it, a crash in the spawn→onChild window leaves no sidecar, and recovery
      // would misread that as "never spawned" and reconcile/retry under a possibly-live installer.
      baseSpawn(command, args, context.env, deps.onChild, deps.onBeforeSpawn)
    )
    if (await stopAfterSpawn?.(result)) return result
    if (result.code === 0) {
      reportCondaArchives(result, context.cache.path)
      return result
    }
    const evidence = [result.maxPathRecoveryEvidence, result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
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
        stderr: `${result.stderr}\nCache cleanup failure:\n` + `${toErrorMessage(cleanupError)}`
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
        ...spawnLogTruncation(result, retry),
        stdout:
          `Original failure before MAX_PATH recovery (stdout):\n${result.stdout}\n` +
          `Retry result after MAX_PATH recovery (stdout):\n${retry.stdout}`,
        stderr:
          `Original failure before MAX_PATH recovery (stderr):\n${result.stderr}\n` +
          `Retry result after MAX_PATH recovery (stderr):\n${retry.stderr}`
      }
    }
    if (retry.code === 0) {
      reportCondaArchives(retry, context.cache.path)
      return retry
    }
    return {
      ...retry,
      ...spawnLogTruncation(result, retry),
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
      ...installLogTruncation(result),
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
        ...installLogTruncation(result),
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
        ...installLogTruncation(preflight, result),
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
        ...installLogTruncation(preflight, result, fallback),
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
      ...installLogTruncation(preflight, result),
      method: 'conda',
      attempts: [condaAttempt],
      fallbackUsed: false,
      prefix,
      error: condaFailureMessage('install', result)
    }
  }

  if (req.installer) {
    const invalid = req.packages.find((pkg) =>
      req.installer === 'github'
        ? !GITHUB_REPOSITORY_SPEC.test(pkg.trim())
        : !R_PACKAGE_NAME.test(pkg.trim())
    )
    if (invalid) {
      return {
        ok: false,
        needsRestart: false,
        log: '',
        method: req.installer,
        error:
          req.installer === 'github'
            ? `"${invalid}" is not a valid GitHub R package specifier; use owner/repository or owner/repository@ref.`
            : `"${invalid}" is not a valid Bioconductor R package name.`
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
        method: req.installer,
        attempts: [],
        fallbackUsed: false,
        prefix,
        error:
          `Cannot verify the installed r-base version and build in ${prefix}; repair this R runtime ` +
          'before installing packages. Open Science will not run an incompletely pinned R package transaction.'
      }
    }

    const rLib = envRLibrary(prefix)
    const cran = deps.cranMirror ?? DEFAULT_CRAN_MIRROR
    const vector = req.packages.map((pkg) => JSON.stringify(pkg.trim())).join(', ')
    const bootstrap = (packageName: string): string =>
      `if (!requireNamespace(${JSON.stringify(packageName)}, quietly=TRUE, lib.loc=.libPaths())) ` +
      `install.packages(${JSON.stringify(packageName)}, lib=${JSON.stringify(rLib)}, repos=${JSON.stringify(cran)}); `
    const script =
      `dir.create(${JSON.stringify(rLib)}, recursive=TRUE, showWarnings=FALSE); ` +
      `.libPaths(c(${JSON.stringify(rLib)}, .libPaths())); ` +
      (req.installer === 'biocmanager'
        ? bootstrap('BiocManager') +
          `BiocManager::install(c(${vector}), lib=${JSON.stringify(rLib)}, ask=FALSE, update=FALSE); ` +
          `cat("OPEN_SCIENCE_BIOC_VERSION\\t", as.character(BiocManager::version()), "\\n", sep="")`
        : bootstrap('remotes') +
          `invisible(lapply(c(${vector}), function(repo) remotes::install_github(repo, ` +
          `lib=${JSON.stringify(rLib)}, dependencies=TRUE, upgrade="never")))`)
    const result = await run(rScriptBin(prefix), ['--vanilla', '--slave', '-e', script])
    const ok = result.code === 0
    const source: NotebookPackageSource | undefined =
      req.installer === 'biocmanager'
        ? { type: 'bioconductor', version: bioconductorVersionFromLog(result) }
        : req.packages.length === 1
          ? githubSource(req.packages[0].trim())
          : undefined
    return {
      ok,
      needsRestart: ok,
      log: mergeLog(result),
      ...installLogTruncation(result),
      method: req.installer,
      attempts: [installerAttempt(0, req.installer, req.packages, result)],
      fallbackUsed: false,
      prefix: rLib,
      ...(ok && source ? { source } : {}),
      error: ok ? undefined : `${req.installer} install failed.`
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
      ...installLogTruncation(approvedPlan, conda, fallback),
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
      ...installLogTruncation(preflight),
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
      stderr: [preflight.stderr, planError].filter(Boolean).join('\n'),
      ...spawnLogTruncation(preflight)
    }
    return {
      ok: false,
      needsRestart: false,
      log: mergeLog(rejectedPlan),
      ...installLogTruncation(rejectedPlan),
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
      ...installLogTruncation(preflight, conda),
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
      ...installLogTruncation(preflight, conda),
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
      ...installLogTruncation(preflight, conda),
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
        ...installLogTruncation(result),
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
      ...installLogTruncation(preflight, result),
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
      ...installLogTruncation(approvedPlan, condaResult, fallback),
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
      ...installLogTruncation(preflight),
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
      ...installLogTruncation(preflight),
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
      ...installLogTruncation(preflight, conda),
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
      ...installLogTruncation(preflight, conda),
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
      ...installLogTruncation(preflight, conda),
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

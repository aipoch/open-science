import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  isNotebookEnvironmentOperationLogTruncation,
  type NotebookEnvironmentManifest,
  type NotebookEnvironmentOperation,
  type NotebookEnvironmentOperationLogTruncation,
  type NotebookEnvironmentPackageChange,
  type NotebookEnvironmentPackage,
  type NotebookInventoryRefreshAttempt,
  type NotebookLiveEnvironmentOverlay,
  type NotebookLanguage,
  type NotebookPackageSource,
  type NotebookPackageInstallerAttempt
} from '../../shared/notebook'
import { condaActivatedPath } from './runtime-paths'
import { runtimeChildProcessErrorFields, type RuntimeDiagnosticLogger } from './runtime-diagnostics'

type EnvironmentExecFile = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr?: string }>

const execFileAsync = promisify(execFile) as EnvironmentExecFile
const INSPECTION_TIMEOUT_MS = 30_000
const MAX_INVENTORY_CACHE_AGE_MS = 24 * 60 * 60 * 1_000
// The mutable binding cache is read on every run, so keep completed operation history bounded by
// both shape and serialized size. Recovery-critical entries may temporarily exceed these limits.
const MAX_OPERATION_LOG_ENTRIES = 200
const MAX_ENVIRONMENT_BINDING_BYTES = 256 * 1_024

type EnvironmentCaptureTarget = {
  language: NotebookLanguage
  environmentName: string
  runtimeSource: 'managed' | 'external'
  command: string
  args?: string[]
  // Conda prefix whose native DLL search path must be activated before spawning the interpreter.
  // Required for Windows R; omitted for non-Conda external runtimes.
  condaPrefix?: string
}

type InstalledEnvironmentInventory = {
  runtimeVersion?: string
  platform?: string
  architecture?: string
  packages: NotebookEnvironmentPackage[]
}

type PackageMutationIntent = {
  operationId: string
  operation: NotebookEnvironmentOperation['operation']
  packages: string[]
}

type PackageMutationOutcome = PackageMutationIntent & {
  result: NotebookEnvironmentOperation['result']
  attempts?: NotebookPackageInstallerAttempt[]
  fallbackUsed?: boolean
  source?: NotebookPackageSource
}

type PackageMutationVerification = {
  result: NotebookEnvironmentOperation['result']
  unsatisfiedPackages?: string[]
  reason?: 'inventory-refresh-failed'
  packageChanges?: NotebookEnvironmentPackageChange[]
}

type InspectedPackage = Partial<NotebookEnvironmentPackage> & {
  requested: string
  name: string
  status: 'installed' | 'missing' | 'unknown'
}

type PackageInspectionResult = {
  inventory: {
    capturedAt?: string
    source: 'full-scan' | 'cache-reused' | 'unavailable'
    validation: 'full-scan' | 'best-effort' | 'unavailable'
  }
  packages: InspectedPackage[]
  warnings?: string[]
}

type EnvironmentInventoryBindingCache = {
  schemaVersion: 1
  generation: number
  state: 'clean' | 'dirty'
  inventoryChecksum?: string
  stateFingerprint?: string
  currentManifestChecksum?: string
  dirtyOperationId?: string
  dirtyReason?: 'package-mutation' | 'fingerprint-changed' | 'recovery'
  verifiedAt?: string
  operationLog: NotebookEnvironmentOperation[]
  operationLogTruncation?: NotebookEnvironmentOperationLogTruncation
}

type EnvironmentRunCaptureStart = {
  fingerprint?: string
  inventoryRefreshed: boolean
  warnings: string[]
}

type PendingEnvironmentOperationRecord = {
  schemaVersion: 1
  operationId: string
  runtimeLocalKey: string
  generation: number
  lifecycle: 'intent' | 'terminal-refresh-pending'
  operation: NotebookEnvironmentOperation['operation']
  packages: string[]
  terminalResult?: NotebookEnvironmentOperation['result']
  attempts: NotebookPackageInstallerAttempt[]
  fallbackUsed: boolean
  inventoryRefreshAttempts: NotebookInventoryRefreshAttempt[]
  beforeInventoryChecksum?: string
  source?: NotebookPackageSource
}

type StoredInventory = InstalledEnvironmentInventory & {
  schemaVersion: 1
  capturedAt: string
}

type EnvironmentCaptureResult = {
  manifest: NotebookEnvironmentManifest
  checksum: string
  storagePath: string
}

type EnvironmentStateTrackerOptions = {
  dataRoot: string
  inspectInstalled?: (target: EnvironmentCaptureTarget) => Promise<InstalledEnvironmentInventory>
  captureFingerprint?: (target: EnvironmentCaptureTarget) => Promise<string | undefined>
  execFile?: EnvironmentExecFile
  now?: () => Date
  platform?: NodeJS.Platform
  logger?: Pick<RuntimeDiagnosticLogger, 'warn' | 'error'>
  operationLogLimits?: {
    maxEntries: number
    maxBytes: number
  }
}

const environmentCaptureProcessEnv = (
  target: EnvironmentCaptureTarget,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv => {
  if (target.language !== 'r' || !target.condaPrefix) return inheritedEnv

  const inheritedPath =
    inheritedEnv.PATH ??
    (platform === 'win32'
      ? Object.entries(inheritedEnv).find(([key]) => key.toLowerCase() === 'path')?.[1]
      : undefined)
  const activatedEnv = { ...inheritedEnv }
  if (platform === 'win32') {
    for (const key of Object.keys(activatedEnv)) {
      if (key.toLowerCase() === 'path') delete activatedEnv[key]
    }
  }
  return {
    ...activatedEnv,
    PATH: condaActivatedPath(target.condaPrefix, inheritedPath, platform)
  }
}

class EnvironmentManifestPublicationError extends Error {
  constructor(cause: unknown) {
    super(`Could not publish the completed-run Environment manifest: ${describeError(cause)}`, {
      cause
    })
    this.name = 'EnvironmentManifestPublicationError'
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const serializedBindingBytes = (cache: EnvironmentInventoryBindingCache): number =>
  Buffer.byteLength(`${JSON.stringify(cache, null, 2)}\n`, 'utf8')

const operationLogTruncationFor = (
  retained: NotebookEnvironmentOperation[],
  omittedCount: number
): NotebookEnvironmentOperationLogTruncation | undefined => {
  if (omittedCount <= 0) return undefined
  const earliestRetainedAt = retained
    .map((operation) => operation.timestamp)
    .filter((timestamp) => timestamp.length > 0)
    .sort()[0]
  return {
    omittedCount,
    ...(earliestRetainedAt ? { earliestRetainedAt } : {})
  }
}

const bindingWithOperationLog = (
  cache: EnvironmentInventoryBindingCache,
  operationLog: NotebookEnvironmentOperation[],
  operationLogTruncation: NotebookEnvironmentOperationLogTruncation | undefined
): EnvironmentInventoryBindingCache => {
  const candidate = { ...cache, operationLog }
  if (operationLogTruncation) candidate.operationLogTruncation = operationLogTruncation
  else delete candidate.operationLogTruncation
  return candidate
}

const compactOperationLog = (
  cache: EnvironmentInventoryBindingCache,
  limits: { maxEntries: number; maxBytes: number }
): boolean => {
  const protectedOperationIds = new Set(cache.dirtyOperationId ? [cache.dirtyOperationId] : [])
  const retainedIndexes = new Set<number>()

  cache.operationLog.forEach((operation, index) => {
    if (!protectedOperationIds.has(operation.operationId)) return
    retainedIndexes.add(index)
  })

  // Retain a contiguous suffix of completed operations, plus any recovery-critical entry.
  for (let index = cache.operationLog.length - 1; index >= 0; index -= 1) {
    if (retainedIndexes.has(index)) continue
    if (retainedIndexes.size >= limits.maxEntries) break
    retainedIndexes.add(index)
  }

  let retained = cache.operationLog.filter((_operation, index) => retainedIndexes.has(index))
  const previouslyOmitted = cache.operationLogTruncation?.omittedCount ?? 0
  const originalLength = cache.operationLog.length
  let nextTruncation = operationLogTruncationFor(
    retained,
    previouslyOmitted + originalLength - retained.length
  )

  // Enforce the byte budget against the exact pretty-printed binding representation written below.
  // A recovery-critical operation is retained even when it makes the binding temporarily exceed it.
  while (
    serializedBindingBytes(bindingWithOperationLog(cache, retained, nextTruncation)) >
    limits.maxBytes
  ) {
    const removableIndex = retained.findIndex(
      (operation) => !protectedOperationIds.has(operation.operationId)
    )
    if (removableIndex < 0) break
    retained = retained.filter((_operation, index) => index !== removableIndex)
    nextTruncation = operationLogTruncationFor(
      retained,
      previouslyOmitted + originalLength - retained.length
    )
  }

  const newlyOmitted = originalLength - retained.length
  const changed =
    newlyOmitted > 0 ||
    cache.operationLogTruncation?.omittedCount !== nextTruncation?.omittedCount ||
    cache.operationLogTruncation?.earliestRetainedAt !== nextTruncation?.earliestRetainedAt

  cache.operationLog = retained
  cache.operationLogTruncation = nextTruncation
  return changed
}

const packageKey = (value: string): string => value.normalize('NFC').toLocaleLowerCase('und')

const packageIdentityKey = (pkg: NotebookEnvironmentPackage): string =>
  [
    pkg.ecosystem,
    packageKey(pkg.name),
    ...(pkg.ecosystem === 'r'
      ? [
          pkg.libraryRank !== undefined
            ? `rank:${pkg.libraryRank}`
            : `scope:${pkg.libraryScope ?? 'unknown'}`
        ]
      : [])
  ].join('\0')

const packageSourceKey = (pkg: NotebookEnvironmentPackage): string => {
  const source = pkg.source
  if (!source) return ''
  return source.type === 'github'
    ? ['github', packageKey(source.repository), source.ref ?? '', source.commit ?? ''].join('\0')
    : ['bioconductor', source.version ?? ''].join('\0')
}

const requestedPackageKey = (value: string): string => packageKey(value).replace(/[-_.]+/gu, '-')

const githubSourceFromSpec = (value: string): { repository: string; ref?: string } | undefined => {
  const spec = value.trim()
  const separator = spec.lastIndexOf('@')
  const repository = separator > 0 ? spec.slice(0, separator) : spec
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) return undefined
  const ref = separator > 0 ? spec.slice(separator + 1) : undefined
  return { repository: packageKey(repository), ...(ref ? { ref } : {}) }
}

const packageNameFromSpec = (value: string, language: NotebookLanguage): string | undefined => {
  const unqualified = value.trim().split('::').at(-1) ?? ''
  const pathName = /^[./\\]/u.test(unqualified)
    ? unqualified.split(/[/\\]/u).filter(Boolean).at(-1)
    : undefined
  const name = (pathName ?? unqualified).match(/^[A-Za-z0-9_.-]+/u)?.[0]
  if (!name) return undefined
  if (language !== 'r') return name
  const lowerName = name.toLocaleLowerCase('und')
  if (lowerName.startsWith('r-')) return name.slice(2)
  if (lowerName.startsWith('bioconductor-')) return name.slice('bioconductor-'.length)
  return name
}

const exactVersionFromSpec = (value: string, language: NotebookLanguage): string | undefined => {
  if (language !== 'python') return undefined
  return value.trim().match(/^[A-Za-z0-9_.-]+==([^\s;,]+)$/u)?.[1]
}

const normalizedPythonVersion = (
  value: string
): { publicVersion: string; localVersion?: string } | undefined => {
  const [publicValue, localValue] = value.trim().toLowerCase().replace(/^v/u, '').split('+', 2)
  if (!publicValue) return undefined
  const match = publicValue.match(/^(?:(\d+)!)?(\d+(?:\.\d+)*)(.*)$/u)
  if (!match) return undefined
  const release = match[2].split('.').map(Number)
  while (release.length > 1 && release.at(-1) === 0) release.pop()
  const suffix = match[3]
    .replace(/[-_.]+/gu, '.')
    .replace(/^\.(?:alpha|a)(\d*)$/u, 'a$1')
    .replace(/^\.(?:beta|b)(\d*)$/u, 'b$1')
    .replace(/^\.(?:c|pre|preview|rc)(\d*)$/u, 'rc$1')
    .replace(/^\.(?:post|rev|r)(\d*)$/u, 'post$1')
    .replace(/^\.dev(\d*)$/u, 'dev$1')
  return {
    publicVersion: `${match[1] ?? '0'}!${release.join('.')}${suffix}`,
    ...(localValue ? { localVersion: localValue.replace(/[-_.]+/gu, '.') } : {})
  }
}

const pythonExactVersionMatches = (requested: string, installed: string | undefined): boolean => {
  if (!installed) return false
  const requestedVersion = normalizedPythonVersion(requested)
  const installedVersion = normalizedPythonVersion(installed)
  if (!requestedVersion || !installedVersion) return requested === installed
  return (
    requestedVersion.publicVersion === installedVersion.publicVersion &&
    (requestedVersion.localVersion === undefined ||
      requestedVersion.localVersion === installedVersion.localVersion)
  )
}

const inspectRequestedPackage = (
  target: EnvironmentCaptureTarget,
  requested: string,
  installed: NotebookEnvironmentPackage[] | undefined
): InspectedPackage => {
  const githubSource = target.language === 'r' ? githubSourceFromSpec(requested) : undefined
  const requestedName = githubSource
    ? githubSource.repository.split('/').at(-1)
    : packageNameFromSpec(requested, target.language)
  if (!requestedName || !installed) {
    return {
      requested,
      name: requestedName ?? requested.trim(),
      status: 'unknown'
    }
  }
  const match = githubSource
    ? installed.find(
        (pkg) =>
          pkg.source?.type === 'github' &&
          packageKey(pkg.source.repository) === githubSource.repository &&
          (githubSource.ref === undefined || pkg.source.ref === githubSource.ref)
      )
    : installed.find((pkg) => requestedPackageKey(pkg.name) === requestedPackageKey(requestedName))
  return match
    ? { requested, ...match, status: 'installed' }
    : { requested, name: requestedName, status: 'missing' }
}

const verifyPackageMutation = (
  target: EnvironmentCaptureTarget,
  outcome: PackageMutationOutcome,
  packages: NotebookEnvironmentPackage[]
): PackageMutationVerification => {
  if (outcome.result !== 'success') return { result: outcome.result }
  const unsatisfiedPackages = outcome.packages.filter((spec) => {
    const name = packageNameFromSpec(spec, target.language)
    const githubSource = target.language === 'r' ? githubSourceFromSpec(spec) : undefined
    if (githubSource) {
      return !packages.some(
        (pkg) =>
          pkg.source?.type === 'github' &&
          packageKey(pkg.source.repository) === githubSource.repository &&
          (githubSource.ref === undefined || pkg.source.ref === githubSource.ref)
      )
    }
    if (!name) return false
    const installed = packages.find(
      (pkg) => requestedPackageKey(pkg.name) === requestedPackageKey(name)
    )
    if (outcome.operation === 'uninstall') return installed !== undefined
    const exactVersion = exactVersionFromSpec(spec, target.language)
    return (
      !installed ||
      (exactVersion !== undefined && !pythonExactVersionMatches(exactVersion, installed.version))
    )
  })
  return unsatisfiedPackages.length > 0
    ? { result: 'failure', unsatisfiedPackages }
    : { result: 'success' }
}

const packageChangesForOperation = ({
  language,
  before,
  after,
  requestedPackages
}: {
  language: NotebookLanguage
  before?: NotebookEnvironmentPackage[]
  after: NotebookEnvironmentPackage[]
  requestedPackages: string[]
}): NotebookEnvironmentPackageChange[] => {
  const requestedKeys = new Set(
    requestedPackages.flatMap((spec) => {
      if (language === 'r' && githubSourceFromSpec(spec)) return []
      const name = packageNameFromSpec(spec, language)
      return name ? [requestedPackageKey(name)] : []
    })
  )
  const requestedGithubRepositories = new Set(
    requestedPackages.flatMap((spec) => {
      const source = language === 'r' ? githubSourceFromSpec(spec) : undefined
      return source ? [source.repository] : []
    })
  )
  const relationshipFor = (
    pkg: NotebookEnvironmentPackage
  ): NotebookEnvironmentPackageChange['relationship'] =>
    requestedKeys.has(requestedPackageKey(pkg.name)) ||
    (pkg.source?.type === 'github' &&
      requestedGithubRepositories.has(packageKey(pkg.source.repository)))
      ? 'requested'
      : 'unattributed'
  const toChange = (
    pkg: NotebookEnvironmentPackage,
    relationship: NotebookEnvironmentPackageChange['relationship'],
    change: NotebookEnvironmentPackageChange['change'],
    beforeVersion?: string,
    afterVersion?: string
  ): NotebookEnvironmentPackageChange => ({
    name: pkg.name,
    ecosystem: pkg.ecosystem,
    relationship,
    change,
    ...(beforeVersion ? { beforeVersion } : {}),
    ...(afterVersion ? { afterVersion } : {}),
    ...(pkg.libraryRank !== undefined ? { libraryRank: pkg.libraryRank } : {}),
    ...(pkg.libraryScope ? { libraryScope: pkg.libraryScope } : {}),
    ...(pkg.source ? { source: pkg.source } : {})
  })

  if (!before) {
    return sortPackages(after)
      .filter((pkg) => relationshipFor(pkg) === 'requested')
      .map((pkg) => toChange(pkg, 'requested', 'observed', undefined, pkg.version))
  }

  const beforeByIdentity = new Map(before.map((pkg) => [packageIdentityKey(pkg), pkg]))
  const afterByIdentity = new Map(after.map((pkg) => [packageIdentityKey(pkg), pkg]))
  const identities = [...new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])].sort()
  const changes: NotebookEnvironmentPackageChange[] = []
  for (const identity of identities) {
    const previous = beforeByIdentity.get(identity)
    const current = afterByIdentity.get(identity)
    const pkg = current ?? previous
    if (!pkg) continue
    const relationship = relationshipFor(pkg)
    if (!previous && current) {
      changes.push(toChange(current, relationship, 'installed', undefined, current.version))
      continue
    }
    if (previous && !current) {
      changes.push(toChange(previous, relationship, 'removed', previous.version))
      continue
    }
    if (!previous || !current) continue
    const versionChanged =
      previous.version !== current.version ||
      previous.versionStatus !== current.versionStatus ||
      packageSourceKey(previous) !== packageSourceKey(current)
    if (versionChanged) {
      changes.push(toChange(current, relationship, 'updated', previous.version, current.version))
    } else if (relationship === 'requested') {
      changes.push(toChange(current, relationship, 'unchanged', previous.version, current.version))
    }
  }
  return changes
}

const packageChangesWithSource = (
  changes: NotebookEnvironmentPackageChange[],
  source: NotebookPackageSource | undefined
): NotebookEnvironmentPackageChange[] =>
  source
    ? changes.map((change) =>
        change.relationship === 'requested' && !change.source ? { ...change, source } : change
      )
    : changes

const normalizePackage = (pkg: NotebookEnvironmentPackage): NotebookEnvironmentPackage => ({
  ...pkg,
  name: pkg.name.trim(),
  evidenceSources: [...new Set(pkg.evidenceSources)].sort()
})

const sortPackages = (packages: NotebookEnvironmentPackage[]): NotebookEnvironmentPackage[] =>
  [...packages].map(normalizePackage).sort((left, right) => {
    const byName = packageKey(left.name).localeCompare(packageKey(right.name))
    if (byName !== 0) return byName
    const byEcosystem = left.ecosystem.localeCompare(right.ecosystem)
    if (byEcosystem !== 0) return byEcosystem
    return (
      (left.libraryRank ?? Number.MAX_SAFE_INTEGER) - (right.libraryRank ?? Number.MAX_SAFE_INTEGER)
    )
  })

const mergePackages = (
  installed: NotebookEnvironmentPackage[],
  live: NotebookEnvironmentPackage[]
): NotebookEnvironmentPackage[] => {
  const merged = new Map<string, NotebookEnvironmentPackage>()
  for (const pkg of installed) {
    merged.set(packageIdentityKey(pkg), { ...pkg, loadedState: 'installed-only' })
  }
  for (const pkg of live) {
    const key = packageIdentityKey(pkg)
    const existing = merged.get(key)
    merged.set(key, {
      ...existing,
      ...pkg,
      version: pkg.version ?? existing?.version,
      versionStatus:
        pkg.versionStatus === 'known' || existing?.versionStatus === 'known'
          ? 'known'
          : 'unavailable',
      evidenceSources: [...new Set([...(existing?.evidenceSources ?? []), ...pkg.evidenceSources])]
    })
  }
  return sortPackages([...merged.values()])
}

const PYTHON_INVENTORY_SCRIPT = [
  'import importlib.metadata as metadata, platform, sys',
  'print("RUNTIME\\t" + platform.python_version() + "\\t" + sys.platform + "\\t" + platform.machine())',
  'rows = []',
  'for dist in metadata.distributions():',
  '    name = (dist.metadata.get("Name") or "").replace("\\t", " ").replace("\\n", " ").strip()',
  '    version = (dist.version or "").replace("\\t", " ").replace("\\n", " ").strip()',
  '    if name: rows.append((name, version))',
  'for name, version in sorted(rows, key=lambda item: item[0].casefold()):',
  '    print("PACKAGE\\t" + name + "\\t" + version)'
].join('\n')

const R_INVENTORY_SCRIPT = [
  'runtimeSystem <- tolower(Sys.info()[["sysname"]])',
  'runtimePlatform <- if (runtimeSystem == "windows") "win32" else runtimeSystem',
  'cat("RUNTIME\\t", paste(R.version$major, R.version$minor, sep="."), "\\t", runtimePlatform, "\\t", Sys.info()[["machine"]], "\\n", sep="")',
  'ip <- installed.packages()',
  'libraryPaths <- normalizePath(.libPaths(), winslash="/", mustWork=FALSE)',
  'runtimeHome <- normalizePath(R.home(), winslash="/", mustWork=FALSE)',
  'userLibraryRaw <- Sys.getenv("R_LIBS_USER")',
  'userLibrary <- if (nzchar(userLibraryRaw)) normalizePath(path.expand(userLibraryRaw), winslash="/", mustWork=FALSE) else ""',
  'if (nrow(ip) > 0) {',
  '  ord <- order(tolower(ip[, "Package"]))',
  '  for (i in ord) {',
  '    priority <- if ("Priority" %in% colnames(ip) && !is.na(ip[i, "Priority"])) ip[i, "Priority"] else ""',
  '    built <- if ("Built" %in% colnames(ip) && !is.na(ip[i, "Built"])) ip[i, "Built"] else ""',
  '    libraryPath <- normalizePath(ip[i, "LibPath"], winslash="/", mustWork=FALSE)',
  '    libraryRank <- match(libraryPath, libraryPaths)',
  '    libraryScope <- if (startsWith(libraryPath, paste0(runtimeHome, "/"))) "environment" else if (nzchar(userLibrary) && startsWith(libraryPath, userLibrary)) "user" else "system"',
  '    descriptionPath <- file.path(ip[i, "LibPath"], ip[i, "Package"], "DESCRIPTION")',
  '    description <- tryCatch(read.dcf(descriptionPath), error=function(e) matrix(character(), nrow=0, ncol=0))',
  '    field <- function(name) if (nrow(description) > 0 && name %in% colnames(description) && !is.na(description[1, name])) gsub("[\\t\\r\\n]", " ", description[1, name]) else ""',
  '    cat("PACKAGE\\t", ip[i, "Package"], "\\t", ip[i, "Version"], "\\t", priority, "\\t", built, "\\t", libraryRank, "\\t", libraryScope, "\\t", field("RemoteType"), "\\t", field("RemoteHost"), "\\t", field("RemoteUsername"), "\\t", field("RemoteRepo"), "\\t", field("RemoteRef"), "\\t", field("RemoteSha"), "\\n", sep="")',
  '  }',
  '}'
].join('\n')

// These probes hash only Runtime/library directory metadata. They are intentionally cheaper than
// enumerating and parsing every installed distribution, but still notice added/removed package
// directories and metadata replacements made outside the app's package-manager journal.
const PYTHON_FINGERPRINT_SCRIPT = [
  'import os, pathlib, platform, sys',
  'print("RUNTIME\\t" + platform.python_version())',
  'for raw in sorted(set(filter(None, sys.path))):',
  '    root = pathlib.Path(raw)',
  '    if not root.is_dir(): continue',
  '    try:',
  '        st = root.stat()',
  '        print("ROOT\\t%s\\t%d\\t%d" % (root, st.st_mtime_ns, st.st_size))',
  '        for item in sorted(root.iterdir(), key=lambda value: value.name.casefold()):',
  '            if not (item.name.endswith(".dist-info") or item.name.endswith(".egg-info")): continue',
  '            meta = item / "METADATA"',
  '            target = meta if meta.exists() else item',
  '            info = target.stat()',
  '            print("PACKAGE\\t%s\\t%d\\t%d" % (item.name, info.st_mtime_ns, info.st_size))',
  '    except OSError:',
  '        print("UNWATCHABLE\\t" + str(root))'
].join('\n')

const R_FINGERPRINT_SCRIPT = [
  'cat("RUNTIME\\t", paste(R.version$major, R.version$minor, sep="."), "\\n", sep="")',
  'for (root in sort(unique(.libPaths()))) {',
  '  info <- file.info(root)',
  '  if (is.na(info$mtime)) { cat("UNWATCHABLE\\t", root, "\\n", sep=""); next }',
  '  cat("ROOT\\t", root, "\\t", sprintf("%.9f", as.numeric(info$mtime)), "\\t", info$size, "\\n", sep="")',
  '  packages <- sort(list.dirs(root, recursive=FALSE, full.names=TRUE))',
  '  for (pkg in packages) {',
  '    description <- file.path(pkg, "DESCRIPTION")',
  '    target <- if (file.exists(description)) description else pkg',
  '    pkgInfo <- file.info(target)',
  '    cat("PACKAGE\\t", basename(pkg), "\\t", sprintf("%.9f", as.numeric(pkgInfo$mtime)), "\\t", pkgInfo$size, "\\n", sep="")',
  '  }',
  '}'
].join('\n')

const parseInventory = (
  language: NotebookLanguage,
  stdout: string
): InstalledEnvironmentInventory => {
  let runtimeVersion: string | undefined
  let runtimePlatform: string | undefined
  let runtimeArchitecture: string | undefined
  const packages: NotebookEnvironmentPackage[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const [
      kind,
      nameOrVersion,
      version,
      priority,
      built,
      libraryRankValue,
      libraryScope,
      remoteType,
      remoteHost,
      remoteUsername,
      remoteRepo,
      remoteRef,
      remoteSha
    ] = line.split('\t')
    if (kind === 'RUNTIME') {
      runtimeVersion = nameOrVersion || undefined
      runtimePlatform = version || undefined
      runtimeArchitecture = priority || undefined
      continue
    }
    if (kind !== 'PACKAGE' || !nameOrVersion) continue
    packages.push({
      name: nameOrVersion,
      ...(version ? { version } : {}),
      versionStatus: version ? 'known' : 'unavailable',
      ecosystem: language,
      evidenceSources:
        language === 'python' ? ['python-importlib-metadata'] : ['r-installed-packages'],
      ...(priority === 'base' || priority === 'recommended'
        ? { priority }
        : priority
          ? { priority: 'other' as const }
          : {}),
      ...(built ? { builtForRuntime: built } : {}),
      ...(language === 'r' && Number.isSafeInteger(Number(libraryRankValue))
        ? { libraryRank: Number(libraryRankValue) }
        : {}),
      ...(language === 'r' &&
      (libraryScope === 'environment' || libraryScope === 'user' || libraryScope === 'system')
        ? { libraryScope }
        : language === 'r'
          ? { libraryScope: 'unknown' as const }
          : {}),
      ...(remoteType?.toLowerCase() === 'github' &&
      (remoteHost?.toLowerCase() === 'github.com' ||
        remoteHost?.toLowerCase() === 'api.github.com') &&
      remoteUsername &&
      remoteRepo
        ? {
            source: {
              type: 'github' as const,
              repository: `${remoteUsername}/${remoteRepo}`,
              ...(remoteRef ? { ref: remoteRef } : {}),
              ...(remoteSha ? { commit: remoteSha } : {})
            }
          }
        : {})
    })
  }
  return {
    runtimeVersion,
    platform: runtimePlatform,
    architecture: runtimeArchitecture,
    packages: sortPackages(packages)
  }
}

const inspectInstalledDefault = async (
  target: EnvironmentCaptureTarget,
  platform: NodeJS.Platform = process.platform,
  execute: EnvironmentExecFile = execFileAsync
): Promise<InstalledEnvironmentInventory> => {
  const args = [
    ...(target.args ?? []),
    ...(target.language === 'python'
      ? ['-c', PYTHON_INVENTORY_SCRIPT]
      : ['--vanilla', '--slave', '-e', R_INVENTORY_SCRIPT])
  ]
  const { stdout } = await execute(target.command, args, {
    timeout: INSPECTION_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: environmentCaptureProcessEnv(target, process.env, platform)
  })
  return parseInventory(target.language, stdout)
}

const captureFingerprintDefault = async (
  target: EnvironmentCaptureTarget,
  platform: NodeJS.Platform = process.platform,
  execute: EnvironmentExecFile = execFileAsync
): Promise<string | undefined> => {
  const args = [
    ...(target.args ?? []),
    ...(target.language === 'python'
      ? ['-c', PYTHON_FINGERPRINT_SCRIPT]
      : ['--vanilla', '--slave', '-e', R_FINGERPRINT_SCRIPT])
  ]
  const { stdout } = await execute(target.command, args, {
    timeout: INSPECTION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: environmentCaptureProcessEnv(target, process.env, platform)
  })
  if (stdout.includes('UNWATCHABLE\t')) return undefined
  return sha256(`${target.language}\n${stdout}`)
}

class EnvironmentStateTracker {
  private readonly inspectInstalled: (
    target: EnvironmentCaptureTarget
  ) => Promise<InstalledEnvironmentInventory>
  private readonly captureFingerprint: (
    target: EnvironmentCaptureTarget
  ) => Promise<string | undefined>
  private readonly now: () => Date
  private readonly platform: NodeJS.Platform
  private readonly logger?: Pick<RuntimeDiagnosticLogger, 'warn' | 'error'>
  private readonly operationLogLimits: { maxEntries: number; maxBytes: number }
  private readonly targetQueues = new Map<string, Promise<void>>()

  constructor(private readonly options: EnvironmentStateTrackerOptions) {
    this.platform = options.platform ?? process.platform
    this.logger = options.logger
    const execute = options.execFile ?? execFileAsync
    this.inspectInstalled =
      options.inspectInstalled ??
      ((target) => inspectInstalledDefault(target, this.platform, execute))
    this.captureFingerprint =
      options.captureFingerprint ??
      ((target) => captureFingerprintDefault(target, this.platform, execute))
    this.now = options.now ?? (() => new Date())
    this.operationLogLimits = options.operationLogLimits ?? {
      maxEntries: MAX_OPERATION_LOG_ENTRIES,
      maxBytes: MAX_ENVIRONMENT_BINDING_BYTES
    }
  }

  async inspectPackages(
    target: EnvironmentCaptureTarget,
    requestedPackages: string[]
  ): Promise<PackageInspectionResult> {
    const prepared = await this.prepareRun(target)
    return this.serializeTarget(target, async () => {
      const cache = await this.readBinding(target)
      const warnings = [...prepared.warnings]
      let inventory: StoredInventory | undefined
      if (cache.state === 'clean' && cache.inventoryChecksum) {
        try {
          inventory = await this.readInventory(target, cache.inventoryChecksum)
        } catch (error) {
          warnings.push(`Installed package inventory unavailable: ${describeError(error)}`)
        }
      }
      const source = inventory
        ? prepared.inventoryRefreshed
          ? 'full-scan'
          : 'cache-reused'
        : 'unavailable'
      return {
        inventory: {
          ...(inventory ? { capturedAt: inventory.capturedAt } : {}),
          source,
          validation:
            source === 'full-scan'
              ? 'full-scan'
              : source === 'cache-reused'
                ? 'best-effort'
                : 'unavailable'
        },
        packages: requestedPackages.map((requested) =>
          inspectRequestedPackage(target, requested, inventory?.packages)
        ),
        ...(warnings.length > 0 ? { warnings } : {})
      }
    })
  }

  async prepareRun(target: EnvironmentCaptureTarget): Promise<EnvironmentRunCaptureStart> {
    return this.serializeTarget(target, async () => {
      const cache = await this.readBinding(target)
      const warnings: string[] = []
      let inventoryRefreshed = false
      let fingerprint = await this.tryCaptureFingerprint(target)
      const expired =
        !cache.verifiedAt ||
        this.now().getTime() - Date.parse(cache.verifiedAt) > MAX_INVENTORY_CACHE_AGE_MS
      const fingerprintChanged = Boolean(
        fingerprint && cache.stateFingerprint && fingerprint !== cache.stateFingerprint
      )
      if (fingerprintChanged) {
        cache.state = 'dirty'
        cache.dirtyReason = 'fingerprint-changed'
      }

      if (cache.state === 'dirty' || expired || !fingerprint) {
        const requiresMutationRecovery = Boolean(cache.dirtyOperationId || cache.dirtyReason)
        try {
          const inventory = await this.captureInventory(target)
          cache.inventoryChecksum = this.inventoryChecksum(inventory)
          cache.state = 'clean'
          cache.verifiedAt = this.now().toISOString()
          cache.dirtyReason = undefined
          inventoryRefreshed = true
          fingerprint = await this.tryCaptureFingerprint(target)
          cache.stateFingerprint = fingerprint
          await this.completePendingOperation(target, cache, inventory)
          cache.dirtyOperationId = undefined
          await this.writeBinding(target, cache)
        } catch (error) {
          this.logProbeFailure(
            requiresMutationRecovery ? 'error' : 'warn',
            'environment inventory probe failed',
            target,
            error
          )
          cache.state = 'dirty'
          cache.dirtyReason = requiresMutationRecovery ? 'recovery' : undefined
          await this.writeBinding(target, cache)
          if (requiresMutationRecovery) {
            throw new Error(
              `Environment inventory recovery failed before Notebook execution: ${describeError(error)}`,
              { cause: error }
            )
          }
          warnings.push(`Installed package inventory unavailable: ${describeError(error)}`)
        }
      } else if (!cache.stateFingerprint) {
        cache.stateFingerprint = fingerprint
        await this.writeBinding(target, cache)
      }

      if (!fingerprint) {
        warnings.push('Environment fingerprint unavailable; installed inventory was rescanned.')
      }
      return { fingerprint, inventoryRefreshed, warnings }
    })
  }

  async captureCompletedRun(
    target: EnvironmentCaptureTarget,
    live?: NotebookLiveEnvironmentOverlay,
    prepared?: EnvironmentRunCaptureStart
  ): Promise<EnvironmentCaptureResult> {
    const runStart = prepared ?? (await this.prepareRun(target))
    return this.serializeTarget(target, async () => {
      const capturedAt = this.now().toISOString()
      const cache = await this.readBinding(target)
      if (compactOperationLog(cache, this.operationLogLimits)) {
        await this.writeBinding(target, cache)
      }
      let inventory: StoredInventory | undefined
      let inventorySource: NotebookEnvironmentManifest['installedInventory']['source'] =
        runStart.inventoryRefreshed ? 'full-scan' : 'cache-reused'
      const warnings = [...runStart.warnings, ...(live?.warnings ?? [])]
      const endFingerprint = await this.tryCaptureFingerprint(target)
      const fingerprintStable = Boolean(
        runStart.fingerprint && endFingerprint && runStart.fingerprint === endFingerprint
      )
      const environmentChangedDuringRun = Boolean(
        runStart.fingerprint && endFingerprint && runStart.fingerprint !== endFingerprint
      )

      if (
        cache.state === 'clean' &&
        cache.inventoryChecksum &&
        fingerprintStable &&
        !environmentChangedDuringRun
      ) {
        inventory = await this.readInventory(target, cache.inventoryChecksum).catch(() => undefined)
      }
      if (!inventory) {
        inventorySource = 'full-scan'
        try {
          inventory = await this.captureInventory(target)
          cache.state = 'clean'
          cache.inventoryChecksum = this.inventoryChecksum(inventory)
          cache.stateFingerprint = endFingerprint
          cache.verifiedAt = capturedAt
          cache.dirtyOperationId = undefined
          cache.dirtyReason = undefined
          await this.writeBinding(target, cache)
        } catch (error) {
          this.logProbeFailure('warn', 'environment inventory probe failed', target, error)
          warnings.push(`Installed package inventory unavailable: ${describeError(error)}`)
        }
      }

      const packages = mergePackages(inventory?.packages ?? [], live?.packages ?? [])
      if (environmentChangedDuringRun) {
        warnings.push('environment-changed-during-run')
      } else if (!fingerprintStable || inventorySource === 'cache-reused') {
        warnings.push('inventory-cache-best-effort')
      }
      const complete = Boolean(
        inventory &&
        live &&
        inventorySource === 'full-scan' &&
        fingerprintStable &&
        !environmentChangedDuringRun
      )
      if (!live) warnings.push('Live Kernel package state unavailable.')
      const manifest: NotebookEnvironmentManifest = {
        schemaVersion: 1,
        captureKind: 'completed-run',
        capturedAt,
        installedInventory: {
          capturedAt: inventory?.capturedAt ?? capturedAt,
          source: inventorySource,
          validation: inventory && inventorySource === 'full-scan' ? 'full-scan' : 'best-effort'
        },
        kernelKind: target.language,
        environmentName: target.environmentName,
        runtimeSource: target.runtimeSource,
        runtimeVersion: live?.runtimeVersion ?? inventory?.runtimeVersion,
        ...(inventory?.platform ? { platform: inventory.platform } : {}),
        ...(inventory?.architecture ? { architecture: inventory.architecture } : {}),
        inventorySources: [
          ...(live ? (['kernel-native'] as const) : []),
          ...(inventory ? (['interpreter-native'] as const) : []),
          ...(cache.operationLog.length > 0 ? (['operation-log'] as const) : [])
        ],
        packages,
        ...(cache.operationLog.length > 0 ? { operationLog: cache.operationLog } : {}),
        ...(cache.operationLogTruncation
          ? { operationLogTruncation: cache.operationLogTruncation }
          : {}),
        complete,
        captureStatus: complete ? 'complete' : 'partial',
        ...(warnings.length > 0 ? { warnings } : {})
      }
      const serialized = `${JSON.stringify(manifest, null, 2)}\n`
      const checksum = sha256(serialized)
      const storagePath = join(this.manifestDirectory(), `${checksum}.json`)
      try {
        await this.writeImmutable(storagePath, serialized)
      } catch (error) {
        throw new EnvironmentManifestPublicationError(error)
      }
      return { manifest, checksum, storagePath }
    })
  }

  async markPackageMutationDirty(
    target: EnvironmentCaptureTarget,
    intent: PackageMutationIntent
  ): Promise<void> {
    await this.serializeTarget(target, async () => {
      const cache = await this.readBinding(target)
      let beforeInventoryChecksum = cache.inventoryChecksum
      if (beforeInventoryChecksum) {
        const baselineReadable = await this.readInventory(target, beforeInventoryChecksum)
          .then(() => true)
          .catch(() => false)
        if (!baselineReadable) beforeInventoryChecksum = undefined
      }
      // A mutation delta is only meaningful with a readable pre-mutation inventory. Capture it here,
      // inside the environment's install lock and before publishing the durable dirty marker, so the
      // first manage_packages call can usually report an exact change. Keep this best-effort: a runtime
      // whose metadata probe is broken may need the installer itself to repair it.
      if (!beforeInventoryChecksum) {
        try {
          const baseline = await this.captureInventory(target)
          beforeInventoryChecksum = this.inventoryChecksum(baseline)
          cache.inventoryChecksum = beforeInventoryChecksum
          cache.stateFingerprint = await this.tryCaptureFingerprint(target)
          cache.verifiedAt = this.now().toISOString()
        } catch (error) {
          this.logProbeFailure(
            'warn',
            'pre-install environment inventory probe failed',
            target,
            error
          )
          beforeInventoryChecksum = undefined
        }
      }
      cache.generation += 1
      cache.state = 'dirty'
      cache.dirtyOperationId = intent.operationId
      cache.dirtyReason = 'package-mutation'
      await this.writeOperation(target, {
        schemaVersion: 1,
        operationId: intent.operationId,
        runtimeLocalKey: this.targetKey(target),
        generation: cache.generation,
        lifecycle: 'intent',
        operation: intent.operation,
        packages: [...intent.packages],
        attempts: [],
        fallbackUsed: false,
        inventoryRefreshAttempts: [],
        beforeInventoryChecksum
      })
      await this.writeBinding(target, cache)
    })
  }

  async refreshAfterPackageMutation(
    target: EnvironmentCaptureTarget,
    outcome: PackageMutationOutcome
  ): Promise<PackageMutationVerification> {
    return this.serializeTarget(target, async () => {
      const cache = await this.readBinding(target)
      const operation = await this.readOperation(target, outcome.operationId)
      const beforeInventoryChecksum = operation?.beforeInventoryChecksum ?? cache.inventoryChecksum
      const baseLogEntry: NotebookEnvironmentOperation = {
        operationId: outcome.operationId,
        timestamp: this.now().toISOString(),
        operation: outcome.operation,
        packages: [...outcome.packages],
        result: outcome.result,
        attempts: outcome.attempts ?? operation?.attempts ?? [],
        fallbackUsed: outcome.fallbackUsed ?? operation?.fallbackUsed ?? false,
        inventoryRefresh: 'failed',
        inventoryRefreshAttempts: operation?.inventoryRefreshAttempts ?? []
      }
      const terminalOperation: PendingEnvironmentOperationRecord = {
        ...(operation ?? {
          schemaVersion: 1,
          operationId: outcome.operationId,
          runtimeLocalKey: this.targetKey(target),
          generation: cache.generation,
          operation: outcome.operation,
          packages: [...outcome.packages],
          inventoryRefreshAttempts: []
        }),
        lifecycle: 'terminal-refresh-pending',
        terminalResult: outcome.result,
        ...(outcome.source ? { source: outcome.source } : {}),
        attempts: baseLogEntry.attempts,
        fallbackUsed: baseLogEntry.fallbackUsed
      }
      // Persist the completed installer outcome before any inventory I/O so recovery retains source
      // evidence if the app exits between the installer and terminal refresh.
      await this.writeOperation(target, terminalOperation)
      const beforeInventory = beforeInventoryChecksum
        ? await this.readInventory(target, beforeInventoryChecksum).catch(() => undefined)
        : undefined
      let verification: PackageMutationVerification
      try {
        const previousInventoryChecksum = cache.inventoryChecksum
        const inventory = await this.captureInventory(target)
        const nextInventoryChecksum = this.inventoryChecksum(inventory)
        const inventoryRefresh =
          previousInventoryChecksum === nextInventoryChecksum ? 'unchanged' : 'published'
        const publishedAttempt: NotebookInventoryRefreshAttempt = {
          attempt: baseLogEntry.inventoryRefreshAttempts.length + 1,
          trigger: 'terminal',
          timestamp: this.now().toISOString(),
          result: inventoryRefresh
        }
        const packageChanges = packageChangesWithSource(
          packageChangesForOperation({
            language: target.language,
            before: beforeInventory?.packages,
            after: inventory.packages,
            requestedPackages: outcome.packages
          }),
          outcome.source
        )
        verification = {
          ...verifyPackageMutation(target, outcome, inventory.packages),
          ...(packageChanges.length > 0 ? { packageChanges } : {})
        }
        const publishedEntry: NotebookEnvironmentOperation = {
          ...baseLogEntry,
          result: verification.result,
          inventoryRefresh,
          inventoryRefreshAttempts: [...baseLogEntry.inventoryRefreshAttempts, publishedAttempt],
          packageChanges
        }
        cache.inventoryChecksum = nextInventoryChecksum
        cache.state = 'clean'
        cache.dirtyOperationId = undefined
        cache.dirtyReason = undefined
        cache.stateFingerprint = await this.tryCaptureFingerprint(target)
        cache.verifiedAt = this.now().toISOString()
        cache.currentManifestChecksum = await this.publishOperationManifest(
          target,
          inventory,
          publishedEntry
        )
        cache.operationLog = [
          ...cache.operationLog.filter((entry) => entry.operationId !== outcome.operationId),
          publishedEntry
        ]
        if (operation) await this.removeOperation(target, operation.operationId)
      } catch (error) {
        this.logProbeFailure(
          'error',
          'post-install environment inventory probe failed',
          target,
          error
        )
        verification = { result: 'failure', reason: 'inventory-refresh-failed' }
        const failedAttempt: NotebookInventoryRefreshAttempt = {
          attempt: baseLogEntry.inventoryRefreshAttempts.length + 1,
          trigger: 'terminal',
          timestamp: this.now().toISOString(),
          result: 'failed',
          error: describeError(error)
        }
        const pendingEntry: NotebookEnvironmentOperation = {
          ...baseLogEntry,
          inventoryRefresh: 'failed',
          inventoryRefreshAttempts: [...baseLogEntry.inventoryRefreshAttempts, failedAttempt]
        }
        cache.operationLog = [
          ...cache.operationLog.filter((entry) => entry.operationId !== outcome.operationId),
          pendingEntry
        ]
        cache.state = 'dirty'
        cache.dirtyOperationId = outcome.operationId
        cache.dirtyReason = 'recovery'
        await this.writeOperation(target, {
          ...terminalOperation,
          inventoryRefreshAttempts: pendingEntry.inventoryRefreshAttempts
        })
      }
      await this.writeBinding(target, cache)
      return verification
    })
  }

  private targetKey(target: EnvironmentCaptureTarget): string {
    return sha256(
      JSON.stringify([
        target.language,
        target.environmentName,
        target.runtimeSource,
        target.command,
        target.args ?? []
      ])
    )
  }

  private targetDirectory(target: EnvironmentCaptureTarget): string {
    return join(
      this.options.dataRoot,
      'runtime',
      'provenance',
      'environment-inventory',
      this.targetKey(target)
    )
  }

  private manifestDirectory(): string {
    return join(this.options.dataRoot, 'runtime', 'provenance', 'environment-manifests')
  }

  private operationPath(target: EnvironmentCaptureTarget, operationId: string): string {
    return join(this.targetDirectory(target), 'operations', `${operationId}.json`)
  }

  private inventoryChecksum(inventory: StoredInventory): string {
    return sha256(`${JSON.stringify(inventory, null, 2)}\n`)
  }

  private async captureInventory(target: EnvironmentCaptureTarget): Promise<StoredInventory> {
    const inspected = await this.inspectInstalled(target)
    const inventory: StoredInventory = {
      schemaVersion: 1,
      capturedAt: this.now().toISOString(),
      runtimeVersion: inspected.runtimeVersion,
      platform: inspected.platform,
      architecture: inspected.architecture,
      packages: sortPackages(inspected.packages)
    }
    const serialized = `${JSON.stringify(inventory, null, 2)}\n`
    const checksum = sha256(serialized)
    await this.writeImmutable(
      join(this.targetDirectory(target), 'inventories', `${checksum}.json`),
      serialized
    )
    return inventory
  }

  private async tryCaptureFingerprint(
    target: EnvironmentCaptureTarget
  ): Promise<string | undefined> {
    return this.captureFingerprint(target).catch((error) => {
      this.logProbeFailure('warn', 'environment fingerprint probe failed', target, error)
      return undefined
    })
  }

  private logProbeFailure(
    level: 'warn' | 'error',
    message: string,
    target: EnvironmentCaptureTarget,
    error: unknown
  ): void {
    try {
      this.logger?.[level](message, {
        ...runtimeChildProcessErrorFields(error),
        language: target.language,
        environmentName: target.environmentName,
        runtimeSource: target.runtimeSource,
        command: target.command,
        ...(target.condaPrefix ? { condaPrefix: target.condaPrefix } : {})
      })
    } catch {
      // Diagnostics are best-effort and must never replace the environment capture outcome.
    }
  }

  private async publishOperationManifest(
    target: EnvironmentCaptureTarget,
    inventory: StoredInventory,
    operation: NotebookEnvironmentOperation
  ): Promise<string> {
    const manifest = {
      schemaVersion: 1,
      captureKind: 'operation',
      capturedAt: this.now().toISOString(),
      environmentName: target.environmentName,
      kernelKind: target.language,
      runtimeSource: target.runtimeSource,
      runtimeVersion: inventory.runtimeVersion,
      ...(inventory.platform ? { platform: inventory.platform } : {}),
      ...(inventory.architecture ? { architecture: inventory.architecture } : {}),
      installedInventory: {
        capturedAt: inventory.capturedAt,
        source: 'full-scan',
        validation: 'full-scan'
      },
      packages: inventory.packages,
      operationLog: [operation]
    }
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`
    const checksum = sha256(serialized)
    await this.writeImmutable(join(this.manifestDirectory(), `${checksum}.json`), serialized)
    return checksum
  }

  private async completePendingOperation(
    target: EnvironmentCaptureTarget,
    cache: EnvironmentInventoryBindingCache,
    inventory: StoredInventory
  ): Promise<void> {
    if (!cache.dirtyOperationId) return
    const pending = await this.readOperation(target, cache.dirtyOperationId)
    if (!pending) return
    const recoveredResult = verifyPackageMutation(
      target,
      {
        operationId: pending.operationId,
        operation: pending.operation,
        packages: pending.packages,
        result: pending.terminalResult ?? 'failure'
      },
      inventory.packages
    )
    const operation: NotebookEnvironmentOperation = {
      operationId: pending.operationId,
      timestamp: this.now().toISOString(),
      operation: pending.operation,
      packages: [...pending.packages],
      result: recoveredResult.result,
      attempts: pending.attempts ?? [],
      fallbackUsed: pending.fallbackUsed ?? false,
      inventoryRefresh: 'published',
      inventoryRefreshAttempts: [
        ...(pending.inventoryRefreshAttempts ?? []),
        {
          attempt: (pending.inventoryRefreshAttempts?.length ?? 0) + 1,
          trigger: 'recovery',
          timestamp: this.now().toISOString(),
          result: 'published'
        }
      ],
      packageChanges: packageChangesWithSource(
        packageChangesForOperation({
          language: target.language,
          before: pending.beforeInventoryChecksum
            ? (
                await this.readInventory(target, pending.beforeInventoryChecksum).catch(
                  () => undefined
                )
              )?.packages
            : undefined,
          after: inventory.packages,
          requestedPackages: pending.packages
        }),
        pending.source
      )
    }
    cache.currentManifestChecksum = await this.publishOperationManifest(
      target,
      inventory,
      operation
    )
    cache.operationLog = [
      ...cache.operationLog.filter((entry) => entry.operationId !== operation.operationId),
      operation
    ]
    await this.removeOperation(target, pending.operationId)
  }

  private async readOperation(
    target: EnvironmentCaptureTarget,
    operationId: string
  ): Promise<PendingEnvironmentOperationRecord | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.operationPath(target, operationId), 'utf8')
      ) as PendingEnvironmentOperationRecord
      if (
        parsed.schemaVersion !== 1 ||
        parsed.operationId !== operationId ||
        parsed.runtimeLocalKey !== this.targetKey(target) ||
        !Array.isArray(parsed.packages) ||
        !Array.isArray(parsed.inventoryRefreshAttempts)
      ) {
        throw new Error('Invalid pending Environment operation record.')
      }
      parsed.attempts ??= []
      parsed.fallbackUsed ??= false
      return parsed
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    }
  }

  private async writeOperation(
    target: EnvironmentCaptureTarget,
    operation: PendingEnvironmentOperationRecord
  ): Promise<void> {
    const path = this.operationPath(target, operation.operationId)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(operation, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  private async removeOperation(
    target: EnvironmentCaptureTarget,
    operationId: string
  ): Promise<void> {
    await rm(this.operationPath(target, operationId), { force: true })
  }

  private async readInventory(
    target: EnvironmentCaptureTarget,
    checksum: string
  ): Promise<StoredInventory> {
    const serialized = await readFile(
      join(this.targetDirectory(target), 'inventories', `${checksum}.json`),
      'utf8'
    )
    if (sha256(serialized) !== checksum) throw new Error('Environment inventory checksum mismatch.')
    return JSON.parse(serialized) as StoredInventory
  }

  private async readBinding(
    target: EnvironmentCaptureTarget
  ): Promise<EnvironmentInventoryBindingCache> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.targetDirectory(target), 'binding.json'), 'utf8')
      ) as EnvironmentInventoryBindingCache
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.operationLog)) {
        throw new Error('Invalid environment inventory binding cache.')
      }
      parsed.operationLog = parsed.operationLog.map((operation) => ({
        ...operation,
        attempts: operation.attempts ?? [],
        fallbackUsed: operation.fallbackUsed ?? false,
        inventoryRefresh: operation.inventoryRefresh ?? 'published',
        inventoryRefreshAttempts: operation.inventoryRefreshAttempts ?? []
      }))
      if (
        parsed.operationLogTruncation !== undefined &&
        !isNotebookEnvironmentOperationLogTruncation(parsed.operationLogTruncation)
      ) {
        throw new Error('Invalid environment operation log truncation metadata.')
      }
      return parsed
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return { schemaVersion: 1, generation: 0, state: 'dirty', operationLog: [] }
      }
      throw error
    }
  }

  private async writeBinding(
    target: EnvironmentCaptureTarget,
    cache: EnvironmentInventoryBindingCache
  ): Promise<void> {
    compactOperationLog(cache, this.operationLogLimits)
    const path = join(this.targetDirectory(target), 'binding.json')
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  }

  private async writeImmutable(path: string, content: string): Promise<void> {
    try {
      const existing = await readFile(path, 'utf8')
      if (existing !== content) throw new Error('Immutable environment manifest conflict.')
      return
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      )) {
        throw error
      }
    }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  }

  private async serializeTarget<Result>(
    target: EnvironmentCaptureTarget,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const key = this.targetKey(target)
    const previous = this.targetQueues.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.then(() => current)
    this.targetQueues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.targetQueues.get(key) === tail) this.targetQueues.delete(key)
    }
  }
}

export {
  environmentCaptureProcessEnv,
  EnvironmentManifestPublicationError,
  EnvironmentStateTracker
}
export type {
  EnvironmentCaptureResult,
  EnvironmentRunCaptureStart,
  EnvironmentCaptureTarget,
  EnvironmentStateTrackerOptions,
  InstalledEnvironmentInventory,
  InspectedPackage,
  PackageInspectionResult,
  PackageMutationIntent,
  PackageMutationVerification,
  PackageMutationOutcome
}

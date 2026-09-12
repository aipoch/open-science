import { packageVersionsMatch } from './package-version-comparison'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, posix, relative, resolve, sep } from 'node:path'

import type {
  NotebookEnvironmentLock,
  NotebookEnvironmentLockComponent,
  NotebookEnvironmentLockFile,
  NotebookEnvironmentLockPartialReason,
  NotebookEnvironmentManifest,
  NotebookEnvironmentPackage,
  NotebookPackageInstaller,
  NotebookRunEnvironmentLockCapture
} from '../../shared/notebook'
import { redactSensitiveText } from '../../shared/diagnostic-redaction'
import { createLogger, diagnosticErrorFields } from '../logger'
import { normalizeExplicitLock } from './micromamba'
import { lockedPackageVersions, nativeLockRestoreState } from './native-lock-restoration'
import { capturePipInstallEvidence, recoverPipInstallEvidence } from './pip-install-evidence'
import { normalizeRuntimeArchitecture, rLibraryDir, rScriptBin } from './runtime-paths'
import {
  decodeVersionedJson,
  type VersionedJsonDecodeResult
} from '../storage/versioned-json-decoder'

type EnvironmentLockTarget = Pick<
  NotebookEnvironmentManifest,
  'environmentName' | 'runtimeSource'
> & {
  language: NotebookEnvironmentManifest['kernelKind']
  condaPrefix?: string
  command?: string
  args?: string[]
}

type EnvironmentLockExec = (argv: string[]) => Promise<string>

type EnvironmentLockWorkspace = Readonly<{
  sessionRoot: string
  searchRoots: readonly string[]
}>

type CaptureNotebookEnvironmentLockOptions = {
  micromamba?: string
  execute: EnvironmentLockExec
  environmentFingerprint?: string
  workspace?: EnvironmentLockWorkspace
}

type EnvironmentLockCaptureResult =
  | {
      state: 'captured'
      lock: NotebookEnvironmentLock
      captureStatus: 'complete' | 'partial'
      partialReasons?: NotebookEnvironmentLockPartialReason[]
      diagnostics?: Extract<
        NotebookRunEnvironmentLockCapture,
        { state: 'partial' | 'available' }
      >['diagnostics']
    }
  | {
      state: 'unavailable'
      reason: Extract<NotebookRunEnvironmentLockCapture, { state: 'unavailable' }>['reason']
    }

type NativeLockComponent = Extract<NotebookEnvironmentLockComponent, { ecosystem: 'python' | 'r' }>

type CondaEnvironmentSnapshot = {
  packages: Map<string, string | undefined>
  pipPackages: Array<{ name: string; version: string }>
  explicitLock: string
}

type EnvironmentLockCacheEntry = {
  revision: string
  lock: NotebookEnvironmentLock
  pipPackages: CondaEnvironmentSnapshot['pipPackages']
  retryAfter?: number
}

type NativeLockSpec = Readonly<{
  ecosystem: 'python' | 'r'
  format: NativeLockComponent['format']
  primary: string
  companions?: readonly string[]
}>

class InvalidEnvironmentLockError extends Error {}

const MAX_NATIVE_LOCK_FILE_BYTES = 2 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

const NATIVE_LOCK_SPECS: Record<'python' | 'r', readonly NativeLockSpec[]> = {
  python: [
    { ecosystem: 'python', format: 'uv-lock', primary: 'uv.lock', companions: ['pyproject.toml'] },
    {
      ecosystem: 'python',
      format: 'poetry-lock',
      primary: 'poetry.lock',
      companions: ['pyproject.toml']
    },
    { ecosystem: 'python', format: 'pip-requirements', primary: 'requirements.lock' },
    { ecosystem: 'python', format: 'pip-requirements', primary: 'requirements.txt' }
  ],
  r: [
    { ecosystem: 'r', format: 'renv-lock', primary: 'renv.lock' },
    { ecosystem: 'r', format: 'pak-lock', primary: 'pkg.lock' }
  ]
}

const PACKAGE_INSTALLERS = new Set([
  'conda',
  'pip',
  'uv',
  'poetry',
  'r-install-packages',
  'renv',
  'pak',
  'biocmanager',
  'github',
  'unknown'
])

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

const normalizedPackageName = (value: string): string =>
  value
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('und')
    .replace(/[-_.]+/gu, '-')

const parseCondaEnvironmentSnapshot = (raw: string): CondaEnvironmentSnapshot => {
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidEnvironmentLockError('The micromamba package inventory is empty.')
  }
  const records = new Map<string, string | undefined>()
  const pipPackages: CondaEnvironmentSnapshot['pipPackages'] = []
  const explicitLines: string[] = []
  for (const entry of value) {
    const record = recordValue(entry)
    if (!record || typeof record.name !== 'string' || record.name.trim().length === 0) {
      throw new InvalidEnvironmentLockError('The micromamba package inventory is invalid.')
    }
    if (record.version !== undefined && typeof record.version !== 'string') {
      throw new InvalidEnvironmentLockError('The micromamba package inventory is invalid.')
    }
    // `list --json` includes PyPI distributions, which have no Conda archive URL or MD5.
    // Keep them as native requirements; dropping them would falsely certify a Conda-only lock.
    if (record.channel === 'pypi') {
      if (typeof record.version !== 'string' || record.version.trim().length === 0) {
        throw new InvalidEnvironmentLockError('The micromamba package inventory is invalid.')
      }
      pipPackages.push({
        name: normalizedPackageName(record.name),
        version: record.version
      })
      continue
    }
    if (
      typeof record.url !== 'string' ||
      record.url.length === 0 ||
      typeof record.md5 !== 'string' ||
      !/^[a-f0-9]{32}$/iu.test(record.md5)
    ) {
      throw new InvalidEnvironmentLockError('The micromamba package inventory is not restorable.')
    }
    let url: URL
    try {
      url = new URL(record.url)
    } catch {
      throw new InvalidEnvironmentLockError('The micromamba package inventory has an invalid URL.')
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new InvalidEnvironmentLockError('The micromamba package inventory is unsafe.')
    }
    records.set(normalizedPackageName(record.name), record.version as string | undefined)
    explicitLines.push(`${record.url}#${record.md5.toLowerCase()}`)
  }
  explicitLines.sort()
  return {
    packages: records,
    pipPackages,
    explicitLock: validateExplicitLock(`@EXPLICIT\n${explicitLines.join('\n')}\n`)
  }
}

const parseCondaPackageNames = (raw: string): string[] =>
  [...parseCondaEnvironmentSnapshot(raw).packages.keys()].sort()

const validateExplicitLock = (raw: string): string => {
  const lock = normalizeExplicitLock(raw)
  const packageLines = lock.split(/\r?\n/u).slice(1).filter(Boolean)
  if (packageLines.length === 0) {
    throw new InvalidEnvironmentLockError('The explicit lock contains no packages.')
  }
  const archives = new Set<string>()
  for (const line of packageLines) {
    let url: URL
    try {
      url = new URL(line)
    } catch {
      throw new InvalidEnvironmentLockError('The explicit lock contains an invalid package URL.')
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      !/^#[a-f0-9]{32}$/iu.test(url.hash)
    ) {
      throw new InvalidEnvironmentLockError('The explicit lock contains unsafe package metadata.')
    }
    // Mirrors share the same package-cache basename. Two entries for it must not compete
    // during restoration, even if they use different URLs or checksums.
    const archive = posix.basename(url.pathname)
    if (archives.has(archive)) {
      throw new InvalidEnvironmentLockError(
        'The explicit lock contains duplicate package archives.'
      )
    }
    archives.add(archive)
  }
  return lock
}

const portableLockPath = (value: string): boolean =>
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')

const hasLocalDependencyReference = (content: string): boolean =>
  [
    /(?:^|\r?\n)\s*(?:-e|--editable)(?:\s+|=)\s*(?!https?:\/\/|git\+|ssh:\/\/)[^\s#]+/iu,
    /(?:^|\r?\n)\s*[A-Za-z0-9_.-]+(?:\[[^\]]+\])?\s*@\s*(?!https?:\/\/|git\+|ssh:\/\/)[^\s#]+/iu,
    /\b(?:path|directory|editable)\s*=\s*["'](?!https?:\/\/|git\+|ssh:\/\/)[^"']+["']/iu,
    /"(?:Path|RemotePath|LocalPath|path|directory|editable)"\s*:\s*"(?!https?:\/\/|git\+|ssh:\/\/)[^"]+"/iu,
    /"(?:Source|RemoteType)"\s*:\s*"local"/iu,
    /(?:^|\r?\n)\s*(?:\.\.?[\\/]|~[\\/])[^\s#]*/mu,
    /\blocal::/iu
  ].some((pattern) => pattern.test(content))

const nativeLockContentIsSafe = (content: string): boolean =>
  !content.includes('\0') &&
  !/\bfile:(?:\/{2,})?/iu.test(content) &&
  !/(?:^|[\s"'=(])(?:~\/|\/(?!\/)[^\s"',}\]]+|[A-Za-z]:[\\/])/mu.test(content) &&
  !hasLocalDependencyReference(content) &&
  redactSensitiveText(content) === content

const nativeLockFileValue = (value: unknown): value is NotebookEnvironmentLockFile => {
  const file = recordValue(value)
  return Boolean(
    file &&
    typeof file.path === 'string' &&
    portableLockPath(file.path) &&
    typeof file.checksum === 'string' &&
    SHA256_PATTERN.test(file.checksum) &&
    typeof file.content === 'string' &&
    Buffer.byteLength(file.content, 'utf8') <= MAX_NATIVE_LOCK_FILE_BYTES &&
    sha256(file.content) === file.checksum &&
    nativeLockContentIsSafe(file.content) &&
    hasOnlyKeys(file, ['path', 'checksum', 'content'])
  )
}

const requirementsAreLocked = (content: string): boolean => {
  const requirements = content
    .replace(/\\\r?\n/gu, ' ')
    .split(/\r?\n/gu)
    .map((line) => line.replace(/(?:^|\s+)#.*$/u, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  return (
    requirements.length > 0 &&
    requirements.every(
      (line) =>
        !line.includes(';') &&
        /^[A-Za-z0-9_.-]+(?:\[[^\]]+\])?==[^\s;*]+(?=\s|$)/u.test(line) &&
        /(?:^|\s)--hash=sha256:[a-f0-9]{64}(?:\s|$)/iu.test(line)
    )
  )
}

const hasCompanionBesidePrimary = (
  files: readonly NotebookEnvironmentLockFile[],
  primaryName: string,
  companionName: string
): boolean => {
  const primary = files.find((file) => posix.basename(file.path) === primaryName)
  return Boolean(
    primary &&
    files.some(
      (file) =>
        posix.basename(file.path) === companionName &&
        posix.dirname(file.path) === posix.dirname(primary.path)
    )
  )
}

const nativeComponentValue = (value: Record<string, unknown>): value is NativeLockComponent => {
  const files = value.files
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every(nativeLockFileValue) ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    !hasOnlyKeys(value, ['ecosystem', 'format', 'resolution', 'files'])
  ) {
    return false
  }
  const lockFiles = files as NotebookEnvironmentLockFile[]
  const basenames = new Set(lockFiles.map((file) => file.path.split('/').at(-1)))
  const primaryContent = (filename: string): string | undefined => {
    const matches = lockFiles.filter((file) => posix.basename(file.path) === filename)
    return matches.length === 1 ? matches[0]!.content : undefined
  }
  if (value.ecosystem === 'python') {
    if (value.resolution !== 'locked' && value.resolution !== 'best-effort') return false
    if (value.format === 'uv-lock') {
      const content = primaryContent('uv.lock')
      return Boolean(
        content &&
        /^version\s*=\s*\d+/mu.test(content) &&
        /\[\[package\]\]/u.test(content) &&
        (value.resolution !== 'locked' ||
          hasCompanionBesidePrimary(lockFiles, 'uv.lock', 'pyproject.toml'))
      )
    }
    if (value.format === 'poetry-lock') {
      const content = primaryContent('poetry.lock')
      return Boolean(
        content &&
        /\[\[package\]\]/u.test(content) &&
        (value.resolution !== 'locked' ||
          hasCompanionBesidePrimary(lockFiles, 'poetry.lock', 'pyproject.toml'))
      )
    }
    if (value.format === 'pip-requirements') {
      const content = basenames.has('requirements.lock')
        ? primaryContent('requirements.lock')
        : primaryContent('requirements.txt')
      return Boolean(
        content &&
        content
          .split(/\r?\n/gu)
          .some((line) => line.trim().length > 0 && !line.trim().startsWith('#')) &&
        (value.resolution !== 'locked' || requirementsAreLocked(content))
      )
    }
    return false
  }
  if (value.ecosystem !== 'r' || value.resolution !== 'locked') {
    return false
  }
  try {
    if (value.format === 'renv-lock' && basenames.has('renv.lock')) {
      const renv = recordValue(JSON.parse(primaryContent('renv.lock') ?? 'null'))
      return Boolean(renv && recordValue(renv.Packages))
    }
    if (value.format === 'pak-lock' && basenames.has('pkg.lock')) {
      const pak = recordValue(JSON.parse(primaryContent('pkg.lock') ?? 'null'))
      return Boolean(pak && Array.isArray(pak.packages) && pak.packages.length > 0)
    }
    return false
  } catch {
    return false
  }
}

const lockComponentValue = (value: unknown): value is NotebookEnvironmentLockComponent => {
  const component = recordValue(value)
  if (!component) return false
  if (component.ecosystem !== 'conda') return nativeComponentValue(component)
  if (
    component.format !== 'conda-explicit-md5' ||
    component.resolution !== 'locked' ||
    typeof component.explicitLock !== 'string' ||
    !Array.isArray(component.packages) ||
    component.packages.length === 0 ||
    !component.packages.every((name) => typeof name === 'string' && name.length > 0) ||
    !hasOnlyKeys(component, ['ecosystem', 'format', 'resolution', 'explicitLock', 'packages'])
  ) {
    return false
  }
  try {
    return validateExplicitLock(component.explicitLock) === component.explicitLock
  } catch {
    return false
  }
}

const environmentLockValue = (value: unknown): NotebookEnvironmentLock | undefined => {
  const lock = recordValue(value)
  if (!lock) return undefined
  const untrackedPackages = lock.untrackedPackages
  const omittedPackages = lock.omittedPackages
  const installers = lock.nonCondaInstallers
  const components = lock.components
  const componentIdentities = Array.isArray(components)
    ? components.map((component) => {
        const record = recordValue(component)
        return `${String(record?.ecosystem)}:${String(record?.format)}`
      })
    : []
  if (
    (lock.schemaVersion !== 1 && lock.schemaVersion !== 2) ||
    lock.format !== 'environment-lock-bundle' ||
    (lock.kernelKind !== 'python' && lock.kernelKind !== 'r') ||
    typeof lock.environmentName !== 'string' ||
    (lock.platform !== undefined && typeof lock.platform !== 'string') ||
    (lock.architecture !== undefined && typeof lock.architecture !== 'string') ||
    !Array.isArray(components) ||
    components.length === 0 ||
    !components.every(lockComponentValue) ||
    new Set(componentIdentities).size !== componentIdentities.length ||
    (lock.schemaVersion === 1
      ? components.filter((component) => component.ecosystem === 'conda').length !== 1 ||
        lock.externalRuntime !== undefined
      : components.some((component) => component.ecosystem === 'conda') ||
        !recordValue(lock.externalRuntime) ||
        !hasOnlyKeys(recordValue(lock.externalRuntime)!, ['version', 'installerVersion']) ||
        !/^\d+\.\d+\.\d+(?:[a-z0-9.+-]*)?$/iu.test(
          String(recordValue(lock.externalRuntime)?.version ?? '')
        ) ||
        !/^\d+\.\d+(?:[a-z0-9.+-]*)?$/iu.test(
          String(recordValue(lock.externalRuntime)?.installerVersion ?? '')
        ) ||
        !['win32', 'darwin', 'linux'].includes(String(lock.platform)) ||
        !['x64', 'arm64'].includes(normalizeRuntimeArchitecture(String(lock.architecture))) ||
        components.length !== 1 ||
        !components.every(
          (component) =>
            component.format === (lock.kernelKind === 'r' ? 'renv-lock' : 'pip-requirements')
        )) ||
    components.some(
      (component) => component.ecosystem !== 'conda' && component.ecosystem !== lock.kernelKind
    ) ||
    (untrackedPackages !== undefined &&
      (!Array.isArray(untrackedPackages) ||
        !untrackedPackages.every((name) => typeof name === 'string' && name.length > 0))) ||
    (omittedPackages !== undefined &&
      (!Array.isArray(omittedPackages) ||
        omittedPackages.length === 0 ||
        new Set(omittedPackages).size !== omittedPackages.length ||
        !omittedPackages.every(
          (name) =>
            typeof name === 'string' &&
            name.startsWith(`${lock.kernelKind}:`) &&
            /^[a-z0-9][a-z0-9-]*$/u.test(name.slice(name.indexOf(':') + 1)) &&
            !untrackedPackages?.includes(name)
        ))) ||
    (installers !== undefined &&
      (!Array.isArray(installers) ||
        !installers.every(
          (installer) => typeof installer === 'string' && PACKAGE_INSTALLERS.has(installer)
        ))) ||
    !hasOnlyKeys(lock, [
      'schemaVersion',
      'format',
      'kernelKind',
      'environmentName',
      'platform',
      'architecture',
      'components',
      'untrackedPackages',
      'omittedPackages',
      'nonCondaInstallers',
      'externalRuntime'
    ])
  ) {
    return undefined
  }
  return value as NotebookEnvironmentLock
}

const decodeNotebookEnvironmentLock = (
  value: string
): VersionedJsonDecodeResult<NotebookEnvironmentLock> => {
  const result = decodeVersionedJson(value, {
    currentVersion: 2,
    legacyVersions: [1],
    readVersion: (candidate) => recordValue(candidate)?.schemaVersion,
    decode: environmentLockValue
  })
  // Both contracts remain supported; v1 is not migrated or rewritten.
  return result.status === 'legacy' ? { ...result, status: 'valid', version: 1 } : result
}

const parseNotebookEnvironmentLock = (value: string): NotebookEnvironmentLock => {
  const decoded = decodeNotebookEnvironmentLock(value)
  if (decoded.status === 'unsupported') {
    throw new Error('Notebook Environment lock version is not supported.')
  }
  if (decoded.status === 'corrupt') throw new Error('Notebook Environment lock schema is invalid.')
  return decoded.value
}

const packageIsCoveredByConda = (
  pkg: NotebookEnvironmentPackage,
  condaPackages: Map<string, string | undefined>
): boolean => {
  // Kernel observations name import roots (including stdlib and local modules), not installable
  // distributions. The completed interpreter inventory carries every package identity that needs
  // lock coverage, so module-only observations do not represent extra package-manager state.
  if (
    pkg.ecosystem === 'python' &&
    pkg.evidenceSources.length > 0 &&
    pkg.evidenceSources.every((source) => source === 'python-kernel-modules')
  ) {
    return true
  }
  if (pkg.ecosystem === 'r' && (pkg.libraryScope === 'user' || pkg.libraryScope === 'system')) {
    return false
  }
  if (pkg.source && (pkg.ecosystem !== 'r' || pkg.source.type !== 'bioconductor')) return false
  const name = normalizedPackageName(pkg.name)
  const covered = (candidate: string): boolean => {
    if (!condaPackages.has(candidate)) return false
    const condaVersion = condaPackages.get(candidate)
    return (
      !pkg.version ||
      !condaVersion ||
      packageVersionsMatch(pkg.ecosystem, pkg.version, condaVersion)
    )
  }
  if (pkg.ecosystem === 'python') return covered(name) || covered(`${name}-base`)
  if (pkg.ecosystem === 'r') {
    // Bioconda retains upstream Bioconductor metadata. Origin alone does not mean a native
    // install: preserve coverage by the matching exact Conda package in the bound library.
    if (pkg.source?.type === 'bioconductor') {
      const candidate = `bioconductor-${name}`
      return (
        pkg.libraryScope === 'environment' &&
        pkg.versionStatus === 'known' &&
        Boolean(pkg.version) &&
        Boolean(condaPackages.get(candidate)) &&
        covered(candidate)
      )
    }
    // Recommended packages are installed separately and may be upgraded or shadowed. Only
    // actual base packages belong to r-base, after source and library-scope checks above.
    if (pkg.priority === 'base') return covered('r-base')
    return covered(`r-${name}`) || covered(`bioconductor-${name}`) || covered(name)
  }
  return covered(name)
}

const nonCondaInstallers = (manifest: NotebookEnvironmentManifest): NotebookPackageInstaller[] => {
  const installers = (manifest.operationLog ?? []).flatMap((operation) =>
    operation.attempts.flatMap((attempt) =>
      attempt.status === 'succeeded' && attempt.installer !== 'conda' ? [attempt.installer] : []
    )
  )
  return [...new Set(installers)].sort()
}

const inside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`)

const errorCode = (error: unknown): string | undefined => {
  const value = recordValue(error)
  return typeof value?.code === 'string' ? value.code : undefined
}

type NativeFileCapture =
  | { state: 'missing' }
  | { state: 'rejected' }
  | { state: 'captured'; file: NotebookEnvironmentLockFile }

const readNativeLockFile = async (
  sessionRoot: string,
  searchRoot: string,
  filename: string
): Promise<NativeFileCapture> => {
  const logicalSessionRoot = resolve(sessionRoot)
  const logicalSearchRoot = resolve(searchRoot)
  if (!inside(logicalSessionRoot, logicalSearchRoot)) return { state: 'rejected' }
  const candidate = join(logicalSearchRoot, filename)
  try {
    const metadata = await lstat(candidate)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_NATIVE_LOCK_FILE_BYTES
    ) {
      return { state: 'rejected' }
    }
    const [physicalSessionRoot, physicalCandidate] = await Promise.all([
      realpath(logicalSessionRoot),
      realpath(candidate)
    ])
    if (!inside(physicalSessionRoot, physicalCandidate)) return { state: 'rejected' }
    const bytes = await readFile(candidate)
    if (bytes.length > MAX_NATIVE_LOCK_FILE_BYTES) return { state: 'rejected' }
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (!Buffer.from(content, 'utf8').equals(bytes) || !nativeLockContentIsSafe(content)) {
      return { state: 'rejected' }
    }
    const path = relative(logicalSessionRoot, candidate).split(sep).join('/')
    if (!portableLockPath(path)) return { state: 'rejected' }
    return { state: 'captured', file: { path, checksum: sha256(content), content } }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'rejected' }
  }
}

const nativeComponentResolution = (
  spec: NativeLockSpec,
  files: readonly NotebookEnvironmentLockFile[]
): 'locked' | 'best-effort' => {
  if (spec.format === 'pip-requirements') {
    return requirementsAreLocked(files[0]!.content) ? 'locked' : 'best-effort'
  }
  if (spec.format === 'uv-lock' || spec.format === 'poetry-lock') {
    return hasCompanionBesidePrimary(files, spec.primary, 'pyproject.toml')
      ? 'locked'
      : 'best-effort'
  }
  return 'locked'
}

const discoverNativeLockComponents = async (
  language: 'python' | 'r',
  workspace: EnvironmentLockWorkspace | undefined
): Promise<{ components: NativeLockComponent[]; rejected: boolean }> => {
  if (!workspace) return { components: [], rejected: false }
  const components: NativeLockComponent[] = []
  let rejected = false
  const sessionRoot = resolve(workspace.sessionRoot)
  const roots: string[] = []
  for (const requestedRoot of workspace.searchRoots) {
    let root = resolve(requestedRoot)
    if (!inside(sessionRoot, root)) {
      rejected = true
      continue
    }
    while (inside(sessionRoot, root)) {
      if (!roots.includes(root)) roots.push(root)
      if (root === sessionRoot) break
      root = resolve(root, '..')
    }
  }
  for (const spec of NATIVE_LOCK_SPECS[language]) {
    if (components.some((component) => component.format === spec.format)) continue
    for (const root of roots) {
      const primary = await readNativeLockFile(workspace.sessionRoot, root, spec.primary)
      if (primary.state === 'missing') continue
      if (primary.state === 'rejected') {
        rejected = true
        break
      }
      const files = [primary.file]
      let componentRejected = false
      for (const companion of spec.companions ?? []) {
        const captured = await readNativeLockFile(workspace.sessionRoot, root, companion)
        if (captured.state === 'rejected') componentRejected = true
        if (captured.state === 'captured') files.push(captured.file)
      }
      if (componentRejected) rejected = true
      else {
        const component = {
          ecosystem: spec.ecosystem,
          format: spec.format,
          resolution: nativeComponentResolution(spec, files),
          files
        } as NativeLockComponent
        if (nativeComponentValue(component)) components.push(component)
        else rejected = true
      }
      break
    }
  }
  return { components, rejected }
}

// Use the installed renv reader, rather than inventing repository/commit identity from versions.
// The native writer uses only R's temporary directory; no project or environment files change.
const snapshotRNativeLock = async (
  prefix: string,
  manifest: NotebookEnvironmentManifest,
  conda: CondaEnvironmentSnapshot,
  execute: EnvironmentLockExec
): Promise<NativeLockComponent | undefined> => {
  const requested = manifest.packages.filter(
    (pkg) =>
      pkg.ecosystem === 'r' &&
      pkg.libraryScope === 'environment' &&
      pkg.loadedState !== 'installed-only' &&
      !packageIsCoveredByConda(pkg, conda.packages)
  )
  if (!requested.length || !manifest.runtimeVersion) return undefined
  // Never ask renv to infer today's release or bootstrap BiocManager while capturing evidence.
  const bioconductorVersions = new Set(
    manifest.packages.flatMap((pkg) =>
      pkg.source?.type === 'bioconductor' ? [pkg.source.version] : []
    )
  )
  if (
    bioconductorVersions.size > 1 ||
    [...bioconductorVersions].some((version) => !version || !/^\d+\.\d+$/u.test(version))
  )
    return undefined
  const bioconductorVersion = [...bioconductorVersions][0]
  const library = JSON.stringify(rLibraryDir(prefix))
  const packages = requested.map((pkg) => JSON.stringify(pkg.name)).join(',')
  // Returning the snapshot first avoids renv's online/latest-package validation. The captured
  // inventory and nativeLockRestoreState below validate our version/source/coverage contract.
  const script = `local({
    Sys.setenv(RENV_PATHS_ROOT=file.path(tempdir(), "renv"),
      RENV_PATHS_CACHE=file.path(tempdir(), "renv-cache"),
      RENV_CONFIG_CACHE_ENABLED="FALSE", RENV_CONFIG_AUTO_SNAPSHOT="FALSE",
      RENV_CONFIG_USER_PROFILE="FALSE");
    .libPaths(${library});
    options(renv.bioconductor.version=${bioconductorVersion ? JSON.stringify(bioconductorVersion) : 'NA_character_'});
    loadNamespace("renv", lib.loc=${library});
    path <- file.path(tempdir(), "renv.lock");
    invisible(capture.output(lock <- renv::snapshot(project=tempdir(), library=${library},
      lockfile=NULL, packages=c(${packages}), prompt=FALSE)));
    invisible(capture.output(renv::lockfile_write(lock, file=path)));
    size <- file.info(path)$size;
    if (is.na(size) || size > ${MAX_NATIVE_LOCK_FILE_BYTES}) stop("R lock snapshot exceeds the capture budget");
    cat(readChar(path, size, useBytes=TRUE))
  })`
  try {
    const raw = await execute([rScriptBin(prefix), '--vanilla', '-e', script])
    if (Buffer.byteLength(raw) > MAX_NATIVE_LOCK_FILE_BYTES) return undefined
    const snapshot = recordValue(JSON.parse(raw))
    const records = recordValue(snapshot?.Packages)
    if (!snapshot || !records || recordValue(snapshot.R)?.Version !== manifest.runtimeVersion)
      return undefined
    // Conda already restores its packages and tools. Keep only the native portion of the
    // recursive dependency snapshot; do not reinstall Conda's builds from CRAN.
    for (const [name, record] of Object.entries(records)) {
      const observed = manifest.packages.find((pkg) => pkg.ecosystem === 'r' && pkg.name === name)
      const version = recordValue(record)?.Version
      if (
        observed &&
        observed.version &&
        typeof version === 'string' &&
        packageVersionsMatch('r', version, observed.version) &&
        packageIsCoveredByConda(observed, conda.packages)
      )
        delete records[name]
    }
    const content = `${JSON.stringify(snapshot)}\n`
    const component: NativeLockComponent = {
      ecosystem: 'r',
      format: 'renv-lock',
      resolution: 'locked',
      files: [{ path: 'r/renv.lock', content, checksum: sha256(content) }]
    }
    return nativeComponentValue(component) ? component : undefined
  } catch {
    // A failed snapshot leaves the Conda baseline usable and native dependencies unresolved.
    return undefined
  }
}

const condaHistoryChecksum = async (condaPrefix: string): Promise<string | undefined> => {
  const history = join(condaPrefix, 'conda-meta', 'history')
  try {
    const metadata = await lstat(history)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_NATIVE_LOCK_FILE_BYTES
    ) {
      return undefined
    }
    const content = await readFile(history)
    return content.length <= MAX_NATIVE_LOCK_FILE_BYTES ? sha256(content) : undefined
  } catch {
    return undefined
  }
}

const manifestRevision = (manifest: NotebookEnvironmentManifest): unknown => ({
  runtimeVersion: manifest.runtimeVersion,
  platform: manifest.platform,
  architecture: manifest.architecture,
  complete: manifest.complete,
  captureStatus: manifest.captureStatus,
  packages: manifest.packages
    .map((pkg) => ({
      ecosystem: pkg.ecosystem,
      name: normalizedPackageName(pkg.name),
      version: pkg.version,
      versionStatus: pkg.versionStatus,
      loadedState: pkg.loadedState,
      evidenceSources: pkg.evidenceSources,
      priority: pkg.priority,
      libraryScope: pkg.libraryScope,
      source: pkg.source
    }))
    .sort((left, right) =>
      `${left.ecosystem}:${left.name}`.localeCompare(`${right.ecosystem}:${right.name}`)
    ),
  nonCondaInstallers: nonCondaInstallers(manifest)
})

const nativeRevision = (
  native: Awaited<ReturnType<typeof discoverNativeLockComponents>>
): unknown => ({
  rejected: native.rejected,
  components: native.components.map((component) => ({
    ecosystem: component.ecosystem,
    format: component.format,
    resolution: component.resolution,
    files: component.files.map((file) => ({ path: file.path, checksum: file.checksum }))
  }))
})

const assessEnvironmentLock = (
  lock: NotebookEnvironmentLock,
  manifest: NotebookEnvironmentManifest,
  nativeRejected: boolean,
  pipPackages: CondaEnvironmentSnapshot['pipPackages']
): {
  captureStatus: 'complete' | 'partial'
  partialReasons?: NotebookEnvironmentLockPartialReason[]
  diagnostics?: Extract<
    NotebookRunEnvironmentLockCapture,
    { state: 'partial' | 'available' }
  >['diagnostics']
} => {
  const nativeState = nativeLockRestoreState(lock, manifest.packages)
  const omitted = new Set(lock.omittedPackages ?? [])
  const unresolvedNative =
    nativeState.state === 'unsupported' ||
    pipPackages.some(
      (installed) =>
        !omitted.has(`python:${installed.name}`) &&
        !manifest.packages.some(
          (observed) =>
            observed.ecosystem === 'python' &&
            normalizedPackageName(observed.name) === installed.name &&
            observed.versionStatus === 'known' &&
            observed.version !== undefined &&
            packageVersionsMatch('python', observed.version, installed.version)
        )
    )
  const partialReasons: NotebookEnvironmentLockPartialReason[] = [
    ...(manifest.captureStatus === 'partial' ? (['environment-manifest-partial'] as const) : []),
    ...(unresolvedNative && lock.untrackedPackages?.length
      ? (['non-conda-package-detected'] as const)
      : []),
    ...(unresolvedNative && lock.nonCondaInstallers?.length
      ? (['non-conda-installer-detected'] as const)
      : []),
    // Auxiliary files are evidence, not necessarily part of the selected restore plan.
    // An unused project lock must not downgrade a fully covered Conda/native environment.
    ...(unresolvedNative &&
    lock.components.some(
      (component) => component.ecosystem !== 'conda' && component.resolution === 'best-effort'
    )
      ? (['native-lock-file-best-effort'] as const)
      : []),
    ...(unresolvedNative && nativeRejected ? (['native-lock-file-rejected'] as const) : [])
  ]
  return {
    captureStatus: partialReasons.length > 0 ? 'partial' : 'complete',
    ...(partialReasons.length > 0 ? { partialReasons } : {}),
    ...(partialReasons.length > 0 && nativeState.state === 'unsupported' && nativeState.diagnostics
      ? {
          diagnostics: nativeState.diagnostics.map((diagnostic) => ({
            reason: diagnostic.reason,
            ...(diagnostic.packageName
              ? { packageName: diagnostic.packageName.slice(0, 200) }
              : {}),
            ...(diagnostic.observedVersion
              ? { observedVersion: diagnostic.observedVersion.slice(0, 200) }
              : {}),
            ...(diagnostic.lockedVersion
              ? { lockedVersion: diagnostic.lockedVersion.slice(0, 200) }
              : {})
          }))
        }
      : {})
  }
}

class EnvironmentLockCaptureOwner {
  private readonly cache = new Map<string, EnvironmentLockCacheEntry>()

  private async captureExternal(
    target: EnvironmentLockTarget,
    manifest: NotebookEnvironmentManifest,
    options: CaptureNotebookEnvironmentLockOptions
  ): Promise<EnvironmentLockCaptureResult> {
    const unavailable = { state: 'unavailable', reason: 'environment-not-managed' } as const
    if (
      !target.command ||
      !manifest.runtimeVersion ||
      !manifest.complete ||
      manifest.captureStatus !== 'complete'
    )
      return unavailable
    try {
      const native = await discoverNativeLockComponents(target.language, options.workspace)
      if (native.rejected) return unavailable
      const observed = manifest.packages.filter((pkg) => pkg.priority !== 'base')
      const requested = observed.filter((pkg) => pkg.loadedState !== 'installed-only')
      if (!requested.length) return unavailable
      const version = (
        await options.execute([
          target.command,
          ...(target.args ?? []),
          ...(target.language === 'r'
            ? ['--slave', '-e', 'cat(as.character(utils::packageVersion("renv")))']
            : ['-c', 'import importlib.metadata; print(importlib.metadata.version("pip"))'])
        ])
      ).trim()
      if (target.language === 'r' && native.components.length === 0) {
        const script = `local({
          Sys.setenv(RENV_CONFIG_CACHE_ENABLED="FALSE", RENV_CONFIG_AUTO_SNAPSHOT="FALSE",
            RENV_PATHS_ROOT=file.path(tempdir(), "renv"));
          invisible(capture.output(lock <- renv::snapshot(project=tempdir(), library=.libPaths(),
            lockfile=NULL, packages=c(${requested.map((pkg) => JSON.stringify(pkg.name)).join(',')}), prompt=FALSE)));
          cat(jsonlite::toJSON(lock, auto_unbox=TRUE))
        })`
        const content = await options.execute([
          target.command,
          ...(target.args ?? []),
          '--slave',
          '-e',
          script
        ])
        const component: NativeLockComponent = {
          ecosystem: 'r',
          format: 'renv-lock',
          resolution: 'locked',
          files: [{ path: 'r/renv.lock', content, checksum: sha256(content) }]
        }
        if (nativeComponentValue(component)) native.components.push(component)
      }
      const component = native.components.find(
        (entry) => entry.format === (target.language === 'r' ? 'renv-lock' : 'pip-requirements')
      )
      if (!component || component.resolution !== 'locked') return unavailable
      if (target.language === 'r') {
        const nativeLock = recordValue(JSON.parse(component.files[0]!.content))
        if (recordValue(nativeLock?.R)?.Version !== manifest.runtimeVersion) return unavailable
      }
      const lock: NotebookEnvironmentLock = {
        schemaVersion: 2,
        format: 'environment-lock-bundle',
        kernelKind: target.language,
        environmentName: target.environmentName,
        platform: manifest.platform,
        architecture: manifest.architecture,
        externalRuntime: { version: manifest.runtimeVersion, installerVersion: version },
        components: [component],
        untrackedPackages: [
          ...new Set(requested.map((pkg) => `${pkg.ecosystem}:${normalizedPackageName(pkg.name)}`))
        ]
      }
      if (!environmentLockValue(lock) || nativeLockRestoreState(lock, observed).state !== 'ready')
        return unavailable
      return {
        state: 'captured',
        lock,
        captureStatus: 'partial',
        partialReasons: ['external-interpreter-required']
      }
    } catch {
      return unavailable
    }
  }

  async capture(
    target: EnvironmentLockTarget,
    manifest: NotebookEnvironmentManifest,
    options: CaptureNotebookEnvironmentLockOptions
  ): Promise<EnvironmentLockCaptureResult> {
    if (target.runtimeSource !== 'managed') {
      return this.captureExternal(target, manifest, options)
    }
    if (!target.condaPrefix) {
      return { state: 'unavailable', reason: 'conda-prefix-unavailable' }
    }
    if (!options.micromamba) {
      return { state: 'unavailable', reason: 'micromamba-unavailable' }
    }
    let stage = 'discovering-lock-evidence'
    try {
      const [historyChecksum, native, pip] = await Promise.all([
        condaHistoryChecksum(target.condaPrefix),
        discoverNativeLockComponents(target.language, options.workspace),
        target.language === 'python' ? capturePipInstallEvidence(target.condaPrefix) : undefined
      ])
      if (
        pip &&
        !native.components.some(
          (component) =>
            component.format === 'pip-requirements' && component.resolution === 'locked'
        )
      ) {
        native.components = native.components.filter(
          (component) => component.format !== 'pip-requirements'
        )
        native.components.push(pip)
      }
      const cacheKey = JSON.stringify([target.language, target.environmentName, target.condaPrefix])
      const revision =
        options.environmentFingerprint && historyChecksum
          ? sha256(
              JSON.stringify({
                environmentFingerprint: options.environmentFingerprint,
                historyChecksum,
                manifest: manifestRevision(manifest),
                native: nativeRevision(native)
              })
            )
          : undefined
      const cached = revision ? this.cache.get(cacheKey) : undefined
      if (
        cached &&
        cached.revision === revision &&
        (!cached.retryAfter || Date.now() < cached.retryAfter)
      ) {
        return {
          state: 'captured',
          lock: cached.lock,
          ...assessEnvironmentLock(cached.lock, manifest, native.rejected, cached.pipPackages)
        }
      }

      stage = 'reading-conda-inventory'
      const inventoryRaw = await options.execute([
        options.micromamba,
        '--no-rc',
        'list',
        '--prefix',
        target.condaPrefix,
        '--json'
      ])
      stage = 'validating-conda-inventory'
      const conda = parseCondaEnvironmentSnapshot(inventoryRaw)
      let recoveryAttempted = false
      if (
        target.language === 'r' &&
        !native.rejected &&
        native.components.length === 0 &&
        conda.packages.has('r-renv')
      ) {
        stage = 'snapshotting-r-lock'
        recoveryAttempted = true
        const snapshot = await snapshotRNativeLock(
          target.condaPrefix,
          manifest,
          conda,
          options.execute
        )
        if (snapshot) native.components.push(snapshot)
      }
      const untrackedPackages = [
        ...new Set([
          ...manifest.packages
            .filter((pkg) => !packageIsCoveredByConda(pkg, conda.packages))
            .map((pkg) => `${pkg.ecosystem}:${normalizedPackageName(pkg.name)}`),
          ...conda.pipPackages.map((pkg) => `python:${pkg.name}`)
        ])
      ].sort()
      // Keep the full installed inventory, but do not require unrelated native packages for
      // replay. Only a complete kernel observation can attest that a distribution was not
      // loaded: the interpreter inventory alone (or an older kernel) cannot establish this.
      // Entries present in native lock files stay governed by those files, even when unused:
      // restore may install them, so exclusions must never conceal stale pins or source conflicts.
      const nativePackageIdentities = new Set(
        native.components.flatMap((component) =>
          [...lockedPackageVersions(component).keys()].map(
            (name) => `${component.ecosystem}:${name}`
          )
        )
      )
      const omittedPackages =
        manifest.complete && manifest.captureStatus === 'complete'
          ? untrackedPackages.filter((identity) => {
              if (nativePackageIdentities.has(identity)) return false
              const observations = manifest.packages.filter(
                (pkg) => `${pkg.ecosystem}:${normalizedPackageName(pkg.name)}` === identity
              )
              return (
                observations.length > 0 &&
                observations.every(
                  (pkg) =>
                    pkg.ecosystem === target.language &&
                    pkg.loadedState === 'installed-only' &&
                    pkg.evidenceSources.includes(
                      pkg.ecosystem === 'python' ? 'python-kernel-modules' : 'r-session-info'
                    )
                )
              )
            })
          : []
      const requiredPackages = untrackedPackages.filter(
        (identity) => !omittedPackages.includes(identity)
      )
      // Older managed pip installs have no installation report. Recover only the required
      // public wheels, by comparing their complete payload with the installed files. Never
      // replace a project-supplied native lock or infer a lock from version numbers alone.
      if (
        target.language === 'python' &&
        target.runtimeSource === 'managed' &&
        native.components.every((component) => component === pip)
      ) {
        const missing = requiredPackages.filter(
          (identity) => !nativePackageIdentities.has(identity)
        )
        recoveryAttempted = missing.length > 0
        stage = 'recovering-pip-evidence'
        const recovered = missing.length
          ? await recoverPipInstallEvidence(target.condaPrefix, missing, options.execute)
          : undefined
        if (recovered) native.components = [recovered]
      }
      const installers = nonCondaInstallers(manifest)
      const lock: NotebookEnvironmentLock = {
        schemaVersion: 1,
        format: 'environment-lock-bundle',
        kernelKind: target.language,
        environmentName: target.environmentName,
        ...(manifest.platform ? { platform: manifest.platform } : {}),
        ...(manifest.architecture ? { architecture: manifest.architecture } : {}),
        components: [
          {
            ecosystem: 'conda',
            format: 'conda-explicit-md5',
            resolution: 'locked',
            explicitLock: conda.explicitLock,
            packages: [...conda.packages.keys()].sort()
          },
          ...native.components
        ],
        ...(requiredPackages.length > 0 ? { untrackedPackages: requiredPackages } : {}),
        ...(omittedPackages.length > 0 ? { omittedPackages } : {}),
        ...(installers.length > 0 ? { nonCondaInstallers: installers } : {})
      }
      stage = 'assessing-lock-coverage'
      const assessment = assessEnvironmentLock(lock, manifest, native.rejected, conda.pipPackages)
      if (revision)
        this.cache.set(cacheKey, {
          revision,
          lock,
          pipPackages: conda.pipPackages,
          // A transient lookup failure must not freeze a partial lock for the app's lifetime.
          ...(recoveryAttempted && assessment.captureStatus === 'partial'
            ? { retryAfter: Date.now() + 60_000 }
            : {})
        })
      return {
        state: 'captured',
        lock,
        ...assessment
      }
    } catch (error) {
      try {
        createLogger('notebook:environment-lock').warn('environment lock capture failed', {
          language: target.language,
          stage,
          ...diagnosticErrorFields(error)
        })
      } catch {
        // Diagnostic failures must not turn best-effort capture into an execution failure.
      }
      return {
        state: 'unavailable',
        reason:
          error instanceof InvalidEnvironmentLockError
            ? 'environment-lock-invalid'
            : 'environment-lock-capture-failed'
      }
    }
  }
}

const captureNotebookEnvironmentLock = (
  target: EnvironmentLockTarget,
  manifest: NotebookEnvironmentManifest,
  options: CaptureNotebookEnvironmentLockOptions
): Promise<EnvironmentLockCaptureResult> =>
  new EnvironmentLockCaptureOwner().capture(target, manifest, options)

export {
  captureNotebookEnvironmentLock,
  decodeNotebookEnvironmentLock,
  EnvironmentLockCaptureOwner,
  parseCondaPackageNames,
  parseNotebookEnvironmentLock,
  validateExplicitLock
}
export type {
  CaptureNotebookEnvironmentLockOptions,
  EnvironmentLockCaptureResult,
  EnvironmentLockExec,
  EnvironmentLockTarget,
  EnvironmentLockWorkspace
}

import { packageVersionsMatch } from './package-version-comparison'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type {
  NotebookEnvironmentLock,
  NotebookEnvironmentLockComponent,
  NotebookEnvironmentLockDiagnostic,
  NotebookEnvironmentPackage
} from '../../shared/notebook'
import type { InstallSpawn } from './package-manager'
import { condaActivatedPath, pythonBin, rLibraryDir, rScriptBin } from './runtime-paths'
import { withPipInstallEvidence } from './pip-install-evidence'
import { PIP_TRANSPORT_ENV_KEYS } from './process-environment'

type NativeLockComponent = Extract<NotebookEnvironmentLockComponent, { ecosystem: 'python' | 'r' }>

type NativeLockRestorePlan = Readonly<{
  component: NativeLockComponent
  primaryFile: string
}>

type NativeLockRestoreState =
  | { state: 'not-needed' }
  | { state: 'ready'; plan: NativeLockRestorePlan }
  | { state: 'unsupported'; diagnostics?: NotebookEnvironmentLockDiagnostic[] }

type RestoreNativeEnvironmentLockInput = Readonly<{
  lock: NotebookEnvironmentLock
  prefix: string
  locksRoot: string
  spawn: InstallSpawn
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  onBeforeSpawn?: () => void
  onChild?: (pid: number) => void
  onOutput?: (output: { stream: 'stdout' | 'stderr'; text: string }) => void
  signal?: AbortSignal
}>

const normalizePackageName = (value: string): string =>
  value
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('und')
    .replace(/[-_.]+/gu, '-')

const primaryFilename = (component: NativeLockComponent): string => {
  switch (component.format) {
    case 'uv-lock':
      return 'uv.lock'
    case 'poetry-lock':
      return 'poetry.lock'
    case 'pip-requirements':
      return component.files.some((file) => basename(file.path) === 'requirements.lock')
        ? 'requirements.lock'
        : 'requirements.txt'
    case 'renv-lock':
      return 'renv.lock'
    case 'pak-lock':
      return 'pkg.lock'
  }
}

const lockedPackageVersions = (
  component: NativeLockComponent
): Map<string, Set<string | undefined>> => {
  const packages = new Map<string, Set<string | undefined>>()
  const add = (name: string, version: unknown): void => {
    const normalized = normalizePackageName(name)
    const versions = packages.get(normalized) ?? new Set<string | undefined>()
    versions.add(typeof version === 'string' && version.length > 0 ? version : undefined)
    packages.set(normalized, versions)
  }
  const primary = component.files.find(
    (file) => basename(file.path) === primaryFilename(component)
  )?.content
  if (!primary) return packages
  if (component.format === 'uv-lock' || component.format === 'poetry-lock') {
    for (const block of primary.split(/^\s*\[\[package\]\]\s*(?:#.*)?$/mu).slice(1)) {
      // Only the package's own fields count; dependency/source sub-tables have other versions.
      const fields = block.split(/^\s*\[/mu)[0]!
      const name = /^\s*name\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/mu.exec(fields)?.[1]
      const version = /^\s*version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/mu.exec(fields)?.[1]
      if (name) add(name, version)
    }
    return packages
  }
  if (component.format === 'pip-requirements') {
    const lines = primary
      .replace(/\\\r?\n/gu, ' ')
      .split(/\r?\n/gu)
      .map((line) => line.replace(/(?:^|\s+)#.*$/u, '').trim())
    // A platform/extra marker is not proof that pip will install the captured distribution.
    // Such files remain best-effort until a platform-resolved lock is available.
    if (lines.some((line) => line.includes(';'))) return packages
    for (const line of lines) {
      const match = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?==([^\s;]+)?/u.exec(line)
      if (match) add(match[1]!, match[2])
    }
    return packages
  }
  try {
    const parsed = JSON.parse(primary) as Record<string, unknown>
    if (component.format === 'renv-lock') {
      const entries = parsed.Packages
      if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        for (const [name, entry] of Object.entries(entries)) {
          add(name, entry && typeof entry === 'object' ? entry.Version : undefined)
        }
      }
      return packages
    }
    if (Array.isArray(parsed.packages)) {
      for (const entry of parsed.packages) {
        if (entry && typeof entry === 'object' && typeof entry.package === 'string') {
          add(entry.package, entry.version)
        }
      }
    }
    return packages
  } catch {
    return new Map()
  }
}

const requiredTool = (component: NativeLockComponent): string => {
  switch (component.format) {
    case 'uv-lock':
      return 'uv'
    case 'poetry-lock':
      return 'poetry'
    case 'pip-requirements':
      return 'pip'
    case 'renv-lock':
      return 'r-renv'
    case 'pak-lock':
      return 'r-pak'
  }
}

// Preserve repository-relative path case. Do not canonicalize traversal, absolute paths or
// dot segments: renv consumes the original lock payload when locating the package archive.
const githubSubdirectory = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.includes('\\') || /^[A-Za-z]:/u.test(value))
    return undefined
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
    ? value
    : undefined
}

const lockedSourcesMatch = (
  component: NativeLockComponent,
  observed?: readonly NotebookEnvironmentPackage[]
): boolean => {
  if (component.ecosystem !== 'r') {
    // The other readers currently establish versions, not remote source identity.
    return observed?.every((pkg) => !pkg.source) ?? true
  }
  const content = component.files.find(
    (file) => basename(file.path) === primaryFilename(component)
  )?.content
  try {
    const lock = JSON.parse(content ?? '') as {
      Packages: Record<string, Record<string, unknown>>
      packages: Array<Record<string, unknown> & { package: string }>
      Bioconductor?: { Version?: string }
    }
    const entries =
      component.format === 'renv-lock'
        ? Object.entries(lock.Packages)
        : lock.packages.map((entry) => [entry.package, entry] as const)
    const records = new Map<string, Record<string, unknown>>()
    const coverageNames = new Map<string, string>()
    for (const [name, entry] of entries) {
      if (
        typeof name !== 'string' ||
        !name ||
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry)
      )
        return false
      if (component.format === 'renv-lock' && entry.Package !== undefined && entry.Package !== name)
        return false
      // Older bundles use Python-style canonical coverage tokens for R too. Preserve those
      // tokens, but never use them to equate distinct R package names or select a source.
      const coverageName = normalizePackageName(name)
      const previous = coverageNames.get(coverageName)
      if (previous !== undefined && previous !== name) return false
      coverageNames.set(coverageName, name)
      records.set(name, entry)
    }
    if (observed?.some((pkg) => !records.has(pkg.name))) return false
    if (component.format !== 'renv-lock') return observed?.every((pkg) => !pkg.source) ?? true
    // Restore/import has no capture-time inventory. Still require an immutable remote target.
    const pinned = [...records.values()].every((entry) => {
      if (entry.Source === 'GitHub') {
        return (
          entry.RemoteType === 'github' &&
          (entry.RemoteHost === 'api.github.com' || entry.RemoteHost === 'github.com') &&
          typeof entry.RemoteUsername === 'string' &&
          entry.RemoteUsername.length > 0 &&
          typeof entry.RemoteRepo === 'string' &&
          entry.RemoteRepo.length > 0 &&
          typeof entry.RemoteSha === 'string' &&
          /^[a-f0-9]{40}$/iu.test(entry.RemoteSha) &&
          githubSubdirectory(entry.RemoteSubdir) !== undefined &&
          // Old GithubSubdir metadata must not silently select a different location.
          (!entry.GithubSubdir || entry.GithubSubdir === entry.RemoteSubdir)
        )
      }
      if (entry.Source === 'Bioconductor') {
        return !entry.RemoteType && /^\d+\.\d+$/u.test(lock.Bioconductor?.Version ?? '')
      }
      return !entry.RemoteType && (entry.Source === undefined || entry.Source === 'Repository')
    })
    if (!pinned) return false
    return (
      observed?.every((pkg) => {
        const entry = records.get(pkg.name)
        if (!entry) return false
        if (pkg.source?.type === 'github') {
          return (
            entry.Source === 'GitHub' &&
            entry.RemoteType === 'github' &&
            (entry.RemoteHost === 'api.github.com' || entry.RemoteHost === 'github.com') &&
            typeof entry.RemoteUsername === 'string' &&
            typeof entry.RemoteRepo === 'string' &&
            `${entry.RemoteUsername}/${entry.RemoteRepo}`.toLowerCase() ===
              pkg.source.repository.toLowerCase() &&
            typeof entry.RemoteSha === 'string' &&
            /^[a-f0-9]{40}$/iu.test(entry.RemoteSha) &&
            entry.RemoteSha.toLowerCase() === pkg.source.commit?.toLowerCase() &&
            githubSubdirectory(entry.RemoteSubdir) === githubSubdirectory(pkg.source.subdirectory)
          )
        }
        if (pkg.source?.type === 'bioconductor') {
          return (
            entry.Source === 'Bioconductor' &&
            !entry.RemoteType &&
            Boolean(pkg.source.version) &&
            lock.Bioconductor?.Version === pkg.source.version
          )
        }
        // A remote lock cannot prove equivalence to a package with no observed remote identity.
        return !entry.RemoteType && (entry.Source === undefined || entry.Source === 'Repository')
      }) ?? true
    )
  } catch {
    return false
  }
}

const nativeLockRestoreState = (
  lock: NotebookEnvironmentLock,
  observedPackages?: readonly NotebookEnvironmentPackage[]
): NativeLockRestoreState => {
  const required = (lock.untrackedPackages ?? []).map((identity) => {
    const separator = identity.indexOf(':')
    return separator > 0
      ? {
          ecosystem: identity.slice(0, separator),
          name: normalizePackageName(identity.slice(separator + 1))
        }
      : undefined
  })
  if (required.length === 0) return { state: 'not-needed' }
  if (required.some((pkg) => !pkg || pkg.ecosystem !== lock.kernelKind || pkg.name.length === 0)) {
    return { state: 'unsupported' }
  }
  const conda = lock.components.find((component) => component.ecosystem === 'conda')
  const condaPackages = new Set(conda?.packages.map(normalizePackageName) ?? [])
  let projectSelectionUnresolved = false
  for (const component of lock.components) {
    if (component.ecosystem === 'conda' || component.resolution !== 'locked') continue
    if (!condaPackages.has(requiredTool(component))) continue
    const packages = lockedPackageVersions(component)
    if (required.every((pkg) => packages.has(pkg!.name))) {
      // Project locks describe possible installations, including extras and platform branches.
      // Without the captured selection, the default sync/install command can silently omit a
      // required package. Keep this explicit until the selection is part of the lock contract.
      if (
        (component.format === 'uv-lock' || component.format === 'poetry-lock') &&
        component.files.some(
          (file) =>
            /^\s*\[(?:project\.optional-dependencies|dependency-groups|tool\.poetry\.(?:extras|group(?:\.|\])))/mu.test(
              file.content
            ) ||
            /\b(?:markers?|resolution-markers)\s*=/mu.test(file.content) ||
            /^\s*optional\s*=\s*true\b/mu.test(file.content)
        )
      ) {
        projectSelectionUnresolved = true
        continue
      }
      const unresolvedVersions = [...packages.entries()].filter(
        ([, versions]) => versions.size !== 1 || versions.has(undefined)
      )
      if (unresolvedVersions.length > 0)
        return {
          state: 'unsupported',
          diagnostics: unresolvedVersions.slice(0, 20).map(([packageName]) => ({
            reason: 'package-version-unresolved',
            packageName
          }))
        }
      if (!lockedSourcesMatch(component))
        return {
          state: 'unsupported',
          diagnostics: [{ reason: 'source-unpinned' }]
        }
      if (observedPackages) {
        // Native installers may also replace packages supplied by the Conda baseline.
        const observed = observedPackages.filter(
          (pkg) => pkg.ecosystem === lock.kernelKind && packages.has(normalizePackageName(pkg.name))
        )
        const missing = required.some(
          (pkg) => !observed.some((candidate) => normalizePackageName(candidate.name) === pkg!.name)
        )
        // These installers restore every listed package. An extra entry would change the
        // captured inventory. Project locks can also list an uninstalled root or optional groups.
        const installsEveryPackage =
          component.format === 'pip-requirements' ||
          component.format === 'renv-lock' ||
          component.format === 'pak-lock'
        const unexpected =
          installsEveryPackage &&
          [...packages.keys()].some(
            (name) => !observed.some((pkg) => normalizePackageName(pkg.name) === name)
          )
        const versionMatches = (
          pkg: NotebookEnvironmentPackage,
          versions: Set<string | undefined>
        ): boolean => {
          const observedVersion = pkg.version
          return (
            versions.size === 1 &&
            pkg.versionStatus === 'known' &&
            observedVersion !== undefined &&
            [...versions].some(
              (version) =>
                version !== undefined &&
                packageVersionsMatch(component.ecosystem, version, observedVersion)
            )
          )
        }
        const versionsMatch = observed.every((pkg) =>
          versionMatches(pkg, packages.get(normalizePackageName(pkg.name))!)
        )
        if (missing || unexpected || !versionsMatch || !lockedSourcesMatch(component, observed)) {
          // Restore will choose this same first component without the capture-time inventory.
          const diagnostics: NotebookEnvironmentLockDiagnostic[] = []
          for (const [packageName, versions] of packages) {
            const pkg = observed.find(
              (candidate) => normalizePackageName(candidate.name) === packageName
            )
            const lockedVersion = [...versions][0]
            if (!pkg && installsEveryPackage)
              diagnostics.push({
                reason: 'package-not-captured',
                packageName,
                lockedVersion
              })
            else if (pkg && !versionMatches(pkg, versions))
              diagnostics.push({
                reason: 'package-version-mismatch',
                packageName,
                ...(pkg.version ? { observedVersion: pkg.version } : {}),
                lockedVersion
              })
          }
          return {
            state: 'unsupported',
            diagnostics:
              diagnostics.length > 0
                ? diagnostics.slice(0, 20)
                : [{ reason: missing ? 'package-not-captured' : 'source-mismatch' }]
          }
        }
      }
      const primaryFile = component.files.find(
        (file) => basename(file.path) === primaryFilename(component)
      )?.path
      if (primaryFile) return { state: 'ready', plan: { component, primaryFile } }
    }
  }
  if (projectSelectionUnresolved)
    return {
      state: 'unsupported',
      diagnostics: [{ reason: 'project-selection-unresolved' }]
    }
  return {
    state: 'unsupported',
    diagnostics: required.slice(0, 20).map((pkg) => {
      const observed = observedPackages?.find(
        (candidate) =>
          candidate.ecosystem === pkg!.ecosystem &&
          normalizePackageName(candidate.name) === pkg!.name
      )
      return {
        reason: 'package-lock-missing',
        packageName: pkg!.name,
        ...(observed?.version ? { observedVersion: observed.version } : {})
      }
    })
  }
}

const executableInPrefix = (
  prefix: string,
  name: 'uv' | 'poetry',
  platform: NodeJS.Platform
): string => {
  if (platform !== 'win32') return join(prefix, 'bin', name)
  const candidates = [
    join(prefix, 'Library', 'bin', `${name}.exe`),
    join(prefix, 'Scripts', `${name}.exe`),
    join(prefix, `${name}.exe`)
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

const rString = (value: string): string => JSON.stringify(value)

// libraryExpression is a trusted R expression: either a quoted prefix path or R.home("library")
// in the portable export. Inspect the captured renv API rather than assuming the newest release.
const renvRestoreExpression = (lockfile: string, libraryExpression: string): string =>
  `local({ restore_args <- list(lockfile=${rString(lockfile)},library=${libraryExpression},prompt=FALSE); ` +
  'restore_formals <- names(formals(renv::restore)); ' +
  'if ("retry" %in% restore_formals) restore_args$retry <- FALSE; ' +
  'if ("strict" %in% restore_formals) restore_args$strict <- TRUE; ' +
  'do.call(renv::restore, restore_args) })'

const nativeCommand = (
  plan: NativeLockRestorePlan,
  prefix: string,
  primaryPath: string,
  platform: NodeJS.Platform,
  inheritedEnv: NodeJS.ProcessEnv = process.env
): { command: string; args: string[]; env: NodeJS.ProcessEnv } => {
  const python = pythonBin(prefix, platform)
  const library = rLibraryDir(prefix, platform)
  const inheritedPath =
    inheritedEnv.PATH ??
    (platform === 'win32'
      ? Object.entries(inheritedEnv).find(([key]) => key.toLowerCase() === 'path')?.[1]
      : undefined) ??
    process.env.PATH
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...inheritedEnv,
    PATH: condaActivatedPath(prefix, inheritedPath, platform),
    CONDA_PREFIX: prefix
  }
  // A captured lock must restore into this interpreter, independent of the app launcher's
  // Python/R configuration. Keep network and cache settings, not ambient pip install options.
  const runtimeOverrides = new Set([
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONUSERBASE',
    'PYTHONNOUSERSITE',
    'VIRTUAL_ENV',
    'R_HOME',
    'R_LIBS',
    'R_LIBS_USER',
    'R_LIBS_SITE',
    'R_ENVIRON',
    'R_ENVIRON_USER',
    'R_PROFILE',
    'R_PROFILE_USER'
  ])
  const pipTransportSettings = new Set<string>(PIP_TRANSPORT_ENV_KEYS)
  for (const key of Object.keys(env)) {
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    if (
      runtimeOverrides.has(normalized) ||
      (platform === 'win32' && normalized === 'PATH' && key !== 'PATH') ||
      (plan.component.format === 'pip-requirements' &&
        normalized.startsWith('PIP_') &&
        !pipTransportSettings.has(normalized))
    )
      delete env[key]
  }
  env.PYTHONNOUSERSITE = '1'
  switch (plan.component.format) {
    case 'pip-requirements':
      return {
        command: python,
        // Reinstall the captured wheels even if Conda supplies the same versions, and leave the
        // captured Conda baseline untouched by dependency resolution.
        args: [
          '-I',
          '-m',
          'pip',
          'install',
          '--require-hashes',
          '--force-reinstall',
          '--no-deps',
          '-r',
          primaryPath
        ],
        env: { ...env, PIP_CONFIG_FILE: platform === 'win32' ? 'nul' : '/dev/null' }
      }
    case 'uv-lock':
      return {
        command: executableInPrefix(prefix, 'uv', platform),
        args: ['sync', '--locked', '--inexact', '--no-install-project', '--python', python],
        env: { ...env, UV_PROJECT_ENVIRONMENT: prefix, UV_PYTHON_DOWNLOADS: 'never' }
      }
    case 'poetry-lock':
      return {
        command: executableInPrefix(prefix, 'poetry', platform),
        args: ['install', '--no-root', '--no-interaction'],
        env: { ...env, VIRTUAL_ENV: prefix, POETRY_VIRTUALENVS_CREATE: 'false' }
      }
    case 'renv-lock':
      return {
        command: rScriptBin(prefix, platform),
        args: ['--vanilla', '-e', renvRestoreExpression(primaryPath, rString(library))],
        env: { ...env, R_LIBS_USER: library, RENV_CONFIG_CACHE_ENABLED: 'FALSE' }
      }
    case 'pak-lock':
      return {
        command: rScriptBin(prefix, platform),
        args: [
          '--vanilla',
          '-e',
          `pak::lockfile_install(lockfile=${rString(primaryPath)},lib=${rString(library)})`
        ],
        env: { ...env, R_LIBS_USER: library }
      }
  }
}

const restoreNativeEnvironmentLock = async (
  input: RestoreNativeEnvironmentLockInput
): Promise<void> => {
  const state = nativeLockRestoreState(input.lock)
  if (state.state === 'not-needed') return
  if (state.state === 'unsupported') {
    throw new Error('Environment lock has no exact restorable native package component.')
  }
  const platform = input.platform ?? process.platform
  for (const file of state.plan.component.files) {
    const destination = join(input.locksRoot, ...file.path.split('/'))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, file.content, { encoding: 'utf8', mode: 0o600 })
  }
  const primaryPath = join(input.locksRoot, ...state.plan.primaryFile.split('/'))
  const invocation = nativeCommand(
    state.plan,
    input.prefix,
    primaryPath,
    platform,
    input.inheritedEnv
  )
  const restore = (reportPath?: string): ReturnType<InstallSpawn> =>
    input.spawn(
      invocation.command,
      invocation.args,
      { ...invocation.env, ...(reportPath ? { PIP_REPORT: reportPath } : {}) },
      input.onChild,
      input.onBeforeSpawn,
      false,
      dirname(primaryPath),
      { onOutput: input.onOutput, signal: input.signal }
    )
  const result =
    state.plan.component.format === 'pip-requirements'
      ? await withPipInstallEvidence(input.prefix, restore)
      : await restore()
  if (result.code !== 0) {
    throw new Error(
      `Native package restoration failed (${state.plan.component.format}): ${result.stderr || result.stdout}`
    )
  }
}

export {
  lockedPackageVersions,
  nativeLockRestoreState,
  renvRestoreExpression,
  restoreNativeEnvironmentLock
}
export type { NativeLockRestorePlan, NativeLockRestoreState, RestoreNativeEnvironmentLockInput }

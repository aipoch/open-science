import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { NotebookEnvironmentLock } from '../../shared/notebook'
import type { InstallSpawn } from './package-manager'
import { lockedPackageVersions, nativeLockRestoreState } from './native-lock-restoration'
import { pythonBin, rScriptBin } from './runtime-paths'
import { packageVersionsMatch } from './package-version-comparison'

const within = (root: string, path: string): boolean => {
  const pathFromRoot = relative(root, path)
  return (
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
}

// Only installation metadata is read. Bound each record, never traverse package contents or data.
const readMetadata = async (path: string): Promise<Record<string, unknown>> => {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error('Package metadata exceeds verification limits.')
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('Package metadata changed during verification.')
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as Record<string, unknown>
  } finally {
    await file.close()
  }
}

export const verifyRestoredEnvironment = async (input: {
  lock: NotebookEnvironmentLock
  prefix: string
  env: NodeJS.ProcessEnv
  spawn: InstallSpawn
  signal?: AbortSignal
  platform?: NodeJS.Platform
}): Promise<void> => {
  input.signal?.throwIfAborted()
  const root = await realpath(input.prefix)
  const conda = input.lock.components.find((component) => component.ecosystem === 'conda')
  if (!conda) throw new Error('Restored environment has no Conda baseline to verify.')
  const lines = conda.explicitLock.split(/\r?\n/u).filter((line) => /^https?:\/\//u.test(line))
  if (!lines.length || lines.length > 10000)
    throw new Error('Conda verification inventory is empty or exceeds its limit.')
  let runtimeVersion: string | undefined
  for (const line of lines) {
    input.signal?.throwIfAborted()
    const url = new URL(line)
    const archive = basename(url.pathname)
    const recordPath = join(
      input.prefix,
      'conda-meta',
      archive.replace(/\.(?:conda|tar\.bz2)$/u, '.json')
    )
    if (!within(root, await realpath(recordPath)))
      throw new Error('Conda metadata resolves outside the restored environment.')
    const record = await readMetadata(recordPath)
    const recordedUrl = typeof record.url === 'string' ? new URL(record.url) : undefined
    if (
      !recordedUrl ||
      recordedUrl.origin !== url.origin ||
      recordedUrl.pathname !== url.pathname ||
      typeof record.md5 !== 'string' ||
      record.md5.toLowerCase() !== url.hash.slice(1).toLowerCase() ||
      typeof record.name !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.build !== 'string' ||
      ![
        `${record.name}-${record.version}-${record.build}.conda`,
        `${record.name}-${record.version}-${record.build}.tar.bz2`
      ].includes(archive)
    )
      throw new Error(`Restored Conda package does not match its captured identity: ${archive}`)
    if (record.name === (input.lock.kernelKind === 'r' ? 'r-base' : 'python'))
      runtimeVersion = record.version
  }
  if (!runtimeVersion)
    throw new Error('Restored interpreter version is missing from the Conda inventory.')

  const native = nativeLockRestoreState(input.lock)
  if (native.state === 'unsupported') throw new Error('Native lock cannot be verified.')
  const versions =
    native.state === 'ready'
      ? lockedPackageVersions(native.plan.component)
      : new Map<string, Set<string | undefined>>()
  if (
    native.state === 'ready' &&
    ['uv-lock', 'poetry-lock'].includes(native.plan.component.format)
  ) {
    // Project roots are intentionally omitted by --no-install-project / --no-root. Check the
    // captured required distributions rather than requiring every possible project-lock entry.
    const required = new Set(
      (input.lock.untrackedPackages ?? []).map((identity) =>
        identity
          .slice(identity.indexOf(':') + 1)
          .normalize('NFC')
          .trim()
          .toLowerCase()
          .replace(/[-_.]+/gu, '-')
      )
    )
    for (const name of versions.keys()) if (!required.has(name)) versions.delete(name)
  }
  const names = [...versions.keys()]
  // R package names are case-sensitive; preserve the names from native lock records.
  const rRecords: Record<string, { Version?: string; RemoteSha?: string }> = {}
  if (native.state === 'ready' && input.lock.kernelKind === 'r') {
    const file = native.plan.component.files.find(
      (file) =>
        basename(file.path) === native.plan.primaryFile || file.path === native.plan.primaryFile
    )!
    const parsed = JSON.parse(file.content)
    if (native.plan.component.format === 'renv-lock') Object.assign(rRecords, parsed.Packages)
    else
      for (const entry of parsed.packages ?? [])
        rRecords[entry.package] = { Version: entry.version }
  }
  const python = input.lock.kernelKind === 'python'
  const script = python
    ? [
        'import importlib.metadata as m, json, sys, pathlib',
        `names = json.loads(${JSON.stringify(JSON.stringify(names))})`,
        'packages = []',
        'for name in names:',
        ' d = m.distribution(name)',
        ' packages.append(dict(name=name, version=d.version, path=str(pathlib.Path(d.locate_file("")).resolve())))',
        'print(json.dumps(dict(version=".".join(map(str,sys.version_info[:3])), root=str(pathlib.Path(sys.prefix).resolve()), packages=packages)))'
      ].join('\n')
    : [
        `package_names <- jsonlite::fromJSON(${JSON.stringify(JSON.stringify(Object.keys(rRecords)))})`,
        'packages <- lapply(package_names, function(name) {',
        ' path <- find.package(name, quiet=FALSE)',
        ' d <- read.dcf(file.path(path, "DESCRIPTION"))',
        ' sha <- if ("RemoteSha" %in% colnames(d)) unname(d[1,"RemoteSha"]) else NULL',
        ' list(name=name, version=unname(d[1,"Version"]), path=normalizePath(path,winslash="/"), sha=sha)',
        '})',
        'cat(jsonlite::toJSON(list(version=as.character(getRversion()), root=normalizePath(R.home(),winslash="/"), packages=packages), auto_unbox=TRUE))'
      ].join('\n')
  const result = await input.spawn(
    python ? pythonBin(input.prefix, input.platform) : rScriptBin(input.prefix, input.platform),
    python ? ['-I', '-c', script] : ['--vanilla', '--slave', '-e', script],
    input.env,
    undefined,
    undefined,
    false,
    input.prefix,
    { signal: input.signal, timeoutMs: 30000 }
  )
  input.signal?.throwIfAborted()
  if (
    result.code !== 0 ||
    result.stdoutDroppedBytes ||
    Buffer.byteLength(result.stdout) > 2 * 1024 * 1024
  ) {
    throw new Error('Restored package metadata probe failed or exceeded its output limit.')
  }
  const observed = JSON.parse(result.stdout)
  if (
    typeof observed.version !== 'string' ||
    !packageVersionsMatch(input.lock.kernelKind, observed.version, runtimeVersion) ||
    typeof observed.root !== 'string' ||
    !within(root, observed.root)
  ) {
    throw new Error('Restored interpreter version or location does not match its lock.')
  }
  if (!Array.isArray(observed.packages) || observed.packages.length !== names.length)
    throw new Error('Restored package inventory is incomplete.')
  const seen = new Set<string>()
  for (const pkg of observed.packages) {
    const name = typeof pkg.name === 'string' ? pkg.name.toLowerCase().replace(/[-_.]+/gu, '-') : ''
    const expected = versions.get(name)
    if (
      seen.has(name) ||
      !expected ||
      typeof pkg.version !== 'string' ||
      ![...expected].some(
        (version) => version && packageVersionsMatch(input.lock.kernelKind, pkg.version, version)
      ) ||
      typeof pkg.path !== 'string' ||
      !within(root, pkg.path)
    ) {
      throw new Error(`Restored package version or location does not match its lock: ${name}`)
    }
    const expectedSha = rRecords[pkg.name]?.RemoteSha
    if (
      expectedSha &&
      (typeof pkg.sha !== 'string' || expectedSha.toLowerCase() !== pkg.sha.toLowerCase())
    )
      throw new Error(`Restored R package source revision does not match its lock: ${name}`)
    seen.add(name)
  }
}

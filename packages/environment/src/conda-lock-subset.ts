import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  CondaEnvironmentDependencyGraph,
  CondaRuntimeSubsetPlan,
  NotebookEnvironmentLock,
  NotebookEnvironmentLockComponent
} from './contracts'

type CondaComponent = Extract<NotebookEnvironmentLockComponent, { ecosystem: 'conda' }>
type Package = CondaEnvironmentDependencyGraph['packages'][number]
const MAX_PACKAGES = 10_000
// Header-only packages can have multi-megabyte file inventories (e.g. r-bh); the
// aggregate limit still bounds a complete scan, including packages outside the subset.
const MAX_METADATA_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_METADATA_BYTES = 32 * 1024 * 1024
const packageName = /^[a-z0-9_][a-z0-9_.-]*$/u
const normalizedName = (name: string): string => name.replace(/[-_.]+/gu, '-')
const virtualPackages = new Set([
  '__archspec',
  '__conda',
  '__cuda',
  '__glibc',
  '__linux',
  '__osx',
  '__unix',
  '__win'
])
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const fields = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

// Prefix records use the compact name [version [build]] MatchSpec form. Preserve every
// constraint verbatim; selection reuses an already resolved inventory and never re-solves it.
const dependencyName = (spec: string): string | undefined => {
  if (spec.length > 4096) return undefined
  const match =
    /^([a-z0-9_][a-z0-9_.-]*)(?: ([a-zA-Z0-9.*+!<>=~|,_-]+)(?: ([a-zA-Z0-9_.*?-]+))?)?$/u.exec(spec)
  // Advanced selectors are not interpreted by this closure reader.
  if (
    match?.[2] &&
    !match[2]
      .split('|')
      .every((alternative) =>
        alternative
          .split(',')
          .every((clause) =>
            /^(?:==|!=|>=|<=|>|<|=|~=)?[a-zA-Z0-9*][a-zA-Z0-9_.+!*~-]*$/u.test(clause)
          )
      )
  )
    return undefined
  return match?.[1]
}

export const condaDependencyGraphMatchesComponent = (
  value: unknown,
  component: Pick<CondaComponent, 'packages' | 'explicitLock'>
): value is CondaEnvironmentDependencyGraph => {
  const graph = record(value)
  if (
    !graph ||
    !fields(graph, ['schemaVersion', 'packages', 'rPackageOwnership']) ||
    graph.schemaVersion !== 1 ||
    !Array.isArray(graph.packages) ||
    graph.packages.length === 0 ||
    graph.packages.length > MAX_PACKAGES
  )
    return false
  const nodes = new Map<string, Package>()
  const archives = new Set<string>()
  for (const value of graph.packages) {
    const pkg = record(value)
    if (
      !pkg ||
      !fields(pkg, ['name', 'version', 'build', 'url', 'md5', 'depends']) ||
      typeof pkg.name !== 'string' ||
      !packageName.test(pkg.name) ||
      pkg.name.startsWith('__') ||
      typeof pkg.version !== 'string' ||
      !/^[a-zA-Z0-9_.+!]+$/u.test(pkg.version) ||
      typeof pkg.build !== 'string' ||
      !/^[a-zA-Z0-9_.-]+$/u.test(pkg.build) ||
      typeof pkg.url !== 'string' ||
      typeof pkg.md5 !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(pkg.md5) ||
      !Array.isArray(pkg.depends) ||
      pkg.depends.length > MAX_PACKAGES ||
      !pkg.depends.every(
        (spec) => typeof spec === 'string' && dependencyName(spec) !== undefined
      ) ||
      new Set(pkg.depends).size !== pkg.depends.length ||
      nodes.has(pkg.name)
    )
      return false
    let url: URL
    try {
      url = new URL(pkg.url)
    } catch {
      return false
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ![
        `${pkg.name}-${pkg.version}-${pkg.build}.conda`,
        `${pkg.name}-${pkg.version}-${pkg.build}.tar.bz2`
      ].includes(basename(url.pathname))
    )
      return false
    const line = `${pkg.url}#${pkg.md5}`
    if (archives.has(line)) return false
    archives.add(line)
    nodes.set(pkg.name, pkg as Package)
  }
  const names = [...nodes.keys()].map(normalizedName)
  if (
    new Set(names).size !== names.length ||
    component.packages.length !== names.length ||
    new Set(component.packages).size !== component.packages.length ||
    component.packages.some((name) => !names.includes(name))
  )
    return false
  const lines = component.explicitLock.split('\n')
  if (
    lines.shift() !== '@EXPLICIT' ||
    lines.pop() !== '' ||
    lines.length !== archives.size ||
    new Set(lines).size !== lines.length ||
    lines.some((line) => !archives.has(line))
  )
    return false
  for (const pkg of nodes.values()) {
    for (const spec of pkg.depends) {
      const name = dependencyName(spec)!
      if (!nodes.has(name) && !virtualPackages.has(name)) return false
    }
  }
  if (graph.rPackageOwnership !== undefined) {
    const ownership = record(graph.rPackageOwnership)
    if (
      !ownership ||
      !fields(ownership, ['schemaVersion', 'packages']) ||
      ownership.schemaVersion !== 1 ||
      !Array.isArray(ownership.packages) ||
      ownership.packages.length === 0 ||
      ownership.packages.length > MAX_PACKAGES
    )
      return false
    const names = new Set<string>()
    for (const value of ownership.packages) {
      const pkg = record(value)
      if (
        !pkg ||
        !fields(pkg, ['name', 'version', 'condaPackage']) ||
        typeof pkg.name !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9.]{0,127}$/u.test(pkg.name) ||
        names.has(pkg.name) ||
        typeof pkg.version !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(pkg.version) ||
        typeof pkg.condaPackage !== 'string' ||
        !nodes.has(pkg.condaPackage)
      )
        return false
      names.add(pkg.name)
    }
  }
  return true
}

// The archive manifest proves ownership; the actual ordinary DESCRIPTION proves the
// runtime package identity. Neither the archive name nor its version is an R identity.
const captureRPackageOwnership = async (
  prefix: string,
  candidates: Array<{ name: string; condaPackage: string; path: string }>
): Promise<CondaEnvironmentDependencyGraph['rPackageOwnership']> => {
  try {
    if (!candidates.length || candidates.length > MAX_PACKAGES) return undefined
    const root = await realpath(prefix)
    const names = new Set<string>()
    const packages: NonNullable<CondaEnvironmentDependencyGraph['rPackageOwnership']>['packages'] =
      []
    const observations: Array<{ path: string; stamp: string }> = []
    const stamp = (stat: Awaited<ReturnType<typeof lstat>>): string =>
      [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
    let totalBytes = 0
    for (const candidate of candidates) {
      if (names.has(candidate.name)) return undefined
      const path = join(root, candidate.path)
      if ((await realpath(path)) !== path) return undefined
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await handle.stat()
        totalBytes += before.size
        if (
          !before.isFile() ||
          before.size <= 0 ||
          before.size > 256 * 1024 ||
          totalBytes > 4 * 1024 * 1024
        )
          return undefined
        const bytes = Buffer.alloc(before.size + 1)
        let size = 0
        while (size < bytes.length) {
          const read = await handle.read(bytes, size, bytes.length - size, size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        const after = await handle.stat()
        if (size !== before.size || stamp(before) !== stamp(after)) return undefined
        const text = bytes.subarray(0, size).toString('utf8')
        const name = [...text.matchAll(/^Package:[ \t]*([^\r\n]+)[ \t]*\r?$/gmu)]
        const version = [...text.matchAll(/^Version:[ \t]*([^\r\n]+)[ \t]*\r?$/gmu)]
        if (name.length !== 1 || name[0]![1]!.trim() !== candidate.name || version.length !== 1)
          return undefined
        const value = version[0]![1]!.trim()
        if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(value)) return undefined
        packages.push({
          name: candidate.name,
          version: value,
          condaPackage: candidate.condaPackage
        })
        names.add(candidate.name)
        observations.push({ path, stamp: stamp(after) })
      } finally {
        await handle.close()
      }
    }
    for (const observation of observations) {
      if (
        (await realpath(observation.path)) !== observation.path ||
        stamp(await lstat(observation.path)) !== observation.stamp
      )
        return undefined
    }
    return { schemaVersion: 1, packages: packages.sort((a, b) => a.name.localeCompare(b.name)) }
  } catch {
    return undefined
  }
}

// Unavailable metadata must not weaken the original exact environment lock. It only removes
// the optional evidence needed for a smaller restore. Do not follow links into unrelated files.
export const captureCondaDependencyGraph = async (
  prefix: string,
  component: Pick<CondaComponent, 'packages' | 'explicitLock'>,
  versions?: ReadonlyMap<string, string | undefined>
): Promise<CondaEnvironmentDependencyGraph | undefined> => {
  try {
    const directory = join(await realpath(prefix), 'conda-meta')
    if (!(await lstat(directory)).isDirectory()) return undefined
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) =>
      entry.name.endsWith('.json')
    )
    const expected = component.explicitLock
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => basename(new URL(line).pathname).replace(/\.(?:conda|tar\.bz2)$/u, '.json'))
    if (
      expected.length === 0 ||
      expected.length > MAX_PACKAGES ||
      entries.length !== expected.length ||
      entries.some((entry) => !entry.isFile() || !expected.includes(entry.name))
    )
      return undefined
    const packages: Package[] = []
    let ownershipComplete = true
    const ownershipCandidates: Array<{ name: string; condaPackage: string; path: string }> = []
    let totalBytes = 0
    const observations: Array<{ path: string; stamp: string }> = []
    const stamp = (stat: Awaited<ReturnType<typeof lstat>>): string =>
      [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
    for (const filename of expected) {
      const path = join(directory, filename)
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await file.stat()
        totalBytes += before.size
        if (
          !before.isFile() ||
          before.size > MAX_METADATA_BYTES ||
          totalBytes > MAX_TOTAL_METADATA_BYTES
        )
          return undefined
        const buffer = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
          if (!bytesRead) break
          length += bytesRead
        }
        const after = await file.stat()
        if (length !== before.size || stamp(before) !== stamp(after)) return undefined
        const pkg = record(JSON.parse(buffer.subarray(0, length).toString('utf8')))
        if (!pkg) return undefined
        if (!Array.isArray(pkg.files) || !pkg.files.every((file) => typeof file === 'string')) {
          ownershipComplete = false
        } else {
          for (const path of pkg.files as string[]) {
            const match = /^lib\/R\/library\/([A-Za-z][A-Za-z0-9.]{0,127})\/DESCRIPTION$/u.exec(
              path
            )
            if (match && typeof pkg.name === 'string')
              ownershipCandidates.push({ name: match[1]!, condaPackage: pkg.name, path })
          }
        }
        if (filename !== `${pkg.name}-${pkg.version}-${pkg.build}.json`) return undefined
        if (
          typeof pkg.name !== 'string' ||
          (versions?.get(normalizedName(pkg.name)) !== undefined &&
            versions.get(normalizedName(pkg.name)) !== pkg.version)
        )
          return undefined
        packages.push({
          name: pkg.name,
          version: pkg.version,
          build: pkg.build,
          url: pkg.url,
          md5: typeof pkg.md5 === 'string' ? pkg.md5.toLowerCase() : pkg.md5,
          depends: pkg.depends
        } as Package)
        observations.push({ path, stamp: stamp(after) })
      } finally {
        await file.close()
      }
    }
    for (const observation of observations) {
      const current = await lstat(observation.path)
      if (!current.isFile() || stamp(current) !== observation.stamp) return undefined
    }
    if (
      (await readdir(directory)).filter((name) => name.endsWith('.json')).length !== expected.length
    )
      return undefined
    packages.sort((left, right) => left.name.localeCompare(right.name))
    const rPackageOwnership = ownershipComplete
      ? await captureRPackageOwnership(prefix, ownershipCandidates)
      : undefined
    // DESCRIPTION reads can span multiple records. Do not seal ownership against
    // metadata that changed while those package identities were being observed.
    for (const observation of observations) {
      const current = await lstat(observation.path)
      if (!current.isFile() || stamp(current) !== observation.stamp) return undefined
    }
    const graph: CondaEnvironmentDependencyGraph = {
      schemaVersion: 1,
      packages,
      ...(rPackageOwnership ? { rPackageOwnership } : {})
    }
    return condaDependencyGraphMatchesComponent(graph, component) ? graph : undefined
  } catch {
    return undefined
  }
}

export const selectCondaEnvironmentLock = (
  lock: NotebookEnvironmentLock,
  roots: readonly string[]
): NotebookEnvironmentLock | undefined => {
  if (
    lock.schemaVersion !== 1 ||
    lock.format !== 'environment-lock-bundle' ||
    lock.externalRuntime !== undefined ||
    lock.kernelKind !== 'r' ||
    lock.components.length !== 1 ||
    lock.untrackedPackages?.length ||
    lock.omittedPackages?.length ||
    lock.nonCondaInstallers?.some((installer) => installer !== 'conda') ||
    roots.length === 0 ||
    roots.some((name) => !packageName.test(name) || name.startsWith('__'))
  )
    return undefined
  const component = lock.components[0]!
  if (
    component.ecosystem !== 'conda' ||
    component.format !== 'conda-explicit-md5' ||
    component.resolution !== 'locked' ||
    !condaDependencyGraphMatchesComponent(component.dependencyGraph, component)
  )
    return undefined
  const nodes = new Map(component.dependencyGraph.packages.map((pkg) => [pkg.name, pkg]))
  const selected = new Set(roots)
  for (const name of selected) {
    const pkg = nodes.get(name)
    if (!pkg) return undefined
    for (const spec of pkg.depends) {
      const dependency = dependencyName(spec)!
      if (!virtualPackages.has(dependency)) selected.add(dependency)
    }
  }
  // The supported runtime is R plus the kernel/verification protocol package, even when the
  // user's plotting source uses base R alone. Do not return a lock that cannot start our loop.
  if (!selected.has('r-base') || !selected.has('r-jsonlite')) return undefined
  const rPackages = component.dependencyGraph.rPackageOwnership?.packages
    .filter((pkg) => selected.has(pkg.condaPackage))
    .map((pkg) => ({ ...pkg }))
  const packages = [...selected].sort().map((name) => {
    const pkg = nodes.get(name)!
    return { ...pkg, depends: [...pkg.depends] }
  })
  const derived: CondaComponent = {
    ...component,
    explicitLock:
      '@EXPLICIT\n' +
      packages
        .map((pkg) => `${pkg.url}#${pkg.md5}`)
        .sort()
        .join('\n') +
      '\n',
    packages: packages.map((pkg) => normalizedName(pkg.name)).sort(),
    dependencyGraph: {
      schemaVersion: 1,
      packages,
      ...(rPackages?.length
        ? {
            rPackageOwnership: {
              schemaVersion: 1 as const,
              packages: rPackages
            }
          }
        : {})
    }
  }
  if (!condaDependencyGraphMatchesComponent(derived.dependencyGraph, derived)) return undefined
  return { ...lock, components: [derived] }
}

// The caller validates the immutable source lock and binds its serialized bytes and replay scope
// to the supplied checksums. This projection proves archive membership, never runtime completeness.
export const deriveCondaRuntimeSubsetPlan = (
  lock: NotebookEnvironmentLock,
  sourceLockChecksum: string,
  scopeChecksum: string,
  archiveNames: readonly string[]
): CondaRuntimeSubsetPlan | undefined => {
  if (
    !/^[a-f0-9]{64}$/u.test(sourceLockChecksum) ||
    !/^[a-f0-9]{64}$/u.test(scopeChecksum) ||
    lock.schemaVersion !== 1 ||
    lock.format !== 'environment-lock-bundle' ||
    lock.externalRuntime !== undefined ||
    lock.kernelKind !== 'r' ||
    lock.components.length !== 1 ||
    lock.untrackedPackages?.length ||
    lock.omittedPackages?.length ||
    lock.nonCondaInstallers?.some((installer) => installer !== 'conda') ||
    archiveNames.length === 0 ||
    archiveNames.length > MAX_PACKAGES ||
    archiveNames.some((name) => typeof name !== 'string' || name.length > 1024) ||
    new Set(archiveNames).size !== archiveNames.length
  )
    return undefined
  const component = lock.components[0]!
  if (
    component.ecosystem !== 'conda' ||
    component.format !== 'conda-explicit-md5' ||
    component.resolution !== 'locked' ||
    !condaDependencyGraphMatchesComponent(component.dependencyGraph, component)
  )
    return undefined
  const inventory = new Map(
    component.dependencyGraph.packages.map((pkg) => [basename(new URL(pkg.url).pathname), pkg])
  )
  const packages: CondaRuntimeSubsetPlan['packages'] = []
  for (const archive of archiveNames) {
    const pkg = inventory.get(archive)
    if (!pkg) return undefined
    packages.push({ ...pkg, depends: [...pkg.depends] })
  }
  packages.sort((left, right) => left.name.localeCompare(right.name))
  const selected = new Set(packages.map((pkg) => pkg.name))
  if (!selected.has('r-base') || !selected.has('r-jsonlite')) return undefined
  const missingDependencies = packages.flatMap((pkg) =>
    pkg.depends
      .filter((spec) => {
        const name = dependencyName(spec)!
        return !selected.has(name) && !virtualPackages.has(name)
      })
      .map((dependency) => ({ packageName: pkg.name, dependency }))
  )
  missingDependencies.sort(
    (left, right) =>
      left.packageName.localeCompare(right.packageName) ||
      left.dependency.localeCompare(right.dependency)
  )
  const ownership = component.dependencyGraph.rPackageOwnership
  const rPackageOwnership = ownership
    ? {
        schemaVersion: 1 as const,
        packages: ownership.packages
          .filter((pkg) => selected.has(pkg.condaPackage))
          .map((pkg) => ({ ...pkg }))
          .sort((left, right) => left.name.localeCompare(right.name))
      }
    : undefined
  return {
    schemaVersion: 1,
    format: 'conda-runtime-subset',
    sourceLockChecksum,
    scopeChecksum,
    archiveNames: [...archiveNames].sort(),
    explicitLock:
      '@EXPLICIT\n' +
      packages
        .map((pkg) => `${pkg.url}#${pkg.md5}`)
        .sort()
        .join('\n') +
      '\n',
    packages,
    ...(rPackageOwnership ? { rPackageOwnership } : {}),
    missingDependencies
  }
}

// Re-derive every field from the source inventory. Untrusted JSON cannot change an archive,
// ownership, declared edge or missing-edge report while retaining a valid-looking scope hash.
export const condaRuntimeSubsetPlanMatchesLock = (
  value: unknown,
  lock: NotebookEnvironmentLock
): value is CondaRuntimeSubsetPlan => {
  const plan = record(value)
  if (
    !plan ||
    !fields(plan, [
      'schemaVersion',
      'format',
      'sourceLockChecksum',
      'scopeChecksum',
      'archiveNames',
      'explicitLock',
      'packages',
      'rPackageOwnership',
      'missingDependencies'
    ]) ||
    typeof plan.sourceLockChecksum !== 'string' ||
    typeof plan.scopeChecksum !== 'string' ||
    !Array.isArray(plan.archiveNames)
  )
    return false
  const expected = deriveCondaRuntimeSubsetPlan(
    lock,
    plan.sourceLockChecksum,
    plan.scopeChecksum,
    plan.archiveNames
  )
  return expected !== undefined && isDeepStrictEqual(value, expected)
}

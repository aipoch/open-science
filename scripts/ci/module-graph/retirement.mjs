/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { createPackageTestPlan, validatePackageTestRegistry } from '../package-test-impact.mjs'
import { usesReviewedBoundary } from './boundaries.mjs'
import { dependencyBoundaryViolations } from './boundary-evidence.mjs'
import { createDependencyReader } from './dependency-reader.mjs'
import { sourceSnapshot } from './source.mjs'

// Exceptions are derived by trusted code from both revisions, never a candidate flag.
// Only consumer evidence can retire; existing owner/interface/contract protections stay intact.
export function verifiedConsumerRetirements(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const candidates = Object.entries(baseManifest.modules).flatMap(([id, owner]) => {
    const current = headManifest.modules[id]
    return current
      ? owner.testFiles.consumer
          .filter((test) => !current.testFiles.consumer.includes(test))
          .map((test) => ({ id, test, owner, current }))
      : []
  })
  if (!candidates.length) return new Set()
  try {
    const before = sourceSnapshot(base, cwd),
      after = sourceSnapshot(head, cwd)
    // Preserve trusted dynamic/source-read evidence even if the candidate deletes it.
    const runtimeEdges = [before, after].flatMap((source) => {
      const text = source.read('scripts/ci/module-runtime-consumers.json')
      return text ? Object.entries(JSON.parse(text)) : []
    })
    const previousDependencies = createDependencyReader(before, runtimeEdges)
    const currentDependencies = createDependencyReader(after, runtimeEdges)
    // Already-independent host history can retire only in a consumer-removal-only change.
    // Do not let concurrent source, test, runtime-edge or checker edits manufacture evidence.
    let registrationOnly
    const isRegistrationOnly = () => {
      if (registrationOnly === undefined) {
        const changed = execFileSync(
          'git',
          ['diff', '--no-renames', '--name-only', '-z', base, head],
          { cwd, encoding: 'utf8' }
        )
          .split('\0')
          .filter(Boolean)
        registrationOnly =
          changed.length > 0 &&
          changed.every((path) =>
            /^scripts\/ci\/module-impact(?:\.json|\/[a-z][a-z0-9_]*\.json)$/.test(path)
          ) &&
          Object.keys(baseManifest.modules).length === Object.keys(headManifest.modules).length &&
          Object.entries(baseManifest.modules).every(([id, original]) => {
            const current = headManifest.modules[id]
            return (
              current &&
              current.testFiles.consumer.every((test) =>
                original.testFiles.consumer.includes(test)
              ) &&
              isDeepStrictEqual(
                {
                  ...original,
                  testFiles: { ...original.testFiles, consumer: current.testFiles.consumer }
                },
                current
              )
            )
          })
      }
      return registrationOnly
    }
    const previousRuntimeDependencies = createDependencyReader(before, runtimeEdges, {
      staticOnly: true,
      runtimeOnly: true
    })
    const currentRuntimeDependencies = createDependencyReader(after, runtimeEdges, {
      staticOnly: true,
      runtimeOnly: true
    })
    const retired = new Set()
    for (const { id, test, owner, current } of candidates) {
      if (
        !before.files.has(test) ||
        !after.files.has(test) ||
        owner.fullTestReason ||
        current.fullTestReason
      )
        continue
      const owners = new Set([...owner.ownerPaths, ...current.ownerPaths])
      const previous = previousDependencies(test, owners)
      // Already-independent history needs complete evidence in both revisions and
      // a retained original test owner; host cleanup additionally excludes code edits.
      if (!previous.reachable) {
        if (/^src\/(?:main|renderer)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(test)) {
          const testOwners = (manifest) =>
            Object.entries(manifest.modules).filter(([, module]) =>
              module.ownerPaths.includes(test)
            )
          // Structural evidence still protects type dependencies; erased type bodies do not
          // execute opaque filesystem/IPC access. Require strict evidence for the runtime cone.
          const previousRuntime = previousRuntimeDependencies(test, owners)
          const currentRuntime = currentRuntimeDependencies(test, owners)
          const originalOwners = testOwners(baseManifest)
          const currentOwners = testOwners(headManifest)
          if (
            !previous.complete ||
            !previousRuntime.complete ||
            previousRuntime.reachable ||
            !currentRuntime.complete ||
            currentRuntime.reachable ||
            !isRegistrationOnly() ||
            originalOwners.length !== 1 ||
            currentOwners.length !== 1 ||
            originalOwners[0][0] === id ||
            originalOwners[0][0] !== currentOwners[0][0] ||
            !originalOwners[0][1].testFiles.owner.includes(test) ||
            !currentOwners[0][1].testFiles.owner.includes(test)
          )
            continue
        } else {
          const root = /^packages\/[^/]+\//.exec(test)?.[0]
          const packageOwners = Object.entries(baseManifest.modules).filter(
            ([, module]) =>
              module.ownerPaths.includes(test) && module.testFiles.owner.includes(test)
          )
          if (
            !root ||
            !previous.complete ||
            !before.files.has(`${root}package.json`) ||
            !after.files.has(`${root}package.json`) ||
            [...owners].some((path) => path.startsWith(root)) ||
            packageOwners.length !== 1 ||
            !headManifest.modules[packageOwners[0][0]]?.ownerPaths.includes(test) ||
            !headManifest.modules[packageOwners[0][0]]?.testFiles.owner.includes(test)
          )
            continue
        }
      }
      const result = currentDependencies(test, owners)
      if (result.complete && !result.reachable) retired.add(`${id}:${test}`)
    }
    return retired
  } catch {
    // Missing/unsupported evidence retains the original registration obligation.
    return new Set()
  }
}

// Absence from an import graph is only a proof when the entire consumer cone is understood.
// Keep uncertain evidence (including generated native addons) rather than demand its deletion.
export function provablyStaleConsumerTests(owner, inspect) {
  const owners = new Set(owner.ownerPaths)
  return owner.testFiles.consumer.filter((test) => {
    const result = inspect(test, owners)
    return result.complete && !result.reachable
  })
}

// Historical cross-package contract evidence can also be redundant: the trusted selector already
// excludes that package for every owner edit. This is not permission to reduce coverage
// based only on a candidate registry or an absent static import.
export function verifiedExcludedPackageTests(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  const candidates = Object.entries(baseManifest.modules).flatMap(([id, owner]) => {
    const current = headManifest.modules[id]
    return current
      ? owner.testFiles.contract
          .filter((test) => !current.testFiles.contract.includes(test))
          .map((test) => ({ id, test, owner, current }))
      : []
  })
  if (!candidates.length) return new Set()
  try {
    const before = sourceSnapshot(base, cwd),
      after = sourceSnapshot(head, cwd)
    const registry = validatePackageTestRegistry(
      JSON.parse(before.read('scripts/ci/package-test-boundaries.json'))
    )
    const manifests = registry.packages.map((entry) => ({
      ...entry,
      manifest: JSON.parse(before.read(`${entry.root}/package.json`))
    }))
    for (const entry of manifests) {
      if (!entry.manifest.name || !entry.manifest.scripts?.test) return new Set()
      const dependencies = {
        ...entry.manifest.dependencies,
        ...entry.manifest.devDependencies,
        ...entry.manifest.peerDependencies,
        ...entry.manifest.optionalDependencies
      }
      if (
        manifests.some(
          (upstream) =>
            upstream.root !== entry.root &&
            Object.hasOwn(dependencies, upstream.manifest.name) &&
            !entry.dependencies.includes(upstream.root)
        )
      )
        return new Set()
    }
    const runtimeEdges = [before, after].flatMap((source) => {
      const text = source.read('scripts/ci/module-runtime-consumers.json')
      return text ? Object.entries(JSON.parse(text)) : []
    })
    const previousDependencies = createDependencyReader(before, runtimeEdges)
    const currentDependencies = createDependencyReader(after, runtimeEdges)
    const retired = new Set()
    for (const { id, test, owner, current } of candidates) {
      const root = registry.packages.find((entry) => test.startsWith(entry.root + '/'))?.root
      if (
        !root ||
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(test) ||
        owner.fullTestReason ||
        current.fullTestReason
      )
        continue
      // Keep a unique owner, independent owner-test coverage and the actual test file.
      const owning = (manifest) =>
        Object.entries(manifest.modules).filter(
          ([, m]) => m.ownerPaths.includes(test) && m.testFiles.owner.includes(test)
        )
      const previousOwners = owning(baseManifest),
        currentOwners = owning(headManifest)
      if (
        !before.files.has(test) ||
        !after.files.has(test) ||
        previousOwners.length !== 1 ||
        currentOwners.length !== 1 ||
        previousOwners[0][0] !== currentOwners[0][0] ||
        previousOwners[0][0] === id
      )
        continue
      const owners = new Set([...owner.ownerPaths, ...current.ownerPaths])
      if (
        !owners.size ||
        [...owners].some((path) => !/^(src|packages)\//.test(path)) ||
        !createPackageTestPlan([...owners], registry).excluded.includes(root)
      )
        continue
      const previous = previousDependencies(test, owners)
      const result = currentDependencies(test, owners)
      if (previous.complete && !previous.reachable && result.complete && !result.reachable)
        retired.add(`${id}:contract:${test}`)
    }
    return retired
  } catch {
    return new Set()
  }
}

export function dependencyBasedConsumerRetirements(
  base,
  head,
  baseManifest,
  headManifest,
  { cwd = process.cwd() } = {}
) {
  try {
    // Cleanup must not change the code, contracts, platform routing or policy that authorizes it.
    const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
      cwd,
      encoding: 'utf8'
    })
      .split('\0')
      .filter(Boolean)
    if (
      !changed.length ||
      changed.some(
        (path) => !/^scripts\/ci\/module-impact(?:\.json|\/[a-z][a-z0-9_]*\.json)$/.test(path)
      )
    )
      return new Set()
    if (
      Object.keys(baseManifest.modules).length !== Object.keys(headManifest.modules).length ||
      Object.entries(baseManifest.modules).some(([id, original]) => {
        const current = headManifest.modules[id]
        return (
          !current ||
          !isDeepStrictEqual(
            {
              ...original,
              testFiles: { ...original.testFiles, consumer: current.testFiles.consumer }
            },
            current
          ) ||
          current.testFiles.consumer.some((test) => !original.testFiles.consumer.includes(test))
        )
      })
    )
      return new Set()
    const sources = [sourceSnapshot(base, cwd), sourceSnapshot(head, cwd)]
    const edges = sources.flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}'))
    )
    const manifests = [baseManifest, headManifest]
    if (
      sources.some(
        (source, i) =>
          dependencyBoundaryViolations(source, manifests[i], manifests[i], edges).length
      )
    )
      return new Set()
    const inspectors = sources.map((source) => createDependencyReader(source, edges))
    const retired = new Set()
    for (const [id, original] of Object.entries(baseManifest.modules)) {
      const current = headManifest.modules[id]
      if (!usesReviewedBoundary(id, original) || !usesReviewedBoundary(id, current)) continue
      const owners = new Set(original.ownerPaths)
      for (const test of original.testFiles.consumer) {
        if (
          current.testFiles.consumer.includes(test) ||
          !sources.every((source) => source.read(test) !== undefined) ||
          inspectors.some((inspect) => inspect(test, owners).reachable)
        )
          continue
        retired.add(`${id}:${test}`)
      }
    }
    return retired
  } catch {
    return new Set()
  }
}

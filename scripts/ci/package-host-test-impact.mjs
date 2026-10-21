/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { sourceSnapshot, createDependencyReader } from './module-graph/index.mjs'
import { loadModuleImpactManifestAtRevision } from './load-module-impact.mjs'
import { createPackageTestPlan, validatePackageTestRegistry } from './package-test-impact.mjs'

const tests = (module) => Object.values(module.testFiles).flat()

// Direct package calls and one host-adapter hop provide fast PR integration feedback.
// An unresolved boundary remains in PR; transitive consumers still block merge queue.
export function directConsumerReason(inspect, test, owners) {
  const direct = inspect.dependencies(test)
  if (!direct.complete) return `unresolved test dependency: ${test}`
  for (const dependency of direct.paths) {
    if (owners.has(dependency)) return `direct runtime boundary: ${dependency}`
    const adapter = inspect.dependencies(dependency)
    if (!adapter.complete) return `unresolved adapter dependency: ${dependency}`
    if ([...adapter.paths].some((path) => owners.has(path)))
      return `direct adapter boundary: ${dependency}`
  }
  return undefined
}

export function isDirectPackageConsumerTest(inspect, test, owners) {
  return directConsumerReason(inspect, test, owners) !== undefined
}

// Both tiers retain declared boundaries; only complete file-level proof can remove
// expansion-only evidence. PR additionally defers distant consumers to queue.
export function refineHostTests(plan, changes, manifest, options = {}) {
  return refineConsumerTests(plan, changes, manifest, options, 'host')
}

// Refine execution, never preflight capabilities or directly declared boundary evidence.
export function refinePackageHostTests(plan, changes, manifest, options = {}) {
  return refineConsumerTests(plan, changes, manifest, options, 'package')
}

function refineConsumerTests(
  plan,
  changes,
  manifest,
  {
    base,
    head,
    cwd = process.cwd(),
    graphTests = [],
    tier = 'queue',
    registrationModules = []
  } = {},
  boundary
) {
  if (!['pr', 'queue'].includes(tier)) throw new Error(`Unknown test tier: ${tier}`)
  if (plan.mode !== 'selective' || !changes.length) return plan
  const originalPlan = plan
  const retain = (reason) => ({
    ...plan,
    reasonChains: [
      ...plan.reasonChains,
      `${boundary} boundary: ${reason} -> retain complete declared selection`
    ]
  })
  const changedPaths = new Set(changes.map(({ path }) => path))
  const directEvidence = new Set([
    ...graphTests,
    ...changedPaths,
    ...Object.values(manifest.modules)
      .filter((module) => module.ownerPaths.some((path) => changedPaths.has(path)))
      .flatMap(tests),
    ...plan.modules.flatMap((id) => manifest.modules[id]?.testFiles.contract ?? [])
  ])
  if (
    tier !== 'pr' &&
    !plan.testFiles.some((test) => test.startsWith('src/') && !directEvidence.has(test))
  )
    return plan
  try {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const mergeBase = git('merge-base', base, head)
    // Include the actual merge checkout: newer main may introduce a dependency.
    const revisions = [...new Set([mergeBase, head, git('rev-parse', 'HEAD')])]
    // Uncommitted sources are not covered by immutable evidence.
    if (git('status', '--porcelain', '--untracked-files=normal'))
      return retain('uncommitted evidence')
    const sources = revisions.map((revision) => sourceSnapshot(revision, cwd))
    const registry =
      boundary === 'package'
        ? validatePackageTestRegistry(
            JSON.parse(sources[0].read('scripts/ci/package-test-boundaries.json'))
          )
        : undefined
    const paths = changes.flatMap(({ path, previousPath }) => [path, previousPath].filter(Boolean))
    if (
      changes.some(({ status }) => !['modified', 'added'].includes(status)) ||
      paths.some((path) =>
        boundary === 'package'
          ? !registry.packages.some(({ root }) => path.startsWith(root + '/'))
          : !/^src\/(?:main|renderer|shared)\/.*\.[cm]?[jt]sx?$/.test(path)
      )
    )
      return retain('mixed, unknown or destructive inputs')
    const manifests = [
      manifest,
      ...revisions.map((revision) => loadModuleImpactManifestAtRevision(revision, { cwd }))
    ]
    const protectedTests = new Set([...graphTests, ...paths])
    const owners = new Set()
    const declaredConsumers = new Set()
    for (const current of manifests) {
      for (const path of paths) {
        const matches = Object.values(current.modules).filter((module) =>
          module.ownerPaths.includes(path)
        )
        // Newly added paths can lack an old owner; their head owner must still be unique.
        if (
          matches.length > 1 ||
          (!matches.length && sources.every((source) => source.files.has(path)))
        )
          return retain(`ambiguous owner: ${path}`)
        for (const module of matches) {
          if (module.fullTestReason) return retain(`full owner: ${path}`)
          for (const owner of module.ownerPaths) owners.add(owner)
          for (const test of module.testFiles.consumer) declaredConsumers.add(test)
          for (const test of tier === 'pr'
            ? [...module.testFiles.owner, ...module.testFiles.contract]
            : tests(module))
            protectedTests.add(test)
        }
      }
      for (const id of plan.modules) {
        const module = current.modules[id]
        if (!module) return retain(`missing module: ${id}`)
        for (const test of module.testFiles.contract) protectedTests.add(test)
      }
    }
    if (!owners.size) return retain('no source owner')
    for (const id of registrationModules) {
      const previous = manifests[1].modules[id]
      const current = manifest.modules[id]
      if (!previous || !current) return retain(`unproven registration: ${id}`)
      const oldTests = new Set(tests(previous))
      const sourceChanged = current.ownerPaths.some((path) => changedPaths.has(path))
      for (const test of tests(current))
        if (!sourceChanged || !oldTests.has(test)) protectedTests.add(test)
    }
    const runtimeEdges = sources.flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json')))
    )
    // Selecting a consumer module does not make all of its sources change seeds.
    // Keep direct declarations and contracts; prove expansion-only exclusions against
    // the actual changed files, including every historical runtime edge.
    const boundaryTests = new Set([...protectedTests, ...directEvidence])
    const completeReaders = sources.map((source) =>
      createDependencyReader(source, runtimeEdges, { staticOnly: true, runtimeOnly: true })
    )
    const changedSources = new Set(paths)
    const omitted = plan.testFiles.filter(
      (test) =>
        test.startsWith('src/') &&
        !boundaryTests.has(test) &&
        completeReaders.every((inspect) => {
          const evidence = inspect(test, changedSources)
          return evidence.complete && !evidence.reachable
        })
    )
    if (omitted.length) {
      const excluded = new Set(omitted)
      plan = {
        ...plan,
        testFiles: plan.testFiles.filter((test) => !excluded.has(test)),
        reasonChains: [
          ...plan.reasonChains,
          ...omitted.map(
            (test) =>
              `${test} -> expansion-only host test; complete base/head/checkout dependency evidence against changed files -> excluded`
          )
        ]
      }
    }
    if (tier === 'pr') {
      const inspectors = sources.map((source) =>
        createDependencyReader(source, runtimeEdges, { runtimeOnly: true })
      )
      const structural =
        boundary === 'host'
          ? sources.map((source) => createDependencyReader(source, runtimeEdges))
          : []
      const retainedReasons = []
      const deferred = plan.testFiles.filter((test) => {
        if (!test.startsWith('src/') || protectedTests.has(test)) return false
        // Missing import evidence cannot demote a historical host contract.
        if (
          declaredConsumers.has(test) &&
          structural.some((inspect) => {
            const evidence = inspect(test, owners)
            return !evidence.complete || !evidence.reachable
          })
        ) {
          retainedReasons.push(
            `${test} -> historical host contract or unresolved structural dependency -> retained`
          )
          return false
        }
        // Keep tests of a direct package consumer (host adapter), plus tests importing the package.
        // More distant integration evidence is deferred, never retired or claimed unrelated.
        const reason = inspectors
          .map((inspect) => directConsumerReason(inspect, test, owners))
          .find(Boolean)
        if (reason) retainedReasons.push(`${test} -> ${reason} -> retained`)
        return !reason
      })
      const deferredPackageRoots =
        boundary === 'package'
          ? createPackageTestPlan(paths, registry).selected.filter(
              (root) =>
                !paths.some((path) => path.startsWith(root + '/')) &&
                ![...protectedTests].some((test) => test.startsWith(root + '/'))
            )
          : []
      deferred.push(
        ...plan.testFiles.filter((test) =>
          deferredPackageRoots.some((root) => test.startsWith(root + '/'))
        )
      )
      const deferredSet = new Set(deferred)
      return {
        ...plan,
        testFiles: plan.testFiles.filter((test) => !deferredSet.has(test)),
        deferredTestFiles: deferred,
        deferredPackageRoots,
        reasonChains: [
          ...plan.reasonChains,
          ...retainedReasons,
          `PR ${boundary} boundary -> ${plan.testFiles.length - deferred.length} retained files; ${deferred.length} consumer files deferred to blocking merge queue; typechecks and capabilities unchanged`,
          ...deferredPackageRoots.map(
            (root) => `${root} -> downstream package suite -> merge queue`
          ),
          ...deferred
            .filter((test) => test.startsWith('src/'))
            .map((test) => `${test} -> host consumer beyond direct adapter -> merge queue`)
        ]
      }
    }
    return plan
  } catch {
    return {
      ...originalPlan,
      reasonChains: [
        ...originalPlan.reasonChains,
        `${boundary === 'package' ? 'package host' : 'host consumer'} evidence unavailable -> retain complete declared selection`
      ]
    }
  }
}

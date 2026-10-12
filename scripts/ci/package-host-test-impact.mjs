/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { sourceSnapshot, createConsumerDependencyReader } from './consumer-retirement.mjs'
import { loadModuleImpactManifestAtRevision } from './load-module-impact.mjs'
import { createPackageTestPlan, validatePackageTestRegistry } from './package-test-impact.mjs'

const tests = (module) => Object.values(module.testFiles).flat()

// Direct package calls and one host-adapter hop provide fast PR integration feedback.
// An unresolved boundary remains in PR; transitive consumers still block merge queue.
export function isDirectPackageConsumerTest(inspect, test, owners) {
  const direct = inspect.dependencies(test)
  if (!direct.complete) return true
  for (const dependency of direct.paths) {
    if (owners.has(dependency)) return true
    const adapter = inspect.dependencies(dependency)
    if (!adapter.complete || [...adapter.paths].some((path) => owners.has(path))) return true
  }
  return false
}

// Refine execution, never preflight capabilities or directly declared boundary evidence.
export function refinePackageHostTests(
  plan,
  changes,
  manifest,
  { base, head, cwd = process.cwd(), graphTests = [], tier = 'queue' } = {}
) {
  if (!['pr', 'queue'].includes(tier)) throw new Error(`Unknown test tier: ${tier}`)
  if (plan.mode !== 'selective' || !changes.length) return plan
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
    if (git('status', '--porcelain', '--untracked-files=normal')) return plan
    const sources = revisions.map((revision) => sourceSnapshot(revision, cwd))
    const registry = validatePackageTestRegistry(
      JSON.parse(sources[0].read('scripts/ci/package-test-boundaries.json'))
    )
    const paths = changes.flatMap(({ path, previousPath }) => [path, previousPath].filter(Boolean))
    if (
      changes.some(({ status }) => !['modified', 'added'].includes(status)) ||
      paths.some((path) => !registry.packages.some(({ root }) => path.startsWith(root + '/')))
    )
      return plan
    const manifests = [
      manifest,
      ...revisions.map((revision) => loadModuleImpactManifestAtRevision(revision, { cwd }))
    ]
    const protectedTests = new Set([...graphTests, ...paths])
    const owners = new Set()
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
          return plan
        for (const module of matches) {
          if (module.fullTestReason) return plan
          for (const owner of module.ownerPaths) owners.add(owner)
          for (const test of tier === 'pr'
            ? [...module.testFiles.owner, ...module.testFiles.contract]
            : tests(module))
            protectedTests.add(test)
        }
      }
      for (const id of plan.modules) {
        const module = current.modules[id]
        if (!module) return plan
        for (const test of module.testFiles.contract) protectedTests.add(test)
      }
    }
    if (!owners.size) return plan
    const runtimeEdges = sources.flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json')))
    )
    if (tier === 'pr') {
      const inspectors = sources.map((source) =>
        createConsumerDependencyReader(source, runtimeEdges, { runtimeOnly: true })
      )
      const deferred = plan.testFiles.filter((test) => {
        if (!test.startsWith('src/') || protectedTests.has(test)) return false
        // Keep tests of a direct package consumer (host adapter), plus tests importing the package.
        // More distant integration evidence is deferred, never retired or claimed unrelated.
        return inspectors.every((inspect) => {
          return !isDirectPackageConsumerTest(inspect, test, owners)
        })
      })
      const deferredPackageRoots = createPackageTestPlan(paths, registry).selected.filter(
        (root) =>
          !paths.some((path) => path.startsWith(root + '/')) &&
          ![...protectedTests].some((test) => test.startsWith(root + '/'))
      )
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
          `PR package boundary -> ${plan.testFiles.length - deferred.length} retained files; ${deferred.length} consumer files deferred to blocking merge queue; typechecks and capabilities unchanged`,
          ...deferredPackageRoots.map(
            (root) => `${root} -> downstream package suite -> merge queue`
          ),
          ...deferred
            .filter((test) => test.startsWith('src/'))
            .map((test) => `${test} -> host consumer beyond direct adapter -> merge queue`)
        ]
      }
    }
    const inspectors = sources.map((source) =>
      createConsumerDependencyReader(source, runtimeEdges, { staticOnly: true })
    )
    const omitted = plan.testFiles.filter((test) => {
      // Independent downstream package suites and policy/source-reading tests remain intact.
      if (!test.startsWith('src/') || protectedTests.has(test)) return false
      return inspectors.every((inspect) => {
        const evidence = inspect(test, owners)
        return evidence.complete && !evidence.reachable
      })
    })
    if (!omitted.length) return plan
    const excluded = new Set(omitted)
    return {
      ...plan,
      testFiles: plan.testFiles.filter((test) => !excluded.has(test)),
      reasonChains: [
        ...plan.reasonChains,
        `package host evidence -> ${plan.testFiles.length} declared files -> ${plan.testFiles.length - omitted.length} retained files; capabilities unchanged`,
        ...omitted.map(
          (test) =>
            `${test} -> expansion-only host test; complete base/head/checkout dependency evidence -> excluded`
        )
      ]
    }
  } catch {
    return {
      ...plan,
      reasonChains: [
        ...plan.reasonChains,
        'package host evidence unavailable -> retain complete declared selection'
      ]
    }
  }
}

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { sourceSnapshot, createConsumerDependencyReader } from './consumer-retirement.mjs'
import { loadModuleImpactManifestAtRevision } from './load-module-impact.mjs'

const tests = (module) => Object.values(module.testFiles).flat()

// Only expansion-only evidence can leave PR. Queue keeps the original declared plan.
export function refineHostTests(
  plan,
  changes,
  manifest,
  { base, head, cwd = process.cwd(), graphTests = [], tier = 'queue' } = {}
) {
  if (!['pr', 'queue'].includes(tier)) throw new Error(`Unknown test tier: ${tier}`)
  if (tier !== 'pr' || plan.mode !== 'selective' || !changes.length) return plan
  const paths = changes.flatMap(({ path, previousPath }) => [path, previousPath].filter(Boolean))
  if (
    changes.some(({ status }) => !['modified', 'added'].includes(status)) ||
    paths.some((path) => !/^src\/(?:main|renderer)\/.*\.[cm]?[jt]sx?$/.test(path))
  )
    return plan
  const directEvidence = new Set([
    ...graphTests,
    ...paths,
    ...Object.values(manifest.modules)
      .filter((module) => module.ownerPaths.some((path) => paths.includes(path)))
      .flatMap(tests),
    ...plan.modules.flatMap((id) => manifest.modules[id]?.testFiles.contract ?? [])
  ])
  if (!plan.testFiles.some((test) => test.startsWith('src/') && !directEvidence.has(test)))
    return plan
  try {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    // Use immutable base/head/actual checkout evidence, including newer main in a merge checkout.
    const revisions = [...new Set([git('merge-base', base, head), head, git('rev-parse', 'HEAD')])]
    if (git('status', '--porcelain', '--untracked-files=normal')) return plan
    const sources = revisions.map((revision) => sourceSnapshot(revision, cwd))
    const snapshots = revisions.map((revision, index) => ({
      manifest: loadModuleImpactManifestAtRevision(revision, { cwd }),
      source: sources[index]
    }))
    if (paths.some((path) => !sources.some((source) => source.files.has(path)))) return plan
    const owners = new Set()
    const protectedTests = new Set(directEvidence)
    for (const { manifest: current, source } of [
      { manifest, source: sources.at(-1) },
      ...snapshots
    ]) {
      for (const path of paths) {
        const matches = Object.values(current.modules).filter((module) =>
          module.ownerPaths.includes(path)
        )
        // Newly added files may lack a base owner; surviving files must have unique ownership.
        if (matches.length > 1 || (!matches.length && source.files.has(path))) return plan
        for (const module of matches) {
          if (module.fullTestReason) return plan
          for (const owner of module.ownerPaths) owners.add(owner)
          for (const test of tests(module)) protectedTests.add(test)
        }
      }
      for (const id of plan.modules) {
        const module = current.modules[id]
        if (!module) return plan
        for (const test of module.fullTestReason ? tests(module) : module.testFiles.contract)
          protectedTests.add(test)
      }
    }
    if (!owners.size) return plan
    const runtimeEdges = sources.flatMap((source) =>
      Object.entries(JSON.parse(source.read('scripts/ci/module-runtime-consumers.json')))
    )
    const inspectors = sources.map((source) =>
      createConsumerDependencyReader(source, runtimeEdges, { staticOnly: true })
    )
    const deferred = plan.testFiles.filter((test) => {
      if (!test.startsWith('src/') || protectedTests.has(test)) return false
      return inspectors.every((inspect) => {
        const evidence = inspect(test, owners)
        return evidence.complete && !evidence.reachable
      })
    })
    if (!deferred.length) return plan
    const deferredSet = new Set(deferred)
    return {
      ...plan,
      testFiles: plan.testFiles.filter((test) => !deferredSet.has(test)),
      deferredTestFiles: deferred,
      reasonChains: [
        ...plan.reasonChains,
        `PR host boundary -> ${plan.testFiles.length - deferred.length} retained files; ${deferred.length} expansion-only files deferred to blocking merge queue; direct evidence and capabilities unchanged`,
        ...deferred.map(
          (test) =>
            `${test} -> complete base/head/checkout evidence finds no owner dependency -> merge queue`
        )
      ]
    }
  } catch {
    return {
      ...plan,
      reasonChains: [
        ...plan.reasonChains,
        'host evidence unavailable -> retain complete declared selection'
      ]
    }
  }
}

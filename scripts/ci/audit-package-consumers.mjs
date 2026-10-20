/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceSnapshot, createConsumerDependencyReader } from './consumer-retirement.mjs'
import { loadModuleImpactManifestAtRevision } from './load-module-impact.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import { validatePackageTestRegistry } from './package-test-impact.mjs'
import { isDirectPackageConsumerTest } from './package-host-test-impact.mjs'

// Audit immutable source with the same resolver used by selection. This is evidence, not
// permission to delete registrations: dynamic/behavioral contracts need explicit ownership.
export function auditPackageConsumers(revision = 'HEAD', cwd = process.cwd()) {
  const sha = execFileSync(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
    { cwd, encoding: 'utf8' }
  ).trim()
  const source = sourceSnapshot(sha, cwd)
  const manifest = loadModuleImpactManifestAtRevision(sha, { cwd })
  const registry = validatePackageTestRegistry(
    JSON.parse(source.read('scripts/ci/package-test-boundaries.json'))
  )
  const runtimeEdges = Object.entries(
    JSON.parse(source.read('scripts/ci/module-runtime-consumers.json'))
  )
  const structural = createConsumerDependencyReader(source, runtimeEdges)
  const runtime = createConsumerDependencyReader(source, runtimeEdges, { runtimeOnly: true })
  const hostFiles = [...source.files].filter((path) => /^src\/.*\.[cm]?[jt]sx?$/.test(path))
  const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
  const packages = registry.packages.map(({ root, dependencies }) => {
    const modules = Object.entries(manifest.modules).filter(([, module]) =>
      module.ownerPaths.some((path) => path.startsWith(root + '/'))
    )
    const owners = new Set([...source.files].filter((path) => path.startsWith(root + '/')))
    const changes = modules.map(([, module]) => ({
      status: 'modified',
      path:
        module.ownerPaths.find(
          (path) => path.startsWith(root + '/') && /\.[cm]?[jt]sx?$/.test(path) && !isTest(path)
        ) ?? module.ownerPaths[0]
    }))
    const plan = createAffectedTestPlan(
      changes,
      { status: 'not-requested', testFiles: [] },
      manifest
    )
    const protectedTests = new Set([
      ...modules.flatMap(([, module]) => [...module.testFiles.owner, ...module.testFiles.contract]),
      ...plan.modules.flatMap((id) => manifest.modules[id].testFiles.contract)
    ])
    const hostTests = plan.testFiles.filter((path) => path.startsWith('src/'))
    const directRuntimeConsumers = [],
      directTypeConsumers = []
    for (const file of hostFiles.filter((path) => !isTest(path))) {
      if ([...runtime.dependencies(file).paths].some((path) => owners.has(path)))
        directRuntimeConsumers.push(file)
      else if ([...structural.dependencies(file).paths].some((path) => owners.has(path)))
        directTypeConsumers.push(file)
    }
    const pr = hostTests.filter(
      (test) => protectedTests.has(test) || isDirectPackageConsumerTest(runtime, test, owners)
    )
    const evidence = hostTests.map((test) => {
      const value = runtime(test, owners)
      const shape = value.reachable ? value : structural(test, owners)
      return {
        test,
        evidence: value.reachable
          ? 'runtime-path'
          : !value.complete
            ? 'unresolved'
            : shape.reachable
              ? 'type-path-only'
              : 'no-static-path',
        pr: pr.includes(test)
      }
    })
    return {
      root,
      dependencies,
      modules: modules.map(([id]) => id),
      mode: plan.mode,
      fullReasons: modules.flatMap(([, module]) =>
        module.fullTestReason ? [module.fullTestReason] : []
      ),
      rawTestFiles: plan.mode === 'full' ? null : plan.testFiles.length,
      hostTestFiles: plan.mode === 'full' ? null : hostTests.length,
      prHostTestFiles: plan.mode === 'full' ? null : pr.length,
      queueHostTestFiles: plan.mode === 'full' ? null : hostTests.length - pr.length,
      directRuntimeConsumers,
      directTypeConsumers,
      declaredRuntimeEdges: Object.fromEntries(
        runtimeEdges.filter(([target]) => target.startsWith(root + '/'))
      ),
      evidence
    }
  })
  return {
    revision: sha,
    note: 'Representative package implementation probes; counts are files, before execution-time unrelated-test pruning. Type-path evidence is not proof that dynamic runtime coupling is absent. Full owners remain full.',
    packages
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditPackageConsumers(process.argv[2] ?? 'HEAD')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

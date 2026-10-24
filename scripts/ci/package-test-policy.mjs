/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createPackageTestPlan } from './package-test-impact.mjs'

// Package roots, rather than individual source imports, define the unit-suite direction.
// Host integration tests remain unrestricted by this guard.
export function packageTestRegistrationViolations(manifest, registry) {
  const roots = registry.packages.map(({ root }) => root)
  const ownedRoots = (module) =>
    roots.filter((root) => module.ownerPaths.some((path) => path.startsWith(root + '/')))
  const violations = []
  for (const [id, module] of Object.entries(manifest.modules)) {
    const selected = createPackageTestPlan(
      ownedRoots(module).map((root) => `${root}/src/changed.ts`),
      registry
    ).selected
    for (const [kind, tests] of Object.entries(module.testFiles)) {
      for (const test of tests) {
        const root = roots.find((root) => test.startsWith(root + '/'))
        if (root && !selected.includes(root)) violations.push({ id, kind, test })
      }
    }
    for (const consumer of module.consumerModules ?? []) {
      for (const root of ownedRoots(manifest.modules[consumer])) {
        if (!selected.includes(root))
          violations.push({ id, kind: 'consumerModules', test: consumer })
      }
    }
  }
  return violations
}

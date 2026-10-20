/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { validatePackageTestRegistry } from './ci/package-test-impact.mjs'

export const packageRegistry = () =>
  JSON.parse(readFileSync(new URL('./ci/package-test-boundaries.json', import.meta.url), 'utf8'))

// Selection is supplied by trusted CI policy. Missing exclusion evidence never skips a new package.
export function packageVerificationPlan(registry, selected, excluded) {
  const { packages } = validatePackageTestRegistry(registry)
  for (const roots of [selected, excluded]) {
    if (
      roots !== undefined &&
      (!Array.isArray(roots) ||
        roots.some(
          (root) =>
            typeof root !== 'string' || !/^(?:packages|packages\/[a-z0-9][a-z0-9-]*)$/.test(root)
        ))
    )
      throw new Error('Invalid package verification selection')
  }
  const tests = packages
    .filter(
      ({ root }) =>
        selected === undefined ||
        selected.includes('packages') ||
        selected.includes(root) ||
        (excluded !== undefined && !excluded.includes(root))
    )
    .map(({ root }) => root)
  const builds = new Set()
  function visit(root) {
    if (builds.has(root)) return
    packages.find((entry) => entry.root === root).dependencies.forEach(visit)
    builds.add(root)
  }
  tests.forEach(visit)
  return { builds: [...builds], tests }
}

export function verificationPlanFromArguments(args = process.argv.slice(2), env = process.env) {
  const registry = packageRegistry()
  const request = args
    .find((arg) => arg.startsWith('--packages='))
    ?.slice(11)
    .split(',')
  if (request) {
    const roots = request.map((name) => `packages/${name}`)
    if (roots.some((root) => !registry.packages.some((entry) => entry.root === root)))
      throw new Error('Unknown package selection')
    return packageVerificationPlan(registry, roots)
  }
  if (!args.includes('--ci')) return packageVerificationPlan(registry)
  const selected = env.OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS
  const excluded = env.OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS
  // Both values belong to one trusted selection. Partial/missing evidence keeps the full baseline.
  return selected && excluded
    ? packageVerificationPlan(registry, JSON.parse(selected), JSON.parse(excluded))
    : packageVerificationPlan(registry)
}

export function familyVerificationPlan(names, args = process.argv.slice(2), env = process.env) {
  const plan = verificationPlanFromArguments(args, env)
  const family = (roots) =>
    roots.map((root) => root.slice('packages/'.length)).filter((name) => names.includes(name))
  return { builds: family(plan.builds), tests: family(plan.tests) }
}

export function isolatedPackageEnvironment(env = process.env) {
  const clean = { ...env }
  for (const key of [
    'NODE_PATH',
    'NODE_OPTIONS',
    'INIT_CWD',
    'VITEST_PORTABLE_CI',
    'OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS',
    'OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS'
  ])
    delete clean[key]
  return clean
}

import { describe, expect, it } from 'vitest'
import {
  packageVerificationPlan,
  packageRegistry,
  verificationPlanFromArguments,
  isolatedPackageEnvironment
} from './package-verification-plan.mjs'
import { verificationCommands } from './check-packages.mjs'

const registry = packageRegistry()
const roots = registry.packages.map(({ root }: { root: string }) => root)
const upstream = 'packages/pdf-structure'
const downstream = 'packages/pdf-translation'

describe('independent package verification', () => {
  it('builds unchanged prerequisites without selecting their tests', () => {
    const plan = packageVerificationPlan(
      registry,
      [downstream],
      roots.filter((root: string) => root !== downstream)
    )
    expect(plan).toEqual({ builds: [upstream, downstream], tests: [downstream] })
    expect(verificationCommands(plan)).toEqual([
      { script: 'check:package-isolation', packages: ['pdf-translation'] }
    ])
  })
  it('does no work for a proven host-only change and retains missing exclusion evidence', () => {
    expect(packageVerificationPlan(registry, [], roots)).toEqual({ builds: [], tests: [] })
    expect(
      packageVerificationPlan(
        registry,
        [],
        roots.filter((root: string) => root !== downstream)
      ).tests
    ).toEqual([downstream])
    expect(
      verificationPlanFromArguments(['--ci'], { OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]' })
        .tests
    ).toEqual(roots)
  })
  it('retains the complete baseline for shared changes and registers every consumer scenario', () => {
    const plan = packageVerificationPlan(registry, ['packages'], [])
    expect(plan.tests).toEqual(roots)
    expect(
      verificationCommands(plan)
        .flatMap(({ packages }) => packages)
        .sort()
    ).toEqual(roots.map((root: string) => root.slice(9)).sort())
    expect(() => verificationCommands({ tests: ['packages/new-package'] })).toThrow(
      'No installed-consumer'
    )
  })
  it('rejects malformed selection and unknown explicit packages', () => {
    expect(() => packageVerificationPlan(registry, ['../src'])).toThrow('Invalid')
    expect(() => packageVerificationPlan(registry, 'packages')).toThrow('Invalid')
    expect(() => verificationPlanFromArguments(['--packages=missing'], {})).toThrow('Unknown')
    expect(() =>
      verificationPlanFromArguments(['--ci'], {
        OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: 'bad',
        OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '[]'
      })
    ).toThrow()
  })
  it('removes host resolution and test-selection hooks while preserving cache configuration', () => {
    expect(
      isolatedPackageEnvironment({
        NODE_PATH: '/host',
        NODE_OPTIONS: '--import /host',
        INIT_CWD: '/host',
        VITEST_PORTABLE_CI: '1',
        OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]',
        OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '[]',
        npm_config_cache: '/cache'
      })
    ).toEqual({ npm_config_cache: '/cache' })
  })
})

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// Windows keeps only the first case-insensitive key; an inherited alias must not win over the stub.
const subprocessEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_execpath')
)

describe('independent package verification', () => {
  it('includes every registered Literature package in the targeted build and verification commands', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    const literatureRoots = roots.filter((root: string) =>
      /^packages\/(?:literature-|journal-catalog$)/.test(root)
    )
    for (const command of ['build:literature-packages', 'check:literature-packages']) {
      const selection = scripts[command]
        .split(' ')
        .find((argument: string) => argument.startsWith('--packages='))
      expect(selection, command).toBeDefined()
      expect(verificationPlanFromArguments([selection], {}).tests.sort(), command).toEqual(
        [...literatureRoots].sort()
      )
    }
  })
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
  it('builds citations without selecting its tests for discovery', () => {
    const plan = verificationPlanFromArguments(['--packages=literature-discovery'], {})
    expect(plan).toEqual({
      builds: ['packages/literature-citations', 'packages/literature-discovery'],
      tests: ['packages/literature-discovery']
    })
    expect(verificationCommands(plan)).toEqual([
      { script: 'check:package-isolation', packages: ['literature-discovery'] }
    ])
  })
  it.each(['environment', 'compute'])('builds diagnostics without its tests for %s', (name) => {
    const plan = verificationPlanFromArguments([`--packages=${name}`], {})
    expect(plan).toEqual({
      builds: ['packages/diagnostics', `packages/${name}`],
      tests: [`packages/${name}`]
    })
    expect(verificationCommands(plan)).toEqual([
      { script: `check:${name}-package`, packages: [name] }
    ])
  })
  it.each(['skills', 'specialists'])('selects only the standalone %s verifier', (name) => {
    const plan = verificationPlanFromArguments([`--packages=${name}`], {})
    expect(plan).toEqual({
      builds: ['packages/durable-files', `packages/${name}`],
      tests: [`packages/${name}`]
    })
    expect(verificationCommands(plan)).toEqual([
      { script: 'check:durable-files-package', packages: [name] }
    ])
  })
  it('verifies a new Specialist package absent from trusted exclusion evidence', () => {
    const plan = packageVerificationPlan(
      registry,
      [],
      roots.filter((root: string) => root !== 'packages/specialists')
    )
    expect(verificationCommands(plan)).toEqual([
      { script: 'check:durable-files-package', packages: ['specialists'] }
    ])
  })
  it('builds the reproduction dependency closure while testing only reproduction', () => {
    const plan = verificationPlanFromArguments(['--packages=reproducibility'], {})
    expect(plan.tests).toEqual(['packages/reproducibility'])
    expect(plan.builds).toEqual([
      'packages/diagnostics',
      'packages/environment',
      'packages/notebook-syntax',
      'packages/notebook-analysis',
      'packages/reproducibility'
    ])
    expect(verificationCommands(plan)).toEqual([
      { script: 'check:reproducibility-package', packages: ['reproducibility'] }
    ])
  })
  it('skips direct reproduction verification for proven host-only or other-package changes', () => {
    for (const selected of [[], ['packages/compute']]) {
      const output = execFileSync(
        process.execPath,
        ['scripts/check-reproducibility-package.mjs', '--ci'],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...subprocessEnvironment,
            npm_execpath: 'unexpected-npm-invocation.cjs',
            OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: JSON.stringify(selected),
            OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(
              roots.filter((root: string) => !selected.includes(root))
            )
          }
        }
      )
      expect(output).toContain('skipped by package selection')
    }
  })
  it('skips the direct environment verifier when only Compute is selected', () => {
    const output = execFileSync(
      process.execPath,
      ['scripts/check-environment-package.mjs', '--ci'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...subprocessEnvironment,
          npm_execpath: 'unexpected-npm-invocation.cjs',
          OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: JSON.stringify(['packages/compute']),
          OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(
            roots.filter((root: string) => root !== 'packages/compute')
          )
        }
      }
    )
    expect(output).toContain('Environment package verification:')
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

it('verifies resilient-download alone without inventing environment or sibling prerequisites', () => {
  const plan = verificationPlanFromArguments(['--packages=resilient-download'], {})
  expect(plan).toEqual({
    builds: ['packages/resilient-download'],
    tests: ['packages/resilient-download']
  })
  expect(verificationCommands(plan)).toEqual([
    { script: 'check:resilient-download-package', packages: ['resilient-download'] }
  ])
})

it('verifies the private test-impact tool without selecting application packages', () => {
  const plan = verificationPlanFromArguments(['--packages=test-impact'], {})
  expect(plan).toEqual({ builds: ['packages/test-impact'], tests: ['packages/test-impact'] })
  expect(verificationCommands(plan)).toEqual([
    { script: 'check:test-impact-package', packages: ['test-impact'] }
  ])
})

it.each([false, true])(
  'dispatches every family with explicit source-test evidence (skip=%s)',
  (skip) => {
    const directory = mkdtempSync(join(tmpdir(), 'package-dispatch-'))
    try {
      const npm = join(directory, 'npm.cjs')
      const calls = join(directory, 'calls.jsonl')
      const output = join(directory, 'report.json')
      writeFileSync(
        npm,
        "require('node:fs').appendFileSync(process.env.PACKAGE_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n')"
      )
      execFileSync(
        process.execPath,
        ['scripts/check-packages.mjs', `--output=${output}`, ...(skip ? ['--skip-tests'] : [])],
        {
          // A synchronous child otherwise blocks Vitest's own timeout indefinitely.
          timeout: 30_000,
          encoding: 'utf8',
          env: { ...subprocessEnvironment, npm_execpath: npm, PACKAGE_TEST_CALLS: calls }
        }
      )
      const commands = verificationCommands(verificationPlanFromArguments([], {}))
      expect(
        readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      ).toEqual(
        commands.map(({ script, packages }: { script: string; packages: string[] }) => [
          'run',
          script,
          '--',
          `--packages=${packages.join(',')}`,
          ...(skip ? ['--skip-tests'] : [])
        ])
      )
      const report = JSON.parse(readFileSync(output, 'utf8'))
      expect(report.sourceTests).toBe(!skip)
      expect(report.runs).toHaveLength(commands.length)
      expect(report.runs.every(({ exitCode }: { exitCode: number }) => exitCode === 0)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

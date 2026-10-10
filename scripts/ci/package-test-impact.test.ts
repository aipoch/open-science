import { execFileSync } from 'node:child_process'
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { executeModuleTestPlan } from './module-test-impact.mjs'
import { describe, expect, it } from 'vitest'
import {
  createPackageTestPlan,
  packageTestExcludePatterns,
  packageTestPlanFromRevisions,
  validatePackageTestRegistry
} from './package-test-impact.mjs'

const core = 'packages/core'
const providers = 'packages/providers'
const mcp = 'packages/mcp-client'
const registry = {
  schemaVersion: 1,
  packages: [
    { root: core, dependencies: [] },
    { root: providers, dependencies: [core] },
    { root: mcp, dependencies: [core] }
  ]
}
describe('independent package test direction', () => {
  it('excludes upstream package unit tests for a downstream host edit even when host selection is full', () => {
    expect(createPackageTestPlan(['src/main/settings/service.ts'], registry)).toMatchObject({
      selected: [],
      excluded: [core, providers, mcp]
    })
  })
  it('selects the changed package without testing upstream or unrelated siblings', () => {
    expect(createPackageTestPlan([`${providers}/src/provider.ts`], registry)).toMatchObject({
      selected: [providers],
      excluded: [core, mcp]
    })
  })
  it('propagates upstream changes to every dependent package', () => {
    expect(createPackageTestPlan([`${core}/src/engine.ts`], registry)).toMatchObject({
      selected: [core, providers, mcp],
      excluded: []
    })
  })
  it.each([
    'package-lock.json',
    'package.json',
    '.nvmrc',
    'vitest.config.ts',
    'tsconfig.node.json',
    'test/setup.ts',
    'scripts/build.mjs',
    '.github/workflows/pr-gate.yml',
    'packages/unknown/index.ts',
    'unclassified/input.bin'
  ])('keeps all package tests for shared or unknown input %s', (path) => {
    expect(createPackageTestPlan([path], registry).excluded).toEqual([])
  })
  it.each(['package.json', 'vitest.config.ts', 'README.md', 'src/provider.test.ts'])(
    'selects a package for its own input %s',
    (path) => {
      expect(createPackageTestPlan([`${providers}/${path}`], registry).selected).toEqual([
        providers
      ])
    }
  )
  it('rejects invalid roots, missing dependencies, duplicates and dependency cycles', () => {
    for (const packages of [
      [{ root: 'src', dependencies: [] }],
      [{ root: 'packages/../src', dependencies: [] }],
      [{ root: core, dependencies: ['packages/missing'] }],
      [registry.packages[0], registry.packages[0]],
      [{ root: core, dependencies: [providers] }, registry.packages[1]]
    ])
      expect(() => validatePackageTestRegistry({ schemaVersion: 1, packages })).toThrow()
  })
  it('leaves local npm test unchanged and rejects invalid CI exclusions', () => {
    const exclusions = { OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify([core]) }
    expect(packageTestExcludePatterns(exclusions)).toEqual([])
    expect(packageTestExcludePatterns({ ...exclusions, VITEST_PORTABLE_CI: '1' })).toEqual([
      `${core}/**`
    ])
    expect(() =>
      packageTestExcludePatterns({
        VITEST_PORTABLE_CI: '1',
        OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: '["src/**"]'
      })
    ).toThrow()
  })
})

it('uses only trusted registry data, includes renames/deletions and preserves synthetic-merge changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'package-impact-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const write = (path: string, value: string): void => {
    const full = join(cwd, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, value)
  }
  try {
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    write('scripts/ci/package-test-boundaries.json', JSON.stringify(registry))
    write(
      'scripts/ci/package-test-impact.mjs',
      readFileSync('scripts/ci/package-test-impact.mjs', 'utf8')
    )
    for (const entry of registry.packages)
      write(
        `${entry.root}/package.json`,
        JSON.stringify({
          name: entry.root,
          scripts: { test: 'vitest run' },
          dependencies: Object.fromEntries(entry.dependencies.map((root) => [root, '*']))
        })
      )
    write(`${core}/src/index.ts`, 'export const value = 1\n')
    write('src/host.ts', 'export const value = 1\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    write('src/host.ts', 'export const value = 2\n')
    git('add', '.')
    git('commit', '-qm', 'host')
    const head = git('rev-parse', 'HEAD')
    expect(packageTestPlanFromRevisions(base, head, base, { cwd }).excluded).toEqual([
      core,
      providers,
      mcp
    ])
    const action = parse(readFileSync('.github/actions/select-package-tests/action.yml', 'utf8'))
    const githubEnv = join(cwd, 'github-env')
    const runAction = (enabled: string): string => {
      writeFileSync(githubEnv, '')
      execFileSync('bash', ['-c', action.runs.steps[0].run], {
        cwd,
        env: {
          ...process.env,
          RUNNER_TEMP: cwd,
          GITHUB_ENV: githubEnv,
          BASE_SHA: base,
          HEAD_SHA: head,
          TRUSTED_BASE_SHA: base,
          PACKAGE_SELECTION_ENABLED: enabled
        }
      })
      return readFileSync(githubEnv, 'utf8')
    }
    expect(runAction('true')).toContain(
      `OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS=${JSON.stringify([core, providers, mcp])}`
    )
    expect(runAction('false')).toBe(
      'OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS=[]\nOPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS=[]\n'
    )
    git('mv', `${core}/src/index.ts`, `${core}/src/renamed.ts`)
    git('commit', '-qm', 'merge-side core change')
    expect(packageTestPlanFromRevisions(base, head, base, { cwd }).excluded).toEqual([])
    git('rm', `${core}/src/renamed.ts`)
    git('commit', '-qm', 'delete core source')
    expect(packageTestPlanFromRevisions(head, 'HEAD', base, { cwd }).excluded).toEqual([])
    write('scripts/ci/package-test-boundaries.json', '{"schemaVersion":1,"packages":[]}')
    git('add', '.')
    git('commit', '-qm', 'candidate attempts exclusion policy edit')
    expect(packageTestPlanFromRevisions(base, 'HEAD', base, { cwd }).excluded).toEqual([])
    expect(packageTestPlanFromRevisions(base, head, 'missing-revision', { cwd })).toMatchObject({
      selected: ['packages'],
      excluded: []
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('applies exclusions to real Vitest discovery across inherited projects while local discovery stays complete', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'package-vitest-discovery-'))
  const cwd = process.cwd()
  try {
    for (const path of [
      'src/host.test.ts',
      'packages/core/src/core.test.ts',
      'packages/core/src/core.architecture.test.ts',
      'packages/core/src/core.integration.test.ts'
    ]) {
      const file = join(fixture, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'import { it } from "vitest"; it("fixture", () => {})\n')
    }
    const list = (portable: string): Array<{ file: string }> =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            join(cwd, 'node_modules/vitest/vitest.mjs'),
            'list',
            '--config',
            join(cwd, 'vitest.config.ts'),
            '--root',
            fixture,
            '--filesOnly',
            '--json'
          ],
          {
            cwd,
            encoding: 'utf8',
            env: {
              ...process.env,
              VITEST_PORTABLE_CI: portable,
              OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify([core])
            }
          }
        )
      )
    expect(list('1').map(({ file }) => file)).toEqual([join(fixture, 'src/host.test.ts')])
    expect(list('0')).toHaveLength(4)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

it.each(['dependencies', 'unavailable'] as const)(
  'executes all required package tests in a real selective shard: %s',
  (evidence) => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'package-selective-shard-')))
    try {
      symlinkSync(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'junction')
      writeFileSync(join(cwd, 'package.json'), '{"type":"module","scripts":{"test":"vitest run"}}')
      writeFileSync(join(cwd, 'vitest.config.ts'), 'export default { test: { maxWorkers: 1 } }')
      for (const root of [core, providers, mcp]) {
        mkdirSync(join(cwd, root), { recursive: true })
        writeFileSync(
          join(cwd, root, 'contract.test.ts'),
          'import { it, expect } from "vitest"; it("package contract", () => expect(true).toBe(true))'
        )
      }
      const plan =
        evidence === 'dependencies'
          ? createPackageTestPlan([`${core}/src/engine.ts`], registry)
          : packageTestPlanFromRevisions('missing', 'missing', 'missing', { cwd })
      expect(
        executeModuleTestPlan(
          {
            mode: 'selective',
            modules: [],
            testFiles: [`${core}/contract.test.ts`],
            graphStatus: 'not-used',
            capabilityOverlays: [],
            fallbackCapabilities: [],
            reasonChains: []
          },
          {
            cwd,
            environment: {
              ...process.env,
              VITEST_PORTABLE_CI: '1',
              OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: JSON.stringify(plan.selected)
            },
            testArguments: ['--shard=1/1', '--reporter=json', '--outputFile=result.json']
          }
        )
      ).toBe(0)
      const report = JSON.parse(readFileSync(join(cwd, 'result.json'), 'utf8'))
      expect(report.numPassedTests).toBe(3)
      expect(report.testResults.map(({ name }: { name: string }) => name).sort()).toEqual(
        [core, providers, mcp].map((root) => join(cwd, root, 'contract.test.ts')).sort()
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)

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
import { join, normalize, sep } from 'node:path'
import { parse } from 'yaml'
import { executeModuleTestPlan } from './module-test-impact.mjs'
import { describe, expect, it } from 'vitest'
import {
  createPackageTestPlan,
  dedicatedPackageTestRoots,
  verificationFamilies,
  packageTestExcludePatterns,
  notebookPackageVerificationPlan,
  environmentPackageVerificationPlan,
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
    '.github/workflows/pr-gate.yml',
    'scripts/build-dev-packages.mjs',
    'scripts/check-packages.mjs',
    'scripts/ci/package-test-impact.mjs',
    'packages/unknown/index.ts',
    'unclassified/input.bin'
  ])('keeps all package tests for shared or unknown input %s', (path) => {
    expect(createPackageTestPlan([path], registry).excluded).toEqual([])
  })
  it.each(['scripts/build.mjs', 'scripts/ci/classify-pr-changes.mjs', 'test/fixtures/case.jsonl'])(
    'excludes unchanged package units for non-package evidence %s',
    (path) => {
      expect(createPackageTestPlan([path], registry)).toMatchObject({
        selected: [],
        excluded: [core, providers, mcp]
      })
    }
  )
  it('keeps the CI install wrapper global', () => {
    expect(createPackageTestPlan(['scripts/ci/npm-ci.mjs'], registry).excluded).toEqual([])
  })
  it.each(['package.json', 'vitest.config.ts', 'README.md', 'src/provider.test.ts'])(
    'selects a package for its own input %s',
    (path) => {
      expect(createPackageTestPlan([`${providers}/${path}`], registry).selected).toEqual([
        providers
      ])
    }
  )
  it.each(dedicatedPackageTestRoots)('keeps %s in its dedicated lane', (root) => {
    for (const verification of [false, true]) {
      expect(
        createPackageTestPlan([`${root}/src/change.ts`], registry, { verification })
      ).toMatchObject({ selected: [], excluded: [core, providers, mcp] })
      expect(
        createPackageTestPlan([`${root}/package.json`, `${providers}/src/provider.ts`], registry, {
          verification
        }).selected
      ).toEqual([providers])
      for (const unknown of [
        `${root}-new/src/change.ts`,
        'packages/new-package/index.ts',
        'package-lock.json'
      ])
        expect(
          createPackageTestPlan([`${root}/src/change.ts`, unknown], registry, { verification })
            .excluded
        ).toEqual([])
      // Registration takes precedence if a dedicated package gains an independent suite later.
      expect(
        createPackageTestPlan(
          [`${root}/src/change.ts`],
          { ...registry, packages: [...registry.packages, { root, dependencies: [core] }] },
          { verification }
        ).selected
      ).toEqual([root])
    }
  })
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
          PACKAGE_SELECTION_ENABLED: enabled,
          PACKAGE_VERIFICATION: 'true'
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
      'packages/core/src/core.integration.test.ts',
      'packages/compute/src/compute.test.ts',
      'packages/compute/src/compute.architecture.test.ts',
      'packages/compute/src/compute.integration.test.ts',
      'packages/durable-files/src/publication.test.ts',
      'packages/durable-files/src/publication.architecture.test.ts',
      'packages/durable-files/src/publication.integration.test.ts',
      'packages/resilient-download/src/transport.test.ts',
      'packages/providers/src/client.test.ts'
    ]) {
      const file = join(fixture, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'import { it } from "vitest"; it("fixture", () => {})\n')
    }
    writeFileSync(
      join(fixture, 'packages/compute/vitest.config.ts'),
      `export default {root: ${JSON.stringify(join(fixture, 'packages/compute'))}, test: {name:'compute',include:['src/**/*.test.ts']}}`
    )
    writeFileSync(
      join(fixture, 'packages/durable-files/vitest.config.ts'),
      `export default {root: ${JSON.stringify(join(fixture, 'packages/durable-files'))}, test: {name:'durable-files',include:['src/**/*.test.ts']}}`
    )
    writeFileSync(
      join(fixture, 'packages/resilient-download/vitest.config.ts'),
      `export default {root: ${JSON.stringify(join(fixture, 'packages/resilient-download'))}, test: {name:'resilient-download',include:['src/**/*.test.ts']}}`
    )
    writeFileSync(
      join(fixture, 'packages/providers/vitest.config.ts'),
      `export default {root: ${JSON.stringify(join(fixture, 'packages/providers'))}, test: {name:'providers',include:['src/**/*.test.ts']}}`
    )
    const literaturePackages = [
      'pdf-structure',
      'pdf-translation',
      'literature-citations',
      'journal-catalog',
      'literature-discovery',
      'literature-screening',
      'literature-library',
      'literature-reading'
    ]
    for (const name of literaturePackages) {
      const root = join(fixture, 'packages', name)
      mkdirSync(join(root, 'test'), { recursive: true })
      writeFileSync(
        join(root, 'test/contract.test.ts'),
        'import { it } from "vitest"; it("contract", () => {})'
      )
      writeFileSync(
        join(root, 'vitest.config.ts'),
        `export default {root: ${JSON.stringify(root)}, test: {name: ${JSON.stringify(name)}, include: ['test/**/*.test.ts']}}`
      )
    }
    const list = (portable: string, excluded = [core], scope = ''): Array<{ file: string }> =>
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
              OPEN_SCIENCE_CI_PORTABLE_SCOPE: scope,
              OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(excluded)
            }
          }
        )
      )
    expect(
      list('1', [
        core,
        'packages/compute',
        'packages/durable-files',
        'packages/resilient-download',
        'packages/providers',
        ...literaturePackages.map((name) => `packages/${name}`)
      ]).map(({ file }) => normalize(file))
    ).toEqual([join(fixture, 'src/host.test.ts')])
    // A trusted baseline predating these standalone packages must still discover the new package, exactly once.
    expect(
      list('1')
        .map(({ file }) => normalize(file))
        .sort()
    ).toEqual(
      [
        'src/host.test.ts',
        'packages/compute/src/compute.test.ts',
        'packages/compute/src/compute.architecture.test.ts',
        'packages/compute/src/compute.integration.test.ts',
        'packages/durable-files/src/publication.test.ts',
        'packages/durable-files/src/publication.architecture.test.ts',
        'packages/durable-files/src/publication.integration.test.ts',
        'packages/resilient-download/src/transport.test.ts',
        'packages/providers/src/client.test.ts',
        ...literaturePackages.map((name) => `packages/${name}/test/contract.test.ts`)
      ]
        .map((file) => join(fixture, file))
        .sort()
    )
    expect(list('0')).toHaveLength(20)
    // Include roots beyond today's directory inventory: partitioning must not drop future host tests.
    for (const path of ['root.test.ts', 'future-host/nested/new.test.ts']) {
      const file = join(fixture, path)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, 'import { it } from "vitest"; it("fixture", () => {})\n')
    }
    for (const excluded of [[], [core, 'packages/compute']]) {
      const files = (scope: string): string[] =>
        list('1', excluded, scope)
          .map(({ file }) => normalize(file))
          .sort()
      const baseline = files('')
      const host = files('host')
      const packages = files('packages')
      expect(host).toHaveLength(3)
      expect(packages.length).toBeGreaterThan(0)
      expect(host.every((file) => !file.startsWith(join(fixture, 'packages') + sep))).toBe(true)
      expect(packages.every((file) => file.startsWith(join(fixture, 'packages') + sep))).toBe(true)
      expect(new Set([...host, ...packages]).size).toBe(host.length + packages.length)
      expect([...host, ...packages].sort()).toEqual(baseline)
    }
    expect(list('0', [], 'host')).toHaveLength(22)
    expect(list('0', [], 'packages')).toHaveLength(22)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

it.each(['dependencies', 'unavailable', 'pr'] as const)(
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
        evidence !== 'unavailable'
          ? createPackageTestPlan([`${core}/src/engine.ts`], registry)
          : packageTestPlanFromRevisions('missing', 'missing', 'missing', { cwd })
      expect(
        executeModuleTestPlan(
          {
            mode: 'selective',
            modules: [],
            testFiles: [`${core}/contract.test.ts`],
            deferredPackageRoots: evidence === 'pr' ? [providers, mcp] : [],
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
      expect(report.numPassedTests).toBe(evidence === 'pr' ? 1 : 3)
      expect(
        report.testResults.map(({ name }: { name: string }) => normalize(name)).sort()
      ).toEqual(
        (evidence === 'pr' ? [core] : [core, providers, mcp])
          .map((root) => join(cwd, root, 'contract.test.ts'))
          .sort()
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)

it.each([
  [
    'packages/environment/src/environment-state-tracker.ts',
    ['packages/environment', 'packages/reproducibility']
  ],
  ['src/main/session-diagnostics/notebook.ts', []],
  [
    'packages/diagnostics/src/diagnostic-redaction.ts',
    [
      'packages/diagnostics',
      'packages/environment',
      'packages/compute',
      'packages/reproducibility',
      'packages/providers'
    ]
  ],
  [
    'packages/diagnostics/src/node.ts',
    [
      'packages/diagnostics',
      'packages/environment',
      'packages/compute',
      'packages/reproducibility',
      'packages/providers'
    ]
  ]
])('applies the real diagnostics registration to %s', (path, selected) => {
  const registered = JSON.parse(readFileSync('scripts/ci/package-test-boundaries.json', 'utf8'))
  const plan = createPackageTestPlan([path], registered)
  expect(plan.selected).toEqual(selected)
  expect(plan.excluded).toContain('packages/connector-core')
  expect(plan.excluded).toContain('packages/connector-builtins')
  expect(plan.excluded).toContain('packages/connector-mcp-client')
  if (selected.length === 0) expect(plan.excluded).toContain('packages/diagnostics')
})

it('keeps Notebook package tests directional while retaining shared syntax consumers', () => {
  const actual = JSON.parse(readFileSync('scripts/ci/package-test-boundaries.json', 'utf8'))
  const syntax = 'packages/notebook-syntax'
  const risk = 'packages/notebook-code-risk'
  const analysis = 'packages/notebook-analysis'
  expect(createPackageTestPlan(['src/main/notebook/runtime-service.ts'], actual).selected).toEqual(
    []
  )
  expect(
    createPackageTestPlan([`${analysis}/src/dependency-analysis.ts`], actual).selected
  ).toEqual([analysis, 'packages/reproducibility'])
  expect(createPackageTestPlan([`${risk}/src/index.ts`], actual).selected).toEqual([risk])
  expect(
    createPackageTestPlan([`${syntax}/assets/tree-sitter-python.wasm`], actual).selected
  ).toEqual([syntax, risk, analysis, 'packages/reproducibility'])
})

it.each([
  [[], [], []],
  [
    ['packages/notebook-code-risk'],
    ['notebook-syntax', 'notebook-code-risk'],
    ['notebook-code-risk']
  ],
  [['packages/notebook-analysis'], ['notebook-syntax', 'notebook-analysis'], ['notebook-analysis']],
  [
    ['packages/notebook-syntax', 'packages/notebook-code-risk', 'packages/notebook-analysis'],
    ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis'],
    ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis']
  ],
  [['packages/diagnostics'], [], []],
  [
    undefined,
    ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis'],
    ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis']
  ],
  [
    ['packages'],
    ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis'],
    ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis']
  ]
])('verifies only selected packages with build-only prerequisites: %j', (roots, builds, tests) => {
  expect(notebookPackageVerificationPlan(roots)).toEqual({ builds, tests })
})

it('verifies new packages absent from an older trusted registry instead of silently skipping bootstrap', () => {
  expect(
    notebookPackageVerificationPlan(['packages/diagnostics'], ['packages/connector-core']).tests
  ).toEqual(['notebook-syntax', 'notebook-code-risk', 'notebook-analysis'])
  expect(
    notebookPackageVerificationPlan(
      [],
      ['packages/notebook-syntax', 'packages/notebook-code-risk', 'packages/notebook-analysis']
    )
  ).toEqual({ builds: [], tests: [] })
  expect(
    notebookPackageVerificationPlan(
      ['packages/notebook-analysis'],
      ['packages/notebook-syntax', 'packages/notebook-code-risk']
    )
  ).toEqual({ builds: ['notebook-syntax', 'notebook-analysis'], tests: ['notebook-analysis'] })
  expect(notebookPackageVerificationPlan([], []).tests).toHaveLength(3)
  expect(() => notebookPackageVerificationPlan([], ['../untrusted'])).toThrow(
    'Invalid package verification roots'
  )
})

it('keeps environment verification directional and requires explicit trusted exclusion', () => {
  const verify = { builds: ['diagnostics', 'environment'], tests: ['environment'] }
  expect(environmentPackageVerificationPlan(undefined, undefined)).toEqual(verify)
  expect(environmentPackageVerificationPlan([], [])).toEqual(verify)
  expect(environmentPackageVerificationPlan([], undefined)).toEqual(verify)
  expect(
    environmentPackageVerificationPlan(['packages/environment'], ['packages/diagnostics'])
  ).toEqual(verify)
  expect(environmentPackageVerificationPlan(['packages'], ['packages/environment'])).toEqual(verify)
  expect(environmentPackageVerificationPlan([], ['packages/environment'])).toEqual({
    builds: [],
    tests: []
  })
  expect(() => environmentPackageVerificationPlan(['../environment'], [])).toThrow('Invalid')
  expect(() => environmentPackageVerificationPlan([], [42])).toThrow('Invalid')
})

it('skips unchanged environment units for host edits and retains downstream contracts for package edits', async () => {
  const { createAffectedTestPlan } = await import('./module-test-impact.mjs')
  const graph = { status: 'not-used', testFiles: [] }
  const host = createAffectedTestPlan(
    [{ path: 'src/main/notebook/runtime-service.ts', status: 'modified' }],
    graph
  )
  expect(host.mode).toBe('selective')
  expect(host.testFiles.some((path) => path.startsWith('packages/environment/'))).toBe(false)
  expect(host.testFiles).toContain('src/main/notebook/runtime-service.test.ts')
  const environment = createAffectedTestPlan(
    [{ path: 'packages/environment/src/environment-state-tracker.ts', status: 'modified' }],
    graph
  )
  expect(environment.mode).toBe('selective')
  expect(environment.testFiles).toContain(
    'packages/environment/src/environment-state-tracker.test.ts'
  )
  expect(environment.testFiles).toContain('src/main/notebook/environment-capture.contract.test.ts')
  expect(environment.testFiles).toContain('src/main/notebook/environment-process.contract.test.ts')
  expect(environment.testFiles.some((path) => path.startsWith('packages/diagnostics/'))).toBe(false)
})

it.each([
  'src/main/windows-executable-trust.ts',
  'src/main/notebook/environment-runner.ts',
  'src/main/notebook/environment-resources.ts',
  'src/main/notebook/shell-process.ts'
])('keeps environment units excluded for host policy edits to %s', (path) => {
  const actualRegistry = JSON.parse(readFileSync('scripts/ci/package-test-boundaries.json', 'utf8'))
  expect(createPackageTestPlan([path], actualRegistry)).toMatchObject({
    selected: [],
    excluded: expect.arrayContaining(['packages/environment'])
  })
})

it.each([
  'src/main/artifacts/reproducibility-host.ts',
  'src/main/artifacts/artifact-reproducibility-lifecycle.ts',
  'src/main/notebook/reproduction-runtime.ts',
  'src/main/artifacts/session-reproducibility-store.ts'
])(
  'keeps unchanged reproduction units excluded when only host behavior changes: %s',
  async (path) => {
    const { createAffectedTestPlan } = await import('./module-test-impact.mjs')
    const plan = createAffectedTestPlan([{ path, status: 'modified' }], {
      status: 'not-used',
      testFiles: []
    })
    expect(plan.mode).toBe('selective')
    expect(plan.testFiles.some((file) => file.startsWith('packages/reproducibility/'))).toBe(false)
  }
)

describe('installed-consumer input selection', () => {
  const actual = JSON.parse(readFileSync('scripts/ci/package-test-boundaries.json', 'utf8'))
  const select = (paths: string[]): ReturnType<typeof createPackageTestPlan> =>
    createPackageTestPlan(paths, actual, { verification: true })
  it.each([
    'src/main/application-events.ts',
    'docs/package-workflows.md',
    'README.md',
    '.github/workflows/source-regression.yml',
    'scripts/ci/windows-test-sequencer.test.ts',
    'scripts/ci/package-test-impact.test.ts',
    'scripts/package-verification-plan.test.ts',
    'scripts/ci/module-test-impact.mjs',
    'test/config/vite.browser-test.config.test.ts',
    'test/fixtures/pdf-translation/adam-parenthetical-native-body.jsonl',
    'e2e/session-diagnostics.spec.ts',
    'electron.vite.config.ts',
    'vite.web.config.ts'
  ])('does not install packages for unrelated input %s', (path) => {
    expect(select([path]).selected).toEqual([])
    expect(select([path]).excluded).toHaveLength(actual.packages.length)
  })
  it('does not install packages for the complete scheduled-regression repair from PR 3478', () => {
    expect(
      select([
        'e2e/reproducibility-preview.spec.ts',
        'e2e/session-diagnostics.spec.ts',
        'e2e/vite.browser-test.config.ts',
        'scripts/ci/module-test-impact.mjs',
        'scripts/ci/module-test-impact.test.ts',
        'scripts/ci/package-test-impact.test.ts',
        'scripts/ci/windows-test-sequencer.test.ts',
        'scripts/ci/windows-test-sequencer.ts',
        'scripts/electron-vite-config.test.ts',
        'scripts/runtime-archives.mjs',
        'scripts/runtime-archives.test.ts',
        'src/main/agents/completion-gate.execute-control.integration.test.ts',
        'src/main/delegation/production-composition.test.ts',
        'src/main/notebook/runtime-service.test.ts',
        'src/main/session-package/service.test.ts',
        'test/config/vite.browser-test.config.test.ts'
      ]).selected
    ).toEqual([])
  })
  it('keeps mixed package/host edits directional and only builds upstream prerequisites', async () => {
    const { packageVerificationPlan } = await import('../package-verification-plan.mjs')
    const plan = select(['src/main/application-events.ts', 'packages/pdf-translation/src/index.ts'])
    expect(plan.selected).toEqual(['packages/pdf-translation'])
    expect(packageVerificationPlan(actual, plan.selected, plan.excluded)).toEqual({
      builds: ['packages/pdf-structure', 'packages/pdf-translation'],
      tests: ['packages/pdf-translation']
    })
    expect(select(['packages/pdf-structure/src/index.ts']).selected).toEqual([
      'packages/pdf-structure',
      'packages/pdf-translation'
    ])
  })
  it.each([
    'package.json',
    'package-lock.json',
    '.npmrc',
    '.nvmrc',
    'tsconfig.packages.json',
    'vitest.config.ts',
    'scripts/package-verification-plan.mjs',
    'scripts/check-packages.mjs',
    'scripts/build-dev-packages.mjs',
    'scripts/ci/package-test-boundaries.json',
    'scripts/ci/package-test-impact.mjs',
    'scripts/ci/npm-ci.mjs',
    '.github/actions/verify-packages/action.yml',
    '.github/actions/select-package-tests/action.yml',
    'packages/new-package/src/index.ts',
    'unknown/input.bin',
    'scripts/unknown-build-helper.mjs',
    'scripts/ci/unknown-build-helper.mjs'
  ])('retains every package for shared or unknown verification input %s', (path) => {
    expect(select([path]).excluded).toEqual([])
  })
  it.each(verificationFamilies)(
    'selects consumers of $script without unrelated packages',
    ({ script, packages }) => {
      const plan = select([`scripts/${script.replace(':', '-')}.mjs`])
      expect(plan.selected).toEqual(
        expect.arrayContaining(packages.map((name: string) => `packages/${name}`))
      )
      expect(plan.excluded.length).toBeGreaterThan(0)
    }
  )
  it('does not let verification rules narrow portable test or ownership policy', () => {
    expect(select(['scripts/ci/module-test-impact.mjs']).selected).toEqual([])
    expect(createPackageTestPlan(['scripts/ci/module-test-impact.mjs'], actual).excluded).toEqual(
      []
    )
  })
})

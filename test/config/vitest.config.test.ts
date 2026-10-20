import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import WindowsTestSequencer from '../../scripts/ci/windows-test-sequencer'

import vitestConfig, {
  CHANGED_SOURCE_COVERAGE_THRESHOLDS,
  coverageThresholdsEnabled,
  coverageThresholdsFor,
  FULL_COVERAGE_THRESHOLDS,
  fullSuiteShardAllowsEmptyProjects,
  resolveVitestMaxWorkers,
  portableTestScopeFor,
  VITEST_ARCHITECTURE_TEST_GLOBS,
  VITEST_COVERAGE_EXCLUDE_PATTERNS,
  VITEST_DATABASE_TEST_GLOBS,
  VITEST_EXCLUDE_PATTERNS,
  VITEST_PORTABLE_CI_EXCLUDE_PATTERNS,
  VITEST_PROCESS_TEST_GLOBS,
  vitestExcludePatternsFor
} from '../../vitest.config'

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

describe('Vitest discovery boundaries', () => {
  it('enables module-based sharding only in the Windows full-test profile', () => {
    expect(vitestConfig.test?.sequence?.sequencer).toBe(
      process.env.VITEST_WINDOWS_FULL_TEST === '1' ? WindowsTestSequencer : undefined
    )
  })
  it.each([
    '**/.pnpm-store/**',
    '**/tmp/**',
    '**/.worktrees/**',
    '**/.worktree/**',
    'docs/internal/**',
    'packages/credential-identity-probe-native/test/**'
  ])('excludes %s from recursive test discovery', (pattern) => {
    expect(VITEST_EXCLUDE_PATTERNS).toContain(pattern)
  })

  it('excludes duplicated platform checks only from portable CI shards', () => {
    expect(vitestExcludePatternsFor({})).not.toEqual(
      expect.arrayContaining([...VITEST_PORTABLE_CI_EXCLUDE_PATTERNS])
    )
    expect(vitestExcludePatternsFor({ VITEST_PORTABLE_CI: '1' })).toEqual(
      expect.arrayContaining([...VITEST_PORTABLE_CI_EXCLUDE_PATTERNS])
    )
  })

  it('limits partition selection to portable CI and rejects unknown scopes', () => {
    expect(portableTestScopeFor({ OPEN_SCIENCE_CI_PORTABLE_SCOPE: 'host' })).toBeUndefined()
    for (const scope of ['host', 'packages']) {
      expect(
        portableTestScopeFor({ VITEST_PORTABLE_CI: '1', OPEN_SCIENCE_CI_PORTABLE_SCOPE: scope })
      ).toBe(scope)
    }
    expect(() =>
      portableTestScopeFor({ VITEST_PORTABLE_CI: '1', OPEN_SCIENCE_CI_PORTABLE_SCOPE: 'other' })
    ).toThrow('Invalid CI portable test scope')
  })

  it('assigns the Plan context Shell sandbox check to the native isolation lanes', () => {
    const planContextTest = 'src/main/session-plan/plan-context-file.shell.integration.test.ts'
    const linuxFilesystemTest =
      'packages/notebook-network-sandbox/src/filesystem-enforcement.integration.test.ts'
    const normalExcludes = vitestExcludePatternsFor({})
    const portableExcludes = vitestExcludePatternsFor({ VITEST_PORTABLE_CI: '1' })

    expect(VITEST_PROCESS_TEST_GLOBS).toContain('**/*.integration.test.ts')
    expect(normalExcludes).not.toContain(planContextTest)
    expect(normalExcludes).not.toContain(linuxFilesystemTest)
    expect(portableExcludes).toContain(planContextTest)
    expect(portableExcludes).toContain(linuxFilesystemTest)
  })
})

it('excludes the Electron IPC composition root from coverage', () => {
  expect(VITEST_COVERAGE_EXCLUDE_PATTERNS).toContain('src/main/ipc.ts')
})

it('defers coverage thresholds only for explicit shard collection', () => {
  expect(coverageThresholdsEnabled({})).toBe(true)
  expect(coverageThresholdsEnabled({ VITEST_DEFER_COVERAGE_THRESHOLDS: '1' })).toBe(false)
  expect(coverageThresholdsEnabled({ VITEST_DEFER_COVERAGE_THRESHOLDS: '0' })).toBe(true)
  expect(
    coverageThresholdsFor({
      VITEST_CHANGED_COVERAGE_THRESHOLDS: '1',
      VITEST_DEFER_COVERAGE_THRESHOLDS: '1'
    })
  ).toBeUndefined()
})

it('allows an empty Vitest project only during explicit shard collection', () => {
  expect(fullSuiteShardAllowsEmptyProjects(['vitest', 'run', '--shard=1/2'])).toBe(true)
  expect(fullSuiteShardAllowsEmptyProjects(['vitest', 'run', '--shard', '2/2'])).toBe(true)
  expect(fullSuiteShardAllowsEmptyProjects(['vitest', 'run'])).toBe(false)
  expect(vitestConfig.test?.passWithNoTests).toBe(fullSuiteShardAllowsEmptyProjects(process.argv))
})

it('ratchets full coverage without raising selective changed-source thresholds', () => {
  expect(FULL_COVERAGE_THRESHOLDS).toEqual({
    lines: 90,
    functions: 88,
    branches: 79,
    statements: 88
  })
  expect(CHANGED_SOURCE_COVERAGE_THRESHOLDS).toEqual({
    lines: 66,
    functions: 62,
    branches: 57,
    statements: 64
  })
  expect(coverageThresholdsFor({})).toMatchObject(FULL_COVERAGE_THRESHOLDS)
  expect(coverageThresholdsFor({ VITEST_CHANGED_COVERAGE_THRESHOLDS: '1' })).toMatchObject(
    CHANGED_SOURCE_COVERAGE_THRESHOLDS
  )
  expect(coverageThresholdsFor({ VITEST_CHANGED_COVERAGE_THRESHOLDS: '0' })).toMatchObject(
    FULL_COVERAGE_THRESHOLDS
  )
  expect(vitestConfig.test?.coverage?.thresholds).toEqual(
    coverageThresholdsEnabled(process.env)
      ? expect.objectContaining(FULL_COVERAGE_THRESHOLDS)
      : undefined
  )
})

it('keeps a safe default timeout for schema-backed hooks', () => {
  expect(vitestConfig.test?.hookTimeout).toBe(
    process.env.VITEST_WINDOWS_FULL_TEST === '1' ? 60_000 : 30_000
  )
})

it.each([
  ['0', undefined, false],
  ['1', undefined, false],
  ['0', '2', false],
  ['1', '2', false],
  ['0', undefined, true],
  ['1', undefined, true],
  ['0', '2', true],
  ['1', '2', true]
])(
  'resolves real Vitest project budgets with Windows profile %s, worker cap %s and host-only selection %s',
  (profile, override, hostOnly) => {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createVitest } from 'vitest/node'
       const ctx = await createVitest('test', {
         watch: false, hookTimeout: 60000, testTimeout: 60000, maxWorkers: 1
       })
       try {
         console.log(JSON.stringify(ctx.projects.map(({ name, config }) => ({
           name, hookTimeout: config.hookTimeout, maxWorkers: config.maxWorkers,
           testTimeout: config.testTimeout
         }))))
       } finally { await ctx.close() }`
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VITEST_PORTABLE_CI: '1',
          OPEN_SCIENCE_CI_PORTABLE_SCOPE: '',
          OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(
            hostOnly
              ? [
                  'packages/resilient-download',
                  'packages/durable-files',
                  'packages/compute',
                  'packages/providers',
                  ...literaturePackages.map((name) => `packages/${name}`)
                ]
              : []
          ),
          OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: '[]',
          VITEST_WINDOWS_FULL_TEST: profile,
          OPEN_SCIENCE_TEST_MAX_WORKERS: override
        },
        encoding: 'utf8',
        timeout: 30_000
      }
    )
    expect(probe.error).toBeUndefined()
    expect(probe.status, probe.stderr).toBe(0)
    expect(
      JSON.parse(probe.stdout).sort((a: { name: string }, b: { name: string }) =>
        a.name.localeCompare(b.name)
      )
    ).toEqual(
      [
        ...['default', 'architecture', 'process', 'database'].map((name) => ({
          name,
          hookTimeout: profile === '1' ? 60_000 : 30_000,
          maxWorkers:
            profile === '1' || name !== 'default'
              ? 1
              : resolveVitestMaxWorkers(undefined, override),
          testTimeout: 60_000
        })),
        ...(hostOnly
          ? []
          : ['resilient-download', 'durable-files', 'compute', 'providers'].map((name) => ({
              name,
              hookTimeout: 10000,
              testTimeout: 60000
            }))),
        ...(hostOnly
          ? []
          : literaturePackages.map((name) => ({
              name,
              hookTimeout: 30000,
              testTimeout: 60000,
              maxWorkers:
                name === 'pdf-structure' ? Math.min(4, Math.max(availableParallelism() - 1, 1)) : 2
            })))
      ].sort((a, b) => a.name.localeCompare(b.name))
    )
  }
)

it('prints captured console output only for failed tests', () => {
  expect(vitestConfig.test?.silent).toBe('passed-only')
})

it('pins the full-suite worker cap to the machine rather than leaving it unbounded', () => {
  const available =
    typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
  expect(resolveVitestMaxWorkers(8)).toBe(7)
  expect(resolveVitestMaxWorkers(1)).toBe(1)
  expect(resolveVitestMaxWorkers(0)).toBe(1)
  expect(vitestConfig.test?.maxWorkers).toBe(
    process.env.VITEST_WINDOWS_FULL_TEST === '1'
      ? 1
      : resolveVitestMaxWorkers(available, process.env.OPEN_SCIENCE_TEST_MAX_WORKERS)
  )
})

type VitestProjectTest = {
  name: string
  include?: string[]
  exclude?: string[]
  isolate?: boolean
  fileParallelism?: boolean
  maxWorkers?: number
  sequence?: { groupOrder?: number }
}

const projectByName = (name: string): VitestProjectTest => {
  const projects = vitestConfig.test?.projects
  expect(Array.isArray(projects)).toBe(true)
  const project = (projects as Array<{ test?: { name?: string } }>).find(
    (candidate) => candidate.test?.name === name
  )
  expect(project, name).toBeDefined()
  return project!.test as VitestProjectTest
}

it('runs whole-tree architecture scans in one reused worker after the parallel unit pool', () => {
  expect(VITEST_ARCHITECTURE_TEST_GLOBS).toEqual([
    '**/*.architecture.test.ts',
    'scripts/ci/module-consumer-coverage.test.ts'
  ])
  const architecture = projectByName('architecture')
  expect(architecture.include).toEqual([...VITEST_ARCHITECTURE_TEST_GLOBS])
  expect(architecture.isolate).toBe(false)
  expect(architecture.fileParallelism).toBe(false)
  expect(architecture.maxWorkers).toBe(1)
  expect(architecture.sequence?.groupOrder).toBe(1)
  expect(projectByName('default').exclude).toEqual(
    expect.arrayContaining([...VITEST_ARCHITECTURE_TEST_GLOBS, ...VITEST_PROCESS_TEST_GLOBS])
  )
})

it('serializes real kernels, TCP servers, and integration files', () => {
  expect(VITEST_PROCESS_TEST_GLOBS).toEqual(
    expect.arrayContaining([
      '**/*.integration.test.ts',
      '**/*.certification.test.ts',
      'src/main/notebook/kernel-executor.test.ts',
      'src/main/local-rpc-transport.test.ts',
      'src/main/session-plan/plan-mcp-server.test.ts',
      'src/main/acp/mcp-http-host.test.ts'
    ])
  )
  expect(VITEST_PROCESS_TEST_GLOBS).not.toContain('scripts/database-migration-ledger-smoke.test.ts')
  const processProject = projectByName('process')
  expect(processProject.include).toEqual([...VITEST_PROCESS_TEST_GLOBS])
  expect(processProject.isolate).toBe(true)
  expect(processProject.fileParallelism).toBe(false)
  expect(processProject.maxWorkers).toBe(1)
})

it('serializes migration and Session package round trips after other schema-using projects', () => {
  expect(VITEST_DATABASE_TEST_GLOBS).toEqual([
    'scripts/database-migration-ledger-smoke.test.ts',
    'src/main/session-package/service.test.ts',
    'src/main/session-package/literature.test.ts',
    'src/main/session-package/fork.test.ts'
  ])
  const database = projectByName('database')
  expect(database.include).toEqual([...VITEST_DATABASE_TEST_GLOBS])
  expect(database.isolate).toBe(true)
  expect(database.fileParallelism).toBe(false)
  expect(database.maxWorkers).toBe(1)
  expect(database.sequence?.groupOrder).toBe(2)
  expect(projectByName('default').exclude).toEqual(
    expect.arrayContaining([...VITEST_DATABASE_TEST_GLOBS])
  )
})

it('does not treat a 50ms scheduler delay as ACP deadlock', () => {
  const sources = [
    'src/main/acp/handler-workflows.test.ts',
    'src/main/acp/ipc.test.ts',
    'src/main/acp/application-commands.test.ts',
    'src/main/acp/prompt-outcome-finalizer.test.ts'
  ].map((path) => readFileSync(path, 'utf8'))
  for (const source of sources) {
    expect(source).not.toMatch(/setTimeout\(\(\) => resolve\('(?:timed-out|blocked)'\), 50\)/)
  }
})

it.each(['', '0', '-1', '1.5', 'two', ' 2', '2 ', 'Infinity', '9007199254740992'])(
  'rejects invalid worker cap %j',
  (override) => {
    expect(() => resolveVitestMaxWorkers(8, override)).toThrow(
      'OPEN_SCIENCE_TEST_MAX_WORKERS must be a positive integer.'
    )
  }
)

it('accepts an explicit positive worker cap independently of available CPUs', () => {
  expect(resolveVitestMaxWorkers(8, '2')).toBe(2)
  expect(resolveVitestMaxWorkers(1, '4')).toBe(4)
})

it.each([false, true])(
  'discovers durable-files exactly once with package-owned setup (excluded=%s)',
  (excluded) => {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { createVitest } from 'vitest/node'
    const ctx = await createVitest('test', { watch: false })
    try {
      const specs = await ctx.globTestSpecifications(['packages/durable-files'])
      const project = ctx.projects.find(({name}) => name === 'durable-files')
      console.log(JSON.stringify({
        specs: specs.map((spec) => ({name: spec.project.name, path: spec.moduleId})),
        setup: project?.config.setupFiles,
        workers: project?.config.maxWorkers
      }))
    } finally { await ctx.close() }
  `
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          VITEST_PORTABLE_CI: '1',
          OPEN_SCIENCE_CI_PORTABLE_SCOPE: '',
          OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(
            excluded ? ['packages/durable-files'] : []
          ),
          OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: JSON.stringify(
            excluded ? [] : ['packages/durable-files']
          )
        }
      }
    )
    expect(probe.error).toBeUndefined()
    expect(probe.status, probe.stderr).toBe(0)
    const result = JSON.parse(probe.stdout)
    if (excluded) expect(result.specs).toEqual([])
    else {
      expect(result.specs).toHaveLength(4)
      expect(new Set(result.specs.map(({ path }: { path: string }) => path)).size).toBe(4)
      expect(result.specs.every(({ name }: { name: string }) => name === 'durable-files')).toBe(
        true
      )
      expect(result.setup).toEqual([])
      expect(result.workers).toBeUndefined()
    }
  }
)

it.each([false, true])(
  'discovers resilient-download exactly once with package-owned setup (excluded=%s)',
  (excluded) => {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { createVitest } from 'vitest/node'
    const ctx = await createVitest('test', { watch: false })
    try {
      const specs = await ctx.globTestSpecifications(['packages/resilient-download'])
      const project = ctx.projects.find(({name}) => name === 'resilient-download')
      console.log(JSON.stringify({
        specs: specs.map((spec) => ({name: spec.project.name, path: spec.moduleId})),
        setup: project?.config.setupFiles,
        workers: project?.config.maxWorkers
      }))
    } finally { await ctx.close() }
  `
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          VITEST_PORTABLE_CI: '1',
          OPEN_SCIENCE_CI_PORTABLE_SCOPE: '',
          OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(
            excluded ? ['packages/resilient-download'] : []
          ),
          OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS: JSON.stringify(
            excluded ? [] : ['packages/resilient-download']
          )
        }
      }
    )
    expect(probe.error).toBeUndefined()
    expect(probe.status, probe.stderr).toBe(0)
    const result = JSON.parse(probe.stdout)
    if (excluded) expect(result.specs).toEqual([])
    else {
      expect(result.specs).toHaveLength(3)
      expect(new Set(result.specs.map(({ path }: { path: string }) => path)).size).toBe(3)
      expect(
        result.specs.every(({ name }: { name: string }) => name === 'resilient-download')
      ).toBe(true)
      expect(result.setup).toEqual([])
      expect(result.workers).toBeUndefined()
    }
  }
)

it.each(['all', 'host', 'excluded'])(
  'keeps Literature/PDF discovery in package-owned projects (%s)',
  (selection) => {
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { createVitest } from 'vitest/node'
        import { readdirSync } from 'node:fs'
        import { resolve } from 'node:path'
        const names = ${JSON.stringify(literaturePackages)}
        const ctx = await createVitest('test', { watch: false })
        try {
          const specs = await ctx.globTestSpecifications(names.map(name => 'packages/' + name))
          console.log(JSON.stringify({
            specs: specs.map(spec => ({name: spec.project.name, path: spec.moduleId})),
            projects: ctx.projects.filter(project => names.includes(project.name)).map(({name, config, vite}) => ({
              name, setup: config.setupFiles,
              hostAliases: vite.config.resolve.alias.filter(({find}) => ['@', '@renderer', 'e-virt-table/dist/index.es.js'].includes(find))
            })),
            expected: names.flatMap(name => readdirSync('packages/' + name + '/test', {recursive: true})
              .filter(file => file.endsWith('.test.ts'))
              .map(file => resolve('packages/' + name + '/test', file)))
          }))
        } finally { await ctx.close() }
      `
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          VITEST_PORTABLE_CI: '1',
          OPEN_SCIENCE_CI_PORTABLE_SCOPE: selection === 'host' ? 'host' : '',
          OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS: JSON.stringify(
            selection === 'excluded' ? literaturePackages.map((name) => `packages/${name}`) : []
          )
        }
      }
    )
    expect(probe.error).toBeUndefined()
    expect(probe.status, probe.stderr).toBe(0)
    const result = JSON.parse(probe.stdout)
    if (selection !== 'all') {
      expect(result.specs).toEqual([])
      expect(result.projects).toEqual([])
      return
    }
    expect(result.projects).toHaveLength(literaturePackages.length)
    expect(result.expected.length).toBeGreaterThan(600)
    expect(result.specs.map(({ path }: { path: string }) => resolve(path)).sort()).toEqual(
      result.expected.sort()
    )
    for (const { name, path } of result.specs) {
      expect(literaturePackages).toContain(name)
      expect(path).toContain(`/packages/${name}/test/`)
    }
    for (const project of result.projects) {
      expect(project.setup).toEqual([])
      expect(project.hostAliases).toEqual([])
    }
  }
)

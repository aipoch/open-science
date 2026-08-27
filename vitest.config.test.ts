import { availableParallelism, cpus } from 'node:os'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import vitestConfig, {
  CHANGED_SOURCE_COVERAGE_THRESHOLDS,
  coverageThresholdsEnabled,
  coverageThresholdsFor,
  FULL_COVERAGE_THRESHOLDS,
  resolveVitestMaxWorkers,
  VITEST_ARCHITECTURE_TEST_GLOBS,
  VITEST_COVERAGE_EXCLUDE_PATTERNS,
  VITEST_EXCLUDE_PATTERNS,
  VITEST_PROCESS_TEST_GLOBS
} from './vitest.config'

describe('Vitest discovery boundaries', () => {
  it.each(['**/.pnpm-store/**', '**/tmp/**', '**/.worktrees/**', '**/.worktree/**'])(
    'excludes %s from recursive test discovery',
    (pattern) => {
      expect(VITEST_EXCLUDE_PATTERNS).toContain(pattern)
    }
  )
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

it('allows empty projects only while collecting deferred-coverage shards', () => {
  expect(vitestConfig.test?.passWithNoTests).toBe(!coverageThresholdsEnabled(process.env))
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
  expect(vitestConfig.test?.hookTimeout).toBe(30_000)
})

it('prints captured console output only for failed tests', () => {
  expect(vitestConfig.test?.silent).toBe('passed-only')
})

it('pins the full-suite worker cap to the machine rather than leaving it unbounded', () => {
  const available =
    typeof availableParallelism === 'function' ? availableParallelism() : cpus().length
  expect(resolveVitestMaxWorkers(8)).toBe(7)
  expect(resolveVitestMaxWorkers(1)).toBe(1)
  expect(resolveVitestMaxWorkers(0)).toBe(1)
  expect(vitestConfig.test?.maxWorkers).toBe(resolveVitestMaxWorkers())
  expect(vitestConfig.test?.maxWorkers).toBe(Math.max(available - 1, 1))
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
  expect(VITEST_ARCHITECTURE_TEST_GLOBS).toEqual(['**/*.architecture.test.ts'])
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

it('serializes real kernels, TCP servers, and integration files so they cannot starve the unit pool', () => {
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
  const processProject = projectByName('process')
  expect(processProject.include).toEqual([...VITEST_PROCESS_TEST_GLOBS])
  expect(processProject.isolate).toBe(true)
  expect(processProject.fileParallelism).toBe(false)
  expect(processProject.maxWorkers).toBe(1)
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

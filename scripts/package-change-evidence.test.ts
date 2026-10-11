import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  changedPackagePaths,
  classifyPackageChange,
  summarizeCi
} from './package-change-evidence.mjs'
const manifests = [
  {
    modules: {
      host: { ownerPaths: ['src/host.ts'] },
      library: {
        ownerPaths: ['packages/a/src/impl.ts', 'packages/a/src/index.ts'],
        interfacePaths: ['packages/a/src/index.ts']
      }
    }
  }
]
it('distinguishes real change categories while preserving uncertainty', () => {
  expect(classifyPackageChange(['src/host.ts'], manifests).category).toBe('host-only')
  expect(classifyPackageChange(['packages/a/src/impl.ts'], manifests).category).toBe(
    'package-implementation'
  )
  expect(
    classifyPackageChange(['packages/a/src/index.ts', 'src/host.ts'], manifests)
  ).toMatchObject({ category: 'public-contract-candidate', changedModules: ['host', 'library'] })
  expect(classifyPackageChange(['package.json'], manifests).category).toBe('mixed-or-uncertain')
})
it('keeps missing timing unavailable and separates queue, elapsed and summed job work', () => {
  expect(summarizeCi(null)).toBeNull()
  expect(
    summarizeCi({
      run_attempt: 2,
      created_at: '2026-01-01T00:00:00Z',
      run_started_at: '2026-01-01T00:10:00Z'
    }).queueMs
  ).toBeNull()
  const run = {
    created_at: '2026-01-01T00:00:00Z',
    run_started_at: '2026-01-01T00:00:10Z',
    jobs: [
      {
        name: 'a',
        conclusion: 'success',
        started_at: '2026-01-01T00:00:10Z',
        completed_at: '2026-01-01T00:00:20Z'
      },
      {
        name: 'b',
        conclusion: 'failure',
        started_at: '2026-01-01T00:00:10Z',
        completed_at: '2026-01-01T00:00:30Z'
      }
    ]
  }
  expect(
    summarizeCi({
      ...run,
      run_attempt: 2,
      jobs: run.jobs.map((job, index) => ({ ...job, run_attempt: index + 1 }))
    })
  ).toMatchObject({ executionMs: null, jobWorkMs: null, consistentAttempt: false })
  expect(summarizeCi(run)).toMatchObject({ queueMs: 10000, executionMs: 20000, jobWorkMs: 30000 })
  expect(summarizeCi({ ...run, jobs: [] })).toMatchObject({ executionMs: null, jobWorkMs: null })
})

it('counts both owners when Git detects a rename across module boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-change-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/old.ts'), 'export const value = 1\n')
    git('add', '.')
    git('commit', '-qm', 'baseline')
    const base = git('rev-parse', 'HEAD')
    renameSync(join(root, 'src/old.ts'), join(root, 'src/new.ts'))
    git('add', '.')
    git('commit', '-qm', 'move')
    expect(changedPackagePaths(base, 'HEAD', root).sort()).toEqual(['src/new.ts', 'src/old.ts'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

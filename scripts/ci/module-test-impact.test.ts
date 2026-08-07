import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  collectCodeGraphTests,
  createAffectedTestPlan,
  createModuleTestPlan,
  executeModuleTestPlan,
  formatModuleTestPlan
} from './module-test-impact.mjs'

const currentStatus = JSON.stringify({
  initialized: true,
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  worktreeMismatch: null,
  index: { state: 'complete', reindexRecommended: false }
})

describe('module test impact commands', () => {
  it('builds a deterministic declared-test plan for one module', () => {
    const plan = createModuleTestPlan('artifact_storage')

    expect(plan.mode).toBe('selective')
    expect(plan.modules).toEqual(['artifact_storage'])
    expect(plan.testFiles).toEqual([...plan.testFiles].sort())
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'src/main/artifacts/repository.test.ts',
        'src/main/artifacts/ipc.test.ts',
        'src/main/artifacts/provenance-repository.test.ts'
      ])
    )
    expect(() => createModuleTestPlan('unknown_module')).toThrow('Unknown module: unknown_module')
  })

  it('expands changed owners through consumer modules and graph candidates', () => {
    const plan = createAffectedTestPlan(
      [{ path: 'src/main/artifacts/repository.ts', status: 'modified' }],
      { status: 'current', testFiles: ['src/main/reviewer/ipc.test.ts'] }
    )

    expect(plan.mode).toBe('selective')
    expect(plan.modules).toEqual(['artifact_storage', 'artifact_provenance', 'session_persistence'])
    expect(plan.testFiles).toContain('src/main/reviewer/ipc.test.ts')
    expect(plan.reasonChains).toContain('artifact_storage -> artifact_provenance')
  })

  it('fails closed for unknown and destructive changes', () => {
    expect(
      createAffectedTestPlan([{ path: 'src/main/unknown-owner.ts', status: 'added' }], {
        status: 'current',
        testFiles: []
      }).mode
    ).toBe('full')
    expect(
      createAffectedTestPlan([{ path: 'src/main/artifacts/repository.ts', status: 'deleted' }], {
        status: 'current',
        testFiles: []
      }).mode
    ).toBe('full')
  })

  it('uses a current CodeGraph index and filters non-Vitest candidates', () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(currentStatus)
      .mockReturnValueOnce(
        JSON.stringify({
          affectedTests: [
            'src/main/artifacts/repository.test.ts',
            'e2e/certification/artifact-provenance.spec.ts',
            '../outside.test.ts',
            'src/main/artifacts/repository.ts'
          ]
        })
      )

    const graph = collectCodeGraphTests(['src/main/artifacts/repository.ts'], {
      cwd: '/repo',
      execute,
      pathExists: () => true
    })

    expect(graph).toEqual({
      status: 'current',
      testFiles: ['src/main/artifacts/repository.test.ts']
    })
    expect(execute).toHaveBeenLastCalledWith(
      'codegraph',
      ['affected', '--json', '--depth', '2', 'src/main/artifacts/repository.ts'],
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  it('falls back deterministically to the manifest for stale or unavailable CodeGraph', () => {
    const mismatch = JSON.stringify({
      ...JSON.parse(currentStatus),
      worktreeMismatch: { worktreeRoot: '/worktree', indexRoot: '/repo' }
    })
    expect(
      collectCodeGraphTests(['src/main/artifacts/repository.ts'], {
        execute: () => mismatch
      })
    ).toEqual({
      status: 'unavailable-manifest-only',
      reason: 'worktree index mismatch',
      testFiles: []
    })

    expect(
      collectCodeGraphTests(['src/main/artifacts/repository.ts'], {
        execute: () => {
          throw new Error('spawn codegraph ENOENT')
        }
      })
    ).toEqual({
      status: 'unavailable-manifest-only',
      reason: 'spawn codegraph ENOENT',
      testFiles: []
    })
  })

  it('prints the exact file list before invoking portable npm test arguments', () => {
    const plan = createModuleTestPlan('upload_repository')
    const spawn = vi.fn(() => ({ status: 0 }))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    expect(executeModuleTestPlan(plan, { cwd: '/repo', spawn })).toBe(0)
    expect(write).toHaveBeenCalledWith(formatModuleTestPlan(plan))
    expect(spawn).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['test', '--', ...plan.testFiles],
      expect.objectContaining({ cwd: '/repo', stdio: 'inherit' })
    )
    write.mockRestore()
  })

  it('keeps npm test as the complete portable suite', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

    expect(packageJson.scripts.test).toBe('vitest run')
    expect(packageJson.scripts['test:module']).toContain('module-test-impact.mjs module')
    expect(packageJson.scripts['test:affected']).toContain('module-test-impact.mjs affected')
  })
})

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { classifyChanges, prGateStage } from './classify-pr-changes.mjs'
import { evaluatePrGate } from './evaluate-pr-gate.mjs'

describe('PR Gate aggregation', () => {
  it('accepts shared execution bundles while preserving semantic lane selection', () => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['documentation'],
        lanes: ['policy', 'docs', 'format'],
        bundles: ['policy', 'static'],
        reasonChains: []
      },
      {
        preflight: 'success',
        policy: 'success',
        static: 'success',
        coverage_macos: 'skipped'
      },
      { executionMode: 'bundles' }
    )

    expect(result.ok).toBe(true)
    expect(result.selectedLanes).toEqual(['policy', 'docs', 'format'])
  })

  it('fails closed when bundle execution is requested without a bundle plan', () => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['documentation'],
        lanes: ['policy', 'docs'],
        reasonChains: []
      },
      { preflight: 'success', policy: 'success', static: 'success' },
      { executionMode: 'bundles' }
    )

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'execution bundle plan is missing'
    })
  })

  it('fails closed when the bundle plan is not an array', () => {
    expect(() =>
      evaluatePrGate(
        {
          schemaVersion: 1,
          mode: 'selective',
          roots: ['documentation'],
          lanes: ['policy', 'docs'],
          bundles: { policy: true },
          reasonChains: []
        },
        { preflight: 'success', policy: 'success' },
        { executionMode: 'bundles' }
      )
    ).not.toThrow()

    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['documentation'],
        lanes: ['policy', 'docs'],
        bundles: { policy: true },
        reasonChains: []
      },
      { preflight: 'success', policy: 'success' },
      { executionMode: 'bundles' }
    )

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'execution bundle plan is missing'
    })
  })

  it.each([
    ['empty', []],
    ['unknown', ['policy', 'unknown']],
    ['duplicate', ['policy', 'static', 'static']],
    ['missing', ['policy']],
    ['extra', ['policy', 'static', 'unit']]
  ])('fails closed when the bundle plan is %s', (_case, bundles) => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['documentation'],
        lanes: ['policy', 'docs'],
        bundles,
        reasonChains: []
      },
      { preflight: 'success', policy: 'success', static: 'success' },
      { executionMode: 'bundles' }
    )

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'execution bundle plan does not match selected lanes'
    })
  })

  it('fails closed for an unsupported execution mode', () => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: [],
        lanes: ['policy'],
        bundles: ['policy'],
        reasonChains: []
      },
      { preflight: 'success', policy: 'success' },
      { executionMode: 'typo' }
    )

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      lane: 'preflight',
      conclusion: 'invalid',
      reason: 'unsupported execution mode: typo'
    })
  })

  it('accepts a compact GitHub Actions plan that omits reason chains', () => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['documentation'],
        lanes: ['policy', 'docs', 'format'],
        bundles: ['policy', 'static']
      },
      {
        preflight: 'success',
        policy: 'success',
        static: 'success',
        coverage_macos: 'skipped'
      },
      { executionMode: 'bundles' }
    )

    expect(result.ok).toBe(true)
    expect(result.selectedBundles).toEqual(['policy', 'static'])
  })

  it('uses bundle execution mode through the trusted CLI interface', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/ci/evaluate-pr-gate.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: '',
        PR_GATE_EXECUTION_MODE: 'bundles',
        PR_GATE_PLAN: JSON.stringify({
          schemaVersion: 1,
          mode: 'selective',
          roots: ['documentation'],
          lanes: ['policy', 'docs'],
          bundles: ['policy', 'static'],
          reasonChains: []
        }),
        PR_GATE_NEEDS: JSON.stringify({
          preflight: { result: 'success' },
          policy: { result: 'success' },
          static: { result: 'success' }
        })
      }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Result: **pass**')
    expect(result.stdout).toContain('Execution bundles: policy, static')
  })

  it('publishes a successful aggregate result from GitHub needs JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-gate-evaluator-'))
    const summary = join(root, 'summary')

    try {
      const result = spawnSync(process.execPath, [resolve('scripts/ci/evaluate-pr-gate.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          PR_GATE_PLAN: JSON.stringify({
            schemaVersion: 1,
            mode: 'selective',
            roots: ['documentation'],
            lanes: ['policy', 'docs'],
            bundles: ['policy', 'static'],
            reasonChains: ['README.md -> documentation']
          }),
          PR_GATE_NEEDS: JSON.stringify({
            preflight: { result: 'success' },
            policy: { result: 'success' },
            docs: { result: 'success' },
            windows_path: { result: 'skipped' }
          })
        }
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(summary, 'utf8')).toContain('Result: **pass**')
      expect(readFileSync(summary, 'utf8')).toContain('policy, docs')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('fails when a selected lane is skipped', () => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['renderer_view'],
        lanes: ['policy', 'typecheck_web', 'e2e_visual_macos'],
        reasonChains: []
      },
      {
        preflight: 'success',
        policy: 'success',
        typecheck_web: 'success',
        e2e_visual_macos: 'skipped',
        windows_path: 'skipped'
      }
    )

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      lane: 'e2e_visual_macos',
      conclusion: 'skipped',
      reason: 'selected lane did not succeed'
    })
  })

  it('fails when an unselected lane executes unsuccessfully', () => {
    const result = evaluatePrGate(
      {
        schemaVersion: 1,
        mode: 'selective',
        roots: ['documentation'],
        lanes: ['policy', 'docs'],
        reasonChains: []
      },
      {
        preflight: 'success',
        policy: 'success',
        docs: 'success',
        windows_path: 'failure',
        e2e_visual_macos: 'skipped'
      }
    )

    expect(result.ok).toBe(false)
    expect(result.failures).toContainEqual({
      lane: 'windows_path',
      conclusion: 'failure',
      reason: 'unselected lane executed unsuccessfully'
    })
  })
})

describe('merge queue stage boundaries', () => {
  const plan = classifyChanges([{ path: 'package.json', status: 'modified' }])
  const deferred = ['linux_runtime', 'windows_core', 'macos_e2e', 'windows_e2e']
  const conclusions = Object.fromEntries([
    ['preflight', 'success'],
    ...plan.bundles.map((bundle) => [bundle, deferred.includes(bundle) ? 'skipped' : 'success'])
  ])

  it.each([
    ['pull_request', 'true', 'pr'],
    ['pull_request', undefined, 'full'],
    ['pull_request', 'false', 'full'],
    ['pull_request_target', 'true', 'full'],
    ['merge_group', 'true', 'full'],
    ['merge_group', undefined, 'full'],
    ['workflow_dispatch', 'true', 'full'],
    ['schedule', 'true', 'full']
  ])('resolves %s with rollout %s to %s', (event, enabled, expected) => {
    expect(prGateStage({ EVENT_NAME: event, PR_GATE_MERGE_QUEUE_ENABLED: enabled })).toBe(expected)
  })

  it('defers only platform bundles while keeping the full impact plan', () => {
    const result = evaluatePrGate(plan, conclusions, {
      executionMode: 'bundles',
      executionStage: 'pr'
    })
    expect(result.ok).toBe(true)
    expect(result.deferredExecutions).toEqual(deferred)
    expect(result.selectedLanes).toEqual(plan.lanes)
    expect(evaluatePrGate(plan, conclusions, { executionMode: 'bundles' }).ok).toBe(false)
  })

  it.each(['skipped', 'cancelled', 'failure', undefined])(
    'requires PR unit tests: %s',
    (conclusion) => {
      expect(
        evaluatePrGate(
          plan,
          { ...conclusions, unit: conclusion },
          {
            executionMode: 'bundles',
            executionStage: 'pr'
          }
        ).ok
      ).toBe(false)
    }
  )

  it.each(['cancelled', 'failure', undefined])(
    'does not hide unexpected deferred results: %s',
    (conclusion) => {
      expect(
        evaluatePrGate(
          plan,
          { ...conclusions, macos_e2e: conclusion },
          {
            executionMode: 'bundles',
            executionStage: 'pr'
          }
        ).ok
      ).toBe(false)
    }
  )

  it('reports deferred work without claiming native execution on the PR', () => {
    const run = spawnSync(process.execPath, [resolve('scripts/ci/evaluate-pr-gate.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        PR_GATE_MERGE_QUEUE_ENABLED: 'true',
        PR_GATE_STAGE: 'pr',
        PR_GATE_EXECUTION_MODE: 'bundles',
        PR_GATE_PLAN: JSON.stringify(plan),
        PR_GATE_NEEDS: JSON.stringify(
          Object.fromEntries(Object.entries(conclusions).map(([key, result]) => [key, { result }]))
        ),
        GITHUB_STEP_SUMMARY: ''
      }
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain(
      'Deferred to merge queue: linux_runtime, windows_core, macos_e2e, windows_e2e'
    )
    expect(run.stdout).toContain('portable PR feedback')
  })

  it('rejects PR-only deferral on a queue SHA even with the rollout enabled', () => {
    const run = spawnSync(process.execPath, [resolve('scripts/ci/evaluate-pr-gate.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: 'merge_group',
        PR_GATE_MERGE_QUEUE_ENABLED: 'true',
        PR_GATE_STAGE: 'pr',
        PR_GATE_EXECUTION_MODE: 'bundles',
        PR_GATE_PLAN: JSON.stringify(plan),
        PR_GATE_NEEDS: JSON.stringify(
          Object.fromEntries(Object.entries(conclusions).map(([key, result]) => [key, { result }]))
        ),
        GITHUB_STEP_SUMMARY: ''
      }
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('PR deferral is not enabled for this event')
  })
})

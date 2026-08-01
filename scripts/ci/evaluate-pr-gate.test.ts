import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluatePrGate } from './evaluate-pr-gate.mjs'

describe('PR Gate aggregation', () => {
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

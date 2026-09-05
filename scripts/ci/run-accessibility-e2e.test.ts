import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  EXPECTED_ACCESSIBILITY_SURFACES,
  publishInfrastructureFailure,
  readAccessibilityResult
} from './run-accessibility-e2e.mjs'

type CompleteResult = {
  schemaVersion: number
  status: 'passed' | 'advisory'
  plannedTests: number
  completedTests: number
  readyTests: number
  axeRunCount: number
  scans: Array<{ surface: string }>
}

const completeResult = (status: 'passed' | 'advisory'): CompleteResult => ({
  schemaVersion: 1,
  status,
  plannedTests: 11,
  completedTests: 11,
  readyTests: 11,
  axeRunCount: EXPECTED_ACCESSIBILITY_SURFACES.length,
  scans: EXPECTED_ACCESSIBILITY_SURFACES.map((surface) => ({ surface }))
})

describe('accessibility E2E result contract', () => {
  it.each(['passed', 'advisory'] as const)('accepts a versioned %s result', (status) => {
    const root = mkdtempSync(join(tmpdir(), 'accessibility-result-'))
    const path = join(root, 'summary.json')

    try {
      writeFileSync(path, JSON.stringify(completeResult(status)))
      expect(readAccessibilityResult(path)).toMatchObject({ status, axeRunCount: 18 })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it.each([
    { name: 'stale schema', result: { schemaVersion: 0, status: 'passed', axeRunCount: 12 } },
    { name: 'unknown status', result: { schemaVersion: 1, status: 'unknown', axeRunCount: 12 } },
    { name: 'missing axe count', result: { schemaVersion: 1, status: 'passed' } },
    { name: 'zero axe evidence', result: { ...completeResult('passed'), axeRunCount: 0 } },
    { name: 'missing surface evidence', result: { ...completeResult('passed'), scans: [] } },
    {
      name: 'unexpected surface evidence',
      result: {
        ...completeResult('passed'),
        scans: completeResult('passed').scans.map((scan, index) =>
          index === 0 ? { surface: 'Unexpected surface' } : scan
        )
      }
    },
    { name: 'incomplete ready evidence', result: { ...completeResult('passed'), readyTests: 10 } }
  ])('rejects $name', ({ result }) => {
    const root = mkdtempSync(join(tmpdir(), 'accessibility-result-'))
    const path = join(root, 'nested', 'summary.json')

    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(result))
      expect(() => readAccessibilityResult(path)).toThrow('invalid scan summary')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('publishes an infrastructure summary when Playwright cannot produce a result', () => {
    const root = mkdtempSync(join(tmpdir(), 'accessibility-summary-'))
    const summaryPath = join(root, 'step-summary.md')

    try {
      publishInfrastructureFailure(new Error('missing scan summary'), {
        GITHUB_STEP_SUMMARY: summaryPath
      })
      expect(readFileSync(summaryPath, 'utf8')).toContain('INFRA_FAILURE')
      expect(readFileSync(summaryPath, 'utf8')).toContain('missing scan summary')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

it('accepts complete evidence from the expanded responsive and contrast matrix', () => {
  const root = mkdtempSync(join(tmpdir(), 'accessibility-expanded-'))
  const path = join(root, 'summary.json')
  const surfaces = [
    ...EXPECTED_ACCESSIBILITY_SURFACES.slice(0, 12),
    'Home (375px, light)',
    'Home (375px, dark)',
    'Home (767px, light)',
    'Home (767px, dark)',
    'Reported text (light)',
    'Reported text (dark)'
  ]
  try {
    writeFileSync(
      path,
      JSON.stringify({
        ...completeResult('passed'),
        plannedTests: 11,
        completedTests: 11,
        readyTests: 11,
        axeRunCount: surfaces.length,
        scans: surfaces.map((surface) => ({ surface }))
      })
    )
    expect(readAccessibilityResult(path)).toMatchObject({
      status: 'passed',
      plannedTests: 11,
      axeRunCount: 18
    })
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

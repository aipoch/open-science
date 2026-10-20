/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import {
  assertEvidenceTestPassed,
  assertRuntimeEvidenceControl,
  evidenceRelativePath,
  renderRuntimeEvidence,
  runtimeEvidenceRows,
  runtimeEvidenceSample
} from './runtime-module-evidence.mjs'

const root = process.cwd()
const test = runtimeEvidenceSample.tests[0]
const source = runtimeEvidenceSample.sources[0]
const manifest = {
  modules: {
    sample: { ownerPaths: [source], testFiles: { owner: [test], consumer: [], contract: [] } }
  }
}
const coverage = () => ({ [join(root, source)]: { s: { 0: 0, 1: 2 }, f: { 0: 0 } } })

it('attributes compiled syntax ownership while retaining separate source and artifact counters', () => {
  const [artifact, ownedSource] = Object.entries(runtimeEvidenceSample.artifactSources)[0]
  const rows = runtimeEvidenceRows(
    test,
    {
      [join(root, artifact)]: { s: { 0: 4, 1: 0 }, f: { 0: 2 } },
      [join(root, ownedSource)]: { s: { 0: 0 }, f: { 0: 0 } }
    },
    {
      modules: {
        syntax: { ownerPaths: [ownedSource], testFiles: { consumer: [test] } }
      }
    },
    root
  )
  expect(rows.find((row) => row.source === artifact)).toMatchObject({
    modules: [{ id: 'syntax', registration: ['consumer'] }],
    observation: { statements: { hit: 1, total: 2 }, functions: { hit: 1, total: 1 } }
  })
  expect(rows.find((row) => row.source === ownedSource)?.observation.functions.hit).toBe(0)
})

it('requires real hits from positive controls without rejecting mocked zero-hit contracts', () => {
  const control = runtimeEvidenceSample.positiveControls[1]
  const row = { ...control, observation: { functions: { hit: 1, total: 10 } } }
  expect(() => assertRuntimeEvidenceControl(control.test, [row])).not.toThrow()
  expect(() => assertRuntimeEvidenceControl(control.test, [])).toThrow('Positive control')
  expect(() =>
    assertRuntimeEvidenceControl(control.test, [{ ...row, error: 'collection failed' }])
  ).toThrow('Positive control')
  expect(() =>
    assertRuntimeEvidenceControl(control.test, [{ ...row, test: 'another.test.ts' }])
  ).toThrow('Positive control')
  row.observation.functions.hit = 0
  expect(() => assertRuntimeEvidenceControl(control.test, [row])).toThrow('Positive control')
  expect(() =>
    assertRuntimeEvidenceControl(
      'packages/notebook-analysis/src/dependency-analysis-parser-unavailable.test.ts',
      [row]
    )
  ).not.toThrow()
})

it('distinguishes zero function hits from unavailable collection and retains registration', () => {
  const rows = runtimeEvidenceRows(test, coverage(), manifest, root)
  expect(rows[0]).toMatchObject({
    modules: [{ id: 'sample', registration: ['owner'] }],
    observation: { statements: { hit: 1, total: 2 }, functions: { hit: 0, total: 1 } }
  })
  expect(rows[1].observation).toBeNull()
  expect(rows[1].error).toContain('unknown')
  expect(runtimeEvidenceRows(test, coverage(), manifest, root, 'Test failed')[0]).toMatchObject({
    observation: null,
    error: 'Test failed'
  })
})

it.each([undefined, { 0: -1 }, { 0: '1' }, [1]])(
  'rejects invalid coverage counters: %j',
  (counts) => {
    const data = coverage()
    Object.assign(data[join(root, source)], { f: counts })
    expect(runtimeEvidenceRows(test, data, manifest, root)[0].observation).toBeNull()
  }
)

it.each([
  ['/repo/src/a.ts', '/repo', 'src/a.ts'],
  ['C:\\repo\\src\\a.ts', 'C:\\repo', 'src/a.ts'],
  ['/other/src/a.ts', '/repo', undefined],
  ['D:\\repo\\src\\a.ts', 'C:\\repo', undefined]
])('normalizes coverage paths without accepting another checkout', (file, directory, expected) => {
  expect(evidenceRelativePath(file, directory)).toBe(expected)
})

it('requires a real successful run of exactly the requested test file', () => {
  const result = {
    success: true,
    testResults: [
      { name: join(root, test), status: 'passed', assertionResults: [{ status: 'passed' }] }
    ]
  }
  expect(() => assertEvidenceTestPassed(result, test, root)).not.toThrow()
  expect(() => assertEvidenceTestPassed({ success: true, testResults: [] }, test, root)).toThrow()
  expect(() => assertEvidenceTestPassed({ ...result, success: false }, test, root)).toThrow()
  expect(() => assertEvidenceTestPassed(result, 'other.test.ts', root)).toThrow()
  result.testResults[0].assertionResults[0].status = 'pending'
  expect(() => assertEvidenceTestPassed(result, test, root)).toThrow()
})

it('labels partial module observations and failed data without presenting them as zero', () => {
  const report = renderRuntimeEvidence({
    revision: 'fixture',
    platform: 'linux/x64',
    node: '24',
    vitest: '4',
    rows: runtimeEvidenceRows(test, coverage(), manifest, root),
    runs: [{ test, seconds: 1 }]
  })
  expect(report).toContain('not entire modules')
  expect(report).toContain('sample (owner) | 0/1 | 1/2')
  expect(report).toContain('unavailable | unavailable')
  expect(report).toContain('No tests are skipped')
})

it('isolates the manual diagnostic from full runs, publication and scheduled issue reporting', () => {
  const workflow = load(readFileSync('.github/workflows/source-regression.yml', 'utf8')) as {
    jobs: Record<
      string,
      {
        if: string
        permissions?: object
        steps: Array<{ run?: string; uses?: string; if?: string; with?: Record<string, unknown> }>
      }
    >
  }
  const job = workflow.jobs.runtime_evidence
  expect(job.if).toBe(
    "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'runtime-evidence' }}"
  )
  expect(job.permissions).toEqual({ contents: 'read' })
  expect(job.steps.filter((step) => step.run).map((step) => step.run)).toEqual([
    'node scripts/ci/npm-ci.mjs',
    'npm run pretest',
    'node scripts/ci/runtime-module-evidence.mjs'
  ])
  const artifact = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!
  expect(artifact.if).toBe('always()')
  expect(artifact.with).toMatchObject({
    path: 'coverage/runtime-module-evidence/',
    'retention-days': 7
  })
  expect(workflow.jobs.macos_setup.if).toContain("inputs.mode != 'runtime-evidence'")
  expect(workflow.jobs.regression.if).toContain("needs.macos_setup.result == 'success'")
  for (const name of ['portable', 'portable_report', 'packages', 'report']) {
    expect(workflow.jobs[name].if).not.toContain('runtime-evidence')
    expect(workflow.jobs[name].if).not.toContain("github.event_name == 'workflow_dispatch'")
  }
})

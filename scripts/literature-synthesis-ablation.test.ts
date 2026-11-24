import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The task-specific JavaScript CLI has no declaration file; importing must be inert.
import {
  applySynthesisAblation,
  inspectSynthesisAblationReport,
  SynthesisAblationReporter
} from './literature-synthesis-ablation.mjs'

type Fixture = {
  report: {
    success: boolean
    testResults: Array<{
      name: string
      status: string
      message: string
      assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }>
    }>
  }
  observation: {
    finished: boolean
    reason: string
    unhandledErrors: Array<{ name: string; message: string }>
    suiteErrors: Array<{ name: string; message: string }>
  }
  run: {
    status: number
    stdout: string
    stderr: string
    signal: string | null
    error: Error | undefined
  }
  variant: { witness: string }
  expectedFiles: string[]
  expectedTests: string[]
  transformHit: boolean
}

const fixture = (): Fixture => ({
  report: {
    success: false,
    testResults: [
      {
        name: 'probe.test.ts',
        status: 'failed',
        message: '',
        assertionResults: [
          {
            fullName: 'semantic witness',
            status: 'failed',
            failureMessages: ['AssertionError: forbidden behavior']
          }
        ]
      }
    ]
  },
  observation: {
    finished: true,
    reason: 'failed',
    unhandledErrors: [],
    suiteErrors: []
  },
  run: {
    status: 1,
    stdout: '',
    stderr: '',
    signal: null,
    error: undefined
  },
  variant: { witness: 'semantic witness' },
  expectedFiles: ['probe.test.ts'],
  expectedTests: ['semantic witness'],
  transformHit: true
})

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('synthesis ablation evidence', () => {
  it('applies every edit of one lifecycle ablation and rejects missing or ambiguous anchors', () => {
    const variant = {
      name: 'lifecycle',
      replacements: [
        { from: 'mount only in picker', to: 'retain while hidden' },
        { from: 'old placement', to: '' }
      ]
    }
    expect(applySynthesisAblation('mount only in picker; old placement', variant)).toBe(
      'retain while hidden; '
    )
    expect(() => applySynthesisAblation('mount only in picker', variant)).toThrow('source anchor')
    expect(() =>
      applySynthesisAblation('mount only in picker; mount only in picker; old placement', variant)
    ).toThrow('source anchor')
  })
  it('accepts a completed semantic failure with no other errors', () => {
    expect(inspectSynthesisAblationReport(fixture()).valid).toBe(true)
  })
  it('requires an explicit witness for another test of the same removed mechanism', () => {
    const f = fixture()
    f.expectedTests.push('alias snapshot witness')
    f.report.testResults[0].assertionResults.push({
      fullName: 'alias snapshot witness',
      status: 'failed',
      failureMessages: ['AssertionError: snapshot changed']
    })
    expect(inspectSynthesisAblationReport(f).valid).toBe(false)
    expect(
      inspectSynthesisAblationReport({
        ...f,
        variant: { ...f.variant, additionalWitnesses: ['alias snapshot witness'] }
      }).valid
    ).toBe(true)
  })
  it('accepts a nonempty passing baseline but rejects an all-skipped baseline', () => {
    const f = fixture()
    f.report.success = true
    f.report.testResults[0].status = 'passed'
    f.report.testResults[0].assertionResults[0].status = 'passed'
    f.report.testResults[0].assertionResults[0].failureMessages = []
    f.run.status = 0
    f.observation.reason = 'passed'
    const baseline = { ...f, variant: { control: true }, expectedTests: undefined }
    expect(inspectSynthesisAblationReport(baseline).valid).toBe(true)
    f.report.testResults[0].assertionResults[0].status = 'skipped'
    expect(inspectSynthesisAblationReport(baseline).valid).toBe(false)
  })
  it('rejects the reproduced afterAll error alongside a semantic witness', () => {
    const f = fixture()
    f.report.testResults[0].message = 'ABLATED_SUITE_CLEANUP_FAILURE'
    expect(inspectSynthesisAblationReport(f).valid).toBe(false)
  })
  it('rejects nested suite hook errors omitted from the JSON suite message', () => {
    const f = fixture()
    f.observation.suiteErrors.push({ name: 'Error', message: 'nested afterAll failure' })
    expect(inspectSynthesisAblationReport(f).valid).toBe(false)
  })
  it('rejects structured unhandled errors even when JSON and both output streams are silent', () => {
    const f = fixture()
    f.observation.unhandledErrors.push({ name: 'Error', message: 'ABLATED_UNHANDLED_FAILURE' })
    expect(inspectSynthesisAblationReport(f).valid).toBe(false)
  })
  it('fails closed when the completion observation is absent, incomplete, or interrupted', () => {
    const f = fixture()
    for (const observation of [
      undefined,
      {},
      { ...f.observation, finished: false },
      { ...f.observation, unhandledErrors: undefined },
      { ...f.observation, suiteErrors: undefined },
      { ...f.observation, reason: 'interrupted' }
    ]) {
      expect(inspectSynthesisAblationReport({ ...f, observation }).valid).toBe(false)
    }
  })
  it.each(['stdout', 'stderr'] as const)('rejects infrastructure diagnostics from %s', (stream) => {
    const f = fixture()
    f.run[stream] = 'Unhandled Rejection: unrelated failure'
    expect(inspectSynthesisAblationReport(f).valid).toBe(false)
  })
  it('rejects startup failure, termination, and timeouts', () => {
    const f = fixture()
    expect(
      inspectSynthesisAblationReport({ ...f, run: { ...f.run, error: new Error('spawn failed') } })
        .valid
    ).toBe(false)
    expect(
      inspectSynthesisAblationReport({ ...f, run: { ...f.run, signal: 'SIGTERM' } }).valid
    ).toBe(false)
    f.report.testResults[0].assertionResults[0].failureMessages = [
      'AssertionError: Test timed out in 5000ms'
    ]
    expect(inspectSynthesisAblationReport(f).valid).toBe(false)
  })
  it('requires the exact baseline selection and expected file identities', () => {
    const f = fixture()
    expect(
      inspectSynthesisAblationReport({ ...f, expectedTests: ['different witness'] }).valid
    ).toBe(false)
    expect(inspectSynthesisAblationReport({ ...f, expectedFiles: ['other.test.ts'] }).valid).toBe(
      false
    )
    expect(
      inspectSynthesisAblationReport({
        ...f,
        report: { ...f.report, testResults: [f.report.testResults[0], f.report.testResults[0]] },
        expectedFiles: ['probe.test.ts', 'other.test.ts']
      }).valid
    ).toBe(false)
    expect(inspectSynthesisAblationReport({ ...f, transformHit: false }).valid).toBe(false)
  })
  it('records completion and the actual reporter unhandled-error argument', () => {
    const root = mkdtempSync(join(tmpdir(), 'synthesis-ablation-reporter-'))
    roots.push(root)
    const path = join(root, 'observation.json')
    new SynthesisAblationReporter(path).onTestRunEnd(
      [],
      [{ name: 'Error', message: 'unhandled source failure', stack: 'unneeded stack' }],
      'failed'
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      finished: true,
      reason: 'failed',
      unhandledErrors: [{ name: 'Error', message: 'unhandled source failure' }],
      suiteErrors: []
    })
  })
})

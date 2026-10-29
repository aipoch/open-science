import { describe, expect, it } from 'vitest'
// @ts-expect-error The CLI is JavaScript; importing it must not execute experiments.
import * as ablation from './collector-ablation.mjs'

const { inspectAblationReport, missingAblationWitnesses, validateAblationInputs } = ablation

const fixture = (): {
  data: {
    success: boolean
    testResults: Array<{
      name: string
      status: string
      message: string
      assertionResults: Array<{ fullName: string; status: string; failureMessages: string[] }>
    }>
  }
  result: { status: number | null; stderr: string; signal?: string }
  expectedFiles: string[]
  expectedTests: string[]
  witness: string
} => ({
  data: {
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
  result: { status: 1, stderr: '' },
  expectedFiles: ['probe.test.ts'],
  expectedTests: ['semantic witness'],
  witness: 'semantic witness'
})
describe('collector ablation evidence', () => {
  it('keeps all 53 moved mechanism anchors unique and in the frozen evidence set', () => {
    expect(validateAblationInputs()).toBe(53)
  })
  it('requires every named witness to be selected by the passing baseline', () => {
    expect(
      missingAblationWitnesses(['suite alpha witness'], ['alpha witness', 'beta witness'])
    ).toEqual(['beta witness'])
    expect(
      missingAblationWitnesses(
        ['suite alpha witness', 'suite beta witness'],
        ['alpha witness', 'beta witness']
      )
    ).toEqual([])
  })

  it('accepts the specified semantic failure without unrelated diagnostics', () => {
    expect(inspectAblationReport(fixture()).valid).toBe(true)
  })
  it('rejects a witness mixed with a suite diagnostic', () => {
    const f = fixture()
    f.data.testResults[0].message = 'Failed to load an additional dependency'
    expect(inspectAblationReport(f).valid).toBe(false)
  })
  it('rejects a witness mixed with an unhandled exception', () => {
    const f = fixture()
    f.result.stderr = 'Unhandled Errors\nUncaught Exception: unrelated failure'
    expect(inspectAblationReport(f).valid).toBe(false)
  })
  it.each(['Test timed out in 30000ms', 'Hook timed out in 30000ms'])(
    'rejects an infrastructure timeout instead of a semantic witness: %s',
    (message) => {
      const f = fixture()
      f.data.testResults[0].assertionResults[0].failureMessages = ['Error: ' + message]
      expect(inspectAblationReport(f).valid).toBe(false)
    }
  )
  it.each([0, 2, null])('rejects an unexpected or missing exit code %s', (status) => {
    const f = fixture()
    f.result.status = status
    expect(inspectAblationReport(f).valid).toBe(false)
  })
  it('rejects missing test files even when the witness is present', () => {
    const f = fixture()
    f.expectedFiles.push('missing.test.ts')
    expect(inspectAblationReport(f).valid).toBe(false)
  })
  it('rejects changed test selections', () => {
    const f = fixture()
    f.expectedTests.push('missing assertion')
    expect(inspectAblationReport(f).valid).toBe(false)
  })
  it('rejects signaled runs', () => {
    const f = fixture()
    f.result.signal = 'SIGTERM'
    expect(inspectAblationReport(f).valid).toBe(false)
  })
})

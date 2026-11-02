import { expect, it } from 'vitest'
import { validateRun } from '../../scripts/pdf-ablation.mjs'

const variant = { test: 'witness', control: false }
const child = { status: 1, signal: null, stderr: '' }
const witness = {
  status: 'failed',
  message: '',
  assertionResults: [
    {
      status: 'failed',
      fullName: 'witness',
      failureMessages: ['AssertionError: expected true to be false']
    }
  ]
}
const report = { testResults: [witness] }

it('accepts a clean named semantic failure', () => {
  expect(validateRun(child, report, variant)).toBe(true)
})

it('rejects an expected assertion mixed with an empty failed startup suite', () => {
  expect(
    validateRun(
      child,
      {
        testResults: [
          witness,
          { status: 'failed', message: 'Cannot find module', assertionResults: [] }
        ]
      },
      variant
    )
  ).toBe(false)
})

it('rejects an expected assertion mixed with an unhandled error', () => {
  expect(
    validateRun(
      { ...child, stderr: 'Vitest caught 1 unhandled error during the test run.' },
      report,
      variant
    )
  ).toBe(false)
})

it.each([
  { ...child, signal: 'SIGTERM' },
  { ...child, error: new Error('spawn failed') },
  { ...child, status: 0 },
  { ...child, status: null }
])('rejects an invalid child result $status/$signal', (invalid) => {
  expect(validateRun(invalid, report, variant)).toBe(false)
})

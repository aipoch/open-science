import { expect, it } from 'vitest'
import { verifyUpdateOccupancy } from './verify-update-occupancy.mjs'

it('rejects skipped or incomplete native launch evidence', () => {
  const cases = ['desktop', 'cli'].map((surface) => ({
    fullName: `admits launch-log readers (${surface})`,
    status: 'passed'
  }))
  const report = { success: true, testResults: [{ assertionResults: cases }] }
  expect(() => verifyUpdateOccupancy(report, 'source')).not.toThrow()
  cases[1].status = 'pending'
  expect(() => verifyUpdateOccupancy(report, 'source')).toThrow('executed')
  expect(() => verifyUpdateOccupancy({}, 'source')).toThrow('executed')
})

it('requires a first-attempt packaged pass, including the actual result behind expected status', () => {
  const result = { status: 'passed', retry: 0 }
  const test = { expectedStatus: 'passed', status: 'expected', results: [result] }
  const report = {
    suites: [
      {
        suites: [
          {
            specs: [
              {
                title: 'certifies real packaged update occupancy and recovery',
                ok: true,
                tests: [test]
              }
            ]
          }
        ]
      }
    ]
  }
  expect(() => verifyUpdateOccupancy(report, 'packaged')).not.toThrow()
  for (const status of ['skipped', 'failed', 'timedOut', 'interrupted']) {
    result.status = status
    expect(() => verifyUpdateOccupancy(report, 'packaged')).toThrow('executed')
  }
  result.status = 'passed'
  result.retry = 1
  expect(() => verifyUpdateOccupancy(report, 'packaged')).toThrow('executed')
  expect(() => verifyUpdateOccupancy({}, 'packaged')).toThrow('executed')
})

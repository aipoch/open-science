import { describe, expect, it } from 'vitest'
import { flakySummary, timingRows } from './merge-e2e-reports.mjs'

const test = (duration: number): { duration: number } => ({ duration })
const report = {
  suites: [
    {
      suites: [
        {
          specs: [
            {
              title: 'retried',
              file: 'a.ts',
              tests: [{ status: 'flaky', results: [test(400), test(200)] }]
            },
            {
              title: 'passed',
              file: 'b.ts',
              tests: [{ status: 'expected', results: [test(500)] }]
            }
          ]
        }
      ]
    }
  ]
}

describe('E2E timing evidence', () => {
  it('includes nested suites and retry cost when ranking slow tests', () => {
    expect(timingRows(report)).toEqual([
      expect.objectContaining({ title: 'retried', duration: 600, status: 'flaky' }),
      expect.objectContaining({ title: 'passed', duration: 500 })
    ])
  })

  it('keeps retry-passed flakes visible in the summary without failing the merge', () => {
    expect(flakySummary(timingRows(report))).toBe('Flaky (passed on retry): 1\n\n- a.ts: retried')
    expect(flakySummary(timingRows(report).filter((row) => row.status !== 'flaky'))).toBe(
      'Flaky (passed on retry): 0'
    )
  })
})

import { describe, expect, it } from 'vitest'
import { timingRows } from './merge-e2e-reports.mjs'

describe('E2E timing evidence', () => {
  it('includes nested suites and retry cost when ranking slow tests', () => {
    const test = (duration: number): { duration: number } => ({ duration })
    expect(
      timingRows({
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
      })
    ).toEqual([
      expect.objectContaining({ title: 'retried', duration: 600, status: 'flaky' }),
      expect.objectContaining({ title: 'passed', duration: 500 })
    ])
  })
})

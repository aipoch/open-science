import { expect, it } from 'vitest'
import { verifyNotebookMutations } from './verify-notebook-mutations.mjs'

type Report = {
  suites: Array<{
    specs: Array<{
      title: string
      ok: boolean
      tests: Array<{
        status: string
        expectedStatus: string
        results: Array<{ status: string; retry: number }>
      }>
    }>
  }>
  errors: Array<{ message: string }>
}
const report = (): Report => ({
  suites: [
    {
      specs: [
        'cancels a timed-out environment mutation before allowing a retry',
        'keeps a healthy environment mutation alive beyond the client idle timeout',
        'cancels a timed-out package mutation before allowing a retry'
      ].map((title) => ({
        title,
        ok: true,
        tests: [
          {
            status: 'expected',
            expectedStatus: 'passed',
            results: [{ status: 'passed', retry: 0 }]
          }
        ]
      }))
    }
  ],
  errors: []
})
it('accepts exactly the required executed mutation cases', () => {
  expect(verifyNotebookMutations(report())).toHaveLength(3)
})
it.each(['skipped', 'flaky', 'missing', 'duplicate', 'unexpected', 'retried', 'error'])(
  'rejects %s execution evidence',
  (failure) => {
    const value = report()
    const specs = value.suites[0].specs
    if (failure === 'missing') specs.pop()
    else if (failure === 'duplicate') specs[2] = specs[0]
    else if (failure === 'error') value.errors = [{ message: 'runner error' }]
    else if (failure === 'retried') specs[0].tests[0].results[0].retry = 1
    else specs[0].tests[0].status = failure
    expect(() => verifyNotebookMutations(value)).toThrow('without skips or retries')
  }
)

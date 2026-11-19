/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function verifyUpdateOccupancy(report, kind) {
  if (kind === 'source') {
    const passed = (report.testResults ?? [])
      .flatMap((file) => file.assertionResults ?? [])
      .filter((test) => test.status === 'passed')
    if (
      report.success === true &&
      passed.length === 2 &&
      ['desktop', 'cli'].every((surface) =>
        passed.some((test) => test.fullName.endsWith('(' + surface + ')'))
      )
    )
      return
  } else if (kind === 'packaged') {
    const visit = (suites) =>
      suites.flatMap((suite) => [...(suite.specs ?? []), ...visit(suite.suites ?? [])])
    const specs = visit(report.suites ?? [])
    const spec = specs[0]
    const test = spec?.tests?.[0]
    if (
      specs.length === 1 &&
      spec.title === 'certifies real packaged update occupancy and recovery' &&
      spec.ok === true &&
      spec.tests.length === 1 &&
      test.expectedStatus === 'passed' &&
      test.status === 'expected' &&
      test.results?.length === 1 &&
      test.results[0].status === 'passed' &&
      test.results[0].retry === 0 &&
      !report.errors?.length
    )
      return
  }
  throw new Error(
    'Update occupancy certification requires executed, passing evidence; skips and retries cannot certify an update.'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyUpdateOccupancy(JSON.parse(readFileSync(process.argv[3], 'utf8')), process.argv[2])
}

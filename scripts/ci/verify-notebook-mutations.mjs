/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const requiredTitles = [
  'cancels a timed-out environment mutation before allowing a retry',
  'keeps a healthy environment mutation alive beyond the client idle timeout',
  'cancels a timed-out package mutation before allowing a retry'
]

export function verifyNotebookMutations(report) {
  const visit = (suites) =>
    suites.flatMap((suite) => [...(suite.specs ?? []), ...visit(suite.suites ?? [])])
  const specs = visit(report.suites ?? [])
  if (
    specs.length !== requiredTitles.length ||
    requiredTitles.some(
      (title) =>
        specs.filter(
          (spec) =>
            spec.title === title &&
            spec.ok &&
            spec.tests?.length === 1 &&
            spec.tests.every(
              (test) =>
                test.status === 'expected' &&
                test.expectedStatus === 'passed' &&
                test.results?.length === 1 &&
                test.results[0].status === 'passed' &&
                test.results[0].retry === 0
            )
        ).length !== 1
    ) ||
    report.errors?.length > 0
  ) {
    throw new Error(
      'Expected all three controlled Windows mutation cases to pass without skips or retries.'
    )
  }
  return requiredTitles
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const titles = verifyNotebookMutations(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    const summary = [
      '## Controlled Notebook mutation certification',
      '',
      `Platform: ${process.platform}; source SHA: ${process.env.GITHUB_SHA ?? 'local checkout'}.`,
      '',
      ...titles.map((title) => `- Passed: ${title}`),
      '',
      'Real Micromamba installation: not selected; requires the separate real-install opt-in.',
      ''
    ].join('\n')
    console.log(summary)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

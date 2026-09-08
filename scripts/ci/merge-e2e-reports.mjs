/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function timingRows(report) {
  const rows = []
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        rows.push({
          title: spec.title,
          file: spec.file,
          project: test.projectName,
          status: test.status,
          duration: (test.results ?? []).reduce((total, result) => total + result.duration, 0)
        })
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  return rows.sort((a, b) => b.duration - a.duration)
}

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

export function mergeReports(root = 'test-results/downloaded-e2e') {
  const paths = files(root)
  const blobs = paths.filter((path) => path.endsWith('.zip') && path.includes('blob-report'))
  if (blobs.length === 0) throw new Error('No E2E blob reports were uploaded.')
  const merged = 'test-results/merged-e2e-blobs'
  mkdirSync(merged, { recursive: true })
  blobs.forEach((path, index) => copyFileSync(path, join(merged, `${index}.zip`)))
  const sections = []
  for (const path of paths.filter((path) => path.endsWith('.json'))) {
    const report = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(report.suites)) continue
    const rows = timingRows(report)
    sections.push(
      `### ${path}\n\nWall time: ${((report.stats?.duration ?? 0) / 1000).toFixed(1)}s\n\n| Test | Seconds (including retries) | Status |\n| --- | ---: | --- |\n` +
        rows
          .slice(0, 20)
          .map(
            (row) =>
              `| ${row.file}: ${row.title.replaceAll('|', '\\|')} | ${(row.duration / 1000).toFixed(1)} | ${row.status} |`
          )
          .join('\n')
    )
  }
  const summary = '# E2E timing\n\n' + sections.join('\n\n') + '\n'
  writeFileSync('test-results/e2e-timing.md', summary)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  // Explicit testDir lets Playwright merge reports originating from different OS checkout roots.
  writeFileSync(
    'test-results/e2e-merge.config.cjs',
    `module.exports = { testDir: ${JSON.stringify(resolve('e2e'))}, reporter: [['html', { open: 'never' }]] }\n`
  )
  const run = spawnSync(
    process.execPath,
    [
      resolve('node_modules/playwright/cli.js'),
      'merge-reports',
      '--config=test-results/e2e-merge.config.cjs',
      merged
    ],
    { stdio: 'inherit' }
  )
  rmSync('test-results/e2e-merge.config.cjs', { force: true })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error('E2E report merge failed.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  mergeReports()

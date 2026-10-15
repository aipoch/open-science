/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModuleImpactManifest } from './load-module-impact.mjs'

// A bounded diagnostic sample, never an input to the test selector.
export const runtimeEvidenceSample = {
  tests: [
    'src/main/node-entry.test.ts',
    'packages/notebook-syntax/src/index.test.ts',
    'packages/notebook-syntax/src/unavailable.test.ts'
  ],
  sources: [
    'src/main/node-entry.ts',
    'src/main/core-runtime.ts',
    'src/main/credential-identity/access.ts',
    'packages/notebook-syntax/src/index.ts'
  ]
}
export const runtimeEvidenceDirectory = 'coverage/runtime-module-evidence'

export function evidenceRelativePath(path, root) {
  const paths = win32.isAbsolute(root) && !root.startsWith('/') ? win32 : posix
  const relative = paths.relative(root, path).split(paths.sep).join('/')
  return relative === '..' || relative.startsWith('../') || paths.isAbsolute(relative)
    ? undefined
    : relative
}

function hits(counts) {
  if (!counts || Array.isArray(counts) || typeof counts !== 'object')
    throw new Error('Missing coverage counters')
  const values = Object.values(counts)
  if (values.some((value) => !Number.isInteger(value) || value < 0))
    throw new Error('Invalid coverage counters')
  return { hit: values.filter((value) => value > 0).length, total: values.length }
}

export function runtimeEvidenceRows(test, coverage, manifest, root, error) {
  const entries = new Map(
    Object.entries(coverage).map(([path, entry]) => [evidenceRelativePath(path, root), entry])
  )
  return runtimeEvidenceSample.sources.map((source) => {
    const owners = Object.entries(manifest.modules).filter(([, m]) => m.ownerPaths.includes(source))
    let observation = null
    let problem = error
    try {
      if (problem) throw new Error(problem)
      const entry = entries.get(source)
      if (!entry) throw new Error('Source absent from coverage report; execution is unknown')
      observation = { statements: hits(entry.s), functions: hits(entry.f) }
    } catch (failure) {
      problem = failure.message
    }
    return {
      test,
      source,
      modules: owners.map(([id, m]) => ({
        id,
        registration: Object.entries(m.testFiles)
          .filter(([, tests]) => tests.includes(test))
          .map(([kind]) => kind)
      })),
      observation,
      ...(problem ? { error: problem } : {})
    }
  })
}

export function assertEvidenceTestPassed(result, test, root) {
  const suites = result.testResults ?? []
  if (
    result.success !== true ||
    suites.length !== 1 ||
    evidenceRelativePath(suites[0].name, root) !== test ||
    suites[0].status !== 'passed' ||
    !suites[0].assertionResults?.some((assertion) => assertion.status === 'passed')
  )
    throw new Error('Expected exactly the requested test file to execute successfully')
}

export function renderRuntimeEvidence(report) {
  const count = (value) => (value ? `${value.hit}/${value.total}` : 'unavailable')
  const lines = [
    '# Runtime module evidence (diagnostic only)',
    '',
    `Revision: \`${report.revision}\`; platform: ${report.platform}; Node: ${report.node}; Vitest: ${report.vitest}.`,
    '',
    'Fixed sample only; counts describe the listed source files, not entire modules. Zero hits do not prove a test can be removed. Missing or failed collection is unavailable, never zero.',
    '',
    '| Test | Source | Module / explicit registration | Functions | Statements |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const row of report.rows) {
    const owners = row.modules
      .map(({ id, registration }) => `${id} (${registration.join(', ') || 'none'})`)
      .join(', ')
    lines.push(
      `| ${row.test} | ${row.source} | ${owners || 'unowned'} | ${count(row.observation?.functions)} | ${count(row.observation?.statements)} |`
    )
  }
  lines.push('', '## Collection', '')
  for (const run of report.runs)
    lines.push(
      `- ${run.test}: ${run.seconds.toFixed(2)}s${run.error ? `; ${run.error}` : '; passed'}`
    )
  const missing = report.rows.filter((row) => row.error)
  if (missing.length)
    lines.push('', `${missing.length} source observations are unavailable; see report.json.`)
  lines.push('', 'No tests are skipped and no module registrations are changed by this report.', '')
  return lines.join('\n')
}

export function runRuntimeModuleEvidence() {
  const root = process.cwd()
  const output = resolve(runtimeEvidenceDirectory)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const manifest = loadModuleImpactManifest()
  const report = {
    schemaVersion: 1,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    ),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    vitest: JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8')).version,
    scope: runtimeEvidenceSample,
    runs: [],
    rows: []
  }
  for (const [index, test] of runtimeEvidenceSample.tests.entries()) {
    const directory = join(output, String(index))
    mkdirSync(directory, { recursive: true })
    const started = performance.now()
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        test,
        '--config',
        'scripts/ci/runtime-module-evidence.config.ts',
        '--coverage',
        '--coverage.reportsDirectory',
        directory,
        '--reporter=json',
        '--outputFile',
        join(directory, 'tests.json')
      ],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
    )
    writeFileSync(join(directory, 'run.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    let coverage = {}
    let error
    try {
      if (result.error) throw result.error
      if (result.status !== 0)
        throw new Error(`Vitest failed (${result.signal ?? result.status}); see ${index}/run.log`)
      assertEvidenceTestPassed(
        JSON.parse(readFileSync(join(directory, 'tests.json'), 'utf8')),
        test,
        root
      )
      coverage = JSON.parse(readFileSync(join(directory, 'coverage-final.json'), 'utf8'))
      if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage))
        throw new Error('Invalid coverage report')
    } catch (failure) {
      error = failure.message
      coverage = {}
    }
    report.runs.push({
      test,
      seconds: (performance.now() - started) / 1000,
      ...(error ? { error } : {})
    })
    report.rows.push(...runtimeEvidenceRows(test, coverage, manifest, root, error))
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const markdown = renderRuntimeEvidence(report)
  writeFileSync(join(output, 'report.md'), markdown)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(markdown)
  return report.rows.some((row) => row.error) ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runRuntimeModuleEvidence()

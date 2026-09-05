/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_RESULT_PATH = 'test-results/accessibility/accessibility-summary.json'
const EXPECTED_TESTS = 11
export const EXPECTED_ACCESSIBILITY_SURFACES = [
  'Onboarding',
  'Home',
  'Home (narrow)',
  'Onboarding step focus',
  'Go-to locations (open)',
  'New project dialog',
  'Workspace',
  'Settings',
  'Permission request',
  'Project files (narrow)',
  'File preview dialog',
  'Long conversation (dark)',
  'Artifact provenance',
  'Compute settings (narrow, dark)',
  'Conversation recovery warning',
  'Home (375px, light)',
  'Home (375px, dark)',
  'Home (767px, light)',
  'Home (767px, dark)',
  'Reported text (light)',
  'Reported text (dark)'
]

export function readAccessibilityResult(path) {
  const result = JSON.parse(readFileSync(path, 'utf8'))
  const scanSurfaces = new Set(
    Array.isArray(result.scans) ? result.scans.map((scan) => scan?.surface) : []
  )
  const validCompleteScan =
    result.plannedTests === EXPECTED_TESTS &&
    result.completedTests === EXPECTED_TESTS &&
    result.readyTests === EXPECTED_TESTS &&
    result.axeRunCount === EXPECTED_ACCESSIBILITY_SURFACES.length &&
    result.scans?.length === EXPECTED_ACCESSIBILITY_SURFACES.length &&
    scanSurfaces.size === EXPECTED_ACCESSIBILITY_SURFACES.length &&
    EXPECTED_ACCESSIBILITY_SURFACES.every((surface) => scanSurfaces.has(surface))
  if (
    result.schemaVersion !== 1 ||
    !['passed', 'advisory', 'infra-failure'].includes(result.status) ||
    !Number.isInteger(result.axeRunCount) ||
    (result.status !== 'infra-failure' && !validCompleteScan)
  ) {
    throw new Error('Accessibility runner produced an invalid scan summary.')
  }
  return result
}

export function publishInfrastructureFailure(error, environment = process.env) {
  if (!environment.GITHUB_STEP_SUMMARY) return
  const message = error instanceof Error ? error.message : String(error)
  try {
    appendFileSync(
      environment.GITHUB_STEP_SUMMARY,
      [
        '## Accessibility quality signal',
        '',
        'Result: **INFRA_FAILURE**',
        '',
        'The real UI scan did not complete. Treat this as test infrastructure failure.',
        '',
        `- runner error: \`${message.replaceAll('`', "'").replaceAll('\n', ' ')}\``,
        ''
      ].join('\n')
    )
  } catch (summaryError) {
    console.error('Failed to publish the accessibility infrastructure summary.', summaryError)
  }
}

export function runAccessibilityE2e(environment = process.env) {
  const resultPath = resolve(environment.ACCESSIBILITY_RESULT_PATH ?? DEFAULT_RESULT_PATH)
  rmSync(resultPath, { force: true })

  const run = spawnSync(
    process.execPath,
    [
      resolve('node_modules/playwright/cli.js'),
      'test',
      '--config=playwright.accessibility.config.ts',
      'e2e/accessibility.spec.ts'
    ],
    {
      env: {
        ...environment,
        // Collect every surface before the reporter fails the run for findings.
        ACCESSIBILITY_COLLECT_ALL: '1',
        ACCESSIBILITY_RESULT_PATH: resultPath
      },
      stdio: 'inherit'
    }
  )

  if (run.error) throw run.error
  const result = readAccessibilityResult(resultPath)
  if (run.status !== 0 && result.status === 'passed') {
    throw new Error('Playwright failed after publishing a passing accessibility result.')
  }
  return result.status === 'passed' && run.status === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runAccessibilityE2e()
  } catch (error) {
    publishInfrastructureFailure(error)
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

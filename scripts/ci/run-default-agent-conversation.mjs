import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { verifyDefaultAgentReport } from './default-agent-conversation.mjs'

const require = createRequire(import.meta.url)
const executable = process.env.OPEN_SCIENCE_E2E_EXECUTABLE
if (!executable || !existsSync(executable))
  throw new Error('Candidate packaged executable is required.')
if (process.env.OPEN_SCIENCE_E2E_HARNESS_RELAY_URL || process.env.OPEN_SCIENCE_E2E_HARNESS_MODEL)
  throw new Error('Release certification requires the deterministic local provider fixture.')
const { GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, DEFAULT_AGENT_PLATFORM } = process.env
if (!GITHUB_SHA || !GITHUB_RUN_ID || !GITHUB_RUN_ATTEMPT || !DEFAULT_AGENT_PLATFORM)
  throw new Error('Candidate source, workflow and platform identities are required.')
const directory = 'test-results/default-agent-conversation'
mkdirSync(directory, { recursive: true })
const reportPath = `${directory}/playwright.json`
rmSync(reportPath, { force: true })
rmSync(`${directory}/certification.json`, { force: true })
const run = spawnSync(
  process.execPath,
  [
    require.resolve('@playwright/test/cli'),
    'test',
    'e2e/default-agent-conversation.spec.ts',
    'e2e/builtin-harness.spec.ts',
    'e2e/harness-provider-errors.spec.ts',
    '--grep',
    '@default-agent-release',
    '--workers=1',
    '--retries=0',
    '--fail-on-flaky-tests',
    '--global-timeout=1200000',
    '--reporter=line,json',
    `--output=${directory}/artifacts`
  ],
  { stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } }
)
if (run.error || run.status !== 0)
  throw new Error(`Default Agent conversation failed (${run.status ?? run.error}).`)
const reportBytes = readFileSync(reportPath)
const cases = verifyDefaultAgentReport(JSON.parse(reportBytes))
writeFileSync(
  `${directory}/certification.json`,
  JSON.stringify(
    {
      schemaVersion: 1,
      status: 'passed',
      platform: DEFAULT_AGENT_PLATFORM,
      sourceSha: process.env.DEFAULT_AGENT_SOURCE_SHA || GITHUB_SHA,
      runId: GITHUB_RUN_ID,
      runAttempt: GITHUB_RUN_ATTEMPT,
      reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
      cases
    },
    null,
    2
  ) + '\n'
)

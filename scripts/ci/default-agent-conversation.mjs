/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Exact behavior inventory: a successful wrapper or an empty/skipped selection cannot certify it.
export const DEFAULT_AGENT_CASES = [
  ...['chat-completions', 'responses', 'messages'].map((protocol) => ({
    file: 'default-agent-conversation.spec.ts',
    title: `default Agent completes two turns over ${protocol}`
  })),
  ...[
    'executes approved host MCP and restores its session after restart',
    'asks the user and receives the selected answer',
    'creates a host plan and continues only after approval',
    'rejects denied execution and can cancel then continue',
    'recovers a crashed model turn without repeating its completed tool'
  ].map((behavior) => ({ file: 'builtin-harness.spec.ts', title: `built-in harness ${behavior}` })),
  ...['chat-completions', 'responses', 'messages'].map((protocol) => ({
    file: 'harness-provider-errors.spec.ts',
    title: `built-in harness shows actionable ${protocol} provider errors across restart`
  }))
]
const key = ({ file, title }) =>
  `${file.replaceAll('\\', '/').replace(/^e2e\//, '')}:${title.replace(/ @default-agent-release$/, '')}`
const expected = DEFAULT_AGENT_CASES.map(key).sort()

export function verifyDefaultAgentReport(report) {
  const visit = (suites) =>
    suites.flatMap((suite) => [...(suite.specs ?? []), ...visit(suite.suites ?? [])])
  const specs = visit(report.suites ?? [])
  if (
    report.errors?.length ||
    JSON.stringify(specs.map(key).sort()) !== JSON.stringify(expected) ||
    specs.some(
      (spec) =>
        spec.ok !== true ||
        spec.tests?.length !== 1 ||
        spec.tests[0].expectedStatus !== 'passed' ||
        spec.tests[0].status !== 'expected' ||
        spec.tests[0].results?.length !== 1 ||
        spec.tests[0].results[0].status !== 'passed' ||
        spec.tests[0].results[0].retry !== 0
    )
  )
    throw new Error(
      'Default Agent certification requires every mandatory case to pass without skips or retries.'
    )
  return [...expected]
}

export function assertDefaultAgentEvidence(evidence, source) {
  if (
    !/^[a-f0-9]{40}$/.test(source.sha ?? '') ||
    !/^[1-9][0-9]*$/.test(source.runId ?? '') ||
    !/^[1-9][0-9]*$/.test(source.runAttempt ?? '') ||
    evidence?.schemaVersion !== 1 ||
    evidence.status !== 'passed' ||
    evidence.platform !== source.platform ||
    evidence.sourceSha !== source.sha ||
    evidence.runId !== source.runId ||
    evidence.runAttempt !== source.runAttempt ||
    !/^[a-f0-9]{64}$/.test(evidence.reportSha256 ?? '') ||
    JSON.stringify(evidence.cases) !== JSON.stringify(expected)
  )
    throw new Error('Missing or invalid default Agent conversation certification.')
  return evidence
}

export function verifyPublishedDefaultAgentEvidence(report, sha, runId) {
  const platforms = ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64']
  const records = report.platforms ?? []
  if (
    report.sourceSha !== sha ||
    JSON.stringify(records.map((record) => record.platform).sort()) !==
      JSON.stringify([...platforms].sort())
  )
    throw new Error('Incomplete default Agent platform certification.')
  for (const record of records) {
    if (
      record.source?.sha !== sha ||
      record.source?.runId !== runId ||
      record.checks?.defaultAgentConversation !== 'passed'
    )
      throw new Error('Default Agent certification does not belong to the publishing source run.')
    assertDefaultAgentEvidence(record.defaultAgentConversation, {
      ...record.source,
      platform: record.platform
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, input] = process.argv.slice(2)
  if (mode !== 'published') throw new Error('Expected published default Agent validation mode.')
  verifyPublishedDefaultAgentEvidence(
    JSON.parse(readFileSync(input, 'utf8')),
    process.env.SOURCE_SHA,
    process.env.SOURCE_RUN_ID
  )
}

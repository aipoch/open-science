import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { JSONReport } from '@playwright/test/reporter'
import {
  DEFAULT_AGENT_CASES,
  assertDefaultAgentEvidence,
  verifyDefaultAgentReport,
  verifyPublishedDefaultAgentEvidence
} from './default-agent-conversation.mjs'

const sha = 'a'.repeat(40)
const source = { sha, runId: '42', runAttempt: '2', platform: 'macos-arm64' }
type ExecutionReport = {
  errors: { message: string }[]
  suites: {
    specs: {
      file: string
      title: string
      ok: boolean
      tests: {
        expectedStatus: string
        status: string
        results: { status: string; retry: number }[]
      }[]
    }[]
  }[]
}
const report = (): ExecutionReport => ({
  errors: [],
  suites: [
    {
      specs: DEFAULT_AGENT_CASES.map((entry) => ({
        ...entry,
        ok: true,
        tests: [
          {
            expectedStatus: 'passed',
            status: 'expected',
            results: [{ status: 'passed', retry: 0 }]
          }
        ]
      }))
    }
  ]
})
type ConversationEvidence = {
  schemaVersion: number
  status: string
  platform: string
  sourceSha: string
  runId: string
  runAttempt: string
  reportSha256: string
  cases: string[]
}
const evidence = (): ConversationEvidence => ({
  schemaVersion: 1,
  status: 'passed',
  platform: source.platform,
  sourceSha: sha,
  runId: '42',
  runAttempt: '2',
  reportSha256: 'b'.repeat(64),
  cases: verifyDefaultAgentReport(report())
})

describe('default Agent release certification', () => {
  it('selects precisely the eleven mandatory real Electron journeys', () => {
    const require = createRequire(import.meta.url)
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('@playwright/test/cli'),
        'test',
        'e2e/builtin-harness.spec.ts',
        'e2e/harness-provider-errors.spec.ts',
        'e2e/default-agent-conversation.spec.ts',
        '--grep',
        '@default-agent-release',
        '--list',
        '--reporter=json'
      ],
      { encoding: 'utf8', timeout: 30_000 }
    )
    expect(result.status, result.stderr).toBe(0)
    const selected = JSON.parse(result.stdout) as JSONReport
    const visit = (suites: JSONReport['suites']): Array<{ file: string; title: string }> =>
      suites.flatMap((suite) => [...suite.specs, ...visit(suite.suites ?? [])])
    const specs = visit(selected.suites)
    expect(specs).toHaveLength(11)
    const expected = verifyDefaultAgentReport(report())
    expect(
      specs
        .map(
          ({ file, title }) =>
            `${file.replace(/^e2e\//, '')}:${title.replace(/ @default-agent-release$/, '')}`
        )
        .sort()
    ).toEqual(expected)
  })

  it.each([
    'missing',
    'duplicate',
    'skipped',
    'failed',
    'timedOut',
    'interrupted',
    'retry',
    'expected-failure',
    'global-error'
  ])('rejects %s execution instead of accepting a green wrapper', (failure) => {
    const input = report()
    const spec = input.suites[0].specs[0]
    if (failure === 'missing') input.suites[0].specs.pop()
    else if (failure === 'duplicate') input.suites[0].specs.push(spec)
    else if (failure === 'retry') spec.tests[0].results[0].retry = 1
    else if (failure === 'expected-failure') spec.tests[0].expectedStatus = 'failed'
    else if (failure === 'global-error') input.errors.push({ message: 'worker failed' })
    else spec.tests[0].results[0].status = failure
    expect(() => verifyDefaultAgentReport(input)).toThrow(/every mandatory case/)
  })

  it('binds the complete evidence to the candidate and certifying run attempt', () => {
    expect(assertDefaultAgentEvidence(evidence(), source)).toMatchObject({ status: 'passed' })
    for (const field of ['sha', 'platform', 'runId', 'runAttempt'])
      expect(() =>
        assertDefaultAgentEvidence(evidence(), { ...source, [field]: 'foreign' })
      ).toThrow()
    const input = evidence()
    input.cases.pop()
    expect(() => assertDefaultAgentEvidence(input, source)).toThrow()
  })

  it('rejects old or partial Nightly reports even when their workflow succeeded', () => {
    const platforms = ['linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64', 'windows-x64']
    const input = {
      sourceSha: sha,
      platforms: platforms.map((platform) => ({
        platform,
        source: { ...source, platform },
        checks: { defaultAgentConversation: 'passed' },
        defaultAgentConversation: { ...evidence(), platform } as
          ReturnType<typeof evidence> | undefined
      }))
    }
    expect(() => verifyPublishedDefaultAgentEvidence(input, sha, '42')).not.toThrow()
    expect(() => verifyPublishedDefaultAgentEvidence(input, sha, '43')).toThrow()
    input.platforms[0].defaultAgentConversation = undefined
    expect(() => verifyPublishedDefaultAgentEvidence(input, sha, '42')).toThrow()
    input.platforms.pop()
    expect(() => verifyPublishedDefaultAgentEvidence(input, sha, '42')).toThrow()
  })

  it('keeps the installed-package runner strict and independent of real-provider relays', () => {
    const runner = readFileSync('scripts/ci/run-default-agent-conversation.mjs', 'utf8')
    for (const flag of ['--workers=1', '--retries=0', '--fail-on-flaky-tests'])
      expect(runner).toContain(flag)
    expect(runner).toContain('OPEN_SCIENCE_E2E_EXECUTABLE')
    expect(runner).toContain('OPEN_SCIENCE_E2E_HARNESS_RELAY_URL')
  })
})

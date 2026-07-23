import { describe, expect, it } from 'vitest'

import {
  buildEnvironmentBlock,
  buildErrorReportText,
  buildGithubIssueUrl,
  formatProviderModel,
  MAX_WHAT_HAPPENED_LENGTH,
  osLabelForPlatform,
  resolveSessionSubject,
  type ErrorReportContext
} from './error-report'

const baseContext: ErrorReportContext = {
  error: 'Run failed: connection reset',
  appVersion: '0.5.1',
  platform: 'darwin',
  frameworkName: 'Claude Code',
  providerName: 'Anthropic',
  model: 'claude-opus-4',
  runtimeVersions: { electron: '30.0.0', chrome: '124', node: '20.11' }
}

describe('osLabelForPlatform', () => {
  it('maps known platforms to human-readable names', () => {
    expect(osLabelForPlatform('win32')).toBe('Windows')
    expect(osLabelForPlatform('linux')).toBe('Linux')
    expect(osLabelForPlatform('darwin')).toBe('macOS')
  })

  it('returns undefined for an unknown platform', () => {
    expect(osLabelForPlatform(undefined)).toBeUndefined()
    expect(osLabelForPlatform('sunos')).toBeUndefined()
  })
})

describe('formatProviderModel', () => {
  it('joins provider and model when both are present', () => {
    expect(formatProviderModel(baseContext)).toBe('Anthropic · claude-opus-4')
  })

  it('falls back to provider name, then model, then Unknown', () => {
    expect(formatProviderModel({ error: 'x', providerName: 'Anthropic' })).toBe('Anthropic')
    expect(formatProviderModel({ error: 'x', model: 'gpt-4o' })).toBe('gpt-4o')
    expect(formatProviderModel({ error: 'x' })).toBe('Unknown')
  })
})

describe('buildEnvironmentBlock', () => {
  it('renders every known field as a labelled line', () => {
    const block = buildEnvironmentBlock(baseContext)
    expect(block).toContain('- App version: 0.5.1')
    expect(block).toContain('- Agent framework: Claude Code')
    expect(block).toContain('- Provider / model: Anthropic · claude-opus-4')
    expect(block).toContain('- Runtime: Electron 30.0.0, Chrome 124, Node 20.11')
  })

  it('omits the runtime line when no versions are known', () => {
    const block = buildEnvironmentBlock({ error: 'x', appVersion: '1.0.0' })
    expect(block).not.toContain('- Runtime:')
    expect(block).toContain('- App version: 1.0.0')
    expect(block).toContain('- Operating system: Unknown')
  })
})

describe('buildErrorReportText', () => {
  it('includes the error, environment, and a local-log note', () => {
    const text = buildErrorReportText(baseContext)
    expect(text).toContain('Run failed: connection reset')
    expect(text).toContain('## Environment')
    expect(text).toContain('The runtime log is not included automatically')
  })

  it('degrades to a placeholder when the error string is blank', () => {
    expect(buildErrorReportText({ error: '   ' })).toContain('A run failed with no error message.')
  })
})

describe('buildGithubIssueUrl', () => {
  it('targets the bug report template with prefilled, decodable fields', () => {
    const url = new URL(buildGithubIssueUrl(baseContext))
    expect(url.pathname).toBe('/aipoch/open-science/issues/new')
    expect(url.searchParams.get('template')).toBe('bug_report.yml')
    expect(url.searchParams.get('what-happened')).toBe('Run failed: connection reset')
    expect(url.searchParams.get('app-version')).toBe('0.5.1')
    expect(url.searchParams.get('provider-model')).toBe('Anthropic · claude-opus-4')
    expect(url.searchParams.get('logs')).toContain('Runtime log not attached automatically')
  })

  it('carries framework, runtime, and detected OS in the logs field', () => {
    const logs = new URL(buildGithubIssueUrl(baseContext)).searchParams.get('logs') ?? ''
    expect(logs).toContain('Agent framework: Claude Code')
    expect(logs).toContain('Electron 30.0.0, Chrome 124, Node 20.11')
    // OS is a dropdown GitHub won't prefill, so its detected value is surfaced here instead.
    expect(logs).toContain('Detected OS: macOS')
    // App version / provider-model have their own prefilled inputs — must not be duplicated here,
    // and the shell-rendered field must stay plain (no Markdown emphasis).
    expect(logs).not.toContain('App version')
    expect(logs).not.toContain('**')
  })

  it('keeps what-happened to the error alone, without the environment block', () => {
    const whatHappened =
      new URL(buildGithubIssueUrl(baseContext)).searchParams.get('what-happened') ?? ''
    expect(whatHappened).toBe('Run failed: connection reset')
    expect(whatHappened).not.toContain('Environment')
    expect(whatHappened).not.toContain('App version')
  })

  it('reflects a redacted error passed via context', () => {
    const url = new URL(buildGithubIssueUrl({ ...baseContext, error: 'redacted summary' }))
    expect(url.searchParams.get('what-happened')).toBe('redacted summary')
  })

  it('never sets the os query param (GitHub ignores dropdown prefill) and uses logs instead', () => {
    // Regression guard for the empirically-confirmed limitation: prefilling a dropdown via query
    // string does not work, so the param must not be sent and the value must live in logs.
    const url = new URL(buildGithubIssueUrl({ ...baseContext, platform: 'win32' }))
    expect(url.searchParams.get('os')).toBeNull()
    expect(url.searchParams.get('logs')).toContain('Detected OS: Windows')
  })

  it('omits fields that are unknown rather than sending empty values', () => {
    const url = new URL(buildGithubIssueUrl({ error: 'boom' }))
    expect(url.searchParams.get('app-version')).toBeNull()
    expect(url.searchParams.get('provider-model')).toBeNull()
    expect(url.searchParams.get('what-happened')).toBe('boom')
  })

  it('bounds a very long error with a visible truncation marker so the URL cannot 414', () => {
    const longError = 'x'.repeat(MAX_WHAT_HAPPENED_LENGTH + 5000)
    const whatHappened =
      new URL(buildGithubIssueUrl({ error: longError })).searchParams.get('what-happened') ?? ''
    // Kept at/under the cap plus the short marker — never the full 11k+ characters.
    expect(whatHappened.length).toBeLessThanOrEqual(MAX_WHAT_HAPPENED_LENGTH + 120)
    expect(whatHappened).toContain('truncated')
    expect(whatHappened).toContain('Copy details')
  })

  it('does not truncate an error at or below the cap', () => {
    const exact = 'y'.repeat(MAX_WHAT_HAPPENED_LENGTH)
    const whatHappened =
      new URL(buildGithubIssueUrl({ error: exact })).searchParams.get('what-happened') ?? ''
    expect(whatHappened).toBe(exact)
  })
})

describe('buildErrorReportText (Copy details) fallback', () => {
  it('always carries the full, untruncated error even when the URL is capped', () => {
    const longError = 'z'.repeat(MAX_WHAT_HAPPENED_LENGTH + 5000)
    const text = buildErrorReportText({ ...baseContext, error: longError })
    // Copy details is the full-fidelity fallback: it must contain the entire error, untruncated.
    expect(text).toContain(longError)
  })
})

describe('resolveSessionSubject', () => {
  const providers = [
    { id: 'p1', name: 'Anthropic' },
    { id: 'ssh:box', name: 'Remote Box' }
  ]
  const frameworks = [
    { id: 'claude-code', displayName: 'Claude Code' },
    { id: 'codex', displayName: 'Codex' }
  ]

  it('resolves framework and provider from the session ids, including the active model', () => {
    const resolved = resolveSessionSubject(
      { agentFrameworkId: 'claude-code', agentBackendId: 'claude-code:p1' },
      providers,
      'p1',
      'claude-opus-4',
      frameworks
    )
    expect(resolved).toEqual({
      frameworkName: 'Claude Code',
      providerName: 'Anthropic',
      model: 'claude-opus-4'
    })
  })

  it('splits backendId on the first colon so provider ids containing colons survive', () => {
    const resolved = resolveSessionSubject(
      { agentFrameworkId: 'codex', agentBackendId: 'codex:ssh:box' },
      providers,
      'ssh:box',
      'gpt-x',
      frameworks
    )
    expect(resolved.providerName).toBe('Remote Box')
    expect(resolved.model).toBe('gpt-x')
  })

  it('omits the model when the active provider no longer matches the session provider', () => {
    const resolved = resolveSessionSubject(
      { agentFrameworkId: 'claude-code', agentBackendId: 'claude-code:p1' },
      providers,
      'p2-switched', // user switched provider after the failure
      'a-newer-model',
      frameworks
    )
    expect(resolved.providerName).toBe('Anthropic') // still the session's provider
    expect(resolved.model).toBeUndefined() // but not the newer, unrelated model
  })

  it('falls back to the raw framework id when it is unknown, and tolerates missing ids', () => {
    expect(
      resolveSessionSubject({ agentFrameworkId: 'mystery' }, providers, undefined, undefined, [])
    ).toEqual({
      frameworkName: 'mystery'
    })
    expect(resolveSessionSubject({}, providers, undefined, undefined, frameworks)).toEqual({
      frameworkName: undefined
    })
  })

  it('yields no provider name when the session provider is gone from the list', () => {
    const resolved = resolveSessionSubject(
      { agentFrameworkId: 'claude-code', agentBackendId: 'claude-code:deleted' },
      providers,
      'deleted',
      'm',
      frameworks
    )
    expect(resolved.providerName).toBeUndefined()
    // Provider matches active id, so model is still allowed even though the provider record is gone.
    expect(resolved.model).toBe('m')
  })
})

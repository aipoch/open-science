// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import type { DatabaseStartupError } from '../../../shared/database-startup'
import {
  ISSUE_BASE_URL,
  buildStartupIssueBody,
  buildStartupIssueTitle,
  buildStartupIssueUrl
} from './startup-issue'

const baseError: DatabaseStartupError = {
  code: 'database_migration_failed',
  message: 'Open Science could not update its database. Existing data was not reset.',
  migrationId: '0009_vision_evidence',
  retryable: true,
  environment: {
    appVersion: '0.9.2',
    platform: 'darwin',
    arch: 'arm64',
    electron: '37.2.0',
    node: '22.17.0'
  }
}

describe('buildStartupIssueTitle', () => {
  it('carries the error code and migration id', () => {
    expect(buildStartupIssueTitle(baseError)).toBe(
      'Startup blocked: database_migration_failed (0009_vision_evidence)'
    )
  })

  it('omits the migration id when absent', () => {
    expect(buildStartupIssueTitle({ ...baseError, migrationId: undefined })).toBe(
      'Startup blocked: database_migration_failed'
    )
  })
})

describe('buildStartupIssueBody', () => {
  it('follows the standard issue structure', () => {
    const body = buildStartupIssueBody(baseError, 'Error: boom\n    at f (/f.js:1:1)')

    expect(body).toContain('## What happened')
    expect(body).toContain(baseError.message)
    expect(body).toContain('## Environment')
    expect(body).toContain('| Error code | `database_migration_failed` |')
    expect(body).toContain('| Migration | `0009_vision_evidence` |')
    expect(body).toContain('| App version | 0.9.2 (darwin-arm64) |')
    expect(body).toContain('| Electron | 37.2.0 · Node 22.17.0 |')
    expect(body).toContain('## Steps to reproduce')
    expect(body).toContain('## Error stack')
    expect(body).toContain('```text\nError: boom\n    at f (/f.js:1:1)\n```')
  })

  it('omits the app rows when the environment is unavailable', () => {
    const withoutEnvironment: DatabaseStartupError = { ...baseError, environment: undefined }
    const body = buildStartupIssueBody(withoutEnvironment, undefined)

    expect(body).toContain('| Error code | `database_migration_failed` |')
    expect(body).not.toContain('App version')
  })

  it('omits the stack section without diagnostics', () => {
    const body = buildStartupIssueBody(baseError, undefined)

    expect(body).not.toContain('## Error stack')
  })
})

describe('buildStartupIssueUrl', () => {
  it('encodes title and body into the public new-issue URL', () => {
    const url = buildStartupIssueUrl({ ...baseError, diagnostics: 'Error: boom' })

    expect(url.startsWith(`${ISSUE_BASE_URL}?title=`)).toBe(true)
    expect(url).toContain(encodeURIComponent('Startup blocked: database_migration_failed'))
    expect(url).toContain('body=')
    expect(decodeURIComponent(url)).toContain('## What happened')
  })

  it('keeps the URL within budget by truncating oversized diagnostics', () => {
    const url = buildStartupIssueUrl({
      ...baseError,
      diagnostics: `Error: boom\n${'x'.repeat(50000)}`
    })

    expect(url.length).toBeLessThanOrEqual(7800)
    expect(decodeURIComponent(url)).toContain('stack truncated')
  })

  it('trims precisely to the URL budget instead of rounding down', () => {
    const url = buildStartupIssueUrl({
      ...baseError,
      diagnostics: `Error: boom\n${'x'.repeat(50000)}`
    })

    // 'x' encodes 1:1, so the binary search lands within a few characters of the budget.
    expect(url.length).toBeGreaterThan(7700)
    expect(url.length).toBeLessThanOrEqual(7800)
  })

  it('keeps short diagnostics intact without a truncation note', () => {
    const url = buildStartupIssueUrl({
      ...baseError,
      diagnostics: 'Error: boom\n    at f (/f.js:1:1)'
    })

    expect(decodeURIComponent(url)).toContain('at f (/f.js:1:1)')
    expect(decodeURIComponent(url)).not.toContain('stack truncated')
  })

  it('uses edited diagnostics in the bounded public draft', () => {
    const url = buildStartupIssueUrl(baseError, 'Error: edited by the user')

    expect(decodeURIComponent(url)).toContain('Error: edited by the user')
    expect(decodeURIComponent(url)).not.toContain('Error: boom')
  })

  it('truncates long emoji diagnostics without splitting a surrogate pair', () => {
    const url = buildStartupIssueUrl(baseError, `Error: boom\n${'🚀'.repeat(5000)}`)

    expect(url.length).toBeLessThanOrEqual(7800)
    expect(decodeURIComponent(url)).toContain('stack truncated')
    expect(() => new URL(url)).not.toThrow()
  })
})

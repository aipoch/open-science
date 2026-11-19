import { describe, expect, it } from 'vitest'
import type { ToolActivity } from '@/stores/session-store-contract'
import { webResultSchema } from '../../../../shared/web-tools'
import { sanitizeToolActivity } from '../../../../shared/session-persistence/tool-activity'
import { normalizeActivityAfterRestore } from '../../../../shared/session-persistence/restore'
import { sanitizeToolContent } from '../../../../shared/tool-detail-sanitizer'
import { getToolExecutionPhase } from './tool-execution-phase'
import {
  isBuiltinWebFetchActivity,
  readWebFetchResult,
  safeWebUrl
} from './workspace-web-fetch-details'

import { fetchActivity, fetchResult } from './workspace-web-fetch-test-fixtures'

describe('trusted WebResult fetch details', () => {
  it('requires host authority, canonical identity and matching invocation', () => {
    expect(readWebFetchResult(fetchActivity())).toEqual(fetchResult())
    expect(
      readWebFetchResult(fetchActivity({ providerToolName: 'mcp__open-science-web__web_fetch' }))
    ).toEqual(fetchResult())
    for (const overrides of [
      { appOwned: undefined },
      { executionInvocationId: undefined },
      { providerToolName: 'mcp__external__web_fetch' },
      { providerToolName: 'WebFetch' },
      { executionInvocationId: 'other' }
    ])
      expect(readWebFetchResult(fetchActivity(overrides))).toBeUndefined()
    expect(isBuiltinWebFetchActivity(fetchActivity({ appOwned: undefined }))).toBe(false)
  })

  it('accepts known MCP wrappers and safely rejects unknown versions and fields', () => {
    expect(
      readWebFetchResult(
        fetchActivity({
          toolContent: [],
          rawOutput: {
            content: [{ type: 'text', text: JSON.stringify(fetchResult()) }]
          }
        })
      )
    ).toEqual(fetchResult())
    for (const result of [
      { ...fetchResult(), schema: 'open-science.web.v2' },
      { ...fetchResult(), extra: 'unknown' },
      { ...fetchResult(), document: undefined },
      { ...fetchResult(), status: 'error' }
    ])
      expect(
        readWebFetchResult(fetchActivity({ toolContent: [], rawOutput: result }))
      ).toBeUndefined()
  })

  it('preserves a complete redacted envelope through persistence and offline restore', () => {
    const result = fetchResult()
    result.document!.text = 'token=x;'.repeat(1500)
    result.document!.total_lines = 10
    const before = JSON.stringify(result)
    expect(webResultSchema.safeParse(result).success).toBe(true)
    const content = sanitizeToolContent([
      { type: 'content', content: { type: 'text', text: before } }
    ])
    expect(JSON.stringify(content)).not.toContain('token=x')
    expect(JSON.stringify(result)).toBe(before)
    const persisted = sanitizeToolActivity({ ...fetchActivity(), toolContent: content })!
    const restored = normalizeActivityAfterRestore(persisted) as ToolActivity
    const saved = readWebFetchResult(restored)!
    expect(saved.document?.sha256).toBe(result.document?.sha256)
    expect(saved.document?.truncated).toBe(true)
    expect(saved.document?.text).toContain('[redacted]')
    expect(webResultSchema.safeParse(saved).success).toBe(true)
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(32000)
  })

  it('retains authoritative cancellation across restore and late success', () => {
    const cancelled = sanitizeToolActivity(fetchActivity({ toolDisposition: 'cancelled' }))!
    expect(cancelled.toolDisposition).toBe('cancelled')
    expect(getToolExecutionPhase(cancelled as ToolActivity, undefined)).toBe('cancelled')
  })

  it('only links intact credential-free HTTP(S) destinations', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@example.org/',
      'https://example.org/?token=secret-value',
      'not a URL'
    ])
      expect(safeWebUrl(url)).toBeUndefined()
    expect(safeWebUrl('https://example.org/#methods')).toBe('https://example.org/#methods')
  })
})

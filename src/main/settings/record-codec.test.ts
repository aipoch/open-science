import { describe, expect, it } from 'vitest'

import {
  sanitizeClaudeInfo,
  sanitizeCodexInfo,
  sanitizeComputeGrant,
  sanitizeProvider
} from './record-codec'

describe('settings record codec', () => {
  it('keeps the private owner interface explicit', async () => {
    expect(Object.keys(await import('./record-codec')).sort()).toEqual([
      'sanitizeClaudeInfo',
      'sanitizeCodexInfo',
      'sanitizeComputeGrant',
      'sanitizeConnectors',
      'sanitizeCustomMcpServer',
      'sanitizePackageMirror',
      'sanitizeProvider'
    ])
  })

  it('rebuilds provider records from known fields without exposing plaintext credentials', () => {
    expect(
      sanitizeProvider({
        id: 'provider-1',
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://example.test/v1',
        model: 'model-1',
        apiEndpoints: ['responses', 'responses', 'unknown'],
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000,
        keyRef: 'encrypted:key',
        keyMask: 'sk-…abcd',
        apiKey: 'plaintext-must-not-survive',
        unknown: true
      })
    ).toEqual({
      id: 'provider-1',
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'https://example.test/v1',
      model: 'model-1',
      apiEndpoints: ['responses'],
      contextWindow: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
      keyRef: 'encrypted:key',
      keyMask: 'sk-…abcd'
    })
  })

  it('rejects unusable provider identities and invalid compute grants', () => {
    expect(sanitizeProvider({ id: 'official', type: 'official', name: 'Unknown' })).toBeUndefined()
    expect(sanitizeProvider({ id: 'provider-1', type: 'removed', name: 'Old' })).toBeUndefined()
    expect(
      sanitizeComputeGrant({ projectId: 'p1', operation: 'download', providerId: 'c1' })
    ).toEqual({
      projectId: 'p1',
      operation: 'download',
      providerId: 'c1'
    })
    expect(
      sanitizeComputeGrant({ projectId: 'p1', operation: 42, providerId: 'c1' })
    ).toBeUndefined()
  })

  it('keeps only recognized Claude and Codex metadata fields', () => {
    expect(
      sanitizeClaudeInfo({ resolvedPath: 'claude-bin', version: '1.0.0', ignored: true })
    ).toEqual({ resolvedPath: 'claude-bin', version: '1.0.0' })
    expect(
      sanitizeCodexInfo({
        resolvedPath: 'codex-bin',
        version: '2.0.0',
        nativePath: 'native-codex-bin',
        nativeVersion: '2.0.1',
        ignored: true
      })
    ).toEqual({
      resolvedPath: 'codex-bin',
      version: '2.0.0',
      nativePath: 'native-codex-bin',
      nativeVersion: '2.0.1'
    })
  })
})

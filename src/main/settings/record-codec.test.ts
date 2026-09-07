import { describe, expect, it } from 'vitest'

import {
  sanitizeClaudeInfo,
  sanitizeCodexInfo,
  sanitizeComputeGrant,
  sanitizeProvider
} from './record-codec'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'

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

  it('applies provider field and fetched-model limits while decoding', () => {
    expect(
      sanitizeProvider({
        id: 'provider-1',
        type: 'custom',
        name: 'n'.repeat(PROVIDER_RESOURCE_LIMITS.nameCharacters + 1)
      })
    ).toBeUndefined()

    const provider = sanitizeProvider({
      id: 'provider-1',
      type: 'custom',
      name: 'Gateway',
      baseUrl: 'u'.repeat(PROVIDER_RESOURCE_LIMITS.baseUrlCharacters + 1),
      model: 'm'.repeat(PROVIDER_RESOURCE_LIMITS.modelIdCharacters + 1),
      fetchedModels: [
        ...Array.from(
          { length: PROVIDER_RESOURCE_LIMITS.fetchedModels + 1 },
          (_, index) => `model-${index}`
        ),
        'x'.repeat(PROVIDER_RESOURCE_LIMITS.modelIdCharacters + 1)
      ]
    })

    expect(provider).not.toHaveProperty('baseUrl')
    expect(provider).not.toHaveProperty('model')
    expect(provider?.fetchedModels).toHaveLength(PROVIDER_RESOURCE_LIMITS.fetchedModels)
    expect(provider?.fetchedModels).not.toContain(
      'x'.repeat(PROVIDER_RESOURCE_LIMITS.modelIdCharacters + 1)
    )
  })

  it.each([
    ['apodex', 'Apodex', undefined],
    ['tencent', 'Tencent TokenHub', 'international'],
    ['tencentcodingplan', 'Tencent Coding Plan', undefined],
    ['tencenttokenplan', 'Tencent Token Plan', undefined]
  ] as const)('preserves the %s provider identity', (vendorId, name, region) => {
    expect(
      sanitizeProvider({
        id: vendorId,
        type: 'official',
        name,
        vendorId,
        region,
        keyRef: 'encrypted:key',
        keyMask: 'sk-…abcd'
      })
    ).toEqual({
      id: vendorId,
      type: 'official',
      name,
      vendorId,
      ...(region ? { region } : {}),
      keyRef: 'encrypted:key',
      keyMask: 'sk-…abcd'
    })
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

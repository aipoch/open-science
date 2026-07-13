import { describe, expect, it } from 'vitest'

import {
  OFFICIAL_VENDORS,
  defaultVendorModel,
  getOfficialVendor,
  isOfficialVendorId,
  resolveVendorApiKeyUrl,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl,
  vendorHasRegions
} from './provider-registry'

describe('provider registry', () => {
  it('defines exactly one of baseUrl or regions per vendor, with a non-empty catalog', () => {
    for (const vendor of OFFICIAL_VENDORS) {
      const hasBaseUrl = Boolean(vendor.baseUrl)
      const hasRegions = (vendor.regions?.length ?? 0) > 0

      expect(hasBaseUrl).not.toBe(hasRegions) // exactly one is set
      expect(vendor.models.length).toBeGreaterThan(0)
    }
  })

  it('narrows known vendor ids and rejects unknown values', () => {
    expect(isOfficialVendorId('deepseek')).toBe(true)
    expect(isOfficialVendorId('openai')).toBe(false)
    expect(isOfficialVendorId(undefined)).toBe(false)
    expect(isOfficialVendorId(42)).toBe(false)
  })

  it('resolves a single-endpoint vendor base URL', () => {
    expect(resolveVendorBaseUrl('deepseek')).toBe('https://api.deepseek.com/anthropic')
    expect(getOfficialVendor('deepseek')?.label).toBe('DeepSeek')
  })

  it('resolves a multi-region vendor by region, defaulting to the first', () => {
    expect(vendorHasRegions('minimax')).toBe(true)
    expect(resolveVendorBaseUrl('minimax', 'china')).toBe('https://api.minimaxi.com/anthropic')
    // Unknown / missing region falls back to the first region.
    expect(resolveVendorBaseUrl('minimax', 'nope')).toBe('https://api.minimax.io/anthropic')
    expect(resolveVendorBaseUrl('minimax')).toBe('https://api.minimax.io/anthropic')
  })

  it('routes GLM to Z.AI overseas and BigModel in China', () => {
    expect(vendorHasRegions('zhipu')).toBe(true)
    expect(resolveVendorBaseUrl('zhipu', 'global')).toBe('https://api.z.ai/api/anthropic')
    expect(resolveVendorBaseUrl('zhipu', 'china')).toBe('https://open.bigmodel.cn/api/anthropic')
  })

  it('exposes the first catalog entry as the default model', () => {
    expect(defaultVendorModel('zhipu')).toBe('glm-5.2')
  })

  it('exposes a model-list URL only for vendors that provide one', () => {
    expect(resolveVendorModelsUrl('deepseek')).toBe('https://api.deepseek.com/v1/models')
    // GLM/MiniMax don't expose a model-list endpoint yet, so refresh is hidden for them.
    expect(resolveVendorModelsUrl('zhipu')).toBeUndefined()
    expect(resolveVendorModelsUrl('minimax')).toBeUndefined()
  })

  it('resolves the key-console URL, preferring the selected region', () => {
    // Single-endpoint vendor: the vendor-level URL.
    expect(resolveVendorApiKeyUrl('deepseek')).toBe('https://platform.deepseek.com/api_keys')
    // Multi-region vendor: the region's own console, defaulting to the first region.
    expect(resolveVendorApiKeyUrl('zhipu', 'china')).toBe(
      'https://open.bigmodel.cn/usercenter/apikeys'
    )
    expect(resolveVendorApiKeyUrl('zhipu')).toBe('https://z.ai/manage-apikey/apikey-list')
  })

  it('returns undefined for unknown vendors', () => {
    // @ts-expect-error deliberately passing an unknown id
    expect(resolveVendorBaseUrl('unknown')).toBeUndefined()
    // @ts-expect-error deliberately passing an unknown id
    expect(defaultVendorModel('unknown')).toBeUndefined()
    // @ts-expect-error deliberately passing an unknown id
    expect(resolveVendorApiKeyUrl('unknown')).toBeUndefined()
  })
})

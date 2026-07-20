import { describe, expect, it } from 'vitest'

import {
  OFFICIAL_VENDORS,
  defaultVendorModel,
  getOfficialVendor,
  isOfficialVendorId,
  isVendorModelMultimodal,
  resolveVendorApiEndpoints,
  resolveVendorApiKeyUrl,
  resolveVendorBaseUrl,
  resolveVendorModelsUrl,
  resolveVendorOpenAiBaseUrl,
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
    expect(isOfficialVendorId('openai')).toBe(true)
    expect(isOfficialVendorId(undefined)).toBe(false)
    expect(isOfficialVendorId(42)).toBe(false)
  })

  it('resolves a single-endpoint vendor base URL', () => {
    expect(resolveVendorBaseUrl('openai')).toBe('https://api.openai.com')
    expect(getOfficialVendor('openai')?.apiEndpoints).toEqual(['responses'])
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

  it('routes GLM to Z.AI overseas and BigModel in China, on both endpoints', () => {
    expect(vendorHasRegions('zhipu')).toBe(true)
    expect(resolveVendorBaseUrl('zhipu', 'global')).toBe('https://api.z.ai/api/anthropic')
    expect(resolveVendorBaseUrl('zhipu', 'china')).toBe('https://open.bigmodel.cn/api/anthropic')
    // GLM also serves an OpenAI route under /api/paas/v4 (not /v1), so Codex can bridge it.
    expect(resolveVendorApiEndpoints('zhipu')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorOpenAiBaseUrl('zhipu', 'global')).toBe('https://api.z.ai/api/paas/v4')
    expect(resolveVendorOpenAiBaseUrl('zhipu', 'china')).toBe(
      'https://open.bigmodel.cn/api/paas/v4'
    )
  })

  it('exposes the first catalog entry as the default model', () => {
    expect(defaultVendorModel('openai')).toBe('gpt-5.6-sol')
    expect(defaultVendorModel('zhipu')).toBe('glm-5.2')
  })

  it('exposes a model-list URL only for vendors that provide one', () => {
    expect(resolveVendorModelsUrl('deepseek')).toBe('https://api.deepseek.com/v1/models')
    // GLM/MiniMax don't expose a model-list endpoint yet, so refresh is hidden for them.
    expect(resolveVendorModelsUrl('zhipu')).toBeUndefined()
    expect(resolveVendorModelsUrl('minimax')).toBeUndefined()
  })

  it('routes OpenRouter through both APIs with a curated catalog and no live refresh', () => {
    expect(resolveVendorApiEndpoints('openrouter')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorBaseUrl('openrouter')).toBe('https://openrouter.ai/api')
    expect(resolveVendorOpenAiBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1')
    expect(resolveVendorApiKeyUrl('openrouter')).toBe(
      'https://openrouter.ai/workspaces/default/keys'
    )
    // Curated (300+ live ids would flood the picker), so refresh-from-vendor is hidden.
    expect(resolveVendorModelsUrl('openrouter')).toBeUndefined()
    expect(defaultVendorModel('openrouter')).toBe('anthropic/claude-opus-4.8')
  })

  it('routes Xiaomi MIMO through both APIs with a live model list', () => {
    expect(resolveVendorApiEndpoints('xiaomimimo')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorBaseUrl('xiaomimimo')).toBe('https://api.xiaomimimo.com/anthropic')
    expect(resolveVendorOpenAiBaseUrl('xiaomimimo')).toBe('https://api.xiaomimimo.com/v1')
    expect(resolveVendorModelsUrl('xiaomimimo')).toBe('https://api.xiaomimimo.com/v1/models')
    expect(defaultVendorModel('xiaomimimo')).toBe('mimo-v2.5-pro')
  })

  it('routes Kimi through both APIs so Codex can bridge it', () => {
    expect(resolveVendorApiEndpoints('kimi')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorBaseUrl('kimi')).toBe('https://api.moonshot.cn/anthropic')
    expect(resolveVendorOpenAiBaseUrl('kimi')).toBe('https://api.moonshot.cn/v1')
    expect(resolveVendorModelsUrl('kimi')).toBe('https://api.moonshot.cn/v1/models')
  })

  it('resolves the key-console URL, preferring the selected region', () => {
    // Single-endpoint vendor: the vendor-level URL.
    expect(resolveVendorApiKeyUrl('deepseek')).toBe('https://platform.deepseek.com/api_keys')
    // Multi-region vendor: the region's own console, defaulting to the first region.
    expect(resolveVendorApiKeyUrl('zhipu', 'china')).toBe(
      'https://open.bigmodel.cn/usercenter/apikeys'
    )
    expect(resolveVendorApiKeyUrl('zhipu')).toBe('https://z.ai')
  })

  it('returns undefined for unknown vendors', () => {
    // @ts-expect-error deliberately passing an unknown id
    expect(resolveVendorBaseUrl('unknown')).toBeUndefined()
    // @ts-expect-error deliberately passing an unknown id
    expect(defaultVendorModel('unknown')).toBeUndefined()
    // @ts-expect-error deliberately passing an unknown id
    expect(resolveVendorApiKeyUrl('unknown')).toBeUndefined()
  })

  describe('isVendorModelMultimodal', () => {
    it('returns true for OpenAI GPT-5 models', () => {
      expect(isVendorModelMultimodal('openai', 'gpt-5.6-sol')).toBe(true)
      expect(isVendorModelMultimodal('openai', 'gpt-5.5')).toBe(true)
      expect(isVendorModelMultimodal('openai', 'gpt-5.4-mini')).toBe(true)
    })

    it('returns true for all Anthropic Claude models', () => {
      expect(isVendorModelMultimodal('anthropic', 'claude-opus-4-8')).toBe(true)
      expect(isVendorModelMultimodal('anthropic', 'claude-sonnet-5')).toBe(true)
      expect(isVendorModelMultimodal('anthropic', 'claude-haiku-4-5-20251001')).toBe(true)
      expect(isVendorModelMultimodal('anthropic', 'claude-opus-4-8[1m]')).toBe(true)
    })

    it('treats Anthropic/OpenAI as vision-capable for live-fetched ids not in the bundled catalog', () => {
      // allMultimodal vendors must cover models the live model-list refresh surfaces, not just the
      // shipped ids — otherwise a refreshed Claude/GPT model would wrongly be flagged text-only.
      expect(isVendorModelMultimodal('anthropic', 'claude-opus-5-future')).toBe(true)
      expect(isVendorModelMultimodal('openai', 'gpt-6-turbo')).toBe(true)
    })

    it('returns false for DeepSeek models (no vision support)', () => {
      expect(isVendorModelMultimodal('deepseek', 'deepseek-v4-pro')).toBe(false)
      expect(isVendorModelMultimodal('deepseek', 'deepseek-v4-flash')).toBe(false)
    })

    it('matches Zhipu vision variants by pattern, including future `Nv` ids', () => {
      expect(isVendorModelMultimodal('zhipu', 'glm-5v-turbo')).toBe(true)
      // The pattern generalizes to future vision variants the live refresh may surface.
      expect(isVendorModelMultimodal('zhipu', 'glm-6v')).toBe(true)
      expect(isVendorModelMultimodal('zhipu', 'glm-5.2')).toBe(false)
      expect(isVendorModelMultimodal('zhipu', 'glm-5.1')).toBe(false)
      expect(isVendorModelMultimodal('zhipu', 'glm-5-turbo')).toBe(false)
    })

    it('returns false for MiniMax models (no vision support)', () => {
      expect(isVendorModelMultimodal('minimax', 'MiniMax-M3')).toBe(false)
      expect(isVendorModelMultimodal('minimax', 'MiniMax-M2.7')).toBe(false)
    })

    it('returns true only for Kimi k3 model', () => {
      expect(isVendorModelMultimodal('kimi', 'kimi-k3')).toBe(true)
      expect(isVendorModelMultimodal('kimi', 'kimi-k2.7-code')).toBe(false)
      expect(isVendorModelMultimodal('kimi', 'kimi-k2.6')).toBe(false)
    })

    it('returns true only for KimiForCode k3 model', () => {
      expect(isVendorModelMultimodal('kimiforcode', 'kimi-k3')).toBe(true)
      expect(isVendorModelMultimodal('kimiforcode', 'kimi-for-coding')).toBe(false)
      expect(isVendorModelMultimodal('kimiforcode', 'kimi-for-coding-highspeed')).toBe(false)
    })

    it('returns false for Xiaomi MIMO models (no vision support)', () => {
      expect(isVendorModelMultimodal('xiaomimimo', 'mimo-v2.5-pro')).toBe(false)
      expect(isVendorModelMultimodal('xiaomimimo', 'mimo-v2.5')).toBe(false)
    })

    it('returns true for OpenRouter vision-capable models', () => {
      expect(isVendorModelMultimodal('openrouter', 'anthropic/claude-opus-4.8')).toBe(true)
      expect(isVendorModelMultimodal('openrouter', 'openai/gpt-5.5')).toBe(true)
      expect(isVendorModelMultimodal('openrouter', 'google/gemini-3.5-flash')).toBe(true)
      expect(isVendorModelMultimodal('openrouter', 'moonshotai/kimi-k3')).toBe(true)
    })

    it('returns false for OpenRouter text-only models', () => {
      expect(isVendorModelMultimodal('openrouter', 'openai/gpt-5.3-codex')).toBe(false)
      expect(isVendorModelMultimodal('openrouter', 'deepseek/deepseek-v4-pro')).toBe(false)
      expect(isVendorModelMultimodal('openrouter', 'z-ai/glm-5.2')).toBe(false)
    })

    it('returns false for undefined or empty model id', () => {
      expect(isVendorModelMultimodal('anthropic', undefined)).toBe(false)
      expect(isVendorModelMultimodal('openai', '')).toBe(false)
    })

    it('returns false for an unknown model id on an explicit-list vendor', () => {
      // OpenRouter uses an explicit list (no blanket rule), so an unlisted id stays text-only.
      expect(isVendorModelMultimodal('openrouter', 'somevendor/unknown-model')).toBe(false)
      // Kimi's list is k3-only; an unknown id is not vision-capable.
      expect(isVendorModelMultimodal('kimi', 'kimi-k9-imaginary')).toBe(false)
    })
  })
})

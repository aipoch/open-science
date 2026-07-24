import { describe, expect, it } from 'vitest'

import {
  OFFICIAL_VENDORS,
  defaultVendorModel,
  getOfficialVendor,
  isOfficialVendorId,
  isVendorModelMultimodal,
  resolveCustomModelContextWindow,
  resolveModelContextWindow,
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

  it('serves MiniMax over Anthropic, OpenAI, and Responses per region', () => {
    // MiniMax exposes the Anthropic route plus the OpenAI /v1/chat/completions and /v1/responses.
    expect(resolveVendorApiEndpoints('minimax')).toEqual(['anthropic', 'openai', 'responses'])
    expect(resolveVendorOpenAiBaseUrl('minimax', 'global')).toBe('https://api.minimax.io/v1')
    expect(resolveVendorOpenAiBaseUrl('minimax', 'china')).toBe('https://api.minimaxi.com/v1')
    // Unknown / missing region falls back to the first region's OpenAI base.
    expect(resolveVendorOpenAiBaseUrl('minimax')).toBe('https://api.minimax.io/v1')
    expect(resolveVendorOpenAiBaseUrl('minimax', 'nope')).toBe('https://api.minimax.io/v1')
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

  it('routes the GLM Coding Plan through the /api/coding OpenAI path, per region', () => {
    expect(vendorHasRegions('glmcodingplan')).toBe(true)
    expect(resolveVendorApiEndpoints('glmcodingplan')).toEqual(['anthropic', 'openai'])
    // The Anthropic route is unchanged from pay-as-you-go GLM.
    expect(resolveVendorBaseUrl('glmcodingplan', 'global')).toBe('https://api.z.ai/api/anthropic')
    expect(resolveVendorBaseUrl('glmcodingplan', 'china')).toBe(
      'https://open.bigmodel.cn/api/anthropic'
    )
    // The OpenAI route swaps /api/paas/v4 for the coding-plan /api/coding/paas/v4.
    expect(resolveVendorOpenAiBaseUrl('glmcodingplan', 'global')).toBe(
      'https://api.z.ai/api/coding/paas/v4'
    )
    expect(resolveVendorOpenAiBaseUrl('glmcodingplan', 'china')).toBe(
      'https://open.bigmodel.cn/api/coding/paas/v4'
    )
    // Quota-based plan: fixed catalog, no live model-list refresh.
    expect(resolveVendorModelsUrl('glmcodingplan')).toBeUndefined()
    expect(defaultVendorModel('glmcodingplan')).toBe('glm-5.2')
    // The coding plan drops GLM's vision variant, so it serves no multimodal model.
    expect(isVendorModelMultimodal('glmcodingplan', 'glm-5v-turbo')).toBe(false)
    expect(isVendorModelMultimodal('glmcodingplan', 'glm-5.2')).toBe(false)
    // Each region points at its own subscription console.
    expect(resolveVendorApiKeyUrl('glmcodingplan', 'global')).toBe('https://z.ai/subscribe')
    expect(resolveVendorApiKeyUrl('glmcodingplan', 'china')).toBe('https://bigmodel.cn/glm-coding')
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

  it('routes SenseNova through both APIs with a curated chat catalog', () => {
    expect(resolveVendorApiEndpoints('sensenova')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorBaseUrl('sensenova')).toBe('https://token.sensenova.cn')
    expect(resolveVendorOpenAiBaseUrl('sensenova')).toBe('https://token.sensenova.cn/v1')
    expect(resolveVendorApiKeyUrl('sensenova')).toBe('https://platform.sensenova.cn/token-plan')
    // The live list also serves the image-generation-only sensenova-u1-fast, which the refresh
    // cannot filter out — so refresh-from-vendor is hidden and the chat catalog stays curated.
    expect(resolveVendorModelsUrl('sensenova')).toBeUndefined()
    expect(defaultVendorModel('sensenova')).toBe('sensenova-6.7-flash-lite')
  })

  it('routes Volcengine Ark through all three APIs with a curated Doubao Seed catalog', () => {
    expect(resolveVendorApiEndpoints('volcengine')).toEqual(['anthropic', 'openai', 'responses'])
    expect(resolveVendorBaseUrl('volcengine')).toBe(
      'https://ark.cn-beijing.volces.com/api/compatible'
    )
    expect(resolveVendorOpenAiBaseUrl('volcengine')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3'
    )
    expect(resolveVendorApiKeyUrl('volcengine')).toBe(
      'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey'
    )
    // Ark's catalog also serves embedding/image/video models the refresh cannot filter out —
    // so refresh-from-vendor is hidden and the Doubao Seed chat catalog stays curated.
    expect(resolveVendorModelsUrl('volcengine')).toBeUndefined()
    expect(defaultVendorModel('volcengine')).toBe('doubao-seed-2-1-pro-260628')
  })

  it('routes Kimi through both APIs so Codex can bridge it', () => {
    expect(resolveVendorApiEndpoints('kimi')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorBaseUrl('kimi')).toBe('https://api.moonshot.cn/anthropic')
    expect(resolveVendorOpenAiBaseUrl('kimi')).toBe('https://api.moonshot.cn/v1')
    expect(resolveVendorModelsUrl('kimi')).toBe('https://api.moonshot.cn/v1/models')
  })

  it('routes StepFun through all three APIs, per region, with a live model list', () => {
    expect(resolveVendorApiEndpoints('stepfun')).toEqual(['anthropic', 'openai', 'responses'])
    expect(vendorHasRegions('stepfun')).toBe(true)
    // Global (.ai) is the first region and the fallback for an unknown region.
    expect(resolveVendorBaseUrl('stepfun')).toBe('https://api.stepfun.ai')
    expect(resolveVendorOpenAiBaseUrl('stepfun')).toBe('https://api.stepfun.ai/v1')
    expect(resolveVendorModelsUrl('stepfun')).toBe('https://api.stepfun.ai/v1/models')
    expect(resolveVendorApiKeyUrl('stepfun')).toBe('https://platform.stepfun.ai/interface-key')
    // China (.com) console.
    expect(resolveVendorBaseUrl('stepfun', 'china')).toBe('https://api.stepfun.com')
    expect(resolveVendorOpenAiBaseUrl('stepfun', 'china')).toBe('https://api.stepfun.com/v1')
    expect(resolveVendorModelsUrl('stepfun', 'china')).toBe('https://api.stepfun.com/v1/models')
    expect(resolveVendorApiKeyUrl('stepfun', 'china')).toBe(
      'https://platform.stepfun.com/interface-key'
    )
    expect(defaultVendorModel('stepfun')).toBe('step-3.7-flash')
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

    it('returns true only for the SenseNova vision model', () => {
      expect(isVendorModelMultimodal('sensenova', 'sensenova-6.7-flash-lite')).toBe(true)
      expect(isVendorModelMultimodal('sensenova', 'deepseek-v4-flash')).toBe(false)
    })

    it('returns true for Volcengine Ark Seed 2.x general models but not the coding model', () => {
      expect(isVendorModelMultimodal('volcengine', 'doubao-seed-2-1-pro-260628')).toBe(true)
      expect(isVendorModelMultimodal('volcengine', 'doubao-seed-2-0-pro-260215')).toBe(true)
      expect(isVendorModelMultimodal('volcengine', 'doubao-seed-2-0-lite-260215')).toBe(true)
      expect(isVendorModelMultimodal('volcengine', 'doubao-seed-2-0-mini-260215')).toBe(true)
      expect(isVendorModelMultimodal('volcengine', 'doubao-seed-2-0-code-preview-260215')).toBe(
        false
      )
    })

    it('returns true only for the StepFun multimodal flash model', () => {
      expect(isVendorModelMultimodal('stepfun', 'step-3.7-flash')).toBe(true)
      expect(isVendorModelMultimodal('stepfun', 'step-3.5-flash')).toBe(false)
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

  describe('resolveModelContextWindow', () => {
    it('declares a positive context window directly on every bundled model', () => {
      for (const vendor of OFFICIAL_VENDORS) {
        for (const model of vendor.models) {
          expect(model.contextWindow, `${vendor.id}/${model.id}`).toBeGreaterThan(0)
          expect(resolveModelContextWindow(vendor.id, model.id)).toBe(model.contextWindow)
        }
      }
    })

    it('keeps 1m bundled variants explicit and recognizes the suffix for unknown live models', () => {
      expect(resolveModelContextWindow('anthropic', 'claude-opus-4-8[1m]')).toBe(1_000_000)
      expect(resolveModelContextWindow('deepseek', 'deepseek-v4-pro[1m]')).toBe(1_000_000)
      expect(resolveModelContextWindow('minimax', 'MiniMax-M3[1m]')).toBe(1_000_000)
      expect(resolveModelContextWindow('anthropic', 'future-claude[1m]')).toBe(1_000_000)
    })

    it('resolves shipped models with vendor-published per-model limits', () => {
      expect(resolveModelContextWindow('anthropic', 'claude-opus-4-8')).toBe(1_000_000)
      expect(resolveModelContextWindow('anthropic', 'claude-haiku-4-5-20251001')).toBe(200_000)
      expect(resolveModelContextWindow('openai', 'gpt-5.6-sol')).toBe(1_050_000)
      expect(resolveModelContextWindow('openai', 'gpt-5.4-mini')).toBe(400_000)
      expect(resolveModelContextWindow('deepseek', 'deepseek-v4-flash')).toBe(1_000_000)
      expect(resolveModelContextWindow('zhipu', 'glm-5.2')).toBe(1_000_000)
      expect(resolveModelContextWindow('zhipu', 'glm-5.1')).toBe(200_000)
      expect(resolveModelContextWindow('kimi', 'kimi-k3')).toBe(1_000_000)
      expect(resolveModelContextWindow('kimi', 'kimi-k2.7-code')).toBe(256_000)
    })

    it('resolves OpenRouter cross-vendor slugs from OpenRouter metadata', () => {
      expect(resolveModelContextWindow('openrouter', 'anthropic/claude-opus-4.8')).toBe(1_000_000)
      expect(resolveModelContextWindow('openrouter', 'google/gemini-3.1-pro-preview')).toBe(
        1_048_576
      )
      expect(resolveModelContextWindow('openrouter', 'x-ai/grok-4.5')).toBe(500_000)
      expect(resolveModelContextWindow('openrouter', 'deepseek/deepseek-v4-pro')).toBe(1_048_576)
    })

    it('uses the conservative fallback for an unknown live-fetched model but not a missing id', () => {
      expect(resolveModelContextWindow('openai', 'totally-unknown-model')).toBe(200_000)
      expect(resolveModelContextWindow('anthropic', undefined)).toBeUndefined()
    })
  })

  describe('resolveCustomModelContextWindow', () => {
    it('uses the configured size and falls back to 200k when the user leaves it blank', () => {
      expect(resolveCustomModelContextWindow(64_000)).toBe(64_000)
      expect(resolveCustomModelContextWindow(undefined)).toBe(200_000)
    })
  })
})

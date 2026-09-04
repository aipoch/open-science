import { describe, expect, it } from 'vitest'

import {
  OFFICIAL_VENDORS,
  defaultVendorModel,
  getOfficialVendor,
  isOfficialVendorId,
  isVendorModelMultimodal,
  isVendorModelResponsesSupported,
  resolveCustomModelContextWindow,
  resolveModelContextWindow,
  resolveVendorApiEndpoints,
  resolveVendorApiKeyUrl,
  resolveVendorBaseUrl,
  resolveVendorModelApiEndpoints,
  resolveVendorModelsUrl,
  resolveVendorModelReasoningEffort,
  resolveVendorOpenAiBaseUrl,
  usesVendorAnthropicApiKeyHeader,
  vendorHasRegions,
  type OfficialVendorId
} from './provider-registry'

describe('provider registry', () => {
  it('defines exactly one of baseUrl or regions per vendor, with a non-empty catalog', () => {
    for (const vendor of OFFICIAL_VENDORS) {
      const hasBaseUrl = Boolean(vendor.baseUrl)
      const hasRegions = (vendor.regions?.length ?? 0) > 0

      expect(hasBaseUrl).not.toBe(hasRegions) // exactly one is set
      expect(vendor.models.length).toBeGreaterThan(0)
      expect(vendor.reasoningEffort).toBeDefined()
    }
  })

  it('narrows known vendor ids and rejects unknown values', () => {
    expect(isOfficialVendorId('deepseek')).toBe(true)
    expect(isOfficialVendorId('openai')).toBe(true)
    expect(isOfficialVendorId('xai')).toBe(true)
    expect(isOfficialVendorId('apodex')).toBe(true)
    expect(isOfficialVendorId('tencent')).toBe(true)
    expect(isOfficialVendorId('tencentcodingplan')).toBe(true)
    expect(isOfficialVendorId('tencenttokenplan')).toBe(true)
    expect(isOfficialVendorId('nvidia')).toBe(true)
    expect(isOfficialVendorId(undefined)).toBe(false)
    expect(isOfficialVendorId(42)).toBe(false)
  })

  it('places Grok immediately after Anthropic in the official provider picker', () => {
    const anthropicIndex = OFFICIAL_VENDORS.findIndex((vendor) => vendor.id === 'anthropic')

    expect(anthropicIndex).toBeGreaterThanOrEqual(0)
    expect(OFFICIAL_VENDORS[anthropicIndex + 1]?.id).toBe('xai')
  })

  it('places OpenCode Go and Zen before OpenRouter with curated mixed-protocol catalogs', () => {
    const openRouterIndex = OFFICIAL_VENDORS.findIndex((vendor) => vendor.id === 'openrouter')
    const goModels = getOfficialVendor('opencode-go')?.models.map(({ id }) => id)
    const zenModels = getOfficialVendor('opencode')?.models.map(({ id }) => id)

    expect(
      OFFICIAL_VENDORS.slice(openRouterIndex - 2, openRouterIndex + 1).map(({ id }) => id)
    ).toEqual(['opencode-go', 'opencode', 'openrouter'])
    expect(resolveVendorBaseUrl('opencode-go')).toBe('https://opencode.ai/zen/go/v1')
    expect(resolveVendorBaseUrl('opencode')).toBe('https://opencode.ai/zen/v1')
    expect(resolveVendorApiEndpoints('opencode-go')).toEqual(['openai'])
    expect(resolveVendorApiEndpoints('opencode')).toEqual(['openai'])
    expect(resolveVendorModelsUrl('opencode-go')).toBeUndefined()
    expect(resolveVendorModelsUrl('opencode')).toBeUndefined()
    expect(defaultVendorModel('opencode-go')).toBe('kimi-k2.7-code')
    expect(defaultVendorModel('opencode')).toBe('kimi-k2.7-code')
    expect(goModels).toEqual([
      'kimi-k2.7-code',
      'grok-4.6',
      'gpt-5.6-luna',
      'glm-5.3-flash',
      'glm-5.3',
      'glm-5.2',
      'glm-5.1',
      'kimi-k3',
      'kimi-k2.6',
      'longcat-2.0',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'minimax-m3',
      'muse-spark-1.2-contributor',
      'qwen3.8-max',
      'qwen3.7-max',
      'qwen3.7-plus',
      'hy3'
    ])
    expect(zenModels).toEqual([
      'kimi-k2.7-code',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'grok-4.6',
      'gpt-5.5',
      'gpt-5.5-pro',
      'gpt-5.4',
      'gpt-5.4-pro',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5.1',
      'gpt-5',
      'gpt-5-nano',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'grok-4.5',
      'grok-build-0.1',
      'muse-spark-1.2',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.5-plus',
      'kimi-k3',
      'kimi-k2.6',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'minimax-m3',
      'glm-5.2',
      'glm-5.1'
    ])
    for (const excluded of ['minimax-m2.7', 'minimax-m2.5', 'qwen3.6-plus']) {
      expect(goModels).not.toContain(excluded)
      expect(zenModels).not.toContain(excluded)
    }
    expect(resolveVendorModelApiEndpoints('opencode-go', 'kimi-k2.7-code')).toEqual(['openai'])
    expect(resolveVendorModelApiEndpoints('opencode-go', 'grok-4.6')).toEqual(['responses'])
    expect(resolveVendorModelApiEndpoints('opencode-go', 'minimax-m3')).toEqual(['anthropic'])
    expect(resolveVendorModelApiEndpoints('opencode', 'gpt-5.6-sol')).toEqual(['responses'])
    expect(resolveVendorModelApiEndpoints('opencode', 'claude-opus-5')).toEqual(['anthropic'])
    expect(resolveVendorModelApiEndpoints('opencode', 'minimax-m3')).toEqual(['openai'])
    expect(isVendorModelMultimodal('opencode-go', 'glm-5.3-flash')).toBe(true)
    expect(isVendorModelMultimodal('opencode', 'gpt-5.3-codex-spark')).toBe(false)
  })

  it('routes NVIDIA through Chat Completions with a curated agent catalog', () => {
    expect(resolveVendorApiEndpoints('nvidia')).toEqual(['openai'])
    expect(resolveVendorBaseUrl('nvidia')).toBe('https://integrate.api.nvidia.com/v1')
    expect(resolveVendorApiKeyUrl('nvidia')).toBe('https://build.nvidia.com/settings/api-keys')
    expect(resolveVendorModelsUrl('nvidia')).toBeUndefined()
    expect(defaultVendorModel('nvidia')).toBe('nvidia/nemotron-3.5-lightning-30b-a3b')
    expect(getOfficialVendor('nvidia')?.models.map(({ id }) => id)).toEqual([
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'deepseek-ai/deepseek-v4-pro-0813',
      'minimaxai/minimax-m3',
      'poolside/laguna-xs-2.1',
      'meta/muse-glimmer-30b',
      'moonshotai/kimi-k3'
    ])
    expect(isVendorModelMultimodal('nvidia', 'minimaxai/minimax-m3')).toBe(true)
    expect(isVendorModelMultimodal('nvidia', 'meta/muse-glimmer-30b')).toBe(true)
    expect(isVendorModelMultimodal('nvidia', 'moonshotai/kimi-k3')).toBe(true)
    expect(isVendorModelMultimodal('nvidia', 'poolside/laguna-xs-2.1')).toBe(false)
  })

  it('resolves a single-endpoint vendor base URL', () => {
    expect(resolveVendorBaseUrl('openai')).toBe('https://api.openai.com')
    expect(getOfficialVendor('openai')?.apiEndpoints).toEqual(['responses'])
    expect(resolveVendorBaseUrl('deepseek')).toBe('https://api.deepseek.com/anthropic')
    expect(getOfficialVendor('deepseek')?.label).toBe('DeepSeek')
  })

  it('ships DeepSeek V4 with a vision-capable flash experimental model', () => {
    expect(
      getOfficialVendor('deepseek')?.models.map(({ id, contextWindow }) => ({ id, contextWindow }))
    ).toEqual([
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro[1m]', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-vision-exp', contextWindow: 1_000_000 }
    ])
    expect(defaultVendorModel('deepseek')).toBe('deepseek-v4-pro')
    expect(resolveVendorOpenAiBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1')
    expect(resolveVendorApiEndpoints('deepseek')).toEqual(['anthropic', 'openai'])
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

  it('offers GLM-4.5-Air through the official Zhipu provider', () => {
    expect(getOfficialVendor('zhipu')?.models).toContainEqual({
      id: 'glm-4.5-air',
      contextWindow: 128_000
    })
  })

  it('offers GLM-5.3 through the pay-as-you-go Zhipu provider', () => {
    expect(getOfficialVendor('zhipu')?.models).toContainEqual({
      id: 'glm-5.3',
      contextWindow: 1_000_000,
      reasoningEffort: 'low-high-max'
    })
  })

  it('offers GLM-5.3-Flash through both Zhipu provider types', () => {
    const expected = {
      id: 'glm-5.3-flash',
      contextWindow: 1_000_000,
      reasoningEffort: 'low-high-max'
    }

    expect(getOfficialVendor('zhipu')?.models).toContainEqual(expected)
    expect(getOfficialVendor('glmcodingplan')?.models).toContainEqual(expected)
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
    expect(defaultVendorModel('glmcodingplan')).toBe('glm-5.3')
    // The coding plan omits the older vision variant but serves the natively multimodal Flash model.
    expect(isVendorModelMultimodal('glmcodingplan', 'glm-5v-turbo')).toBe(false)
    expect(isVendorModelMultimodal('glmcodingplan', 'glm-5.3-flash')).toBe(true)
    expect(isVendorModelMultimodal('glmcodingplan', 'glm-5.3')).toBe(false)
    expect(isVendorModelMultimodal('glmcodingplan', 'glm-5.2')).toBe(false)
    // Each region points at its own subscription console.
    expect(resolveVendorApiKeyUrl('glmcodingplan', 'global')).toBe('https://z.ai/subscribe')
    expect(resolveVendorApiKeyUrl('glmcodingplan', 'china')).toBe('https://bigmodel.cn/glm-coding')
  })

  it('exposes the first catalog entry as the default model', () => {
    expect(defaultVendorModel('openai')).toBe('gpt-5.6-sol')
    expect(defaultVendorModel('xai')).toBe('grok-4.6')
    expect(defaultVendorModel('zhipu')).toBe('glm-5.3')
  })

  it('resolves model-specific static reasoning effort profiles without network discovery', () => {
    expect(resolveVendorModelReasoningEffort('openai', 'gpt-5.5')).toEqual({
      supported: true,
      slots: ['none', 'low', 'medium', 'high', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('deepseek', 'deepseek-v4-pro')).toEqual({
      supported: true,
      slots: ['none', 'high', 'max', 'max', 'max']
    })
    expect(resolveVendorModelReasoningEffort('glmcodingplan', 'glm-5.3')).toEqual({
      supported: true,
      slots: ['low', 'high', 'max', 'max', 'max']
    })
    expect(resolveVendorModelReasoningEffort('zhipu', 'glm-5.3-flash')).toEqual({
      supported: true,
      slots: ['low', 'high', 'max', 'max', 'max']
    })
    expect(resolveVendorModelReasoningEffort('glmcodingplan', 'glm-5.3-flash')).toEqual({
      supported: true,
      slots: ['low', 'high', 'max', 'max', 'max']
    })
    expect(resolveVendorModelReasoningEffort('stepfun', 'step-3.7-flash')).toEqual({
      supported: true,
      slots: ['low', 'medium', 'high', 'high', 'high']
    })
    expect(resolveVendorModelReasoningEffort('anthropic', 'claude-haiku-4-5-20251001')).toEqual({
      supported: false
    })
    expect(resolveVendorModelReasoningEffort('xai', 'grok-4.5')).toEqual({
      supported: true,
      slots: ['low', 'medium', 'high', 'xhigh', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('xai', 'grok-4.3')).toEqual({
      supported: true,
      slots: ['none', 'low', 'medium', 'high', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('xai', 'grok-build-0.1')).toEqual({
      supported: false
    })
    expect(resolveVendorModelReasoningEffort('minimax', 'MiniMax-M3')).toEqual({
      supported: true,
      slots: ['none', 'high', 'high', 'high', 'high']
    })
    expect(resolveVendorModelReasoningEffort('minimax', 'MiniMax-M2.7')).toEqual({
      supported: false
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'deepseek/deepseek-v4-pro')).toEqual({
      supported: true,
      slots: ['none', 'high', 'xhigh', 'xhigh', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'z-ai/glm-5.2')).toEqual({
      supported: true,
      slots: ['none', 'high', 'xhigh', 'xhigh', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'anthropic/claude-haiku-4.5')).toEqual({
      supported: false
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'anthropic/claude-opus-5')).toEqual({
      supported: true,
      slots: ['low', 'medium', 'high', 'xhigh', 'max']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'openai/gpt-5.6-terra')).toEqual({
      supported: true,
      slots: ['none', 'low', 'medium', 'high', 'max']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'openai/gpt-5.5-pro')).toEqual({
      supported: true,
      slots: ['medium', 'high', 'xhigh', 'xhigh', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'openai/gpt-5.5')).toEqual({
      supported: true,
      slots: ['none', 'low', 'medium', 'high', 'xhigh']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'moonshotai/kimi-k3')).toEqual({
      supported: true,
      slots: ['low', 'high', 'max', 'max', 'max']
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'google/gemini-3.6-flash')).toEqual({
      supported: true,
      slots: ['minimal', 'low', 'medium', 'high', 'high']
    })
    expect(
      resolveVendorModelReasoningEffort('openrouter', 'google/gemini-3.1-pro-preview')
    ).toEqual({ supported: false })
    expect(resolveVendorModelReasoningEffort('openrouter', 'x-ai/grok-4.5')).toEqual({
      supported: false
    })
    expect(resolveVendorModelReasoningEffort('openrouter', 'qwen/qwen3.7-max')).toEqual({
      supported: true,
      slots: ['none', 'high', 'high', 'high', 'high']
    })
    expect(resolveVendorModelReasoningEffort('deepseek', undefined)).toEqual({
      supported: true,
      slots: ['none', 'high', 'max', 'max', 'max']
    })
  })

  it('ships only unsupported or two-to-five-choice static model profiles', () => {
    for (const vendor of OFFICIAL_VENDORS) {
      for (const model of vendor.models) {
        const profile = resolveVendorModelReasoningEffort(vendor.id, model.id)
        if (!profile.supported) continue

        expect(new Set(profile.slots).size).toBeGreaterThanOrEqual(2)
        expect(new Set(profile.slots).size).toBeLessThanOrEqual(5)
      }
    }
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
    expect(defaultVendorModel('openrouter')).toBe('anthropic/claude-opus-5')
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

  it('routes Tencent TokenHub through all three APIs with regional keys and curated models', () => {
    expect(resolveVendorApiEndpoints('tencent')).toEqual(['anthropic', 'openai', 'responses'])
    expect(usesVendorAnthropicApiKeyHeader('tencent')).toBe(true)
    expect(usesVendorAnthropicApiKeyHeader('deepseek')).toBe(false)
    expect(vendorHasRegions('tencent')).toBe(true)
    expect(resolveVendorBaseUrl('tencent')).toBe('https://tokenhub-intl.tencentcloudmaas.com')
    expect(resolveVendorOpenAiBaseUrl('tencent')).toBe(
      'https://tokenhub-intl.tencentcloudmaas.com/v1'
    )
    expect(resolveVendorApiKeyUrl('tencent')).toBe(
      'https://console.tencentcloud.com/tokenhub/apikey'
    )
    expect(resolveVendorBaseUrl('tencent', 'china')).toBe('https://tokenhub.tencentmaas.com')
    expect(resolveVendorOpenAiBaseUrl('tencent', 'china')).toBe(
      'https://tokenhub.tencentmaas.com/v1'
    )
    expect(resolveVendorApiKeyUrl('tencent', 'china')).toBe(
      'https://console.cloud.tencent.com/tokenhub/apikey'
    )
    expect(resolveVendorModelsUrl('tencent')).toBeUndefined()
    expect(defaultVendorModel('tencent')).toBe('hy4-preview')
    expect(getOfficialVendor('tencent')?.models.map(({ id }) => id)).toEqual([
      'hy4-preview',
      'glm-5.3',
      'glm-5.3-flash',
      'kimi-k3',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'minimax-m3'
    ])
    expect(resolveModelContextWindow('tencent', 'hy4-preview')).toBe(1_000_000)
    expect(resolveModelContextWindow('tencent', 'kimi-k3')).toBe(1_048_576)
    expect(isVendorModelResponsesSupported('tencent', 'glm-5.3')).toBe(true)
    expect(isVendorModelResponsesSupported('tencent', 'deepseek-v4-flash')).toBe(true)
    expect(isVendorModelResponsesSupported('tencent', 'deepseek-v4-pro')).toBe(true)
    expect(isVendorModelResponsesSupported('tencent', 'minimax-m3')).toBe(true)
    expect(isVendorModelResponsesSupported('tencent', 'hy4-preview')).toBe(true)
    expect(isVendorModelMultimodal('tencent', 'hy4-preview')).toBe(false)
    expect(resolveVendorModelReasoningEffort('tencent', 'hy4-preview')).toEqual({
      supported: false
    })
  })

  it('routes Tencent Coding Plan through its mainland subscription endpoints', () => {
    expect(resolveVendorApiEndpoints('tencentcodingplan')).toEqual(['anthropic', 'openai'])
    expect(vendorHasRegions('tencentcodingplan')).toBe(false)
    expect(resolveVendorBaseUrl('tencentcodingplan')).toBe(
      'https://api.lkeap.cloud.tencent.com/coding/anthropic'
    )
    expect(resolveVendorOpenAiBaseUrl('tencentcodingplan')).toBe(
      'https://api.lkeap.cloud.tencent.com/coding/v3'
    )
    expect(resolveVendorApiKeyUrl('tencentcodingplan')).toBe(
      'https://console.cloud.tencent.com/tokenhub/codingplan'
    )
    expect(getOfficialVendor('tencentcodingplan')?.models.map(({ id }) => id)).toEqual([
      'deepseek-v4-flash-202605',
      'deepseek-v4-pro-202606',
      'minimax-m2.7',
      'glm-5',
      'glm-5.1',
      'glm-5.2',
      'hy3'
    ])
    expect(defaultVendorModel('tencentcodingplan')).toBe('deepseek-v4-flash-202605')
    expect(resolveVendorModelsUrl('tencentcodingplan')).toBeUndefined()
    expect(isVendorModelResponsesSupported('tencentcodingplan', 'glm-5.2')).toBe(false)
  })

  it('routes Tencent Token Plan through its international subscription endpoints', () => {
    expect(resolveVendorApiEndpoints('tencenttokenplan')).toEqual(['anthropic', 'openai'])
    expect(vendorHasRegions('tencenttokenplan')).toBe(false)
    expect(resolveVendorBaseUrl('tencenttokenplan')).toBe(
      'https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic'
    )
    expect(resolveVendorOpenAiBaseUrl('tencenttokenplan')).toBe(
      'https://tokenhub-intl.tencentcloudmaas.com/plan/v3'
    )
    expect(resolveVendorApiKeyUrl('tencenttokenplan')).toBe(
      'https://console.intl.cloud.tencent.com/tokenhub/tokenplan'
    )
    expect(getOfficialVendor('tencenttokenplan')?.models.map(({ id }) => id)).toEqual([
      'glm-5.2',
      'kimi-k2.6',
      'deepseek-v4-pro-202606',
      'deepseek-v4-flash-202605',
      'minimax-m3'
    ])
    expect(defaultVendorModel('tencenttokenplan')).toBe('glm-5.2')
    expect(resolveVendorModelsUrl('tencenttokenplan')).toBeUndefined()
    expect(isVendorModelMultimodal('tencenttokenplan', 'kimi-k2.6')).toBe(true)
    expect(isVendorModelMultimodal('tencenttokenplan', 'glm-5.2')).toBe(false)
  })

  it('routes Grok through xAI Chat Completions and Responses with a curated model catalog', () => {
    expect(resolveVendorApiEndpoints('xai')).toEqual(['openai', 'responses'])
    expect(resolveVendorBaseUrl('xai')).toBe('https://api.x.ai')
    expect(resolveVendorOpenAiBaseUrl('xai')).toBe('https://api.x.ai/v1')
    expect(resolveVendorApiKeyUrl('xai')).toBe('https://console.x.ai/team/default/api-keys')
    // xAI's live catalog also includes image, audio, and video generation models, so keep refresh
    // hidden and expose only the curated language-model catalog.
    expect(resolveVendorModelsUrl('xai')).toBeUndefined()
    expect(defaultVendorModel('xai')).toBe('grok-4.6')
  })

  it('routes Apodex core models through Messages and Chat Completions', () => {
    expect(resolveVendorApiEndpoints('apodex')).toEqual(['anthropic', 'openai'])
    expect(resolveVendorBaseUrl('apodex')).toBe('https://api.apodex.ai')
    expect(resolveVendorOpenAiBaseUrl('apodex')).toBe('https://api.apodex.ai/v1')
    expect(resolveVendorApiKeyUrl('apodex')).toBe('https://platform.apodex.ai/console')
    expect(resolveVendorModelsUrl('apodex')).toBeUndefined()
    expect(usesVendorAnthropicApiKeyHeader('apodex')).toBe(true)
    expect(getOfficialVendor('apodex')?.models).toEqual([
      { id: 'apodex-1.1', contextWindow: 262_144 },
      { id: 'apodex-1.1-mini', contextWindow: 262_144 }
    ])
    expect(defaultVendorModel('apodex')).toBe('apodex-1.1')
    expect(isVendorModelMultimodal('apodex', 'apodex-1.1')).toBe(false)
    expect(isVendorModelResponsesSupported('apodex', 'apodex-1.1')).toBe(false)
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

  it('routes Bailian Responses only for the documented Qwen models', () => {
    const bailianId = 'bailian' as OfficialVendorId

    expect(isOfficialVendorId('bailian')).toBe(true)
    expect(resolveVendorApiEndpoints(bailianId)).toEqual(['anthropic', 'openai'])
    expect(isVendorModelResponsesSupported(bailianId, 'qwen3.8-max')).toBe(true)
    expect(isVendorModelResponsesSupported(bailianId, 'qwen3.7-max')).toBe(true)
    expect(isVendorModelResponsesSupported(bailianId, 'qwen3.6-flash')).toBe(true)
    expect(isVendorModelResponsesSupported(bailianId, 'deepseek-v4-pro')).toBe(false)
    expect(isVendorModelResponsesSupported(bailianId, 'deepseek-v4-flash')).toBe(false)
    expect(vendorHasRegions(bailianId)).toBe(true)

    // Mainland China is the default; the overseas region swaps only the DashScope host.
    expect(resolveVendorBaseUrl(bailianId)).toBe(
      'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages'
    )
    expect(resolveVendorOpenAiBaseUrl(bailianId)).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1'
    )
    expect(resolveVendorBaseUrl(bailianId, 'global')).toBe(
      'https://dashscope-us.aliyuncs.com/apps/anthropic/v1/messages'
    )
    expect(resolveVendorOpenAiBaseUrl(bailianId, 'global')).toBe(
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
    )
    expect(resolveVendorApiKeyUrl(bailianId)).toBe(
      'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key'
    )
    expect(resolveVendorApiKeyUrl(bailianId, 'global')).toBe(
      'https://modelstudio.console.alibabacloud.com/us-east-1?tab=model#/api-key'
    )

    expect(
      getOfficialVendor(bailianId)?.models.map(({ id, contextWindow }) => ({ id, contextWindow }))
    ).toEqual([
      { id: 'qwen3.8-max', contextWindow: 983_616 },
      { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.7-max', contextWindow: 1_000_000 },
      { id: 'qwen3.7-flash', contextWindow: 1_000_000 },
      { id: 'qwen3.6-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-0731', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 }
    ])
    expect(defaultVendorModel(bailianId)).toBe('qwen3.8-max')
    expect(resolveVendorModelsUrl(bailianId)).toBeUndefined()
  })

  it('does not advertise Responses support for Bailian for Plan', () => {
    const planId = 'bailianplan' as OfficialVendorId

    expect(isOfficialVendorId('bailianplan')).toBe(true)
    expect(resolveVendorApiEndpoints(planId)).toEqual(['anthropic', 'openai'])
    expect(vendorHasRegions(planId)).toBe(false)
    expect(resolveVendorBaseUrl(planId)).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'
    )
    expect(resolveVendorOpenAiBaseUrl(planId)).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    )
    expect(resolveVendorApiKeyUrl(planId)).toBe(
      'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview'
    )

    expect(
      getOfficialVendor(planId)?.models.map(({ id, contextWindow }) => ({ id, contextWindow }))
    ).toEqual([
      { id: 'qwen3.8-max', contextWindow: 983_616 },
      { id: 'qwen3.8-max-preview', contextWindow: 983_616 },
      { id: 'qwen3.7-max', contextWindow: 1_000_000 },
      { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-0731', contextWindow: 1_000_000 }
    ])
    expect(defaultVendorModel(planId)).toBe('qwen3.8-max')
    expect(resolveVendorModelsUrl(planId)).toBeUndefined()

    expect(isVendorModelResponsesSupported(planId, 'qwen3.8-max')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'qwen3.8-max-preview')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'qwen3.7-max')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'qwen3.7-plus')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'qwen3.6-flash')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'glm-5.2')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'deepseek-v4-pro')).toBe(false)
    expect(isVendorModelResponsesSupported(planId, 'deepseek-v4-flash-0731')).toBe(false)
  })

  it('exposes the documented qwen3.8 reasoning effort levels for both Bailian plans', () => {
    const expectedProfile = {
      supported: true,
      slots: ['low', 'medium', 'xhigh', 'xhigh', 'xhigh']
    }

    expect(resolveVendorModelReasoningEffort('bailian', 'qwen3.8-max')).toEqual(expectedProfile)
    expect(resolveVendorModelReasoningEffort('bailianplan', 'qwen3.8-max')).toEqual(expectedProfile)
    expect(resolveVendorModelReasoningEffort('bailianplan', 'qwen3.8-max-preview')).toEqual(
      expectedProfile
    )
  })

  it('limits Bailian Chat reasoning effort to the documented model families', () => {
    const highMaxProfile = {
      supported: true,
      slots: ['high', 'max', 'max', 'max', 'max']
    }

    expect(resolveVendorModelReasoningEffort('bailian', 'deepseek-v4-pro')).toEqual(highMaxProfile)
    expect(resolveVendorModelReasoningEffort('bailian', 'deepseek-v4-flash')).toEqual(
      highMaxProfile
    )
    expect(resolveVendorModelReasoningEffort('bailian', 'deepseek-v4-flash-0731')).toEqual(
      highMaxProfile
    )
    expect(resolveVendorModelReasoningEffort('bailianplan', 'glm-5.2')).toEqual(highMaxProfile)
    expect(resolveVendorModelReasoningEffort('bailianplan', 'deepseek-v4-pro')).toEqual(
      highMaxProfile
    )
    expect(resolveVendorModelReasoningEffort('bailianplan', 'deepseek-v4-flash-0731')).toEqual(
      highMaxProfile
    )
    expect(resolveVendorModelReasoningEffort('bailian', 'qwen3.7-plus')).toEqual({
      supported: false
    })
  })

  it('uses the qwen3.8 context window published for Codex integrations', () => {
    expect(resolveModelContextWindow('bailian', 'qwen3.8-max')).toBe(983_616)
    expect(resolveModelContextWindow('bailianplan', 'qwen3.8-max')).toBe(983_616)
    expect(resolveModelContextWindow('bailianplan', 'qwen3.8-max-preview')).toBe(983_616)
  })

  it('routes Step Plan over Anthropic and OpenAI under /step_plan, no live model list', () => {
    expect(resolveVendorApiEndpoints('stepplan')).toEqual(['anthropic', 'openai'])
    expect(vendorHasRegions('stepplan')).toBe(false)
    expect(resolveVendorBaseUrl('stepplan')).toBe('https://api.stepfun.com/step_plan')
    expect(resolveVendorOpenAiBaseUrl('stepplan')).toBe('https://api.stepfun.com/step_plan/v1')
    // Quota-based plan: fixed catalog, no "refresh from vendor" endpoint.
    expect(resolveVendorModelsUrl('stepplan')).toBeUndefined()
    expect(resolveVendorApiKeyUrl('stepplan')).toBe('https://platform.stepfun.com/plan-subscribe')
    expect(defaultVendorModel('stepplan')).toBe('step-3.7-flash')
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

    it('returns true for all curated Grok language models', () => {
      expect(isVendorModelMultimodal('xai', 'grok-4.5')).toBe(true)
      expect(isVendorModelMultimodal('xai', 'grok-4.3')).toBe(true)
      expect(isVendorModelMultimodal('xai', 'grok-build-0.1')).toBe(true)
    })

    it('treats Anthropic/OpenAI as vision-capable for live-fetched ids not in the bundled catalog', () => {
      // allMultimodal vendors must cover models the live model-list refresh surfaces, not just the
      // shipped ids — otherwise a refreshed Claude/GPT model would wrongly be flagged text-only.
      expect(isVendorModelMultimodal('anthropic', 'claude-opus-5-future')).toBe(true)
      expect(isVendorModelMultimodal('openai', 'gpt-6-turbo')).toBe(true)
    })

    it('returns true only for the DeepSeek vision-exp model', () => {
      expect(isVendorModelMultimodal('deepseek', 'deepseek-v4-flash-vision-exp')).toBe(true)
      expect(isVendorModelMultimodal('deepseek', 'deepseek-v4-pro')).toBe(false)
      expect(isVendorModelMultimodal('deepseek', 'deepseek-v4-flash')).toBe(false)
    })

    it('matches the multimodal Qwen models in the Bailian catalog', () => {
      const bailianId = 'bailian' as OfficialVendorId

      expect(isVendorModelMultimodal(bailianId, 'qwen3.8-max')).toBe(true)
      expect(isVendorModelMultimodal(bailianId, 'qwen3.7-plus')).toBe(true)
      expect(isVendorModelMultimodal(bailianId, 'qwen3.7-flash')).toBe(true)
      expect(isVendorModelMultimodal(bailianId, 'qwen3.6-plus')).toBe(true)
      expect(isVendorModelMultimodal(bailianId, 'qwen3.6-flash')).toBe(true)
      expect(isVendorModelMultimodal(bailianId, 'qwen3.7-max')).toBe(false)
      expect(isVendorModelMultimodal(bailianId, 'deepseek-v4-pro')).toBe(false)
    })

    it('matches the visual-understanding models in the Bailian for Plan catalog', () => {
      const planId = 'bailianplan' as OfficialVendorId

      expect(isVendorModelMultimodal(planId, 'qwen3.8-max')).toBe(true)
      expect(isVendorModelMultimodal(planId, 'qwen3.8-max-preview')).toBe(true)
      expect(isVendorModelMultimodal(planId, 'qwen3.7-plus')).toBe(true)
      expect(isVendorModelMultimodal(planId, 'qwen3.6-flash')).toBe(true)
      expect(isVendorModelMultimodal(planId, 'qwen3.7-max')).toBe(false)
      expect(isVendorModelMultimodal(planId, 'glm-5.2')).toBe(false)
      expect(isVendorModelMultimodal(planId, 'deepseek-v4-pro')).toBe(false)
    })

    it('matches Zhipu vision variants by pattern plus GLM-5.3-Flash explicitly', () => {
      expect(isVendorModelMultimodal('zhipu', 'glm-5v-turbo')).toBe(true)
      expect(isVendorModelMultimodal('zhipu', 'glm-5.3-flash')).toBe(true)
      // The pattern generalizes to future vision variants the live refresh may surface.
      expect(isVendorModelMultimodal('zhipu', 'glm-6v')).toBe(true)
      expect(isVendorModelMultimodal('zhipu', 'glm-5.2')).toBe(false)
      expect(isVendorModelMultimodal('zhipu', 'glm-5.1')).toBe(false)
      expect(isVendorModelMultimodal('zhipu', 'glm-5-turbo')).toBe(false)
    })

    it('returns true only for MiniMax M3 models', () => {
      expect(isVendorModelMultimodal('minimax', 'MiniMax-M3')).toBe(true)
      expect(isVendorModelMultimodal('minimax', 'MiniMax-M3[1m]')).toBe(true)
      expect(isVendorModelMultimodal('minimax', 'MiniMax-M2.7')).toBe(false)
      expect(isVendorModelMultimodal('minimax', 'MiniMax-M2.5')).toBe(false)
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
      expect(isVendorModelMultimodal('volcengine', 'doubao-seed-2-1-turbo-260628')).toBe(true)
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
      expect(isVendorModelMultimodal('stepplan', 'step-3.7-flash')).toBe(true)
      expect(isVendorModelMultimodal('stepplan', 'step-3.5-flash-2603')).toBe(false)
      expect(isVendorModelMultimodal('stepplan', 'step-router-v1')).toBe(false)
    })

    it('returns true for OpenRouter vision-capable models', () => {
      expect(isVendorModelMultimodal('openrouter', 'anthropic/claude-opus-5')).toBe(true)
      expect(isVendorModelMultimodal('openrouter', 'anthropic/claude-opus-4.8')).toBe(true)
      expect(isVendorModelMultimodal('openrouter', 'openai/gpt-5.5')).toBe(true)
      expect(isVendorModelMultimodal('openrouter', 'google/gemini-3.6-flash')).toBe(true)
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

  describe('isVendorModelResponsesSupported', () => {
    it('returns true for every model of a vendor that declares responses in apiEndpoints', () => {
      // xAI and MiniMax declare vendor-level 'responses', so their whole catalog supports it.
      expect(isVendorModelResponsesSupported('xai', 'grok-4.5')).toBe(true)
      expect(isVendorModelResponsesSupported('xai', 'grok-build-0.1')).toBe(true)
      expect(isVendorModelResponsesSupported('minimax', 'MiniMax-M3')).toBe(true)
      expect(isVendorModelResponsesSupported('volcengine', 'doubao-seed-2-1-pro-260628')).toBe(true)
    })

    it('returns true for every bundled DeepSeek V4 model', () => {
      expect(isVendorModelResponsesSupported('deepseek', 'deepseek-v4-pro')).toBe(true)
      expect(isVendorModelResponsesSupported('deepseek', 'deepseek-v4-pro[1m]')).toBe(true)
      expect(isVendorModelResponsesSupported('deepseek', 'deepseek-v4-flash')).toBe(true)
      expect(isVendorModelResponsesSupported('deepseek', 'deepseek-v4-flash-vision-exp')).toBe(true)
      expect(resolveVendorModelApiEndpoints('deepseek', 'deepseek-v4-pro')).toEqual([
        'anthropic',
        'openai',
        'responses'
      ])
    })

    it('returns false for unknown DeepSeek models', () => {
      expect(isVendorModelResponsesSupported('deepseek', 'deepseek-v3')).toBe(false)
    })

    it('returns false for vendors with no Responses support at all', () => {
      expect(isVendorModelResponsesSupported('zhipu', 'glm-5.2')).toBe(false)
      expect(isVendorModelResponsesSupported('kimi', 'kimi-k3')).toBe(false)
      expect(isVendorModelResponsesSupported('anthropic', 'claude-opus-5')).toBe(false)
    })

    it('returns false for an undefined model id', () => {
      expect(isVendorModelResponsesSupported('deepseek', undefined)).toBe(false)
      expect(isVendorModelResponsesSupported('xai', undefined)).toBe(false)
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
      expect(resolveModelContextWindow('xai', 'grok-4.5')).toBe(500_000)
      expect(resolveModelContextWindow('xai', 'grok-4.3')).toBe(1_000_000)
      expect(resolveModelContextWindow('xai', 'grok-build-0.1')).toBe(256_000)
      expect(resolveModelContextWindow('deepseek', 'deepseek-v4-flash')).toBe(1_000_000)
      expect(resolveModelContextWindow('deepseek', 'deepseek-v4-flash-vision-exp')).toBe(1_000_000)
      expect(resolveModelContextWindow('glmcodingplan', 'glm-5.3')).toBe(1_000_000)
      expect(resolveModelContextWindow('zhipu', 'glm-5.3-flash')).toBe(1_000_000)
      expect(resolveModelContextWindow('glmcodingplan', 'glm-5.3-flash')).toBe(1_000_000)
      expect(resolveModelContextWindow('zhipu', 'glm-5.2')).toBe(1_000_000)
      expect(resolveModelContextWindow('zhipu', 'glm-5.1')).toBe(200_000)
      expect(resolveModelContextWindow('kimi', 'kimi-k3')).toBe(1_000_000)
      expect(resolveModelContextWindow('kimi', 'kimi-k2.7-code')).toBe(256_000)
    })

    it('resolves OpenRouter cross-vendor slugs from OpenRouter metadata', () => {
      expect(resolveModelContextWindow('openrouter', 'anthropic/claude-opus-5')).toBe(1_000_000)
      expect(resolveModelContextWindow('openrouter', 'anthropic/claude-opus-4.8')).toBe(1_000_000)
      expect(resolveModelContextWindow('openrouter', 'google/gemini-3.6-flash')).toBe(1_048_576)
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

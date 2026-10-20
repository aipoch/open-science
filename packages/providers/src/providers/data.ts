import type { OfficialVendor } from './types'

// The shipped vendor set. Each entry owns its endpoint and catalog; model lists are intentionally
// conservative so a vendor's unrelated model types do not appear in the composer.
const definitions: readonly OfficialVendor[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] },
    apiEndpoints: ['responses'],
    baseUrl: 'https://api.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    // The API exposes a broader mixed catalog (embeddings, image, and audio models); keep the coding
    // catalog curated here instead of importing every id from /v1/models.
    models: [
      {
        id: 'gpt-5.6-sol',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'ultra'] }
      },
      {
        id: 'gpt-6-astra',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      // https://developers.openai.com/api/docs/models/gpt-6.1-sol
      {
        id: 'gpt-6.1-sol',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'gpt-6-sol',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'gpt-6-luna',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'gpt-5.6-terra',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'ultra'] }
      },
      {
        id: 'gpt-5.6-luna',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      // GPT-5.5 documents none as its latency-first, no-reasoning mode.
      {
        id: 'gpt-5.5',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      { id: 'gpt-5.4', contextWindow: 1_050_000 },
      { id: 'gpt-5.4-mini', contextWindow: 400_000 }
    ],
    // The curated coding catalog is all GPT-5+, which is vision-capable across the board.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    baseUrl: 'https://api.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    modelsListUrl: 'https://api.anthropic.com/v1/models',
    models: [
      { id: 'claude-opus-5', contextWindow: 1_000_000 },
      { id: 'claude-opus-5-5', contextWindow: 1_000_000 },
      { id: 'claude-fable-5-1', contextWindow: 1_000_000 },
      { id: 'claude-opus-4-8', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5', contextWindow: 1_000_000 },
      { id: 'claude-sonnet-5-5', contextWindow: 1_000_000 },
      // https://platform.claude.com/docs/en/models/haiku-5-5/overview
      { id: 'claude-haiku-5-5', contextWindow: 1_000_000 },
      {
        id: 'claude-haiku-4-5-20251001',
        contextWindow: 200_000,
        reasoningEffort: { supported: false }
      }
    ],
    // Every current Claude model is vision-capable, including any surfaced by the live model-list
    // refresh above — so this is a blanket rule, not the four bundled ids.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    // xAI documents four selectable effort values for Grok 4.6 and 4.7. Models with a different capability
    // override this default below; models without a documented effort control stay unsupported.
    reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] },
    // xAI serves OpenAI-compatible Chat Completions and native Responses from the same versioned
    // `/v1` base. Keep the bare API root in baseUrl for the official-vendor invariant and publish the
    // exact versioned base separately so OpenCode, validation, and Codex do not append another `/v1`.
    apiEndpoints: ['chat-completions', 'responses'],
    baseUrl: 'https://api.x.ai',
    chatCompletionsBaseUrl: 'https://api.x.ai/v1',
    apiKeyUrl: 'https://console.x.ai/team/default/api-keys',
    // Curated from xAI's language-model catalog. The live /v1/models response also includes image,
    // audio, and video generation models, so exposing refresh would pollute the chat-model picker.
    // Experimental Grok 4.20 beta variants are intentionally omitted from the stable default list.
    models: [
      // https://docs.x.ai/developers/grok-4-7
      { id: 'grok-4.7', contextWindow: 500_000 },
      { id: 'grok-4.6', contextWindow: 500_000 },
      { id: 'grok-4.5', contextWindow: 500_000 },
      {
        id: 'grok-4.3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      { id: 'grok-build-0.1', contextWindow: 256_000, reasoningEffort: { supported: false } }
    ],
    // Every curated xAI language model accepts text and image input.
    multimodal: { allMultimodal: true }
  },
  {
    id: 'apodex',
    label: 'Apodex',
    // Apodex exposes only a thinking on/off switch, not the product's effort ladder.
    reasoningEffort: { supported: false },
    apiEndpoints: ['messages', 'chat-completions'],
    messagesApiKeyHeader: true,
    baseUrl: 'https://api.apodex.ai',
    chatCompletionsBaseUrl: 'https://api.apodex.ai/v1',
    apiKeyUrl: 'https://platform.apodex.ai/console',
    // Keep this curated: the account catalog can also contain Deep Research SKUs with different
    // request semantics, while this provider entry is for the two core text models.
    models: [
      { id: 'apodex-1.1', contextWindow: 262_144 },
      { id: 'apodex-1.1-mini', contextWindow: 262_144 }
    ]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // DeepSeek V4 supports an explicit thinking-off switch plus high/max reasoning effort.
    reasoningEffort: { supported: true, values: ['none', 'high', 'max'] },
    // DeepSeek exposes both routes: Anthropic /v1/messages under `/anthropic`, and the OpenAI-compatible
    // route under `/v1`. The same model ids work on both, so it's safe to prefer OpenAI where the
    // framework supports it (e.g. OpenCode). chatCompletionsBaseUrl is the exact version-carrying base clients
    // append `/chat/completions` to. Native Responses uses the documented origin base instead.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://api.deepseek.com/anthropic',
    chatCompletionsBaseUrl: 'https://api.deepseek.com/v1',
    responsesBaseUrl: 'https://api.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    modelsListUrl: 'https://api.deepseek.com/v1/models',
    models: [
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      // DeepSeek V4.1 Flash uses the stable API id deepseek-flash.
      { id: 'deepseek-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-vision-exp', contextWindow: 1_000_000 }
    ],
    // Bundled DeepSeek V4 models serve the native Responses API. Keep the explicit list because the
    // vendor also exposes non-Responses models through its live model catalog.
    responsesModels: [
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp'
    ],
    // V4.1 Flash accepts image input; the legacy Flash ids now route to the same model.
    // Keep Pro text-only, and apply these capabilities to ids received through live refresh too.
    multimodal: {
      multimodalModels: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']
    }
  },
  {
    id: 'bailian',
    label: 'Bailian',
    // Keep effort hidden for models that only expose protocol-specific thinking controls. Models
    // with a documented cross-protocol effort vocabulary override this default below.
    reasoningEffort: { supported: false },
    // Both regions expose Anthropic Messages plus OpenAI-compatible Chat Completions. Responses is
    // available only for the Qwen models listed below.
    // The Anthropic URL is kept in its documented full-endpoint form; the shared URL normalizer strips
    // `/v1/messages` before Claude Code/OpenCode append their own protocol suffix.
    apiEndpoints: ['messages', 'chat-completions'],
    regions: [
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages',
        chatCompletionsBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key'
      },
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://dashscope-us.aliyuncs.com/apps/anthropic/v1/messages',
        chatCompletionsBaseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
        apiKeyUrl: 'https://modelstudio.console.alibabacloud.com/us-east-1?tab=model#/api-key'
      }
    ],
    // Curated from Bailian's model marketplace. Keep refresh hidden because the full catalog also
    // contains image, audio, video, embedding, and other models outside this chat-provider surface.
    models: [
      {
        id: 'qwen3.8-max',
        contextWindow: 983_616,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'xhigh'] }
      },
      { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.7-max', contextWindow: 1_000_000 },
      { id: 'qwen3.7-flash', contextWindow: 1_000_000 },
      { id: 'qwen3.6-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
      {
        id: 'deepseek-v4-flash-0731',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      {
        id: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      {
        id: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      }
    ],
    responsesModels: [
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.7-max',
      'qwen3.7-flash',
      'qwen3.6-plus',
      'qwen3.6-flash'
    ],
    multimodal: {
      multimodalModels: [
        'qwen3.8-max',
        'qwen3.7-plus',
        'qwen3.7-flash',
        'qwen3.6-plus',
        'qwen3.6-flash'
      ]
    }
  },
  {
    id: 'bailianplan',
    label: 'Bailian for Plan',
    // The qwen3.8, GLM, and DeepSeek entries below override this conservative default.
    reasoningEffort: { supported: false },
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    chatCompletionsBaseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    apiKeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview',
    models: [
      {
        id: 'qwen3.8-max',
        contextWindow: 983_616,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'xhigh'] }
      },
      {
        id: 'qwen3.8-max-preview',
        contextWindow: 983_616,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'xhigh'] }
      },
      { id: 'qwen3.7-max', contextWindow: 1_000_000 },
      { id: 'qwen3.7-plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
      {
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      {
        id: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      {
        id: 'deepseek-v4-flash-0731',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      }
    ],
    multimodal: {
      multimodalModels: ['qwen3.8-max', 'qwen3.8-max-preview', 'qwen3.7-plus', 'qwen3.6-flash']
    }
  },
  {
    id: 'zhipu',
    label: 'Zhipu AI (GLM)',
    reasoningEffort: { supported: false },
    // GLM serves overseas from Z.AI and mainland China from BigModel (智谱) — different hosts and
    // separate consoles, so they are distinct endpoints rather than one base URL. Each region also
    // publishes an OpenAI-compatible route under `/api/paas/v4` (not `/v1`), so Codex can bridge it.
    apiEndpoints: ['messages', 'chat-completions'],
    regions: [
      {
        id: 'global',
        label: 'Global (Z.AI)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        chatCompletionsBaseUrl: 'https://api.z.ai/api/paas/v4',
        apiKeyUrl: 'https://z.ai'
      },
      {
        id: 'china',
        label: 'China (BigModel)',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        chatCompletionsBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
      }
    ],
    models: [
      {
        id: 'glm-5.3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'high', 'max'] }
      },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5v-turbo', contextWindow: 200_000 },
      { id: 'glm-5-turbo', contextWindow: 200_000 },
      { id: 'glm-4.5-air', contextWindow: 128_000 }
    ],
    // GLM usually marks vision variants with a `v` after the major version (e.g. glm-5v-turbo), but
    // GLM-5.3-Flash is also natively multimodal without that marker.
    multimodal: {
      multimodalModelPattern: /glm-\d+v/i,
      multimodalModels: ['glm-5.3-flash']
    }
  },
  {
    id: 'glmcodingplan',
    label: 'GLM Coding Plan',
    reasoningEffort: { supported: false },
    // The GLM Coding Plan subscription (Z.AI's z.ai/subscribe, BigModel's glm-coding): a quota-based
    // plan that reuses GLM's regions but routes the OpenAI path through `/api/coding/paas/v4` instead
    // of `/api/paas/v4`. The Anthropic route (`/api/anthropic`) is unchanged from the pay-as-you-go
    // GLM endpoint. Quota-based catalogs ship a fixed model list and expose no live model list.
    apiEndpoints: ['messages', 'chat-completions'],
    regions: [
      {
        id: 'global',
        label: 'Global (Z.AI)',
        baseUrl: 'https://api.z.ai/api/anthropic',
        chatCompletionsBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
        apiKeyUrl: 'https://z.ai/subscribe'
      },
      {
        id: 'china',
        label: 'China (BigModel)',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        chatCompletionsBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKeyUrl: 'https://bigmodel.cn/glm-coding'
      }
    ],
    // The coding plan omits glm-5v-turbo, but serves the natively multimodal GLM-5.3-Flash.
    models: [
      {
        id: 'glm-5.3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'high', 'max'] }
      },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5-turbo', contextWindow: 200_000 }
    ],
    multimodal: { multimodalModels: ['glm-5.3-flash'] }
  },
  {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // Moonshot serves both routes on one host: Anthropic /v1/messages under `/anthropic` and the
    // OpenAI-compatible /v1/chat/completions under `/v1` (see the live model list below). `both` lets
    // Codex drive it through the Responses->Chat bridge.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://api.moonshot.cn/anthropic',
    chatCompletionsBaseUrl: 'https://api.moonshot.cn/v1',
    apiKeyUrl: 'https://platform.kimi.com/console',
    modelsListUrl: 'https://api.moonshot.cn/v1/models',
    models: [
      { id: 'kimi-k3', contextWindow: 1_000_000 },
      { id: 'kimi-k2.7-code', contextWindow: 256_000 },
      { id: 'kimi-k2.6', contextWindow: 256_000 },
      { id: 'kimi-k2.5', contextWindow: 256_000 }
    ],
    // Vision arrives with the k3 generation; older k2.x chat models are text-only.
    multimodal: { multimodalModels: ['kimi-k3'] }
  },
  {
    id: 'kimiforcode',
    label: 'Kimi For Coding',
    reasoningEffort: { supported: true, values: ['low', 'high', 'max'] },
    // The Kimi Code subscription endpoint: quota-based models (billed against a periodically refreshing
    // quota rather than per token), so it ships a fixed catalog and exposes no live model list. It
    // serves both the Anthropic route and the OpenAI-compatible /v1/chat/completions under `/coding/v1`
    // (Kimi documents this plan for Codex and OpenCode), so `both` lets Codex bridge it.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://api.kimi.com/coding',
    chatCompletionsBaseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyUrl: 'https://www.kimi.com/code/docs',
    models: [
      {
        id: 'kimi-k3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      { id: 'kimi-for-coding', contextWindow: 1_048_576 },
      { id: 'kimi-for-coding-highspeed', contextWindow: 256_000 }
    ],
    // Only the k3 model in this plan is vision-capable; the coding-tuned ids are text-only.
    multimodal: { multimodalModels: ['kimi-k3', 'kimi-for-coding'] }
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    reasoningEffort: { supported: false },
    // MiniMax serves the Anthropic /v1/messages route under `/anthropic`, plus the OpenAI-compatible
    // /v1/chat/completions and OpenAI Responses /v1/responses under `/v1`, from a Global host (.io) and
    // a mainland-China one (.com). `baseUrl` is the Anthropic route; `chatCompletionsBaseUrl` is the `/v1` base
    // clients append `/chat/completions` to, and the Responses probe derives `/v1/responses` from it.
    apiEndpoints: ['messages', 'chat-completions', 'responses'],
    regions: [
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://api.minimax.io/anthropic',
        chatCompletionsBaseUrl: 'https://api.minimax.io/v1',
        apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key'
      },
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        chatCompletionsBaseUrl: 'https://api.minimaxi.com/v1',
        apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key'
      }
    ],
    models: [
      // MiniMax documents M3 reasoning as a binary thinking switch: none disables thinking and high
      // enables Adaptive Thinking. Older M2 models remain conservative until documented otherwise.
      {
        id: 'MiniMax-M3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      // M3.1 always thinks and supports five effort levels (default: max). Keep M3 as the
      // default and retain the Preview id for existing selections.
      // https://platform.minimax.cn/docs/guides/text-generation
      {
        id: 'MiniMax-M3.1-Flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'MiniMax-M3.1-Flash-Preview',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      { id: 'MiniMax-M2.7', contextWindow: 204_800 },
      { id: 'MiniMax-M2.5', contextWindow: 204_800 }
    ],
    // M3 and M3.1 are natively multimodal; older M2 models remain text-only.
    multimodal: {
      multimodalModels: ['MiniMax-M3', 'MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview']
    }
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] },
    // StepFun serves all three routes on one host per region — Anthropic /v1/messages, the
    // OpenAI-compatible /v1/chat/completions, and OpenAI Responses /v1/responses — from an overseas
    // console (.ai) and a mainland-China one (.com). `baseUrl` is the bare root (the Anthropic client
    // appends /v1/messages); `chatCompletionsBaseUrl` is the /v1 base clients append /chat/completions to, and
    // the Responses probe derives /v1/responses from it.
    apiEndpoints: ['messages', 'chat-completions', 'responses'],
    regions: [
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://api.stepfun.ai',
        chatCompletionsBaseUrl: 'https://api.stepfun.ai/v1',
        apiKeyUrl: 'https://platform.stepfun.ai/interface-key',
        modelsListUrl: 'https://api.stepfun.ai/v1/models'
      },
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://api.stepfun.com',
        chatCompletionsBaseUrl: 'https://api.stepfun.com/v1',
        apiKeyUrl: 'https://platform.stepfun.com/interface-key',
        modelsListUrl: 'https://api.stepfun.com/v1/models'
      }
    ],
    models: [
      { id: 'step-5-preview', contextWindow: 1_000_000 },
      { id: 'step-3.7-flash', contextWindow: 262_144 },
      { id: 'step-3.5-flash', contextWindow: 262_144 }
    ],
    // Step 5 Preview and step-3.7-flash are multimodal; step-3.5-flash is text-only.
    multimodal: { multimodalModels: ['step-5-preview', 'step-3.7-flash'] }
  },
  {
    id: 'stepplan',
    label: 'Step Plan',
    reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] },
    // StepFun's Step Plan is a quota-based subscription that routes under `/step_plan` on both the
    // mainland-China and overseas hosts: Anthropic /v1/messages and the OpenAI-compatible
    // /v1/chat/completions. Keep China first so historical providers without a region continue to
    // resolve to the former `.com` endpoint. Quota plans ship a fixed catalog and expose no live model
    // list.
    apiEndpoints: ['messages', 'chat-completions'],
    regions: [
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://api.stepfun.com/step_plan',
        chatCompletionsBaseUrl: 'https://api.stepfun.com/step_plan/v1',
        apiKeyUrl: 'https://platform.stepfun.com/plan-subscribe'
      },
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://api.stepfun.ai/step_plan',
        chatCompletionsBaseUrl: 'https://api.stepfun.ai/step_plan/v1',
        apiKeyUrl: 'https://platform.stepfun.ai/plan-subscribe'
      }
    ],
    // step-router-v1 auto-switches between deepseek-v4-pro and step-3.7-flash; step-3.5-flash-2603 is
    // the high-frequency-agent build. Step 5 Preview leads as the recommended flagship default.
    models: [
      { id: 'step-5-preview', contextWindow: 1_000_000 },
      { id: 'step-3.7-flash', contextWindow: 262_144 },
      { id: 'step-3.5-flash', contextWindow: 262_144 },
      {
        id: 'step-3.5-flash-2603',
        contextWindow: 262_144,
        reasoningEffort: { supported: true, values: ['low', 'high'] }
      },
      { id: 'step-router-v1', contextWindow: 262_144 }
    ],
    // Step 5 Preview and step-3.7-flash are multimodal; the agent/code builds are text-only.
    multimodal: { multimodalModels: ['step-5-preview', 'step-3.7-flash'] }
  },
  {
    id: 'xiaomimimo',
    label: 'Xiaomi MIMO',
    reasoningEffort: { supported: true, values: ['none', 'high'] },
    // Xiaomi MiMo exposes both routes: Anthropic /v1/messages under `/anthropic` and the OpenAI-compatible
    // /v1/chat/completions under `/v1`. The same model ids work on both.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    chatCompletionsBaseUrl: 'https://api.xiaomimimo.com/v1',
    apiKeyUrl: 'https://platform.xiaomimimo.com/console/api-keys',
    modelsListUrl: 'https://api.xiaomimimo.com/v1/models',
    models: [
      { id: 'mimo-v2.6-pro', contextWindow: 1_000_000 },
      { id: 'mimo-v2.6-flash', contextWindow: 1_000_000 },
      { id: 'mimo-v2.6-pro-ultraspeed', contextWindow: 1_000_000 },
      { id: 'mimo-v2.5-pro', contextWindow: 1_000_000 },
      { id: 'mimo-v2.5', contextWindow: 1_000_000 }
    ],
    // V2.6 supports image input on both APIs; keep capabilities scoped to the documented ids.
    // https://mimo.mi.com/docs/en-US/news/latest/v2-6
    multimodal: {
      multimodalModels: ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed']
    }
  },
  {
    id: 'sensenova',
    label: 'SenseNova',
    reasoningEffort: { supported: false },
    // SenseTime's SenseNova serves both routes on one host: the Anthropic-compatible /v1/messages
    // at the bare root and the OpenAI-compatible /v1/chat/completions under /v1.
    // https://platform.sensenova.cn/docs documents the newer hosted models on Chat Completions;
    // do not infer Messages support (including Kimi vision) from their original vendors.
    // Keep the catalog curated: /v1/models also includes image-only U1 models and refresh does
    // not filter output modalities.
    apiEndpoints: ['messages', 'chat-completions'],
    regions: [
      // Keep China first: pre-region provider records must retain their original endpoint.
      {
        id: 'china',
        label: 'China',
        baseUrl: 'https://token.sensenova.cn',
        chatCompletionsBaseUrl: 'https://token.sensenova.cn/v1',
        apiKeyUrl: 'https://platform.sensenova.cn/console/keys'
      },
      {
        id: 'global',
        label: 'Global',
        baseUrl: 'https://token.sensenova.ai',
        chatCompletionsBaseUrl: 'https://token.sensenova.ai/v1',
        apiKeyUrl: 'https://platform.sensenova.ai/console/keys',
        // https://platform.sensenova.ai/docs lists only Flash Lite as a chat model.
        modelIds: ['sensenova-6.8-flash-lite']
      }
    ],
    models: [
      { id: 'sensenova-6.8-flash-lite', contextWindow: 262_144 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000, apiEndpoint: 'chat-completions' },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'glm-5.2', contextWindow: 1_000_000, apiEndpoint: 'chat-completions' },
      { id: 'kimi-k3', contextWindow: 1_000_000, apiEndpoint: 'chat-completions' },
      // Preserve pinned selections without silently migrating them to a different model.
      { id: 'sensenova-6.7-flash-lite', contextWindow: 256_000 }
    ],
    multimodal: {
      multimodalModels: ['sensenova-6.8-flash-lite', 'kimi-k3', 'sensenova-6.7-flash-lite']
    }
  },
  {
    id: 'volcengine',
    label: 'Volcengine Ark',
    reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] },
    // ByteDance's Volcengine Ark serves all three routes on one host: the Anthropic-compatible
    // /v1/messages under /api/compatible, the OpenAI-compatible /v1/chat/completions under /api/v3,
    // and OpenAI Responses at /api/v3/responses (the probe derives it from `chatCompletionsBaseUrl`). The same
    // model ids work on all three. No modelsListUrl: Ark's catalog also serves embedding, image
    // (Seedream), and video (Seedance) models alongside the chat ids, and the refresh has no
    // modality filter — so the chat catalog stays curated.
    apiEndpoints: ['messages', 'chat-completions', 'responses'],
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    chatCompletionsBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    // Official model cards and effort mappings (verified 2026-09-16):
    // https://console.volcengine.com/ark/region:cn-beijing/model
    // https://www.volcengine.com/docs/82379/1449737
    models: [
      { id: 'doubao-seed-2-1-pro-260915', contextWindow: 1_024_000 },
      {
        id: 'deepseek-v4-1-flash-260910',
        contextWindow: 1_024_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'high', 'max'] }
      },
      {
        id: 'glm-5-3-flash-260828',
        contextWindow: 1_024_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      // Keep dated selections pinned; a catalog update must not replace an existing model.
      { id: 'doubao-seed-2-1-pro-260628', contextWindow: 256_000 },
      { id: 'doubao-seed-2-1-turbo-260628', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-pro-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-lite-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-mini-260215', contextWindow: 256_000 },
      { id: 'doubao-seed-2-0-code-preview-260215', contextWindow: 256_000 }
    ],
    // Explicit image-input support; the older code-preview coding model remains text-only.
    multimodal: {
      multimodalModels: [
        'doubao-seed-2-1-pro-260915',
        'deepseek-v4-1-flash-260910',
        'glm-5-3-flash-260828',
        'doubao-seed-2-1-pro-260628',
        'doubao-seed-2-1-turbo-260628',
        'doubao-seed-2-0-pro-260215',
        'doubao-seed-2-0-lite-260215',
        'doubao-seed-2-0-mini-260215'
      ]
    }
  },
  {
    id: 'tencent',
    label: 'Tencent TokenHub',
    reasoningEffort: { supported: false },
    // TokenHub exposes Anthropic Messages, OpenAI Chat Completions, and Responses from regional
    // hosts. China and International are separate account sites with distinct consoles, API keys,
    // and domains, so keep the site explicit rather than retrying credentials across editions. The
    // broader TokenHub catalog also contains non-language models, so this provider stays curated.
    apiEndpoints: ['messages', 'chat-completions', 'responses'],
    messagesApiKeyHeader: true,
    regions: [
      {
        id: 'international',
        label: 'International (Singapore)',
        baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com',
        chatCompletionsBaseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
        apiKeyUrl: 'https://console.tencentcloud.com/tokenhub/apikey'
      },
      {
        id: 'china',
        label: 'China (Guangzhou)',
        baseUrl: 'https://tokenhub.tencentmaas.com',
        chatCompletionsBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
        apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub/apikey'
      }
    ],
    models: [
      { id: 'hy4-preview', contextWindow: 1_000_000 },
      { id: 'glm-5.3', contextWindow: 1_000_000 },
      { id: 'glm-5.3-flash', contextWindow: 1_000_000 },
      { id: 'kimi-k3', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'minimax-m3', contextWindow: 1_000_000 }
    ]
    // The curated language models above are text-only in TokenHub's model matrix, so no
    // `multimodal` rule.
  },
  {
    id: 'tencentcodingplan',
    label: 'Tencent Coding Plan',
    reasoningEffort: { supported: false },
    // Mainland China's subscription plan exposes separate Anthropic Messages and OpenAI Chat
    // Completions routes. Tencent documents ANTHROPIC_AUTH_TOKEN for the former, so it keeps the
    // default Authorization: Bearer transport. Accepted aliases are intentionally omitted so the
    // picker shows each model once; the first documented id is the canonical selection.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
    chatCompletionsBaseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
    apiKeyUrl: 'https://console.cloud.tencent.com/tokenhub/codingplan',
    models: [
      { id: 'deepseek-v4-flash-202605', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro-202606', contextWindow: 1_000_000 },
      { id: 'minimax-m2.7', contextWindow: 204_800 },
      { id: 'glm-5', contextWindow: 200_000 },
      { id: 'glm-5.1', contextWindow: 200_000 },
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'hy3', contextWindow: 256_000 }
    ]
  },
  {
    id: 'tencenttokenplan',
    label: 'Tencent Token Plan',
    reasoningEffort: { supported: false },
    // The international subscription is a distinct product with its own key, endpoints, and model
    // catalog. Its Claude Code guide also uses ANTHROPIC_AUTH_TOKEN (Authorization: Bearer). Keep it
    // separate from both mainland Coding Plan and pay-as-you-go Tencent TokenHub.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic',
    chatCompletionsBaseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3',
    apiKeyUrl: 'https://console.intl.cloud.tencent.com/tokenhub/tokenplan',
    models: [
      { id: 'glm-5.2', contextWindow: 1_000_000 },
      { id: 'kimi-k2.6', contextWindow: 256_000 },
      { id: 'deepseek-v4-pro-202606', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-flash-202605', contextWindow: 1_000_000 },
      { id: 'minimax-m3', contextWindow: 1_000_000 }
    ],
    multimodal: { multimodalModels: ['kimi-k2.6'] }
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    reasoningEffort: { supported: false },
    apiEndpoints: ['chat-completions'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    // The live catalog mixes chat, embedding, image, OCR, safety, and other model types, so keep the
    // agent-capable chat catalog curated instead of exposing refresh-from-vendor.
    models: [
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', contextWindow: 1_000_000 },
      { id: 'deepseek-ai/deepseek-v4-pro-0813', contextWindow: 1_000_000 },
      { id: 'minimaxai/minimax-m3', contextWindow: 1_000_000 },
      { id: 'poolside/laguna-xs-2.1', contextWindow: 262_144 },
      { id: 'meta/muse-glimmer-30b', contextWindow: 131_072 },
      { id: 'moonshotai/kimi-k3', contextWindow: 1_048_576 }
    ],
    multimodal: {
      multimodalModels: ['minimaxai/minimax-m3', 'meta/muse-glimmer-30b', 'moonshotai/kimi-k3']
    }
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    reasoningEffort: { supported: false },
    apiEndpoints: ['chat-completions'],
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyUrl: 'https://opencode.ai/zen',
    // OpenCode documents one protocol per model. Keep the catalog bundled so deprecated and temporary
    // free entries do not appear through the broader live model endpoint.
    models: [
      { id: 'kimi-k2.7-code', contextWindow: 262_144 },
      {
        id: 'grok-4.7',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'grok-4.6',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.6-luna',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      { id: 'glm-5.1', contextWindow: 202_752 },
      { id: 'kimi-k3', contextWindow: 1_048_576 },
      { id: 'kimi-k2.6', contextWindow: 262_144 },
      {
        id: 'longcat-2.0',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'deepseek-v4.1-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      {
        id: 'deepseek-v4-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'deepseek-v4-flash-vision-exp',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'high', 'max'] }
      },
      { id: 'mimo-v2.6-flash', contextWindow: 1_048_576 },
      { id: 'mimo-v2.6-pro', contextWindow: 1_048_576 },
      { id: 'mimo-v2.5', contextWindow: 1_000_000 },
      { id: 'mimo-v2.5-pro', contextWindow: 1_048_576 },
      {
        id: 'minimax-m3',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'muse-spark-1.3-contributor',
        contextWindow: 1_048_576,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'muse-spark-1.2-contributor',
        contextWindow: 1_048_576,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'qwen3.8-max',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'qwen3.8-flash',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'xhigh'] }
      },
      {
        id: 'qwen3.7-max',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'qwen3.7-plus',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'hy4-preview',
        contextWindow: 1_024_000,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'hy3',
        contextWindow: 256_000,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      }
    ],
    multimodal: {
      multimodalModels: [
        'kimi-k2.7-code',
        'grok-4.7',
        'grok-4.6',
        'gpt-5.6-luna',
        'glm-5.3-flash',
        'kimi-k3',
        'kimi-k2.6',
        'deepseek-v4.1-flash',
        'deepseek-v4-flash-vision-exp',
        'mimo-v2.6-flash',
        'mimo-v2.6-pro',
        'mimo-v2.5',
        'mimo-v2.5-pro',
        'muse-spark-1.3-contributor',
        'muse-spark-1.2-contributor',
        'qwen3.8-max',
        'qwen3.8-flash',
        'qwen3.7-plus'
      ]
    }
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    reasoningEffort: { supported: false },
    apiEndpoints: ['chat-completions'],
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyUrl: 'https://opencode.ai/zen',
    // Zen also mixes protocols. Exclude Google-native, deprecated, and explicitly
    // product-excluded models while preserving the existing Kimi default. Legacy lower-tier
    // models are not backfilled, and the transient limited-time free entries stay out (the
    // two grandfathered free models at the tail predate that policy).
    // New entries verified against Zen docs/live models and models.dev (opencode), 2026-10-03.
    // Sonnet 5.5 uses the Anthropic SDK in models.dev while the Zen endpoint table catches up.
    models: [
      { id: 'kimi-k2.7-code', contextWindow: 262_144 },
      {
        id: 'gpt-6-astra',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'gpt-6.1-sol',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'gpt-6-sol',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'gpt-6-luna',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'gpt-5.6-sol',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'gpt-5.6-terra',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'gpt-5.6-luna',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'claude-fable-5-1',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-fable-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-opus-5-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-opus-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-sonnet-5-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-sonnet-5',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'grok-4.7',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'grok-4.6',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.5',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.5-pro',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.4',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.4-pro',
        contextWindow: 1_050_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.4-mini',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.4-nano',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.3-codex',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.3-codex-spark',
        contextWindow: 128_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.2',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'gpt-5.1',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] }
      },
      {
        id: 'gpt-5',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'gpt-5-nano',
        contextWindow: 400_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'claude-opus-4-8',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-opus-4-7',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'claude-opus-4-6',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'max'] }
      },
      {
        id: 'claude-opus-4-5',
        contextWindow: 200_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] }
      },
      {
        id: 'claude-sonnet-4-6',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'max'] }
      },
      { id: 'claude-sonnet-4-5', contextWindow: 1_000_000, apiEndpoint: 'messages' },
      { id: 'claude-haiku-4-5', contextWindow: 200_000, apiEndpoint: 'messages' },
      {
        id: 'grok-4.5',
        contextWindow: 500_000,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] }
      },
      { id: 'grok-build-0.1', contextWindow: 256_000, apiEndpoint: 'responses' },
      {
        id: 'muse-spark-1.3',
        contextWindow: 1_048_576,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'muse-spark-1.2',
        contextWindow: 1_048_576,
        apiEndpoint: 'responses',
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'qwen3.8-max',
        contextWindow: 262_144,
        apiEndpoint: 'chat-completions',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'qwen3.8-flash',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['low', 'medium', 'xhigh'] }
      },
      {
        id: 'qwen3.7-max',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'qwen3.7-plus',
        contextWindow: 1_000_000,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'qwen3.5-plus',
        contextWindow: 262_144,
        apiEndpoint: 'messages',
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      { id: 'kimi-k3', contextWindow: 1_048_576 },
      {
        id: 'kimi-k2.6',
        contextWindow: 262_144,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      {
        id: 'deepseek-v4.1-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'deepseek-v4-flash-vision-exp',
        contextWindow: 1_000_000,
        apiEndpoint: 'chat-completions',
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
      { id: 'minimax-m3', contextWindow: 512_000 },
      {
        id: 'glm-5.3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['high', 'max'] }
      },
      {
        id: 'glm-5.1',
        contextWindow: 204_800,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      // Free Chat Completions models documented at https://opencode.ai/docs/zen/.
      // Context and vision metadata: https://models.dev/api.json (opencode), checked 2026-09-13.
      { id: 'big-pickle', contextWindow: 200_000, apiEndpoint: 'chat-completions' },
      { id: 'mimo-v2.5-free', contextWindow: 200_000, apiEndpoint: 'chat-completions' }
    ],
    multimodal: {
      multimodalModels: [
        'kimi-k2.7-code',
        'gpt-6-astra',
        'gpt-6.1-sol',
        'gpt-6-sol',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'claude-fable-5-1',
        'claude-fable-5',
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-sonnet-5',
        'claude-sonnet-5-5',
        'grok-4.7',
        'grok-4.6',
        'gpt-5.5',
        'gpt-5.5-pro',
        'gpt-5.4',
        'gpt-5.4-pro',
        'gpt-5.4-mini',
        'gpt-5.4-nano',
        'gpt-5.3-codex',
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
        'muse-spark-1.3',
        'muse-spark-1.2',
        'qwen3.8-flash',
        'qwen3.8-max',
        'qwen3.5-plus',
        'kimi-k3',
        'kimi-k2.6',
        'deepseek-v4.1-flash',
        'deepseek-v4-flash-vision-exp',
        'minimax-m3',
        'glm-5.3-flash',
        'mimo-v2.5-free'
      ]
    }
  },
  // OpenRouter is an aggregation gateway (many vendors behind one key), so it sits last in the picker.
  {
    id: 'openrouter',
    label: 'OpenRouter',
    // The gateway aggregates unrelated model families, so every curated entry below declares its
    // own capability. Unknown additions stay conservative instead of pretending to support five.
    reasoningEffort: { supported: false },
    // Multi-vendor gateway: Anthropic /v1/messages under `/api` and the OpenAI-compatible
    // /v1/chat/completions under `/api/v1`. Its live catalog is 300+ ids, so this ships a curated set of
    // the top models across vendors (no modelsListUrl) rather than a "refresh from vendor" that would
    // flood the model picker. Model slugs use OpenRouter's `vendor/model` form.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://openrouter.ai/api',
    chatCompletionsBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyUrl: 'https://openrouter.ai/workspaces/default/keys',
    models: [
      // Anthropic
      {
        id: 'anthropic/claude-opus-5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-opus-5.5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-sonnet-5.5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-fable-5.1',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-opus-4.8',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-sonnet-5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-haiku-4.5',
        contextWindow: 200_000,
        reasoningEffort: { supported: false }
      },
      // OpenAI
      // Effort choices come from OpenRouter reasoning metadata, not upstream defaults.
      // GPT-6 Luna spans none through max within the existing five-choice UI; Qwen omits minimal.
      // Current tool-capable chat models from the public catalog (2026-10-04).
      {
        id: 'openai/gpt-6.1-sol',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'openai/gpt-6.1-sol-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'openai/gpt-6-astra',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'openai/gpt-6-astra-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'openai/gpt-6-luna',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-6-luna-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      // These profiles are baked from OpenRouter's public model reasoning metadata. Where a model
      // exposes additional values, this shipped compatibility subset retains the previously verified values.
      {
        id: 'openai/gpt-5.6-terra-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-5.6-terra',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-5.6-sol-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-5.6-sol',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-5.6-luna-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-5.6-luna',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-5.5-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['medium', 'high', 'xhigh'] }
      },
      {
        id: 'openai/gpt-5.5',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'openai/gpt-5.3-codex',
        contextWindow: 400_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      // Other top-ranked vendors on OpenRouter
      {
        id: 'x-ai/grok-4.7',
        contextWindow: 500_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'deepseek/deepseek-v4.1-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['none', 'low', 'high', 'max'] }
      },
      {
        id: 'z-ai/glm-5.3',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'z-ai/glm-5.3-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'qwen/qwen3.8-max-0902',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'minimax/minimax-m3',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: false }
      },
      {
        id: 'xiaomi/mimo-v2.6-pro',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'xiaomi/mimo-v2.6-flash',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'google/gemini-3.1-pro-preview',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] }
      },
      {
        id: 'google/gemini-3.6-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'google/gemini-3.5-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['minimal', 'low', 'medium', 'high'] }
      },
      {
        id: 'x-ai/grok-4.5',
        contextWindow: 500_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] }
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['none', 'high', 'xhigh'] }
      },
      {
        id: 'z-ai/glm-5.2',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['none', 'high', 'xhigh'] }
      },
      {
        id: 'moonshotai/kimi-k3',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['low', 'high', 'max'] }
      },
      {
        id: 'qwen/qwen3.7-max',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['none', 'high'] }
      },
      // Free, tool-capable entries from https://openrouter.ai/api/v1/models (2026-09-13).
      // Keep exact free IDs: appending :free to an arbitrary paid model does not make it available.
      // Both also expose /api/v1/messages, so retain the gateway's dual-endpoint compatibility.
      {
        id: 'openrouter/free',
        contextWindow: 200_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'google/gemma-4-31b-it:free',
        contextWindow: 262_144,
        reasoningEffort: { supported: false }
      }
    ],
    // OpenRouter's catalog is curated (no live refresh), and vision support is an unpredictable subset
    // across vendors — so it is an explicit id list rather than a blanket rule or pattern. The
    // Text-only members (deepseek-v4-pro, glm-5.2, glm-5.3, qwen3.7-max) are omitted.
    multimodal: {
      multimodalModels: [
        'anthropic/claude-opus-5.5',
        'anthropic/claude-sonnet-5.5',
        'anthropic/claude-fable-5.1',
        'openai/gpt-6.1-sol',
        'openai/gpt-6.1-sol-pro',
        'openai/gpt-6-astra',
        'openai/gpt-6-astra-pro',
        'openai/gpt-6-luna',
        'openai/gpt-6-luna-pro',
        'x-ai/grok-4.7',
        'deepseek/deepseek-v4.1-flash',
        'z-ai/glm-5.3-flash',
        'qwen/qwen3.8-max-0902',
        'minimax/minimax-m3',
        'xiaomi/mimo-v2.6-pro',
        'xiaomi/mimo-v2.6-flash',
        'anthropic/claude-opus-5',
        'anthropic/claude-opus-4.8',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-haiku-4.5',
        'openai/gpt-5.6-terra-pro',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-sol-pro',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-luna-pro',
        'openai/gpt-5.6-luna',
        'openai/gpt-5.5-pro',
        'openai/gpt-5.5',
        'openai/gpt-5.3-codex',
        'google/gemini-3.1-pro-preview',
        'google/gemini-3.6-flash',
        'google/gemini-3.5-flash',
        'x-ai/grok-4.5',
        'moonshotai/kimi-k3',
        'openrouter/free',
        'google/gemma-4-31b-it:free'
      ]
    }
  },
  // Requesty is also a multi-vendor gateway, so it follows OpenRouter at the end of the picker.
  {
    id: 'requesty',
    label: 'Requesty',
    // Like OpenRouter, each curated entry declares its own capability and unknown ids stay
    // conservative.
    reasoningEffort: { supported: false },
    // Anthropic /v1/messages at the router root and the OpenAI-compatible /v1/chat/completions under
    // `/v1`. The live catalog has hundreds of `vendor/model` ids, so ship a short curated set (no
    // modelsListUrl) instead of a refresh that would flood the picker.
    apiEndpoints: ['messages', 'chat-completions'],
    baseUrl: 'https://router.requesty.ai',
    chatCompletionsBaseUrl: 'https://router.requesty.ai/v1',
    apiKeyUrl: 'https://app.requesty.ai/api-keys',
    // Ids, context windows, and vision from https://router.requesty.ai/v1/models (2026-10-04).
    models: [
      {
        id: 'anthropic/claude-sonnet-5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      // https://docs.requesty.ai/features/reasoning: OpenAI max maps to high and none to low.
      // Use low through xhigh; other new families without documented effort values stay hidden.
      // Current tool-capable chat models from the public catalog (2026-10-04).
      {
        id: 'anthropic/claude-sonnet-5-5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'max'] }
      },
      {
        id: 'anthropic/claude-fable-5.1',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'max'] }
      },
      {
        id: 'openai/gpt-6.1-sol',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'openai/gpt-6-astra',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'openai/gpt-6-luna',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'google/gemini-3.6-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high'] }
      },
      {
        id: 'xai/grok-4.7',
        contextWindow: 500_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'deepseek/deepseek-v4.1-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'zai/glm-5.3',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'zai/glm-5.3-flash',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'xiaomi/mimo-v2.6-pro',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: false }
      },
      {
        id: 'xiaomi/mimo-v2.6-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: false }
      },
      {
        id: 'anthropic/claude-opus-5-5',
        contextWindow: 1_000_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      },
      {
        id: 'anthropic/claude-haiku-4-5',
        contextWindow: 200_000,
        reasoningEffort: { supported: false }
      },
      {
        id: 'openai/gpt-5.5',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['none', 'low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'openai/gpt-5.4',
        contextWindow: 1_050_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'openai/gpt-5.4-mini',
        contextWindow: 400_000,
        reasoningEffort: { supported: true, values: ['low', 'medium', 'high', 'xhigh'] }
      },
      {
        id: 'google/gemini-3.1-pro-preview',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: false }
      },
      {
        id: 'google/gemini-3.5-flash',
        contextWindow: 1_048_576,
        reasoningEffort: { supported: false }
      },
      { id: 'xai/grok-4.6', contextWindow: 500_000, reasoningEffort: { supported: false } }
    ],
    // Curated like OpenRouter, so vision support is an explicit id list; unlisted ids stay text-only.
    multimodal: {
      multimodalModels: [
        'anthropic/claude-sonnet-5-5',
        'anthropic/claude-fable-5.1',
        'openai/gpt-6.1-sol',
        'openai/gpt-6-astra',
        'openai/gpt-6-luna',
        'google/gemini-3.6-flash',
        'xai/grok-4.7',
        'deepseek/deepseek-v4.1-flash',
        'zai/glm-5.3',
        'zai/glm-5.3-flash',
        'xiaomi/mimo-v2.6-pro',
        'xiaomi/mimo-v2.6-flash',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-opus-5-5',
        'anthropic/claude-haiku-4-5',
        'openai/gpt-5.5',
        'openai/gpt-5.4',
        'openai/gpt-5.4-mini',
        'google/gemini-3.1-pro-preview',
        'google/gemini-3.5-flash',
        'xai/grok-4.6'
      ]
    }
  }
]

function freezeDefinition<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDefinition(child)
    Object.freeze(value)
  }
  return value
}
export const OFFICIAL_VENDORS = freezeDefinition(definitions)

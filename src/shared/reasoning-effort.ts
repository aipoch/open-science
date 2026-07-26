import type { ReasoningEffort } from './settings'

export type ModelReasoningEffort =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

// The concrete value delivered to an agent/model adapter after the active model profile projects
// the app's five intent slots. `default` is the explicit sentinel for omitting an effort parameter.
export type ResolvedReasoningEffort = ModelReasoningEffort | 'default'

export type ReasoningEffortPresetId =
  | 'standard-5'
  | 'low-medium-high-xhigh'
  | 'low-medium-high-xhigh-ultra'
  | 'low-medium-high-max'
  | 'none-low-medium-high-xhigh'
  | 'none-low-medium-high-max'
  | 'low-medium-high'
  | 'medium-high-xhigh'
  | 'minimal-low-medium-high'
  | 'none-high-max'
  | 'none-high-xhigh'
  | 'low-high-max'
  | 'none-high'
  | 'low-high'
  | 'high-max'

export type ReasoningEffortPresetSetting = ReasoningEffortPresetId | 'unsupported'

// Custom gateways can expose the same model-effort vocabulary through different wire shapes. Keep
// this explicit instead of guessing from a user-entered URL or model id: a compatible proxy may use
// any hostname while still requiring its upstream provider's native request body.
export type CustomReasoningEffortTransport =
  'reasoning-effort' | 'deepseek' | 'minimax' | 'xiaomimimo' | 'openrouter'

export const CUSTOM_REASONING_EFFORT_TRANSPORTS: ReadonlyArray<{
  id: CustomReasoningEffortTransport
  label: string
}> = [
  { id: 'reasoning-effort', label: 'OpenAI-compatible reasoning_effort' },
  { id: 'deepseek', label: 'DeepSeek thinking + effort' },
  { id: 'minimax', label: 'MiniMax adaptive thinking' },
  { id: 'xiaomimimo', label: 'MiMo thinking switch' },
  { id: 'openrouter', label: 'OpenRouter reasoning object' }
]

const CUSTOM_REASONING_EFFORT_TRANSPORT_IDS = new Set<string>(
  CUSTOM_REASONING_EFFORT_TRANSPORTS.map(({ id }) => id)
)

export const isCustomReasoningEffortTransport = (
  value: unknown
): value is CustomReasoningEffortTransport =>
  typeof value === 'string' && CUSTOM_REASONING_EFFORT_TRANSPORT_IDS.has(value)

export const CUSTOM_REASONING_EFFORT_PRESETS: ReadonlyArray<{
  id: ReasoningEffortPresetId
  label: string
}> = [
  { id: 'standard-5', label: 'Low / Medium / High / XHigh / Max' },
  { id: 'low-medium-high-xhigh-ultra', label: 'Low / Medium / High / XHigh / Ultra' },
  { id: 'low-medium-high-max', label: 'Low / Medium / High / Max' },
  { id: 'low-medium-high-xhigh', label: 'Low / Medium / High / XHigh' },
  { id: 'none-low-medium-high-xhigh', label: 'None / Low / Medium / High / XHigh' },
  { id: 'none-low-medium-high-max', label: 'None / Low / Medium / High / Max' },
  { id: 'minimal-low-medium-high', label: 'Minimal / Low / Medium / High' },
  { id: 'low-medium-high', label: 'Low / Medium / High' },
  { id: 'medium-high-xhigh', label: 'Medium / High / XHigh' },
  { id: 'none-high-max', label: 'None / High / Max' },
  { id: 'none-high-xhigh', label: 'None / High / XHigh' },
  { id: 'low-high-max', label: 'Low / High / Max' },
  { id: 'high-max', label: 'High / Max' },
  { id: 'none-high', label: 'None / High' },
  { id: 'low-high', label: 'Low / High' }
]

export type ReasoningEffortProfile =
  | { supported: false }
  | {
      supported: true
      slots: readonly [
        ModelReasoningEffort,
        ModelReasoningEffort,
        ModelReasoningEffort,
        ModelReasoningEffort,
        ModelReasoningEffort
      ]
    }

export type ReasoningEffortOption = {
  value: ModelReasoningEffort
  label: string
  intent: Exclude<ReasoningEffort, 'default'>
}

export type ReasoningEffortControl = {
  options: ReasoningEffortOption[]
  selectedValue?: ModelReasoningEffort
}

const INTENTS: readonly Exclude<ReasoningEffort, 'default'>[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

const PROFILES: Record<ReasoningEffortPresetId, ReasoningEffortProfile> = {
  'standard-5': {
    supported: true,
    slots: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  'low-medium-high-xhigh': {
    supported: true,
    slots: ['low', 'medium', 'high', 'xhigh', 'xhigh']
  },
  'low-medium-high-xhigh-ultra': {
    supported: true,
    slots: ['low', 'medium', 'high', 'xhigh', 'ultra']
  },
  'low-medium-high-max': {
    supported: true,
    slots: ['low', 'medium', 'high', 'max', 'max']
  },
  'none-low-medium-high-xhigh': {
    supported: true,
    slots: ['none', 'low', 'medium', 'high', 'xhigh']
  },
  'none-low-medium-high-max': {
    supported: true,
    slots: ['none', 'low', 'medium', 'high', 'max']
  },
  'low-medium-high': {
    supported: true,
    slots: ['low', 'medium', 'high', 'high', 'high']
  },
  'medium-high-xhigh': {
    supported: true,
    slots: ['medium', 'high', 'xhigh', 'xhigh', 'xhigh']
  },
  'minimal-low-medium-high': {
    supported: true,
    slots: ['minimal', 'low', 'medium', 'high', 'high']
  },
  'none-high-max': {
    supported: true,
    slots: ['none', 'high', 'max', 'max', 'max']
  },
  'none-high-xhigh': {
    supported: true,
    slots: ['none', 'high', 'xhigh', 'xhigh', 'xhigh']
  },
  'low-high-max': {
    supported: true,
    slots: ['low', 'high', 'max', 'max', 'max']
  },
  'none-high': {
    supported: true,
    slots: ['none', 'high', 'high', 'high', 'high']
  },
  'low-high': {
    supported: true,
    slots: ['low', 'high', 'high', 'high', 'high']
  },
  'high-max': {
    supported: true,
    slots: ['high', 'max', 'max', 'max', 'max']
  }
}

const REASONING_EFFORT_PRESET_SETTINGS = new Set<string>([...Object.keys(PROFILES), 'unsupported'])

export const isReasoningEffortPresetSetting = (
  value: unknown
): value is ReasoningEffortPresetSetting =>
  typeof value === 'string' && REASONING_EFFORT_PRESET_SETTINGS.has(value)

export const reasoningEffortProfile = (preset: ReasoningEffortPresetId): ReasoningEffortProfile =>
  PROFILES[preset]

export const resolveReasoningEffortProfile = (
  preset: ReasoningEffortPresetSetting | undefined
): ReasoningEffortProfile =>
  preset === 'unsupported' ? { supported: false } : reasoningEffortProfile(preset ?? 'standard-5')

export const resolveReasoningEffortValue = (
  intent: ReasoningEffort,
  profile: ReasoningEffortProfile
): ResolvedReasoningEffort => {
  if (intent === 'default' || !profile.supported) return 'default'

  return profile.slots[INTENTS.indexOf(intent)]
}

const effortLabel = (value: ModelReasoningEffort): string =>
  value === 'xhigh' ? 'XHigh' : value.charAt(0).toUpperCase() + value.slice(1)

export const resolveReasoningEffortControl = (
  intent: ReasoningEffort,
  profile: ReasoningEffortProfile
): ReasoningEffortControl => {
  if (!profile.supported) return { options: [] }

  const lastIntentByValue = new Map<ModelReasoningEffort, Exclude<ReasoningEffort, 'default'>>()

  profile.slots.forEach((value, index) => {
    lastIntentByValue.set(value, INTENTS[Math.min(index, INTENTS.length - 1)])
  })

  const options = [...lastIntentByValue.entries()].map(([value, optionIntent]) => ({
    value,
    label: effortLabel(value),
    intent: optionIntent
  }))

  const selectedValue = resolveReasoningEffortValue(intent, profile)

  return {
    options,
    selectedValue: selectedValue === 'default' ? undefined : selectedValue
  }
}

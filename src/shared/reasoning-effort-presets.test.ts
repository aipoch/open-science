import { expect, it } from 'vitest'
import { reasoningEffortProfile, type ReasoningEffortPresetId } from './reasoning-effort'

const historicalSlots = {
  'standard-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'low-medium-xhigh': ['low', 'medium', 'xhigh', 'xhigh', 'xhigh'],
  'low-medium-high-xhigh': ['low', 'medium', 'high', 'xhigh', 'xhigh'],
  'low-medium-high-xhigh-ultra': ['low', 'medium', 'high', 'xhigh', 'ultra'],
  'low-medium-high-max': ['low', 'medium', 'high', 'max', 'max'],
  'none-low-medium-high-xhigh': ['none', 'low', 'medium', 'high', 'xhigh'],
  'none-low-medium-high-max': ['none', 'low', 'medium', 'high', 'max'],
  'low-medium-high': ['low', 'medium', 'high', 'high', 'high'],
  'medium-high-xhigh': ['medium', 'high', 'xhigh', 'xhigh', 'xhigh'],
  'minimal-low-medium-high': ['minimal', 'low', 'medium', 'high', 'high'],
  'none-low-high-max': ['none', 'low', 'high', 'max', 'max'],
  'none-high-max': ['none', 'high', 'max', 'max', 'max'],
  'none-high-xhigh': ['none', 'high', 'xhigh', 'xhigh', 'xhigh'],
  'low-high-max': ['low', 'high', 'max', 'max', 'max'],
  'none-high': ['none', 'high', 'high', 'high', 'high'],
  'low-high': ['low', 'high', 'high', 'high', 'high'],
  'high-max': ['high', 'max', 'max', 'max', 'max']
} as const

it.each(Object.entries(historicalSlots))('preserves saved %s intent mapping', (preset, slots) => {
  expect(reasoningEffortProfile(preset as ReasoningEffortPresetId)).toEqual({
    supported: true,
    slots
  })
})

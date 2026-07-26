import { describe, expect, it } from 'vitest'

import {
  isReasoningEffortPresetSetting,
  reasoningEffortProfile,
  resolveReasoningEffortValue,
  resolveReasoningEffortProfile,
  resolveReasoningEffortControl
} from './reasoning-effort'

describe('isReasoningEffortPresetSetting', () => {
  it('accepts supported presets and the explicit unsupported setting', () => {
    expect(isReasoningEffortPresetSetting('standard-5')).toBe(true)
    expect(isReasoningEffortPresetSetting('none-high')).toBe(true)
    expect(isReasoningEffortPresetSetting('unsupported')).toBe(true)
  })

  it('rejects unknown and non-string settings', () => {
    expect(isReasoningEffortPresetSetting('dynamic')).toBe(false)
    expect(isReasoningEffortPresetSetting(5)).toBe(false)
  })
})

describe('resolveReasoningEffortControl', () => {
  it('shows three model options and lets the highest option cover the upper user intents', () => {
    const control = resolveReasoningEffortControl('max', reasoningEffortProfile('low-medium-high'))

    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high'])
    expect(control.selectedValue).toBe('high')
    expect(control.options.at(-1)?.intent).toBe('max')
  })

  it('shows every option for a five-level model', () => {
    const control = resolveReasoningEffortControl('max', reasoningEffortProfile('standard-5'))

    expect(control.options.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(control.selectedValue).toBe('max')
  })

  it('includes a true off option for a five-level model that supports none', () => {
    const control = resolveReasoningEffortControl(
      'low',
      reasoningEffortProfile('none-low-medium-high-xhigh')
    )

    expect(control.options.map((option) => option.value)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(control.selectedValue).toBe('none')
  })

  it('shows two options when the model only distinguishes high and max', () => {
    const control = resolveReasoningEffortControl('high', reasoningEffortProfile('high-max'))

    expect(control.options.map((option) => option.value)).toEqual(['high', 'max'])
    expect(control.selectedValue).toBe('max')
    expect(control.options[1].intent).toBe('max')
  })

  it('lets the highest option of a four-level model cover the top two intents', () => {
    const control = resolveReasoningEffortControl(
      'max',
      reasoningEffortProfile('low-medium-high-max')
    )

    expect(control.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'max'])
    expect(control.selectedValue).toBe('max')
    expect(control.options.at(-1)?.intent).toBe('max')
  })

  it('defaults an unconfigured custom model to the standard five-level profile', () => {
    expect(resolveReasoningEffortProfile(undefined)).toEqual(reasoningEffortProfile('standard-5'))
  })

  it('preserves an explicit custom-model unsupported choice', () => {
    expect(resolveReasoningEffortProfile('unsupported')).toEqual({ supported: false })
  })
})

describe('resolveReasoningEffortValue', () => {
  it('projects a five-slot intent onto the active model profile', () => {
    expect(resolveReasoningEffortValue('xhigh', reasoningEffortProfile('low-medium-high'))).toBe(
      'high'
    )
  })

  it('uses the default sentinel when the user or model disables an override', () => {
    expect(resolveReasoningEffortValue('default', reasoningEffortProfile('standard-5'))).toBe(
      'default'
    )
    expect(resolveReasoningEffortValue('max', { supported: false })).toBe('default')
  })
})

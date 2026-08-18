import { describe, expect, it, vi } from 'vitest'

import { LocalePreferenceOwner } from './owner'
import { translateNativeMessage } from './native-messages'

describe('LocalePreferenceOwner', () => {
  it('resolves the system locale and notifies consumers only when the preference changes', () => {
    const owner = new LocalePreferenceOwner(['ja-JP', 'en-US'])
    const listener = vi.fn()
    owner.subscribe(listener)

    expect(owner.snapshot()).toEqual({ preference: 'system', locale: 'ja' })
    expect(owner.setPreference('zh-Hant')).toEqual({ preference: 'zh-Hant', locale: 'zh-Hant' })
    expect(listener).toHaveBeenCalledWith({ preference: 'zh-Hant', locale: 'zh-Hant' })

    listener.mockClear()
    owner.setPreference('zh-Hant')
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects invalid renderer input and translates native messages with interpolation', () => {
    const owner = new LocalePreferenceOwner(['en-US'])

    expect(() => owner.setPreference('fr')).toThrow('Invalid language preference')
    expect(translateNativeMessage('ja', 'Quit')).toBe('終了')
    expect(
      translateNativeMessage(
        'zh-Hans',
        '{{count}} notebooks already exist in the chosen directory.',
        {
          count: 3
        }
      )
    ).toContain('3')
  })
})

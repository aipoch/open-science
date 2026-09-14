import { describe, expect, it } from 'vitest'

import { SETTINGS_VISUAL_CHANGES } from './changes'

describe('settings visual-preview change registry', () => {
  it('contains exactly the 7 demonstrated changes in order', () => {
    expect(SETTINGS_VISUAL_CHANGES.map((change) => change.id)).toEqual([
      'compute-load-states',
      'compute-removal-inline-confirm',
      'remote-revoke-confirmation',
      'remote-pairing-first',
      'remote-revoke-all',
      'disabled-action-explanations',
      'credential-remove-disabled'
    ])
  })

  it('uses unique ids and unique target selectors', () => {
    const ids = SETTINGS_VISUAL_CHANGES.map((change) => change.id)
    const selectors = SETTINGS_VISUAL_CHANGES.map((change) => change.targetSelector)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(selectors).size).toBe(selectors.length)
  })

  it('gives every change Chinese review copy and a wired activate()', () => {
    for (const change of SETTINGS_VISUAL_CHANGES) {
      expect(change.title.length).toBeGreaterThan(0)
      expect(change.description.length).toBeGreaterThan(0)
      expect(typeof change.activate).toBe('function')
      expect(change.targetSelector).toBe(`[data-visual-change="${change.id}"]`)
    }
  })
})

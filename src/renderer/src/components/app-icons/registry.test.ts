import { describe, expect, it } from 'vitest'
import { Brain } from 'lucide-react'
import { APP_ICON_GROUPS, APP_ICONS, DEFAULT_APP_ICON } from './registry'

// Keys persisted by existing Specialist profiles; they must stay resolvable forever.
const LEGACY_SPECIALIST_ICON_KEYS = [
  'brain',
  'beaker',
  'book-open',
  'flask-conical',
  'microscope',
  'search'
]

describe('app icon registry', () => {
  it('uses unique icon keys across all groups', () => {
    const keys = APP_ICON_GROUPS.flatMap((group) => group.icons.map((icon) => icon.key))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('uses unique group keys and non-empty groups', () => {
    const groupKeys = APP_ICON_GROUPS.map((group) => group.key)
    expect(new Set(groupKeys).size).toBe(groupKeys.length)
    for (const group of APP_ICON_GROUPS) {
      expect(group.icons.length).toBeGreaterThan(0)
    }
  })

  it('keeps every legacy specialist icon key resolvable', () => {
    for (const key of LEGACY_SPECIALIST_ICON_KEYS) {
      expect(APP_ICONS[key]).toBeDefined()
    }
  })

  it('maps every registered key to its group entry', () => {
    for (const group of APP_ICON_GROUPS) {
      for (const icon of group.icons) {
        expect(APP_ICONS[icon.key]).toBe(icon.Icon)
      }
    }
  })

  it('keeps the fixed Reviewer identity outside the appearance picker', () => {
    expect(APP_ICONS['owl-scholar']).toBeDefined()
    expect(
      APP_ICON_GROUPS.flatMap((group) => group.icons).some((icon) => icon.key === 'owl-scholar')
    ).toBe(false)
  })

  it('exposes the Brain icon as the documented unknown-key fallback', () => {
    // Consumers render `APP_ICONS[key] ?? DEFAULT_APP_ICON` (direct map access, not a
    // resolver call) so React lint rules never see a component created during render.
    expect(DEFAULT_APP_ICON).toBe(Brain)
    expect(APP_ICONS['no-such-icon']).toBeUndefined()
  })
})

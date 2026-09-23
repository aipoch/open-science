// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SETTINGS_SEARCH_INDEX, SettingsGlobalSearch } from './SettingsGlobalSearch'
import type { SettingsPanelId } from './settings-navigation'
import { i18next } from '@/i18n'

const PANELS: ReadonlyArray<{ id: SettingsPanelId; labelKey: string }> = [
  { id: 'general', labelKey: 'General' },
  { id: 'model', labelKey: 'Model' },
  { id: 'network', labelKey: 'Network' },
  { id: 'runtimes', labelKey: 'Runtimes' }
]

let container: HTMLDivElement
let root: Root

const scrollIntoViewMock = vi.fn()

beforeEach(() => {
  scrollIntoViewMock.mockClear()
  // jsdom does not implement scrollIntoView; the highlight path calls it on the jump target.
  Element.prototype.scrollIntoView = scrollIntoViewMock as never
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

const renderSearch = (onNavigate = vi.fn()): void => {
  act(() => {
    root.render(
      <div role="dialog">
        <SettingsGlobalSearch panels={PANELS} onNavigate={onNavigate} />
      </div>
    )
  })
}

const input = (): HTMLInputElement =>
  document.body.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!

const typeQuery = (value: string): void => {
  const field = input()
  act(() => {
    field.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const pressKey = (key: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    ;(document.activeElement ?? input()).dispatchEvent(event)
  })
  return event
}

const options = (): HTMLButtonElement[] =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'))

const selectedOption = (): HTMLButtonElement | undefined =>
  options().find((option) => option.getAttribute('aria-selected') === 'true')

// Mounts a fake settings content scroller standing in for the freshly navigated panel, so the
// highlight logic can find its jump target without rendering real panels.
const mountPanelRoot = (panel: string, html: string): void => {
  const scroller = document.createElement('div')
  scroller.dataset.slot = 'settings-content-scroll'
  scroller.dataset.settingsActivePanel = panel
  scroller.innerHTML = html
  document.body.appendChild(scroller)
}

describe('SettingsGlobalSearch', () => {
  it('matches by label, keywords, and panel name, and reports no matches', () => {
    renderSearch()

    typeQuery('proxy')
    expect(options().map((option) => option.textContent)).toEqual(['ProxyNetwork'])

    // English-only match keywords are never displayed but still match.
    typeQuery('npm')
    expect(options().map((option) => option.textContent)).toEqual(['Package mirrorNetwork'])

    // The owning panel's translated label matches every entry of that panel.
    typeQuery('network')
    expect(options().length).toBe(3)

    typeQuery('zzzz-no-such-setting')
    expect(options()).toEqual([])
    expect(document.body.textContent).toContain('No matching settings')
  })

  it('wraps ArrowUp/ArrowDown through the results and Enter navigates to the active panel', () => {
    const onNavigate = vi.fn()
    renderSearch(onNavigate)

    typeQuery('network')
    const entries = options()
    expect(entries.length).toBe(3)
    expect(selectedOption()).toBe(entries[0])

    pressKey('ArrowDown')
    expect(selectedOption()).toBe(entries[1])

    // ArrowUp past the first entry wraps to the last.
    pressKey('ArrowUp')
    pressKey('ArrowUp')
    expect(selectedOption()).toBe(entries[2])
    expect(input().getAttribute('aria-activedescendant')).toBe(entries[2].id)

    pressKey('Enter')
    expect(onNavigate).toHaveBeenCalledWith('network')
    expect(input().value).toBe('')
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
  })

  it('keeps focus on the input: options are not tabbable', () => {
    renderSearch()
    typeQuery('proxy')

    for (const option of options()) {
      expect(option.getAttribute('tabindex')).toBe('-1')
    }
    expect(document.activeElement).toBe(input())
  })

  it('closes only the results list on the first Escape, even from a mouse-hovered option', () => {
    renderSearch()
    typeQuery('proxy')
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()

    // Hover moves the active option without moving focus off the input.
    act(() => {
      options()[0]?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    })

    const event = pressKey('Escape')
    expect(event.defaultPrevented).toBe(false)
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).not.toBe(input())

    // With the list closed, a second Escape is left for the dialog to handle.
    const second = pressKey('Escape')
    expect(second.defaultPrevented).toBe(false)
  })

  it('jumps to the anchored setting instead of the first block, ringing and focusing it', () => {
    mountPanelRoot(
      'general',
      `<section data-slot="settings-section">Appearance</section>
       <section data-slot="settings-section" data-settings-anchor="general.notifications">Notifications</section>`
    )
    const onNavigate = vi.fn()
    renderSearch(onNavigate)

    typeQuery('notifications')
    pressKey('Enter')

    const target = document.body.querySelector<HTMLElement>(
      '[data-settings-anchor="general.notifications"]'
    )!
    expect(onNavigate).toHaveBeenCalledWith('general')
    // The ring lands on the anchored section, not the panel's first section.
    expect(target.classList.contains('settings-search-highlight')).toBe(true)
    // Non-focusable targets get a temporary tabindex and receive focus.
    expect(target.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(target)
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('focuses an anchored control without lending it a tabindex', () => {
    mountPanelRoot(
      'tags',
      `<section data-slot="settings-section">Tags</section>
       <button type="button" data-settings-anchor="tags.new">New Tag</button>`
    )
    renderSearch()

    typeQuery('new tag')
    pressKey('Enter')

    const target = document.body.querySelector<HTMLElement>('[data-settings-anchor="tags.new"]')!
    expect(target.classList.contains('settings-search-highlight')).toBe(true)
    expect(target.hasAttribute('tabindex')).toBe(false)
    expect(document.activeElement).toBe(target)
  })

  it('waits for a missing anchor before falling back to the first content block', () => {
    vi.useFakeTimers()
    mountPanelRoot('general', `<section data-slot="settings-section">Appearance</section>`)
    renderSearch()

    typeQuery('notifications')
    pressKey('Enter')

    // The anchor never renders: no premature ring on the wrong block.
    expect(document.body.querySelector('.settings-search-highlight')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    const first = document.body.querySelector<HTMLElement>('[data-slot="settings-section"]')!
    expect(first.classList.contains('settings-search-highlight')).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('fades and removes the ring after the dwell, restoring tabindex but keeping focus', () => {
    vi.useFakeTimers()
    mountPanelRoot(
      'general',
      `<section data-slot="settings-section" data-settings-anchor="general.notifications">Notifications</section>`
    )
    renderSearch()

    typeQuery('notifications')
    pressKey('Enter')

    const target = document.body.querySelector<HTMLElement>(
      '[data-settings-anchor="general.notifications"]'
    )!
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    // Mid-dwell the ring is still on; the class's own CSS animation handles the fade-out.
    expect(target.classList.contains('settings-search-highlight')).toBe(true)

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(target.classList.contains('settings-search-highlight')).toBe(false)
    expect(target.hasAttribute('tabindex')).toBe(false)
    // Focus stays on the jump target after the visual ring is gone.
    expect(document.activeElement).toBe(target)
  })

  it('covers every settings panel and resolves the newly indexed sub-settings', () => {
    const allPanels: readonly SettingsPanelId[] = [
      'model',
      'agent',
      'skills',
      'specialists',
      'memory',
      'connectors',
      'network',
      'remote-control',
      'credentials',
      'tags',
      'permissions',
      'runtimes',
      'storage',
      'compute',
      'usage',
      'archived',
      'general'
    ]
    const covered = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.panel))
    expect(allPanels.filter((panel) => !covered.has(panel))).toEqual([])

    renderSearch()

    typeQuery('remembered')
    expect(options().map((option) => option.id)).toEqual([
      expect.stringContaining('permissions.remembered')
    ])

    typeQuery('update')
    expect(options().map((option) => option.id)).toEqual([
      expect.stringContaining('general.updates')
    ])

    typeQuery('api key')
    const apiKeyHits = options().map((option) => option.id)
    expect(apiKeyHits.some((id) => id.includes('model.provider-key'))).toBe(true)
    expect(apiKeyHits.some((id) => id.includes('model.add-provider'))).toBe(true)
  })

  it('matches localized keyword synonyms and still matches English terms', async () => {
    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
    })
    try {
      renderSearch()

      // The aria-label is translated under zh-Hans; target the combobox role instead.
      const typeLocalized = (value: string): void => {
        const field = document.body.querySelector<HTMLInputElement>('[role="combobox"]')!
        act(() => {
          field.focus()
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            field,
            value
          )
          field.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }

      // The zh-Hans synonyms for the 'api key' keyword key resolve through the catalog.
      typeLocalized('密钥')
      const localizedHits = options().map((option) => option.id)
      expect(localizedHits.some((id) => id.includes('model.provider-key'))).toBe(true)
      expect(localizedHits.some((id) => id.includes('model.add-provider'))).toBe(true)

      // The English keyword key itself remains a haystack under a translated locale.
      typeLocalized('vendor')
      expect(options().map((option) => option.id)).toEqual([
        expect.stringContaining('model.add-provider'),
        expect.stringContaining('model.provider-key')
      ])
    } finally {
      await act(async () => {
        await i18next.changeLanguage('en')
      })
    }
  })

  it('cancels a superseded highlight when a new selection starts', () => {
    vi.useFakeTimers()
    mountPanelRoot(
      'general',
      `<section data-slot="settings-section" data-settings-anchor="general.notifications">Notifications</section>
       <section data-slot="settings-section" data-settings-anchor="general.language">Language</section>`
    )
    renderSearch()

    typeQuery('notifications')
    pressKey('Enter')
    const first = document.body.querySelector<HTMLElement>(
      '[data-settings-anchor="general.notifications"]'
    )!
    expect(first.classList.contains('settings-search-highlight')).toBe(true)

    // A second jump strips the first ring immediately instead of letting it dwell.
    typeQuery('language')
    pressKey('Enter')
    expect(first.classList.contains('settings-search-highlight')).toBe(false)
    const second = document.body.querySelector<HTMLElement>(
      '[data-settings-anchor="general.language"]'
    )!
    expect(second.classList.contains('settings-search-highlight')).toBe(true)
    expect(document.activeElement).toBe(second)
  })

  it('marks a jump target in the panel sources for every anchored entry', () => {
    const sources = readdirSync(__dirname, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.(ts|tsx)$/.test(entry.name) &&
          !entry.name.includes('.test.') &&
          entry.name !== 'SettingsGlobalSearch.tsx'
      )
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))

    const anchored = SETTINGS_SEARCH_INDEX.filter((entry) => !entry.skipAnchor)
    expect(anchored.length).toBeGreaterThan(0)
    for (const entry of anchored) {
      const hits = sources.filter(
        (source) => source.includes(`"${entry.id}"`) || source.includes(`'${entry.id}'`)
      )
      expect(hits.length, `${entry.id} needs a data-settings-anchor in some panel`).toBe(1)
    }
  })

  it('defines the jump-target ring with an offset gap and scroll margin in main.css', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    expect(css).toMatch(/\.settings-search-highlight\s*\{[^}]*outline-offset:\s*4px/)
    expect(css).toMatch(/\.settings-search-highlight\s*\{[^}]*scroll-margin/)
    expect(css).toMatch(/\.settings-search-highlight\s*\{[^}]*animation:/)
    expect(css).toMatch(/@keyframes settings-search-highlight-out/)
  })
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsGlobalSearch } from './SettingsGlobalSearch'
import type { SettingsPanelId } from './settings-navigation'

const PANELS: ReadonlyArray<{ id: SettingsPanelId; labelKey: string }> = [
  { id: 'general', labelKey: 'General' },
  { id: 'model', labelKey: 'Model' },
  { id: 'network', labelKey: 'Network' },
  { id: 'runtimes', labelKey: 'Runtimes' }
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
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
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SettingsSearchInput } from './SettingsSearchInput'

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

const pressSearchShortcut = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => window.dispatchEvent(event))
  return event
}

describe('SettingsSearchInput', () => {
  it.each([undefined, '', 'Search skills…'])(
    'reserves shortcut space only while an unfocused search is empty (placeholder: %s)',
    (placeholder) => {
      act(() => {
        root.render(
          <SettingsSearchInput
            aria-label="Search skills"
            placeholder={placeholder}
            defaultValue="abst"
          />
        )
      })
      const input = container.querySelector('input')!
      const hint = container.querySelector('kbd')
      expect(input.type).toBe('search')
      expect(input.value).toBe('abst')
      expect(input.placeholder).toBe(placeholder || ' ')
      expect(input.classList.contains('pr-20')).toBe(false)
      expect(input.classList.contains('pr-2.5')).toBe(true)
      expect(input.classList.contains('[&:placeholder-shown:not(:focus)]:pr-28')).toBe(false)
      expect(hint).toBeNull()
    }
  )

  it('shows the macOS shortcut and focuses the field with Cmd+Alt+K', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput aria-label="Search skills" value="" onChange={() => undefined} />
        </div>
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search skills"]')
    const event = pressSearchShortcut({ metaKey: true, altKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input?.getAttribute('aria-keyshortcuts')).toBe('Meta+Alt+K')
    expect(container.querySelector('kbd')).toBeNull()
  })

  it('shows the cross-platform shortcut and focuses the field with Ctrl+Alt+K', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'linux' }
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput aria-label="Search connectors" value="" onChange={() => undefined} />
        </div>
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search connectors"]')
    const event = pressSearchShortcut({ ctrlKey: true, altKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input?.getAttribute('aria-keyshortcuts')).toBe('Control+Alt+K')
    expect(container.querySelector('kbd')).toBeNull()
  })

  it('focuses the search owned by the topmost dialog', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog" aria-label="Settings">
          <SettingsSearchInput aria-label="Search skills" value="" onChange={() => undefined} />
          <div role="dialog" aria-label="Packages">
            <SettingsSearchInput aria-label="Filter packages" value="" onChange={() => undefined} />
          </div>
        </div>
      )
    })

    pressSearchShortcut({ metaKey: true, altKey: true })

    expect(document.activeElement).toBe(
      document.body.querySelector<HTMLInputElement>('[aria-label="Filter packages"]')
    )
  })

  it('routes plain K to global search and Alt+K to the local search in the same dialog', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput
            aria-label="Search settings"
            shortcutScope="global"
            value=""
            onChange={() => undefined}
          />
          <SettingsSearchInput aria-label="Search skills" value="" onChange={() => undefined} />
        </div>
      )
    })

    pressSearchShortcut({ metaKey: true })

    const globalSearch = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Search settings"]'
    )!
    expect(document.activeElement).toBe(globalSearch)
    expect(globalSearch.getAttribute('aria-keyshortcuts')).toBe('Meta+K')
    expect(globalSearch.nextElementSibling?.textContent).toBe('⌘K')

    pressSearchShortcut({ metaKey: true, altKey: true })
    expect(document.activeElement).toBe(
      document.body.querySelector<HTMLInputElement>('[aria-label="Search skills"]')
    )
  })

  it('keeps last-mounted-wins for same-scope fields in the same dialog', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput aria-label="First search" value="" onChange={() => undefined} />
          <SettingsSearchInput aria-label="Second search" value="" onChange={() => undefined} />
        </div>
      )
    })

    pressSearchShortcut({ metaKey: true, altKey: true })

    expect(document.activeElement).toBe(
      document.body.querySelector<HTMLInputElement>('[aria-label="Second search"]')
    )
  })

  it('keeps a nested dialog search ahead of the global field in the dialog below', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog" aria-label="Settings">
          <SettingsSearchInput
            aria-label="Search settings"
            shortcutScope="global"
            value=""
            onChange={() => undefined}
          />
          <div role="dialog" aria-label="Bulk manage">
            <SettingsSearchInput aria-label="Filter selected" value="" onChange={() => undefined} />
          </div>
        </div>
      )
    })

    pressSearchShortcut({ metaKey: true, altKey: true })

    expect(document.activeElement).toBe(
      document.body.querySelector<HTMLInputElement>('[aria-label="Filter selected"]')
    )
  })

  it.each([
    ['closing', { 'data-state': 'closed' }],
    ['hidden', { hidden: true }]
  ])('does not consume the shortcut for a search in a %s dialog', (_, dialogProps) => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog" {...dialogProps}>
          <SettingsSearchInput aria-label="Search skills" value="" onChange={() => undefined} />
        </div>
      )
    })

    const event = pressSearchShortcut({ metaKey: true, altKey: true })

    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('preserves the global shortcut character on alternate keyboard layouts', () => {
    act(() =>
      root.render(<SettingsSearchInput shortcutScope="global" aria-label="Global search" />)
    )
    const event = pressSearchShortcut({ metaKey: true, key: 't', code: 'KeyK' })
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('handles the macOS Option-modified K character', () => {
    act(() => root.render(<SettingsSearchInput aria-label="Local search" />))
    const event = pressSearchShortcut({ metaKey: true, altKey: true, key: '˚', code: 'KeyK' })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(container.querySelector('input'))
  })

  it.each([
    { ctrlKey: true },
    { altKey: true },
    { ctrlKey: true, altKey: true, shiftKey: true },
    { ctrlKey: true, altKey: true, repeat: true },
    { ctrlKey: true, altKey: true, isComposing: true },
    { ctrlKey: true, altKey: true, key: 'x', code: 'KeyX' }
  ])('does not claim a nonmatching local shortcut: %j', (init) => {
    act(() => root.render(<SettingsSearchInput aria-label="Local search" />))
    const event = pressSearchShortcut(init)
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })

  it('hides the native cancel affordance and shows no clear button while empty', () => {
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput aria-label="Search skills" value="" onChange={() => undefined} />
        </div>
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search skills"]')
    expect(input?.className).toContain('[&::-webkit-search-cancel-button]:hidden')
    expect(document.body.querySelector('[aria-label="Clear search"]')).toBeNull()
    expect(container.querySelector('kbd')).toBeNull()
  })

  it('replaces the shortcut hint with a clear button once the field has text', () => {
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput
            aria-label="Search skills"
            value="theme"
            onChange={() => undefined}
          />
        </div>
      )
    })

    expect(document.body.querySelector('[aria-label="Clear search"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('⌘⌥K')
  })

  it('clears through a real input event and keeps focus in the field', () => {
    const changes: string[] = []
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput
            aria-label="Search skills"
            defaultValue="theme"
            onChange={(event) => changes.push(event.target.value)}
          />
        </div>
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search skills"]')
    const clear = document.body.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')
    expect(input?.value).toBe('theme')

    act(() => clear?.click())

    expect(changes).toEqual([''])
    expect(input?.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(document.body.querySelector('[aria-label="Clear search"]')).toBeNull()
  })
})

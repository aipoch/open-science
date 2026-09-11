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
  it('shows the macOS shortcut and focuses the field with Cmd+K', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'darwin' }
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput aria-label="Search skills" value="" onChange={() => undefined} />
        </div>
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search skills"]')
    const event = pressSearchShortcut({ metaKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input?.getAttribute('aria-keyshortcuts')).toBe('Meta+K')
    expect(document.body.textContent).toContain('⌘K')
  })

  it('shows the cross-platform shortcut and focuses the field with Ctrl+K', () => {
    ;(window as unknown as { api: unknown }).api = { platform: 'linux' }
    act(() => {
      root.render(
        <div role="dialog">
          <SettingsSearchInput aria-label="Search connectors" value="" onChange={() => undefined} />
        </div>
      )
    })

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Search connectors"]')
    const event = pressSearchShortcut({ ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input?.getAttribute('aria-keyshortcuts')).toBe('Control+K')
    expect(document.body.textContent).toContain('CtrlK')
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

    pressSearchShortcut({ metaKey: true })

    expect(document.activeElement).toBe(
      document.body.querySelector<HTMLInputElement>('[aria-label="Filter packages"]')
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

    const event = pressSearchShortcut({ metaKey: true })

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
    expect(document.body.textContent).toContain('K')
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
    expect(document.body.textContent).not.toContain('⌘K')
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

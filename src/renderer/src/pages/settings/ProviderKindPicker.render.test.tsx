// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '@/i18n'
import { ProviderKindPicker } from './ProviderKindPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
})

const search = (): HTMLInputElement =>
  container.querySelector<HTMLInputElement>('[aria-label="Search providers"]')!
const cardKeys = (): string[] =>
  Array.from(container.querySelectorAll('[data-slot="provider-picker-card"]')).map(
    (card) => card.getAttribute('data-provider-kind') ?? ''
  )
const sectionHeadings = (): string[] =>
  Array.from(container.querySelectorAll('h3')).map((heading) => heading.textContent ?? '')
const chip = (label: string): HTMLButtonElement =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>('[aria-label="Provider category"] button')
  ).find((button) => button.textContent?.startsWith(label))!

const render = (
  props: Partial<Parameters<typeof ProviderKindPicker>[0]> = {}
): ReturnType<typeof vi.fn> => {
  const onSelect = vi.fn()
  act(() => root.render(<ProviderKindPicker onSelect={onSelect} {...props} />))
  return onSelect
}

describe('ProviderKindPicker', () => {
  it('pins the custom gateway above sectioned providers and focuses search', () => {
    render({ recommendedKey: 'official:deepseek' })

    expect(document.activeElement).toBe(search())
    expect(cardKeys()[0]).toBe('custom')
    expect(sectionHeadings()).toEqual([
      'Account sign-in',
      'Model vendors',
      'Coding plans',
      'Cloud platforms',
      'Gateways',
      'Local'
    ])
    const deepseek = container.querySelector('[data-provider-kind="official:deepseek"]')
    expect(deepseek?.textContent).toContain('Recommended')
    expect(deepseek?.textContent).toContain('platform.deepseek.com')
  })

  it('gives every provider icon a light backing in dark mode', () => {
    render({ codeBuddyProviders: [], showClaudeIsolated: true, showCodexSubscriptions: true })

    for (const card of container.querySelectorAll('[data-provider-kind]')) {
      const icon = card.querySelector('img, svg')
      expect(
        icon?.classList.contains('dark:bg-foreground'),
        card.getAttribute('data-provider-kind') ?? ''
      ).toBe(true)
    }
  })

  it('selects a provider kind from its card', () => {
    const onSelect = render()
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-provider-kind="local:ollama"]')!.click()
    )
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('local:ollama')
  })

  it('narrows sections and category counts as the user searches', () => {
    render()
    act(() => fireEvent.change(search(), { target: { value: '智谱' } }))

    expect(cardKeys()).toEqual(['official:zhipu', 'official:glmcodingplan'])
    expect(sectionHeadings()).toEqual(['Model vendors', 'Coding plans'])
    expect(chip('All').textContent).toBe('All2')
    expect(chip('Model vendors').textContent).toBe('Model vendors1')
    expect(chip('Gateways').textContent).toBe('Gateways0')
  })

  it('filters to one category with a chip and toggles its pressed state', () => {
    render()
    act(() => chip('Local').click())

    expect(chip('Local').getAttribute('aria-pressed')).toBe('true')
    expect(chip('All').getAttribute('aria-pressed')).toBe('false')
    expect(sectionHeadings()).toEqual(['Local'])
    expect(cardKeys()).toEqual(['local:ollama', 'local:lmstudio', 'local:llamacpp', 'local:vllm'])
  })

  it('picks the first enabled match on Enter', () => {
    const onSelect = render()
    act(() => fireEvent.change(search(), { target: { value: 'openrouter' } }))
    act(() => fireEvent.keyDown(search(), { key: 'Enter' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('official:openrouter')
  })

  it('offers the custom gateway when nothing matches', () => {
    const onSelect = render()
    act(() => fireEvent.change(search(), { target: { value: 'no-such-provider' } }))

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'No providers match your search.'
    )
    expect(cardKeys()).toEqual(['custom'])
    act(() => fireEvent.keyDown(search(), { key: 'Enter' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('disables CodeBuddy accounts that are already added', () => {
    render({ codeBuddyProviders: ['builtin-codebuddy-china'] })
    const added = container.querySelector<HTMLButtonElement>(
      '[data-provider-kind="builtin-codebuddy-china"]'
    )
    expect(added?.disabled).toBe(true)
    expect(added?.textContent).toContain('Already added')
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-provider-kind="builtin-codebuddy-international"]'
      )?.disabled
    ).toBe(false)
  })
})

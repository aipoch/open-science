// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderForm } from './ProviderForm'
import {
  createEmptyProviderFormValue,
  type ProviderFormErrors,
  type ProviderFormValue
} from './provider-form-value'

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

const render = (
  value: ProviderFormValue,
  { onChange = vi.fn(), errors }: { onChange?: () => void; errors?: ProviderFormErrors } = {}
): void => {
  act(() => {
    root.render(<ProviderForm value={value} onChange={onChange} errors={errors} />)
  })
}

describe('ProviderForm field switching', () => {
  it('shows gateway/key/model fields for a custom provider and no auth-style control', () => {
    render(createEmptyProviderFormValue({ type: 'custom' }))

    expect(container.querySelector('[aria-label="Base URL"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="API key"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).not.toBeNull()
    // The auth style selector was removed; custom always uses a bearer token.
    expect(container.querySelector('[aria-label="Auth style"]')).toBeNull()
  })

  it('hides gateway/key fields for a local-claude provider', () => {
    render(createEmptyProviderFormValue({ type: 'claude-default' }))

    expect(container.querySelector('[aria-label="Base URL"]')).toBeNull()
    expect(container.querySelector('[aria-label="API key"]')).toBeNull()
    // Only the optional model override remains.
    expect(container.querySelector('[aria-label="Model"]')).not.toBeNull()
  })

  it('reports a type change through onChange', () => {
    const onChange = vi.fn()
    render(createEmptyProviderFormValue({ type: 'custom' }), { onChange })

    const localButton = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')
    act(() => localButton?.click())

    expect(onChange).toHaveBeenCalledWith({ type: 'claude-default' })
  })

  it('never renders a stored plaintext key: the key input stays empty and masked-only', () => {
    // The form is given no plaintext key (the renderer never receives one); only a mask is shown.
    render(createEmptyProviderFormValue({ type: 'custom', key: '' }))
    const keyInput = container.querySelector<HTMLInputElement>('[aria-label="API key"]')

    expect(keyInput?.getAttribute('type')).toBe('password')
    expect(keyInput?.value).toBe('')
  })

  it('renders inline required-field errors for a custom provider', () => {
    render(createEmptyProviderFormValue({ type: 'custom' }), {
      errors: {
        baseUrl: 'Base URL is required.',
        key: 'API key is required.',
        model: 'Model is required.'
      }
    })

    expect(container.textContent).toContain('Base URL is required.')
    expect(container.textContent).toContain('API key is required.')
    expect(container.textContent).toContain('Model is required.')
  })
})

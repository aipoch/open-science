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

  it('surfaces the provider-type picker with the current selection', () => {
    // The picker is a styled (non-native) control; option/selection behavior is unit-tested via
    // providerKindPatch, so here we just assert the trigger renders the current kind.
    render(createEmptyProviderFormValue({ type: 'official', vendorId: 'deepseek' }))
    const trigger = container.querySelector('[aria-label="Provider type"]')

    expect(trigger?.tagName).toBe('BUTTON')
    expect(trigger?.textContent).toContain('DeepSeek')
  })

  it('shows a key field but no base URL or model control for an official vendor', () => {
    render(createEmptyProviderFormValue({ type: 'official', vendorId: 'deepseek' }))

    expect(container.querySelector('[aria-label="API key"]')).not.toBeNull()
    // Official vendors expose neither a base URL nor a model control at add time — Add is add & test;
    // the model is chosen from the global selector afterwards.
    expect(container.querySelector('[aria-label="Base URL"]')).toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).toBeNull()
    // The supported models are shown read-only as reference tags.
    expect(container.textContent).toContain('Supported models')
    expect(container.textContent).toContain('deepseek-v4-pro')
  })

  it('shows a region-specific "get a key" link for an official vendor', () => {
    render(createEmptyProviderFormValue({ type: 'official', vendorId: 'zhipu', region: 'china' }))
    const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((anchor) =>
      anchor.textContent?.includes('Get an API key')
    )

    // China GLM points at the BigModel console, not Z.AI's.
    expect(link?.getAttribute('href')).toBe('https://open.bigmodel.cn/usercenter/apikeys')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('shows no "get a key" link for a custom provider', () => {
    render(createEmptyProviderFormValue({ type: 'custom' }))
    const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find((anchor) =>
      anchor.textContent?.includes('Get an API key')
    )

    expect(link).toBeUndefined()
  })

  it('shows an endpoint selector only for a multi-region official vendor', () => {
    render(
      createEmptyProviderFormValue({ type: 'official', vendorId: 'minimax', region: 'global' })
    )
    expect(container.querySelector('[aria-label="Endpoint"]')).not.toBeNull()

    render(createEmptyProviderFormValue({ type: 'official', vendorId: 'deepseek' }))
    expect(container.querySelector('[aria-label="Endpoint"]')).toBeNull()
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

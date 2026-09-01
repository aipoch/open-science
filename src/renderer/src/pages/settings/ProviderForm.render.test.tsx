// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { ProviderForm } from './ProviderForm'
import { getApiKeySecurityCopyKeys } from './provider-key-security'
import {
  createEmptyProviderFormValue,
  type ProviderFormErrors,
  type ProviderFormValue
} from './provider-form-value'

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

const render = (
  value: ProviderFormValue,
  {
    onChange = vi.fn(),
    errors,
    hasStoredKey = false,
    showCodexSubscriptions = false,
    showClaudeIsolated = false
  }: {
    onChange?: () => void
    errors?: ProviderFormErrors
    hasStoredKey?: boolean
    showCodexSubscriptions?: boolean
    showClaudeIsolated?: boolean
  } = {}
): void => {
  act(() => {
    root.render(
      <ProviderForm
        value={value}
        onChange={onChange}
        errors={errors}
        hasStoredKey={hasStoredKey}
        showCodexSubscriptions={showCodexSubscriptions}
        showClaudeIsolated={showClaudeIsolated}
      />
    )
  })
}

describe('ProviderForm field switching', () => {
  it('shows gateway/key/model fields for a custom provider and no auth-style control', () => {
    render(createEmptyProviderFormValue({ type: 'custom' }))

    expect(container.querySelector('[aria-label="Base URL"]')).not.toBeNull()
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Provider name"]')?.placeholder
    ).toBe('Optional display name')
    expect(container.querySelector<HTMLInputElement>('[aria-label="API key"]')?.placeholder).toBe(
      'Paste API key'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Model"]')?.placeholder).toBe(
      'e.g. deepseek-v4-flash'
    )
    const contextWindow = container.querySelector<HTMLInputElement>('[aria-label="Context window"]')
    expect(contextWindow?.placeholder).toBe('Use provider default')
    expect(contextWindow?.getAttribute('role')).toBeNull()
    expect(
      container.querySelector('[role="group"][aria-labelledby="provider-context-window-label"]')
        ?.textContent
    ).toBe('32K64K128K200K256K1M')
    expect(container.querySelector('[aria-label="Maximum input tokens"]')).toBeNull()
    expect(container.querySelector('[aria-label="Maximum output tokens"]')).toBeNull()

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Advanced settings')
        ?.click()
    })

    expect(
      container
        .querySelector<HTMLInputElement>('[aria-label="Maximum input tokens"]')
        ?.getAttribute('role')
    ).toBeNull()
    expect(
      container
        .querySelector<HTMLInputElement>('[aria-label="Maximum output tokens"]')
        ?.getAttribute('role')
    ).toBeNull()
    // The auth style selector was removed; custom always uses a bearer token.
    expect(container.querySelector('[aria-label="Auth style"]')).toBeNull()
  })

  it('opens Advanced settings when saved model limits would otherwise be hidden', () => {
    render(
      createEmptyProviderFormValue({
        type: 'custom',
        maxInputTokens: '272000'
      })
    )

    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="provider-advanced-settings"]'
    )
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('#provider-advanced-settings')).not.toBeNull()
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Maximum input tokens"]')?.value
    ).toBe('272000')
  })

  it('shows context and input/output presets as inline shortcuts', () => {
    render(createEmptyProviderFormValue({ type: 'custom' }))

    expect(
      container.querySelector('[role="group"][aria-labelledby="provider-context-window-label"]')
        ?.textContent
    ).toBe('32K64K128K200K256K1M')

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Advanced settings')
        ?.click()
    })

    expect(
      container.querySelector('[role="group"][aria-labelledby="provider-max-input-tokens-label"]')
        ?.textContent
    ).toBe('32K64K128K200K256K1M')
    expect(
      container.querySelector('[role="group"][aria-labelledby="provider-max-output-tokens-label"]')
        ?.textContent
    ).toBe('4K8K16K32K64K128K')
  })

  it('shows OpenAI as an official provider with a model catalog', () => {
    render(
      createEmptyProviderFormValue({
        type: 'official',
        name: 'OpenAI',
        vendorId: 'openai',
        apiEndpoint: 'responses'
      })
    )

    expect(container.querySelector('[aria-label="Provider type"]')?.textContent).toContain('OpenAI')
    expect(container.querySelector('[aria-label="Base URL"]')).toBeNull()
    expect(container.querySelector('[aria-label="API format"]')).toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).toBeNull()
    expect(container.querySelector('[aria-label="Context window"]')).toBeNull()
    expect(container.textContent).toContain('gpt-5.6-sol')
    expect(container.querySelector<HTMLAnchorElement>('a')?.href).toBe(
      'https://platform.openai.com/api-keys'
    )
  })

  it('renders the bundled Grok brand mark for the xAI provider', () => {
    render(
      createEmptyProviderFormValue({
        type: 'official',
        name: 'xAI (Grok)',
        vendorId: 'xai',
        apiEndpoint: 'responses'
      })
    )

    const providerType = container.querySelector('[aria-label="Provider type"]')
    const icon = providerType?.querySelector('img')

    expect(providerType?.textContent).toContain('xAI (Grok)')
    expect(icon?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(decodeURIComponent(icon?.getAttribute('src') ?? '')).toContain('<title>Grok</title>')
    expect(container.textContent).toContain('grok-4.6')
  })

  it('renders the bundled Bailian brand mark and regional catalog', () => {
    render(
      createEmptyProviderFormValue({
        type: 'official',
        name: 'Bailian',
        vendorId: 'bailian',
        region: 'china',
        apiEndpoint: 'responses'
      })
    )

    const providerType = container.querySelector('[aria-label="Provider type"]')
    const icon = providerType?.querySelector('img')

    expect(providerType?.textContent).toContain('Bailian')
    expect(icon?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(decodeURIComponent(icon?.getAttribute('src') ?? '')).toContain('<title>BaiLian</title>')
    expect(container.querySelector('[aria-label="Endpoint"]')?.textContent).toContain('China')
    expect(container.textContent).toContain('qwen3.8-max')
  })

  it('reuses the bundled Bailian brand mark for Bailian for Plan', () => {
    render(
      createEmptyProviderFormValue({
        type: 'official',
        name: 'Bailian for Plan',
        vendorId: 'bailianplan',
        apiEndpoint: 'openai'
      })
    )

    const providerType = container.querySelector('[aria-label="Provider type"]')
    const icon = providerType?.querySelector('img')

    expect(providerType?.textContent).toContain('Bailian for Plan')
    expect(icon?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(decodeURIComponent(icon?.getAttribute('src') ?? '')).toContain('<title>BaiLian</title>')
    expect(container.textContent).toContain('qwen3.8-max-preview')
  })

  it('allows a custom gateway to select the Responses endpoint', () => {
    render(
      createEmptyProviderFormValue({
        type: 'custom',
        baseUrl: 'https://gateway.example/v1',
        model: 'custom-responses-model',
        apiEndpoint: 'responses'
      })
    )

    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/responses'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Base URL"]')?.value).toBe(
      'https://gateway.example/v1'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe(
      'custom-responses-model'
    )
  })

  it('lets a custom model declare its reasoning effort group', async () => {
    render(
      createEmptyProviderFormValue({
        type: 'custom',
        apiEndpoint: 'openai',
        reasoningEffortPreset: 'none-high',
        reasoningEffortTransport: 'deepseek'
      })
    )

    expect(
      container.querySelector('[aria-label="Supports thinking mode"]')?.getAttribute('data-state')
    ).toBe('checked')
    expect(
      container.querySelector('[aria-label="Reasoning effort levels"]')?.textContent
    ).toContain('None / High')
    expect(container.textContent).not.toContain('exact levels accepted by this model')
    const effortHelp = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="field-help"]')
    ).find((button) => button.parentElement?.textContent?.includes('Supported effort levels'))
    await act(async () => effortHelp?.focus())
    expect(document.body.textContent).toContain('exact levels accepted by this model')
    expect(document.body.textContent).toContain(
      'Examples reflect common native model APIs. A gateway may use different mappings.'
    )
    expect(
      container.querySelector('[aria-label="Reasoning effort request format"]')?.textContent
    ).toContain('DeepSeek — thinking + reasoning_effort')
  })

  it('keeps thinking controls off by default and reveals them only after enabling', () => {
    const onChange = vi.fn()
    render(createEmptyProviderFormValue({ type: 'custom' }), { onChange })

    expect(container.querySelector('[aria-label="Supports thinking mode"]')).toBeNull()
    expect(container.querySelector('[aria-label="Reasoning effort levels"]')).toBeNull()

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Advanced settings')
        ?.click()
    })

    expect(
      container.querySelector('[aria-label="Supports thinking mode"]')?.getAttribute('data-state')
    ).toBe('unchecked')

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Supports thinking mode"]')?.click()
    })

    expect(onChange).toHaveBeenCalledWith({ reasoningEffortPreset: 'standard-5' })
  })

  it.each([
    [
      'anthropic' as const,
      "Messages API uses the framework's Anthropic-compatible thinking request automatically."
    ],
    ['responses' as const, 'Responses API uses its native reasoning request automatically.']
  ])('does not ask for a separate reasoning request format on %s', async (apiEndpoint, copy) => {
    render(
      createEmptyProviderFormValue({
        type: 'custom',
        apiEndpoint,
        reasoningEffortPreset: 'standard-5'
      })
    )

    expect(container.textContent).not.toContain(copy)
    expect(container.querySelector('[aria-label="Reasoning effort request format"]')).toBeNull()
    const effortHelp = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="field-help"]')
    ).find((button) => button.parentElement?.textContent?.includes('Supported effort levels'))
    await act(async () => effortHelp?.focus())
    expect(document.body.textContent).toContain(copy)
  })

  it('describes existing Codex authentication as a one-time import', () => {
    render(
      createEmptyProviderFormValue({
        type: 'codex-shared',
        name: 'Existing Codex profile',
        apiEndpoint: 'responses'
      }),
      { showCodexSubscriptions: true }
    )

    expect(container.querySelector('[aria-label="Provider name"]')).toBeNull()
    expect(container.querySelector('[aria-label="API key"]')).toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).toBeNull()
    expect(container.textContent).toContain(
      "Copies Codex authentication and, when compatible, the active provider's non-secret loopback route into Open Science"
    )
    expect(container.textContent).toContain('Skills and sessions are not imported')
  })

  it('chooses the Codex authentication mode inside the single provider form', () => {
    render(createEmptyProviderFormValue({ type: 'codex-shared', name: 'Codex subscription' }), {
      showCodexSubscriptions: true
    })

    const trigger = container.querySelector('[aria-label="Codex authentication"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.textContent).toContain('Import existing Codex sign-in')
    expect(container.querySelector('[aria-label="Transport"]')).toBeNull()

    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Advanced settings')
        ?.click()
    })

    expect(container.querySelector('[aria-label="Transport"]')?.textContent).toContain(
      'Auto (recommended)'
    )
  })

  it('opens Codex Advanced settings when a manual transport would otherwise be hidden', () => {
    render(
      createEmptyProviderFormValue({
        type: 'codex-isolated',
        codexTransport: 'https'
      }),
      { showCodexSubscriptions: true }
    )

    const disclosure = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="provider-advanced-settings"]'
    )
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[aria-label="Transport"]')?.textContent).toContain('HTTPS')
  })

  it('shows a fixed Claude subscription without an editable name or API key', () => {
    render(
      createEmptyProviderFormValue({
        type: 'claude-isolated',
        name: 'Claude subscription',
        apiEndpoint: 'anthropic'
      }),
      { showClaudeIsolated: true }
    )

    // Mirrors the Codex subscription: the identity is a fixed builtin, so no editable name, and the
    // browser sign-in (both isolated and shared modes) lives in the Settings card, not an inline
    // API-key field. The authentication mode selector is shown.
    expect(container.querySelector('[aria-label="Provider name"]')).toBeNull()
    expect(container.querySelector('[aria-label="API key"]')).toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).not.toBeNull()
    expect(container.textContent).toContain('Claude authentication')
    expect(container.textContent).toContain('Sign in separately')
    expect(container.textContent).toContain('claude setup-token')
    expect(container.textContent).toContain('nothing is read from or written to')
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
    expect(container.textContent).toContain('deepseek-v4-flash-vision-exp')
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

  it('lets the user reveal and hide only the API key in the current draft', () => {
    render(createEmptyProviderFormValue({ type: 'custom', key: 'draft-secret' }))
    const keyInput = container.querySelector<HTMLInputElement>('[aria-label="API key"]')

    expect(keyInput?.type).toBe('password')
    expect(keyInput?.value).toBe('draft-secret')

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show API key"]')?.click()
    })
    expect(keyInput?.type).toBe('text')
    expect(container.querySelector('[aria-label="Hide API key"]')).not.toBeNull()

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Hide API key"]')?.click()
    })
    expect(keyInput?.type).toBe('password')
  })

  it('masks the API key again when the provider kind or record changes', () => {
    render(createEmptyProviderFormValue({ type: 'custom', key: 'draft-secret' }))

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show API key"]')?.click()
    })
    expect(container.querySelector<HTMLInputElement>('[aria-label="API key"]')?.type).toBe('text')

    render(
      createEmptyProviderFormValue({
        type: 'official',
        vendorId: 'deepseek',
        key: 'draft-secret'
      })
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="API key"]')?.type).toBe(
      'password'
    )

    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show API key"]')?.click()
    })
    render(createEmptyProviderFormValue({ type: 'official', vendorId: 'deepseek', key: '' }))
    render(
      createEmptyProviderFormValue({
        type: 'official',
        vendorId: 'deepseek',
        key: 'next-draft-secret'
      })
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="API key"]')?.type).toBe(
      'password'
    )
  })

  it('moves custom-provider descriptions into generic field-help tooltips', async () => {
    render(createEmptyProviderFormValue({ type: 'custom' }))
    const helpButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="field-help"]')
    )

    expect(helpButtons).toHaveLength(5)
    expect(
      helpButtons.every((button) => button.getAttribute('aria-label') === 'More information')
    ).toBe(true)
    expect(container.textContent).not.toContain(
      'Base URL, key, and model for an Anthropic or OpenAI-compatible endpoint'
    )
    expect(container.textContent).not.toContain('Which chat API this gateway speaks')

    await act(async () => helpButtons[0]?.focus())
    expect(document.body.textContent).toContain(
      'Base URL, key, and model for a Messages or Chat Completions endpoint'
    )

    await act(async () => helpButtons[1]?.focus())
    expect(document.body.textContent).toContain('The gateway root')

    await act(async () => helpButtons[2]?.focus())
    expect(document.body.textContent).toContain('Choose the protocol documented by the gateway')

    await act(async () => helpButtons[3]?.focus())
    expect(document.body.textContent).toContain('Your key stays private.')
  })

  it('uses field help for provider, key, and supported-model descriptions for official vendors', async () => {
    render(createEmptyProviderFormValue({ type: 'official', vendorId: 'deepseek' }))
    const helpButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="field-help"]')
    )

    expect(helpButtons).toHaveLength(3)
    expect(container.textContent).not.toContain('API key — models provided')
    expect(container.textContent).not.toContain('Bundled with the app.')

    await act(async () => helpButtons[2]?.focus())
    expect(document.body.textContent).toContain(
      'Bundled with the app. Refresh from the vendor to pull the latest.'
    )
  })

  it('describes encrypted and unavailable storage accurately', () => {
    // The selector returns keys, which under natural-language keys are themselves the English copy.
    // Resolving them through t() still matters: it proves the fail-closed promise reaches the user in
    // the resolved language instead of only existing as a constant.
    const resolve = (encryptionAvailable: boolean): { title: string; description: string } => {
      const keys = getApiKeySecurityCopyKeys(encryptionAvailable)
      return {
        title: i18next.t(keys.title),
        description: i18next.t(keys.description)
      }
    }

    expect(resolve(true)).toEqual({
      title: 'Your key stays private.',
      description:
        'It is stored only on this device and never uploaded to Open Science. Your OS secure storage protects it, and it is sent only to the selected provider when you make a request.'
    })
    expect(resolve(false)).toEqual({
      title: 'Secure storage is unavailable.',
      description:
        'Open Science will not save API keys until the operating-system credential vault is available. Unlock or authorize the system keychain, then retry.'
    })
  })

  it('renders inline required-field errors for a custom provider', () => {
    // Errors arrive as catalog keys; the assertions below are on the rendered English, so this covers
    // both the key→copy resolution and the fact that each field renders its own message.
    render(createEmptyProviderFormValue({ type: 'custom' }), {
      errors: {
        baseUrl: 'Base URL is required.',
        key: 'API key is required.',
        model: 'Model is required.'
      }
    })

    const baseUrl = container.querySelector<HTMLInputElement>('[aria-label="Base URL"]')
    const key = container.querySelector<HTMLInputElement>('[aria-label="API key"]')
    const model = container.querySelector<HTMLInputElement>('[aria-label="Model"]')

    for (const [field, errorId] of [
      [baseUrl, 'provider-base-url-error'],
      [key, 'provider-key-error'],
      [model, 'provider-model-error']
    ] as const) {
      expect(field?.getAttribute('aria-required')).toBe('true')
      expect(field?.getAttribute('aria-invalid')).toBe('true')
      expect(field?.getAttribute('aria-describedby')).toBe(errorId)
      expect(container.querySelector(`#${errorId}`)).not.toBeNull()
    }

    expect(container.querySelector('#provider-base-url-error')?.textContent).toBe(
      'Base URL is required.'
    )
    expect(container.querySelector('#provider-key-error')?.textContent).toBe('API key is required.')
    expect(container.querySelector('#provider-model-error')?.textContent).toBe('Model is required.')
  })

  it('does not require a replacement API key when an edit keeps the stored key', () => {
    render(createEmptyProviderFormValue({ type: 'official' }), { hasStoredKey: true })

    expect(
      container
        .querySelector<HTMLInputElement>('[aria-label="API key"]')
        ?.getAttribute('aria-required')
    ).toBeNull()
  })
})

// @vitest-environment jsdom
// Proves the Model panel's pieces read from the catalog rather than shipping literals: each renders in
// English, then re-renders in Chinese after a language change. Catalog parity tests can't catch a
// component that never calls t() at all, and a locale-independent helper that quietly returns English.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { i18next } from '@/i18n'
import { ProviderList } from './ProviderList'
import { describeValidation } from './validation-message'
import { incompatibilityReason } from '../workspace/composer-model-picker-utils'
import type { ProviderView } from '../../../../shared/settings'

let container: HTMLDivElement
let root: Root

const render = (element: React.JSX.Element): void => {
  act(() => {
    root.render(element)
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  switchTo('en')
})

const noop = (): void => {}

const listProps = {
  activeProviderId: undefined,
  onEdit: noop,
  onDelete: noop,
  onTest: noop
}

describe('ProviderList', () => {
  it('translates the empty state and re-renders on language change', () => {
    render(<ProviderList providers={[]} {...listProps} />)
    expect(container.textContent).toContain('No providers yet')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('还没有模型服务商')
    expect(container.textContent).not.toContain('No providers yet')
  })

  it('translates a row type badge while leaving the provider name alone', () => {
    const provider = {
      id: 'p1',
      name: 'My gateway',
      type: 'custom',
      baseUrl: 'https://gateway.example',
      model: 'some-model',
      apiEndpoints: ['openai']
    } as unknown as ProviderView

    render(<ProviderList providers={[provider]} {...listProps} />)
    expect(container.textContent).toContain('Custom')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('自定义')
    // The provider's own name is user data, not copy — it must survive the language change verbatim.
    expect(container.textContent).toContain('My gateway')
  })
})

describe('describeValidation', () => {
  it('resolves category copy per locale and keeps the gateway message verbatim', () => {
    const zh = i18next.getFixedT('zh-Hans')
    expect(describeValidation({ ok: false, category: 'timeout' }, zh)).toBe('请求超时并已中止。')

    // A gateway-supplied message is the provider's text, not ours: it interpolates unchanged, and only
    // the surrounding frame localizes.
    expect(
      describeValidation(
        { ok: false, category: 'network', message: 'ECONNREFUSED' },
        i18next.getFixedT('zh-Hant')
      )
    ).toBe('無法連上該端點。檢查網路連線和基礎 URL。（ECONNREFUSED）')
  })
})

describe('incompatibilityReason', () => {
  it('localizes the frame while keeping route paths and names verbatim', () => {
    const reason = incompatibilityReason(
      { apiEndpoints: ['openai'], type: 'custom', name: 'OpenAI Gateway' },
      'Claude Code',
      ['anthropic'],
      i18next.getFixedT('zh-Hans')
    )

    expect(reason).toContain('/v1/messages')
    expect(reason).toContain('/v1/chat/completions')
    expect(reason).toContain('Claude Code')
    expect(reason).toContain('OpenAI Gateway')
    expect(reason).toContain('需要')
  })

  it('preserves spaces around Brazilian Portuguese route-list conjunctions', () => {
    const reason = incompatibilityReason(
      { apiEndpoints: ['openai', 'responses'], type: 'custom', name: 'Gateway' },
      'Claude Code',
      ['anthropic', 'responses'],
      i18next.getFixedT('pt-BR')
    )

    expect(reason).toContain('/v1/messages ou /v1/responses')
    expect(reason).toContain('/v1/chat/completions ou /v1/responses')
    expect(reason).not.toContain('messagesou')
  })
})

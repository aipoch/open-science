// @vitest-environment jsdom
// Proves the Claude setup-token modal reads its copy from the catalog rather than shipping literals.
// The description is a <Trans> with two <code> spans and a <link>, so it is asserted on the rendered
// text and on the surviving anchor — a catalog whose tags don't match the components map would drop
// the link silently. zh-Hant is asserted separately because no cross-script fallback is configured.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { ClaudeIsolatedSignInModal } from './ClaudeIsolatedSignInModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

// The modal renders through a Radix portal, so assertions read document.body, not the container.
const renderModal = (browserSignInPending = false): void => {
  act(() => {
    root.render(
      <ClaudeIsolatedSignInModal
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        browserSignInPending={browserSignInPending}
      />
    )
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
  act(() => root.unmount())
  container.remove()
  switchTo('en')
})

describe('ClaudeIsolatedSignInModal copy', () => {
  it('translates the title, step, and footer actions, and re-renders on language change', () => {
    renderModal()
    expect(document.body.textContent).toContain('Sign in with Anthropic')
    expect(document.body.textContent).toContain('Step 1 · Run')
    expect(document.body.textContent).toContain('Sign in')
    expect(document.body.textContent).toContain('Cancel')

    switchTo('zh-Hans')
    expect(document.body.textContent).toContain('使用 Anthropic 账号登录')
    expect(document.body.textContent).toContain('第 1 步 · 运行')
    expect(document.body.textContent).toContain('取消')

    // zh-Hant must not fall back to zh-Hans: 登录→登入, 运行→執行.
    switchTo('zh-Hant')
    expect(document.body.textContent).toContain('使用 Anthropic 帳號登入')
    expect(document.body.textContent).toContain('第 1 步 · 執行')
    expect(document.body.textContent).not.toContain('第 1 步 · 运行')
  })

  it('keeps the code spans and the docs link when interpolating the description', () => {
    renderModal()
    const anchor = document.body.querySelector('a[href*="docs.claude.com"]')
    expect(anchor?.textContent).toContain("Anthropic's setup-token guide")
    expect(document.body.textContent).toContain('claude setup-token')
    expect(document.body.textContent).toContain('~/.claude')

    switchTo('zh-Hant')
    const zhAnchor = document.body.querySelector('a[href*="docs.claude.com"]')
    expect(zhAnchor?.textContent).toContain('Anthropic 的 setup-token 指南')
    // Command and path are protocol values — untranslated in every locale.
    expect(document.body.textContent).toContain('claude setup-token')
    expect(document.body.textContent).toContain('~/.claude')
  })

  it('swaps the paste label and hides step 1 while a browser sign-in is pending', () => {
    renderModal(true)
    expect(document.body.textContent).toContain('Paste the token printed by setup-token')
    expect(document.body.textContent).not.toContain('Step 1 · Run')
    expect(document.body.textContent).toContain('Opening your browser to sign in…')

    switchTo('zh-Hans')
    expect(document.body.textContent).toContain('粘贴 setup-token 输出的 token')
    expect(document.body.textContent).toContain('正在打开浏览器登录…')
  })
})

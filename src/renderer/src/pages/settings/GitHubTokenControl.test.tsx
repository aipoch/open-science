// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { GitHubTokenControl } from './GitHubTokenControl'

let container: HTMLDivElement
let root: Root

const settingsApi = {
  getGitHubTokenStatus: vi.fn(),
  saveGitHubToken: vi.fn(),
  removeGitHubToken: vi.fn()
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const click = async (label: string): Promise<void> => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes(label)
  )
  await act(async () => button?.click())
}

const enterToken = (value: string): void => {
  const field = document.body.querySelector<HTMLInputElement>('#github-token')
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', {
    value: { getData: vi.fn(() => value), setData: vi.fn() }
  })
  act(() => {
    field?.dispatchEvent(paste)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  settingsApi.getGitHubTokenStatus.mockResolvedValue({ configured: false })
  ;(window as unknown as { api: unknown }).api = { settings: settingsApi }
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

describe('GitHubTokenControl', () => {
  it('stays hidden when token management is restricted to the local app', async () => {
    settingsApi.getGitHubTokenStatus.mockRejectedValue(
      new Error(
        'This action is only available in the local desktop app (settings:get-github-token-status).'
      )
    )

    await act(async () => root.render(<GitHubTokenControl />))
    await flush()

    expect(container.innerHTML).toBe('')
  })

  it('reveals an initially disabled save action and reports a successful verified save', async () => {
    settingsApi.saveGitHubToken.mockResolvedValue({ configured: true, mask: 'gith…fied' })
    await act(async () => root.render(<GitHubTokenControl />))
    await flush()

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Verify and save')
    )
    expect(save?.disabled).toBe(true)

    const settingsLink = document.body.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/settings/tokens"]'
    )
    expect(settingsLink?.textContent).toContain('Manage tokens on GitHub')
    expect(settingsLink?.target).toBe('_blank')
    expect(settingsLink?.rel).toBe('noreferrer')

    enterToken('github_pat_verified')
    expect(save?.disabled).toBe(false)
    await act(async () => {
      document.body
        .querySelector<HTMLInputElement>('#github-token')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' })
        )
    })
    await flush()

    expect(settingsApi.saveGitHubToken).toHaveBeenCalledWith({ token: 'github_pat_verified' })
    expect(document.body.textContent).toContain('Token verified and saved.')
    expect(document.body.textContent).toContain('Saved token: gith…fied')
    expect(document.body.querySelectorAll('#github-token-status')).toHaveLength(1)
    expect(document.body.querySelectorAll('#github-token-feedback')).toHaveLength(1)
    expect(document.body.querySelector('#github-token')?.getAttribute('aria-describedby')).toBe(
      'github-token-status github-token-feedback'
    )
    expect(document.body.querySelector<HTMLInputElement>('#github-token')?.value).toBe('')

    await act(async () => i18next.changeLanguage('zh-Hans'))
    expect(document.body.textContent).toContain('令牌已验证并保存。')
    expect(document.body.textContent).not.toContain('Token verified and saved.')
    await act(async () => i18next.changeLanguage('en'))
  })

  it('keeps the existing masked token visible when replacement validation fails', async () => {
    settingsApi.getGitHubTokenStatus.mockResolvedValue({ configured: true, mask: 'old…oken' })
    settingsApi.saveGitHubToken.mockRejectedValue(new Error('GitHub rejected this token.'))
    await act(async () => root.render(<GitHubTokenControl />))
    await flush()

    enterToken('bad-token')
    await click('Verify and save')
    await flush()

    expect(
      document.body.querySelector('[aria-label="GitHub token settings"]')?.getAttribute('aria-busy')
    ).toBe('false')
    expect(document.body.textContent).toContain('GitHub rejected this token.')
    expect(document.body.textContent).toContain('Saved token: old…oken')
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('localizes a token verification failure instead of displaying backend error details', async () => {
    settingsApi.getGitHubTokenStatus.mockResolvedValue({ configured: true, mask: 'old…oken' })
    settingsApi.saveGitHubToken.mockRejectedValue(
      new Error('GitHub rejected this token. Check that it is valid and try again.')
    )
    await act(async () => root.render(<GitHubTokenControl />))
    await flush()

    enterToken('bad-token')
    await click('Verify and save')
    await flush()

    await act(async () => i18next.changeLanguage('zh-Hans'))
    const alert = document.body.querySelector('[role="alert"]')?.textContent
    const details = document.body.querySelector('details')
    await act(async () => i18next.changeLanguage('en'))

    expect(alert).toContain('令牌验证失败。')
    expect(alert).not.toContain('GitHub rejected this token.')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('GitHub rejected this token.')
  })

  it('removes a configured token and exposes the success state', async () => {
    settingsApi.getGitHubTokenStatus.mockResolvedValue({ configured: true, mask: 'old…oken' })
    settingsApi.removeGitHubToken.mockResolvedValue({ configured: false })
    await act(async () => root.render(<GitHubTokenControl />))
    await flush()

    await click('Remove token')
    await flush()

    expect(settingsApi.removeGitHubToken).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Saved token removed.')
    expect(document.body.textContent).not.toContain('old…oken')
  })
})

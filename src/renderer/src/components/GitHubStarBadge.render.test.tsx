// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitHubStarBadge } from './GitHubStarBadge'
import { APP } from '../../../shared/app-config'

let container: HTMLDivElement
let root: Root
const STAR_NUDGE_LAST_SHOWN_STORAGE_KEY = 'open-science:github-star-nudge-last-shown-at'

const installApi = (getStars: () => Promise<number | null>): void => {
  ;(window as unknown as { api: unknown }).api = { github: { getStars } }
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  window.localStorage.removeItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.localStorage.removeItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY)
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GitHubStarBadge', () => {
  it('links to the repo and shows the formatted count when available', async () => {
    installApi(() => Promise.resolve(1234))
    await act(async () => {
      root.render(<GitHubStarBadge />)
    })
    await flush()

    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe(APP.links.githubRepo)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.textContent).toContain('1.2k')
  })

  it('shows an icon-only entry when the count is unavailable', async () => {
    installApi(() => Promise.resolve(null))
    await act(async () => {
      root.render(<GitHubStarBadge />)
    })
    await flush()

    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe(APP.links.githubRepo)
    expect(link?.textContent).not.toMatch(/\d/)
  })

  it('degrades to an icon-only link when the github API is unavailable', async () => {
    ;(window as unknown as { api: unknown }).api = {}

    await act(async () => {
      root.render(<GitHubStarBadge />)
    })
    await flush()

    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe(APP.links.githubRepo)
    expect(link?.textContent).not.toMatch(/\d/)
  })

  it('keeps the workspace entry voluntary without timed prompts or storage writes', async () => {
    vi.useFakeTimers()
    installApi(() => Promise.resolve(2600))
    await act(async () => {
      root.render(<GitHubStarBadge variant="workspace" />)
    })
    act(() => vi.advanceTimersByTime(60_000))
    expect(container.querySelector('a')?.getAttribute('href')).toBe(APP.links.githubRepo)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Enjoying Open-Science?')
    expect(window.localStorage.getItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY)).toBeNull()
  })
})

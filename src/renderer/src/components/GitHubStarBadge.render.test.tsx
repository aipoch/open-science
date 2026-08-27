// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: React.ReactNode; open: boolean }) => (
    <div data-popover-open={open}>{children}</div>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { GitHubStarBadge } from './GitHubStarBadge'
import { APP } from '../../../shared/app-config'

let container: HTMLDivElement
let root: Root
const STAR_NUDGE_LAST_SHOWN_STORAGE_KEY = 'open-science:github-star-nudge-last-shown-at'
const STAR_NUDGE_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1_000

const installApi = (getStars: () => Promise<number | null>): void => {
  ;(window as unknown as { api: unknown }).api = { github: { getStars } }
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.localStorage.clear()
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

  it('shows the workspace nudge after five seconds and keeps it open for thirty seconds', async () => {
    vi.useFakeTimers()
    const getClientRects = vi
      .spyOn(Element.prototype, 'getClientRects')
      .mockReturnValue({ length: 1 } as DOMRectList)
    installApi(() => Promise.resolve(2600))

    await act(async () => {
      root.render(<GitHubStarBadge variant="workspace" nudgeKey="project-1" />)
    })

    const popover = (): Element | null => container.querySelector('[data-popover-open]')
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    act(() => vi.advanceTimersByTime(4_999))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    act(() => vi.advanceTimersByTime(1))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')
    expect(Number(window.localStorage.getItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY))).toBe(Date.now())
    expect(container.textContent).toContain('A star helps more researchers find it.')
    expect(container.querySelector('svg[class*="_infinite"]')).not.toBeNull()

    act(() => vi.advanceTimersByTime(29_999))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')

    act(() => vi.advanceTimersByTime(1))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    getClientRects.mockRestore()
  })

  it('shows the workspace nudge at most once every two days across projects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList)
    installApi(() => Promise.resolve(2600))

    const popover = (): Element | null => container.querySelector('[data-popover-open]')
    await act(async () => {
      root.render(<GitHubStarBadge key="project-1" variant="workspace" nudgeKey="project-1" />)
    })
    act(() => vi.advanceTimersByTime(5_000))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')
    const lastShownAt = Number(window.localStorage.getItem(STAR_NUDGE_LAST_SHOWN_STORAGE_KEY))

    await act(async () => {
      root.render(<GitHubStarBadge key="project-2" variant="workspace" nudgeKey="project-2" />)
    })
    vi.setSystemTime(lastShownAt + STAR_NUDGE_COOLDOWN_MS - 1)
    act(() => vi.advanceTimersByTime(10_000))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    vi.setSystemTime(lastShownAt + STAR_NUDGE_COOLDOWN_MS)
    await act(async () => {
      root.render(<GitHubStarBadge key="project-3" variant="workspace" nudgeKey="project-3" />)
    })
    act(() => vi.advanceTimersByTime(4_999))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    act(() => vi.advanceTimersByTime(1))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')
  })

  it('starts the workspace delay after the sidebar becomes visible and closes when hidden', async () => {
    vi.useFakeTimers()
    let visible = false
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(
      () => ({ length: visible ? 1 : 0 }) as DOMRectList
    )
    installApi(() => Promise.resolve(2600))

    await act(async () => {
      root.render(<GitHubStarBadge variant="workspace" nudgeKey="project-1" />)
    })

    const popover = (): Element | null => container.querySelector('[data-popover-open]')
    act(() => vi.advanceTimersByTime(2_000))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    visible = true
    act(() => vi.advanceTimersByTime(500))
    act(() => vi.advanceTimersByTime(4_999))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')

    act(() => vi.advanceTimersByTime(1))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')

    act(() => vi.advanceTimersByTime(500))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')

    visible = false
    act(() => vi.advanceTimersByTime(499))
    expect(popover()?.getAttribute('data-popover-open')).toBe('true')

    act(() => vi.advanceTimersByTime(1))
    expect(popover()?.getAttribute('data-popover-open')).toBe('false')
  })
})

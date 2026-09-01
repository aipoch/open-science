// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

import { SessionMessageLink } from './SessionMessageLink'

describe('SessionMessageLink', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      isLoaded: true,
      notebookNetwork: {
        allowedDomains: ['example.com'],
        disabledOpenScienceDomainGroups: [],
        disabledOpenScienceDomains: []
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('loads a remote favicon only for an approved domain and keeps a local fallback otherwise', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://tracking.example/pixel?visitor=123">
          Unapproved source
        </SessionMessageLink>
      )
    })

    expect(container.querySelector('[data-session-link-favicon-fallback]')).not.toBeNull()
    expect(container.querySelector('[data-session-link-favicon] img')).toBeNull()

    await act(async () => {
      root.render(
        <SessionMessageLink href="https://pubmed.ncbi.nlm.nih.gov/123?view=full">
          Paper
        </SessionMessageLink>
      )
    })

    let favicon = container.querySelector<HTMLImageElement>('[data-session-link-favicon] img')
    expect(favicon?.getAttribute('src')).toBe('https://pubmed.ncbi.nlm.nih.gov/favicon.ico')
    expect(favicon?.getAttribute('loading')).toBe('lazy')
    expect(favicon?.getAttribute('referrerpolicy')).toBe('no-referrer')

    await act(async () => {
      root.render(
        <SessionMessageLink href="https://pubmed.ncbi.nlm.nih.gov/456">Paper</SessionMessageLink>
      )
    })
    favicon = container.querySelector<HTMLImageElement>('[data-session-link-favicon] img')
    expect(favicon?.getAttribute('src')).toBe('https://pubmed.ncbi.nlm.nih.gov/favicon.ico')

    await act(async () => {
      favicon?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('[data-session-link-favicon]')?.getAttribute('data-state')).toBe(
      'error'
    )
    expect(container.querySelector('[data-session-link-favicon] img')).toBeNull()
    expect(container.querySelector('[data-session-link-favicon-fallback]')).not.toBeNull()

    await act(async () => {
      root.render(
        <SessionMessageLink href="mailto:researcher@example.com">Email</SessionMessageLink>
      )
    })
    expect(container.querySelector('[data-session-link-favicon]')).toBeNull()
  })

  it('keeps the external-link safety confirmation for a non-HTTPS session link', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await act(async () => {
      root.render(<SessionMessageLink href="http://example.com/paper">Paper</SessionMessageLink>)
    })

    const link = container.querySelector<HTMLButtonElement>('[data-session-message-link]')
    await act(async () => {
      link?.click()
    })
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))

    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Open external link?"]'
    )
    expect(dialog).not.toBeNull()

    const openLink = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Open link'
    )
    await act(async () => {
      openLink?.click()
    })

    expect(open).toHaveBeenCalledWith('http://example.com/paper', '_blank', 'noreferrer')
  })

  it('keeps an unapproved HTTPS source local until external navigation is confirmed', async () => {
    vi.useFakeTimers()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await act(async () => {
      root.render(
        <SessionMessageLink href="https://tracking.example/paper">
          Unapproved source
        </SessionMessageLink>
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    fireEvent.pointerEnter(sourceLink!)
    await act(async () => vi.advanceTimersByTimeAsync(350))

    const hoverCard = document.body.querySelector<HTMLElement>('[data-source-preview-hover-card]')
    expect(hoverCard?.textContent).toContain('tracking.example')
    expect(hoverCard?.textContent).toContain('https://tracking.example/paper')
    expect(document.body.querySelector('[data-session-link-favicon] img')).toBeNull()
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])

    await act(async () => {
      hoverCard?.querySelector<HTMLAnchorElement>('[data-source-preview-hover-url]')?.click()
      await vi.runAllTimersAsync()
    })

    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Open external link?"]'
    )
    expect(dialog).not.toBeNull()
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'collapsed',
      items: []
    })

    const openLink = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Open link'
    )
    await act(async () => {
      openLink?.click()
    })

    expect(open).toHaveBeenCalledWith('https://tracking.example/paper', '_blank', 'noreferrer')
  })

  it('shows local source details on hover and opens an approved source in the preview panel', async () => {
    vi.useFakeTimers()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await act(async () => {
      root.render(
        <SessionMessageLink
          href="https://example.com/paper#results"
          title="Genome study"
          className="underline"
        >
          Torre et al. 2026
        </SessionMessageLink>
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    expect(sourceLink?.tagName).toBe('A')
    expect(sourceLink?.getAttribute('href')).toBe('https://example.com/paper#results')
    expect(sourceLink?.textContent).toContain('Torre et al. 2026')
    expect(container.querySelector('[data-citation-marker]')).toBeNull()

    fireEvent.pointerEnter(sourceLink!)
    await act(async () => vi.runAllTimersAsync())

    const hoverCard = document.body.querySelector<HTMLElement>('[data-source-preview-hover-card]')
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(hoverCard?.textContent).toContain('Genome study')
    expect(hoverCard?.textContent).toContain('example.com')
    expect(hoverCard?.textContent).toContain('https://example.com/paper#results')
    expect(hoverCard?.className).toContain('w-fit')
    const hoverSummary = hoverCard?.querySelector<HTMLElement>(
      '[data-source-preview-hover-summary]'
    )
    const hoverActions = hoverCard?.querySelector<HTMLElement>(
      '[data-source-preview-hover-actions]'
    )
    const hoverIconColumn = hoverCard?.querySelector<HTMLElement>(
      '[data-source-preview-hover-icon-column]'
    )
    const hoverContentColumn = hoverCard?.querySelector<HTMLElement>(
      '[data-source-preview-hover-content-column]'
    )
    const hoverTitle = hoverCard?.querySelector<HTMLElement>('[data-source-preview-hover-title]')
    expect(hoverTitle?.textContent).toBe('Genome study')
    expect(hoverTitle?.className).toContain('text-text-000')
    expect(hoverTitle?.id).not.toBe('')
    expect(hoverCard?.getAttribute('aria-labelledby')).toBe(hoverTitle?.id)
    const hoverHostname = hoverCard?.querySelector<HTMLElement>(
      '[data-source-preview-hover-hostname]'
    )
    expect(hoverHostname?.textContent).toBe('example.com')
    expect(hoverHostname?.className).toContain('text-text-000/70')
    const hoverFavicon = hoverCard?.querySelector<HTMLElement>('[data-session-link-favicon]')
    expect(hoverFavicon).not.toBeNull()
    expect(hoverFavicon?.querySelector('[data-session-link-favicon-skeleton]')).toBeNull()
    expect(hoverFavicon?.querySelector('[data-session-link-favicon-fallback]')).not.toBeNull()
    let hoverCardUrl = hoverCard?.querySelector<HTMLAnchorElement>(
      '[data-source-preview-hover-url]'
    )
    expect(hoverCardUrl?.tagName).toBe('A')
    expect(hoverCardUrl?.href).toBe('https://example.com/paper#results')
    expect(hoverCardUrl?.textContent).toBe('https://example.com/paper#results')
    expect(hoverCardUrl?.className).toContain('text-text-000')
    expect(hoverCardUrl?.className).not.toContain('text-text-300')
    const externalButton = hoverCard?.querySelector<HTMLButtonElement>(
      '[data-source-preview-hover-external]'
    )
    expect(externalButton?.getAttribute('aria-label')).toBe('Open source in browser')
    expect(hoverSummary?.contains(hoverTitle ?? null)).toBe(true)
    expect(hoverSummary?.contains(hoverHostname ?? null)).toBe(true)
    expect(hoverIconColumn?.contains(hoverFavicon ?? null)).toBe(true)
    expect(hoverContentColumn?.contains(hoverSummary ?? null)).toBe(true)
    expect(hoverContentColumn?.contains(hoverActions ?? null)).toBe(true)
    expect(hoverActions?.contains(hoverCardUrl ?? null)).toBe(true)
    expect(hoverActions?.contains(externalButton ?? null)).toBe(true)
    expect(
      Boolean(
        hoverSummary &&
        hoverActions &&
        hoverSummary.compareDocumentPosition(hoverActions) & Node.DOCUMENT_POSITION_FOLLOWING
      )
    ).toBe(true)
    const previewStateBeforeExternalOpen = usePreviewWorkbenchStore.getState()

    await act(async () => {
      externalButton?.focus()
      externalButton?.click()
      await vi.runAllTimersAsync()
    })
    expect(open).toHaveBeenCalledWith('https://example.com/paper#results', '_blank', 'noreferrer')
    expect(document.activeElement).toBe(sourceLink)
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: previewStateBeforeExternalOpen.panelState,
      activeItemId: previewStateBeforeExternalOpen.activeItemId,
      items: []
    })

    fireEvent.pointerEnter(sourceLink!)
    await act(async () => vi.runAllTimersAsync())
    hoverCardUrl = document.body.querySelector<HTMLAnchorElement>('[data-source-preview-hover-url]')

    await act(async () => {
      hoverCardUrl?.click()
    })

    expect(
      document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
    ).toBeNull()

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'open',
      activeItemId: 'source:https://example.com/paper#results',
      items: [
        expect.objectContaining({
          id: 'source:https://example.com/paper#results',
          type: 'source',
          title: 'Genome study',
          url: 'https://example.com/paper#results'
        })
      ]
    })
  })

  it('keeps the interactive source preview actions keyboard reachable', async () => {
    vi.useFakeTimers()

    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/paper" title="Genome study">
          Genome study
        </SessionMessageLink>
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    await act(async () => {
      sourceLink?.focus()
      await vi.runAllTimersAsync()
    })

    const hoverCard = document.body.querySelector<HTMLElement>('[data-source-preview-hover-card]')
    const hoverUrl = hoverCard?.querySelector<HTMLAnchorElement>('[data-source-preview-hover-url]')
    const externalButton = hoverCard?.querySelector<HTMLButtonElement>(
      '[data-source-preview-hover-external]'
    )
    expect(hoverUrl?.tabIndex).toBe(0)
    expect(externalButton?.tabIndex).toBe(0)

    fireEvent.keyDown(sourceLink!, { key: 'Tab' })
    expect(document.activeElement).toBe(hoverUrl)

    fireEvent.pointerLeave(sourceLink!)
    fireEvent.pointerLeave(hoverCard!)
    await act(async () => vi.runAllTimersAsync())
    expect(document.body.querySelector('[data-source-preview-hover-card]')).not.toBeNull()

    await act(async () => {
      hoverUrl?.click()
      await vi.runAllTimersAsync()
    })
    expect(document.activeElement).toBe(sourceLink)
  })

  it('restores focus on Escape and reopens when the source link is focused again', async () => {
    vi.useFakeTimers()

    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/paper" title="Genome study">
          Genome study
        </SessionMessageLink>
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    await act(async () => {
      sourceLink?.focus()
    })
    const hoverCard = document.body.querySelector<HTMLElement>('[data-source-preview-hover-card]')
    const hoverUrl = hoverCard?.querySelector<HTMLAnchorElement>('[data-source-preview-hover-url]')
    await act(async () => {
      hoverUrl?.focus()
      fireEvent.keyDown(hoverUrl!, { key: 'Escape' })
      await vi.runAllTimersAsync()
    })

    expect(document.body.querySelector('[data-source-preview-hover-card]')).toBeNull()
    expect(document.activeElement).toBe(sourceLink)

    await act(async () => {
      sourceLink?.blur()
      sourceLink?.focus()
    })
    expect(document.body.querySelector('[data-source-preview-hover-card]')).not.toBeNull()
  })

  it('opens interactive source details on touch without activating the preview panel', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/paper" title="Genome study">
          Genome study
        </SessionMessageLink>
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    await act(async () => {
      fireEvent.pointerDown(sourceLink!, { pointerType: 'touch' })
      sourceLink?.click()
    })

    expect(document.body.querySelector('[data-source-preview-hover-card]')).not.toBeNull()
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      panelState: 'collapsed',
      items: []
    })
  })

  it('uses the visible HTTPS link label as the source title when Markdown has no title', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/source">
          <strong>
            Torre et al. <em>2026</em>
          </strong>
        </SessionMessageLink>
      )
    })

    await act(async () => {
      container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')?.click()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      title: 'Torre et al. 2026',
      url: 'https://example.com/source'
    })
  })

  it('keeps a numeric non-HTTPS link on the external-link safety path', async () => {
    await act(async () => {
      root.render(<SessionMessageLink href="http://example.com/paper">1</SessionMessageLink>)
    })

    expect(container.querySelector('[data-citation-marker]')).toBeNull()
    expect(container.querySelector('[data-session-message-link]')).not.toBeNull()
  })

  it('routes middle-click HTTPS activation directly to the source panel', async () => {
    await act(async () => {
      root.render(
        <SessionMessageLink href="https://example.com/paper" title="Genome study">
          Genome study
        </SessionMessageLink>
      )
    })

    const sourceLink = container.querySelector<HTMLAnchorElement>('[data-source-preview-link]')
    const auxClick = new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })
    await act(async () => {
      sourceLink?.dispatchEvent(auxClick)
    })

    expect(auxClick.defaultPrevented).toBe(true)
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
    ).toBeNull()
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(
      'source:https://example.com/paper'
    )
  })
})

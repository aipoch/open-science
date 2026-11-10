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
import { SourceLinkSummary, resetSourceLinkSummaryCacheForTests } from './SourceLinkSummary'
import { PresentedAgentMarkdown } from './AgentMarkdown'

describe('SessionMessageLink', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetSourceLinkSummaryCacheForTests()
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

  it('loads unknown HTTPS metadata while keeping external navigation confirmation', async () => {
    vi.useFakeTimers()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    const getSourceLinkMetadata = vi.fn().mockResolvedValue({
      title: 'Public page',
      description: 'Public summary'
    })
    vi.stubGlobal('api', { settings: { getSourceLinkMetadata } })

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
    expect(getSourceLinkMetadata).toHaveBeenCalledWith('https://tracking.example/paper')
    expect(hoverCard?.textContent).toContain('Public page')
    expect(hoverCard?.textContent).toContain('Public summary')
    expect(hoverCard?.textContent).toContain('tracking.example')
    expect(hoverCard?.textContent).not.toContain('Unapproved source')
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

    const metadataResult = Promise.withResolvers<{
      title: string
      description: string
      imageUrl: string
    }>()
    const imageResult = Promise.withResolvers<string>()
    const getSourceLinkMetadata = vi.fn().mockReturnValue(metadataResult.promise)
    const getSourceLinkImage = vi.fn().mockReturnValue(imageResult.promise)
    vi.stubGlobal('api', { settings: { getSourceLinkMetadata, getSourceLinkImage } })
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

    expect(getSourceLinkMetadata).not.toHaveBeenCalled()
    fireEvent.pointerEnter(sourceLink!)
    await act(async () => vi.advanceTimersByTimeAsync(99))
    expect(document.body.querySelector('[data-source-preview-hover-card]')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    const hoverCard = document.body.querySelector<HTMLElement>('[data-source-preview-hover-card]')
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(getSourceLinkMetadata).toHaveBeenCalledWith('https://example.com/paper#results')
    expect(hoverCard?.textContent).toBe('example.com')
    expect(hoverCard?.getAttribute('data-side')).toBe('bottom')
    expect(getSourceLinkImage).not.toHaveBeenCalled()
    await act(async () => {
      metadataResult.resolve({
        title: 'Article title',
        description: 'Abstract',
        imageUrl: 'https://cdn.example/cover.png'
      })
    })
    expect(hoverCard?.textContent).toContain('Article title')
    expect(hoverCard!.querySelector('img[src^="data:"]')).toBeNull()
    expect(getSourceLinkImage).toHaveBeenCalledWith('https://cdn.example/cover.png')
    await act(async () => {
      imageResult.resolve('data:image/png;base64,AA==')
    })
    expect(hoverCard?.textContent).toContain('Article title')
    expect(hoverCard?.textContent).toContain('Abstract')
    const artwork = hoverCard!.querySelector<HTMLImageElement>('img[src^="data:"]')!
    expect(artwork).not.toBeNull()
    let hoverCardUrl = hoverCard?.querySelector<HTMLAnchorElement>(
      '[data-source-preview-hover-url]'
    )
    expect(hoverCardUrl?.textContent).toBe('example.com')
    expect(hoverCard?.getAttribute('aria-labelledby')).toBe(hoverCardUrl?.id)
    const externalButton = hoverCard?.querySelector<HTMLButtonElement>(
      '[data-source-preview-hover-external]'
    )
    expect(externalButton?.getAttribute('aria-label')).toBe('Open source in browser')
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
    expect(getSourceLinkMetadata).toHaveBeenCalledTimes(1)
    expect(getSourceLinkImage).toHaveBeenCalledTimes(1)
    const cachedCard = document.body.querySelector('[data-source-preview-hover-card]')!
    expect(cachedCard.textContent).toContain('Article title')
    const cachedArtwork = cachedCard.querySelector<HTMLImageElement>('img[src^="data:"]')!
    expect(cachedArtwork).not.toBeNull()
    fireEvent.error(cachedArtwork)
    expect(cachedCard.contains(cachedArtwork)).toBe(false)
    expect(cachedCard.textContent).toContain('Abstract')

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

  it('shares in-flight requests across closing and reopening a preview', async () => {
    const metadata = Promise.withResolvers<{ title: string; imageUrl: string }>()
    const image = Promise.withResolvers<string>()
    const getSourceLinkMetadata = vi.fn().mockReturnValue(metadata.promise)
    const getSourceLinkImage = vi.fn().mockReturnValue(image.promise)
    vi.stubGlobal('api', { settings: { getSourceLinkMetadata, getSourceLinkImage } })
    const preview = (
      <SourceLinkSummary url="https://example.com/pending" hostname="example.com" allowed />
    )
    await act(async () => root.render(preview))
    await act(async () => root.render(null))
    await act(async () => root.render(preview))
    expect(getSourceLinkMetadata).toHaveBeenCalledTimes(1)
    await act(async () =>
      metadata.resolve({ title: 'Pending article', imageUrl: 'https://example.com/image.png' })
    )
    expect(container.textContent).toContain('Pending article')
    await act(async () => root.render(null))
    await act(async () => root.render(preview))
    expect(getSourceLinkImage).toHaveBeenCalledTimes(1)
    await act(async () => image.resolve('data:image/png;base64,AA=='))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
  })

  it('retries failed metadata and artwork without refetching successful text', async () => {
    const getSourceLinkMetadata = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValue({ title: 'Recovered article', imageUrl: 'https://example.com/image.png' })
    const getSourceLinkImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValue('data:image/png;base64,AA==')
    vi.stubGlobal('api', { settings: { getSourceLinkMetadata, getSourceLinkImage } })
    const preview = (
      <SourceLinkSummary url="https://example.com/retry" hostname="example.com" allowed />
    )
    await act(async () => root.render(preview))
    expect(container.textContent).toBe('')
    await act(async () => root.render(null))
    await act(async () => root.render(preview))
    expect(container.textContent).toContain('Recovered article')
    expect(container.querySelector('img')).toBeNull()
    await act(async () => root.render(null))
    await act(async () => root.render(preview))
    expect(getSourceLinkMetadata).toHaveBeenCalledTimes(2)
    expect(getSourceLinkImage).toHaveBeenCalledTimes(2)
    expect(container.querySelector('img')).not.toBeNull()
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

    vi.stubGlobal('api', {
      settings: { getSourceLinkMetadata: vi.fn().mockRejectedValue(new Error('Timeout')) }
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
    expect(hoverCard?.textContent).toBe('example.com')
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
  it('updates a same-length source URL when rendered Markdown is replaced', async () => {
    const content = '[Paper](https://example.com/old) summary.'
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={content} sessionLinks isAnimating />)
    )
    expect(container.querySelector('a[data-session-message-link]')?.getAttribute('href')).toBe(
      'https://example.com/old'
    )
    await act(async () =>
      root.render(
        <PresentedAgentMarkdown
          content={content.replace('/old', '/new')}
          sessionLinks
          isAnimating
        />
      )
    )
    expect(container.querySelector('a[data-session-message-link]')?.getAttribute('href')).toBe(
      'https://example.com/new'
    )
  })

  it('keeps a loaded favicon and open source preview while following text streams', async () => {
    const content = '[Paper](https://example.com/paper) summary'
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={content} sessionLinks isAnimating />)
    )
    const link = container.querySelector<HTMLAnchorElement>('a[data-session-message-link]')!
    const favicon = link.querySelector('img')!
    expect(favicon).not.toBeNull()
    await act(async () => {
      fireEvent.load(favicon)
      fireEvent.focus(link)
    })
    expect(document.querySelector('[data-source-preview-hover-card]')).not.toBeNull()
    for (let index = 1; index <= 10; index++) {
      await act(async () =>
        root.render(
          <PresentedAgentMarkdown content={content + '.'.repeat(index)} sessionLinks isAnimating />
        )
      )
    }
    expect(container.querySelector('a[data-session-message-link]')).toBe(link)
    expect(link.querySelector('img')).toBe(favicon)
    expect(link.querySelector('[data-session-link-favicon]')?.getAttribute('data-state')).toBe(
      'success'
    )
    expect(document.querySelector('[data-source-preview-hover-card]')).not.toBeNull()
  })
})

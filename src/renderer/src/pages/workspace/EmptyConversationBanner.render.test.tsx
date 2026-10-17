// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'

import { EmptyConversationBanner } from './EmptyConversationBanner'

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
})

describe('EmptyConversationBanner', () => {
  it('renders the centered placeholder copy with a decorative flask mark', () => {
    const html = renderToStaticMarkup(<EmptyConversationBanner />)

    expect(html).toContain('data-testid="empty-conversation-banner"')
    expect(html).toContain('What will you research in Open-Science?')
    expect(html).toContain('Attach data or papers, then describe what you want to find out.')
    // The dotted flask is decorative; the heading and description carry meaning.
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('<h2')
    expect(html).toContain('class="size-28 text-text-300 opacity-40 md:size-32 dark:opacity-80"')
    expect(html).toContain('class="text-balance text-lg font-normal text-text-000 md:text-xl"')
    expect(html).toContain('class="text-xs text-text-100"')
  })

  it('renders the session-package entry row when import is available', () => {
    vi.stubGlobal('api', { sessions: { importPackage: vi.fn() } })

    const html = renderToStaticMarkup(
      <EmptyConversationBanner sessionImport={{ projectId: 'project-1', canImport: true }} />
    )

    expect(html).toContain('data-testid="session-package-entry"')
    expect(html).toContain('Import previous research')
    expect(html).toContain('Drag a .science research package onto this page, or choose a file')
    expect(html).toContain('class="mt-0.5 block text-xs text-text-100"')
    expect(html).toContain('aria-label="What is a .science research package?"')
    expect(html).toContain('aria-label="Choose a .science file"')
    expect(html).toContain('accept=".science"')
  })

  it('identifies an original record with no messages without a loading-like decoration', () => {
    vi.stubGlobal('api', { sessions: { importPackage: vi.fn() } })

    const html = renderToStaticMarkup(
      <EmptyConversationBanner
        researchTitle="Tuanzi research"
        researchRecord
        onStartResearch={vi.fn()}
        sessionImport={{ projectId: 'project-1', canImport: true }}
      />
    )

    expect(html).toContain('No conversation history')
    expect(html).toContain('Review the research materials or ask a question below.')
    expect(html).not.toContain('Tuanzi research')
    expect(html).not.toContain('Discussing')
    expect(html).not.toContain('original research stays unchanged')
    expect(html).not.toContain('<svg')
    expect(html).toContain('overflow-y-auto')
    expect(html).not.toContain('top-[42%]')
    expect(html).toContain('Summarize research')
    expect(html).toContain('Examine the evidence')
    expect(html).toContain('Identify limitations')
    expect(html).not.toContain('Analyze data')
    expect(html).not.toContain('Compare papers')
    expect(html).not.toContain('data-testid="session-package-entry"')
  })

  it('invites a question for a new research discussion without claiming history is missing', () => {
    const html = renderToStaticMarkup(<EmptyConversationBanner researchTitle="Research" />)
    expect(html).toContain('Ask about this research')
    expect(html).toContain('Review the research materials or ask a question below.')
    expect(html).not.toContain('No conversation history')
    expect(html).not.toContain('Discussing')
    expect(html).not.toContain('<svg')
  })

  it('omits the entry row without import props or when the Project cannot import', () => {
    vi.stubGlobal('api', { sessions: { importPackage: vi.fn() } })

    expect(renderToStaticMarkup(<EmptyConversationBanner />)).not.toContain(
      'data-testid="session-package-entry"'
    )
    expect(
      renderToStaticMarkup(
        <EmptyConversationBanner sessionImport={{ projectId: 'project-1', canImport: false }} />
      )
    ).not.toContain('data-testid="session-package-entry"')
    expect(
      renderToStaticMarkup(
        <EmptyConversationBanner sessionImport={{ projectId: '', canImport: true }} />
      )
    ).not.toContain('data-testid="session-package-entry"')
  })

  it('omits the entry row when desktop package import is unavailable', () => {
    // No window.api.sessions.importPackage bridge.
    expect(
      renderToStaticMarkup(
        <EmptyConversationBanner sessionImport={{ projectId: 'project-1', canImport: true }} />
      )
    ).not.toContain('data-testid="session-package-entry"')

    // Web surface never advertises desktop import.
    vi.stubGlobal('api', { sessions: { importPackage: vi.fn() } })
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    expect(
      renderToStaticMarkup(
        <EmptyConversationBanner sessionImport={{ projectId: 'project-1', canImport: true }} />
      )
    ).not.toContain('data-testid="session-package-entry"')
  })
})

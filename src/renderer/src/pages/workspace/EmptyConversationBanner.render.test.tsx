import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EmptyConversationBanner } from './EmptyConversationBanner'

describe('EmptyConversationBanner', () => {
  it('renders the centered placeholder copy with a decorative flask mark', () => {
    const html = renderToStaticMarkup(<EmptyConversationBanner />)

    expect(html).toContain('data-testid="empty-conversation-banner"')
    expect(html).toContain('What will you research in Open Science?')
    expect(html).toContain('Discover, share, and collaborate on research that matters')
    // The dotted flask is decorative; the heading and description carry meaning.
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('<h2')
    expect(html).toContain('class="size-28 text-text-300 opacity-40 md:size-32 dark:opacity-80"')
    expect(html).toContain('class="text-balance text-lg font-normal text-text-000 md:text-xl"')
    expect(html).toContain('class="text-xs text-text-100"')
  })
})

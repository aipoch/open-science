import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EmptyConversationBanner } from './EmptyConversationBanner'

describe('EmptyConversationBanner', () => {
  it('renders the centered placeholder copy with a decorative flask mark', () => {
    const html = renderToStaticMarkup(<EmptyConversationBanner />)

    expect(html).toContain('data-testid="empty-conversation-banner"')
    expect(html).toContain('What will you research in Open Science?')
    expect(html).toContain('Discover, share, and collaborate on research that matters')
    // The dotted flask is decorative; only the heading carries meaning.
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('<h2')
  })
})

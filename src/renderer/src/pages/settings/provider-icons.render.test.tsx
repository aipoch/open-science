import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ProviderKindIcon } from './provider-icons'

describe('ProviderKindIcon', () => {
  it.each(['official:opencode-go', 'official:opencode'])(
    'reuses the OpenCode logo for %s',
    (kindKey) => {
      const html = renderToStaticMarkup(<ProviderKindIcon kindKey={kindKey} />)

      expect(html).toContain('<svg')
      expect(html).toContain('text-foreground')
      expect(html).not.toContain('text-muted-foreground')
    }
  )
})

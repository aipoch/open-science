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

  it.each(['official:tencent', 'official:tencentcodingplan', 'official:tencenttokenplan'])(
    'renders the Tencent Cloud provider logo for %s',
    (kindKey) => {
      const html = renderToStaticMarkup(<ProviderKindIcon kindKey={kindKey} />)

      expect(html).toContain('<svg')
      expect(html).toContain('<title>TencentCloud</title>')
      expect(html).toContain('#006EFF')
      expect(html).not.toContain('text-muted-foreground')
    }
  )

  it('renders the NVIDIA provider logo', () => {
    const html = renderToStaticMarkup(<ProviderKindIcon kindKey="official:nvidia" />)

    expect(html).toContain('<svg')
    expect(html).toContain('<title>Nvidia</title>')
    expect(html).toContain('#74B71B')
    expect(html).not.toContain('text-muted-foreground')
  })
})

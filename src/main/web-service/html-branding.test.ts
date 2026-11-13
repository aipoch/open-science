import { describe, expect, it } from 'vitest'

import { brandHtmlPreviewDocument } from './html-branding'

describe('brandHtmlPreviewDocument', () => {
  it('prefixes the existing title and adds the Open-Science favicon', () => {
    const branded = brandHtmlPreviewDocument(
      '<!doctype html><html><head><title>Immersive · 效果丰富单页</title></head><body></body></html>',
      { logoSvg: '<svg viewBox="0 0 1 1"><path /></svg>' }
    )

    expect(branded).toContain('<title>Open-Science | Immersive · 效果丰富单页</title>')
    expect(branded).toContain('data-open-science-favicon="true"')
    expect(branded).toContain('data:image/svg+xml,')
  })

  it('adds a branded fallback title when the document has no title', () => {
    const branded = brandHtmlPreviewDocument('<html><head></head><body></body></html>', {
      logoSvg: '<svg />'
    })

    expect(branded).toContain('<title>Open-Science | HTML Preview</title>')
  })

  it('does not duplicate branding when applied twice', () => {
    const once = brandHtmlPreviewDocument('<html><head><title>Report</title></head></html>', {
      logoSvg: '<svg />'
    })

    expect(brandHtmlPreviewDocument(once, { logoSvg: '<svg />' })).toBe(once)
  })
})

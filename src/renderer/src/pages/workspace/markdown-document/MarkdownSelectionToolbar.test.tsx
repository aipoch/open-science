import { describe, expect, it } from 'vitest'

import { isSafeUrl } from './markdown-selection-toolbar-utils'

describe('MarkdownSelectionToolbar URL validation', () => {
  it('accepts web and mail links', () => {
    expect(isSafeUrl('https://example.com/article')).toBe(true)
    expect(isSafeUrl('/local/article')).toBe(true)
    expect(isSafeUrl('mailto:review@example.com')).toBe(true)
  })

  it('rejects executable and malformed links', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeUrl('not a url')).toBe(false)
    expect(isSafeUrl('')).toBe(false)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const highlight = vi.fn()
const supportsLanguage = vi.fn(() => true)

vi.mock('./code-highlighter-runtime', () => ({
  code: {
    name: 'shiki',
    type: 'code-highlighter',
    highlight,
    supportsLanguage,
    getSupportedLanguages: () => ['mermaid'],
    getThemes: () => ['github-light', 'github-light']
  }
}))

import type { HighlightResult } from '@streamdown/code'

import { highlightMermaidSource, LINE_CLASS, tokensToHtml } from './mermaid-source-highlight'

const tokensResult = (content: string): HighlightResult => ({
  tokens: [[{ content, color: '#0550ae', fontStyle: 0, offset: 0 }]],
  fg: '#1f2328',
  bg: '#ffffff'
})

const lineSpan = (inner: string): string => `<span class="${LINE_CLASS}">${inner}</span>`
const tokenSpan = (content: string, color?: string): string =>
  `<span class="text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]"${
    color ? ` style="--sdm-c:${color}"` : ''
  }>${content}</span>`

beforeEach(() => {
  highlight.mockReset()
  supportsLanguage.mockReset().mockReturnValue(true)
})

describe('highlightMermaidSource', () => {
  it('delivers line-numbered token html for supported mermaid source', async () => {
    highlight.mockReturnValue(tokensResult('graph'))
    const apply = vi.fn()

    highlightMermaidSource('graph TD; highlight-sync', apply)
    await vi.waitFor(() => expect(apply).toHaveBeenCalled())

    expect(apply).toHaveBeenCalledWith({
      html: lineSpan(tokenSpan('graph', '#0550ae')),
      bg: '#ffffff',
      fg: '#1f2328'
    })
    expect(highlight).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'graph TD; highlight-sync', language: 'mermaid' }),
      expect.any(Function)
    )
  })

  it('delivers asynchronously when the highlighter is still warming up', async () => {
    highlight.mockImplementation((_options, callback) => {
      queueMicrotask(() => callback(tokensResult('async')))
      return null
    })
    const apply = vi.fn()

    highlightMermaidSource('graph TD; highlight-async', apply)
    await vi.waitFor(() =>
      expect(apply).toHaveBeenCalledWith(expect.objectContaining({ bg: '#ffffff' }))
    )
  })

  it('serves repeat requests from the cache without re-highlighting', async () => {
    highlight.mockReturnValue(tokensResult('cached'))
    const first = vi.fn()
    const second = vi.fn()

    highlightMermaidSource('graph TD; highlight-cache', first)
    await vi.waitFor(() => expect(first).toHaveBeenCalled())
    highlightMermaidSource('graph TD; highlight-cache', second)

    expect(second).toHaveBeenCalledWith({
      html: lineSpan(tokenSpan('cached', '#0550ae')),
      bg: '#ffffff',
      fg: '#1f2328'
    })
    expect(highlight).toHaveBeenCalledTimes(1)
  })

  it('never delivers when the grammar is unsupported', async () => {
    supportsLanguage.mockReturnValue(false)
    const apply = vi.fn()

    highlightMermaidSource('graph TD; unsupported', apply)
    await Promise.resolve()
    await Promise.resolve()

    expect(apply).not.toHaveBeenCalled()
    expect(highlight).not.toHaveBeenCalled()
  })
})

describe('tokensToHtml', () => {
  it('escapes markup in token content', () => {
    const html = tokensToHtml({
      tokens: [[{ content: 'A-->"<b>" & <C>', offset: 0 }]],
      fg: '#1f2328',
      bg: '#ffffff'
    })
    expect(html).toBe(lineSpan(tokenSpan('A--&gt;"&lt;b&gt;" &amp; &lt;C&gt;')))
  })

  it('colors tokens through --sdm-c and ignores fontStyle, like streamdown', () => {
    const html = tokensToHtml({
      tokens: [
        [
          { content: 'kw', color: '#cf222e', fontStyle: 1, offset: 0 },
          { content: 'name', fontStyle: 2, offset: 2 }
        ]
      ],
      fg: '#1f2328',
      bg: '#ffffff'
    })
    expect(html).toBe(lineSpan(tokenSpan('kw', '#cf222e') + tokenSpan('name')))
    expect(html).not.toContain('italic')
  })

  it('wraps each source line in a gutter line span', () => {
    const html = tokensToHtml({
      tokens: [[{ content: 'one', offset: 0 }], [{ content: 'two', offset: 4 }]],
      fg: '#1f2328',
      bg: '#ffffff'
    })
    expect(html).toBe(lineSpan(tokenSpan('one')) + lineSpan(tokenSpan('two')))
    expect(html).toContain('counter(line)')
  })
})

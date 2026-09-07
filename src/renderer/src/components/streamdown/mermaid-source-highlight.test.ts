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

import { highlightMermaidSource, tokensToHtml } from './mermaid-source-highlight'

const tokensResult = (content: string): HighlightResult => ({
  tokens: [[{ content, color: '#0550ae', fontStyle: 0, offset: 0 }]],
  fg: '#1f2328',
  bg: '#ffffff'
})

beforeEach(() => {
  highlight.mockReset()
  supportsLanguage.mockReset().mockReturnValue(true)
})

describe('highlightMermaidSource', () => {
  it('delivers token html for supported mermaid source', async () => {
    highlight.mockReturnValue(tokensResult('graph'))
    const apply = vi.fn()

    highlightMermaidSource('graph TD; highlight-sync', apply)
    await vi.waitFor(() => expect(apply).toHaveBeenCalled())

    expect(apply).toHaveBeenCalledWith('<span style="color:#0550ae">graph</span>')
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
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(expect.stringContaining('async')))
  })

  it('serves repeat requests from the cache without re-highlighting', async () => {
    highlight.mockReturnValue(tokensResult('cached'))
    const first = vi.fn()
    const second = vi.fn()

    highlightMermaidSource('graph TD; highlight-cache', first)
    await vi.waitFor(() => expect(first).toHaveBeenCalled())
    highlightMermaidSource('graph TD; highlight-cache', second)

    expect(second).toHaveBeenCalledWith('<span style="color:#0550ae">cached</span>')
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
    expect(html).toBe('<span>A--&gt;"&lt;b&gt;" &amp; &lt;C&gt;</span>')
  })

  it('emits italic and bold styles from the font style bitmask', () => {
    const html = tokensToHtml({
      tokens: [
        [
          { content: 'kw', color: '#cf222e', fontStyle: 1, offset: 0 },
          { content: 'name', color: '#953800', fontStyle: 2, offset: 2 }
        ]
      ],
      fg: '#1f2328',
      bg: '#ffffff'
    })
    expect(html).toBe(
      '<span style="color:#cf222e;font-style:italic">kw</span>' +
        '<span style="color:#953800;font-weight:600">name</span>'
    )
  })

  it('joins lines with newlines', () => {
    const html = tokensToHtml({
      tokens: [[{ content: 'one', offset: 0 }], [{ content: 'two', offset: 4 }]],
      fg: '#1f2328',
      bg: '#ffffff'
    })
    expect(html).toBe('<span>one</span>\n<span>two</span>')
  })
})

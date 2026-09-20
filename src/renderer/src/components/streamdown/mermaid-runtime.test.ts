// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { PresentedAgentMarkdown } from './AgentMarkdown'

vi.mock('@streamdown/mermaid', () => {
  const render = vi.fn(async (id: string) => ({
    svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"></svg>`
  }))
  const instance = { initialize: vi.fn(), render }
  const upstreamPlugin = {
    name: 'mermaid' as const,
    type: 'diagram' as const,
    language: 'mermaid',
    getMermaid: vi.fn(() => instance)
  }
  return {
    createMermaidPlugin: vi.fn(() => upstreamPlugin),
    mermaid: upstreamPlugin,
    __instance: instance
  }
})

import { mermaid } from './mermaid-runtime'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const instance = ((await import('@streamdown/mermaid')) as any).__instance as {
  render: ReturnType<typeof vi.fn>
}
import {
  getMermaidSource,
  MERMAID_RENDER_ID_ATTRIBUTE,
  rememberMermaidSource
} from './mermaid-source-registry'

beforeEach(() => {
  instance.render.mockClear()
})

describe('mermaid source-tracking plugin', () => {
  it('keeps the upstream plugin identity fields', () => {
    expect(mermaid.name).toBe('mermaid')
    expect(mermaid.type).toBe('diagram')
    expect(mermaid.language).toBe('mermaid')
  })

  it('records the source by render id and stamps the id onto the svg', async () => {
    const api = mermaid.getMermaid({ theme: 'default' })

    const result = await api.render('mermaid-1-test', 'graph TD; A-->B')

    expect(getMermaidSource('mermaid-1-test')).toBe('graph TD; A-->B')
    expect(result.svg).toContain(`${MERMAID_RENDER_ID_ATTRIBUTE}="mermaid-1-test"`)
    expect(result.svg).toContain('<svg')
  })

  it('remembers the source even when rendering fails', async () => {
    instance.render.mockRejectedValueOnce(new Error('parse error'))
    const api = mermaid.getMermaid()

    await expect(api.render('mermaid-2-test', 'not a diagram')).rejects.toThrow('parse error')
    expect(getMermaidSource('mermaid-2-test')).toBe('not a diagram')
  })
})

describe('mermaid source registry', () => {
  it('evicts the oldest entries beyond the cap', () => {
    for (let index = 0; index < 120; index += 1) {
      rememberMermaidSource(`evict-${index}`, `source ${index}`)
    }

    expect(getMermaidSource('evict-0')).toBeUndefined()
    expect(getMermaidSource('evict-119')).toBe('source 119')
  })

  it('re-remembering an id refreshes its recency', () => {
    rememberMermaidSource('keep', 'first')
    for (let index = 0; index < 100; index += 1) {
      rememberMermaidSource(`filler-${index}`, `filler ${index}`)
    }
    rememberMermaidSource('keep', 'second')
    for (let index = 0; index < 20; index += 1) {
      rememberMermaidSource(`tail-${index}`, `tail ${index}`)
    }

    expect(getMermaidSource('keep')).toBe('second')
  })
})

describe('completed Mermaid blocks during streaming', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the rendered diagram when later paragraphs stream and when the message finishes', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(target: Element): void {
          queueMicrotask(() =>
            this.callback(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            )
          )
        }
        disconnect(): void {
          /* This fixture delivers one observation only. */
        }
        unobserve(): void {
          /* No ongoing observation is retained. */
        }
        takeRecords(): IntersectionObserverEntry[] {
          return []
        }
      }
    )
    const chart = '```mermaid\ngraph TD; A-->B\n```\n\nTail'
    const view = render(
      createElement(PresentedAgentMarkdown, { content: chart, isAnimating: true })
    )
    await waitFor(() =>
      expect(view.container.querySelector('svg[data-mermaid-render-id]')).not.toBeNull()
    )
    const svg = view.container.querySelector('svg[data-mermaid-render-id]')
    const initialCalls = instance.render.mock.calls.length
    expect(initialCalls).toBeGreaterThan(0)
    for (let index = 1; index <= 20; index++) {
      view.rerender(
        createElement(PresentedAgentMarkdown, {
          content: chart + '.'.repeat(index),
          isAnimating: true
        })
      )
      expect(view.container.querySelector('svg[data-mermaid-render-id]'), `append ${index}`).toBe(
        svg
      )
    }
    view.rerender(createElement(PresentedAgentMarkdown, { content: chart + '.'.repeat(20) }))
    expect(view.container.textContent).toContain('Tail' + '.'.repeat(20))
    expect(view.container.querySelector('svg[data-mermaid-render-id]')).toBe(svg)
    expect(instance.render).toHaveBeenCalledTimes(initialCalls)
  })
})

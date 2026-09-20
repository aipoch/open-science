// @vitest-environment jsdom
import { act } from 'react'
import { waitFor } from '@testing-library/react'
import { Lexer } from 'marked'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentMarkdown, PresentedAgentMarkdown } from './AgentMarkdown'

const { renderMermaid } = vi.hoisted(() => ({
  renderMermaid: vi.fn(async (id: string) => ({
    svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"></svg>`
  }))
}))

vi.mock('@streamdown/mermaid', () => {
  const instance = { initialize: vi.fn(), render: renderMermaid }
  const plugin = {
    name: 'mermaid' as const,
    type: 'diagram' as const,
    language: 'mermaid',
    getMermaid: vi.fn(() => instance)
  }
  return { createMermaidPlugin: vi.fn(() => plugin), mermaid: plugin }
})

describe('AgentMarkdown streaming presentation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('keeps the rendered Mermaid diagram when later paragraphs stream and the message finishes', async () => {
    vi.useRealTimers()
    renderMermaid.mockClear()
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
    await act(async () => root.render(<PresentedAgentMarkdown content={chart} isAnimating />))
    await waitFor(() =>
      expect(container.querySelector('svg[data-mermaid-render-id]')).not.toBeNull()
    )
    const svg = container.querySelector('svg[data-mermaid-render-id]')
    const initialCalls = renderMermaid.mock.calls.length
    expect(initialCalls).toBeGreaterThan(0)
    for (let index = 1; index <= 20; index++) {
      await act(async () =>
        root.render(<PresentedAgentMarkdown content={chart + '.'.repeat(index)} isAnimating />)
      )
      expect(container.querySelector('svg[data-mermaid-render-id]'), `append ${index}`).toBe(svg)
    }
    await act(async () => root.render(<PresentedAgentMarkdown content={chart + '.'.repeat(20)} />))
    expect(container.textContent).toContain('Tail' + '.'.repeat(20))
    expect(container.querySelector('svg[data-mermaid-render-id]')).toBe(svg)
    expect(renderMermaid).toHaveBeenCalledTimes(initialCalls)
  })

  it('renders fenced alert examples as their original source text', async () => {
    vi.useRealTimers()
    const literal = '> [!NOTE]\n> This is literal example source.'
    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'```markdown\n' + literal + '\n```'} />)
    })
    // Highlighted lines are separate elements, so textContent may omit their visual line breaks.
    await vi.waitFor(() =>
      expect(container.querySelector('pre')?.textContent?.replace(/\n/g, '')).toBe(
        literal.replace(/\n/g, '')
      )
    )
    expect(container.querySelector('pre')?.textContent).not.toContain('<aside')
  })

  it('continues painting while target content grows faster than animation frames', async () => {
    await act(async () => {
      root.render(<AgentMarkdown content="流" isAnimating />)
    })

    for (let length = 2; length <= 70; length += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(8))
      await act(async () => {
        root.render(<AgentMarkdown content={'流'.repeat(length)} isAnimating />)
      })
    }

    const visible = container.querySelector('.agent-markdown')?.textContent ?? ''
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(70)
  })

  it('does not re-split the completed prefix when only the streaming tail changes', async () => {
    vi.useRealTimers()
    const prefix =
      Array.from(
        { length: 100 },
        (_, index) => `Completed paragraph ${index}. ${'Scientific prose. '.repeat(8)}`
      ).join('\n\n') + '\n\n'
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={prefix + 'Live text'} isAnimating />)
    )
    const firstParagraph = container.querySelector('p')
    const lexer = vi.spyOn(Lexer.prototype, 'blockTokens')
    const parse = vi.spyOn(Object.getPrototypeOf(unified) as typeof unified, 'parse')
    try {
      for (let count = 1; count <= 20; count++) {
        await act(async () =>
          root.render(
            <PresentedAgentMarkdown
              content={prefix + 'Live text' + ' continuation'.repeat(count)}
              isAnimating
            />
          )
        )
      }
      expect(container.textContent).toContain('Live text' + ' continuation'.repeat(20))
      expect(container.querySelector('p')).toBe(firstParagraph)
      expect(parse.mock.calls.length).toBeGreaterThan(0)
      expect(
        parse.mock.calls.some(([source]) => String(source).includes('Completed paragraph 0.'))
      ).toBe(false)
      expect(lexer.mock.calls.length).toBeGreaterThan(0)
      expect(lexer.mock.calls.some(([source]) => source.includes('Completed paragraph 0.'))).toBe(
        false
      )
    } finally {
      lexer.mockRestore()
      parse.mockRestore()
    }
  })

  it('keeps completed Markdown blocks mounted when streaming settles', async () => {
    vi.useRealTimers()

    const content = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index + 1} with **formatted content**.`
    ).join('\n\n')

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={content} isAnimating />)
    })

    const firstParagraph = container.querySelector('p')
    expect(firstParagraph).not.toBeNull()

    const createElement = document.createElement.bind(document) as typeof document.createElement
    let createdParagraphs = 0
    vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions
    ) => {
      if (tagName === 'p') {
        createdParagraphs += 1
      }
      return createElement(tagName, options)
    }) as typeof document.createElement)

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={content} />)
    })

    expect(createdParagraphs).toBe(0)
    expect(container.querySelector('p')).toBe(firstParagraph)
  })

  it('renders the allowed session artifact image element through a supplied component', async () => {
    vi.useRealTimers()
    const ArtifactImage = ({
      artifact_ref: artifactRef
    }: Record<string, unknown>): React.JSX.Element => (
      <button data-testid="artifact-image">
        {typeof artifactRef === 'string' ? artifactRef : null}
      </button>
    )

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown
          content={'<session-artifact-image artifact_ref="version-1"></session-artifact-image>'}
          components={{ 'session-artifact-image': ArtifactImage }}
        />
      )
    })

    expect(container.querySelector('[data-testid="artifact-image"]')?.textContent).toBe('version-1')
  })

  it('passes a normalized artifact target to a supplied link component', async () => {
    vi.useRealTimers()
    const Link = ({ href }: React.ComponentProps<'a'> & { node?: unknown }): React.JSX.Element => (
      <button data-testid="managed-file-link">{href}</button>
    )

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown
          content="[report](/.open-science/artifact/version-1)"
          components={{ a: Link }}
        />
      )
    })

    expect(container.querySelector('[data-testid="managed-file-link"]')?.textContent).toBe(
      '/.open-science/artifact/version-1'
    )
  })

  it('hides an unclosed trailing blockquote while streaming, without CSS :has()', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'Intro paragraph\n\n>'} isAnimating />)
    })

    const quote = container.querySelector('blockquote')
    expect(quote).not.toBeNull()
    expect(quote?.textContent?.trim()).toBe('')
    expect(quote?.className).toContain('hidden')
  })

  it('shows only the blockquotes that have paragraph content while streaming', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'> quoted text\n\n>'} isAnimating />)
    })

    const quotes = container.querySelectorAll('blockquote')
    expect(quotes).toHaveLength(2)
    expect(quotes[0].className).not.toContain('hidden')
    expect(quotes[0].textContent).toContain('quoted text')
    expect(quotes[1].className).toContain('hidden')
  })

  it('keeps nested blockquotes visible when an inner paragraph has text', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'> > nested text'} isAnimating />)
    })

    const quotes = container.querySelectorAll('blockquote')
    expect(quotes.length).toBeGreaterThan(0)
    for (const quote of quotes) {
      expect(quote.className).not.toContain('hidden')
    }
  })

  it('hides an image-only blockquote while streaming, matching the old :has(p) rule', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown content="> ![alt](https://example.com/x.png)" isAnimating />
      )
    })

    const quote = container.querySelector('blockquote')
    expect(quote).not.toBeNull()
    // Streamdown's paragraph unwraps the lone image, so no <p> reaches the DOM — the old
    // blockquote:not(:has(p:not(:empty))) selector hid this quote too.
    expect(quote?.querySelector('p')).toBeNull()
    expect(quote?.className).toContain('hidden')
  })

  it('shows the same empty blockquote once streaming settles', async () => {
    vi.useRealTimers()

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'Intro paragraph\n\n>'} isAnimating />)
    })
    expect(container.querySelector('blockquote')?.className).toContain('hidden')

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'Intro paragraph\n\n>'} />)
    })

    const quote = container.querySelector('blockquote')
    expect(quote).not.toBeNull()
    expect(quote?.className).not.toContain('hidden')
  })

  it('keeps a supplied blockquote component in charge of chrome while toggling hidden', async () => {
    vi.useRealTimers()
    const CustomQuote = ({
      children,
      className
    }: React.ComponentProps<'blockquote'> & { node?: unknown }): React.JSX.Element => (
      <aside className={className} data-testid="custom-quote">
        {children}
      </aside>
    )

    await act(async () => {
      root.render(
        <PresentedAgentMarkdown
          content={'> visible text\n\n>'}
          components={{ blockquote: CustomQuote }}
          isAnimating
        />
      )
    })

    const quotes = container.querySelectorAll('[data-testid="custom-quote"]')
    expect(quotes).toHaveLength(2)
    expect(quotes[0].className).not.toContain('hidden')
    expect(quotes[1].className).toContain('hidden')
  })
})

describe('cost-aware Markdown parsing', () => {
  let clock = 0
  let parseCost = 20

  const workers: FakeWorker[] = []
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    messages: { id: number; source: string }[] = []
    terminated = false
    constructor() {
      workers.push(this)
    }
    postMessage(message: { id: number; source: string }): void {
      this.messages.push(message)
    }
    complete(index = this.messages.length - 1): void {
      const { id, source } = this.messages[index]!
      this.onmessage?.({
        data: {
          id,
          bytes: source.length * 4,
          tree: unified().use(remarkParse).parse(source)
        }
      } as MessageEvent)
    }
    terminate(): void {
      this.terminated = true
    }
  }
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    clock = 0
    parseCost = 20
    workers.length = 0
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('Worker', FakeWorker)
    vi.spyOn(performance, 'now').mockImplementation(() => {
      clock += parseCost
      return clock
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('prepares the parser before expensive output without pausing text while it starts', async () => {
    parseCost = 0
    await act(async () => root.render(<PresentedAgentMarkdown content="Starting" isAnimating />))
    expect(workers).toHaveLength(1)
    expect(workers[0]!.messages[0]!.source).toBe('')
    parseCost = 20
    const first = 'Scientific prose. '.repeat(2000)
    await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'latest'} isAnimating />)
    )
    expect(container.textContent).toBe(first + 'latest')
    expect(workers[0]!.messages).toHaveLength(1)
    await act(async () => workers[0]!.complete())
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'latest append'} isAnimating />)
    )
    expect(workers[0]!.messages.at(-1)!.source).toBe(first + 'latest append')
    await act(async () => workers[0]!.complete())
    expect(container.textContent).toBe(first + 'latest append')
  })

  const finishWarmup = async (): Promise<void> => {
    expect(workers[0]!.messages[0]!.source).toBe('')
    await act(async () => workers[0]!.complete(0))
    // Work-count assertions below concern streamed parsing after initialization.
    workers[0]!.messages.length = 0
  }

  it('moves subsequent costly streaming parses off the main thread', async () => {
    const first = 'Scientific prose. '.repeat(2000)
    await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
    await finishWarmup()
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'More text.'} isAnimating />)
    )
    expect(workers).toHaveLength(1)
    expect(workers[0]!.messages.at(-1)?.source).toContain('More text.')
  })

  it('coalesces pending text, keeps making progress, and renders the latest complete snapshot', async () => {
    const first = 'Scientific prose. '.repeat(2000)
    await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
    await finishWarmup()
    for (const tail of ['one', 'one two', 'one two three']) {
      await act(async () =>
        root.render(<PresentedAgentMarkdown content={first + tail} isAnimating />)
      )
    }
    const worker = workers[0]!
    expect(worker.messages).toHaveLength(1)
    await act(async () => worker.complete(0))
    expect(container.textContent).toContain('one')
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]!.source).toBe(first + 'one two three')
    await act(async () => worker.complete(1))
    expect(container.textContent).toBe(first + 'one two three')
  })

  it('flushes terminal text synchronously and ignores a late Worker result', async () => {
    const first = 'Scientific prose. '.repeat(2000)
    await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
    await finishWarmup()
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'pending'} isAnimating />)
    )
    const worker = workers[0]!
    await act(async () => root.render(<PresentedAgentMarkdown content={first + 'final'} />))
    expect(container.textContent).toBe(first + 'final')
    expect(worker.terminated).toBe(true)
    await act(async () => worker.complete())
    expect(container.textContent).toBe(first + 'final')
  })

  it('discards pending branch text on replacement and releases the Worker on unmount', async () => {
    const first = 'Scientific prose. '.repeat(2000)
    await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
    await finishWarmup()
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'pending'} isAnimating />)
    )
    const worker = workers[0]!
    await act(async () =>
      root.render(<PresentedAgentMarkdown content="A different branch" isAnimating />)
    )
    expect(worker.terminated).toBe(false)
    await act(async () => worker.complete())
    expect(container.textContent).toBe('A different branch')
    await act(async () =>
      root.render(<PresentedAgentMarkdown content="A different branch continues" isAnimating />)
    )
    expect(workers).toHaveLength(1)
    await act(async () => root.render(null))
    expect(worker.terminated).toBe(true)
  })

  it('falls back to full current text when the Worker fails without retrying every update', async () => {
    const first = 'Scientific prose. '.repeat(2000)
    await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
    await finishWarmup()
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'pending'} isAnimating />)
    )
    const worker = workers[0]!
    await act(async () => worker.onerror?.(new ErrorEvent('error')))
    expect(container.textContent).toBe(first + 'pending')
    await act(async () =>
      root.render(<PresentedAgentMarkdown content={first + 'pending more'} isAnimating />)
    )
    expect(container.textContent).toBe(first + 'pending more')
    expect(workers).toHaveLength(1)
  })

  it('leaves inexpensive streaming synchronous', async () => {
    parseCost = 0
    await act(async () => root.render(<PresentedAgentMarkdown content="Short text" isAnimating />))
    await act(async () =>
      root.render(<PresentedAgentMarkdown content="Short text continues" isAnimating />)
    )
    expect(container.textContent).toBe('Short text continues')
    expect(workers).toHaveLength(1)
    expect(workers[0]!.messages.map((message) => message.source)).toEqual([''])
  })

  it('keeps rendering when parser initialization times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await act(async () =>
        root.render(<PresentedAgentMarkdown content="Initial text" isAnimating />)
      )
      await act(async () =>
        root.render(<PresentedAgentMarkdown content="Initial text grows" isAnimating />)
      )
      expect(container.textContent).toBe('Initial text grows')
      await act(async () => vi.advanceTimersByTime(5001))
      await act(async () =>
        root.render(<PresentedAgentMarkdown content="Initial text grows again" isAnimating />)
      )
      expect(container.textContent).toBe('Initial text grows again')
      expect(workers).toHaveLength(1)
      expect(workers[0]!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers from a Worker that never replies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const first = 'Scientific prose. '.repeat(2000)
      await act(async () => root.render(<PresentedAgentMarkdown content={first} isAnimating />))
      await finishWarmup()
      await act(async () =>
        root.render(<PresentedAgentMarkdown content={first + 'pending'} isAnimating />)
      )
      await act(async () => vi.advanceTimersByTime(5001))
      expect(container.textContent).toBe(first + 'pending')
      expect(workers[0]!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares one Worker across blocks and keeps a surviving owner after another unmounts', async () => {
    const first = 'First response. '.repeat(2000)
    const second = 'Second response. '.repeat(2000)
    await act(async () =>
      root.render(
        <>
          <PresentedAgentMarkdown key="a" content={first} isAnimating />
          <PresentedAgentMarkdown key="b" content={second} isAnimating />
        </>
      )
    )
    await finishWarmup()
    await act(async () =>
      root.render(
        <>
          <PresentedAgentMarkdown key="a" content={first + 'pending A'} isAnimating />
          <PresentedAgentMarkdown key="b" content={second + 'pending B'} isAnimating />
        </>
      )
    )
    expect(workers).toHaveLength(1)
    const worker = workers[0]!
    expect(worker.messages).toHaveLength(1)
    await act(async () =>
      root.render(<PresentedAgentMarkdown key="b" content={second + 'pending B'} isAnimating />)
    )
    expect(worker.terminated).toBe(false)
    await act(async () => worker.complete(0))
    expect(worker.messages).toHaveLength(2)
    await act(async () => worker.complete(1))
    expect(container.textContent).toBe(second + 'pending B')
  })
})

// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const streamdownHarness = vi.hoisted(() => ({
  shouldThrow: true,
  codeImports: 0,
  mermaidImports: 0,
  disallowedElements: undefined as readonly string[] | undefined,
  components: undefined as Record<string, unknown> | undefined,
  plugins: undefined as Record<string, unknown> | undefined,
  shikiTheme: undefined as unknown,
  mermaidOptions: undefined as unknown,
  animated: undefined as unknown,
  caret: undefined as string | undefined,
  blockComponent: undefined as unknown
}))

vi.mock('./code-highlighter-runtime', () => {
  streamdownHarness.codeImports += 1
  return { code: { name: 'shiki' } }
})
vi.mock('@streamdown/cjk', () => ({ cjk: {} }))
vi.mock('@streamdown/math', () => ({ createMathPlugin: () => ({}) }))
vi.mock('./mermaid-runtime', () => {
  streamdownHarness.mermaidImports += 1
  return { mermaid: { name: 'mermaid' } }
})
vi.mock('streamdown', () => ({
  Streamdown: ({
    children,
    animated,
    caret,
    components,
    disallowedElements,
    BlockComponent,
    plugins,
    shikiTheme,
    mermaid
  }: PropsWithChildren<{
    animated?: unknown
    caret?: string
    components?: Record<string, unknown>
    disallowedElements?: readonly string[]
    BlockComponent?: unknown
    plugins?: Record<string, unknown>
    shikiTheme?: unknown
    mermaid?: unknown
  }>): React.JSX.Element => {
    if (streamdownHarness.shouldThrow) throw new Error('optimized Markdown chunk failed to load')
    streamdownHarness.components = components
    streamdownHarness.disallowedElements = disallowedElements
    streamdownHarness.animated = animated
    streamdownHarness.caret = caret
    streamdownHarness.blockComponent = BlockComponent
    streamdownHarness.plugins = plugins
    streamdownHarness.shikiTheme = shikiTheme
    streamdownHarness.mermaidOptions = mermaid

    return <div data-testid="rich-markdown">{children}</div>
  }
}))

const { AgentMarkdown, PresentedAgentMarkdown } = await import('./AgentMarkdown')
const { SessionMessageLink } = await import('./SessionMessageLink')
const { StreamingBlock } = await import('./StreamingBlock')

describe('AgentMarkdown renderer recovery', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    streamdownHarness.shouldThrow = true
    streamdownHarness.disallowedElements = undefined
    streamdownHarness.components = undefined
    streamdownHarness.plugins = undefined
    streamdownHarness.shikiTheme = undefined
    streamdownHarness.mermaidOptions = undefined
    streamdownHarness.animated = undefined
    streamdownHarness.caret = undefined
    streamdownHarness.blockComponent = undefined
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    container.remove()
  })

  it('does not request Mermaid or code highlighting for prose, lists, and tables', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(
        <AgentMarkdown
          content={'Plain text\n\n- list item\n\n| Name | Value |\n| --- | --- |\n| A | 1 |'}
        />
      )
    })

    expect(streamdownHarness.codeImports).toBe(0)
    expect(streamdownHarness.mermaidImports).toBe(0)
    expect(streamdownHarness.plugins?.code).toBeUndefined()
    expect(streamdownHarness.plugins?.mermaid).toBeUndefined()
    expect(streamdownHarness.shikiTheme).toBeUndefined()
    expect(streamdownHarness.mermaidOptions).toBeUndefined()
  })

  it('loads code highlighting and its themes only after a fence appears', async () => {
    streamdownHarness.shouldThrow = false
    const content = '```ts\nconst value = 1\n```'

    await act(async () => {
      root.render(<AgentMarkdown content={content} />)
    })

    expect(streamdownHarness.codeImports).toBe(1)
    expect(streamdownHarness.mermaidImports).toBe(0)
    expect(streamdownHarness.plugins?.code).toEqual({ name: 'shiki' })
    expect(streamdownHarness.shikiTheme).toEqual(['github-light', 'github-light'])
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe(content)
  })

  it('upgrades a streaming fence to Mermaid without dropping its readable source', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<PresentedAgentMarkdown content={'```mer'} isAnimating />)
    })

    expect(streamdownHarness.mermaidImports).toBe(0)
    expect(streamdownHarness.plugins?.mermaid).toBeUndefined()
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('```mer')

    const content = '```mermaid\ngraph TD\n  A --> B'
    await act(async () => {
      root.render(<PresentedAgentMarkdown content={content} isAnimating />)
    })

    expect(streamdownHarness.mermaidImports).toBe(1)
    expect(streamdownHarness.plugins?.mermaid).toEqual({ name: 'mermaid' })
    expect(streamdownHarness.mermaidOptions).toBeDefined()
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe(content)
  })

  it('keeps the original message and sibling UI visible when rich Markdown rendering fails', async () => {
    await act(async () => {
      root.render(
        <section>
          <span data-testid="workspace-sibling">Workspace controls</span>
          <AgentMarkdown content={'Original message\n```ts\nconst value = 1\n```'} />
        </section>
      )
    })

    expect(container.querySelector('[data-testid="workspace-sibling"]')?.textContent).toBe(
      'Workspace controls'
    )
    expect(container.querySelector('[data-agent-markdown-fallback]')?.textContent).toBe(
      'Original message\n```ts\nconst value = 1\n```'
    )
  })

  it('retries rich rendering when the message content changes after a failure', async () => {
    await act(async () => {
      root.render(<AgentMarkdown content="Initial message" />)
    })

    streamdownHarness.shouldThrow = false
    await act(async () => {
      root.render(<AgentMarkdown content="Recovered message" />)
    })

    expect(container.querySelector('[data-agent-markdown-fallback]')).toBeNull()
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe(
      'Recovered message'
    )
  })

  it('blocks network-fetching media elements when media is disabled', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="Untrusted preview" allowMedia={false} />)
    })

    expect(streamdownHarness.disallowedElements).toEqual(
      expect.arrayContaining(['img', 'video', 'audio', 'source', 'track', 'use'])
    )
  })

  it('opts into the session link renderer without changing default AgentMarkdown callers', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="Plain shared markdown" />)
    })
    expect(streamdownHarness.components).toBeUndefined()

    await act(async () => {
      root.render(<AgentMarkdown content="Session markdown" sessionLinks />)
    })
    expect(streamdownHarness.components?.a).toBe(SessionMessageLink)
  })

  it('lets a session surface override one renderer while retaining its other custom components', async () => {
    streamdownHarness.shouldThrow = false
    const ArtifactLink = (): React.JSX.Element => <span>Artifact link</span>
    const ArtifactImage = (): React.JSX.Element => <span>Artifact image</span>

    await act(async () => {
      root.render(
        <AgentMarkdown
          content="Session artifact"
          sessionLinks
          components={{ a: ArtifactLink, 'session-artifact-image': ArtifactImage }}
        />
      )
    })

    expect(streamdownHarness.components?.a).toBe(ArtifactLink)
    expect(streamdownHarness.components?.['session-artifact-image']).toBe(ArtifactImage)
  })

  it('defers highlighting of the trailing unclosed code fence via the streaming block', async () => {
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content={'```ts\nconst value = 1'} isAnimating />)
    })

    expect(streamdownHarness.blockComponent).toBe(StreamingBlock)
  })

  it('reveals a buffered segment across frames without any caret at the visible tail', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false
    const content = 'flow'.repeat(13)

    await act(async () => {
      root.render(<AgentMarkdown content={content} isAnimating />)
    })
    expect(streamdownHarness.caret).toBeUndefined()
    expect(streamdownHarness.animated).toBe(false)
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('')

    await act(async () => vi.advanceTimersByTimeAsync(512))
    const firstFrame = container.querySelector('[data-testid="rich-markdown"]')?.textContent ?? ''
    expect(firstFrame).toBe('f')

    for (let expectedLength = 2; expectedLength <= 12; expectedLength += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(16))
      expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent?.length).toBe(
        expectedLength
      )
    }

    await act(async () => vi.advanceTimersByTimeAsync(900))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe(content)

    await act(async () => {
      root.render(<AgentMarkdown content={content} />)
    })
    expect(streamdownHarness.caret).toBeUndefined()
  })

  it('drains a large backlog with catch-up frames instead of trailing seconds behind', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false
    const content = 'y'.repeat(3000)

    await act(async () => {
      root.render(<AgentMarkdown content={content} isAnimating />)
    })
    // Prebuffer, then the backlog (3000 > 600) drains at remaining/30 per frame.
    await act(async () => vi.advanceTimersByTimeAsync(512))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    // Without catch-up, ~94 frames at <=3 graphemes would reveal under 300 graphemes.
    expect(
      container.querySelector('[data-testid="rich-markdown"]')?.textContent?.length ?? 0
    ).toBeGreaterThan(2000)
  })

  it('keeps revealing while faster stream updates extend the target between frames', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="x" isAnimating />)
    })

    for (let length = 2; length <= 70; length += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(8))
      await act(async () => {
        root.render(<AgentMarkdown content={'x'.repeat(length)} isAnimating />)
      })
    }

    const visible = container.querySelector('[data-testid="rich-markdown"]')?.textContent ?? ''
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(70)
    expect(streamdownHarness.caret).toBeUndefined()
  })

  it('prebuffers a small segment instead of exposing source jitter directly', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content={'x'.repeat(12)} isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(480))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('')
    expect(streamdownHarness.caret).toBeUndefined()

    await act(async () => {
      root.render(<AgentMarkdown content={'x'.repeat(40)} isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(32))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('x')
  })

  it('starts a slow stream after the bounded prebuffer delay', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content={'x'.repeat(12)} isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(496))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('')

    await act(async () => vi.advanceTimersByTimeAsync(16))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('x')
  })

  it('flushes a non-append correction that preserves the visible prefix', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (frameId: number) => clearTimeout(frameId))
    streamdownHarness.shouldThrow = false

    await act(async () => {
      root.render(<AgentMarkdown content="abcdef" isAnimating />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(544))
    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('abc')

    await act(async () => {
      root.render(<AgentMarkdown content="abcXYZ" isAnimating />)
    })

    expect(container.querySelector('[data-testid="rich-markdown"]')?.textContent).toBe('abcXYZ')
  })
})

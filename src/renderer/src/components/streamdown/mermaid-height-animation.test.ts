// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installMermaidHeightAnimation } from './mermaid-height-animation'

type ResizeHandler = (entries: Array<{ target: Element }>) => void

let resizeHandler: ResizeHandler | undefined
let observedTargets: Element[]
let unobservedTargets: Element[]

class FakeResizeObserver {
  constructor(callback: ResizeHandler) {
    resizeHandler = callback
  }
  observe(target: Element): void {
    observedTargets.push(target)
  }
  unobserve(target: Element): void {
    unobservedTargets.push(target)
  }
  disconnect(): void {
    /* no-op */
  }
}

const setHeight = (element: HTMLElement, height: number): void => {
  Object.defineProperty(element, 'offsetHeight', { configurable: true, value: height })
}

// MutationObserver callbacks are delivered as microtasks; block discovery must settle first.
const flushMutations = (): Promise<void> => Promise.resolve()

const createMermaidBlock = async (height: number, inRoot = true): Promise<HTMLElement> => {
  const block = document.createElement('div')
  block.dataset.streamdown = 'mermaid-block'
  setHeight(block, height)
  if (inRoot) {
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    root.appendChild(block)
    document.body.appendChild(root)
  } else {
    document.body.appendChild(block)
  }
  await flushMutations()
  // A real ResizeObserver delivers an initial entry with the current size on observe().
  resizeHandler?.([{ target: block }])
  return block
}

const notifyResize = (block: HTMLElement, height: number): void => {
  setHeight(block, height)
  resizeHandler?.([{ target: block }])
}

let uninstall: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  observedTargets = []
  unobservedTargets = []
  resizeHandler = undefined
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  uninstall = installMermaidHeightAnimation()
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('installMermaidHeightAnimation', () => {
  it('animates the block from the placeholder height to the rendered height', async () => {
    const block = await createMermaidBlock(200)

    notifyResize(block, 480)

    expect(block.style.overflow).toBe('hidden')
    expect(block.style.transition).toContain('height')
    expect(block.style.height).toBe('480px')

    vi.advanceTimersByTime(230)

    expect(block.style.height).toBe('')
    expect(block.style.overflow).toBe('')
    expect(block.style.transition).toBe('')
  })

  it('does not animate the initial measurement', async () => {
    const block = await createMermaidBlock(200)

    expect(observedTargets).toContain(block)
    expect(block.style.height).toBe('')
  })

  it('ignores height changes below the threshold', async () => {
    const block = await createMermaidBlock(200)

    notifyResize(block, 201)

    expect(block.style.height).toBe('')
  })

  it('chains a follow-up animation when the height changes again mid-transition', async () => {
    const block = await createMermaidBlock(200)

    notifyResize(block, 480)
    expect(block.style.height).toBe('480px')

    // The diagram re-rendered taller while the first transition was still running.
    setHeight(block, 620)
    vi.advanceTimersByTime(230)

    expect(block.style.height).toBe('620px')
    vi.advanceTimersByTime(230)
    expect(block.style.height).toBe('')
  })

  it('ignores intermediate transition frames reported by the observer', async () => {
    const block = await createMermaidBlock(200)

    notifyResize(block, 480)
    notifyResize(block, 340)

    expect(block.style.height).toBe('480px')
  })

  it('skips the animation when reduced motion is preferred', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const block = await createMermaidBlock(200)

    notifyResize(block, 480)

    expect(block.style.height).toBe('')
    expect(block.style.overflow).toBe('')
  })

  it('ignores mermaid blocks outside the agent markdown root', async () => {
    const block = await createMermaidBlock(200, false)

    expect(observedTargets).not.toContain(block)
  })

  it('tracks blocks added after install and releases removed blocks', async () => {
    const block = document.createElement('div')
    block.dataset.streamdown = 'mermaid-block'
    setHeight(block, 200)
    const root = document.createElement('div')
    root.className = 'agent-markdown-root'
    root.appendChild(block)

    document.body.appendChild(root)
    await flushMutations()
    expect(observedTargets).toContain(block)

    root.remove()
    await flushMutations()
    expect(unobservedTargets).toContain(block)
  })

  it('restores the auto height when uninstalling mid-animation', async () => {
    const block = await createMermaidBlock(200)

    notifyResize(block, 480)
    expect(block.style.height).toBe('480px')

    uninstall?.()
    uninstall = undefined

    expect(block.style.height).toBe('')
    expect(block.style.overflow).toBe('')
  })
})

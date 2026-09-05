import { STREAMDOWN_MERMAID_BLOCK_SELECTOR } from './dom-selectors'

const AGENT_MARKDOWN_ROOT_SELECTOR = '.agent-markdown-root'
const MERMAID_BLOCK_SELECTOR = STREAMDOWN_MERMAID_BLOCK_SELECTOR
const HEIGHT_TRANSITION_MS = 180
const HEIGHT_TRANSITION_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'
const MIN_HEIGHT_DELTA_PX = 2

type MermaidBlockState = {
  contentHeight: number | null
  animating: boolean
  targetHeight: number
  timer: number | null
}

// Streamdown lazily renders a mermaid diagram when its placeholder scrolls near the viewport and
// then swaps the 200px placeholder for the real SVG in a single commit. Reserving the rendered
// height up front is impossible, so the next best thing is to animate the block between the two
// heights instead of letting the surrounding transcript jump.
const installMermaidHeightAnimation = (): (() => void) => {
  if (typeof ResizeObserver !== 'function') return () => {}

  const states = new WeakMap<HTMLElement, MermaidBlockState>()
  const observedBlocks = new Set<HTMLElement>()

  const prefersReducedMotion = (): boolean =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

  const finishAnimation = (block: HTMLElement, state: MermaidBlockState): void => {
    state.animating = false
    if (state.timer !== null) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    block.style.transition = ''
    block.style.height = ''
    block.style.overflow = ''

    // The diagram may have changed again mid-animation (streaming retries, window resize). The
    // transition pinned the block at its old target, so re-measure now that height is auto and
    // chain into a follow-up animation instead of snapping.
    const settledHeight = block.offsetHeight
    if (Math.abs(settledHeight - state.targetHeight) >= MIN_HEIGHT_DELTA_PX) {
      startAnimation(block, state, state.targetHeight, settledHeight)
    }
    state.contentHeight = settledHeight
  }

  const startAnimation = (
    block: HTMLElement,
    state: MermaidBlockState,
    from: number,
    to: number
  ): void => {
    if (state.timer !== null) window.clearTimeout(state.timer)
    state.animating = true
    state.targetHeight = to

    block.style.overflow = 'hidden'
    block.style.transition = 'none'
    block.style.height = `${from}px`
    // Flush layout so the transition below starts from `from` instead of the auto height.
    void block.offsetHeight
    block.style.transition = `height ${HEIGHT_TRANSITION_MS}ms ${HEIGHT_TRANSITION_EASING}`
    block.style.height = `${to}px`

    // A timer is used instead of transitionend: jsdom never fires it, and an interrupted
    // transition (transitioncancel) must still restore the auto height.
    state.timer = window.setTimeout(() => finishAnimation(block, state), HEIGHT_TRANSITION_MS + 50)
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const block = entry.target
      if (!(block instanceof HTMLElement)) continue
      const state = states.get(block)
      if (!state) continue
      // While the transition runs the block reports every intermediate height; the settled
      // height is re-measured when the animation finishes.
      if (state.animating) continue

      const next = block.offsetHeight
      const previous = state.contentHeight
      state.contentHeight = next
      if (previous === null || Math.abs(next - previous) < MIN_HEIGHT_DELTA_PX) continue
      if (prefersReducedMotion()) continue

      startAnimation(block, state, previous, next)
    }
  })

  const trackBlock = (block: HTMLElement): void => {
    if (observedBlocks.has(block)) return
    observedBlocks.add(block)
    states.set(block, { contentHeight: null, animating: false, targetHeight: 0, timer: null })
    resizeObserver.observe(block)
  }

  const releaseBlock = (block: HTMLElement): void => {
    if (!observedBlocks.delete(block)) return
    const state = states.get(block)
    if (state?.animating) {
      if (state.timer !== null) window.clearTimeout(state.timer)
      block.style.transition = ''
      block.style.height = ''
      block.style.overflow = ''
    }
    resizeObserver.unobserve(block)
  }

  const collectBlocks = (node: Node, found: HTMLElement[]): void => {
    if (!(node instanceof HTMLElement)) return
    if (node.matches(MERMAID_BLOCK_SELECTOR) && node.closest(AGENT_MARKDOWN_ROOT_SELECTOR)) {
      found.push(node)
    }
    for (const block of node.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR)) {
      if (block.closest(AGENT_MARKDOWN_ROOT_SELECTOR)) found.push(block)
    }
  }

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const added: HTMLElement[] = []
      const removed: HTMLElement[] = []
      mutation.addedNodes.forEach((node) => collectBlocks(node, added))
      mutation.removedNodes.forEach((node) => collectBlocks(node, removed))
      added.forEach(trackBlock)
      removed.forEach(releaseBlock)
    }
  })

  const initial: HTMLElement[] = []
  collectBlocks(document.body, initial)
  initial.forEach(trackBlock)
  mutationObserver.observe(document.body, { childList: true, subtree: true })

  return () => {
    mutationObserver.disconnect()
    for (const block of [...observedBlocks]) releaseBlock(block)
    resizeObserver.disconnect()
  }
}

export { installMermaidHeightAnimation }

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initI18n, i18next } from '@/i18n'

vi.mock('./mermaid-source-highlight', () => ({
  highlightMermaidSource: vi.fn()
}))

import { highlightMermaidSource } from './mermaid-source-highlight'
import { rememberMermaidSource } from './mermaid-source-registry'
import { installMermaidViewToggle } from './mermaid-view-toggle'

const mockHighlight = vi.mocked(highlightMermaidSource)

const SOURCE = 'graph TD; A-->B'

const flushMutations = (): Promise<void> => Promise.resolve()

const createMermaidBlock = (
  renderId?: string
): { block: HTMLElement; actions: HTMLElement; body: HTMLElement; diagram?: HTMLElement } => {
  const root = document.createElement('div')
  root.className = 'agent-markdown-root'
  const block = document.createElement('div')
  block.dataset.streamdown = 'mermaid-block'
  const header = document.createElement('div')
  const actions = document.createElement('div')
  actions.dataset.streamdown = 'mermaid-block-actions'
  const body = document.createElement('div')
  let diagram: HTMLElement | undefined
  if (renderId) {
    diagram = document.createElement('div')
    diagram.dataset.streamdown = 'mermaid'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-mermaid-render-id', renderId)
    diagram.appendChild(svg)
    body.appendChild(diagram)
  }
  block.append(header, actions, body)
  root.appendChild(block)
  document.body.appendChild(root)
  return { block, actions, body, diagram }
}

const findToggle = (actions: HTMLElement): HTMLButtonElement | null =>
  actions.querySelector('[data-mermaid-view-toggle]')

let uninstall: (() => void) | undefined

beforeEach(async () => {
  mockHighlight.mockReset()
  await initI18n('en')
  uninstall = installMermaidViewToggle()
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
})

describe('installMermaidViewToggle', () => {
  it('adds a toggle to the action bar once a sourced diagram exists', async () => {
    rememberMermaidSource('r-1', SOURCE)
    const { actions } = createMermaidBlock('r-1')
    await flushMutations()

    const toggle = findToggle(actions)
    expect(toggle).not.toBeNull()
    expect(toggle?.title).toBe('View source')
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
    expect(toggle?.disabled).toBe(false)
  })

  it('waits for the rendered diagram before adding the toggle', async () => {
    const { actions, body } = createMermaidBlock()
    await flushMutations()
    expect(findToggle(actions)).toBeNull()

    rememberMermaidSource('r-2', SOURCE)
    const diagram = document.createElement('div')
    diagram.dataset.streamdown = 'mermaid'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-mermaid-render-id', 'r-2')
    diagram.appendChild(svg)
    body.appendChild(diagram)
    await flushMutations()

    expect(findToggle(actions)).not.toBeNull()
  })

  it('toggles between the source and the rendered diagram', async () => {
    rememberMermaidSource('r-3', SOURCE)
    const { actions, body, diagram } = createMermaidBlock('r-3')
    await flushMutations()
    const toggle = findToggle(actions)
    expect(toggle).not.toBeNull()

    toggle?.click()

    const sourceView = body.querySelector('[data-mermaid-source-view]')
    expect(sourceView?.textContent).toBe(SOURCE)
    expect(diagram?.style.display).toBe('none')
    expect(toggle?.title).toBe('View diagram')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')

    toggle?.click()

    expect(body.querySelector('[data-mermaid-source-view]')).toBeNull()
    expect(diagram?.style.display).toBe('')
    expect(toggle?.title).toBe('View source')
  })

  it('upgrades the source view with highlighted markup when the highlighter resolves', async () => {
    rememberMermaidSource('r-3b', SOURCE)
    const { actions, body } = createMermaidBlock('r-3b')
    await flushMutations()

    mockHighlight.mockImplementation((source, apply) => {
      apply(`<span style="color:#0550ae">${source}</span>`)
    })
    findToggle(actions)?.click()

    const code = body.querySelector('[data-mermaid-source-view] code')
    expect(code?.innerHTML).toBe('<span style="color:#0550ae">graph TD; A--&gt;B</span>')
    expect(mockHighlight).toHaveBeenCalledWith(SOURCE, expect.any(Function))
  })

  it('drops highlight deliveries that arrive after toggling back to the diagram', async () => {
    rememberMermaidSource('r-3c', SOURCE)
    const { actions, body } = createMermaidBlock('r-3c')
    await flushMutations()

    let deliver: ((html: string) => void) | undefined
    mockHighlight.mockImplementation((_source, apply) => {
      deliver = apply
    })
    const toggle = findToggle(actions)
    toggle?.click()
    const container = body.querySelector('[data-mermaid-source-view]')
    expect(container).not.toBeNull()

    toggle?.click()
    deliver?.('<span style="color:#0550ae">stale</span>')

    expect(container?.querySelector('code')?.textContent).toBe(SOURCE)
    expect(container?.isConnected).toBe(false)
  })

  it('refreshes a visible source view when the diagram re-renders', async () => {
    rememberMermaidSource('r-4', SOURCE)
    const { actions, body } = createMermaidBlock('r-4')
    await flushMutations()
    findToggle(actions)?.click()
    expect(body.querySelector('[data-mermaid-source-view]')?.textContent).toBe(SOURCE)

    rememberMermaidSource('r-5', 'graph TD; C-->D')
    body.querySelector('svg')?.setAttribute('data-mermaid-render-id', 'r-5')
    await flushMutations()

    expect(body.querySelector('[data-mermaid-source-view]')?.textContent).toBe('graph TD; C-->D')
  })

  it('disables the toggle when the diagram is replaced by an error panel', async () => {
    rememberMermaidSource('r-6', SOURCE)
    const { actions, body } = createMermaidBlock('r-6')
    await flushMutations()
    expect(findToggle(actions)?.disabled).toBe(false)

    body.querySelector('[data-streamdown="mermaid"]')?.remove()
    await flushMutations()

    expect(findToggle(actions)?.disabled).toBe(true)
  })

  // Regression: syncButton runs inside the MutationObserver callback. An unconditional
  // innerHTML rewrite queues another delivery forever, pegging the main thread — the app
  // freezes and diagrams never finish rendering. After the toggle settles the installer
  // must stop producing mutations entirely.
  it('stops mutating the DOM once the toggle has settled', async () => {
    rememberMermaidSource('r-9', SOURCE)
    const { actions } = createMermaidBlock('r-9')
    await flushMutations()
    await flushMutations()
    expect(findToggle(actions)).not.toBeNull()

    let mutations = 0
    const probe = new MutationObserver(() => {
      mutations += 1
    })
    probe.observe(actions, { childList: true, subtree: true, attributes: true })
    for (let round = 0; round < 5; round += 1) await flushMutations()
    probe.disconnect()

    expect(mutations).toBe(0)
  })

  it('translates the label when the language changes', async () => {
    rememberMermaidSource('r-7', SOURCE)
    const { actions } = createMermaidBlock('r-7')
    await flushMutations()
    expect(findToggle(actions)?.title).toBe('View source')

    await i18next.changeLanguage('de')
    expect(findToggle(actions)?.title).toBe('Quelle ansehen')

    await i18next.changeLanguage('zh-Hans')
    expect(findToggle(actions)?.title).toBe('查看源码')
  })

  it('restores the source view and removes buttons on uninstall', async () => {
    rememberMermaidSource('r-8', SOURCE)
    const { actions, body, diagram } = createMermaidBlock('r-8')
    await flushMutations()
    findToggle(actions)?.click()
    expect(body.querySelector('[data-mermaid-source-view]')).not.toBeNull()

    uninstall?.()
    uninstall = undefined

    expect(findToggle(actions)).toBeNull()
    expect(body.querySelector('[data-mermaid-source-view]')).toBeNull()
    expect(diagram?.style.display).toBe('')
  })
})

import { i18next } from '@/i18n'

import { highlightMermaidSource } from './mermaid-source-highlight'
import { getMermaidSource, MERMAID_RENDER_ID_ATTRIBUTE } from './mermaid-source-registry'

const AGENT_MARKDOWN_ROOT_SELECTOR = '.agent-markdown-root'
const MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]'
const MERMAID_ACTIONS_SELECTOR = `${AGENT_MARKDOWN_ROOT_SELECTOR} [data-streamdown="mermaid-block-actions"]`

const TOGGLE_ATTRIBUTE = 'data-mermaid-view-toggle'
const DECORATED_ATTRIBUTE = 'data-view-toggle-decorated'
const VIEW_ATTRIBUTE = 'data-mermaid-view'
const SOURCE_VIEW_ATTRIBUTE = 'data-mermaid-source-view'

const BUTTON_CLASS =
  'cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50'

const CODE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6L2 12l6 6M16 6l6 6-6 6"/></svg>'
const DIAGRAM_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>'

const sourceByContainer = new WeakMap<HTMLElement, string>()

const getDiagramBody = (block: HTMLElement): HTMLElement | null => {
  const last = block.lastElementChild
  return last instanceof HTMLElement ? last : null
}

const currentSource = (block: HTMLElement): string | undefined => {
  const renderId = block
    .querySelector(`svg[${MERMAID_RENDER_ID_ATTRIBUTE}]`)
    ?.getAttribute(MERMAID_RENDER_ID_ATTRIBUTE)
  return renderId ? getMermaidSource(renderId) : undefined
}

const syncButton = (button: HTMLButtonElement, block: HTMLElement): void => {
  const showingSource = block.getAttribute(VIEW_ATTRIBUTE) === 'source'
  const disabled = !showingSource && currentSource(block) === undefined
  // syncButton runs inside the MutationObserver callback. Rewriting innerHTML always replaces
  // the child nodes — even with identical markup — which queues another delivery and loops
  // forever on the main thread. Only touch the DOM when something actually changed.
  const stateKey = `${showingSource ? 'source' : 'diagram'}:${disabled ? 'off' : 'on'}:${i18next.language}`
  if (button.dataset.toggleState === stateKey) return
  button.dataset.toggleState = stateKey

  button.innerHTML = showingSource ? DIAGRAM_ICON : CODE_ICON
  const label = i18next.t(showingSource ? 'View diagram' : 'View source')
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(showingSource))
  button.disabled = disabled
}

// Renders the fence source like a fenced code block (see the [data-mermaid-source-view] rules in
// agent-markdown.css): plain text immediately, upgraded to Shiki tokens when the shared
// highlighter chunk resolves. Stale deliveries (toggled back, re-rendered chart) are dropped.
const setSourceViewContent = (container: HTMLElement, source: string): void => {
  sourceByContainer.set(container, source)
  const code = container.querySelector('code')
  if (!code) return
  code.textContent = source
  highlightMermaidSource(source, (html) => {
    if (!container.isConnected || sourceByContainer.get(container) !== source) return
    code.innerHTML = html
  })
}

const showSource = (block: HTMLElement): void => {
  if (block.getAttribute(VIEW_ATTRIBUTE) === 'source') return
  const body = getDiagramBody(block)
  const source = currentSource(block)
  if (!body || source === undefined) return

  const container = document.createElement('div')
  container.setAttribute(SOURCE_VIEW_ATTRIBUTE, '')
  const pre = document.createElement('pre')
  pre.appendChild(document.createElement('code'))
  container.appendChild(pre)
  for (const child of body.children) {
    if (child instanceof HTMLElement) child.style.display = 'none'
  }
  body.appendChild(container)
  block.setAttribute(VIEW_ATTRIBUTE, 'source')
  setSourceViewContent(container, source)
}

const showDiagram = (block: HTMLElement): void => {
  const body = getDiagramBody(block)
  body?.querySelector(`[${SOURCE_VIEW_ATTRIBUTE}]`)?.remove()
  if (body) {
    for (const child of body.children) {
      if (child instanceof HTMLElement) child.style.display = ''
    }
  }
  block.removeAttribute(VIEW_ATTRIBUTE)
}

// Adds a source/rendered toggle to each mermaid block's action bar. The rendered SVG stays
// mounted (display: none) while the source is shown, so toggling back never re-renders.
const installMermaidViewToggle = (): (() => void) => {
  const decorate = (): void => {
    for (const actions of document.querySelectorAll<HTMLElement>(
      `${MERMAID_ACTIONS_SELECTOR}:not([${DECORATED_ATTRIBUTE}])`
    )) {
      const block = actions.closest(MERMAID_BLOCK_SELECTOR)
      if (!(block instanceof HTMLElement)) continue
      // The toggle only works once a rendered diagram has exposed its source; retry next scan.
      if (!block.querySelector(`svg[${MERMAID_RENDER_ID_ATTRIBUTE}]`)) continue

      actions.setAttribute(DECORATED_ATTRIBUTE, '')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = BUTTON_CLASS
      button.setAttribute(TOGGLE_ATTRIBUTE, '')
      button.addEventListener('click', () => {
        if (block.getAttribute(VIEW_ATTRIBUTE) === 'source') {
          showDiagram(block)
        } else {
          showSource(block)
        }
        syncButton(button, block)
      })
      actions.prepend(button)
    }

    // Re-rendered diagrams (retry, streaming) replace the SVG: keep enabled/disabled state and
    // any visible source view in sync with the latest chart.
    for (const button of document.querySelectorAll<HTMLButtonElement>(`[${TOGGLE_ATTRIBUTE}]`)) {
      const block = button.closest(MERMAID_BLOCK_SELECTOR)
      if (!(block instanceof HTMLElement)) continue
      syncButton(button, block)
      const sourceView = getDiagramBody(block)?.querySelector<HTMLElement>(
        `[${SOURCE_VIEW_ATTRIBUTE}]`
      )
      const source = currentSource(block)
      if (sourceView && source !== undefined && sourceByContainer.get(sourceView) !== source) {
        setSourceViewContent(sourceView, source)
      }
    }
  }

  const onLanguageChanged = (): void => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(`[${TOGGLE_ATTRIBUTE}]`)) {
      const block = button.closest(MERMAID_BLOCK_SELECTOR)
      if (block instanceof HTMLElement) syncButton(button, block)
    }
  }

  decorate()
  const observer = new MutationObserver(decorate)
  observer.observe(document.body, { childList: true, subtree: true })
  i18next.on('languageChanged', onLanguageChanged)

  return () => {
    observer.disconnect()
    i18next.off('languageChanged', onLanguageChanged)
    for (const block of document.querySelectorAll<HTMLElement>(
      `${MERMAID_BLOCK_SELECTOR}[${VIEW_ATTRIBUTE}="source"]`
    )) {
      showDiagram(block)
    }
    for (const button of document.querySelectorAll(`[${TOGGLE_ATTRIBUTE}]`)) button.remove()
    for (const actions of document.querySelectorAll(`[${DECORATED_ATTRIBUTE}]`)) {
      actions.removeAttribute(DECORATED_ATTRIBUTE)
    }
  }
}

export { installMermaidViewToggle }

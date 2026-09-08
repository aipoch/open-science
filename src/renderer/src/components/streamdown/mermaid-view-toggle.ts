import { i18next } from '@/i18n'

import { highlightMermaidSource, LINE_CLASS } from './mermaid-source-highlight'
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

// Bidirectional arrows: the button switches between the rendered diagram and its source.
const TOGGLE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>'

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

  button.innerHTML = TOGGLE_ICON
  const label = i18next.t(showingSource ? 'View diagram' : 'View source')
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(showingSource))
  button.disabled = disabled
}

// Renders the fence source exactly like a line-numbered fenced code block: the container takes
// the code-block-body data attribute so the shared stylesheet applies, each line is a gutter
// span, and the pre picks up the Shiki background once highlighting resolves. Plain text shows
// first and is upgraded to token markup; stale deliveries (toggled back, re-rendered chart)
// are dropped.
const setSourceViewContent = (container: HTMLElement, source: string): void => {
  sourceByContainer.set(container, source)
  const pre = container.querySelector('pre')
  const code = container.querySelector('code')
  if (!pre || !code) return

  pre.style.removeProperty('--sdm-bg')
  pre.style.removeProperty('--sdm-fg')
  code.replaceChildren(
    ...source.split('\n').map((line) => {
      const lineSpan = document.createElement('span')
      lineSpan.className = LINE_CLASS
      lineSpan.textContent = line
      return lineSpan
    })
  )
  highlightMermaidSource(source, (highlight) => {
    if (!container.isConnected || sourceByContainer.get(container) !== source) return
    code.innerHTML = highlight.html
    if (highlight.bg) pre.style.setProperty('--sdm-bg', highlight.bg)
    if (highlight.fg) pre.style.setProperty('--sdm-fg', highlight.fg)
  })
}

const showSource = (block: HTMLElement): void => {
  if (block.getAttribute(VIEW_ATTRIBUTE) === 'source') return
  const body = getDiagramBody(block)
  const source = currentSource(block)
  if (!body || source === undefined) return

  const container = document.createElement('div')
  container.setAttribute(SOURCE_VIEW_ATTRIBUTE, '')
  container.dataset.streamdown = 'code-block-body'
  container.dataset.language = 'mermaid'
  const pre = document.createElement('pre')
  pre.className = 'bg-[var(--sdm-bg,inherit)] dark:bg-[var(--shiki-dark-bg,var(--sdm-bg,inherit))]'
  const code = document.createElement('code')
  code.className = '[counter-increment:line_0] [counter-reset:line]'
  pre.appendChild(code)
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

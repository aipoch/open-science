import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'

import { describe, expect, it } from 'vitest'

describe('AgentMarkdown fullscreen chrome', () => {
  it('keeps per-commit structural re-match selectors out of the streaming block', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const streamingBlock = css.slice(
      css.indexOf('.agent-markdown-streaming'),
      css.indexOf('/* --- Streamdown dropdown panels')
    )

    // Quote/empty-block hiding while streaming is decided render-side (createStreamingBlockquote);
    // :has()/:empty here would re-match on every streamed DOM mutation.
    expect(streamingBlock).not.toContain(':has(')
    expect(streamingBlock).not.toContain(':empty')
    expect(streamingBlock).toContain('& hr {')
    expect(streamingBlock).not.toContain('cursor-blink')
    expect(streamingBlock).not.toContain('background-color: currentColor')
  })

  it('renders no streaming caret on the terminal text block', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const streamingBlock = css.slice(
      css.indexOf('.agent-markdown-streaming'),
      css.indexOf('/* --- Streamdown dropdown panels')
    )
    const markup = renderToStaticMarkup(
      createElement(
        Streamdown,
        { animated: false, dir: 'auto', isAnimating: true, mode: 'streaming' },
        'Example output with Python (matplotlib)'
      )
    )

    expect(markup).toContain('style="display:contents"')
    expect(markup).not.toContain('--streamdown-caret')
    // The terminal-block ::after stays suppressed so no caret glyph appears while streaming.
    expect(streamingBlock).toContain('& .agent-markdown > :last-child::after')
    expect(streamingBlock).toContain('content: none')
    expect(streamingBlock).not.toContain('& .agent-markdown > :last-child:empty::after')
    expect(streamingBlock).not.toContain('& .agent-markdown > :last-child > :last-child::after')
  })

  it('keeps Mermaid fullscreen functionality enabled while matching the dialog overlay chrome', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const config = readFileSync(resolve(__dirname, 'streamdown-config.ts'), 'utf8')
    const mermaidFullscreenBlock = css.slice(
      css.indexOf('/* Mermaid fullscreen portal'),
      css.indexOf('/* Agent message typography')
    )

    expect(config).toContain('mermaid: {')
    expect(config).toContain('fullscreen: true')
    expect(mermaidFullscreenBlock).toContain('background: rgb(0 0 0 / 50%) !important')
    expect(mermaidFullscreenBlock).not.toContain('backdrop-filter: blur')
    expect(mermaidFullscreenBlock).toContain('rounded-xl')
    expect(mermaidFullscreenBlock).toContain('border border-border')
    expect(mermaidFullscreenBlock).toContain('bg-card')
    expect(mermaidFullscreenBlock).toContain('text-foreground')
    expect(mermaidFullscreenBlock).toContain('shadow-dialog')
    expect(mermaidFullscreenBlock).toContain('bg-card!')
    expect(mermaidFullscreenBlock).toContain("[data-fullscreen-state='closing']")
    expect(mermaidFullscreenBlock).toContain('sd-fullscreen-overlay-out')
    expect(mermaidFullscreenBlock).toContain('sd-fullscreen-panel-out')
    expect(mermaidFullscreenBlock).toContain('z-[80]!')
    expect(mermaidFullscreenBlock).toContain('z-[82]!')
    expect(mermaidFullscreenBlock).toContain('pointer-events: auto !important')
    expect(mermaidFullscreenBlock).toContain('pointer-events: none !important')
  })

  it('uses theme-aware shared chrome for table fullscreen without changing table rendering', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const themeCss = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const blockEnd = css.indexOf('/* Mermaid fullscreen portal')
    const blockStart = css.lastIndexOf("[data-streamdown='table-fullscreen'] {", blockEnd)
    const tableFullscreenBlock = css.slice(blockStart, blockEnd)

    expect(tableFullscreenBlock).toContain('background: rgb(0 0 0 / 50%) !important')
    expect(tableFullscreenBlock).toContain('bg-card text-foreground shadow-dialog')
    expect(tableFullscreenBlock).toContain("[data-fullscreen-state='closing']")
    expect(tableFullscreenBlock).toContain('& > div:first-child {')
    expect(tableFullscreenBlock).toContain('@apply border-border bg-card;')
    expect(tableFullscreenBlock).toContain('& > div:last-child {')
    expect(tableFullscreenBlock).toContain('@apply bg-card px-4')
    expect(tableFullscreenBlock).toContain('z-[80]!')
    expect(tableFullscreenBlock).toContain('pointer-events: auto !important')
    expect(tableFullscreenBlock).toContain('pointer-events: none !important')
    expect(css).toContain('z-markdown-menu')
    expect(css).not.toContain('z-[10000]')
    expect(themeCss).toContain('--z-index-markdown-menu: 200')
    expect(themeCss).not.toContain('--z-index-markdown-menu: 10000')
  })

  it('disables both fullscreen animations when reduced motion is requested', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const reducedMotionBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

    expect(reducedMotionBlock).toContain("[data-streamdown='table-fullscreen']")
  })

  it('uses the native zoom-in cursor and a visible keyboard focus ring for artifact images', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const artifactImageBlock = css.slice(
      css.indexOf('[data-session-artifact-image]'),
      css.indexOf('[data-session-artifact-image-status]')
    )
    const artifactImageStatusBlock = css.slice(
      css.indexOf('[data-session-artifact-image-status]'),
      css.indexOf('[data-session-link-favicon]')
    )

    expect(artifactImageBlock).toContain('cursor-zoom-in')
    expect(artifactImageBlock).toContain('&:focus-visible')
    expect(artifactImageBlock).toContain('outline-ring')
    expect(artifactImageBlock).toContain('&:active')
    expect(artifactImageBlock).toContain('&:disabled')
    expect(artifactImageStatusBlock).toContain('bg-sd-surface-subtle')
    expect(artifactImageStatusBlock).toContain('text-sd-muted')
    expect(artifactImageStatusBlock).not.toContain('bg-bg-100')
  })
})

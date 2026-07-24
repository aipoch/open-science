import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('AgentMarkdown fullscreen chrome', () => {
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
  })

  it('disables both fullscreen animations when reduced motion is requested', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/agent-markdown.css'), 'utf8')
    const reducedMotionBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

    expect(reducedMotionBlock).toContain("[data-streamdown='table-fullscreen']")
  })
})

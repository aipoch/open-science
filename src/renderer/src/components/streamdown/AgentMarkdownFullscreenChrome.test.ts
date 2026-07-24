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
  })
})

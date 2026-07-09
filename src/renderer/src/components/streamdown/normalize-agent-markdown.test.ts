import { describe, expect, it } from 'vitest'

import {
  normalizeAgentMarkdown,
  normalizeGfmAlerts,
  normalizeMermaidChart
} from './normalize-agent-markdown'

describe('normalizeMermaidChart', () => {
  it('fixes title and x-axis on one line with unquoted labels', () => {
    const input = `xychart-beta
    "Monthly sales" x-axis [Jan, Feb, Mar, Apr, May]
    y-axis "Sales" 0 --> 100
    bar [30, 45, 38, 52, 61]`

    const output = normalizeMermaidChart(input)

    expect(output).toContain('title "Monthly sales"')
    expect(output).toContain('x-axis ["Jan", "Feb", "Mar", "Apr", "May"]')
  })
})

describe('normalizeGfmAlerts', () => {
  it('converts GFM alert blockquotes to aside elements', () => {
    const input = `> [!WARNING]
> Back up the database before running the migration.`

    const output = normalizeGfmAlerts(input)

    expect(output).toContain('<aside data-agent-alert="warning">')
    expect(output).toContain('Back up the database before running the migration.')
  })
})

describe('normalizeAgentMarkdown', () => {
  it('applies mermaid and alert normalizers', () => {
    const input = `\`\`\`mermaid
xychart-beta
    "Monthly sales" x-axis [Jan, Feb]
\`\`\`

> [!TIP]
> Use static mode to preview completed messages.`

    const output = normalizeAgentMarkdown(input)

    expect(output).toContain('title "Monthly sales"')
    expect(output).toContain('<aside data-agent-alert="tip">')
  })
})

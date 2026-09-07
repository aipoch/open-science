import { describe, expect, it } from 'vitest'

import {
  createAgentMarkdownNormalizer,
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

// Characterization: pins the exact current output so the incremental streaming normalizer can
// be verified against it. Update only via a deliberate behavior change.
describe('normalizeAgentMarkdown characterization', () => {
  it.each([
    [
      'multi-line alert body',
      'Intro text.\n\n> [!WARNING]\n> Back up the database.\n> Then run the migration.\n\nAfter.',
      'Intro text.\n\n<aside data-agent-alert="warning">\n\nBack up the database.\nThen run the migration.\n\n</aside>\n\n\nAfter.'
    ],
    ['alert header alone is left untouched', '> [!NOTE]', '> [!NOTE]'],
    [
      'alert header without a contiguous body is left untouched',
      '> [!NOTE]\n\nparagraph',
      '> [!NOTE]\n\nparagraph'
    ],
    [
      'alert with a partial trailing body line still converts',
      '> [!WARNING]\n> Back up the dat',
      '<aside data-agent-alert="warning">\n\nBack up the dat\n\n</aside>\n\n'
    ],
    [
      'alert type is lowercased',
      '> [!note]\n> lowercase type',
      '<aside data-agent-alert="note">\n\nlowercase type\n\n</aside>\n\n'
    ],
    [
      'closed mermaid xychart gets title/x-axis fixes',
      '```mermaid\nxychart-beta\n    "Monthly sales" x-axis [Jan, Feb]\n    bar [30, 45]\n```',
      '```mermaid\nxychart-beta\n    title "Monthly sales"\n    x-axis ["Jan", "Feb"]\n    bar [30, 45]\n```'
    ],
    [
      'unclosed mermaid fence is left untouched',
      '```mermaid\nxychart-beta\n    "Monthly sales" x-axis [Jan, Feb]',
      '```mermaid\nxychart-beta\n    "Monthly sales" x-axis [Jan, Feb]'
    ],
    [
      'mermaid block containing a blank line still normalizes',
      '```mermaid\nxychart-beta\n\n    "T" x-axis [a, b]\n```\n',
      '```mermaid\nxychart-beta\n\n    title "T"\n    x-axis ["a", "b"]\n```\n'
    ],
    ['plain code fence passes through', '```js\nconst a = 1\n```', '```js\nconst a = 1\n```'],
    ['unclosed plain code fence passes through', '```js\nconst a = 1', '```js\nconst a = 1'],
    [
      'inline code and emphasis pass through',
      'Some `inline code` and **bold** text.',
      'Some `inline code` and **bold** text.'
    ]
  ])('%s', (_name, input, expected) => {
    expect(normalizeAgentMarkdown(input)).toBe(expected)
  })
})

describe('createAgentMarkdownNormalizer', () => {
  // Feeds every append-only prefix of `chunks` through the incremental normalizer and pins
  // each step to the full normalizer's output.
  const expectAppendStreamMatchesFull = (chunks: string[]): void => {
    const incremental = createAgentMarkdownNormalizer()
    let streamed = ''
    for (const chunk of chunks) {
      streamed += chunk
      expect(incremental(streamed)).toBe(normalizeAgentMarkdown(streamed))
    }
  }

  it('matches full normalization for a growing prose stream', () => {
    expectAppendStreamMatchesFull([
      'The quick',
      ' brown fox jumps over',
      ' the lazy dog.\n\nSecond para',
      'graph with `inline code`.'
    ])
  })

  it('matches full normalization when an append completes a GFM alert', () => {
    expectAppendStreamMatchesFull([
      'Intro text.\n\n> [!WARNING]\n> Back up the dat',
      'abase.\n> Then run the migration.',
      '\n\nAfter.'
    ])
  })

  it('matches full normalization when an append completes the alert header itself', () => {
    expectAppendStreamMatchesFull(['Some lead-in.\n\n> [!NOT', 'E]\n> Body line.'])
  })

  it('matches full normalization while a mermaid fence opens, grows, and closes', () => {
    expectAppendStreamMatchesFull([
      'Chart below.\n\n```merm',
      'aid\nxychart-beta\n    "Monthly sales" x-axis [Jan, Feb]',
      '\n    bar [30, 45]\n```',
      '\n\nTrailing prose.'
    ])
  })

  it('matches full normalization for a mermaid block containing a blank line', () => {
    expectAppendStreamMatchesFull([
      '```mermaid\nxychart-beta\n\n    "T" x-axis [a, b]',
      '\n```\n',
      '\nNext paragraph.'
    ])
  })

  it('matches full normalization for code fences with blank lines inside', () => {
    expectAppendStreamMatchesFull([
      '```js\nconst a = 1\n\nconst b = 2',
      '\n```\n\n> [!TIP]\n> Done.',
      '\n\n```py\nprint(1)'
    ])
  })

  it('matches full normalization when the stream ends mid-line after a closed fence', () => {
    expectAppendStreamMatchesFull(['```js\nconst a = 1\n```\n\nAfter', ' the fence.'])
  })

  it('falls back to full normalization for non-append changes', () => {
    const incremental = createAgentMarkdownNormalizer()
    incremental('Intro.\n\n> [!NOTE]\n> Original body.')

    const edited = 'Intro.\n\n> [!NOTE]\n> Edited body.'
    expect(incremental(edited)).toBe(normalizeAgentMarkdown(edited))

    // The stream can keep growing incrementally after an edit.
    const grown = `${edited}\n\nMore.`
    expect(incremental(grown)).toBe(normalizeAgentMarkdown(grown))
  })

  it('returns the cached output for repeated identical input', () => {
    const incremental = createAgentMarkdownNormalizer()
    const input = '> [!TIP]\n> Repeated.'
    expect(incremental(input)).toBe(normalizeAgentMarkdown(input))
    expect(incremental(input)).toBe(normalizeAgentMarkdown(input))
  })

  it('handles empty and single-block input without a blank line', () => {
    const incremental = createAgentMarkdownNormalizer()
    expect(incremental('')).toBe('')
    expectAppendStreamMatchesFull(['> [!NOTE]\n> one', '\n> two', '\n> three'])
  })

  it('matches full normalization when a whitespace-only partial line extends', () => {
    expectAppendStreamMatchesFull([
      'First paragraph.\n\n  ',
      'Second paragraph.',
      '\n\n> [!NOTE]\n> Body.'
    ])
  })

  it('matches full normalization when an append splits a fence marker across the boundary', () => {
    expectAppendStreamMatchesFull([
      'Code below.\n\n``',
      '`js\nconst a = 1',
      '\n```\n\n> [!TIP]\n> Done.'
    ])
  })

  it('matches full normalization when an unclosed mermaid opener widens past the last split', () => {
    expectAppendStreamMatchesFull([
      'First paragraph.\n\nSecond paragraph.\n\n',
      '```mermaid\nxychart-beta\n    "T" x-axis [a, b]',
      '\n```\n\nAfter the chart.'
    ])
  })

  it('matches full normalization when a partial fence marker line gets replaced', () => {
    const incremental = createAgentMarkdownNormalizer()
    incremental('Intro.\n\n```merm')

    const replaced = 'Intro.\n\n```js\nconst a = 1\n```'
    expect(incremental(replaced)).toBe(normalizeAgentMarkdown(replaced))

    const grown = `${replaced}\n\n> [!NOTE]\n> After the fence.`
    expect(incremental(grown)).toBe(normalizeAgentMarkdown(grown))
  })
})

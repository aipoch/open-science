import { describe, expect, it } from 'vitest'

import { createMarkdownPluginNeedsScanner, getMarkdownPluginNeeds } from './code-fence'

describe('getMarkdownPluginNeeds', () => {
  it('needs nothing for prose, lists, and tables', () => {
    expect(
      getMarkdownPluginNeeds(
        'Plain text\n\n- list item\n\n| Name | Value |\n| --- | --- |\n| A | 1 |'
      )
    ).toEqual({ code: false, mermaid: false })
  })

  it('detects code and mermaid fences', () => {
    expect(getMarkdownPluginNeeds('```ts\nconst value = 1\n```')).toEqual({
      code: true,
      mermaid: false
    })
    expect(getMarkdownPluginNeeds('```mermaid\ngraph TD\n  A --> B')).toEqual({
      code: true,
      mermaid: true
    })
  })

  it('detects fences nested in blockquotes and lists', () => {
    expect(getMarkdownPluginNeeds('- ```ts\n  const value = 1\n  ```')).toEqual({
      code: true,
      mermaid: false
    })
    expect(getMarkdownPluginNeeds('> ```mermaid\n> graph TD\n>   A --> B\n> ```')).toEqual({
      code: true,
      mermaid: true
    })
    expect(
      getMarkdownPluginNeeds('- Code sample:\n\n    ```ts\n    const value = 1\n    ```')
    ).toEqual({ code: true, mermaid: false })
    expect(
      getMarkdownPluginNeeds(
        '- Outer item\n    - Inner item\n      ```mermaid\n      graph TD\n        A --> B\n      ```'
      )
    ).toEqual({ code: true, mermaid: true })
  })

  it('treats an unclosed trailing fence as code', () => {
    expect(getMarkdownPluginNeeds('Text.\n\n```js\nconst a = 1')).toEqual({
      code: true,
      mermaid: false
    })
  })

  it('ignores fence markers inside an open fence', () => {
    expect(getMarkdownPluginNeeds('```md\n```mermaid\ngraph TD\n```')).toEqual({
      code: true,
      mermaid: false
    })
  })
})

describe('createMarkdownPluginNeedsScanner', () => {
  // Feeds every append-only prefix of `chunks` through the incremental scanner and pins each
  // step to the full one-shot scan of the same text.
  const expectAppendStreamMatchesFull = (chunks: string[]): void => {
    const incremental = createMarkdownPluginNeedsScanner()
    let streamed = ''
    for (const chunk of chunks) {
      streamed += chunk
      expect(incremental(streamed)).toEqual(getMarkdownPluginNeeds(streamed))
    }
  }

  it('matches the full scan for a growing prose stream', () => {
    expectAppendStreamMatchesFull([
      'The quick',
      ' brown fox jumps over',
      ' the lazy dog.\n\nSecond para',
      'graph with `inline code`.'
    ])
  })

  it('matches the full scan when an append chunk splits a fence marker', () => {
    expectAppendStreamMatchesFull([
      'Code below.\n\n``',
      '`js\nconst a = 1',
      '\n```\n\nTrailing prose.'
    ])
  })

  it('matches the full scan for an unclosed trailing fence that later closes', () => {
    expectAppendStreamMatchesFull([
      'Text.\n\n```js\nconst a = 1',
      '\nconst b = 2',
      '\n```\n\nDone.'
    ])
  })

  it('detects a mermaid fence on a partial trailing line', () => {
    const incremental = createMarkdownPluginNeedsScanner()
    incremental('Chart below.\n\n')

    expect(incremental('Chart below.\n\n```mermaid')).toEqual({ code: true, mermaid: true })
    expect(incremental('Chart below.\n\n```mermaid\ngraph TD')).toEqual({
      code: true,
      mermaid: true
    })
    expect(getMarkdownPluginNeeds('Chart below.\n\n```mermaid')).toEqual({
      code: true,
      mermaid: true
    })
  })

  it('matches the full scan while a partial mermaid opener completes', () => {
    expectAppendStreamMatchesFull(['```mer', 'maid\ngraph TD', '\n```\n\n```js\nconst a = 1'])
  })

  it('matches the full scan for fences nested in blockquotes and lists', () => {
    expectAppendStreamMatchesFull([
      '> ```mermaid\n> graph TD',
      '\n>   A --> B\n> ```',
      '\n\n- ```ts\n  const value = 1\n  ```'
    ])
    expectAppendStreamMatchesFull([
      '- Outer item\n    - Inner item',
      '\n      ```mermaid\n      graph TD\n        A --> B',
      '\n      ```'
    ])
  })

  it('keeps needs monotonic while content grows and resets on replacement', () => {
    const incremental = createMarkdownPluginNeedsScanner()
    expect(incremental('```js\nconst a = 1')).toEqual({ code: true, mermaid: false })
    expect(incremental('```js\nconst a = 1\n```')).toEqual({ code: true, mermaid: false })

    // A replaced message without any fence drops the requirement again.
    expect(incremental('Just prose now.')).toEqual({ code: false, mermaid: false })
    expect(incremental('Just prose now.\n\n```mermaid\ngraph TD')).toEqual({
      code: true,
      mermaid: true
    })
  })

  it('falls back to a full scan for non-append corrections that keep a prefix', () => {
    const incremental = createMarkdownPluginNeedsScanner()
    incremental('Intro.\n\n```merm')

    const corrected = 'Intro.\n\n```js\nconst a = 1'
    expect(incremental(corrected)).toEqual(getMarkdownPluginNeeds(corrected))

    const grown = corrected + '\n````\n\nText.'
    expect(incremental(grown)).toEqual(getMarkdownPluginNeeds(grown))
  })

  it('returns the cached needs for repeated identical input', () => {
    const incremental = createMarkdownPluginNeedsScanner()
    const input = '```ts\nconst value = 1\n```'
    expect(incremental(input)).toEqual({ code: true, mermaid: false })
    expect(incremental(input)).toEqual({ code: true, mermaid: false })
  })

  it('handles empty input', () => {
    const incremental = createMarkdownPluginNeedsScanner()
    expect(incremental('')).toEqual({ code: false, mermaid: false })
    expect(incremental('```')).toEqual(getMarkdownPluginNeeds('```'))
  })
})

// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { JsonPreviewBody } from './JsonPreview'

const item: PreviewFileItem = {
  id: 'json-file',
  sessionId: 'session-1',
  type: 'file',
  title: 'data.json',
  name: 'data.json',
  path: '/workspace/data.json',
  format: 'json'
}

const renderJson = (content: string, truncated = false): HTMLElement =>
  render(
    <JsonPreviewBody
      item={item}
      state={{
        status: 'ready',
        preview: { content, encoding: 'utf8', size: content.length, truncated },
        pagination: {
          pageNumber: 1,
          hasPrevious: false,
          hasNext: truncated,
          previousPage: () => undefined,
          nextPage: () => undefined
        }
      }}
    />
  ).container

// Read only visible source cells, excluding the non-selectable line-number gutter.
const sourceText = (container: HTMLElement): string =>
  [...container.querySelectorAll('[data-testid="source-line-number"]')]
    .map((number) => number.nextElementSibling?.textContent ?? '')
    .join('\n')

afterEach(cleanup)

describe('JSON source fidelity', () => {
  it.each([
    ['unsafe integer', '{"id":9007199254740993}', '9007199254740993'],
    ['overflowing exponent', '{"value":1e400}', '1e400'],
    ['duplicate property', '{"sample":"first","sample":"second"}', '"first"']
  ])('preserves the original %s in the visible source', (_name, content, value) => {
    expect(sourceText(renderJson(content))).toContain(value)
  })

  it('does not diagnose valid deeply nested JSON as a syntax error', () => {
    const content = '['.repeat(10_000) + '0' + ']'.repeat(10_000)
    expect(() => JSON.parse(content)).not.toThrow()
    const container = renderJson(content)
    expect(sourceText(container)).toBe(content)
    expect(container.textContent).not.toContain('Invalid JSON')
  })

  it('retains syntax diagnostics and the source of invalid JSON', () => {
    const content = '{"sample":}'
    const container = renderJson(content)
    expect(container.textContent).toContain('Invalid JSON')
    expect(sourceText(container)).toBe(content)
  })

  it('preserves safe values and arrays', () => {
    const content = '{"id":42,"values":[1,2,3]}'
    expect(JSON.parse(sourceText(renderJson(content)))).toEqual(JSON.parse(content))
  })

  it('leaves incomplete pages unparsed', () => {
    const content = '{"id":9007199254740993'
    const container = renderJson(content, true)
    expect(sourceText(container)).toBe(content)
    expect(container.textContent).not.toContain('Invalid JSON')
  })
})

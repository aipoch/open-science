import { describe, expect, it } from 'vitest'

import { capToolDetailText, sanitizeToolContent } from './tool-detail-sanitizer'

describe('capToolDetailText', () => {
  it('preserves bounded text and truncates oversized text at the shared limit', () => {
    const bounded = 'x'.repeat(16_000)

    expect(capToolDetailText(bounded)).toBe(bounded)
    expect(capToolDetailText(`${bounded}tail`)).toBe(`${bounded}\n…`)
  })
})

describe('sanitizeToolContent', () => {
  it('keeps only supported content projections and strips unknown fields', () => {
    expect(
      sanitizeToolContent([
        null,
        { type: 'content', content: { type: 'text', text: 'result', secret: 'drop-me' } },
        {
          type: 'content',
          content: {
            type: 'resource_link',
            uri: 'file:///report.csv',
            name: 'report.csv',
            title: 'Report',
            description: 'drop-me'
          }
        },
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///notes.txt', text: 'notes', blob: 'drop-me' }
          }
        },
        { type: 'content', content: { type: 'image', data: 'drop-me' } }
      ])
    ).toEqual([
      { type: 'content', content: { type: 'text', text: 'result' } },
      {
        type: 'content',
        content: {
          type: 'resource_link',
          uri: 'file:///report.csv',
          name: 'report.csv',
          title: 'Report'
        }
      },
      {
        type: 'content',
        content: { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'notes' } }
      }
    ])
  })

  it('normalizes diffs and caps each text field independently', () => {
    const oversized = 'x'.repeat(16_001)

    expect(
      sanitizeToolContent([
        { type: 'diff', path: '/repo/new.ts', newText: 42 },
        { type: 'diff', path: '', oldText: 'ignored', newText: 'ignored' }
      ])
    ).toEqual([{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: '' }])
    expect(
      sanitizeToolContent([
        { type: 'diff', path: '/repo/old.ts', oldText: oversized, newText: 'replacement' }
      ])
    ).toEqual([
      {
        type: 'diff',
        path: '/repo/old.ts',
        oldText: `${'x'.repeat(16_000)}\n…`,
        newText: 'replacement'
      }
    ])
    expect(
      sanitizeToolContent([
        { type: 'diff', path: '/repo/new.ts', oldText: 'original', newText: oversized }
      ])
    ).toEqual([
      {
        type: 'diff',
        path: '/repo/new.ts',
        oldText: 'original',
        newText: `${'x'.repeat(16_000)}\n…`
      }
    ])
  })

  it('drops malformed or empty projections', () => {
    expect(sanitizeToolContent(undefined)).toBeUndefined()
    expect(
      sanitizeToolContent([
        'text',
        { type: 'content', content: { type: 'text', text: '' } },
        { type: 'content', content: { type: 'resource_link', uri: '' } },
        { type: 'content', content: { type: 'resource', resource: {} } },
        { type: 'terminal', terminalId: 'terminal-1' }
      ])
    ).toBeUndefined()
  })

  it('stops before an entry that would exceed the aggregate content budget', () => {
    const result = sanitizeToolContent([
      { type: 'content', content: { type: 'text', text: 'a'.repeat(16_000) } },
      { type: 'content', content: { type: 'text', text: 'b'.repeat(16_000) } },
      { type: 'content', content: { type: 'text', text: 'after-budget' } }
    ])

    expect(result).toEqual([
      { type: 'content', content: { type: 'text', text: 'a'.repeat(16_000) } }
    ])
  })
})

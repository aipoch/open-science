import { describe, expect, it } from 'vitest'

import { detectTrigger } from './useMentionTrigger'

describe('detectTrigger', () => {
  it('is active with the query when the trigger opens the string', () => {
    expect(detectTrigger('/lit', '/')).toEqual({ active: true, query: 'lit' })
  })

  it('is active when the trigger is preceded by whitespace', () => {
    expect(detectTrigger('hi /a', '/')).toEqual({ active: true, query: 'a' })
  })

  it('is inactive when the trigger has no whitespace boundary', () => {
    expect(detectTrigger('hi/a', '/')).toEqual({ active: false, query: '' })
  })

  it('is inactive once whitespace follows the trigger', () => {
    expect(detectTrigger('/a b', '/')).toEqual({ active: false, query: '' })
  })

  it('is inactive for an empty string', () => {
    expect(detectTrigger('', '/')).toEqual({ active: false, query: '' })
  })

  it('is active with an empty query when the trigger is the last char', () => {
    expect(detectTrigger('type /', '/')).toEqual({ active: true, query: '' })
  })

  it('is active with an empty query when the trigger alone opens the string', () => {
    expect(detectTrigger('/', '/')).toEqual({ active: true, query: '' })
  })

  it('ignores leading whitespace before the trigger', () => {
    expect(detectTrigger('   /foo', '/')).toEqual({ active: true, query: 'foo' })
  })

  it('treats a tab after the trigger as a boundary that closes it', () => {
    expect(detectTrigger('/foo\tbar', '/')).toEqual({ active: false, query: '' })
  })

  it('treats a newline before the trigger as whitespace', () => {
    expect(detectTrigger('line one\n/cmd', '/')).toEqual({ active: true, query: 'cmd' })
  })

  it('is inactive when the trigger sits inside a word', () => {
    expect(detectTrigger('a/b', '/')).toEqual({ active: false, query: '' })
  })

  it('keeps a trailing trigger char inside the query', () => {
    expect(detectTrigger('//x', '/')).toEqual({ active: true, query: '/x' })
  })

  it('supports a multi-character trigger', () => {
    expect(detectTrigger('see ::note', '::')).toEqual({ active: true, query: 'note' })
    expect(detectTrigger('see :note', '::')).toEqual({ active: false, query: '' })
  })

  it('is inactive for an empty trigger', () => {
    expect(detectTrigger('anything', '')).toEqual({ active: false, query: '' })
  })
})

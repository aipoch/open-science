import { describe, expect, it } from 'vitest'

import { formatLine } from '../logger'
import { errorLogFields } from './runtime'

describe('errorLogFields', () => {
  it('expands an Error into message + stack fields', () => {
    const fields = errorLogFields(new Error('boom'))

    expect(fields.error).toBe('boom')
    expect(typeof fields.stack).toBe('string')
    expect(fields.stack).toContain('boom')
  })

  it('stringifies a non-Error thrown value with no stack', () => {
    const fields = errorLogFields('plain string failure')

    expect(fields.error).toBe('plain string failure')
    expect(fields.stack).toBeUndefined()
  })

  it('stringifies a JSON-RPC-style error object', () => {
    const fields = errorLogFields({ code: -32603, message: 'Internal error' })

    // A bare object isn't an Error, so it falls back to String() — enough to see it in the log rather
    // than losing it, while a genuine Error path keeps the stack.
    expect(fields.error).toBe('[object Object]')
    expect(fields.stack).toBeUndefined()
  })

  it('survives the file logger without collapsing to {} (the regression this guards)', () => {
    // Nesting a raw Error inside a context object loses everything: toSerializable only unwraps a
    // top-level Error, so the nested one serializes to {} because its fields are non-enumerable.
    const rawNested = JSON.parse(
      formatLine('error', 'acp', 'agent connection failed', {
        error: new Error('spawn ENOENT'),
        framework: 'claude-code'
      })
    ) as { data: { error: unknown; framework: string } }

    expect(rawNested.data.error).toEqual({})

    // Spreading errorLogFields keeps the message + stack visible alongside the context.
    const fixed = JSON.parse(
      formatLine('error', 'acp', 'agent connection failed', {
        ...errorLogFields(new Error('spawn ENOENT')),
        framework: 'claude-code'
      })
    ) as { data: { error: string; stack?: string; framework: string } }

    expect(fixed.data.error).toBe('spawn ENOENT')
    expect(typeof fixed.data.stack).toBe('string')
    expect(fixed.data.framework).toBe('claude-code')
  })
})

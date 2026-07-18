import { describe, expect, it } from 'vitest'

import { describePromptError } from './prompt-error'

// Builds an ACP RequestError-shaped value: an Error carrying the JSON-RPC code + data the agent attaches.
const agentError = (
  message: string,
  data: Record<string, unknown> = { service: 'session', errorName: 'APIError' },
  code = -32603
): Error => Object.assign(new Error(message), { code, data, name: 'RequestError' })

describe('describePromptError', () => {
  it('rewords a provider JSON resource_not_found into an actionable message with the model name', () => {
    const error = agentError(
      'Internal error: Not Found: {"error":{"message":"The requested resource was not found","type":"resource_not_found_error"}}'
    )

    const text = describePromptError(error, { model: 'deepseek-v4-flash' })

    expect(text).toContain('model "deepseek-v4-flash"')
    expect(text).toContain('Settings → Model')
    // Surfaces the provider's own human message, not the raw JSON blob.
    expect(text).toContain('The requested resource was not found')
    expect(text).not.toContain('{')
  })

  it('handles a text-only (non-JSON) provider not-found, including non-English messages', () => {
    const error = agentError('Internal error: Not Found: 没找到对象')

    const text = describePromptError(error, { model: 'kimi-k3' })

    expect(text).toContain('model "kimi-k3"')
    expect(text).toContain('没找到对象')
    // The `Internal error:` and `Not Found:` wrapper prefixes are stripped from the surfaced text.
    expect(text).not.toMatch(/internal error:/i)
    expect(text).not.toMatch(/not found:/i)
  })

  it('extracts the provider message when the JSON payload has trailing text', () => {
    const error = agentError(
      'Internal error: Not Found: {"error":{"message":"The requested resource was not found","type":"resource_not_found_error"}} (request id: req-abc-123)'
    )

    const text = describePromptError(error, { model: 'deepseek-v4-flash' })

    expect(text).toContain('The requested resource was not found')
    // Neither the raw JSON blob nor the trailing request id leaks into the surfaced text.
    expect(text).not.toContain('{')
    expect(text).not.toContain('request id')
  })

  it('passes through a benign "not found" API error that is not a resource lookup', () => {
    const error = agentError(
      'Internal error: Overloaded: rate limit config not found, using default'
    )

    expect(describePromptError(error, { model: 'gpt-5' })).toBe(
      'Internal error: Overloaded: rate limit config not found, using default'
    )
  })

  it('omits the model clause when no model is known', () => {
    const error = agentError('Internal error: Not Found: model missing')

    const text = describePromptError(error)

    expect(text).toContain('could not find the requested resource.')
    expect(text).not.toContain('for model')
  })

  it('passes through an unrelated API error unchanged', () => {
    const error = agentError('Internal error: Overloaded: service is busy')

    expect(describePromptError(error, { model: 'gpt-5' })).toBe(
      'Internal error: Overloaded: service is busy'
    )
  })

  it('does not treat an ACP protocol not-found (no APIError tag) as a model problem', () => {
    // A plain session-not-found with no upstream signal must stay verbatim (the resume path owns it).
    const error = Object.assign(new Error('Resource not found'), { code: -32002 })

    expect(describePromptError(error)).toBe('Resource not found')
  })

  it('rewords a resource_not_found even without the APIError tag when the type is present', () => {
    const error = agentError(
      'Internal error: Not Found: {"error":{"message":"unknown model","type":"resource_not_found_error"}}',
      {}
    )

    expect(describePromptError(error)).toContain('could not find the requested resource')
  })

  it('accepts a plain string error', () => {
    expect(describePromptError('boom')).toBe('boom')
  })
})
